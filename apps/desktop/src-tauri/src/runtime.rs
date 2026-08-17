//! Headless runtime for Claude Code subprocess execution.
//!
//! This module manages `claude -p` / `stream-json` sessions used by automation
//! and remote adapters. It is not the primary local interactive runtime.

use crate::channel::DesktopChannel;
use crate::config;
use crate::event_bus::{ReplayBatch, SessionEventPayload, SessionStore};
use crate::event_dispatcher::EventDispatcher;
use crate::notifications::{self, NotificationContext};
use crate::remote::{RemotePeerRef, RemotePlatform};
use crate::secure_fs::write_private_atomic;
use crate::session_provenance::bind_source_session_id;
use crate::terminal::resolve_claude_path;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, BufRead, BufReader, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const RUNTIME_STATE_NOTE: &str =
    "Cold resume only. Used for orphan cleanup and --resume, not stdio reattachment.";
const CCEM_PERMISSION_MCP_SERVER_NAME: &str = "ccem_permission";
const CCEM_PERMISSION_MCP_TOOL_NAME: &str = "mcp__ccem_permission__approval_prompt";
const PERMISSION_BRIDGE_REQUEST_POLL_MS: u64 = 300;
const PERMISSION_BRIDGE_RESPONSE_TIMEOUT_SECS: u64 = 60 * 30;
const PERMISSION_MCP_SERVER_SOURCE: &str =
    include_str!("../resources/ccem-permission-mcp-server.mjs");

static USER_PATH: OnceLock<String> = OnceLock::new();

#[derive(Debug, Clone)]
struct PermissionPromptBridge {
    bridge_dir: PathBuf,
    requests_dir: PathBuf,
    responses_dir: PathBuf,
    mcp_config_path: PathBuf,
}

