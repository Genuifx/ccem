use crate::config::MANAGED_CLAUDE_ENV_KEYS;
use crate::diagnostic_log;
use crate::terminal::{
    get_user_path, resolve_claude_path, resolve_codex_path, resolve_opencode_path,
    resolve_tmux_path,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
#[cfg(test)]
use std::sync::Mutex;
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

static TMUX_BINARY: OnceLock<String> = OnceLock::new();
#[cfg(test)]
static TMUX_INTEGRATION_TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
#[cfg(test)]
static TMUX_INTEGRATION_TEST_SOCKET_PATH: OnceLock<PathBuf> = OnceLock::new();

const DEFAULT_TMUX_SESSION: &str = "ccem";
const DEFAULT_TMUX_WINDOW: &str = "main";
const LAUNCH_TARGET_HEALTHCHECK_DELAY: Duration = Duration::from_millis(350);
const LAUNCH_ERROR_PANE_TAIL_CHARS: usize = 1_600;
const LAUNCH_DIAGNOSTIC_PANE_MAX_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct TmuxWindowInfo {
    pub session_name: String,
    pub window_name: String,
    pub window_index: u32,
    pub pane_pid: Option<u32>,
    pub session_attached_clients: u32,
    pub target: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TmuxLaunchSpec {
    command: String,
    environment: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TmuxLaunchPaneState {
    target: String,
    window_index: u32,
    window_name: String,
    pane_dead: bool,
    pane_dead_status: Option<i32>,
    pane_dead_signal: Option<String>,
    pane_active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CapturedPaneOutput {
    output: String,
    truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ManagedTmuxTargetAction {
    KillSession(String),
    KillWindow(String),
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeTerminalState {
    Idle,
    Processing,
    WaitingApproval,
    Unknown,
}

#[derive(Debug, Clone)]
pub struct TmuxManager {
    session_prefix: String,
}

impl Default for TmuxManager {
    fn default() -> Self {
        Self {
            session_prefix: DEFAULT_TMUX_SESSION.to_string(),
        }
    }
}

impl TmuxManager {
    pub fn session_name(&self) -> &str {
        &self.session_prefix
    }

    pub fn ensure_server(&self) -> Result<(), String> {
        Self::check_tmux_installed()
    }

    pub fn create_session(
        &self,
        runtime_id: &str,
        client: &str,
        env_name: &str,
        client_args: &[String],
        env_vars: &HashMap<String, String>,
        working_dir: &Path,
    ) -> Result<TmuxWindowInfo, String> {
        Self::check_tmux_installed()?;
        let session_name = session_name_for_runtime(runtime_id, &self.session_prefix);
        let window_name = DEFAULT_TMUX_WINDOW.to_string();
        let working_dir_str = working_dir.to_str().ok_or_else(|| {
            format!(
                "Working directory is not valid UTF-8: {}",
                working_dir.display()
            )
        })?;
        let launch_environment_target = session_name.clone();
        let tmux_binary = resolve_tmux_binary()?.to_string();
        diagnostic_log::append_session_launch_event(
            "tmux.create_session.start",
            serde_json::json!({
                "runtime_id": runtime_id,
                "session_name": &session_name,
                "client": client,
                "env_name": env_name,
                "working_dir": working_dir_str,
                "tmux_binary": &tmux_binary,
                "env_keys": sorted_env_keys(env_vars),
                "client_arg_count": client_args.len(),
            }),
        );
        let launch_spec = build_tmux_launch_spec(
            client,
            client_args,
            env_vars,
            &launch_environment_target,
            &tmux_binary,
        );
        let mut create_args = vec![
            "new-session".to_string(),
            "-d".to_string(),
            "-P".to_string(),
            "-F".to_string(),
            "#{window_index}".to_string(),
            "-s".to_string(),
            session_name.clone(),
            "-n".to_string(),
            window_name.clone(),
            "-c".to_string(),
            working_dir_str.to_string(),
        ];
        for entry in &launch_spec.environment {
            create_args.push("-e".to_string());
            create_args.push(entry.clone());
        }
        create_args.push(launch_spec.command.clone());
        create_args.extend([
            ";".to_string(),
            "set-option".to_string(),
            "-w".to_string(),
            "-t".to_string(),
            session_name.clone(),
            "remain-on-exit".to_string(),
            "on".to_string(),
        ]);

        let window_index = match self.run_create_command(&session_name, &create_args) {
            Ok(index) => index,
            Err(error) if is_tmux_session_create_race_error(&error) => {
                diagnostic_log::append_session_launch_event(
                    "tmux.create_session.race",
                    serde_json::json!({
                        "runtime_id": runtime_id,
                        "session_name": &session_name,
                        "error": &error,
                    }),
                );
                self.inspect_target(&session_name)?.window_index
            }
            Err(error) => {
                let cleanup_error = self.cleanup_partial_create(&session_name);
                diagnostic_log::append_session_launch_event(
                    "tmux.create_session.create_error",
                    serde_json::json!({
                        "runtime_id": runtime_id,
                        "session_name": &session_name,
                        "error": &error,
                        "cleanup_error": cleanup_error.as_deref(),
                    }),
                );
                return Err(cleanup_error
                    .map(|cleanup| format!("{}; cleanup failed: {}", error, cleanup))
                    .unwrap_or(error));
            }
        };
        let target = format!("{}:{}", session_name, window_index);

        let mut window = match self.inspect_target(&target) {
            Ok(window) => window,
            Err(_) => TmuxWindowInfo {
                session_name,
                window_name: window_name.clone(),
                window_index,
                pane_pid: None,
                session_attached_clients: 0,
                target,
            },
        };

        if let Err(error) = self.configure_session_status(&window.session_name, env_name, env_vars)
        {
            eprintln!(
                "Failed to configure tmux status for {}: {}",
                window.session_name, error
            );
        }

        match self.verify_target_survived_launch(runtime_id, &window.target, env_vars) {
            Ok(live_window) => {
                window = live_window;
                diagnostic_log::append_session_launch_event(
                    "tmux.create_session.healthcheck.ok",
                    serde_json::json!({
                        "runtime_id": runtime_id,
                        "session_name": &window.session_name,
                        "target": &window.target,
                        "pane_pid": window.pane_pid,
                        "window_name": &window.window_name,
                        "window_index": window.window_index,
                    }),
                );
            }
            Err(error) => {
                diagnostic_log::append_session_launch_event(
                    "tmux.create_session.healthcheck.error",
                    serde_json::json!({
                        "runtime_id": runtime_id,
                        "session_name": &window.session_name,
                        "target": &window.target,
                        "error": &error,
                    }),
                );
                return Err(error);
            }
        }

        Ok(window)
    }

    pub fn configure_session_status(
        &self,
        session_name: &str,
        env_name: &str,
        env_vars: &HashMap<String, String>,
    ) -> Result<(), String> {
        let model_full = derive_runtime_model_label(env_vars);
        let model_compact = compact_model_label(&model_full);

        let options = [
            ("status", "on".to_string()),
            ("status-interval", "2".to_string()),
            ("status-left-length", "80".to_string()),
            ("status-right-length", "140".to_string()),
            ("window-status-format", String::new()),
            ("window-status-current-format", String::new()),
            ("window-status-separator", String::new()),
            ("@ccem_env", env_name.to_string()),
            ("@ccem_model", model_full),
            ("@ccem_model_short", model_compact),
            ("status-left", build_status_left_format()),
            ("status-right", build_status_right_format()),
        ];

        for (option, value) in options {
            let status = tmux_command()?
                .args(["set-option", "-t", session_name, option, &value])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map_err(|error| {
                    format!(
                        "Failed to set tmux option '{}' for session '{}': {}",
                        option, session_name, error
                    )
                })?;

            if !status.success() {
                return Err(format!(
                    "tmux set-option {} failed for session {}",
                    option, session_name
                ));
            }
        }

        Ok(())
    }

    fn run_create_command(&self, target_name: &str, args: &[String]) -> Result<u32, String> {
        let output = tmux_command()?.args(args).output().map_err(|error| {
            format!("Failed to create tmux window '{}': {}", target_name, error)
        })?;

        if !output.status.success() {
            return Err(format!(
                "tmux failed to create window '{}': {}",
                target_name,
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }

        String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse::<u32>()
            .map_err(|error| {
                format!(
                    "Failed to parse tmux window index for '{}': {}",
                    target_name, error
                )
            })
    }

    pub fn list_sessions(&self) -> Result<Vec<TmuxWindowInfo>, String> {
        Self::check_tmux_installed()?;
        let output = tmux_command()?
            .args(["list-sessions", "-F", "#{session_name}"])
            .output()
            .map_err(|error| format!("Failed to list tmux sessions: {}", error))?;

        if !output.status.success() {
            let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if is_missing_tmux_session_error(&error) {
                return Ok(Vec::new());
            }
            return Err(format!("tmux list-sessions failed: {}", error));
        }

        let mut windows = Vec::new();
        for session_name in String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .filter(|name| is_managed_session_name(name, &self.session_prefix))
        {
            let output = tmux_command()?
                .args([
                    "list-windows",
                    "-t",
                    session_name,
                    "-F",
                    "#{window_index}|#{window_name}|#{pane_pid}|#{session_attached}",
                ])
                .output()
                .map_err(|error| {
                    format!(
                        "Failed to list tmux windows for session '{}': {}",
                        session_name, error
                    )
                })?;

            if !output.status.success() {
                let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
                if is_missing_tmux_session_error(&error) {
                    continue;
                }
                return Err(format!(
                    "tmux list-windows failed for session '{}': {}",
                    session_name, error
                ));
            }

            windows.extend(
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .filter_map(|line| parse_window_line(session_name, line))
                    .filter(|info| info.window_name != "bootstrap"),
            );
        }
        Ok(windows)
    }

    pub fn cleanup_orphaned_managed_sessions(
        &self,
        active_runtime_ids: &[String],
    ) -> Result<Vec<String>, String> {
        if Self::check_tmux_installed().is_err() {
            return Ok(Vec::new());
        }

        let windows = self.list_sessions()?;
        let actions =
            orphaned_managed_tmux_targets(&windows, active_runtime_ids, &self.session_prefix);
        let mut cleaned = Vec::new();

        for action in actions {
            match action {
                ManagedTmuxTargetAction::KillSession(session_name) => {
                    self.kill_session_target(&session_name)?;
                    cleaned.push(session_name);
                }
                ManagedTmuxTargetAction::KillWindow(target) => {
                    self.kill_window_target(&target)?;
                    cleaned.push(target);
                }
            }
        }

        Ok(cleaned)
    }

    pub fn get_window_info(&self, runtime_id: &str) -> Result<TmuxWindowInfo, String> {
        for target in target_candidates_for_runtime(runtime_id, &self.session_prefix) {
            if let Ok(info) = self.inspect_target(&target) {
                return Ok(info);
            }
        }
        Err(format!("tmux window not found for runtime {}", runtime_id))
    }

    pub fn get_attach_target(&self, runtime_id: &str) -> Result<String, String> {
        Ok(self.get_window_info(runtime_id)?.target)
    }

    pub fn resolve_live_attach_target(
        &self,
        runtime_id: &str,
        persisted_target: Option<&str>,
    ) -> Result<String, String> {
        Self::check_tmux_installed()?;
        let candidates = attach_target_candidates_for_runtime(
            runtime_id,
            &self.session_prefix,
            persisted_target,
        );

        for target in &candidates {
            if self.target_exists(target)? {
                return Ok(target.clone());
            }
        }

        Err(format!(
            "tmux target not found for runtime {}{}",
            runtime_id,
            if candidates.is_empty() {
                String::new()
            } else {
                format!(" (checked: {})", candidates.join(", "))
            }
        ))
    }

    pub fn stop_session(&self, runtime_id: &str) -> Result<(), String> {
        let info = match self.get_window_info(runtime_id) {
            Ok(info) => info,
            Err(error)
                if error.contains("tmux window not found")
                    || error.contains("no server running")
                    || error.contains("list-windows failed") =>
            {
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        self.send_named_key_to_target(&info.target, "C-c")?;
        thread::sleep(Duration::from_millis(1200));
        if self.target_exists(&info.target)? {
            self.kill_window_target(&info.target)?;
        }
        Ok(())
    }

    pub fn capture_pane(&self, runtime_id: &str, lines: u32) -> Result<String, String> {
        let info = self.get_window_info(runtime_id)?;
        self.capture_pane_target(&info.target, lines)
    }

    pub fn capture_pane_target(&self, target: &str, lines: u32) -> Result<String, String> {
        let start = format!("-{}", lines.max(20));
        let output = tmux_command()?
            .args(["capture-pane", "-t", target, "-p", "-S", &start])
            .output()
            .map_err(|error| format!("Failed to capture tmux pane {}: {}", target, error))?;

        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            Err(format!(
                "tmux capture-pane failed for {}: {}",
                target,
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        }
    }

    fn capture_pane_all_target(&self, target: &str) -> Result<CapturedPaneOutput, String> {
        let capture_path = std::env::temp_dir().join(format!(
            "ccem-launch-pane-{}-{}.log",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let mut options = OpenOptions::new();
        options.create_new(true).read(true).write(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut capture_file = options.open(&capture_path).map_err(|error| {
            format!(
                "Failed to create bounded pane capture for {}: {}",
                target, error
            )
        })?;

        let result = (|| {
            let output = tmux_command()?
                .args(["capture-pane", "-t", target, "-p", "-S", "-"])
                .stdout(Stdio::from(capture_file.try_clone().map_err(|error| {
                    format!("Failed to prepare pane capture for {}: {}", target, error)
                })?))
                .output()
                .map_err(|error| format!("Failed to capture tmux pane {}: {}", target, error))?;

            if !output.status.success() {
                return Err(format!(
                    "tmux capture-pane failed for {}: {}",
                    target,
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }

            read_bounded_pane_capture(&mut capture_file, LAUNCH_DIAGNOSTIC_PANE_MAX_BYTES)
                .map_err(|error| format!("Failed to read pane capture {}: {}", target, error))
        })();
        drop(capture_file);
        let _ = std::fs::remove_file(capture_path);
        result
    }

    pub fn send_terminal_input(&self, runtime_id: &str, data: &str) -> Result<(), String> {
        let target = self.get_attach_target(runtime_id)?;
        self.send_terminal_input_to_target(&target, data)
    }

    pub fn send_terminal_input_to_target(&self, target: &str, data: &str) -> Result<(), String> {
        match data {
            "\r" => self.send_named_key_to_target(target, "Enter"),
            "\n" => self.send_named_key_to_target(target, "Enter"),
            "\t" => self.send_named_key_to_target(target, "Tab"),
            "\u{7f}" => self.send_named_key_to_target(target, "BSpace"),
            "\u{3}" => self.send_named_key_to_target(target, "C-c"),
            "\u{4}" => self.send_named_key_to_target(target, "C-d"),
            "\u{1b}" => self.send_named_key_to_target(target, "Escape"),
            "\u{1b}[A" => self.send_named_key_to_target(target, "Up"),
            "\u{1b}[B" => self.send_named_key_to_target(target, "Down"),
            "\u{1b}[C" => self.send_named_key_to_target(target, "Right"),
            "\u{1b}[D" => self.send_named_key_to_target(target, "Left"),
            _ if should_use_paste_buffer(data) => self.send_long_text_to_target(target, data),
            _ => self.send_literal_to_target(target, data),
        }
    }

    pub fn send_message(&self, runtime_id: &str, message: &str) -> Result<(), String> {
        if self.detect_state(runtime_id)? == ClaudeTerminalState::WaitingApproval {
            return Err(
                "Claude is waiting for approval. Approve or deny the request before sending a new message."
                    .to_string(),
            );
        }

        let target = self.get_attach_target(runtime_id)?;
        if should_use_paste_buffer(message) {
            self.send_long_text_to_target(&target, message)?;
        } else {
            self.send_literal_to_target(&target, message)?;
        }
        self.send_named_key_to_target(&target, "Enter")
    }

    pub fn send_approval(&self, runtime_id: &str, approved: bool) -> Result<(), String> {
        if self.detect_state(runtime_id)? != ClaudeTerminalState::WaitingApproval {
            return Err("Claude is not currently waiting for approval".to_string());
        }

        let target = self.get_attach_target(runtime_id)?;
        self.send_named_key_to_target(&target, if approved { "y" } else { "n" })
    }

    pub fn detect_state(&self, runtime_id: &str) -> Result<ClaudeTerminalState, String> {
        let captured = self.capture_pane(runtime_id, 24)?;
        Ok(detect_state_from_capture(&captured))
    }

    pub fn check_tmux_installed() -> Result<(), String> {
        resolve_tmux_binary().map(|_| ())
    }

    pub fn has_session(&self, session_name: &str) -> Result<bool, String> {
        let status = tmux_command()?
            .args(["has-session", "-t", session_name])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| {
                format!("Failed to check tmux session '{}': {}", session_name, error)
            })?;
        Ok(status.success())
    }

    fn inspect_target(&self, target: &str) -> Result<TmuxWindowInfo, String> {
        let output = tmux_command()?
            .args([
                "display-message",
                "-p",
                "-t",
                target,
                "#{session_name}|#{window_name}|#{window_index}|#{pane_pid}|#{session_attached}",
            ])
            .stdin(Stdio::null())
            .output()
            .map_err(|error| format!("Failed to inspect tmux target {}: {}", target, error))?;

        if !output.status.success() {
            return Err(format!(
                "tmux target lookup failed for {}: {}",
                target,
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }

        let info = parse_target_line(&String::from_utf8_lossy(&output.stdout))
            .ok_or_else(|| format!("Failed to parse tmux target metadata for {}", target))?;
        if target_matches_info(target, &info) {
            Ok(info)
        } else {
            Err(format!(
                "tmux target lookup for {} resolved to {}",
                target, info.target
            ))
        }
    }

    fn target_exists(&self, target: &str) -> Result<bool, String> {
        let output = tmux_command()?
            .args([
                "display-message",
                "-p",
                "-t",
                target,
                "#{session_name}|#{window_name}|#{window_index}|#{pane_pid}|#{session_attached}",
            ])
            .stdin(Stdio::null())
            .output()
            .map_err(|error| format!("Failed to inspect tmux target {}: {}", target, error))?;
        if !output.status.success() {
            return Ok(false);
        }

        Ok(parse_target_line(&String::from_utf8_lossy(&output.stdout))
            .is_some_and(|info| target_matches_info(target, &info)))
    }

    fn launch_pane_states(&self, session_name: &str) -> Result<Vec<TmuxLaunchPaneState>, String> {
        let output = tmux_command()?
            .args([
                "list-panes",
                "-s",
                "-t",
                session_name,
                "-F",
                "#{window_index}|#{window_name}|#{pane_index}|#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}|#{pane_active}",
            ])
            .stdin(Stdio::null())
            .output()
            .map_err(|error| {
                format!(
                    "Failed to inspect launch panes for session {}: {}",
                    session_name, error
                )
            })?;

        if !output.status.success() {
            return Err(format!(
                "tmux launch pane lookup failed for {}: {}",
                session_name,
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }

        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| parse_launch_pane_line(session_name, line))
            .collect())
    }

    fn clear_launch_retention(&self, target: &str) -> Result<(), String> {
        let status = tmux_command()?
            .args(["set-option", "-wu", "-t", target, "remain-on-exit"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| {
                format!(
                    "Failed to restore remain-on-exit for tmux target {}: {}",
                    target, error
                )
            })?;

        if status.success() {
            Ok(())
        } else {
            Err(format!(
                "tmux failed to restore remain-on-exit for target {}",
                target
            ))
        }
    }

    fn cleanup_partial_create(&self, session_name: &str) -> Option<String> {
        match self.target_exists(session_name) {
            Ok(true) => self.kill_session_target(session_name).err(),
            Ok(false) => None,
            Err(error) => Some(error),
        }
    }

    fn kill_pane_target(&self, target: &str) -> Result<(), String> {
        let status = tmux_command()?
            .args(["kill-pane", "-t", target])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| format!("Failed to kill tmux pane {}: {}", target, error))?;

        if status.success() {
            Ok(())
        } else {
            Err(format!("tmux kill-pane failed for {}", target))
        }
    }

    fn restore_launch_lifecycle(
        &self,
        session_name: &str,
        launch_target: &str,
        pane_states: &[TmuxLaunchPaneState],
    ) -> Result<Vec<TmuxLaunchPaneState>, String> {
        if let Some(retention_window) = pane_states
            .iter()
            .find(|pane| launch_pane_matches_target(pane, launch_target))
        {
            let retention_target =
                format!("{}:{}", session_name, retention_window.window_index);
            if self.target_exists(&retention_target)? {
                if let Err(error) = self.clear_launch_retention(&retention_target) {
                    if self.target_exists(&retention_target)? {
                        return Err(error);
                    }
                }
            }
        }

        let retained_launch_panes = pane_states
            .iter()
            .filter(|pane| pane.pane_dead && launch_pane_matches_target(pane, launch_target))
            .map(|pane| pane.target.clone())
            .collect::<Vec<_>>();
        let mut removal_errors = Vec::new();
        for pane_target in &retained_launch_panes {
            if let Err(error) = self.kill_pane_target(pane_target) {
                removal_errors.push(error);
            }
        }

        let refreshed = self.launch_pane_states(session_name)?;
        let stale_launch_panes = refreshed
            .iter()
            .filter(|pane| pane.pane_dead && launch_pane_matches_target(pane, launch_target))
            .map(|pane| pane.target.as_str())
            .collect::<Vec<_>>();
        if !stale_launch_panes.is_empty() {
            let removal_detail = if removal_errors.is_empty() {
                String::new()
            } else {
                format!(" ({})", removal_errors.join("; "))
            };
            return Err(format!(
                "tmux retained dead launch panes after lifecycle restore: {}{}",
                stale_launch_panes.join(", "),
                removal_detail
            ));
        }

        Ok(refreshed)
    }

    fn verify_target_survived_launch(
        &self,
        runtime_id: &str,
        target: &str,
        env_vars: &HashMap<String, String>,
    ) -> Result<TmuxWindowInfo, String> {
        thread::sleep(LAUNCH_TARGET_HEALTHCHECK_DELAY);
        let session_name = target.split_once(':').map(|(session, _)| session).unwrap_or(target);
        let pane_states = match self.launch_pane_states(session_name) {
            Ok(states) if !states.is_empty() => states,
            Ok(_) => {
                let cleanup_error = self.kill_session_target(session_name).err();
                diagnostic_log::append_session_launch_event(
                    "tmux.create_session.pane_dead",
                    serde_json::json!({
                        "runtime_id": runtime_id,
                        "session_name": session_name,
                        "target": target,
                        "exit_code": null,
                        "signal": null,
                        "pane_output": "",
                        "pane_output_truncated": false,
                        "capture_error": "tmux returned no panes for the launch session",
                        "cleanup_error": cleanup_error,
                    }),
                );
                return Err(format!(
                    "session_command_exited: tmux target {} exited before output could be captured",
                    target
                ));
            }
            Err(error) => {
                let cleanup_error = self.kill_session_target(session_name).err();
                diagnostic_log::append_session_launch_event(
                    "tmux.create_session.pane_dead",
                    serde_json::json!({
                        "runtime_id": runtime_id,
                        "session_name": session_name,
                        "target": target,
                        "exit_code": null,
                        "signal": null,
                        "pane_output": "",
                        "pane_output_truncated": false,
                        "capture_error": &error,
                        "cleanup_error": cleanup_error,
                    }),
                );
                return Err(format!(
                    "session_command_exited: tmux target {} exited before output could be captured ({})",
                    target, error
                ));
            }
        };

        if pane_states.iter().any(|pane| !pane.pane_dead) {
            let restored_states =
                match self.restore_launch_lifecycle(session_name, target, &pane_states) {
                    Ok(states) => states,
                    Err(error) => {
                        let cleanup_error = self.kill_session_target(session_name).err();
                        diagnostic_log::append_session_launch_event(
                            "tmux.create_session.retention_restore_error",
                            serde_json::json!({
                                "runtime_id": runtime_id,
                                "session_name": session_name,
                                "target": target,
                                "error": &error,
                                "cleanup_error": cleanup_error.as_deref(),
                            }),
                        );
                        return Err(error);
                    }
                };
            let live_pane = restored_states
                .iter()
                .find(|pane| !pane.pane_dead && pane.pane_active)
                .or_else(|| restored_states.iter().find(|pane| !pane.pane_dead))
                .ok_or_else(|| {
                    format!(
                        "tmux session {} lost its live pane while restoring launch lifecycle",
                        session_name
                    )
                })?;

            return self.inspect_target(&format!(
                "{}:{}",
                session_name, live_pane.window_index
            ));
        }

        let failed_pane = pane_states
            .iter()
            .find(|pane| launch_pane_matches_target(pane, target))
            .or_else(|| pane_states.iter().find(|pane| pane.pane_active))
            .unwrap_or(&pane_states[0]);
        let (pane_output, pane_output_truncated, capture_error) =
            match self.capture_pane_all_target(&failed_pane.target) {
                Ok(capture) => (
                    redact_sensitive_launch_output(&capture.output, env_vars),
                    capture.truncated,
                    None,
                ),
                Err(error) => (String::new(), false, Some(error)),
            };
        let cleanup_error = self.kill_session_target(session_name).err();
        diagnostic_log::append_session_launch_event(
            "tmux.create_session.pane_dead",
            serde_json::json!({
                "runtime_id": runtime_id,
                "session_name": session_name,
                "target": &failed_pane.target,
                "window_index": failed_pane.window_index,
                "window_name": &failed_pane.window_name,
                "exit_code": failed_pane.pane_dead_status,
                "signal": failed_pane.pane_dead_signal,
                "pane_output": &pane_output,
                "pane_output_truncated": pane_output_truncated,
                "capture_error": capture_error.as_deref(),
                "cleanup_error": cleanup_error.as_deref(),
            }),
        );

        let exit_description = failed_pane
            .pane_dead_status
            .map(|status| format!("exit code {}", status))
            .or_else(|| {
                failed_pane
                    .pane_dead_signal
                    .as_deref()
                    .map(|signal| format!("signal {}", signal))
            })
            .unwrap_or_else(|| "unknown exit status".to_string());
        let output_tail = launch_error_pane_tail(&pane_output);
        let output_detail = if output_tail.is_empty() {
            capture_error
                .as_deref()
                .map(|error| format!("; pane output unavailable: {}", error))
                .unwrap_or_else(|| "; no pane output was captured".to_string())
        } else {
            format!("; pane output:\n{}", output_tail)
        };
        let cleanup_detail = cleanup_error
            .as_deref()
            .map(|error| format!("; cleanup failed: {}", error))
            .unwrap_or_default();

        Err(format!(
            "session_command_exited: session command exited during launch ({}){}{}",
            exit_description, output_detail, cleanup_detail
        ))
    }

    fn kill_window_target(&self, target: &str) -> Result<(), String> {
        let status = tmux_command()?
            .args(["kill-window", "-t", target])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| format!("Failed to kill tmux window {}: {}", target, error))?;

        if status.success() {
            Ok(())
        } else {
            Err(format!("tmux kill-window failed for {}", target))
        }
    }

    fn kill_session_target(&self, session_name: &str) -> Result<(), String> {
        let status = tmux_command()?
            .args(["kill-session", "-t", session_name])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| format!("Failed to kill tmux session {}: {}", session_name, error))?;

        if status.success() {
            Ok(())
        } else {
            Err(format!("tmux kill-session failed for {}", session_name))
        }
    }

    fn send_named_key_to_target(&self, target: &str, key: &str) -> Result<(), String> {
        let status = tmux_command()?
            .args(["send-keys", "-t", target, key])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| {
                format!("Failed to send tmux key '{}' to {}: {}", key, target, error)
            })?;

        if status.success() {
            Ok(())
        } else {
            Err(format!("tmux send-keys {} failed for {}", key, target))
        }
    }

    fn send_literal_to_target(&self, target: &str, text: &str) -> Result<(), String> {
        let status = tmux_command()?
            .args(["send-keys", "-t", target, "-l", text])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| {
                format!("Failed to send literal tmux input to {}: {}", target, error)
            })?;

        if status.success() {
            Ok(())
        } else {
            Err(format!("tmux send-keys -l failed for {}", target))
        }
    }

    fn send_long_text_to_target(&self, target: &str, text: &str) -> Result<(), String> {
        let temp_path = std::env::temp_dir().join(format!(
            "ccem-tmux-buffer-{}-{}.txt",
            std::process::id(),
            sanitize_target_for_filename(target)
        ));
        std::fs::write(&temp_path, text)
            .map_err(|error| format!("Failed to write tmux paste buffer temp file: {}", error))?;

        let load_status = tmux_command()?
            .args(["load-buffer", temp_path.to_string_lossy().as_ref()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| format!("Failed to load tmux buffer for {}: {}", target, error))?;

        if !load_status.success() {
            let _ = std::fs::remove_file(&temp_path);
            return Err(format!("tmux load-buffer failed for {}", target));
        }

        let paste_status = tmux_command()?
            .args(["paste-buffer", "-d", "-t", target])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| format!("Failed to paste tmux buffer into {}: {}", target, error))?;

        let _ = std::fs::remove_file(&temp_path);
        if paste_status.success() {
            Ok(())
        } else {
            Err(format!("tmux paste-buffer failed for {}", target))
        }
    }
}

fn session_name_for_runtime(runtime_id: &str, session_prefix: &str) -> String {
    format!("{}-{}", session_prefix, sanitize_runtime_id(runtime_id))
}

fn derive_runtime_model_label(env_vars: &HashMap<String, String>) -> String {
    env_vars
        .get("ANTHROPIC_MODEL")
        .or_else(|| env_vars.get("ANTHROPIC_DEFAULT_OPUS_MODEL"))
        .cloned()
        .unwrap_or_else(|| "default".to_string())
}

fn compact_model_label(model: &str) -> String {
    let lower = model.to_ascii_lowercase();
    if lower.contains("opus") {
        "opus".to_string()
    } else if lower.contains("sonnet") {
        "sonnet".to_string()
    } else if lower.contains("haiku") {
        "haiku".to_string()
    } else if lower.contains("gpt-5") {
        "gpt-5".to_string()
    } else {
        model.to_string()
    }
}

const WIDTH_GE_36_PATTERN: &str = "^(3[6-9]|[4-9][0-9]|[1-9][0-9][0-9].*)$";
const WIDTH_GE_72_PATTERN: &str = "^(7[2-9]|[89][0-9]|[1-9][0-9][0-9].*)$";
const WIDTH_GE_96_PATTERN: &str = "^(9[6-9]|[1-9][0-9][0-9].*)$";
const WIDTH_GE_110_PATTERN: &str = "^(11[0-9]|1[2-9][0-9]|[2-9][0-9][0-9].*)$";
const WIDTH_GE_132_PATTERN: &str = "^(13[2-9]|1[4-9][0-9]|[2-9][0-9][0-9].*)$";

fn width_at_least(pattern: &str) -> String {
    format!("#{{m|r:{pattern},#{{window_width}}}}")
}

fn build_status_left_format() -> String {
    format!(
        "#{{?{},#{{pane_current_path}},#{{b:pane_current_path}}}}",
        width_at_least(WIDTH_GE_110_PATTERN)
    )
}

fn build_status_right_format() -> String {
    let full = "#{@ccem_model} | #{@ccem_env} | ccem";
    let compact = "#{@ccem_model_short} | #{@ccem_env} | ccem";
    let base = "#{@ccem_env} | ccem";

    format!(
        "#{{?{ge_96},{full},#{{?{ge_72},{compact},#{{?{ge_36},{base},}}}}}}",
        ge_96 = width_at_least(WIDTH_GE_96_PATTERN),
        ge_72 = width_at_least(WIDTH_GE_72_PATTERN),
        ge_36 = width_at_least(WIDTH_GE_36_PATTERN),
        full = full,
        compact = compact,
        base = base,
    )
}

pub fn window_name_for_runtime(runtime_id: &str) -> String {
    let sanitized = sanitize_runtime_id(runtime_id);
    let short = if sanitized.len() > 8 {
        sanitized[sanitized.len() - 8..].to_string()
    } else {
        sanitized
    };
    format!("ccem-{}", short)
}

fn window_name_candidates_for_runtime(runtime_id: &str) -> Vec<String> {
    let primary = window_name_for_runtime(runtime_id);
    let legacy = format!("ccem-{}", runtime_id.chars().take(8).collect::<String>());
    if legacy == primary {
        vec![primary]
    } else {
        vec![primary, legacy]
    }
}

fn target_candidates_for_runtime(runtime_id: &str, session_prefix: &str) -> Vec<String> {
    let session_name = session_name_for_runtime(runtime_id, session_prefix);
    let mut targets = vec![format!("{}:{}", session_name, DEFAULT_TMUX_WINDOW)];
    targets.push(session_name);
    targets.extend(
        window_name_candidates_for_runtime(runtime_id)
            .into_iter()
            .map(|window_name| format!("{}:{}", session_prefix, window_name)),
    );
    targets
}

fn attach_target_candidates_for_runtime(
    runtime_id: &str,
    session_prefix: &str,
    persisted_target: Option<&str>,
) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();

    if let Some(target) = persisted_target
        .map(str::trim)
        .filter(|target| !target.is_empty())
    {
        if seen.insert(target.to_string()) {
            candidates.push(target.to_string());
        }
    }

    for target in target_candidates_for_runtime(runtime_id, session_prefix) {
        if seen.insert(target.clone()) {
            candidates.push(target);
        }
    }

    candidates
}

fn orphaned_managed_tmux_targets(
    windows: &[TmuxWindowInfo],
    active_runtime_ids: &[String],
    session_prefix: &str,
) -> Vec<ManagedTmuxTargetAction> {
    let active_session_names = active_runtime_ids
        .iter()
        .map(|runtime_id| session_name_for_runtime(runtime_id, session_prefix))
        .collect::<HashSet<_>>();
    let active_targets = active_runtime_ids
        .iter()
        .flat_map(|runtime_id| target_candidates_for_runtime(runtime_id, session_prefix))
        .collect::<HashSet<_>>();
    let mut seen_dedicated_sessions = HashSet::new();
    let mut actions = Vec::new();

    for window in windows {
        if !is_managed_session_name(&window.session_name, session_prefix) {
            continue;
        }

        // A manually attached tmux client is live user state, even if ccem lost
        // the runtime record that originally created the target.
        if window.session_attached_clients > 0 {
            continue;
        }

        if window.session_name == session_prefix {
            if !active_targets.contains(&window.target) {
                actions.push(ManagedTmuxTargetAction::KillWindow(window.target.clone()));
            }
            continue;
        }

        if active_session_names.contains(&window.session_name) {
            continue;
        }

        if seen_dedicated_sessions.insert(window.session_name.clone()) {
            actions.push(ManagedTmuxTargetAction::KillSession(
                window.session_name.clone(),
            ));
        }
    }

    actions
}

pub fn detect_state_from_capture(captured: &str) -> ClaudeTerminalState {
    let tail = captured
        .lines()
        .rev()
        .filter(|line| !line.trim().is_empty())
        .take(16)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");

    if contains_approval_pattern(&tail) {
        return ClaudeTerminalState::WaitingApproval;
    }
    if contains_processing_pattern(&tail) {
        return ClaudeTerminalState::Processing;
    }
    if contains_prompt_pattern(&tail) {
        return ClaudeTerminalState::Idle;
    }
    if tail.trim().is_empty() {
        return ClaudeTerminalState::Unknown;
    }
    ClaudeTerminalState::Processing
}

fn contains_processing_pattern(lines: &str) -> bool {
    let lower = lines.to_ascii_lowercase();
    if lower.contains("esc to interrupt") || lower.contains("ctrl+c to cancel") {
        return true;
    }

    lines.lines().any(|line| {
        let trimmed = line.trim();
        matches!(
            trimmed.chars().next(),
            Some('✳' | '✶' | '✢' | '✻' | '✽' | '✺' | '✹' | '✷' | '◐' | '◓' | '◑' | '◒')
        ) && (trimmed.contains('…') || trimmed.contains("..."))
    })
}

fn contains_prompt_pattern(lines: &str) -> bool {
    let trimmed = lines.trim_end();
    let lower = trimmed.to_ascii_lowercase();
    trimmed.contains("\n❯")
        || trimmed.contains("❯\u{a0}Try ")
        || trimmed.contains("❯ Try ")
        || trimmed.ends_with('❯')
        || trimmed.contains("\n>")
        || trimmed.ends_with('>')
        || trimmed.contains("accept edits on")
        || lower.contains("press enter")
}

fn contains_approval_pattern(lines: &str) -> bool {
    lines.contains("[Edit]")
        || lines.contains("[Shell]")
        || lines.contains("[Question]")
        || (lines.contains("Allow") && lines.contains("Deny"))
}

fn parse_window_line(session_name: &str, line: &str) -> Option<TmuxWindowInfo> {
    let mut parts = line.split('|');
    let window_index = parts.next()?.parse::<u32>().ok()?;
    let window_name = parts.next()?.to_string();
    let pane_pid = parts.next().and_then(|value| value.parse::<u32>().ok());
    let session_attached_clients = parts
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    Some(TmuxWindowInfo {
        session_name: session_name.to_string(),
        target: format!("{}:{}", session_name, window_name),
        window_name,
        window_index,
        pane_pid,
        session_attached_clients,
    })
}

fn parse_target_line(line: &str) -> Option<TmuxWindowInfo> {
    let mut parts = line.trim().split('|');
    let session_name = parts.next()?.to_string();
    let window_name = parts.next()?.to_string();
    let window_index = parts.next()?.parse::<u32>().ok()?;
    let pane_pid = parts.next().and_then(|value| value.parse::<u32>().ok());
    let session_attached_clients = parts
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    Some(TmuxWindowInfo {
        target: format!("{}:{}", session_name, window_index),
        session_name,
        window_name,
        window_index,
        pane_pid,
        session_attached_clients,
    })
}

fn parse_launch_pane_line(session_name: &str, line: &str) -> Option<TmuxLaunchPaneState> {
    let mut parts = line.trim().split('|');
    let window_index = parts.next()?.parse::<u32>().ok()?;
    let window_name = parts.next()?.to_string();
    let pane_index = parts.next()?.parse::<u32>().ok()?;
    let pane_dead = parts.next()? == "1";
    let pane_dead_status = parts.next().and_then(|value| value.parse::<i32>().ok());
    let pane_dead_signal = parts
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let pane_active = parts.next()? == "1";

    Some(TmuxLaunchPaneState {
        target: format!("{}:{}.{}", session_name, window_index, pane_index),
        window_index,
        window_name,
        pane_dead,
        pane_dead_status,
        pane_dead_signal,
        pane_active,
    })
}

fn launch_pane_matches_target(pane: &TmuxLaunchPaneState, target: &str) -> bool {
    pane.target
        .split_once(':')
        .map(|(session, _)| {
            target == session
                || target == format!("{}:{}", session, pane.window_index)
                || target == format!("{}:{}", session, pane.window_name)
                || target == pane.target
        })
        .unwrap_or(false)
}

fn launch_error_pane_tail(output: &str) -> String {
    let trimmed = output.trim();
    if trimmed.chars().count() <= LAUNCH_ERROR_PANE_TAIL_CHARS {
        return trimmed.to_string();
    }

    let tail = trimmed
        .chars()
        .rev()
        .take(LAUNCH_ERROR_PANE_TAIL_CHARS)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<String>();
    format!("…{}", tail)
}

fn read_bounded_pane_capture(
    capture_file: &mut File,
    max_bytes: u64,
) -> Result<CapturedPaneOutput, String> {
    let captured_bytes = capture_file
        .metadata()
        .map_err(|error| error.to_string())?
        .len();
    let truncated = captured_bytes > max_bytes;
    if truncated {
        capture_file
            .seek(SeekFrom::End(-(max_bytes as i64)))
            .map_err(|error| error.to_string())?;
    } else {
        capture_file
            .seek(SeekFrom::Start(0))
            .map_err(|error| error.to_string())?;
    }
    let mut bytes = Vec::with_capacity(captured_bytes.min(max_bytes) as usize);
    capture_file
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;

    Ok(CapturedPaneOutput {
        output: String::from_utf8_lossy(&bytes).to_string(),
        truncated,
    })
}

fn redact_sensitive_launch_output(
    output: &str,
    env_vars: &HashMap<String, String>,
) -> String {
    let mut sensitive_values = Vec::new();
    for (key, value) in env_vars {
        if value.is_empty() {
            continue;
        }
        if is_sensitive_launch_env_key(key) || is_sensitive_config_content_key(key) {
            sensitive_values.push(value.clone());
        }
        if is_sensitive_config_content_key(key) {
            if let Ok(config) = serde_json::from_str::<serde_json::Value>(value) {
                collect_sensitive_json_strings(&config, &mut sensitive_values);
            }
        }
    }
    sensitive_values.sort_unstable_by_key(|value| std::cmp::Reverse(value.len()));
    sensitive_values.dedup();

    sensitive_values
        .into_iter()
        .fold(output.to_string(), |redacted, value| {
            redacted.replace(&value, "[REDACTED]")
        })
}

fn is_sensitive_launch_env_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_uppercase)
        .collect::<String>();
    normalized.contains("APIKEY")
        || normalized.contains("TOKEN")
        || normalized.contains("SECRET")
        || normalized.contains("PASSWORD")
}

fn is_sensitive_config_content_key(key: &str) -> bool {
    key.to_ascii_uppercase().ends_with("CONFIG_CONTENT")
}

fn collect_sensitive_json_strings(
    value: &serde_json::Value,
    sensitive_values: &mut Vec<String>,
) {
    match value {
        serde_json::Value::Object(entries) => {
            for (key, nested) in entries {
                if is_sensitive_launch_env_key(key) {
                    collect_json_strings(nested, sensitive_values);
                } else {
                    collect_sensitive_json_strings(nested, sensitive_values);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_sensitive_json_strings(item, sensitive_values);
            }
        }
        _ => {}
    }
}

fn collect_json_strings(value: &serde_json::Value, sensitive_values: &mut Vec<String>) {
    match value {
        serde_json::Value::String(value) if !value.is_empty() => {
            sensitive_values.push(value.clone());
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_json_strings(item, sensitive_values);
            }
        }
        serde_json::Value::Object(entries) => {
            for nested in entries.values() {
                collect_json_strings(nested, sensitive_values);
            }
        }
        _ => {}
    }
}

fn target_matches_info(requested_target: &str, info: &TmuxWindowInfo) -> bool {
    requested_target == info.target
        || requested_target == info.session_name
        || requested_target == format!("{}:{}", info.session_name, info.window_name)
}

fn sorted_env_keys(env_vars: &HashMap<String, String>) -> Vec<String> {
    let mut keys = env_vars.keys().cloned().collect::<Vec<_>>();
    keys.sort();
    keys
}

fn build_tmux_launch_command(
    client: &str,
    client_args: &[String],
    env_vars: &HashMap<String, String>,
) -> String {
    build_tmux_launch_spec(
        client,
        client_args,
        env_vars,
        &format!("{DEFAULT_TMUX_SESSION}:{DEFAULT_TMUX_WINDOW}"),
        "tmux",
    )
    .command
}

fn build_tmux_launch_spec(
    client: &str,
    client_args: &[String],
    env_vars: &HashMap<String, String>,
    target: &str,
    tmux_binary: &str,
) -> TmuxLaunchSpec {
    let client_binary = match client {
        "codex" => resolve_codex_path().unwrap_or_else(|| "codex".to_string()),
        "opencode" => resolve_opencode_path().unwrap_or_else(|| "opencode".to_string()),
        _ => resolve_claude_path().unwrap_or_else(|| "claude".to_string()),
    };
    let mut environment = vec![format!("PATH={}", get_user_path())];
    let mut environment_keys = vec!["PATH".to_string()];

    let mut env_entries = env_vars.iter().collect::<Vec<_>>();
    env_entries.sort_by(|left, right| left.0.cmp(right.0));
    for (key, value) in env_entries {
        environment.push(format!("{}={}", key, value));
        environment_keys.push(key.clone());
    }

    let mut command_parts = vec![shell_quote(&client_binary)];
    command_parts.extend(client_args.iter().map(|arg| shell_quote(arg)));

    let environment_loader = build_tmux_environment_loader(&environment_keys, target, tmux_binary);
    let managed_env_keys = MANAGED_CLAUDE_ENV_KEYS.join(" ");

    TmuxLaunchSpec {
        command: format!(
            "unset {}; unset CLAUDECODE; {} exec {}",
            managed_env_keys,
            environment_loader,
            command_parts.join(" ")
        ),
        environment,
    }
}

fn build_tmux_environment_loader(
    environment_keys: &[String],
    target: &str,
    tmux_binary: &str,
) -> String {
    let key_list = environment_keys
        .iter()
        .map(|key| shell_quote(key))
        .collect::<Vec<_>>()
        .join(" ");

    format!(
        "__ccem_tmux={}; __ccem_target={}; for __ccem_key in {}; do \
         __ccem_line=\"$(\"$__ccem_tmux\" show-environment -t \"$__ccem_target\" \"$__ccem_key\" 2>/dev/null || true)\"; \
         case \"$__ccem_line\" in \"$__ccem_key=\"*) export \"$__ccem_line\" ;; esac; \
         done; unset __ccem_key __ccem_line __ccem_tmux __ccem_target;",
        shell_quote(tmux_binary),
        shell_quote(target),
        key_list
    )
}

fn should_use_paste_buffer(text: &str) -> bool {
    text.contains('\n')
        || text.contains('\r')
        || text.contains('\u{1b}')
        || text.len() > 120
        || text.chars().filter(|ch| ch.is_whitespace()).count() > 8
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn resolve_tmux_binary() -> Result<&'static str, String> {
    if let Some(path) = TMUX_BINARY.get() {
        return Ok(path.as_str());
    }

    let path = resolve_tmux_path().ok_or_else(|| {
        "tmux is not installed. Install it first, e.g. `brew install tmux`.".to_string()
    })?;

    let _ = TMUX_BINARY.set(path);
    Ok(TMUX_BINARY
        .get()
        .expect("tmux binary path should be initialized")
        .as_str())
}

fn tmux_command_for_binary(tmux_binary: &str) -> Command {
    #[cfg(test)]
    {
        let mut command = Command::new(tmux_binary);
        command
            .env_remove("TMUX")
            .env_remove("TMUX_PANE")
            .env_remove("TMUX_TMPDIR");
        #[cfg(unix)]
        command.args(["-f", "/dev/null"]);
        command.arg("-S").arg(tmux_integration_test_socket_path());
        command
    }

    #[cfg(not(test))]
    {
        Command::new(tmux_binary)
    }
}

#[cfg(test)]
fn tmux_integration_test_socket_path() -> &'static Path {
    TMUX_INTEGRATION_TEST_SOCKET_PATH
        .get_or_init(|| {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            std::env::temp_dir().join(format!(
                "ccem-tmux-test-{}-{nonce:x}.sock",
                std::process::id()
            ))
        })
        .as_path()
}

fn tmux_command() -> Result<Command, String> {
    Ok(tmux_command_for_binary(resolve_tmux_binary()?))
}

#[cfg(test)]
struct TmuxIntegrationTestGuard {
    _lock: std::sync::MutexGuard<'static, ()>,
}

#[cfg(test)]
impl Drop for TmuxIntegrationTestGuard {
    fn drop(&mut self) {
        if let Ok(mut command) = tmux_command() {
            let _ = command
                .arg("kill-server")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let _ = std::fs::remove_file(tmux_integration_test_socket_path());
    }
}

#[cfg(test)]
fn tmux_integration_test_lock() -> TmuxIntegrationTestGuard {
    let lock = TMUX_INTEGRATION_TEST_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    TmuxIntegrationTestGuard { _lock: lock }
}

fn sanitize_target_for_filename(target: &str) -> String {
    target
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect()
}

fn sanitize_runtime_id(runtime_id: &str) -> String {
    runtime_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect::<String>()
}

fn is_managed_session_name(session_name: &str, session_prefix: &str) -> bool {
    session_name == session_prefix || session_name.starts_with(&format!("{}-", session_prefix))
}

fn is_missing_tmux_session_error(error: &str) -> bool {
    error.contains("can't find session") || error.contains("no server running")
}

fn is_tmux_session_create_race_error(error: &str) -> bool {
    error.contains("duplicate session") || error.contains("index 0 in use")
}

#[cfg(test)]
mod tests {
    use super::{
        attach_target_candidates_for_runtime, build_status_left_format, build_status_right_format,
        build_tmux_environment_loader, build_tmux_launch_command, build_tmux_launch_spec,
        compact_model_label, detect_state_from_capture, is_managed_session_name,
        is_missing_tmux_session_error, is_tmux_session_create_race_error,
        orphaned_managed_tmux_targets, parse_launch_pane_line, parse_target_line,
        parse_window_line, read_bounded_pane_capture, redact_sensitive_launch_output,
        resolve_tmux_binary, session_name_for_runtime, shell_quote, target_candidates_for_runtime,
        target_matches_info, tmux_command, tmux_command_for_binary, tmux_integration_test_lock,
        tmux_integration_test_socket_path, window_name_for_runtime, ClaudeTerminalState,
        ManagedTmuxTargetAction, TmuxManager, TmuxWindowInfo,
    };
    use std::collections::HashMap;
    use std::path::Path;
    use std::process::Stdio;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn detect_state_flags_waiting_approval() {
        let captured = "Run tool?\n[Shell] cargo test\nAllow   Deny";
        assert_eq!(
            detect_state_from_capture(captured),
            ClaudeTerminalState::WaitingApproval
        );
    }

    #[test]
    fn detect_state_flags_idle_prompt() {
        let captured = "Done.\n❯";
        assert_eq!(
            detect_state_from_capture(captured),
            ClaudeTerminalState::Idle
        );
    }

    #[test]
    fn detect_state_flags_idle_for_initial_claude_input_screen() {
        let captured = "\
 ▐▛███▜▌   Claude Code v2.1.72\n\
▝▜█████▛▘  glm-5 · API Usage Billing\n\
  ▘▘ ▝▝    ~/Github/claude-code-env-manager\n\
\n\
────────────────────────────────────────────────────────────────────────────────\n\
❯\u{a0}Try \"how do I log an error?\"\n\
────────────────────────────────────────────────────────────────────────────────\n\
  g@192 claude-code-env-manager\n\
  ⏵⏵ accept edits on (shift+tab to cycle)\n\
\n\
\n\
\n\
\n\
";
        assert_eq!(
            detect_state_from_capture(captured),
            ClaudeTerminalState::Idle
        );
    }

    #[test]
    fn detect_state_flags_idle_for_lowercase_press_enter_prompt() {
        let captured = "Update available\nPress enter to continue";
        assert_eq!(
            detect_state_from_capture(captured),
            ClaudeTerminalState::Idle
        );
    }

    #[test]
    fn detect_state_flags_processing_when_interrupt_hint_is_visible() {
        let captured = "\
❯ Reply with a short sentence in Chinese describing that you are processing\n\
  this request.\n\
\n\
✳ Misting…\n\
\n\
────────────────────────────────────────────────────────────────────────────────\n\
❯\u{a0}\n\
────────────────────────────────────────────────────────────────────────────────\n\
  esc to interrupt\n\
";
        assert_eq!(
            detect_state_from_capture(captured),
            ClaudeTerminalState::Processing
        );
    }

    #[test]
    fn window_name_uses_runtime_suffix_for_better_uniqueness() {
        assert_eq!(
            window_name_for_runtime("session-1772984434305"),
            "ccem-84434305"
        );
    }

    #[test]
    fn session_name_uses_full_runtime_id() {
        assert_eq!(
            session_name_for_runtime("session-1772984434305", "ccem"),
            "ccem-session1772984434305"
        );
    }

    #[test]
    fn target_candidates_prefer_dedicated_tmux_session() {
        assert_eq!(
            target_candidates_for_runtime("session-1772984434305", "ccem"),
            vec![
                "ccem-session1772984434305:main".to_string(),
                "ccem-session1772984434305".to_string(),
                "ccem:ccem-84434305".to_string(),
                "ccem:ccem-session-".to_string(),
            ]
        );
    }

    #[test]
    fn attach_target_candidates_try_persisted_target_first_without_duplicates() {
        assert_eq!(
            attach_target_candidates_for_runtime(
                "session-1772984434305",
                "ccem",
                Some("ccem-session1772984434305:main"),
            ),
            vec![
                "ccem-session1772984434305:main".to_string(),
                "ccem-session1772984434305".to_string(),
                "ccem:ccem-84434305".to_string(),
                "ccem:ccem-session-".to_string(),
            ]
        );

        assert_eq!(
            attach_target_candidates_for_runtime(
                "session-1772984434305",
                "ccem",
                Some("ccem:legacy-window"),
            ),
            vec![
                "ccem:legacy-window".to_string(),
                "ccem-session1772984434305:main".to_string(),
                "ccem-session1772984434305".to_string(),
                "ccem:ccem-84434305".to_string(),
                "ccem:ccem-session-".to_string(),
            ]
        );
    }

    #[test]
    fn tmux_test_commands_use_private_server_socket() {
        let command = tmux_command_for_binary("tmux");
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let socket_path = tmux_integration_test_socket_path()
            .to_string_lossy()
            .into_owned();

        assert!(args
            .windows(2)
            .any(|pair| pair == ["-S", socket_path.as_str()]));
        #[cfg(unix)]
        assert!(args.windows(2).any(|pair| pair == ["-f", "/dev/null"]));

        let removed_environment = command
            .get_envs()
            .filter(|(_, value)| value.is_none())
            .map(|(key, _)| key.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(removed_environment.iter().any(|key| key == "TMUX"));
        assert!(removed_environment.iter().any(|key| key == "TMUX_PANE"));
        assert!(removed_environment.iter().any(|key| key == "TMUX_TMPDIR"));
    }

    #[test]
    fn required_tmux_integration_lane_has_tmux() {
        if std::env::var("CCEM_REQUIRE_TMUX_TESTS").as_deref() == Ok("1") {
            TmuxManager::check_tmux_installed()
                .expect("CCEM_REQUIRE_TMUX_TESTS=1 requires the tmux binary");
        }
    }

    #[test]
    fn tmux_integration_tests_use_private_server_socket() {
        let _tmux_guard = tmux_integration_test_lock();

        if TmuxManager::check_tmux_installed().is_err() {
            return;
        }

        let session_name = format!("ccem-socket-test-{}", std::process::id());

        struct TmuxSessionGuard {
            session_name: String,
        }

        impl Drop for TmuxSessionGuard {
            fn drop(&mut self) {
                let _ = tmux_command().and_then(|mut command| {
                    command
                        .args(["kill-session", "-t", &self.session_name])
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status()
                        .map(|_| ())
                        .map_err(|error| {
                            format!(
                                "Failed to clean test tmux session {}: {}",
                                self.session_name, error
                            )
                        })
                });
            }
        }

        let status = tmux_command()
            .expect("tmux command should be available")
            .args(["new-session", "-d", "-s", &session_name, "/bin/sleep 30"])
            .status()
            .expect("test tmux session should be created");
        assert!(status.success());
        let _session_guard = TmuxSessionGuard {
            session_name: session_name.clone(),
        };

        let output = tmux_command()
            .expect("tmux command should be available")
            .args([
                "display-message",
                "-p",
                "-t",
                &session_name,
                "#{socket_path}",
            ])
            .output()
            .expect("tmux socket path should be inspectable");
        assert!(output.status.success());

        let socket_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let socket_file_name = Path::new(&socket_path)
            .file_name()
            .and_then(|name| name.to_str())
            .expect("tmux socket path should have a UTF-8 file name");
        assert_eq!(Path::new(&socket_path), tmux_integration_test_socket_path());
        assert_ne!(socket_file_name, "default");
    }

    #[test]
    fn resolve_live_attach_target_checks_real_tmux_targets_before_attach() {
        let _tmux_guard = tmux_integration_test_lock();

        if TmuxManager::check_tmux_installed().is_err() {
            return;
        }

        let runtime_id = format!("session-test-{}", std::process::id());
        let session_prefix = format!("ccem-test-{}", std::process::id());
        let session_name = session_name_for_runtime(&runtime_id, &session_prefix);
        let target = session_name.clone();

        let _ = tmux_command().and_then(|mut command| {
            command
                .args(["kill-session", "-t", &session_name])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|_| ())
                .map_err(|error| {
                    format!(
                        "Failed to clean stale test tmux session {}: {}",
                        session_name, error
                    )
                })
        });

        struct TmuxSessionGuard {
            session_name: String,
        }

        impl Drop for TmuxSessionGuard {
            fn drop(&mut self) {
                let _ = tmux_command().and_then(|mut command| {
                    command
                        .args(["kill-session", "-t", &self.session_name])
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status()
                        .map(|_| ())
                        .map_err(|error| {
                            format!(
                                "Failed to clean test tmux session {}: {}",
                                self.session_name, error
                            )
                        })
                });
            }
        }

        let status = tmux_command()
            .expect("tmux command should be available")
            .args([
                "new-session",
                "-d",
                "-s",
                &session_name,
                "-n",
                "main",
                "/bin/sleep 30",
            ])
            .status()
            .expect("test tmux session should be created");
        assert!(status.success());
        let _guard = TmuxSessionGuard {
            session_name: session_name.clone(),
        };

        let manager = TmuxManager { session_prefix };
        assert_eq!(
            manager
                .resolve_live_attach_target(&runtime_id, Some(&target))
                .expect("live target should resolve"),
            target
        );

        let missing_runtime_id = format!("session-missing-{}", std::process::id());
        let missing_error = manager
            .resolve_live_attach_target(&missing_runtime_id, Some("ccem-missing:main"))
            .expect_err("missing target should fail before opening Terminal");
        assert!(missing_error.contains("tmux target not found"));
    }

    #[test]
    fn launch_healthcheck_captures_exited_pane_and_cleans_session() {
        let _tmux_guard = tmux_integration_test_lock();

        if TmuxManager::check_tmux_installed().is_err() {
            return;
        }

        let runtime_id = format!("session-exit-test-{}", std::process::id());
        let session_prefix = format!("ccem-exit-test-{}", std::process::id());
        let session_name = session_name_for_runtime(&runtime_id, &session_prefix);

        let _ = tmux_command().and_then(|mut command| {
            command
                .args(["kill-session", "-t", &session_name])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|_| ())
                .map_err(|error| {
                    format!(
                        "Failed to clean stale test tmux session {}: {}",
                        session_name, error
                    )
                })
        });

        struct TmuxSessionGuard {
            session_name: String,
        }

        impl Drop for TmuxSessionGuard {
            fn drop(&mut self) {
                let _ = tmux_command().and_then(|mut command| {
                    command
                        .args(["kill-session", "-t", &self.session_name])
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status()
                        .map(|_| ())
                        .map_err(|error| {
                            format!(
                                "Failed to clean test tmux session {}: {}",
                                self.session_name, error
                            )
                        })
                });
            }
        }

        let output = tmux_command()
            .expect("tmux command should be available")
            .args([
                "new-session",
                "-d",
                "-P",
                "-F",
                "#{window_index}",
                "-s",
                &session_name,
                "-n",
                "main",
                "exec /ccem-missing-session-client",
                ";",
                "set-option",
                "-w",
                "-t",
                &session_name,
                "remain-on-exit",
                "on",
            ])
            .output()
            .expect("test tmux session should be created");
        assert!(output.status.success());
        let _guard = TmuxSessionGuard {
            session_name: session_name.clone(),
        };
        let window_index = String::from_utf8_lossy(&output.stdout).trim().to_string();
        assert!(!window_index.is_empty());
        let target = format!("{session_name}:{window_index}");

        let manager = TmuxManager { session_prefix };
        let error = manager
            .verify_target_survived_launch(&runtime_id, &target, &HashMap::new())
            .expect_err("exited tmux target should fail launch healthcheck");
        assert!(error.starts_with("session_command_exited:"));
        assert!(
            error.contains("exit code 126") || error.contains("exit code 127"),
            "unexpected error: {error}"
        );
        assert!(
            error.contains("ccem-missing-session-client"),
            "unexpected error: {error}"
        );
        assert!(
            !manager
                .has_session(&session_name)
                .expect("tmux session lookup should succeed"),
            "failed launch session should be cleaned up"
        );
    }

    #[test]
    fn launch_healthcheck_reports_signal_and_cleans_session() {
        let _tmux_guard = tmux_integration_test_lock();

        if TmuxManager::check_tmux_installed().is_err() {
            return;
        }

        let runtime_id = format!("session-signal-test-{}", std::process::id());
        let session_prefix = format!("ccem-signal-test-{}", std::process::id());
        let session_name = session_name_for_runtime(&runtime_id, &session_prefix);

        struct TmuxSessionGuard {
            session_name: String,
        }

        impl Drop for TmuxSessionGuard {
            fn drop(&mut self) {
                let _ = tmux_command().and_then(|mut command| {
                    command
                        .args(["kill-session", "-t", &self.session_name])
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status()
                        .map(|_| ())
                        .map_err(|error| {
                            format!(
                                "Failed to clean test tmux session {}: {}",
                                self.session_name, error
                            )
                        })
                });
            }
        }

        let output = tmux_command()
            .expect("tmux command should be available")
            .args([
                "new-session",
                "-d",
                "-P",
                "-F",
                "#{window_index}",
                "-s",
                &session_name,
                "-n",
                "main",
                "exec /bin/sh -c 'kill -TERM $$'",
                ";",
                "set-option",
                "-w",
                "-t",
                &session_name,
                "remain-on-exit",
                "on",
            ])
            .output()
            .expect("signal test tmux session should be created");
        assert!(output.status.success());
        let _guard = TmuxSessionGuard {
            session_name: session_name.clone(),
        };
        let window_index = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let target = format!("{session_name}:{window_index}");

        let manager = TmuxManager { session_prefix };
        let error = manager
            .verify_target_survived_launch(&runtime_id, &target, &HashMap::new())
            .expect_err("signaled tmux target should fail launch healthcheck");
        assert!(error.starts_with("session_command_exited:"));
        assert!(error.contains("signal term"), "unexpected error: {error}");
        assert!(
            !manager
                .has_session(&session_name)
                .expect("tmux session lookup should succeed"),
            "signaled launch session should be cleaned up"
        );
    }

    #[test]
    fn partial_create_failure_cleanup_removes_created_session() {
        let _tmux_guard = tmux_integration_test_lock();

        if TmuxManager::check_tmux_installed().is_err() {
            return;
        }

        let runtime_id = format!("session-partial-create-test-{}", std::process::id());
        let session_prefix = format!("ccem-partial-create-test-{}", std::process::id());
        let session_name = session_name_for_runtime(&runtime_id, &session_prefix);
        let manager = TmuxManager { session_prefix };
        let args = [
            "new-session",
            "-d",
            "-P",
            "-F",
            "#{window_index}",
            "-s",
            &session_name,
            "/bin/sleep 30",
            ";",
            "set-option",
            "-w",
            "-t",
            &session_name,
            "ccem-invalid-option",
            "on",
        ]
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>();

        manager
            .run_create_command(&session_name, &args)
            .expect_err("invalid chained option should fail after creating the session");
        assert!(
            manager
                .target_exists(&session_name)
                .expect("partial session lookup should succeed"),
            "tmux should expose the partially created session"
        );
        assert_eq!(manager.cleanup_partial_create(&session_name), None);
        assert!(
            !manager
                .target_exists(&session_name)
                .expect("cleaned session lookup should succeed"),
            "partial launch session should be removed"
        );
    }

    #[test]
    fn target_parsing_uses_window_index_not_renamable_window_name() {
        let window = parse_window_line("ccem-session222", "3|claude|202|1").unwrap();
        assert_eq!(window.target, "ccem-session222:claude");
        assert_eq!(window.window_name, "claude");

        let target = parse_target_line("ccem-session222|claude|3|202|2").unwrap();
        assert_eq!(target.target, "ccem-session222:3");
        assert!(target_matches_info("ccem-session222", &target));
        assert!(target_matches_info("ccem-session222:claude", &target));
        assert!(target_matches_info("ccem-session222:3", &target));
    }

    #[test]
    fn launch_pane_parser_preserves_text_signal_names() {
        let pane = parse_launch_pane_line(
            "ccem-session222",
            "3|main|0|1||term|1",
        )
        .expect("launch pane metadata should parse");

        assert_eq!(pane.pane_dead_signal.as_deref(), Some("term"));
        assert_eq!(pane.pane_dead_status, None);
    }

    #[test]
    fn launch_healthcheck_survives_tmux_window_rename() {
        let _tmux_guard = tmux_integration_test_lock();

        if TmuxManager::check_tmux_installed().is_err() {
            return;
        }

        let runtime_id = format!("session-rename-test-{}", std::process::id());
        let session_prefix = format!("ccem-rename-test-{}", std::process::id());
        let session_name = session_name_for_runtime(&runtime_id, &session_prefix);

        let _ = tmux_command().and_then(|mut command| {
            command
                .args(["kill-session", "-t", &session_name])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|_| ())
                .map_err(|error| {
                    format!(
                        "Failed to clean stale test tmux session {}: {}",
                        session_name, error
                    )
                })
        });

        struct TmuxSessionGuard {
            session_name: String,
        }

        impl Drop for TmuxSessionGuard {
            fn drop(&mut self) {
                let _ = tmux_command().and_then(|mut command| {
                    command
                        .args(["kill-session", "-t", &self.session_name])
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status()
                        .map(|_| ())
                        .map_err(|error| {
                            format!(
                                "Failed to clean test tmux session {}: {}",
                                self.session_name, error
                            )
                        })
                });
            }
        }

        let output = tmux_command()
            .expect("tmux command should be available")
            .args([
                "new-session",
                "-d",
                "-P",
                "-F",
                "#{window_index}",
                "-s",
                &session_name,
                "-n",
                "main",
                "/bin/sleep 30",
            ])
            .output()
            .expect("test tmux session should be created");
        assert!(output.status.success());
        let _guard = TmuxSessionGuard {
            session_name: session_name.clone(),
        };
        let window_index = String::from_utf8_lossy(&output.stdout).trim().to_string();
        assert!(!window_index.is_empty());

        let rename_status = tmux_command()
            .expect("tmux command should be available")
            .args([
                "rename-window",
                "-t",
                &format!("{session_name}:{window_index}"),
                "claude",
            ])
            .status()
            .expect("test tmux window should be renamed");
        assert!(rename_status.success());

        let manager = TmuxManager { session_prefix };
        let stable_target = format!("{session_name}:{window_index}");
        manager
            .verify_target_survived_launch(&runtime_id, &stable_target, &HashMap::new())
            .expect("stable index target should survive window rename");
        let info = manager
            .get_window_info(&runtime_id)
            .expect("renamed dedicated session should still resolve");
        assert_eq!(info.target, stable_target);
        assert_eq!(info.window_name, "claude");
    }

    #[test]
    fn launch_healthcheck_accepts_live_dedicated_session_after_window_replacement() {
        let _tmux_guard = tmux_integration_test_lock();

        if TmuxManager::check_tmux_installed().is_err() {
            return;
        }

        let runtime_id = format!("session-replace-test-{}", std::process::id());
        let session_prefix = format!("ccem-replace-test-{}", std::process::id());
        let session_name = session_name_for_runtime(&runtime_id, &session_prefix);

        let _ = tmux_command().and_then(|mut command| {
            command
                .args(["kill-session", "-t", &session_name])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|_| ())
                .map_err(|error| {
                    format!(
                        "Failed to clean stale test tmux session {}: {}",
                        session_name, error
                    )
                })
        });

        let output = tmux_command()
            .expect("tmux command should be available")
            .args([
                "new-session",
                "-d",
                "-P",
                "-F",
                "#{window_index}",
                "-s",
                &session_name,
                "-n",
                "initial",
                "/bin/sleep 30",
                ";",
                "set-option",
                "-w",
                "-t",
                &session_name,
                "remain-on-exit",
                "on",
            ])
            .output()
            .expect("test tmux session should be created");
        assert!(output.status.success());

        struct TmuxSessionGuard {
            session_name: String,
        }

        impl Drop for TmuxSessionGuard {
            fn drop(&mut self) {
                let _ = tmux_command().and_then(|mut command| {
                    command
                        .args(["kill-session", "-t", &self.session_name])
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status()
                        .map(|_| ())
                        .map_err(|error| {
                            format!(
                                "Failed to clean test tmux session {}: {}",
                                self.session_name, error
                            )
                        })
                });
            }
        }

        let _guard = TmuxSessionGuard {
            session_name: session_name.clone(),
        };
        let initial_index = String::from_utf8_lossy(&output.stdout).trim().to_string();
        assert!(!initial_index.is_empty());
        let initial_target = format!("{session_name}:{initial_index}");

        let replacement = tmux_command()
            .expect("tmux command should be available")
            .args([
                "new-window",
                "-d",
                "-P",
                "-F",
                "#{window_index}",
                "-t",
                &session_name,
                "-n",
                "claude",
                "/bin/sleep 30",
            ])
            .output()
            .expect("replacement tmux window should be created");
        assert!(replacement.status.success());
        let replacement_index = String::from_utf8_lossy(&replacement.stdout)
            .trim()
            .to_string();
        assert!(!replacement_index.is_empty());
        let replacement_target = format!("{session_name}:{replacement_index}");

        let exit_status = tmux_command()
            .expect("tmux command should be available")
            .args(["respawn-pane", "-k", "-t", &initial_target, "/bin/true"])
            .status()
            .expect("initial tmux pane should exit");
        assert!(exit_status.success());

        let manager = TmuxManager { session_prefix };
        let live_window = manager
            .verify_target_survived_launch(&runtime_id, &initial_target, &HashMap::new())
            .expect("live dedicated session should survive window replacement");
        assert_eq!(live_window.target, replacement_target);
        assert!(
            !manager
                .target_exists(&initial_target)
                .expect("initial target lookup should succeed"),
            "retained dead launch window should be removed"
        );
        assert_eq!(
            manager
                .get_window_info(&runtime_id)
                .expect("replacement session should remain addressable")
                .target,
            replacement_target
        );
    }

    #[test]
    fn launch_healthcheck_preserves_replacement_window_lifecycle_setting() {
        let _tmux_guard = tmux_integration_test_lock();

        if TmuxManager::check_tmux_installed().is_err() {
            return;
        }

        let runtime_id = format!("session-replace-setting-test-{}", std::process::id());
        let session_prefix = format!("ccem-replace-setting-test-{}", std::process::id());
        let session_name = session_name_for_runtime(&runtime_id, &session_prefix);

        struct TmuxSessionGuard {
            session_name: String,
        }

        impl Drop for TmuxSessionGuard {
            fn drop(&mut self) {
                let _ = tmux_command().and_then(|mut command| {
                    command
                        .args(["kill-session", "-t", &self.session_name])
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status()
                        .map(|_| ())
                        .map_err(|error| {
                            format!(
                                "Failed to clean test tmux session {}: {}",
                                self.session_name, error
                            )
                        })
                });
            }
        }

        let initial = tmux_command()
            .expect("tmux command should be available")
            .args([
                "new-session",
                "-d",
                "-P",
                "-F",
                "#{window_index}",
                "-s",
                &session_name,
                "-n",
                "initial",
                "/bin/sleep 30",
                ";",
                "set-option",
                "-w",
                "-t",
                &session_name,
                "remain-on-exit",
                "on",
            ])
            .output()
            .expect("initial tmux session should be created");
        assert!(initial.status.success());
        let _guard = TmuxSessionGuard {
            session_name: session_name.clone(),
        };
        let initial_target = format!(
            "{}:{}",
            session_name,
            String::from_utf8_lossy(&initial.stdout).trim()
        );

        let replacement = tmux_command()
            .expect("tmux command should be available")
            .args([
                "new-window",
                "-d",
                "-P",
                "-F",
                "#{window_index}",
                "-t",
                &session_name,
                "-n",
                "claude",
                "/bin/sleep 30",
            ])
            .output()
            .expect("replacement tmux window should be created");
        assert!(replacement.status.success());
        let replacement_target = format!(
            "{}:{}",
            session_name,
            String::from_utf8_lossy(&replacement.stdout).trim()
        );
        assert!(
            tmux_command()
                .expect("tmux command should be available")
                .args([
                    "set-option",
                    "-w",
                    "-t",
                    &replacement_target,
                    "remain-on-exit",
                    "on",
                ])
                .status()
                .expect("replacement lifecycle setting should apply")
                .success()
        );
        assert!(
            tmux_command()
                .expect("tmux command should be available")
                .args(["kill-window", "-t", &initial_target])
                .status()
                .expect("initial launch window should be removed")
                .success()
        );

        let manager = TmuxManager { session_prefix };
        let live_window = manager
            .verify_target_survived_launch(&runtime_id, &initial_target, &HashMap::new())
            .expect("replacement window should survive launch healthcheck");
        assert_eq!(live_window.target, replacement_target);

        let lifecycle = tmux_command()
            .expect("tmux command should be available")
            .args([
                "show-options",
                "-wv",
                "-t",
                &replacement_target,
                "remain-on-exit",
            ])
            .output()
            .expect("replacement lifecycle setting should be readable");
        assert!(lifecycle.status.success());
        assert_eq!(String::from_utf8_lossy(&lifecycle.stdout).trim(), "on");
    }

    #[test]
    fn launch_command_does_not_override_term_inside_tmux() {
        let command =
            build_tmux_launch_command("claude", &["--print".to_string()], &HashMap::new());
        assert!(!command.contains("export TERM="));
        assert!(command.contains("unset CLAUDECODE"));
    }

    #[test]
    fn launch_command_supports_codex_resume_subcommand() {
        let command = build_tmux_launch_command(
            "codex",
            &["resume".to_string(), "session-123".to_string()],
            &HashMap::new(),
        );
        assert!(command.contains("exec "));
        assert!(command.contains("'resume' 'session-123'"));
    }

    #[test]
    fn launch_spec_keeps_secret_env_values_out_of_shell_command() {
        let mut env_vars = HashMap::new();
        env_vars.insert(
            "ANTHROPIC_AUTH_TOKEN".to_string(),
            "sk-ant-secret-value".to_string(),
        );

        let spec = build_tmux_launch_spec(
            "claude",
            &[],
            &env_vars,
            "ccem-session123:main",
            "/opt/homebrew/bin/tmux",
        );

        assert!(!spec.command.contains("sk-ant-secret-value"));
        assert!(spec.command.contains("show-environment"));
        assert!(spec.command.contains("ANTHROPIC_AUTH_TOKEN"));
        assert!(spec
            .environment
            .iter()
            .any(|entry| entry == "ANTHROPIC_AUTH_TOKEN=sk-ant-secret-value"));
    }

    #[test]
    fn launch_diagnostics_redact_sensitive_environment_values() {
        let env_vars = HashMap::from([
            (
                "ANTHROPIC_AUTH_TOKEN".to_string(),
                "sk-ant-secret-value".to_string(),
            ),
            (
                "ANTHROPIC_BASE_URL".to_string(),
                "https://diagnostic.example".to_string(),
            ),
            (
                "OPENCODE_CONFIG_CONTENT".to_string(),
                r#"{"provider":{"anthropic":{"options":{"apiKey":"opencode-secret-canary"}}}}"#
                    .to_string(),
            ),
        ]);

        let output = redact_sensitive_launch_output(
            "auth failed for sk-ant-secret-value and opencode-secret-canary at https://diagnostic.example",
            &env_vars,
        );

        assert_eq!(
            output,
            "auth failed for [REDACTED] and [REDACTED] at https://diagnostic.example"
        );
        assert!(!output.contains("opencode-secret-canary"));
    }

    #[test]
    fn launch_diagnostics_keep_only_the_bounded_output_tail() {
        let path = std::env::temp_dir().join(format!(
            "ccem-bounded-pane-test-{}.log",
            std::process::id()
        ));
        let mut payload = vec![b'x'; 70_000];
        payload.extend_from_slice(b"diagnostic-tail");
        std::fs::write(&path, payload).expect("write oversized pane fixture");
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .open(&path)
            .expect("open oversized pane fixture");

        let capture =
            read_bounded_pane_capture(&mut file, 64 * 1024).expect("read bounded pane tail");

        assert!(capture.truncated);
        assert_eq!(capture.output.len(), 64 * 1024);
        assert!(capture.output.ends_with("diagnostic-tail"));
        drop(file);
        std::fs::remove_file(path).expect("remove oversized pane fixture");
    }

    #[test]
    fn launch_spec_clears_omitted_managed_model_pins_before_loading_selected_env() {
        let mut env_vars = HashMap::new();
        env_vars.insert("ANTHROPIC_MODEL".to_string(), "opus".to_string());

        let spec = build_tmux_launch_spec(
            "claude",
            &[],
            &env_vars,
            "ccem-session123:main",
            "/opt/homebrew/bin/tmux",
        );

        assert!(spec.command.starts_with("unset ANTHROPIC_BASE_URL "));
        assert!(spec.command.contains("ANTHROPIC_DEFAULT_OPUS_MODEL"));
        assert!(spec.command.contains("ANTHROPIC_DEFAULT_SONNET_MODEL"));
        assert!(!spec
            .environment
            .iter()
            .any(|entry| entry.starts_with("ANTHROPIC_DEFAULT_OPUS_MODEL=")));
        assert!(!spec
            .environment
            .iter()
            .any(|entry| entry.starts_with("ANTHROPIC_DEFAULT_SONNET_MODEL=")));
        assert!(spec
            .environment
            .iter()
            .any(|entry| entry == "ANTHROPIC_MODEL=opus"));
    }

    #[test]
    fn launch_environment_loader_exports_tmux_session_path_to_pane_process() {
        let _tmux_guard = tmux_integration_test_lock();

        if TmuxManager::check_tmux_installed().is_err() {
            return;
        }

        let session_name = format!("ccem-env-test-{}", std::process::id());
        let target = format!("{session_name}:main");
        let output_path =
            std::env::temp_dir().join(format!("ccem-tmux-env-{}.txt", std::process::id()));
        let injected_path = "/tmp/ccem-node-bin:/usr/bin:/bin:/usr/sbin:/sbin";

        let _ = std::fs::remove_file(&output_path);
        let _ = tmux_command().and_then(|mut command| {
            command
                .args(["kill-session", "-t", &session_name])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|_| ())
                .map_err(|error| {
                    format!(
                        "Failed to clean stale test tmux session {}: {}",
                        session_name, error
                    )
                })
        });

        struct TestCleanup {
            session_name: String,
            output_path: std::path::PathBuf,
        }

        impl Drop for TestCleanup {
            fn drop(&mut self) {
                let _ = tmux_command().and_then(|mut command| {
                    command
                        .args(["kill-session", "-t", &self.session_name])
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status()
                        .map(|_| ())
                        .map_err(|error| {
                            format!(
                                "Failed to clean test tmux session {}: {}",
                                self.session_name, error
                            )
                        })
                });
                let _ = std::fs::remove_file(&self.output_path);
            }
        }

        let _cleanup = TestCleanup {
            session_name: session_name.clone(),
            output_path: output_path.clone(),
        };

        let tmux_binary = resolve_tmux_binary().expect("tmux binary should resolve");
        let environment_keys = vec!["PATH".to_string()];
        let environment_loader =
            build_tmux_environment_loader(&environment_keys, &target, tmux_binary);
        let command = format!(
            "{} printf '%s' \"$PATH\" > {}; /bin/sleep 2",
            environment_loader,
            shell_quote(output_path.to_string_lossy().as_ref())
        );

        let status = tmux_command()
            .expect("tmux command should be available")
            .args([
                "new-session",
                "-d",
                "-s",
                &session_name,
                "-n",
                "main",
                "-e",
                &format!("PATH={injected_path}"),
                &command,
            ])
            .status()
            .expect("test tmux session should be created");
        assert!(status.success());

        thread::sleep(Duration::from_millis(250));
        let captured_path =
            std::fs::read_to_string(&output_path).expect("pane should write captured PATH");
        assert_eq!(captured_path, injected_path);
    }

    #[test]
    fn orphan_detection_marks_untracked_dedicated_sessions_for_cleanup() {
        let windows = vec![
            TmuxWindowInfo {
                session_name: "ccem-session111".to_string(),
                window_name: "main".to_string(),
                window_index: 0,
                pane_pid: Some(101),
                session_attached_clients: 0,
                target: "ccem-session111:main".to_string(),
            },
            TmuxWindowInfo {
                session_name: "ccem-session222".to_string(),
                window_name: "main".to_string(),
                window_index: 0,
                pane_pid: Some(202),
                session_attached_clients: 0,
                target: "ccem-session222:main".to_string(),
            },
        ];

        let actions = orphaned_managed_tmux_targets(&windows, &["session-111".to_string()], "ccem");

        assert_eq!(
            actions,
            vec![ManagedTmuxTargetAction::KillSession(
                "ccem-session222".to_string()
            )]
        );
    }

    #[test]
    fn orphan_detection_preserves_attached_dedicated_sessions() {
        let windows = vec![TmuxWindowInfo {
            session_name: "ccem-session222".to_string(),
            window_name: "main".to_string(),
            window_index: 0,
            pane_pid: Some(202),
            session_attached_clients: 1,
            target: "ccem-session222:main".to_string(),
        }];

        let actions = orphaned_managed_tmux_targets(&windows, &[], "ccem");

        assert!(actions.is_empty());
    }

    #[test]
    fn orphan_detection_preserves_attached_legacy_windows() {
        let windows = vec![TmuxWindowInfo {
            session_name: "ccem".to_string(),
            window_name: "ccem-12345678".to_string(),
            window_index: 1,
            pane_pid: Some(303),
            session_attached_clients: 1,
            target: "ccem:ccem-12345678".to_string(),
        }];

        let actions = orphaned_managed_tmux_targets(&windows, &[], "ccem");

        assert!(actions.is_empty());
    }

    #[test]
    fn tmux_metadata_parses_attached_client_count() {
        let window = parse_window_line("ccem-session222", "0|main|202|1").unwrap();
        assert_eq!(window.session_attached_clients, 1);

        let target = parse_target_line("ccem-session222|main|0|202|2").unwrap();
        assert_eq!(target.session_attached_clients, 2);
        assert_eq!(target.target, "ccem-session222:0");
    }

    #[test]
    fn missing_tmux_session_errors_are_detected() {
        assert!(is_missing_tmux_session_error(
            "tmux failed to create window 'ccem-1234': can't find session: ccem"
        ));
        assert!(is_missing_tmux_session_error(
            "tmux failed to create window 'ccem-1234': no server running on /tmp/tmux-501/default"
        ));
    }

    #[test]
    fn tmux_session_create_races_are_detected() {
        assert!(is_tmux_session_create_race_error(
            "tmux failed to create window 'ccem-1234': duplicate session: ccem"
        ));
        assert!(is_tmux_session_create_race_error(
            "tmux failed to create window 'ccem-1234': create window failed: index 0 in use"
        ));
    }

    #[test]
    fn managed_session_name_accepts_legacy_and_dedicated_sessions() {
        assert!(is_managed_session_name("ccem", "ccem"));
        assert!(is_managed_session_name("ccem-session1772984434305", "ccem"));
        assert!(!is_managed_session_name("work", "ccem"));
    }

    #[test]
    fn compact_model_label_collapses_known_families() {
        assert_eq!(
            compact_model_label("claude-opus-4-1-20250805"),
            "opus".to_string()
        );
        assert_eq!(
            compact_model_label("claude-sonnet-4-5-20250929"),
            "sonnet".to_string()
        );
        assert_eq!(compact_model_label("glm-5"), "glm-5".to_string());
    }

    #[test]
    fn status_formats_use_window_width_conditions() {
        let left = build_status_left_format();
        let right = build_status_right_format();
        assert!(left.contains("window_width"));
        assert!(left.contains("pane_current_path"));
        assert!(left.contains("b:pane_current_path"));
        assert!(right.contains("window_width"));
        assert!(right.contains("@ccem_env"));
        assert!(right.contains("@ccem_model"));
        assert!(right.contains("@ccem_model_short"));
        assert!(right.contains("ccem"));
        assert!(!right.contains("#("));
        assert!(!right.contains("@ccem_subagent"));
    }
}
