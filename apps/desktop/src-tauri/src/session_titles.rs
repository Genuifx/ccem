use crate::config;
use crate::native_helper_resource::native_helper_script_path;
use crate::native_runtime::spawn_native_helper_process;
use crate::terminal;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

const DEFAULT_HAIKU_MODEL: &str = "haiku";
const TITLE_MAX_CHARS: usize = 36;
const TITLE_INPUT_MAX_CHARS: usize = 2_000;
const TITLE_HELPER_TIMEOUT: Duration = Duration::from_secs(45);

#[tauri::command]
pub async fn generate_workspace_session_title(
    app: AppHandle,
    title_input: String,
    env_name: Option<String>,
    working_dir: Option<String>,
) -> Result<Option<String>, String> {
    let Some(request) =
        build_title_query_request(&title_input, env_name.as_deref(), working_dir.as_deref())?
    else {
        return Ok(None);
    };
    let generated_title = run_title_query_helper(app, request).await?;
    Ok(generated_title.and_then(|title| sanitize_generated_title(&title)))
}

#[derive(Debug)]
struct TitleQueryRequest {
    title_input: String,
    working_dir: String,
    env_vars: HashMap<String, String>,
    claude_path: Option<String>,
    model: String,
}

#[derive(Debug, Serialize)]
struct TitleQueryCommand<'a> {
    #[serde(rename = "type")]
    command_type: &'static str,
    title_input: &'a str,
    working_dir: &'a str,
    env_vars: &'a HashMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    claude_path: Option<&'a str>,
    model: &'a str,
}

fn build_title_query_request(
    title_input: &str,
    env_name: Option<&str>,
    working_dir: Option<&str>,
) -> Result<Option<TitleQueryRequest>, String> {
    let input = normalize_title_input(title_input);
    if input.is_empty() {
        return Ok(None);
    }

    let cfg = config::read_config()?;
    let env_name = env_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or(cfg.current.as_deref())
        .ok_or_else(|| "No current environment configured for session titles".to_string())?;
    // resolve_claude_env owns the auth boundary, including official OAuth.
    let resolved = config::resolve_claude_env(env_name)?;
    let mut env_vars = resolved.env_vars;
    force_haiku_title_model(&mut env_vars);
    env_vars.insert("PATH".to_string(), terminal::get_user_path());

    let model = env_vars
        .get("ANTHROPIC_MODEL")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_HAIKU_MODEL)
        .to_string();

    Ok(Some(TitleQueryRequest {
        title_input: input,
        working_dir: working_dir
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(title_query_working_dir),
        env_vars,
        claude_path: terminal::resolve_claude_path(),
        model,
    }))
}

async fn run_title_query_helper(
    app: AppHandle,
    request: TitleQueryRequest,
) -> Result<Option<String>, String> {
    let helper_command = TitleQueryCommand {
        command_type: "title_query",
        title_input: &request.title_input,
        working_dir: &request.working_dir,
        env_vars: &request.env_vars,
        claude_path: request.claude_path.as_deref(),
        model: &request.model,
    };
    let line = serde_json::to_string(&helper_command)
        .map_err(|error| format!("Failed to encode title query command: {}", error))?;
    let helper_path = native_helper_script_path(&app)?;
    let command = app
        .shell()
        .sidecar("ccem-node")
        .map_err(|error| format!("Failed to resolve Node sidecar: {}", error))?
        .arg(helper_path.to_string_lossy().to_string())
        .current_dir(&request.working_dir);

    let (rx, mut child) = spawn_native_helper_process(command.into())?;

    if let Err(error) = child.write(format!("{}\n", line).as_bytes()) {
        let _ = child.kill();
        return Err(format!("Failed to write title query command: {}", error));
    }

    // The helper stays alive to read commands even after SDK errors. Always
    // stop this owned child on result, error, malformed output or hard timeout.
    let result = tokio::time::timeout(TITLE_HELPER_TIMEOUT, receive_title_helper_output(rx)).await;
    let _ = child.kill();
    result.map_err(|_| "Native title helper timed out after 45s".to_string())?
}