#[derive(Debug, Clone)]
struct PendingPermissionRequest {
    runtime_id: String,
    bridge: PermissionPromptBridge,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PermissionPromptRequestFile {
    request_id: String,
    tool_name: String,
    input: Value,
    #[serde(default)]
    tool_use_id: Option<String>,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PermissionPromptResponseFile {
    behavior: String,
    #[serde(rename = "updatedInput", skip_serializing_if = "Option::is_none")]
    updated_input: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

struct BuildClaudeCommandResult {
    command: Command,
    permission_bridge: Option<PermissionPromptBridge>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeKind {
    Interactive,
    Headless,
}

fn default_runtime_kind() -> RuntimeKind {
    RuntimeKind::Headless
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ManagedSessionSource {
    Desktop,
    Telegram { chat_id: i64, thread_id: i64 },
    Weixin { peer_id: String },
    Wecom { bot_id: String, peer_id: String },
    Cron { task_id: String },
}

impl ManagedSessionSource {
    pub fn remote_peer_ref(&self) -> Option<RemotePeerRef> {
        match self {
            Self::Desktop | Self::Cron { .. } => None,
            Self::Telegram { chat_id, thread_id } => {
                Some(RemotePeerRef::telegram(*chat_id, Some(*thread_id)))
            }
            Self::Weixin { peer_id } => Some(RemotePeerRef::weixin(peer_id.clone())),
            Self::Wecom { bot_id, peer_id } => {
                Some(RemotePeerRef::wecom(bot_id.clone(), peer_id.clone()))
            }
        }
    }

    pub fn matches_remote_peer(
        &self,
        platform: RemotePlatform,
        peer_id: &str,
        thread_id: Option<&str>,
    ) -> bool {
        self.remote_peer_ref().is_some_and(|candidate| {
            candidate.platform == platform
                && candidate.peer_id == peer_id
                && candidate.thread_id.as_deref() == thread_id
        })
    }
}

pub type HeadlessSessionSource = ManagedSessionSource;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ManagedSessionStatus {
    Initializing,
    Ready,
    Processing,
    WaitingPermission {
        request_id: String,
        tool_name: String,
    },
    Completed,
    Stopped,
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CompactedSummary {
    pub total_events: usize,
    pub last_event_seq: Option<u64>,
    pub outcome: String,
    pub finished_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeStateEntry {
    pub runtime_id: String,
    #[serde(default = "default_runtime_kind")]
    pub runtime_kind: RuntimeKind,
    pub claude_session_id: Option<String>,
    pub pid: Option<u32>,
    pub project_dir: String,
    pub env_name: String,
    pub perm_mode: String,
    pub source: ManagedSessionSource,
    pub saved_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<CompactedSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tmux_session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tmux_window: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tmux_window_index: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jsonl_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeStateFile {
    pub sessions: Vec<RuntimeStateEntry>,
    pub note: String,
}

impl Default for RuntimeStateFile {
    fn default() -> Self {
        Self {
            sessions: Vec::new(),
            note: RUNTIME_STATE_NOTE.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ManagedSessionRecord {
    pub runtime_id: String,
    pub claude_session_id: Option<String>,
    pub pid: Option<u32>,
    pub project_dir: String,
    pub env_name: String,
    pub perm_mode: String,
    pub source: ManagedSessionSource,
    pub state: ManagedSessionStatus,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeRecoveryCandidate {
    pub runtime_id: String,
    pub runtime_kind: RuntimeKind,
    pub claude_session_id: String,
    pub project_dir: String,
    pub env_name: String,
    pub perm_mode: String,
    pub source: ManagedSessionSource,
    pub saved_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ManagedSessionSummary {
    pub runtime_id: String,
    pub claude_session_id: Option<String>,
    pub pid: Option<u32>,
    pub project_dir: String,
    pub env_name: String,
    pub perm_mode: String,
    pub source: ManagedSessionSource,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub is_active: bool,
    pub last_event_seq: Option<u64>,
}

pub type HeadlessSessionSummary = ManagedSessionSummary;

#[derive(Debug, Clone)]
pub struct ManagedSessionOptions {
    pub env_name: String,
    pub perm_mode: String,
    pub working_dir: String,
    pub resume_session_id: Option<String>,
    pub initial_prompt: Option<String>,
    pub max_budget_usd: Option<f64>,
    pub allowed_tools: Vec<String>,
    pub disallowed_tools: Vec<String>,
    pub env_vars: HashMap<String, String>,
    pub source: ManagedSessionSource,
}

pub type HeadlessSessionOptions = ManagedSessionOptions;

struct ManagedSessionHandle {
    record: Mutex<ManagedSessionRecord>,
    stdin: Mutex<Option<ChildStdin>>,
    events: Mutex<SessionStore>,
    permission_bridge: Option<PermissionPromptBridge>,
    alive: AtomicBool,
}

pub struct RuntimeManager {
    sessions: Mutex<HashMap<String, Arc<ManagedSessionHandle>>>,
    pending_permissions: Mutex<HashMap<String, PendingPermissionRequest>>,
}

pub type HeadlessRuntimeManager = RuntimeManager;

impl Default for RuntimeManager {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            pending_permissions: Mutex::new(HashMap::new()),
        }
    }
}

impl RuntimeManager {
    pub fn create_session(
        self: &Arc<Self>,
        app: AppHandle,
        options: ManagedSessionOptions,
    ) -> Result<ManagedSessionSummary, String> {
        let runtime_id = generate_runtime_id();
        let build = build_claude_command(&options, &runtime_id)?;
        let mut command = build.command;
        let mut child = command
            .spawn()
            .map_err(|error| format!("Failed to spawn Claude CLI: {}", error))?;

        let pid = child.id();
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to capture Claude stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to capture Claude stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Failed to capture Claude stderr".to_string())?;

        let handle = Arc::new(ManagedSessionHandle {
            record: Mutex::new(ManagedSessionRecord {
                runtime_id: runtime_id.clone(),
                claude_session_id: None,
                pid: Some(pid),
                project_dir: options.working_dir.clone(),
                env_name: options.env_name.clone(),
                perm_mode: options.perm_mode.clone(),
                source: options.source.clone(),
                state: ManagedSessionStatus::Initializing,
                created_at: Utc::now(),
            }),
            stdin: Mutex::new(Some(stdin)),
            events: Mutex::new(SessionStore::new(runtime_id.clone())),
            permission_bridge: build.permission_bridge.clone(),
            alive: AtomicBool::new(true),
        });

        self.insert_handle(runtime_id.clone(), handle.clone())?;
        let _ = attach_desktop_channel(&app, &runtime_id, DesktopChannel::headless(app.clone()));
        self.persist_state_best_effort();

        self.append_lifecycle_event(
            &app,
            &runtime_id,
            "spawned",
            format!("Claude subprocess started with pid {}", pid),
        );

        self.spawn_stdout_reader(app.clone(), runtime_id.clone(), stdout);
        self.spawn_stderr_reader(app.clone(), runtime_id.clone(), stderr);
        self.spawn_waiter(app.clone(), runtime_id.clone(), child);
        if let Some(permission_bridge) = build.permission_bridge {
            self.spawn_permission_request_watcher(
                app.clone(),
                runtime_id.clone(),
                permission_bridge,
            );
        }

        if let Some(initial_prompt) = options.initial_prompt.as_ref() {
            self.send_user_message(&app, &runtime_id, initial_prompt)?;
        }

        self.summary(&runtime_id)
            .ok_or_else(|| format!("Managed session {} disappeared after startup", runtime_id))
    }

    pub fn list_sessions(&self) -> Vec<ManagedSessionSummary> {
        let handles = self
            .sessions
            .lock()
            .map(|sessions| sessions.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        let mut summaries = handles
            .into_iter()
            .map(|handle| summary_from_handle(&handle))
            .collect::<Vec<_>>();
        summaries.sort_by_key(|summary| std::cmp::Reverse(summary.created_at));
        summaries
    }

    pub fn summary(&self, runtime_id: &str) -> Option<ManagedSessionSummary> {
        self.get_handle(runtime_id)
            .ok()
            .map(|handle| summary_from_handle(&handle))
    }

    pub fn send_user_message(
        &self,
        app: &AppHandle,
        runtime_id: &str,
        text: &str,
    ) -> Result<(), String> {
        let handle = self.get_handle(runtime_id)?;
        if !handle.alive.load(Ordering::SeqCst) {
            return Err(format!(
                "Managed session {} is no longer active",
                runtime_id
            ));
        }

        let message = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [
                    { "type": "text", "text": text }
                ]
            }
        });

        {
            let mut stdin_guard = handle
                .stdin
                .lock()
                .map_err(|_| "Failed to lock managed session stdin".to_string())?;
            let stdin = stdin_guard
                .as_mut()
                .ok_or_else(|| format!("Managed session {} stdin is closed", runtime_id))?;

            let payload = serde_json::to_string(&message)
                .map_err(|error| format!("Failed to encode Claude input: {}", error))?;
            stdin
                .write_all(payload.as_bytes())
                .and_then(|_| stdin.write_all(b"\n"))
                .and_then(|_| stdin.flush())
                .map_err(|error| format!("Failed to write to Claude stdin: {}", error))?;
        }

        self.set_state(runtime_id, ManagedSessionStatus::Processing);
        self.append_lifecycle_event(app, runtime_id, "input_sent", summarize_user_input(text));
        Ok(())
    }

    pub fn replay_events(
        &self,
        runtime_id: &str,
        since_seq: Option<u64>,
    ) -> Result<ReplayBatch, String> {
        let handle = self.get_handle(runtime_id)?;
        let events = handle
            .events
            .lock()
            .map_err(|_| "Failed to lock managed session events".to_string())?;
        Ok(events.events_since(since_seq))
    }

    pub fn stop_session(&self, app: &AppHandle, runtime_id: &str) -> Result<(), String> {
        let handle = self.get_handle(runtime_id)?;
        let pid = handle
            .record
            .lock()
            .map_err(|_| "Failed to lock managed session record".to_string())?
            .pid
            .ok_or_else(|| format!("Managed session {} has no active pid", runtime_id))?;

        {
            let mut stdin_guard = handle
                .stdin
                .lock()
                .map_err(|_| "Failed to lock managed session stdin".to_string())?;
            *stdin_guard = None;
        }

        self.set_state(runtime_id, ManagedSessionStatus::Stopped);
        self.append_lifecycle_event(
            app,
            runtime_id,
            "stop_requested",
            format!("Sending SIGTERM to pid {}", pid),
        );
        kill_process(pid)?;
        Ok(())
    }

    pub fn remove_session(&self, runtime_id: &str) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "Failed to lock runtime manager session map".to_string())?;

        let can_remove = sessions
            .get(runtime_id)
            .map(|handle| {
                !handle.alive.load(Ordering::SeqCst)
                    || matches!(
                        handle.record.lock().ok().map(|record| record.state.clone()),
                        Some(ManagedSessionStatus::Stopped)
                            | Some(ManagedSessionStatus::Completed)
                            | Some(ManagedSessionStatus::Error { .. })
                    )
            })
            .ok_or_else(|| format!("Managed session not found: {}", runtime_id))?;

        if !can_remove {
            return Err(format!(
                "Managed session {} is still active and cannot be removed",
                runtime_id
            ));
        }

        let bridge_dir = sessions.get(runtime_id).and_then(|handle| {
            handle
                .permission_bridge
                .as_ref()
                .map(|bridge| bridge.bridge_dir.clone())
        });
        sessions.remove(runtime_id);
        drop(sessions);
        self.clear_pending_permissions_for_runtime(runtime_id);
        if let Some(bridge_dir) = bridge_dir {
            let _ = fs::remove_dir_all(bridge_dir);
        }
        self.persist_state_best_effort();
        Ok(())
    }

    pub fn respond_to_permission(
        &self,
        app: &AppHandle,
        request_id: &str,
        approved: bool,
        responder: &str,
    ) -> Result<(), String> {
        let pending = {
            let mut pending_permissions = self
                .pending_permissions
                .lock()
                .map_err(|_| "Failed to lock pending permission requests".to_string())?;
            pending_permissions.remove(request_id)
        }
        .or_else(|| {
            recover_pending_permission_from_disk(request_id)
                .ok()
                .flatten()
        })
        .ok_or_else(|| format!("Permission request not found: {}", request_id))?;

        write_permission_prompt_response(
            &pending.bridge,
            request_id,
            PermissionPromptResponseFile {
                behavior: if approved {
                    "allow".to_string()
                } else {
                    "deny".to_string()
                },
                updated_input: None,
                message: None,
            },
        )?;

        self.set_state(&pending.runtime_id, ManagedSessionStatus::Processing);
        let _ = self.append_event(
            app,
            &pending.runtime_id,
            SessionEventPayload::PermissionResponded {
                request_id: request_id.to_string(),
                tool_use_id: None,
                approved,
                responder: responder.to_string(),
            },
        );
        Ok(())
    }

    pub fn respond_to_permission_for_runtime(
        &self,
        app: &AppHandle,
        runtime_id: &str,
        approved: bool,
        responder: &str,
    ) -> Result<(), String> {
        let request_id = self
            .pending_permissions
            .lock()
            .map_err(|_| "Failed to lock pending permission requests".to_string())?
            .iter()
            .find_map(|(request_id, pending)| {
                (pending.runtime_id == runtime_id).then(|| request_id.clone())
            })
            .ok_or_else(|| format!("No pending permission request found for {}", runtime_id))?;

        self.respond_to_permission(app, &request_id, approved, responder)
    }

    pub fn shutdown_all(&self) {
        let handles = self
            .sessions
            .lock()
            .map(|sessions| sessions.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();

        for handle in handles {
            let runtime_id = handle
                .record
                .lock()
                .ok()
                .map(|record| record.runtime_id.clone());
            let pid = {
                let mut stdin_guard = match handle.stdin.lock() {
                    Ok(guard) => guard,
                    Err(_) => continue,
                };
                *stdin_guard = None;

                let mut record = match handle.record.lock() {
                    Ok(record) => record,
                    Err(_) => continue,
                };
                record.state = ManagedSessionStatus::Stopped;
                record.pid
            };

            handle.alive.store(false, Ordering::SeqCst);

            if let Some(pid) = pid {
                let _ = terminate_process(pid);
            }

            if let Some(runtime_id) = runtime_id.as_deref() {
                self.clear_pending_permissions_for_runtime(runtime_id);
            }
            if let Some(bridge) = handle.permission_bridge.as_ref() {
                let _ = fs::remove_dir_all(&bridge.bridge_dir);
            }
        }

        let _ = replace_runtime_entries_for_kind(
            &runtime_state_file_path(),
            RuntimeKind::Headless,
            Vec::new(),
        );
    }

    pub fn snapshot_state(&self) -> RuntimeStateFile {
        RuntimeStateFile {
            sessions: self.active_state_entries(),
            ..RuntimeStateFile::default()
        }
    }

    pub fn active_state_entries(&self) -> Vec<RuntimeStateEntry> {
        let sessions = self
            .sessions
            .lock()
            .map(|sessions| {
                sessions
                    .values()
                    .filter(|handle| handle.alive.load(Ordering::SeqCst))
                    .map(|handle| {
                        let record = handle.record.lock().unwrap().clone();
                        RuntimeStateEntry {
                            runtime_id: record.runtime_id,
                            runtime_kind: RuntimeKind::Headless,
                            claude_session_id: record.claude_session_id,
                            pid: record.pid,
                            project_dir: record.project_dir,
                            env_name: record.env_name,
                            perm_mode: record.perm_mode,
                            source: record.source,
                            saved_at: Utc::now(),
                            summary: None,
                            tmux_session: None,
                            tmux_window: None,
                            tmux_window_index: None,
                            jsonl_path: None,
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        sessions
    }

    #[allow(dead_code)]
    pub fn persist_default_state(&self) -> io::Result<()> {
        replace_runtime_entries_for_kind(
            &runtime_state_file_path(),
            RuntimeKind::Headless,
            self.active_state_entries(),
        )
    }

    fn insert_handle(
        &self,
        runtime_id: String,
        handle: Arc<ManagedSessionHandle>,
    ) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "Failed to lock runtime manager session map".to_string())?;
        sessions.insert(runtime_id, handle);
        Ok(())
    }

    fn get_handle(&self, runtime_id: &str) -> Result<Arc<ManagedSessionHandle>, String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "Failed to lock runtime manager session map".to_string())?;
        sessions
            .get(runtime_id)
            .cloned()
            .ok_or_else(|| format!("Managed session not found: {}", runtime_id))
    }

    fn set_state(&self, runtime_id: &str, state: ManagedSessionStatus) {
        if let Ok(handle) = self.get_handle(runtime_id) {
            if let Ok(mut record) = handle.record.lock() {
                record.state = state;
            }
            self.persist_state_best_effort();
        }
    }

    fn update_claude_session_id(&self, runtime_id: &str, claude_session_id: String) {
        if let Ok(handle) = self.get_handle(runtime_id) {
            if let Ok(mut record) = handle.record.lock() {
                record.claude_session_id = Some(claude_session_id.clone());
            }
            if let Err(error) = bind_source_session_id("claude", runtime_id, &claude_session_id) {
                eprintln!(
                    "Failed to bind headless Claude provenance for {}: {}",
                    runtime_id, error
                );
            }
            self.persist_state_best_effort();
        }
    }

    fn append_event(
        &self,
        app: &AppHandle,
        runtime_id: &str,
        payload: SessionEventPayload,
    ) -> Option<()> {
        let handle = self.get_handle(runtime_id).ok()?;
        let record = {
            let mut events = handle.events.lock().ok()?;
            events.append(payload)
        };
        if let Ok(session) = handle.record.lock() {
            notifications::maybe_notify_session_event(
                app,
                &NotificationContext::new(
                    session.env_name.clone(),
                    session.project_dir.clone(),
                    "Claude",
                ),
                &record.payload,
            );
        }
        dispatch_session_event(app, runtime_id, &record);
        Some(())
    }

    fn append_lifecycle_event(
        &self,
        app: &AppHandle,
        runtime_id: &str,
        stage: impl Into<String>,
        detail: impl Into<String>,
    ) {
        let _ = self.append_event(
            app,
            runtime_id,
            SessionEventPayload::Lifecycle {
                stage: stage.into(),
                detail: detail.into(),
            },
        );
    }

    fn spawn_permission_request_watcher(
        self: &Arc<Self>,
        app: AppHandle,
        runtime_id: String,
        bridge: PermissionPromptBridge,
    ) {
        let manager = Arc::clone(self);
        thread::spawn(move || {
            let mut seen_requests = HashSet::new();

            while manager
                .get_handle(&runtime_id)
                .ok()
                .is_some_and(|handle| handle.alive.load(Ordering::SeqCst))
            {
                let request_files = match list_permission_request_files(&bridge) {
                    Ok(files) => files,
                    Err(error) => {
                        manager.append_lifecycle_event(
                            &app,
                            &runtime_id,
                            "permission_bridge_error",
                            error,
                        );
                        thread::sleep(std::time::Duration::from_millis(
                            PERMISSION_BRIDGE_REQUEST_POLL_MS,
                        ));
                        continue;
                    }
                };

                for path in request_files {
                    let request_id = match permission_request_id_from_path(&path) {
                        Some(request_id) => request_id,
                        None => continue,
                    };

                    if seen_requests.contains(&request_id) {
                        continue;
                    }

                    match read_permission_prompt_request(&path) {
                        Ok(request) => {
                            seen_requests.insert(request.request_id.clone());
                            manager.register_permission_request(
                                &app,
                                &runtime_id,
                                bridge.clone(),
                                request,
                            );
                        }
                        Err(error) => {
                            manager.append_lifecycle_event(
                                &app,
                                &runtime_id,
                                "permission_bridge_error",
                                format!("Failed to read permission request: {}", error),
                            );
                        }
                    }
                }

                thread::sleep(std::time::Duration::from_millis(
                    PERMISSION_BRIDGE_REQUEST_POLL_MS,
                ));
            }
        });
    }

    fn register_permission_request(
        &self,
        app: &AppHandle,
        runtime_id: &str,
        bridge: PermissionPromptBridge,
        request: PermissionPromptRequestFile,
    ) {
        let inserted = if let Ok(mut pending_permissions) = self.pending_permissions.lock() {
            if pending_permissions.contains_key(&request.request_id) {
                false
            } else {
                pending_permissions.insert(
                    request.request_id.clone(),
                    PendingPermissionRequest {
                        runtime_id: runtime_id.to_string(),
                        bridge,
                    },
                );
                true
            }
        } else {
            self.append_lifecycle_event(
                app,
                runtime_id,
                "permission_bridge_error",
                "Failed to lock pending permission requests",
            );
            false
        };

        if inserted {
            self.set_state(
                runtime_id,
                ManagedSessionStatus::WaitingPermission {
                    request_id: request.request_id.clone(),
                    tool_name: request.tool_name.clone(),
                },
            );
            let _ = self.append_event(
                app,
                runtime_id,
                SessionEventPayload::PermissionRequired {
                    request_id: request.request_id,
                    tool_use_id: None,
                    tool_name: request.tool_name,
                    input_summary: None,
                    background_task_id: None,
                },
            );
        }
    }

    fn clear_pending_permissions_for_runtime(&self, runtime_id: &str) {
        if let Ok(mut pending_permissions) = self.pending_permissions.lock() {
            pending_permissions.retain(|_, pending| pending.runtime_id != runtime_id);
        }
    }

    fn spawn_stdout_reader(
        self: &Arc<Self>,
        app: AppHandle,
        runtime_id: String,
        stdout: ChildStdout,
    ) {
        let manager = Arc::clone(self);
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(line) if !line.trim().is_empty() => {
                        manager.handle_stdout_line(&app, &runtime_id, &line);
                    }
                    Ok(_) => {}
                    Err(error) => {
                        manager.append_lifecycle_event(
                            &app,
                            &runtime_id,
                            "stdout_error",
                            error.to_string(),
                        );
                        break;
                    }
                }
            }
        });
    }

    fn spawn_stderr_reader(
        self: &Arc<Self>,
        app: AppHandle,
        runtime_id: String,
        stderr: ChildStderr,
    ) {
        let manager = Arc::clone(self);
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(line) if !line.trim().is_empty() => {
                        let _ = manager.append_event(
                            &app,
                            &runtime_id,
                            SessionEventPayload::StdErrLine { line },
                        );
                    }
                    Ok(_) => {}
                    Err(error) => {
                        manager.append_lifecycle_event(
                            &app,
                            &runtime_id,
                            "stderr_error",
                            error.to_string(),
                        );
                        break;
                    }
                }
            }
        });
    }

    fn spawn_waiter(self: &Arc<Self>, app: AppHandle, runtime_id: String, mut child: Child) {
        let manager = Arc::clone(self);
        thread::spawn(move || {
            let exit_result = child.wait();
            match exit_result {
                Ok(status) => {
                    manager.handle_process_exit(&app, &runtime_id, status.code(), status.success());
                }
                Err(error) => {
                    manager.handle_process_failure(&app, &runtime_id, error.to_string());
                }
            }
        });
    }

    fn handle_stdout_line(&self, app: &AppHandle, runtime_id: &str, line: &str) {
        let parsed = serde_json::from_str::<Value>(line).ok();
        let message_type = parsed
            .as_ref()
            .and_then(|value| value.get("type"))
            .and_then(Value::as_str)
            .map(ToString::to_string);

        if let Some(value) = parsed.as_ref() {
            self.apply_protocol_state(runtime_id, value);
            for payload in extract_protocol_events(value) {
                let _ = self.append_event(app, runtime_id, payload);
            }
        }

        let _ = self.append_event(
            app,
            runtime_id,
            SessionEventPayload::ClaudeJson {
                message_type,
                raw_json: line.to_string(),
            },
        );
    }

    fn apply_protocol_state(&self, runtime_id: &str, value: &Value) {
        let message_type = value.get("type").and_then(Value::as_str);

        match message_type {
            Some("system") if value.get("subtype").and_then(Value::as_str) == Some("init") => {
                if let Some(session_id) = value.get("session_id").and_then(Value::as_str) {
                    self.update_claude_session_id(runtime_id, session_id.to_string());
                }
                self.set_state(runtime_id, ManagedSessionStatus::Ready);
            }
            Some("assistant") => {
                self.set_state(runtime_id, ManagedSessionStatus::Ready);
            }
            Some("content_block_delta") => {
                self.set_state(runtime_id, ManagedSessionStatus::Processing);
            }
            Some("result") => {
                if value
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    let message = value
                        .get("result")
                        .and_then(Value::as_str)
                        .unwrap_or("Claude returned an error result")
                        .to_string();
                    self.set_state(runtime_id, ManagedSessionStatus::Error { message });
                } else {
                    self.set_state(runtime_id, ManagedSessionStatus::Ready);
                }
            }
            Some("error") => {
                let message = value
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Unknown Claude stream error")
                    .to_string();
                self.set_state(runtime_id, ManagedSessionStatus::Error { message });
            }
            _ => {}
        }
    }

