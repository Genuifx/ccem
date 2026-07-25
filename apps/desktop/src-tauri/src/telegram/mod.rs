mod channel;

use crate::channel::OutputChannel;
use crate::config;
use crate::cron;
use crate::crypto;
use crate::event_bus::{
    InteractiveToolPrompt, SessionEventPayload, ToolCategory, ToolQuestionOption,
    ToolQuestionPrompt,
};
use crate::interactive_runtime::{InteractiveRuntimeManager, InteractiveSessionOptions};
use crate::permission_preview::format_permission_preview;
use crate::runtime::{
    clear_runtime_recovery_candidates_by_claude_session_id, HeadlessRuntimeManager,
    HeadlessSessionOptions, HeadlessSessionSource,
};
use crate::session::SessionManager;
use crate::tmux::ClaudeTerminalState;
use chrono::{DateTime, Utc};
use reqwest::blocking::Response;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::any::Any;
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

use self::channel::TelegramChannel;

const TELEGRAM_API_BASE: &str = "https://api.telegram.org";
const TELEGRAM_GENERAL_TOPIC_THREAD_ID: i64 = 1;
const TELEGRAM_DEFAULT_TOPIC_ICON_COLOR: u32 = 0x6FB9F0;
const INTERACTIVE_TOOL_SEEN_TTL: Duration = Duration::from_secs(60 * 10);
const TELEGRAM_LONG_POLL_TIMEOUT_SECS: u64 = 5;
const TELEGRAM_HTTP_TIMEOUT_SECS: u64 = 12;
const TELEGRAM_STOP_GRACE_TIMEOUT_SECS: u64 = 7;
const TELEGRAM_STOP_POLL_INTERVAL_MS: u64 = 100;
const TELEGRAM_BIND_PROJECT_LIMIT: usize = 8;
const TELEGRAM_BIND_PERM_MODES: &[&str] = &["yolo", "dev", "readonly", "safe", "ci", "audit"];
const TELEGRAM_MINIMAL_GROUP_COMMANDS: &[TelegramBotCommand] = &[
    TelegramBotCommand {
        command: "help",
        description: "Show available commands",
    },
    TelegramBotCommand {
        command: "whoami",
        description: "Show your Telegram ids",
    },
];
const TELEGRAM_PRIVATE_COMMANDS: &[TelegramBotCommand] = &[
    TelegramBotCommand {
        command: "help",
        description: "Show available commands",
    },
    TelegramBotCommand {
        command: "whoami",
        description: "Show your Telegram ids",
    },
    TelegramBotCommand {
        command: "sessions",
        description: "List active sessions",
    },
    TelegramBotCommand {
        command: "envs",
        description: "List configured environments",
    },
    TelegramBotCommand {
        command: "stop",
        description: "Stop an active session",
    },
];
const TELEGRAM_FULL_GROUP_COMMANDS: &[TelegramBotCommand] = &[
    TelegramBotCommand {
        command: "help",
        description: "Show available commands",
    },
    TelegramBotCommand {
        command: "whoami",
        description: "Show chat and topic ids",
    },
    TelegramBotCommand {
        command: "sessions",
        description: "List active sessions",
    },
    TelegramBotCommand {
        command: "envs",
        description: "List configured environments",
    },
    TelegramBotCommand {
        command: "resume",
        description: "Resume the bound topic session",
    },
    TelegramBotCommand {
        command: "stop",
        description: "Stop an active session",
    },
    TelegramBotCommand {
        command: "topics",
        description: "List saved topic bindings",
    },
    TelegramBotCommand {
        command: "topic",
        description: "Inspect the current topic binding",
    },
    TelegramBotCommand {
        command: "bind",
        description: "Bind this topic to a project",
    },
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TelegramTopicBinding {
    #[serde(rename = "threadId", alias = "thread_id")]
    pub thread_id: i64,
    #[serde(rename = "projectDir", alias = "project_dir")]
    pub project_dir: String,
    #[serde(
        rename = "preferredEnv",
        alias = "preferred_env",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub preferred_env: Option<String>,
    #[serde(
        rename = "preferredPermMode",
        alias = "preferred_perm_mode",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub preferred_perm_mode: Option<String>,
    #[serde(
        rename = "activeRuntimeId",
        alias = "active_runtime_id",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub active_runtime_id: Option<String>,
    #[serde(
        rename = "lastClaudeSessionId",
        alias = "last_claude_session_id",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub last_claude_session_id: Option<String>,
    #[serde(rename = "createdAt", alias = "created_at")]
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TelegramBridgePreferences {
    #[serde(rename = "showToolCalls", alias = "show_tool_calls", default)]
    pub show_tool_calls: bool,
    #[serde(rename = "showLowRiskTools", alias = "show_low_risk_tools", default)]
    pub show_low_risk_tools: bool,
    #[serde(
        rename = "flushIntervalMs",
        alias = "flush_interval_ms",
        default = "default_flush_interval_ms"
    )]
    pub flush_interval_ms: u64,
}

impl Default for TelegramBridgePreferences {
    fn default() -> Self {
        Self {
            show_tool_calls: true,
            show_low_risk_tools: false,
            flush_interval_ms: default_flush_interval_ms(),
        }
    }
}

fn default_flush_interval_ms() -> u64 {
    3000
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TelegramSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(rename = "botToken", default)]
    pub bot_token: Option<String>,
    #[serde(rename = "allowedUserIds", alias = "allowed_user_ids", default)]
    pub allowed_user_ids: Vec<i64>,
    #[serde(rename = "allowedChatId", default)]
    pub allowed_chat_id: Option<i64>,
    #[serde(
        rename = "notificationsChatId",
        alias = "notifications_chat_id",
        default
    )]
    pub notifications_chat_id: Option<i64>,
    #[serde(rename = "notificationsThreadId", default)]
    pub notifications_thread_id: Option<i64>,
    #[serde(rename = "defaultEnvName", default)]
    pub default_env_name: Option<String>,
    #[serde(rename = "defaultPermMode", default)]
    pub default_perm_mode: Option<String>,
    #[serde(rename = "defaultWorkingDir", default)]
    pub default_working_dir: Option<String>,
    #[serde(rename = "topicBindings", alias = "topic_bindings", default)]
    pub topic_bindings: Vec<TelegramTopicBinding>,
    #[serde(rename = "useChannelMonitor", alias = "use_channel_monitor", default)]
    pub use_channel_monitor: bool,
    #[serde(default)]
    pub preferences: TelegramBridgePreferences,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TelegramBridgeStatus {
    pub configured: bool,
    pub running: bool,
    #[serde(rename = "botUsername")]
    pub bot_username: Option<String>,
    #[serde(rename = "lastError")]
    pub last_error: Option<String>,
    #[serde(rename = "allowedChatId")]
    pub allowed_chat_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TelegramForumTopic {
    pub thread_id: i64,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_color: Option<u32>,
    pub is_bound: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bound_project: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
enum PendingInteractiveAction {
    #[default]
    Empty,
    FreeText(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InteractiveChoiceSubmitMode {
    AskUserQuestion,
    PlanExit,
}

#[derive(Debug, Clone)]
struct ActiveInteractiveChoicePrompt {
    runtime_id: String,
    tool_use_id: String,
    questions: Vec<ToolQuestionPrompt>,
    current_question_index: usize,
    submit_mode: InteractiveChoiceSubmitMode,
    selected_options: BTreeSet<usize>,
    awaiting_text_entry: Option<usize>,
    message_id: Option<i64>,
}

#[derive(Debug, Clone)]
enum ActiveInteractivePrompt {
    Choice(ActiveInteractiveChoicePrompt),
}

#[derive(Debug, Clone, Default)]
struct KnownForumTopicState {
    name: Option<String>,
    icon_color: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BindStep {
    SelectProject,
    EnterCustomProject,
    SelectEnv,
    SelectPerm,
}

#[derive(Debug, Clone)]
struct PendingBindSession {
    message_id: i64,
    step: BindStep,
    project_candidates: Vec<String>,
    selected_project: Option<String>,
    selected_env: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct TelegramBridgeState {
    configured: bool,
    running: bool,
    bot_username: Option<String>,
    last_error: Option<String>,
    allowed_chat_id: Option<i64>,
    next_update_id: Option<i64>,
    active_runtime_by_scope: HashMap<String, String>,
    interactive_monitor_by_scope: HashMap<String, String>,
    pending_interactive_actions: HashMap<String, VecDeque<PendingInteractiveAction>>,
    active_interactive_prompts: HashMap<String, ActiveInteractivePrompt>,
    seen_interactive_tool_events: HashMap<String, Instant>,
    pending_bind_sessions: HashMap<String, PendingBindSession>,
    known_forum_topics: HashMap<i64, KnownForumTopicState>,
}

pub struct TelegramBridgeManager {
    state: Mutex<TelegramBridgeState>,
    stop_flag: AtomicBool,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
}

impl Default for TelegramBridgeManager {
    fn default() -> Self {
        Self {
            state: Mutex::new(TelegramBridgeState::default()),
            stop_flag: AtomicBool::new(false),
            worker: Mutex::new(None),
        }
    }
}

impl TelegramBridgeManager {
    pub fn status(&self) -> TelegramBridgeStatus {
        self.cleanup_finished_worker();
        let state = self
            .state
            .lock()
            .map(|state| state.clone())
            .unwrap_or_default();
        TelegramBridgeStatus {
            configured: state.configured,
            running: state.running,
            bot_username: state.bot_username,
            last_error: state.last_error,
            allowed_chat_id: state.allowed_chat_id,
        }
    }

    pub fn start(
        self: &Arc<Self>,
        app: AppHandle,
        runtime_manager: Arc<HeadlessRuntimeManager>,
        interactive_runtime_manager: Arc<InteractiveRuntimeManager>,
    ) -> Result<TelegramBridgeStatus, String> {
        self.cleanup_finished_worker();

        {
            let state = self
                .state
                .lock()
                .map_err(|_| "Failed to lock Telegram bridge state".to_string())?;
            if state.running {
                return Ok(TelegramBridgeStatus {
                    configured: true,
                    running: true,
                    bot_username: state.bot_username.clone(),
                    last_error: state.last_error.clone(),
                    allowed_chat_id: state.allowed_chat_id,
                });
            }
        }

        if self
            .worker
            .lock()
            .map_err(|_| "Failed to lock Telegram bridge worker".to_string())?
            .as_ref()
            .is_some_and(|handle| !handle.is_finished())
        {
            self.stop_flag.store(true, Ordering::SeqCst);
            if !self.wait_for_worker_shutdown(Duration::from_secs(TELEGRAM_STOP_GRACE_TIMEOUT_SECS))
            {
                return Err(
                    "Telegram bridge is still stopping. CCEM is waiting for the previous long-poll request to finish."
                        .to_string(),
                );
            }
        }

        let settings = read_telegram_settings()?;
        let token = settings
            .bot_token
            .clone()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "Telegram bot token is not configured".to_string())?;
        let me = get_me(&token)?;
        sync_registered_commands(&token, &settings)?;

        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Failed to lock Telegram bridge state".to_string())?;
            self.stop_flag.store(false, Ordering::SeqCst);
            state.configured = true;
            state.running = true;
            state.bot_username = me.username.clone();
            state.last_error = None;
            state.allowed_chat_id = settings.allowed_chat_id;
        }

        let manager = Arc::clone(self);
        let handle = thread::spawn(move || {
            run_bridge_loop(
                manager,
                app,
                runtime_manager,
                interactive_runtime_manager,
                token,
                settings,
                me.username,
            );
        });
        if let Ok(mut worker) = self.worker.lock() {
            *worker = Some(handle);
        }

        Ok(self.status())
    }

    pub fn stop(&self) -> TelegramBridgeStatus {
        self.stop_flag.store(true, Ordering::SeqCst);
        if let Ok(mut state) = self.state.lock() {
            state.running = false;
            state.active_runtime_by_scope.clear();
            state.interactive_monitor_by_scope.clear();
            state.pending_interactive_actions.clear();
            state.active_interactive_prompts.clear();
            state.seen_interactive_tool_events.clear();
            state.pending_bind_sessions.clear();
            state.known_forum_topics.clear();
        }
        self.status()
    }

    pub fn sync_settings(&self, settings: &TelegramSettings) {
        if let Ok(mut state) = self.state.lock() {
            state.configured = settings
                .bot_token
                .as_ref()
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false);
            state.allowed_chat_id = settings.allowed_chat_id;
            if !settings.enabled {
                state.running = false;
            }
        }
    }

    fn set_last_error(&self, message: impl Into<String>) {
        // Defense in depth: transport errors already strip the bot token at
        // the format site (see `redact_telegram_token`), but any error path
        // that bypasses those formatters converges here. Strip again so the
        // persisted `last_error` shown in the desktop UI can never carry a
        // token, even if a future call site forgets to redact.
        let redacted = redact_telegram_token(&message.into());
        if let Ok(mut state) = self.state.lock() {
            state.last_error = Some(redacted);
            state.running = false;
        }
    }

    fn clear_last_error(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.last_error = None;
            state.running = true;
        }
    }

    fn remember_forum_topic(&self, thread_id: i64, name: Option<String>, icon_color: Option<u32>) {
        if let Ok(mut state) = self.state.lock() {
            let entry = state.known_forum_topics.entry(thread_id).or_default();
            if let Some(name) = name.filter(|value| !value.trim().is_empty()) {
                entry.name = Some(name);
            }
            if icon_color.is_some() {
                entry.icon_color = icon_color;
            }
        }
    }

    fn known_forum_topics(&self) -> HashMap<i64, KnownForumTopicState> {
        self.state
            .lock()
            .map(|state| state.known_forum_topics.clone())
            .unwrap_or_default()
    }

    fn remember_runtime_for_scope(&self, chat_id: i64, thread_id: Option<i64>, runtime_id: String) {
        if let Ok(mut state) = self.state.lock() {
            state
                .active_runtime_by_scope
                .insert(scope_key(chat_id, thread_id), runtime_id);
        }
    }

    fn active_runtime_for_scope(&self, chat_id: i64, thread_id: Option<i64>) -> Option<String> {
        self.state.lock().ok().and_then(|state| {
            state
                .active_runtime_by_scope
                .get(&scope_key(chat_id, thread_id))
                .cloned()
        })
    }

    fn clear_runtime_for_scope(&self, chat_id: i64, thread_id: Option<i64>, runtime_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            let key = scope_key(chat_id, thread_id);
            if state
                .active_runtime_by_scope
                .get(&key)
                .is_some_and(|value| value == runtime_id)
            {
                state.active_runtime_by_scope.remove(&key);
            }
            if state
                .interactive_monitor_by_scope
                .get(&key)
                .is_some_and(|value| value == runtime_id)
            {
                state.interactive_monitor_by_scope.remove(&key);
            }
            state.pending_interactive_actions.remove(&key);
            state.active_interactive_prompts.remove(&key);
            state
                .seen_interactive_tool_events
                .retain(|tool_key, _| !tool_key.starts_with(&format!("{key}:")));
        }
    }

    fn ensure_interactive_monitor_for_scope(
        &self,
        chat_id: i64,
        thread_id: Option<i64>,
        runtime_id: &str,
    ) -> bool {
        if let Ok(mut state) = self.state.lock() {
            let key = scope_key(chat_id, thread_id);
            if state
                .interactive_monitor_by_scope
                .get(&key)
                .is_some_and(|value| value == runtime_id)
            {
                return false;
            }
            state
                .interactive_monitor_by_scope
                .insert(key, runtime_id.to_string());
            return true;
        }
        true
    }

    fn queue_interactive_message(
        &self,
        chat_id: i64,
        thread_id: Option<i64>,
        message: String,
    ) -> usize {
        if let Ok(mut state) = self.state.lock() {
            let queue = state
                .pending_interactive_actions
                .entry(scope_key(chat_id, thread_id))
                .or_default();
            queue.push_back(PendingInteractiveAction::FreeText(message));
            return queue.len();
        }
        0
    }

    fn pop_pending_interactive_action(
        &self,
        chat_id: i64,
        thread_id: Option<i64>,
    ) -> Option<PendingInteractiveAction> {
        let mut state = self.state.lock().ok()?;
        let key = scope_key(chat_id, thread_id);
        let queue = state.pending_interactive_actions.get_mut(&key)?;
        let message = queue.pop_front();
        if queue.is_empty() {
            state.pending_interactive_actions.remove(&key);
        }
        message
    }

    fn remember_active_prompt(
        &self,
        chat_id: i64,
        thread_id: Option<i64>,
        prompt: ActiveInteractivePrompt,
    ) {
        if let Ok(mut state) = self.state.lock() {
            state
                .active_interactive_prompts
                .insert(scope_key(chat_id, thread_id), prompt);
        }
    }

    fn active_prompt_for_scope(
        &self,
        chat_id: i64,
        thread_id: Option<i64>,
    ) -> Option<ActiveInteractivePrompt> {
        self.state.lock().ok().and_then(|state| {
            state
                .active_interactive_prompts
                .get(&scope_key(chat_id, thread_id))
                .cloned()
        })
    }

    fn mutate_active_prompt_for_scope<T>(
        &self,
        chat_id: i64,
        thread_id: Option<i64>,
        mutate: impl FnOnce(&mut ActiveInteractivePrompt) -> T,
    ) -> Option<T> {
        let mut state = self.state.lock().ok()?;
        let prompt = state
            .active_interactive_prompts
            .get_mut(&scope_key(chat_id, thread_id))?;
        Some(mutate(prompt))
    }

    fn clear_active_prompt_for_scope(
        &self,
        chat_id: i64,
        thread_id: Option<i64>,
    ) -> Option<ActiveInteractivePrompt> {
        self.state.lock().ok().and_then(|mut state| {
            state
                .active_interactive_prompts
                .remove(&scope_key(chat_id, thread_id))
        })
    }

    fn mark_interactive_tool_seen(
        &self,
        chat_id: i64,
        thread_id: Option<i64>,
        tool_use_id: &str,
    ) -> bool {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return false,
        };
        state
            .seen_interactive_tool_events
            .retain(|_, seen_at| seen_at.elapsed() <= INTERACTIVE_TOOL_SEEN_TTL);
        let key = format!("{}:{}", scope_key(chat_id, thread_id), tool_use_id);
        match state.seen_interactive_tool_events.get(&key) {
            Some(_) => false,
            None => {
                state
                    .seen_interactive_tool_events
                    .insert(key, Instant::now());
                true
            }
        }
    }

    fn next_update_id(&self) -> Option<i64> {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.next_update_id)
    }

    fn advance_update_id(&self, update_id: i64) {
        if let Ok(mut state) = self.state.lock() {
            state.next_update_id = Some(update_id + 1);
        }
    }

    fn cleanup_finished_worker(&self) {
        if let Ok(mut worker) = self.worker.lock() {
            if worker.as_ref().is_some_and(|handle| handle.is_finished()) {
                if let Some(handle) = worker.take() {
                    let stopped_intentionally = self.stop_flag.load(Ordering::SeqCst);
                    let join_result = handle.join();
                    if let Ok(mut state) = self.state.lock() {
                        state.running = false;
                        if stopped_intentionally {
                            state.last_error = None;
                        } else if let Err(payload) = join_result {
                            state.last_error = Some(format!(
                                "Telegram bridge worker panicked: {}",
                                panic_payload_to_string(payload)
                            ));
                        } else if state.last_error.is_none() {
                            state.last_error =
                                Some("Telegram bridge worker exited unexpectedly.".to_string());
                        }
                    }
                }
            }
        }
    }

    fn wait_for_worker_shutdown(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            self.cleanup_finished_worker();
            let still_running = self
                .worker
                .lock()
                .map(|worker| worker.as_ref().is_some_and(|handle| !handle.is_finished()))
                .unwrap_or(false);
            if !still_running {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(TELEGRAM_STOP_POLL_INTERVAL_MS));
        }
    }
}

