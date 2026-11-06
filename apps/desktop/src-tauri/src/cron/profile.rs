//! Explicit profile recovery and bounded, model-free checks for unattended work.
use super::process::{kill_cron_process_tree, OutputCollector};
use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::AppHandle;

const WORKER: &str = include_str!("../../resources/claude-profile-repair.cjs");

fn process_command(command: &mut Command) {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
}

fn worker(app: &AppHandle, mut input: Value, limit: Duration) -> Result<Value, String> {
    let home = dirs::home_dir().ok_or("Cannot locate home directory")?;
    if let Some(cwd) = input["workingDir"].as_str() {
        input["workingDir"] = json!(super::expand_cron_working_dir(cwd, Some(&home)));
    }
    input["home"] = json!(home);
    // Serialize recovery across Desktop processes. Keep this file in place:
    // OS locks release on crash, so stale worker-lock recovery cannot race.
    let _repair_lock = if input["action"] == "repair" {
        use fs2::FileExt;
        let root = home.join(".ccem");
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let path = root.join(".claude-profile-repair.lock");
        if std::fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file()) {
            return Err("Invalid profile repair lock".into());
        }
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)
            .map_err(|e| e.to_string())?;
        file.try_lock_exclusive()
            .map_err(|_| "Another profile repair is running")?;
        Some(file)
    } else {
        None
    };
    input["profile"] = json!(crate::agent_home::claude_home());
    let node = crate::dsh_history::resolve_ccem_node_path(app).map_err(|e| e.to_string())?;
    let mut command = Command::new(node);
    command
        .args(["-e", WORKER])
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH");
    run_worker(&mut command, &input, limit)
}

fn run_worker(command: &mut Command, input: &Value, limit: Duration) -> Result<Value, String> {
    process_command(command);
    let mut child = command
        .spawn()
        .map_err(|e| format!("Profile check could not start: {e}"))?;
    let stdout = OutputCollector::spawn(child.stdout.take());
    let stderr = OutputCollector::spawn(child.stderr.take());
    let write = child
        .stdin
        .take()
        .ok_or("Missing profile check input".to_string())
        .and_then(|mut pipe| {
            pipe.write_all(input.to_string().as_bytes())
                .map_err(|e| e.to_string())
        });
    let start = Instant::now();
    let outcome = if let Err(error) = write {
        Err(error)
    } else {
        loop {
            match child.try_wait() {
                Ok(Some(status)) => break if status.success() { Ok(()) } else { Err("Profile check failed".into()) },
                Err(error) => break Err(error.to_string()),
                Ok(None) if start.elapsed() >= limit => break Err("CCEM_PREFLIGHT_TIMEOUT: Profile access timed out. Check directory access or import skills from an accessible folder.".into()),
                Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            }
        }
    };
    if outcome.is_err() {
        kill_cron_process_tree(&mut child);
    }
    let raw = stdout.finish(Duration::from_millis(200));
    let _ = stderr.finish(Duration::from_millis(200));
    outcome?;
    let response: Value =
        serde_json::from_str(&raw).map_err(|_| "Invalid profile check response")?;
    if response["ok"] != true {
        return Err(response["error"]
            .as_str()
            .unwrap_or("Profile check failed")
            .to_string());
    }
    Ok(response["result"].clone())
}

