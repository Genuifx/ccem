use crate::channel::{ChannelKind, DesktopChannel, OutputChannel};
use crate::event_bus::ReplayBatch;
use crate::event_dispatcher::EventDispatcher;
use crate::interactive_runtime::InteractiveRuntimeManager;
use crate::runtime::{
    HeadlessRuntimeManager, HeadlessSessionOptions, ManagedSessionSource, RuntimeKind,
};
use crate::tmux::ClaudeTerminalState;
use crate::unified_session::{RuntimeInput, UnifiedSessionDebugComparison, UnifiedSessionInfo};
use chrono::{DateTime, Utc};
use std::sync::Arc;
use tauri::AppHandle;

pub trait RuntimeBackend: Send + Sync {
    fn runtime_kind(&self) -> RuntimeKind;
    fn is_alive(&self) -> bool;
    fn stop(&self) -> Result<(), String>;
    fn send_input(&self, input: RuntimeInput) -> Result<(), String>;
    fn replay_events(&self, since_seq: Option<u64>) -> Result<ReplayBatch, String>;
    fn session_info(&self) -> UnifiedSessionInfo;
}

struct HeadlessBackend {
    app: AppHandle,
    runtime_id: String,
    runtime_manager: Arc<HeadlessRuntimeManager>,
    dispatcher: Arc<EventDispatcher>,
}

impl RuntimeBackend for HeadlessBackend {
    fn runtime_kind(&self) -> RuntimeKind {
        RuntimeKind::Headless
    }

    fn is_alive(&self) -> bool {
        self.runtime_manager
            .summary(&self.runtime_id)
            .is_some_and(|summary| summary.is_active)
    }

    fn stop(&self) -> Result<(), String> {
        self.runtime_manager
            .stop_session(&self.app, &self.runtime_id)
    }

    fn send_input(&self, input: RuntimeInput) -> Result<(), String> {
        match input {
            RuntimeInput::Message { text } => {
                self.runtime_manager
                    .send_user_message(&self.app, &self.runtime_id, &text)
            }
            RuntimeInput::Approval {
                approved,
                responder,
            } => self.runtime_manager.respond_to_permission_for_runtime(
                &self.app,
                &self.runtime_id,
                approved,
                responder.as_deref().unwrap_or("unified"),
            ),
            RuntimeInput::RawTerminal { .. } => {
                Err("Headless runtime does not support raw terminal input".to_string())
            }
        }
    }

    fn replay_events(&self, since_seq: Option<u64>) -> Result<ReplayBatch, String> {
        self.runtime_manager
            .replay_events(&self.runtime_id, since_seq)
    }

    fn session_info(&self) -> UnifiedSessionInfo {
        let summary = self
            .runtime_manager
            .summary(&self.runtime_id)
            .unwrap_or_else(|| unreachable!("headless backend resolved from missing session"));
        UnifiedSessionInfo {
            id: summary.runtime_id,
            runtime_kind: RuntimeKind::Headless,
            source: summary.source,
            status: summary.status,
            project_dir: summary.project_dir,
            env_name: summary.env_name,
            perm_mode: summary.perm_mode,
            created_at: summary.created_at,
            is_active: summary.is_active,
            pid: summary.pid,
            claude_session_id: summary.claude_session_id,
            tmux_target: None,
            client: Some("claude".to_string()),
            channels: self.dispatcher.list_channels(&self.runtime_id),
        }
    }
}

struct TmuxBackend {
    runtime_id: String,
    interactive_runtime_manager: Arc<InteractiveRuntimeManager>,
    dispatcher: Arc<EventDispatcher>,
}

impl RuntimeBackend for TmuxBackend {
    fn runtime_kind(&self) -> RuntimeKind {
        RuntimeKind::Interactive
    }

    fn is_alive(&self) -> bool {
        self.interactive_runtime_manager
            .summary(&self.runtime_id)
            .is_some_and(|summary| summary.is_active)
    }

    fn stop(&self) -> Result<(), String> {
        self.interactive_runtime_manager
            .stop_session(&self.runtime_id)
    }

    fn send_input(&self, input: RuntimeInput) -> Result<(), String> {
        match input {
            RuntimeInput::Message { text } => self
                .interactive_runtime_manager
                .send_message(&self.runtime_id, &text),
            RuntimeInput::Approval { approved, .. } => self
                .interactive_runtime_manager
                .send_approval(&self.runtime_id, approved),
            RuntimeInput::RawTerminal { data } => self
                .interactive_runtime_manager
                .write_input(&self.runtime_id, &data),
        }
    }

    fn replay_events(&self, since_seq: Option<u64>) -> Result<ReplayBatch, String> {
        self.interactive_runtime_manager
            .replay_events(&self.runtime_id, since_seq)
    }

