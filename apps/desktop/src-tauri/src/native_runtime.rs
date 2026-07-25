use crate::browser::{authorize_browser_tool, BrowserManager, BrowserToolRequest};
use crate::config::{resolve_claude_env, resolve_codex_runtime};
use crate::event_bus::{
    ReplayBatch, SessionEventPayload, SessionPromptImage, SessionStore, TodoSnapshotV1,
};
use crate::native_event_log::NativeEventLog;
use crate::native_helper_resource::native_helper_script_path;
use crate::prompt_image_store::PromptImageStore;
use crate::session_provenance::bind_source_session_id;
use crate::system_proxy::resolve_codex_proxy_env;
use crate::terminal::{self, resolve_claude_path, resolve_codex_path, TerminalType};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
#[cfg(test)]
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

const NATIVE_STOP_GRACE_PERIOD: Duration = Duration::from_secs(10);
static NATIVE_RUNTIME_STATE_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

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
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub is_active: bool,
    pub can_handoff_to_terminal: bool,
    #[serde(default, skip_serializing)]
    pub pending_handoff_terminal: Option<TerminalType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
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
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub is_active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_event_seq: Option<u64>,
    pub can_handoff_to_terminal: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
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
    pub provider_session_id: Option<String>,
    pub seed_boundary_message_count: Option<u64>,
    pub helper_env_vars: HashMap<String, String>,
    pub terminal_env_vars: HashMap<String, String>,
    pub claude_path: Option<String>,
    pub codex_path: Option<String>,
    pub codex_base_url: Option<String>,
    pub codex_api_key: Option<String>,
    pub effort: Option<String>,
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
) -> Option<String> {
    if text.trim().is_empty() && images.map(|items| items.is_empty()).unwrap_or(true) {
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

    Some(hex::encode(hasher.finalize()))
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
        #[serde(skip_serializing_if = "Option::is_none")]
        env_name: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        perm_mode: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        env_vars: Option<&'a HashMap<String, String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        effort: Option<&'a str>,
    },
    RewindFiles {
        checkpoint_id: &'a str,
    },
    BrowserToolResponse {
        request_id: &'a str,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<&'a Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<&'a str>,
    },
    Stop,
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
        HelperInputCommand::BrowserToolResponse { .. } => "browser_tool_response",
        HelperInputCommand::Stop => "stop",
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
}

struct NativeSessionHandle {
    generation: u64,
    record: Mutex<NativeSessionRecord>,
    child: Mutex<Option<CommandChild>>,
    events: Mutex<SessionStore>,
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
            status: record.status,
            created_at: record.created_at,
            updated_at: record.updated_at,
            is_active: record.is_active,
            last_event_seq,
            can_handoff_to_terminal: record.can_handoff_to_terminal,
            last_error: record.last_error,
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
fn terminal_launches() -> &'static Mutex<Vec<TerminalLaunchInvocation>> {
    static LAUNCHES: OnceLock<Mutex<Vec<TerminalLaunchInvocation>>> = OnceLock::new();
    LAUNCHES.get_or_init(|| Mutex::new(Vec::new()))
}

#[cfg(test)]
fn clear_terminal_launches() {
    terminal_launches()
        .lock()
        .expect("terminal launches")
        .clear();
}

