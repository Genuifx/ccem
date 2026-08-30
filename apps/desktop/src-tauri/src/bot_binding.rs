use crate::channel::{ChannelKind, InteractiveOutputChunk, OutputChannel};
use crate::config::EnvironmentMutationCoordinator;
use crate::event_bus::SessionEventRecord;
use crate::native_runtime::NativeRuntimeManager;
use crate::remote::RemotePlatform;
use crate::unified_runtime::UnifiedSessionManager;
use crate::unified_session::RuntimeInput;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager};

mod formatting;
mod storage;
use self::formatting::{
    format_inbound_prompt, format_task_card, summarize_session_event, truncate_text,
};
pub use storage::bot_binding_request_path;

const REQUEST_WATCH_INTERVAL_MS: u64 = 1500;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BindSessionToBotRequest {
    pub runtime_id: String,
    pub platform: RemotePlatform,
    pub peer_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_summary: Option<String>,
    #[serde(default = "default_true", skip_serializing_if = "is_false")]
    pub send_task_card: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BotBindingFileRequest {
    pub request_id: String,
    #[serde(flatten)]
    pub bind: BindSessionToBotRequest,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BotBindingDeliveryStatus {
    BoundOnly,
    Pending,
    Delivered,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BotBindingInfo {
    pub binding_id: String,
    pub runtime_id: String,
    pub task_id: String,
    pub platform: RemotePlatform,
    pub peer_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_id: Option<String>,
    pub task_title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_label: Option<String>,
    #[serde(default = "default_true", skip_serializing_if = "is_false")]
    pub send_task_card: bool,
    pub correlation_marker: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_card_message_id: Option<String>,
    #[serde(default = "default_delivery_status")]
    pub delivery_status: BotBindingDeliveryStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_delivery_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivered_at: Option<DateTime<Utc>>,
    pub connected_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BotBindingOutboxFrameKind {
    TaskCard,
    EventUpdate,
    InteractiveOutput,
    InboundCommand,
    PermissionPrompt,
    SessionCompleted,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BotBindingOutboxFrame {
    pub frame_id: String,
    pub binding_id: String,
    pub runtime_id: String,
    pub task_id: String,
    pub kind: BotBindingOutboxFrameKind,
    pub title: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quoted_task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correlation_marker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery_message_id: Option<String>,
    pub occurred_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BotBindingInboundRequest {
    pub binding_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_message_id: Option<String>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quoted_task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub responder: Option<String>,
}

pub struct BotBindingManager {
    bindings: Mutex<HashMap<String, BotBindingInfo>>,
    outbox: Mutex<Vec<BotBindingOutboxFrame>>,
    processed_file_requests: Mutex<HashSet<String>>,
    native_relay_bindings: Mutex<HashSet<String>>,
    storage_path: Option<PathBuf>,
}

impl Default for BotBindingManager {
    fn default() -> Self {
        Self::with_bindings(None, HashMap::new())
    }
}

impl BotBindingManager {
    pub fn load_from_disk() -> Self {
        let path = storage::bot_binding_state_path();
        let bindings = match storage::load_bindings(&path) {
            Ok(bindings) => bindings,
            Err(error) => {
                eprintln!("Bot binding restore warning: {}", error);
                HashMap::new()
            }
        };
        Self::with_bindings(Some(path), bindings)
    }

    #[cfg(test)]
    pub(crate) fn with_storage_path_for_test(path: PathBuf) -> Self {
        let bindings = storage::load_bindings(&path).unwrap_or_default();
        Self::with_bindings(Some(path), bindings)
    }

    fn with_bindings(
        storage_path: Option<PathBuf>,
        bindings: HashMap<String, BotBindingInfo>,
    ) -> Self {
        Self {
            bindings: Mutex::new(bindings),
            outbox: Mutex::new(Vec::new()),
            processed_file_requests: Mutex::new(HashSet::new()),
            native_relay_bindings: Mutex::new(HashSet::new()),
            storage_path,
        }
    }

    pub fn bind_session(
        self: &Arc<Self>,
        app: &AppHandle,
        unified: &UnifiedSessionManager,
        request: BindSessionToBotRequest,
    ) -> Result<BotBindingInfo, String> {
        let runtime_id = request.runtime_id.trim().to_string();
        if runtime_id.is_empty() {
            return Err("runtime_id is required".to_string());
        }
        if request.peer_id.trim().is_empty() {
            return Err("peer_id is required".to_string());
        }
        if !unified.contains_session(&runtime_id) {
            return Err(format!("Unified session not found: {}", runtime_id));
        }

        let project_label = unified_project_label(unified, &runtime_id);
        let (info, created) = self.ensure_binding_record(request, &runtime_id, project_label)?;

        let channel = BotBindingChannel::new(self.clone(), info.clone());
        unified.attach_output_channel(&runtime_id, Arc::new(channel))?;

        if created {
            self.append_frame(
                &info,
                BotBindingOutboxFrameKind::TaskCard,
                "Task bound to bot",
                format_task_card(&info),
                None,
            )?;
        }

        if let Ok(replay) = unified.get_session_events(app, &runtime_id, None) {
            let replay_channel = BotBindingChannel::new(self.clone(), info.clone());
            for event in replay.events {
                let _ = replay_channel.send_event(&event);
            }
        }

        Ok(info)
    }

    pub fn bind_any_session(
        self: &Arc<Self>,
        app: &AppHandle,
        unified: &UnifiedSessionManager,
        native: Arc<NativeRuntimeManager>,
        request: BindSessionToBotRequest,
    ) -> Result<BotBindingInfo, String> {
        if unified.contains_session(request.runtime_id.trim()) {
            return self.bind_session(app, unified, request);
        }
        self.bind_native_session(native, request)
    }

    pub fn bind_native_session(
        self: &Arc<Self>,
        native: Arc<NativeRuntimeManager>,
        request: BindSessionToBotRequest,
    ) -> Result<BotBindingInfo, String> {
        let runtime_id = request.runtime_id.trim().to_string();
        if runtime_id.is_empty() {
            return Err("runtime_id is required".to_string());
        }
        if request.peer_id.trim().is_empty() {
            return Err("peer_id is required".to_string());
        }
        native.replay_events(&runtime_id, None)?;

        let project_label = native_project_label(&native, &runtime_id);
        let (info, created) = self.ensure_binding_record(request, &runtime_id, project_label)?;

        if created {
            self.append_frame(
                &info,
                BotBindingOutboxFrameKind::TaskCard,
                "Task bound to bot",
                format_task_card(&info),
                None,
            )?;
        }
        self.start_native_relay(native, info.clone());

        Ok(info)
    }

    pub fn list_bindings(&self, runtime_id: Option<String>) -> Vec<BotBindingInfo> {
        let Ok(bindings) = self.bindings.lock() else {
            return Vec::new();
        };
        let mut items = bindings
            .values()
            .filter(|binding| {
                runtime_id
                    .as_deref()
                    .is_none_or(|runtime| binding.runtime_id == runtime)
            })
            .cloned()
            .collect::<Vec<_>>();
        items.sort_by_key(|binding| binding.connected_at);
        items
    }

    pub fn outbox(&self, binding_id: Option<String>) -> Vec<BotBindingOutboxFrame> {
        let Ok(outbox) = self.outbox.lock() else {
            return Vec::new();
        };
        outbox
            .iter()
            .filter(|frame| {
                binding_id
                    .as_deref()
                    .is_none_or(|candidate| frame.binding_id == candidate)
            })
            .cloned()
            .collect()
    }

    pub(crate) fn find_binding_for_route(
        &self,
        platform: RemotePlatform,
        bot_id: Option<&str>,
        peer_id: &str,
        quoted_task_id: Option<&str>,
        correlation_marker: Option<&str>,
    ) -> Option<BotBindingInfo> {
        let peer_id = peer_id.trim();
        if peer_id.is_empty() {
            return None;
        }

        let quoted_task_id = normalize_optional_str(quoted_task_id);
        let correlation_marker = normalize_optional_str(correlation_marker);
        if quoted_task_id.is_none() && correlation_marker.is_none() {
            return None;
        }

        let bot_id = normalize_optional_str(bot_id);
        self.bindings
            .lock()
            .ok()?
            .values()
            .find(|binding| {
                binding_target_matches(binding, platform, bot_id.as_deref(), peer_id)
                    && route_marker_matches(
                        binding,
                        quoted_task_id.as_deref(),
                        correlation_marker.as_deref(),
                    )
            })
            .cloned()
    }

    pub(crate) fn find_bindings_for_target(
        &self,
        platform: RemotePlatform,
        bot_id: Option<&str>,
        peer_id: &str,
    ) -> Vec<BotBindingInfo> {
        let peer_id = peer_id.trim();
        if peer_id.is_empty() {
            return Vec::new();
        }

        let bot_id = normalize_optional_str(bot_id);
        let Ok(bindings) = self.bindings.lock() else {
            return Vec::new();
        };
        let mut items = bindings
            .values()
            .filter(|binding| binding_target_matches(binding, platform, bot_id.as_deref(), peer_id))
            .cloned()
            .collect::<Vec<_>>();
        items.sort_by_key(|binding| binding.connected_at);
        items
    }

    pub(crate) fn mark_task_card_delivery_pending(
        &self,
        binding_id: &str,
    ) -> Result<BotBindingInfo, String> {
        self.update_delivery_state(
            binding_id,
            BotBindingDeliveryStatus::Pending,
            None,
            None,
            false,
        )
    }

    pub(crate) fn mark_task_card_delivered(
        &self,
        binding_id: &str,
        message_id: impl Into<String>,
    ) -> Result<BotBindingInfo, String> {
        self.update_delivery_state(
            binding_id,
            BotBindingDeliveryStatus::Delivered,
            Some(message_id.into()),
            None,
            true,
        )
    }

    pub(crate) fn mark_task_card_delivery_failed(
        &self,
        binding_id: &str,
        error: impl Into<String>,
    ) -> Result<BotBindingInfo, String> {
        self.update_delivery_state(
            binding_id,
            BotBindingDeliveryStatus::Failed,
            None,
            Some(error.into()),
            false,
        )
    }

    pub fn send_inbound_command(
        &self,
        app: &AppHandle,
        unified: &UnifiedSessionManager,
        native: Arc<NativeRuntimeManager>,
        request: BotBindingInboundRequest,
    ) -> Result<(), String> {
        let info = self
            .get_binding(&request.binding_id)
            .ok_or_else(|| format!("Bot binding not found: {}", request.binding_id))?;
        let text = request.text.trim();
        if text.is_empty() {
            return Err("text is required".to_string());
        }

        self.append_frame(
            &info,
            BotBindingOutboxFrameKind::InboundCommand,
            "Inbound bot command",
            text,
            request.quoted_task_id.clone(),
        )?;

        let routed_text = format_inbound_prompt(&info, text, request.quoted_task_id.as_deref());
        if unified.contains_session(&info.runtime_id) {
            return unified.send_input(
                app,
                &info.runtime_id,
                RuntimeInput::Message { text: routed_text },
            );
        }

        // Sending can lazily reconnect a persisted native session. Join the
        // process-wide environment mutation barrier so reconnect cannot race a
        // delete after its reference scan.
        let environment_mutations = app
            .try_state::<Arc<EnvironmentMutationCoordinator>>()
            .ok_or_else(|| "Environment mutation coordinator is unavailable".to_string())?;
        let _mutation_guard = environment_mutations.lock()?;
        native.send_user_message(
            app,
            &info.runtime_id,
            &routed_text,
            Some(&routed_text),
            None,
            None,
            request.client_message_id.as_deref(),
        )
    }

    pub fn process_file_requests(
        self: &Arc<Self>,
        app: &AppHandle,
        unified: &UnifiedSessionManager,
        native: Arc<NativeRuntimeManager>,
    ) -> Result<Vec<BotBindingInfo>, String> {
        let path = bot_binding_request_path();
        if !path.exists() {
            return Ok(Vec::new());
        }

        let file = fs::File::open(&path)
            .map_err(|error| format!("Failed to open {}: {}", path.display(), error))?;
        let reader = BufReader::new(file);
        let mut created = Vec::new();
        for line in reader.lines() {
            let line = line.map_err(|error| format!("Failed to read request line: {}", error))?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let request: BotBindingFileRequest = serde_json::from_str(trimmed)
                .map_err(|error| format!("Failed to parse bot binding request: {}", error))?;

            let already_processed = self
                .processed_file_requests
                .lock()
                .map_err(|_| "Failed to lock processed bot binding requests".to_string())?
                .contains(&request.request_id);
            if already_processed {
                continue;
            }

            match self.bind_any_session(app, unified, native.clone(), request.bind) {
                Ok(info) => {
                    self.processed_file_requests
                        .lock()
                        .map_err(|_| "Failed to lock processed bot binding requests".to_string())?
                        .insert(request.request_id);
                    created.push(info);
                }
                Err(error) => {
                    eprintln!(
                        "Bot binding request {} failed: {}",
                        request.request_id, error
                    );
                }
            }
        }

        Ok(created)
    }

    pub fn start_request_watcher(
        self: &Arc<Self>,
        app: AppHandle,
        unified: Arc<UnifiedSessionManager>,
        native: Arc<NativeRuntimeManager>,
        mut on_bindings: impl FnMut(Vec<BotBindingInfo>) + Send + 'static,
    ) {
        let manager = self.clone();
        thread::spawn(move || loop {
            if let Ok(infos) = manager.process_file_requests(&app, &unified, native.clone()) {
                if !infos.is_empty() {
                    on_bindings(infos);
                }
            }
            thread::sleep(Duration::from_millis(REQUEST_WATCH_INTERVAL_MS));
        });
    }

    fn get_binding(&self, binding_id: &str) -> Option<BotBindingInfo> {
        self.bindings.lock().ok()?.get(binding_id).cloned()
    }

    fn append_frame(
        &self,
        info: &BotBindingInfo,
        kind: BotBindingOutboxFrameKind,
        title: impl Into<String>,
        text: impl Into<String>,
        quoted_task_id: Option<String>,
    ) -> Result<(), String> {
        let mut outbox = self
            .outbox
            .lock()
            .map_err(|_| "Failed to lock bot binding outbox".to_string())?;
        let now = Utc::now();
        let frame_id = format!("bot-frame-{}-{}", now.timestamp_millis(), outbox.len() + 1);
        outbox.push(BotBindingOutboxFrame {
            frame_id,
            binding_id: info.binding_id.clone(),
            runtime_id: info.runtime_id.clone(),
            task_id: info.task_id.clone(),
            kind,
            title: title.into(),
            text: text.into(),
            quoted_task_id,
            correlation_marker: Some(info.correlation_marker.clone()),
            delivery_message_id: info.task_card_message_id.clone(),
            occurred_at: now,
        });
        Ok(())
    }

    fn update_delivery_state(
        &self,
        binding_id: &str,
        status: BotBindingDeliveryStatus,
        message_id: Option<String>,
        error: Option<String>,
        delivered: bool,
    ) -> Result<BotBindingInfo, String> {
        let mut bindings = self
            .bindings
            .lock()
            .map_err(|_| "Failed to lock bot bindings".to_string())?;
        let binding = bindings
            .get_mut(binding_id)
            .ok_or_else(|| format!("Bot binding not found: {}", binding_id))?;

        binding.delivery_status = status;
        if let Some(message_id) = normalize_optional(message_id) {
            binding.task_card_message_id = Some(message_id);
        }
        binding.last_delivery_error = normalize_optional(error);
        binding.delivered_at = delivered.then(Utc::now);
        let updated = binding.clone();

        self.persist_bindings(&bindings)?;
        Ok(updated)
    }

    fn ensure_binding_record(
        &self,
        request: BindSessionToBotRequest,
        runtime_id: &str,
        project_label: Option<String>,
    ) -> Result<(BotBindingInfo, bool), String> {
        let mut request = request;
        request.runtime_id = runtime_id.to_string();
        request.peer_id = request.peer_id.trim().to_string();
        if request.peer_id.is_empty() {
            return Err("peer_id is required".to_string());
        }
        request.thread_id = normalize_optional(request.thread_id);
        request.bot_id = normalize_optional(request.bot_id);
        if request.platform == RemotePlatform::Wecom && request.bot_id.is_none() {
            return Err("bot_id is required for WeCom bot bindings".to_string());
        }
        let binding_id = stable_binding_id(&request);
        if let Some(existing) = self.get_binding(&binding_id) {
            return Ok((existing, false));
        }
        let task_id = format!("ccem-task-{}", runtime_slug(runtime_id));

        let info = BotBindingInfo {
            binding_id: binding_id.clone(),
            runtime_id: runtime_id.to_string(),
            task_id: task_id.clone(),
            platform: request.platform,
            peer_id: request.peer_id.trim().to_string(),
            thread_id: request.thread_id,
            bot_id: request.bot_id,
            task_title: normalize_optional(request.task_title)
                .unwrap_or_else(|| format!("CCEM session {}", short_runtime_id(runtime_id))),
            task_summary: normalize_optional(request.task_summary),
            project_label: normalize_optional(project_label),
            send_task_card: request.send_task_card,
            correlation_marker: build_correlation_marker(&binding_id, &task_id),
            task_card_message_id: None,
            delivery_status: BotBindingDeliveryStatus::BoundOnly,
            last_delivery_error: None,
            delivered_at: None,
            connected_at: Utc::now(),
        };

        let mut bindings = self
            .bindings
            .lock()
            .map_err(|_| "Failed to lock bot bindings".to_string())?;
        bindings.insert(binding_id.clone(), info.clone());
        if let Err(error) = self.persist_bindings(&bindings) {
            bindings.remove(&binding_id);
            return Err(error);
        }
        Ok((info, true))
    }

    fn persist_bindings(&self, bindings: &HashMap<String, BotBindingInfo>) -> Result<(), String> {
        let Some(path) = self.storage_path.as_ref() else {
            return Ok(());
        };
        storage::save_bindings(path, bindings)
    }

    fn start_native_relay(
        self: &Arc<Self>,
        native: Arc<NativeRuntimeManager>,
        info: BotBindingInfo,
    ) {
        if !self.claim_native_relay(&info.binding_id) {
            return;
        }

        let manager = self.clone();
        thread::spawn(move || {
            let channel = BotBindingChannel::new(manager.clone(), info.clone());
            let mut since_seq = None;
            loop {
                if manager.get_binding(&info.binding_id).is_none() {
                    break;
                }
                match native.replay_events(&info.runtime_id, since_seq) {
                    Ok(replay) => {
                        for event in replay.events {
                            since_seq = Some(event.seq);
                            let _ = channel.send_event(&event);
                        }
                    }
                    Err(error) => {
                        let _ = manager.append_frame(
                            &info,
                            BotBindingOutboxFrameKind::Error,
                            "Native relay error",
                            truncate_text(&error, 1200),
                            None,
                        );
                        break;
                    }
                }
                thread::sleep(Duration::from_millis(REQUEST_WATCH_INTERVAL_MS));
            }
            manager.release_native_relay(&info.binding_id);
        });
    }

    fn claim_native_relay(&self, binding_id: &str) -> bool {
        self.native_relay_bindings
            .lock()
            .map(|mut active| active.insert(binding_id.to_string()))
            .unwrap_or(false)
    }

    fn release_native_relay(&self, binding_id: &str) {
        if let Ok(mut active) = self.native_relay_bindings.lock() {
            active.remove(binding_id);
        }
    }
}

struct BotBindingChannelState {
    last_event_seq: u64,
    last_output_seq: u64,
}

struct BotBindingChannel {
    manager: Arc<BotBindingManager>,
    info: BotBindingInfo,
    state: Mutex<BotBindingChannelState>,
}

impl BotBindingChannel {
    fn new(manager: Arc<BotBindingManager>, info: BotBindingInfo) -> Self {
        Self {
            manager,
            info,
            state: Mutex::new(BotBindingChannelState {
                last_event_seq: 0,
                last_output_seq: 0,
            }),
        }
    }
}

impl OutputChannel for BotBindingChannel {
    fn channel_kind(&self) -> ChannelKind {
        ChannelKind::BotBinding {
            binding_id: self.info.binding_id.clone(),
            platform: self.info.platform,
            peer_id: self.info.peer_id.clone(),
            thread_id: self.info.thread_id.clone(),
            bot_id: self.info.bot_id.clone(),
        }
    }

    fn connected_at(&self) -> DateTime<Utc> {
        self.info.connected_at
    }

    fn label(&self) -> Option<String> {
        Some(format!(
            "{} bot binding · {}",
            self.info.platform.display_name(),
            self.info.peer_id
        ))
    }

    fn send_event(&self, event: &SessionEventRecord) -> Result<(), String> {
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Failed to lock bot binding channel state".to_string())?;
            if event.seq <= state.last_event_seq {
                return Ok(());
            }
            state.last_event_seq = event.seq;
        }

        if let Some(summary) = summarize_session_event(event) {
            self.manager.append_frame(
                &self.info,
                summary.kind,
                summary.title,
                summary.text,
                None,
            )?;
        }
        Ok(())
    }

    fn send_interactive_output(&self, chunk: &InteractiveOutputChunk) -> Result<(), String> {
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Failed to lock bot binding channel state".to_string())?;
            if chunk.seq <= state.last_output_seq {
                return Ok(());
            }
            state.last_output_seq = chunk.seq;
        }

        let text = chunk.data.trim();
        if text.is_empty() {
            return Ok(());
        }

        self.manager.append_frame(
            &self.info,
            BotBindingOutboxFrameKind::InteractiveOutput,
            "Terminal output",
            truncate_text(text, 1600),
            None,
        )
    }

    fn is_connected(&self) -> bool {
        self.manager.get_binding(&self.info.binding_id).is_some()
    }
}

fn binding_target_matches(
    binding: &BotBindingInfo,
    platform: RemotePlatform,
    bot_id: Option<&str>,
    peer_id: &str,
) -> bool {
    if binding.platform != platform || !peer_id_matches(&binding.peer_id, peer_id) {
        return false;
    }

    match (platform, bot_id, binding.bot_id.as_deref()) {
        (RemotePlatform::Wecom, Some(expected), Some(actual)) => expected == actual,
        (RemotePlatform::Wecom, Some(_), None) => false,
        (RemotePlatform::Wecom, None, _) => true,
        (_, Some(expected), Some(actual)) => expected == actual,
        (_, Some(_), None) => false,
        (_, None, _) => true,
    }
}

fn peer_id_matches(left: &str, right: &str) -> bool {
    let left = left.trim();
    let right = right.trim();
    left == right || strip_peer_scope(left) == strip_peer_scope(right)
}

fn strip_peer_scope(peer_id: &str) -> &str {
    peer_id
        .strip_prefix("single:")
        .or_else(|| peer_id.strip_prefix("group:"))
        .unwrap_or(peer_id)
}

fn route_marker_matches(
    binding: &BotBindingInfo,
    quoted_task_id: Option<&str>,
    correlation_marker: Option<&str>,
) -> bool {
    let route_id = bot_binding_route_id(binding);
    quoted_task_id.is_some_and(|quoted| {
        quoted == binding.task_id.as_str() || route_token_matches(quoted, &route_id)
    }) || correlation_marker.is_some_and(|marker| {
        marker == binding.correlation_marker.as_str()
            || route_token_matches(marker, &route_id)
            || binding
                .task_card_message_id
                .as_deref()
                .is_some_and(|message_id| marker == message_id)
    })
}

pub(crate) fn bot_binding_route_id(binding: &BotBindingInfo) -> String {
    route_id_from_parts(&binding.binding_id, &binding.task_id)
}

pub(crate) fn route_id_from_parts(binding_id: &str, task_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(binding_id.as_bytes());
    hasher.update(b":");
    hasher.update(task_id.as_bytes());
    let digest = hasher.finalize();
    hex::encode_upper(&digest[..4])
}

fn route_token_matches(candidate: &str, route_id: &str) -> bool {
    candidate
        .trim()
        .trim_start_matches('#')
        .strip_prefix("ccem:")
        .unwrap_or_else(|| candidate.trim().trim_start_matches('#'))
        .eq_ignore_ascii_case(route_id)
}

fn stable_binding_id(request: &BindSessionToBotRequest) -> String {
    let thread = request
        .bot_id
        .as_deref()
        .or(request.thread_id.as_deref())
        .unwrap_or("direct");
    format!(
        "botbind-{}-{}-{}-{}",
        runtime_slug(&request.runtime_id),
        request.platform.display_name().to_ascii_lowercase(),
        sanitize_id(&request.peer_id),
        sanitize_id(thread)
    )
}

fn unified_project_label(unified: &UnifiedSessionManager, runtime_id: &str) -> Option<String> {
    unified
        .list_sessions()
        .into_iter()
        .find(|session| session.id == runtime_id)
        .and_then(|session| compact_project_label(&session.project_dir))
}

fn native_project_label(native: &NativeRuntimeManager, runtime_id: &str) -> Option<String> {
    native
        .list_sessions()
        .into_iter()
        .find(|session| session.runtime_id == runtime_id)
        .and_then(|session| compact_project_label(&session.project_dir))
}

fn compact_project_label(project_dir: &str) -> Option<String> {
    let trimmed = project_dir.trim();
    if trimmed.is_empty() {
        return None;
    }
    Path::new(trimmed)
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .or_else(|| Some(trimmed.to_string()))
}

fn runtime_slug(runtime_id: &str) -> String {
    sanitize_id(runtime_id)
}

fn short_runtime_id(runtime_id: &str) -> String {
    runtime_id.chars().take(12).collect()
}

fn sanitize_id(value: &str) -> String {
    value
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

fn build_correlation_marker(binding_id: &str, task_id: &str) -> String {
    format!("ccem-bot-binding:{binding_id}:{task_id}")
}

fn normalize_optional(value: Option<String>) -> Option<String> {
    value.and_then(|candidate| {
        let trimmed = candidate.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

fn normalize_optional_str(value: Option<&str>) -> Option<String> {
    value.and_then(|candidate| {
        let trimmed = candidate.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

fn default_delivery_status() -> BotBindingDeliveryStatus {
    BotBindingDeliveryStatus::BoundOnly
}

fn default_true() -> bool {
    true
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[cfg(test)]
mod tests;
