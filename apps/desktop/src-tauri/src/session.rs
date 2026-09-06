use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::diagnostic_log;
use crate::notifications::{self, NotificationContext};
use crate::terminal;

fn default_client() -> String {
    "claude".to_string()
}

/// Return the path to ~/.ccem/sessions.json
fn get_sessions_file_path() -> std::path::PathBuf {
    dirs::home_dir()
        .map(|h| h.join(".ccem/sessions.json"))
        .unwrap_or_default()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Session {
    pub id: String,
    pub pid: Option<u32>,
    #[serde(default = "default_client")]
    pub client: String, // "claude" | "codex"
    #[serde(alias = "env_name")] // 兼容旧的 snake_case
    pub env_name: String,
    #[serde(default, alias = "config_source")]
    pub config_source: Option<String>,
    #[serde(alias = "perm_mode")]
    pub perm_mode: String,
    #[serde(alias = "working_dir")]
    pub working_dir: String,
    #[serde(alias = "start_time")]
    pub start_time: String,
    pub status: String, // "running", "stopped", "interrupted"
    // Terminal metadata for window control
    #[serde(alias = "terminal_type")]
    pub terminal_type: Option<String>, // "iterm2" | "terminalapp"
    #[serde(alias = "window_id")]
    pub window_id: Option<String>, // iTerm2 window ID for operations
    #[serde(alias = "iterm_session_id")]
    pub iterm_session_id: Option<String>, // iTerm2 session unique ID for move_session API
    #[serde(default, alias = "tmux_target")]
    pub tmux_target: Option<String>, // tmux target for tmux-backed interactive sessions
}

impl Session {
    pub fn is_tmux_backed(&self) -> bool {
        self.tmux_target.is_some() || self.terminal_type.as_deref() == Some("embedded")
    }

    pub fn resolved_tmux_target(&self) -> Option<&str> {
        self.tmux_target.as_deref().or_else(|| {
            (self.terminal_type.as_deref() == Some("embedded"))
                .then_some(self.window_id.as_deref())
                .flatten()
        })
    }
}

pub struct SessionManager {
    pub sessions: Mutex<Vec<Session>>,
    sessions_file_path: PathBuf,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(vec![]),
            sessions_file_path: get_sessions_file_path(),
        }
    }
}

impl SessionManager {
    /// Load sessions from ~/.ccem/sessions.json, returning a new SessionManager.
    /// Returns an empty manager if the file doesn't exist or is corrupted.
    pub fn load_from_disk() -> Self {
        Self::load_from_path(get_sessions_file_path())
    }

    fn load_from_path(path: PathBuf) -> Self {
        let sessions = if path.exists() {
            match std::fs::read_to_string(&path) {
                Ok(content) => serde_json::from_str::<Vec<Session>>(&content)
                    .map(|sessions| {
                        sessions
                            .into_iter()
                            .map(Self::normalize_loaded_session)
                            .collect()
                    })
                    .unwrap_or_else(|e| {
                        eprintln!("Failed to parse sessions.json: {}", e);
                        vec![]
                    }),
                Err(e) => {
                    eprintln!("Failed to read sessions.json: {}", e);
                    vec![]
                }
            }
        } else {
            vec![]
        };
        Self {
            sessions: Mutex::new(sessions),
            sessions_file_path: path,
        }
    }