#[cfg(test)]
fn take_terminal_launches() -> Vec<TerminalLaunchInvocation> {
    std::mem::take(&mut *terminal_launches().lock().expect("terminal launches"))
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
    terminal_launches()
        .lock()
        .expect("terminal launches")
        .push(TerminalLaunchInvocation {
            terminal,
            working_dir: working_dir.to_string(),
            runtime_id: runtime_id.to_string(),
            env_name: env_name.to_string(),
            perm_mode: perm_mode.map(str::to_string),
            resume_session_id: resume_session_id.map(str::to_string),
            client: client.to_string(),
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
}

impl Default for NativeRuntimeManager {
    fn default() -> Self {
        let state_path = native_runtime_state_file_path();
        let records = read_native_runtime_state_from(&state_path)
            .unwrap_or_default()
            .sessions
            .into_iter()
            .map(|record| (record.runtime_id.clone(), record))
            .collect();
        Self {
            records: Mutex::new(records),
            handles: Mutex::new(HashMap::new()),
            next_handle_generation: AtomicU64::new(1),
            state_path,
            event_log: NativeEventLog::default(),
            prompt_image_store: PromptImageStore::default(),
        }
    }
}

impl NativeRuntimeManager {
    pub fn create_session(
        self: &Arc<Self>,
        app: AppHandle,
        options: NativeSessionOptions,
    ) -> Result<NativeSessionSummary, String> {
        let mut options = options;
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
            status: "initializing".to_string(),
            created_at: now,
            updated_at: now,
            is_active: true,
            can_handoff_to_terminal: terminal::external_terminal_launch_supported(),
            pending_handoff_terminal: None,
            last_error: None,
        };

        let handle = Arc::new(NativeSessionHandle {
            generation: self.allocate_handle_generation(),
            record: Mutex::new(record.clone()),
            child: Mutex::new(None),
            events: Mutex::new(SessionStore::new(runtime_id.clone())),
            helper_env_vars: options.helper_env_vars.clone(),
            terminal_env_vars: options.terminal_env_vars.clone(),
            claude_path: options.claude_path.clone(),
            codex_path: options.codex_path.clone(),
            codex_base_url: options.codex_base_url.clone(),
            codex_api_key: options.codex_api_key.clone(),
            alive: AtomicBool::new(true),
        });

        self.insert_record(record)?;
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
        )?;
        self.spawn_helper(app, &runtime_id, &options, handle)?;
        self.summary_for(&runtime_id)
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
                        status: record.status,
                        created_at: record.created_at,
                        updated_at: record.updated_at,
                        is_active: record.is_active,
                        last_event_seq: None,
                        can_handoff_to_terminal: record.can_handoff_to_terminal,
                        last_error: record.last_error,
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

    pub fn replay_events_limited(
        &self,
        runtime_id: &str,
        since_seq: Option<u64>,
        limit: Option<u64>,
    ) -> Result<ReplayBatch, String> {
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
    ) -> Result<(), String> {
        let text = text.trim();
        let has_images = images.as_ref().is_some_and(|imgs| !imgs.is_empty());
        if text.is_empty() && !has_images {
            return Ok(());
        }

        let mut handle = self.ensure_handle(app.clone(), runtime_id)?;
        let image_count = images.as_ref().map(|imgs| imgs.len()).unwrap_or(0);
        if !self.mark_handle_live_if_current(runtime_id, &handle)? {
            handle = self.ensure_handle(app.clone(), runtime_id)?;
            if !self.mark_handle_live_if_current(runtime_id, &handle)? {
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
        self.append_user_prompt_event(runtime_id, display_text.unwrap_or(text), images)
    }

    pub fn respond_to_permission(
        self: &Arc<Self>,
        app: &AppHandle,
        runtime_id: &str,
        request_id: &str,
        approved: bool,
    ) -> Result<(), String> {
        let handle = self.ensure_handle(app.clone(), runtime_id)?;
        self.write_to_child_with_reconnect(
            app,
            runtime_id,
            handle,
            &HelperInputCommand::PermissionResponse {
                request_id,
                approved,
            },
        )
    }

    pub fn respond_to_prompt(
        self: &Arc<Self>,
        app: &AppHandle,
        runtime_id: &str,
        tool_use_id: &str,
        prompt_type: &str,
        display_text: Option<&str>,
        answers: &HashMap<String, String>,
        annotations: Option<&HashMap<String, InteractivePromptAnnotation>>,
    ) -> Result<(), String> {
        if answers.is_empty() {
            return Err("Interactive prompt response requires at least one answer.".to_string());
        }

        let handle = self.ensure_handle(app.clone(), runtime_id)?;
        self.append_interactive_prompt_response_event(runtime_id, display_text, answers)?;
        self.write_to_child_with_reconnect(
            app,
            runtime_id,
            handle,
            &HelperInputCommand::InteractivePromptResponse {
                tool_use_id,
                prompt_type,
                answers,
                annotations,
            },
        )
    }

    pub fn rewind_files(
        self: &Arc<Self>,
        app: &AppHandle,
        runtime_id: &str,
        checkpoint_id: &str,
    ) -> Result<(), String> {
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

        self.write_to_child_with_reconnect(
            app,
            runtime_id,
            handle,
            &HelperInputCommand::RewindFiles { checkpoint_id },
        )
    }

    pub fn update_session_settings(
        self: &Arc<Self>,
        app: &AppHandle,
        runtime_id: &str,
        env_name: Option<&str>,
        perm_mode: Option<&str>,
        env_vars: Option<&HashMap<String, String>>,
        effort: Option<&str>,
    ) -> Result<(), String> {
        let handle = self.ensure_handle(app.clone(), runtime_id)?;
        if let Some(mode) = perm_mode {
            self.update_record(runtime_id, |record| {
                record.perm_mode = mode.to_string();
                record.runtime_perm_mode = None;
                record.updated_at = Utc::now();
            })?;
            notify_browser_policy_changed(app, runtime_id);
        }
        self.write_to_child_with_reconnect(
            app,
            runtime_id,
            handle,
            &HelperInputCommand::UpdateSettings {
                env_name,
                perm_mode,
                env_vars,
                effort,
            },
        )?;
        self.update_record(runtime_id, |record| {
            if let Some(name) = env_name {
                record.env_name = name.to_string();
            }
            if let Some(next_effort) = effort {
                record.effort = non_empty_error(next_effort);
            }
            record.updated_at = Utc::now();
        })?;
        Ok(())
    }

    pub fn update_session_runtime_perm_mode(
        self: &Arc<Self>,
        app: &AppHandle,
        runtime_id: &str,
        runtime_perm_mode: Option<&str>,
    ) -> Result<(), String> {
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
                env_name: None,
                perm_mode: Some(&helper_perm_mode),
                env_vars: None,
                effort: None,
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
        let stop_source = normalize_stop_source(source);
        let stop_status = self
            .records
            .lock()
            .map_err(|_| "Failed to lock native runtime records".to_string())?
            .get(runtime_id)
            .map(|record| record.status.clone())
            .unwrap_or_else(|| "missing_record".to_string());
        let stop_handle_generation = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(runtime_id)
            .map(|handle| handle.generation.to_string())
            .unwrap_or_else(|| "none".to_string());
        self.append_event(
            runtime_id,
            SessionEventPayload::SessionCompleted {
                reason: "Stopped from desktop workspace.".to_string(),
            },
        )?;
        self.append_lifecycle_event(
            runtime_id,
            "stop_requested",
            format!(
                "Desktop workspace requested native runtime stop. source={stop_source} status={stop_status} handle_generation={stop_handle_generation}"
            ),
        )?;
        if let Some(handle) = self.request_child_stop(runtime_id)? {
            // Graceful stop — the helper aborts the current turn and stays alive.
            // Mark as interrupted so the frontend re-enables the composer for continued use.
            self.update_record(runtime_id, |record| {
                record.status = "interrupted".to_string();
                record.updated_at = Utc::now();
            })?;
            self.schedule_force_kill(runtime_id.to_string(), handle);
        } else {
            // Hard stop — the child process was already gone.
            self.update_record(runtime_id, |record| {
                record.status = "stopped".to_string();
                record.is_active = false;
                record.updated_at = Utc::now();
            })?;
            self.kill_child(runtime_id)?;
            self.remove_handle(runtime_id)?;
        }
        Ok(())
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
    ) -> Result<NativeHandoffResult, String> {
        if !terminal::external_terminal_launch_supported() {
            return Err(
                "Terminal handoff is not available on this platform; continue in the native workspace runtime.".to_string(),
            );
        }

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

        if record.provider_session_id.is_some() {
            self.complete_terminal_handoff(record, terminal)?;
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

    pub fn prepare_terminal_handoff(
        &self,
        runtime_id: &str,
        terminal_type: Option<TerminalType>,
    ) -> Result<NativeTerminalHandoff, String> {
        if !terminal::external_terminal_launch_supported() {
            return Err(
                "Terminal handoff is not available on this platform; continue in the native workspace runtime.".to_string(),
            );
        }

        let terminal = terminal_type.unwrap_or_else(terminal::get_preferred_terminal);
        let record = self.current_record(runtime_id)?;
        let resume_session_id = record
            .provider_session_id
            .clone()
            .ok_or_else(|| "Session id is not ready for terminal handoff yet".to_string())?;
        let mut env_vars = self.terminal_env_vars_for_record(&record)?;
        inject_ccem_runtime_env(&mut env_vars, &record.runtime_id);

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
        })
    }

    pub fn complete_managed_terminal_handoff(
        &self,
        runtime_id: &str,
        terminal: TerminalType,
    ) -> Result<(), String> {
        let record = self.current_record(runtime_id)?;
        self.update_record(runtime_id, |entry| {
            entry.status = "handoff".to_string();
            entry.is_active = false;
            entry.updated_at = Utc::now();
            entry.can_handoff_to_terminal = true;
            entry.pending_handoff_terminal = None;
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
        self.kill_child(runtime_id)?;
        self.remove_handle(runtime_id)?;
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
    ) -> Result<(), String> {
        let runtime_id = record.runtime_id.clone();
        let provider_session_id = record
            .provider_session_id
            .clone()
            .ok_or_else(|| "Session id is not ready for terminal handoff yet".to_string())?;

        let mut env_vars = self.terminal_env_vars_for_record(&record)?;
        inject_ccem_runtime_env(&mut env_vars, &runtime_id);

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
            let _ = self.append_lifecycle_event(
                &runtime_id,
                "handoff_failed",
                format!(
                    "Failed to open {} session in {}: {}",
                    record.provider.as_str(),
                    terminal.display_name(),
                    error
                ),
            );
            return Err(error);
        }

        self.update_record(&runtime_id, |entry| {
            entry.status = "handoff".to_string();
            entry.is_active = false;
            entry.updated_at = Utc::now();
            entry.can_handoff_to_terminal = true;
            entry.pending_handoff_terminal = None;
        })?;
        self.append_event(
            &runtime_id,
            SessionEventPayload::Lifecycle {
                stage: "handoff".to_string(),
                detail: format!(
                    "Opened {} session in {}.",
                    record.provider.as_str(),
                    terminal.display_name()
                ),
            },
        )?;
        self.kill_child(&runtime_id)?;
        self.remove_handle(&runtime_id)?;
        Ok(())
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
            return Ok(handle);
        }

        let mut record = self
            .records
            .lock()
            .map_err(|_| "Failed to lock native runtime records".to_string())?
            .get(runtime_id)
            .cloned()
            .ok_or_else(|| format!("Native runtime {} not found", runtime_id))?;

        if reactivate_record_for_reconnect(&mut record) {
            let reactivated = record.clone();
            self.update_record(runtime_id, |stored| {
                *stored = reactivated.clone();
            })?;
        }

        let options = build_runtime_bootstrap_options(&record)?;

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
            helper_env_vars: options.helper_env_vars.clone(),
            terminal_env_vars: options.terminal_env_vars.clone(),
            claude_path: options.claude_path.clone(),
            codex_path: options.codex_path.clone(),
            codex_base_url: options.codex_base_url.clone(),
            codex_api_key: options.codex_api_key.clone(),
            alive: AtomicBool::new(true),
        });

        self.insert_handle(runtime_id.to_string(), handle.clone())?;
        self.append_event(
            runtime_id,
            SessionEventPayload::Lifecycle {
                stage: "runtime_resume".to_string(),
                detail: format!(
                    "Reconnected native runtime helper with generation {}.",
                    handle.generation
                ),
            },
        )?;
        self.spawn_helper(app, runtime_id, &options, handle.clone())?;
        Ok(handle)
    }

    fn spawn_helper(
        self: &Arc<Self>,
        app: AppHandle,
        runtime_id: &str,
        options: &NativeSessionOptions,
        handle: Arc<NativeSessionHandle>,
    ) -> Result<(), String> {
        let todo_snapshot_seed = self.event_log.latest_todo_snapshot(runtime_id)?;
        let helper_path = native_helper_script_path(&app)?;
        let command = app
            .shell()
            .sidecar("ccem-node")
            .map_err(|error| format!("Failed to resolve Node sidecar: {}", error))?
            .arg(helper_path.to_string_lossy().to_string())
            .current_dir(&options.working_dir);

        let (mut rx, child) = command
            .spawn()
            .map_err(|error| format!("Failed to spawn native runtime sidecar: {}", error))?;

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
                            if let Err(error) = manager.process_helper_stdout_with_app(
                                Some(&app_handle),
                                &runtime,
                                &text,
                            ) {
                                let _ = manager.append_event(
                                    &runtime,
                                    SessionEventPayload::StdErrLine {
                                        line: format!("Failed to process helper output: {}", error),
                                    },
                                );
                            }
                        }
                    }
                    CommandEvent::Stderr(line) => {
                        for text in drain_helper_output_lines(&mut stderr_buffer, &line) {
                            let _ = manager.append_event(
                                &runtime,
                                SessionEventPayload::StdErrLine { line: text },
                            );
                        }
                    }
                    CommandEvent::Error(error) => {
                        manager.flush_helper_output_buffers(
                            Some(&app_handle),
                            &runtime,
                            &mut stdout_buffer,
                            &mut stderr_buffer,
                        );
                        let _ = manager.append_event(
                            &runtime,
                            SessionEventPayload::StdErrLine {
                                line: format!("Native sidecar error: {}", error),
                            },
                        );
                        let _ = manager.mark_process_exit(&runtime, Some(1), &event_handle);
                        break;
                    }
                    CommandEvent::Terminated(payload) => {
                        manager.flush_helper_output_buffers(
                            Some(&app_handle),
                            &runtime,
                            &mut stdout_buffer,
                            &mut stderr_buffer,
                        );
                        let _ = manager.mark_process_exit(&runtime, payload.code, &event_handle);
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
                    let record = self
                        .records
                        .lock()
                        .map_err(|_| "Failed to lock native runtime records".to_string())?
                        .get(runtime_id)
                        .cloned()
                        .ok_or_else(|| format!("Native runtime {} not found", runtime_id))?;
                    match self.complete_terminal_handoff(record, terminal) {
                        Ok(()) => destroy_browser_session(app, runtime_id),
                        Err(error) => {
                            self.update_record(runtime_id, |record| {
                                record.status = "ready".to_string();
                                record.is_active = true;
                                record.updated_at = Utc::now();
                                record.pending_handoff_terminal = None;
                                record.last_error = Some(error.clone());
                            })?;
                            self.append_event(
                                runtime_id,
                                SessionEventPayload::StdErrLine {
                                    line: format!("Terminal handoff failed: {}", error),
                                },
                            )?;
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
                self.update_record(runtime_id, |record| {
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
                let payload = serde_json::from_value::<SessionEventPayload>(payload)
                    .map_err(|error| format!("Failed to decode helper payload: {}", error))?;
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
        }
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
        if !self.is_current_handle(runtime_id, handle)? {
            return Ok(());
        }

        let expected_terminal = self
            .records
            .lock()
            .map_err(|_| "Failed to lock native runtime records".to_string())?
            .get(runtime_id)
            .map(|record| is_native_terminal_status(&record.status))
            .unwrap_or(false);

        if !expected_terminal {
            let exit_reason = format!(
                "Native runtime sidecar exited unexpectedly{}.",
                exit_code
                    .map(|code| format!(" with code {}", code))
                    .unwrap_or_default()
            );
            self.update_record(runtime_id, |record| {
                record.status = if is_recoverable_native_process_exit(record) {
                    "interrupted"
                } else {
                    "error"
                }
                .to_string();
                record.is_active = false;
                record.updated_at = Utc::now();
                if record.last_error.is_none() {
                    record.last_error = Some(exit_reason.clone());
                }
            })?;
            self.append_event(
                runtime_id,
                SessionEventPayload::SessionCompleted {
                    reason: exit_reason,
                },
            )?;
        }

        self.remove_handle_if_current(runtime_id, handle)
    }

    fn write_to_child(
        &self,
        handle: &Arc<NativeSessionHandle>,
        command: &HelperInputCommand<'_>,
    ) -> Result<(), String> {
        let line = serde_json::to_string(command)
            .map_err(|error| format!("Failed to encode helper command: {}", error))?;
        let mut child_guard = handle
            .child
            .lock()
            .map_err(|_| "Failed to lock native sidecar child".to_string())?;
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
        match self.write_to_child(&handle, command) {
            Ok(()) => Ok(()),
            Err(error) if is_retryable_native_child_write_error(&error) => {
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
                let _ = self.kill_child(runtime_id);
                self.remove_handle(runtime_id)?;
                self.update_record(runtime_id, |record| {
                    record.status = "initializing".to_string();
                    record.is_active = true;
                    record.last_error = None;
                    record.updated_at = Utc::now();
                })?;
                let next_handle = self.ensure_handle(app.clone(), runtime_id)?;
                self.write_to_child(&next_handle, command)
            }
            Err(error) => Err(error),
        }
    }

    fn request_child_stop(
        &self,
        runtime_id: &str,
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

        handle.alive.store(false, Ordering::SeqCst);
        let has_child = handle
            .child
            .lock()
            .map_err(|_| "Failed to lock native sidecar child".to_string())?
            .is_some();
        if !has_child {
            return Ok(None);
        }

        match self.write_to_child(&handle, &HelperInputCommand::Stop) {
            Ok(()) => {
                self.append_lifecycle_event(
                    runtime_id,
                    "stop_written",
                    format!(
                        "Native helper generation {} accepted stop command.",
                        handle.generation
                    ),
                )?;
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

    fn schedule_force_kill(self: &Arc<Self>, runtime_id: String, handle: Arc<NativeSessionHandle>) {
        let manager = Arc::clone(self);
        tauri::async_runtime::spawn_blocking(move || {
            std::thread::sleep(NATIVE_STOP_GRACE_PERIOD);
            let _ = manager.force_kill_stopped_handle(&runtime_id, &handle);
        });
    }

    fn force_kill_stopped_handle(
        &self,
        runtime_id: &str,
        handle: &Arc<NativeSessionHandle>,
    ) -> Result<bool, String> {
        // Lock order is handles -> child. The child is stored as Option<CommandChild>,
        // so take() moves the only manager-owned child handle out before kill().
        let child_to_kill = {
            let mut handles = self
                .handles
                .lock()
                .map_err(|_| "Failed to lock native runtime handles".to_string())?;
            let Some(current) = handles.get(runtime_id) else {
                return Ok(false);
            };
            if !Self::same_handle(current, handle) || handle.alive.load(Ordering::SeqCst) {
                return Ok(false);
            }

            let child_to_kill = handle
                .child
                .lock()
                .map_err(|_| "Failed to lock native sidecar child".to_string())?
                .take();
            let detail = format!(
                "Native helper generation {} did not settle after stop; removed stale helper handle.",
                handle.generation
            );
            let record = handle
                .events
                .lock()
                .map_err(|_| "Failed to lock native session store".to_string())?
                .append(SessionEventPayload::Lifecycle {
                    stage: "stop_force_killed".to_string(),
                    detail,
                });
            if let Err(error) = self.event_log.append(&record) {
                eprintln!(
                    "Failed to persist native event {}:{}: {}",
                    record.runtime_id, record.seq, error
                );
            }
            handles.remove(runtime_id);
            child_to_kill
        };

        if let Some(child) = child_to_kill {
            let _ = child.kill();
        }

        self.update_record(runtime_id, |record| {
            record.status = "interrupted".to_string();
            record.is_active = false;
            record.updated_at = Utc::now();
        })?;
        Ok(true)
    }

    fn append_user_prompt_event(
        &self,
        runtime_id: &str,
        text: &str,
        images: Option<&Vec<PromptImage>>,
    ) -> Result<(), String> {
        let text = text.trim();
        let image_count = images.map(|items| items.len()).unwrap_or(0);
        if text.is_empty() && image_count == 0 {
            return Ok(());
        }
        let event_images = prompt_images_for_event(images, &self.prompt_image_store)?;
        let canonical_hash = canonical_user_prompt_hash(text, event_images.as_ref());

        self.append_event(
            runtime_id,
            SessionEventPayload::UserPrompt {
                text: text.to_string(),
                image_count: image_count as u64,
                images: event_images,
                canonical_hash,
            },
        )
    }

    fn append_interactive_prompt_response_event(
        &self,
        runtime_id: &str,
        display_text: Option<&str>,
        answers: &HashMap<String, String>,
    ) -> Result<(), String> {
        let Some(text) = summarize_interactive_prompt_response(display_text, answers) else {
            return Ok(());
        };
        self.append_user_prompt_event(runtime_id, &text, None)
    }

    fn append_event(&self, runtime_id: &str, payload: SessionEventPayload) -> Result<(), String> {
        let last_error = payload_last_error(&payload);
        let handles = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?;
        let Some(handle) = handles.get(runtime_id) else {
            return Ok(());
        };
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
        if let Some(message) = last_error {
            self.set_last_error(runtime_id, message)?;
        }
        Ok(())
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
        records.insert(record.runtime_id.clone(), record);
        persist_native_runtime_state_to(&self.state_path, records.values().cloned().collect())
    }

    fn insert_handle(
        &self,
        runtime_id: String,
        handle: Arc<NativeSessionHandle>,
    ) -> Result<(), String> {
        self.handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .insert(runtime_id, handle);
        Ok(())
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

    fn mark_handle_live_if_current(
        &self,
        runtime_id: &str,
        handle: &Arc<NativeSessionHandle>,
    ) -> Result<bool, String> {
        let handles = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?;
        let is_current = handles
            .get(runtime_id)
            .map(|current| Self::same_handle(current, handle))
            .unwrap_or(false);
        if is_current {
            handle.alive.store(true, Ordering::SeqCst);
        }
        Ok(is_current)
    }

    fn remove_handle(&self, runtime_id: &str) -> Result<(), String> {
        self.handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .remove(runtime_id);
        Ok(())
    }

    fn remove_handle_if_current(
        &self,
        runtime_id: &str,
        handle: &Arc<NativeSessionHandle>,
    ) -> Result<(), String> {
        let mut handles = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?;
        let is_current = handles
            .get(runtime_id)
            .map(|current| Self::same_handle(current, handle))
            .unwrap_or(false);
        if is_current {
            handles.remove(runtime_id);
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
                let _ = child.kill();
            }
        }
        Ok(())
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
        if let Some(handle) = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(runtime_id)
            .cloned()
        {
            return Ok(handle.summary());
        }

        self.records
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
                status: record.status,
                created_at: record.created_at,
                updated_at: record.updated_at,
                is_active: record.is_active,
                last_event_seq: None,
                can_handoff_to_terminal: record.can_handoff_to_terminal,
                last_error: record.last_error,
            })
            .ok_or_else(|| format!("Native runtime {} not found", runtime_id))
    }

    fn flush_helper_output_buffers(
        &self,
        app: Option<&AppHandle>,
        runtime_id: &str,
        stdout_buffer: &mut Vec<u8>,
        stderr_buffer: &mut Vec<u8>,
    ) {
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
        "stopped" | "error" | "handoff" | "interrupted" | "closed_idle"
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
    use std::time::{SystemTime, UNIX_EPOCH};

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("native-{}", timestamp)
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
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!("Failed to create native runtime state directory: {}", error)
        })?;
    }

    let state = NativeRuntimeState { sessions: records };
    let serialized = serde_json::to_vec_pretty(&state)
        .map_err(|error| format!("Failed to serialize native runtime state: {}", error))?;
    let temp_path = native_runtime_state_temp_file_path(path);
    fs::write(&temp_path, serialized)
        .map_err(|error| format!("Failed to write native runtime state: {}", error))?;
    fs::rename(&temp_path, path)
        .map_err(|error| format!("Failed to finalize native runtime state: {}", error))
}

fn native_runtime_state_temp_file_path(path: &Path) -> PathBuf {
    let counter = NATIVE_RUNTIME_STATE_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("native-runtime-state.json");
    path.with_file_name(format!(
        ".{}.{}.{}.tmp",
        file_name,
        std::process::id(),
        counter
    ))
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
        provider_session_id: record.provider_session_id.clone(),
        seed_boundary_message_count: record.seed_boundary_message_count,
        helper_env_vars,
        terminal_env_vars,
        claude_path: resolve_claude_path(),
        codex_path: resolve_codex_path(),
        codex_base_url,
        codex_api_key,
        effort: record.effort.clone(),
    })
}

