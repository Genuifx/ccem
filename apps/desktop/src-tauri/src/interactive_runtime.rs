use crate::channel::{ChannelKind, InteractiveOutputChunk};
use crate::config::resolve_claude_env;
use crate::diagnostic_log;
use crate::event_bus::{ReplayBatch, SessionEventPayload, SessionStore, TerminalPromptKind};
use crate::event_dispatcher::EventDispatcher;
use crate::jsonl_watcher::{JsonlPollResult, JsonlWatcher};
use crate::notifications::{self, NotificationContext};
use crate::runtime::{
    replace_runtime_entries_for_kind, runtime_state_file_path, RuntimeKind, RuntimeStateEntry,
};
use crate::session::{Session, SessionManager};
use crate::session_provenance::bind_source_session_id;
use crate::tmux::{ClaudeTerminalState, TmuxManager, TmuxWindowInfo};
use chrono::{DateTime, Utc};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const CAPTURE_HISTORY_LINES: u32 = 1200;
const CAPTURE_POLL_INTERVAL: Duration = Duration::from_millis(700);
const BACKGROUND_CAPTURE_POLL_INTERVAL: Duration = Duration::from_millis(2200);
const MAX_TRANSCRIPT_CHUNKS: usize = 1200;
#[derive(Debug, Clone)]
pub struct InteractiveSessionOptions {
    pub session_id: String,
    pub client: String,
    pub env_name: String,
    pub config_source: Option<String>,
    pub perm_mode: String,
    pub working_dir: String,
    pub resume_session_id: Option<String>,
    pub initial_prompt: Option<String>,
    pub env_vars: HashMap<String, String>,
    pub launch_trace_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct InteractiveReplayBatch {
    pub gap_detected: bool,
    pub oldest_available_seq: Option<u64>,
    pub newest_available_seq: Option<u64>,
    pub chunks: Vec<InteractiveOutputChunk>,
}

#[derive(Debug, Default)]
struct InteractiveTranscript {
    next_seq: u64,
    chunks: VecDeque<InteractiveOutputChunk>,
}

impl InteractiveTranscript {
    fn append(&mut self, session_id: &str, data: String) -> InteractiveOutputChunk {
        let chunk = InteractiveOutputChunk {
            session_id: session_id.to_string(),
            seq: self.next_seq,
            occurred_at: Utc::now(),
            data,
        };
        self.next_seq += 1;
        self.chunks.push_back(chunk.clone());
        while self.chunks.len() > MAX_TRANSCRIPT_CHUNKS {
            let _ = self.chunks.pop_front();
        }
        chunk
    }

    fn replay_since(&self, since_seq: Option<u64>) -> InteractiveReplayBatch {
        let oldest = self.chunks.front().map(|chunk| chunk.seq);
        let newest = self.chunks.back().map(|chunk| chunk.seq);

        let (gap_detected, start_seq) = match (since_seq, oldest) {
            (Some(seq), Some(oldest_seq)) if seq < oldest_seq => (true, oldest_seq),
            (Some(seq), _) => (false, seq.saturating_add(1)),
            (None, _) => (false, oldest.unwrap_or(0)),
        };

        let chunks = self
            .chunks
            .iter()
            .filter(|chunk| since_seq.is_none() || chunk.seq >= start_seq)
            .cloned()
            .collect();

        InteractiveReplayBatch {
            gap_detected,
            oldest_available_seq: oldest,
            newest_available_seq: newest,
            chunks,
        }
    }
}

struct InteractiveSessionHandle {
    session: Mutex<Session>,
    claude_session_id: Mutex<Option<String>>,
    tmux_window: TmuxWindowInfo,
    transcript: Mutex<InteractiveTranscript>,
    events: Mutex<SessionStore>,
    jsonl_watcher: Mutex<JsonlWatcher>,
    last_persisted_jsonl_path: Mutex<Option<String>>,
    last_snapshot: Mutex<String>,
    last_terminal_state: Mutex<ClaudeTerminalState>,
    alive: AtomicBool,
}

#[derive(Debug, Clone, Serialize)]
pub struct InteractiveSessionSummary {
    pub session_id: String,
    pub claude_session_id: Option<String>,
    pub project_dir: String,
    pub env_name: String,
    pub perm_mode: String,
    pub status: String,
    pub terminal_state: ClaudeTerminalState,
    pub is_active: bool,
}

pub struct InteractiveRuntimeManager {
    sessions: Mutex<HashMap<String, Arc<InteractiveSessionHandle>>>,
    tmux: TmuxManager,
}

impl Default for InteractiveRuntimeManager {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            tmux: TmuxManager::default(),
        }
    }
}