    fn lock_sessions(&self) -> MutexGuard<'_, Vec<Session>> {
        self.sessions.lock().unwrap_or_else(|poisoned| {
            eprintln!("Session manager lock was poisoned; recovering session state");
            poisoned.into_inner()
        })
    }

    fn normalize_loaded_session(mut session: Session) -> Session {
        if session.tmux_target.is_none() && session.terminal_type.as_deref() == Some("embedded") {
            session.tmux_target = session.window_id.clone();
            session.window_id = None;
            session.iterm_session_id = None;
        }

        session
    }

    fn save_to_disk_result(&self) -> Result<(), String> {
        let path = self.sessions_file_path.clone();
        let temp_path = path.with_extension("tmp");

        // 在锁内完成读取-序列化-写入
        let sessions = self.lock_sessions().clone();
        diagnostic_log::append_session_launch_event(
            "session.save_to_disk.start",
            serde_json::json!({
                "path": &path,
                "temp_path": &temp_path,
                "count": sessions.len(),
            }),
        );

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create sessions dir: {}", e))?;
        }

        // 获取文件锁
        let lock_file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(&path)
            .map_err(|e| format!("Failed to open sessions file for locking: {}", e))?;

        // 加排他锁
        lock_file
            .lock_exclusive()
            .map_err(|e| format!("Failed to acquire lock on sessions file: {}", e))?;

        // 序列化并写入临时文件
        let json = serde_json::to_string_pretty(&sessions)
            .map_err(|e| format!("Failed to serialize sessions: {}", e))?;
        fs::write(&temp_path, json)
            .map_err(|e| format!("Failed to write temp sessions file: {}", e))?;
        // 原子替换
        fs::rename(&temp_path, &path)
            .map_err(|e| format!("Failed to rename temp sessions file: {}", e))?;
        diagnostic_log::append_session_launch_event(
            "session.save_to_disk.ok",
            serde_json::json!({
                "path": &path,
                "count": sessions.len(),
            }),
        );
        // 锁会在 lock_file drop 时自动释放
        Ok(())
    }

    /// Persist current sessions to ~/.ccem/sessions.json with atomic write.
    /// Errors are logged but never panic.
    fn save_to_disk(&self) {
        if let Err(e) = self.save_to_disk_result() {
            eprintln!("{}", e);
        }
    }

    pub fn try_add_session(&self, session: Session) -> Result<(), String> {
        let session_id = session.id.clone();
        {
            let mut sessions = self.lock_sessions();
            sessions.push(session);
        }
        if let Err(error) = self.save_to_disk_result() {
            let mut sessions = self.lock_sessions();
            sessions.retain(|s| s.id != session_id);
            return Err(error);
        }
        Ok(())
    }

    pub fn add_session(&self, session: Session) {
        if let Err(error) = self.try_add_session(session) {
            eprintln!("Failed to add session: {}", error);
        }
    }

    pub fn remove_session(&self, id: &str) {
        {
            let mut sessions = self.lock_sessions();
            sessions.retain(|s| s.id != id);
        }
        self.save_to_disk();
    }

    pub fn update_session_status(&self, id: &str, status: &str) {
        {
            let mut sessions = self.lock_sessions();
            if let Some(session) = sessions.iter_mut().find(|s| s.id == id) {
                session.status = status.to_string();
            }
        }
        self.save_to_disk();
    }

    pub fn list_sessions(&self) -> Vec<Session> {
        self.lock_sessions().clone()
    }

    pub fn get_session(&self, id: &str) -> Option<Session> {
        self.lock_sessions().iter().find(|s| s.id == id).cloned()
    }

    /// Get all running sessions with PIDs for monitoring
    pub fn get_running_sessions_with_pid(&self) -> Vec<(String, u32)> {
        self.lock_sessions()
            .iter()
            .filter(|s| s.status == "running" && s.pid.is_some())
            .map(|s| (s.id.clone(), s.pid.unwrap()))
            .collect()
    }

    /// Get all running sessions (including those without PID)
    pub fn get_running_sessions(&self) -> Vec<Session> {
        self.lock_sessions()
            .iter()
            .filter(|s| s.status == "running")
            .cloned()
            .collect()
    }

    /// Update the iTerm2 session ID for a session
    pub fn update_session_iterm_id(&self, id: &str, iterm_session_id: &str) {
        {
            let mut sessions = self.lock_sessions();
            if let Some(session) = sessions.iter_mut().find(|s| s.id == id) {
                session.iterm_session_id = Some(iterm_session_id.to_string());
            }
        }
        self.save_to_disk();
    }

    /// Update the window ID for a session (used after arrange merges windows)
    pub fn update_session_window_id(&self, id: &str, window_id: &str) {
        {
            let mut sessions = self.lock_sessions();
            if let Some(session) = sessions.iter_mut().find(|s| s.id == id) {
                session.window_id = Some(window_id.to_string());
            }
        }
        self.save_to_disk();
    }

    pub fn attach_tmux_terminal(
        &self,
        id: &str,
        terminal_type: &str,
        window_id: Option<&str>,
        iterm_session_id: Option<&str>,
    ) {
        {
            let mut sessions = self.lock_sessions();
            if let Some(session) = sessions.iter_mut().find(|s| s.id == id) {
                session.terminal_type = Some(terminal_type.to_string());
                session.window_id = window_id.map(str::to_string);
                session.iterm_session_id = iterm_session_id.map(str::to_string);
            }
        }
        self.save_to_disk();
    }

    pub fn update_session_pid(&self, id: &str, pid: Option<u32>) {
        {
            let mut sessions = self.lock_sessions();
            if let Some(session) = sessions.iter_mut().find(|s| s.id == id) {
                session.pid = pid;
            }
        }
        self.save_to_disk();
    }

    /// Get all running sessions that have terminal metadata
    pub fn get_running_terminal_sessions(&self) -> Vec<Session> {
        self.lock_sessions()
            .iter()
            .filter(|s| s.status == "running" && s.terminal_type.is_some() && !s.is_tmux_backed())
            .cloned()
            .collect()
    }

    /// Validate persisted sessions against actual terminal state on app startup.
    /// - Removes stopped/interrupted sessions (stale from previous run)
    /// - Checks running sessions against live terminal windows
    /// - Marks orphaned sessions as stopped or interrupted
    pub fn validate_and_reconcile(&self) {
        let has_running_sessions = {
            let mut sessions = self.lock_sessions();
            sessions.retain(|s| s.status == "running");
            !sessions.is_empty()
        };

        if !has_running_sessions {
            self.save_to_disk();
            return;
        }

        let running = self.get_running_sessions();
        let active_iterm_sessions = query_needed_terminal(&running, "iterm2", terminal::list_iterm_sessions);
        let active_terminal_windows = query_needed_terminal(&running, "terminalapp", terminal::list_terminal_app_windows);

        {
            let mut sessions = self.lock_sessions();

            // Validate each remaining running session
            for session in sessions.iter_mut() {
                if session.is_tmux_backed() {
                    if !tmux_session_has_recoverable_target(session) {
                        session.status = "stopped".to_string();
                    }
                    continue;
                }

                match (&session.terminal_type, &session.window_id) {
                    (Some(term_type), Some(wid)) => {
                        let is_alive = match term_type.as_str() {
                            "iterm2" => terminal_window_is_present(&active_iterm_sessions, wid),
                            "terminalapp" => terminal_window_is_present(&active_terminal_windows, wid),
                            _ => false,
                        };

                        if !is_alive {
                            if check_exit_file(&session.id).is_some() {
                                session.status = "stopped".to_string();
                                cleanup_exit_file(&session.id);
                            } else {
                                session.status = "interrupted".to_string();
                            }
                        }
                    }
                    _ => {
                        // No terminal metadata — can't verify, mark interrupted
                        session.status = "interrupted".to_string();
                    }
                }
            }
        }
        self.save_to_disk();
    }
}