#[derive(Debug, Deserialize)]
struct TelegramApiResponse<T> {
    ok: bool,
    result: Option<T>,
    description: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
struct TelegramBotCommand {
    command: &'static str,
    description: &'static str,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TelegramBotCommandScope {
    Default,
    AllPrivateChats,
    AllGroupChats,
    Chat { chat_id: i64 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TelegramCommandRegistration {
    scope: TelegramBotCommandScope,
    commands: Vec<TelegramBotCommand>,
}

#[derive(Debug, Deserialize)]
struct TelegramUser {
    username: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TelegramUpdate {
    update_id: i64,
    message: Option<TelegramMessage>,
    #[serde(default)]
    callback_query: Option<TelegramCallbackQuery>,
}

#[derive(Debug, Deserialize)]
struct TelegramMessage {
    #[serde(default)]
    message_id: i64,
    chat: TelegramChat,
    #[serde(default)]
    from: Option<TelegramSender>,
    text: Option<String>,
    #[serde(default)]
    message_thread_id: Option<i64>,
    #[serde(default)]
    forum_topic_created: Option<TelegramForumTopicCreatedPayload>,
    #[serde(default)]
    forum_topic_edited: Option<TelegramForumTopicEditedPayload>,
}

#[derive(Debug, Deserialize)]
struct TelegramForumTopicCreatedPayload {
    name: String,
    #[serde(default)]
    icon_color: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct TelegramForumTopicEditedPayload {
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TelegramChat {
    id: i64,
    #[serde(default)]
    is_forum: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct TelegramSender {
    id: i64,
}

#[derive(Debug, Deserialize)]
struct TelegramCallbackQuery {
    id: String,
    from: TelegramSender,
    #[serde(default)]
    message: Option<TelegramMessage>,
    #[serde(default)]
    data: Option<String>,
}

pub fn telegram_settings_path() -> PathBuf {
    config::get_ccem_dir().join("telegram.json")
}

pub fn read_telegram_settings() -> Result<TelegramSettings, String> {
    let path = telegram_settings_path();
    if !path.exists() {
        return Ok(TelegramSettings::default());
    }

    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read telegram settings: {}", error))?;
    let settings: TelegramSettings = serde_json::from_str(&content)
        .map_err(|error| format!("Failed to parse telegram settings: {}", error))?;
    decrypt_telegram_settings(settings)
}

fn decrypt_telegram_settings(mut settings: TelegramSettings) -> Result<TelegramSettings, String> {
    settings.bot_token = settings
        .bot_token
        .as_deref()
        .map(|token| crypto::decrypt_local_secret("Telegram bot token", token))
        .transpose()?;
    Ok(settings)
}

pub fn write_telegram_settings(settings: &TelegramSettings) -> Result<(), String> {
    config::ensure_ccem_dir().map_err(|error| format!("Failed to create config dir: {}", error))?;
    let mut persisted = settings.clone();
    persisted.bot_token = persisted
        .bot_token
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .map(|value| crypto::encrypt(value))
        .transpose()
        .map_err(|e| format!("Failed to encrypt telegram bot token: {}", e))?;
    let content = serde_json::to_string_pretty(&persisted)
        .map_err(|error| format!("Failed to serialize telegram settings: {}", error))?;
    fs::write(telegram_settings_path(), content)
        .map_err(|error| format!("Failed to write telegram settings: {}", error))
}

pub fn send_configured_message(text: &str) -> Result<bool, String> {
    let settings = read_telegram_settings()?;
    if !settings.enabled {
        return Ok(false);
    }

    let token = match settings
        .bot_token
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        Some(token) => token.to_string(),
        None => return Ok(false),
    };
    let chat_id = match settings.notifications_chat_id.or(settings.allowed_chat_id) {
        Some(chat_id) => chat_id,
        None => return Ok(false),
    };
    let thread_id = if chat_id > 0 {
        None
    } else {
        settings.notifications_thread_id
    };

    send_message(&token, chat_id, thread_id, text)?;
    Ok(true)
}

fn scope_key(chat_id: i64, thread_id: Option<i64>) -> String {
    format!(
        "{}:{}",
        chat_id,
        canonical_thread_id(thread_id).unwrap_or(0)
    )
}

fn bind_scope_key(chat_id: i64, thread_id: i64) -> String {
    scope_key(chat_id, Some(thread_id))
}

fn set_pending_bind_session(
    manager: &TelegramBridgeManager,
    chat_id: i64,
    thread_id: i64,
    session: PendingBindSession,
) -> Result<(), String> {
    let mut state = manager
        .state
        .lock()
        .map_err(|_| "Failed to lock Telegram bridge state".to_string())?;
    state
        .pending_bind_sessions
        .insert(bind_scope_key(chat_id, thread_id), session);
    Ok(())
}

fn pending_bind_session(
    manager: &TelegramBridgeManager,
    chat_id: i64,
    thread_id: i64,
) -> Result<Option<PendingBindSession>, String> {
    let state = manager
        .state
        .lock()
        .map_err(|_| "Failed to lock Telegram bridge state".to_string())?;
    Ok(state
        .pending_bind_sessions
        .get(&bind_scope_key(chat_id, thread_id))
        .cloned())
}

fn with_pending_bind_session<R, F>(
    manager: &TelegramBridgeManager,
    chat_id: i64,
    thread_id: i64,
    update: F,
) -> Result<Option<R>, String>
where
    F: FnOnce(&mut PendingBindSession) -> Result<R, String>,
{
    let mut state = manager
        .state
        .lock()
        .map_err(|_| "Failed to lock Telegram bridge state".to_string())?;
    let Some(session) = state
        .pending_bind_sessions
        .get_mut(&bind_scope_key(chat_id, thread_id))
    else {
        return Ok(None);
    };
    update(session).map(Some)
}

fn clear_pending_bind_session(
    manager: &TelegramBridgeManager,
    chat_id: i64,
    thread_id: i64,
) -> Result<(), String> {
    let mut state = manager
        .state
        .lock()
        .map_err(|_| "Failed to lock Telegram bridge state".to_string())?;
    state
        .pending_bind_sessions
        .remove(&bind_scope_key(chat_id, thread_id));
    Ok(())
}

fn find_topic_binding(
    settings: &TelegramSettings,
    thread_id: Option<i64>,
) -> Option<&TelegramTopicBinding> {
    let thread_id = canonical_thread_id(thread_id)?;
    settings
        .topic_bindings
        .iter()
        .find(|binding| binding.thread_id == thread_id)
}

fn find_topic_binding_by_project<'a>(
    settings: &'a TelegramSettings,
    project_dir: &str,
    preferred_env: Option<&str>,
    preferred_perm_mode: Option<&str>,
) -> Option<&'a TelegramTopicBinding> {
    settings.topic_bindings.iter().find(|binding| {
        let binding_env = resolve_topic_env_name(settings, binding.preferred_env.as_deref());
        let binding_perm =
            resolve_topic_perm_mode(settings, binding.preferred_perm_mode.as_deref());
        binding.project_dir == project_dir
            && binding_env == preferred_env.unwrap_or_default()
            && binding_perm == preferred_perm_mode.unwrap_or_default()
    })
}

fn canonical_thread_id(thread_id: Option<i64>) -> Option<i64> {
    match thread_id {
        Some(TELEGRAM_GENERAL_TOPIC_THREAD_ID) | None => None,
        value => value,
    }
}

fn is_general_topic(thread_id: Option<i64>) -> bool {
    canonical_thread_id(thread_id).is_none()
}

fn is_sender_allowed(settings: &TelegramSettings, user_id: Option<i64>) -> bool {
    if settings.allowed_user_ids.is_empty() {
        return true;
    }

    user_id
        .map(|user_id| settings.allowed_user_ids.contains(&user_id))
        .unwrap_or(false)
}

fn is_private_chat_scope(chat_id: i64, user_id: Option<i64>) -> bool {
    user_id.is_some_and(|user_id| user_id == chat_id)
}

fn is_chat_allowed(settings: &TelegramSettings, chat_id: i64, user_id: Option<i64>) -> bool {
    settings.allowed_chat_id.is_none_or(|allowed_chat_id| {
        allowed_chat_id == chat_id || is_private_chat_scope(chat_id, user_id)
    })
}

fn upsert_topic_binding(settings: &mut TelegramSettings, binding: TelegramTopicBinding) {
    if let Some(existing) = settings
        .topic_bindings
        .iter_mut()
        .find(|existing| existing.thread_id == binding.thread_id)
    {
        *existing = binding;
    } else {
        settings.topic_bindings.push(binding);
        settings.topic_bindings.sort_by_key(|left| left.thread_id);
    }
}

fn save_topic_binding(
    thread_id: i64,
    project_dir: String,
    preferred_env: Option<String>,
    preferred_perm_mode: Option<String>,
) -> Result<TelegramTopicBinding, String> {
    with_telegram_settings_mut(|settings| {
        let existing = settings
            .topic_bindings
            .iter()
            .find(|binding| binding.thread_id == thread_id)
            .cloned();
        let binding = TelegramTopicBinding {
            thread_id,
            project_dir,
            preferred_env,
            preferred_perm_mode,
            active_runtime_id: existing
                .as_ref()
                .and_then(|binding| binding.active_runtime_id.clone()),
            last_claude_session_id: existing
                .as_ref()
                .and_then(|binding| binding.last_claude_session_id.clone()),
            created_at: existing
                .map(|binding| binding.created_at)
                .unwrap_or_else(Utc::now),
        };
        upsert_topic_binding(settings, binding.clone());
        binding
    })
}

fn remove_topic_binding(settings: &mut TelegramSettings, thread_id: i64) -> bool {
    let before = settings.topic_bindings.len();
    settings
        .topic_bindings
        .retain(|binding| binding.thread_id != thread_id);
    before != settings.topic_bindings.len()
}

fn parse_permission_callback_data(data: &str) -> Option<(bool, &str)> {
    if let Some(request_id) = data.strip_prefix("perm:approve:") {
        return Some((true, request_id.trim()));
    }

    if let Some(request_id) = data.strip_prefix("perm:deny:") {
        return Some((false, request_id.trim()));
    }

    None
}

fn parse_interactive_permission_callback_data(data: &str) -> Option<(bool, &str)> {
    if let Some(session_id) = data.strip_prefix("perm_i:approve:") {
        return Some((true, session_id.trim()));
    }

    if let Some(session_id) = data.strip_prefix("perm_i:deny:") {
        return Some((false, session_id.trim()));
    }

    None
}

fn parse_interactive_tool_select_callback_data(data: &str) -> Option<usize> {
    data.strip_prefix("tool_i:select:")
        .and_then(|value| value.parse::<usize>().ok())
}

fn parse_interactive_tool_submit_callback_data(data: &str) -> bool {
    data == "tool_i:submit"
}

fn parse_interactive_tool_cancel_callback_data(data: &str) -> bool {
    data == "tool_i:cancel"
}

fn active_prompt_runtime_id(prompt: &ActiveInteractivePrompt) -> &str {
    match prompt {
        ActiveInteractivePrompt::Choice(prompt) => &prompt.runtime_id,
    }
}

fn active_choice_question(prompt: &ActiveInteractiveChoicePrompt) -> Option<&ToolQuestionPrompt> {
    prompt.questions.get(prompt.current_question_index)
}

fn active_choice_progress(prompt: &ActiveInteractiveChoicePrompt) -> Option<(usize, usize)> {
    (prompt.questions.len() > 1).then_some((
        prompt.current_question_index.saturating_add(1),
        prompt.questions.len(),
    ))
}

fn advance_active_choice_prompt(prompt: &mut ActiveInteractiveChoicePrompt) -> bool {
    if prompt.current_question_index + 1 >= prompt.questions.len() {
        return false;
    }

    prompt.current_question_index += 1;
    prompt.selected_options.clear();
    prompt.awaiting_text_entry = None;
    true
}

fn format_active_choice_text(prompt: &ActiveInteractiveChoicePrompt) -> String {
    active_choice_question(prompt)
        .map(|question| format_interactive_choice_text(question, active_choice_progress(prompt)))
        .unwrap_or_else(|| "Interactive question is no longer available.".to_string())
}

fn build_active_choice_markup(prompt: &ActiveInteractiveChoicePrompt) -> serde_json::Value {
    active_choice_question(prompt)
        .map(|question| build_interactive_choice_markup(question, &prompt.selected_options))
        .unwrap_or_else(build_text_entry_markup)
}

fn selection_submit_options(
    question: &ToolQuestionPrompt,
    selected_options: &BTreeSet<usize>,
) -> BTreeSet<usize> {
    selected_options
        .iter()
        .copied()
        .filter(|index| {
            question
                .options
                .get(index.saturating_sub(1))
                .is_none_or(|option| {
                    !is_vscode_text_entry_option(&option.label)
                        && !is_chat_about_this_option(&option.label)
                })
        })
        .collect()
}

fn option_has_preview(option: &ToolQuestionOption) -> bool {
    option
        .preview
        .as_deref()
        .map(str::trim)
        .is_some_and(|preview| !preview.is_empty())
}

fn is_vscode_text_entry_option(label: &str) -> bool {
    let normalized = label.to_ascii_lowercase();
    normalized.contains("type something")
        || normalized.contains("type here")
        || normalized.contains("other")
}

fn is_chat_about_this_option(label: &str) -> bool {
    label.to_ascii_lowercase().contains("chat about this")
}

fn question_supports_chat_about_this(question: &ToolQuestionPrompt) -> bool {
    question.options.iter().any(option_has_preview)
}

fn ensure_text_entry_option(question: &ToolQuestionPrompt) -> ToolQuestionPrompt {
    if question_supports_chat_about_this(question) {
        return question.clone();
    }

    if question
        .options
        .iter()
        .any(|option| is_vscode_text_entry_option(&option.label))
    {
        return question.clone();
    }

    let mut question = question.clone();
    question.options.push(ToolQuestionOption {
        label: "Type something".to_string(),
        description: None,
        preview: None,
    });
    question
}

fn ensure_chat_about_this_option(question: &ToolQuestionPrompt) -> ToolQuestionPrompt {
    if !question_supports_chat_about_this(question)
        || question
            .options
            .iter()
            .any(|option| is_chat_about_this_option(&option.label))
    {
        return question.clone();
    }

    let mut question = question.clone();
    question.options.push(ToolQuestionOption {
        label: "Chat about this".to_string(),
        description: Some("Clarify the question before answering.".to_string()),
        preview: None,
    });
    question
}

fn normalize_ask_user_questions_for_telegram(
    questions: Vec<ToolQuestionPrompt>,
) -> Vec<ToolQuestionPrompt> {
    questions
        .into_iter()
        .map(|question| {
            let question = ensure_chat_about_this_option(&question);
            ensure_text_entry_option(&question)
        })
        .collect()
}

fn format_tool_started_message(
    category: &ToolCategory,
    raw_name: &str,
    input_summary: &str,
) -> Option<String> {
    let trimmed = input_summary.trim();
    match category {
        ToolCategory::Execution { .. } => Some(if trimmed.is_empty() {
            format!("⚙️ {raw_name}")
        } else {
            format!("⚙️ {raw_name}: {trimmed}")
        }),
        ToolCategory::FileOp { .. } => Some(if trimmed.is_empty() {
            format!("📄 {raw_name}")
        } else {
            format!("📄 {raw_name}: {trimmed}")
        }),
        ToolCategory::TaskMgmt { .. } => Some(if trimmed.is_empty() {
            format!("📋 {raw_name}")
        } else {
            format!("📋 {raw_name}: {trimmed}")
        }),
        ToolCategory::Unknown { .. } => Some(if trimmed.is_empty() {
            format!("🔧 {raw_name}")
        } else {
            format!("🔧 {raw_name}: {trimmed}")
        }),
        ToolCategory::Search { .. } | ToolCategory::UserInput { .. } => None,
    }
}

fn format_tool_completed_message(
    raw_name: &str,
    result_summary: &str,
    success: bool,
) -> Option<String> {
    if is_interactive_user_input_tool(raw_name) {
        return None;
    }

    let trimmed = result_summary.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(format!(
        "{} {}: {}",
        if success { "✅" } else { "⚠️" },
        raw_name,
        trimmed
    ))
}

fn is_interactive_user_input_tool(raw_name: &str) -> bool {
    raw_name.contains("AskUser")
        || raw_name.contains("Question")
        || (raw_name.contains("PlanMode") && raw_name.contains("Exit"))
}

fn summarize_interactive_prompt_resolution(raw_name: &str, result_summary: &str) -> String {
    let trimmed = result_summary.trim();
    if raw_name.contains("AskUser")
        && (trimmed.contains("wants to clarify these questions")
            || trimmed.contains("doesn't want to proceed with this tool use"))
    {
        return "Interactive prompt resolved via AskUserQuestion.\nClaude switched to clarification mode.".to_string();
    }

    if trimmed.is_empty() {
        format!("Interactive prompt resolved via {}.", raw_name)
    } else {
        format!(
            "Interactive prompt resolved via {}.\n{}",
            raw_name, result_summary
        )
    }
}

fn format_interactive_choice_text(
    question: &ToolQuestionPrompt,
    progress: Option<(usize, usize)>,
) -> String {
    let mut lines = Vec::new();
    if let Some((current, total)) = progress {
        lines.push(format!("Question {current}/{total}"));
        lines.push(String::new());
    }
    if let Some(header) = question.header.as_deref() {
        lines.push(format!("{}:", header));
    }
    lines.push(question.question.clone());
    lines.push(String::new());

    for (index, option) in question.options.iter().enumerate() {
        let prefix = format!("{}. {}", index + 1, option.label);
        match option.description.as_deref() {
            Some(description) if !description.trim().is_empty() => {
                lines.push(format!("{prefix}\n{}", description.trim()));
            }
            _ => lines.push(prefix),
        }
    }

    if question.multi_select {
        lines.push(String::new());
        lines.push("可多选，点按钮切换后再提交。".to_string());
    }

    lines.join("\n")
}

fn build_interactive_choice_markup(
    question: &ToolQuestionPrompt,
    selected_options: &BTreeSet<usize>,
) -> serde_json::Value {
    let mut rows = question
        .options
        .iter()
        .enumerate()
        .map(|(index, option)| {
            let option_index = index + 1;
            let selected = selected_options.contains(&option_index);
            let marker = if selected { "☑" } else { "☐" };
            serde_json::json!([{
                "text": format!("{marker} {}. {}", option_index, option.label),
                "callback_data": format!("tool_i:select:{option_index}"),
            }])
        })
        .collect::<Vec<_>>();

    if question.multi_select {
        rows.push(serde_json::json!([
            {
                "text": "Submit",
                "callback_data": "tool_i:submit",
            },
            {
                "text": "Cancel",
                "callback_data": "tool_i:cancel",
            }
        ]));
    } else {
        rows.push(serde_json::json!([{
            "text": "Cancel",
            "callback_data": "tool_i:cancel",
        }]));
    }

    serde_json::json!({ "inline_keyboard": rows })
}

fn build_plan_exit_question(
    plan_summary: Option<&str>,
    allowed_prompts: &[String],
) -> ToolQuestionPrompt {
    let mut question =
        "Claude has written up a plan and is ready to execute. Would you like to proceed?"
            .to_string();
    if let Some(plan_summary) = plan_summary
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        question = format!(
            "Claude has written up a plan and is ready to execute.\n\n{}\n\nWould you like to proceed?",
            truncate_for_telegram(plan_summary)
        );
    }

    let custom_text_entry = allowed_prompts
        .iter()
        .find_map(|prompt| {
            let trimmed = prompt.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        })
        .unwrap_or_else(|| "Type here to tell Claude what to change".to_string());

    ToolQuestionPrompt {
        header: Some("Ready to code?".to_string()),
        question,
        multi_select: false,
        options: vec![
            ToolQuestionOption {
                label: "Yes, clear context and auto-accept edits".to_string(),
                description: None,
                preview: None,
            },
            ToolQuestionOption {
                label: "Yes, auto-accept edits".to_string(),
                description: None,
                preview: None,
            },
            ToolQuestionOption {
                label: "Yes, manually approve edits".to_string(),
                description: None,
                preview: None,
            },
            ToolQuestionOption {
                label: custom_text_entry,
                description: None,
                preview: None,
            },
        ],
    }
}

fn build_text_entry_markup() -> serde_json::Value {
    serde_json::json!({
        "inline_keyboard": [[{
            "text": "Cancel",
            "callback_data": "tool_i:cancel",
        }]]
    })
}

fn send_interactive_input_sequence(
    interactive_runtime_manager: &Arc<InteractiveRuntimeManager>,
    runtime_id: &str,
    steps: &[(&str, Duration)],
) -> Result<(), String> {
    for (data, delay) in steps {
        interactive_runtime_manager.write_input(runtime_id, data)?;
        if !delay.is_zero() {
            thread::sleep(*delay);
        }
    }
    Ok(())
}

fn build_multi_select_text_entry_steps(option_index: usize) -> Vec<(String, Duration)> {
    let mut owned_steps = Vec::new();
    for _ in 0..(option_index + 2) {
        owned_steps.push(("\u{1b}[A".to_string(), Duration::from_millis(60)));
    }
    for _ in 0..option_index.saturating_sub(1) {
        owned_steps.push(("\u{1b}[B".to_string(), Duration::from_millis(60)));
    }
    owned_steps.push(("\r".to_string(), Duration::from_millis(120)));
    owned_steps
}

fn build_multi_select_submit_steps(selected_options: &BTreeSet<usize>) -> Vec<(String, Duration)> {
    let mut owned_steps = selected_options
        .iter()
        .map(|option| (option.to_string(), Duration::from_millis(120)))
        .collect::<Vec<_>>();
    owned_steps.push(("\t".to_string(), Duration::from_millis(120)));
    owned_steps.push(("\r".to_string(), Duration::from_millis(400)));
    owned_steps.push(("1".to_string(), Duration::from_millis(0)));
    owned_steps
}

fn build_chat_about_this_steps(option_count: usize) -> Vec<(String, Duration)> {
    let mut owned_steps = Vec::new();
    for _ in 0..option_count {
        owned_steps.push(("\u{1b}[B".to_string(), Duration::from_millis(80)));
    }
    owned_steps.push(("\r".to_string(), Duration::from_millis(120)));
    owned_steps
}

fn submit_single_select_answer(
    interactive_runtime_manager: &Arc<InteractiveRuntimeManager>,
    runtime_id: &str,
    option_index: usize,
) -> Result<(), String> {
    let option = option_index.to_string();
    send_interactive_input_sequence(
        interactive_runtime_manager,
        runtime_id,
        &[
            (option.as_str(), Duration::from_millis(120)),
            ("\u{1b}[C", Duration::from_millis(120)),
            ("\r", Duration::from_millis(400)),
            ("\r", Duration::from_millis(0)),
        ],
    )
}

fn submit_choice_answer(
    interactive_runtime_manager: &Arc<InteractiveRuntimeManager>,
    runtime_id: &str,
    submit_mode: InteractiveChoiceSubmitMode,
    option_index: usize,
    question_count: usize,
) -> Result<(), String> {
    match submit_mode {
        InteractiveChoiceSubmitMode::AskUserQuestion => {
            if question_count > 1 {
                interactive_runtime_manager.write_input(runtime_id, &option_index.to_string())
            } else {
                submit_single_select_answer(interactive_runtime_manager, runtime_id, option_index)
            }
        }
        InteractiveChoiceSubmitMode::PlanExit => {
            interactive_runtime_manager.write_input(runtime_id, &option_index.to_string())
        }
    }
}

fn enter_text_entry_mode(
    interactive_runtime_manager: &Arc<InteractiveRuntimeManager>,
    runtime_id: &str,
    option_index: usize,
) -> Result<(), String> {
    interactive_runtime_manager.write_input(runtime_id, &option_index.to_string())
}

fn enter_multi_select_text_entry_mode(
    interactive_runtime_manager: &Arc<InteractiveRuntimeManager>,
    runtime_id: &str,
    option_index: usize,
) -> Result<(), String> {
    let owned_steps = build_multi_select_text_entry_steps(option_index);
    let borrowed = owned_steps
        .iter()
        .map(|(step, delay)| (step.as_str(), *delay))
        .collect::<Vec<_>>();
    send_interactive_input_sequence(interactive_runtime_manager, runtime_id, &borrowed)
}

fn submit_text_entry_answer(
    interactive_runtime_manager: &Arc<InteractiveRuntimeManager>,
    runtime_id: &str,
    text: &str,
) -> Result<(), String> {
    send_interactive_input_sequence(
        interactive_runtime_manager,
        runtime_id,
        &[
            (text, Duration::from_millis(120)),
            ("\r", Duration::from_millis(0)), // Enter to confirm text input
        ],
    )
}

fn submit_multi_select_answer(
    interactive_runtime_manager: &Arc<InteractiveRuntimeManager>,
    runtime_id: &str,
    selected_options: &BTreeSet<usize>,
) -> Result<(), String> {
    let owned_steps = build_multi_select_submit_steps(selected_options);
    let borrowed = owned_steps
        .iter()
        .map(|(step, delay)| (step.as_str(), *delay))
        .collect::<Vec<_>>();
    send_interactive_input_sequence(interactive_runtime_manager, runtime_id, &borrowed)
}

fn select_chat_about_this(
    interactive_runtime_manager: &Arc<InteractiveRuntimeManager>,
    runtime_id: &str,
    option_count: usize,
) -> Result<(), String> {
    let owned_steps = build_chat_about_this_steps(option_count);
    let borrowed = owned_steps
        .iter()
        .map(|(step, delay)| (step.as_str(), *delay))
        .collect::<Vec<_>>();
    send_interactive_input_sequence(interactive_runtime_manager, runtime_id, &borrowed)
}

fn runtime_is_active(
    runtime_manager: &Arc<HeadlessRuntimeManager>,
    interactive_runtime_manager: &Arc<InteractiveRuntimeManager>,
    runtime_id: &str,
) -> bool {
    runtime_manager
        .summary(runtime_id)
        .is_some_and(|summary| summary.is_active)
        || interactive_runtime_manager
            .summary(runtime_id)
            .is_some_and(|summary| summary.is_active)
}

fn resolve_active_runtime_for_scope(
    manager: &Arc<TelegramBridgeManager>,
    runtime_manager: &Arc<HeadlessRuntimeManager>,
    interactive_runtime_manager: &Arc<InteractiveRuntimeManager>,
    settings: &TelegramSettings,
    chat_id: i64,
    thread_id: Option<i64>,
    topic_binding: Option<&TelegramTopicBinding>,
) -> Option<String> {
    if let Some(runtime_id) = manager.active_runtime_for_scope(chat_id, thread_id) {
        if runtime_is_active(runtime_manager, interactive_runtime_manager, &runtime_id) {
            return Some(runtime_id);
        }
        manager.clear_runtime_for_scope(chat_id, thread_id, &runtime_id);
    }

    let binding = topic_binding?;
    if let Some(runtime_id) = binding.active_runtime_id.clone() {
        if runtime_is_active(runtime_manager, interactive_runtime_manager, &runtime_id) {
            manager.remember_runtime_for_scope(chat_id, thread_id, runtime_id.clone());
            return Some(runtime_id);
        }
    }

    let env_name = resolve_topic_env_name(settings, binding.preferred_env.as_deref());
    let perm_mode = resolve_topic_perm_mode(settings, binding.preferred_perm_mode.as_deref());
    if let Some(summary) = interactive_runtime_manager.find_active_by_scope(
        &binding.project_dir,
        &env_name,
        &perm_mode,
    ) {
        manager.remember_runtime_for_scope(chat_id, thread_id, summary.session_id.clone());
        if let Some(thread_id) = thread_id {
            let _ = sync_topic_binding_runtime(
                thread_id,
                Some(Some(summary.session_id.clone())),
                Some(summary.claude_session_id.clone()),
            );
        }
        return Some(summary.session_id);
    }

    if let Some(thread_id) = thread_id {
        let _ = sync_topic_binding_runtime(thread_id, Some(None), None);
    }
    None
}

fn generate_telegram_runtime_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("session-telegram-{timestamp}")
}

fn with_telegram_settings_mut<T>(
    update: impl FnOnce(&mut TelegramSettings) -> T,
) -> Result<T, String> {
    let mut settings = read_telegram_settings()?;
    let result = update(&mut settings);
    write_telegram_settings(&settings)?;
    Ok(result)
}

fn sync_topic_binding_runtime(
    thread_id: i64,
    active_runtime_id: Option<Option<String>>,
    last_claude_session_id: Option<Option<String>>,
) -> Result<(), String> {
    with_telegram_settings_mut(|settings| {
        if let Some(binding) = settings
            .topic_bindings
            .iter_mut()
            .find(|binding| binding.thread_id == thread_id)
        {
            if let Some(active_runtime_id) = active_runtime_id {
                binding.active_runtime_id = active_runtime_id;
            }
            if let Some(last_claude_session_id) = last_claude_session_id {
                binding.last_claude_session_id = last_claude_session_id;
            }
        }
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BindCommand {
    project_dir: String,
    preferred_env: Option<String>,
    preferred_perm_mode: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NewTopicCommand {
    project_dir: String,
    preferred_env: Option<String>,
    preferred_perm_mode: Option<String>,
    initial_prompt: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TelegramCreatedForumTopic {
    message_thread_id: i64,
}

#[derive(Debug, Clone, Deserialize)]
struct TelegramSentMessage {
    message_id: i64,
}

fn parse_bind_command(text: &str) -> Result<BindCommand, String> {
    let args = text
        .strip_prefix("/bind")
        .map(str::trim)
        .unwrap_or_default();
    if args.is_empty() {
        return Err("Usage: /bind <project_dir> [env=<name>] [perm=<mode>]".to_string());
    }

    let mut project_parts = Vec::new();
    let mut preferred_env = None;
    let mut preferred_perm_mode = None;

    for token in args.split_whitespace() {
        if let Some(value) = token.strip_prefix("env=") {
            preferred_env = (!value.trim().is_empty()).then(|| value.trim().to_string());
            continue;
        }

        if let Some(value) = token.strip_prefix("perm=") {
            preferred_perm_mode = (!value.trim().is_empty()).then(|| value.trim().to_string());
            continue;
        }

        project_parts.push(token);
    }

    let project_dir = project_parts.join(" ").trim().to_string();
    if project_dir.is_empty() {
        return Err("Topic binding requires a project directory".to_string());
    }

    Ok(BindCommand {
        project_dir: expand_home_dir(&project_dir),
        preferred_env,
        preferred_perm_mode,
    })
}

fn parse_new_topic_command(text: &str) -> Result<NewTopicCommand, String> {
    let args = text.strip_prefix("/new").map(str::trim).unwrap_or_default();
    if args.is_empty() {
        return Err(
            "Usage: /new <project_dir> [env=<name>|<env>] [perm=<mode>] [prompt...]".to_string(),
        );
    }

    let tokens = args.split_whitespace().collect::<Vec<_>>();
    let project_dir = expand_home_dir(tokens[0]);
    let mut preferred_env = None;
    let mut preferred_perm_mode = None;
    let mut prompt_parts = Vec::new();

    for (index, token) in tokens.iter().enumerate().skip(1) {
        if let Some(value) = token.strip_prefix("env=") {
            preferred_env = (!value.trim().is_empty()).then(|| value.trim().to_string());
            continue;
        }

        if let Some(value) = token.strip_prefix("perm=") {
            preferred_perm_mode = (!value.trim().is_empty()).then(|| value.trim().to_string());
            continue;
        }

        if let Some(value) = token.strip_prefix("prompt=") {
            if !value.trim().is_empty() {
                prompt_parts.push(value.trim().to_string());
            }
            prompt_parts.extend(tokens.iter().skip(index + 1).map(|value| value.to_string()));
            break;
        }

        if preferred_env.is_none() && !token.contains('=') {
            preferred_env = Some((*token).to_string());
            continue;
        }

        prompt_parts.push((*token).to_string());
    }

    if project_dir.trim().is_empty() {
        return Err("Project directory is required".to_string());
    }

    Ok(NewTopicCommand {
        project_dir,
        preferred_env,
        preferred_perm_mode,
        initial_prompt: (!prompt_parts.is_empty()).then(|| prompt_parts.join(" ")),
    })
}

fn expand_home_dir(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed == "~" {
        return dirs::home_dir()
            .map(|home| home.to_string_lossy().to_string())
            .unwrap_or_else(|| trimmed.to_string());
    }

    if let Some(remainder) = trimmed.strip_prefix("~/") {
        return dirs::home_dir()
            .map(|home| home.join(remainder).to_string_lossy().to_string())
            .unwrap_or_else(|| trimmed.to_string());
    }

    trimmed.to_string()
}

fn looks_like_project_path(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed == "~"
        || trimmed.starts_with("~/")
        || trimmed.starts_with('/')
        || trimmed.starts_with("./")
        || trimmed.starts_with("../")
        || trimmed.contains('/')
}

fn resolve_topic_env_name(settings: &TelegramSettings, preferred_env: Option<&str>) -> String {
    preferred_env
        .map(ToString::to_string)
        .or_else(|| settings.default_env_name.clone())
        .or_else(|| config::read_config().ok().and_then(|cfg| cfg.current))
        .unwrap_or_else(|| "official".to_string())
}

fn resolve_topic_perm_mode(
    settings: &TelegramSettings,
    preferred_perm_mode: Option<&str>,
) -> String {
    preferred_perm_mode
        .map(ToString::to_string)
        .or_else(|| settings.default_perm_mode.clone())
        .unwrap_or_else(|| "dev".to_string())
}

fn format_topic_title(project_dir: &str, env_name: &str, perm_mode: &str) -> String {
    let project_path = PathBuf::from(project_dir);
    let project_name = project_path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(project_dir);
    let mut title = format!("{project_name} [{env_name}/{perm_mode}]");
    if title.chars().count() > 128 {
        title = title.chars().take(128).collect();
    }
    title
}

fn format_topic_binding(binding: &TelegramTopicBinding) -> String {
    let mut lines = vec![
        format!("Thread: {}", binding.thread_id),
        format!("Project: {}", binding.project_dir),
    ];

    if let Some(env) = binding.preferred_env.as_ref() {
        lines.push(format!("Env: {}", env));
    }
    if let Some(perm) = binding.preferred_perm_mode.as_ref() {
        lines.push(format!("Permission: {}", perm));
    }
    if let Some(runtime_id) = binding.active_runtime_id.as_ref() {
        lines.push(format!("Active runtime: {}", runtime_id));
    }
    if let Some(session_id) = binding.last_claude_session_id.as_ref() {
        lines.push(format!("Last Claude session: {}", session_id));
    }

    lines.join("\n")
}

fn format_topic_command_hint() -> String {
    [
        "Topic commands:",
        "/new <prompt> - start or continue work here",
        "/resume [prompt] - resume the last session for this topic",
        "/topic - show the current binding",
        "/topic clear - remove this binding",
        "/cron list - list cron tasks",
        "",
        "Tip: type / in this topic to open the group command list.",
    ]
    .join("\n")
}

fn format_topic_binding_success_message(binding: &TelegramTopicBinding) -> String {
    format!(
        "Bound this topic to:\n{}\n\n{}",
        format_topic_binding(binding),
        format_topic_command_hint()
    )
}

fn format_new_topic_welcome_message(binding: &TelegramTopicBinding) -> String {
    format!(
        "This topic is ready for {}.\n\n{}",
        compact_project_label(&binding.project_dir),
        format_topic_command_hint()
    )
}

fn format_topic_bindings_message(settings: &TelegramSettings) -> String {
    if settings.topic_bindings.is_empty() {
        return "No Telegram topic bindings configured yet.".to_string();
    }

    settings
        .topic_bindings
        .iter()
        .take(20)
        .map(|binding| {
            let env = binding.preferred_env.as_deref().unwrap_or("current-env");
            let perm = binding
                .preferred_perm_mode
                .as_deref()
                .unwrap_or("app-default");
            format!(
                "#{} · {} · {} · {}",
                binding.thread_id, binding.project_dir, env, perm
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn project_display_name(project_dir: &str) -> String {
    PathBuf::from(project_dir)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(project_dir)
        .to_string()
}

fn compact_project_label(project_dir: &str) -> String {
    let path = expand_home_dir(project_dir);
    let display = dirs::home_dir()
        .and_then(|home| {
            path.strip_prefix(home.to_string_lossy().as_ref())
                .map(|remainder| format!("~{}", remainder))
        })
        .unwrap_or(path);
    let parts = display
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if parts.len() <= 2 {
        return display;
    }
    format!(".../{}/{}", parts[parts.len() - 2], parts[parts.len() - 1])
}

fn ensure_accessible_project_dir(project_dir: &str) -> Result<(), String> {
    let metadata = fs::metadata(project_dir)
        .map_err(|error| format!("Project directory is not accessible: {}", error))?;
    if metadata.is_dir() {
        Ok(())
    } else {
        Err(format!("Project path is not a directory: {}", project_dir))
    }
}

fn remember_forum_topic_from_message(manager: &TelegramBridgeManager, message: &TelegramMessage) {
    let Some(thread_id) = canonical_thread_id(message.message_thread_id) else {
        return;
    };
    let topic_name = message
        .forum_topic_created
        .as_ref()
        .map(|payload| payload.name.clone())
        .or_else(|| {
            message
                .forum_topic_edited
                .as_ref()
                .and_then(|payload| payload.name.clone())
        });
    let icon_color = message
        .forum_topic_created
        .as_ref()
        .and_then(|payload| payload.icon_color);
    manager.remember_forum_topic(thread_id, topic_name, icon_color);
}

fn collect_project_candidates(settings: &TelegramSettings) -> Vec<String> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    let mut push_candidate = |value: String| {
        let normalized = expand_home_dir(&value);
        if normalized.trim().is_empty() {
            return;
        }
        if seen.insert(normalized.clone()) {
            candidates.push(normalized);
        }
    };

    for binding in &settings.topic_bindings {
        push_candidate(binding.project_dir.clone());
    }

    if let Ok(app_config) = config::read_app_config() {
        for favorite in app_config.favorites {
            push_candidate(favorite.path);
        }
        for recent in app_config.recent {
            push_candidate(recent.path);
        }
        if let Some(default_working_dir) = app_config.default_working_dir {
            push_candidate(default_working_dir);
        }
    }

    if let Some(default_working_dir) = settings.default_working_dir.clone() {
        push_candidate(default_working_dir);
    }

    candidates.truncate(TELEGRAM_BIND_PROJECT_LIMIT);
    candidates
}

fn collect_env_candidates() -> Vec<String> {
    let Ok(config) = config::read_config() else {
        return Vec::new();
    };

    let mut names = config.registries.keys().cloned().collect::<Vec<_>>();
    names.sort();

    if let Some(current) = config.current {
        if let Some(index) = names.iter().position(|name| name == &current) {
            let current_name = names.remove(index);
            names.insert(0, current_name);
        }
    }

    names
}

fn build_bind_project_keyboard(project_candidates: &[String]) -> serde_json::Value {
    let mut rows = project_candidates
        .iter()
        .enumerate()
        .map(|(index, project_dir)| {
            vec![serde_json::json!({
                "text": compact_project_label(project_dir),
                "callback_data": format!("bind:project:{index}"),
            })]
        })
        .collect::<Vec<_>>();
    rows.push(vec![serde_json::json!({
        "text": "Enter custom path...",
        "callback_data": "bind:project:custom",
    })]);
    rows.push(vec![serde_json::json!({
        "text": "Cancel",
        "callback_data": "bind:cancel",
    })]);
    serde_json::json!({ "inline_keyboard": rows })
}

fn build_bind_env_keyboard(env_candidates: &[String]) -> serde_json::Value {
    let mut rows = env_candidates
        .iter()
        .map(|env_name| {
            vec![serde_json::json!({
                "text": env_name,
                "callback_data": format!("bind:env:{env_name}"),
            })]
        })
        .collect::<Vec<_>>();
    rows.push(vec![serde_json::json!({
        "text": "Use current app environment",
        "callback_data": "bind:env:__skip__",
    })]);
    rows.push(vec![serde_json::json!({
        "text": "Cancel",
        "callback_data": "bind:cancel",
    })]);
    serde_json::json!({ "inline_keyboard": rows })
}

fn build_bind_perm_keyboard() -> serde_json::Value {
    let mut rows = TELEGRAM_BIND_PERM_MODES
        .iter()
        .map(|perm_mode| {
            vec![serde_json::json!({
                "text": perm_mode,
                "callback_data": format!("bind:perm:{perm_mode}"),
            })]
        })
        .collect::<Vec<_>>();
    rows.push(vec![serde_json::json!({
        "text": "Use app default permission mode",
        "callback_data": "bind:perm:__skip__",
    })]);
    rows.push(vec![serde_json::json!({
        "text": "Cancel",
        "callback_data": "bind:cancel",
    })]);
    serde_json::json!({ "inline_keyboard": rows })
}

fn format_bind_project_prompt_text() -> String {
    "Select a project directory for this topic.".to_string()
}

fn format_bind_env_prompt_text(project_dir: &str) -> String {
    format!(
        "Project: {}\n\nSelect the environment to prefer for this topic.",
        project_dir
    )
}

fn format_bind_perm_prompt_text(project_dir: &str, selected_env: Option<&str>) -> String {
    let env_line = selected_env
        .map(|value| format!("Env: {value}"))
        .unwrap_or_else(|| "Env: use current app environment".to_string());
    format!(
        "Project: {}\n{}\n\nSelect the permission mode to prefer for this topic.",
        project_dir, env_line
    )
}

fn format_bind_custom_project_prompt_text() -> String {
    "Type the project directory in your next message.".to_string()
}

fn get_known_forum_topics_internal(
    manager: &TelegramBridgeManager,
    settings: &TelegramSettings,
) -> Vec<TelegramForumTopic> {
    let cached_topics = manager.known_forum_topics();
    let mut merged = HashMap::<i64, TelegramForumTopic>::new();

    for (thread_id, cached_topic) in cached_topics {
        let bound_project = settings
            .topic_bindings
            .iter()
            .find(|binding| binding.thread_id == thread_id)
            .map(|binding| binding.project_dir.clone());
        let name = cached_topic
            .name
            .clone()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| bound_project.as_deref().map(project_display_name))
            .unwrap_or_else(|| format!("Thread {}", thread_id));
        merged.insert(
            thread_id,
            TelegramForumTopic {
                thread_id,
                name,
                icon_color: cached_topic.icon_color,
                is_bound: bound_project.is_some(),
                bound_project,
            },
        );
    }

    for binding in &settings.topic_bindings {
        merged
            .entry(binding.thread_id)
            .and_modify(|topic| {
                topic.is_bound = true;
                topic.bound_project = Some(binding.project_dir.clone());
                if topic.name.trim().is_empty() || topic.name.starts_with("Thread ") {
                    topic.name = project_display_name(&binding.project_dir);
                }
            })
            .or_insert_with(|| TelegramForumTopic {
                thread_id: binding.thread_id,
                name: project_display_name(&binding.project_dir),
                icon_color: None,
                is_bound: true,
                bound_project: Some(binding.project_dir.clone()),
            });
    }

    let mut topics = merged.into_values().collect::<Vec<_>>();
    topics.sort_by(|left, right| {
        right
            .is_bound
            .cmp(&left.is_bound)
            .then_with(|| left.thread_id.cmp(&right.thread_id))
    });
    topics
}

fn run_bridge_loop(
    manager: Arc<TelegramBridgeManager>,
    app: AppHandle,
    runtime_manager: Arc<HeadlessRuntimeManager>,
    interactive_runtime_manager: Arc<InteractiveRuntimeManager>,
    token: String,
    settings: TelegramSettings,
    username: Option<String>,
) {
    while !manager.stop_flag.load(Ordering::SeqCst) {
        match get_updates(&token, manager.next_update_id()) {
            Ok(updates) => {
                manager.clear_last_error();
                for update in updates {
                    manager.advance_update_id(update.update_id);
                    if let Some(message) = update.message {
                        let effective_settings =
                            read_telegram_settings().unwrap_or_else(|_| settings.clone());
                        if let Err(error) = handle_message(
                            &manager,
                            &app,
                            &runtime_manager,
                            &interactive_runtime_manager,
                            &token,
                            &effective_settings,
                            username.as_deref(),
                            message,
                        ) {
                            manager.set_last_error(error);
                        }
                    }
                    if let Some(callback_query) = update.callback_query {
                        let effective_settings =
                            read_telegram_settings().unwrap_or_else(|_| settings.clone());
                        if let Err(error) = handle_callback_query(
                            &manager,
                            &app,
                            &runtime_manager,
                            &interactive_runtime_manager,
                            &token,
                            &effective_settings,
                            callback_query,
                        ) {
                            manager.set_last_error(error);
                        }
                    }
                }
            }
            Err(error) => {
                manager.set_last_error(error);
                interruptible_sleep(&manager, Duration::from_secs(5));
            }
        }
    }
}

fn interruptible_sleep(manager: &TelegramBridgeManager, duration: Duration) {
    let deadline = Instant::now() + duration;
    loop {
        if manager.stop_flag.load(Ordering::SeqCst) {
            break;
        }
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        let remaining = deadline.saturating_duration_since(now);
        thread::sleep(remaining.min(Duration::from_millis(TELEGRAM_STOP_POLL_INTERVAL_MS)));
    }
}

fn panic_payload_to_string(payload: Box<dyn Any + Send>) -> String {
    match payload.downcast::<String>() {
        Ok(message) => *message,
        Err(payload) => match payload.downcast::<&'static str>() {
            Ok(message) => (*message).to_string(),
            Err(_) => "unknown panic".to_string(),
        },
    }
}

fn handle_message(
    manager: &Arc<TelegramBridgeManager>,
    app: &AppHandle,
    runtime_manager: &Arc<HeadlessRuntimeManager>,
    interactive_runtime_manager: &Arc<InteractiveRuntimeManager>,
    token: &str,
    settings: &TelegramSettings,
    bot_username: Option<&str>,
    message: TelegramMessage,
) -> Result<(), String> {
    if !settings.enabled {
        return Ok(());
    }

    let is_forum_chat = message.chat.is_forum.unwrap_or(false);
    let chat_id = message.chat.id;
    let user_id = message.from.as_ref().map(|sender| sender.id);
    if !is_chat_allowed(settings, chat_id, user_id) {
        return Ok(());
    }
    remember_forum_topic_from_message(manager, &message);
    if !is_sender_allowed(settings, user_id) {
        return Ok(());
    }

    let raw_text = match message.text.as_deref().map(str::trim) {
        Some(text) if !text.is_empty() => text,
        _ => return Ok(()),
    };
    let text = normalize_command_text(raw_text, bot_username);
    let thread_id = canonical_thread_id(message.message_thread_id);
    let topic_binding = find_topic_binding(settings, thread_id).cloned();

    if text == "/start" || text == "/help" {
        send_message(
            token,
            chat_id,
            thread_id,
            "CCEM Telegram bridge is running.\nCommands:\n/help\n/whoami\n/sessions\n/envs\n/new <project_dir> [env=<name>|<env>] [perm=<mode>] [prompt...]\n/resume [prompt]\n/stop [runtime_id]\n/approve <request_id>\n/deny <request_id>\n/topics\n/topic\n/topic clear\n/bind [<project_dir>] [env=<name>] [perm=<mode>]\n/cron list\n/cron toggle <task>\n/cron run <task>\nPlain text in a bound topic will continue or start that topic's project console.",
        )?;
        return Ok(());
    }

    if text == "/whoami" {
        let message = format!(
            "user_id: {}\nchat_id: {}\nthread_id: {}",
            user_id
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unknown".to_string()),
            chat_id,
            thread_id
                .map(|value| value.to_string())
                .unwrap_or_else(|| "none".to_string())
        );
        send_message(token, chat_id, thread_id, &message)?;
        return Ok(());
    }

    if text == "/cron" || text == "/cron help" {
        send_message(
            token,
            chat_id,
            thread_id,
            "Cron commands:\n/cron list\n/cron toggle <task id or prefix>\n/cron run <task id or prefix>",
        )?;
        return Ok(());
    }

    if text == "/cron list" {
        let tasks = cron::list_cron_tasks()?;
        send_message(token, chat_id, thread_id, &format_cron_list_message(&tasks))?;
        return Ok(());
    }

    if text == "/envs" {
        let envs = config::read_config()?;
        let current = envs.current.clone();
        let body = if envs.registries.is_empty() {
            "No environments configured yet.".to_string()
        } else {
            let mut names = envs.registries.keys().cloned().collect::<Vec<_>>();
            names.sort();
            names
                .into_iter()
                .map(|name| {
                    if current.as_deref() == Some(name.as_str()) {
                        format!("• {name} (current)")
                    } else {
                        format!("• {name}")
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        };
        send_message(token, chat_id, thread_id, &body)?;
        return Ok(());
    }

    if let Some(selector) = text.strip_prefix("/cron toggle ").map(str::trim) {
        let task = resolve_cron_task(selector)?;
        let toggled = cron::toggle_cron_task(task.id.clone())?;
        send_message(
            token,
            chat_id,
            thread_id,
            &format!(
                "Cron task {} is now {}.",
                toggled.name,
                if toggled.enabled {
                    "enabled"
                } else {
                    "disabled"
                }
            ),
        )?;
        return Ok(());
    }

    if let Some(selector) = text.strip_prefix("/cron run ").map(str::trim) {
        let task = resolve_cron_task(selector)?;
        let unified_runtime_manager =
            app.state::<Arc<crate::unified_runtime::UnifiedSessionManager>>();
        cron::run_cron_task_now(
            app.clone(),
            unified_runtime_manager.inner().clone(),
            &task.id,
        )?;
        send_message(
            token,
            chat_id,
            thread_id,
            &format!(
                "Running cron task {} now.\nResults will be sent to the configured Telegram notification target.",
                task.name
            ),
        )?;
        return Ok(());
    }

    if text == "/sessions" {
        let mut lines = runtime_manager
            .list_sessions()
            .into_iter()
            .take(12)
            .map(|session| {
                format!(
                    "{} · {} · {} · headless",
                    session.runtime_id, session.status, session.project_dir
                )
            })
            .collect::<Vec<_>>();

        for binding in settings.topic_bindings.iter().take(12) {
            let Some(runtime_id) = binding.active_runtime_id.as_deref() else {
                continue;
            };
            let Some(summary) = interactive_runtime_manager.summary(runtime_id) else {
                continue;
            };
            if !summary.is_active {
                continue;
            }
            lines.push(format!(
                "{} · {} · {} · interactive",
                summary.session_id, summary.status, summary.project_dir
            ));
        }

        let body = if lines.is_empty() {
            "No active sessions.".to_string()
        } else {
            lines.join("\n")
        };
        send_message(token, chat_id, thread_id, &body)?;
        return Ok(());
    }

    if text == "/topics" {
        send_message(
            token,
            chat_id,
            thread_id,
            &format_topic_bindings_message(settings),
        )?;
        return Ok(());
    }

    if text == "/topic" {
        let message = match topic_binding.as_ref() {
            Some(binding) => format_topic_binding(binding),
            None if thread_id.is_some() => {
                "This topic is not bound yet. Use /bind <project_dir> [env=<name>] [perm=<mode>] to attach it to a project."
                    .to_string()
            }
            None => "Send this command inside a Telegram forum topic to inspect its binding."
                .to_string(),
        };
        send_message(token, chat_id, thread_id, &message)?;
        return Ok(());
    }

    if text == "/topic clear" {
        let Some(thread_id) = thread_id else {
            send_message(
                token,
                chat_id,
                thread_id,
                "Topic bindings only work inside Telegram forum topics.",
            )?;
            return Ok(());
        };

        let removed =
            with_telegram_settings_mut(|settings| remove_topic_binding(settings, thread_id))?;
        let message = if removed {
            "Removed the topic binding for this thread."
        } else {
            "This topic does not have a saved binding."
        };
        send_message(token, chat_id, Some(thread_id), message)?;
        return Ok(());
    }

    if !text.starts_with('/') {
        if let Some(thread_id) = thread_id {
            if handle_pending_bind_project_text(manager, token, chat_id, thread_id, &text)? {
                return Ok(());
            }
        }
    }

    if text.starts_with("/bind") {
        let Some(thread_id) = thread_id else {
            send_message(
                token,
                chat_id,
                thread_id,
                "Use /bind from inside a Telegram forum topic so CCEM can map the thread to a project.",
            )?;
            return Ok(());
        };

        let bind_args = text
            .strip_prefix("/bind")
            .map(str::trim)
            .unwrap_or_default();
        if bind_args.is_empty() {
            let project_candidates = collect_project_candidates(settings);
            let message = send_message_with_markup(
                token,
                chat_id,
                Some(thread_id),
                &format_bind_project_prompt_text(),
                Some(build_bind_project_keyboard(&project_candidates)),
            )?;
            set_pending_bind_session(
                manager,
                chat_id,
                thread_id,
                PendingBindSession {
                    message_id: message.message_id,
                    step: BindStep::SelectProject,
                    project_candidates,
                    selected_project: None,
                    selected_env: None,
                },
            )?;
            return Ok(());
        }

        let bind = parse_bind_command(&text)?;
        let binding = save_topic_binding(
            thread_id,
            bind.project_dir.clone(),
            bind.preferred_env.clone(),
            bind.preferred_perm_mode.clone(),
        )?;
        manager.remember_forum_topic(
            thread_id,
            Some(project_display_name(&binding.project_dir)),
            None,
        );
        send_message(
            token,
            chat_id,
            Some(thread_id),
            &format_topic_binding_success_message(&binding),
        )?;
        return Ok(());
    }

    let active_runtime_id = resolve_active_runtime_for_scope(
        manager,
        runtime_manager,
        interactive_runtime_manager,
        settings,
        chat_id,
        thread_id,
        topic_binding.as_ref(),
    );

    if let Some(argument) = text.strip_prefix("/new ").map(str::trim) {
        let should_create_topic = is_forum_chat
            && is_general_topic(thread_id)
            && topic_binding.is_none()
            && looks_like_project_path(argument.split_whitespace().next().unwrap_or_default());

        if should_create_topic {
            match parse_new_topic_command(&text) {
                Ok(command) => {
                    return create_telegram_topic_console(
                        manager,
                        app,
                        runtime_manager,
                        interactive_runtime_manager,
                        token,
                        settings,
                        chat_id,
                        command,
                    );
                }
                Err(error) => {
                    send_message(token, chat_id, thread_id, &error)?;
                    return Ok(());
                }
            }
        }

        if topic_binding.is_some() {
            return create_interactive_telegram_session(
                manager,
                app,
                interactive_runtime_manager,
                token,
                settings,
                chat_id,
                thread_id,
                argument,
                None,
                topic_binding.as_ref(),
            );
        }

        return create_telegram_session(
            manager,
            app,
            runtime_manager,
            token,
            settings,
            chat_id,
            thread_id,
            argument,
            None,
            topic_binding.as_ref(),
        );
    }

    if text == "/new" {
        let usage = if is_forum_chat && is_general_topic(thread_id) && topic_binding.is_none() {
            "Usage: /new <project_dir> [env=<name>|<env>] [perm=<mode>] [prompt...]"
        } else {
            "Usage: /new <prompt>"
        };
        send_message(token, chat_id, thread_id, usage)?;
        return Ok(());
    }

    if let Some(follow_up) = text.strip_prefix("/resume").map(str::trim) {
        let Some(binding) = topic_binding.as_ref() else {
            send_message(
                token,
                chat_id,
                thread_id,
                "This topic is not bound. Bind it first or use /new <prompt>.",
            )?;
            return Ok(());
        };
        let Some(session_id) = binding.last_claude_session_id.clone() else {
            send_message(
                token,
                chat_id,
                thread_id,
                "No saved Claude session is available for this topic yet.",
            )?;
            return Ok(());
        };
        return create_interactive_telegram_session(
            manager,
            app,
            interactive_runtime_manager,
            token,
            settings,
            chat_id,
            thread_id,
            if follow_up.is_empty() { "" } else { follow_up },
            Some(session_id),
            Some(binding),
        );
    }

    if let Some(argument) = text.strip_prefix("/stop").map(str::trim) {
        let runtime_id = if argument.is_empty() {
            active_runtime_id.clone()
        } else {
            Some(argument.to_string())
        };

        if let Some(runtime_id) = runtime_id {
            if runtime_manager.summary(&runtime_id).is_some() {
                runtime_manager.stop_session(app, &runtime_id)?;
            } else {
                interactive_runtime_manager.stop_session(&runtime_id)?;
            }
            send_message(
                token,
                chat_id,
                thread_id,
                &format!("Stopping session {runtime_id}"),
            )?;
        } else {
            send_message(
                token,
                chat_id,
                thread_id,
                "No active Telegram session to stop.",
            )?;
        }
        return Ok(());
    }

    if text == "/approve" {
        send_message(token, chat_id, thread_id, "Usage: /approve <request_id>")?;
        return Ok(());
    }

    if let Some(request_id) = text.strip_prefix("/approve ").map(str::trim) {
        if request_id.is_empty() {
            send_message(token, chat_id, thread_id, "Usage: /approve <request_id>")?;
            return Ok(());
        }
        match runtime_manager.respond_to_permission(app, request_id, true, "telegram") {
            Ok(()) => {
                send_message(
                    token,
                    chat_id,
                    thread_id,
                    &format_permission_command_result(request_id, true, None),
                )?;
            }
            Err(error) => {
                send_message(
                    token,
                    chat_id,
                    thread_id,
                    &format_permission_command_result(request_id, true, Some(&error)),
                )?;
            }
        }
        return Ok(());
    }

    if text == "/deny" {
        send_message(token, chat_id, thread_id, "Usage: /deny <request_id>")?;
        return Ok(());
    }

    if let Some(request_id) = text.strip_prefix("/deny ").map(str::trim) {
        if request_id.is_empty() {
            send_message(token, chat_id, thread_id, "Usage: /deny <request_id>")?;
            return Ok(());
        }
        match runtime_manager.respond_to_permission(app, request_id, false, "telegram") {
            Ok(()) => {
                send_message(
                    token,
                    chat_id,
                    thread_id,
                    &format_permission_command_result(request_id, false, None),
                )?;
            }
            Err(error) => {
                send_message(
                    token,
                    chat_id,
                    thread_id,
                    &format_permission_command_result(request_id, false, Some(&error)),
                )?;
            }
        }
        return Ok(());
    }

    if let Some(runtime_id) = active_runtime_id {
        if runtime_manager.summary(&runtime_id).is_some() {
            runtime_manager.send_user_message(app, &runtime_id, &text)?;
            send_message(
                token,
                chat_id,
                thread_id,
                &format!("Sent follow-up to {runtime_id}"),
            )?;
        } else {
            send_or_queue_interactive_message(
                manager,
                app,
                interactive_runtime_manager,
                token,
                settings,
                chat_id,
                thread_id,
                &runtime_id,
                &text,
            )?;
        }
        return Ok(());
    }

    if let Some(binding) = topic_binding.as_ref() {
        return create_interactive_telegram_session(
            manager,
            app,
            interactive_runtime_manager,
            token,
            settings,
            chat_id,
            thread_id,
            &text,
            binding.last_claude_session_id.clone(),
            Some(binding),
        );
    }

    if is_private_chat_scope(chat_id, user_id) {
        return create_telegram_session(
            manager,
            app,
            runtime_manager,
            token,
            settings,
            chat_id,
            thread_id,
            &text,
            None,
            None,
        );
    }

    send_message(
        token,
        chat_id,
        thread_id,
        "No active Telegram session. Use /new <prompt> to start one.",
    )?;
    Ok(())
}

fn handle_pending_bind_project_text(
    manager: &Arc<TelegramBridgeManager>,
    token: &str,
    chat_id: i64,
    thread_id: i64,
    text: &str,
) -> Result<bool, String> {
    let Some(session) = pending_bind_session(manager, chat_id, thread_id)? else {
        return Ok(false);
    };
    if session.step != BindStep::EnterCustomProject {
        return Ok(false);
    }

    let project_dir = expand_home_dir(text);
    if let Err(error) = ensure_accessible_project_dir(&project_dir) {
        send_message(
            token,
            chat_id,
            Some(thread_id),
            &format!("{error}\nSend another path or tap Cancel above."),
        )?;
        return Ok(true);
    }

    let env_candidates = collect_env_candidates();
    if with_pending_bind_session(manager, chat_id, thread_id, |pending| {
        pending.selected_project = Some(project_dir.clone());
        pending.selected_env = None;
        pending.step = BindStep::SelectEnv;
        Ok(())
    })?
    .is_none()
    {
        send_message(
            token,
            chat_id,
            Some(thread_id),
            "Binding session expired. Run /bind again.",
        )?;
        return Ok(true);
    }

    edit_message_text(
        token,
        chat_id,
        session.message_id,
        &format_bind_env_prompt_text(&project_dir),
        Some(build_bind_env_keyboard(&env_candidates)),
    )?;
    Ok(true)
}

fn handle_bind_cancel_callback(
    manager: &Arc<TelegramBridgeManager>,
    token: &str,
    chat_id: i64,
    thread_id: i64,
    message_id: i64,
    callback_query_id: &str,
) -> Result<(), String> {
    clear_pending_bind_session(manager, chat_id, thread_id)?;
    edit_message_text(token, chat_id, message_id, "Binding cancelled.", None)?;
    answer_callback_query(token, callback_query_id, "Binding cancelled.", false)?;
    Ok(())
}

fn handle_bind_project_callback(
    manager: &Arc<TelegramBridgeManager>,
    token: &str,
    chat_id: i64,
    thread_id: i64,
    message_id: i64,
    callback_query_id: &str,
    selection: &str,
) -> Result<(), String> {
    let Some(session) = pending_bind_session(manager, chat_id, thread_id)? else {
        answer_callback_query(
            token,
            callback_query_id,
            "Binding session expired. Run /bind again.",
            true,
        )?;
        return Ok(());
    };

    if selection == "custom" {
        if with_pending_bind_session(manager, chat_id, thread_id, |pending| {
            pending.step = BindStep::EnterCustomProject;
            Ok(())
        })?
        .is_none()
        {
            answer_callback_query(
                token,
                callback_query_id,
                "Binding session expired. Run /bind again.",
                true,
            )?;
            return Ok(());
        }
        edit_message_text(
            token,
            chat_id,
            message_id,
            &format_bind_custom_project_prompt_text(),
            Some(build_bind_project_keyboard(&session.project_candidates)),
        )?;
        answer_callback_query(
            token,
            callback_query_id,
            "Send the path in your next message.",
            false,
        )?;
        return Ok(());
    }

    let Ok(index) = selection.parse::<usize>() else {
        answer_callback_query(token, callback_query_id, "Unknown project selection.", true)?;
        return Ok(());
    };
    let Some(project_dir) = session.project_candidates.get(index).cloned() else {
        answer_callback_query(token, callback_query_id, "Unknown project selection.", true)?;
        return Ok(());
    };

    let env_candidates = collect_env_candidates();
    if with_pending_bind_session(manager, chat_id, thread_id, |pending| {
        pending.selected_project = Some(project_dir.clone());
        pending.selected_env = None;
        pending.step = BindStep::SelectEnv;
        Ok(())
    })?
    .is_none()
    {
        answer_callback_query(
            token,
            callback_query_id,
            "Binding session expired. Run /bind again.",
            true,
        )?;
        return Ok(());
    }

    edit_message_text(
        token,
        chat_id,
        message_id,
        &format_bind_env_prompt_text(&project_dir),
        Some(build_bind_env_keyboard(&env_candidates)),
    )?;
    answer_callback_query(token, callback_query_id, "Project selected.", false)?;
    Ok(())
}

fn handle_bind_env_callback(
    manager: &Arc<TelegramBridgeManager>,
    token: &str,
    chat_id: i64,
    thread_id: i64,
    message_id: i64,
    callback_query_id: &str,
    selection: &str,
) -> Result<(), String> {
    let env_choice = (selection != "__skip__").then(|| selection.to_string());
    let env_choice_for_update = env_choice.clone();
    let Some((project_dir, selected_env)) =
        with_pending_bind_session(manager, chat_id, thread_id, move |pending| {
            let project_dir = pending
                .selected_project
                .clone()
                .ok_or_else(|| "Choose a project first.".to_string())?;
            pending.selected_env = env_choice_for_update.clone();
            pending.step = BindStep::SelectPerm;
            Ok((project_dir, pending.selected_env.clone()))
        })?
    else {
        answer_callback_query(
            token,
            callback_query_id,
            "Binding session expired. Run /bind again.",
            true,
        )?;
        return Ok(());
    };

    edit_message_text(
        token,
        chat_id,
        message_id,
        &format_bind_perm_prompt_text(&project_dir, selected_env.as_deref()),
        Some(build_bind_perm_keyboard()),
    )?;
    answer_callback_query(token, callback_query_id, "Environment selected.", false)?;
    Ok(())
}

fn handle_bind_perm_callback(
    manager: &Arc<TelegramBridgeManager>,
    token: &str,
    chat_id: i64,
    thread_id: i64,
    message_id: i64,
    callback_query_id: &str,
    selection: &str,
) -> Result<(), String> {
    let Some(session) = pending_bind_session(manager, chat_id, thread_id)? else {
        answer_callback_query(
            token,
            callback_query_id,
            "Binding session expired. Run /bind again.",
            true,
        )?;
        return Ok(());
    };

    let Some(project_dir) = session.selected_project.clone() else {
        answer_callback_query(token, callback_query_id, "Choose a project first.", true)?;
        return Ok(());
    };

    let binding = save_topic_binding(
        thread_id,
        project_dir,
        session.selected_env.clone(),
        (selection != "__skip__").then(|| selection.to_string()),
    )?;
    clear_pending_bind_session(manager, chat_id, thread_id)?;
    manager.remember_forum_topic(
        thread_id,
        Some(project_display_name(&binding.project_dir)),
        None,
    );
    edit_message_text(
        token,
        chat_id,
        message_id,
        &format_topic_binding_success_message(&binding),
        None,
    )?;
    answer_callback_query(token, callback_query_id, "Topic bound.", false)?;
    Ok(())
}

pub fn get_known_forum_topics(
    manager: &Arc<TelegramBridgeManager>,
) -> Result<Vec<TelegramForumTopic>, String> {
    let settings = read_telegram_settings()?;
    Ok(get_known_forum_topics_internal(manager, &settings))
}

pub fn bind_topic_from_desktop(
    manager: &Arc<TelegramBridgeManager>,
    project_dir: String,
    env_name: Option<String>,
    perm_mode: Option<String>,
    thread_id: Option<i64>,
    create_new_topic: bool,
) -> Result<TelegramTopicBinding, String> {
    let settings = read_telegram_settings()?;
    let token = settings
        .bot_token
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Telegram bot token is not configured.".to_string())?
        .to_string();
    let chat_id = settings.allowed_chat_id.ok_or_else(|| {
        "Allowed Chat ID is required before binding a Telegram topic.".to_string()
    })?;
    let project_dir = expand_home_dir(&project_dir);
    ensure_accessible_project_dir(&project_dir)?;

    let target_thread_id = if create_new_topic {
        let topic_title = format_topic_title(
            &project_dir,
            &resolve_topic_env_name(&settings, env_name.as_deref()),
            &resolve_topic_perm_mode(&settings, perm_mode.as_deref()),
        );
        let created_thread_id = create_forum_topic(&token, chat_id, &topic_title)?;
        manager.remember_forum_topic(
            created_thread_id,
            Some(topic_title),
            Some(TELEGRAM_DEFAULT_TOPIC_ICON_COLOR),
        );
        created_thread_id
    } else {
        canonical_thread_id(thread_id)
            .ok_or_else(|| "Choose an existing Telegram topic or create a new one.".to_string())?
    };

    let binding = save_topic_binding(target_thread_id, project_dir, env_name, perm_mode)?;
    manager.remember_forum_topic(
        target_thread_id,
        Some(project_display_name(&binding.project_dir)),
        None,
    );
    send_message(
        &token,
        chat_id,
        Some(target_thread_id),
        &format_topic_binding_success_message(&binding),
    )?;
    Ok(binding)
}

fn handle_callback_query(
    manager: &Arc<TelegramBridgeManager>,
    app: &AppHandle,
    runtime_manager: &Arc<HeadlessRuntimeManager>,
    interactive_runtime_manager: &Arc<InteractiveRuntimeManager>,
    token: &str,
    settings: &TelegramSettings,
    callback_query: TelegramCallbackQuery,
) -> Result<(), String> {
    if !settings.enabled {
        return Ok(());
    }

    let user_id = Some(callback_query.from.id);
    if !is_sender_allowed(settings, user_id) {
        answer_callback_query(
            token,
            &callback_query.id,
            "You are not allowed to control this bot.",
            true,
        )?;
        return Ok(());
    }

    let Some(message) = callback_query.message else {
        answer_callback_query(
            token,
            &callback_query.id,
            "This action is no longer attached to a message.",
            true,
        )?;
        return Ok(());
    };

    let chat_id = message.chat.id;
    if !is_chat_allowed(settings, chat_id, user_id) {
        answer_callback_query(
            token,
            &callback_query.id,
            "This chat is not allowed to control the bot.",
            true,
        )?;
        return Ok(());
    }

    let Some(data) = callback_query.data.as_deref() else {
        answer_callback_query(token, &callback_query.id, "Missing callback payload.", true)?;
        return Ok(());
    };

    if let Some((approved, request_id)) = parse_permission_callback_data(data) {
        if request_id.is_empty() {
            answer_callback_query(token, &callback_query.id, "Missing request id.", true)?;
            return Ok(());
        }

        match runtime_manager.respond_to_permission(app, request_id, approved, "telegram") {
            Ok(()) => {
                answer_callback_query(
                    token,
                    &callback_query.id,
                    if approved {
                        "Permission approved."
                    } else {
                        "Permission denied."
                    },
                    false,
                )?;
            }
            Err(error) => {
                answer_callback_query(
                    token,
                    &callback_query.id,
                    &truncate_for_telegram(&redact_telegram_token(&format!("Failed: {error}"))),
                    true,
                )?;
            }
        }
        return Ok(());
    }

    if let Some((approved, session_id)) = parse_interactive_permission_callback_data(data) {
        if session_id.is_empty() {
            answer_callback_query(token, &callback_query.id, "Missing session id.", true)?;
            return Ok(());
        }

        match interactive_runtime_manager.send_approval(session_id, approved) {
            Ok(()) => {
                let text = if approved {
                    "Interactive approval sent."
                } else {
                    "Interactive denial sent."
                };
                let _ = edit_message_text(token, chat_id, message.message_id, text, None);
                answer_callback_query(token, &callback_query.id, text, false)?;
            }
            Err(error) => {
                answer_callback_query(
                    token,
                    &callback_query.id,
                    &truncate_for_telegram(&redact_telegram_token(&format!("Failed: {error}"))),
                    true,
                )?;
            }
        }
        return Ok(());
    }

    if let Some(option_index) = parse_interactive_tool_select_callback_data(data) {
        return handle_interactive_tool_select_callback(
            manager,
            interactive_runtime_manager,
            token,
            chat_id,
            canonical_thread_id(message.message_thread_id),
            message.message_id,
            &callback_query.id,
            option_index,
        );
    }

    if parse_interactive_tool_submit_callback_data(data) {
        return handle_interactive_tool_submit_callback(
            manager,
            interactive_runtime_manager,
            token,
            chat_id,
            canonical_thread_id(message.message_thread_id),
            message.message_id,
            &callback_query.id,
        );
    }

    if parse_interactive_tool_cancel_callback_data(data) {
        return handle_interactive_tool_cancel_callback(
            manager,
            interactive_runtime_manager,
            token,
            chat_id,
            canonical_thread_id(message.message_thread_id),
            message.message_id,
            &callback_query.id,
        );
    }

    let Some(thread_id) = canonical_thread_id(message.message_thread_id) else {
        answer_callback_query(
            token,
            &callback_query.id,
            "Use this action from inside a Telegram forum topic.",
            true,
        )?;
        return Ok(());
    };

    if data == "bind:cancel" {
        return handle_bind_cancel_callback(
            manager,
            token,
            chat_id,
            thread_id,
            message.message_id,
            &callback_query.id,
        );
    }

    if let Some(selection) = data.strip_prefix("bind:project:") {
        return handle_bind_project_callback(
            manager,
            token,
            chat_id,
            thread_id,
            message.message_id,
            &callback_query.id,
            selection,
        );
    }

    if let Some(selection) = data.strip_prefix("bind:env:") {
        return handle_bind_env_callback(
            manager,
            token,
            chat_id,
            thread_id,
            message.message_id,
            &callback_query.id,
            selection,
        );
    }

    if let Some(selection) = data.strip_prefix("bind:perm:") {
        return handle_bind_perm_callback(
            manager,
            token,
            chat_id,
            thread_id,
            message.message_id,
            &callback_query.id,
            selection,
        );
    }

    answer_callback_query(
        token,
        &callback_query.id,
        "Unsupported callback action.",
        true,
    )?;
    Ok(())
}

fn create_telegram_topic_console(
    manager: &Arc<TelegramBridgeManager>,
    app: &AppHandle,
    runtime_manager: &Arc<HeadlessRuntimeManager>,
    interactive_runtime_manager: &Arc<InteractiveRuntimeManager>,
    token: &str,
    settings: &TelegramSettings,
    chat_id: i64,
    command: NewTopicCommand,
) -> Result<(), String> {
    let metadata = fs::metadata(&command.project_dir)
        .map_err(|error| format!("Project directory is not accessible: {}", error))?;
    if !metadata.is_dir() {
        return Err(format!(
            "Project path is not a directory: {}",
            command.project_dir
        ));
    }

    let env_name = resolve_topic_env_name(settings, command.preferred_env.as_deref());
    let perm_mode = resolve_topic_perm_mode(settings, command.preferred_perm_mode.as_deref());
    let _ = config::resolve_claude_env(&env_name)?;

    if let Some(existing_binding) = find_topic_binding_by_project(
        settings,
        &command.project_dir,
        Some(env_name.as_str()),
        Some(perm_mode.as_str()),
    )
    .cloned()
    {
        if let Some(active_runtime_id) = existing_binding.active_runtime_id.as_ref() {
            if runtime_is_active(
                runtime_manager,
                interactive_runtime_manager,
                active_runtime_id,
            ) {
                send_message(
                    token,
                    chat_id,
                    None,
                    &format!(
                        "Topic #{} already has an active session: {}",
                        existing_binding.thread_id, active_runtime_id
                    ),
                )?;
                return Ok(());
            }
        }

        if let Some(summary) = interactive_runtime_manager.find_active_by_scope(
            &existing_binding.project_dir,
            &env_name,
            &perm_mode,
        ) {
            return attach_existing_interactive_session(
                manager,
                app,
                interactive_runtime_manager,
                token,
                settings,
                chat_id,
                Some(existing_binding.thread_id),
                &summary.session_id,
                command.initial_prompt.as_deref(),
            );
        }

        send_message(
            token,
            chat_id,
            None,
            &format!(
                "Reusing topic #{} for {}.",
                existing_binding.thread_id, existing_binding.project_dir
            ),
        )?;
        return create_interactive_telegram_session(
            manager,
            app,
            interactive_runtime_manager,
            token,
            settings,
            chat_id,
            Some(existing_binding.thread_id),
            command.initial_prompt.as_deref().unwrap_or_default(),
            existing_binding.last_claude_session_id.clone(),
            Some(&existing_binding),
        );
    }

    let thread_id = create_forum_topic(
        token,
        chat_id,
        &format_topic_title(&command.project_dir, &env_name, &perm_mode),
    )?;
    let binding = with_telegram_settings_mut(|settings| {
        let binding = TelegramTopicBinding {
            thread_id,
            project_dir: command.project_dir.clone(),
            preferred_env: Some(env_name.clone()),
            preferred_perm_mode: Some(perm_mode.clone()),
            active_runtime_id: None,
            last_claude_session_id: None,
            created_at: Utc::now(),
        };
        upsert_topic_binding(settings, binding.clone());
        binding
    })?;

    send_message(
        token,
        chat_id,
        None,
        &format!(
            "Created topic #{} for {}.\nStarting the project console there.",
            thread_id, binding.project_dir
        ),
    )?;

    send_message(
        token,
        chat_id,
        Some(thread_id),
        &format_new_topic_welcome_message(&binding),
    )?;

    create_interactive_telegram_session(
        manager,
        app,
        interactive_runtime_manager,
        token,
        settings,
        chat_id,
        Some(thread_id),
        command.initial_prompt.as_deref().unwrap_or_default(),
        None,
        Some(&binding),
    )
}

#[allow(clippy::too_many_arguments)]
fn create_telegram_session(
    manager: &Arc<TelegramBridgeManager>,
    app: &AppHandle,
    runtime_manager: &Arc<HeadlessRuntimeManager>,
    token: &str,
    settings: &TelegramSettings,
    chat_id: i64,
    thread_id: Option<i64>,
    prompt: &str,
    resume_session_id: Option<String>,
    binding: Option<&TelegramTopicBinding>,
) -> Result<(), String> {
    let thread_id = canonical_thread_id(thread_id);
    let env_name = binding
        .and_then(|binding| binding.preferred_env.clone())
        .or_else(|| settings.default_env_name.clone())
        .clone()
        .or_else(|| config::read_config().ok().and_then(|cfg| cfg.current))
        .unwrap_or_else(|| "official".to_string());
    let perm_mode = binding
        .and_then(|binding| binding.preferred_perm_mode.clone())
        .or_else(|| settings.default_perm_mode.clone())
        .clone()
        .unwrap_or_else(|| "dev".to_string());
    let working_dir = binding
        .map(|binding| binding.project_dir.clone())
        .or_else(|| settings.default_working_dir.clone())
        .clone()
        .or_else(config::get_default_working_dir)
        .or_else(|| dirs::home_dir().map(|path| path.to_string_lossy().to_string()))
        .unwrap_or_else(|| ".".to_string());
    let resolved = config::resolve_claude_env(&env_name)?;

    let summary = runtime_manager.create_session(
        app.clone(),
        HeadlessSessionOptions {
            env_name: resolved.env_name,
            perm_mode,
            working_dir: working_dir.clone(),
            resume_session_id,
            initial_prompt: (!prompt.trim().is_empty()).then(|| prompt.to_string()),
            max_budget_usd: None,
            allowed_tools: Vec::new(),
            disallowed_tools: Vec::new(),
            env_vars: resolved.env_vars,
            source: HeadlessSessionSource::Telegram {
                chat_id,
                thread_id: thread_id.unwrap_or(0),
            },
        },
    )?;

    manager.remember_runtime_for_scope(chat_id, thread_id, summary.runtime_id.clone());
    if let Some(thread_id) = thread_id {
        let _ = sync_topic_binding_runtime(thread_id, Some(Some(summary.runtime_id.clone())), None);
    }
    send_message(
        token,
        chat_id,
        thread_id,
        &format!(
            "Started {} in {}\nI will reply here when Claude responds.",
            summary.runtime_id, working_dir
        ),
    )?;

    let manager = Arc::clone(manager);
    let runtime_manager = Arc::clone(runtime_manager);
    let token = token.to_string();
    let runtime_id = summary.runtime_id.clone();
    let app_handle = app.clone();
    if settings.use_channel_monitor {
        let channel = Arc::new(TelegramChannel::headless(
            Arc::clone(&manager),
            token.clone(),
            settings.clone(),
            runtime_id.clone(),
            chat_id,
            thread_id,
        ));
        attach_telegram_output_channel(app, &runtime_id, channel.clone())?;
        replay_headless_events_to_channel(&runtime_manager, &runtime_id, channel.as_ref());
        thread::spawn(move || {
            monitor_session_completion_with_channel(
                manager,
                app_handle,
                runtime_manager,
                token,
                chat_id,
                thread_id,
                runtime_id,
                channel,
            );
        });
    } else {
        thread::spawn(move || {
            monitor_session_completion(
                manager,
                app_handle,
                runtime_manager,
                token,
                chat_id,
                thread_id,
                runtime_id,
            );
        });
    }

    Ok(())
}

fn handle_interactive_tool_select_callback(
    manager: &Arc<TelegramBridgeManager>,
    interactive_runtime_manager: &Arc<InteractiveRuntimeManager>,
    token: &str,
    chat_id: i64,
    thread_id: Option<i64>,
    message_id: i64,
    callback_query_id: &str,
    option_index: usize,
) -> Result<(), String> {
    let Some(prompt) = manager.active_prompt_for_scope(chat_id, thread_id) else {
        answer_callback_query(
            token,
            callback_query_id,
            "This interactive question is no longer active.",
            true,
        )?;
        return Ok(());
    };

    match prompt {
        ActiveInteractivePrompt::Choice(active_prompt) => {
            let Some(question) = active_choice_question(&active_prompt).cloned() else {
                answer_callback_query(
                    token,
                    callback_query_id,
                    "This interactive question is no longer available.",
                    true,
                )?;
                return Ok(());
            };

            if option_index == 0 || option_index > question.options.len() {
                answer_callback_query(token, callback_query_id, "Unknown option.", true)?;
                return Ok(());
            }

            let option = &question.options[option_index - 1];
            if is_chat_about_this_option(&option.label) {
                select_chat_about_this(
                    interactive_runtime_manager,
                    &active_prompt.runtime_id,
                    question.options.len().saturating_sub(1),
                )?;
                manager.clear_active_prompt_for_scope(chat_id, thread_id);
                let _ = edit_message_text(
                    token,
                    chat_id,
                    message_id,
                    "Selected `Chat about this` via Telegram.\nClaude will switch to clarification mode.",
                    None,
                );
                answer_callback_query(
                    token,
                    callback_query_id,
                    "Switched to clarification mode.",
                    false,
                )?;
                return Ok(());
            }

            if question.multi_select {
                if is_vscode_text_entry_option(&option.label) {
                    if active_prompt.selected_options.contains(&option_index)
                        && active_prompt.awaiting_text_entry.is_none()
                    {
                        answer_callback_query(
                            token,
                            callback_query_id,
                            "Text answer already captured. Choose more options or tap Submit.",
                            false,
                        )?;
                        return Ok(());
                    }

                    // Update Telegram state and message BEFORE TUI interaction
                    // so the user always sees the text entry prompt even if TUI keys fail
                    let _ = manager.mutate_active_prompt_for_scope(chat_id, thread_id, |prompt| {
                        match prompt {
                            ActiveInteractivePrompt::Choice(prompt) => {
                                prompt.selected_options.insert(option_index);
                                prompt.awaiting_text_entry = Some(option_index);
                            }
                        }
                    });
                    if let Err(err) = edit_message_text(
                        token,
                        chat_id,
                        message_id,
                        &format!(
                            "{}\n\nText entry mode selected. Send your answer as a normal Telegram message, then tap Submit to finish this question.",
                            format_active_choice_text(&active_prompt)
                        ),
                        Some(build_text_entry_markup()),
                    ) {
                        eprintln!("[telegram] edit_message_text failed for Type something prompt: {err}");
                    }
                    answer_callback_query(
                        token,
                        callback_query_id,
                        "✏️ Text entry enabled. Send your answer as a normal message, then tap Submit.",
                        true,
                    )?;
                    if let Err(err) = enter_multi_select_text_entry_mode(
                        interactive_runtime_manager,
                        &active_prompt.runtime_id,
                        option_index,
                    ) {
                        eprintln!("[telegram] enter_multi_select_text_entry_mode failed: {err}");
                    }
                    return Ok(());
                }

                let selected_options = manager
                    .mutate_active_prompt_for_scope(chat_id, thread_id, |prompt| match prompt {
                        ActiveInteractivePrompt::Choice(prompt) => {
                            if prompt.selected_options.contains(&option_index) {
                                prompt.selected_options.remove(&option_index);
                            } else {
                                prompt.selected_options.insert(option_index);
                            }
                            prompt.selected_options.clone()
                        }
                    })
                    .unwrap_or_default();

                let mut preview_prompt = active_prompt.clone();
                preview_prompt.selected_options = selected_options.clone();
                let text = format_active_choice_text(&preview_prompt);
                let markup = build_active_choice_markup(&preview_prompt);
                let _ = edit_message_text(token, chat_id, message_id, &text, Some(markup));
                answer_callback_query(token, callback_query_id, "Selection updated.", false)?;
                return Ok(());
            }

            if is_vscode_text_entry_option(&option.label) {
                // Update Telegram state and message BEFORE TUI interaction
                let _ =
                    manager.mutate_active_prompt_for_scope(
                        chat_id,
                        thread_id,
                        |prompt| match prompt {
                            ActiveInteractivePrompt::Choice(prompt) => {
                                prompt.awaiting_text_entry = Some(option_index);
                                prompt.selected_options.clear();
                            }
                        },
                    );
                if let Err(err) = edit_message_text(
                    token,
                    chat_id,
                    message_id,
                    &format!(
                        "{}\n\nText entry mode selected. Send your answer as a normal Telegram message, and CCEM will submit it to Claude.",
                        format_active_choice_text(&active_prompt)
                    ),
                    Some(build_text_entry_markup()),
                ) {
                    eprintln!("[telegram] edit_message_text failed for Type something prompt: {err}");
                }
                answer_callback_query(
                    token,
                    callback_query_id,
                    "✏️ Text entry enabled. Send your answer as a normal message.",
                    true,
                )?;
                if let Err(err) = enter_text_entry_mode(
                    interactive_runtime_manager,
                    &active_prompt.runtime_id,
                    option_index,
                ) {
                    eprintln!("[telegram] enter_text_entry_mode failed: {err}");
                }
                return Ok(());
            }

            submit_choice_answer(
                interactive_runtime_manager,
                &active_prompt.runtime_id,
                active_prompt.submit_mode,
                option_index,
                active_prompt.questions.len(),
            )?;
            let has_next_question =
                active_prompt.current_question_index + 1 < active_prompt.questions.len();
            if has_next_question {
                let next_prompt = manager.mutate_active_prompt_for_scope(
                    chat_id,
                    thread_id,
                    |prompt| match prompt {
                        ActiveInteractivePrompt::Choice(prompt) => {
                            advance_active_choice_prompt(prompt);
                            prompt.clone()
                        }
                    },
                );

                if let Some(next_prompt) = next_prompt {
                    if let Err(err) = edit_message_text(
                        token,
                        chat_id,
                        message_id,
                        &format_active_choice_text(&next_prompt),
                        Some(build_active_choice_markup(&next_prompt)),
                    ) {
                        eprintln!("[telegram] edit_message_text failed for next question after single-select: {err}");
                    }
                }
                answer_callback_query(
                    token,
                    callback_query_id,
                    "Answer submitted. Next question ready.",
                    false,
                )?;
            } else {
                manager.clear_active_prompt_for_scope(chat_id, thread_id);
                if let Err(err) = edit_message_text(
                    token,
                    chat_id,
                    message_id,
                    &format!("Submitted answer via Telegram.\n{}", option.label.trim()),
                    None,
                ) {
                    eprintln!("[telegram] edit_message_text failed for final submit: {err}");
                }
                answer_callback_query(token, callback_query_id, "Answer submitted.", false)?;
            }
        }
    }

    Ok(())
}

fn handle_interactive_tool_submit_callback(
    manager: &Arc<TelegramBridgeManager>,
    interactive_runtime_manager: &Arc<InteractiveRuntimeManager>,
    token: &str,
    chat_id: i64,
    thread_id: Option<i64>,
    message_id: i64,
    callback_query_id: &str,
) -> Result<(), String> {
    let Some(prompt) = manager.active_prompt_for_scope(chat_id, thread_id) else {
        answer_callback_query(
            token,
            callback_query_id,
            "This interactive question is no longer active.",
            true,
        )?;
        return Ok(());
    };

    match prompt {
        ActiveInteractivePrompt::Choice(active_prompt) => {
            let Some(question) = active_choice_question(&active_prompt).cloned() else {
                answer_callback_query(
                    token,
                    callback_query_id,
                    "This interactive question is no longer available.",
                    true,
                )?;
                return Ok(());
            };

            if !question.multi_select {
                answer_callback_query(token, callback_query_id, "Pick one option directly.", true)?;
                return Ok(());
            }

            if active_prompt.awaiting_text_entry.is_some() {
                answer_callback_query(
                    token,
                    callback_query_id,
                    "Send your custom text answer first, then tap Submit.",
                    true,
                )?;
                return Ok(());
            }

            if active_prompt.selected_options.is_empty() {
                answer_callback_query(
                    token,
                    callback_query_id,
                    "Pick at least one option before submitting.",
                    true,
                )?;
                return Ok(());
            }

            let submit_options =
                selection_submit_options(&question, &active_prompt.selected_options);

            submit_multi_select_answer(
                interactive_runtime_manager,
                &active_prompt.runtime_id,
                &submit_options,
            )?;
            let selected_labels = active_prompt
                .selected_options
                .iter()
                .filter_map(|index| question.options.get(index.saturating_sub(1)))
                .map(|option| option.label.clone())
                .collect::<Vec<_>>()
                .join(", ");
            let has_next_question =
                active_prompt.current_question_index + 1 < active_prompt.questions.len();
            eprintln!(
                "[telegram] multi-select submit: question_index={}, questions_len={}, has_next={}",
                active_prompt.current_question_index,
                active_prompt.questions.len(),
                has_next_question,
            );
            if has_next_question {
                let next_prompt = manager.mutate_active_prompt_for_scope(
                    chat_id,
                    thread_id,
                    |prompt| match prompt {
                        ActiveInteractivePrompt::Choice(prompt) => {
                            advance_active_choice_prompt(prompt);
                            prompt.clone()
                        }
                    },
                );
                if let Some(next_prompt) = next_prompt {
                    if let Err(err) = edit_message_text(
                        token,
                        chat_id,
                        message_id,
                        &format_active_choice_text(&next_prompt),
                        Some(build_active_choice_markup(&next_prompt)),
                    ) {
                        eprintln!("[telegram] edit_message_text failed for next question after multi-select submit: {err}");
                    }
                }
                answer_callback_query(
                    token,
                    callback_query_id,
                    "Answers submitted. Next question ready.",
                    false,
                )?;
            } else {
                manager.clear_active_prompt_for_scope(chat_id, thread_id);
                if let Err(err) = edit_message_text(
                    token,
                    chat_id,
                    message_id,
                    &format!("Submitted answers via Telegram.\n{}", selected_labels),
                    None,
                ) {
                    eprintln!(
                        "[telegram] edit_message_text failed for multi-select final submit: {err}"
                    );
                }
                answer_callback_query(token, callback_query_id, "Answers submitted.", false)?;
            }
        }
    }

    Ok(())
}

fn handle_interactive_tool_cancel_callback(
    manager: &Arc<TelegramBridgeManager>,
    interactive_runtime_manager: &Arc<InteractiveRuntimeManager>,
    token: &str,
    chat_id: i64,
    thread_id: Option<i64>,
    message_id: i64,
    callback_query_id: &str,
) -> Result<(), String> {
    let Some(prompt) = manager.clear_active_prompt_for_scope(chat_id, thread_id) else {
        answer_callback_query(
            token,
            callback_query_id,
            "This interactive question is no longer active.",
            true,
        )?;
        return Ok(());
    };

    interactive_runtime_manager.write_input(active_prompt_runtime_id(&prompt), "\u{1b}")?;
    let _ = edit_message_text(
        token,
        chat_id,
        message_id,
        "Interactive question cancelled.",
        None,
    );
    answer_callback_query(token, callback_query_id, "Cancelled.", false)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn create_interactive_telegram_session(
    manager: &Arc<TelegramBridgeManager>,
    app: &AppHandle,
    interactive_runtime_manager: &Arc<InteractiveRuntimeManager>,
    token: &str,
    settings: &TelegramSettings,
    chat_id: i64,
    thread_id: Option<i64>,
    prompt: &str,
    resume_session_id: Option<String>,
    binding: Option<&TelegramTopicBinding>,
) -> Result<(), String> {
    let thread_id = canonical_thread_id(thread_id);
    let env_name = binding
        .and_then(|binding| binding.preferred_env.clone())
        .or_else(|| settings.default_env_name.clone())
        .or_else(|| config::read_config().ok().and_then(|cfg| cfg.current))
        .unwrap_or_else(|| "official".to_string());
    let perm_mode = binding
        .and_then(|binding| binding.preferred_perm_mode.clone())
        .or_else(|| settings.default_perm_mode.clone())
        .unwrap_or_else(|| "dev".to_string());
    let working_dir = binding
        .map(|binding| binding.project_dir.clone())
        .or_else(|| settings.default_working_dir.clone())
        .or_else(config::get_default_working_dir)
        .or_else(|| dirs::home_dir().map(|path| path.to_string_lossy().to_string()))
        .unwrap_or_else(|| ".".to_string());
    let resolved = config::resolve_claude_env(&env_name)?;
    let session_manager = app.state::<Arc<SessionManager>>().inner().clone();
    let runtime_id = generate_telegram_runtime_id();
    let resume_target = resume_session_id.clone();

    let session = interactive_runtime_manager.create_session(
        app.clone(),
        session_manager,
        InteractiveSessionOptions {
            session_id: runtime_id.clone(),
            client: "claude".to_string(),
            env_name: resolved.env_name,
            config_source: Some("ccem".to_string()),
            perm_mode,
            working_dir: working_dir.clone(),
            resume_session_id,
            initial_prompt: None,
            env_vars: resolved.env_vars,
            launch_trace_id: format!("telegram-{}", runtime_id),
        },
    )?;

    if let Some(session_id) = resume_target.as_deref() {
        let _ = clear_runtime_recovery_candidates_by_claude_session_id(session_id);
    }

    manager.remember_runtime_for_scope(chat_id, thread_id, session.id.clone());
    if let Some(thread_id) = thread_id {
        let _ = sync_topic_binding_runtime(thread_id, Some(Some(session.id.clone())), None);
    }

    let status_message = if prompt.trim().is_empty() {
        format!(
            "Attached interactive session {} in {}.",
            session.id, working_dir
        )
    } else {
        format!(
            "Started interactive session {} in {}.\nSending your prompt now.",
            session.id, working_dir
        )
    };
    send_message(token, chat_id, thread_id, &status_message)?;

    ensure_interactive_monitor(
        manager,
        app,
        interactive_runtime_manager,
        token,
        settings,
        chat_id,
        thread_id,
        &session.id,
    );

    if !prompt.trim().is_empty() {
        interactive_runtime_manager.send_message(&session.id, prompt)?;
    }

    Ok(())
}

fn attach_existing_interactive_session(
    manager: &Arc<TelegramBridgeManager>,
    app: &AppHandle,
    interactive_runtime_manager: &Arc<InteractiveRuntimeManager>,
    token: &str,
    settings: &TelegramSettings,
    chat_id: i64,
    thread_id: Option<i64>,
    runtime_id: &str,
    prompt: Option<&str>,
) -> Result<(), String> {
    let thread_id = canonical_thread_id(thread_id);
    manager.remember_runtime_for_scope(chat_id, thread_id, runtime_id.to_string());
    if let Some(thread_id) = thread_id {
        let _ = sync_topic_binding_runtime(thread_id, Some(Some(runtime_id.to_string())), None);
    }

    ensure_interactive_monitor(
        manager,
        app,
        interactive_runtime_manager,
        token,
        settings,
        chat_id,
        thread_id,
        runtime_id,
    );

    if let Some(prompt) = prompt.filter(|value| !value.trim().is_empty()) {
        send_or_queue_interactive_message(
            manager,
            app,
            interactive_runtime_manager,
            token,
            settings,
            chat_id,
            thread_id,
            runtime_id,
            prompt,
        )?;
    } else {
        send_message(
            token,
            chat_id,
            thread_id,
            &format!("Attached to existing interactive session {runtime_id}."),
        )?;
    }

    Ok(())
}

fn ensure_interactive_monitor(
    manager: &Arc<TelegramBridgeManager>,
    app: &AppHandle,
    interactive_runtime_manager: &Arc<InteractiveRuntimeManager>,
    token: &str,
    settings: &TelegramSettings,
    chat_id: i64,
    thread_id: Option<i64>,
    runtime_id: &str,
) {
    let thread_id = canonical_thread_id(thread_id);
    if !manager.ensure_interactive_monitor_for_scope(chat_id, thread_id, runtime_id) {
        return;
    }

    let manager = Arc::clone(manager);
    let interactive_runtime_manager = Arc::clone(interactive_runtime_manager);
    let token = token.to_string();
    let runtime_id = runtime_id.to_string();
    let settings = settings.clone();
    let app_handle = app.clone();
    if settings.use_channel_monitor {
        let channel = Arc::new(TelegramChannel::interactive(
            Arc::clone(&manager),
            token.clone(),
            settings.clone(),
            runtime_id.clone(),
            chat_id,
            thread_id,
        ));
        if attach_telegram_output_channel(app, &runtime_id, channel.clone()).is_err() {
            return;
        }
        replay_interactive_events_to_channel(
            &interactive_runtime_manager,
            &runtime_id,
            channel.as_ref(),
        );
        thread::spawn(move || {
            monitor_interactive_session_with_channel(
                manager,
                app_handle,
                interactive_runtime_manager,
                token,
                chat_id,
                thread_id,
                runtime_id,
                channel,
            );
        });
    } else {
        thread::spawn(move || {
            monitor_interactive_session(
                manager,
                interactive_runtime_manager,
                token,
                settings,
                chat_id,
                thread_id,
                runtime_id,
            );
        });
    }
}

fn send_or_queue_interactive_message(
    manager: &Arc<TelegramBridgeManager>,
    app: &AppHandle,
    interactive_runtime_manager: &Arc<InteractiveRuntimeManager>,
    token: &str,
    settings: &TelegramSettings,
    chat_id: i64,
    thread_id: Option<i64>,
    runtime_id: &str,
    text: &str,
) -> Result<(), String> {
    ensure_interactive_monitor(
        manager,
        app,
        interactive_runtime_manager,
        token,
        settings,
        chat_id,
        thread_id,
        runtime_id,
    );

    if let Some(ActiveInteractivePrompt::Choice(prompt)) =
        manager.active_prompt_for_scope(chat_id, thread_id)
    {
        if prompt.awaiting_text_entry.is_some() {
            let current_question = active_choice_question(&prompt).cloned();
            let is_multi_select = current_question
                .as_ref()
                .is_some_and(|question| question.multi_select);
            eprintln!(
                "[telegram] text entry submit: question_index={}, questions_len={}, multi_select={}, current_question_exists={}",
                prompt.current_question_index,
                prompt.questions.len(),
                is_multi_select,
                current_question.is_some(),
            );
            submit_text_entry_answer(interactive_runtime_manager, runtime_id, text)?;
            if is_multi_select {
                let updated_prompt = manager.mutate_active_prompt_for_scope(
                    chat_id,
                    thread_id,
                    |prompt| match prompt {
                        ActiveInteractivePrompt::Choice(prompt) => {
                            prompt.awaiting_text_entry = None;
                            prompt.clone()
                        }
                    },
                );

                if let Some(updated_prompt) = updated_prompt {
                    if let Some(message_id) = updated_prompt.message_id {
                        if let Err(err) = edit_message_text(
                            token,
                            chat_id,
                            message_id,
                            &format!(
                                "{}\n\nText answer saved. Choose more options or tap Submit when ready.",
                                format_active_choice_text(&updated_prompt)
                            ),
                            Some(build_active_choice_markup(&updated_prompt)),
                        ) {
                            eprintln!("[telegram] edit_message_text failed after multi-select text entry: {err}");
                        }
                    }
                }
                send_message(
                    token,
                    chat_id,
                    thread_id,
                    "Text answer saved. Choose more options or tap Submit when ready.",
                )?;
            } else {
                let has_next_question = prompt.current_question_index + 1 < prompt.questions.len();
                if has_next_question {
                    let next_prompt =
                        manager.mutate_active_prompt_for_scope(chat_id, thread_id, |prompt| {
                            match prompt {
                                ActiveInteractivePrompt::Choice(prompt) => {
                                    advance_active_choice_prompt(prompt);
                                    prompt.clone()
                                }
                            }
                        });

                    if let Some(next_prompt) = next_prompt {
                        if let Some(message_id) = next_prompt.message_id {
                            if let Err(err) = edit_message_text(
                                token,
                                chat_id,
                                message_id,
                                &format_active_choice_text(&next_prompt),
                                Some(build_active_choice_markup(&next_prompt)),
                            ) {
                                eprintln!("[telegram] edit_message_text failed for next question after text entry: {err}");
                            }
                        }
                    }
                    send_message(
                        token,
                        chat_id,
                        thread_id,
                        "Text answer submitted. Continue with the next question.",
                    )?;
                } else {
                    // TUI auto-navigated to Submit tab, press Enter to submit the form
                    send_interactive_input_sequence(
                        interactive_runtime_manager,
                        runtime_id,
                        &[("\r", Duration::from_millis(0))],
                    )?;
                    manager.clear_active_prompt_for_scope(chat_id, thread_id);
                    if let Some(message_id) = prompt.message_id {
                        if let Err(err) = edit_message_text(
                            token,
                            chat_id,
                            message_id,
                            &format!(
                                "Submitted text answer via Telegram.\n{}",
                                truncate_for_telegram(text)
                            ),
                            None,
                        ) {
                            eprintln!("[telegram] edit_message_text failed for final text entry submit: {err}");
                        }
                    }
                    send_message(
                        token,
                        chat_id,
                        thread_id,
                        &format!("Sent text answer to interactive question in {runtime_id}"),
                    )?;
                }
            }
            return Ok(());
        }

        let current_question = active_choice_question(&prompt).cloned();
        send_message(
            token,
            chat_id,
            thread_id,
            if current_question
                .as_ref()
                .is_some_and(|question| question.options.is_empty())
            {
                "Claude is waiting for an interactive answer that currently requires local terminal / VS Code interaction. Finish that prompt locally before sending a new follow-up."
            } else {
                "Claude is waiting for an interactive answer. Use the buttons in the active question message before sending a new follow-up."
            },
        )?;
        return Ok(());
    }

    match interactive_runtime_manager.get_state(runtime_id)? {
        ClaudeTerminalState::Idle => {
            interactive_runtime_manager.send_message(runtime_id, text)?;
            send_message(
                token,
                chat_id,
                thread_id,
                &format!("Sent follow-up to {runtime_id}"),
            )?;
        }
        ClaudeTerminalState::WaitingApproval => {
            send_message(
                token,
                chat_id,
                thread_id,
                "Claude is waiting for approval. Approve or deny the request before sending a new message.",
            )?;
        }
        ClaudeTerminalState::Processing | ClaudeTerminalState::Unknown => {
            let position = manager.queue_interactive_message(chat_id, thread_id, text.to_string());
            let suffix = if position > 0 {
                format!(" (position {position})")
            } else {
                String::new()
            };
            send_message(
                token,
                chat_id,
                thread_id,
                &format!("Claude is busy. Queued your message for {runtime_id}{suffix}"),
            )?;
        }
    }

    Ok(())
}

fn attach_telegram_output_channel(
    app: &AppHandle,
    runtime_id: &str,
    channel: Arc<TelegramChannel>,
) -> Result<(), String> {
    let unified_runtime_manager = app.state::<Arc<crate::unified_runtime::UnifiedSessionManager>>();
    unified_runtime_manager
        .inner()
        .attach_output_channel(runtime_id, channel)
}

fn replay_headless_events_to_channel(
    runtime_manager: &Arc<HeadlessRuntimeManager>,
    runtime_id: &str,
    channel: &TelegramChannel,
) {
    let Ok(batch) = runtime_manager.replay_events(runtime_id, None) else {
        return;
    };

    for event in batch.events {
        let _ = channel.send_event(&event);
    }
}

fn replay_interactive_events_to_channel(
    interactive_runtime_manager: &Arc<InteractiveRuntimeManager>,
    runtime_id: &str,
    channel: &TelegramChannel,
) {
    let Ok(batch) = interactive_runtime_manager.replay_events(runtime_id, None) else {
        return;
    };

    for event in batch.events {
        let _ = channel.send_event(&event);
    }
}

fn detach_telegram_output_channel(
    app: &AppHandle,
    runtime_id: &str,
    chat_id: i64,
    thread_id: Option<i64>,
) {
    let unified_runtime_manager = app.state::<Arc<crate::unified_runtime::UnifiedSessionManager>>();
    let _ = unified_runtime_manager.inner().detach_channel(
        runtime_id,
        &crate::channel::ChannelKind::Telegram { chat_id, thread_id },
    );
}

fn monitor_session_completion_with_channel(
    manager: Arc<TelegramBridgeManager>,
    app: AppHandle,
    runtime_manager: Arc<HeadlessRuntimeManager>,
    token: String,
    chat_id: i64,
    thread_id: Option<i64>,
    runtime_id: String,
    channel: Arc<TelegramChannel>,
) {
    let started = Instant::now();
    let timeout = Duration::from_secs(60 * 15);

    loop {
        if manager.stop_flag.load(Ordering::SeqCst) {
            break;
        }

        if started.elapsed() > timeout {
            let _ = runtime_manager.stop_session(&app, &runtime_id);
            channel.flush_if_due(true);
            let _ = send_message(
                &token,
                chat_id,
                thread_id,
                &format!("Session {runtime_id} timed out while waiting for completion."),
            );
            manager.clear_runtime_for_scope(chat_id, thread_id, &runtime_id);
            if let Some(thread_id) = thread_id {
                let _ = sync_topic_binding_runtime(thread_id, Some(None), None);
            }
            detach_telegram_output_channel(&app, &runtime_id, chat_id, thread_id);
            break;
        }

        channel.flush_if_due(false);

        match runtime_manager.summary(&runtime_id) {
            Some(summary)
                if !summary.is_active
                    || matches!(summary.status.as_str(), "completed" | "stopped" | "error") =>
            {
                channel.flush_if_due(true);
                if matches!(summary.status.as_str(), "stopped" | "error") {
                    let message = format_result_message(&runtime_id, &summary.status, "", "");
                    let _ = send_message(&token, chat_id, thread_id, &message);
                }
                let _ = runtime_manager.remove_session(&runtime_id);
                manager.clear_runtime_for_scope(chat_id, thread_id, &runtime_id);
                if let Some(thread_id) = thread_id {
                    let _ = sync_topic_binding_runtime(
                        thread_id,
                        Some(None),
                        Some(summary.claude_session_id.clone()),
                    );
                }
                detach_telegram_output_channel(&app, &runtime_id, chat_id, thread_id);
                break;
            }
            Some(_) => {
                thread::sleep(Duration::from_millis(700));
            }
            None => {
                channel.flush_if_due(true);
                manager.clear_runtime_for_scope(chat_id, thread_id, &runtime_id);
                if let Some(thread_id) = thread_id {
                    let _ = sync_topic_binding_runtime(thread_id, Some(None), None);
                }
                detach_telegram_output_channel(&app, &runtime_id, chat_id, thread_id);
                break;
            }
        }
    }
}

fn monitor_interactive_session_with_channel(
    manager: Arc<TelegramBridgeManager>,
    app: AppHandle,
    interactive_runtime_manager: Arc<InteractiveRuntimeManager>,
    token: String,
    chat_id: i64,
    thread_id: Option<i64>,
    runtime_id: String,
    channel: Arc<TelegramChannel>,
) {
    let mut last_claude_session_id =
        interactive_runtime_manager.current_claude_session_id(&runtime_id);

    loop {
        if manager.stop_flag.load(Ordering::SeqCst) {
            break;
        }

        channel.flush_if_due(false);

        if let Ok(state) = interactive_runtime_manager.get_state(&runtime_id) {
            if state == ClaudeTerminalState::Idle {
                if let Some(PendingInteractiveAction::FreeText(queued_message)) =
                    manager.pop_pending_interactive_action(chat_id, thread_id)
                {
                    match interactive_runtime_manager.send_message(&runtime_id, &queued_message) {
                        Ok(()) => {
                            let _ = send_message(
                                &token,
                                chat_id,
                                thread_id,
                                &format!("Sent queued follow-up to {runtime_id}"),
                            );
                        }
                        Err(error) => {
                            let restored_position = manager.queue_interactive_message(
                                chat_id,
                                thread_id,
                                queued_message,
                            );
                            let suffix = if restored_position > 0 {
                                format!(" (still queued at position {restored_position})")
                            } else {
                                String::new()
                            };
                            let _ = send_message(
                                &token,
                                chat_id,
                                thread_id,
                                &format!(
                                    "Failed to send queued follow-up to {runtime_id}: {}{}",
                                    truncate_for_telegram(&redact_telegram_token(&error)),
                                    suffix
                                ),
                            );
                        }
                    }
                }
            }
        }

        let current_claude_session_id =
            interactive_runtime_manager.current_claude_session_id(&runtime_id);
        if current_claude_session_id != last_claude_session_id {
            if let Some(thread_id) = thread_id {
                let _ = sync_topic_binding_runtime(
                    thread_id,
                    None,
                    Some(current_claude_session_id.clone()),
                );
            }
            last_claude_session_id = current_claude_session_id;
        }

        match interactive_runtime_manager.summary(&runtime_id) {
            Some(summary)
                if summary.is_active
                    && !matches!(summary.status.as_str(), "stopped" | "error" | "completed") =>
            {
                thread::sleep(Duration::from_millis(700));
            }
            Some(summary) => {
                channel.flush_if_due(true);
                let _ = send_message(
                    &token,
                    chat_id,
                    thread_id,
                    &format!(
                        "Interactive session {} is now {}.",
                        summary.session_id, summary.status
                    ),
                );
                manager.clear_runtime_for_scope(chat_id, thread_id, &runtime_id);
                if let Some(thread_id) = thread_id {
                    let _ = sync_topic_binding_runtime(
                        thread_id,
                        Some(None),
                        Some(summary.claude_session_id.clone()),
                    );
                }
                detach_telegram_output_channel(&app, &runtime_id, chat_id, thread_id);
                break;
            }
            None => {
                channel.flush_if_due(true);
                manager.clear_runtime_for_scope(chat_id, thread_id, &runtime_id);
                if let Some(thread_id) = thread_id {
                    let _ = sync_topic_binding_runtime(
                        thread_id,
                        Some(None),
                        Some(last_claude_session_id.clone()),
                    );
                }
                detach_telegram_output_channel(&app, &runtime_id, chat_id, thread_id);
                break;
            }
        }
    }
}

fn monitor_session_completion(
    manager: Arc<TelegramBridgeManager>,
    app: AppHandle,
    runtime_manager: Arc<HeadlessRuntimeManager>,
    token: String,
    chat_id: i64,
    thread_id: Option<i64>,
    runtime_id: String,
) {
    let started = Instant::now();
    let timeout = Duration::from_secs(60 * 15);
    let mut last_seen_seq = None;
    let mut announced_requests = HashSet::new();
    let mut announced_responses = HashSet::new();
    let mut permission_messages: HashMap<String, TelegramSentMessage> = HashMap::new();
    let mut pending_stdout = Vec::new();
    let mut pending_stderr = Vec::new();

    loop {
        if started.elapsed() > timeout {
            let _ = runtime_manager.stop_session(&app, &runtime_id);
            let _ = send_message(
                &token,
                chat_id,
                thread_id,
                &format!("Session {runtime_id} timed out while waiting for completion."),
            );
            manager.clear_runtime_for_scope(chat_id, thread_id, &runtime_id);
            if let Some(thread_id) = thread_id {
                let _ = sync_topic_binding_runtime(thread_id, Some(None), None);
            }
            break;
        }

        if let Ok(batch) = runtime_manager.replay_events(&runtime_id, last_seen_seq) {
            if let Some(newest_seq) = batch.newest_available_seq {
                last_seen_seq = Some(newest_seq);
            }

            for event in batch.events {
                match event.payload {
                    SessionEventPayload::AssistantChunk { text } if !text.trim().is_empty() => {
                        pending_stdout.push(text);
                    }
                    SessionEventPayload::StdErrLine { line } if !line.trim().is_empty() => {
                        pending_stderr.push(line);
                    }
                    SessionEventPayload::Lifecycle { stage, detail } => {
                        if matches!(
                            stage.as_str(),
                            "stderr_error" | "stdout_error" | "process_failure"
                        ) {
                            pending_stderr.push(format!("[{stage}] {detail}"));
                        }
                    }
                    SessionEventPayload::PermissionRequired {
                        request_id,
                        tool_name,
                        ..
                    } if announced_requests.insert(request_id.clone()) => {
                        if let Ok(sent_message) = send_permission_request_message(
                            &token,
                            chat_id,
                            thread_id,
                            &request_id,
                            &tool_name,
                        ) {
                            permission_messages.insert(request_id.clone(), sent_message);
                        }
                    }
                    SessionEventPayload::PermissionResponded {
                        request_id,
                        approved,
                        responder,
                        ..
                    } if announced_responses.insert(request_id.clone()) => {
                        let text =
                            format_permission_response_text(&request_id, approved, &responder);
                        if let Some(sent_message) = permission_messages.remove(&request_id) {
                            if edit_message_text(
                                &token,
                                chat_id,
                                sent_message.message_id,
                                &text,
                                None,
                            )
                            .is_err()
                            {
                                let _ = send_message(&token, chat_id, thread_id, &text);
                            }
                        } else {
                            let _ = send_message(&token, chat_id, thread_id, &text);
                        }
                    }
                    SessionEventPayload::ClaudeJson {
                        message_type,
                        raw_json,
                    } if message_type.as_deref() == Some("result") => {
                        let result = parse_headless_result_payload(&raw_json);
                        if pending_stdout.is_empty() {
                            if let Some(text) = result
                                .as_ref()
                                .and_then(|payload| payload.result_text.as_deref())
                                .filter(|text| !text.trim().is_empty())
                                .filter(|_| {
                                    !result.as_ref().is_some_and(|payload| payload.is_error)
                                })
                            {
                                pending_stdout.push(text.to_string());
                            }
                        }
                        if pending_stderr.is_empty() {
                            if let Some(text) = result
                                .as_ref()
                                .and_then(|payload| payload.result_text.as_deref())
                                .filter(|text| !text.trim().is_empty())
                                .filter(|_| result.as_ref().is_some_and(|payload| payload.is_error))
                            {
                                pending_stderr.push(text.to_string());
                            }
                        }

                        let message = format_headless_turn_message(
                            &runtime_id,
                            &pending_stdout.join("\n"),
                            &pending_stderr.join("\n"),
                        );
                        let _ = send_message(&token, chat_id, thread_id, &message);
                        pending_stdout.clear();
                        pending_stderr.clear();
                    }
                    SessionEventPayload::SessionCompleted { reason }
                        if reason != "completed" && reason != "stopped" =>
                    {
                        pending_stderr.push(reason);
                    }
                    _ => {}
                }
            }
        }

        match runtime_manager.summary(&runtime_id) {
            Some(summary)
                if !summary.is_active
                    || matches!(summary.status.as_str(), "completed" | "stopped" | "error") =>
            {
                if !pending_stdout.is_empty() || !pending_stderr.is_empty() {
                    let message = format_headless_turn_message(
                        &runtime_id,
                        &pending_stdout.join("\n"),
                        &pending_stderr.join("\n"),
                    );
                    let _ = send_message(&token, chat_id, thread_id, &message);
                    pending_stdout.clear();
                    pending_stderr.clear();
                }

                if matches!(summary.status.as_str(), "stopped" | "error") {
                    let message = format_result_message(&runtime_id, &summary.status, "", "");
                    let _ = send_message(&token, chat_id, thread_id, &message);
                }
                let _ = runtime_manager.remove_session(&runtime_id);
                manager.clear_runtime_for_scope(chat_id, thread_id, &runtime_id);
                if let Some(thread_id) = thread_id {
                    let _ = sync_topic_binding_runtime(
                        thread_id,
                        Some(None),
                        Some(summary.claude_session_id.clone()),
                    );
                }
                break;
            }
            Some(_) => {
                thread::sleep(Duration::from_millis(700));
            }
            None => {
                manager.clear_runtime_for_scope(chat_id, thread_id, &runtime_id);
                if let Some(thread_id) = thread_id {
                    let _ = sync_topic_binding_runtime(thread_id, Some(None), None);
                }
                break;
            }
        }
    }
}

fn monitor_interactive_session(
    manager: Arc<TelegramBridgeManager>,
    interactive_runtime_manager: Arc<InteractiveRuntimeManager>,
    token: String,
    settings: TelegramSettings,
    chat_id: i64,
    thread_id: Option<i64>,
    runtime_id: String,
) {
    let flush_interval = Duration::from_millis(settings.preferences.flush_interval_ms.max(500));
    let mut last_seen_seq = None;
    let mut last_flush_at = Instant::now();
    let mut pending_lines = Vec::new();
    let mut last_state = ClaudeTerminalState::Unknown;
    let mut approval_message: Option<TelegramSentMessage> = None;
    let mut last_claude_session_id =
        interactive_runtime_manager.current_claude_session_id(&runtime_id);

    loop {
        if manager.stop_flag.load(Ordering::SeqCst) {
            break;
        }

        if let Ok(batch) = interactive_runtime_manager.replay_events(&runtime_id, last_seen_seq) {
            if let Some(newest_seq) = batch.newest_available_seq {
                last_seen_seq = Some(newest_seq);
            }

            for event in batch.events {
                match event.payload {
                    SessionEventPayload::AssistantChunk { text } if !text.trim().is_empty() => {
                        pending_lines.push(text);
                    }
                    SessionEventPayload::SystemMessage { message }
                        if !message.trim().is_empty() =>
                    {
                        pending_lines.push(message);
                    }
                    SessionEventPayload::ToolUseStarted {
                        tool_use_id,
                        category,
                        raw_name,
                        input_summary,
                        needs_response,
                        prompt,
                        ..
                    } => {
                        if !manager.mark_interactive_tool_seen(chat_id, thread_id, &tool_use_id) {
                            continue;
                        }

                        if needs_response {
                            match prompt {
                                Some(InteractiveToolPrompt::AskUserQuestion { questions })
                                    if !questions.is_empty() =>
                                {
                                    let questions =
                                        normalize_ask_user_questions_for_telegram(questions);
                                    let prompt_state = ActiveInteractiveChoicePrompt {
                                        runtime_id: runtime_id.clone(),
                                        tool_use_id: tool_use_id.clone(),
                                        questions,
                                        current_question_index: 0,
                                        submit_mode: InteractiveChoiceSubmitMode::AskUserQuestion,
                                        selected_options: BTreeSet::new(),
                                        awaiting_text_entry: None,
                                        message_id: None,
                                    };
                                    let text = format_active_choice_text(&prompt_state);
                                    let markup = build_active_choice_markup(&prompt_state);
                                    if let Ok(sent) = send_message_with_markup(
                                        &token,
                                        chat_id,
                                        thread_id,
                                        &text,
                                        Some(markup),
                                    ) {
                                        let mut prompt_state = prompt_state;
                                        prompt_state.message_id = Some(sent.message_id);
                                        manager.remember_active_prompt(
                                            chat_id,
                                            thread_id,
                                            ActiveInteractivePrompt::Choice(prompt_state),
                                        );
                                    }
                                }
                                Some(InteractiveToolPrompt::PlanExit {
                                    allowed_prompts,
                                    plan_summary,
                                }) => {
                                    let question = build_plan_exit_question(
                                        plan_summary
                                            .as_deref()
                                            .or((!input_summary.trim().is_empty())
                                                .then_some(input_summary.as_str())),
                                        &allowed_prompts,
                                    );
                                    let prompt_state = ActiveInteractiveChoicePrompt {
                                        runtime_id: runtime_id.clone(),
                                        tool_use_id: tool_use_id.clone(),
                                        questions: vec![question],
                                        current_question_index: 0,
                                        submit_mode: InteractiveChoiceSubmitMode::PlanExit,
                                        selected_options: BTreeSet::new(),
                                        awaiting_text_entry: None,
                                        message_id: None,
                                    };
                                    let text = format_active_choice_text(&prompt_state);
                                    let markup = build_active_choice_markup(&prompt_state);
                                    if let Ok(sent) = send_message_with_markup(
                                        &token,
                                        chat_id,
                                        thread_id,
                                        &truncate_for_telegram(&text),
                                        Some(markup),
                                    ) {
                                        let mut prompt_state = prompt_state;
                                        prompt_state.message_id = Some(sent.message_id);
                                        manager.remember_active_prompt(
                                            chat_id,
                                            thread_id,
                                            ActiveInteractivePrompt::Choice(prompt_state),
                                        );
                                    }
                                }
                                _ => {
                                    pending_lines
                                        .push(format!("🔧 {}: {}", raw_name, input_summary));
                                }
                            }
                        } else {
                            if matches!(prompt, Some(InteractiveToolPrompt::PlanEntry)) {
                                pending_lines.push("🧭 Claude entered plan mode.".to_string());
                            }
                            if settings.preferences.show_tool_calls {
                                if let Some(message) = format_tool_started_message(
                                    &category,
                                    &raw_name,
                                    &input_summary,
                                ) {
                                    pending_lines.push(message);
                                }
                            }
                        }
                    }
                    SessionEventPayload::ToolUseCompleted {
                        tool_use_id,
                        raw_name,
                        result_summary,
                        success,
                        ..
                    } => {
                        if let Some(active_prompt) =
                            manager.active_prompt_for_scope(chat_id, thread_id)
                        {
                            let (matches_active, message_id) = match active_prompt {
                                ActiveInteractivePrompt::Choice(prompt) => {
                                    (prompt.tool_use_id == tool_use_id, prompt.message_id)
                                }
                            };

                            if matches_active {
                                manager.clear_active_prompt_for_scope(chat_id, thread_id);
                                if let Some(message_id) = message_id {
                                    let final_text = summarize_interactive_prompt_resolution(
                                        &raw_name,
                                        &result_summary,
                                    );
                                    let _ = edit_message_text(
                                        &token,
                                        chat_id,
                                        message_id,
                                        &truncate_for_telegram(&final_text),
                                        None,
                                    );
                                }
                            }
                        }

                        if settings.preferences.show_tool_calls {
                            if let Some(message) =
                                format_tool_completed_message(&raw_name, &result_summary, success)
                            {
                                pending_lines.push(message);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }

        if !pending_lines.is_empty() && last_flush_at.elapsed() >= flush_interval {
            let body = truncate_for_telegram(&pending_lines.join("\n\n"));
            let _ = send_message(&token, chat_id, thread_id, &body);
            pending_lines.clear();
            last_flush_at = Instant::now();
        }

        if let Ok(state) = interactive_runtime_manager.get_state(&runtime_id) {
            if state == ClaudeTerminalState::WaitingApproval
                && last_state != ClaudeTerminalState::WaitingApproval
            {
                if let Ok(sent) = send_interactive_permission_request_message(
                    &token,
                    chat_id,
                    thread_id,
                    &runtime_id,
                ) {
                    approval_message = Some(sent);
                }
            } else if last_state == ClaudeTerminalState::WaitingApproval
                && state != ClaudeTerminalState::WaitingApproval
            {
                if let Some(sent) = approval_message.take() {
                    let _ = edit_message_text(
                        &token,
                        chat_id,
                        sent.message_id,
                        "Interactive approval request resolved.",
                        None,
                    );
                }
            }

            if state == ClaudeTerminalState::Idle {
                if let Some(PendingInteractiveAction::FreeText(queued_message)) =
                    manager.pop_pending_interactive_action(chat_id, thread_id)
                {
                    match interactive_runtime_manager.send_message(&runtime_id, &queued_message) {
                        Ok(()) => {
                            let _ = send_message(
                                &token,
                                chat_id,
                                thread_id,
                                &format!("Sent queued follow-up to {runtime_id}"),
                            );
                        }
                        Err(error) => {
                            let restored_position = manager.queue_interactive_message(
                                chat_id,
                                thread_id,
                                queued_message,
                            );
                            let suffix = if restored_position > 0 {
                                format!(" (still queued at position {restored_position})")
                            } else {
                                String::new()
                            };
                            let _ = send_message(
                                &token,
                                chat_id,
                                thread_id,
                                &format!(
                                    "Failed to send queued follow-up to {runtime_id}: {}{}",
                                    truncate_for_telegram(&redact_telegram_token(&error)),
                                    suffix
                                ),
                            );
                        }
                    }
                }
            }
            last_state = state;
        }

        let current_claude_session_id =
            interactive_runtime_manager.current_claude_session_id(&runtime_id);
        if current_claude_session_id != last_claude_session_id {
            if let Some(thread_id) = thread_id {
                let _ = sync_topic_binding_runtime(
                    thread_id,
                    None,
                    Some(current_claude_session_id.clone()),
                );
            }
            last_claude_session_id = current_claude_session_id;
        }

        match interactive_runtime_manager.summary(&runtime_id) {
            Some(summary)
                if summary.is_active
                    && !matches!(summary.status.as_str(), "stopped" | "error" | "completed") =>
            {
                thread::sleep(Duration::from_millis(700));
            }
            Some(summary) => {
                if !pending_lines.is_empty() {
                    let body = truncate_for_telegram(&pending_lines.join("\n\n"));
                    let _ = send_message(&token, chat_id, thread_id, &body);
                }
                let _ = send_message(
                    &token,
                    chat_id,
                    thread_id,
                    &format!(
                        "Interactive session {} is now {}.",
                        summary.session_id, summary.status
                    ),
                );
                manager.clear_runtime_for_scope(chat_id, thread_id, &runtime_id);
                if let Some(thread_id) = thread_id {
                    let _ = sync_topic_binding_runtime(
                        thread_id,
                        Some(None),
                        Some(summary.claude_session_id.clone()),
                    );
                }
                break;
            }
            None => {
                if !pending_lines.is_empty() {
                    let body = truncate_for_telegram(&pending_lines.join("\n\n"));
                    let _ = send_message(&token, chat_id, thread_id, &body);
                }
                manager.clear_runtime_for_scope(chat_id, thread_id, &runtime_id);
                if let Some(thread_id) = thread_id {
                    let _ = sync_topic_binding_runtime(
                        thread_id,
                        Some(None),
                        Some(last_claude_session_id.clone()),
                    );
                }
                break;
            }
        }
    }
}

#[derive(Debug)]
struct HeadlessResultPayload {
    is_error: bool,
    result_text: Option<String>,
}

fn parse_headless_result_payload(raw_json: &str) -> Option<HeadlessResultPayload> {
    let value = serde_json::from_str::<serde_json::Value>(raw_json).ok()?;
    if value.get("type").and_then(serde_json::Value::as_str) != Some("result") {
        return None;
    }
    Some(HeadlessResultPayload {
        is_error: value
            .get("is_error")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        result_text: value
            .get("result")
            .and_then(serde_json::Value::as_str)
            .map(ToString::to_string),
    })
}

fn format_headless_turn_message(runtime_id: &str, stdout: &str, stderr: &str) -> String {
    let mut lines = vec![format!("Session {runtime_id} replied:")];
    if !stdout.trim().is_empty() {
        lines.push(String::new());
        lines.push(truncate_for_telegram(stdout));
    }
    if !stderr.trim().is_empty() {
        lines.push(String::new());
        lines.push("Errors:".to_string());
        lines.push(truncate_for_telegram(stderr));
    }
    lines.join("\n")
}

fn format_result_message(runtime_id: &str, status: &str, stdout: &str, stderr: &str) -> String {
    let mut lines = vec![format!(
        "Session {runtime_id} finished with status: {status}"
    )];
    if !stdout.trim().is_empty() {
        lines.push(String::new());
        lines.push("Output:".to_string());
        lines.push(truncate_for_telegram(stdout));
    }
    if !stderr.trim().is_empty() {
        lines.push(String::new());
        lines.push("Errors:".to_string());
        lines.push(truncate_for_telegram(stderr));
    }
    lines.join("\n")
}

fn format_cron_list_message(tasks: &[cron::CronTask]) -> String {
    if tasks.is_empty() {
        return "No cron tasks configured.".to_string();
    }

    tasks
        .iter()
        .take(20)
        .map(|task| {
            format!(
                "{} {} · {} · {} · {}",
                if task.enabled { "✅" } else { "⏸" },
                task.name,
                task.execution_profile,
                task.cron_expression,
                task.id
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn resolve_cron_task(selector: &str) -> Result<cron::CronTask, String> {
    let selector = selector.trim();
    if selector.is_empty() {
        return Err("Cron task id or name is required".to_string());
    }

    let exact_matches = cron::list_cron_tasks()?
        .into_iter()
        .filter(|task| {
            task.id.eq_ignore_ascii_case(selector) || task.name.eq_ignore_ascii_case(selector)
        })
        .collect::<Vec<_>>();

    if exact_matches.len() == 1 {
        return Ok(exact_matches[0].clone());
    }

    let normalized = selector.to_lowercase();
    let partial_matches = cron::list_cron_tasks()?
        .into_iter()
        .filter(|task| {
            task.id.to_lowercase().starts_with(&normalized)
                || task.name.to_lowercase().contains(&normalized)
        })
        .collect::<Vec<_>>();

    if partial_matches.len() == 1 {
        return Ok(partial_matches[0].clone());
    }

    if partial_matches.is_empty() && exact_matches.is_empty() {
        return Err(format!("Cron task not found: {}", selector));
    }

    let candidates = if !exact_matches.is_empty() {
        exact_matches
    } else {
        partial_matches
    };
    Err(format!(
        "Cron task selector is ambiguous: {}",
        candidates
            .into_iter()
            .take(5)
            .map(|task| format!("{} ({})", task.name, task.id))
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

fn truncate_for_telegram(value: &str) -> String {
    const MAX_LEN: usize = 3500;
    if value.len() <= MAX_LEN {
        return value.to_string();
    }

    let mut truncated = value.chars().take(MAX_LEN).collect::<String>();
    truncated.push_str("\n…");
    truncated
}

/// Minimum shape of a Telegram bot token that we redact on sight.
///
/// Real tokens look like `<bot_id>:<secret>` where `<bot_id>` is 8-10 digits
/// and `<secret>` is ~35 characters of `[A-Za-z0-9_-]`. The constants below
/// are deliberately loose lower bounds so we still catch truncated or
/// newly-formatted tokens while avoiding false positives on ordinary text.
const REDACT_TOKEN_MIN_DIGITS: usize = 6;
const REDACT_TOKEN_MIN_SECRET: usize = 20;
const REDACT_TOKEN_MAX_SECRET: usize = 80;
const REDACT_TOKEN_REPLACEMENT: &str = "[REDACTED]";

#[inline]
fn is_telegram_token_secret_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
}

/// Next UTF-8 character boundary at or after `start`. Used so byte-level
/// scanning never splits a multi-byte character when copying non-matching
/// input verbatim.
#[inline]
fn next_char_boundary(bytes: &[u8], start: usize) -> usize {
    if start >= bytes.len() {
        return bytes.len();
    }
    let lead = bytes[start];
    let len = if lead < 0x80 {
        1
    } else if lead & 0xE0 == 0xC0 {
        2
    } else if lead & 0xF0 == 0xE0 {
        3
    } else if lead & 0xF8 == 0xF0 {
        4
    } else {
        // Invalid UTF-8 lead byte; step one byte to make progress.
        1
    };
    (start + len).min(bytes.len())
}

/// Strip Telegram bot tokens from `value`.
///
/// The Telegram API embeds the bot token in the URL path
/// (`https://api.telegram.org/bot<token>/<method>`), and `reqwest` surfaces
/// that URL inside transport error strings. Left unfiltered, those errors
/// flow into `last_error` state, log lines, and even external Telegram
/// replies. This helper finds the `<digits>:<secret>` shape anywhere in the
/// input and replaces it with `[REDACTED]`, preserving HTTP status, endpoint
/// names, and other diagnostic context.
fn redact_telegram_token(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = String::with_capacity(bytes.len());
    let mut cursor = 0usize;

    while cursor < bytes.len() {
        if bytes[cursor].is_ascii_digit() {
            let digit_start = cursor;
            while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
                cursor += 1;
            }
            let digit_end = cursor;

            let has_enough_digits = digit_end - digit_start >= REDACT_TOKEN_MIN_DIGITS;
            let followed_by_colon = cursor < bytes.len() && bytes[cursor] == b':';
            if has_enough_digits && followed_by_colon {
                let secret_start = cursor + 1;
                let mut scan = secret_start;
                while scan < bytes.len()
                    && (scan - secret_start) < REDACT_TOKEN_MAX_SECRET
                    && is_telegram_token_secret_byte(bytes[scan])
                {
                    scan += 1;
                }
                if scan - secret_start >= REDACT_TOKEN_MIN_SECRET {
                    out.push_str(REDACT_TOKEN_REPLACEMENT);
                    cursor = scan;
                    continue;
                }
            }

            // Not a token; copy the digit run verbatim. Both bounds sit on
            // ASCII byte boundaries, which are always valid UTF-8 boundaries.
            out.push_str(&value[digit_start..digit_end]);
            continue;
        }

        let end = next_char_boundary(bytes, cursor);
        out.push_str(&value[cursor..end]);
        cursor = end;
    }

    out
}

fn normalize_command_text(text: &str, bot_username: Option<&str>) -> String {
    let mut parts = text.splitn(2, ' ');
    let command = parts.next().unwrap_or_default();
    let remainder =
        strip_bot_username_mentions(parts.next().unwrap_or_default().trim(), bot_username);

    let normalized_command = if let Some(username) = bot_username {
        let suffix = format!("@{username}");
        command.strip_suffix(&suffix).unwrap_or(command).to_string()
    } else {
        command.to_string()
    };

    if remainder.is_empty() {
        normalized_command
    } else {
        format!("{normalized_command} {remainder}")
    }
}

fn strip_bot_username_mentions(text: &str, bot_username: Option<&str>) -> String {
    let Some(username) = bot_username else {
        return text.to_string();
    };

    let mention = format!("@{username}");
    text.split_whitespace()
        .filter(|token| !token.eq_ignore_ascii_case(&mention))
        .collect::<Vec<_>>()
        .join(" ")
}

fn build_command_registrations(settings: &TelegramSettings) -> Vec<TelegramCommandRegistration> {
    let mut registrations = vec![TelegramCommandRegistration {
        scope: TelegramBotCommandScope::AllPrivateChats,
        commands: TELEGRAM_PRIVATE_COMMANDS.to_vec(),
    }];

    if let Some(chat_id) = settings.allowed_chat_id.filter(|chat_id| *chat_id < 0) {
        registrations.push(TelegramCommandRegistration {
            scope: TelegramBotCommandScope::AllGroupChats,
            commands: TELEGRAM_MINIMAL_GROUP_COMMANDS.to_vec(),
        });
        registrations.push(TelegramCommandRegistration {
            scope: TelegramBotCommandScope::Chat { chat_id },
            commands: TELEGRAM_FULL_GROUP_COMMANDS.to_vec(),
        });
    } else {
        registrations.push(TelegramCommandRegistration {
            scope: TelegramBotCommandScope::AllGroupChats,
            commands: TELEGRAM_FULL_GROUP_COMMANDS.to_vec(),
        });
    }

    registrations
}

fn command_scopes_to_clear(settings: &TelegramSettings) -> Vec<TelegramBotCommandScope> {
    let mut scopes = vec![
        TelegramBotCommandScope::Default,
        TelegramBotCommandScope::AllPrivateChats,
        TelegramBotCommandScope::AllGroupChats,
    ];
    if let Some(chat_id) = settings.allowed_chat_id.filter(|chat_id| *chat_id < 0) {
        scopes.push(TelegramBotCommandScope::Chat { chat_id });
    }
    scopes
}

fn clear_registered_commands(token: &str, settings: &TelegramSettings) -> Result<(), String> {
    for scope in command_scopes_to_clear(settings) {
        delete_my_commands(token, Some(&scope))?;
    }

    Ok(())
}

fn sync_registered_commands(token: &str, settings: &TelegramSettings) -> Result<(), String> {
    clear_registered_commands(token, settings)?;

    for registration in build_command_registrations(settings) {
        set_my_commands(token, &registration.commands, Some(&registration.scope))?;
    }

    Ok(())
}

pub fn reconcile_registered_commands(
    previous: Option<&TelegramSettings>,
    next: &TelegramSettings,
) -> Result<(), String> {
    let previous_token = previous
        .and_then(|settings| settings.bot_token.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let next_token = next
        .bot_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if previous_token != next_token {
        return Ok(());
    }

    let Some(token) = next_token.or(previous_token) else {
        return Ok(());
    };

    if let Some(previous) = previous {
        clear_registered_commands(token, previous)?;
    }

    if next.enabled {
        sync_registered_commands(token, next)?;
    }

    Ok(())
}

fn get_me(token: &str) -> Result<TelegramUser, String> {
    let client = telegram_http_client(None)?;
    let url = format!("{TELEGRAM_API_BASE}/bot{token}/getMe");
    let response = client
        .get(url)
        .send()
        .map_err(|error| redact_telegram_token(&format!("Telegram getMe failed: {}", error)))?;
    let payload: TelegramApiResponse<TelegramUser> =
        parse_telegram_response(response, "Telegram getMe response")?;
    if payload.ok {
        payload
            .result
            .ok_or_else(|| "Telegram getMe returned ok=true without result".to_string())
    } else {
        Err(payload
            .description
            .unwrap_or_else(|| "Telegram getMe returned an error".to_string()))
    }
}

fn set_my_commands(
    token: &str,
    commands: &[TelegramBotCommand],
    scope: Option<&TelegramBotCommandScope>,
) -> Result<(), String> {
    #[derive(Serialize)]
    struct SetMyCommandsBody<'a> {
        commands: &'a [TelegramBotCommand],
        #[serde(skip_serializing_if = "Option::is_none")]
        scope: Option<&'a TelegramBotCommandScope>,
    }

    let client = telegram_http_client(None)?;
    let url = format!("{TELEGRAM_API_BASE}/bot{token}/setMyCommands");
    let response = client
        .post(url)
        .json(&SetMyCommandsBody { commands, scope })
        .send()
        .map_err(|error| redact_telegram_token(&format!(
            "Telegram setMyCommands failed: {}",
            error
        )))?;
    let payload: TelegramApiResponse<bool> =
        parse_telegram_response(response, "Telegram setMyCommands response")?;
    if payload.ok {
        payload
            .result
            .filter(|ok| *ok)
            .map(|_| ())
            .ok_or_else(|| "Telegram setMyCommands returned ok=true without result".to_string())
    } else {
        Err(payload
            .description
            .unwrap_or_else(|| "Telegram setMyCommands returned an error".to_string()))
    }
}

fn delete_my_commands(token: &str, scope: Option<&TelegramBotCommandScope>) -> Result<(), String> {
    #[derive(Serialize)]
    struct DeleteMyCommandsBody<'a> {
        #[serde(skip_serializing_if = "Option::is_none")]
        scope: Option<&'a TelegramBotCommandScope>,
    }

    let client = telegram_http_client(None)?;
    let url = format!("{TELEGRAM_API_BASE}/bot{token}/deleteMyCommands");
    let response = client
        .post(url)
        .json(&DeleteMyCommandsBody { scope })
        .send()
        .map_err(|error| redact_telegram_token(&format!(
            "Telegram deleteMyCommands failed: {}",
            error
        )))?;
    let payload: TelegramApiResponse<bool> =
        parse_telegram_response(response, "Telegram deleteMyCommands response")?;
    if payload.ok {
        payload
            .result
            .filter(|ok| *ok)
            .map(|_| ())
            .ok_or_else(|| "Telegram deleteMyCommands returned ok=true without result".to_string())
    } else {
        Err(payload
            .description
            .unwrap_or_else(|| "Telegram deleteMyCommands returned an error".to_string()))
    }
}

fn get_updates(token: &str, offset: Option<i64>) -> Result<Vec<TelegramUpdate>, String> {
    let client = telegram_http_client(Some(Duration::from_secs(TELEGRAM_HTTP_TIMEOUT_SECS)))?;
    let url = format!("{TELEGRAM_API_BASE}/bot{token}/getUpdates");
    let mut query = vec![("timeout", TELEGRAM_LONG_POLL_TIMEOUT_SECS.to_string())];
    if let Some(offset) = offset {
        query.push(("offset", offset.to_string()));
    }

    let response = client
        .get(url)
        .query(&query)
        .send()
        .map_err(|error| redact_telegram_token(&format!(
            "Telegram getUpdates failed: {}",
            error
        )))?;
    let payload: TelegramApiResponse<Vec<TelegramUpdate>> =
        parse_telegram_response(response, "Telegram updates")?;
    if payload.ok {
        payload
            .result
            .ok_or_else(|| "Telegram getUpdates returned ok=true without result".to_string())
    } else {
        Err(payload
            .description
            .unwrap_or_else(|| "Telegram getUpdates returned an error".to_string()))
    }
}

fn create_forum_topic(token: &str, chat_id: i64, name: &str) -> Result<i64, String> {
    #[derive(Serialize)]
    struct CreateForumTopicBody<'a> {
        chat_id: i64,
        name: &'a str,
        icon_color: u32,
    }

    let client = telegram_http_client(None)?;
    let url = format!("{TELEGRAM_API_BASE}/bot{token}/createForumTopic");
    let response = client
        .post(url)
        .json(&CreateForumTopicBody {
            chat_id,
            name,
            icon_color: TELEGRAM_DEFAULT_TOPIC_ICON_COLOR,
        })
        .send()
        .map_err(|error| redact_telegram_token(&format!(
            "Telegram createForumTopic failed: {}",
            error
        )))?;
    let payload: TelegramApiResponse<TelegramCreatedForumTopic> =
        parse_telegram_response(response, "Telegram createForumTopic response")?;
    if payload.ok {
        payload
            .result
            .map(|result| result.message_thread_id)
            .ok_or_else(|| "Telegram createForumTopic returned ok=true without result".to_string())
    } else {
        Err(payload
            .description
            .unwrap_or_else(|| "Telegram createForumTopic returned an error".to_string()))
    }
}

fn send_message(
    token: &str,
    chat_id: i64,
    thread_id: Option<i64>,
    text: &str,
) -> Result<(), String> {
    send_message_with_markup(token, chat_id, thread_id, text, None).map(|_| ())
}

fn send_permission_request_message(
    token: &str,
    chat_id: i64,
    thread_id: Option<i64>,
    request_id: &str,
    tool_name: &str,
) -> Result<TelegramSentMessage, String> {
    let markup = serde_json::json!({
        "inline_keyboard": [[
            {
                "text": "Approve",
                "callback_data": format!("perm:approve:{request_id}"),
            },
            {
                "text": "Deny",
                "callback_data": format!("perm:deny:{request_id}"),
            }
        ]]
    });

    send_message_with_markup(
        token,
        chat_id,
        thread_id,
        &format_permission_request_text(tool_name, request_id),
        Some(markup),
    )
}

fn format_permission_request_text(tool_name: &str, request_id: &str) -> String {
    format!(
        "Permission required for {}.\nRequest: {}",
        format_permission_preview(tool_name, 120),
        format_permission_preview(request_id, 240)
    )
}

fn format_permission_response_text(request_id: &str, approved: bool, responder: &str) -> String {
    format!(
        "Permission request {} was {} by {}.",
        format_permission_preview(request_id, 240),
        if approved { "approved" } else { "denied" },
        format_permission_preview(responder, 120)
    )
}

fn format_permission_command_result(
    request_id: &str,
    approved: bool,
    error: Option<&str>,
) -> String {
    let request_id = format_permission_preview(request_id, 240);
    match error {
        Some(error) => format!(
            "Failed to {} {request_id}: {}",
            if approved { "approve" } else { "deny" },
            format_permission_preview(error, 400)
        ),
        None => format!(
            "{} permission request {request_id}.",
            if approved { "Approved" } else { "Denied" }
        ),
    }
}

fn send_interactive_permission_request_message(
    token: &str,
    chat_id: i64,
    thread_id: Option<i64>,
    session_id: &str,
) -> Result<TelegramSentMessage, String> {
    let markup = serde_json::json!({
        "inline_keyboard": [[
            {
                "text": "Approve",
                "callback_data": format!("perm_i:approve:{session_id}"),
            },
            {
                "text": "Deny",
                "callback_data": format!("perm_i:deny:{session_id}"),
            }
        ]]
    });

    send_message_with_markup(
        token,
        chat_id,
        thread_id,
        &format!("Interactive approval required for session {session_id}."),
        Some(markup),
    )
}

fn send_message_with_markup(
    token: &str,
    chat_id: i64,
    thread_id: Option<i64>,
    text: &str,
    reply_markup: Option<serde_json::Value>,
) -> Result<TelegramSentMessage, String> {
    #[derive(Serialize)]
    struct SendMessageBody<'a> {
        chat_id: i64,
        text: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        message_thread_id: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reply_markup: Option<serde_json::Value>,
    }

    let client = telegram_http_client(None)?;
    let url = format!("{TELEGRAM_API_BASE}/bot{token}/sendMessage");
    let response = client
        .post(url)
        .json(&SendMessageBody {
            chat_id,
            text,
            message_thread_id: canonical_thread_id(thread_id),
            reply_markup,
        })
        .send()
        .map_err(|error| redact_telegram_token(&format!(
            "Telegram sendMessage failed: {}",
            error
        )))?;
    let payload: TelegramApiResponse<TelegramSentMessage> =
        parse_telegram_response(response, "Telegram sendMessage response")?;
    if payload.ok {
        payload
            .result
            .ok_or_else(|| "Telegram sendMessage returned ok=true without result".to_string())
    } else {
        Err(payload
            .description
            .unwrap_or_else(|| "Telegram sendMessage returned an error".to_string()))
    }
}

fn edit_message_text(
    token: &str,
    chat_id: i64,
    message_id: i64,
    text: &str,
    reply_markup: Option<serde_json::Value>,
) -> Result<(), String> {
    #[derive(Serialize)]
    struct EditMessageTextBody<'a> {
        chat_id: i64,
        message_id: i64,
        text: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        reply_markup: Option<serde_json::Value>,
    }

    let client = telegram_http_client(None)?;
    let url = format!("{TELEGRAM_API_BASE}/bot{token}/editMessageText");
    let response = client
        .post(url)
        .json(&EditMessageTextBody {
            chat_id,
            message_id,
            text,
            reply_markup,
        })
        .send()
        .map_err(|error| redact_telegram_token(&format!(
            "Telegram editMessageText failed: {}",
            error
        )))?;
    let payload: TelegramApiResponse<serde_json::Value> =
        parse_telegram_response(response, "Telegram editMessageText response")?;
    if payload.ok {
        payload
            .result
            .map(|_| ())
            .ok_or_else(|| "Telegram editMessageText returned ok=true without result".to_string())
    } else {
        Err(payload
            .description
            .unwrap_or_else(|| "Telegram editMessageText returned an error".to_string()))
    }
}

fn answer_callback_query(
    token: &str,
    callback_query_id: &str,
    text: &str,
    show_alert: bool,
) -> Result<(), String> {
    #[derive(Serialize)]
    struct AnswerCallbackQueryBody<'a> {
        callback_query_id: &'a str,
        text: &'a str,
        show_alert: bool,
    }

    let client = telegram_http_client(None)?;
    let url = format!("{TELEGRAM_API_BASE}/bot{token}/answerCallbackQuery");
    let response = client
        .post(url)
        .json(&AnswerCallbackQueryBody {
            callback_query_id,
            text,
            show_alert,
        })
        .send()
        .map_err(|error| redact_telegram_token(&format!(
            "Telegram answerCallbackQuery failed: {}",
            error
        )))?;
    let payload: TelegramApiResponse<serde_json::Value> =
        parse_telegram_response(response, "Telegram answerCallbackQuery response")?;
    if payload.ok {
        payload.result.map(|_| ()).ok_or_else(|| {
            "Telegram answerCallbackQuery returned ok=true without result".to_string()
        })
    } else {
        Err(payload
            .description
            .unwrap_or_else(|| "Telegram answerCallbackQuery returned an error".to_string()))
    }
}

fn telegram_http_client(timeout: Option<Duration>) -> Result<reqwest::blocking::Client, String> {
    let mut builder = reqwest::blocking::Client::builder();
    if telegram_no_proxy_requested() {
        builder = builder.no_proxy();
    }
    if let Some(timeout) = timeout {
        builder = builder.timeout(timeout);
    }
    builder
        .build()
        .map_err(|error| redact_telegram_token(&format!("Failed to build Telegram client: {}", error)))
}

fn telegram_no_proxy_requested() -> bool {
    std::env::var("CCEM_TELEGRAM_NO_PROXY")
        .ok()
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn parse_telegram_response<T>(response: Response, context: &str) -> Result<T, String>
where
    T: DeserializeOwned,
{
    let status = response.status();
    let body = response
        .text()
        .map_err(|error| format!("Failed to read {context}: {}", error))?;
    serde_json::from_str(&body).map_err(|error| {
        format!(
            "Failed to parse {context}: {} (status {}, body: {})",
            error,
            status,
            truncate_for_telegram(&body)
        )
    })
}

#[cfg(test)]
mod tests {
    use super::{
        active_choice_question, advance_active_choice_prompt, build_chat_about_this_steps,
        build_command_registrations, build_multi_select_submit_steps,
        build_multi_select_text_entry_steps, build_plan_exit_question, canonical_thread_id,
        command_scopes_to_clear, decrypt_telegram_settings, ensure_chat_about_this_option,
        ensure_text_entry_option, expand_home_dir, format_active_choice_text,
        format_new_topic_welcome_message, format_permission_command_result,
        format_permission_request_text, format_permission_response_text,
        format_tool_completed_message,
        format_topic_binding_success_message, is_chat_about_this_option, is_chat_allowed,
        is_sender_allowed, is_vscode_text_entry_option, normalize_command_text, parse_bind_command,
        parse_interactive_tool_cancel_callback_data, parse_interactive_tool_select_callback_data,
        parse_interactive_tool_submit_callback_data, parse_new_topic_command,
        parse_permission_callback_data, redact_telegram_token, remove_topic_binding,
        selection_submit_options, summarize_interactive_prompt_resolution, upsert_topic_binding,
        ActiveInteractiveChoicePrompt, InteractiveChoiceSubmitMode, PendingInteractiveAction,
        TelegramBotCommandScope, TelegramBridgeManager, TelegramSettings, TelegramTopicBinding,
        TELEGRAM_FULL_GROUP_COMMANDS, TELEGRAM_MINIMAL_GROUP_COMMANDS, TELEGRAM_PRIVATE_COMMANDS,
    };
    use crate::event_bus::{ToolQuestionOption, ToolQuestionPrompt};
    use chrono::Utc;
    use std::collections::BTreeSet;
    use std::path::{Path, PathBuf};

    #[test]
    fn normalize_command_text_strips_bot_username() {
        assert_eq!(
            normalize_command_text("/new@ccem_bot hello world", Some("ccem_bot")),
            "/new hello world"
        );
    }

    #[test]
    fn read_telegram_settings_rejects_tampered_v2_token_without_exposing_value() {
        let tampered = "enc:v2:000000000000000000000000:00:00000000000000000000000000000000";
        let settings = TelegramSettings {
            enabled: true,
            bot_token: Some(tampered.to_string()),
            ..TelegramSettings::default()
        };

        let error = decrypt_telegram_settings(settings).expect_err("tampered v2 token should fail");

        assert!(
            !error.contains(tampered),
            "Error should not include encrypted token material"
        );
    }

    #[test]
    fn normalize_command_text_keeps_plain_text() {
        assert_eq!(
            normalize_command_text("continue this task", Some("ccem_bot")),
            "continue this task"
        );
    }

    #[test]
    fn normalize_command_text_strips_trailing_bot_mention_from_remainder() {
        assert_eq!(
            normalize_command_text(
                "/bind /Users/g/Github/home env=glm perm=dev @ClawdCode996Bot",
                Some("ClawdCode996Bot")
            ),
            "/bind /Users/g/Github/home env=glm perm=dev"
        );
    }

    #[test]
    fn parse_permission_callback_data_extracts_action_and_request_id() {
        assert_eq!(
            parse_permission_callback_data("perm:approve:req-123"),
            Some((true, "req-123"))
        );
        assert_eq!(
            parse_permission_callback_data("perm:deny:req-456"),
            Some((false, "req-456"))
        );
        assert_eq!(parse_permission_callback_data("noop:req-123"), None);
    }

    #[test]
    fn permission_messages_expose_only_sanitized_display_copies() {
        let request_id = "req\n\u{17b4}\u{202e}id";
        let tool_name = "Bash\u{1d173}\u{201c}";

        assert_eq!(
            format_permission_request_text(tool_name, request_id),
            "Permission required for Bash\\u{1D173}\\u{201C}.\nRequest: req\\u{000A}\\u{17B4}\\u{202E}id"
        );
        assert_eq!(
            format_permission_response_text(request_id, true, "telegram"),
            "Permission request req\\u{000A}\\u{17B4}\\u{202E}id was approved by telegram."
        );
        assert_eq!(
            format_permission_command_result(request_id, true, None),
            "Approved permission request req\\u{000A}\\u{17B4}\\u{202E}id."
        );
        assert_eq!(
            format_permission_command_result(request_id, false, Some("bad\nrequest")),
            "Failed to deny req\\u{000A}\\u{17B4}\\u{202E}id: bad\\u{000A}request"
        );
    }

    #[test]
    fn parse_bind_command_supports_env_and_perm() {
        let parsed =
            parse_bind_command("/bind /Users/g/Github/home env=glm perm=dev").expect("parse bind");
        assert_eq!(parsed.project_dir, "/Users/g/Github/home");
        assert_eq!(parsed.preferred_env.as_deref(), Some("glm"));
        assert_eq!(parsed.preferred_perm_mode.as_deref(), Some("dev"));
    }

    #[test]
    fn parse_new_topic_command_supports_env_perm_and_prompt() {
        let parsed =
            parse_new_topic_command("/new ~/Github/home glm perm=dev check the repo status")
                .expect("parse new topic");
        assert!(PathBuf::from(&parsed.project_dir).ends_with(Path::new("Github").join("home")));
        assert_eq!(parsed.preferred_env.as_deref(), Some("glm"));
        assert_eq!(parsed.preferred_perm_mode.as_deref(), Some("dev"));
        assert_eq!(
            parsed.initial_prompt.as_deref(),
            Some("check the repo status")
        );
    }

    #[test]
    fn canonical_thread_id_omits_general_topic_id() {
        assert_eq!(canonical_thread_id(Some(1)), None);
        assert_eq!(canonical_thread_id(Some(42)), Some(42));
        assert_eq!(canonical_thread_id(None), None);
    }

    #[test]
    fn expand_home_dir_preserves_plain_paths() {
        assert_eq!(expand_home_dir("/tmp/project"), "/tmp/project");
    }

    #[test]
    fn upsert_topic_binding_replaces_existing_thread_binding() {
        let created_at = Utc::now();
        let mut settings = TelegramSettings::default();
        upsert_topic_binding(
            &mut settings,
            TelegramTopicBinding {
                thread_id: 42,
                project_dir: "/tmp/one".to_string(),
                preferred_env: None,
                preferred_perm_mode: None,
                active_runtime_id: None,
                last_claude_session_id: None,
                created_at,
            },
        );
        upsert_topic_binding(
            &mut settings,
            TelegramTopicBinding {
                thread_id: 42,
                project_dir: "/tmp/two".to_string(),
                preferred_env: Some("glm".to_string()),
                preferred_perm_mode: Some("dev".to_string()),
                active_runtime_id: Some("headless-1".to_string()),
                last_claude_session_id: Some("claude-1".to_string()),
                created_at,
            },
        );

        assert_eq!(settings.topic_bindings.len(), 1);
        assert_eq!(settings.topic_bindings[0].project_dir, "/tmp/two");
        assert_eq!(
            settings.topic_bindings[0].preferred_env.as_deref(),
            Some("glm")
        );
    }

    #[test]
    fn remove_topic_binding_returns_whether_a_binding_was_removed() {
        let mut settings = TelegramSettings {
            topic_bindings: vec![TelegramTopicBinding {
                thread_id: 99,
                project_dir: "/tmp/project".to_string(),
                preferred_env: None,
                preferred_perm_mode: None,
                active_runtime_id: None,
                last_claude_session_id: None,
                created_at: Utc::now(),
            }],
            ..TelegramSettings::default()
        };

        assert!(remove_topic_binding(&mut settings, 99));
        assert!(settings.topic_bindings.is_empty());
        assert!(!remove_topic_binding(&mut settings, 99));
    }

    #[test]
    fn allowed_user_ids_gate_only_blocks_unknown_senders_when_configured() {
        let settings = TelegramSettings {
            allowed_user_ids: vec![1, 2, 3],
            ..TelegramSettings::default()
        };

        assert!(is_sender_allowed(&settings, Some(2)));
        assert!(!is_sender_allowed(&settings, Some(9)));
        assert!(!is_sender_allowed(&settings, None));

        let open_settings = TelegramSettings::default();
        assert!(is_sender_allowed(&open_settings, None));
    }

    #[test]
    fn allowed_chat_id_still_allows_matching_chat() {
        let settings = TelegramSettings {
            allowed_chat_id: Some(-100123),
            ..TelegramSettings::default()
        };

        assert!(is_chat_allowed(&settings, -100123, Some(42)));
        assert!(!is_chat_allowed(&settings, -100124, Some(42)));
    }

    #[test]
    fn allowed_chat_id_still_allows_private_chat_with_sender() {
        let settings = TelegramSettings {
            allowed_chat_id: Some(-100123),
            ..TelegramSettings::default()
        };

        assert!(is_chat_allowed(&settings, 42, Some(42)));
        assert!(!is_chat_allowed(&settings, 42, Some(7)));
    }

    #[test]
    fn command_registrations_use_full_group_scope_when_no_allowed_chat_is_set() {
        let settings = TelegramSettings {
            ..TelegramSettings::default()
        };
        let registrations = build_command_registrations(&settings);

        assert_eq!(registrations.len(), 2);
        assert_eq!(
            registrations[0].scope,
            TelegramBotCommandScope::AllPrivateChats
        );
        assert_eq!(
            registrations[0].commands,
            TELEGRAM_PRIVATE_COMMANDS.to_vec()
        );
        assert_eq!(
            registrations[1].scope,
            TelegramBotCommandScope::AllGroupChats
        );
        assert_eq!(
            registrations[1].commands,
            TELEGRAM_FULL_GROUP_COMMANDS.to_vec()
        );
    }

    #[test]
    fn command_registrations_limit_global_group_menu_when_allowed_chat_is_configured() {
        let settings = TelegramSettings {
            allowed_chat_id: Some(-100123),
            ..TelegramSettings::default()
        };
        let registrations = build_command_registrations(&settings);

        assert_eq!(registrations.len(), 3);
        assert_eq!(
            registrations[1].scope,
            TelegramBotCommandScope::AllGroupChats
        );
        assert_eq!(
            registrations[1].commands,
            TELEGRAM_MINIMAL_GROUP_COMMANDS.to_vec()
        );
        assert_eq!(
            registrations[2].scope,
            TelegramBotCommandScope::Chat { chat_id: -100123 }
        );
        assert_eq!(
            registrations[2].commands,
            TELEGRAM_FULL_GROUP_COMMANDS.to_vec()
        );
    }

    #[test]
    fn registered_menus_omit_argument_only_commands() {
        let private_commands = TELEGRAM_PRIVATE_COMMANDS
            .iter()
            .map(|command| command.command)
            .collect::<Vec<_>>();
        assert!(!private_commands.contains(&"new"));
        assert!(!private_commands.contains(&"approve"));
        assert!(!private_commands.contains(&"deny"));
        assert!(!private_commands.contains(&"cron"));

        let group_commands = TELEGRAM_FULL_GROUP_COMMANDS
            .iter()
            .map(|command| command.command)
            .collect::<Vec<_>>();
        assert!(!group_commands.contains(&"new"));
        assert!(!group_commands.contains(&"approve"));
        assert!(!group_commands.contains(&"deny"));
        assert!(!group_commands.contains(&"cron"));
    }

    #[test]
    fn command_scopes_to_clear_include_chat_scope_for_restricted_group() {
        let settings = TelegramSettings {
            allowed_chat_id: Some(-100123),
            ..TelegramSettings::default()
        };

        assert_eq!(
            command_scopes_to_clear(&settings),
            vec![
                TelegramBotCommandScope::Default,
                TelegramBotCommandScope::AllPrivateChats,
                TelegramBotCommandScope::AllGroupChats,
                TelegramBotCommandScope::Chat { chat_id: -100123 },
            ]
        );
    }

    #[test]
    fn topic_binding_success_message_includes_command_hint() {
        let binding = TelegramTopicBinding {
            thread_id: 42,
            project_dir: "/tmp/project".to_string(),
            preferred_env: Some("official".to_string()),
            preferred_perm_mode: Some("dev".to_string()),
            active_runtime_id: None,
            last_claude_session_id: None,
            created_at: Utc::now(),
        };

        let message = format_topic_binding_success_message(&binding);
        assert!(message.contains("Bound this topic to:"));
        assert!(message.contains("Topic commands:"));
        assert!(message.contains("/new <prompt>"));
        assert!(message.contains("Tip: type /"));
    }

    #[test]
    fn new_topic_welcome_message_includes_command_hint() {
        let binding = TelegramTopicBinding {
            thread_id: 42,
            project_dir: "/tmp/project".to_string(),
            preferred_env: Some("official".to_string()),
            preferred_perm_mode: Some("dev".to_string()),
            active_runtime_id: None,
            last_claude_session_id: None,
            created_at: Utc::now(),
        };

        let message = format_new_topic_welcome_message(&binding);
        assert!(message.contains("This topic is ready"));
        assert!(message.contains("Topic commands:"));
        assert!(message.contains("/resume [prompt]"));
    }

    #[test]
    fn interactive_monitor_tracking_is_idempotent_per_scope() {
        let manager = TelegramBridgeManager::default();
        assert!(manager.ensure_interactive_monitor_for_scope(1, Some(2), "runtime-1"));
        assert!(!manager.ensure_interactive_monitor_for_scope(1, Some(2), "runtime-1"));
        assert!(manager.ensure_interactive_monitor_for_scope(1, Some(2), "runtime-2"));
    }

    #[test]
    fn clear_last_error_marks_bridge_running_again() {
        let manager = TelegramBridgeManager::default();
        manager.set_last_error("temporary getUpdates failure");
        assert!(!manager.status().running);

        manager.clear_last_error();
        let status = manager.status();
        assert!(status.running);
        assert_eq!(status.last_error, None);
    }

    #[test]
    fn pending_interactive_messages_are_fifo_per_scope() {
        let manager = TelegramBridgeManager::default();
        assert_eq!(
            manager.queue_interactive_message(1, Some(2), "first".to_string()),
            1
        );
        assert_eq!(
            manager.queue_interactive_message(1, Some(2), "second".to_string()),
            2
        );
        assert_eq!(
            manager.pop_pending_interactive_action(1, Some(2)),
            Some(PendingInteractiveAction::FreeText("first".to_string()))
        );
        assert_eq!(
            manager.pop_pending_interactive_action(1, Some(2)),
            Some(PendingInteractiveAction::FreeText("second".to_string()))
        );
        assert_eq!(manager.pop_pending_interactive_action(1, Some(2)), None);
    }

    #[test]
    fn interactive_tool_callback_parsers_accept_expected_payloads() {
        assert_eq!(
            parse_interactive_tool_select_callback_data("tool_i:select:2"),
            Some(2)
        );
        assert_eq!(
            parse_interactive_tool_select_callback_data("tool_i:select:not-a-number"),
            None
        );
        assert!(parse_interactive_tool_submit_callback_data("tool_i:submit"));
        assert!(parse_interactive_tool_cancel_callback_data("tool_i:cancel"));
    }

    #[test]
    fn text_entry_option_detection_supports_type_here_variants() {
        assert!(is_vscode_text_entry_option("Type something"));
        assert!(is_vscode_text_entry_option(
            "Type here to tell Claude what to change"
        ));
        assert!(!is_vscode_text_entry_option("Yes, manually approve edits"));
    }

    #[test]
    fn chat_about_this_detection_matches_tui_label() {
        assert!(is_chat_about_this_option("Chat about this"));
        assert!(!is_chat_about_this_option("Type something"));
    }

    #[test]
    fn build_plan_exit_question_includes_text_entry_option() {
        let prompt = build_plan_exit_question(
            Some("Step 1: write hello.sh\nStep 2: run it"),
            &["Type here to tell Claude what to change".to_string()],
        );

        assert_eq!(prompt.header.as_deref(), Some("Ready to code?"));
        assert!(prompt.question.contains("Would you like to proceed?"));
        assert_eq!(prompt.options.len(), 4);
        assert!(prompt.options[3].label.contains("Type here"));
    }

    #[test]
    fn ensure_text_entry_option_appends_missing_type_something_choice() {
        let prompt = ToolQuestionPrompt {
            header: Some("Question".to_string()),
            question: "你更喜欢哪种工作方式?".to_string(),
            multi_select: false,
            options: vec![ToolQuestionOption {
                label: "独立工作".to_string(),
                description: None,
                preview: None,
            }],
        };

        let enriched = ensure_text_entry_option(&prompt);
        assert_eq!(enriched.options.len(), 2);
        assert_eq!(enriched.options[1].label, "Type something");
    }

    #[test]
    fn ensure_chat_about_this_option_appends_for_preview_questions() {
        let prompt = ToolQuestionPrompt {
            header: Some("UI 风格".to_string()),
            question: "你更喜欢哪种 UI 风格？".to_string(),
            multi_select: false,
            options: vec![ToolQuestionOption {
                label: "Glassmorphism".to_string(),
                description: Some("玻璃质感".to_string()),
                preview: Some("preview".to_string()),
            }],
        };

        let enriched = ensure_chat_about_this_option(&prompt);
        assert_eq!(enriched.options.len(), 2);
        assert_eq!(enriched.options[1].label, "Chat about this");

        let normalized = ensure_text_entry_option(&enriched);
        assert_eq!(normalized.options.len(), 2);
        assert!(normalized
            .options
            .iter()
            .all(|option| option.label != "Type something"));
    }

    #[test]
    fn ensure_text_entry_option_supports_text_only_prompt() {
        let prompt = ToolQuestionPrompt {
            header: None,
            question: "请描述你的工作方式".to_string(),
            multi_select: false,
            options: vec![],
        };

        let enriched = ensure_text_entry_option(&prompt);
        assert_eq!(enriched.options.len(), 1);
        assert_eq!(enriched.options[0].label, "Type something");
    }

    #[test]
    fn selection_submit_options_skips_type_something_choice() {
        let prompt = ToolQuestionPrompt {
            header: None,
            question: "你希望 CCEM 未来增加哪些功能？".to_string(),
            multi_select: true,
            options: vec![
                ToolQuestionOption {
                    label: "团队协作".to_string(),
                    description: None,
                    preview: None,
                },
                ToolQuestionOption {
                    label: "Type something".to_string(),
                    description: None,
                    preview: None,
                },
            ],
        };

        let selected: BTreeSet<usize> = [1usize, 2usize].into_iter().collect();
        let filtered = selection_submit_options(&prompt, &selected);
        assert_eq!(filtered, [1usize].into_iter().collect());
    }

    #[test]
    fn selection_submit_options_skips_chat_about_this_choice() {
        let prompt = ToolQuestionPrompt {
            header: Some("UI 风格".to_string()),
            question: "你更喜欢哪种 UI 风格？".to_string(),
            multi_select: false,
            options: vec![
                ToolQuestionOption {
                    label: "Glassmorphism".to_string(),
                    description: None,
                    preview: Some("preview".to_string()),
                },
                ToolQuestionOption {
                    label: "Chat about this".to_string(),
                    description: Some("Clarify".to_string()),
                    preview: None,
                },
            ],
        };

        let selected: BTreeSet<usize> = [1usize, 2usize].into_iter().collect();
        let filtered = selection_submit_options(&prompt, &selected);
        assert_eq!(filtered, [1usize].into_iter().collect());
    }

    #[test]
    fn build_multi_select_text_entry_steps_focuses_requested_option() {
        let steps = build_multi_select_text_entry_steps(4);
        let keys = steps
            .iter()
            .map(|(step, _)| step.as_str())
            .collect::<Vec<_>>();
        assert_eq!(keys[..6], ["\u{1b}[A"; 6]);
        assert_eq!(keys[6..9], ["\u{1b}[B"; 3]);
        assert_eq!(keys[9], "\r");
    }

    #[test]
    fn build_multi_select_submit_steps_tabs_then_confirms() {
        let selected: BTreeSet<usize> = [1usize, 3usize].into_iter().collect();
        let steps = build_multi_select_submit_steps(&selected);
        let keys = steps
            .iter()
            .map(|(step, _)| step.as_str())
            .collect::<Vec<_>>();
        assert_eq!(keys, vec!["1", "3", "\t", "\r", "1"]);
    }

    #[test]
    fn build_chat_about_this_steps_navigates_below_visible_options() {
        let steps = build_chat_about_this_steps(3);
        let keys = steps
            .iter()
            .map(|(step, _)| step.as_str())
            .collect::<Vec<_>>();
        assert_eq!(keys, vec!["\u{1b}[B", "\u{1b}[B", "\u{1b}[B", "\r"]);
    }

    #[test]
    fn summarize_interactive_prompt_resolution_compacts_clarify_mode() {
        let summary = summarize_interactive_prompt_resolution(
            "AskUserQuestion",
            "The user doesn't want to proceed with this tool use. The tool use was rejected. The user wants to clarify these questions.",
        );
        assert!(summary.contains("clarification mode"));
        assert!(!summary.contains("doesn't want to proceed"));
    }

    #[test]
    fn format_tool_completed_message_suppresses_interactive_user_input_noise() {
        assert_eq!(
            format_tool_completed_message(
                "AskUserQuestion",
                "The user wants to clarify these questions.",
                false,
            ),
            None
        );
    }

    #[test]
    fn multi_question_prompt_text_includes_progress_and_uses_current_question() {
        let prompt = ActiveInteractiveChoicePrompt {
            runtime_id: "runtime-1".to_string(),
            tool_use_id: "toolu-1".to_string(),
            questions: vec![
                ToolQuestionPrompt {
                    header: Some("Question A".to_string()),
                    question: "你写代码多少年了？".to_string(),
                    multi_select: false,
                    options: vec![ToolQuestionOption {
                        label: "0-1 年".to_string(),
                        description: None,
                        preview: None,
                    }],
                },
                ToolQuestionPrompt {
                    header: Some("Question B".to_string()),
                    question: "你更喜欢什么工作模式？".to_string(),
                    multi_select: false,
                    options: vec![ToolQuestionOption {
                        label: "远程".to_string(),
                        description: None,
                        preview: None,
                    }],
                },
            ],
            current_question_index: 0,
            submit_mode: InteractiveChoiceSubmitMode::AskUserQuestion,
            selected_options: BTreeSet::new(),
            awaiting_text_entry: None,
            message_id: None,
        };

        let text = format_active_choice_text(&prompt);
        assert!(text.contains("Question 1/2"));
        assert!(text.contains("你写代码多少年了？"));
        assert!(!text.contains("你更喜欢什么工作模式？"));
    }

    #[test]
    fn advancing_multi_question_prompt_moves_to_next_question() {
        let mut prompt = ActiveInteractiveChoicePrompt {
            runtime_id: "runtime-1".to_string(),
            tool_use_id: "toolu-1".to_string(),
            questions: vec![
                ToolQuestionPrompt {
                    header: None,
                    question: "第一题".to_string(),
                    multi_select: false,
                    options: vec![ToolQuestionOption {
                        label: "A".to_string(),
                        description: None,
                        preview: None,
                    }],
                },
                ToolQuestionPrompt {
                    header: None,
                    question: "第二题".to_string(),
                    multi_select: true,
                    options: vec![ToolQuestionOption {
                        label: "B".to_string(),
                        description: None,
                        preview: None,
                    }],
                },
            ],
            current_question_index: 0,
            submit_mode: InteractiveChoiceSubmitMode::AskUserQuestion,
            selected_options: [1usize].into_iter().collect(),
            awaiting_text_entry: Some(1),
            message_id: Some(42),
        };

        assert!(advance_active_choice_prompt(&mut prompt));
        assert_eq!(prompt.current_question_index, 1);
        assert!(prompt.selected_options.is_empty());
        assert_eq!(prompt.awaiting_text_entry, None);
        assert_eq!(
            active_choice_question(&prompt).map(|question| question.question.as_str()),
            Some("第二题")
        );
    }

    #[test]
    fn mark_interactive_tool_seen_is_scoped_and_deduplicated() {
        let manager = TelegramBridgeManager::default();

        assert!(manager.mark_interactive_tool_seen(1, Some(2), "toolu-1"));
        assert!(!manager.mark_interactive_tool_seen(1, Some(2), "toolu-1"));
        assert!(manager.mark_interactive_tool_seen(1, Some(3), "toolu-1"));
        assert!(manager.mark_interactive_tool_seen(1, Some(2), "toolu-2"));
    }

    // ----- redact_telegram_token ------------------------------------------------
    //
    // The fake token constants below are intentionally invalid — they only
    // satisfy the shape (digits:secret) so the redactor matches them. They
    // are NOT live credentials.

    /// Shape-valid but non-live token used in every redaction test.
    const FAKE_TOKEN: &str = "123456789:ABCdef1234567890_ABCdef1234567890_X";
    /// Second distinct fake token so multi-occurrence tests can distinguish
    /// matches without reusing the same constant.
    const FAKE_TOKEN_TWO: &str = "9876543210:Zyxwvu0987654321_Zyxwvu0987654321_A";

    #[test]
    fn redact_telegram_token_strips_token_in_api_url() {
        let url = format!("https://api.telegram.org/bot{FAKE_TOKEN}/getMe");
        let redacted = redact_telegram_token(&url);
        assert!(!redacted.contains(FAKE_TOKEN), "token survived redaction");
        assert!(
            redacted.contains("api.telegram.org/bot"),
            "URL host and /bot prefix must be preserved: {redacted}"
        );
        assert!(
            redacted.contains("/getMe"),
            "endpoint name must be preserved: {redacted}"
        );
        assert!(
            redacted.contains("[REDACTED]"),
            "expected replacement marker: {redacted}"
        );
    }

    #[test]
    fn redact_telegram_token_strips_bare_token() {
        let redacted = redact_telegram_token(FAKE_TOKEN);
        assert_eq!(redacted, "[REDACTED]");
    }

    #[test]
    fn redact_telegram_token_preserves_diagnostic_context() {
        // Simulates the kind of error string reqwest produces, including the
        // URL with token, HTTP status, and a wrapped cause.
        let error = format!(
            "error sending request for url (https://api.telegram.org/bot{FAKE_TOKEN}/sendMessage): \
             connection refused (status 502)"
        );
        let redacted = redact_telegram_token(&error);
        assert!(!redacted.contains(FAKE_TOKEN));
        assert!(redacted.contains("status 502"));
        assert!(redacted.contains("connection refused"));
        assert!(redacted.contains("/sendMessage"));
        assert!(redacted.contains("[REDACTED]"));
    }

    #[test]
    fn redact_telegram_token_handles_multiple_tokens_in_one_string() {
        let combined = format!("first {FAKE_TOKEN} then {FAKE_TOKEN_TWO} end");
        let redacted = redact_telegram_token(&combined);
        assert!(!redacted.contains(FAKE_TOKEN));
        assert!(!redacted.contains(FAKE_TOKEN_TWO));
        assert_eq!(redacted, "first [REDACTED] then [REDACTED] end");
    }

    #[test]
    fn redact_telegram_token_preserves_non_token_digit_text() {
        // Years, status codes, port numbers, and short digit runs must survive
        // unchanged. None of these have the `<digits>:<long-secret>` shape.
        let cases = [
            "Status 503 returned in 2024",
            "connecting to host:443/path",
            "short id 12345 only",
            "time 12:34",
            "config v1.2.3",
        ];
        for case in cases {
            assert_eq!(redact_telegram_token(case), case, "non-token text changed");
        }
    }

    #[test]
    fn redact_telegram_token_handles_empty_and_plain_input() {
        assert_eq!(redact_telegram_token(""), "");
        assert_eq!(
            redact_telegram_token("no digits no colons here"),
            "no digits no colons here"
        );
    }

    #[test]
    fn redact_telegram_token_preserves_utf8_around_token() {
        let input = format!("桥接失败 bridge failed: {FAKE_TOKEN} 终止");
        let redacted = redact_telegram_token(&input);
        assert!(!redacted.contains(FAKE_TOKEN));
        assert!(redacted.contains("桥接失败 bridge failed:"));
        assert!(redacted.contains("终止"));
        assert!(redacted.contains("[REDACTED]"));
    }

    #[test]
    fn redact_telegram_token_strips_when_token_is_at_string_boundaries() {
        let leading = format!("{FAKE_TOKEN}/getUpdates");
        let redacted = redact_telegram_token(&leading);
        assert_eq!(redacted, "[REDACTED]/getUpdates");

        let trailing = format!("error: {FAKE_TOKEN}");
        let redacted = redact_telegram_token(&trailing);
        assert_eq!(redacted, "error: [REDACTED]");
    }

    #[test]
    fn redact_telegram_token_rejects_short_secrets() {
        // Too few secret chars → not a token, must be preserved verbatim.
        let short = "123456789:short";
        assert_eq!(redact_telegram_token(short), short);

        // Borderline: exactly 19 chars (under MIN_SECRET=20).
        let borderline = "123456789:abcdefghijklmnopqrstuvwxyzS"; // 30 chars actually
        assert!(
            redact_telegram_token(borderline).contains("[REDACTED]"),
            "30-char secret should be redacted"
        );
    }

    #[test]
    fn set_last_error_strips_telegram_token_from_persisted_state() {
        // Integration guard: even if a caller hands set_last_error a raw
        // transport error containing the token URL, the value surfaced
        // through status() must never carry the token.
        let manager = TelegramBridgeManager::default();
        let leaked = format!(
            "Telegram getUpdates failed: error sending request for url \
             (https://api.telegram.org/bot{FAKE_TOKEN}/getUpdates): timeout (status 504)"
        );

        manager.set_last_error(leaked);

        let status = manager.status();
        assert!(!status.running, "set_last_error must mark bridge as not running");
        let stored = status
            .last_error
            .as_deref()
            .expect("last_error should be populated");
        assert!(
            !stored.contains(FAKE_TOKEN),
            "last_error must not retain the bot token: {stored}"
        );
        assert!(
            stored.contains("/getUpdates"),
            "endpoint context must be preserved: {stored}"
        );
        assert!(
            stored.contains("status 504"),
            "HTTP status must be preserved: {stored}"
        );
        assert!(
            stored.contains("[REDACTED]"),
            "expected replacement marker in last_error: {stored}"
        );
    }
}