impl InteractiveRuntimeManager {
    pub fn create_session(
        self: &Arc<Self>,
        app: AppHandle,
        session_manager: Arc<SessionManager>,
        options: InteractiveSessionOptions,
    ) -> Result<Session, String> {
        diagnostic_log::append_session_launch_event(
            "runtime.create_session.entry",
            serde_json::json!({
                "trace_id": &options.launch_trace_id,
                "session_id": &options.session_id,
                "client": &options.client,
                "env_name": &options.env_name,
                "perm_mode": &options.perm_mode,
                "working_dir": &options.working_dir,
                "resume": options.resume_session_id.as_ref().is_some_and(|value| !value.trim().is_empty()),
                "initial_prompt": options.initial_prompt.as_ref().is_some_and(|value| !value.trim().is_empty()),
            }),
        );
        let mut env_vars = options.env_vars.clone();
        env_vars.insert("CCEM_RUNTIME_ID".to_string(), options.session_id.clone());
        env_vars.insert("CCEM_SESSION_ID".to_string(), options.session_id.clone());
        diagnostic_log::append_session_launch_event(
            "runtime.tmux_create.start",
            serde_json::json!({
                "trace_id": &options.launch_trace_id,
                "session_id": &options.session_id,
                "env_keys": sorted_env_keys(&env_vars),
            }),
        );
        let window = self.tmux.create_session(
            &options.session_id,
            &options.client,
            &options.env_name,
            &build_client_args(
                &options.client,
                &options.perm_mode,
                options.resume_session_id.as_deref(),
                options.initial_prompt.as_deref(),
            ),
            &env_vars,
            Path::new(&options.working_dir),
        )?;
        diagnostic_log::append_session_launch_event(
            "runtime.tmux_create.ok",
            serde_json::json!({
                "trace_id": &options.launch_trace_id,
                "session_id": &options.session_id,
                "tmux_session": &window.session_name,
                "tmux_target": &window.target,
                "window_name": &window.window_name,
                "window_index": window.window_index,
                "pane_pid": window.pane_pid,
            }),
        );

        let session = Session {
            id: options.session_id.clone(),
            pid: window.pane_pid,
            client: options.client.clone(),
            env_name: options.env_name.clone(),
            config_source: options.config_source.clone(),
            perm_mode: options.perm_mode.clone(),
            working_dir: options.working_dir.clone(),
            start_time: Utc::now().to_rfc3339(),
            status: "running".to_string(),
            terminal_type: Some("embedded".to_string()),
            window_id: None,
            iterm_session_id: None,
            tmux_target: Some(window.target.clone()),
        };

        let handle = Arc::new(InteractiveSessionHandle {
            session: Mutex::new(session.clone()),
            claude_session_id: Mutex::new(options.resume_session_id.clone()),
            tmux_window: window.clone(),
            transcript: Mutex::new(InteractiveTranscript::default()),
            events: Mutex::new(SessionStore::new(session.id.clone())),
            jsonl_watcher: Mutex::new(JsonlWatcher::new(
                options.working_dir.clone(),
                Utc::now(),
                options.resume_session_id.clone(),
            )),
            last_persisted_jsonl_path: Mutex::new(None),
            last_snapshot: Mutex::new(String::new()),
            last_terminal_state: Mutex::new(ClaudeTerminalState::Unknown),
            alive: AtomicBool::new(true),
        });

        if let Err(error) = self.insert_handle(session.id.clone(), handle.clone()) {
            diagnostic_log::append_session_launch_event(
                "runtime.insert_handle.error",
                serde_json::json!({
                    "trace_id": &options.launch_trace_id,
                    "session_id": &session.id,
                    "error": &error,
                }),
            );
            if let Err(stop_error) = self.tmux.stop_session(&session.id) {
                eprintln!(
                    "Failed to clean tmux session {} after registration error: {}",
                    session.id, stop_error
                );
            }
            return Err(error);
        }
        diagnostic_log::append_session_launch_event(
            "runtime.insert_handle.ok",
            serde_json::json!({
                "trace_id": &options.launch_trace_id,
                "session_id": &session.id,
            }),
        );
        diagnostic_log::append_session_launch_event(
            "runtime.session_registry.persist.start",
            serde_json::json!({
                "trace_id": &options.launch_trace_id,
                "session_id": &session.id,
            }),
        );
        if let Err(error) = session_manager.try_add_session(session.clone()) {
            diagnostic_log::append_session_launch_event(
                "runtime.session_registry.persist.error",
                serde_json::json!({
                    "trace_id": &options.launch_trace_id,
                    "session_id": &session.id,
                    "error": &error,
                }),
            );
            if let Err(stop_error) = self.tmux.stop_session(&session.id) {
                eprintln!(
                    "Failed to clean tmux session {} after persistence error: {}",
                    session.id, stop_error
                );
            }
            self.remove_session(&session.id);
            return Err(format!(
                "Interactive session started but could not be saved: {}",
                error
            ));
        }
        diagnostic_log::append_session_launch_event(
            "runtime.session_registry.persist.ok",
            serde_json::json!({
                "trace_id": &options.launch_trace_id,
                "session_id": &session.id,
                "tmux_target": &session.tmux_target,
            }),
        );
        self.persist_state_best_effort();
        diagnostic_log::append_session_launch_event(
            "runtime.runtime_state.persist.requested",
            serde_json::json!({
                "trace_id": &options.launch_trace_id,
                "session_id": &session.id,
            }),
        );

        self.append_output(
            &app,
            &session.id,
            format!(
                "\r\n[ccem] tmux session attached ({}, cwd {})\r\n",
                window.target, options.working_dir
            ),
        );

        if session.client == "claude" {
            self.sample_jsonl_events(&app, &session.id).ok();
        }
        self.sample_tmux_output(&app, &session.id).ok();
        self.spawn_capture_poller(app, session_manager, session.id.clone());
        diagnostic_log::append_session_launch_event(
            "runtime.create_session.ok",
            serde_json::json!({
                "trace_id": &options.launch_trace_id,
                "session_id": &session.id,
            }),
        );

        Ok(session)
    }