    fn session_info(&self) -> UnifiedSessionInfo {
        let session = self
            .interactive_runtime_manager
            .list_sessions()
            .into_iter()
            .find(|session| session.id == self.runtime_id)
            .unwrap_or_else(|| unreachable!("interactive backend resolved from missing session"));
        let summary = self
            .interactive_runtime_manager
            .summary(&self.runtime_id)
            .unwrap_or_else(|| unreachable!("interactive backend resolved from missing summary"));
        UnifiedSessionInfo {
            id: session.id.clone(),
            runtime_kind: RuntimeKind::Interactive,
            source: ManagedSessionSource::Desktop,
            status: normalize_interactive_status(
                &summary.status,
                &summary.terminal_state,
                summary.is_active,
            ),
            project_dir: session.working_dir.clone(),
            env_name: session.env_name.clone(),
            perm_mode: session.perm_mode.clone(),
            created_at: parse_rfc3339_or_now(&session.start_time),
            is_active: summary.is_active,
            pid: session.pid,
            claude_session_id: summary.claude_session_id,
            tmux_target: session.resolved_tmux_target().map(str::to_string),
            client: Some(session.client.clone()),
            channels: self.dispatcher.list_channels(&self.runtime_id),
        }
    }
}

pub struct UnifiedSessionManager {
    headless_runtime_manager: Arc<HeadlessRuntimeManager>,
    interactive_runtime_manager: Arc<InteractiveRuntimeManager>,
    dispatcher: Arc<EventDispatcher>,
}

impl UnifiedSessionManager {
    pub fn new(
        headless_runtime_manager: Arc<HeadlessRuntimeManager>,
        interactive_runtime_manager: Arc<InteractiveRuntimeManager>,
        dispatcher: Arc<EventDispatcher>,
    ) -> Self {
        Self {
            headless_runtime_manager,
            interactive_runtime_manager,
            dispatcher,
        }
    }

    pub fn create_headless_session(
        &self,
        app: AppHandle,
        options: HeadlessSessionOptions,
    ) -> Result<UnifiedSessionInfo, String> {
        let summary = self
            .headless_runtime_manager
            .create_session(app.clone(), options)?;
        self.resolve_backend(&app, &summary.runtime_id)
            .map(|backend| backend.session_info())
            .ok_or_else(|| {
                format!(
                    "Unified session {} disappeared after startup",
                    summary.runtime_id
                )
            })
    }

    pub fn list_sessions(&self) -> Vec<UnifiedSessionInfo> {
        let mut sessions = self
            .headless_runtime_manager
            .list_sessions()
            .into_iter()
            .map(|summary| UnifiedSessionInfo {
                id: summary.runtime_id.clone(),
                runtime_kind: RuntimeKind::Headless,
                source: summary.source,
                status: summary.status,
                project_dir: summary.project_dir,
                env_name: summary.env_name,
                perm_mode: summary.perm_mode,
                created_at: summary.created_at,
                is_active: summary.is_active,
                pid: summary.pid,
                claude_session_id: summary.claude_session_id,
                tmux_target: None,
                client: Some("claude".to_string()),
                channels: self.dispatcher.list_channels(&summary.runtime_id),
            })
            .chain(
                self.interactive_runtime_manager
                    .list_sessions()
                    .into_iter()
                    .map(|session| {
                        let summary = self
                            .interactive_runtime_manager
                            .summary(&session.id)
                            .unwrap_or_else(|| unreachable!("interactive summary disappeared"));
                        UnifiedSessionInfo {
                            id: session.id.clone(),
                            runtime_kind: RuntimeKind::Interactive,
                            source: ManagedSessionSource::Desktop,
                            status: normalize_interactive_status(
                                &summary.status,
                                &summary.terminal_state,
                                summary.is_active,
                            ),
                            project_dir: session.working_dir.clone(),
                            env_name: session.env_name.clone(),
                            perm_mode: session.perm_mode.clone(),
                            created_at: parse_rfc3339_or_now(&session.start_time),
                            is_active: summary.is_active,
                            pid: session.pid,
                            claude_session_id: summary.claude_session_id,
                            tmux_target: session.resolved_tmux_target().map(str::to_string),
                            client: Some(session.client.clone()),
                            channels: self.dispatcher.list_channels(&session.id),
                        }
                    }),
            )
            .collect::<Vec<_>>();

        sessions.sort_by_key(|session| std::cmp::Reverse(session.created_at));
        sessions
    }

    pub fn get_session_events(
        &self,
        app: &AppHandle,
        runtime_id: &str,
        since_seq: Option<u64>,
    ) -> Result<ReplayBatch, String> {
        self.resolve_backend(app, runtime_id)
            .ok_or_else(|| format!("Unified session not found: {}", runtime_id))?
            .replay_events(since_seq)
    }

