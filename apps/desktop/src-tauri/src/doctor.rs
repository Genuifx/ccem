use chrono::Utc;
use serde::Serialize;
use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::terminal;

const VERSION_OUTPUT_LIMIT: usize = 2000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    schema_version: u8,
    generated_at: String,
    app_version: String,
    platform: DoctorPlatform,
    process: DoctorProcess,
    environment: DoctorEnvironment,
    commands: Vec<DoctorCommandStatus>,
    paths: Vec<DoctorPathStatus>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoctorPlatform {
    os: String,
    arch: String,
    family: String,
    debug_build: bool,
    capabilities: DoctorCapabilities,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoctorCapabilities {
    tmux_supported: bool,
    external_terminal_launch_supported: bool,
    native_runtime_supported: bool,
    headless_runtime_supported: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoctorProcess {
    current_exe: Option<String>,
    current_dir: Option<String>,
    home_dir: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoctorEnvironment {
    path_entries: Vec<String>,
    safe_vars: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoctorCommandStatus {
    name: String,
    installed: bool,
    resolved_path: Option<String>,
    version: Option<String>,
    version_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoctorPathStatus {
    label: String,
    path: String,
    exists: bool,
    is_dir: bool,
    is_file: bool,
    size_bytes: Option<u64>,
    error: Option<String>,
}

#[tauri::command]
pub fn collect_doctor_report() -> DoctorReport {
    build_doctor_report()
}

fn build_doctor_report() -> DoctorReport {
    let user_path = terminal::get_user_path();

    DoctorReport {
        schema_version: 1,
        generated_at: Utc::now().to_rfc3339(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        platform: DoctorPlatform {
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            family: std::env::consts::FAMILY.to_string(),
            debug_build: cfg!(debug_assertions),
            capabilities: DoctorCapabilities {
                tmux_supported: cfg!(any(target_os = "macos", target_os = "linux")),
                external_terminal_launch_supported: cfg!(target_os = "macos"),
                native_runtime_supported: true,
                headless_runtime_supported: true,
            },
        },
        process: DoctorProcess {
            current_exe: std::env::current_exe().ok().map(path_to_string),
            current_dir: std::env::current_dir().ok().map(path_to_string),
            home_dir: dirs::home_dir().map(path_to_string),
        },
        environment: DoctorEnvironment {
            path_entries: split_path_entries(&user_path),
            safe_vars: collect_safe_env_vars(),
        },
        commands: collect_command_statuses(&user_path),
        paths: collect_path_statuses(),
    }
}

fn collect_command_statuses(user_path: &str) -> Vec<DoctorCommandStatus> {
    let mut statuses = vec![
        doctor_command(
            "node",
            resolve_command_from_path("node", user_path),
            user_path,
        ),
        doctor_command("ccem", terminal::resolve_ccem_path(), user_path),
        doctor_command("claude", terminal::resolve_claude_path(), user_path),
        doctor_command("codex", terminal::resolve_codex_path(), user_path),
        doctor_command("opencode", terminal::resolve_opencode_path(), user_path),
    ];

    if cfg!(any(target_os = "macos", target_os = "linux")) {
        statuses.push(doctor_command(
            "tmux",
            terminal::resolve_tmux_path(),
            user_path,
        ));
    } else {
        statuses.push(DoctorCommandStatus {
            name: "tmux".to_string(),
            installed: false,
            resolved_path: None,
            version: None,
            version_error: Some("tmux is not used by CCEM on this platform".to_string()),
        });
    }

    statuses
}

fn doctor_command(
    name: &str,
    resolved_path: Option<String>,
    user_path: &str,
) -> DoctorCommandStatus {
    let (version, version_error) = resolved_path
        .as_deref()
        .map(|path| command_version(path, user_path))
        .unwrap_or((None, None));

    DoctorCommandStatus {
        name: name.to_string(),
        installed: resolved_path.is_some(),
        resolved_path,
        version,
        version_error,
    }
}

fn command_version(path: &str, user_path: &str) -> (Option<String>, Option<String>) {
    let output = version_command(path)
        .arg("--version")
        .env("PATH", user_path)
        .output();
    match output {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let text = format!("{} {}", stdout.trim(), stderr.trim())
                .trim()
                .to_string();

            if output.status.success() && !text.is_empty() {
                (Some(truncate(text, VERSION_OUTPUT_LIMIT)), None)
            } else if text.is_empty() {
                (
                    None,
                    Some(format!("version exited with status {}", output.status)),
                )
            } else {
                (
                    None,
                    Some(format!(
                        "version exited with status {}: {}",
                        output.status,
                        truncate(text, VERSION_OUTPUT_LIMIT)
                    )),
                )
            }
        }
        Err(error) => (None, Some(error.to_string())),
    }
}

fn version_command(path: &str) -> Command {
    #[cfg(windows)]
    {
        if is_windows_batch_path(path) {
            let shell = std::env::var_os("ComSpec").unwrap_or_else(|| OsString::from("cmd.exe"));
            let mut command = Command::new(shell);
            command.arg("/C").arg(path);
            return command;
        }
    }

    Command::new(path)
}

fn is_windows_batch_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "cmd" | "bat"))
        .unwrap_or(false)
}

fn collect_path_statuses() -> Vec<DoctorPathStatus> {
    let mut paths = Vec::new();

    if let Some(home) = dirs::home_dir() {
        paths.push(path_status("home", home.clone()));
        paths.push(path_status("ccemConfigDir", home.join(".ccem")));
        paths.push(path_status(
            "ccemConfig",
            home.join(".ccem").join("config.json"),
        ));
        paths.push(path_status(
            "ccemNativeRuntimeState",
            home.join(".ccem").join("native-runtime-state.json"),
        ));
        paths.push(path_status("claudeHome", crate::agent_home::claude_home()));
        paths.push(path_status("codexHome", crate::agent_home::codex_home()));
    }

    for (label, key) in [
        ("appData", "APPDATA"),
        ("localAppData", "LOCALAPPDATA"),
        ("programFiles", "ProgramFiles"),
        ("programFilesX86", "ProgramFiles(x86)"),
    ] {
        if let Some(value) = std::env::var_os(key) {
            paths.push(path_status(label, PathBuf::from(value)));
        }
    }

    if let Some(app_data) = std::env::var_os("APPDATA") {
        let base = PathBuf::from(app_data);
        paths.push(path_status(
            "appDataCcemDesktop",
            base.join("com.ccem.desktop"),
        ));
        paths.push(path_status("appDataCcem", base.join("ccem")));
    }

    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let base = PathBuf::from(local_app_data);
        paths.push(path_status(
            "localAppDataCcemDesktop",
            base.join("com.ccem.desktop"),
        ));
        paths.push(path_status("localAppDataCcem", base.join("ccem")));
    }

    paths
}

fn path_status(label: &str, path: PathBuf) -> DoctorPathStatus {
    let path_string = path_to_string(path.clone());
    match fs::metadata(&path) {
        Ok(metadata) => DoctorPathStatus {
            label: label.to_string(),
            path: path_string,
            exists: true,
            is_dir: metadata.is_dir(),
            is_file: metadata.is_file(),
            size_bytes: metadata.is_file().then_some(metadata.len()),
            error: None,
        },
        Err(error) => DoctorPathStatus {
            label: label.to_string(),
            path: path_string,
            exists: false,
            is_dir: false,
            is_file: false,
            size_bytes: None,
            error: Some(error.to_string()),
        },
    }
}

fn collect_safe_env_vars() -> BTreeMap<String, String> {
    let mut vars = BTreeMap::new();
    for key in SAFE_ENV_KEYS {
        if is_secret_env_key(key) {
            continue;
        }
        if let Ok(value) = std::env::var(key) {
            vars.insert((*key).to_string(), truncate(value, 8000));
        }
    }
    vars
}

const SAFE_ENV_KEYS: &[&str] = &[
    "APPDATA",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "ComSpec",
    "HOME",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "OS",
    "PATH",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "SHELL",
    "USERPROFILE",
];

fn is_secret_env_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    [
        "API_KEY",
        "AUTH",
        "CREDENTIAL",
        "KEY",
        "PASSWORD",
        "SECRET",
        "TOKEN",
    ]
    .iter()
    .any(|needle| upper.contains(needle))
}