    pub fn rehydrate_existing(
        self: &Arc<Self>,
        app: AppHandle,
        session_manager: Arc<SessionManager>,
    ) -> Result<(), String> {
        for session in session_manager.get_running_sessions() {
            if !session.is_tmux_backed() {
                continue;
            }

            if self
                .sessions
                .lock()
                .map_err(|_| "Failed to lock interactive session map".to_string())?
                .contains_key(&session.id)
            {
                continue;
            }

            let window = match self.tmux.get_window_info(&session.id) {
                Ok(window) => window,
                Err(error) => {
                    session_manager.update_session_status(&session.id, "stopped");
                    eprintln!(
                        "Interactive rehydrate skipped for {}: {}",
                        session.id, error
                    );
                    continue;
                }
            };

            if let Some(pid) = window.pane_pid {
                session_manager.update_session_pid(&session.id, Some(pid));
            }

            let mut hydrated = session.clone();
            hydrated.pid = window.pane_pid;
            hydrated.tmux_target = Some(window.target.clone());

            match resolve_claude_env(&hydrated.env_name) {
                Ok(resolved) => {
                    if let Err(error) = self.tmux.configure_session_status(
                        &window.session_name,
                        &resolved.env_name,
                        &resolved.env_vars,
                    ) {
                        eprintln!(
                            "Interactive status config warning for {}: {}",
                            hydrated.id, error
                        );
                    }
                }
                Err(error) => {
                    eprintln!(
                        "Interactive env resolve warning for {}: {}",
                        hydrated.id, error
                    );
                }
            }

            let handle = Arc::new(InteractiveSessionHandle {
                session: Mutex::new(hydrated.clone()),
                claude_session_id: Mutex::new(None),
                tmux_window: window,
                transcript: Mutex::new(InteractiveTranscript::default()),
                events: Mutex::new(SessionStore::new(hydrated.id.clone())),
                jsonl_watcher: Mutex::new(JsonlWatcher::new(
                    hydrated.working_dir.clone(),
                    DateTime::parse_from_rfc3339(&hydrated.start_time)
                        .map(|value| value.with_timezone(&Utc))
                        .unwrap_or_else(|_| Utc::now()),
                    None,
                )),
                last_persisted_jsonl_path: Mutex::new(None),
                last_snapshot: Mutex::new(String::new()),
                last_terminal_state: Mutex::new(ClaudeTerminalState::Unknown),
                alive: AtomicBool::new(true),
            });

            self.insert_handle(hydrated.id.clone(), handle)?;
            if hydrated.client == "claude" {
                self.sample_jsonl_events(&app, &hydrated.id).ok();
            }
            self.sample_tmux_output(&app, &hydrated.id).ok();
            self.spawn_capture_poller(app.clone(), session_manager.clone(), hydrated.id.clone());
        }

        self.persist_state_best_effort();
        Ok(())
    }