    pub fn get_session_info(
        &self,
        app: &AppHandle,
        runtime_id: &str,
    ) -> Option<UnifiedSessionInfo> {
        self.resolve_backend(app, runtime_id)
            .map(|backend| backend.session_info())
    }

    pub fn send_input(
        &self,
        app: &AppHandle,
        runtime_id: &str,
        input: RuntimeInput,
    ) -> Result<(), String> {
        self.resolve_backend(app, runtime_id)
            .ok_or_else(|| format!("Unified session not found: {}", runtime_id))?
            .send_input(input)
    }

    pub fn stop_session(&self, app: &AppHandle, runtime_id: &str) -> Result<(), String> {
        self.resolve_backend(app, runtime_id)
            .ok_or_else(|| format!("Unified session not found: {}", runtime_id))?
            .stop()
    }

    pub fn attach_output_channel(
        &self,
        runtime_id: &str,
        channel: Arc<dyn OutputChannel>,
    ) -> Result<(), String> {
        if !self.contains_session(runtime_id) {
            return Err(format!("Unified session not found: {}", runtime_id));
        }
        self.dispatcher
            .attach_channel(runtime_id.to_string(), channel)
    }

    pub fn attach_desktop_channel(&self, app: &AppHandle, runtime_id: &str) -> Result<(), String> {
        let Some(backend) = self.resolve_backend(app, runtime_id) else {
            return Err(format!("Unified session not found: {}", runtime_id));
        };

        let channel: Arc<dyn OutputChannel> = match backend.runtime_kind() {
            RuntimeKind::Headless => Arc::new(DesktopChannel::headless(app.clone())),
            RuntimeKind::Interactive => Arc::new(DesktopChannel::interactive(app.clone())),
            // Native runtimes stream through their own event log and never
            // attach a desktop output channel.
            RuntimeKind::Native => {
                return Err(
                    "Native runtimes do not attach desktop output channels".to_string(),
                );
            }
        };

        self.attach_output_channel(runtime_id, channel)
    }

    pub fn detach_channel(
        &self,
        runtime_id: &str,
        channel_kind: &ChannelKind,
    ) -> Result<(), String> {
        self.dispatcher.detach_channel(runtime_id, channel_kind)
    }

    pub fn has_connected_channel(&self, runtime_id: &str, channel_kind: &ChannelKind) -> bool {
        self.dispatcher
            .has_connected_channel(runtime_id, channel_kind)
    }

    pub fn debug_compare_sessions(&self) -> UnifiedSessionDebugComparison {
        let headless_count = self.headless_runtime_manager.list_sessions().len();
        let interactive_count = self.interactive_runtime_manager.list_sessions().len();
        let unified_count = self.list_sessions().len();
        UnifiedSessionDebugComparison {
            headless_count,
            interactive_count,
            unified_count,
            matched: unified_count == headless_count + interactive_count,
        }
    }

    pub fn contains_session(&self, runtime_id: &str) -> bool {
        self.headless_runtime_manager.summary(runtime_id).is_some()
            || self
                .interactive_runtime_manager
                .summary(runtime_id)
                .is_some()
    }

    fn resolve_backend(
        &self,
        app: &AppHandle,
        runtime_id: &str,
    ) -> Option<Box<dyn RuntimeBackend>> {
        if self.headless_runtime_manager.summary(runtime_id).is_some() {
            return Some(Box::new(HeadlessBackend {
                app: app.clone(),
                runtime_id: runtime_id.to_string(),
                runtime_manager: self.headless_runtime_manager.clone(),
                dispatcher: self.dispatcher.clone(),
            }));
        }

        if self
            .interactive_runtime_manager
            .summary(runtime_id)
            .is_some()
        {
            return Some(Box::new(TmuxBackend {
                runtime_id: runtime_id.to_string(),
                interactive_runtime_manager: self.interactive_runtime_manager.clone(),
                dispatcher: self.dispatcher.clone(),
            }));
        }

        None
    }
}

fn parse_rfc3339_or_now(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .map(|parsed| parsed.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}

fn normalize_interactive_status(
    status: &str,
    terminal_state: &ClaudeTerminalState,
    is_active: bool,
) -> String {
    if !is_active {
        return match status {
            "running" => "stopped".to_string(),
            other => other.to_string(),
        };
    }

    if status != "running" {
        return status.to_string();
    }

    match terminal_state {
        ClaudeTerminalState::Idle => "ready".to_string(),
        ClaudeTerminalState::Processing => "processing".to_string(),
        ClaudeTerminalState::WaitingApproval => "waiting_permission".to_string(),
        ClaudeTerminalState::Unknown => status.to_string(),
    }
}