    fn handle_process_exit(
        &self,
        app: &AppHandle,
        runtime_id: &str,
        exit_code: Option<i32>,
        success: bool,
    ) {
        if let Ok(handle) = self.get_handle(runtime_id) {
            handle.alive.store(false, Ordering::SeqCst);
            if let Ok(mut stdin_guard) = handle.stdin.lock() {
                *stdin_guard = None;
            }
        }

        let next_state = match self.current_state(runtime_id) {
            Some(ManagedSessionStatus::Stopped) => ManagedSessionStatus::Stopped,
            Some(ManagedSessionStatus::Error { message }) => {
                ManagedSessionStatus::Error { message }
            }
            _ if success => ManagedSessionStatus::Completed,
            _ => ManagedSessionStatus::Error {
                message: format!(
                    "Claude exited with code {}",
                    exit_code
                        .map(|value| value.to_string())
                        .unwrap_or_else(|| "unknown".to_string())
                ),
            },
        };

        self.set_state(runtime_id, next_state.clone());
        let reason = match next_state {
            ManagedSessionStatus::Completed => "completed".to_string(),
            ManagedSessionStatus::Stopped => "stopped".to_string(),
            ManagedSessionStatus::Error { message } => message,
            _ => "finished".to_string(),
        };
        let _ = self.append_event(
            app,
            runtime_id,
            SessionEventPayload::SessionCompleted { reason },
        );
        self.clear_pending_permissions_for_runtime(runtime_id);
        if let Ok(handle) = self.get_handle(runtime_id) {
            if let Some(bridge) = handle.permission_bridge.as_ref() {
                let _ = fs::remove_dir_all(&bridge.bridge_dir);
            }
        }
        self.persist_state_best_effort();
    }