async fn receive_title_helper_output(
    mut rx: tauri::async_runtime::Receiver<CommandEvent>,
) -> Result<Option<String>, String> {
    let mut stdout_buffer = Vec::new();
    let mut stderr_buffer = Vec::new();
    let mut stderr_lines = Vec::new();

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(chunk) => {
                for text in drain_output_lines(&mut stdout_buffer, &chunk) {
                    if let Some(title) = process_title_helper_line(&text, &mut stderr_lines)? {
                        return Ok(title);
                    }
                }
            }
            CommandEvent::Stderr(chunk) => {
                stderr_lines.extend(drain_output_lines(&mut stderr_buffer, &chunk));
            }
            CommandEvent::Error(error) => {
                return Err(format!("Native title helper error: {}", error));
            }
            CommandEvent::Terminated(payload) => {
                if let Some(text) = take_remaining_output_line(&mut stdout_buffer) {
                    if let Some(title) = process_title_helper_line(&text, &mut stderr_lines)? {
                        return Ok(title);
                    }
                }
                if let Some(text) = take_remaining_output_line(&mut stderr_buffer) {
                    stderr_lines.push(text);
                }
                if payload.code.unwrap_or_default() != 0 {
                    let suffix = if stderr_lines.is_empty() {
                        String::new()
                    } else {
                        format!(": {}", stderr_lines.join("\n"))
                    };
                    return Err(format!(
                        "Native title helper exited with code {:?}{}",
                        payload.code, suffix
                    ));
                }
                return Err("Native title helper exited without a title result".to_string());
            }
            _ => {}
        }
    }

    Err("Native title helper closed without a title result".to_string())
}

fn process_title_helper_line(
    line: &str,
    stderr_lines: &mut Vec<String>,
) -> Result<Option<Option<String>>, String> {
    let value: Value = serde_json::from_str(line)
        .map_err(|error| format!("Failed to parse title helper output: {}", error))?;
    match value.get("type").and_then(Value::as_str) {
        Some("title_result") => Ok(Some(
            value
                .get("title")
                .and_then(Value::as_str)
                .map(|title| title.to_string()),
        )),
        Some("status") => {
            if value.get("status").and_then(Value::as_str) == Some("error") {
                return Err(value
                    .get("detail")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| "Native title helper reported an error.".to_string()));
            }
            Ok(None)
        }
        Some("event") => {
            if let Some(line) = value
                .get("payload")
                .and_then(|payload| payload.get("line"))
                .and_then(Value::as_str)
            {
                stderr_lines.push(line.to_string());
            }
            Ok(None)
        }
        _ => Ok(None),
    }
}

fn title_query_working_dir() -> String {
    config::get_default_working_dir()
        .or_else(|| dirs::home_dir().map(|path| path.to_string_lossy().to_string()))
        .unwrap_or_else(|| ".".to_string())
}