fn query_needed_terminal(
    sessions: &[Session], kind: &str,
    query: impl FnOnce() -> Result<Vec<String>, String>,
) -> Result<Vec<String>, String> {
    if sessions.iter().any(|session| !session.is_tmux_backed() && session.terminal_type.as_deref() == Some(kind)) {
        query()
    } else {
        Ok(Vec::new())
    }
}

fn terminal_window_is_present(result: &Result<Vec<String>, String>, id: &str) -> bool {
    // Failure/timeout is unknown, so the next monitor pass can retry. It must
    // not turn a live user's session into an interrupted session.
    result.as_ref().map(|ids| ids.iter().any(|value| value == id)).unwrap_or(true)
}

/// Check if a process with the given PID is still running
#[cfg(unix)]
fn is_process_alive(pid: u32) -> bool {
    // kill(pid, 0) checks whether the process exists without spawning a shell command.
    let result = unsafe { libc::kill(pid as i32, 0) };
    if result == 0 {
        return true;
    }

    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn tmux_session_has_recoverable_target(session: &Session) -> bool {
    session.pid.is_some_and(is_process_alive)
        || session
            .resolved_tmux_target()
            .is_some_and(|target| !target.trim().is_empty())
}

#[cfg(windows)]
fn is_process_alive(pid: u32) -> bool {
    use std::process::Command;

    // Use tasklist to check if process exists
    Command::new("tasklist")
        .args(["/FI", &format!("PID eq {}", pid), "/NH"])
        .output()
        .map(|output| {
            let stdout = String::from_utf8_lossy(&output.stdout);
            stdout.contains(&pid.to_string())
        })
        .unwrap_or(false)
}

/// Get the sessions directory path
fn get_sessions_dir() -> std::path::PathBuf {
    dirs::home_dir()
        .map(|h| h.join(".ccem/sessions"))
        .unwrap_or_default()
}

/// Check if an exit file exists for a session and return the exit code
fn check_exit_file(session_id: &str) -> Option<i32> {
    let exit_file = get_sessions_dir().join(format!("{}.exit", session_id));
    if exit_file.exists() {
        std::fs::read_to_string(&exit_file)
            .ok()
            .and_then(|s| s.trim().parse().ok())
    } else {
        None
    }
}

/// Clean up the exit file for a session
pub fn cleanup_exit_file(session_id: &str) {
    let exit_file = get_sessions_dir().join(format!("{}.exit", session_id));
    let _ = std::fs::remove_file(exit_file);
}

/// Clean up stale exit files that don't belong to any persisted session.
/// Called on startup after load_from_disk, before validate_and_reconcile,
/// so that known sessions' exit files are preserved for reconciliation.
pub fn cleanup_stale_exit_files_except(manager: &SessionManager) {
    let sessions_dir = get_sessions_dir();
    if !sessions_dir.exists() {
        return;
    }

    let known_ids: std::collections::HashSet<String> = manager
        .lock_sessions()
        .iter()
        .map(|s| s.id.clone())
        .collect();

    if let Ok(entries) = std::fs::read_dir(&sessions_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map(|e| e == "exit").unwrap_or(false) {
                // Extract session ID from filename (e.g. "session-123456.exit" -> "session-123456")
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    if !known_ids.contains(stem) {
                        let _ = std::fs::remove_file(&path);
                    }
                }
            }
        }
    }
}