    fn handle_process_failure(&self, app: &AppHandle, runtime_id: &str, message: String) {
        if let Ok(handle) = self.get_handle(runtime_id) {
            handle.alive.store(false, Ordering::SeqCst);
            if let Some(bridge) = handle.permission_bridge.as_ref() {
                let _ = fs::remove_dir_all(&bridge.bridge_dir);
            }
        }
        self.set_state(
            runtime_id,
            ManagedSessionStatus::Error {
                message: message.clone(),
            },
        );
        self.clear_pending_permissions_for_runtime(runtime_id);
        self.append_lifecycle_event(app, runtime_id, "process_failure", message);
        self.persist_state_best_effort();
    }

    fn current_state(&self, runtime_id: &str) -> Option<ManagedSessionStatus> {
        self.get_handle(runtime_id)
            .ok()
            .and_then(|handle| handle.record.lock().ok().map(|record| record.state.clone()))
    }

    fn persist_state_best_effort(&self) {
        if let Err(error) = self.persist_default_state() {
            eprintln!("Failed to persist runtime state: {}", error);
        }
    }
}

fn attach_desktop_channel(
    app: &AppHandle,
    runtime_id: &str,
    channel: DesktopChannel,
) -> Result<(), String> {
    let dispatcher = app.state::<Arc<EventDispatcher>>().inner().clone();
    dispatcher.attach_channel(runtime_id.to_string(), Arc::new(channel))
}

fn dispatch_session_event(
    app: &AppHandle,
    runtime_id: &str,
    record: &crate::event_bus::SessionEventRecord,
) {
    let dispatcher = app.state::<Arc<EventDispatcher>>().inner().clone();
    dispatcher.dispatch_event(runtime_id, record);
}

fn build_claude_command(
    options: &ManagedSessionOptions,
    runtime_id: &str,
) -> Result<BuildClaudeCommandResult, String> {
    let claude_binary = resolve_claude_path().unwrap_or_else(|| "claude".to_string());
    let mut command = Command::new(&claude_binary);
    let permission_mode = official_permission_mode(&options.perm_mode);
    let permission_bridge = if permission_mode == "bypassPermissions" {
        None
    } else {
        Some(prepare_permission_prompt_bridge(runtime_id)?)
    };
    let mut allowed_tools = options.allowed_tools.clone();
    if permission_bridge.is_some()
        && !allowed_tools
            .iter()
            .any(|tool| tool == CCEM_PERMISSION_MCP_TOOL_NAME)
    {
        allowed_tools.push(CCEM_PERMISSION_MCP_TOOL_NAME.to_string());
    }

    // `stream-json` is only available in print/headless mode.
    command.args([
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--replay-user-messages",
    ]);

    command.args(build_permission_args(&options.perm_mode));

    if let Some(max_budget_usd) = options.max_budget_usd {
        command.args(["--max-budget-usd", &format!("{max_budget_usd:.2}")]);
    }

    if !allowed_tools.is_empty() {
        command.arg("--allowedTools");
        command.args(&allowed_tools);
    }

    if !options.disallowed_tools.is_empty() {
        command.arg("--disallowedTools");
        command.args(&options.disallowed_tools);
    }

    if let Some(resume_session_id) = options.resume_session_id.as_ref() {
        command.args(["--resume", resume_session_id]);
    }

    if let Some(bridge) = permission_bridge.as_ref() {
        command.args([
            "--mcp-config",
            bridge
                .mcp_config_path
                .to_str()
                .ok_or_else(|| "Permission bridge config path is not valid UTF-8".to_string())?,
        ]);
        command.args(["--permission-prompt-tool", CCEM_PERMISSION_MCP_TOOL_NAME]);
    }

    command
        .env("PATH", get_user_path())
        .env("CCEM_RUNTIME_ID", runtime_id)
        .env("CCEM_SESSION_ID", runtime_id)
        .env_remove("CLAUDECODE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .current_dir(&options.working_dir);

    config::clear_managed_claude_env(&mut command);
    for (key, value) in &options.env_vars {
        command.env(key, value);
    }

    Ok(BuildClaudeCommandResult {
        command,
        permission_bridge,
    })
}

fn build_permission_args(mode_name: &str) -> Vec<String> {
    vec![
        "--permission-mode".to_string(),
        official_permission_mode(mode_name).to_string(),
    ]
}

fn official_permission_mode(mode_name: &str) -> &str {
    match mode_name {
        "yolo" => "bypassPermissions",
        "dev" => "acceptEdits",
        "readonly" | "audit" => "plan",
        "safe" | "ci" => "default",
        "acceptEdits" | "bypassPermissions" | "default" | "dontAsk" | "plan" | "auto" => mode_name,
        _ => "acceptEdits",
    }
}

fn get_user_path() -> &'static str {
    USER_PATH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        match Command::new(&shell)
            .args(["-li", "-c", "echo $PATH"])
            .output()
        {
            Ok(output) if output.status.success() => {
                String::from_utf8_lossy(&output.stdout).trim().to_string()
            }
            _ => std::env::var("PATH").unwrap_or_default(),
        }
    })
}

fn generate_runtime_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("headless-{}", nanos)
}

fn summarize_user_input(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return "(empty input)".to_string();
    }

    let mut summary = trimmed.replace('\n', " ");
    if summary.len() > 120 {
        summary.truncate(120);
        summary.push_str("...");
    }
    summary
}

fn ensure_permission_mcp_server_script() -> Result<PathBuf, String> {
    let script_dir = ccem_runtime_tools_dir();
    fs::create_dir_all(&script_dir)
        .map_err(|error| format!("Failed to create runtime tools dir: {}", error))?;

    let script_path = script_dir.join("ccem-permission-mcp-server.mjs");
    let should_write = match fs::read_to_string(&script_path) {
        Ok(existing) => existing != PERMISSION_MCP_SERVER_SOURCE,
        Err(error) if error.kind() == ErrorKind::NotFound => true,
        Err(error) => {
            return Err(format!(
                "Failed to read permission MCP server script: {}",
                error
            ))
        }
    };

    if should_write {
        fs::write(&script_path, PERMISSION_MCP_SERVER_SOURCE)
            .map_err(|error| format!("Failed to write permission MCP server script: {}", error))?;
    }

    Ok(script_path)
}

fn prepare_permission_prompt_bridge(runtime_id: &str) -> Result<PermissionPromptBridge, String> {
    let script_path = ensure_permission_mcp_server_script()?;
    let bridge_dir = permission_bridge_root_dir().join(runtime_id);
    let requests_dir = bridge_dir.join("requests");
    let responses_dir = bridge_dir.join("responses");
    fs::create_dir_all(&requests_dir)
        .map_err(|error| format!("Failed to create permission request dir: {}", error))?;
    fs::create_dir_all(&responses_dir)
        .map_err(|error| format!("Failed to create permission response dir: {}", error))?;

    let config_path = bridge_dir.join("mcp-config.json");
    let mut server_config = serde_json::json!({
        "type": "stdio",
        "command": "node",
        "args": [
            script_path.to_string_lossy().to_string(),
            "--bridge-dir",
            bridge_dir.to_string_lossy().to_string(),
            "--timeout-secs",
            PERMISSION_BRIDGE_RESPONSE_TIMEOUT_SECS.to_string()
        ]
    });

    if cfg!(debug_assertions) {
        // Development builds keep the MCP bridge log so protocol mismatches are observable.
        server_config["env"] = serde_json::json!({
            "CCEM_PERMISSION_MCP_DEBUG": "1",
        });
    }

    let config = serde_json::json!({
        "mcpServers": {
            CCEM_PERMISSION_MCP_SERVER_NAME: server_config
        }
    });
    fs::write(
        &config_path,
        serde_json::to_string_pretty(&config)
            .map_err(|error| format!("Failed to encode MCP config: {}", error))?,
    )
    .map_err(|error| format!("Failed to write MCP config: {}", error))?;

    Ok(PermissionPromptBridge {
        bridge_dir,
        requests_dir,
        responses_dir,
        mcp_config_path: config_path,
    })
}