fn trim_output_line(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn drain_output_lines(buffer: &mut Vec<u8>, chunk: &[u8]) -> Vec<String> {
    buffer.extend_from_slice(chunk);
    let mut lines = Vec::new();
    while let Some(index) = buffer.iter().position(|byte| *byte == b'\n') {
        let line: Vec<u8> = buffer.drain(..=index).collect();
        if let Some(text) = trim_output_line(&line) {
            lines.push(text);
        }
    }
    lines
}

fn take_remaining_output_line(buffer: &mut Vec<u8>) -> Option<String> {
    if buffer.is_empty() {
        return None;
    }
    let line = std::mem::take(buffer);
    trim_output_line(&line)
}

fn normalize_title_input(input: &str) -> String {
    crate::user_prompt_display::normalize_user_visible_prompt(input)
        .unwrap_or_default()
        .trim()
        .chars()
        .take(TITLE_INPUT_MAX_CHARS)
        .collect::<String>()
}

fn sanitize_generated_title(raw: &str) -> Option<String> {
    let mut title = raw
        .trim()
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim()
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
        .trim()
        .trim_start_matches(['"', '\'', '`', '“', '‘', '[', '【'])
        .trim_end_matches([
            '"', '\'', '`', '”', '’', ']', '】', '。', '.', '！', '!', '？', '?', '，', ',', '、',
            '；', ';', '：', ':',
        ])
        .trim()
        .to_string();

    for prefix in ["标题：", "标题:", "Title:", "title:"] {
        if let Some(stripped) = title.strip_prefix(prefix) {
            title = stripped.trim().to_string();
        }
    }

    title = title
        .trim_start_matches(['"', '\'', '`', '“', '‘'])
        .trim_end_matches(['"', '\'', '`', '”', '’', '。', '.', '！', '!', '？', '?'])
        .trim()
        .to_string();

    title = title
        .chars()
        .take(TITLE_MAX_CHARS)
        .collect::<String>()
        .trim()
        .to_string();

    let normalized = title.to_ascii_lowercase();
    if title.is_empty()
        || title.contains('<')
        || title.contains('>')
        || title.contains("```")
        || title.starts_with('#')
        || matches!(
            normalized.as_str(),
            "无法生成标题"
                | "untitled"
                | "no title"
                | "session title"
                | "收到"
                | "好的"
                | "ok"
                | "okay"
        )
    {
        None
    } else {
        Some(title)
    }
}

fn force_haiku_title_model(env_vars: &mut HashMap<String, String>) {
    let model = env_vars
        .get("ANTHROPIC_DEFAULT_HAIKU_MODEL")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            env_vars
                .get("ANTHROPIC_SMALL_FAST_MODEL")
                .map(String::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .unwrap_or(DEFAULT_HAIKU_MODEL)
        .to_string();
    env_vars.insert("ANTHROPIC_MODEL".to_string(), model);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn sanitize_generated_title_returns_compact_plain_text() {
        assert_eq!(
            sanitize_generated_title("  ```\n\"排查 ProjectTree 标题生成。\"\n```  "),
            Some("排查 ProjectTree 标题生成".to_string())
        );
        assert_eq!(
            sanitize_generated_title("标题：“修复标题生成。”"),
            Some("修复标题生成".to_string())
        );
    }

    #[test]
    fn sanitize_generated_title_rejects_empty_or_generic_output() {
        assert_eq!(sanitize_generated_title("   "), None);
        assert_eq!(sanitize_generated_title("无法生成标题"), None);
        assert_eq!(
            sanitize_generated_title("<system_tip>交付文件时</system_tip>"),
            None
        );
        assert_eq!(sanitize_generated_title("<think>分析请求</think>"), None);
        assert_eq!(sanitize_generated_title("# 推荐的标题"), None);
        assert_eq!(sanitize_generated_title("收到。"), None);
    }

    #[test]
    fn title_input_recovers_visible_request_before_truncation() {
        let input = format!("<system_tip>{}</system_tip>\n\n<selected_skills>hidden</selected_skills>\n<user_request>修复会话标题\n并补回归测试</user_request>", crate::user_prompt_display::WORKSPACE_FILE_PREVIEW_SYSTEM_TIP);
        assert_eq!(normalize_title_input(&input), "修复会话标题\n并补回归测试");
        assert_eq!(
            normalize_title_input("<workspace_annotations>hidden</workspace_annotations>"),
            ""
        );
        assert_eq!(
            normalize_title_input(&"字".repeat(3_000)).chars().count(),
            TITLE_INPUT_MAX_CHARS
        );
    }

    #[test]
    fn title_model_falls_back_when_haiku_mapping_is_blank() {
        let mut env_vars = HashMap::from([
            ("ANTHROPIC_DEFAULT_HAIKU_MODEL".to_string(), " ".to_string()),
            (
                "ANTHROPIC_SMALL_FAST_MODEL".to_string(),
                "small-fast-test".to_string(),
            ),
            ("ANTHROPIC_MODEL".to_string(), "opus".to_string()),
        ]);
        force_haiku_title_model(&mut env_vars);
        assert_eq!(env_vars["ANTHROPIC_MODEL"], "small-fast-test");
        env_vars.remove("ANTHROPIC_SMALL_FAST_MODEL");
        force_haiku_title_model(&mut env_vars);
        assert_eq!(env_vars["ANTHROPIC_MODEL"], "haiku");
    }

    #[test]
    fn title_helper_error_is_terminal_without_waiting_for_process_exit() {
        let mut stderr = Vec::new();
        assert_eq!(
            process_title_helper_line(
                r#"{"type":"status","status":"error","detail":"401 Unauthorized"}"#,
                &mut stderr
            ),
            Err("401 Unauthorized".to_string())
        );
        assert!(process_title_helper_line("broken JSON", &mut stderr).is_err());
        assert_eq!(
            process_title_helper_line(r#"{"type":"title_result","title":null}"#, &mut stderr)
                .unwrap(),
            Some(None)
        );
    }

    #[test]
    fn title_model_env_prefers_configured_haiku_model() {
        let mut env_vars = HashMap::new();
        env_vars.insert(
            "ANTHROPIC_DEFAULT_HAIKU_MODEL".to_string(),
            "claude-haiku-test".to_string(),
        );
        env_vars.insert("ANTHROPIC_MODEL".to_string(), "opus".to_string());

        force_haiku_title_model(&mut env_vars);

        assert_eq!(
            env_vars.get("ANTHROPIC_MODEL").map(String::as_str),
            Some("claude-haiku-test")
        );
    }

    #[test]
    fn title_helper_line_extracts_title_result() {
        let mut stderr_lines = Vec::new();

        assert_eq!(
            process_title_helper_line(
                r#"{"type":"title_result","title":"标题：AI 生成标题。"}"#,
                &mut stderr_lines
            )
            .expect("helper output should parse"),
            Some(Some("标题：AI 生成标题。".to_string()))
        );
    }

    #[cfg(unix)]
    fn assert_owned_title_helper_stopped(pid: u32) {
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while unsafe { libc::kill(pid as i32, 0) } == 0 {
            assert!(
                std::time::Instant::now() < deadline,
                "owned title helper {pid} leaked"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[cfg(unix)]
    #[test]
    fn title_helper_frames_settle_while_the_real_process_is_still_waiting_for_commands() {
        for (frame, expected) in [
            (
                r#"{"type":"title_result","title":"生成的短标题"}"#,
                Ok(Some("生成的短标题".to_string())),
            ),
            (
                r#"{"type":"status","status":"error","detail":"401 Unauthorized"}"#,
                Err("401 Unauthorized".to_string()),
            ),
        ] {
            let mut command = std::process::Command::new("/bin/sh");
            command.args(["-c", &format!("printf '%s\\n' '{}'; exec sleep 60", frame)]);
            let (rx, child) = spawn_native_helper_process(command).unwrap();
            let pid = child.pid();
            let result = tauri::async_runtime::block_on(async {
                tokio::time::timeout(Duration::from_secs(2), receive_title_helper_output(rx)).await
            });
            drop(child);
            assert_eq!(
                result.expect("frame must settle without waiting for exit"),
                expected
            );
            assert_owned_title_helper_stopped(pid);
        }
    }

    #[cfg(unix)]
    #[test]
    fn timed_out_title_helper_is_killed_on_owner_drop() {
        let mut command = std::process::Command::new("/bin/sh");
        command.args(["-c", "exec sleep 60"]);
        let (rx, child) = spawn_native_helper_process(command).unwrap();
        let pid = child.pid();
        let result = tauri::async_runtime::block_on(async {
            tokio::time::timeout(Duration::from_millis(20), receive_title_helper_output(rx)).await
        });
        drop(child);
        assert!(result.is_err());
        assert_owned_title_helper_stopped(pid);
    }
}