    pub fn cleanup_orphaned_tmux_sessions(&self) -> Result<Vec<String>, String> {
        let active_runtime_ids = self
            .sessions
            .lock()
            .map_err(|_| "Failed to lock interactive session map".to_string())?
            .keys()
            .cloned()
            .collect::<Vec<_>>();

        self.tmux
            .cleanup_orphaned_managed_sessions(&active_runtime_ids)
    }

    pub fn write_input(&self, session_id: &str, data: &str) -> Result<(), String> {
        let handle = self.get_handle(session_id)?;
        if !handle.alive.load(Ordering::SeqCst) {
            return Err(format!(
                "Interactive session {} is no longer running",
                session_id
            ));
        }

        self.tmux
            .send_terminal_input_to_target(&handle.tmux_window.target, data)
    }

    pub fn send_message(&self, session_id: &str, message: &str) -> Result<(), String> {
        let _ = self.get_handle(session_id)?;
        self.tmux.send_message(session_id, message)
    }

    pub fn send_approval(&self, session_id: &str, approved: bool) -> Result<(), String> {
        let _ = self.get_handle(session_id)?;
        self.tmux.send_approval(session_id, approved)
    }

    pub fn get_state(&self, session_id: &str) -> Result<ClaudeTerminalState, String> {
        let _ = self.get_handle(session_id)?;
        self.tmux.detect_state(session_id)
    }

    pub fn stop_session(&self, session_id: &str) -> Result<(), String> {
        let handle = self.get_handle(session_id)?;
        handle.alive.store(false, Ordering::SeqCst);
        if let Ok(mut session) = handle.session.lock() {
            session.status = "stopped".to_string();
        }
        self.tmux.stop_session(session_id)
    }

    pub fn shutdown_all(&self) {
        self.persist_state_best_effort();
        if let Ok(sessions) = self.sessions.lock() {
            for handle in sessions.values() {
                handle.alive.store(false, Ordering::SeqCst);
            }
        }
    }