#[tauri::command]
pub async fn inspect_claude_task_profile(
    app: AppHandle,
    working_dir: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        worker(
            &app,
            json!({ "workingDir": working_dir }),
            Duration::from_secs(30),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn repair_claude_task_profile(
    app: AppHandle,
    working_dir: String,
    trust_project: bool,
    skill_names: Vec<String>,
) -> Result<Value, String> {
    // trust_project is an explicit UI decision, never inferred from legacy trust.
    tauri::async_runtime::spawn_blocking(move || {
        worker(
            &app,
            json!({
                "action": "repair", "workingDir": working_dir,
                "trustProject": trust_project, "skillNames": skill_names,
            }),
            Duration::from_secs(30),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(super) fn check_profile(
    app: &AppHandle,
    working_dir: &str,
    limit: Duration,
) -> Result<bool, String> {
    let state = worker(
        app,
        json!({ "workingDir": working_dir, "preflight": true }),
        limit,
    )?;
    if state["trusted"] != true {
        return Err("CCEM_PREFLIGHT: Project is not trusted in the isolated Claude profile. Edit this task → Check runtime → confirm project trust.".into());
    }
    // Links are supported by Claude. Verify them in its actual process rather
    // than banning working links or following them in the Desktop process.
    Ok(state["skills"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|s| s["state"] == "linked"))
}

/// Use the same selected Claude binary, cwd and environment as the real run.
/// Initialization discovers commands without sending a user/model request.
pub(super) fn check_required_skills(
    mut command: Command,
    required: &[String],
    limit: Duration,
) -> Result<(), String> {
    process_command(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| format!("CCEM_PREFLIGHT: Claude initialization failed: {e}"))?;
    let stdout = OutputCollector::spawn(child.stdout.take());
    let stderr = OutputCollector::spawn(child.stderr.take());
    // Keep stdin open until the response so the CLI stays in control mode.
    let mut input = child
        .stdin
        .take()
        .ok_or("CCEM_PREFLIGHT: Missing Claude input")?;
    let written = writeln!(
        input,
        "{}",
        json!({"type":"control_request","request_id":"ccem-preflight","request":{"subtype":"initialize"}})
    );
    let start = Instant::now();
    let result = if written.is_err() {
        Err("CCEM_PREFLIGHT: Could not initialize Claude".into())
    } else {
        loop {
            if let Some(result) = initialization_result(&stdout.snapshot(), required) {
                break result;
            }
            if start.elapsed() >= limit {
                break Err("CCEM_PREFLIGHT_TIMEOUT: Claude skill discovery timed out; inspect profile directory access before retrying.".into());
            }
            if !matches!(child.try_wait(), Ok(None)) {
                break Err(
                    "CCEM_PREFLIGHT: Claude exited before skill discovery completed.".into(),
                );
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    };
    kill_cron_process_tree(&mut child);
    drop(input);
    let _ = stdout.finish(Duration::from_millis(200));
    let _ = stderr.finish(Duration::from_millis(200));
    result
}

pub(super) fn preflight_error(message: String) -> std::io::Error {
    let kind = if message.starts_with("CCEM_PREFLIGHT_TIMEOUT:") {
        std::io::ErrorKind::TimedOut
    } else {
        std::io::ErrorKind::Other
    };
    std::io::Error::new(kind, message)
}

/// Every startup phase and the real spawn share the task's total budget.
pub(super) fn remaining_budget(
    start: Instant,
    total: Duration,
    cap: Duration,
) -> std::io::Result<Duration> {
    total
        .checked_sub(start.elapsed())
        .filter(|d| !d.is_zero())
        .map(|d| d.min(cap))
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "CCEM_PREFLIGHT_TIMEOUT: Task deadline elapsed before Claude could start",
            )
        })
}

pub(super) fn spawn_before_deadline(
    command: &mut Command,
    start: Instant,
    total: Duration,
) -> std::io::Result<std::process::Child> {
    remaining_budget(start, total, total)?;
    command.spawn()
}

fn initialization_result(output: &str, required: &[String]) -> Option<Result<(), String>> {
    for line in output.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value["type"] != "control_response"
            || value["response"]["request_id"] != "ccem-preflight"
        {
            continue;
        }
        let response = &value["response"];
        let Some(commands) = response["response"]["commands"].as_array() else {
            return Some(Err(
                "CCEM_PREFLIGHT: Claude did not return its available skills.".into(),
            ));
        };
        if response["subtype"] != "success" {
            return Some(Err("CCEM_PREFLIGHT: Claude rejected initialization.".into()));
        }
        let missing: Vec<_> = required
            .iter()
            .filter(|name| {
                !commands
                    .iter()
                    .any(|c| c["name"].as_str() == Some(name.as_str()))
            })
            .collect();
        return Some(if missing.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "CCEM_PREFLIGHT: Required skills unavailable: {}. Edit this task → Check runtime.",
                missing
                    .iter()
                    .map(|s| s.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checks_matching_response_and_missing_skills() {
        let output = json!({"type":"control_response","response":{"request_id":"ccem-preflight","subtype":"success","response":{"commands":[{"name":"example"}]}}}).to_string();
        assert!(initialization_result(&output, &["example".into()])
            .unwrap()
            .is_ok());
        assert!(initialization_result(&output, &["missing".into()])
            .unwrap()
            .unwrap_err()
            .contains("missing"));
        assert!(initialization_result(&output.replace("ccem-preflight", "other"), &[]).is_none());
    }
    #[test]
    #[cfg(unix)]
    fn expired_preflight_never_starts_runner() {
        let start = Instant::now();
        let total = Duration::from_millis(100);
        let mut probe = Command::new("sh");
        probe.args(["-c", "sleep 30"]);
        let error =
            check_required_skills(probe, &[], remaining_budget(start, total, total).unwrap())
                .unwrap_err();
        assert_eq!(preflight_error(error).kind(), std::io::ErrorKind::TimedOut);
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("model-started");
        let mut runner = Command::new("touch");
        runner.arg(&marker);
        assert_eq!(
            spawn_before_deadline(&mut runner, start, total)
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::TimedOut
        );
        assert!(!marker.exists());
    }
    #[test]
    #[cfg(unix)]
    fn real_child_discovery_and_timeout_are_bounded() {
        let mut command = Command::new("sh");
        command.args(["-c", "read request; printf '%s\\n' '{\"type\":\"control_response\",\"response\":{\"request_id\":\"ccem-preflight\",\"subtype\":\"success\",\"response\":{\"commands\":[{\"name\":\"fixture\"}]}}}'; sleep 30"]);
        assert!(
            check_required_skills(command, &["fixture".into()], Duration::from_secs(2)).is_ok()
        );
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30"]);
        let start = Instant::now();
        assert!(
            check_required_skills(command, &["fixture".into()], Duration::from_millis(100))
                .unwrap_err()
                .contains("timed out")
        );
        assert!(start.elapsed() < Duration::from_secs(3));
    }
}