fn permission_bridge_root_dir() -> PathBuf {
    if cfg!(test) {
        return std::env::temp_dir().join("ccem-runtime-permission-bridges");
    }
    dirs::home_dir()
        .map(|home| home.join(".ccem/runtime-permission-bridges"))
        .unwrap_or_else(|| PathBuf::from(".ccem/runtime-permission-bridges"))
}

fn ccem_runtime_tools_dir() -> PathBuf {
    if cfg!(test) {
        return std::env::temp_dir().join("ccem-runtime-tools");
    }
    dirs::home_dir()
        .map(|home| home.join(".ccem/runtime-tools"))
        .unwrap_or_else(|| PathBuf::from(".ccem/runtime-tools"))
}

fn list_permission_request_files(bridge: &PermissionPromptBridge) -> Result<Vec<PathBuf>, String> {
    let mut files = fs::read_dir(&bridge.requests_dir)
        .map_err(|error| format!("Failed to read permission request dir: {}", error))?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect::<Vec<_>>();
    files.sort();
    Ok(files)
}

fn permission_request_id_from_path(path: &Path) -> Option<String> {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .map(ToString::to_string)
}

fn read_permission_prompt_request(path: &Path) -> Result<PermissionPromptRequestFile, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read permission prompt request file: {}", error))?;
    serde_json::from_str(&content)
        .map_err(|error| format!("Failed to parse permission prompt request file: {}", error))
}

fn write_permission_prompt_response(
    bridge: &PermissionPromptBridge,
    request_id: &str,
    response: PermissionPromptResponseFile,
) -> Result<(), String> {
    let response_path = bridge.responses_dir.join(format!("{request_id}.json"));
    let payload = serde_json::to_string_pretty(&response)
        .map_err(|error| format!("Failed to encode permission response: {}", error))?;
    fs::write(response_path, payload)
        .map_err(|error| format!("Failed to write permission response: {}", error))
}

fn recover_pending_permission_from_disk(
    request_id: &str,
) -> Result<Option<PendingPermissionRequest>, String> {
    let bridge_root = permission_bridge_root_dir();
    let entries = match fs::read_dir(&bridge_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Failed to read permission bridge root dir: {}",
                error
            ))
        }
    };

    for entry in entries {
        let path = match entry {
            Ok(entry) => entry.path(),
            Err(_) => continue,
        };
        if !path.is_dir() {
            continue;
        }

        let request_path = path.join("requests").join(format!("{request_id}.json"));
        if !request_path.is_file() {
            continue;
        }

        let Some(runtime_id) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };

        return Ok(Some(PendingPermissionRequest {
            runtime_id: runtime_id.to_string(),
            bridge: PermissionPromptBridge {
                bridge_dir: path.clone(),
                requests_dir: path.join("requests"),
                responses_dir: path.join("responses"),
                mcp_config_path: path.join("mcp-config.json"),
            },
        }));
    }

    Ok(None)
}

fn extract_protocol_events(value: &Value) -> Vec<SessionEventPayload> {
    let message_type = value.get("type").and_then(Value::as_str);
    match message_type {
        Some("content_block_delta") => value
            .get("delta")
            .and_then(|delta| delta.get("text"))
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(|text| {
                vec![SessionEventPayload::AssistantChunk {
                    text: text.to_string(),
                }]
            })
            .unwrap_or_default(),
        Some("assistant") => extract_text_blocks(value)
            .into_iter()
            .map(|text| SessionEventPayload::AssistantChunk { text })
            .collect(),
        Some("system") if value.get("subtype").and_then(Value::as_str) == Some("init") => {
            let session_id = value
                .get("session_id")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            vec![SessionEventPayload::SystemMessage {
                message: format!("Claude session initialized ({session_id})"),
            }]
        }
        _ => Vec::new(),
    }
}