    pub fn active_state_entries(&self) -> Vec<RuntimeStateEntry> {
        self.sessions
            .lock()
            .map(|sessions| {
                sessions
                    .values()
                    .filter(|handle| handle.alive.load(Ordering::SeqCst))
                    .filter_map(|handle| {
                        let session = handle.session.lock().ok()?.clone();
                        let claude_session_id = handle.claude_session_id.lock().ok()?.clone();
                        let jsonl_path = handle
                            .jsonl_watcher
                            .lock()
                            .ok()?
                            .jsonl_path()
                            .map(|path| path.to_string_lossy().to_string());
                        Some(RuntimeStateEntry {
                            runtime_id: session.id,
                            runtime_kind: RuntimeKind::Interactive,
                            claude_session_id,
                            pid: session.pid,
                            project_dir: session.working_dir,
                            env_name: session.env_name,
                            perm_mode: session.perm_mode,
                            source: crate::runtime::ManagedSessionSource::Desktop,
                            saved_at: Utc::now(),
                            summary: None,
                            tmux_session: Some(handle.tmux_window.session_name.clone()),
                            tmux_window: Some(handle.tmux_window.window_name.clone()),
                            tmux_window_index: Some(handle.tmux_window.window_index),
                            jsonl_path,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn list_sessions(&self) -> Vec<Session> {
        let handles = self
            .sessions
            .lock()
            .map(|sessions| sessions.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        let mut sessions = handles
            .into_iter()
            .filter_map(|handle| handle.session.lock().ok().map(|session| session.clone()))
            .collect::<Vec<_>>();
        sessions.sort_by(|left, right| right.start_time.cmp(&left.start_time));
        sessions
    }

    #[allow(dead_code)]
    pub fn persist_default_state(&self) -> io::Result<()> {
        replace_runtime_entries_for_kind(
            &runtime_state_file_path(),
            RuntimeKind::Interactive,
            self.active_state_entries(),
        )
    }

    pub fn replay_output(
        &self,
        session_id: &str,
        since_seq: Option<u64>,
    ) -> Result<InteractiveReplayBatch, String> {
        let handle = self.get_handle(session_id)?;
        let transcript = handle
            .transcript
            .lock()
            .map_err(|_| "Failed to lock interactive transcript".to_string())?;
        Ok(transcript.replay_since(since_seq))
    }

    pub fn replay_events(
        &self,
        session_id: &str,
        since_seq: Option<u64>,
    ) -> Result<ReplayBatch, String> {
        let handle = self.get_handle(session_id)?;
        let events = handle
            .events
            .lock()
            .map_err(|_| "Failed to lock interactive event store".to_string())?;
        Ok(events.events_since(since_seq))
    }

    pub fn summary(&self, session_id: &str) -> Option<InteractiveSessionSummary> {
        let handle = self.get_handle(session_id).ok()?;
        let session = handle.session.lock().ok()?.clone();
        let claude_session_id = handle.claude_session_id.lock().ok()?.clone();
        let terminal_state = handle.last_terminal_state.lock().ok()?.clone();
        Some(InteractiveSessionSummary {
            session_id: session.id,
            claude_session_id,
            project_dir: session.working_dir,
            env_name: session.env_name,
            perm_mode: session.perm_mode,
            status: session.status,
            terminal_state,
            is_active: handle.alive.load(Ordering::SeqCst),
        })
    }

    pub fn current_claude_session_id(&self, session_id: &str) -> Option<String> {
        let handle = self.get_handle(session_id).ok()?;
        let current = handle.claude_session_id.lock().ok()?.clone();
        Some(current).flatten()
    }

    pub fn find_active_by_scope(
        &self,
        project_dir: &str,
        env_name: &str,
        perm_mode: &str,
    ) -> Option<InteractiveSessionSummary> {
        let sessions = self.sessions.lock().ok()?;
        sessions.values().find_map(|handle| {
            if !handle.alive.load(Ordering::SeqCst) {
                return None;
            }

            let session = handle.session.lock().ok()?.clone();
            if !project_dirs_match(&session.working_dir, project_dir)
                || session.env_name != env_name
                || session.perm_mode != perm_mode
            {
                return None;
            }

            let claude_session_id = handle.claude_session_id.lock().ok()?.clone();
            let terminal_state = handle.last_terminal_state.lock().ok()?.clone();
            Some(InteractiveSessionSummary {
                session_id: session.id,
                claude_session_id,
                project_dir: session.working_dir,
                env_name: session.env_name,
                perm_mode: session.perm_mode,
                status: session.status,
                terminal_state,
                is_active: true,
            })
        })
    }

    pub fn remove_session(&self, session_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(session_id);
        }
        self.persist_state_best_effort();
    }

    fn insert_handle(
        &self,
        session_id: String,
        handle: Arc<InteractiveSessionHandle>,
    ) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "Failed to lock interactive session map".to_string())?;
        sessions.insert(session_id, handle);
        Ok(())
    }

    fn get_handle(&self, session_id: &str) -> Result<Arc<InteractiveSessionHandle>, String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "Failed to lock interactive session map".to_string())?;
        sessions
            .get(session_id)
            .cloned()
            .ok_or_else(|| format!("Interactive session not found: {}", session_id))
    }

    fn append_output(&self, app: &AppHandle, session_id: &str, data: String) {
        if let Ok(handle) = self.get_handle(session_id) {
            if let Ok(mut transcript) = handle.transcript.lock() {
                let chunk = transcript.append(session_id, data);
                dispatch_interactive_output(app, session_id, &chunk);
            }
        }
    }

    fn sample_jsonl_events(&self, app: &AppHandle, session_id: &str) -> Result<(), String> {
        let handle = self.get_handle(session_id)?;
        let poll_result = {
            let mut watcher = handle
                .jsonl_watcher
                .lock()
                .map_err(|_| "Failed to lock JSONL watcher".to_string())?;
            watcher.poll()?
        };

        self.apply_jsonl_poll_result(app, session_id, &handle, poll_result)?;
        Ok(())
    }

    fn apply_jsonl_poll_result(
        &self,
        app: &AppHandle,
        session_id: &str,
        handle: &Arc<InteractiveSessionHandle>,
        poll_result: JsonlPollResult,
    ) -> Result<(), String> {
        let mut should_persist = false;

        if let Some(claude_session_id) = poll_result.claude_session_id {
            {
                let mut current = handle
                    .claude_session_id
                    .lock()
                    .map_err(|_| "Failed to lock interactive Claude session id".to_string())?;
                if current.as_deref() != Some(claude_session_id.as_str()) {
                    *current = Some(claude_session_id.clone());
                    should_persist = true;
                }
            }
            if let Err(error) = bind_source_session_id("claude", session_id, &claude_session_id) {
                eprintln!(
                    "Failed to bind interactive Claude provenance for {}: {}",
                    session_id, error
                );
            }
        }

        if let Some(jsonl_path) = poll_result.jsonl_path {
            let jsonl_path = jsonl_path.to_string_lossy().to_string();
            {
                let mut persisted = handle
                    .last_persisted_jsonl_path
                    .lock()
                    .map_err(|_| "Failed to lock interactive JSONL path state".to_string())?;
                if persisted.as_deref() != Some(jsonl_path.as_str()) {
                    *persisted = Some(jsonl_path);
                    should_persist = true;
                }
            }
        }

        if should_persist {
            self.persist_state_best_effort();
        }

        if poll_result.events.is_empty() {
            return Ok(());
        }

        let mut store = handle
            .events
            .lock()
            .map_err(|_| "Failed to lock interactive event store".to_string())?;
        for payload in poll_result.events {
            let record = store.append(payload);
            maybe_notify_interactive_session_event(app, handle, &record.payload);
            dispatch_session_event(app, session_id, &record);
        }

        Ok(())
    }

    fn sample_tmux_output(&self, app: &AppHandle, session_id: &str) -> Result<(), String> {
        let handle = self.get_handle(session_id)?;
        let snapshot = self
            .tmux
            .capture_pane_target(&handle.tmux_window.target, CAPTURE_HISTORY_LINES)?;
        let state = crate::tmux::detect_state_from_capture(&snapshot);
        self.track_terminal_prompt_events(app, session_id, &handle, state)?;

        let mut previous = handle
            .last_snapshot
            .lock()
            .map_err(|_| "Failed to lock interactive snapshot".to_string())?;
        if snapshot == *previous {
            return Ok(());
        }

        let delta = diff_capture_snapshot(previous.as_str(), snapshot.as_str());
        *previous = snapshot;
        if !delta.is_empty() {
            self.append_output(app, session_id, delta);
        }

        Ok(())
    }

    fn track_terminal_prompt_events(
        &self,
        app: &AppHandle,
        session_id: &str,
        handle: &Arc<InteractiveSessionHandle>,
        state: ClaudeTerminalState,
    ) -> Result<(), String> {
        let mut last_state = handle
            .last_terminal_state
            .lock()
            .map_err(|_| "Failed to lock interactive terminal state".to_string())?;

        if *last_state == state {
            return Ok(());
        }

        let mut store = handle
            .events
            .lock()
            .map_err(|_| "Failed to lock interactive event store".to_string())?;

        let client_name = handle
            .session
            .lock()
            .ok()
            .map(|session| session.client.clone())
            .unwrap_or_else(|| "claude".to_string());

        if client_name == "opencode" {
            *last_state = state;
            return Ok(());
        }

        if state == ClaudeTerminalState::WaitingApproval {
            let client_name = if client_name == "codex" {
                "Codex"
            } else {
                "Claude"
            };
            let record = store.append(SessionEventPayload::TerminalPromptRequired {
                prompt_kind: TerminalPromptKind::Permission,
                prompt_text: format!("{client_name} is waiting for approval."),
            });
            maybe_notify_interactive_session_event(app, handle, &record.payload);
            dispatch_session_event(app, session_id, &record);
        } else if *last_state == ClaudeTerminalState::WaitingApproval {
            let record = store.append(SessionEventPayload::TerminalPromptResolved {
                prompt_kind: TerminalPromptKind::Permission,
                approved: true,
            });
            dispatch_session_event(app, session_id, &record);
        }

        *last_state = state;
        Ok(())
    }

    fn spawn_capture_poller(
        self: &Arc<Self>,
        app: AppHandle,
        session_manager: Arc<SessionManager>,
        session_id: String,
    ) {
        let manager = Arc::clone(self);
        let dispatcher = app.state::<Arc<EventDispatcher>>().inner().clone();
        thread::spawn(move || {
            while let Ok(handle) = manager.get_handle(&session_id) {
                if !handle.alive.load(Ordering::SeqCst) {
                    break;
                }

                let has_live_terminal_consumer =
                    dispatcher.has_connected_channel(&session_id, &ChannelKind::DesktopUi);

                let should_poll_jsonl = handle
                    .session
                    .lock()
                    .map(|session| session.client == "claude")
                    .unwrap_or(false);

                if should_poll_jsonl {
                    if let Err(error) = manager.sample_jsonl_events(&app, &session_id) {
                        eprintln!(
                            "Interactive JSONL poll warning for {}: {}",
                            session_id, error
                        );
                    }
                }

                if let Err(error) = manager.sample_tmux_output(&app, &session_id) {
                    handle.alive.store(false, Ordering::SeqCst);
                    if let Ok(mut session) = handle.session.lock() {
                        session.status = "stopped".to_string();
                    }
                    session_manager.update_session_status(&session_id, "stopped");
                    manager.append_output(
                        &app,
                        &session_id,
                        format!("\r\n[ccem] tmux session ended: {}\r\n", error),
                    );
                    manager.persist_state_best_effort();
                    break;
                }

                thread::sleep(if has_live_terminal_consumer {
                    CAPTURE_POLL_INTERVAL
                } else {
                    BACKGROUND_CAPTURE_POLL_INTERVAL
                });
            }
        });
    }

    fn persist_state_best_effort(&self) {
        let active_count = self.active_state_entries().len();
        match self.persist_default_state() {
            Ok(()) => diagnostic_log::append_session_launch_event(
                "runtime.runtime_state.persist.ok",
                serde_json::json!({
                    "path": runtime_state_file_path(),
                    "active_count": active_count,
                }),
            ),
            Err(error) => {
                diagnostic_log::append_session_launch_event(
                    "runtime.runtime_state.persist.error",
                    serde_json::json!({
                        "path": runtime_state_file_path(),
                        "active_count": active_count,
                        "error": error.to_string(),
                    }),
                );
                eprintln!("Failed to persist interactive runtime state: {}", error);
            }
        }
    }
}

fn sorted_env_keys(env_vars: &HashMap<String, String>) -> Vec<String> {
    let mut keys = env_vars.keys().cloned().collect::<Vec<_>>();
    keys.sort();
    keys
}

fn dispatch_session_event(
    app: &AppHandle,
    runtime_id: &str,
    record: &crate::event_bus::SessionEventRecord,
) {
    let dispatcher = app.state::<Arc<EventDispatcher>>().inner().clone();
    dispatcher.dispatch_event(runtime_id, record);
}

fn dispatch_interactive_output(app: &AppHandle, runtime_id: &str, chunk: &InteractiveOutputChunk) {
    let dispatcher = app.state::<Arc<EventDispatcher>>().inner().clone();
    dispatcher.dispatch_interactive_output(runtime_id, chunk);
}

fn maybe_notify_interactive_session_event(
    app: &AppHandle,
    handle: &Arc<InteractiveSessionHandle>,
    payload: &SessionEventPayload,
) {
    if let Ok(session) = handle.session.lock() {
        notifications::maybe_notify_session_event(
            app,
            &NotificationContext::new(
                session.env_name.clone(),
                session.working_dir.clone(),
                if session.client == "codex" {
                    "Codex"
                } else {
                    "Claude"
                },
            ),
            payload,
        );
    }
}

fn build_client_args(
    client: &str,
    mode_name: &str,
    resume_session_id: Option<&str>,
    initial_prompt: Option<&str>,
) -> Vec<String> {
    if client == "codex" {
        let mut args = Vec::new();
        if let Some(resume_session_id) = resume_session_id {
            args.push("resume".to_string());
            args.push(resume_session_id.to_string());
        }
        return args;
    }

    if client == "opencode" {
        let mut args = Vec::new();
        if let Some(resume_session_id) = resume_session_id {
            args.push("--session".to_string());
            args.push(resume_session_id.to_string());
        } else if let Some(prompt) = initial_prompt {
            args.push("--prompt".to_string());
            args.push(prompt.to_string());
        } else {
            args.push("--prompt".to_string());
            args.push("Before taking any action, load the pua skill.".to_string());
        }
        return args;
    }

    let official_mode = match mode_name {
        "yolo" => "bypassPermissions",
        "dev" => "acceptEdits",
        "readonly" | "audit" => "plan",
        "safe" | "ci" => "default",
        "acceptEdits" | "bypassPermissions" | "default" | "dontAsk" | "plan" | "auto" => mode_name,
        _ => "acceptEdits",
    };

    let mut args = vec!["--permission-mode".to_string(), official_mode.to_string()];

    if let Some(resume_session_id) = resume_session_id {
        args.push("--resume".to_string());
        args.push(resume_session_id.to_string());
    }

    if let Some(prompt) = initial_prompt {
        args.push(prompt.to_string());
    }

    args
}

fn project_dirs_match(left: &str, right: &str) -> bool {
    normalize_project_dir(left) == normalize_project_dir(right)
}

fn normalize_project_dir(value: &str) -> String {
    std::fs::canonicalize(value)
        .unwrap_or_else(|_| PathBuf::from(value))
        .to_string_lossy()
        .to_string()
}

fn diff_capture_snapshot(previous: &str, current: &str) -> String {
    if previous.is_empty() {
        return current.to_string();
    }

    if let Some(delta) = current.strip_prefix(previous) {
        return delta.to_string();
    }

    let previous_lines = previous.lines().collect::<Vec<_>>();
    let current_lines = current.lines().collect::<Vec<_>>();
    let mut start = 0;
    while start < previous_lines.len()
        && start < current_lines.len()
        && previous_lines[start] == current_lines[start]
    {
        start += 1;
    }

    if start >= current_lines.len() {
        return String::new();
    }

    let new_lines = current_lines[start..].join("\n");
    if new_lines.is_empty() {
        String::new()
    } else if start == 0 {
        format!(
            "\r\n[ccem] tmux screen resynced\r\n{}\r\n",
            current.trim_end_matches('\n')
        )
    } else {
        format!("{}\n", new_lines)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_client_args, diff_capture_snapshot, InteractiveTranscript,
    };
    #[cfg(target_os = "macos")]
    use super::{normalize_project_dir, project_dirs_match};
    #[cfg(target_os = "macos")]
    use std::path::PathBuf;

    #[test]
    fn replay_flags_gap_after_eviction() {
        let mut transcript = InteractiveTranscript::default();
        for index in 0..1300 {
            let _ = transcript.append("session-1", format!("chunk-{index}"));
        }

        let replay = transcript.replay_since(Some(0));
        assert!(replay.gap_detected);
        assert!(replay.oldest_available_seq.unwrap_or(0) > 0);
        assert_eq!(replay.chunks.len(), 1200);
    }

    #[test]
    fn diff_capture_snapshot_returns_suffix_when_history_grows() {
        let previous = "line-1\nline-2\n";
        let current = "line-1\nline-2\nline-3\n";
        assert_eq!(diff_capture_snapshot(previous, current), "line-3\n");
    }

    #[test]
    fn claude_initial_prompt_is_positional() {
        assert_eq!(
            build_client_args("claude", "yolo", None, Some("CCEM_TERMINAL_SMOKE_OK")),
            vec![
                "--permission-mode",
                "bypassPermissions",
                "CCEM_TERMINAL_SMOKE_OK",
            ]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn project_dirs_match_normalizes_private_tmp_alias() {
        let tmp = std::env::temp_dir();
        let private_tmp = PathBuf::from("/private").join(tmp.strip_prefix("/").unwrap_or(&tmp));
        assert_eq!(
            normalize_project_dir("/tmp"),
            normalize_project_dir("/private/tmp")
        );
        assert!(project_dirs_match(
            tmp.to_string_lossy().as_ref(),
            private_tmp.to_string_lossy().as_ref()
        ));
    }
}