/// Start a background thread to monitor session status
/// Checks every 5 seconds if processes are still alive
pub fn start_session_monitor(app: AppHandle, manager: Arc<SessionManager>) {
    thread::spawn(move || {
        loop {
            // Sleep for 5 seconds between checks
            thread::sleep(Duration::from_secs(5));

            // 1. Check PID-based sessions (existing logic)
            let sessions_to_check = manager.get_running_sessions_with_pid();
            for (session_id, pid) in sessions_to_check {
                if !is_process_alive(pid) {
                    manager.update_session_status(&session_id, "stopped");
                    if let Some(session) = manager.get_session(&session_id) {
                        let _ = app.emit("session-updated", &session);
                    }
                }
            }

            // 2. Batch query all active terminal windows (single AppleScript call each)
            let terminal_sessions = manager.get_running_terminal_sessions();
            let active_iterm_sessions = query_needed_terminal(&terminal_sessions, "iterm2", terminal::list_iterm_sessions);
            let active_terminal_app_windows = query_needed_terminal(&terminal_sessions, "terminalapp", terminal::list_terminal_app_windows);

            // 3. Check terminal-based sessions
            for session in terminal_sessions {
                let context = NotificationContext::new(
                    session.env_name.clone(),
                    session.working_dir.clone(),
                    if session.client == "codex" {
                        "Codex"
                    } else {
                        "Claude"
                    },
                );

                // First check for exit status file
                if let Some(exit_code) = check_exit_file(&session.id) {
                    let event_name = if exit_code == 0 {
                        "task-completed"
                    } else {
                        "task-error"
                    };

                    manager.update_session_status(&session.id, "stopped");
                    if let Some(updated_session) = manager.get_session(&session.id) {
                        let _ = app.emit(event_name, &updated_session);
                    }
                    if exit_code == 0 {
                        notifications::maybe_notify_task_completed(&app, &context);
                    } else {
                        notifications::maybe_notify_task_failed(
                            &app,
                            &context,
                            format!("{} exited with code {}", context.client_name, exit_code),
                        );
                    }
                    cleanup_exit_file(&session.id);
                    continue;
                }

                // Then check if terminal window still exists
                if let (Some(term_type), Some(wid)) = (&session.terminal_type, &session.window_id) {
                    let is_alive = match term_type.as_str() {
                        "iterm2" => terminal_window_is_present(&active_iterm_sessions, wid),
                        "terminalapp" => terminal_window_is_present(&active_terminal_app_windows, wid),
                        _ => true,
                    };

                    if !is_alive {
                        // Window closed but no exit file = interrupted
                        manager.update_session_status(&session.id, "interrupted");
                        if let Some(updated_session) = manager.get_session(&session.id) {
                            let _ = app.emit("session-interrupted", &updated_session);
                        }
                        notifications::maybe_notify_task_failed(
                            &app,
                            &context,
                            format!(
                                "{} was interrupted because the terminal window closed",
                                project_label(&session.working_dir)
                            ),
                        );
                    }
                }
            }
        }
    });
}

