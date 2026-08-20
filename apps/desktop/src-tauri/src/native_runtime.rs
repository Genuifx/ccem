use crate::browser::{authorize_browser_tool, BrowserManager, BrowserToolRequest};
use crate::config::{resolve_claude_env, resolve_codex_runtime};
use crate::event_bus::{
    NativeBackgroundTask, NativeBackgroundTaskStatus, ReplayBatch, SessionEventPayload,
    SessionPromptAnnotation, SessionPromptImage, SessionStore, TodoSnapshotV1,
};
use crate::native_event_log::NativeEventLog;
use crate::native_helper_resource::native_helper_script_path;
use crate::prompt_image_store::PromptImageStore;
use crate::router::{
    apply_session_router_patch, describe_router_environment, is_valid_router_environment_alias,
    validate_session_router_targets, LaunchAuthKind, LaunchTransport, RouterAuthCapability,
    RouterConfig, RouterEnvironmentAuthKind, RouterManager, RouterServiceError,
    SessionRouterRecord, SessionRouterState, SessionRouterUpdatedEvent, UpdateSessionRouterRequest,
    MY_DEFAULT_ROUTER_PROFILE_ID, OAUTH_ROUTING_VERIFIED,
};
use crate::secure_fs::write_private_atomic;
use crate::session_provenance::bind_source_session_id;
use crate::system_proxy::resolve_codex_proxy_env;
use crate::terminal::{self, resolve_claude_path, resolve_codex_path, TerminalType};
use crate::workspace_decorations::AttentionSummary;
use chrono::{DateTime, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use shared_child::SharedChild;
#[cfg(test)]
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command as StdCommand, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::Duration;
#[cfg(unix)]
use std::{os::unix::process::CommandExt, os::unix::process::ExitStatusExt};
#[cfg(windows)]
use std::{
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    ptr,
};
use tauri::async_runtime::{block_on, channel, Receiver, Sender};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::{
    process::{CommandEvent, TerminatedPayload},
    ShellExt,
};

const NATIVE_STOP_GRACE_PERIOD: Duration = Duration::from_secs(10);
const NATIVE_HELPER_RETIRING_ERROR: &str = "Native runtime helper is retiring";
const ACTIVE_BACKGROUND_TASK_SHUTDOWN_ERROR: &str = "Cannot close this native runtime while Claude background tasks remain active. Retry with force after confirming their results may be lost.";
const MAX_PROMPT_ANNOTATIONS: usize = 20;
const MAX_PROMPT_ANNOTATION_QUOTE_CHARS: usize = 12_000;
const MAX_PROMPT_ANNOTATION_NOTE_CHARS: usize = 4_000;
const MAX_PROMPT_ANNOTATION_TOTAL_CHARS: usize = 60_000;

fn is_background_task_shutdown_safety_error(message: &str) -> bool {
    message.starts_with("Cannot close this native runtime while ")
        && message.contains("Claude background task")
        && message.contains("Retry with force")
}

#[cfg(unix)]
fn unix_descendant_process_ids(root_pid: u32, process_table: &str) -> Vec<u32> {
    let mut children_by_parent = HashMap::<u32, Vec<u32>>::new();
    for line in process_table.lines() {
        let mut fields = line.split_whitespace();
        let Some(pid) = fields.next().and_then(|value| value.parse::<u32>().ok()) else {
            continue;
        };
        let Some(parent_pid) = fields.next().and_then(|value| value.parse::<u32>().ok()) else {
            continue;
        };
        if pid > 1 {
            children_by_parent.entry(parent_pid).or_default().push(pid);
        }
    }

    let mut descendants = Vec::new();
    let mut pending = vec![root_pid];
    while let Some(parent_pid) = pending.pop() {
        if let Some(children) = children_by_parent.get(&parent_pid) {
            for child_pid in children {
                descendants.push(*child_pid);
                pending.push(*child_pid);
            }
        }
    }
    descendants.reverse();
    descendants
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeProvider {
    Claude,
    Codex,
}

impl NativeProvider {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
}

fn app_termination_requires_idle_freeze(provider: NativeProvider) -> bool {
    provider == NativeProvider::Claude
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeTransport {
    NativeSdk,
    InteractiveTerminal,
    ExternalWeb,
    Headless,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NativeSessionRecord {
    pub runtime_id: String,
    pub provider: NativeProvider,
    pub transport: NativeTransport,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed_boundary_message_count: Option<u64>,
    pub project_dir: String,
    pub env_name: String,
    pub perm_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_perm_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_env_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_settings_request_id: Option<String>,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub is_active: bool,
    pub can_handoff_to_terminal: bool,
    #[serde(default, skip_serializing)]
    pub pending_handoff_terminal: Option<TerminalType>,
    #[serde(default, skip_serializing)]
    pub pending_handoff_allow_background_task_termination: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub router: Option<SessionRouterRecord>,
}

/// True while this app still owns the runtime's helper child process.
///
/// A COMPLETED terminal handoff (`status == "handoff"` plus inactive)
/// transfers the session to the external terminal, so the process is no
/// longer ours. A handoff that was only REQUESTED
/// (`pending_handoff_terminal` set) or that failed mid-flight still owns
/// the child and must be torn down on app exit.
pub(crate) fn runtime_child_is_owned(record: &NativeSessionRecord) -> bool {
    record.status != "handoff" || record.is_active
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NativeSessionSummary {
    pub runtime_id: String,
    pub provider: NativeProvider,
    pub transport: NativeTransport,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed_boundary_message_count: Option<u64>,
    pub project_dir: String,
    pub env_name: String,
    pub perm_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_perm_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_env_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_effort: Option<String>,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub is_active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_event_seq: Option<u64>,
    pub can_handoff_to_terminal: bool,
    #[serde(default)]
    pub background_tasks: Vec<NativeBackgroundTask>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub router: Option<SessionRouterState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeHandoffStatus {
    Opened,
    Pending,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NativeHandoffResult {
    pub status: NativeHandoffStatus,
}

#[derive(Debug, Clone)]
pub struct NativeTerminalHandoff {
    pub runtime_id: String,
    pub provider: NativeProvider,
    pub env_name: String,
    pub perm_mode: String,
    pub project_dir: String,
    pub resume_session_id: String,
    pub terminal: TerminalType,
    pub env_vars: HashMap<String, String>,
    pub allow_background_task_termination: bool,
    pub preparation_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NativeSessionOptions {
    pub provider: NativeProvider,
    pub env_name: String,
    pub perm_mode: String,
    pub runtime_perm_mode: Option<String>,
    pub working_dir: String,
    pub initial_prompt: Option<String>,
    pub display_prompt: Option<String>,
    pub initial_images: Option<Vec<PromptImage>>,
    pub initial_annotations: Option<Vec<SessionPromptAnnotation>>,
    pub provider_session_id: Option<String>,
    pub seed_boundary_message_count: Option<u64>,
    pub helper_env_vars: HashMap<String, String>,
    pub terminal_env_vars: HashMap<String, String>,
    pub claude_path: Option<String>,
    pub codex_path: Option<String>,
    pub codex_base_url: Option<String>,
    pub codex_api_key: Option<String>,
    pub effort: Option<String>,
    pub router_launch_draft: Option<RouterLaunchDraft>,
    pub router_record: Option<SessionRouterRecord>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct RouterLaunchDraft {
    pub bindings: HashMap<String, String>,
    pub allowed_envs: Vec<String>,
    pub source_profile_id: Option<String>,
    pub profile_revision: Option<u64>,
    pub dynamic_routing: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InteractivePromptAnnotation {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptImage {
    pub media_type: String,
    pub base64_data: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
}

fn prompt_images_for_event(
    images: Option<&Vec<PromptImage>>,
    prompt_image_store: &PromptImageStore,
) -> Result<Option<Vec<SessionPromptImage>>, String> {
    let Some(images) = images else {
        return Ok(None);
    };
    if images.is_empty() {
        return Ok(None);
    }

    let mut event_images = Vec::with_capacity(images.len());
    for image in images {
        let stored =
            prompt_image_store.store_base64_image(&image.media_type, &image.base64_data)?;
        event_images.push(SessionPromptImage {
            media_type: stored.media_type,
            base64_data: None,
            storage_path: Some(stored.storage_path),
            sha256: Some(stored.sha256),
            byte_size: Some(stored.byte_size),
            placeholder: image.placeholder.clone(),
        });
    }

    Ok(Some(event_images))
}

fn canonical_user_prompt_hash(
    text: &str,
    images: Option<&Vec<SessionPromptImage>>,
    annotations: Option<&Vec<SessionPromptAnnotation>>,
) -> Option<String> {
    if text.trim().is_empty()
        && images.map(|items| items.is_empty()).unwrap_or(true)
        && annotations.map(|items| items.is_empty()).unwrap_or(true)
    {
        return None;
    }

    let mut hasher = Sha256::new();
    hasher.update(b"ccem-user-prompt-v1\0");
    hasher.update(text.as_bytes());
    hasher.update(b"\0");
    if let Some(images) = images {
        for image in images {
            hasher.update(b"image\0");
            if let Some(sha256) = image.sha256.as_deref() {
                hasher.update(sha256.as_bytes());
            }
            hasher.update(b"\0");
        }
    }
    if let Some(annotations) = annotations {
        for annotation in annotations {
            hasher.update(b"annotation\0");
            hasher.update(annotation.quote.as_bytes());
            hasher.update(b"\0");
            hasher.update(annotation.note.as_bytes());
            hasher.update(b"\0");
        }
    }

    Some(hex::encode(hasher.finalize()))
}

fn validate_prompt_annotations(
    annotations: Option<&Vec<SessionPromptAnnotation>>,
) -> Result<Option<Vec<SessionPromptAnnotation>>, String> {
    let Some(annotations) = annotations else {
        return Ok(None);
    };
    if annotations.is_empty() {
        return Ok(None);
    }
    if annotations.len() > MAX_PROMPT_ANNOTATIONS {
        return Err(format!(
            "A prompt can include at most {MAX_PROMPT_ANNOTATIONS} annotations."
        ));
    }

    let mut total_chars = 0usize;
    let mut validated = Vec::with_capacity(annotations.len());
    for annotation in annotations {
        let quote = annotation.quote.trim();
        let note = annotation.note.trim();
        let quote_chars = quote.chars().count();
        let note_chars = note.chars().count();
        if quote.is_empty() || note.is_empty() {
            return Err("Prompt annotations require both selected text and a note.".to_string());
        }
        if quote_chars > MAX_PROMPT_ANNOTATION_QUOTE_CHARS {
            return Err(format!(
                "Prompt annotation selected text exceeds {MAX_PROMPT_ANNOTATION_QUOTE_CHARS} characters."
            ));
        }
        if note_chars > MAX_PROMPT_ANNOTATION_NOTE_CHARS {
            return Err(format!(
                "Prompt annotation note exceeds {MAX_PROMPT_ANNOTATION_NOTE_CHARS} characters."
            ));
        }
        total_chars = total_chars
            .checked_add(quote_chars + note_chars)
            .ok_or_else(|| "Prompt annotation size overflowed.".to_string())?;
        if total_chars > MAX_PROMPT_ANNOTATION_TOTAL_CHARS {
            return Err(format!(
                "Prompt annotations exceed {MAX_PROMPT_ANNOTATION_TOTAL_CHARS} total characters."
            ));
        }
        validated.push(SessionPromptAnnotation {
            quote: quote.to_string(),
            note: note.to_string(),
        });
    }

    Ok(Some(validated))
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum HelperInputCommand<'a> {
    Init {
        provider: &'a str,
        env_name: &'a str,
        perm_mode: &'a str,
        allow_dangerously_skip_permissions: bool,
        working_dir: &'a str,
        env_vars: &'a HashMap<String, String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        initial_prompt: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        initial_images: Option<&'a [PromptImage]>,
        #[serde(skip_serializing_if = "Option::is_none")]
        provider_session_id: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        claude_path: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        codex_path: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        codex_base_url: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        codex_api_key: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        effort: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        todo_snapshot_seed: Option<&'a TodoSnapshotV1>,
        #[serde(skip_serializing_if = "Option::is_none")]
        router: Option<&'a HelperRouterInit>,
    },
    Prompt {
        text: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        images: Option<&'a [PromptImage]>,
    },
    PermissionResponse {
        request_id: &'a str,
        approved: bool,
    },
    InteractivePromptResponse {
        tool_use_id: &'a str,
        prompt_type: &'a str,
        answers: &'a HashMap<String, String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        annotations: Option<&'a HashMap<String, InteractivePromptAnnotation>>,
    },
    UpdateSettings {
        request_id: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        env_name: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        perm_mode: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        env_vars: Option<&'a HashMap<String, String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        effort: Option<&'a str>,
        force_restart: bool,
    },
    RewindFiles {
        checkpoint_id: &'a str,
    },
    UsageQuery,
    BrowserToolResponse {
        request_id: &'a str,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<&'a Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<&'a str>,
    },
    InterruptTurn,
    PrepareStop {
        request_id: &'a str,
        require_idle: bool,
        force_background_tasks: bool,
        finalize: bool,
    },
    CancelPrepareStop {
        request_id: &'a str,
    },
    StopTask {
        task_id: &'a str,
        stop_request_id: &'a str,
    },
    Stop {
        force_background_tasks: bool,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HelperRouterInit {
    route_tag_nonce: String,
    dynamic_routing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    menu: Option<String>,
}

fn is_bypass_permission_mode(mode: &str) -> bool {
    matches!(mode, "yolo" | "bypassPermissions")
}

fn effective_native_perm_mode<'a>(
    perm_mode: &'a str,
    runtime_perm_mode: Option<&'a str>,
) -> &'a str {
    runtime_perm_mode.unwrap_or(perm_mode)
}

fn native_session_allows_dangerously_skip_permissions(options: &NativeSessionOptions) -> bool {
    options.provider == NativeProvider::Claude
        && (is_bypass_permission_mode(&options.perm_mode)
            || options
                .runtime_perm_mode
                .as_deref()
                .is_some_and(is_bypass_permission_mode))
}

fn authorize_browser_tool_for_record(
    record: &NativeSessionRecord,
    tool: &str,
) -> Result<(), String> {
    authorize_browser_tool(
        effective_native_perm_mode(
            record.perm_mode.as_str(),
            record.runtime_perm_mode.as_deref(),
        ),
        tool,
    )
}

fn native_status_allows_file_rewind(status: &str) -> bool {
    matches!(status, "idle" | "ready" | "interrupted" | "closed_idle")
}

fn native_status_allows_usage_query(status: &str) -> bool {
    matches!(
        status,
        "idle"
            | "ready"
            | "interrupted"
            | "closed_idle"
            | "initializing"
            | "processing"
            | "running"
    )
}

fn stage_runtime_settings_update(
    record: &mut NativeSessionRecord,
    env_name: Option<&str>,
    effort: Option<&str>,
    request_id: &str,
) {
    if env_name.is_none() && effort.is_none() {
        return;
    }
    match record.provider {
        NativeProvider::Claude => {
            if let Some(name) = env_name {
                record.pending_env_name = Some(name.to_string());
            }
            if let Some(next_effort) = effort {
                record.pending_effort = non_empty_error(next_effort);
            }
            record.pending_settings_request_id = Some(request_id.to_string());
        }
        NativeProvider::Codex => {
            if let Some(name) = env_name {
                record.env_name = name.to_string();
            }
            if let Some(next_effort) = effort {
                record.effort = non_empty_error(next_effort);
            }
            record.pending_env_name = None;
            record.pending_effort = None;
            record.pending_settings_request_id = None;
        }
    }
    record.updated_at = Utc::now();
}

fn apply_background_task_event(
    handle: &NativeSessionHandle,
    payload: &SessionEventPayload,
) -> Result<bool, String> {
    fn preserve_local_transition(
        current: &NativeBackgroundTask,
        incoming: &NativeBackgroundTask,
    ) -> bool {
        if current.status == NativeBackgroundTaskStatus::Settling {
            return true;
        }
        if current.status != NativeBackgroundTaskStatus::Stopping {
            return false;
        }
        if incoming.status == NativeBackgroundTaskStatus::Settling {
            return false;
        }
        !(incoming.stop_failed == Some(true)
            && incoming.stop_request_id.is_some()
            && incoming.stop_request_id == current.stop_request_id)
    }

    fn preserve_transition_fields(
        current: &NativeBackgroundTask,
        incoming: &NativeBackgroundTask,
    ) -> NativeBackgroundTask {
        let mut next = incoming.clone();
        next.status = current.status;
        next.stop_request_id = current.stop_request_id.clone();
        next.stop_failed = current.stop_failed;
        if current.status == NativeBackgroundTaskStatus::Stopping {
            next.error = current.error.clone();
        }
        next
    }

    match payload {
        SessionEventPayload::BackgroundTasksChanged { tasks } => {
            {
                let mut background_tool_ids = handle
                    .background_tool_use_ids
                    .lock()
                    .map_err(|_| "Failed to lock background tool use ids".to_string())?;
                for task in tasks {
                    if let Some(tool_use_id) = task.tool_use_id.as_ref() {
                        background_tool_ids.insert(tool_use_id.clone());
                    }
                }
            }
            let terminal_ids = handle
                .terminal_background_task_ids
                .lock()
                .map_err(|_| "Failed to lock terminal background task ids".to_string())?;
            let current_tasks = handle
                .background_tasks
                .lock()
                .map_err(|_| "Failed to lock native background tasks".to_string())?;
            let mut next_tasks = HashMap::new();
            let mut invalidated_stop_ids = Vec::new();
            for task in tasks {
                if task.status.is_terminal() || terminal_ids.contains(&task.task_id) {
                    continue;
                }
                let mut next = task.clone();
                if let Some(current) = current_tasks.get(&task.task_id) {
                    if current.status == NativeBackgroundTaskStatus::Stopping
                        && task.status == NativeBackgroundTaskStatus::Settling
                    {
                        next.stop_request_id = None;
                        next.stop_failed = None;
                        invalidated_stop_ids.push(task.task_id.clone());
                    } else if preserve_local_transition(current, task) {
                        next = preserve_transition_fields(current, task);
                    }
                }
                next_tasks.insert(next.task_id.clone(), next);
            }
            for (task_id, current) in current_tasks.iter() {
                if next_tasks.contains_key(task_id) || terminal_ids.contains(task_id) {
                    continue;
                }
                let mut missing = current.clone();
                if missing.status == NativeBackgroundTaskStatus::Stopping
                    || missing.stop_request_id.is_some()
                {
                    invalidated_stop_ids.push(task_id.clone());
                }
                missing.status = NativeBackgroundTaskStatus::Settling;
                missing.updated_at = Utc::now();
                missing.stop_request_id = None;
                missing.stop_failed = None;
                next_tasks.insert(task_id.clone(), missing);
            }
            drop(current_tasks);
            drop(terminal_ids);
            if !invalidated_stop_ids.is_empty() {
                let mut pending_stops = handle
                    .pending_background_task_stops
                    .lock()
                    .map_err(|_| "Failed to lock pending background task stops".to_string())?;
                for task_id in invalidated_stop_ids {
                    pending_stops.remove(&task_id);
                }
            }
            *handle
                .background_tasks
                .lock()
                .map_err(|_| "Failed to lock native background tasks".to_string())? = next_tasks;
            Ok(true)
        }
        SessionEventPayload::BackgroundTaskUpdated { task } => {
            let added_tool_correlation = if let Some(tool_use_id) = task.tool_use_id.as_ref() {
                handle
                    .background_tool_use_ids
                    .lock()
                    .map_err(|_| "Failed to lock background tool use ids".to_string())?
                    .insert(tool_use_id.clone())
            } else {
                false
            };
            let mut terminal_ids = handle
                .terminal_background_task_ids
                .lock()
                .map_err(|_| "Failed to lock terminal background task ids".to_string())?;
            let mut tasks = handle
                .background_tasks
                .lock()
                .map_err(|_| "Failed to lock native background tasks".to_string())?;
            if terminal_ids.contains(&task.task_id) {
                return Ok(added_tool_correlation);
            }
            if task.status.is_terminal() {
                terminal_ids.insert(task.task_id.clone());
                tasks.remove(&task.task_id);
                handle
                    .pending_background_task_stops
                    .lock()
                    .map_err(|_| "Failed to lock pending background task stops".to_string())?
                    .remove(&task.task_id);
                return Ok(true);
            }
            let mut next = task.clone();
            if let Some(current) = tasks.get(&task.task_id) {
                if preserve_local_transition(current, task) {
                    next = preserve_transition_fields(current, task);
                }
            }
            tasks.insert(next.task_id.clone(), next);
            if task.stop_failed == Some(true) {
                let mut pending_stops = handle
                    .pending_background_task_stops
                    .lock()
                    .map_err(|_| "Failed to lock pending background task stops".to_string())?;
                if pending_stops
                    .get(&task.task_id)
                    .is_some_and(|(request_id, _)| {
                        Some(request_id) == task.stop_request_id.as_ref()
                    })
                {
                    pending_stops.remove(&task.task_id);
                }
            }
            Ok(true)
        }
        SessionEventPayload::ToolUseCompleted { tool_use_id, .. } => {
            if !handle
                .background_tool_use_ids
                .lock()
                .map_err(|_| "Failed to lock background tool use ids".to_string())?
                .contains(tool_use_id)
            {
                return Ok(true);
            }
            Ok(handle
                .completed_background_tool_use_ids
                .lock()
                .map_err(|_| "Failed to lock completed background tool use ids".to_string())?
                .insert(tool_use_id.clone()))
        }
        _ => Ok(true),
    }
}

fn destroy_browser_session(app: Option<&AppHandle>, runtime_id: &str) {
    let Some(app) = app else {
        return;
    };
    let Some(browser) = app.try_state::<Arc<BrowserManager>>() else {
        return;
    };
    if let Err(error) = browser.close(app, Some(runtime_id)) {
        eprintln!(
            "Failed to destroy preview browser session {}: {}",
            runtime_id, error
        );
    }
}

fn notify_browser_policy_changed(app: &AppHandle, runtime_id: &str) {
    let Some(browser) = app.try_state::<Arc<BrowserManager>>() else {
        return;
    };
    if let Err(error) = browser.policy_changed(app, runtime_id) {
        eprintln!(
            "Failed to invalidate preview browser policy for {}: {}",
            runtime_id, error
        );
    }
}

fn helper_command_kind(command: &HelperInputCommand<'_>) -> &'static str {
    match command {
        HelperInputCommand::Init { .. } => "init",
        HelperInputCommand::Prompt { .. } => "prompt",
        HelperInputCommand::PermissionResponse { .. } => "permission_response",
        HelperInputCommand::InteractivePromptResponse { .. } => "interactive_prompt_response",
        HelperInputCommand::UpdateSettings { .. } => "update_settings",
        HelperInputCommand::RewindFiles { .. } => "rewind_files",
        HelperInputCommand::UsageQuery => "usage_query",
        HelperInputCommand::BrowserToolResponse { .. } => "browser_tool_response",
        HelperInputCommand::InterruptTurn => "interrupt_turn",
        HelperInputCommand::PrepareStop { .. } => "prepare_stop",
        HelperInputCommand::CancelPrepareStop { .. } => "cancel_prepare_stop",
        HelperInputCommand::StopTask { .. } => "stop_task",
        HelperInputCommand::Stop { .. } => "stop",
    }
}

const UNATTRIBUTED_STOP_SOURCE: &str = "unattributed";

fn normalize_stop_source(source: Option<&str>) -> String {
    let Some(source) = source.map(str::trim).filter(|source| !source.is_empty()) else {
        return UNATTRIBUTED_STOP_SOURCE.to_string();
    };

    let normalized: String = source
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | ':'))
        .take(80)
        .collect();

    if normalized.is_empty() {
        UNATTRIBUTED_STOP_SOURCE.to_string()
    } else {
        normalized
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum HelperOutputEvent {
    SessionMeta {
        provider_session_id: String,
    },
    Status {
        status: String,
        #[serde(default)]
        detail: Option<String>,
    },
    Event {
        payload: Value,
    },
    BrowserToolRequest {
        request_id: String,
        tool: String,
        #[serde(default)]
        args: Value,
    },
    TeardownPrepared {
        request_id: String,
        ready: bool,
        #[serde(default)]
        detail: Option<String>,
    },
    BackgroundTaskStopFailed {
        task_id: String,
        stop_request_id: String,
        error: String,
    },
}

#[derive(Debug)]
struct NativeHelperChild {
    inner: Arc<SharedChild>,
    stdin: Option<ChildStdin>,
    process_tree: Arc<NativeProcessTree>,
}

impl NativeHelperChild {
    fn pid(&self) -> u32 {
        self.inner.id()
    }

    fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.stdin
            .as_mut()
            .ok_or_else(|| "Native sidecar stdin is closed".to_string())?
            .write_all(bytes)
            .map_err(|error| error.to_string())
    }

    fn kill(mut self) -> Result<(), String> {
        self.stdin.take();
        let tree_result = self.process_tree.kill();
        let _ = self.inner.kill();
        tree_result
    }
}

impl Drop for NativeHelperChild {
    fn drop(&mut self) {
        self.stdin.take();
        let _ = self.process_tree.kill();
        let _ = self.inner.kill();
    }
}

#[cfg(unix)]
#[derive(Debug)]
struct NativeProcessTree {
    process_group_id: i32,
    terminated: Mutex<bool>,
}

fn terminate_process_tree_once(
    terminated: &Mutex<bool>,
    terminate: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let mut terminated = terminated
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if *terminated {
        return Ok(());
    }
    terminate()?;
    *terminated = true;
    Ok(())
}

#[cfg(unix)]
impl NativeProcessTree {
    fn attach(root_pid: u32) -> Result<Self, String> {
        let process_group_id = i32::try_from(root_pid)
            .ok()
            .filter(|pid| *pid > 1)
            .ok_or_else(|| format!("Invalid native helper pid {root_pid}"))?;
        // SAFETY: getpgid only inspects the child spawned immediately before this call.
        let actual_group = unsafe { libc::getpgid(process_group_id) };
        if actual_group == -1 {
            return Err(format!(
                "Failed to inspect native helper process group: {}",
                io::Error::last_os_error()
            ));
        }
        if actual_group != process_group_id {
            return Err(format!(
                "Native helper {root_pid} did not enter its dedicated process group"
            ));
        }
        Ok(Self {
            process_group_id,
            terminated: Mutex::new(false),
        })
    }

    fn kill(&self) -> Result<(), String> {
        terminate_process_tree_once(&self.terminated, || {
            if self.process_group_id <= 1 {
                return Err("Refusing to kill an invalid native helper process group".to_string());
            }
            // SAFETY: the negative PID targets only the dedicated group configured before exec.
            let result = unsafe { libc::kill(-self.process_group_id, libc::SIGKILL) };
            let error = io::Error::last_os_error();
            if result == 0 || error.raw_os_error() == Some(libc::ESRCH) {
                Ok(())
            } else {
                Err(format!(
                    "Failed to kill native helper process group {}: {error}",
                    self.process_group_id
                ))
            }
        })
    }
}

#[cfg(windows)]
#[derive(Debug)]
struct NativeProcessTree {
    job: OwnedHandle,
    terminated: Mutex<bool>,
}

#[cfg(windows)]
impl NativeProcessTree {
    fn attach(root_pid: u32) -> Result<Self, String> {
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        };

        // SAFETY: null attributes/name create a private job owned by this process.
        let raw_job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if raw_job.is_null() {
            return Err(format!(
                "Failed to create native helper job: {}",
                io::Error::last_os_error()
            ));
        }
        // SAFETY: raw_job is a new owned HANDLE returned by CreateJobObjectW.
        let job = unsafe { OwnedHandle::from_raw_handle(raw_job as _) };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: limits points to a correctly sized JOBOBJECT_EXTENDED_LIMIT_INFORMATION.
        let configured = unsafe {
            SetInformationJobObject(
                job.as_raw_handle() as _,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            )
        };
        if configured == 0 {
            return Err(format!(
                "Failed to configure native helper job: {}",
                io::Error::last_os_error()
            ));
        }

        // The native helper protocol does not launch provider work until Init is written, so the
        // root cannot create descendants before this assignment completes.
        // SAFETY: OpenProcess returns a separately owned handle for the freshly spawned root PID.
        let raw_process = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA | PROCESS_TERMINATE,
                0,
                root_pid,
            )
        };
        if raw_process.is_null() {
            return Err(format!(
                "Failed to open native helper process {root_pid}: {}",
                io::Error::last_os_error()
            ));
        }
        // SAFETY: raw_process is a new owned HANDLE returned by OpenProcess.
        let process = unsafe { OwnedHandle::from_raw_handle(raw_process as _) };
        // SAFETY: both handles are valid for the duration of this call.
        let assigned = unsafe {
            AssignProcessToJobObject(job.as_raw_handle() as _, process.as_raw_handle() as _)
        };
        if assigned == 0 {
            return Err(format!(
                "Failed to assign native helper {root_pid} to its job: {}",
                io::Error::last_os_error()
            ));
        }

        Ok(Self {
            job,
            terminated: Mutex::new(false),
        })
    }

    fn kill(&self) -> Result<(), String> {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;

        terminate_process_tree_once(&self.terminated, || {
            // SAFETY: the handle remains owned by self for the duration of this call.
            if unsafe { TerminateJobObject(self.job.as_raw_handle() as _, 1) } != 0 {
                Ok(())
            } else {
                Err(format!(
                    "Failed to terminate native helper job: {}",
                    io::Error::last_os_error()
                ))
            }
        })
    }
}

#[cfg(not(any(unix, windows)))]
#[derive(Debug)]
struct NativeProcessTree {
    terminated: Mutex<bool>,
}

#[cfg(not(any(unix, windows)))]
impl NativeProcessTree {
    fn attach(_root_pid: u32) -> Result<Self, String> {
        Ok(Self {
            terminated: Mutex::new(false),
        })
    }

    fn kill(&self) -> Result<(), String> {
        terminate_process_tree_once(&self.terminated, || Ok(()))
    }
}

fn spawn_native_helper_process(
    mut command: StdCommand,
) -> Result<(Receiver<CommandEvent>, NativeHelperChild), String> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_native_helper_command(&mut command);

    let child = Arc::new(
        SharedChild::spawn(&mut command)
            .map_err(|error| format!("Failed to spawn native runtime sidecar: {error}"))?,
    );
    let process_tree = match NativeProcessTree::attach(child.id()) {
        Ok(process_tree) => Arc::new(process_tree),
        Err(error) => {
            abort_unmanaged_native_helper(&child);
            return Err(error);
        }
    };

    let stdin = match child.take_stdin() {
        Some(stdin) => stdin,
        None => {
            abort_managed_native_helper(&child, &process_tree);
            return Err("Native sidecar stdin pipe is unavailable".to_string());
        }
    };
    let stdout = match child.take_stdout() {
        Some(stdout) => stdout,
        None => {
            abort_managed_native_helper(&child, &process_tree);
            return Err("Native sidecar stdout pipe is unavailable".to_string());
        }
    };
    let stderr = match child.take_stderr() {
        Some(stderr) => stderr,
        None => {
            abort_managed_native_helper(&child, &process_tree);
            return Err("Native sidecar stderr pipe is unavailable".to_string());
        }
    };

    let (sender, receiver) = channel(64);
    let drain_guard = Arc::new(RwLock::new(()));
    let (reader_ready, readers_started) = std::sync::mpsc::sync_channel(2);
    spawn_native_output_reader(
        stdout,
        sender.clone(),
        Arc::clone(&drain_guard),
        reader_ready.clone(),
        CommandEvent::Stdout,
    );
    spawn_native_output_reader(
        stderr,
        sender.clone(),
        Arc::clone(&drain_guard),
        reader_ready,
        CommandEvent::Stderr,
    );
    for _ in 0..2 {
        if readers_started.recv().is_err() {
            abort_managed_native_helper(&child, &process_tree);
            return Err("Native sidecar output reader failed to start".to_string());
        }
    }

    let wait_child = Arc::clone(&child);
    let wait_tree = Arc::clone(&process_tree);
    thread::spawn(move || {
        let wait_result = wait_child.wait();
        let cleanup_result = wait_tree.kill();
        let _drained = drain_guard
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let event = match (wait_result, cleanup_result) {
            (Ok(status), Ok(())) => CommandEvent::Terminated(TerminatedPayload {
                code: status.code(),
                signal: native_exit_signal(&status),
            }),
            (Err(wait_error), Ok(())) => CommandEvent::Error(format!(
                "Failed to wait for native runtime sidecar: {wait_error}"
            )),
            (Ok(_), Err(cleanup_error)) => CommandEvent::Error(cleanup_error),
            (Err(wait_error), Err(cleanup_error)) => CommandEvent::Error(format!(
                "Failed to wait for native runtime sidecar: {wait_error}; {cleanup_error}"
            )),
        };
        send_native_helper_event(&sender, event);
    });

    Ok((
        receiver,
        NativeHelperChild {
            inner: child,
            stdin: Some(stdin),
            process_tree,
        },
    ))
}

#[cfg(unix)]
fn configure_native_helper_command(command: &mut StdCommand) {
    command.process_group(0);
}

#[cfg(not(unix))]
fn configure_native_helper_command(_command: &mut StdCommand) {}

fn abort_unmanaged_native_helper(child: &SharedChild) {
    let _ = child.kill();
    let _ = child.wait();
}

fn abort_managed_native_helper(child: &SharedChild, process_tree: &NativeProcessTree) {
    let _ = process_tree.kill();
    let _ = child.kill();
    let _ = child.wait();
}

fn spawn_native_output_reader<R>(
    reader: R,
    sender: Sender<CommandEvent>,
    drain_guard: Arc<RwLock<()>>,
    ready: std::sync::mpsc::SyncSender<()>,
    wrap: fn(Vec<u8>) -> CommandEvent,
) where
    R: io::Read + Send + 'static,
{
    thread::spawn(move || {
        let _draining = drain_guard
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _ = ready.send(());
        let mut reader = BufReader::new(reader);
        loop {
            let mut bytes = Vec::new();
            match reader.read_until(b'\n', &mut bytes) {
                Ok(0) => break,
                Ok(_) => send_native_helper_event(&sender, wrap(bytes)),
                Err(error) => {
                    send_native_helper_event(&sender, CommandEvent::Error(error.to_string()));
                    break;
                }
            }
        }
    });
}

fn send_native_helper_event(sender: &Sender<CommandEvent>, event: CommandEvent) {
    let sender = sender.clone();
    let _ = block_on(async move { sender.send(event).await });
}

#[cfg(unix)]
fn native_exit_signal(status: &std::process::ExitStatus) -> Option<i32> {
    status.signal()
}

#[cfg(not(unix))]
fn native_exit_signal(_status: &std::process::ExitStatus) -> Option<i32> {
    None
}

#[cfg(all(test, unix))]
fn native_process_group_exists(process_group_id: i32) -> bool {
    if process_group_id <= 1 {
        return false;
    }
    // SAFETY: signal 0 only checks whether a member remains in the dedicated process group.
    let result = unsafe { libc::kill(-process_group_id, 0) };
    result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(all(test, unix))]
fn native_process_exists(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    if pid <= 1 {
        return false;
    }
    // SAFETY: signal 0 only checks whether the exact PID exists.
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

struct NativeSessionHandle {
    generation: u64,
    record: Mutex<NativeSessionRecord>,
    child: Mutex<Option<NativeHelperChild>>,
    events: Mutex<SessionStore>,
    background_tasks: Mutex<HashMap<String, NativeBackgroundTask>>,
    terminal_background_task_ids: Mutex<HashSet<String>>,
    background_tool_use_ids: Mutex<HashSet<String>>,
    completed_background_tool_use_ids: Mutex<HashSet<String>>,
    pending_background_task_stops: Mutex<HashMap<String, (String, NativeBackgroundTaskStatus)>>,
    teardown_preparations: Mutex<HashMap<String, Result<(), String>>>,
    helper_env_vars: HashMap<String, String>,
    terminal_env_vars: HashMap<String, String>,
    claude_path: Option<String>,
    codex_path: Option<String>,
    codex_base_url: Option<String>,
    codex_api_key: Option<String>,
    alive: AtomicBool,
}

impl NativeSessionHandle {
    fn summary(&self) -> NativeSessionSummary {
        let record = self
            .record
            .lock()
            .expect("native session record poisoned")
            .clone();
        let last_event_seq = self.events.lock().ok().and_then(|store| store.newest_seq());
        let mut background_tasks = self
            .background_tasks
            .lock()
            .map(|tasks| tasks.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        background_tasks.sort_by_key(|task| task.started_at);
        NativeSessionSummary {
            runtime_id: record.runtime_id,
            provider: record.provider,
            transport: record.transport,
            provider_session_id: record.provider_session_id,
            seed_boundary_message_count: record.seed_boundary_message_count,
            project_dir: record.project_dir,
            env_name: record.env_name,
            perm_mode: record.perm_mode,
            runtime_perm_mode: record.runtime_perm_mode,
            effort: record.effort,
            pending_env_name: record.pending_env_name,
            pending_effort: record.pending_effort,
            status: record.status,
            created_at: record.created_at,
            updated_at: record.updated_at,
            is_active: record.is_active,
            last_event_seq,
            can_handoff_to_terminal: record.can_handoff_to_terminal,
            background_tasks,
            last_error: record.last_error,
            router: record.router.as_ref().map(SessionRouterState::from),
        }
    }
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
struct TerminalLaunchInvocation {
    terminal: TerminalType,
    working_dir: String,
    runtime_id: String,
    env_name: String,
    perm_mode: Option<String>,
    resume_session_id: Option<String>,
    client: String,
}

#[cfg(test)]
thread_local! {
    static TERMINAL_LAUNCHES: RefCell<Vec<TerminalLaunchInvocation>> =
        const { RefCell::new(Vec::new()) };
}

#[cfg(test)]
fn clear_terminal_launches() {
    TERMINAL_LAUNCHES.with(|launches| launches.borrow_mut().clear());
}

#[cfg(test)]
fn take_terminal_launches() -> Vec<TerminalLaunchInvocation> {
    TERMINAL_LAUNCHES.with(|launches| std::mem::take(&mut *launches.borrow_mut()))
}

#[cfg(not(test))]
fn launch_terminal_for_native_handoff(
    terminal: TerminalType,
    env_vars: HashMap<String, String>,
    working_dir: &str,
    runtime_id: &str,
    env_name: &str,
    perm_mode: Option<&str>,
    resume_session_id: Option<&str>,
    client: &str,
) -> Result<(), String> {
    terminal::launch_in_terminal(
        terminal,
        env_vars,
        working_dir,
        runtime_id,
        env_name,
        perm_mode,
        resume_session_id,
        client,
    )
    .map(|_| ())
}

#[cfg(test)]
fn launch_terminal_for_native_handoff(
    terminal: TerminalType,
    _env_vars: HashMap<String, String>,
    working_dir: &str,
    runtime_id: &str,
    env_name: &str,
    perm_mode: Option<&str>,
    resume_session_id: Option<&str>,
    client: &str,
) -> Result<(), String> {
    TERMINAL_LAUNCHES.with(|launches| {
        launches.borrow_mut().push(TerminalLaunchInvocation {
            terminal,
            working_dir: working_dir.to_string(),
            runtime_id: runtime_id.to_string(),
            env_name: env_name.to_string(),
            perm_mode: perm_mode.map(str::to_string),
            resume_session_id: resume_session_id.map(str::to_string),
            client: client.to_string(),
        });
    });
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct NativeRuntimeState {
    sessions: Vec<NativeSessionRecord>,
}

pub struct NativeRuntimeManager {
    records: Mutex<HashMap<String, NativeSessionRecord>>,
    handles: Mutex<HashMap<String, Arc<NativeSessionHandle>>>,
    next_handle_generation: AtomicU64,
    state_path: PathBuf,
    event_log: NativeEventLog,
    prompt_image_store: PromptImageStore,
    router_manager: OnceLock<Arc<RouterManager>>,
    reconnect_lock: Mutex<()>,
    settings_update_lock: Mutex<()>,
    app_termination_lock: Mutex<()>,
    app_termination_in_progress: AtomicBool,
    terminal_handoff_preparations: Mutex<HashMap<String, String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RouterLaunchDecision {
    Bypass,
    LaunchDirect,
    LaunchRouted,
    RejectUnavailable,
}

fn router_launch_decision(
    previous_transport: Option<LaunchTransport>,
    launch_requested: bool,
    router_ready: bool,
    auth_capability: RouterAuthCapability,
    oauth_verified: bool,
) -> RouterLaunchDecision {
    match previous_transport {
        Some(LaunchTransport::Direct) => return RouterLaunchDecision::LaunchDirect,
        None if !launch_requested => return RouterLaunchDecision::Bypass,
        Some(LaunchTransport::Routed) | None => {}
    }

    let can_route =
        router_ready && (auth_capability != RouterAuthCapability::Oauth || oauth_verified);
    if can_route {
        RouterLaunchDecision::LaunchRouted
    } else {
        RouterLaunchDecision::RejectUnavailable
    }
}

fn validate_router_launch_draft_profile(
    config: &RouterConfig,
    draft: &RouterLaunchDraft,
) -> Result<(), String> {
    let Some(profile_id) = draft.source_profile_id.as_deref() else {
        if draft.profile_revision.is_some() {
            return Err(
                "ROUTER_PROFILE_INVALID: profileRevision requires sourceProfileId".to_string(),
            );
        }
        return Ok(());
    };
    if profile_id == MY_DEFAULT_ROUTER_PROFILE_ID {
        if draft.profile_revision.is_some()
            || draft.bindings != config.bindings
            || draft.allowed_envs != config.default_allowed_envs
            || draft.dynamic_routing != Some(config.dynamic_routing)
        {
            return Err(
                "ROUTER_PROFILE_STALE: my-default router settings changed before launch"
                    .to_string(),
            );
        }
        return Ok(());
    }
    let profile = config
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| {
            format!("ROUTER_PROFILE_STALE: router profile '{profile_id}' no longer exists")
        })?;
    if draft.profile_revision != Some(profile.revision)
        || draft.bindings != profile.bindings
        || draft.allowed_envs != profile.allowed_envs
        || draft.dynamic_routing != Some(config.dynamic_routing)
    {
        return Err(format!(
            "ROUTER_PROFILE_STALE: router profile '{profile_id}' changed before launch"
        ));
    }
    Ok(())
}

pub(crate) fn validate_router_create_selection(
    router_launch_draft: Option<&RouterLaunchDraft>,
    resume_router_from_runtime_id: Option<&str>,
) -> Result<(), String> {
    if router_launch_draft.is_some() && resume_router_from_runtime_id.is_some() {
        return Err(
            "ROUTER_CREATE_CONFLICT: routerLaunchDraft and resumeRouterFromRuntimeId are mutually exclusive"
                .to_string(),
        );
    }
    if resume_router_from_runtime_id.is_some_and(|runtime_id| runtime_id.trim().is_empty()) {
        return Err(
            "ROUTER_RESUME_SOURCE_INVALID: resumeRouterFromRuntimeId must not be empty".to_string(),
        );
    }
    Ok(())
}

fn native_project_dirs_match(left: &str, right: &str) -> bool {
    fn normalize(value: &str) -> PathBuf {
        fs::canonicalize(value).unwrap_or_else(|_| PathBuf::from(value))
    }

    normalize(left) == normalize(right)
}

impl Default for NativeRuntimeManager {
    fn default() -> Self {
        Self::try_new().expect("failed to load native runtime state")
    }
}

impl NativeRuntimeManager {
    pub fn try_new() -> Result<Self, String> {
        let state_path = native_runtime_state_file_path();
        let records = read_native_runtime_state_from(&state_path)
            .map_err(|error| format!("Failed to load native runtime state: {error}"))?
            .sessions
            .into_iter()
            .map(|record| (record.runtime_id.clone(), record))
            .collect();
        Ok(Self {
            records: Mutex::new(records),
            handles: Mutex::new(HashMap::new()),
            next_handle_generation: AtomicU64::new(1),
            state_path,
            event_log: NativeEventLog::default(),
            prompt_image_store: PromptImageStore::default(),
            router_manager: OnceLock::new(),
            reconnect_lock: Mutex::new(()),
            settings_update_lock: Mutex::new(()),
            app_termination_lock: Mutex::new(()),
            app_termination_in_progress: AtomicBool::new(false),
            terminal_handoff_preparations: Mutex::new(HashMap::new()),
        })
    }

    pub fn set_router_manager(&self, manager: Arc<RouterManager>) -> Result<(), String> {
        self.router_manager
            .set(manager)
            .map_err(|_| "Native router manager was already configured".to_string())
    }

    pub(crate) fn clone_router_record_for_history_resume(
        &self,
        source_runtime_id: &str,
        requested_provider: NativeProvider,
        requested_provider_session_id: Option<&str>,
        requested_project_dir: &str,
    ) -> Result<SessionRouterRecord, String> {
        if requested_provider != NativeProvider::Claude {
            return Err(
                "ROUTER_RESUME_PROVIDER_MISMATCH: routed history resume requires Claude"
                    .to_string(),
            );
        }
        let requested_provider_session_id = requested_provider_session_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                "ROUTER_RESUME_SESSION_MISMATCH: providerSessionId is required for routed history resume"
                    .to_string()
            })?;
        let source = self
            .records
            .lock()
            .map_err(|_| {
                "ROUTER_STATE_UNAVAILABLE: native runtime records are unavailable".to_string()
            })?
            .get(source_runtime_id)
            .cloned()
            .ok_or_else(|| {
                format!(
                    "ROUTER_RESUME_SOURCE_NOT_FOUND: native runtime {source_runtime_id} was not found"
                )
            })?;
        if source.provider != NativeProvider::Claude || source.provider != requested_provider {
            return Err(
                "ROUTER_RESUME_PROVIDER_MISMATCH: source runtime provider does not match the requested provider"
                    .to_string(),
            );
        }
        let source_provider_session_id = source
            .provider_session_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if source_provider_session_id != Some(requested_provider_session_id) {
            return Err(
                "ROUTER_RESUME_SESSION_MISMATCH: source runtime providerSessionId does not match the requested history session"
                    .to_string(),
            );
        }
        if !native_project_dirs_match(&source.project_dir, requested_project_dir) {
            return Err(
                "ROUTER_RESUME_CWD_MISMATCH: source runtime project directory does not match the requested history session"
                    .to_string(),
            );
        }
        let mut router = source.router.ok_or_else(|| {
            "ROUTER_RESUME_SOURCE_NOT_ROUTED: source runtime has no routed state".to_string()
        })?;
        if router.launch_transport != LaunchTransport::Routed {
            return Err(
                "ROUTER_RESUME_SOURCE_NOT_ROUTED: source runtime is not routed".to_string(),
            );
        }

        // A history continuation keeps the authoritative route/auth snapshot,
        // but is a distinct native runtime and therefore gets independent
        // bearer material. Generation facts are re-derived by
        // prepare_router_launch before the record can be persisted or spawned.
        router.session_key = random_router_secret(32);
        router.route_tag_nonce = random_router_secret(24);
        router.revision = 0;
        router.warnings.clear();
        Ok(router)
    }

    pub fn create_session(
        self: &Arc<Self>,
        app: AppHandle,
        options: NativeSessionOptions,
    ) -> Result<NativeSessionSummary, String> {
        let _termination_guard = self
            .app_termination_lock
            .lock()
            .map_err(|_| "Failed to lock native runtime termination".to_string())?;
        if self.app_termination_in_progress.load(Ordering::SeqCst) {
            return Err(
                "CCEM is closing native runtimes; a new session cannot be started.".to_string(),
            );
        }
        let mut options = options;
        self.prepare_router_launch(&mut options, false)?;
        options.initial_annotations =
            validate_prompt_annotations(options.initial_annotations.as_ref())?;
        merge_helper_env_path(&mut options.helper_env_vars, &terminal::get_user_path());
        let runtime_id = generate_runtime_id();
        inject_ccem_runtime_env(&mut options.helper_env_vars, &runtime_id);
        inject_ccem_runtime_env(&mut options.terminal_env_vars, &runtime_id);
        let now = Utc::now();
        let record = NativeSessionRecord {
            runtime_id: runtime_id.clone(),
            provider: options.provider,
            transport: NativeTransport::NativeSdk,
            provider_session_id: options.provider_session_id.clone(),
            seed_boundary_message_count: options.seed_boundary_message_count,
            project_dir: options.working_dir.clone(),
            env_name: options.env_name.clone(),
            perm_mode: options.perm_mode.clone(),
            runtime_perm_mode: options.runtime_perm_mode.clone(),
            effort: options.effort.clone(),
            pending_env_name: None,
            pending_effort: None,
            pending_settings_request_id: None,
            status: "initializing".to_string(),
            created_at: now,
            updated_at: now,
            is_active: true,
            can_handoff_to_terminal: terminal::external_terminal_launch_supported(),
            pending_handoff_terminal: None,
            pending_handoff_allow_background_task_termination: false,
            last_error: None,
            router: options.router_record.clone(),
        };

        let handle = Arc::new(NativeSessionHandle {
            generation: self.allocate_handle_generation(),
            record: Mutex::new(record.clone()),
            child: Mutex::new(None),
            events: Mutex::new(SessionStore::new(runtime_id.clone())),
            background_tasks: Mutex::new(HashMap::new()),
            terminal_background_task_ids: Mutex::new(HashSet::new()),
            background_tool_use_ids: Mutex::new(HashSet::new()),
            completed_background_tool_use_ids: Mutex::new(HashSet::new()),
            pending_background_task_stops: Mutex::new(HashMap::new()),
            teardown_preparations: Mutex::new(HashMap::new()),
            helper_env_vars: options.helper_env_vars.clone(),
            terminal_env_vars: options.terminal_env_vars.clone(),
            claude_path: options.claude_path.clone(),
            codex_path: options.codex_path.clone(),
            codex_base_url: options.codex_base_url.clone(),
            codex_api_key: options.codex_api_key.clone(),
            alive: AtomicBool::new(true),
        });

        if let (Some(manager), Some(router)) = (
            self.router_manager.get(),
            record
                .router
                .as_ref()
                .filter(|router| router.launch_transport == LaunchTransport::Routed),
        ) {
            manager
                .register(&runtime_id, handle.generation, router.clone())
                .map_err(|error| error.to_string())?;
        }

        if let Err(error) = self.insert_record(record) {
            if let Some(manager) = self.router_manager.get() {
                manager.unregister_generation(&runtime_id, handle.generation);
            }
            return Err(error);
        }
        let launch_result = (|| {
            self.insert_handle(runtime_id.clone(), handle.clone())?;
            self.append_event(
                &runtime_id,
                SessionEventPayload::Lifecycle {
                    stage: "runtime_boot".to_string(),
                    detail: format!("Starting {} native runtime.", options.provider.as_str()),
                },
            )?;
            self.append_user_prompt_event(
                &runtime_id,
                options
                    .display_prompt
                    .as_deref()
                    .or(options.initial_prompt.as_deref())
                    .unwrap_or_default(),
                options.initial_images.as_ref(),
                options.initial_annotations.as_ref(),
            )?;
            self.spawn_helper(app, &runtime_id, &options, handle.clone())?;
            self.summary_for(&runtime_id)
        })();
        match launch_result {
            Ok(summary) => Ok(summary),
            Err(error) => {
                let _ = self.kill_child(&runtime_id);
                let _ = self.remove_handle(&runtime_id);
                let _ = self.remove_record(&runtime_id);
                Err(error)
            }
        }
    }

    fn prepare_router_launch(
        &self,
        options: &mut NativeSessionOptions,
        recovering: bool,
    ) -> Result<(), String> {
        if options.provider != NativeProvider::Claude {
            if options.router_launch_draft.is_some() {
                return Err(
                    "ROUTER_PROVIDER_UNSUPPORTED: dynamic routing is only available for Claude sessions"
                        .to_string(),
                );
            }
            options.router_record = None;
            return Ok(());
        }

        if let Some(existing) = options.router_record.as_mut() {
            options.router_launch_draft = None;
            if existing.launch_transport == LaunchTransport::Direct {
                let warnings = existing.warnings.clone();
                prepare_direct_router_launch(options, None)?;
                if let Some(router) = options.router_record.as_mut() {
                    router.warnings = warnings;
                }
                return Ok(());
            }
            let manager = self.router_manager.get().ok_or_else(|| {
                "ROUTER_UNAVAILABLE: routed session recovery requires the router manager"
                    .to_string()
            })?;
            let status = manager.status();
            let unavailable_reason = if status.actual_port.is_none() {
                status
                    .error
                    .clone()
                    .unwrap_or_else(|| "Router listener is unavailable.".to_string())
            } else if existing.router_auth_capability == RouterAuthCapability::Oauth
                && !OAUTH_ROUTING_VERIFIED
            {
                "OAuth routing is not verified for this runtime.".to_string()
            } else {
                "Router launch decision rejected recovery without a readiness reason.".to_string()
            };

            match router_launch_decision(
                Some(existing.launch_transport),
                false,
                status.actual_port.is_some(),
                existing.router_auth_capability,
                OAUTH_ROUTING_VERIFIED,
            ) {
                RouterLaunchDecision::RejectUnavailable => {
                    return Err(if recovering {
                        format!(
                            "ROUTER_UNAVAILABLE: routed session recovery requires the router listener ({unavailable_reason})"
                        )
                    } else {
                        format!("ROUTER_UNAVAILABLE: {unavailable_reason}")
                    });
                }
                RouterLaunchDecision::LaunchRouted => {}
                RouterLaunchDecision::LaunchDirect | RouterLaunchDecision::Bypass => {
                    unreachable!("persisted routed sessions cannot bypass or launch direct")
                }
            }

            let actual_port = status
                .actual_port
                .expect("router readiness checked before routed recovery");
            let source_env = match existing.router_auth_capability {
                RouterAuthCapability::Oauth => crate::config::OFFICIAL_ENV_NAME,
                RouterAuthCapability::Token => existing.default_env.as_str(),
            };
            let source =
                describe_router_environment(source_env).map_err(|error| error.to_string())?;
            match (existing.router_auth_capability, source.auth_kind) {
                (RouterAuthCapability::Oauth, RouterEnvironmentAuthKind::RequiresOauth)
                | (RouterAuthCapability::Token, RouterEnvironmentAuthKind::Token) => {}
                _ => {
                    return Err(
                        "ROUTER_AUTH_CHANGED: helper generation auth source no longer matches the persisted capability"
                            .to_string(),
                    )
                }
            }
            validate_session_router_targets(existing, OAUTH_ROUTING_VERIFIED)
                .map_err(|error| error.to_string())?;
            let resolved_source = resolve_claude_env(source_env)?;
            options.helper_env_vars = resolved_source.env_vars;
            existing.launch_transport = LaunchTransport::Routed;
            existing.launch_default_env = source.name;
            existing.launch_model_pins = source.pins;
            existing.launch_auth_kind = match existing.router_auth_capability {
                RouterAuthCapability::Oauth => LaunchAuthKind::Oauth,
                RouterAuthCapability::Token => LaunchAuthKind::Token,
            };
            existing.warnings.clear();
            configure_routed_helper_env(&mut options.helper_env_vars, actual_port, existing);
            return Ok(());
        }

        let Some(draft) = options.router_launch_draft.take() else {
            return Ok(());
        };
        let manager = self.router_manager.get().ok_or_else(|| {
            "ROUTER_UNAVAILABLE: explicit router launch requires the router manager".to_string()
        })?;
        let config = manager.config();
        validate_router_launch_draft_profile(&config, &draft)?;
        let source =
            describe_router_environment(&options.env_name).map_err(|error| error.to_string())?;
        let mut allowed_envs = draft.allowed_envs;
        allowed_envs.push(options.env_name.clone());
        allowed_envs.extend(draft.bindings.values().cloned());
        dedupe_nonempty(&mut allowed_envs);

        let auth_capability = match source.auth_kind {
            RouterEnvironmentAuthKind::Token => RouterAuthCapability::Token,
            RouterEnvironmentAuthKind::RequiresOauth => RouterAuthCapability::Oauth,
        };
        let launch_auth_kind = match auth_capability {
            RouterAuthCapability::Token => LaunchAuthKind::Token,
            RouterAuthCapability::Oauth => LaunchAuthKind::Oauth,
        };
        let status = manager.status();
        match router_launch_decision(
            None,
            true,
            status.actual_port.is_some(),
            auth_capability,
            OAUTH_ROUTING_VERIFIED,
        ) {
            RouterLaunchDecision::RejectUnavailable => {
                let reason = if status.actual_port.is_none() {
                    status
                        .error
                        .unwrap_or_else(|| "Router listener is unavailable.".to_string())
                } else {
                    "OAuth routing is not verified for this runtime.".to_string()
                };
                return Err(format!("ROUTER_UNAVAILABLE: {reason}"));
            }
            RouterLaunchDecision::LaunchRouted => {}
            RouterLaunchDecision::LaunchDirect | RouterLaunchDecision::Bypass => {
                unreachable!("explicit router launches cannot bypass or launch direct")
            }
        }

        let router_record = SessionRouterRecord {
            session_key: random_router_secret(32),
            route_tag_nonce: random_router_secret(24),
            default_env: options.env_name.clone(),
            bindings: draft.bindings,
            allowed_envs,
            source_profile_id: draft.source_profile_id,
            profile_revision: draft.profile_revision,
            dynamic_routing: draft.dynamic_routing.unwrap_or(config.dynamic_routing),
            revision: 0,
            router_auth_capability: auth_capability,
            launch_transport: LaunchTransport::Routed,
            launch_auth_kind,
            launch_default_env: source.name,
            launch_model_pins: source.pins,
            warnings: Vec::new(),
        };

        validate_session_router_targets(&router_record, OAUTH_ROUTING_VERIFIED)
            .map_err(|error| error.to_string())?;
        configure_routed_helper_env(
            &mut options.helper_env_vars,
            status.actual_port.expect("checked router port"),
            &router_record,
        );
        options.router_record = Some(router_record);
        Ok(())
    }

    fn prepare_explicit_direct_launch(
        &self,
        options: &mut NativeSessionOptions,
    ) -> Result<(), String> {
        if options.provider != NativeProvider::Claude || options.router_record.is_none() {
            return Err(
                "ROUTER_SESSION_UNAVAILABLE: only routed Claude sessions can restart direct"
                    .to_string(),
            );
        }
        prepare_direct_router_launch(
            options,
            Some("Router bypassed by explicit restart; this helper generation is direct.".into()),
        )
    }

    pub fn list_sessions(&self) -> Vec<NativeSessionSummary> {
        let handles = self
            .handles
            .lock()
            .ok()
            .map(|handles| handles.clone())
            .unwrap_or_default();
        let records = self
            .records
            .lock()
            .ok()
            .map(|records| records.clone())
            .unwrap_or_default();

        let mut sessions = records
            .into_values()
            .map(|record| {
                if let Some(handle) = handles.get(&record.runtime_id) {
                    handle.summary()
                } else {
                    NativeSessionSummary {
                        runtime_id: record.runtime_id,
                        provider: record.provider,
                        transport: record.transport,
                        provider_session_id: record.provider_session_id,
                        seed_boundary_message_count: record.seed_boundary_message_count,
                        project_dir: record.project_dir,
                        env_name: record.env_name,
                        perm_mode: record.perm_mode,
                        runtime_perm_mode: record.runtime_perm_mode,
                        effort: record.effort,
                        pending_env_name: record.pending_env_name,
                        pending_effort: record.pending_effort,
                        status: record.status,
                        created_at: record.created_at,
                        updated_at: record.updated_at,
                        is_active: record.is_active,
                        last_event_seq: None,
                        can_handoff_to_terminal: record.can_handoff_to_terminal,
                        background_tasks: Vec::new(),
                        last_error: record.last_error,
                        router: record.router.as_ref().map(SessionRouterState::from),
                    }
                }
            })
            .collect::<Vec<_>>();

        sessions.sort_by_key(|session| std::cmp::Reverse(session.updated_at));
        sessions
    }

    pub fn replay_events(
        &self,
        runtime_id: &str,
        since_seq: Option<u64>,
    ) -> Result<ReplayBatch, String> {
        self.replay_events_limited(runtime_id, since_seq, None)
    }

    /// Read the persisted attention summary without replaying event history.
    pub fn attention_summary(&self, runtime_id: &str) -> Result<AttentionSummary, String> {
        self.event_log.attention_summary(runtime_id)
    }

    pub fn replay_events_limited(
        &self,
        runtime_id: &str,
        since_seq: Option<u64>,
        limit: Option<u64>,
    ) -> Result<ReplayBatch, String> {
        // Fast path for the common idle-poll case: nothing exists after
        // `since_seq`. Return the same empty batch a full replay would,
        // without running the events query. Only taken when sqlite knows the
        // runtime (newest seq present); otherwise fall through so runtimes
        // backed solely by the in-memory store keep their fallback.
        if since_seq.is_some() {
            if let Ok((pending_count, oldest_available_seq, newest_available_seq)) =
                self.event_log.pending_since(runtime_id, since_seq)
            {
                if pending_count == 0 {
                    if let Some(newest_seq) = newest_available_seq {
                        return Ok(ReplayBatch {
                            gap_detected: false,
                            truncated: false,
                            oldest_available_seq,
                            newest_available_seq: Some(newest_seq),
                            events: Vec::new(),
                        });
                    }
                }
            }
        }

        match self.event_log.replay(runtime_id, since_seq, limit) {
            Ok(batch) if batch.newest_available_seq.is_some() => return Ok(batch),
            Ok(_) => {}
            Err(error) => eprintln!(
                "Failed to replay native events from sqlite for {}: {}",
                runtime_id, error
            ),
        }

        let handles = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?;
        let Some(handle) = handles.get(runtime_id) else {
            if self.has_record(runtime_id)? {
                return Ok(ReplayBatch {
                    gap_detected: false,
                    truncated: false,
                    oldest_available_seq: None,
                    newest_available_seq: None,
                    events: Vec::new(),
                });
            }
            return Err(format!("Native runtime {} not found", runtime_id));
        };
        handle
            .events
            .lock()
            .map_err(|_| "Failed to lock native session events".to_string())
            .map(|store| {
                let mut batch = store.events_since(since_seq);
                if since_seq.is_none() {
                    if let Some(limit) = limit.and_then(|value| usize::try_from(value).ok()) {
                        if limit > 0 && batch.events.len() > limit {
                            batch.events = batch.events[batch.events.len() - limit..].to_vec();
                            batch.truncated = true;
                        }
                    }
                }
                batch
            })
    }

    pub fn send_user_message(
        self: &Arc<Self>,
        app: &AppHandle,
        runtime_id: &str,
        text: &str,
        display_text: Option<&str>,
        images: Option<&Vec<PromptImage>>,
        annotations: Option<&Vec<SessionPromptAnnotation>>,
    ) -> Result<(), String> {
        let _termination_guard = self
            .app_termination_lock
            .lock()
            .map_err(|_| "Failed to lock native runtime termination".to_string())?;
        self.reject_query_mutation_during_transition(runtime_id, "send a prompt")?;
        let text = text.trim();
        let has_images = images.as_ref().is_some_and(|imgs| !imgs.is_empty());
        let annotations = validate_prompt_annotations(annotations)?;
        if text.is_empty() && !has_images {
            return Ok(());
        }

        let mut handle = self.ensure_handle(app.clone(), runtime_id)?;
        let image_count = images.as_ref().map(|imgs| imgs.len()).unwrap_or(0);
        if !self.is_current_live_handle(runtime_id, &handle)? {
            handle = self.ensure_handle(app.clone(), runtime_id)?;
            if !self.is_current_live_handle(runtime_id, &handle)? {
                return Err("Native runtime helper was replaced while sending prompt".to_string());
            }
        }
        let record = handle
            .record
            .lock()
            .map_err(|_| "Failed to lock native session record".to_string())?
            .clone();
        self.append_lifecycle_event(
            runtime_id,
            "prompt_send_requested",
            format!(
                "runtime_id={} provider={} status={} handle_generation={} chars={} images={}",
                runtime_id,
                record.provider.as_str(),
                record.status,
                handle.generation,
                text.chars().count(),
                image_count
            ),
        )?;
        let images_ref = images
            .filter(|imgs| !imgs.is_empty())
            .map(|imgs| imgs.as_slice());
        self.write_to_child_with_reconnect(
            app,
            runtime_id,
            handle,
            &HelperInputCommand::Prompt {
                text,
                images: images_ref,
            },
        )?;
        self.append_lifecycle_event(
            runtime_id,
            "prompt_send_written",
            format!(
                "helper accepted prompt command: chars={} images={}",
                text.chars().count(),
                image_count
            ),
        )?;
        self.append_user_prompt_event(
            runtime_id,
            display_text.unwrap_or(text),
            images,
            annotations.as_ref(),
        )
    }

    pub fn respond_to_permission(
        self: &Arc<Self>,
        runtime_id: &str,
        request_id: &str,
        approved: bool,
    ) -> Result<(), String> {
        let _transition_guard = self
            .app_termination_lock
            .lock()
            .map_err(|_| "Failed to lock native runtime transition".to_string())?;
        self.reject_query_mutation_during_transition(runtime_id, "respond to permission")?;
        let handle = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(runtime_id)
            .cloned()
            .filter(|handle| handle.alive.load(Ordering::SeqCst))
            .ok_or_else(|| {
                format!("Native runtime {runtime_id} no longer has a live permission request.")
            })?;
        self.write_to_child(
            &handle,
            &HelperInputCommand::PermissionResponse {
                request_id,
                approved,
            },
        )
    }

    pub fn respond_to_prompt(
        self: &Arc<Self>,
        runtime_id: &str,
        tool_use_id: &str,
        prompt_type: &str,
        display_text: Option<&str>,
        answers: &HashMap<String, String>,
        annotations: Option<&HashMap<String, InteractivePromptAnnotation>>,
        prompt_annotations: Option<&Vec<SessionPromptAnnotation>>,
    ) -> Result<(), String> {
        let _transition_guard = self
            .app_termination_lock
            .lock()
            .map_err(|_| "Failed to lock native runtime transition".to_string())?;
        self.reject_query_mutation_during_transition(runtime_id, "respond to a prompt")?;
        if answers.is_empty() {
            return Err("Interactive prompt response requires at least one answer.".to_string());
        }
        let prompt_annotations = validate_prompt_annotations(prompt_annotations)?;

        let handle = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(runtime_id)
            .cloned()
            .filter(|handle| handle.alive.load(Ordering::SeqCst))
            .ok_or_else(|| {
                format!("Native runtime {runtime_id} no longer has a live interactive prompt.")
            })?;
        self.deliver_and_append_interactive_prompt_response(
            runtime_id,
            display_text,
            answers,
            prompt_annotations.as_ref(),
            || {
                self.write_to_child(
                    &handle,
                    &HelperInputCommand::InteractivePromptResponse {
                        tool_use_id,
                        prompt_type,
                        answers,
                        annotations,
                    },
                )
            },
        )
    }

    fn active_background_tasks(
        &self,
        runtime_id: &str,
    ) -> Result<Vec<NativeBackgroundTask>, String> {
        let handle = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(runtime_id)
            .cloned();
        let Some(handle) = handle else {
            return Ok(Vec::new());
        };
        let mut tasks = handle
            .background_tasks
            .lock()
            .map_err(|_| "Failed to lock native background tasks".to_string())?
            .values()
            .cloned()
            .collect::<Vec<_>>();
        tasks.sort_by_key(|task| task.started_at);
        Ok(tasks)
    }

    fn reject_background_task_termination(
        &self,
        runtime_id: &str,
        action: &str,
        force: bool,
    ) -> Result<(), String> {
        let tasks = self.active_background_tasks(runtime_id)?;
        if tasks.is_empty() || force {
            return Ok(());
        }
        Err(format!(
            "Cannot {action} while {} Claude background task{} remain active. Retry with force after confirming their results may be lost.",
            tasks.len(),
            if tasks.len() == 1 { "" } else { "s" }
        ))
    }

    fn interrupt_background_tasks(&self, runtime_id: &str, reason: &str) -> Result<usize, String> {
        let tasks = self.active_background_tasks(runtime_id)?;
        for mut task in tasks.iter().cloned() {
            task.status = NativeBackgroundTaskStatus::Interrupted;
            task.updated_at = Utc::now();
            if task.error.is_none() {
                task.error = Some(reason.to_string());
            }
            self.append_event(
                runtime_id,
                SessionEventPayload::BackgroundTaskUpdated { task: task.clone() },
            )?;
            if let Some(tool_use_id) = task.tool_use_id.as_ref() {
                self.append_event(
                    runtime_id,
                    SessionEventPayload::ToolUseCompleted {
                        tool_use_id: tool_use_id.clone(),
                        raw_name: task
                            .task_type
                            .clone()
                            .unwrap_or_else(|| "background_task".to_string()),
                        result_summary: task.error.clone().unwrap_or_else(|| reason.to_string()),
                        result_content: None,
                        success: false,
                        todo_snapshot: None,
                    },
                )?;
            }
        }
        Ok(tasks.len())
    }

    pub fn prepare_app_termination(&self, force: bool) -> Result<usize, String> {
        self.prepare_app_termination_with_hook(force, |_| {})
    }

    fn prepare_app_termination_with_hook<F>(
        &self,
        force: bool,
        before_commit: F,
    ) -> Result<usize, String>
    where
        F: FnOnce(&[String]),
    {
        self.prepare_app_termination_with_hooks(force, before_commit, |runtime_id, force| {
            self.shutdown_child(runtime_id, force)
        })
    }

    fn prepare_app_termination_with_hooks<F, S>(
        &self,
        force: bool,
        before_commit: F,
        mut shutdown_child: S,
    ) -> Result<usize, String>
    where
        F: FnOnce(&[String]),
        S: FnMut(&str, bool) -> Result<(), String>,
    {
        let _termination_guard = self
            .app_termination_lock
            .lock()
            .map_err(|_| "Failed to lock native runtime termination".to_string())?;
        if self.app_termination_in_progress.load(Ordering::SeqCst) {
            return Ok(0);
        }
        self.app_termination_in_progress
            .store(true, Ordering::SeqCst);

        let mut prepared_handles = Vec::new();
        let result = (|| {
            let handles = self
                .handles
                .lock()
                .map_err(|_| "Failed to lock native runtime handles".to_string())?
                .values()
                .cloned()
                .collect::<Vec<_>>();
            let mut runtime_ids = Vec::with_capacity(handles.len());
            for handle in handles {
                let record = handle
                    .record
                    .lock()
                    .map_err(|_| "Failed to lock native session record".to_string())?;
                if runtime_child_is_owned(&record) {
                    runtime_ids.push(record.runtime_id.clone());
                }
            }
            let mut tasks_by_runtime = Vec::new();
            let mut total = 0usize;
            for runtime_id in &runtime_ids {
                let count = self.active_background_tasks(runtime_id)?.len();
                if count > 0 {
                    total += count;
                    tasks_by_runtime.push(runtime_id.clone());
                }
            }

            if total > 0 && !force {
                return Err(format!(
                    "Cannot exit while {total} Claude background task{} remain active. Retry with force after confirming their results may be lost.",
                    if total == 1 { "" } else { "s" }
                ));
            }

            if force {
                for runtime_id in &tasks_by_runtime {
                    self.interrupt_background_tasks(
                        runtime_id,
                        "CCEM exited before the Claude background task settled.",
                    )?;
                }
            }

            let preparation_id = format!(
                "app-termination-{}",
                Utc::now().timestamp_nanos_opt().unwrap_or_default()
            );
            if !force {
                for (index, runtime_id) in runtime_ids.iter().enumerate() {
                    let request_id = format!("{preparation_id}-{index}");
                    let require_idle = app_termination_requires_idle_freeze(
                        self.current_record(runtime_id)?.provider,
                    );
                    if let Some(handle) = self.request_child_prepare_stop(
                        runtime_id,
                        &request_id,
                        require_idle,
                        false,
                        false,
                    )? {
                        prepared_handles.push((runtime_id.clone(), request_id, handle));
                    }
                }
                for (runtime_id, request_id, handle) in &prepared_handles {
                    if let Err(error) =
                        self.await_child_prepare_stop(runtime_id, request_id, handle, false)
                    {
                        return Err(error);
                    }
                }
            }

            before_commit(&runtime_ids);
            if !force {
                let late_task_count =
                    runtime_ids.iter().try_fold(0usize, |count, runtime_id| {
                        self.active_background_tasks(runtime_id)
                            .map(|tasks| count + tasks.len())
                    })?;
                if late_task_count > 0 {
                    return Err(format!(
                        "Cannot exit while {late_task_count} Claude background task{} remain active. Retry with force after confirming their results may be lost.",
                        if late_task_count == 1 { "" } else { "s" }
                    ));
                }
            }

            let originals = runtime_ids
                .iter()
                .map(|runtime_id| {
                    self.current_record(runtime_id)
                        .map(|record| (runtime_id.clone(), record))
                })
                .collect::<Result<Vec<_>, _>>()?;
            for (runtime_id, _) in &originals {
                let has_forced_tasks = tasks_by_runtime.contains(runtime_id);
                self.update_record(runtime_id, |record| {
                    record.status = if has_forced_tasks {
                        "interrupted"
                    } else {
                        "app_closing"
                    }
                    .to_string();
                    record.is_active = false;
                    record.updated_at = Utc::now();
                })?;
            }

            let mut closed_runtime_ids = HashSet::new();
            for runtime_id in &runtime_ids {
                let has_forced_tasks = tasks_by_runtime.contains(runtime_id);
                if let Err(error) = shutdown_child(runtime_id, force) {
                    if !force && is_background_task_shutdown_safety_error(&error) {
                        for (original_runtime_id, original) in &originals {
                            if closed_runtime_ids.contains(original_runtime_id) {
                                continue;
                            }
                            let live_handle = self
                                .handles
                                .lock()
                                .map_err(|_| "Failed to lock native runtime handles".to_string())?
                                .get(original_runtime_id)
                                .cloned();
                            if let Some(handle) = live_handle {
                                let restored = original.clone();
                                self.update_record(original_runtime_id, |record| {
                                    *record = restored.clone();
                                })?;
                                handle.alive.store(true, Ordering::SeqCst);
                            } else {
                                self.update_record(original_runtime_id, |record| {
                                    record.status = "interrupted".to_string();
                                    record.is_active = false;
                                    record.updated_at = Utc::now();
                                    record.last_error = Some(
                                        "Native runtime exited while a late background task blocked app termination."
                                            .to_string(),
                                    );
                                })?;
                            }
                        }
                        return Err(error);
                    }
                    self.update_record(runtime_id, |record| {
                        record.status = "interrupted".to_string();
                        record.is_active = false;
                        record.updated_at = Utc::now();
                        record.last_error = Some(format!(
                            "Native runtime shutdown failed while CCEM was exiting: {error}"
                        ));
                    })?;
                    if let Some(handle) = self
                        .handles
                        .lock()
                        .map_err(|_| "Failed to lock native runtime handles".to_string())?
                        .get(runtime_id)
                        .cloned()
                    {
                        handle.alive.store(false, Ordering::SeqCst);
                    }
                    self.append_event(
                        runtime_id,
                        SessionEventPayload::StdErrLine {
                            line: format!(
                                "Native runtime shutdown failed during app exit: {error}"
                            ),
                        },
                    )?;
                    continue;
                }
                if !has_forced_tasks {
                    self.update_record(runtime_id, |record| {
                        record.status = "stopped".to_string();
                        record.updated_at = Utc::now();
                    })?;
                }
                closed_runtime_ids.insert(runtime_id.clone());
            }

            Ok(total)
        })();

        if result.is_err() {
            for (runtime_id, request_id, _) in &prepared_handles {
                self.cancel_child_prepare_stop(runtime_id, request_id);
            }
            self.app_termination_in_progress
                .store(false, Ordering::SeqCst);
        }
        result
    }

    pub fn rewind_files(
        self: &Arc<Self>,
        app: &AppHandle,
        runtime_id: &str,
        checkpoint_id: &str,
    ) -> Result<(), String> {
        let _transition_guard = self
            .app_termination_lock
            .lock()
            .map_err(|_| "Failed to lock native runtime transition".to_string())?;
        self.reject_query_mutation_during_transition(runtime_id, "rewind files")?;
        let checkpoint_id = checkpoint_id.trim();
        if checkpoint_id.is_empty() {
            return Err("Checkpoint id is required.".to_string());
        }

        let handle = self.ensure_handle(app.clone(), runtime_id)?;
        let status = handle
            .record
            .lock()
            .map_err(|_| "Failed to lock native session record".to_string())?
            .status
            .clone();
        if !native_status_allows_file_rewind(&status) {
            return Err(format!(
                "Cannot rewind files while native session is {}.",
                status
            ));
        }
        if !self.active_background_tasks(runtime_id)?.is_empty() {
            return Err(
                "Cannot rewind files while Claude background tasks remain active.".to_string(),
            );
        }

        self.write_to_child_with_reconnect(
            app,
            runtime_id,
            handle,
            &HelperInputCommand::RewindFiles { checkpoint_id },
        )
    }

    pub fn query_session_usage(
        self: &Arc<Self>,
        app: &AppHandle,
        runtime_id: &str,
    ) -> Result<(), String> {
        let _transition_guard = self
            .app_termination_lock
            .lock()
            .map_err(|_| "Failed to lock native runtime transition".to_string())?;
        self.reject_query_mutation_during_transition(runtime_id, "query usage")?;
        let handle = self.ensure_handle(app.clone(), runtime_id)?;
        let status = handle
            .record
            .lock()
            .map_err(|_| "Failed to lock native session record".to_string())?
            .status
            .clone();
        if !native_status_allows_usage_query(&status) {
            return Err(format!(
                "Cannot query usage while native session is {}.",
                status
            ));
        }

        self.write_to_child_with_reconnect(app, runtime_id, handle, &HelperInputCommand::UsageQuery)
    }

    pub fn stop_background_task(
        self: &Arc<Self>,
        runtime_id: &str,
        task_id: &str,
    ) -> Result<(), String> {
        let _transition_guard = self
            .app_termination_lock
            .lock()
            .map_err(|_| "Failed to lock native runtime transition".to_string())?;
        self.reject_query_mutation_during_transition(runtime_id, "stop a background task")?;
        let task_id = task_id.trim();
        if task_id.is_empty() {
            return Err("Background task id is required.".to_string());
        }

        let handle = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(runtime_id)
            .cloned()
            .filter(|handle| handle.alive.load(Ordering::SeqCst))
            .ok_or_else(|| {
                format!("Claude background task {task_id} is no longer attached to a live runtime.")
            })?;
        let provider = handle
            .record
            .lock()
            .map_err(|_| "Failed to lock native session record".to_string())?
            .provider;
        if provider != NativeProvider::Claude {
            return Err(
                "Background task controls are only available for Claude sessions.".to_string(),
            );
        }

        let original = handle
            .background_tasks
            .lock()
            .map_err(|_| "Failed to lock native background tasks".to_string())?
            .get(task_id)
            .cloned()
            .ok_or_else(|| format!("Claude background task {task_id} is not active."))?;
        if !original.status.can_stop() {
            return Err(format!(
                "Claude background task {task_id} cannot be stopped while it is {:?}.",
                original.status
            ));
        }

        let mut stopping = original.clone();
        let stop_request_id = format!(
            "stop-{}-{}",
            task_id,
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        stopping.status = NativeBackgroundTaskStatus::Stopping;
        stopping.updated_at = Utc::now();
        stopping.error = None;
        stopping.stop_request_id = Some(stop_request_id.clone());
        stopping.stop_failed = None;
        self.append_event(
            runtime_id,
            SessionEventPayload::BackgroundTaskUpdated { task: stopping },
        )?;
        handle
            .pending_background_task_stops
            .lock()
            .map_err(|_| "Failed to lock pending background task stops".to_string())?
            .insert(
                task_id.to_string(),
                (stop_request_id.clone(), original.status),
            );

        if let Err(error) = self.write_to_child(
            &handle,
            &HelperInputCommand::StopTask {
                task_id,
                stop_request_id: &stop_request_id,
            },
        ) {
            handle
                .pending_background_task_stops
                .lock()
                .map_err(|_| "Failed to lock pending background task stops".to_string())?
                .remove(task_id);
            let mut restored = original;
            restored.updated_at = Utc::now();
            restored.error = Some(error.clone());
            restored.stop_request_id = Some(stop_request_id);
            restored.stop_failed = Some(true);
            self.append_event(
                runtime_id,
                SessionEventPayload::BackgroundTaskUpdated { task: restored },
            )?;
            return Err(error);
        }

        Ok(())
    }

    pub fn update_session_settings(
        self: &Arc<Self>,
        app: &AppHandle,
        runtime_id: &str,
        env_name: Option<&str>,
        perm_mode: Option<&str>,
        env_vars: Option<&HashMap<String, String>>,
        effort: Option<&str>,
        force_restart: bool,
    ) -> Result<(), String> {
        let _transition_guard = self
            .app_termination_lock
            .lock()
            .map_err(|_| "Failed to lock native runtime transition".to_string())?;
        self.reject_query_mutation_during_transition(runtime_id, "update settings")?;
        let _settings_guard = self
            .settings_update_lock
            .lock()
            .map_err(|_| "Failed to lock native settings updates".to_string())?;
        let handle = self.ensure_handle(app.clone(), runtime_id)?;
        let request_id = format!(
            "settings-{}-{}",
            runtime_id,
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        if let Some(mode) = perm_mode {
            self.update_record(runtime_id, |record| {
                record.perm_mode = mode.to_string();
                record.runtime_perm_mode = None;
                record.updated_at = Utc::now();
            })?;
            notify_browser_policy_changed(app, runtime_id);
        }
        let original_settings = handle
            .record
            .lock()
            .map_err(|_| "Failed to lock native session record".to_string())?
            .clone();
        if env_name.is_some() || effort.is_some() {
            self.update_record(runtime_id, |record| {
                stage_runtime_settings_update(record, env_name, effort, &request_id);
            })?;
        }
        if let Err(error) = self.write_to_child_with_reconnect(
            app,
            runtime_id,
            handle,
            &HelperInputCommand::UpdateSettings {
                request_id: &request_id,
                env_name,
                perm_mode,
                env_vars,
                effort,
                force_restart,
            },
        ) {
            if env_name.is_some() || effort.is_some() {
                self.update_record(runtime_id, |record| {
                    record.env_name = original_settings.env_name;
                    record.effort = original_settings.effort;
                    record.pending_env_name = original_settings.pending_env_name;
                    record.pending_effort = original_settings.pending_effort;
                    record.pending_settings_request_id =
                        original_settings.pending_settings_request_id;
                    record.updated_at = Utc::now();
                })?;
            }
            return Err(error);
        }
        Ok(())
    }

    pub fn get_session_router(
        &self,
        runtime_id: &str,
    ) -> Result<SessionRouterState, RouterServiceError> {
        let records = self.records.lock().map_err(|_| {
            RouterServiceError::new(
                "ROUTER_STATE_UNAVAILABLE",
                "Native runtime record lock is poisoned.",
            )
        })?;
        let record = records.get(runtime_id).ok_or_else(|| {
            RouterServiceError::new(
                "ROUTER_SESSION_NOT_FOUND",
                format!("Native runtime {runtime_id} was not found."),
            )
        })?;
        record
            .router
            .as_ref()
            .map(SessionRouterState::from)
            .ok_or_else(|| {
                RouterServiceError::new(
                    "ROUTER_SESSION_UNAVAILABLE",
                    "This native session does not have router state.",
                )
            })
    }

    pub fn router_environment_references(&self, env_name: &str) -> Result<Vec<String>, String> {
        let records = self
            .records
            .lock()
            .map_err(|_| "Failed to lock native runtime records".to_string())?;
        let mut references = records
            .values()
            .filter_map(|record| {
                if matches!(record.status.as_str(), "stopped" | "handoff") {
                    return None;
                }
                let referenced = record.env_name == env_name
                    || record.router.as_ref().is_some_and(|router| {
                        router.default_env == env_name
                            || router.launch_default_env == env_name
                            || router
                                .allowed_envs
                                .iter()
                                .any(|allowed| allowed == env_name)
                            || router.bindings.values().any(|target| target == env_name)
                    });
                referenced.then(|| format!("session:{}", record.runtime_id))
            })
            .collect::<Vec<_>>();
        references.sort();
        Ok(references)
    }

    pub fn rename_router_environment_references(
        &self,
        old_name: &str,
        new_name: &str,
    ) -> Result<Vec<SessionRouterUpdatedEvent>, String> {
        if old_name == new_name {
            return Ok(Vec::new());
        }
        let _coordinator = self
            .reconnect_lock
            .lock()
            .map_err(|_| "Failed to lock native runtime router coordinator".to_string())?;
        let mut records = self
            .records
            .lock()
            .map_err(|_| "Failed to lock native runtime records".to_string())?;
        let previous_records = records.clone();
        let mut updated_records = previous_records.clone();
        let mut events = Vec::new();
        for record in updated_records.values_mut() {
            let mut record_changed = false;
            if record.env_name == old_name {
                record.env_name = new_name.to_string();
                record_changed = true;
            }
            let Some(router) = record.router.as_mut() else {
                if record_changed {
                    record.updated_at = Utc::now();
                }
                continue;
            };
            let previous_router = router.clone();
            if router.default_env == old_name {
                router.default_env = new_name.to_string();
            }
            if router.launch_default_env == old_name {
                router.launch_default_env = new_name.to_string();
            }
            for target in router.bindings.values_mut() {
                if target == old_name {
                    *target = new_name.to_string();
                }
            }
            for allowed in &mut router.allowed_envs {
                if allowed == old_name {
                    *allowed = new_name.to_string();
                }
            }
            dedupe_nonempty(&mut router.allowed_envs);
            if *router != previous_router {
                router.revision = previous_router
                    .revision
                    .checked_add(1)
                    .ok_or_else(|| format!("Router revision overflow for {}", record.runtime_id))?;
                record_changed = true;
                events.push(SessionRouterUpdatedEvent {
                    runtime_id: record.runtime_id.clone(),
                    router: SessionRouterState::from(&*router),
                    reason: "environment-rename".to_string(),
                });
            }
            if record_changed {
                record.updated_at = Utc::now();
            }
        }
        let handles = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?;
        *records = updated_records.clone();
        if let Err(error) =
            persist_native_runtime_state_to(&self.state_path, records.values().cloned().collect())
        {
            *records = previous_records;
            return Err(error);
        }

        let mut registered: Vec<(String, u64)> = Vec::new();
        for (runtime_id, handle) in handles.iter() {
            let Some(updated) = updated_records.get(runtime_id) else {
                continue;
            };
            if let (Some(manager), Some(router)) = (
                self.router_manager.get(),
                updated
                    .router
                    .as_ref()
                    .filter(|router| router.launch_transport == LaunchTransport::Routed),
            ) {
                if let Err(error) = manager.register(runtime_id, handle.generation, router.clone())
                {
                    *records = previous_records.clone();
                    let rollback_error = persist_native_runtime_state_to(
                        &self.state_path,
                        records.values().cloned().collect(),
                    )
                    .err();
                    for (registered_id, registered_generation) in registered {
                        if let Some(previous_router) = previous_records
                            .get(&registered_id)
                            .and_then(|record| record.router.clone())
                        {
                            let _ = manager.register(
                                &registered_id,
                                registered_generation,
                                previous_router,
                            );
                        }
                    }
                    return Err(match rollback_error {
                        Some(rollback_error) => format!(
                            "{}; failed to roll back native router state: {rollback_error}",
                            error
                        ),
                        None => error.to_string(),
                    });
                }
                registered.push((runtime_id.clone(), handle.generation));
            }
        }
        for (runtime_id, handle) in handles.iter() {
            if let Some(updated) = updated_records.get(runtime_id).cloned() {
                if let Ok(mut record) = handle.record.lock() {
                    *record = updated;
                }
            }
        }
        Ok(events)
    }

    pub fn update_session_router(
        self: &Arc<Self>,
        app: &AppHandle,
        request: UpdateSessionRouterRequest,
        reason: &str,
    ) -> Result<SessionRouterState, RouterServiceError> {
        let _coordinator = self.reconnect_lock.lock().map_err(|_| {
            RouterServiceError::new(
                "ROUTER_STATE_UNAVAILABLE",
                "Native runtime router coordinator is poisoned.",
            )
        })?;
        let mut records = self.records.lock().map_err(|_| {
            RouterServiceError::new(
                "ROUTER_STATE_UNAVAILABLE",
                "Native runtime record lock is poisoned.",
            )
        })?;
        let previous_record = records.get(&request.runtime_id).cloned().ok_or_else(|| {
            RouterServiceError::new(
                "ROUTER_SESSION_NOT_FOUND",
                format!("Native runtime {} was not found.", request.runtime_id),
            )
        })?;
        if previous_record.provider != NativeProvider::Claude {
            return Err(RouterServiceError::new(
                "ROUTER_PROVIDER_UNSUPPORTED",
                "Session routing is only available for Claude native sessions.",
            ));
        }
        let current_router = previous_record.router.as_ref().ok_or_else(|| {
            RouterServiceError::new(
                "ROUTER_SESSION_UNAVAILABLE",
                "This native session does not have router state.",
            )
        })?;
        let mut updated_router = apply_session_router_patch(
            current_router,
            request.expected_revision,
            &request.patch,
            session_router_patch_oauth_validation_enabled(current_router),
        )?;

        let default_changed = updated_router.default_env != current_router.default_env;
        let direct_env = if default_changed
            && updated_router.launch_transport == LaunchTransport::Direct
        {
            let descriptor = describe_router_environment(&updated_router.default_env)
                .map_err(|error| RouterServiceError::new(error.code, error.message))?;
            updated_router.launch_default_env = descriptor.name;
            updated_router.launch_model_pins = descriptor.pins;
            updated_router.launch_auth_kind = match descriptor.auth_kind {
                RouterEnvironmentAuthKind::Token => LaunchAuthKind::Token,
                RouterEnvironmentAuthKind::RequiresOauth => LaunchAuthKind::Oauth,
            };
            Some(
                resolve_claude_env(&updated_router.default_env)
                    .map_err(|error| RouterServiceError::new("ROUTER_ENV_UNAVAILABLE", error))?,
            )
        } else {
            None
        };
        let router_manager = self.router_manager.get();
        if updated_router.launch_transport == LaunchTransport::Routed && router_manager.is_none() {
            return Err(RouterServiceError::new(
                "ROUTER_UNAVAILABLE",
                "Router manager is not configured.",
            ));
        }

        let handles = self.handles.lock().map_err(|_| {
            RouterServiceError::new(
                "ROUTER_STATE_UNAVAILABLE",
                "Native runtime handle lock is poisoned.",
            )
        })?;
        let active_handle = handles.get(&request.runtime_id).cloned();
        let settings_request_id = format!(
            "router-settings-{}-{}",
            request.runtime_id,
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );

        let mut updated_record = previous_record.clone();
        if direct_env.is_some() && active_handle.is_some() {
            stage_runtime_settings_update(
                &mut updated_record,
                Some(&updated_router.default_env),
                None,
                &settings_request_id,
            );
        } else {
            updated_record.env_name = updated_router.default_env.clone();
        }
        updated_record.updated_at = Utc::now();
        updated_record.router = Some(updated_router.clone());
        records.insert(request.runtime_id.clone(), updated_record.clone());
        if let Err(error) =
            persist_native_runtime_state_to(&self.state_path, records.values().cloned().collect())
        {
            records.insert(request.runtime_id.clone(), previous_record.clone());
            return Err(RouterServiceError::new("ROUTER_PERSIST_FAILED", error));
        }

        // Keep the current helper generation stable while applying the persisted
        // router state. Recovery and route updates share reconnect_lock; the
        // handle lock also prevents an exit callback from unregistering/replacing
        // this generation between the check and registration.
        let apply_result = if let Some(handle) = active_handle.as_ref() {
            if updated_router.launch_transport == LaunchTransport::Routed {
                router_manager
                    .expect("routed router manager checked above")
                    .register(
                        &request.runtime_id,
                        handle.generation,
                        updated_router.clone(),
                    )
                    .map_err(|error| RouterServiceError::new(error.code, error.message))
            } else if let Some(resolved) = direct_env.as_ref() {
                self.write_to_child(
                    handle,
                    &HelperInputCommand::UpdateSettings {
                        request_id: &settings_request_id,
                        env_name: Some(&updated_router.default_env),
                        perm_mode: None,
                        env_vars: Some(&resolved.env_vars),
                        effort: None,
                        force_restart: false,
                    },
                )
                .map_err(|error| {
                    RouterServiceError::new(
                        "ROUTER_DIRECT_UPDATE_FAILED",
                        format!("Failed to switch the direct helper environment: {error}"),
                    )
                })
            } else {
                Ok(())
            }
        } else {
            Ok(())
        };

        if let Err(error) = apply_result {
            records.insert(request.runtime_id.clone(), previous_record.clone());
            let rollback_result = persist_native_runtime_state_to(
                &self.state_path,
                records.values().cloned().collect(),
            );
            if let (Some(manager), Some(handle), Some(previous_router)) = (
                router_manager,
                active_handle.as_ref(),
                previous_record.router.clone(),
            ) {
                if previous_router.launch_transport == LaunchTransport::Routed {
                    let _ =
                        manager.register(&request.runtime_id, handle.generation, previous_router);
                }
            }
            return Err(if let Err(rollback_error) = rollback_result {
                RouterServiceError::new(
                    "ROUTER_ROLLBACK_FAILED",
                    format!(
                        "{}; state rollback also failed: {rollback_error}",
                        error.message
                    ),
                )
            } else {
                error
            });
        }

        if let Some(handle) = active_handle.as_ref() {
            if let Ok(mut handle_record) = handle.record.lock() {
                *handle_record = updated_record;
            }
        }
        drop(handles);
        drop(records);
        let state = SessionRouterState::from(&updated_router);
        let event = SessionRouterUpdatedEvent {
            runtime_id: request.runtime_id,
            router: state.clone(),
            reason: reason.to_string(),
        };
        if let Err(error) = app.emit("native-session-router-updated", event) {
            eprintln!(
                "Failed to emit native-session-router-updated for {}: {}",
                previous_record.runtime_id, error
            );
        }
        Ok(state)
    }

    pub fn restart_session_direct(
        self: &Arc<Self>,
        app: &AppHandle,
        runtime_id: &str,
    ) -> Result<SessionRouterState, RouterServiceError> {
        let _coordinator = self.reconnect_lock.lock().map_err(|_| {
            RouterServiceError::new(
                "ROUTER_STATE_UNAVAILABLE",
                "Native runtime router coordinator is poisoned.",
            )
        })?;
        let previous_record = self
            .records
            .lock()
            .map_err(|_| {
                RouterServiceError::new(
                    "ROUTER_STATE_UNAVAILABLE",
                    "Native runtime record lock is poisoned.",
                )
            })?
            .get(runtime_id)
            .cloned()
            .ok_or_else(|| {
                RouterServiceError::new(
                    "ROUTER_SESSION_NOT_FOUND",
                    format!("Native runtime {runtime_id} was not found."),
                )
            })?;
        if previous_record.provider != NativeProvider::Claude {
            return Err(RouterServiceError::new(
                "ROUTER_PROVIDER_UNSUPPORTED",
                "Session routing is only available for Claude native sessions.",
            ));
        }
        let previous_router = previous_record.router.as_ref().ok_or_else(|| {
            RouterServiceError::new(
                "ROUTER_SESSION_UNAVAILABLE",
                "This native session does not have router state.",
            )
        })?;
        if previous_router.launch_transport == LaunchTransport::Direct {
            return Err(RouterServiceError::new(
                "ROUTER_ALREADY_DIRECT",
                "This helper generation is already direct.",
            ));
        }

        let mut options = build_runtime_bootstrap_options(&previous_record)
            .map_err(|error| RouterServiceError::new("ROUTER_ENV_UNAVAILABLE", error))?;
        self.prepare_explicit_direct_launch(&mut options)
            .map_err(|error| RouterServiceError::new("ROUTER_DIRECT_RESTART_INVALID", error))?;
        let mut direct_router = options
            .router_record
            .clone()
            .expect("explicit direct launch requires router state");
        direct_router.revision = previous_router.revision.checked_add(1).ok_or_else(|| {
            RouterServiceError::new(
                "ROUTER_REVISION_OVERFLOW",
                "Router revision cannot be incremented.",
            )
        })?;

        let recovery_record =
            self.retire_handle_for_direct_restart(runtime_id, previous_router.revision)?;
        self.stage_direct_restart_record(
            runtime_id,
            previous_router.revision,
            &direct_router,
            &recovery_record,
        )?;

        self.reconnect_handle_locked_from_baseline(
            app.clone(),
            runtime_id,
            true,
            Some(&recovery_record),
        )
        .map_err(|error| RouterServiceError::new("ROUTER_DIRECT_RESTART_FAILED", error))?;
        let state = SessionRouterState::from(&direct_router);
        let event = SessionRouterUpdatedEvent {
            runtime_id: runtime_id.to_string(),
            router: state.clone(),
            reason: "restart-direct".to_string(),
        };
        if let Err(error) = app.emit("native-session-router-updated", event) {
            eprintln!("Failed to emit native-session-router-updated for {runtime_id}: {error}");
        }
        Ok(state)
    }

    fn retire_handle_for_direct_restart(
        &self,
        runtime_id: &str,
        previous_revision: u64,
    ) -> Result<NativeSessionRecord, RouterServiceError> {
        let mut records = self.records.lock().map_err(|_| {
            RouterServiceError::new(
                "ROUTER_STATE_UNAVAILABLE",
                "Native runtime record lock is poisoned.",
            )
        })?;
        let current = records.get(runtime_id).cloned().ok_or_else(|| {
            RouterServiceError::new(
                "ROUTER_SESSION_NOT_FOUND",
                format!("Native runtime {runtime_id} was not found."),
            )
        })?;
        let current_revision = current.router.as_ref().map(|router| router.revision);
        if current_revision != Some(previous_revision) {
            return Err(RouterServiceError::conflict(
                current
                    .router
                    .as_ref()
                    .map(SessionRouterState::from)
                    .ok_or_else(|| {
                        RouterServiceError::new(
                            "ROUTER_SESSION_UNAVAILABLE",
                            "This native session no longer has router state.",
                        )
                    })?,
            ));
        }

        let mut handles = self.handles.lock().map_err(|_| {
            RouterServiceError::new(
                "ROUTER_STATE_UNAVAILABLE",
                "Native runtime handle lock is poisoned.",
            )
        })?;
        let handle = handles.get(runtime_id).cloned();
        let mut child = match handle.as_ref() {
            Some(handle) => Some(handle.child.lock().map_err(|_| {
                RouterServiceError::new(
                    "ROUTER_STATE_UNAVAILABLE",
                    "Native runtime child lock is poisoned.",
                )
            })?),
            None => None,
        };

        let recovery_record = recoverable_record_after_helper_removed(&current);
        records.insert(runtime_id.to_string(), recovery_record.clone());
        if let Err(error) =
            persist_native_runtime_state_to(&self.state_path, records.values().cloned().collect())
        {
            records.insert(runtime_id.to_string(), current);
            return Err(RouterServiceError::new("ROUTER_PERSIST_FAILED", error));
        }

        if let Some(handle) = handle.as_ref() {
            handle.alive.store(false, Ordering::SeqCst);
        }
        if let Some(child) = child.as_mut().and_then(|child| child.take()) {
            let _ = child.kill();
        }
        let removed_generation = handles.remove(runtime_id).map(|handle| handle.generation);
        drop(child);
        drop(handles);
        drop(records);
        if let (Some(manager), Some(generation)) = (self.router_manager.get(), removed_generation) {
            manager.unregister_generation(runtime_id, generation);
        }
        Ok(recovery_record)
    }

    fn stage_direct_restart_record(
        &self,
        runtime_id: &str,
        previous_revision: u64,
        direct_router: &SessionRouterRecord,
        recovery_record: &NativeSessionRecord,
    ) -> Result<(), RouterServiceError> {
        let mut records = self.records.lock().map_err(|_| {
            RouterServiceError::new(
                "ROUTER_STATE_UNAVAILABLE",
                "Native runtime record lock is poisoned.",
            )
        })?;
        let current = records.get(runtime_id).cloned().ok_or_else(|| {
            RouterServiceError::new(
                "ROUTER_SESSION_NOT_FOUND",
                format!("Native runtime {runtime_id} was not found."),
            )
        })?;
        let current_revision = current.router.as_ref().map(|router| router.revision);
        if current_revision != Some(previous_revision) {
            return Err(RouterServiceError::conflict(
                current
                    .router
                    .as_ref()
                    .map(SessionRouterState::from)
                    .ok_or_else(|| {
                        RouterServiceError::new(
                            "ROUTER_SESSION_UNAVAILABLE",
                            "This native session no longer has router state.",
                        )
                    })?,
            ));
        }
        let mut direct_record = current;
        direct_record.env_name = direct_router.default_env.clone();
        direct_record.router = Some(direct_router.clone());
        direct_record.status = "initializing".to_string();
        direct_record.is_active = true;
        direct_record.updated_at = Utc::now();
        direct_record.last_error = None;
        records.insert(runtime_id.to_string(), direct_record);
        if let Err(error) =
            persist_native_runtime_state_to(&self.state_path, records.values().cloned().collect())
        {
            records.insert(runtime_id.to_string(), recovery_record.clone());
            let rollback_result = persist_native_runtime_state_to(
                &self.state_path,
                records.values().cloned().collect(),
            );
            let error = match rollback_result {
                Ok(()) => error,
                Err(rollback_error) => {
                    format!("{error}; direct restart state rollback also failed: {rollback_error}")
                }
            };
            return Err(RouterServiceError::new("ROUTER_PERSIST_FAILED", error));
        }
        Ok(())
    }

    pub fn update_session_runtime_perm_mode(
        self: &Arc<Self>,
        app: &AppHandle,
        runtime_id: &str,
        runtime_perm_mode: Option<&str>,
    ) -> Result<(), String> {
        let _transition_guard = self
            .app_termination_lock
            .lock()
            .map_err(|_| "Failed to lock native runtime transition".to_string())?;
        self.reject_query_mutation_during_transition(runtime_id, "update permissions")?;
        let handle = self.ensure_handle(app.clone(), runtime_id)?;
        let display_perm_mode = {
            let record = handle
                .record
                .lock()
                .map_err(|_| "Failed to lock native session record".to_string())?;
            record.perm_mode.clone()
        };
        let normalized_runtime_perm_mode = runtime_perm_mode
            .map(|mode| mode.trim().to_string())
            .filter(|mode| !mode.is_empty() && mode != &display_perm_mode);
        let helper_perm_mode = effective_native_perm_mode(
            display_perm_mode.as_str(),
            normalized_runtime_perm_mode.as_deref(),
        )
        .to_string();
        let request_id = format!(
            "settings-{}-{}",
            runtime_id,
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );

        self.update_record(runtime_id, |record| {
            record.runtime_perm_mode = normalized_runtime_perm_mode.clone();
            record.updated_at = Utc::now();
        })?;
        notify_browser_policy_changed(app, runtime_id);

        self.write_to_child_with_reconnect(
            app,
            runtime_id,
            handle,
            &HelperInputCommand::UpdateSettings {
                request_id: &request_id,
                env_name: None,
                perm_mode: Some(&helper_perm_mode),
                env_vars: None,
                effort: None,
                force_restart: false,
            },
        )?;
        Ok(())
    }

    pub fn stop_session(self: &Arc<Self>, runtime_id: &str) -> Result<(), String> {
        self.stop_session_from(runtime_id, None)
    }

    pub fn stop_session_from(
        self: &Arc<Self>,
        runtime_id: &str,
        source: Option<&str>,
    ) -> Result<(), String> {
        self.stop_session_from_with_grace(runtime_id, source, NATIVE_STOP_GRACE_PERIOD)
    }

    fn stop_session_from_with_grace(
        self: &Arc<Self>,
        runtime_id: &str,
        source: Option<&str>,
        force_kill_grace: Duration,
    ) -> Result<(), String> {
        let mut errors = Vec::new();
        let _reconnect_guard = match self.reconnect_lock.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                errors.push("Native runtime reconnect coordinator was poisoned".to_string());
                poisoned.into_inner()
            }
        };
        let stop_source = normalize_stop_source(source);
        let (stop_status, provider) = match self.records.lock() {
            Ok(records) => records
                .get(runtime_id)
                .map(|record| (record.status.clone(), record.provider))
                .ok_or_else(|| format!("Native runtime {runtime_id} not found"))?,
            Err(poisoned) => {
                errors.push("Native runtime records were poisoned during stop".to_string());
                poisoned
                    .into_inner()
                    .get(runtime_id)
                    .map(|record| (record.status.clone(), record.provider))
                    .ok_or_else(|| format!("Native runtime {runtime_id} not found"))?
            }
        };
        let stop_handle = match self.handles.lock() {
            Ok(handles) => handles.get(runtime_id).cloned(),
            Err(poisoned) => {
                errors.push("Native runtime handles were poisoned during stop".to_string());
                poisoned.into_inner().get(runtime_id).cloned()
            }
        };
        let stop_handle_generation = stop_handle
            .as_ref()
            .map(|handle| handle.generation.to_string())
            .unwrap_or_else(|| "none".to_string());
        if let Err(error) = self.append_lifecycle_event(
            runtime_id,
            "stop_requested",
            format!(
                "Desktop workspace requested native runtime stop. source={stop_source} status={stop_status} handle_generation={stop_handle_generation}"
            ),
        ) {
            errors.push(error);
        }

        if provider == NativeProvider::Claude {
            if let Some(handle) = stop_handle {
                if let Err(error) = self.write_to_child(&handle, &HelperInputCommand::InterruptTurn)
                {
                    errors.push(error);
                } else if let Err(error) = self.append_lifecycle_event(
                    runtime_id,
                    "interrupt_written",
                    format!(
                        "Native helper generation {} accepted foreground interrupt command.",
                        handle.generation
                    ),
                ) {
                    errors.push(error);
                }
            } else {
                errors.push(format!(
                    "Native runtime {runtime_id} helper is not connected"
                ));
            }
            return if errors.is_empty() {
                Ok(())
            } else {
                Err(errors.join("; "))
            };
        }

        if let Err(error) = self.append_event(
            runtime_id,
            SessionEventPayload::SessionCompleted {
                reason: "Stopped from desktop workspace.".to_string(),
            },
        ) {
            errors.push(error);
        }
        let stop_handle = match self.request_child_stop(runtime_id, false) {
            Ok(handle) => handle,
            Err(error) => {
                errors.push(error);
                None
            }
        };
        if let Some(handle) = stop_handle {
            if let Err(error) = self.update_record(runtime_id, |record| {
                record.status = "interrupted".to_string();
                record.updated_at = Utc::now();
            }) {
                errors.push(error);
            }
            // Once Stop has been written and the generation is non-live, cleanup must be
            // scheduled even when state persistence or telemetry failed above.
            self.schedule_force_kill_after(runtime_id.to_string(), handle, force_kill_grace);
        } else {
            // Hard stop — Stop could not be delivered. State persistence is best-effort, but
            // exact-generation process cleanup is mandatory.
            if let Err(error) = self.update_record(runtime_id, |record| {
                record.status = "stopped".to_string();
                record.is_active = false;
                record.updated_at = Utc::now();
            }) {
                errors.push(error);
            }
            if let Err(error) = self.retire_current_handle_locked(runtime_id) {
                errors.push(error);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    pub fn reconcile_stale_records(&self) -> Result<usize, String> {
        let live_runtime_ids = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .keys()
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        let mut changed = 0;
        let now = Utc::now();

        let mut records = self
            .records
            .lock()
            .map_err(|_| "Failed to lock native runtime records".to_string())?;

        for record in records.values_mut() {
            if record.pending_settings_request_id.is_some() {
                record.pending_env_name = None;
                record.pending_effort = None;
                record.pending_settings_request_id = None;
                record.last_error = Some(
                    "Deferred Claude settings were not applied because the desktop runtime restarted."
                        .to_string(),
                );
                record.updated_at = now;
                changed += 1;
            }
            if live_runtime_ids.contains(&record.runtime_id) {
                continue;
            }
            if !record.is_active || is_native_terminal_status(&record.status) {
                continue;
            }

            if record.status == "idle" {
                record.is_active = false;
                record.updated_at = now;
                changed += 1;
                continue;
            }

            record.status = "interrupted".to_string();
            record.is_active = false;
            record.updated_at = now;
            if record.last_error.is_none() {
                record.last_error = Some(
                    "Native runtime was interrupted because the desktop app restarted.".to_string(),
                );
            }
            changed += 1;
        }

        if changed > 0 {
            persist_native_runtime_state_to(&self.state_path, records.values().cloned().collect())?;
        }

        Ok(changed)
    }

    pub fn handoff_to_terminal(
        &self,
        runtime_id: &str,
        terminal_type: Option<TerminalType>,
        allow_background_task_termination: bool,
    ) -> Result<NativeHandoffResult, String> {
        let _transition_guard = self
            .app_termination_lock
            .lock()
            .map_err(|_| "Failed to lock native runtime transition".to_string())?;
        if self.app_termination_in_progress.load(Ordering::SeqCst) {
            return Err("CCEM is already closing native runtimes.".to_string());
        }
        let _reconnect_guard = self
            .reconnect_lock
            .lock()
            .map_err(|_| "Failed to lock native runtime reconnect coordinator".to_string())?;
        if !terminal::external_terminal_launch_supported() {
            return Err(
                "Terminal handoff is not available on this platform; continue in the native workspace runtime.".to_string(),
            );
        }

        self.reject_background_task_termination(
            runtime_id,
            "handoff this session",
            allow_background_task_termination,
        )?;

        let handle = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(runtime_id)
            .cloned();

        let record = if let Some(handle) = handle.as_ref() {
            handle
                .record
                .lock()
                .map_err(|_| "Failed to lock native session record".to_string())?
                .clone()
        } else {
            self.records
                .lock()
                .map_err(|_| "Failed to lock native runtime records".to_string())?
                .get(runtime_id)
                .cloned()
                .ok_or_else(|| format!("Native runtime {} not found", runtime_id))?
        };
        if record.is_active && !native_status_allows_file_rewind(&record.status) {
            return Err(
                "Finish the current foreground turn before continuing this session in Terminal."
                    .to_string(),
            );
        }

        let terminal = terminal_type.unwrap_or_else(terminal::get_preferred_terminal);
        self.append_lifecycle_event(
            runtime_id,
            "handoff_requested",
            format!(
                "Terminal handoff requested for {} in {}.",
                record.provider.as_str(),
                terminal.display_name()
            ),
        )?;

        let preparation_id = format!(
            "pending-terminal-handoff-{}-{}",
            runtime_id,
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        self.terminal_handoff_preparations
            .lock()
            .map_err(|_| "Failed to lock native terminal handoff state".to_string())?
            .insert(runtime_id.to_string(), preparation_id.clone());

        if record.provider_session_id.is_some() {
            let prepare_result = match self.request_child_prepare_stop(
                runtime_id,
                &preparation_id,
                true,
                allow_background_task_termination,
                true,
            ) {
                Ok(Some(handle)) => self.await_child_prepare_stop(
                    runtime_id,
                    &preparation_id,
                    &handle,
                    allow_background_task_termination,
                ),
                Ok(None) => Ok(()),
                Err(error) => Err(error),
            };
            if let Err(error) = prepare_result {
                self.cancel_terminal_handoff_preparation(runtime_id, Some(&preparation_id));
                return Err(error);
            }
            let result =
                self.complete_terminal_handoff(record, terminal, allow_background_task_termination);
            if let Err(error) = result {
                self.fail_pending_terminal_handoff(runtime_id, &preparation_id, &error)?;
                return Err(error);
            }
            self.terminal_handoff_preparations
                .lock()
                .map_err(|_| "Failed to lock native terminal handoff state".to_string())?
                .remove(runtime_id);
            return Ok(NativeHandoffResult {
                status: NativeHandoffStatus::Opened,
            });
        }

        self.update_record(runtime_id, |entry| {
            entry.status = "handoff_pending".to_string();
            entry.is_active = true;
            entry.updated_at = Utc::now();
            entry.can_handoff_to_terminal = true;
            entry.pending_handoff_terminal = Some(terminal);
            entry.pending_handoff_allow_background_task_termination =
                allow_background_task_termination;
            entry.last_error = None;
        })?;
        self.append_event(
            runtime_id,
            SessionEventPayload::Lifecycle {
                stage: "handoff_pending".to_string(),
                detail: format!(
                    "Terminal handoff will open in {} when the provider session id is ready.",
                    terminal.display_name()
                ),
            },
        )?;
        Ok(NativeHandoffResult {
            status: NativeHandoffStatus::Pending,
        })
    }

    fn prepare_terminal_handoff(
        &self,
        runtime_id: &str,
        terminal_type: Option<TerminalType>,
        allow_background_task_termination: bool,
    ) -> Result<NativeTerminalHandoff, String> {
        let _transition_guard = self
            .app_termination_lock
            .lock()
            .map_err(|_| "Failed to lock native runtime transition".to_string())?;
        if self.app_termination_in_progress.load(Ordering::SeqCst) {
            return Err("CCEM is already closing native runtimes.".to_string());
        }
        if !terminal::external_terminal_launch_supported() {
            return Err(
                "Terminal handoff is not available on this platform; continue in the native workspace runtime.".to_string(),
            );
        }

        self.reject_background_task_termination(
            runtime_id,
            "handoff this session",
            allow_background_task_termination,
        )?;

        let terminal = terminal_type.unwrap_or_else(terminal::get_preferred_terminal);
        let record = self.current_record(runtime_id)?;
        let resume_session_id = record
            .provider_session_id
            .clone()
            .ok_or_else(|| "Session id is not ready for terminal handoff yet".to_string())?;
        let mut env_vars = self.terminal_env_vars_for_record(&record)?;
        inject_ccem_runtime_env(&mut env_vars, &record.runtime_id);
        let preparation_id = format!(
            "terminal-handoff-{}-{}",
            runtime_id,
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        if let Some(handle) = self.request_child_prepare_stop(
            runtime_id,
            &preparation_id,
            true,
            allow_background_task_termination,
            false,
        )? {
            if let Err(error) = self.await_child_prepare_stop(
                runtime_id,
                &preparation_id,
                &handle,
                allow_background_task_termination,
            ) {
                self.cancel_child_prepare_stop(runtime_id, &preparation_id);
                return Err(error);
            }
        } else if record.is_active && !native_status_allows_file_rewind(&record.status) {
            return Err(
                "Finish the current foreground turn before continuing this session in Terminal."
                    .to_string(),
            );
        }
        self.terminal_handoff_preparations
            .lock()
            .map_err(|_| "Failed to lock native terminal handoff state".to_string())?
            .insert(runtime_id.to_string(), preparation_id.clone());

        Ok(NativeTerminalHandoff {
            runtime_id: record.runtime_id.clone(),
            provider: record.provider,
            env_name: record.env_name.clone(),
            perm_mode: effective_native_perm_mode(
                record.perm_mode.as_str(),
                record.runtime_perm_mode.as_deref(),
            )
            .to_string(),
            project_dir: record.project_dir.clone(),
            resume_session_id,
            terminal,
            env_vars,
            allow_background_task_termination,
            preparation_id: Some(preparation_id),
        })
    }

    pub fn run_managed_terminal_handoff<T>(
        &self,
        runtime_id: &str,
        terminal_type: Option<TerminalType>,
        allow_background_task_termination: bool,
        launch: impl FnOnce(&NativeTerminalHandoff) -> Result<T, String>,
        cleanup: impl FnOnce(&T),
    ) -> Result<(NativeTerminalHandoff, T), String> {
        let _reconnect_guard = self
            .reconnect_lock
            .lock()
            .map_err(|_| "Failed to lock native runtime reconnect coordinator".to_string())?;
        let handoff = self.prepare_terminal_handoff(
            runtime_id,
            terminal_type,
            allow_background_task_termination,
        )?;
        let frozen_handle = self.freeze_current_handle_for_handoff(runtime_id)?;
        let launched = match launch(&handoff) {
            Ok(launched) => launched,
            Err(launch_error) => {
                self.cancel_terminal_handoff_preparation(
                    runtime_id,
                    handoff.preparation_id.as_deref(),
                );
                if let Some(handle) = frozen_handle.as_ref() {
                    handle.alive.store(true, Ordering::SeqCst);
                }
                return Err(launch_error);
            }
        };

        if let Err(error) = self.complete_managed_terminal_handoff(
            runtime_id,
            handoff.terminal,
            handoff.allow_background_task_termination,
            handoff.preparation_id.as_deref(),
        ) {
            cleanup(&launched);
            if let Some(handle) = frozen_handle.as_ref() {
                if self.is_current_handle(runtime_id, handle).unwrap_or(false) {
                    handle.alive.store(true, Ordering::SeqCst);
                }
            }
            return Err(error);
        }
        Ok((handoff, launched))
    }

    pub fn cancel_terminal_handoff_preparation(
        &self,
        runtime_id: &str,
        preparation_id: Option<&str>,
    ) {
        let removed = self
            .terminal_handoff_preparations
            .lock()
            .ok()
            .and_then(|mut preparations| preparations.remove(runtime_id));
        if let Some(request_id) = preparation_id.or(removed.as_deref()) {
            self.cancel_child_prepare_stop(runtime_id, request_id);
        }
    }

    fn fail_pending_terminal_handoff(
        &self,
        runtime_id: &str,
        preparation_id: &str,
        error: &str,
    ) -> Result<(), String> {
        self.cancel_terminal_handoff_preparation(runtime_id, Some(preparation_id));
        self.update_record(runtime_id, |record| {
            if record.status == "handoff_pending" || record.status == "handoff_finalizing" {
                record.status = "ready".to_string();
                record.is_active = true;
            }
            record.updated_at = Utc::now();
            record.pending_handoff_terminal = None;
            record.pending_handoff_allow_background_task_termination = false;
            record.last_error = Some(error.to_string());
        })?;
        self.append_event(
            runtime_id,
            SessionEventPayload::StdErrLine {
                line: format!("Terminal handoff failed: {}", error),
            },
        )
    }

    pub fn complete_managed_terminal_handoff(
        &self,
        runtime_id: &str,
        terminal: TerminalType,
        allow_background_task_termination: bool,
        preparation_id: Option<&str>,
    ) -> Result<(), String> {
        let record = self.current_record(runtime_id)?;
        let expected_preparation = self
            .terminal_handoff_preparations
            .lock()
            .map_err(|_| "Failed to lock native terminal handoff state".to_string())?
            .get(runtime_id)
            .cloned();
        if expected_preparation.as_deref() != preparation_id {
            return Err("Terminal handoff preparation is no longer current.".to_string());
        }
        let preparation_id =
            preparation_id.ok_or_else(|| "Terminal handoff preparation is missing.".to_string())?;
        if let Some(handle) = self.request_child_prepare_stop(
            runtime_id,
            preparation_id,
            true,
            allow_background_task_termination,
            true,
        )? {
            if let Err(error) = self.await_child_prepare_stop(
                runtime_id,
                preparation_id,
                &handle,
                allow_background_task_termination,
            ) {
                self.cancel_terminal_handoff_preparation(runtime_id, Some(preparation_id));
                return Err(error);
            }
        } else {
            let latest_record = self.current_record(runtime_id)?;
            if latest_record.is_active && !native_status_allows_file_rewind(&latest_record.status) {
                self.cancel_terminal_handoff_preparation(runtime_id, Some(preparation_id));
                return Err(
                    "Finish the current foreground turn before continuing this session in Terminal."
                        .to_string(),
                );
            }
        }
        if let Err(error) = self.reject_background_task_termination(
            runtime_id,
            "handoff this session",
            allow_background_task_termination,
        ) {
            self.cancel_terminal_handoff_preparation(runtime_id, Some(preparation_id));
            return Err(error);
        }
        self.update_record(runtime_id, |entry| {
            entry.status = "handoff_closing".to_string();
            entry.updated_at = Utc::now();
        })?;
        if let Err(error) = self.shutdown_child(runtime_id, allow_background_task_termination) {
            self.cancel_terminal_handoff_preparation(runtime_id, Some(preparation_id));
            self.update_record(runtime_id, |entry| {
                entry.status = record.status.clone();
                entry.is_active = record.is_active;
                entry.updated_at = Utc::now();
                entry.last_error = Some(error.clone());
            })?;
            return Err(error);
        }
        self.update_record(runtime_id, |entry| {
            entry.status = "handoff".to_string();
            entry.is_active = false;
            entry.updated_at = Utc::now();
            entry.can_handoff_to_terminal = true;
            entry.pending_handoff_terminal = None;
            entry.pending_handoff_allow_background_task_termination = false;
        })?;
        self.append_event(
            runtime_id,
            SessionEventPayload::Lifecycle {
                stage: "handoff".to_string(),
                detail: format!(
                    "Opened {} session in {}.",
                    record.provider.as_str(),
                    terminal.display_name()
                ),
            },
        )?;
        self.remove_handle(runtime_id)?;
        self.terminal_handoff_preparations
            .lock()
            .map_err(|_| "Failed to lock native terminal handoff state".to_string())?
            .remove(runtime_id);
        Ok(())
    }

    fn current_record(&self, runtime_id: &str) -> Result<NativeSessionRecord, String> {
        let handle = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(runtime_id)
            .cloned();

        if let Some(handle) = handle {
            return handle
                .record
                .lock()
                .map_err(|_| "Failed to lock native session record".to_string())
                .map(|record| record.clone());
        }

        self.records
            .lock()
            .map_err(|_| "Failed to lock native runtime records".to_string())?
            .get(runtime_id)
            .cloned()
            .ok_or_else(|| format!("Native runtime {} not found", runtime_id))
    }

    fn reject_query_mutation_during_transition(
        &self,
        runtime_id: &str,
        action: &str,
    ) -> Result<(), String> {
        if self.app_termination_in_progress.load(Ordering::SeqCst) {
            return Err(format!(
                "Cannot {action} while CCEM is closing native runtimes."
            ));
        }
        if self
            .terminal_handoff_preparations
            .lock()
            .map_err(|_| "Failed to lock native terminal handoff state".to_string())?
            .contains_key(runtime_id)
        {
            return Err(format!(
                "Cannot {action} while this native session is preparing to continue in Terminal."
            ));
        }
        let status = self
            .records
            .lock()
            .map_err(|_| "Failed to lock native runtime records".to_string())?
            .get(runtime_id)
            .map(|record| record.status.clone())
            .ok_or_else(|| format!("Native runtime {runtime_id} not found"))?;
        if is_query_mutation_terminal_status(&status) || status.starts_with("handoff_") {
            return Err(format!(
                "Cannot {action} while native session {runtime_id} is {status}."
            ));
        }
        Ok(())
    }

    fn terminal_env_vars_for_record(
        &self,
        record: &NativeSessionRecord,
    ) -> Result<HashMap<String, String>, String> {
        let handle = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(&record.runtime_id)
            .cloned();

        if let Some(handle) = handle {
            return Ok(handle.terminal_env_vars.clone());
        }

        build_runtime_bootstrap_options(record).map(|options| options.terminal_env_vars)
    }

    fn complete_terminal_handoff(
        &self,
        record: NativeSessionRecord,
        terminal: TerminalType,
        allow_background_task_termination: bool,
    ) -> Result<(), String> {
        let runtime_id = record.runtime_id.clone();
        let provider_session_id = record
            .provider_session_id
            .clone()
            .ok_or_else(|| "Session id is not ready for terminal handoff yet".to_string())?;
        self.reject_background_task_termination(
            &runtime_id,
            "handoff this session",
            allow_background_task_termination,
        )?;

        let mut env_vars = self.terminal_env_vars_for_record(&record)?;
        inject_ccem_runtime_env(&mut env_vars, &runtime_id);
        let frozen_handle = self.freeze_current_handle_for_handoff(&runtime_id)?;

        self.update_record(&runtime_id, |entry| {
            entry.status = "handoff_closing".to_string();
            entry.updated_at = Utc::now();
        })?;
        if let Err(error) = self.shutdown_child(&runtime_id, allow_background_task_termination) {
            self.update_record(&runtime_id, |entry| {
                entry.status = record.status.clone();
                entry.is_active = record.is_active;
                entry.updated_at = Utc::now();
                entry.last_error = Some(error.clone());
            })?;
            return Err(error);
        }

        if let Err(error) = launch_terminal_for_native_handoff(
            terminal,
            env_vars,
            &record.project_dir,
            &runtime_id,
            &record.env_name,
            Some(effective_native_perm_mode(
                record.perm_mode.as_str(),
                record.runtime_perm_mode.as_deref(),
            )),
            Some(provider_session_id.as_str()),
            record.provider.as_str(),
        ) {
            let cleanup_errors =
                self.finish_failed_terminal_handoff(&runtime_id, frozen_handle.as_ref(), &error);
            if !cleanup_errors.is_empty() {
                eprintln!(
                    "Terminal handoff launch for {runtime_id} failed with cleanup warnings: {}",
                    cleanup_errors.join("; ")
                );
            }
            return Err(error);
        }

        let mut warnings = self.finish_terminal_handoff_metadata_after_launch(
            &runtime_id,
            record.provider.as_str(),
            terminal,
        );
        if let Some(handle) = frozen_handle.as_ref() {
            if let Err(error) = self.retire_handle_if_current(&runtime_id, handle) {
                warnings.push(error);
            }
        }
        if !warnings.is_empty() {
            eprintln!(
                "Terminal handoff for {runtime_id} opened with cleanup warnings: {}",
                warnings.join("; ")
            );
        }
        // Launch is the irreversible commit boundary. Finalization warnings must not be reported
        // as a retryable launch failure or the caller can reopen a duplicate terminal session.
        Ok(())
    }

    /// Complete a terminal handoff after the new terminal is already open.
    ///
    /// The caller owns the reconnect coordinator. Metadata is best-effort at this commit boundary:
    /// every failure is reported, but none may leave the old native helper generation alive.
    fn finish_terminal_handoff_metadata_after_launch(
        &self,
        runtime_id: &str,
        provider: &str,
        terminal: TerminalType,
    ) -> Vec<String> {
        let mut errors = Vec::new();
        if let Err(error) = self.update_record(runtime_id, |entry| {
            entry.status = "handoff".to_string();
            entry.is_active = false;
            entry.updated_at = Utc::now();
            entry.can_handoff_to_terminal = true;
            entry.pending_handoff_terminal = None;
            entry.pending_handoff_allow_background_task_termination = false;
        }) {
            errors.push(error);
        }
        if let Err(error) = self.append_event(
            runtime_id,
            SessionEventPayload::Lifecycle {
                stage: "handoff".to_string(),
                detail: format!(
                    "Opened {} session in {}.",
                    provider,
                    terminal.display_name()
                ),
            },
        ) {
            errors.push(error);
        }
        errors
    }

    fn freeze_current_handle_for_handoff(
        &self,
        runtime_id: &str,
    ) -> Result<Option<Arc<NativeSessionHandle>>, String> {
        let handles = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?;
        let Some(handle) = handles.get(runtime_id).cloned() else {
            return Ok(None);
        };
        let _child = handle
            .child
            .lock()
            .map_err(|_| "Failed to lock native sidecar child".to_string())?;
        handle.alive.store(false, Ordering::SeqCst);
        drop(_child);
        drop(handles);
        Ok(Some(handle))
    }

    fn finish_failed_terminal_handoff(
        &self,
        runtime_id: &str,
        frozen_handle: Option<&Arc<NativeSessionHandle>>,
        launch_error: &str,
    ) -> Vec<String> {
        let mut errors = Vec::new();
        if let Err(error) = self.update_record(runtime_id, |record| {
            record.status = "interrupted".to_string();
            record.is_active = false;
            record.pending_handoff_terminal = None;
            record.pending_handoff_allow_background_task_termination = false;
            record.updated_at = Utc::now();
            record.last_error = Some(launch_error.to_string());
        }) {
            errors.push(error);
        }
        if let Err(error) = self.append_lifecycle_event(
            runtime_id,
            "handoff_failed",
            format!("Failed to open terminal session: {launch_error}"),
        ) {
            errors.push(error);
        }
        if let Some(handle) = frozen_handle {
            if let Err(error) = self.retire_handle_if_current(runtime_id, handle) {
                errors.push(error);
            }
        }
        errors
    }

    fn ensure_handle(
        self: &Arc<Self>,
        app: AppHandle,
        runtime_id: &str,
    ) -> Result<Arc<NativeSessionHandle>, String> {
        if let Some(handle) = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(runtime_id)
            .cloned()
        {
            if handle.alive.load(Ordering::SeqCst) {
                return Ok(handle);
            }
        }

        let _reconnect_guard = self
            .reconnect_lock
            .lock()
            .map_err(|_| "Failed to lock native runtime reconnect coordinator".to_string())?;
        if let Some(handle) = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(runtime_id)
            .cloned()
        {
            if handle.alive.load(Ordering::SeqCst) {
                return Ok(handle);
            }
            self.retire_handle_if_current(runtime_id, &handle)?;
        }

        self.reconnect_handle_locked(app, runtime_id, false)
    }

    fn reconnect_handle_locked(
        self: &Arc<Self>,
        app: AppHandle,
        runtime_id: &str,
        force_direct: bool,
    ) -> Result<Arc<NativeSessionHandle>, String> {
        self.reconnect_handle_locked_from_baseline(app, runtime_id, force_direct, None)
    }

    fn reconnect_handle_locked_from_baseline(
        self: &Arc<Self>,
        app: AppHandle,
        runtime_id: &str,
        force_direct: bool,
        rollback_record: Option<&NativeSessionRecord>,
    ) -> Result<Arc<NativeSessionHandle>, String> {
        let rollback_record = rollback_record.map(recoverable_record_after_helper_removed);
        let (handle, options) = self.prepare_reconnect_handle_locked(
            runtime_id,
            force_direct,
            rollback_record.as_ref(),
        )?;
        let launch_result = self
            .append_event(
                runtime_id,
                SessionEventPayload::Lifecycle {
                    stage: "runtime_resume".to_string(),
                    detail: format!(
                        "Reconnected native runtime helper with generation {}.",
                        handle.generation
                    ),
                },
            )
            .and_then(|_| self.spawn_helper(app, runtime_id, &options, handle.clone()));
        if let Err(error) = launch_result {
            let _ = self.kill_child(runtime_id);
            let _ = self.remove_handle(runtime_id);
            if let Some(rollback_record) = rollback_record.as_ref() {
                let _ = self.rollback_reconnect_failure(runtime_id, rollback_record, error.clone());
            } else {
                let failure = error.clone();
                let _ = self.update_record(runtime_id, |record| {
                    record.status = "interrupted".to_string();
                    record.is_active = false;
                    record.updated_at = Utc::now();
                    record.last_error = Some(failure);
                });
            }
            return Err(error);
        }
        Ok(handle)
    }

    fn prepare_reconnect_handle_locked(
        self: &Arc<Self>,
        runtime_id: &str,
        force_direct: bool,
        rollback_record: Option<&NativeSessionRecord>,
    ) -> Result<(Arc<NativeSessionHandle>, NativeSessionOptions), String> {
        let mut record = self
            .records
            .lock()
            .map_err(|_| "Failed to lock native runtime records".to_string())?
            .get(runtime_id)
            .cloned()
            .ok_or_else(|| format!("Native runtime {} not found", runtime_id))?;
        let rollback_record = rollback_record
            .map(recoverable_record_after_helper_removed)
            .unwrap_or_else(|| record.clone());
        if rollback_record.runtime_id != runtime_id {
            return Err(format!(
                "Reconnect rollback record {} does not match runtime {}",
                rollback_record.runtime_id, runtime_id
            ));
        }

        reactivate_record_for_reconnect(&mut record);

        let mut options = build_runtime_bootstrap_options(&record).map_err(|error| {
            self.rollback_reconnect_failure(runtime_id, &rollback_record, error)
        })?;
        let prepare_result = if force_direct {
            self.prepare_explicit_direct_launch(&mut options)
        } else {
            self.prepare_router_launch(&mut options, true)
        };
        if let Err(error) = prepare_result {
            return Err(self.rollback_reconnect_failure(runtime_id, &rollback_record, error));
        }
        record.router = options.router_record.clone();

        let start_seq = self
            .event_log
            .newest_seq(runtime_id)
            .unwrap_or(None)
            .map(|seq| seq + 1)
            .unwrap_or(1);

        let handle = Arc::new(NativeSessionHandle {
            generation: self.allocate_handle_generation(),
            record: Mutex::new(record.clone()),
            child: Mutex::new(None),
            events: Mutex::new(SessionStore::with_start_seq(
                runtime_id.to_string(),
                start_seq,
            )),
            background_tasks: Mutex::new(HashMap::new()),
            terminal_background_task_ids: Mutex::new(HashSet::new()),
            background_tool_use_ids: Mutex::new(HashSet::new()),
            completed_background_tool_use_ids: Mutex::new(HashSet::new()),
            pending_background_task_stops: Mutex::new(HashMap::new()),
            teardown_preparations: Mutex::new(HashMap::new()),
            helper_env_vars: options.helper_env_vars.clone(),
            terminal_env_vars: options.terminal_env_vars.clone(),
            claude_path: options.claude_path.clone(),
            codex_path: options.codex_path.clone(),
            codex_base_url: options.codex_base_url.clone(),
            codex_api_key: options.codex_api_key.clone(),
            alive: AtomicBool::new(true),
        });

        self.persist_prepared_reconnect_record(runtime_id, &record, &rollback_record)?;

        if let (Some(manager), Some(router)) = (
            self.router_manager.get(),
            record
                .router
                .as_ref()
                .filter(|router| router.launch_transport == LaunchTransport::Routed),
        ) {
            if let Err(error) = manager.register(runtime_id, handle.generation, router.clone()) {
                manager.unregister_generation(runtime_id, handle.generation);
                return Err(self.rollback_reconnect_failure(
                    runtime_id,
                    &rollback_record,
                    error.to_string(),
                ));
            }
        }

        if let Err(error) = self.insert_handle(runtime_id.to_string(), handle.clone()) {
            if let Some(manager) = self.router_manager.get() {
                manager.unregister_generation(runtime_id, handle.generation);
            }
            return Err(self.rollback_reconnect_failure(runtime_id, &rollback_record, error));
        }
        Ok((handle, options))
    }

    fn persist_prepared_reconnect_record(
        &self,
        runtime_id: &str,
        record: &NativeSessionRecord,
        rollback_record: &NativeSessionRecord,
    ) -> Result<(), String> {
        let mut records = self
            .records
            .lock()
            .map_err(|_| "Failed to lock native runtime records".to_string())?;
        if !records.contains_key(runtime_id) {
            return Err(format!("Native runtime {} not found", runtime_id));
        }
        records.insert(runtime_id.to_string(), record.clone());
        if let Err(error) =
            persist_native_runtime_state_to(&self.state_path, records.values().cloned().collect())
        {
            records.insert(runtime_id.to_string(), rollback_record.clone());
            let rollback_result = persist_native_runtime_state_to(
                &self.state_path,
                records.values().cloned().collect(),
            );
            return Err(match rollback_result {
                Ok(()) => error,
                Err(rollback_error) => {
                    format!("{error}; reconnect state rollback also failed: {rollback_error}")
                }
            });
        }
        Ok(())
    }

    fn rollback_reconnect_failure(
        &self,
        runtime_id: &str,
        rollback_record: &NativeSessionRecord,
        error: String,
    ) -> String {
        let rollback_result = (|| {
            let mut records = self
                .records
                .lock()
                .map_err(|_| "Failed to lock native runtime records".to_string())?;
            if !records.contains_key(runtime_id) {
                return Err(format!("Native runtime {} not found", runtime_id));
            }
            records.insert(runtime_id.to_string(), rollback_record.clone());
            persist_native_runtime_state_to(&self.state_path, records.values().cloned().collect())
        })();
        match rollback_result {
            Ok(()) => error,
            Err(rollback_error) => {
                format!("{error}; reconnect state rollback also failed: {rollback_error}")
            }
        }
    }

    fn spawn_helper(
        self: &Arc<Self>,
        app: AppHandle,
        runtime_id: &str,
        options: &NativeSessionOptions,
        handle: Arc<NativeSessionHandle>,
    ) -> Result<(), String> {
        let todo_snapshot_seed = self.event_log.latest_todo_snapshot(runtime_id)?;
        let helper_router_init = options
            .router_record
            .as_ref()
            .filter(|router| router.launch_transport == LaunchTransport::Routed)
            .map(build_helper_router_init);
        let helper_path = native_helper_script_path(&app)?;
        let command = app
            .shell()
            .sidecar("ccem-node")
            .map_err(|error| format!("Failed to resolve Node sidecar: {}", error))?
            .arg(helper_path.to_string_lossy().to_string())
            .current_dir(&options.working_dir);

        let (mut rx, child) = spawn_native_helper_process(command.into())?;

        {
            let mut child_slot = handle
                .child
                .lock()
                .map_err(|_| "Failed to lock native sidecar child".to_string())?;
            *child_slot = Some(child);
        }

        self.write_to_child(
            &handle,
            &HelperInputCommand::Init {
                provider: options.provider.as_str(),
                env_name: &options.env_name,
                perm_mode: effective_native_perm_mode(
                    options.perm_mode.as_str(),
                    options.runtime_perm_mode.as_deref(),
                ),
                allow_dangerously_skip_permissions:
                    native_session_allows_dangerously_skip_permissions(options),
                working_dir: &options.working_dir,
                env_vars: &handle.helper_env_vars,
                initial_prompt: options.initial_prompt.as_deref(),
                initial_images: options.initial_images.as_deref(),
                provider_session_id: options.provider_session_id.as_deref(),
                claude_path: handle.claude_path.as_deref(),
                codex_path: handle.codex_path.as_deref(),
                codex_base_url: handle.codex_base_url.as_deref(),
                codex_api_key: handle.codex_api_key.as_deref(),
                effort: options.effort.as_deref(),
                todo_snapshot_seed: todo_snapshot_seed.as_ref(),
                router: helper_router_init.as_ref(),
            },
        )?;

        let manager = self.clone();
        let runtime = runtime_id.to_string();
        let event_handle = handle.clone();
        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut stdout_buffer = Vec::new();
            let mut stderr_buffer = Vec::new();
            while let Some(event) = rx.recv().await {
                if !manager
                    .is_current_handle(&runtime, &event_handle)
                    .unwrap_or(false)
                {
                    break;
                }

                match event {
                    CommandEvent::Stdout(line) => {
                        for text in drain_helper_output_lines(&mut stdout_buffer, &line) {
                            if let Err(error) = manager.process_helper_stdout_if_current(
                                Some(&app_handle),
                                &runtime,
                                &text,
                                &event_handle,
                            ) {
                                let _ = manager.append_event_if_current(
                                    &runtime,
                                    SessionEventPayload::StdErrLine {
                                        line: format!("Failed to process helper output: {}", error),
                                    },
                                    &event_handle,
                                );
                            }
                        }
                    }
                    CommandEvent::Stderr(line) => {
                        for text in drain_helper_output_lines(&mut stderr_buffer, &line) {
                            let _ = manager.append_event_if_current(
                                &runtime,
                                SessionEventPayload::StdErrLine { line: text },
                                &event_handle,
                            );
                        }
                    }
                    CommandEvent::Error(error) => {
                        manager.flush_helper_output_buffers(
                            Some(&app_handle),
                            &runtime,
                            &mut stdout_buffer,
                            &mut stderr_buffer,
                            &event_handle,
                        );
                        if let Err(event_error) = manager.append_event_if_current(
                            &runtime,
                            SessionEventPayload::StdErrLine {
                                line: format!("Native sidecar error: {}", error),
                            },
                            &event_handle,
                        ) {
                            eprintln!(
                                "Failed to append native sidecar error for {runtime}: {event_error}"
                            );
                        }
                        if let Err(exit_error) =
                            manager.mark_process_exit(&runtime, Some(1), &event_handle)
                        {
                            eprintln!(
                                "Failed to finalize native sidecar error for {runtime}: {exit_error}"
                            );
                        }
                        break;
                    }
                    CommandEvent::Terminated(payload) => {
                        manager.flush_helper_output_buffers(
                            Some(&app_handle),
                            &runtime,
                            &mut stdout_buffer,
                            &mut stderr_buffer,
                            &event_handle,
                        );
                        if let Err(error) =
                            manager.mark_process_exit(&runtime, payload.code, &event_handle)
                        {
                            eprintln!(
                                "Failed to finalize native sidecar termination for {runtime}: {error}"
                            );
                        }
                        break;
                    }
                    _ => {}
                }
            }
        });

        Ok(())
    }

    fn process_helper_stdout(&self, runtime_id: &str, line: &str) -> Result<(), String> {
        self.process_helper_stdout_with_app(None, runtime_id, line)
    }

    fn process_helper_stdout_if_current(
        &self,
        app: Option<&AppHandle>,
        runtime_id: &str,
        line: &str,
        handle: &Arc<NativeSessionHandle>,
    ) -> Result<(), String> {
        let _reconnect_guard = self
            .reconnect_lock
            .lock()
            .map_err(|_| "Failed to lock native runtime reconnect coordinator".to_string())?;
        if !self.is_current_handle(runtime_id, handle)? {
            return Ok(());
        }
        self.process_helper_stdout_with_app(app, runtime_id, line)
    }

    fn process_helper_stdout_with_app(
        &self,
        app: Option<&AppHandle>,
        runtime_id: &str,
        line: &str,
    ) -> Result<(), String> {
        let mut processed = false;
        for entry in line
            .lines()
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
        {
            processed = true;
            self.process_helper_stdout_line(app, runtime_id, entry)?;
        }
        if !processed {
            return Ok(());
        }
        Ok(())
    }

    fn process_helper_stdout_line(
        &self,
        app: Option<&AppHandle>,
        runtime_id: &str,
        line: &str,
    ) -> Result<(), String> {
        let output: HelperOutputEvent = serde_json::from_str(line)
            .map_err(|error| format!("Failed to parse helper event JSON: {}", error))?;

        match output {
            HelperOutputEvent::SessionMeta {
                provider_session_id,
            } => {
                let mut pending_handoff_terminal = None;
                let mut pending_handoff_allow_background_task_termination = false;
                let provider = self
                    .records
                    .lock()
                    .map_err(|_| "Failed to lock native runtime records".to_string())?
                    .get(runtime_id)
                    .map(|record| record.provider)
                    .ok_or_else(|| format!("Native runtime {} not found", runtime_id))?;

                self.update_record(runtime_id, |record| {
                    record.provider_session_id = Some(provider_session_id.clone());
                    record.can_handoff_to_terminal = terminal::external_terminal_launch_supported();
                    pending_handoff_terminal = record.pending_handoff_terminal;
                    pending_handoff_allow_background_task_termination =
                        record.pending_handoff_allow_background_task_termination;
                    record.updated_at = Utc::now();
                })?;

                if let Err(error) =
                    bind_source_session_id(provider.as_str(), runtime_id, &provider_session_id)
                {
                    eprintln!(
                        "Failed to bind native runtime {} to provider session {}: {}",
                        runtime_id, provider_session_id, error
                    );
                }

                if let Some(terminal) = pending_handoff_terminal {
                    let preparation_id = {
                        let mut preparations =
                            self.terminal_handoff_preparations.lock().map_err(|_| {
                                "Failed to lock native terminal handoff state".to_string()
                            })?;
                        preparations
                            .entry(runtime_id.to_string())
                            .or_insert_with(|| {
                                format!(
                                    "pending-terminal-handoff-{}-{}",
                                    runtime_id,
                                    Utc::now().timestamp_nanos_opt().unwrap_or_default()
                                )
                            })
                            .clone()
                    };
                    match self.request_child_prepare_stop(
                        runtime_id,
                        &preparation_id,
                        true,
                        pending_handoff_allow_background_task_termination,
                        true,
                    ) {
                        Ok(Some(_)) => {
                            self.update_record(runtime_id, |record| {
                                record.status = "handoff_finalizing".to_string();
                                record.updated_at = Utc::now();
                            })?;
                        }
                        Ok(None) => {
                            let record = self.current_record(runtime_id)?;
                            let result = self.complete_terminal_handoff(
                                record,
                                terminal,
                                pending_handoff_allow_background_task_termination,
                            );
                            self.terminal_handoff_preparations
                                .lock()
                                .map_err(|_| {
                                    "Failed to lock native terminal handoff state".to_string()
                                })?
                                .remove(runtime_id);
                            match result {
                                Ok(()) => destroy_browser_session(app, runtime_id),
                                Err(error) => self.fail_pending_terminal_handoff(
                                    runtime_id,
                                    &preparation_id,
                                    &error,
                                )?,
                            }
                        }
                        Err(error) => {
                            self.fail_pending_terminal_handoff(runtime_id, &preparation_id, &error)?
                        }
                    }
                }

                Ok(())
            }
            HelperOutputEvent::Status { status, detail } => {
                let normalized_detail = detail
                    .as_ref()
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty());
                let mut applied = false;
                let mut next_status = status.clone();
                let handoff_in_progress = self
                    .terminal_handoff_preparations
                    .lock()
                    .map_err(|_| "Failed to lock native terminal handoff state".to_string())?
                    .contains_key(runtime_id);
                self.update_record(runtime_id, |record| {
                    if handoff_in_progress && status != "error" {
                        return;
                    }
                    if status == "error"
                        && is_recoverable_native_helper_error(record, normalized_detail.as_deref())
                    {
                        next_status = "interrupted".to_string();
                    }
                    if record.status == "error" && !is_native_terminal_status(&next_status) {
                        return;
                    }
                    applied = true;
                    record.status = next_status.clone();
                    record.is_active = !is_native_terminal_status(&next_status);
                    record.updated_at = Utc::now();
                    if status == "error" {
                        record.last_error = normalized_detail.clone().or_else(|| {
                            Some("Native runtime helper reported an error.".to_string())
                        });
                    } else if matches!(
                        next_status.as_str(),
                        "ready" | "processing" | "initializing"
                    ) {
                        record.last_error = None;
                    }
                })?;
                if !applied {
                    return Ok(());
                }
                if let Some(detail) = normalized_detail {
                    self.append_event(
                        runtime_id,
                        SessionEventPayload::Lifecycle {
                            stage: next_status,
                            detail,
                        },
                    )?;
                }
                if status == "error" {
                    let _ = self.kill_child(runtime_id);
                }
                Ok(())
            }
            HelperOutputEvent::Event { payload } => {
                // A payload type this build does not know (newer helper) must
                // not kill the stdout pump for the whole runtime — skip it.
                let payload = match serde_json::from_value::<SessionEventPayload>(payload) {
                    Ok(payload) => payload,
                    Err(error) => {
                        eprintln!("Skipping unknown helper event for {runtime_id}: {error}");
                        return Ok(());
                    }
                };
                self.append_event(runtime_id, payload)
            }
            HelperOutputEvent::BrowserToolRequest {
                request_id,
                tool,
                args,
            } => self.handle_browser_tool_request(
                app,
                runtime_id,
                BrowserToolRequest {
                    request_id,
                    tool,
                    args,
                },
            ),
            HelperOutputEvent::TeardownPrepared {
                request_id,
                ready,
                detail,
            } => {
                let pending_handoff = {
                    let expected = self
                        .terminal_handoff_preparations
                        .lock()
                        .map_err(|_| "Failed to lock native terminal handoff state".to_string())?
                        .get(runtime_id)
                        .cloned();
                    if expected.as_deref() != Some(request_id.as_str()) {
                        None
                    } else {
                        let record = self.current_record(runtime_id)?;
                        if record.status == "handoff_finalizing" {
                            record.pending_handoff_terminal.map(|terminal| {
                                (
                                    terminal,
                                    record.pending_handoff_allow_background_task_termination,
                                )
                            })
                        } else {
                            None
                        }
                    }
                };
                if let Some((terminal, allow_background_task_termination)) = pending_handoff {
                    if !ready {
                        let error = detail
                            .unwrap_or_else(|| "Native helper is not safe to close.".to_string());
                        return self.fail_pending_terminal_handoff(runtime_id, &request_id, &error);
                    }
                    let record = self.current_record(runtime_id)?;
                    let result = self.complete_terminal_handoff(
                        record,
                        terminal,
                        allow_background_task_termination,
                    );
                    self.terminal_handoff_preparations
                        .lock()
                        .map_err(|_| "Failed to lock native terminal handoff state".to_string())?
                        .remove(runtime_id);
                    match result {
                        Ok(()) => {
                            destroy_browser_session(app, runtime_id);
                            return Ok(());
                        }
                        Err(error) => {
                            return self.fail_pending_terminal_handoff(
                                runtime_id,
                                &request_id,
                                &error,
                            );
                        }
                    }
                }

                let handles = self
                    .handles
                    .lock()
                    .map_err(|_| "Failed to lock native runtime handles".to_string())?;
                let Some(handle) = handles.get(runtime_id) else {
                    return Ok(());
                };
                handle
                    .teardown_preparations
                    .lock()
                    .map_err(|_| "Failed to lock native teardown preparation".to_string())?
                    .insert(
                        request_id,
                        if ready {
                            Ok(())
                        } else {
                            Err(detail.unwrap_or_else(|| {
                                "Native helper is not safe to close.".to_string()
                            }))
                        },
                    );
                Ok(())
            }
            HelperOutputEvent::BackgroundTaskStopFailed {
                task_id,
                stop_request_id,
                error,
            } => self.restore_rejected_background_task_stop(
                runtime_id,
                &task_id,
                &stop_request_id,
                &error,
            ),
        }
    }

    fn restore_rejected_background_task_stop(
        &self,
        runtime_id: &str,
        task_id: &str,
        stop_request_id: &str,
        error: &str,
    ) -> Result<(), String> {
        let handle = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(runtime_id)
            .cloned()
            .ok_or_else(|| format!("Native runtime {runtime_id} not found"))?;
        let prior_status = {
            let mut pending_stops = handle
                .pending_background_task_stops
                .lock()
                .map_err(|_| "Failed to lock pending background task stops".to_string())?;
            let Some((request_id, status)) = pending_stops.get(task_id).cloned() else {
                return Ok(());
            };
            if request_id != stop_request_id {
                return Ok(());
            }
            pending_stops.remove(task_id);
            status
        };
        let restored = {
            let tasks = handle
                .background_tasks
                .lock()
                .map_err(|_| "Failed to lock native background tasks".to_string())?;
            let Some(current) = tasks.get(task_id) else {
                return Ok(());
            };
            if current.status != NativeBackgroundTaskStatus::Stopping
                || current.stop_request_id.as_deref() != Some(stop_request_id)
            {
                return Ok(());
            }
            let mut restored = current.clone();
            restored.status = prior_status;
            restored.updated_at = Utc::now();
            restored.error = Some(error.trim().to_string());
            restored.stop_failed = Some(true);
            restored
        };
        self.append_event(
            runtime_id,
            SessionEventPayload::BackgroundTaskUpdated { task: restored },
        )
    }

    fn handle_browser_tool_request(
        &self,
        app: Option<&AppHandle>,
        runtime_id: &str,
        request: BrowserToolRequest,
    ) -> Result<(), String> {
        let handle = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(runtime_id)
            .cloned()
            .ok_or_else(|| format!("Native runtime {} helper is not connected", runtime_id))?;

        let (workspace_dir, permission_mode, authorization) = {
            let record = handle
                .record
                .lock()
                .map_err(|_| "Failed to lock native session record".to_string())?;
            let permission_mode = effective_native_perm_mode(
                record.perm_mode.as_str(),
                record.runtime_perm_mode.as_deref(),
            )
            .to_string();
            (
                record.project_dir.clone(),
                permission_mode,
                authorize_browser_tool_for_record(&record, &request.tool),
            )
        };

        let response = match app {
            Some(app) => match app.try_state::<Arc<BrowserManager>>() {
                Some(browser) => {
                    let audit = browser.audit_policy_decision(
                        &workspace_dir,
                        runtime_id,
                        &permission_mode,
                        &request,
                        authorization.is_ok(),
                        authorization.as_ref().err().map(String::as_str),
                    );
                    match authorization {
                        Ok(()) => audit.and_then(|_| {
                            browser.run_tool(app, runtime_id, &workspace_dir, &request)
                        }),
                        Err(policy_error) => {
                            if let Err(audit_error) = audit {
                                eprintln!(
                                    "Failed to append denied preview browser audit: {audit_error}"
                                );
                            }
                            Err(policy_error)
                        }
                    }
                }
                None => Err("Browser manager is not registered.".to_string()),
            },
            None => Err("Browser tool request requires an app handle.".to_string()),
        };

        match response {
            Ok(result) => self.write_to_child(
                &handle,
                &HelperInputCommand::BrowserToolResponse {
                    request_id: &request.request_id,
                    ok: true,
                    result: Some(&result),
                    error: None,
                },
            ),
            Err(error) => self.write_to_child(
                &handle,
                &HelperInputCommand::BrowserToolResponse {
                    request_id: &request.request_id,
                    ok: false,
                    result: None,
                    error: Some(&error),
                },
            ),
        }
    }

    fn mark_process_exit(
        &self,
        runtime_id: &str,
        exit_code: Option<i32>,
        handle: &Arc<NativeSessionHandle>,
    ) -> Result<(), String> {
        let mut errors = Vec::new();
        let _reconnect_guard = match self.reconnect_lock.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                errors.push("Native runtime reconnect coordinator was poisoned".to_string());
                poisoned.into_inner()
            }
        };
        let is_current = match self.handles.lock() {
            Ok(handles) => handles
                .get(runtime_id)
                .map(|current| Self::same_handle(current, handle))
                .unwrap_or(false),
            Err(poisoned) => {
                errors.push("Native runtime handles were poisoned during process exit".to_string());
                poisoned
                    .into_inner()
                    .get(runtime_id)
                    .map(|current| Self::same_handle(current, handle))
                    .unwrap_or(false)
            }
        };
        if !is_current {
            if errors.is_empty() {
                return Ok(());
            }
            return Err(errors.join("; "));
        }
        handle.alive.store(false, Ordering::SeqCst);

        let exit_reason = format!(
            "Native runtime sidecar exited unexpectedly{}.",
            exit_code
                .map(|code| format!(" with code {}", code))
                .unwrap_or_default()
        );
        if let Err(error) = self.interrupt_background_tasks(runtime_id, &exit_reason) {
            errors.push(error);
        }

        let expected_terminal = match self.records.lock() {
            Ok(records) => records
                .get(runtime_id)
                .map(|record| is_native_terminal_status(&record.status))
                .unwrap_or(false),
            Err(poisoned) => {
                errors.push("Native runtime records were poisoned during process exit".to_string());
                poisoned
                    .into_inner()
                    .get(runtime_id)
                    .map(|record| is_native_terminal_status(&record.status))
                    .unwrap_or(false)
            }
        };

        if !expected_terminal {
            if let Err(error) = self.update_record(runtime_id, |record| {
                let recoverable = is_recoverable_native_process_exit(record);
                record.status = if recoverable { "interrupted" } else { "error" }.to_string();
                record.is_active = false;
                record.pending_handoff_terminal = None;
                record.pending_handoff_allow_background_task_termination = false;
                if record.pending_settings_request_id.is_some() {
                    record.pending_env_name = None;
                    record.pending_effort = None;
                    record.pending_settings_request_id = None;
                    record.last_error = Some(
                        "Deferred Claude settings were not applied because the helper exited."
                            .to_string(),
                    );
                }
                record.can_handoff_to_terminal =
                    recoverable && terminal::external_terminal_launch_supported();
                record.updated_at = Utc::now();
                if record.last_error.is_none() {
                    record.last_error = Some(exit_reason.clone());
                }
            }) {
                errors.push(error);
            }
            if let Err(error) = self.append_event(
                runtime_id,
                SessionEventPayload::SessionCompleted {
                    reason: exit_reason,
                },
            ) {
                errors.push(error);
            }
        }

        if let Err(error) = self.retire_handle_if_current(runtime_id, handle) {
            errors.push(error);
        }
        if errors.is_empty() {
            return Ok(());
        }
        Err(errors.join("; "))
    }

    fn write_to_child(
        &self,
        handle: &Arc<NativeSessionHandle>,
        command: &HelperInputCommand<'_>,
    ) -> Result<(), String> {
        self.write_to_child_checked(handle, command, false)
    }

    fn write_to_live_child(
        &self,
        handle: &Arc<NativeSessionHandle>,
        command: &HelperInputCommand<'_>,
    ) -> Result<(), String> {
        self.write_to_child_checked(handle, command, true)
    }

    fn write_to_child_checked(
        &self,
        handle: &Arc<NativeSessionHandle>,
        command: &HelperInputCommand<'_>,
        require_live: bool,
    ) -> Result<(), String> {
        let line = serde_json::to_string(command)
            .map_err(|error| format!("Failed to encode helper command: {}", error))?;
        let mut child_guard = handle
            .child
            .lock()
            .map_err(|_| "Failed to lock native sidecar child".to_string())?;
        if require_live && !handle.alive.load(Ordering::SeqCst) {
            return Err(NATIVE_HELPER_RETIRING_ERROR.to_string());
        }
        let child = child_guard
            .as_mut()
            .ok_or_else(|| "Native sidecar child is not available".to_string())?;
        child
            .write(format!("{}\n", line).as_bytes())
            .map_err(|error| format!("Failed to write to native sidecar stdin: {}", error))
    }

    fn write_to_child_with_reconnect(
        self: &Arc<Self>,
        app: &AppHandle,
        runtime_id: &str,
        handle: Arc<NativeSessionHandle>,
        command: &HelperInputCommand<'_>,
    ) -> Result<(), String> {
        let requires_live_handle = matches!(command, HelperInputCommand::Prompt { .. });
        let write_result = if requires_live_handle {
            self.write_to_live_child(&handle, command)
        } else {
            self.write_to_child(&handle, command)
        };
        match write_result {
            Ok(()) => Ok(()),
            Err(error)
                if error == NATIVE_HELPER_RETIRING_ERROR
                    || is_retryable_native_child_write_error(&error) =>
            {
                let _ = self.append_event(
                    runtime_id,
                    SessionEventPayload::Lifecycle {
                        stage: "runtime_resume".to_string(),
                        detail: format!(
                            "Restarting native runtime helper generation {} for {} after write failed: {}",
                            handle.generation,
                            helper_command_kind(command),
                            error
                        ),
                    },
                );
                let _reconnect_guard = self.reconnect_lock.lock().map_err(|_| {
                    "Failed to lock native runtime reconnect coordinator".to_string()
                })?;
                let current = self
                    .handles
                    .lock()
                    .map_err(|_| "Failed to lock native runtime handles".to_string())?
                    .get(runtime_id)
                    .cloned();
                let next_handle = match current {
                    Some(current)
                        if !Self::same_handle(&current, &handle)
                            && current.alive.load(Ordering::SeqCst) =>
                    {
                        current
                    }
                    current => {
                        if let Some(current) = current {
                            self.retire_handle_if_current(runtime_id, &current)?;
                        }
                        self.update_record(runtime_id, |record| {
                            record.status = "initializing".to_string();
                            record.is_active = true;
                            record.last_error = None;
                            record.updated_at = Utc::now();
                        })?;
                        self.reconnect_handle_locked(app.clone(), runtime_id, false)?
                    }
                };
                if requires_live_handle {
                    self.write_to_live_child(&next_handle, command)
                } else {
                    self.write_to_child(&next_handle, command)
                }
            }
            Err(error) => Err(error),
        }
    }

    fn request_child_stop(
        &self,
        runtime_id: &str,
        force_background_tasks: bool,
    ) -> Result<Option<Arc<NativeSessionHandle>>, String> {
        let handle = match self.handles.lock() {
            Ok(handles) => handles.get(runtime_id).cloned(),
            Err(poisoned) => {
                eprintln!("Native runtime handles were poisoned while requesting stop");
                poisoned.into_inner().get(runtime_id).cloned()
            }
        };
        let Some(handle) = handle else {
            return Ok(None);
        };

        handle.alive.store(false, Ordering::SeqCst);
        let has_child = match handle.child.lock() {
            Ok(child) => child.is_some(),
            Err(poisoned) => {
                eprintln!("Native sidecar child mutex was poisoned while requesting stop");
                poisoned.into_inner().is_some()
            }
        };
        if !has_child {
            return Ok(None);
        }

        match self.write_to_child(
            &handle,
            &HelperInputCommand::Stop {
                force_background_tasks,
            },
        ) {
            Ok(()) => {
                if let Err(error) = self.append_lifecycle_event(
                    runtime_id,
                    "stop_written",
                    format!(
                        "Native helper generation {} accepted stop command.",
                        handle.generation
                    ),
                ) {
                    // Telemetry must never prevent the exact generation's force-cleanup timer.
                    eprintln!("Failed to append native helper stop lifecycle event: {error}");
                }
                Ok(Some(handle))
            }
            Err(error) => {
                let _ = self.append_event(
                    runtime_id,
                    SessionEventPayload::StdErrLine {
                        line: format!("Failed to request native helper stop: {}", error),
                    },
                );
                let _ = self.append_lifecycle_event(
                    runtime_id,
                    "stop_write_failed",
                    format!("Failed to write native helper stop command: {}", error),
                );
                Ok(None)
            }
        }
    }

    fn request_child_prepare_stop(
        &self,
        runtime_id: &str,
        request_id: &str,
        require_idle: bool,
        force_background_tasks: bool,
        finalize: bool,
    ) -> Result<Option<Arc<NativeSessionHandle>>, String> {
        let handle = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(runtime_id)
            .cloned();
        let Some(handle) = handle else {
            return Ok(None);
        };
        let has_child = handle
            .child
            .lock()
            .map_err(|_| "Failed to lock native sidecar child".to_string())?
            .is_some();
        if !has_child {
            return Ok(None);
        }
        handle
            .teardown_preparations
            .lock()
            .map_err(|_| "Failed to lock native teardown preparation".to_string())?
            .remove(request_id);
        self.write_to_child(
            &handle,
            &HelperInputCommand::PrepareStop {
                request_id,
                require_idle,
                force_background_tasks,
                finalize,
            },
        )?;
        Ok(Some(handle))
    }

    fn await_child_prepare_stop(
        &self,
        runtime_id: &str,
        request_id: &str,
        handle: &Arc<NativeSessionHandle>,
        allow_background_tasks: bool,
    ) -> Result<(), String> {
        let deadline = std::time::Instant::now() + NATIVE_STOP_GRACE_PERIOD;
        while std::time::Instant::now() < deadline {
            if !self.is_current_handle(runtime_id, handle)? {
                return Err(format!(
                    "Native runtime {runtime_id} exited while preparing app termination."
                ));
            }
            if !allow_background_tasks && !self.active_background_tasks(runtime_id)?.is_empty() {
                return Err(
                    "A Claude background task started while preparing app termination.".to_string(),
                );
            }
            if let Some(result) = handle
                .teardown_preparations
                .lock()
                .map_err(|_| "Failed to lock native teardown preparation".to_string())?
                .remove(request_id)
            {
                return result;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        Err(format!(
            "Native runtime {runtime_id} did not become safe to close before the deadline."
        ))
    }

    fn cancel_child_prepare_stop(&self, runtime_id: &str, request_id: &str) {
        let handle = self
            .handles
            .lock()
            .ok()
            .and_then(|handles| handles.get(runtime_id).cloned());
        let Some(handle) = handle else {
            return;
        };
        if let Ok(mut preparations) = handle.teardown_preparations.lock() {
            preparations.remove(request_id);
        }
        let _ = self.write_to_child(
            &handle,
            &HelperInputCommand::CancelPrepareStop { request_id },
        );
        handle.alive.store(true, Ordering::SeqCst);
    }

    fn schedule_force_kill_after(
        self: &Arc<Self>,
        runtime_id: String,
        handle: Arc<NativeSessionHandle>,
        grace: Duration,
    ) {
        let manager = Arc::clone(self);
        tauri::async_runtime::spawn_blocking(move || {
            std::thread::sleep(grace);
            if let Err(error) = manager.force_kill_stopped_handle(&runtime_id, &handle) {
                eprintln!(
                    "Failed to finalize native helper force cleanup for {runtime_id}: {error}"
                );
            }
        });
    }

    fn force_kill_stopped_handle(
        &self,
        runtime_id: &str,
        handle: &Arc<NativeSessionHandle>,
    ) -> Result<bool, String> {
        let mut errors = Vec::new();
        let _reconnect_guard = match self.reconnect_lock.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                errors.push("Native runtime reconnect coordinator was poisoned".to_string());
                poisoned.into_inner()
            }
        };
        if handle.alive.load(Ordering::SeqCst) {
            return Ok(false);
        }

        let is_current = match self.handles.lock() {
            Ok(handles) => handles
                .get(runtime_id)
                .map(|current| Self::same_handle(current, handle))
                .unwrap_or(false),
            Err(poisoned) => {
                errors
                    .push("Native runtime handles were poisoned during force cleanup".to_string());
                poisoned
                    .into_inner()
                    .get(runtime_id)
                    .map(|current| Self::same_handle(current, handle))
                    .unwrap_or(false)
            }
        };

        if is_current {
            if let Err(error) = self.append_lifecycle_event(
                runtime_id,
                "stop_force_killed",
                format!(
                    "Native helper generation {} did not settle after stop; removed stale helper handle.",
                    handle.generation
                ),
            ) {
                errors.push(error);
            }
            if let Err(error) = self.update_record(runtime_id, |record| {
                record.status = "interrupted".to_string();
                record.is_active = false;
                record.updated_at = Utc::now();
            }) {
                errors.push(error);
            }
        }

        // Claim only the exact stopped generation. Metadata/state errors above are reported after
        // cleanup; none may prevent removing and killing the owned process tree.
        let removed_current = match self.handles.lock() {
            Ok(mut handles) => {
                let matches = handles
                    .get(runtime_id)
                    .map(|current| Self::same_handle(current, handle))
                    .unwrap_or(false);
                if matches {
                    handles.remove(runtime_id);
                }
                matches
            }
            Err(poisoned) => {
                errors.push(
                    "Native runtime handles were poisoned while claiming force cleanup".to_string(),
                );
                let mut handles = poisoned.into_inner();
                let matches = handles
                    .get(runtime_id)
                    .map(|current| Self::same_handle(current, handle))
                    .unwrap_or(false);
                if matches {
                    handles.remove(runtime_id);
                }
                matches
            }
        };

        if let Some(manager) = self.router_manager.get() {
            manager.unregister_generation(runtime_id, handle.generation);
        }
        let child_to_kill = match handle.child.lock() {
            Ok(mut child) => child.take(),
            Err(poisoned) => {
                errors.push(
                    "Native sidecar child mutex was poisoned during force cleanup".to_string(),
                );
                poisoned.into_inner().take()
            }
        };
        if let Some(child) = child_to_kill {
            if let Err(error) = child.kill() {
                errors.push(error);
            }
        }

        if errors.is_empty() {
            Ok(removed_current)
        } else {
            Err(errors.join("; "))
        }
    }

    fn append_user_prompt_event(
        &self,
        runtime_id: &str,
        text: &str,
        images: Option<&Vec<PromptImage>>,
        annotations: Option<&Vec<SessionPromptAnnotation>>,
    ) -> Result<(), String> {
        let text = text.trim();
        let image_count = images.map(|items| items.len()).unwrap_or(0);
        let annotations = validate_prompt_annotations(annotations)?;
        if text.is_empty() && image_count == 0 && annotations.is_none() {
            return Ok(());
        }
        let event_images = prompt_images_for_event(images, &self.prompt_image_store)?;
        let canonical_hash =
            canonical_user_prompt_hash(text, event_images.as_ref(), annotations.as_ref());

        self.append_event(
            runtime_id,
            SessionEventPayload::UserPrompt {
                text: text.to_string(),
                image_count: image_count as u64,
                images: event_images,
                annotations,
                canonical_hash,
            },
        )
    }

    fn append_interactive_prompt_response_event(
        &self,
        runtime_id: &str,
        display_text: Option<&str>,
        answers: &HashMap<String, String>,
        annotations: Option<&Vec<SessionPromptAnnotation>>,
    ) -> Result<(), String> {
        let Some(text) = summarize_interactive_prompt_response(display_text, answers) else {
            return Ok(());
        };
        self.append_user_prompt_event(runtime_id, &text, None, annotations)
    }

    fn deliver_and_append_interactive_prompt_response(
        &self,
        runtime_id: &str,
        display_text: Option<&str>,
        answers: &HashMap<String, String>,
        annotations: Option<&Vec<SessionPromptAnnotation>>,
        deliver: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        deliver()?;
        self.append_interactive_prompt_response_event(
            runtime_id,
            display_text,
            answers,
            annotations,
        )
    }

    /// Public bridge for OTHER managers (proxy debug router) to append an
    /// event onto a live runtime's bus, e.g. per-request routed usage truth.
    pub fn append_external_event(
        &self,
        runtime_id: &str,
        payload: SessionEventPayload,
    ) -> Result<(), String> {
        self.append_event(runtime_id, payload)
    }

    fn append_event(&self, runtime_id: &str, payload: SessionEventPayload) -> Result<(), String> {
        let last_error = payload_last_error(&payload);
        let settings_change = match &payload {
            SessionEventPayload::RuntimeSettingsChanged {
                state,
                request_id,
                env_name,
                effort,
                pending_env_name,
                pending_effort,
            } => Some((
                state.clone(),
                request_id.clone(),
                env_name.clone(),
                effort.clone(),
                pending_env_name.clone(),
                pending_effort.clone(),
            )),
            _ => None,
        };
        let handles = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?;
        let Some(handle) = handles.get(runtime_id) else {
            return Ok(());
        };
        if !apply_background_task_event(handle, &payload)? {
            return Ok(());
        }
        {
            let mut store = handle
                .events
                .lock()
                .map_err(|_| "Failed to lock native session store".to_string())?;
            let record = store.append(payload);
            if let Err(error) = self.event_log.append(&record) {
                eprintln!(
                    "Failed to persist native event {}:{}: {}",
                    record.runtime_id, record.seq, error
                );
            }
        }
        drop(handles);
        if let Some((state, request_id, env_name, effort, pending_env_name, pending_effort)) =
            settings_change
        {
            self.update_record(runtime_id, |record| {
                let request_matches =
                    request_id.is_some() && request_id == record.pending_settings_request_id;
                if state == "applied" {
                    record.env_name = env_name;
                    record.effort = effort;
                    if request_matches || record.pending_settings_request_id.is_none() {
                        record.pending_env_name = None;
                        record.pending_effort = None;
                        record.pending_settings_request_id = None;
                    }
                } else if state == "deferred" && request_matches {
                    record.pending_env_name = pending_env_name;
                    record.pending_effort = pending_effort;
                }
                record.updated_at = Utc::now();
            })?;
        }
        if let Some(message) = last_error {
            self.set_last_error(runtime_id, message)?;
        }
        Ok(())
    }

    fn append_event_if_current(
        &self,
        runtime_id: &str,
        payload: SessionEventPayload,
        handle: &Arc<NativeSessionHandle>,
    ) -> Result<(), String> {
        let _reconnect_guard = self
            .reconnect_lock
            .lock()
            .map_err(|_| "Failed to lock native runtime reconnect coordinator".to_string())?;
        if !self.is_current_handle(runtime_id, handle)? {
            return Ok(());
        }
        self.append_event(runtime_id, payload)
    }

    fn append_lifecycle_event(
        &self,
        runtime_id: &str,
        stage: &str,
        detail: impl Into<String>,
    ) -> Result<(), String> {
        self.append_event(
            runtime_id,
            SessionEventPayload::Lifecycle {
                stage: stage.to_string(),
                detail: detail.into(),
            },
        )
    }

    fn insert_record(&self, record: NativeSessionRecord) -> Result<(), String> {
        let mut records = self
            .records
            .lock()
            .map_err(|_| "Failed to lock native runtime records".to_string())?;
        let runtime_id = record.runtime_id.clone();
        if records.contains_key(&runtime_id) {
            return Err(format!("Native runtime {runtime_id} already exists"));
        }
        records.insert(runtime_id.clone(), record);
        if let Err(error) =
            persist_native_runtime_state_to(&self.state_path, records.values().cloned().collect())
        {
            records.remove(&runtime_id);
            return Err(error.to_string());
        }
        Ok(())
    }

    fn remove_record(&self, runtime_id: &str) -> Result<(), String> {
        let mut records = self
            .records
            .lock()
            .map_err(|_| "Failed to lock native runtime records".to_string())?;
        records.remove(runtime_id);
        persist_native_runtime_state_to(&self.state_path, records.values().cloned().collect())
    }

    fn insert_handle(
        &self,
        runtime_id: String,
        handle: Arc<NativeSessionHandle>,
    ) -> Result<(), String> {
        let mut handles = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?;
        match handles.entry(runtime_id) {
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(handle);
                Ok(())
            }
            std::collections::hash_map::Entry::Occupied(entry) => Err(format!(
                "Native runtime handle {} already exists",
                entry.key()
            )),
        }
    }

    fn allocate_handle_generation(&self) -> u64 {
        self.next_handle_generation.fetch_add(1, Ordering::SeqCst)
    }

    fn same_handle(current: &Arc<NativeSessionHandle>, handle: &Arc<NativeSessionHandle>) -> bool {
        let same_generation = current.generation == handle.generation;
        if same_generation {
            debug_assert!(
                Arc::ptr_eq(current, handle),
                "native handle generation reused for a different Arc"
            );
        }
        same_generation && Arc::ptr_eq(current, handle)
    }

    fn is_current_live_handle(
        &self,
        runtime_id: &str,
        handle: &Arc<NativeSessionHandle>,
    ) -> Result<bool, String> {
        let handles = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?;
        Ok(handles
            .get(runtime_id)
            .map(|current| {
                Self::same_handle(current, handle) && handle.alive.load(Ordering::SeqCst)
            })
            .unwrap_or(false))
    }

    fn remove_handle(&self, runtime_id: &str) -> Result<(), String> {
        let removed_generation = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .remove(runtime_id)
            .map(|handle| handle.generation);
        if let (Some(manager), Some(generation)) = (self.router_manager.get(), removed_generation) {
            manager.unregister_generation(runtime_id, generation);
        }
        Ok(())
    }

    fn retire_handle_if_current(
        &self,
        runtime_id: &str,
        handle: &Arc<NativeSessionHandle>,
    ) -> Result<bool, String> {
        let mut errors = Vec::new();
        let removed = {
            let mut handles = match self.handles.lock() {
                Ok(handles) => handles,
                Err(poisoned) => {
                    errors.push(
                        "Native runtime handles were poisoned while retiring helper".to_string(),
                    );
                    poisoned.into_inner()
                }
            };
            let is_current = handles
                .get(runtime_id)
                .map(|current| Self::same_handle(current, handle))
                .unwrap_or(false);
            is_current.then(|| handles.remove(runtime_id)).flatten()
        };
        let Some(removed) = removed else {
            return Ok(false);
        };

        removed.alive.store(false, Ordering::SeqCst);
        if let Some(manager) = self.router_manager.get() {
            manager.unregister_generation(runtime_id, removed.generation);
        }
        let child = match removed.child.lock() {
            Ok(mut child) => child.take(),
            Err(poisoned) => {
                errors.push(
                    "Native sidecar child mutex was poisoned while retiring helper".to_string(),
                );
                poisoned.into_inner().take()
            }
        };
        if let Some(child) = child {
            if let Err(error) = child.kill() {
                errors.push(error);
            }
        }
        if errors.is_empty() {
            Ok(true)
        } else {
            Err(errors.join("; "))
        }
    }

    fn retire_current_handle_locked(&self, runtime_id: &str) -> Result<(), String> {
        let handle = match self.handles.lock() {
            Ok(handles) => handles.get(runtime_id).cloned(),
            Err(poisoned) => poisoned.into_inner().get(runtime_id).cloned(),
        };
        if let Some(handle) = handle {
            self.retire_handle_if_current(runtime_id, &handle)?;
        }
        Ok(())
    }

    fn is_current_handle(
        &self,
        runtime_id: &str,
        handle: &Arc<NativeSessionHandle>,
    ) -> Result<bool, String> {
        Ok(self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(runtime_id)
            .map(|current| Self::same_handle(current, handle))
            .unwrap_or(false))
    }

    fn kill_child(&self, runtime_id: &str) -> Result<(), String> {
        self.interrupt_background_tasks(
            runtime_id,
            "Claude runtime closed before the background task settled.",
        )?;
        let handles = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?;
        if let Some(handle) = handles.get(runtime_id) {
            handle.alive.store(false, Ordering::SeqCst);
            if let Some(child) = handle
                .child
                .lock()
                .map_err(|_| "Failed to lock native sidecar child".to_string())?
                .take()
            {
                child.kill()?;
            }
        }
        Ok(())
    }

    fn shutdown_child(&self, runtime_id: &str, force_background_tasks: bool) -> Result<(), String> {
        if !runtime_child_is_owned(&self.current_record(runtime_id)?) {
            return Ok(());
        }
        self.reject_background_task_termination(
            runtime_id,
            "close this native runtime",
            force_background_tasks,
        )?;
        let Some(handle) = self.request_child_stop(runtime_id, force_background_tasks)? else {
            self.reject_background_task_termination(
                runtime_id,
                "close this native runtime",
                force_background_tasks,
            )?;
            self.kill_child(runtime_id)?;
            return Ok(());
        };

        let deadline = std::time::Instant::now() + NATIVE_STOP_GRACE_PERIOD;
        while std::time::Instant::now() < deadline {
            if !self.is_current_handle(runtime_id, &handle)? {
                return Ok(());
            }
            if !force_background_tasks && !self.active_background_tasks(runtime_id)?.is_empty() {
                handle.alive.store(true, Ordering::SeqCst);
                return Err(ACTIVE_BACKGROUND_TASK_SHUTDOWN_ERROR.to_string());
            }
            std::thread::sleep(Duration::from_millis(25));
        }

        self.reject_background_task_termination(
            runtime_id,
            "close this native runtime",
            force_background_tasks,
        )?;
        self.kill_child(runtime_id)
    }

    fn update_record<F>(&self, runtime_id: &str, update: F) -> Result<(), String>
    where
        F: FnOnce(&mut NativeSessionRecord),
    {
        let updated_record = {
            let mut records = self
                .records
                .lock()
                .map_err(|_| "Failed to lock native runtime records".to_string())?;
            let record = records
                .get_mut(runtime_id)
                .ok_or_else(|| format!("Native runtime {} not found", runtime_id))?;
            update(record);
            record.clone()
        };

        if let Some(handle) = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(runtime_id)
            .cloned()
        {
            if let Ok(mut record) = handle.record.lock() {
                *record = updated_record;
            }
        }

        let records = self
            .records
            .lock()
            .map_err(|_| "Failed to lock native runtime records".to_string())?;
        persist_native_runtime_state_to(&self.state_path, records.values().cloned().collect())
    }

    fn set_last_error(&self, runtime_id: &str, message: String) -> Result<(), String> {
        self.update_record(runtime_id, |record| {
            record.last_error = Some(message);
            record.updated_at = Utc::now();
        })
    }

    fn has_record(&self, runtime_id: &str) -> Result<bool, String> {
        self.records
            .lock()
            .map_err(|_| "Failed to lock native runtime records".to_string())
            .map(|records| records.contains_key(runtime_id))
    }

    fn summary_for(&self, runtime_id: &str) -> Result<NativeSessionSummary, String> {
        self.get_session_summary(runtime_id)?
            .ok_or_else(|| format!("Native runtime {} not found", runtime_id))
    }

    /// Single-session variant of `list_sessions`: reads only this runtime's
    /// handle or record instead of cloning the whole session map.
    pub fn get_session_summary(
        &self,
        runtime_id: &str,
    ) -> Result<Option<NativeSessionSummary>, String> {
        if let Some(handle) = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(runtime_id)
            .cloned()
        {
            return Ok(Some(handle.summary()));
        }

        Ok(self
            .records
            .lock()
            .map_err(|_| "Failed to lock native runtime records".to_string())?
            .get(runtime_id)
            .cloned()
            .map(|record| NativeSessionSummary {
                runtime_id: record.runtime_id,
                provider: record.provider,
                transport: record.transport,
                provider_session_id: record.provider_session_id,
                seed_boundary_message_count: record.seed_boundary_message_count,
                project_dir: record.project_dir,
                env_name: record.env_name,
                perm_mode: record.perm_mode,
                runtime_perm_mode: record.runtime_perm_mode,
                effort: record.effort,
                pending_env_name: record.pending_env_name,
                pending_effort: record.pending_effort,
                status: record.status,
                created_at: record.created_at,
                updated_at: record.updated_at,
                is_active: record.is_active,
                last_event_seq: None,
                can_handoff_to_terminal: record.can_handoff_to_terminal,
                background_tasks: Vec::new(),
                last_error: record.last_error,
                router: record.router.as_ref().map(SessionRouterState::from),
            }))
    }

    fn flush_helper_output_buffers(
        &self,
        app: Option<&AppHandle>,
        runtime_id: &str,
        stdout_buffer: &mut Vec<u8>,
        stderr_buffer: &mut Vec<u8>,
        handle: &Arc<NativeSessionHandle>,
    ) {
        let Ok(_reconnect_guard) = self.reconnect_lock.lock() else {
            return;
        };
        if !self.is_current_handle(runtime_id, handle).unwrap_or(false) {
            stdout_buffer.clear();
            stderr_buffer.clear();
            return;
        }
        if let Some(text) = take_remaining_helper_output_line(stdout_buffer) {
            if let Err(error) = self.process_helper_stdout_with_app(app, runtime_id, &text) {
                let _ = self.append_event(
                    runtime_id,
                    SessionEventPayload::StdErrLine {
                        line: format!("Failed to process helper output: {}", error),
                    },
                );
            }
        }
        if let Some(text) = take_remaining_helper_output_line(stderr_buffer) {
            let _ = self.append_event(runtime_id, SessionEventPayload::StdErrLine { line: text });
        }
    }
}

fn trim_helper_output_line(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes)
        .trim_matches(['\r', '\n'])
        .trim()
        .to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn drain_helper_output_lines(buffer: &mut Vec<u8>, chunk: &[u8]) -> Vec<String> {
    buffer.extend_from_slice(chunk);
    let mut lines = Vec::new();
    while let Some(index) = buffer.iter().position(|byte| *byte == b'\n') {
        let line = buffer.drain(..=index).collect::<Vec<_>>();
        if let Some(text) = trim_helper_output_line(&line) {
            lines.push(text);
        }
    }
    lines
}

fn take_remaining_helper_output_line(buffer: &mut Vec<u8>) -> Option<String> {
    if buffer.is_empty() {
        return None;
    }
    let line = std::mem::take(buffer);
    trim_helper_output_line(&line)
}

fn summarize_interactive_prompt_response(
    display_text: Option<&str>,
    answers: &HashMap<String, String>,
) -> Option<String> {
    if let Some(text) = display_text
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(text.to_string());
    }

    let mut entries = answers
        .iter()
        .filter_map(|(question, answer)| {
            let answer = answer.trim();
            if answer.is_empty() {
                return None;
            }
            Some((question.trim(), answer))
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left.0.cmp(right.0));

    match entries.as_slice() {
        [] => None,
        [(_, answer)] => Some((*answer).to_string()),
        _ => Some(
            entries
                .into_iter()
                .map(|(question, answer)| {
                    if question.is_empty() {
                        answer.to_string()
                    } else {
                        format!("{question}: {answer}")
                    }
                })
                .collect::<Vec<_>>()
                .join("\n"),
        ),
    }
}

fn payload_last_error(payload: &SessionEventPayload) -> Option<String> {
    match payload {
        SessionEventPayload::StdErrLine { line } if !is_context_usage_probe_error(line) => {
            non_empty_error(line)
        }
        SessionEventPayload::Lifecycle { stage, detail } if stage == "error" => {
            non_empty_error(detail)
        }
        SessionEventPayload::SessionCompleted { reason }
            if !reason.contains("Stopped from desktop workspace") =>
        {
            non_empty_error(reason)
        }
        _ => None,
    }
}

fn is_context_usage_probe_error(message: &str) -> bool {
    message
        .trim_start()
        .starts_with("[context_usage] getContextUsage failed:")
}

fn is_native_terminal_status(status: &str) -> bool {
    matches!(
        status,
        "stopped"
            | "error"
            | "handoff"
            | "handoff_closing"
            | "app_closing"
            | "interrupted"
            | "closed_idle"
    )
}

fn is_query_mutation_terminal_status(status: &str) -> bool {
    matches!(
        status,
        "stopped" | "error" | "handoff" | "handoff_closing" | "app_closing"
    )
}

fn is_recoverable_native_process_exit(record: &NativeSessionRecord) -> bool {
    record
        .provider_session_id
        .as_deref()
        .is_some_and(|session_id| !session_id.trim().is_empty())
}

fn is_recoverable_native_helper_error(record: &NativeSessionRecord, detail: Option<&str>) -> bool {
    is_recoverable_native_process_exit(record)
        && detail.is_some_and(is_recoverable_native_process_error)
}

fn is_recoverable_native_process_error(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("terminated by signal")
        || normalized.contains("signal sigkill")
        || normalized.contains("sigkill")
}

fn reactivate_record_for_reconnect(record: &mut NativeSessionRecord) -> bool {
    if !matches!(
        record.status.as_str(),
        "error" | "interrupted" | "closed_idle"
    ) {
        return false;
    }

    record.status = "initializing".to_string();
    record.is_active = true;
    record.last_error = None;
    record.updated_at = Utc::now();
    true
}

fn recoverable_record_after_helper_removed(record: &NativeSessionRecord) -> NativeSessionRecord {
    let mut recovery = record.clone();
    recovery.status = "interrupted".to_string();
    recovery.is_active = false;
    recovery.pending_handoff_terminal = None;
    recovery.updated_at = Utc::now();
    recovery.last_error =
        Some("Direct restart was interrupted after the previous helper stopped.".to_string());
    recovery
}

fn session_router_patch_oauth_validation_enabled(current: &SessionRouterRecord) -> bool {
    OAUTH_ROUTING_VERIFIED || current.launch_transport == LaunchTransport::Direct
}

fn is_retryable_native_child_write_error(message: &str) -> bool {
    message == "Native sidecar child is not available"
        || message.starts_with("Failed to write to native sidecar stdin:")
}

fn env_path_separator() -> char {
    if cfg!(windows) {
        ';'
    } else {
        ':'
    }
}

fn merge_path_values_with_separator(primary: &str, secondary: &str, separator: char) -> String {
    let mut parts = Vec::new();
    for value in [primary, secondary] {
        for part in value
            .split(separator)
            .map(str::trim)
            .filter(|part| !part.is_empty())
        {
            if !parts.iter().any(|existing| existing == part) {
                parts.push(part.to_string());
            }
        }
    }
    parts.join(&separator.to_string())
}

fn merge_path_values(primary: &str, secondary: &str) -> String {
    merge_path_values_with_separator(primary, secondary, env_path_separator())
}

fn merge_helper_env_path(env_vars: &mut HashMap<String, String>, user_path: &str) {
    let user_path = user_path.trim();
    if user_path.is_empty() {
        return;
    }

    let merged = env_vars
        .get("PATH")
        .map(|existing| merge_path_values(user_path, existing))
        .unwrap_or_else(|| user_path.to_string());
    env_vars.insert("PATH".to_string(), merged);
}

fn non_empty_error(message: &str) -> Option<String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn generate_runtime_id() -> String {
    let mut random = [0_u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut random);
    format!("native-{}", hex::encode(random))
}

fn native_runtime_state_file_path() -> PathBuf {
    dirs::home_dir()
        .map(|home| home.join(".ccem/native-runtime-state.json"))
        .unwrap_or_else(|| PathBuf::from(".ccem/native-runtime-state.json"))
}

fn read_native_runtime_state_from(path: &Path) -> io::Result<NativeRuntimeState> {
    if !path.exists() {
        return Ok(NativeRuntimeState::default());
    }

    let content = fs::read_to_string(path)?;
    let mut state = serde_json::from_str::<NativeRuntimeState>(&content)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;

    for record in &mut state.sessions {
        if record
            .last_error
            .as_deref()
            .is_some_and(is_context_usage_probe_error)
        {
            record.last_error = None;
        }
    }

    Ok(state)
}

fn persist_native_runtime_state_to(
    path: &Path,
    records: Vec<NativeSessionRecord>,
) -> Result<(), String> {
    let state = NativeRuntimeState { sessions: records };
    let serialized = serde_json::to_vec_pretty(&state)
        .map_err(|error| format!("Failed to serialize native runtime state: {}", error))?;
    write_private_atomic(path, &serialized)
        .map_err(|error| format!("Failed to persist private native runtime state: {}", error))
}

fn prepare_direct_router_launch(
    options: &mut NativeSessionOptions,
    warning: Option<String>,
) -> Result<(), String> {
    let router = options
        .router_record
        .as_ref()
        .ok_or_else(|| "ROUTER_SESSION_UNAVAILABLE: session router state is missing".to_string())?;
    let default_env = router.default_env.clone();
    let source = describe_router_environment(&default_env).map_err(|error| error.to_string())?;
    let resolved = resolve_claude_env(&default_env)?;
    let runtime_id = options
        .helper_env_vars
        .get("CCEM_RUNTIME_ID")
        .or_else(|| options.helper_env_vars.get("CCEM_SESSION_ID"))
        .cloned();

    options.env_name = default_env;
    options.helper_env_vars = resolved.env_vars.clone();
    merge_helper_env_path(&mut options.helper_env_vars, &terminal::get_user_path());
    options.terminal_env_vars = resolved.env_vars;
    if let Some(runtime_id) = runtime_id.as_deref() {
        inject_ccem_runtime_env(&mut options.helper_env_vars, runtime_id);
        inject_ccem_runtime_env(&mut options.terminal_env_vars, runtime_id);
    }

    let router = options
        .router_record
        .as_mut()
        .expect("router checked before resolving direct launch");
    router.launch_transport = LaunchTransport::Direct;
    router.launch_auth_kind = match source.auth_kind {
        RouterEnvironmentAuthKind::Token => LaunchAuthKind::Token,
        RouterEnvironmentAuthKind::RequiresOauth => LaunchAuthKind::Oauth,
    };
    router.launch_default_env = source.name;
    router.launch_model_pins = source.pins;
    router.warnings = warning.into_iter().collect();
    Ok(())
}

fn build_runtime_bootstrap_options(
    record: &NativeSessionRecord,
) -> Result<NativeSessionOptions, String> {
    let (mut helper_env_vars, mut terminal_env_vars, codex_base_url, codex_api_key) =
        match record.provider {
            NativeProvider::Claude => {
                let resolved = resolve_claude_env(&record.env_name)?;
                (resolved.env_vars.clone(), resolved.env_vars, None, None)
            }
            NativeProvider::Codex => {
                resolve_codex_runtime(&record.env_name)?;
                let proxy_env_vars = resolve_codex_proxy_env();
                (proxy_env_vars.clone(), proxy_env_vars, None, None)
            }
        };
    merge_helper_env_path(&mut helper_env_vars, &terminal::get_user_path());
    inject_ccem_runtime_env(&mut helper_env_vars, &record.runtime_id);
    inject_ccem_runtime_env(&mut terminal_env_vars, &record.runtime_id);

    Ok(NativeSessionOptions {
        provider: record.provider,
        env_name: record.env_name.clone(),
        perm_mode: record.perm_mode.clone(),
        runtime_perm_mode: record.runtime_perm_mode.clone(),
        working_dir: record.project_dir.clone(),
        initial_prompt: None,
        display_prompt: None,
        initial_images: None,
        initial_annotations: None,
        provider_session_id: record.provider_session_id.clone(),
        seed_boundary_message_count: record.seed_boundary_message_count,
        helper_env_vars,
        terminal_env_vars,
        claude_path: resolve_claude_path(),
        codex_path: resolve_codex_path(),
        codex_base_url,
        codex_api_key,
        effort: record.effort.clone(),
        router_launch_draft: None,
        router_record: record.router.clone(),
    })
}

fn inject_ccem_runtime_env(env_vars: &mut HashMap<String, String>, runtime_id: &str) {
    env_vars.insert("CCEM_RUNTIME_ID".to_string(), runtime_id.to_string());
    env_vars.insert("CCEM_SESSION_ID".to_string(), runtime_id.to_string());
}

fn build_helper_router_init(record: &SessionRouterRecord) -> HelperRouterInit {
    let aliases = record
        .allowed_envs
        .iter()
        .filter(|name| is_valid_router_environment_alias(name))
        .cloned()
        .collect::<Vec<_>>();
    let menu = (record.dynamic_routing && !aliases.is_empty()).then(|| {
        format!(
            "CCEM model routing: when calling Agent, you may put exactly one override at the first character of its prompt: <CCEM-ROUTE>ccem:ENV</CCEM-ROUTE>. Allowed ENV values: {}. Never invent or transform an environment name.",
            aliases.join(", ")
        )
    });
    HelperRouterInit {
        route_tag_nonce: record.route_tag_nonce.clone(),
        dynamic_routing: record.dynamic_routing,
        menu,
    }
}

fn configure_routed_helper_env(
    env_vars: &mut HashMap<String, String>,
    actual_port: u16,
    record: &SessionRouterRecord,
) {
    for key in [
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_SUBAGENT_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL",
    ] {
        env_vars.remove(key);
    }
    env_vars.insert(
        "ANTHROPIC_BASE_URL".to_string(),
        format!("http://127.0.0.1:{actual_port}/s/{}", record.session_key),
    );
    if record.launch_auth_kind == LaunchAuthKind::Token {
        env_vars.insert(
            "ANTHROPIC_AUTH_TOKEN".to_string(),
            format!("ccem-router-placeholder-{}", random_router_secret(8)),
        );
    }
}

fn random_router_secret(bytes: usize) -> String {
    let mut value = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut value);
    hex::encode(value)
}

fn dedupe_nonempty(values: &mut Vec<String>) {
    let mut seen = std::collections::HashSet::new();
    values.retain(|value| !value.trim().is_empty() && seen.insert(value.clone()));
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::unix_descendant_process_ids;
    use super::{
        apply_session_router_patch, authorize_browser_tool_for_record, clear_terminal_launches,
        drain_helper_output_lines, is_retryable_native_child_write_error,
        launch_terminal_for_native_handoff, merge_helper_env_path,
        merge_path_values_with_separator, native_session_allows_dangerously_skip_permissions,
        native_status_allows_file_rewind, reactivate_record_for_reconnect,
        read_native_runtime_state_from, recoverable_record_after_helper_removed,
        router_launch_decision, runtime_child_is_owned,
        session_router_patch_oauth_validation_enabled, stage_runtime_settings_update,
        take_terminal_launches, validate_router_create_selection,
        validate_router_launch_draft_profile, HelperInputCommand, NativeProvider,
        NativeRuntimeManager, NativeSessionHandle, NativeSessionOptions, NativeSessionRecord,
        NativeTransport, PromptImage, RouterLaunchDecision, RouterLaunchDraft,
    };
    use crate::event_bus::{
        NativeBackgroundTask, NativeBackgroundTaskStatus, NativeBackgroundTaskUsage,
        SessionEventPayload, SessionPromptAnnotation, SessionStore, TodoSnapshotItemV1,
        TodoSnapshotV1,
    };
    use crate::native_event_log::NativeEventLog;
    use crate::prompt_image_store::PromptImageStore;
    use crate::router::{
        LaunchAuthKind, LaunchTransport, RouterAuthCapability, RouterConfig, RouterManager,
        RouterModelPins, RouterProfile, SessionRouterPatch, SessionRouterRecord,
    };
    use chrono::Utc;
    use std::collections::{HashMap, HashSet};
    use std::fs;
    #[cfg(unix)]
    use std::path::PathBuf;
    #[cfg(unix)]
    use std::process::Command;
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier, Mutex, OnceLock};
    #[cfg(unix)]
    use std::time::{Duration, Instant};

    fn native_session_handle(record: NativeSessionRecord) -> Arc<NativeSessionHandle> {
        native_session_handle_with_terminal_env(record, HashMap::new())
    }

    #[cfg(unix)]
    #[test]
    fn hard_stop_enumerates_descendants_children_first() {
        let mut descendants =
            unix_descendant_process_ids(100, "100 1\n101 100\n102 101\n103 100\n104 999\n");
        let child_index = descendants
            .iter()
            .position(|pid| *pid == 101)
            .expect("direct child");
        let grandchild_index = descendants
            .iter()
            .position(|pid| *pid == 102)
            .expect("grandchild");
        assert!(grandchild_index < child_index);
        descendants.sort_unstable();
        assert_eq!(descendants, vec![101, 102, 103]);
    }

    fn native_session_handle_with_generation(
        record: NativeSessionRecord,
        generation: u64,
    ) -> Arc<NativeSessionHandle> {
        native_session_handle_with_terminal_env_and_generation(record, HashMap::new(), generation)
    }

    fn native_session_handle_with_terminal_env(
        record: NativeSessionRecord,
        terminal_env_vars: HashMap<String, String>,
    ) -> Arc<NativeSessionHandle> {
        native_session_handle_with_terminal_env_and_generation(record, terminal_env_vars, 1)
    }

    fn native_session_handle_with_terminal_env_and_generation(
        record: NativeSessionRecord,
        terminal_env_vars: HashMap<String, String>,
        generation: u64,
    ) -> Arc<NativeSessionHandle> {
        let runtime_id = record.runtime_id.clone();
        Arc::new(NativeSessionHandle {
            generation,
            record: Mutex::new(record),
            child: Mutex::new(None),
            events: Mutex::new(SessionStore::new(&runtime_id)),
            background_tasks: Mutex::new(HashMap::new()),
            terminal_background_task_ids: Mutex::new(HashSet::new()),
            background_tool_use_ids: Mutex::new(HashSet::new()),
            completed_background_tool_use_ids: Mutex::new(HashSet::new()),
            pending_background_task_stops: Mutex::new(HashMap::new()),
            teardown_preparations: Mutex::new(HashMap::new()),
            helper_env_vars: HashMap::new(),
            terminal_env_vars,
            claude_path: None,
            codex_path: None,
            codex_base_url: None,
            codex_api_key: None,
            alive: AtomicBool::new(true),
        })
    }

    fn manager_with_handle(runtime_id: &str) -> NativeRuntimeManager {
        let record = NativeSessionRecord {
            runtime_id: runtime_id.to_string(),
            provider: NativeProvider::Claude,
            transport: NativeTransport::NativeSdk,
            provider_session_id: None,
            seed_boundary_message_count: None,
            project_dir: "/tmp/project".to_string(),
            env_name: "DeepSeek".to_string(),
            perm_mode: "dev".to_string(),
            runtime_perm_mode: None,
            effort: None,
            pending_env_name: None,
            pending_effort: None,
            pending_settings_request_id: None,
            status: "processing".to_string(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            is_active: true,
            can_handoff_to_terminal: false,
            pending_handoff_terminal: None,
            pending_handoff_allow_background_task_termination: false,
            last_error: None,
            router: None,
        };
        let handle = native_session_handle(record.clone());
        let manager = NativeRuntimeManager {
            records: Mutex::new(HashMap::from([(runtime_id.to_string(), record)])),
            handles: Mutex::new(HashMap::from([(runtime_id.to_string(), handle)])),
            next_handle_generation: AtomicU64::new(2),
            state_path: std::env::temp_dir()
                .join(format!("ccem-native-runtime-test-{runtime_id}.json")),
            event_log: NativeEventLog::new(
                std::env::temp_dir().join(format!("ccem-native-runtime-test-{runtime_id}.sqlite")),
            ),
            prompt_image_store: PromptImageStore::new(
                std::env::temp_dir()
                    .join(format!("ccem-native-runtime-test-{runtime_id}-attachments")),
            ),
            router_manager: OnceLock::new(),
            reconnect_lock: Mutex::new(()),
            settings_update_lock: Mutex::new(()),
            app_termination_lock: Mutex::new(()),
            app_termination_in_progress: AtomicBool::new(false),
            terminal_handoff_preparations: Mutex::new(HashMap::new()),
        };
        manager
    }

    fn manager_with_records(
        runtime_id: &str,
        records: Vec<NativeSessionRecord>,
    ) -> NativeRuntimeManager {
        NativeRuntimeManager {
            records: Mutex::new(
                records
                    .into_iter()
                    .map(|record| (record.runtime_id.clone(), record))
                    .collect(),
            ),
            handles: Mutex::new(HashMap::new()),
            next_handle_generation: AtomicU64::new(1),
            state_path: std::env::temp_dir().join(format!(
                "ccem-native-runtime-reconcile-test-{runtime_id}.json"
            )),
            event_log: NativeEventLog::new(std::env::temp_dir().join(format!(
                "ccem-native-runtime-reconcile-test-{runtime_id}.sqlite"
            ))),
            prompt_image_store: PromptImageStore::new(std::env::temp_dir().join(format!(
                "ccem-native-runtime-reconcile-test-{runtime_id}-attachments"
            ))),
            router_manager: OnceLock::new(),
            reconnect_lock: Mutex::new(()),
            settings_update_lock: Mutex::new(()),
            app_termination_lock: Mutex::new(()),
            app_termination_in_progress: AtomicBool::new(false),
            terminal_handoff_preparations: Mutex::new(HashMap::new()),
        }
    }

    #[test]
    fn runtime_child_is_owned_covers_handoff_matrix() {
        // Owned: an active runtime belongs to this app.
        assert!(runtime_child_is_owned(&native_record("owned", "processing", true)));

        // Handoff requested but not completed still owns the child.
        let mut pending = native_record("pending", "processing", true);
        pending.pending_handoff_terminal = Some(crate::terminal::TerminalType::TerminalApp);
        assert!(runtime_child_is_owned(&pending));

        // Completed handoff: status "handoff" and inactive -> not owned.
        assert!(!runtime_child_is_owned(&native_record(
            "handed-off",
            "handoff",
            false
        )));

        // Transient handoff bookkeeping (status set before the inactive
        // flag) keeps ownership to stay on the safe side.
        assert!(runtime_child_is_owned(&native_record(
            "transient",
            "handoff",
            true
        )));
    }

    #[test]
    fn shutdown_child_skips_completed_handoff_ownership() {
        let runtime_id = "shutdown-handed-off";
        let manager = manager_with_handle(runtime_id);
        manager
            .update_record(runtime_id, |record| {
                record.status = "handoff".to_string();
                record.is_active = false;
            })
            .expect("mark record handed off");
        manager
            .append_event(
                runtime_id,
                SessionEventPayload::BackgroundTasksChanged {
                    tasks: vec![background_task(
                        "task-owned-by-terminal",
                        NativeBackgroundTaskStatus::Running,
                    )],
                },
            )
            .expect("append handed-off background task");

        manager
            .shutdown_child(runtime_id, true)
            .expect("unowned runtime is left untouched");

        let record = manager.current_record(runtime_id).expect("record");
        assert_eq!(record.status, "handoff");
        assert!(!record.is_active);
        assert_eq!(manager.active_background_tasks(runtime_id).unwrap().len(), 1);
    }

    fn native_record(runtime_id: &str, status: &str, is_active: bool) -> NativeSessionRecord {
        NativeSessionRecord {
            runtime_id: runtime_id.to_string(),
            provider: NativeProvider::Claude,
            transport: NativeTransport::NativeSdk,
            provider_session_id: None,
            seed_boundary_message_count: None,
            project_dir: "/tmp/project".to_string(),
            env_name: "DeepSeek".to_string(),
            perm_mode: "dev".to_string(),
            runtime_perm_mode: None,
            effort: None,
            pending_env_name: None,
            pending_effort: None,
            pending_settings_request_id: None,
            status: status.to_string(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            is_active,
            can_handoff_to_terminal: false,
            pending_handoff_terminal: None,
            pending_handoff_allow_background_task_termination: false,
            last_error: None,
            router: None,
        }
    }

    fn background_task(task_id: &str, status: NativeBackgroundTaskStatus) -> NativeBackgroundTask {
        NativeBackgroundTask {
            task_id: task_id.to_string(),
            tool_use_id: Some(format!("tool-{task_id}")),
            task_type: Some("bash".to_string()),
            subagent_type: None,
            workflow_name: None,
            description: format!("Background task {task_id}"),
            status,
            started_at: Utc::now(),
            updated_at: Utc::now(),
            progress_summary: None,
            last_tool_name: None,
            usage: Some(NativeBackgroundTaskUsage {
                total_tokens: 0,
                tool_uses: 1,
                duration_ms: 10,
            }),
            terminal_summary: None,
            output_file: None,
            error: None,
            skip_transcript: Some(true),
            stop_request_id: None,
            stop_failed: None,
        }
    }

    fn reconnect_router_record(launch_transport: LaunchTransport) -> SessionRouterRecord {
        SessionRouterRecord {
            session_key: "reconnect-session-key".into(),
            route_tag_nonce: "reconnect-route-nonce".into(),
            default_env: "official".into(),
            bindings: HashMap::new(),
            allowed_envs: vec!["official".into()],
            source_profile_id: Some("profile-before-reconnect".into()),
            profile_revision: Some(7),
            dynamic_routing: true,
            revision: 11,
            router_auth_capability: RouterAuthCapability::Oauth,
            launch_transport,
            launch_auth_kind: LaunchAuthKind::Oauth,
            launch_default_env: "official".into(),
            launch_model_pins: RouterModelPins::default(),
            warnings: vec!["generation-before-reconnect".into()],
        }
    }

    #[test]
    fn history_router_resume_clones_authoritative_semantics_with_fresh_secrets() {
        let project = tempfile::tempdir().expect("history router project");
        let source_runtime_id = "native-history-router-source";
        let mut source = native_record(source_runtime_id, "stopped", false);
        source.provider_session_id = Some("provider-history-1".into());
        source.project_dir = project.path().to_string_lossy().to_string();
        let mut source_router = reconnect_router_record(LaunchTransport::Routed);
        source_router.default_env = "token-main".into();
        source_router.allowed_envs = vec!["token-main".into(), "token-agent".into()];
        source_router.bindings = HashMap::from([("subagent:Explore".into(), "token-agent".into())]);
        source_router.router_auth_capability = RouterAuthCapability::Token;
        source_router.launch_auth_kind = LaunchAuthKind::Token;
        source_router.launch_default_env = "token-main".into();
        source.router = Some(source_router.clone());
        let manager = manager_with_records(source_runtime_id, vec![source]);

        let resumed = manager
            .clone_router_record_for_history_resume(
                source_runtime_id,
                NativeProvider::Claude,
                Some("provider-history-1"),
                &project.path().join(".").to_string_lossy(),
            )
            .expect("clone routed history semantics");

        assert_ne!(resumed.session_key, source_router.session_key);
        assert_ne!(resumed.route_tag_nonce, source_router.route_tag_nonce);
        assert_eq!(resumed.default_env, source_router.default_env);
        assert_eq!(resumed.bindings, source_router.bindings);
        assert_eq!(resumed.allowed_envs, source_router.allowed_envs);
        assert_eq!(resumed.source_profile_id, source_router.source_profile_id);
        assert_eq!(resumed.profile_revision, source_router.profile_revision);
        assert_eq!(resumed.dynamic_routing, source_router.dynamic_routing);
        assert_eq!(
            resumed.router_auth_capability,
            source_router.router_auth_capability
        );
        assert_eq!(resumed.launch_transport, LaunchTransport::Routed);
        assert_eq!(resumed.revision, 0);
        assert!(resumed.warnings.is_empty());
    }

    #[test]
    fn history_router_resume_rejects_identity_mismatch_and_non_routed_sources() {
        let source_runtime_id = "native-history-router-identity";
        let mut source = native_record(source_runtime_id, "stopped", false);
        source.provider_session_id = Some("provider-history-identity".into());
        source.project_dir = "/tmp/history-router-one".into();
        source.router = Some(reconnect_router_record(LaunchTransport::Routed));
        let manager = manager_with_records(source_runtime_id, vec![source]);

        let provider_error = manager
            .clone_router_record_for_history_resume(
                source_runtime_id,
                NativeProvider::Codex,
                Some("provider-history-identity"),
                "/tmp/history-router-one",
            )
            .expect_err("provider mismatch must fail closed");
        assert!(provider_error.contains("ROUTER_RESUME_PROVIDER_MISMATCH"));

        let session_error = manager
            .clone_router_record_for_history_resume(
                source_runtime_id,
                NativeProvider::Claude,
                Some("provider-history-other"),
                "/tmp/history-router-one",
            )
            .expect_err("provider session mismatch must fail closed");
        assert!(session_error.contains("ROUTER_RESUME_SESSION_MISMATCH"));

        let cwd_error = manager
            .clone_router_record_for_history_resume(
                source_runtime_id,
                NativeProvider::Claude,
                Some("provider-history-identity"),
                "/tmp/history-router-two",
            )
            .expect_err("cwd mismatch must fail closed");
        assert!(cwd_error.contains("ROUTER_RESUME_CWD_MISMATCH"));

        let direct_runtime_id = "native-history-router-direct";
        let mut direct = native_record(direct_runtime_id, "stopped", false);
        direct.provider_session_id = Some("provider-history-direct".into());
        direct.project_dir = "/tmp/history-router-direct".into();
        direct.router = Some(reconnect_router_record(LaunchTransport::Direct));
        let direct_manager = manager_with_records(direct_runtime_id, vec![direct]);
        let direct_error = direct_manager
            .clone_router_record_for_history_resume(
                direct_runtime_id,
                NativeProvider::Claude,
                Some("provider-history-direct"),
                "/tmp/history-router-direct",
            )
            .expect_err("direct source must not be upgraded to routed");
        assert!(direct_error.contains("ROUTER_RESUME_SOURCE_NOT_ROUTED"));

        let no_router_runtime_id = "native-history-router-none";
        let mut no_router = native_record(no_router_runtime_id, "stopped", false);
        no_router.provider_session_id = Some("provider-history-none".into());
        no_router.project_dir = "/tmp/history-router-none".into();
        let no_router_manager = manager_with_records(no_router_runtime_id, vec![no_router]);
        let no_router_error = no_router_manager
            .clone_router_record_for_history_resume(
                no_router_runtime_id,
                NativeProvider::Claude,
                Some("provider-history-none"),
                "/tmp/history-router-none",
            )
            .expect_err("legacy direct history must stay opted out");
        assert!(no_router_error.contains("ROUTER_RESUME_SOURCE_NOT_ROUTED"));
    }

    #[test]
    fn history_router_resume_reuses_recovery_gates_before_any_new_record_exists() {
        let env_name = "native-history-resume-unavailable-token";
        let _env_override = crate::router::register_test_router_environment(
            env_name,
            crate::config::EnvConfig {
                base_url: Some("http://127.0.0.1:1".into()),
                auth_token: Some("fixture-token".into()),
                default_opus_model: None,
                default_sonnet_model: None,
                default_haiku_model: None,
                model: None,
                subagent_model: None,
                limit_write_tools: false,
            },
        );
        let source_runtime_id = "native-history-router-unavailable";
        let mut source = native_record(source_runtime_id, "stopped", false);
        source.provider_session_id = Some("provider-history-unavailable".into());
        source.project_dir = "/tmp/history-router-unavailable".into();
        let mut source_router = reconnect_router_record(LaunchTransport::Routed);
        source_router.default_env = env_name.into();
        source_router.allowed_envs = vec![env_name.into()];
        source_router.router_auth_capability = RouterAuthCapability::Token;
        source_router.launch_auth_kind = LaunchAuthKind::Token;
        source_router.launch_default_env = env_name.into();
        source.router = Some(source_router.clone());
        let manager = manager_with_records(source_runtime_id, vec![source]);
        manager
            .set_router_manager(Arc::new(RouterManager::new(RouterConfig::default())))
            .expect("set unavailable router manager");
        let resumed = manager
            .clone_router_record_for_history_resume(
                source_runtime_id,
                NativeProvider::Claude,
                Some("provider-history-unavailable"),
                "/tmp/history-router-unavailable",
            )
            .expect("clone authoritative record");
        let mut options = native_session_options("dev", None);
        options.env_name = env_name.into();
        options.router_record = Some(resumed);

        let error = manager
            .prepare_router_launch(&mut options, false)
            .expect_err("listener unavailability must reject the history continuation");

        assert!(error.contains("ROUTER_UNAVAILABLE"), "{error}");
        let records = manager.records.lock().expect("records");
        assert_eq!(
            records.len(),
            1,
            "resume preparation must not insert a record"
        );
        assert_eq!(
            records[source_runtime_id]
                .router
                .as_ref()
                .expect("source router")
                .session_key,
            source_router.session_key,
            "source private state remains untouched",
        );
    }

    #[test]
    fn history_router_resume_revalidates_current_targets_and_auth_capability() {
        let main_env = "native-history-resume-main-token";
        let _main_override = crate::router::register_test_router_environment(
            main_env,
            crate::config::EnvConfig {
                base_url: Some("http://127.0.0.1:1".into()),
                auth_token: Some("fixture-token".into()),
                default_opus_model: None,
                default_sonnet_model: None,
                default_haiku_model: None,
                model: None,
                subagent_model: None,
                limit_write_tools: false,
            },
        );
        let source_runtime_id = "native-history-router-missing-target";
        let mut source = native_record(source_runtime_id, "stopped", false);
        source.provider_session_id = Some("provider-history-missing-target".into());
        source.project_dir = "/tmp/history-router-missing-target".into();
        let mut source_router = reconnect_router_record(LaunchTransport::Routed);
        source_router.default_env = main_env.into();
        source_router.bindings = HashMap::from([(
            "subagent:Explore".into(),
            "native-history-resume-deleted-target".into(),
        )]);
        source_router.allowed_envs = vec![
            main_env.into(),
            "native-history-resume-deleted-target".into(),
        ];
        source_router.router_auth_capability = RouterAuthCapability::Token;
        source_router.launch_auth_kind = LaunchAuthKind::Token;
        source_router.launch_default_env = main_env.into();
        source.router = Some(source_router);
        let manager = manager_with_records(source_runtime_id, vec![source]);
        let router_manager = Arc::new(RouterManager::new(RouterConfig::default()));
        router_manager.set_ready(61_236);
        manager
            .set_router_manager(router_manager)
            .expect("set ready router manager");
        let resumed = manager
            .clone_router_record_for_history_resume(
                source_runtime_id,
                NativeProvider::Claude,
                Some("provider-history-missing-target"),
                "/tmp/history-router-missing-target",
            )
            .expect("clone authoritative record");
        let mut options = native_session_options("dev", None);
        options.env_name = main_env.into();
        options.router_record = Some(resumed);

        let target_error = manager
            .prepare_router_launch(&mut options, false)
            .expect_err("a deleted target must fail closed");
        assert!(
            target_error.contains("ROUTER_ENV_MISSING"),
            "{target_error}"
        );

        let _official_override = crate::router::register_test_router_environment(
            crate::config::OFFICIAL_ENV_NAME,
            crate::config::EnvConfig {
                base_url: Some("https://api.anthropic.com".into()),
                auth_token: None,
                default_opus_model: None,
                default_sonnet_model: None,
                default_haiku_model: None,
                model: None,
                subagent_model: None,
                limit_write_tools: false,
            },
        );
        let auth_manager = manager_with_handle("native-history-router-auth-drift");
        let ready = Arc::new(RouterManager::new(RouterConfig::default()));
        ready.set_ready(61_237);
        auth_manager
            .set_router_manager(ready)
            .expect("set ready auth router manager");
        let mut auth_options = native_session_options("dev", None);
        auth_options.env_name = crate::config::OFFICIAL_ENV_NAME.into();
        let mut auth_drifted = reconnect_router_record(LaunchTransport::Routed);
        auth_drifted.router_auth_capability = RouterAuthCapability::Token;
        auth_drifted.launch_auth_kind = LaunchAuthKind::Token;
        auth_options.router_record = Some(auth_drifted);

        let auth_error = auth_manager
            .prepare_router_launch(&mut auth_options, false)
            .expect_err("token to OAuth auth drift must fail closed");
        assert!(auth_error.contains("ROUTER_AUTH_CHANGED"), "{auth_error}");
    }

    #[test]
    fn router_create_selection_rejects_draft_and_history_resume_together() {
        let draft = RouterLaunchDraft::default();
        let error = validate_router_create_selection(Some(&draft), Some("native-source"))
            .expect_err("the two router launch authorities must be mutually exclusive");
        assert!(error.contains("ROUTER_CREATE_CONFLICT"));

        validate_router_create_selection(Some(&draft), None).expect("draft-only launch");
        validate_router_create_selection(None, Some("native-source"))
            .expect("history-resume-only launch");
        validate_router_create_selection(None, None).expect("direct launch");
    }

    #[test]
    fn router_launch_transport_matrix_is_explicit_fail_closed_and_generation_scoped() {
        use LaunchTransport::{Direct, Routed};
        use RouterAuthCapability::{Oauth, Token};
        use RouterLaunchDecision::{Bypass, LaunchDirect, LaunchRouted, RejectUnavailable};

        let cases = [
            (None, false, false, Token, false, Bypass),
            (None, false, true, Token, true, Bypass),
            (None, true, false, Token, false, RejectUnavailable),
            (None, true, true, Token, false, LaunchRouted),
            (None, true, true, Oauth, false, RejectUnavailable),
            (None, true, true, Oauth, true, LaunchRouted),
            (Some(Direct), true, false, Token, false, LaunchDirect),
            (Some(Direct), true, true, Token, false, LaunchDirect),
            (Some(Direct), true, true, Oauth, false, LaunchDirect),
            (Some(Direct), true, true, Oauth, true, LaunchDirect),
            (Some(Routed), true, false, Token, false, RejectUnavailable),
            (Some(Routed), true, true, Token, false, LaunchRouted),
            (Some(Routed), true, true, Oauth, false, RejectUnavailable),
            (Some(Routed), true, true, Oauth, true, LaunchRouted),
            (Some(Routed), false, true, Token, false, LaunchRouted),
            (Some(Direct), false, true, Token, false, LaunchDirect),
        ];

        for (previous, requested, ready, auth, oauth_verified, expected) in cases {
            assert_eq!(
                router_launch_decision(previous, requested, ready, auth, oauth_verified),
                expected,
                "previous={previous:?} requested={requested} ready={ready} auth={auth:?} oauth_verified={oauth_verified}",
            );
        }
    }

    #[test]
    fn router_opt_in_is_not_inherited_by_the_next_new_session() {
        assert_eq!(
            router_launch_decision(None, true, true, RouterAuthCapability::Token, false,),
            RouterLaunchDecision::LaunchRouted
        );
        assert_eq!(
            router_launch_decision(None, false, true, RouterAuthCapability::Token, false,),
            RouterLaunchDecision::Bypass
        );
    }

    #[test]
    fn my_default_launch_provenance_requires_an_exact_config_snapshot() {
        let config = RouterConfig {
            bindings: HashMap::from([("background".into(), "glm".into())]),
            default_allowed_envs: vec!["glm".into()],
            dynamic_routing: false,
            ..RouterConfig::default()
        };
        let mut draft = RouterLaunchDraft {
            bindings: config.bindings.clone(),
            allowed_envs: config.default_allowed_envs.clone(),
            source_profile_id: Some("my-default".into()),
            profile_revision: None,
            dynamic_routing: Some(config.dynamic_routing),
        };

        validate_router_launch_draft_profile(&config, &draft)
            .expect("the current my-default snapshot is valid");

        draft.dynamic_routing = Some(true);
        let error = validate_router_launch_draft_profile(&config, &draft)
            .expect_err("a stale my-default snapshot must fail closed");
        assert!(error.contains("ROUTER_PROFILE_STALE"), "{error}");
    }

    #[test]
    fn named_profile_launch_provenance_requires_current_dynamic_routing() {
        let profile = RouterProfile {
            id: "chores".into(),
            name: "Chores".into(),
            revision: 4,
            bindings: HashMap::from([("background".into(), "glm".into())]),
            allowed_envs: vec!["glm".into()],
        };
        let config = RouterConfig {
            profiles: vec![profile.clone()],
            dynamic_routing: false,
            ..RouterConfig::default()
        };
        let mut draft = RouterLaunchDraft {
            bindings: profile.bindings,
            allowed_envs: profile.allowed_envs,
            source_profile_id: Some(profile.id),
            profile_revision: Some(profile.revision),
            dynamic_routing: Some(true),
        };

        let error = validate_router_launch_draft_profile(&config, &draft)
            .expect_err("stale dynamicRouting must fail closed");
        assert!(error.contains("ROUTER_PROFILE_STALE"), "{error}");

        draft.dynamic_routing = Some(config.dynamic_routing);
        validate_router_launch_draft_profile(&config, &draft)
            .expect("the current named profile snapshot is valid");
    }

    #[test]
    fn new_session_without_router_launch_draft_stays_direct() {
        let manager = manager_with_handle("native-router-opt-in-off");
        manager
            .set_router_manager(Arc::new(RouterManager::new(RouterConfig::default())))
            .expect("set router manager");
        let mut options = native_session_options("dev", None);
        options.env_name = crate::config::OFFICIAL_ENV_NAME.to_string();

        manager
            .prepare_router_launch(&mut options, false)
            .expect("an ordinary new session remains direct");

        assert_eq!(options.router_record, None);
        assert!(options.router_launch_draft.is_none());
    }

    #[test]
    fn legacy_none_and_direct_records_keep_their_recovery_transport() {
        let manager = manager_with_handle("native-router-legacy-recovery");
        let router_manager = Arc::new(RouterManager::new(RouterConfig::default()));
        router_manager.set_ready(61_235);
        manager
            .set_router_manager(router_manager)
            .expect("set ready router manager");

        let mut none = native_session_options("dev", None);
        none.env_name = crate::config::OFFICIAL_ENV_NAME.to_string();
        manager
            .prepare_router_launch(&mut none, true)
            .expect("legacy sessions without router state stay direct");
        assert_eq!(none.router_record, None);

        let mut direct = native_session_options("dev", None);
        direct.env_name = crate::config::OFFICIAL_ENV_NAME.to_string();
        direct.router_record = Some(reconnect_router_record(LaunchTransport::Direct));
        manager
            .prepare_router_launch(&mut direct, true)
            .expect("legacy direct router records stay direct");
        assert_eq!(
            direct
                .router_record
                .as_ref()
                .map(|router| router.launch_transport),
            Some(LaunchTransport::Direct)
        );
    }

    #[test]
    fn explicit_router_launch_draft_fails_closed_without_listener_and_leaves_no_record() {
        let manager = manager_with_handle("native-router-opt-in-unavailable");
        manager
            .set_router_manager(Arc::new(RouterManager::new(RouterConfig::default())))
            .expect("set router manager");
        let mut options = native_session_options("dev", None);
        options.env_name = crate::config::OFFICIAL_ENV_NAME.to_string();
        options.router_launch_draft = Some(RouterLaunchDraft::default());

        let error = manager
            .prepare_router_launch(&mut options, false)
            .expect_err("an explicit router launch must fail closed");

        assert!(error.contains("ROUTER_UNAVAILABLE"), "{error}");
        assert_eq!(options.router_record, None);
    }

    #[test]
    fn empty_router_launch_draft_routes_only_the_main_environment() {
        let env_name = "native-empty-router-draft-token";
        let _env_override = crate::router::register_test_router_environment(
            env_name,
            crate::config::EnvConfig {
                base_url: Some("http://127.0.0.1:1".into()),
                auth_token: Some("fixture-token".into()),
                default_opus_model: None,
                default_sonnet_model: None,
                default_haiku_model: None,
                model: None,
                subagent_model: None,
                limit_write_tools: false,
            },
        );
        let manager = manager_with_handle("native-router-empty-draft");
        let router_manager = Arc::new(RouterManager::new(RouterConfig::default()));
        router_manager.set_ready(61_234);
        manager
            .set_router_manager(router_manager)
            .expect("set ready router manager");
        let mut options = native_session_options("dev", None);
        options.env_name = env_name.to_string();
        options.router_launch_draft = Some(RouterLaunchDraft::default());

        manager
            .prepare_router_launch(&mut options, false)
            .expect("empty draft routes with the main environment only");

        let router = options.router_record.expect("routed session record");
        assert_eq!(router.launch_transport, LaunchTransport::Routed);
        assert_eq!(router.default_env, env_name);
        assert_eq!(router.allowed_envs, vec![env_name]);
        assert!(router.bindings.is_empty());
    }

    #[test]
    fn codex_router_launch_draft_is_rejected_instead_of_silently_cleared() {
        let manager = manager_with_handle("native-codex-router-opt-in");
        let mut options = native_session_options("dev", None);
        options.provider = NativeProvider::Codex;
        options.router_launch_draft = Some(RouterLaunchDraft::default());

        let error = manager
            .prepare_router_launch(&mut options, false)
            .expect_err("Codex cannot opt in to the Claude router");

        assert!(error.contains("ROUTER_PROVIDER_UNSUPPORTED"), "{error}");
        assert_eq!(options.router_record, None);
    }

    #[test]
    fn direct_oauth_to_token_main_patch_is_not_blocked_by_the_router_oauth_gate() {
        let mut current = reconnect_router_record(LaunchTransport::Direct);
        current
            .allowed_envs
            .push("zz-ccem-missing-token-main-test".into());
        let token_main_patch = SessionRouterPatch {
            default_env: Some("zz-ccem-missing-token-main-test".into()),
            ..SessionRouterPatch::default()
        };

        assert!(session_router_patch_oauth_validation_enabled(&current));
        let error = apply_session_router_patch(
            &current,
            current.revision,
            &token_main_patch,
            session_router_patch_oauth_validation_enabled(&current),
        )
        .expect_err("synthetic token environment is intentionally absent");
        assert_eq!(
            error.code, "ROUTER_ENV_MISSING",
            "direct patch must pass the router-only OAuth gate before environment resolution"
        );
    }

    #[test]
    fn routed_oauth_session_patch_keeps_the_oauth_gate_closed() {
        let mut current = reconnect_router_record(LaunchTransport::Routed);
        current
            .allowed_envs
            .push("zz-ccem-missing-token-main-test".into());
        let token_main_patch = SessionRouterPatch {
            default_env: Some("zz-ccem-missing-token-main-test".into()),
            ..SessionRouterPatch::default()
        };

        assert!(!session_router_patch_oauth_validation_enabled(&current));
        let error = apply_session_router_patch(
            &current,
            current.revision,
            &token_main_patch,
            session_router_patch_oauth_validation_enabled(&current),
        )
        .expect_err("routed OAuth generation must remain fail-closed");
        assert_eq!(error.code, "ROUTER_OAUTH_NOT_VERIFIED");
    }

    #[test]
    fn browser_policy_uses_runtime_permission_override_from_record() {
        let mut record = native_record("native-browser-policy", "ready", true);
        record.perm_mode = "dev".to_string();
        record.runtime_perm_mode = Some("readonly".to_string());

        assert!(authorize_browser_tool_for_record(&record, "snapshot").is_ok());
        assert!(authorize_browser_tool_for_record(&record, "click").is_err());

        record.perm_mode = "readonly".to_string();
        record.runtime_perm_mode = Some("dev".to_string());

        assert!(authorize_browser_tool_for_record(&record, "click").is_ok());
    }

    fn native_session_options(
        perm_mode: &str,
        runtime_perm_mode: Option<&str>,
    ) -> NativeSessionOptions {
        NativeSessionOptions {
            provider: NativeProvider::Claude,
            env_name: "default".to_string(),
            perm_mode: perm_mode.to_string(),
            runtime_perm_mode: runtime_perm_mode.map(str::to_string),
            working_dir: "/tmp/project".to_string(),
            initial_prompt: None,
            display_prompt: None,
            initial_images: None,
            initial_annotations: None,
            provider_session_id: None,
            seed_boundary_message_count: None,
            helper_env_vars: HashMap::new(),
            terminal_env_vars: HashMap::new(),
            claude_path: None,
            codex_path: None,
            codex_base_url: None,
            codex_api_key: None,
            effort: None,
            router_launch_draft: None,
            router_record: None,
        }
    }

    #[test]
    fn replay_events_limited_returns_empty_batch_when_nothing_pending() {
        let runtime_id = "native-replay-fastpath";
        let manager = manager_with_handle(runtime_id);

        for seq in 1..=3 {
            manager
                .append_event(
                    runtime_id,
                    SessionEventPayload::AssistantChunk {
                        text: format!("chunk-{seq}"),
                    },
                )
                .expect("append chunk");
        }

        // Zero-pending incremental replay: empty batch with accurate bounds,
        // identical to the shape a full empty replay produces.
        let fast = manager
            .replay_events_limited(runtime_id, Some(3), None)
            .expect("fast-path replay");
        assert!(fast.events.is_empty());
        assert!(!fast.gap_detected);
        assert!(!fast.truncated);
        assert_eq!(fast.oldest_available_seq, Some(1));
        assert_eq!(fast.newest_available_seq, Some(3));

        let slow = manager
            .replay_events_limited(runtime_id, None, None)
            .expect("full replay");
        assert_eq!(fast.oldest_available_seq, slow.oldest_available_seq);
        assert_eq!(fast.newest_available_seq, slow.newest_available_seq);

        // Pending events still replay through the normal path.
        let incremental = manager
            .replay_events_limited(runtime_id, Some(1), None)
            .expect("incremental replay");
        assert_eq!(
            incremental
                .events
                .iter()
                .map(|event| event.seq)
                .collect::<Vec<_>>(),
            vec![2, 3],
        );
    }

    #[test]
    fn helper_stdout_accepts_multiple_jsonl_events_in_one_chunk() {
        let runtime_id = "native-jsonl";
        let manager = manager_with_handle(runtime_id);
        let chunk = concat!(
            r#"{"type":"event","payload":{"type":"stderr_line","line":"first error"}}"#,
            "\n",
            r#"{"type":"event","payload":{"type":"session_completed","reason":"done"}}"#,
            "\n",
        );

        manager
            .process_helper_stdout(runtime_id, chunk)
            .expect("process jsonl chunk");

        let batch = manager
            .replay_events(runtime_id, None)
            .expect("replay events");

        assert_eq!(batch.events.len(), 2);
        assert_eq!(
            batch.events[0].payload,
            SessionEventPayload::StdErrLine {
                line: "first error".to_string(),
            }
        );
        assert_eq!(
            batch.events[1].payload,
            SessionEventPayload::SessionCompleted {
                reason: "done".to_string(),
            }
        );
    }

    #[test]
    fn helper_teardown_preparation_ack_is_correlated_by_request_id() {
        let runtime_id = "native-teardown-prepared";
        let manager = manager_with_handle(runtime_id);
        manager
            .process_helper_stdout(
                runtime_id,
                r#"{"type":"teardown_prepared","request_id":"prepare-1","ready":true}"#,
            )
            .expect("process teardown preparation");
        let handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .cloned()
            .expect("handle");
        assert_eq!(
            handle
                .teardown_preparations
                .lock()
                .expect("preparations")
                .remove("prepare-1"),
            Some(Ok(()))
        );
    }

    #[test]
    fn helper_token_usage_records_official_token_counts() {
        let runtime_id = "native-token-usage";
        let manager = manager_with_handle(runtime_id);

        manager
            .process_helper_stdout(
                runtime_id,
                r#"{"type":"event","payload":{"type":"token_usage","provider":"claude","input_tokens":10,"output_tokens":120,"cache_read_tokens":0,"cache_creation_tokens":0}}"#,
            )
            .expect("process token usage");

        let summary = manager.summary_for(runtime_id).expect("summary");
        assert_eq!(summary.runtime_id, runtime_id);

        let batch = manager
            .replay_events(runtime_id, None)
            .expect("replay events");
        assert_eq!(batch.events.len(), 1);
        match &batch.events[0].payload {
            SessionEventPayload::TokenUsage {
                input_tokens,
                output_tokens,
                ..
            } => {
                assert_eq!(*input_tokens, 10);
                assert_eq!(*output_tokens, 120);
            }
            payload => panic!("unexpected payload: {:?}", payload),
        }
    }

    #[test]
    fn context_usage_probe_stderr_does_not_set_last_error() {
        let runtime_id = "native-context-usage-probe";
        let manager = manager_with_handle(runtime_id);

        manager
            .process_helper_stdout(
                runtime_id,
                r#"{"type":"event","payload":{"type":"stderr_line","line":"[context_usage] getContextUsage failed: Error: q.match is not a function"}}"#,
            )
            .expect("process context usage probe stderr");

        let summary = manager.summary_for(runtime_id).expect("summary");
        assert_eq!(summary.last_error, None);

        let batch = manager
            .replay_events(runtime_id, None)
            .expect("replay events");
        assert_eq!(batch.events.len(), 1);
        assert_eq!(
            batch.events[0].payload,
            SessionEventPayload::StdErrLine {
                line: "[context_usage] getContextUsage failed: Error: q.match is not a function"
                    .to_string(),
            }
        );
    }

    #[test]
    fn read_state_clears_persisted_context_usage_probe_error() {
        let mut record = native_record("native-context-usage-state", "ready", true);
        record.last_error = Some(
            "[context_usage] getContextUsage failed: Error: q.match is not a function".to_string(),
        );
        let state_path = std::env::temp_dir().join(format!(
            "ccem-native-runtime-context-usage-state-{}.json",
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        let serialized = serde_json::to_string(&serde_json::json!({
            "sessions": [record],
        }))
        .expect("serialize state");
        fs::write(&state_path, serialized).expect("write state");

        let state = read_native_runtime_state_from(&state_path).expect("read state");

        assert_eq!(state.sessions.len(), 1);
        assert_eq!(state.sessions[0].last_error, None);

        let _ = fs::remove_file(state_path);
    }

    #[test]
    fn helper_output_buffers_partial_json_until_newline() {
        let mut buffer = Vec::new();
        let first = drain_helper_output_lines(&mut buffer, br#"{"type":"status","status":"ready""#);
        assert!(first.is_empty());

        let second = drain_helper_output_lines(
            &mut buffer,
            br#","detail":"ok"}
{"type":"status","status":"processing","detail":"go"}
"#,
        );

        assert_eq!(
            second,
            vec![
                r#"{"type":"status","status":"ready","detail":"ok"}"#.to_string(),
                r#"{"type":"status","status":"processing","detail":"go"}"#.to_string(),
            ]
        );
    }

    #[test]
    fn helper_init_serializes_initial_images_for_first_turn() {
        let env_vars = HashMap::new();
        let images = vec![PromptImage {
            media_type: "image/png".to_string(),
            base64_data: "iVBORw0KGgo=".to_string(),
            placeholder: Some("[Image #1]".to_string()),
        }];

        let command = HelperInputCommand::Init {
            provider: "claude",
            env_name: "default",
            perm_mode: "dev",
            allow_dangerously_skip_permissions: false,
            working_dir: "/tmp/project",
            env_vars: &env_vars,
            initial_prompt: Some("describe this"),
            initial_images: Some(images.as_slice()),
            provider_session_id: None,
            claude_path: None,
            codex_path: None,
            codex_base_url: None,
            codex_api_key: None,
            effort: None,
            todo_snapshot_seed: None,
            router: None,
        };

        let serialized = serde_json::to_value(command).expect("serialize init command");
        assert_eq!(serialized["initial_prompt"], "describe this");
        assert_eq!(serialized["initial_images"][0]["mediaType"], "image/png");
        assert_eq!(
            serialized["initial_images"][0]["base64Data"],
            "iVBORw0KGgo="
        );
        assert_eq!(serialized["initial_images"][0]["placeholder"], "[Image #1]");
    }

    #[test]
    fn helper_init_serializes_todo_snapshot_seed_for_reconnect() {
        let env_vars = HashMap::new();
        let seed = TodoSnapshotV1 {
            version: 1,
            provider: "claude".to_string(),
            source: "TaskList".to_string(),
            revision: 7,
            items: vec![TodoSnapshotItemV1 {
                id: "task-1".to_string(),
                text: "Preserve this task".to_string(),
                status: "pending".to_string(),
                active_text: None,
            }],
        };
        let command = HelperInputCommand::Init {
            provider: "claude",
            env_name: "default",
            perm_mode: "dev",
            allow_dangerously_skip_permissions: false,
            working_dir: "/tmp/project",
            env_vars: &env_vars,
            initial_prompt: None,
            initial_images: None,
            provider_session_id: Some("provider-session"),
            claude_path: None,
            codex_path: None,
            codex_base_url: None,
            codex_api_key: None,
            effort: None,
            todo_snapshot_seed: Some(&seed),
            router: None,
        };

        let serialized = serde_json::to_value(command).expect("serialize init command");
        assert_eq!(serialized["todo_snapshot_seed"]["revision"], 7);
        assert_eq!(
            serialized["todo_snapshot_seed"]["items"][0]["text"],
            "Preserve this task"
        );
    }

    #[test]
    fn helper_init_can_enable_later_bypass_restore_while_starting_in_plan() {
        let env_vars = HashMap::new();
        let command = HelperInputCommand::Init {
            provider: "claude",
            env_name: "default",
            perm_mode: "plan",
            allow_dangerously_skip_permissions: true,
            working_dir: "/tmp/project",
            env_vars: &env_vars,
            initial_prompt: None,
            initial_images: None,
            provider_session_id: None,
            claude_path: None,
            codex_path: None,
            codex_base_url: None,
            codex_api_key: None,
            effort: None,
            todo_snapshot_seed: None,
            router: None,
        };

        let serialized = serde_json::to_value(command).expect("serialize init command");
        assert_eq!(serialized["perm_mode"], "plan");
        assert_eq!(serialized["allow_dangerously_skip_permissions"], true);
    }

    #[test]
    fn yolo_session_started_in_runtime_plan_mode_keeps_bypass_available() {
        let options = native_session_options("yolo", Some("plan"));

        assert!(native_session_allows_dangerously_skip_permissions(&options));
    }

    #[test]
    fn non_yolo_plan_session_does_not_enable_bypass_restore() {
        let options = native_session_options("dev", Some("plan"));

        assert!(!native_session_allows_dangerously_skip_permissions(
            &options
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn terminal_handoff_preparation_preserves_desktop_terminal_env() {
        let runtime_id = "native-handoff-terminal-env";
        let mut record = native_record(runtime_id, "ready", true);
        record.provider_session_id = Some("provider-session-bridge".to_string());
        let mut terminal_env_vars = HashMap::new();
        terminal_env_vars.insert("CCEM_RUNTIME_ID".to_string(), runtime_id.to_string());
        terminal_env_vars.insert("CCEM_SESSION_ID".to_string(), runtime_id.to_string());
        terminal_env_vars.insert(
            "CCEM_TEST_DESKTOP_PERMISSION_BRIDGE".to_string(),
            "connected".to_string(),
        );
        let handle = native_session_handle_with_terminal_env(record.clone(), terminal_env_vars);
        let manager = NativeRuntimeManager {
            records: Mutex::new(HashMap::from([(runtime_id.to_string(), record)])),
            handles: Mutex::new(HashMap::from([(runtime_id.to_string(), handle)])),
            next_handle_generation: AtomicU64::new(2),
            state_path: std::env::temp_dir().join(format!(
                "ccem-native-runtime-terminal-env-test-{runtime_id}.json"
            )),
            event_log: NativeEventLog::new(std::env::temp_dir().join(format!(
                "ccem-native-runtime-terminal-env-test-{runtime_id}.sqlite"
            ))),
            prompt_image_store: PromptImageStore::new(std::env::temp_dir().join(format!(
                "ccem-native-runtime-terminal-env-test-{runtime_id}-attachments"
            ))),
            router_manager: OnceLock::new(),
            reconnect_lock: Mutex::new(()),
            settings_update_lock: Mutex::new(()),
            app_termination_lock: Mutex::new(()),
            app_termination_in_progress: AtomicBool::new(false),
            terminal_handoff_preparations: Mutex::new(HashMap::new()),
        };

        let handoff = manager
            .prepare_terminal_handoff(
                runtime_id,
                Some(crate::terminal::TerminalType::TerminalApp),
                false,
            )
            .expect("handoff should be ready");

        assert_eq!(handoff.resume_session_id, "provider-session-bridge");
        assert_eq!(handoff.runtime_id, runtime_id);
        assert_eq!(
            handoff.env_vars.get("CCEM_RUNTIME_ID").map(String::as_str),
            Some(runtime_id)
        );
        assert_eq!(
            handoff.env_vars.get("CCEM_SESSION_ID").map(String::as_str),
            Some(runtime_id)
        );
        assert_eq!(
            handoff
                .env_vars
                .get("CCEM_TEST_DESKTOP_PERMISSION_BRIDGE")
                .map(String::as_str),
            Some("connected")
        );
        assert!(handoff.preparation_id.is_some());
    }

    #[test]
    fn terminal_handoff_rejects_a_processing_foreground_without_a_live_helper_ack() {
        let runtime_id = "native-handoff-processing";
        let manager = manager_with_handle(runtime_id);
        manager
            .update_record(runtime_id, |record| {
                record.status = "processing".to_string();
                record.provider_session_id = Some("provider-session-processing".to_string());
            })
            .expect("set processing handoff record");

        let error = manager
            .prepare_terminal_handoff(
                runtime_id,
                Some(crate::terminal::TerminalType::TerminalApp),
                false,
            )
            .expect_err("processing foreground must block handoff");
        assert!(error.contains("Finish the current foreground turn"));
    }

    #[test]
    fn native_user_prompt_events_are_replayable() {
        let runtime_id = format!(
            "native-user-prompt-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        let manager = manager_with_handle(&runtime_id);
        let images = vec![PromptImage {
            media_type: "image/png".to_string(),
            base64_data: "iVBORw0KGgo=".to_string(),
            placeholder: Some("[Image #1]".to_string()),
        }];
        let prompt_annotations = vec![SessionPromptAnnotation {
            quote: "selected code".to_string(),
            note: "keep the user input visible".to_string(),
        }];

        manager
            .append_user_prompt_event(
                &runtime_id,
                "continue",
                Some(&images),
                Some(&prompt_annotations),
            )
            .expect("append user prompt event");

        let batch = manager
            .replay_events(&runtime_id, None)
            .expect("replay events");

        assert_eq!(batch.events.len(), 1);
        let SessionEventPayload::UserPrompt {
            text,
            image_count,
            images,
            annotations,
            canonical_hash,
        } = &batch.events[0].payload
        else {
            panic!("expected user prompt event");
        };
        assert_eq!(text, "continue");
        assert_eq!(*image_count, 1);
        assert_eq!(annotations, &Some(prompt_annotations));
        assert_eq!(canonical_hash.as_deref().map(str::len), Some(64));
        let image = images
            .as_ref()
            .and_then(|items| items.first())
            .expect("stored prompt image");
        assert_eq!(image.media_type, "image/png");
        assert_eq!(image.base64_data, None);
        assert_eq!(image.byte_size, Some(8));
        assert_eq!(image.placeholder.as_deref(), Some("[Image #1]"));
        assert_eq!(image.sha256.as_deref().map(str::len), Some(64));
        let storage_path = image
            .storage_path
            .as_deref()
            .expect("stored prompt image path");
        assert!(storage_path.ends_with(".png"));
        assert_eq!(
            manager
                .prompt_image_store
                .read_data_url(storage_path, &image.media_type)
                .expect("read stored prompt image"),
            "data:image/png;base64,iVBORw0KGgo="
        );

        let persisted_json = serde_json::to_value(&batch.events[0].payload)
            .expect("serialize persisted user prompt event");
        assert!(persisted_json["images"][0].get("base64Data").is_none());
        assert_eq!(
            persisted_json["images"][0]["storagePath"],
            serde_json::Value::String(storage_path.to_string())
        );
        assert_eq!(
            persisted_json["canonical_hash"].as_str().map(str::len),
            Some(64)
        );
    }

    #[test]
    fn native_user_prompt_rejects_annotation_overflow_without_persisting_an_event() {
        let runtime_id = format!(
            "native-user-prompt-annotation-limit-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        let manager = manager_with_handle(&runtime_id);
        let annotations = (0..21)
            .map(|index| SessionPromptAnnotation {
                quote: format!("quote {index}"),
                note: format!("note {index}"),
            })
            .collect::<Vec<_>>();

        let error = manager
            .append_user_prompt_event(&runtime_id, "continue", None, Some(&annotations))
            .expect_err("annotation overflow must fail");

        assert!(error.contains("at most 20 annotations"));
        assert!(manager
            .replay_events(&runtime_id, None)
            .expect("replay events")
            .events
            .is_empty());
    }

    #[test]
    fn native_session_summary_preserves_seed_boundary_message_count() {
        let runtime_id = "native-seed-boundary-summary";
        let mut record = native_record(runtime_id, "processing", true);
        record.provider_session_id = Some("provider-session-1".to_string());
        record.seed_boundary_message_count = Some(12);
        let manager = manager_with_records(runtime_id, vec![record]);

        let summary = manager.summary_for(runtime_id).expect("summary");

        assert_eq!(summary.seed_boundary_message_count, Some(12));
    }

    #[test]
    fn interactive_prompt_response_is_replayable_as_user_prompt() {
        let runtime_id = format!(
            "native-interactive-response-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        let manager = manager_with_handle(&runtime_id);
        let answers = HashMap::from([("Pick one".to_string(), "Use the SQLite path".to_string())]);
        let prompt_annotations = vec![SessionPromptAnnotation {
            quote: "current query".to_string(),
            note: "keep the response visible".to_string(),
        }];

        manager
            .append_interactive_prompt_response_event(
                &runtime_id,
                Some("Use the SQLite path"),
                &answers,
                Some(&prompt_annotations),
            )
            .expect("append interactive response event");

        let batch = manager
            .replay_events(&runtime_id, None)
            .expect("replay events");

        assert_eq!(batch.events.len(), 1);
        let SessionEventPayload::UserPrompt {
            text,
            image_count,
            images,
            annotations,
            canonical_hash,
        } = &batch.events[0].payload
        else {
            panic!("expected user prompt event");
        };
        assert_eq!(text, "Use the SQLite path");
        assert_eq!(*image_count, 0);
        assert_eq!(images, &None);
        assert_eq!(annotations, &Some(prompt_annotations));
        assert_eq!(canonical_hash.as_deref().map(str::len), Some(64));
    }

    #[test]
    fn failed_interactive_prompt_delivery_does_not_persist_a_user_prompt() {
        let runtime_id = format!(
            "native-interactive-response-failed-write-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        let manager = manager_with_handle(&runtime_id);
        let answers = HashMap::from([("Pick one".to_string(), "Use SQLite".to_string())]);
        let prompt_annotations = vec![SessionPromptAnnotation {
            quote: "current query".to_string(),
            note: "only persist after delivery".to_string(),
        }];

        let error = manager
            .deliver_and_append_interactive_prompt_response(
                &runtime_id,
                Some("Use SQLite"),
                &answers,
                Some(&prompt_annotations),
                || Err("Failed to write to native sidecar stdin: Broken pipe".to_string()),
            )
            .expect_err("failed helper delivery must be returned");

        assert!(error.contains("Broken pipe"));
        assert!(manager
            .replay_events(&runtime_id, None)
            .expect("replay events")
            .events
            .is_empty());
    }

    #[test]
    fn helper_stop_serializes_shutdown_command() {
        let serialized = serde_json::to_value(HelperInputCommand::Stop {
            force_background_tasks: true,
        })
        .expect("serialize stop");

        assert_eq!(serialized["type"], "stop");
        assert_eq!(serialized["force_background_tasks"], true);

        let prepare = serde_json::to_value(HelperInputCommand::PrepareStop {
            request_id: "prepare-1",
            require_idle: true,
            force_background_tasks: true,
            finalize: true,
        })
        .expect("serialize prepare stop");
        let cancel = serde_json::to_value(HelperInputCommand::CancelPrepareStop {
            request_id: "prepare-1",
        })
        .expect("serialize cancel prepare stop");
        assert_eq!(prepare["type"], "prepare_stop");
        assert_eq!(prepare["request_id"], "prepare-1");
        assert_eq!(prepare["require_idle"], true);
        assert_eq!(prepare["force_background_tasks"], true);
        assert_eq!(prepare["finalize"], true);
        assert_eq!(cancel["type"], "cancel_prepare_stop");
        assert_eq!(cancel["request_id"], "prepare-1");
    }

    #[test]
    fn app_termination_idle_freeze_is_claude_only() {
        assert!(super::app_termination_requires_idle_freeze(
            NativeProvider::Claude
        ));
        assert!(!super::app_termination_requires_idle_freeze(
            NativeProvider::Codex
        ));
    }

    #[test]
    fn helper_foreground_interrupt_and_single_task_stop_are_distinct_commands() {
        let interrupt = serde_json::to_value(HelperInputCommand::InterruptTurn)
            .expect("serialize foreground interrupt");
        let stop_task = serde_json::to_value(HelperInputCommand::StopTask {
            task_id: "task-1",
            stop_request_id: "stop-task-1",
        })
        .expect("serialize task stop");

        assert_eq!(interrupt["type"], "interrupt_turn");
        assert_eq!(stop_task["type"], "stop_task");
        assert_eq!(stop_task["task_id"], "task-1");
        assert_eq!(stop_task["stop_request_id"], "stop-task-1");
    }

    #[test]
    fn helper_rewind_files_serializes_checkpoint_command() {
        let serialized = serde_json::to_value(HelperInputCommand::RewindFiles {
            checkpoint_id: "checkpoint-1",
        })
        .expect("serialize rewind files");

        assert_eq!(serialized["type"], "rewind_files");
        assert_eq!(serialized["checkpoint_id"], "checkpoint-1");
    }

    #[test]
    fn file_rewind_is_limited_to_idle_like_native_statuses() {
        for status in ["idle", "ready", "interrupted", "closed_idle"] {
            assert!(native_status_allows_file_rewind(status), "{status}");
        }
        for status in [
            "initializing",
            "processing",
            "handoff_pending",
            "handoff",
            "stopped",
            "error",
        ] {
            assert!(!native_status_allows_file_rewind(status), "{status}");
        }
    }

    #[test]
    fn live_summary_replaces_background_tasks_and_terminal_state_never_regresses() {
        let runtime_id = format!(
            "native-background-summary-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        let manager = manager_with_handle(&runtime_id);
        let mut running = background_task("task-1", NativeBackgroundTaskStatus::Running);
        running.tool_use_id = None;

        manager
            .append_event(
                &runtime_id,
                SessionEventPayload::BackgroundTasksChanged {
                    tasks: vec![running.clone()],
                },
            )
            .expect("append running snapshot");
        assert_eq!(
            manager
                .summary_for(&runtime_id)
                .expect("running summary")
                .background_tasks,
            vec![running.clone()]
        );

        let mut completed = running.clone();
        completed.status = NativeBackgroundTaskStatus::Completed;
        completed.terminal_summary = Some("done".to_string());
        completed.updated_at = Utc::now();
        manager
            .append_event(
                &runtime_id,
                SessionEventPayload::BackgroundTaskUpdated {
                    task: completed.clone(),
                },
            )
            .expect("append terminal task");
        let terminal_seq = manager
            .summary_for(&runtime_id)
            .expect("terminal summary")
            .last_event_seq;
        assert!(manager
            .summary_for(&runtime_id)
            .expect("terminal summary")
            .background_tasks
            .is_empty());

        let mut enriched_terminal = completed.clone();
        enriched_terminal.tool_use_id = Some("tool-task-1-late".to_string());
        manager
            .append_event(
                &runtime_id,
                SessionEventPayload::BackgroundTaskUpdated {
                    task: enriched_terminal,
                },
            )
            .expect("persist late terminal tool correlation");
        let enriched_terminal_seq = manager
            .summary_for(&runtime_id)
            .expect("enriched terminal summary")
            .last_event_seq;
        assert!(enriched_terminal_seq > terminal_seq);

        manager
            .append_event(
                &runtime_id,
                SessionEventPayload::BackgroundTaskUpdated { task: running },
            )
            .expect("ignore late running update");
        let mut late_failed = completed.clone();
        late_failed.status = NativeBackgroundTaskStatus::Failed;
        late_failed.error = Some("late failure".to_string());
        manager
            .append_event(
                &runtime_id,
                SessionEventPayload::BackgroundTaskUpdated { task: late_failed },
            )
            .expect("ignore late terminal update");
        let after_late = manager.summary_for(&runtime_id).expect("late summary");
        assert!(after_late.background_tasks.is_empty());
        assert_eq!(after_late.last_event_seq, enriched_terminal_seq);

        let replay = manager
            .replay_events(&runtime_id, None)
            .expect("replay background events");
        assert!(replay.events.iter().any(|event| matches!(
            &event.payload,
            SessionEventPayload::BackgroundTaskUpdated { task }
                if task.status == NativeBackgroundTaskStatus::Completed
                    && task.tool_use_id.as_deref() == Some("tool-task-1-late")
        )));
    }

    #[test]
    fn stopping_task_ignores_stale_progress_and_only_matching_stop_failure_restores() {
        let runtime_id = format!(
            "native-background-stop-race-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        let manager = manager_with_handle(&runtime_id);
        let running = background_task("task-stop", NativeBackgroundTaskStatus::Running);
        manager
            .append_event(
                &runtime_id,
                SessionEventPayload::BackgroundTasksChanged {
                    tasks: vec![running.clone()],
                },
            )
            .expect("append running task");

        let mut stopping = running.clone();
        stopping.status = NativeBackgroundTaskStatus::Stopping;
        stopping.stop_request_id = Some("stop-new".to_string());
        stopping.updated_at = Utc::now();
        manager
            .append_event(
                &runtime_id,
                SessionEventPayload::BackgroundTaskUpdated {
                    task: stopping.clone(),
                },
            )
            .expect("append stopping task");

        let mut stale_failure = running.clone();
        stale_failure.error = Some("old stop failed".to_string());
        stale_failure.stop_request_id = Some("stop-old".to_string());
        stale_failure.stop_failed = Some(true);
        manager
            .append_event(
                &runtime_id,
                SessionEventPayload::BackgroundTasksChanged {
                    tasks: vec![stale_failure],
                },
            )
            .expect("append stale snapshot");
        let preserved = manager
            .summary_for(&runtime_id)
            .expect("stopping summary")
            .background_tasks
            .pop()
            .expect("stopping task");
        assert_eq!(preserved.status, NativeBackgroundTaskStatus::Stopping);
        assert_eq!(preserved.stop_request_id.as_deref(), Some("stop-new"));
        assert_eq!(preserved.error, None);

        let mut matching_failure = running;
        matching_failure.error = Some("new stop failed".to_string());
        matching_failure.stop_request_id = Some("stop-new".to_string());
        matching_failure.stop_failed = Some(true);
        manager
            .append_event(
                &runtime_id,
                SessionEventPayload::BackgroundTaskUpdated {
                    task: matching_failure,
                },
            )
            .expect("append matching stop failure");
        let restored = manager
            .summary_for(&runtime_id)
            .expect("restored summary")
            .background_tasks
            .pop()
            .expect("restored task");
        assert_eq!(restored.status, NativeBackgroundTaskStatus::Running);
        assert_eq!(restored.error.as_deref(), Some("new stop failed"));
    }

    #[test]
    fn settling_snapshot_advances_stopping_task_and_invalidates_stop_failure_restore() {
        let runtime_id = format!(
            "native-background-stop-settling-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        let manager = manager_with_handle(&runtime_id);
        let running = background_task("task-stop", NativeBackgroundTaskStatus::Running);
        manager
            .append_event(
                &runtime_id,
                SessionEventPayload::BackgroundTasksChanged {
                    tasks: vec![running.clone()],
                },
            )
            .expect("append running task");
        let handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(&runtime_id)
            .cloned()
            .expect("handle");
        handle
            .pending_background_task_stops
            .lock()
            .expect("pending stops")
            .insert(
                "task-stop".to_string(),
                (
                    "stop-current".to_string(),
                    NativeBackgroundTaskStatus::Running,
                ),
            );
        let mut stopping = running.clone();
        stopping.status = NativeBackgroundTaskStatus::Stopping;
        stopping.stop_request_id = Some("stop-current".to_string());
        manager
            .append_event(
                &runtime_id,
                SessionEventPayload::BackgroundTaskUpdated { task: stopping },
            )
            .expect("append stopping task");

        let mut settling_snapshot = running.clone();
        settling_snapshot.status = NativeBackgroundTaskStatus::Settling;
        settling_snapshot.stop_request_id = None;
        settling_snapshot.stop_failed = None;
        manager
            .append_event(
                &runtime_id,
                SessionEventPayload::BackgroundTasksChanged {
                    tasks: vec![settling_snapshot],
                },
            )
            .expect("append settling live snapshot");
        let settling = manager
            .active_background_tasks(&runtime_id)
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(settling.status, NativeBackgroundTaskStatus::Settling);
        assert_eq!(settling.stop_request_id, None);
        assert!(handle
            .pending_background_task_stops
            .lock()
            .expect("pending stops")
            .is_empty());

        let mut late_failure = running;
        late_failure.error = Some("late stop failure".to_string());
        late_failure.stop_request_id = Some("stop-current".to_string());
        late_failure.stop_failed = Some(true);
        manager
            .append_event(
                &runtime_id,
                SessionEventPayload::BackgroundTaskUpdated { task: late_failure },
            )
            .expect("ignore invalidated stop failure");
        assert_eq!(
            manager.active_background_tasks(&runtime_id).unwrap()[0].status,
            NativeBackgroundTaskStatus::Settling
        );
    }

    #[test]
    fn foreground_interrupt_failure_events_preserve_live_background_tasks() {
        let runtime_id = "native-interrupt-failed-with-background";
        let manager = manager_with_handle(runtime_id);
        manager
            .append_event(
                runtime_id,
                SessionEventPayload::BackgroundTasksChanged {
                    tasks: vec![background_task(
                        "task-survives-interrupt-failure",
                        NativeBackgroundTaskStatus::Running,
                    )],
                },
            )
            .expect("append running background task");

        manager
            .process_helper_stdout(
                runtime_id,
                r#"{"type":"event","payload":{"type":"lifecycle","stage":"interrupt_failed","detail":"mock interrupt rejected"}}"#,
            )
            .expect("append scoped interrupt failure");
        manager
            .process_helper_stdout(
                runtime_id,
                r#"{"type":"status","status":"processing","detail":"Claude interrupt failed; the foreground turn and background tasks remain attached."}"#,
            )
            .expect("keep runtime processing");

        let summary = manager.summary_for(runtime_id).expect("live summary");
        assert_eq!(summary.status, "processing");
        assert!(summary.is_active);
        assert_eq!(summary.background_tasks.len(), 1);
        assert_eq!(
            summary.background_tasks[0].status,
            NativeBackgroundTaskStatus::Running
        );
        let handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .cloned()
            .expect("live helper");
        assert!(handle.alive.load(Ordering::SeqCst));
        let replay = manager.replay_events(runtime_id, None).expect("replay");
        assert!(!replay.events.iter().any(|event| matches!(
            &event.payload,
            SessionEventPayload::BackgroundTaskUpdated { task }
                if task.status == NativeBackgroundTaskStatus::Interrupted
        )));
        assert!(!replay.events.iter().any(|event| matches!(
            &event.payload,
            SessionEventPayload::ToolUseCompleted { tool_use_id, .. }
                if tool_use_id == "tool-task-survives-interrupt-failure"
        )));
    }

    #[test]
    fn active_background_tasks_block_destructive_actions_without_force() {
        let runtime_id = format!(
            "native-background-guard-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        let manager = manager_with_handle(&runtime_id);
        manager
            .append_event(
                &runtime_id,
                SessionEventPayload::BackgroundTasksChanged {
                    tasks: vec![background_task(
                        "task-guard",
                        NativeBackgroundTaskStatus::Running,
                    )],
                },
            )
            .expect("append active task");

        let error = manager
            .reject_background_task_termination(&runtime_id, "handoff this session", false)
            .expect_err("handoff must require force");
        assert!(error.contains("1 Claude background task"));
        manager
            .reject_background_task_termination(&runtime_id, "handoff this session", true)
            .expect("confirmed handoff may proceed");
        assert_eq!(
            manager.active_background_tasks(&runtime_id).unwrap().len(),
            1
        );

        assert!(manager.prepare_app_termination(false).is_err());
        assert_eq!(manager.prepare_app_termination(true).unwrap(), 1);
        assert!(manager
            .active_background_tasks(&runtime_id)
            .unwrap()
            .is_empty());
        manager
            .append_event(
                &runtime_id,
                SessionEventPayload::ToolUseCompleted {
                    tool_use_id: "tool-task-guard".to_string(),
                    raw_name: "bash".to_string(),
                    result_summary: "duplicate helper teardown completion".to_string(),
                    result_content: None,
                    success: false,
                    todo_snapshot: None,
                },
            )
            .expect("ignore duplicate background tool completion");
        assert_eq!(
            manager
                .replay_events(&runtime_id, None)
                .unwrap()
                .events
                .iter()
                .filter(|event| matches!(
                    &event.payload,
                    SessionEventPayload::ToolUseCompleted { tool_use_id, .. }
                        if tool_use_id == "tool-task-guard"
                ))
                .count(),
            1
        );
        assert!(manager
            .replay_events(&runtime_id, None)
            .unwrap()
            .events
            .iter()
            .any(|event| matches!(
                &event.payload,
                SessionEventPayload::BackgroundTaskUpdated { task }
                    if task.status == NativeBackgroundTaskStatus::Interrupted
            )));
    }

    #[test]
    fn app_termination_guards_only_desktop_owned_background_tasks() {
        let owned_runtime_id = "native-app-exit-owned";
        let handed_off_runtime_id = "native-app-exit-handed-off";
        let manager = manager_with_handle(owned_runtime_id);
        let handed_off_record = native_record(handed_off_runtime_id, "handoff", false);
        manager
            .insert_record(handed_off_record.clone())
            .expect("insert handed-off record");
        manager
            .insert_handle(
                handed_off_runtime_id.to_string(),
                native_session_handle(handed_off_record),
            )
            .expect("insert handed-off handle");

        for (runtime_id, task_id) in [
            (owned_runtime_id, "task-owned-by-desktop"),
            (handed_off_runtime_id, "task-owned-by-terminal"),
        ] {
            manager
                .append_event(
                    runtime_id,
                    SessionEventPayload::BackgroundTasksChanged {
                        tasks: vec![background_task(
                            task_id,
                            NativeBackgroundTaskStatus::Running,
                        )],
                    },
                )
                .expect("append active background task");
        }

        let error = manager
            .prepare_app_termination(false)
            .expect_err("owned background task must block normal exit");
        assert!(error.contains("1 Claude background task"));
        assert!(!error.contains("2 Claude background tasks"));

        assert_eq!(manager.prepare_app_termination(true).unwrap(), 1);
        assert!(manager
            .active_background_tasks(owned_runtime_id)
            .unwrap()
            .is_empty());
        assert_eq!(
            manager
                .active_background_tasks(handed_off_runtime_id)
                .unwrap()
                .len(),
            1
        );
        let handed_off = manager
            .current_record(handed_off_runtime_id)
            .expect("handed-off record");
        assert_eq!(handed_off.status, "handoff");
        assert!(!handed_off.is_active);
    }

    #[test]
    fn app_termination_preparation_blocks_all_teardown_when_a_late_task_appears() {
        let first_runtime_id = format!(
            "native-app-exit-first-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        let second_runtime_id = format!(
            "native-app-exit-second-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        let manager = manager_with_handle(&first_runtime_id);
        let second_record = native_record(&second_runtime_id, "ready", true);
        manager
            .insert_record(second_record.clone())
            .expect("insert second record");
        manager
            .insert_handle(
                second_runtime_id.clone(),
                native_session_handle(second_record),
            )
            .expect("insert second handle");
        let late_runtime_id = Mutex::new(None::<String>);

        let error = manager
            .prepare_app_termination_with_hook(false, |runtime_ids| {
                let runtime_id = runtime_ids.last().expect("runtime selected");
                *late_runtime_id.lock().expect("late runtime id") = Some(runtime_id.to_string());
                manager
                    .append_event(
                        runtime_id,
                        SessionEventPayload::BackgroundTaskUpdated {
                            task: background_task(
                                "task-started-during-exit",
                                NativeBackgroundTaskStatus::Running,
                            ),
                        },
                    )
                    .expect("append late background task");
            })
            .expect_err("late task must cancel non-forced app termination");
        assert!(error.contains("background task"));
        assert!(!manager.app_termination_in_progress.load(Ordering::SeqCst));

        for runtime_id in [&first_runtime_id, &second_runtime_id] {
            let summary = manager.summary_for(runtime_id).expect("restored summary");
            assert!(summary.is_active);
            assert!(matches!(summary.status.as_str(), "processing" | "ready"));
            let handle = manager
                .handles
                .lock()
                .expect("handles")
                .get(runtime_id)
                .cloned()
                .expect("restored handle");
            assert!(handle.alive.load(Ordering::SeqCst));
        }
        let late_runtime_id = late_runtime_id
            .lock()
            .expect("late runtime id")
            .clone()
            .expect("late runtime selected");
        assert_eq!(
            manager
                .active_background_tasks(&late_runtime_id)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn app_termination_commit_never_swallows_a_late_background_task_guard() {
        let runtime_id = "native-app-exit-shutdown-task-race";
        let manager = manager_with_handle(runtime_id);

        let error = manager
            .prepare_app_termination_with_hooks(
                false,
                |_| {},
                |shutdown_runtime_id, _| {
                    manager.append_event(
                        shutdown_runtime_id,
                        SessionEventPayload::BackgroundTaskUpdated {
                            task: background_task(
                                "task-started-at-shutdown",
                                NativeBackgroundTaskStatus::Running,
                            ),
                        },
                    )?;
                    Err(super::ACTIVE_BACKGROUND_TASK_SHUTDOWN_ERROR.to_string())
                },
            )
            .expect_err("a late task safety guard must abort non-forced app termination");

        assert!(super::is_background_task_shutdown_safety_error(&error));
        assert!(!manager.app_termination_in_progress.load(Ordering::SeqCst));
        let summary = manager
            .summary_for(runtime_id)
            .expect("restored live summary");
        assert_eq!(summary.status, "processing");
        assert!(summary.is_active);
        assert_eq!(summary.background_tasks.len(), 1);
        assert!(manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .expect("live helper remains")
            .alive
            .load(Ordering::SeqCst));
    }

    #[test]
    fn app_termination_commit_failure_never_restores_already_closed_runtimes() {
        let first_runtime_id = "native-app-exit-commit-first";
        let second_runtime_id = "native-app-exit-commit-second";
        let manager = manager_with_handle(first_runtime_id);
        let second_record = native_record(second_runtime_id, "ready", true);
        manager
            .insert_record(second_record.clone())
            .expect("insert second record");
        manager
            .insert_handle(
                second_runtime_id.to_string(),
                native_session_handle(second_record),
            )
            .expect("insert second handle");
        let shutdown_order = Mutex::new(Vec::<String>::new());

        manager
            .prepare_app_termination_with_hooks(
                false,
                |_| {},
                |runtime_id, _| {
                    let mut order = shutdown_order.lock().expect("shutdown order");
                    order.push(runtime_id.to_string());
                    if order.len() == 1 {
                        drop(order);
                        manager.remove_handle(runtime_id)?;
                        Ok(())
                    } else {
                        Err("simulated second runtime shutdown failure".to_string())
                    }
                },
            )
            .expect("commit failures are terminal and app exit continues");

        let order = shutdown_order.lock().expect("shutdown order");
        assert_eq!(order.len(), 2);
        let closed = manager.summary_for(&order[0]).expect("closed summary");
        assert_eq!(closed.status, "stopped");
        assert!(!closed.is_active);
        assert!(!manager
            .handles
            .lock()
            .expect("handles")
            .contains_key(&order[0]));
        let failed = manager.summary_for(&order[1]).expect("failed summary");
        assert_eq!(failed.status, "interrupted");
        assert!(!failed.is_active);
        assert!(failed
            .last_error
            .as_deref()
            .is_some_and(|error| error.contains("simulated second runtime shutdown failure")));
        assert!(!manager
            .handles
            .lock()
            .expect("handles")
            .get(&order[1])
            .expect("failed handle retained for diagnostics")
            .alive
            .load(Ordering::SeqCst));
    }

    #[test]
    fn helper_process_exit_persists_active_tasks_as_interrupted() {
        let runtime_id = format!(
            "native-background-exit-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        let manager = manager_with_handle(&runtime_id);
        manager
            .append_event(
                &runtime_id,
                SessionEventPayload::BackgroundTasksChanged {
                    tasks: vec![background_task(
                        "task-exit",
                        NativeBackgroundTaskStatus::Running,
                    )],
                },
            )
            .expect("append active task");
        let handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(&runtime_id)
            .cloned()
            .expect("live handle");

        manager
            .mark_process_exit(&runtime_id, Some(9), &handle)
            .expect("mark helper exit");

        let summary = manager.summary_for(&runtime_id).expect("record summary");
        assert!(summary.background_tasks.is_empty());
        let replay = manager
            .replay_events(&runtime_id, None)
            .expect("replay interrupted task");
        assert!(replay.events.iter().any(|event| matches!(
            &event.payload,
            SessionEventPayload::BackgroundTaskUpdated { task }
                if task.task_id == "task-exit"
                    && task.status == NativeBackgroundTaskStatus::Interrupted
        )));
    }

    #[test]
    fn reconcile_stale_records_marks_active_records_interrupted() {
        let manager = manager_with_records(
            "native-reconcile",
            vec![
                native_record("native-reconcile-active", "processing", true),
                native_record("native-reconcile-stopped", "stopped", false),
                native_record("native-reconcile-idle", "idle", true),
            ],
        );

        let reconciled = manager
            .reconcile_stale_records()
            .expect("reconcile stale records");

        assert_eq!(reconciled, 2);
        let active = manager
            .summary_for("native-reconcile-active")
            .expect("active summary");
        let stopped = manager
            .summary_for("native-reconcile-stopped")
            .expect("stopped summary");
        let idle = manager
            .summary_for("native-reconcile-idle")
            .expect("idle summary");

        assert_eq!(active.status, "interrupted");
        assert!(!active.is_active);
        assert_eq!(stopped.status, "stopped");
        assert!(!stopped.is_active);
        assert_eq!(idle.status, "idle");
        assert!(!idle.is_active);
    }

    #[test]
    fn summary_includes_persisted_effort() {
        let mut record = native_record("native-effort", "ready", true);
        record.effort = Some("max".to_string());
        let manager = manager_with_records("native-effort", vec![record]);

        let summary = manager.summary_for("native-effort").expect("summary");

        assert_eq!(summary.effort.as_deref(), Some("max"));
    }

    #[test]
    fn codex_settings_update_effective_values_immediately_while_claude_waits_for_ack() {
        let mut codex = native_record("native-codex-settings", "ready", true);
        codex.provider = NativeProvider::Codex;
        codex.env_name = "old-codex".to_string();
        codex.effort = Some("medium".to_string());
        stage_runtime_settings_update(
            &mut codex,
            Some("new-codex"),
            Some("high"),
            "settings-codex",
        );
        assert_eq!(codex.env_name, "new-codex");
        assert_eq!(codex.effort.as_deref(), Some("high"));
        assert_eq!(codex.pending_env_name, None);
        assert_eq!(codex.pending_effort, None);
        assert_eq!(codex.pending_settings_request_id, None);

        let mut claude = native_record("native-claude-settings", "ready", true);
        claude.env_name = "old-claude".to_string();
        claude.effort = Some("medium".to_string());
        stage_runtime_settings_update(
            &mut claude,
            Some("new-claude"),
            Some("high"),
            "settings-claude",
        );
        assert_eq!(claude.env_name, "old-claude");
        assert_eq!(claude.effort.as_deref(), Some("medium"));
        assert_eq!(claude.pending_env_name.as_deref(), Some("new-claude"));
        assert_eq!(claude.pending_effort.as_deref(), Some("high"));
        assert_eq!(
            claude.pending_settings_request_id.as_deref(),
            Some("settings-claude")
        );
    }

    #[test]
    fn helper_stop_rejection_restores_only_the_matching_local_stopping_request() {
        let runtime_id = "native-stop-rejection";
        let manager = manager_with_handle(runtime_id);
        let running = background_task("task-rejected", NativeBackgroundTaskStatus::Running);
        manager
            .append_event(
                runtime_id,
                SessionEventPayload::BackgroundTasksChanged {
                    tasks: vec![running.clone()],
                },
            )
            .expect("append running task");
        let handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .cloned()
            .expect("handle");
        handle
            .pending_background_task_stops
            .lock()
            .expect("pending stops")
            .insert(
                "task-rejected".to_string(),
                (
                    "stop-current".to_string(),
                    NativeBackgroundTaskStatus::Running,
                ),
            );
        let mut stopping = running;
        stopping.status = NativeBackgroundTaskStatus::Stopping;
        stopping.stop_request_id = Some("stop-current".to_string());
        manager
            .append_event(
                runtime_id,
                SessionEventPayload::BackgroundTaskUpdated { task: stopping },
            )
            .expect("append stopping task");

        manager
            .process_helper_stdout(
                runtime_id,
                r#"{"type":"background_task_stop_failed","task_id":"task-rejected","stop_request_id":"stop-stale","error":"stale"}"#,
            )
            .expect("ignore stale rejection");
        assert_eq!(
            manager.active_background_tasks(runtime_id).unwrap()[0].status,
            NativeBackgroundTaskStatus::Stopping
        );

        manager
            .process_helper_stdout(
                runtime_id,
                r#"{"type":"background_task_stop_failed","task_id":"task-rejected","stop_request_id":"stop-current","error":"task already settling"}"#,
            )
            .expect("restore matching rejection");
        let restored = manager
            .active_background_tasks(runtime_id)
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(restored.status, NativeBackgroundTaskStatus::Running);
        assert_eq!(restored.error.as_deref(), Some("task already settling"));
        assert_eq!(restored.stop_failed, Some(true));
    }

    #[test]
    fn stopping_a_stale_task_never_restarts_a_missing_runtime_handle() {
        let runtime_id = "native-stale-background-stop";
        let manager = Arc::new(manager_with_records(
            runtime_id,
            vec![native_record(runtime_id, "ready", true)],
        ));

        let error = manager
            .stop_background_task(runtime_id, "task-stale")
            .expect_err("a stale task cannot recreate its helper");

        assert!(error.contains("no longer attached to a live runtime"));
        assert!(manager.handles.lock().expect("handles").is_empty());
        let summary = manager.summary_for(runtime_id).expect("summary");
        assert_eq!(summary.status, "ready");
        assert!(summary.background_tasks.is_empty());

        let permission_error = manager
            .respond_to_permission(runtime_id, "request-stale", true)
            .expect_err("a stale permission cannot recreate its helper");
        assert!(permission_error.contains("no longer has a live permission request"));
        let prompt_error = manager
            .respond_to_prompt(
                runtime_id,
                "tool-stale",
                "ask_user_question",
                Some("answer"),
                &HashMap::from([("question".to_string(), "answer".to_string())]),
                None,
                None,
            )
            .expect_err("a stale interactive prompt cannot recreate its helper");
        assert!(prompt_error.contains("no longer has a live interactive prompt"));
        assert!(manager.handles.lock().expect("handles").is_empty());
    }

    #[test]
    fn terminal_handoff_record_rejects_query_mutations_without_recreating_a_handle() {
        let runtime_id = "native-completed-handoff-gate";
        let manager = manager_with_records(
            runtime_id,
            vec![native_record(runtime_id, "handoff", false)],
        );

        for action in [
            "send a prompt",
            "respond to permission",
            "respond to a prompt",
            "update settings",
            "rewind files",
            "query usage",
            "stop a background task",
        ] {
            assert!(manager
                .reject_query_mutation_during_transition(runtime_id, action)
                .expect_err("terminal handoff must reject query mutation")
                .contains("is handoff"));
        }
        assert!(manager.handles.lock().expect("handles").is_empty());
        assert_eq!(manager.summary_for(runtime_id).unwrap().status, "handoff");
    }

    #[test]
    fn recoverable_disconnected_statuses_allow_query_reconnect_but_not_stale_responses() {
        for status in ["interrupted", "closed_idle"] {
            let runtime_id = format!("native-recoverable-query-gate-{status}");
            let manager = Arc::new(manager_with_records(
                &runtime_id,
                vec![native_record(&runtime_id, status, false)],
            ));

            manager
                .reject_query_mutation_during_transition(&runtime_id, "send a prompt")
                .expect("a new prompt may reconnect a recoverable runtime");
            manager
                .reject_query_mutation_during_transition(&runtime_id, "update settings")
                .expect("settings may reconnect a recoverable runtime");

            let permission_error = manager
                .respond_to_permission(&runtime_id, "request-from-old-helper", true)
                .expect_err("a response cannot reconnect an old permission request");
            assert!(permission_error.contains("no longer has a live permission request"));
            let prompt_error = manager
                .respond_to_prompt(
                    &runtime_id,
                    "tool-from-old-helper",
                    "ask_user_question",
                    Some("answer"),
                    &HashMap::from([("question".to_string(), "answer".to_string())]),
                    None,
                    None,
                )
                .expect_err("a response cannot reconnect an old interactive prompt");
            assert!(prompt_error.contains("no longer has a live interactive prompt"));
            assert!(manager.handles.lock().expect("handles").is_empty());
        }

        let error_runtime_id = "native-query-gate-error";
        let error_manager = manager_with_records(
            error_runtime_id,
            vec![native_record(error_runtime_id, "error", false)],
        );
        assert!(error_manager
            .reject_query_mutation_during_transition(error_runtime_id, "send a prompt")
            .expect_err("an error session keeps the existing new-session UI contract")
            .contains("is error"));
    }

    #[test]
    fn reconcile_stale_records_reports_deferred_effort_clear_after_restart() {
        let mut record = native_record("native-effort-clear", "stopped", false);
        record.effort = Some("max".to_string());
        record.pending_effort = None;
        record.pending_settings_request_id = Some("settings-clear-effort".to_string());
        let serialized = serde_json::to_value(&record).expect("serialize pending settings");
        assert_eq!(
            serialized["pending_settings_request_id"],
            "settings-clear-effort"
        );
        let manager = manager_with_records("native-effort-clear", vec![record]);

        assert_eq!(manager.reconcile_stale_records().unwrap(), 1);
        let summary = manager
            .summary_for("native-effort-clear")
            .expect("summary after restart reconciliation");
        assert_eq!(summary.effort.as_deref(), Some("max"));
        assert_eq!(summary.pending_effort, None);
        assert!(summary
            .last_error
            .as_deref()
            .is_some_and(|error| error.contains("not applied")));
    }

    #[test]
    fn status_error_keeps_last_error_when_late_processing_arrives() {
        let runtime_id = "native-status-error";
        let manager = manager_with_handle(runtime_id);

        manager
            .process_helper_stdout(
                runtime_id,
                r#"{"type":"status","status":"error","detail":"Native CLI binary not found"}"#,
            )
            .expect("process error status");
        manager
            .process_helper_stdout(
                runtime_id,
                r#"{"type":"status","status":"processing","detail":"Claude is processing a turn."}"#,
            )
            .expect("ignore late processing");

        let summary = manager.summary_for(runtime_id).expect("summary");
        assert_eq!(summary.status, "error");
        assert!(!summary.is_active);
        assert_eq!(
            summary.last_error.as_deref(),
            Some("Native CLI binary not found")
        );
    }

    #[test]
    fn provider_sigkill_error_is_recoverable_after_session_meta() {
        let runtime_id = "native-provider-sigkill";
        let manager = manager_with_handle(runtime_id);
        manager
            .update_record(runtime_id, |record| {
                record.provider_session_id = Some("provider-session-1".to_string());
                record.can_handoff_to_terminal = true;
                record.status = "processing".to_string();
                record.is_active = true;
            })
            .expect("set processing record");

        manager
            .process_helper_stdout(
                runtime_id,
                r#"{"type":"status","status":"error","detail":"Claude Code process terminated by signal SIGKILL"}"#,
            )
            .expect("process recoverable error status");

        let summary = manager.summary_for(runtime_id).expect("summary");
        assert_eq!(summary.status, "interrupted");
        assert!(!summary.is_active);
        assert_eq!(
            summary.last_error.as_deref(),
            Some("Claude Code process terminated by signal SIGKILL")
        );
    }

    #[test]
    fn provider_sigkill_without_session_meta_stays_error() {
        let runtime_id = "native-provider-startup-sigkill";
        let manager = manager_with_handle(runtime_id);

        manager
            .process_helper_stdout(
                runtime_id,
                r#"{"type":"status","status":"error","detail":"Claude Code process terminated by signal SIGKILL"}"#,
            )
            .expect("process error status");

        let summary = manager.summary_for(runtime_id).expect("summary");
        assert_eq!(summary.status, "error");
        assert!(!summary.is_active);
        assert_eq!(
            summary.last_error.as_deref(),
            Some("Claude Code process terminated by signal SIGKILL")
        );
    }

    #[test]
    fn retryable_child_write_errors_match_dead_helper_states() {
        assert!(is_retryable_native_child_write_error(
            "Native sidecar child is not available"
        ));
        assert!(is_retryable_native_child_write_error(
            "Failed to write to native sidecar stdin: Broken pipe"
        ));
        assert!(!is_retryable_native_child_write_error(
            "Failed to encode helper command: invalid payload"
        ));
    }

    #[test]
    fn terminal_launch_capture_is_isolated_between_parallel_test_threads() {
        clear_terminal_launches();
        let launch_barrier = Arc::new(Barrier::new(3));

        let launch_and_take = |runtime_id: &'static str| {
            let launch_barrier = Arc::clone(&launch_barrier);
            std::thread::spawn(move || {
                launch_terminal_for_native_handoff(
                    crate::terminal::TerminalType::TerminalApp,
                    HashMap::new(),
                    "/tmp/project",
                    runtime_id,
                    "official",
                    Some("dev"),
                    None,
                    "claude",
                )
                .expect("capture terminal launch");
                launch_barrier.wait();

                let launches = take_terminal_launches();
                assert_eq!(launches.len(), 1);
                assert_eq!(launches[0].runtime_id, runtime_id);
            })
        };

        let first = launch_and_take("parallel-terminal-capture-a");
        let second = launch_and_take("parallel-terminal-capture-b");
        launch_barrier.wait();
        first.join().expect("first capture thread");
        second.join().expect("second capture thread");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn handoff_without_provider_session_rejects_an_active_foreground_turn() {
        let runtime_id = "native-fresh-handoff";
        let manager = manager_with_handle(runtime_id);
        clear_terminal_launches();

        let error = manager
            .handoff_to_terminal(
                runtime_id,
                Some(crate::terminal::TerminalType::TerminalApp),
                false,
            )
            .expect_err("active foreground handoff must wait for the turn to finish");
        assert!(error.contains("Finish the current foreground turn"));

        assert!(take_terminal_launches().is_empty());

        let summary = manager.summary_for(runtime_id).expect("summary");
        assert_eq!(summary.status, "processing");
        assert!(summary.is_active);
        assert_eq!(summary.provider_session_id, None);
        assert!(manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .is_some());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn pending_handoff_gates_query_mutations_until_session_meta_completes_it() {
        let runtime_id = "native-pending-handoff-gate";
        let manager = manager_with_handle(runtime_id);
        clear_terminal_launches();
        manager
            .update_record(runtime_id, |record| {
                record.status = "ready".to_string();
                record.is_active = true;
            })
            .expect("set ready record");

        let result = manager
            .handoff_to_terminal(
                runtime_id,
                Some(crate::terminal::TerminalType::TerminalApp),
                false,
            )
            .expect("queue pending handoff");
        assert_eq!(result.status, super::NativeHandoffStatus::Pending);
        assert!(manager
            .terminal_handoff_preparations
            .lock()
            .expect("handoff preparations")
            .contains_key(runtime_id));
        assert_eq!(
            manager.summary_for(runtime_id).unwrap().status,
            "handoff_pending"
        );
        for action in [
            "send a prompt",
            "update settings",
            "rewind files",
            "query usage",
            "respond to permission",
            "respond to a prompt",
            "stop a background task",
        ] {
            assert!(manager
                .reject_query_mutation_during_transition(runtime_id, action)
                .expect_err("pending handoff must gate mutations")
                .contains("preparing to continue in Terminal"));
        }

        manager
            .process_helper_stdout(
                runtime_id,
                r#"{"type":"session_meta","provider_session_id":"provider-session-gated"}"#,
            )
            .expect("complete pending handoff");
        assert_eq!(take_terminal_launches().len(), 1);
        assert_eq!(manager.summary_for(runtime_id).unwrap().status, "handoff");
        assert!(!manager
            .terminal_handoff_preparations
            .lock()
            .expect("handoff preparations")
            .contains_key(runtime_id));
    }

    #[test]
    fn rejected_pending_handoff_finalization_reopens_the_native_session() {
        let runtime_id = "native-pending-handoff-rejected";
        let manager = manager_with_handle(runtime_id);
        manager
            .update_record(runtime_id, |record| {
                record.status = "handoff_finalizing".to_string();
                record.pending_handoff_terminal = Some(crate::terminal::TerminalType::TerminalApp);
            })
            .expect("set finalizing handoff");
        manager
            .terminal_handoff_preparations
            .lock()
            .expect("handoff preparations")
            .insert(
                runtime_id.to_string(),
                "pending-handoff-request".to_string(),
            );

        manager
            .process_helper_stdout(
                runtime_id,
                r#"{"type":"teardown_prepared","request_id":"pending-handoff-request","ready":false,"detail":"foreground still running"}"#,
            )
            .expect("reject pending handoff");

        let summary = manager.summary_for(runtime_id).expect("summary");
        assert_eq!(summary.status, "ready");
        assert!(summary.is_active);
        assert!(summary
            .last_error
            .as_deref()
            .is_some_and(|error| error.contains("foreground still running")));
        assert!(!manager
            .terminal_handoff_preparations
            .lock()
            .expect("handoff preparations")
            .contains_key(runtime_id));
    }

    #[test]
    fn session_meta_completes_pending_handoff_with_resume_id() {
        let runtime_id = "native-pending-handoff";
        let manager = manager_with_handle(runtime_id);
        clear_terminal_launches();
        manager
            .update_record(runtime_id, |record| {
                record.status = "handoff_pending".to_string();
                record.pending_handoff_terminal = Some(crate::terminal::TerminalType::TerminalApp);
            })
            .expect("set pending handoff");

        manager
            .process_helper_stdout(
                runtime_id,
                r#"{"type":"session_meta","provider_session_id":"provider-session-1"}"#,
            )
            .expect("process session meta");

        let launches = take_terminal_launches();
        assert_eq!(launches.len(), 1);
        assert_eq!(
            launches[0].resume_session_id.as_deref(),
            Some("provider-session-1")
        );
        assert_eq!(launches[0].runtime_id, runtime_id);
        assert_eq!(launches[0].perm_mode.as_deref(), Some("dev"));

        let summary = manager.summary_for(runtime_id).expect("summary");
        assert_eq!(summary.status, "handoff");
        assert!(!summary.is_active);
        assert_eq!(
            summary.provider_session_id.as_deref(),
            Some("provider-session-1")
        );
        assert!(manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .is_none());

        let runtime_id = "native-pending-handoff-runtime-perm";
        let manager = manager_with_handle(runtime_id);
        clear_terminal_launches();
        manager
            .update_record(runtime_id, |record| {
                record.status = "handoff_pending".to_string();
                record.perm_mode = "yolo".to_string();
                record.runtime_perm_mode = Some("plan".to_string());
                record.pending_handoff_terminal = Some(crate::terminal::TerminalType::TerminalApp);
            })
            .expect("set pending handoff");

        manager
            .process_helper_stdout(
                runtime_id,
                r#"{"type":"session_meta","provider_session_id":"provider-session-2"}"#,
            )
            .expect("process session meta");

        let launches = take_terminal_launches();
        assert_eq!(launches.len(), 1);
        assert_eq!(
            launches[0].resume_session_id.as_deref(),
            Some("provider-session-2")
        );
        assert_eq!(launches[0].runtime_id, runtime_id);
        assert_eq!(launches[0].perm_mode.as_deref(), Some("plan"));

        let summary = manager.summary_for(runtime_id).expect("summary");
        assert_eq!(summary.status, "handoff");
        assert!(!summary.is_active);
        assert_eq!(
            summary.provider_session_id.as_deref(),
            Some("provider-session-2")
        );
    }

    #[test]
    fn pending_handoff_exit_reconnect_session_meta_does_not_launch_old_terminal() {
        let runtime_id = "native-pending-handoff-exit-reconnect";
        let manager = manager_with_handle(runtime_id);
        clear_terminal_launches();
        manager
            .update_record(runtime_id, |record| {
                record.status = "handoff_pending".to_string();
                record.is_active = true;
                record.can_handoff_to_terminal = true;
                record.pending_handoff_terminal = Some(crate::terminal::TerminalType::TerminalApp);
            })
            .expect("set pending handoff");
        let exited_handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .expect("pending handoff handle")
            .clone();

        manager
            .mark_process_exit(runtime_id, Some(1), &exited_handle)
            .expect("mark pending helper exit");

        let exited = manager.summary_for(runtime_id).expect("exited summary");
        assert_eq!(exited.status, "error");
        assert!(!exited.is_active);
        assert!(!exited.can_handoff_to_terminal);
        let mut reconnected_record = manager
            .records
            .lock()
            .expect("records")
            .get(runtime_id)
            .expect("persisted exited record")
            .clone();
        assert_eq!(reconnected_record.pending_handoff_terminal, None);
        assert!(reactivate_record_for_reconnect(&mut reconnected_record));
        manager
            .update_record(runtime_id, |record| {
                *record = reconnected_record.clone();
            })
            .expect("persist reconnected record");
        manager
            .insert_handle(
                runtime_id.to_string(),
                native_session_handle_with_generation(reconnected_record, 2),
            )
            .expect("insert reconnected handle");

        manager
            .process_helper_stdout(
                runtime_id,
                r#"{"type":"session_meta","provider_session_id":"provider-session-after-reconnect"}"#,
            )
            .expect("process session meta after reconnect");

        assert!(
            take_terminal_launches().is_empty(),
            "stale pending handoff must not open a terminal after reconnect"
        );
        let summary = manager
            .summary_for(runtime_id)
            .expect("reconnected summary");
        assert_eq!(summary.status, "initializing");
        assert!(summary.is_active);
        assert_eq!(
            summary.provider_session_id.as_deref(),
            Some("provider-session-after-reconnect")
        );
        assert_eq!(
            manager
                .records
                .lock()
                .expect("records")
                .get(runtime_id)
                .expect("reconnected record")
                .pending_handoff_terminal,
            None
        );
    }

    #[test]
    fn stale_helper_exit_does_not_mark_reconnected_session_error() {
        let runtime_id = "native-stale-helper-exit";
        let manager = manager_with_handle(runtime_id);
        let stale_handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .expect("stale handle")
            .clone();

        let replacement_record = native_record(runtime_id, "ready", true);
        let replacement_handle = native_session_handle_with_generation(replacement_record, 2);
        manager
            .remove_handle(runtime_id)
            .expect("retire stale handle before replacement");
        manager
            .insert_handle(runtime_id.to_string(), replacement_handle.clone())
            .expect("insert replacement handle");
        manager
            .update_record(runtime_id, |record| {
                record.status = "ready".to_string();
                record.is_active = true;
                record.last_error = None;
            })
            .expect("set reconnected record ready");

        manager
            .mark_process_exit(runtime_id, Some(1), &stale_handle)
            .expect("ignore stale exit");

        let summary = manager.summary_for(runtime_id).expect("summary");
        assert_eq!(summary.status, "ready");
        assert!(summary.is_active);
        assert_eq!(summary.last_error, None);
        assert!(manager
            .is_current_handle(runtime_id, &replacement_handle)
            .expect("current handle check"));
    }

    #[test]
    fn stop_force_kill_removes_only_current_stopped_handle() {
        let runtime_id = "native-stop-force-kill";
        let manager = manager_with_handle(runtime_id);
        let handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .expect("handle")
            .clone();
        handle.alive.store(false, Ordering::SeqCst);

        let removed = manager
            .force_kill_stopped_handle(runtime_id, &handle)
            .expect("force kill stopped handle");

        assert!(removed);
        assert!(!manager
            .is_current_handle(runtime_id, &handle)
            .expect("current handle check"));

        let summary = manager.summary_for(runtime_id).expect("summary");
        assert_eq!(summary.status, "interrupted");
        assert!(!summary.is_active);

        let replay = manager
            .replay_events_limited(runtime_id, None, None)
            .expect("replay events");
        assert!(replay.events.iter().any(|event| matches!(
            &event.payload,
            SessionEventPayload::Lifecycle { stage, .. } if stage == "stop_force_killed"
        )));
    }

    #[test]
    fn removing_a_helper_generation_unregisters_its_route() {
        let runtime_id = "native-router-generation-exit";
        let manager = manager_with_handle(runtime_id);
        let router_manager = Arc::new(RouterManager::new(RouterConfig::default()));
        manager
            .set_router_manager(router_manager.clone())
            .expect("set router manager");
        let router = SessionRouterRecord {
            session_key: "route-key".into(),
            route_tag_nonce: "route-nonce".into(),
            default_env: "official".into(),
            bindings: HashMap::new(),
            allowed_envs: vec!["official".into()],
            source_profile_id: None,
            profile_revision: None,
            dynamic_routing: true,
            revision: 0,
            router_auth_capability: RouterAuthCapability::Oauth,
            launch_transport: LaunchTransport::Routed,
            launch_auth_kind: LaunchAuthKind::Oauth,
            launch_default_env: "official".into(),
            launch_model_pins: RouterModelPins::default(),
            warnings: Vec::new(),
        };
        manager
            .update_record(runtime_id, |record| record.router = Some(router.clone()))
            .expect("persist router state");
        router_manager
            .register(runtime_id, 1, router)
            .expect("register route");
        assert_eq!(router_manager.route_count(), 1);

        manager
            .remove_handle(runtime_id)
            .expect("remove helper handle");

        assert_eq!(router_manager.route_count(), 0);
    }

    #[test]
    fn environment_reference_query_covers_recoverable_snapshots_only() {
        let mut recoverable = native_record("native-router-env-recoverable", "interrupted", false);
        recoverable.env_name = "old env".into();
        let mut stopped = native_record("native-router-env-stopped", "stopped", false);
        stopped.env_name = "old env".into();
        let mut handoff = native_record("native-router-env-handoff", "handoff", false);
        handoff.env_name = "old env".into();
        let manager = manager_with_records(
            "native-router-env-reference-query",
            vec![recoverable, stopped, handoff],
        );

        assert_eq!(
            manager
                .router_environment_references("old env")
                .expect("query environment refs"),
            vec!["session:native-router-env-recoverable"]
        );
    }

    #[test]
    fn environment_rename_cascades_persisted_router_snapshot() {
        let runtime_id = "native-router-env-rename";
        let mut record = native_record(runtime_id, "interrupted", false);
        record.env_name = "old env".into();
        record.router = Some(SessionRouterRecord {
            session_key: "route-key".into(),
            route_tag_nonce: "route-nonce".into(),
            default_env: "old env".into(),
            bindings: HashMap::from([("background".into(), "old env".into())]),
            allowed_envs: vec!["old env".into(), "new env".into()],
            source_profile_id: None,
            profile_revision: None,
            dynamic_routing: true,
            revision: 0,
            router_auth_capability: RouterAuthCapability::Token,
            launch_transport: LaunchTransport::Direct,
            launch_auth_kind: LaunchAuthKind::Token,
            launch_default_env: "old env".into(),
            launch_model_pins: RouterModelPins::default(),
            warnings: Vec::new(),
        });
        let manager = manager_with_records(runtime_id, vec![record]);

        let events = manager
            .rename_router_environment_references("old env", "new env")
            .expect("rename router refs");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].runtime_id, runtime_id);
        assert_eq!(events[0].reason, "environment-rename");
        assert_eq!(events[0].router.revision, 1);

        assert!(manager
            .router_environment_references("old env")
            .expect("scan old refs")
            .is_empty());
        let renamed = manager
            .records
            .lock()
            .expect("records")
            .get(runtime_id)
            .expect("record")
            .clone();
        assert_eq!(renamed.env_name, "new env");
        let router = renamed.router.expect("router");
        assert_eq!(router.default_env, "new env");
        assert_eq!(router.launch_default_env, "new env");
        assert_eq!(router.revision, 1);
        assert_eq!(router.allowed_envs, vec!["new env"]);
        assert_eq!(
            router.bindings.get("background").map(String::as_str),
            Some("new env")
        );
    }

    #[test]
    fn stop_force_kill_does_not_remove_replacement_handle() {
        let runtime_id = "native-stop-force-kill-stale";
        let manager = manager_with_handle(runtime_id);
        let stale_handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .expect("stale handle")
            .clone();
        stale_handle.alive.store(false, Ordering::SeqCst);

        let replacement_record = native_record(runtime_id, "processing", true);
        let replacement_handle = native_session_handle_with_generation(replacement_record, 2);
        manager
            .remove_handle(runtime_id)
            .expect("retire stale handle before replacement");
        manager
            .insert_handle(runtime_id.to_string(), replacement_handle.clone())
            .expect("insert replacement handle");

        let removed = manager
            .force_kill_stopped_handle(runtime_id, &stale_handle)
            .expect("ignore stale stopped handle");

        assert!(!removed);
        assert!(manager
            .is_current_handle(runtime_id, &replacement_handle)
            .expect("current handle check"));
    }

    #[test]
    fn handle_generations_are_monotonic() {
        let manager = manager_with_records("native-handle-generation", Vec::new());

        let first = manager.allocate_handle_generation();
        let second = manager.allocate_handle_generation();
        let third = manager.allocate_handle_generation();

        assert_eq!(first, 1);
        assert_eq!(second, 2);
        assert_eq!(third, 3);
    }

    #[test]
    fn concurrent_runtime_ids_are_unique() {
        const THREADS: usize = 16;
        const IDS_PER_THREAD: usize = 128;
        let barrier = Arc::new(Barrier::new(THREADS));
        let workers = (0..THREADS)
            .map(|_| {
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    (0..IDS_PER_THREAD)
                        .map(|_| super::generate_runtime_id())
                        .collect::<Vec<_>>()
                })
            })
            .collect::<Vec<_>>();

        let ids = workers
            .into_iter()
            .flat_map(|worker| worker.join().expect("runtime ID worker"))
            .collect::<Vec<_>>();
        let unique = ids.iter().collect::<HashSet<_>>();

        assert_eq!(unique.len(), ids.len(), "runtime IDs must never collide");
    }

    #[test]
    fn duplicate_record_insert_is_rejected_without_overwrite() {
        let runtime_id = "native-duplicate-record";
        let manager = manager_with_records(runtime_id, Vec::new());
        let original = native_record(runtime_id, "initializing", true);
        manager
            .insert_record(original.clone())
            .expect("insert original record");
        let replacement = native_record(runtime_id, "error", false);

        let error = manager
            .insert_record(replacement)
            .expect_err("duplicate runtime record must be rejected");

        assert!(error.contains("already exists"));
        assert_eq!(
            manager.records.lock().expect("records").get(runtime_id),
            Some(&original)
        );
        let _ = fs::remove_file(&manager.state_path);
    }

    #[test]
    fn duplicate_handle_insert_is_rejected_without_overwrite() {
        let runtime_id = "native-duplicate-handle";
        let manager = manager_with_handle(runtime_id);
        let original = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .expect("original handle")
            .clone();
        let replacement =
            native_session_handle_with_generation(native_record(runtime_id, "processing", true), 2);

        let error = manager
            .insert_handle(runtime_id.to_string(), replacement)
            .expect_err("duplicate runtime handle must be rejected");

        assert!(error.contains("already exists"));
        assert!(Arc::ptr_eq(
            manager
                .handles
                .lock()
                .expect("handles")
                .get(runtime_id)
                .expect("original handle retained"),
            &original
        ));
    }

    #[cfg(unix)]
    #[test]
    fn managed_helper_kill_reaps_shell_wrapper_and_grandchild_without_touching_sibling() {
        let mut sibling = Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn unrelated sibling");
        let sibling_pid = sibling.id();

        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(
            r#"read ready
trap '' TERM
/bin/sh -c 'trap "" TERM; while :; do /bin/sleep 1; done' &
echo "$!"
wait"#,
        );
        let (mut events, mut helper) =
            super::spawn_native_helper_process(command).expect("spawn managed helper tree");
        let root_pid = helper.pid();
        helper.write(b"ready\n").expect("start helper workload");

        let grandchild_pid = tauri::async_runtime::block_on(async {
            loop {
                match events.recv().await.expect("managed helper event") {
                    tauri_plugin_shell::process::CommandEvent::Stdout(bytes) => {
                        let value = String::from_utf8_lossy(&bytes).trim().to_string();
                        if let Ok(pid) = value.parse::<u32>() {
                            break pid;
                        }
                    }
                    tauri_plugin_shell::process::CommandEvent::Error(error) => {
                        panic!("managed helper output failed: {error}")
                    }
                    _ => {}
                }
            }
        });

        assert_eq!(
            unsafe { libc::getpgid(root_pid as i32) },
            root_pid as i32,
            "managed helper must lead its own process group"
        );
        assert_ne!(
            unsafe { libc::getpgid(sibling_pid as i32) },
            root_pid as i32,
            "unrelated sibling must stay outside the managed group"
        );

        helper.kill().expect("kill managed helper tree");
        let deadline = Instant::now() + Duration::from_secs(5);
        while super::native_process_group_exists(root_pid as i32)
            || super::native_process_exists(grandchild_pid)
        {
            assert!(
                Instant::now() < deadline,
                "managed helper group or grandchild survived tree kill"
            );
            std::thread::sleep(Duration::from_millis(25));
        }

        assert!(
            sibling.try_wait().expect("poll sibling").is_none(),
            "tree kill must not touch an unrelated sibling"
        );
        let _ = sibling.kill();
        let _ = sibling.wait();
    }

    #[test]
    fn process_tree_termination_is_serialized_and_success_is_idempotent() {
        let terminated = Mutex::new(false);
        let calls = AtomicUsize::new(0);

        super::terminate_process_tree_once(&terminated, || {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .expect("first termination");
        super::terminate_process_tree_once(&terminated, || {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .expect("idempotent termination");

        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn failed_process_tree_termination_remains_retryable() {
        let terminated = Mutex::new(false);
        let calls = AtomicUsize::new(0);

        let error = super::terminate_process_tree_once(&terminated, || {
            calls.fetch_add(1, Ordering::SeqCst);
            Err("first kill failed".to_string())
        })
        .expect_err("first termination must fail");
        super::terminate_process_tree_once(&terminated, || {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .expect("failed termination must be retryable");

        assert_eq!(error, "first kill failed");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[cfg(unix)]
    #[test]
    fn managed_helper_drains_fast_exit_output_before_termination() {
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg("printf tail-without-newline");
        let (mut events, _helper) =
            super::spawn_native_helper_process(command).expect("spawn fast helper");

        let observed = tauri::async_runtime::block_on(async {
            let mut observed = Vec::new();
            while let Some(event) = events.recv().await {
                match event {
                    tauri_plugin_shell::process::CommandEvent::Stdout(bytes) => {
                        observed.push(String::from_utf8_lossy(&bytes).to_string());
                    }
                    tauri_plugin_shell::process::CommandEvent::Terminated(_) => {
                        observed.push("terminated".to_string());
                        break;
                    }
                    tauri_plugin_shell::process::CommandEvent::Error(error) => {
                        panic!("fast helper failed: {error}")
                    }
                    _ => {}
                }
            }
            observed
        });

        assert_eq!(observed, vec!["tail-without-newline", "terminated"]);
    }

    #[cfg(unix)]
    #[test]
    fn managed_helper_root_exit_reaps_stubborn_descendant_without_touching_sibling() {
        let mut sibling = Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn unrelated sibling");
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(
            r#"read ready
/bin/sh -c 'trap "" TERM; while :; do /bin/sleep 1; done' &
echo "$!"
exit 0"#,
        );
        let (mut events, mut helper) =
            super::spawn_native_helper_process(command).expect("spawn managed helper tree");
        let root_pid = helper.pid();
        helper.write(b"ready\n").expect("start helper workload");

        let grandchild_pid = tauri::async_runtime::block_on(async {
            let mut grandchild_pid = None;
            while let Some(event) = events.recv().await {
                match event {
                    tauri_plugin_shell::process::CommandEvent::Stdout(bytes) => {
                        grandchild_pid = String::from_utf8_lossy(&bytes).trim().parse().ok();
                    }
                    tauri_plugin_shell::process::CommandEvent::Terminated(_) => break,
                    tauri_plugin_shell::process::CommandEvent::Error(error) => {
                        panic!("managed helper failed: {error}")
                    }
                    _ => {}
                }
            }
            grandchild_pid.expect("grandchild pid before termination")
        });

        let deadline = Instant::now() + Duration::from_secs(5);
        while super::native_process_group_exists(root_pid as i32)
            || super::native_process_exists(grandchild_pid)
        {
            assert!(
                Instant::now() < deadline,
                "descendant survived natural helper root exit"
            );
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(
            sibling.try_wait().expect("poll sibling").is_none(),
            "root-exit cleanup must not touch an unrelated sibling"
        );
        let _ = sibling.kill();
        let _ = sibling.wait();
    }

    #[cfg(unix)]
    #[test]
    fn dropping_managed_helper_reaps_stubborn_descendant_without_touching_sibling() {
        let mut sibling = Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn unrelated sibling");
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(
            r#"read ready
/bin/sh -c 'trap "" TERM; while :; do /bin/sleep 1; done' &
echo "$!"
wait"#,
        );
        let (mut events, mut helper) =
            super::spawn_native_helper_process(command).expect("spawn managed helper tree");
        let root_pid = helper.pid();
        helper.write(b"ready\n").expect("start helper workload");
        let grandchild_pid = tauri::async_runtime::block_on(async {
            loop {
                match events.recv().await.expect("managed helper event") {
                    tauri_plugin_shell::process::CommandEvent::Stdout(bytes) => {
                        if let Ok(pid) = String::from_utf8_lossy(&bytes).trim().parse::<u32>() {
                            break pid;
                        }
                    }
                    tauri_plugin_shell::process::CommandEvent::Error(error) => {
                        panic!("managed helper failed: {error}")
                    }
                    _ => {}
                }
            }
        });

        drop(helper);
        let deadline = Instant::now() + Duration::from_secs(5);
        while super::native_process_group_exists(root_pid as i32)
            || super::native_process_exists(grandchild_pid)
        {
            assert!(
                Instant::now() < deadline,
                "descendant survived managed helper Drop"
            );
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(
            sibling.try_wait().expect("poll sibling").is_none(),
            "Drop cleanup must not touch an unrelated sibling"
        );
        let _ = sibling.kill();
        let _ = sibling.wait();
    }

    #[cfg(unix)]
    #[test]
    fn force_kill_reaps_process_tree_even_when_state_persist_fails() {
        let runtime_id = "native-force-kill-persist-failure";
        let mut manager = manager_with_handle(runtime_id);
        manager.state_path = PathBuf::from("/dev/null/native-runtime-state.json");
        let handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .expect("handle")
            .clone();
        handle.alive.store(false, Ordering::SeqCst);

        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(
            r#"read ready
/bin/sh -c 'trap "" TERM; while :; do /bin/sleep 1; done' &
echo "$!"
wait"#,
        );
        let (mut events, mut child) =
            super::spawn_native_helper_process(command).expect("spawn managed helper tree");
        let root_pid = child.pid();
        child.write(b"ready\n").expect("start helper workload");
        let grandchild_pid = tauri::async_runtime::block_on(async {
            loop {
                match events.recv().await.expect("managed helper event") {
                    tauri_plugin_shell::process::CommandEvent::Stdout(bytes) => {
                        if let Ok(pid) = String::from_utf8_lossy(&bytes).trim().parse::<u32>() {
                            break pid;
                        }
                    }
                    tauri_plugin_shell::process::CommandEvent::Error(error) => {
                        panic!("managed helper failed: {error}")
                    }
                    _ => {}
                }
            }
        });
        *handle.child.lock().expect("child slot") = Some(child);
        let poison_target = Arc::clone(&handle);
        let _ = std::thread::spawn(move || {
            let _child = poison_target.child.lock().expect("child slot");
            panic!("poison child slot");
        })
        .join();

        let error = manager
            .force_kill_stopped_handle(runtime_id, &handle)
            .expect_err("state persistence must fail");
        let handle_removed = !manager
            .is_current_handle(runtime_id, &handle)
            .expect("current handle check");
        let deadline = Instant::now() + Duration::from_secs(5);
        while super::native_process_group_exists(root_pid as i32)
            || super::native_process_exists(grandchild_pid)
        {
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let tree_reaped = !super::native_process_group_exists(root_pid as i32)
            && !super::native_process_exists(grandchild_pid);
        let _ = manager.kill_child(runtime_id);

        assert!(error.contains("persist"));
        assert!(error.contains("child mutex was poisoned"));
        assert!(
            handle_removed,
            "persist failure must not retain the stopped handle"
        );
        assert!(
            tree_reaped,
            "persist failure must not skip process-tree kill"
        );
    }

    #[cfg(unix)]
    #[test]
    fn stop_schedules_force_cleanup_even_when_state_persist_fails() {
        let runtime_id = "native-stop-schedule-persist-failure";
        let mut manager = manager_with_handle(runtime_id);
        manager.state_path = PathBuf::from("/dev/null/native-runtime-state.json");
        let handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .expect("handle")
            .clone();
        manager
            .records
            .lock()
            .expect("records")
            .get_mut(runtime_id)
            .expect("record")
            .provider = NativeProvider::Codex;
        handle.record.lock().expect("handle record").provider = NativeProvider::Codex;

        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(
            r#"read ready
/bin/sh -c 'trap "" TERM; while :; do /bin/sleep 1; done' &
echo "$!"
wait"#,
        );
        let (mut events, mut child) =
            super::spawn_native_helper_process(command).expect("spawn managed helper tree");
        let root_pid = child.pid();
        child.write(b"ready\n").expect("start helper workload");
        let grandchild_pid = tauri::async_runtime::block_on(async {
            loop {
                match events.recv().await.expect("managed helper event") {
                    tauri_plugin_shell::process::CommandEvent::Stdout(bytes) => {
                        if let Ok(pid) = String::from_utf8_lossy(&bytes).trim().parse::<u32>() {
                            break pid;
                        }
                    }
                    tauri_plugin_shell::process::CommandEvent::Error(error) => {
                        panic!("managed helper failed: {error}")
                    }
                    _ => {}
                }
            }
        });
        *handle.child.lock().expect("child slot") = Some(child);

        let manager = Arc::new(manager);
        let error = manager
            .stop_session_from_with_grace(
                runtime_id,
                Some("regression_test"),
                Duration::from_millis(50),
            )
            .expect_err("state persistence must still be reported");
        assert!(error.contains("persist"));

        let deadline = Instant::now() + Duration::from_secs(5);
        while manager
            .is_current_handle(runtime_id, &handle)
            .unwrap_or(false)
            || super::native_process_group_exists(root_pid as i32)
            || super::native_process_exists(grandchild_pid)
        {
            assert!(
                Instant::now() < deadline,
                "scheduled force cleanup did not retire the stopped helper tree"
            );
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    #[cfg(unix)]
    #[test]
    fn stop_write_still_returns_cleanup_handle_when_lifecycle_store_is_poisoned() {
        let runtime_id = "native-stop-write-poisoned-telemetry";
        let manager = manager_with_handle(runtime_id);
        let handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .expect("handle")
            .clone();
        let poison_target = Arc::clone(&handle);
        let _ = std::thread::spawn(move || {
            let _events = poison_target.events.lock().expect("events");
            panic!("poison lifecycle store");
        })
        .join();

        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg("read _stop; /bin/sleep 30");
        let (_events, child) =
            super::spawn_native_helper_process(command).expect("spawn managed helper");
        *handle.child.lock().expect("child slot") = Some(child);

        let scheduled_handle = manager
            .request_child_stop(runtime_id, false)
            .expect("telemetry failure must not fail stop scheduling")
            .expect("successful Stop write must return its cleanup handle");

        assert!(NativeRuntimeManager::same_handle(
            &scheduled_handle,
            &handle
        ));
        assert!(!handle.alive.load(Ordering::SeqCst));
        manager
            .retire_handle_if_current(runtime_id, &handle)
            .expect("cleanup stopped helper");
    }

    #[cfg(unix)]
    #[test]
    fn completed_terminal_handoff_reaps_old_tree_despite_metadata_failures() {
        let runtime_id = "native-handoff-metadata-failure";
        let mut manager = manager_with_handle(runtime_id);
        manager.state_path = PathBuf::from("/dev/null/native-runtime-state.json");
        let handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .expect("handle")
            .clone();
        manager
            .records
            .lock()
            .expect("records")
            .get_mut(runtime_id)
            .expect("record")
            .provider_session_id = Some("provider-handoff-session".to_string());
        handle
            .record
            .lock()
            .expect("handle record")
            .provider_session_id = Some("provider-handoff-session".to_string());
        let mut sibling = Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn unrelated sibling");

        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(
            r#"read ready
/bin/sh -c 'trap "" TERM; while :; do /bin/sleep 1; done' &
echo "$!"
wait"#,
        );
        let (mut events, mut child) =
            super::spawn_native_helper_process(command).expect("spawn managed helper tree");
        let root_pid = child.pid();
        child.write(b"ready\n").expect("start helper workload");
        let grandchild_pid = tauri::async_runtime::block_on(async {
            loop {
                match events.recv().await.expect("managed helper event") {
                    tauri_plugin_shell::process::CommandEvent::Stdout(bytes) => {
                        if let Ok(pid) = String::from_utf8_lossy(&bytes).trim().parse::<u32>() {
                            break pid;
                        }
                    }
                    tauri_plugin_shell::process::CommandEvent::Error(error) => {
                        panic!("managed helper failed: {error}")
                    }
                    _ => {}
                }
            }
        });
        *handle.child.lock().expect("child slot") = Some(child);
        let poison_target = Arc::clone(&handle);
        let _ = std::thread::spawn(move || {
            let _events = poison_target.events.lock().expect("events");
            panic!("poison handoff event store");
        })
        .join();

        let frozen_handle = manager
            .freeze_current_handle_for_handoff(runtime_id)
            .expect("freeze current helper");
        let warnings = manager.finish_terminal_handoff_metadata_after_launch(
            runtime_id,
            NativeProvider::Claude.as_str(),
            crate::terminal::TerminalType::TerminalApp,
        );
        assert!(
            !warnings.is_empty(),
            "poisoned metadata stores must be reported as warnings"
        );
        manager
            .retire_handle_if_current(runtime_id, frozen_handle.as_ref().expect("frozen helper"))
            .expect("retire old helper tree");

        let deadline = Instant::now() + Duration::from_secs(5);
        while super::native_process_group_exists(root_pid as i32)
            || super::native_process_exists(grandchild_pid)
        {
            assert!(
                Instant::now() < deadline,
                "terminal handoff left the old native process tree alive"
            );
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(!manager
            .is_current_handle(runtime_id, &handle)
            .expect("current handle check"));
        let record = manager.current_record(runtime_id).expect("handoff record");
        assert_eq!(record.status, "handoff");
        assert!(!record.is_active);
        assert!(
            sibling.try_wait().expect("poll sibling").is_none(),
            "handoff cleanup must not touch an unrelated sibling"
        );
        let _ = sibling.kill();
        let _ = sibling.wait();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn managed_handoff_serializes_replacement_until_old_generation_is_retired() {
        let runtime_id = "native-handoff-serialized-replacement";
        let manager = Arc::new(manager_with_handle(runtime_id));
        let old_handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .expect("handle")
            .clone();
        manager
            .records
            .lock()
            .expect("records")
            .get_mut(runtime_id)
            .expect("record")
            .provider_session_id = Some("provider-handoff-race".to_string());
        old_handle
            .record
            .lock()
            .expect("handle record")
            .provider_session_id = Some("provider-handoff-race".to_string());
        manager
            .records
            .lock()
            .expect("records")
            .get_mut(runtime_id)
            .expect("record")
            .status = "ready".to_string();
        old_handle.record.lock().expect("handle record").status = "ready".to_string();

        let (start_replacement, replacement_started) = std::sync::mpsc::sync_channel(0);
        let (replacement_acquired, acquired_replacement) = std::sync::mpsc::sync_channel(1);
        let replacement_manager = Arc::clone(&manager);
        let replacement_runtime_id = runtime_id.to_string();
        let replacement_thread = std::thread::spawn(move || {
            replacement_started.recv().expect("replacement start");
            let _coordinator = replacement_manager
                .reconnect_lock
                .lock()
                .expect("replacement coordinator");
            replacement_acquired.send(()).expect("replacement acquired");
            let mut record = replacement_manager
                .records
                .lock()
                .expect("records")
                .get(&replacement_runtime_id)
                .expect("record")
                .clone();
            record.status = "processing".to_string();
            record.is_active = true;
            let replacement = native_session_handle_with_generation(record, 2);
            replacement_manager
                .insert_handle(replacement_runtime_id, Arc::clone(&replacement))
                .expect("insert replacement after handoff");
            replacement
        });

        manager
            .run_managed_terminal_handoff(
                runtime_id,
                Some(crate::terminal::TerminalType::TerminalApp),
                false,
                |_| {
                    assert!(
                        !old_handle.alive.load(Ordering::SeqCst),
                        "handoff must make the prepared generation non-live before launch"
                    );
                    start_replacement.send(()).expect("start replacement");
                    assert!(
                        acquired_replacement
                            .recv_timeout(Duration::from_millis(100))
                            .is_err(),
                        "replacement must not enter during the external launch closure"
                    );
                    Ok(())
                },
                |_| {},
            )
            .expect("managed handoff");

        let replacement = replacement_thread.join().expect("replacement thread");
        assert!(manager
            .is_current_handle(runtime_id, &replacement)
            .expect("replacement current check"));
        assert!(replacement.alive.load(Ordering::SeqCst));
        assert!(!NativeRuntimeManager::same_handle(
            &replacement,
            &old_handle
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn failed_managed_handoff_restores_the_frozen_generation() {
        let runtime_id = "native-handoff-launch-failure-no-revive";
        let manager = manager_with_handle(runtime_id);
        let handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .expect("handle")
            .clone();
        manager
            .records
            .lock()
            .expect("records")
            .get_mut(runtime_id)
            .expect("record")
            .provider_session_id = Some("provider-handoff-failure".to_string());
        handle
            .record
            .lock()
            .expect("handle record")
            .provider_session_id = Some("provider-handoff-failure".to_string());
        manager
            .records
            .lock()
            .expect("records")
            .get_mut(runtime_id)
            .expect("record")
            .status = "ready".to_string();
        handle.record.lock().expect("handle record").status = "ready".to_string();

        let error = manager
            .run_managed_terminal_handoff(
                runtime_id,
                Some(crate::terminal::TerminalType::TerminalApp),
                false,
                |_| Err::<(), _>("terminal open failed".to_string()),
                |_| {},
            )
            .expect_err("launch failure");

        assert_eq!(error, "terminal open failed");
        assert!(handle.alive.load(Ordering::SeqCst));
        assert!(manager
            .is_current_handle(runtime_id, &handle)
            .expect("current handle check"));
        let record = manager
            .current_record(runtime_id)
            .expect("failed handoff record");
        assert_eq!(record.status, "ready");
        assert!(record.is_active);
    }

    #[test]
    fn stop_source_normalization_keeps_lifecycle_details_bounded() {
        assert_eq!(super::normalize_stop_source(None), "unattributed");
        assert_eq!(
            super::normalize_stop_source(Some(" workspace_escape ")),
            "workspace_escape"
        );
        assert_eq!(
            super::normalize_stop_source(Some("native session stop button!")),
            "nativesessionstopbutton"
        );
        assert_eq!(super::normalize_stop_source(Some("!!!")), "unattributed");
    }

    #[test]
    fn stopped_handle_cannot_be_revived() {
        let runtime_id = "native-stopped-handle-no-revive";
        let manager = manager_with_handle(runtime_id);
        let handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .expect("handle")
            .clone();
        handle.alive.store(false, Ordering::SeqCst);

        assert!(!manager
            .is_current_live_handle(runtime_id, &handle)
            .expect("live handle check"));
        assert!(!handle.alive.load(Ordering::SeqCst));
    }

    #[test]
    fn retire_and_force_kill_race_removes_stopped_generation_once() {
        let runtime_id = "native-retire-force-kill-race";
        let manager = Arc::new(manager_with_handle(runtime_id));
        let handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .expect("handle")
            .clone();
        handle.alive.store(false, Ordering::SeqCst);

        let barrier = Arc::new(Barrier::new(3));

        let retire_manager = Arc::clone(&manager);
        let retire_barrier = Arc::clone(&barrier);
        let retire_handle = Arc::clone(&handle);
        let retire_runtime_id = runtime_id.to_string();
        let retire_thread = std::thread::spawn(move || {
            retire_barrier.wait();
            retire_manager
                .retire_handle_if_current(&retire_runtime_id, &retire_handle)
                .expect("retire stopped handle")
        });

        let kill_manager = Arc::clone(&manager);
        let kill_barrier = Arc::clone(&barrier);
        let kill_handle = Arc::clone(&handle);
        let kill_runtime_id = runtime_id.to_string();
        let kill_thread = std::thread::spawn(move || {
            kill_barrier.wait();
            kill_manager
                .force_kill_stopped_handle(&kill_runtime_id, &kill_handle)
                .expect("force kill stopped handle")
        });

        barrier.wait();
        let retired = retire_thread.join().expect("retire thread");
        let force_killed = kill_thread.join().expect("kill thread");

        assert_ne!(
            retired, force_killed,
            "exactly one path should remove the stopped generation"
        );
        assert!(!manager
            .is_current_handle(runtime_id, &handle)
            .expect("current handle check"));
    }

    #[test]
    fn stop_force_kill_does_not_remove_reused_live_handle() {
        let runtime_id = "native-stop-force-kill-reused";
        let manager = manager_with_handle(runtime_id);
        let handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .expect("handle")
            .clone();
        handle.alive.store(true, Ordering::SeqCst);

        let removed = manager
            .force_kill_stopped_handle(runtime_id, &handle)
            .expect("skip live handle");

        assert!(!removed);
        assert!(manager
            .is_current_handle(runtime_id, &handle)
            .expect("current handle check"));
    }

    #[test]
    fn unexpected_helper_exit_after_provider_session_is_recoverable() {
        let runtime_id = "native-helper-reclaimed";
        let manager = manager_with_handle(runtime_id);
        let handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .expect("handle")
            .clone();
        manager
            .update_record(runtime_id, |record| {
                record.provider_session_id = Some("provider-session-1".to_string());
                record.can_handoff_to_terminal = true;
                record.status = "ready".to_string();
                record.is_active = true;
            })
            .expect("set ready record");

        manager
            .mark_process_exit(runtime_id, Some(9), &handle)
            .expect("mark process exit");

        let summary = manager.summary_for(runtime_id).expect("summary");
        assert_eq!(summary.status, "interrupted");
        assert!(!summary.is_active);
        assert_eq!(
            summary.last_error.as_deref(),
            Some("Native runtime sidecar exited unexpectedly with code 9.")
        );
        assert!(!manager
            .is_current_handle(runtime_id, &handle)
            .expect("current handle check"));
    }

    #[cfg(unix)]
    #[test]
    fn process_exit_retires_generation_even_when_state_persist_fails() {
        let runtime_id = "native-exit-persist-failure";
        let mut manager = manager_with_handle(runtime_id);
        manager.state_path = PathBuf::from("/dev/null/native-runtime-state.json");
        let handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .expect("handle")
            .clone();

        let error = manager
            .mark_process_exit(runtime_id, Some(9), &handle)
            .expect_err("state persistence must still be reported");

        assert!(error.contains("persist"));
        assert!(!manager
            .is_current_handle(runtime_id, &handle)
            .expect("current handle check"));
        assert!(!handle.alive.load(Ordering::SeqCst));
    }

    #[test]
    fn unexpected_helper_exit_before_provider_session_stays_error() {
        let runtime_id = "native-helper-startup-crash";
        let manager = manager_with_handle(runtime_id);
        let handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .expect("handle")
            .clone();

        manager
            .mark_process_exit(runtime_id, Some(1), &handle)
            .expect("mark process exit");

        let summary = manager.summary_for(runtime_id).expect("summary");
        assert_eq!(summary.status, "error");
        assert!(!summary.is_active);
        assert_eq!(
            summary.last_error.as_deref(),
            Some("Native runtime sidecar exited unexpectedly with code 1.")
        );
    }

    #[test]
    fn interrupted_helper_exit_keeps_recoverable_status() {
        let runtime_id = "native-interrupted-helper-exit";
        let manager = manager_with_handle(runtime_id);
        let handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .expect("handle")
            .clone();
        manager
            .update_record(runtime_id, |record| {
                record.provider_session_id = Some("provider-session-1".to_string());
                record.status = "interrupted".to_string();
                record.is_active = false;
                record.last_error = Some("Turn interrupted.".to_string());
            })
            .expect("set interrupted record");

        manager
            .mark_process_exit(runtime_id, Some(9), &handle)
            .expect("mark process exit");

        let summary = manager.summary_for(runtime_id).expect("summary");
        assert_eq!(summary.status, "interrupted");
        assert!(!summary.is_active);
        assert_eq!(summary.last_error.as_deref(), Some("Turn interrupted."));
    }

    #[test]
    fn closed_idle_record_reconnects_like_recoverable_terminal_status() {
        let mut record = native_record("native-closed-idle-reconnect", "closed_idle", false);

        assert!(super::is_native_terminal_status(&record.status));
        assert!(reactivate_record_for_reconnect(&mut record));
        assert_eq!(record.status, "initializing");
        assert!(record.is_active);
    }

    #[test]
    fn reconnect_reactivates_error_record_for_user_continue() {
        let mut record = native_record("native-reactivate-error", "error", false);
        record.last_error = Some("Native runtime sidecar exited unexpectedly.".to_string());

        assert!(reactivate_record_for_reconnect(&mut record));
        assert_eq!(record.status, "initializing");
        assert!(record.is_active);
        assert_eq!(record.last_error, None);
    }

    #[test]
    fn reconnect_prepare_failure_restores_the_complete_terminal_record() {
        let runtime_id = "native-reconnect-prepare-rollback";
        let mut record = native_record(runtime_id, "interrupted", false);
        record.env_name = "official".into();
        record.last_error = Some("failure before reconnect".into());
        record.router = Some(reconnect_router_record(LaunchTransport::Routed));
        let original = record.clone();
        let manager = Arc::new(manager_with_records(runtime_id, vec![record]));
        manager
            .set_router_manager(Arc::new(RouterManager::new(RouterConfig::default())))
            .expect("set unavailable router manager");

        let error = manager
            .prepare_reconnect_handle_locked(runtime_id, false, None)
            .err()
            .expect("routed reconnect should fail while the router is unavailable");

        assert!(error.contains("ROUTER_UNAVAILABLE"), "{error}");
        let restored = manager
            .records
            .lock()
            .expect("records")
            .get(runtime_id)
            .expect("restored record")
            .clone();
        assert_eq!(restored, original);
        assert!(!manager
            .handles
            .lock()
            .expect("handles")
            .contains_key(runtime_id));
    }

    #[test]
    fn reconnect_insert_failure_restores_record_and_router_generation_facts() {
        let runtime_id = "native-reconnect-insert-rollback";
        let mut original = native_record(runtime_id, "processing", true);
        original.env_name = "official".into();
        original.last_error = Some("diagnostic retained across rollback".into());
        original.router = Some(reconnect_router_record(LaunchTransport::Routed));
        let mut staged_direct = original.clone();
        staged_direct.status = "initializing".into();
        staged_direct.last_error = None;
        let direct_router = staged_direct.router.as_mut().expect("router");
        direct_router.launch_transport = LaunchTransport::Direct;
        direct_router.revision += 1;
        direct_router.warnings = vec!["staged direct generation".into()];
        let manager = Arc::new(manager_with_records(runtime_id, vec![staged_direct]));
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = manager.handles.lock().expect("handles before poison");
            panic!("poison handles to force insert failure");
        }));

        let error = manager
            .prepare_reconnect_handle_locked(runtime_id, true, Some(&original))
            .err()
            .expect("handle insertion should fail");

        assert!(
            error.contains("Failed to lock native runtime handles"),
            "{error}"
        );
        let restored = manager
            .records
            .lock()
            .expect("records")
            .get(runtime_id)
            .expect("restored record")
            .clone();
        assert_eq!(restored.status, "interrupted");
        assert!(!restored.is_active);
        assert_eq!(restored.pending_handoff_terminal, None);
        assert_eq!(restored.router, original.router);
        assert_eq!(restored.env_name, original.env_name);
        assert_eq!(restored.provider_session_id, original.provider_session_id);
    }

    #[test]
    fn reconnect_persist_failure_keeps_killed_generation_recoverable_without_handle() {
        let runtime_id = "native-reconnect-persist-rollback";
        let mut original = native_record(runtime_id, "processing", true);
        original.env_name = "official".into();
        original.router = Some(reconnect_router_record(LaunchTransport::Routed));
        let mut staged_direct = original.clone();
        staged_direct.status = "initializing".into();
        let direct_router = staged_direct.router.as_mut().expect("router");
        direct_router.launch_transport = LaunchTransport::Direct;
        direct_router.revision += 1;

        let unwritable_state_path = tempfile::tempdir().expect("state directory");
        let mut manager = manager_with_records(runtime_id, vec![staged_direct]);
        manager.state_path = unwritable_state_path.path().to_path_buf();
        let manager = Arc::new(manager);

        let error = manager
            .prepare_reconnect_handle_locked(runtime_id, true, Some(&original))
            .err()
            .expect("persisting over a directory should fail");

        assert!(
            error.contains("Failed to persist private native runtime state"),
            "{error}"
        );
        let restored = manager
            .records
            .lock()
            .expect("records")
            .get(runtime_id)
            .expect("restored record")
            .clone();
        assert_eq!(restored.status, "interrupted");
        assert!(!restored.is_active);
        assert_eq!(restored.router, original.router);
        assert!(!manager
            .handles
            .lock()
            .expect("handles")
            .contains_key(runtime_id));
    }

    #[test]
    fn direct_restart_stage_persist_failure_restores_routed_recovery_facts() {
        let runtime_id = "native-direct-stage-persist-rollback";
        let mut original = native_record(runtime_id, "processing", true);
        original.env_name = "official".into();
        original.router = Some(reconnect_router_record(LaunchTransport::Routed));
        let recovery = recoverable_record_after_helper_removed(&original);
        let mut direct_router = original.router.clone().expect("router");
        direct_router.launch_transport = LaunchTransport::Direct;
        direct_router.revision += 1;

        let unwritable_state_path = tempfile::tempdir().expect("state directory");
        let mut manager = manager_with_records(runtime_id, vec![original.clone()]);
        manager.state_path = unwritable_state_path.path().to_path_buf();

        let error = manager
            .stage_direct_restart_record(
                runtime_id,
                original.router.as_ref().expect("router").revision,
                &direct_router,
                &recovery,
            )
            .expect_err("persisting over a directory should fail");

        assert_eq!(error.code, "ROUTER_PERSIST_FAILED");
        let restored = manager
            .records
            .lock()
            .expect("records")
            .get(runtime_id)
            .expect("restored record")
            .clone();
        assert_eq!(restored.status, "interrupted");
        assert!(!restored.is_active);
        assert_eq!(restored.router, original.router);
        assert!(!manager
            .handles
            .lock()
            .expect("handles")
            .contains_key(runtime_id));
    }

    #[test]
    fn direct_restart_persists_recovery_before_retiring_the_handle() {
        let runtime_id = "native-direct-retire-handle";
        let mut manager = manager_with_handle(runtime_id);
        let mut original = manager
            .records
            .lock()
            .expect("records")
            .get(runtime_id)
            .expect("record")
            .clone();
        original.router = Some(reconnect_router_record(LaunchTransport::Routed));
        manager
            .records
            .lock()
            .expect("records")
            .insert(runtime_id.to_string(), original.clone());
        let state_dir = tempfile::tempdir().expect("state directory");
        manager.state_path = state_dir.path().join("native-runtime-state.json");
        manager
            .retire_handle_for_direct_restart(
                runtime_id,
                original.router.as_ref().expect("router").revision,
            )
            .expect("retire handle");

        let restored = manager
            .records
            .lock()
            .expect("records")
            .get(runtime_id)
            .expect("record")
            .clone();
        assert_eq!(restored.status, "interrupted");
        assert!(!restored.is_active);
        assert_eq!(restored.router, original.router);
        assert!(!manager
            .handles
            .lock()
            .expect("handles")
            .contains_key(runtime_id));
    }

    #[test]
    fn direct_restart_recovery_persist_failure_leaves_old_handle_active() {
        let runtime_id = "native-direct-retire-persist-failure";
        let mut manager = manager_with_handle(runtime_id);
        let mut original = manager
            .records
            .lock()
            .expect("records")
            .get(runtime_id)
            .expect("record")
            .clone();
        original.router = Some(reconnect_router_record(LaunchTransport::Routed));
        manager
            .records
            .lock()
            .expect("records")
            .insert(runtime_id.to_string(), original.clone());
        let unwritable_state_path = tempfile::tempdir().expect("state directory");
        manager.state_path = unwritable_state_path.path().to_path_buf();
        let error = manager
            .retire_handle_for_direct_restart(
                runtime_id,
                original.router.as_ref().expect("router").revision,
            )
            .expect_err("persisting over a directory should fail before retirement");

        assert_eq!(error.code, "ROUTER_PERSIST_FAILED");
        assert_eq!(
            manager.records.lock().expect("records").get(runtime_id),
            Some(&original)
        );
        let handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .expect("old handle retained")
            .clone();
        assert!(handle.alive.load(Ordering::SeqCst));
    }

    #[test]
    fn helper_env_path_preserves_api_vars_and_adds_user_path() {
        let mut env_vars = HashMap::from([(
            "ANTHROPIC_AUTH_TOKEN".to_string(),
            "secret-token".to_string(),
        )]);

        merge_helper_env_path(
            &mut env_vars,
            "/Users/test/.nvm/versions/node/v22/bin:/usr/bin",
        );

        assert_eq!(
            env_vars.get("ANTHROPIC_AUTH_TOKEN").map(String::as_str),
            Some("secret-token")
        );
        assert_eq!(
            env_vars.get("PATH").map(String::as_str),
            Some("/Users/test/.nvm/versions/node/v22/bin:/usr/bin")
        );
    }

    #[test]
    fn helper_env_path_prepends_user_path_to_existing_path() {
        let (existing_path, user_path, expected_path) = if cfg!(windows) {
            (
                r"C:\custom\bin",
                r"D:\Users\test\AppData\Roaming\npm;C:\Program Files\nodejs",
                r"D:\Users\test\AppData\Roaming\npm;C:\Program Files\nodejs;C:\custom\bin",
            )
        } else {
            (
                "/custom/bin",
                "/Users/test/.nvm/versions/node/v22/bin:/usr/bin",
                "/Users/test/.nvm/versions/node/v22/bin:/usr/bin:/custom/bin",
            )
        };
        let mut env_vars = HashMap::from([("PATH".to_string(), existing_path.to_string())]);

        merge_helper_env_path(&mut env_vars, user_path);

        assert_eq!(
            env_vars.get("PATH").map(String::as_str),
            Some(expected_path)
        );
    }

    #[test]
    fn helper_env_path_merges_windows_paths_without_splitting_drive_letters() {
        assert_eq!(
            merge_path_values_with_separator(
                r"D:\Users\test\AppData\Roaming\npm;C:\Program Files\nodejs",
                r"C:\custom\bin;D:\Users\test\AppData\Roaming\npm",
                ';'
            ),
            r"D:\Users\test\AppData\Roaming\npm;C:\Program Files\nodejs;C:\custom\bin"
        );
    }
}