fn extract_text_blocks(value: &Value) -> Vec<String> {
    value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
        .map(|content| {
            content
                .iter()
                .filter_map(|block| {
                    if block.get("type").and_then(Value::as_str) != Some("text") {
                        return None;
                    }
                    block
                        .get("text")
                        .and_then(Value::as_str)
                        .filter(|text| !text.is_empty())
                        .map(ToString::to_string)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn status_name(status: &ManagedSessionStatus) -> &'static str {
    match status {
        ManagedSessionStatus::Initializing => "initializing",
        ManagedSessionStatus::Ready => "ready",
        ManagedSessionStatus::Processing => "processing",
        ManagedSessionStatus::WaitingPermission { .. } => "waiting_permission",
        ManagedSessionStatus::Completed => "completed",
        ManagedSessionStatus::Stopped => "stopped",
        ManagedSessionStatus::Error { .. } => "error",
    }
}

fn summary_from_handle(handle: &Arc<ManagedSessionHandle>) -> ManagedSessionSummary {
    let record = handle.record.lock().unwrap().clone();
    let last_event_seq = handle
        .events
        .lock()
        .ok()
        .and_then(|events| events.newest_seq());

    ManagedSessionSummary {
        runtime_id: record.runtime_id,
        claude_session_id: record.claude_session_id,
        pid: record.pid,
        project_dir: record.project_dir,
        env_name: record.env_name,
        perm_mode: record.perm_mode,
        source: record.source,
        status: status_name(&record.state).to_string(),
        created_at: record.created_at,
        is_active: handle.alive.load(Ordering::SeqCst),
        last_event_seq,
    }
}

fn kill_process(pid: u32) -> Result<(), String> {
    let status = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status()
        .map_err(|error| format!("Failed to invoke kill for pid {}: {}", pid, error))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("kill -TERM {} exited with status {}", pid, status))
    }
}

#[allow(dead_code)]
pub fn runtime_state_file_path() -> PathBuf {
    dirs::home_dir()
        .map(|home| home.join(".ccem/runtime-state.json"))
        .unwrap_or_else(|| PathBuf::from(".ccem/runtime-state.json"))
}

#[allow(dead_code)]
pub fn read_runtime_state() -> io::Result<RuntimeStateFile> {
    read_runtime_state_from(&runtime_state_file_path())
}

pub fn read_runtime_state_from(path: &Path) -> io::Result<RuntimeStateFile> {
    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content)
            .map_err(|error| io::Error::new(ErrorKind::InvalidData, error)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(RuntimeStateFile::default()),
        Err(error) => Err(error),
    }
}

#[allow(dead_code)]
pub fn write_runtime_state(state: &RuntimeStateFile) -> io::Result<()> {
    write_runtime_state_to(&runtime_state_file_path(), state)
}

pub fn write_runtime_state_to(path: &Path, state: &RuntimeStateFile) -> io::Result<()> {
    let json = serde_json::to_string_pretty(state)
        .map_err(|error| io::Error::new(ErrorKind::InvalidData, error))?;
    write_private_atomic(path, json.as_bytes())
}

pub fn replace_runtime_entries_for_kind(
    path: &Path,
    runtime_kind: RuntimeKind,
    entries: Vec<RuntimeStateEntry>,
) -> io::Result<()> {
    let mut state = read_runtime_state_from(path)?;
    state
        .sessions
        .retain(|entry| entry.runtime_kind != runtime_kind);
    state.sessions.extend(entries);
    state.sessions.sort_by(|left, right| {
        right
            .saved_at
            .cmp(&left.saved_at)
            .then_with(|| left.runtime_id.cmp(&right.runtime_id))
    });
    write_runtime_state_to(path, &state)
}

#[allow(dead_code)]
pub fn list_runtime_recovery_candidates() -> io::Result<Vec<RuntimeRecoveryCandidate>> {
    list_runtime_recovery_candidates_from(&runtime_state_file_path())
}

pub fn list_runtime_recovery_candidates_from(
    path: &Path,
) -> io::Result<Vec<RuntimeRecoveryCandidate>> {
    let state = read_runtime_state_from(path)?;
    let mut candidates = state
        .sessions
        .into_iter()
        .filter(|entry| entry.summary.is_none())
        .filter_map(|entry| {
            let claude_session_id = entry
                .claude_session_id
                .as_ref()
                .map(|session_id| session_id.trim())
                .filter(|session_id| !session_id.is_empty())?
                .to_string();

            Some(RuntimeRecoveryCandidate {
                runtime_id: entry.runtime_id,
                runtime_kind: entry.runtime_kind,
                claude_session_id,
                project_dir: entry.project_dir,
                env_name: entry.env_name,
                perm_mode: entry.perm_mode,
                source: entry.source,
                saved_at: entry.saved_at,
            })
        })
        .collect::<Vec<_>>();

    candidates.sort_by(|left, right| {
        right
            .saved_at
            .cmp(&left.saved_at)
            .then_with(|| left.runtime_id.cmp(&right.runtime_id))
    });
    Ok(candidates)
}

#[allow(dead_code)]
pub fn dismiss_runtime_recovery_candidate(runtime_id: &str) -> io::Result<()> {
    dismiss_runtime_recovery_candidate_from(&runtime_state_file_path(), runtime_id)
}

pub fn dismiss_runtime_recovery_candidate_from(path: &Path, runtime_id: &str) -> io::Result<()> {
    let mut state = read_runtime_state_from(path)?;
    state
        .sessions
        .retain(|entry| entry.runtime_id != runtime_id);
    write_runtime_state_to(path, &state)
}

#[allow(dead_code)]
pub fn clear_runtime_recovery_candidates_by_claude_session_id(
    claude_session_id: &str,
) -> io::Result<()> {
    clear_runtime_recovery_candidates_by_claude_session_id_from(
        &runtime_state_file_path(),
        claude_session_id,
    )
}

pub fn clear_runtime_recovery_candidates_by_claude_session_id_from(
    path: &Path,
    claude_session_id: &str,
) -> io::Result<()> {
    let trimmed = claude_session_id.trim();
    if trimmed.is_empty() {
        return Ok(());
    }

    let mut state = read_runtime_state_from(path)?;
    state.sessions.retain(|entry| {
        entry
            .claude_session_id
            .as_deref()
            .map(str::trim)
            .map(|session_id| session_id != trimmed)
            .unwrap_or(true)
    });
    write_runtime_state_to(path, &state)
}

#[allow(dead_code)]
pub fn cleanup_orphaned_runtime_processes() -> io::Result<RuntimeStateFile> {
    cleanup_orphaned_runtime_processes_from(&runtime_state_file_path())
}

pub fn cleanup_orphaned_runtime_processes_from(path: &Path) -> io::Result<RuntimeStateFile> {
    let state = read_runtime_state_from(path)?;
    let mut preserved_sessions = Vec::new();

    for entry in state.sessions {
        if let Some(pid) = entry.pid {
            let process_alive = process_exists(pid);
            let command_line = read_process_command_line(pid);
            let command_matches = command_line
                .as_deref()
                .map(|command| runtime_command_matches(entry.runtime_kind, command))
                .unwrap_or(false);

            if process_alive && command_matches {
                let _ = terminate_process(pid);
            }
        }

        if let Some(claude_session_id) = entry.claude_session_id.clone() {
            preserved_sessions.push(RuntimeStateEntry {
                pid: None,
                saved_at: Utc::now(),
                claude_session_id: Some(claude_session_id),
                ..entry
            });
        }
    }

    let updated = RuntimeStateFile {
        sessions: preserved_sessions,
        ..RuntimeStateFile::default()
    };
    write_runtime_state_to(path, &updated)?;
    Ok(updated)
}

fn process_exists(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn read_process_command_line(pid: u32) -> Option<String> {
    let output = Command::new("ps")
        .args(["-o", "command=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let command = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if command.is_empty() {
        None
    } else {
        Some(command)
    }
}

fn runtime_command_matches(runtime_kind: RuntimeKind, command_line: &str) -> bool {
    let normalized = command_line.to_ascii_lowercase();
    match runtime_kind {
        RuntimeKind::Interactive => normalized.contains("claude"),
        RuntimeKind::Headless => normalized.contains("claude") && normalized.contains("-p"),
    }
}

fn terminate_process(pid: u32) -> Result<(), String> {
    send_signal(pid, "TERM")?;

    for _ in 0..50 {
        if !process_exists(pid) {
            return Ok(());
        }
        thread::sleep(std::time::Duration::from_millis(100));
    }

    send_signal(pid, "KILL")
}

fn send_signal(pid: u32, signal: &str) -> Result<(), String> {
    let status = Command::new("kill")
        .args([format!("-{}", signal).as_str(), &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| {
            format!(
                "Failed to invoke kill -{} for pid {}: {}",
                signal, pid, error
            )
        })?;

    if status.success() || !process_exists(pid) {
        Ok(())
    } else {
        Err(format!(
            "kill -{} {} exited with status {}",
            signal, pid, status
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_claude_command, build_permission_args,
        clear_runtime_recovery_candidates_by_claude_session_id_from,
        dismiss_runtime_recovery_candidate_from, extract_protocol_events,
        list_runtime_recovery_candidates_from, permission_bridge_root_dir, read_runtime_state_from,
        recover_pending_permission_from_disk, replace_runtime_entries_for_kind, status_name,
        write_runtime_state_to, ManagedSessionOptions, ManagedSessionRecord, ManagedSessionSource,
        ManagedSessionStatus, RuntimeKind, RuntimeManager, RuntimeRecoveryCandidate,
        RuntimeStateEntry, RuntimeStateFile,
    };
    use crate::remote::RemotePlatform;
    use chrono::Utc;
    use serde_json::json;
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_temp_file() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        let counter = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "ccem-runtime-tests-{}-{nanos}-{counter}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&dir);
        dir.join("state.json")
    }

    #[test]
    fn runtime_state_roundtrips_on_disk() {
        let path = unique_temp_file();
        let now = Utc::now();
        let state = RuntimeStateFile {
            sessions: vec![RuntimeStateEntry {
                runtime_id: "runtime-1".to_string(),
                runtime_kind: RuntimeKind::Headless,
                claude_session_id: Some("claude-1".to_string()),
                pid: Some(12345),
                project_dir: "/tmp/project".to_string(),
                env_name: "official".to_string(),
                perm_mode: "default".to_string(),
                source: ManagedSessionSource::Desktop,
                saved_at: now,
                summary: None,
                tmux_session: None,
                tmux_window: None,
                tmux_window_index: None,
                jsonl_path: None,
            }],
            ..RuntimeStateFile::default()
        };

        write_runtime_state_to(&path, &state).expect("write runtime state");
        let restored = read_runtime_state_from(&path).expect("read runtime state");

        assert_eq!(restored, state);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn replace_runtime_entries_preserves_other_runtime_kind() {
        let path = unique_temp_file();
        let now = Utc::now();

        write_runtime_state_to(
            &path,
            &RuntimeStateFile {
                sessions: vec![
                    RuntimeStateEntry {
                        runtime_id: "interactive-1".to_string(),
                        runtime_kind: RuntimeKind::Interactive,
                        claude_session_id: None,
                        pid: Some(100),
                        project_dir: "/tmp/interactive".to_string(),
                        env_name: "glm".to_string(),
                        perm_mode: "dev".to_string(),
                        source: ManagedSessionSource::Desktop,
                        saved_at: now,
                        summary: None,
                        tmux_session: None,
                        tmux_window: None,
                        tmux_window_index: None,
                        jsonl_path: None,
                    },
                    RuntimeStateEntry {
                        runtime_id: "headless-1".to_string(),
                        runtime_kind: RuntimeKind::Headless,
                        claude_session_id: Some("claude-headless".to_string()),
                        pid: Some(200),
                        project_dir: "/tmp/headless".to_string(),
                        env_name: "glm".to_string(),
                        perm_mode: "default".to_string(),
                        source: ManagedSessionSource::Desktop,
                        saved_at: now,
                        summary: None,
                        tmux_session: None,
                        tmux_window: None,
                        tmux_window_index: None,
                        jsonl_path: None,
                    },
                ],
                ..RuntimeStateFile::default()
            },
        )
        .expect("seed runtime state");

        replace_runtime_entries_for_kind(
            &path,
            RuntimeKind::Interactive,
            vec![RuntimeStateEntry {
                runtime_id: "interactive-2".to_string(),
                runtime_kind: RuntimeKind::Interactive,
                claude_session_id: Some("claude-interactive".to_string()),
                pid: Some(300),
                project_dir: "/tmp/interactive-2".to_string(),
                env_name: "glm".to_string(),
                perm_mode: "dev".to_string(),
                source: ManagedSessionSource::Desktop,
                saved_at: now,
                summary: None,
                tmux_session: None,
                tmux_window: None,
                tmux_window_index: None,
                jsonl_path: None,
            }],
        )
        .expect("replace runtime kind entries");

        let restored = read_runtime_state_from(&path).expect("read merged runtime state");
        assert_eq!(restored.sessions.len(), 2);
        assert!(restored
            .sessions
            .iter()
            .any(|entry| entry.runtime_id == "interactive-2"
                && entry.runtime_kind == RuntimeKind::Interactive));
        assert!(restored
            .sessions
            .iter()
            .any(|entry| entry.runtime_id == "headless-1"
                && entry.runtime_kind == RuntimeKind::Headless));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn recovery_candidates_only_include_resumeable_entries() {
        let path = unique_temp_file();
        let now = Utc::now();

        write_runtime_state_to(
            &path,
            &RuntimeStateFile {
                sessions: vec![
                    RuntimeStateEntry {
                        runtime_id: "interactive-resume".to_string(),
                        runtime_kind: RuntimeKind::Interactive,
                        claude_session_id: Some("claude-interactive".to_string()),
                        pid: None,
                        project_dir: "/tmp/interactive".to_string(),
                        env_name: "glm".to_string(),
                        perm_mode: "dev".to_string(),
                        source: ManagedSessionSource::Desktop,
                        saved_at: now,
                        summary: None,
                        tmux_session: None,
                        tmux_window: None,
                        tmux_window_index: None,
                        jsonl_path: None,
                    },
                    RuntimeStateEntry {
                        runtime_id: "headless-summary".to_string(),
                        runtime_kind: RuntimeKind::Headless,
                        claude_session_id: Some("claude-summary".to_string()),
                        pid: None,
                        project_dir: "/tmp/headless".to_string(),
                        env_name: "glm".to_string(),
                        perm_mode: "default".to_string(),
                        source: ManagedSessionSource::Desktop,
                        saved_at: now,
                        summary: Some(super::CompactedSummary {
                            total_events: 5,
                            last_event_seq: Some(4),
                            outcome: "completed".to_string(),
                            finished_at: now,
                        }),
                        tmux_session: None,
                        tmux_window: None,
                        tmux_window_index: None,
                        jsonl_path: None,
                    },
                    RuntimeStateEntry {
                        runtime_id: "missing-session-id".to_string(),
                        runtime_kind: RuntimeKind::Headless,
                        claude_session_id: None,
                        pid: None,
                        project_dir: "/tmp/missing".to_string(),
                        env_name: "glm".to_string(),
                        perm_mode: "default".to_string(),
                        source: ManagedSessionSource::Desktop,
                        saved_at: now,
                        summary: None,
                        tmux_session: None,
                        tmux_window: None,
                        tmux_window_index: None,
                        jsonl_path: None,
                    },
                ],
                ..RuntimeStateFile::default()
            },
        )
        .expect("seed runtime state");

        let candidates =
            list_runtime_recovery_candidates_from(&path).expect("list runtime recovery candidates");
        assert_eq!(
            candidates,
            vec![RuntimeRecoveryCandidate {
                runtime_id: "interactive-resume".to_string(),
                runtime_kind: RuntimeKind::Interactive,
                claude_session_id: "claude-interactive".to_string(),
                project_dir: "/tmp/interactive".to_string(),
                env_name: "glm".to_string(),
                perm_mode: "dev".to_string(),
                source: ManagedSessionSource::Desktop,
                saved_at: now,
            }]
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn dismiss_runtime_recovery_candidate_removes_only_target_entry() {
        let path = unique_temp_file();
        let now = Utc::now();

        write_runtime_state_to(
            &path,
            &RuntimeStateFile {
                sessions: vec![
                    RuntimeStateEntry {
                        runtime_id: "interactive-1".to_string(),
                        runtime_kind: RuntimeKind::Interactive,
                        claude_session_id: Some("claude-1".to_string()),
                        pid: None,
                        project_dir: "/tmp/interactive-1".to_string(),
                        env_name: "glm".to_string(),
                        perm_mode: "dev".to_string(),
                        source: ManagedSessionSource::Desktop,
                        saved_at: now,
                        summary: None,
                        tmux_session: None,
                        tmux_window: None,
                        tmux_window_index: None,
                        jsonl_path: None,
                    },
                    RuntimeStateEntry {
                        runtime_id: "headless-1".to_string(),
                        runtime_kind: RuntimeKind::Headless,
                        claude_session_id: Some("claude-2".to_string()),
                        pid: None,
                        project_dir: "/tmp/headless-1".to_string(),
                        env_name: "glm".to_string(),
                        perm_mode: "default".to_string(),
                        source: ManagedSessionSource::Desktop,
                        saved_at: now,
                        summary: None,
                        tmux_session: None,
                        tmux_window: None,
                        tmux_window_index: None,
                        jsonl_path: None,
                    },
                ],
                ..RuntimeStateFile::default()
            },
        )
        .expect("seed runtime state");

        dismiss_runtime_recovery_candidate_from(&path, "interactive-1")
            .expect("dismiss recovery candidate");

        let restored = read_runtime_state_from(&path).expect("read runtime state");
        assert_eq!(restored.sessions.len(), 1);
        assert_eq!(restored.sessions[0].runtime_id, "headless-1");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn clear_runtime_recovery_candidates_by_session_id_removes_matching_entries() {
        let path = unique_temp_file();
        let now = Utc::now();

        write_runtime_state_to(
            &path,
            &RuntimeStateFile {
                sessions: vec![
                    RuntimeStateEntry {
                        runtime_id: "interactive-1".to_string(),
                        runtime_kind: RuntimeKind::Interactive,
                        claude_session_id: Some("shared-session".to_string()),
                        pid: None,
                        project_dir: "/tmp/interactive-1".to_string(),
                        env_name: "glm".to_string(),
                        perm_mode: "dev".to_string(),
                        source: ManagedSessionSource::Desktop,
                        saved_at: now,
                        summary: None,
                        tmux_session: None,
                        tmux_window: None,
                        tmux_window_index: None,
                        jsonl_path: None,
                    },
                    RuntimeStateEntry {
                        runtime_id: "headless-1".to_string(),
                        runtime_kind: RuntimeKind::Headless,
                        claude_session_id: Some("shared-session".to_string()),
                        pid: None,
                        project_dir: "/tmp/headless-1".to_string(),
                        env_name: "glm".to_string(),
                        perm_mode: "default".to_string(),
                        source: ManagedSessionSource::Desktop,
                        saved_at: now,
                        summary: None,
                        tmux_session: None,
                        tmux_window: None,
                        tmux_window_index: None,
                        jsonl_path: None,
                    },
                    RuntimeStateEntry {
                        runtime_id: "headless-2".to_string(),
                        runtime_kind: RuntimeKind::Headless,
                        claude_session_id: Some("other-session".to_string()),
                        pid: None,
                        project_dir: "/tmp/headless-2".to_string(),
                        env_name: "glm".to_string(),
                        perm_mode: "default".to_string(),
                        source: ManagedSessionSource::Desktop,
                        saved_at: now,
                        summary: None,
                        tmux_session: None,
                        tmux_window: None,
                        tmux_window_index: None,
                        jsonl_path: None,
                    },
                ],
                ..RuntimeStateFile::default()
            },
        )
        .expect("seed runtime state");

        clear_runtime_recovery_candidates_by_claude_session_id_from(&path, "shared-session")
            .expect("clear matching recovery candidates");

        let restored = read_runtime_state_from(&path).expect("read runtime state");
        assert_eq!(restored.sessions.len(), 1);
        assert_eq!(restored.sessions[0].runtime_id, "headless-2");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn extract_protocol_events_reads_text_delta_chunks() {
        let value = json!({
            "type": "content_block_delta",
            "delta": {
                "text": "hello from delta"
            }
        });

        let events = extract_protocol_events(&value);
        assert_eq!(events.len(), 1);
        assert!(matches!(
            &events[0],
            crate::event_bus::SessionEventPayload::AssistantChunk { text } if text == "hello from delta"
        ));
    }

    #[test]
    fn extract_protocol_events_reads_assistant_text_blocks() {
        let value = json!({
            "type": "assistant",
            "message": {
                "content": [
                    { "type": "text", "text": "first block" },
                    { "type": "tool_use", "id": "tool-1" },
                    { "type": "text", "text": "second block" }
                ]
            }
        });

        let events = extract_protocol_events(&value);
        assert_eq!(events.len(), 2);
        assert!(matches!(
            &events[0],
            crate::event_bus::SessionEventPayload::AssistantChunk { text } if text == "first block"
        ));
        assert!(matches!(
            &events[1],
            crate::event_bus::SessionEventPayload::AssistantChunk { text } if text == "second block"
        ));
    }

    #[test]
    fn runtime_manager_snapshot_includes_registered_sessions() {
        let manager = Arc::new(RuntimeManager::default());
        let created_at = Utc::now();
        let handle = super::ManagedSessionHandle {
            record: std::sync::Mutex::new(ManagedSessionRecord {
                runtime_id: "runtime-2".to_string(),
                claude_session_id: Some("claude-2".to_string()),
                pid: Some(54321),
                project_dir: "/tmp/worktree".to_string(),
                env_name: "production".to_string(),
                perm_mode: "default".to_string(),
                source: ManagedSessionSource::Telegram {
                    chat_id: -100123,
                    thread_id: 42,
                },
                state: ManagedSessionStatus::Initializing,
                created_at,
            }),
            stdin: std::sync::Mutex::new(None),
            events: std::sync::Mutex::new(crate::event_bus::SessionStore::new("runtime-2")),
            permission_bridge: None,
            alive: AtomicBool::new(true),
        };

        manager
            .insert_handle("runtime-2".to_string(), Arc::new(handle))
            .expect("insert handle");

        let snapshot = manager.snapshot_state();
        let sessions = manager.list_sessions();

        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(snapshot.sessions[0].runtime_id, "runtime-2");
        assert_eq!(snapshot.sessions[0].pid, Some(54321));
        assert_eq!(sessions[0].status, "initializing");
        assert!(sessions[0].is_active);
    }

    #[test]
    fn managed_session_source_remote_helpers_cover_supported_platforms() {
        let telegram = ManagedSessionSource::Telegram {
            chat_id: -100123,
            thread_id: 42,
        };
        let weixin = ManagedSessionSource::Weixin {
            peer_id: "wx-peer-1".to_string(),
        };
        let wecom = ManagedSessionSource::Wecom {
            bot_id: "aibot-1".to_string(),
            peer_id: "chat-1".to_string(),
        };

        let telegram_remote = telegram.remote_peer_ref().expect("telegram remote ref");
        assert_eq!(telegram_remote.platform, RemotePlatform::Telegram);
        assert_eq!(telegram_remote.peer_id, "-100123");
        assert_eq!(telegram_remote.thread_id.as_deref(), Some("42"));
        assert!(telegram.matches_remote_peer(RemotePlatform::Telegram, "-100123", Some("42")));
        assert!(!telegram.matches_remote_peer(RemotePlatform::Weixin, "-100123", Some("42")));

        let weixin_remote = weixin.remote_peer_ref().expect("weixin remote ref");
        assert_eq!(weixin_remote.platform, RemotePlatform::Weixin);
        assert_eq!(weixin_remote.peer_id, "wx-peer-1");
        assert_eq!(weixin_remote.thread_id, None);
        assert!(weixin.matches_remote_peer(RemotePlatform::Weixin, "wx-peer-1", None));
        assert!(!weixin.matches_remote_peer(RemotePlatform::Telegram, "wx-peer-1", None));

        let wecom_remote = wecom.remote_peer_ref().expect("wecom remote ref");
        assert_eq!(wecom_remote.platform, RemotePlatform::Wecom);
        assert_eq!(wecom_remote.peer_id, "chat-1");
        assert_eq!(wecom_remote.thread_id.as_deref(), Some("aibot-1"));
        assert!(wecom.matches_remote_peer(RemotePlatform::Wecom, "chat-1", Some("aibot-1")));
    }

    #[test]
    fn remove_session_rejects_active_runtime() {
        let manager = Arc::new(RuntimeManager::default());
        let handle = super::ManagedSessionHandle {
            record: std::sync::Mutex::new(ManagedSessionRecord {
                runtime_id: "runtime-active".to_string(),
                claude_session_id: Some("claude-active".to_string()),
                pid: Some(54321),
                project_dir: "/tmp/worktree".to_string(),
                env_name: "production".to_string(),
                perm_mode: "default".to_string(),
                source: ManagedSessionSource::Desktop,
                state: ManagedSessionStatus::Processing,
                created_at: Utc::now(),
            }),
            stdin: std::sync::Mutex::new(None),
            events: std::sync::Mutex::new(crate::event_bus::SessionStore::new("runtime-active")),
            permission_bridge: None,
            alive: AtomicBool::new(true),
        };

        manager
            .insert_handle("runtime-active".to_string(), Arc::new(handle))
            .expect("insert handle");

        let error = manager
            .remove_session("runtime-active")
            .expect_err("active session should not be removable");
        assert!(error.contains("still active"));
    }

    #[test]
    fn remove_session_allows_terminal_runtime() {
        let manager = Arc::new(RuntimeManager::default());
        let handle = super::ManagedSessionHandle {
            record: std::sync::Mutex::new(ManagedSessionRecord {
                runtime_id: "runtime-done".to_string(),
                claude_session_id: Some("claude-done".to_string()),
                pid: Some(54321),
                project_dir: "/tmp/worktree".to_string(),
                env_name: "production".to_string(),
                perm_mode: "default".to_string(),
                source: ManagedSessionSource::Desktop,
                state: ManagedSessionStatus::Completed,
                created_at: Utc::now(),
            }),
            stdin: std::sync::Mutex::new(None),
            events: std::sync::Mutex::new(crate::event_bus::SessionStore::new("runtime-done")),
            permission_bridge: None,
            alive: AtomicBool::new(false),
        };

        manager
            .insert_handle("runtime-done".to_string(), Arc::new(handle))
            .expect("insert handle");

        manager
            .remove_session("runtime-done")
            .expect("terminal session should be removable");
        assert!(manager.list_sessions().is_empty());
    }

    #[test]
    fn permission_mode_translation_matches_runtime_expectations() {
        assert_eq!(
            build_permission_args("dev"),
            vec!["--permission-mode", "acceptEdits"]
        );
        assert_eq!(
            build_permission_args("readonly"),
            vec!["--permission-mode", "plan"]
        );
        assert_eq!(
            build_permission_args("yolo"),
            vec!["--permission-mode", "bypassPermissions"]
        );
        assert_eq!(
            build_permission_args("safe"),
            vec!["--permission-mode", "default"]
        );
    }

    #[test]
    fn build_claude_command_includes_budget_and_tool_policy_flags() {
        let options = ManagedSessionOptions {
            env_name: "glm".to_string(),
            perm_mode: "default".to_string(),
            working_dir: "/tmp".to_string(),
            resume_session_id: None,
            initial_prompt: None,
            max_budget_usd: Some(1.5),
            allowed_tools: vec!["Read".to_string(), "Grep".to_string()],
            disallowed_tools: vec!["WebSearch".to_string()],
            env_vars: HashMap::new(),
            source: ManagedSessionSource::Desktop,
        };

        let command = build_claude_command(&options, "runtime-test").expect("build command");
        let args = command
            .command
            .get_args()
            .map(|value| value.to_string_lossy().to_string())
            .collect::<Vec<_>>();

        assert!(args
            .windows(2)
            .any(|pair| pair == ["--max-budget-usd", "1.50"]));
        assert!(args.contains(&"--allowedTools".to_string()));
        assert!(args.contains(&"Read".to_string()));
        assert!(args.contains(&"Grep".to_string()));
        assert!(args.contains(&"--disallowedTools".to_string()));
        assert!(args.contains(&"WebSearch".to_string()));
    }

    #[test]
    fn build_claude_command_clears_omitted_managed_model_pins() {
        let mut env_vars = HashMap::new();
        env_vars.insert("ANTHROPIC_MODEL".to_string(), "opus".to_string());
        let options = ManagedSessionOptions {
            env_name: "official".to_string(),
            perm_mode: "default".to_string(),
            working_dir: "/tmp".to_string(),
            resume_session_id: None,
            initial_prompt: None,
            max_budget_usd: None,
            allowed_tools: Vec::new(),
            disallowed_tools: Vec::new(),
            env_vars,
            source: ManagedSessionSource::Desktop,
        };

        let command = build_claude_command(&options, "runtime-env-test")
            .expect("build Claude command")
            .command;
        let command_env = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|item| item.to_string_lossy().into_owned()),
                )
            })
            .collect::<HashMap<_, _>>();

        assert_eq!(command_env.get("ANTHROPIC_DEFAULT_OPUS_MODEL"), Some(&None));
        assert_eq!(
            command_env.get("ANTHROPIC_DEFAULT_SONNET_MODEL"),
            Some(&None)
        );
        assert_eq!(
            command_env.get("ANTHROPIC_MODEL"),
            Some(&Some("opus".to_string()))
        );
    }

    #[test]
    fn recover_pending_permission_from_disk_finds_request_file() {
        let bridge_root = permission_bridge_root_dir();
        let _ = fs::remove_dir_all(&bridge_root);

        let runtime_id = "headless-runtime-test";
        let requests_dir = bridge_root.join(runtime_id).join("requests");
        let responses_dir = bridge_root.join(runtime_id).join("responses");
        fs::create_dir_all(&requests_dir).expect("create requests dir");
        fs::create_dir_all(&responses_dir).expect("create responses dir");
        fs::write(requests_dir.join("req-123.json"), "{}").expect("write request file");

        let recovered = recover_pending_permission_from_disk("req-123")
            .expect("recover request")
            .expect("request should exist");
        assert_eq!(recovered.runtime_id, runtime_id);
        assert_eq!(recovered.bridge.requests_dir, requests_dir);
        assert_eq!(recovered.bridge.responses_dir, responses_dir);

        let _ = fs::remove_dir_all(&bridge_root);
    }

    #[test]
    fn status_names_are_stable_for_ui_consumers() {
        assert_eq!(status_name(&ManagedSessionStatus::Ready), "ready");
        assert_eq!(status_name(&ManagedSessionStatus::Stopped), "stopped");
        assert_eq!(
            status_name(&ManagedSessionStatus::Error {
                message: "boom".to_string()
            }),
            "error"
        );
    }
}