fn project_label(working_dir: &str) -> String {
    std::path::Path::new(working_dir)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| working_dir.to_string())
}

#[cfg(test)]
mod tests {
    use super::{tmux_session_has_recoverable_target, Session, SessionManager};
    use std::sync::Arc;

    fn sample_session(id: &str) -> Session {
        Session {
            id: id.to_string(),
            pid: Some(42),
            client: "claude".to_string(),
            env_name: "glm-official".to_string(),
            config_source: Some("ccem".to_string()),
            perm_mode: "dev".to_string(),
            working_dir: "/tmp/project".to_string(),
            start_time: "2026-06-26T00:00:00Z".to_string(),
            status: "running".to_string(),
            terminal_type: Some("embedded".to_string()),
            window_id: None,
            iterm_session_id: None,
            tmux_target: Some(format!("ccem-{}:main", id.replace('-', ""))),
        }
    }

    #[test]
    fn startup_skips_unneeded_terminal_queries_and_preserves_unknown_sessions() {
        let session = sample_session("tmux-fixture");
        let result = super::query_needed_terminal(&[session], "iterm2", || {
            panic!("tmux restore must not start an AppleScript query");
        });
        assert_eq!(result.unwrap(), Vec::<String>::new());
        let mut session = sample_session("terminal-fixture");
        session.tmux_target = None;
        session.terminal_type = Some("iterm2".into());
        session.window_id = Some("42".into());
        let result = super::query_needed_terminal(&[session], "iterm2", || Err("timeout".into()));
        assert!(super::terminal_window_is_present(&result, "42"));
        assert!(!super::terminal_window_is_present(&Ok(vec![]), "42"));
        assert!(super::terminal_window_is_present(&Ok(vec!["42".into()]), "42"));
    }

    #[test]
    fn tmux_backed_session_with_target_survives_pidless_startup_reconcile() {
        let session = Session {
            id: "session-1777215516640".to_string(),
            pid: None,
            client: "claude".to_string(),
            env_name: "DeepSeek".to_string(),
            config_source: Some("ccem".to_string()),
            perm_mode: "dev".to_string(),
            working_dir: "/tmp/project".to_string(),
            start_time: "2026-04-26T00:00:00Z".to_string(),
            status: "running".to_string(),
            terminal_type: Some("iterm2".to_string()),
            window_id: Some("54783".to_string()),
            iterm_session_id: None,
            tmux_target: Some("ccem-session1777215516640:main".to_string()),
        };

        assert!(tmux_session_has_recoverable_target(&session));
    }

    #[test]
    fn try_add_session_persists_to_configured_path() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let sessions_path = temp_dir.path().join("sessions.json");
        let manager = SessionManager::load_from_path(sessions_path.clone());

        manager
            .try_add_session(sample_session("session-1782480915757"))
            .expect("session should persist");

        let persisted = std::fs::read_to_string(&sessions_path).expect("sessions file");
        let sessions: Vec<Session> =
            serde_json::from_str(&persisted).expect("persisted sessions json");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "session-1782480915757");
    }

    #[test]
    fn try_add_session_recovers_poisoned_session_lock() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let sessions_path = temp_dir.path().join("sessions.json");
        let manager = Arc::new(SessionManager::load_from_path(sessions_path.clone()));
        let poison_target = Arc::clone(&manager);

        let _ = std::thread::spawn(move || {
            let _guard = poison_target
                .sessions
                .lock()
                .expect("lock before poisoning");
            panic!("poison session manager lock for regression test");
        })
        .join();

        manager
            .try_add_session(sample_session("session-1782480920439"))
            .expect("poisoned lock should be recovered");

        let persisted = std::fs::read_to_string(&sessions_path).expect("sessions file");
        let sessions: Vec<Session> =
            serde_json::from_str(&persisted).expect("persisted sessions json");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "session-1782480920439");
    }
}