fn resolve_command_from_path(binary: &str, path_value: &str) -> Option<String> {
    let names = command_lookup_names(binary);
    for dir in split_pathbufs(path_value) {
        for name in &names {
            let candidate = dir.join(name);
            if is_executable_candidate(&candidate) {
                return Some(path_to_string(candidate));
            }
        }
    }
    None
}

fn command_lookup_names(binary: &str) -> Vec<OsString> {
    #[cfg(windows)]
    {
        let binary_path = Path::new(binary);
        if binary_path.extension().is_some() {
            return vec![OsString::from(binary)];
        }

        let mut names = vec![OsString::from(binary)];
        let pathext =
            std::env::var_os("PATHEXT").unwrap_or_else(|| OsString::from(".COM;.EXE;.BAT;.CMD"));
        for ext in pathext.to_string_lossy().split(';') {
            let ext = ext.trim();
            if ext.is_empty() {
                continue;
            }
            names.push(OsString::from(format!(
                "{}{}",
                binary,
                ext.to_ascii_lowercase()
            )));
            names.push(OsString::from(format!(
                "{}{}",
                binary,
                ext.to_ascii_uppercase()
            )));
        }
        names
    }

    #[cfg(not(windows))]
    {
        vec![OsString::from(binary)]
    }
}

fn is_executable_candidate(path: &Path) -> bool {
    path.is_file()
}

fn split_path_entries(path_value: &str) -> Vec<String> {
    split_pathbufs(path_value)
        .into_iter()
        .map(path_to_string)
        .collect()
}

fn split_pathbufs(path_value: &str) -> Vec<PathBuf> {
    std::env::split_paths(OsStr::new(path_value)).collect()
}

fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().to_string()
}

fn truncate(value: String, limit: usize) -> String {
    if value.len() <= limit {
        return value;
    }

    let mut end = limit;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...<truncated>", &value[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_env_keys_are_filtered() {
        assert!(is_secret_env_key("ANTHROPIC_API_KEY"));
        assert!(is_secret_env_key("SOME_AUTH_TOKEN"));
        assert!(!is_secret_env_key("PATH"));
        assert!(!is_secret_env_key("LOCALAPPDATA"));
    }

    #[test]
    fn path_status_reports_metadata_without_contents() {
        let status = path_status("missing", PathBuf::from("/definitely/not/a/ccem/path"));
        assert_eq!(status.label, "missing");
        assert!(!status.exists);
        assert!(status.error.is_some());
    }

    #[test]
    fn truncate_preserves_utf8_boundaries() {
        let truncated = truncate("hello世界".to_string(), 7);
        assert!(truncated.starts_with("hello"));
        assert!(truncated.ends_with("...<truncated>"));
    }

    #[test]
    fn detects_windows_batch_wrappers_for_version_probe() {
        assert!(is_windows_batch_path(
            "C:\\Users\\wzt\\AppData\\Roaming\\npm\\claude.cmd"
        ));
        assert!(is_windows_batch_path("ccem.BAT"));
        assert!(!is_windows_batch_path("/usr/local/bin/node"));
    }
}