fn inject_ccem_runtime_env(env_vars: &mut HashMap<String, String>, runtime_id: &str) {
    env_vars.insert("CCEM_RUNTIME_ID".to_string(), runtime_id.to_string());
    env_vars.insert("CCEM_SESSION_ID".to_string(), runtime_id.to_string());
}

#[cfg(test)]
mod tests {
    use super::{
        authorize_browser_tool_for_record, clear_terminal_launches, drain_helper_output_lines,
        is_retryable_native_child_write_error, merge_helper_env_path,
        merge_path_values_with_separator, native_runtime_state_temp_file_path,
        native_session_allows_dangerously_skip_permissions, native_status_allows_file_rewind,
        reactivate_record_for_reconnect, read_native_runtime_state_from, take_terminal_launches,
        HelperInputCommand, NativeProvider, NativeRuntimeManager, NativeSessionHandle,
        NativeSessionOptions, NativeSessionRecord, NativeTransport, PromptImage,
    };
    use crate::event_bus::{
        SessionEventPayload, SessionStore, TodoSnapshotItemV1, TodoSnapshotV1,
    };
    use crate::native_event_log::NativeEventLog;
    use crate::prompt_image_store::PromptImageStore;
    use chrono::Utc;
    use std::collections::HashMap;
    use std::fs;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Barrier, Mutex};

    fn native_session_handle(record: NativeSessionRecord) -> Arc<NativeSessionHandle> {
        native_session_handle_with_terminal_env(record, HashMap::new())
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
            status: "processing".to_string(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            is_active: true,
            can_handoff_to_terminal: false,
            pending_handoff_terminal: None,
            last_error: None,
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
        }
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
            status: status.to_string(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            is_active,
            can_handoff_to_terminal: false,
            pending_handoff_terminal: None,
            last_error: None,
        }
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
            provider_session_id: None,
            seed_boundary_message_count: None,
            helper_env_vars: HashMap::new(),
            terminal_env_vars: HashMap::new(),
            claude_path: None,
            codex_path: None,
            codex_base_url: None,
            codex_api_key: None,
            effort: None,
        }
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
    fn native_runtime_state_temp_paths_are_unique_per_write() {
        let state_path = std::env::temp_dir().join("ccem-native-runtime-state-test.json");

        let first = native_runtime_state_temp_file_path(&state_path);
        let second = native_runtime_state_temp_file_path(&state_path);

        assert_ne!(first, second);
        assert_eq!(first.parent(), state_path.parent());
        assert_eq!(second.parent(), state_path.parent());
        assert!(first
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.contains("ccem-native-runtime-state-test.json")));
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
        };

        let handoff = manager
            .prepare_terminal_handoff(runtime_id, Some(crate::terminal::TerminalType::TerminalApp))
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

        manager
            .append_user_prompt_event(&runtime_id, "continue", Some(&images))
            .expect("append user prompt event");

        let batch = manager
            .replay_events(&runtime_id, None)
            .expect("replay events");

        assert_eq!(batch.events.len(), 1);
        let SessionEventPayload::UserPrompt {
            text,
            image_count,
            images,
            canonical_hash,
        } = &batch.events[0].payload
        else {
            panic!("expected user prompt event");
        };
        assert_eq!(text, "continue");
        assert_eq!(*image_count, 1);
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

        manager
            .append_interactive_prompt_response_event(
                &runtime_id,
                Some("Use the SQLite path"),
                &answers,
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
            canonical_hash,
        } = &batch.events[0].payload
        else {
            panic!("expected user prompt event");
        };
        assert_eq!(text, "Use the SQLite path");
        assert_eq!(*image_count, 0);
        assert_eq!(images, &None);
        assert_eq!(canonical_hash.as_deref().map(str::len), Some(64));
    }

    #[test]
    fn helper_stop_serializes_shutdown_command() {
        let serialized = serde_json::to_value(HelperInputCommand::Stop).expect("serialize stop");

        assert_eq!(serialized["type"], "stop");
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

    #[cfg(target_os = "macos")]
    #[test]
    fn handoff_without_provider_session_waits_for_session_meta() {
        let runtime_id = "native-fresh-handoff";
        let manager = manager_with_handle(runtime_id);
        clear_terminal_launches();

        manager
            .handoff_to_terminal(runtime_id, Some(crate::terminal::TerminalType::TerminalApp))
            .expect("handoff should enter pending state");

        assert!(take_terminal_launches().is_empty());

        let summary = manager.summary_for(runtime_id).expect("summary");
        assert_eq!(summary.status, "handoff_pending");
        assert!(summary.is_active);
        assert_eq!(summary.provider_session_id, None);
        assert!(manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .is_some());
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
    fn mark_handle_live_rejects_stale_generation() {
        let runtime_id = "native-stale-handle-live-mark";
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
        replacement_handle.alive.store(false, Ordering::SeqCst);
        manager
            .insert_handle(runtime_id.to_string(), replacement_handle.clone())
            .expect("insert replacement handle");

        assert!(!manager
            .mark_handle_live_if_current(runtime_id, &stale_handle)
            .expect("stale live mark"));
        assert!(!stale_handle.alive.load(Ordering::SeqCst));

        assert!(manager
            .mark_handle_live_if_current(runtime_id, &replacement_handle)
            .expect("replacement live mark"));
        assert!(replacement_handle.alive.load(Ordering::SeqCst));
        assert!(manager
            .is_current_handle(runtime_id, &replacement_handle)
            .expect("current handle check"));
    }

    #[test]
    fn mark_handle_live_and_force_kill_race_has_only_safe_outcomes() {
        let runtime_id = "native-live-force-kill-race";
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

        let mark_manager = Arc::clone(&manager);
        let mark_barrier = Arc::clone(&barrier);
        let mark_handle = Arc::clone(&handle);
        let mark_runtime_id = runtime_id.to_string();
        let mark_thread = std::thread::spawn(move || {
            mark_barrier.wait();
            mark_manager
                .mark_handle_live_if_current(&mark_runtime_id, &mark_handle)
                .expect("mark handle live")
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
        let marked_live = mark_thread.join().expect("mark thread");
        let force_killed = kill_thread.join().expect("kill thread");

        assert_ne!(
            marked_live, force_killed,
            "exactly one race participant should win the stopped handle"
        );

        if marked_live {
            assert!(handle.alive.load(Ordering::SeqCst));
            assert!(manager
                .is_current_handle(runtime_id, &handle)
                .expect("current handle check"));
            let summary = manager.summary_for(runtime_id).expect("summary");
            assert_eq!(summary.status, "processing");
            assert!(summary.is_active);
        } else {
            assert!(force_killed);
            assert!(!manager
                .is_current_handle(runtime_id, &handle)
                .expect("current handle check"));
            let summary = manager.summary_for(runtime_id).expect("summary");
            assert_eq!(summary.status, "interrupted");
            assert!(!summary.is_active);
        }
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
