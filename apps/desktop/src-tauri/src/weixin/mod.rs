mod channel;

use crate::config;
use crate::crypto;
use crate::remote::RemotePlatform;
use crate::runtime::{
    HeadlessRuntimeManager, HeadlessSessionOptions, HeadlessSessionSource, ManagedSessionSource,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chrono::{DateTime, Utc};
use rand::RngCore;
use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::any::Any;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

use self::channel::WeixinChannel;

const DEFAULT_WEIXIN_API_BASE: &str = "https://ilinkai.weixin.qq.com";
const WEIXIN_LOGIN_BOT_TYPE: &str = "3";
const WEIXIN_LONG_POLL_TIMEOUT_MS: u64 = 35_000;
const WEIXIN_QR_POLL_TIMEOUT_MS: u64 = 35_000;
const WEIXIN_API_TIMEOUT_MS: u64 = 15_000;
const WEIXIN_STOP_GRACE_TIMEOUT_SECS: u64 = 7;
const WEIXIN_STOP_POLL_INTERVAL_MS: u64 = 100;
const WEIXIN_RETRY_DELAY_MS: u64 = 2_000;
const WEIXIN_BACKOFF_DELAY_MS: u64 = 30_000;
const WEIXIN_MAX_CONSECUTIVE_FAILURES: usize = 3;
const WEIXIN_SESSION_EXPIRED_ERRCODE: i32 = -14;
const WEIXIN_TEXT_LIMIT: usize = 4000;
const WEIXIN_MESSAGE_TYPE_USER: i32 = 1;
const WEIXIN_MESSAGE_ITEM_TYPE_TEXT: i32 = 1;

fn default_api_base_url() -> String {
    DEFAULT_WEIXIN_API_BASE.to_string()
}

fn default_flush_interval_ms() -> u64 {
    3000
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeixinSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(
        rename = "apiBaseUrl",
        alias = "api_base_url",
        default = "default_api_base_url"
    )]
    pub api_base_url: String,
    #[serde(rename = "botToken", alias = "bot_token", default)]
    pub bot_token: Option<String>,
    #[serde(rename = "botAccountId", alias = "bot_account_id", default)]
    pub bot_account_id: Option<String>,
    #[serde(rename = "allowedPeerIds", alias = "allowed_peer_ids", default)]
    pub allowed_peer_ids: Vec<String>,
    #[serde(rename = "defaultEnvName", default)]
    pub default_env_name: Option<String>,
    #[serde(rename = "defaultPermMode", default)]
    pub default_perm_mode: Option<String>,
    #[serde(rename = "defaultWorkingDir", default)]
    pub default_working_dir: Option<String>,
    #[serde(
        rename = "flushIntervalMs",
        alias = "flush_interval_ms",
        default = "default_flush_interval_ms"
    )]
    pub flush_interval_ms: u64,
}

impl Default for WeixinSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            api_base_url: default_api_base_url(),
            bot_token: None,
            bot_account_id: None,
            allowed_peer_ids: Vec::new(),
            default_env_name: None,
            default_perm_mode: None,
            default_working_dir: None,
            flush_interval_ms: default_flush_interval_ms(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct WeixinStateFile {
    #[serde(
        rename = "syncCursor",
        alias = "sync_cursor",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    sync_cursor: Option<String>,
    #[serde(
        rename = "lastLoginAt",
        alias = "last_login_at",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    last_login_at: Option<DateTime<Utc>>,
    #[serde(
        rename = "lastError",
        alias = "last_error",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WeixinBridgeStatus {
    pub configured: bool,
    pub running: bool,
    #[serde(rename = "botAccountId")]
    pub bot_account_id: Option<String>,
    #[serde(rename = "lastError")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeixinLoginSession {
    #[serde(rename = "sessionKey")]
    pub session_key: String,
    pub status: String,
    #[serde(rename = "qrCodeUrl")]
    pub qr_code_url: Option<String>,
    pub message: String,
    #[serde(rename = "botAccountId")]
    pub bot_account_id: Option<String>,
    #[serde(rename = "expiresAt")]
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
struct ActiveWeixinLogin {
    session_key: String,
    qrcode: String,
    qr_code_url: String,
    api_base_url: String,
    expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default)]
struct WeixinBridgeState {
    configured: bool,
    running: bool,
    bot_account_id: Option<String>,
    last_error: Option<String>,
    active_runtime_by_peer: HashMap<String, String>,
    context_token_by_peer: HashMap<String, String>,
    permission_owner_by_request: HashMap<String, PermissionOwner>,
    active_login: Option<ActiveWeixinLogin>,
}

#[derive(Debug, Clone)]
struct PermissionOwner {
    peer_id: String,
    runtime_id: String,
}

enum PermissionResolution {
    None,
    Single(String),
    Ambiguous,
}

pub struct WeixinBridgeManager {
    state: Mutex<WeixinBridgeState>,
    stop_flag: AtomicBool,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
}

impl Default for WeixinBridgeManager {
    fn default() -> Self {
        Self {
            state: Mutex::new(WeixinBridgeState::default()),
            stop_flag: AtomicBool::new(false),
            worker: Mutex::new(None),
        }
    }
}

impl WeixinBridgeManager {
    pub fn status(&self) -> WeixinBridgeStatus {
        self.cleanup_finished_worker();
        let state = self
            .state
            .lock()
            .map(|state| state.clone())
            .unwrap_or_default();
        WeixinBridgeStatus {
            configured: state.configured,
            running: state.running,
            bot_account_id: state.bot_account_id,
            last_error: state.last_error,
        }
    }

    fn ensure_worker_stopped(&self, timeout: Duration) -> Result<(), String> {
        self.cleanup_finished_worker();
        let still_running = self
            .worker
            .lock()
            .map_err(|_| "Failed to lock Weixin bridge worker".to_string())?
            .as_ref()
            .is_some_and(|handle| !handle.is_finished());
        if !still_running {
            return Ok(());
        }

        self.stop_flag.store(true, Ordering::SeqCst);
        if self.wait_for_worker_shutdown(timeout) {
            Ok(())
        } else {
            Err(
                "Weixin bridge is still stopping. Wait for the previous long-poll request to finish."
                    .to_string(),
            )
        }
    }

    pub fn start(
        self: &Arc<Self>,
        app: AppHandle,
        runtime_manager: Arc<HeadlessRuntimeManager>,
    ) -> Result<WeixinBridgeStatus, String> {
        self.cleanup_finished_worker();

        {
            let state = self
                .state
                .lock()
                .map_err(|_| "Failed to lock Weixin bridge state".to_string())?;
            if state.running {
                return Ok(WeixinBridgeStatus {
                    configured: state.configured,
                    running: true,
                    bot_account_id: state.bot_account_id.clone(),
                    last_error: state.last_error.clone(),
                });
            }
        }

        self.ensure_worker_stopped(Duration::from_secs(WEIXIN_STOP_GRACE_TIMEOUT_SECS))?;

        let settings = read_weixin_settings()?;
        let token = settings
            .bot_token
            .clone()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                "Weixin bot token is not configured. Scan the login QR code first.".to_string()
            })?;

        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Failed to lock Weixin bridge state".to_string())?;
            self.stop_flag.store(false, Ordering::SeqCst);
            state.configured = true;
            state.running = true;
            state.bot_account_id = settings.bot_account_id.clone();
            state.last_error = None;
        }

        let manager = Arc::clone(self);
        let handle = thread::spawn(move || {
            run_bridge_loop(manager, app, runtime_manager, token, settings);
        });
        if let Ok(mut worker) = self.worker.lock() {
            *worker = Some(handle);
        }

        Ok(self.status())
    }

    pub fn stop(&self) -> WeixinBridgeStatus {
        self.stop_flag.store(true, Ordering::SeqCst);
        if let Ok(mut state) = self.state.lock() {
            state.running = false;
            state.active_runtime_by_peer.clear();
            state.context_token_by_peer.clear();
            state.permission_owner_by_request.clear();
        }
        self.status()
    }

    pub fn sync_settings(&self, settings: &WeixinSettings) {
        if let Ok(mut state) = self.state.lock() {
            state.configured = settings
                .bot_token
                .as_ref()
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false);
            state.bot_account_id = settings.bot_account_id.clone();
        }
    }

    pub fn start_login(&self) -> Result<WeixinLoginSession, String> {
        if self.status().running {
            return Err(
                "Stop the running Weixin bridge before scanning a new login QR code.".to_string(),
            );
        }
        self.ensure_worker_stopped(Duration::from_secs(WEIXIN_STOP_GRACE_TIMEOUT_SECS))?;

        let settings = read_weixin_settings()?;
        let api_base_url = normalize_api_base_url(&settings.api_base_url);
        let qr = fetch_qr_code(&api_base_url)?;
        let session_key = generate_client_id("wx-login");
        let expires_at =
            Utc::now() + chrono::Duration::milliseconds((WEIXIN_QR_POLL_TIMEOUT_MS * 8) as i64);

        if let Ok(mut state) = self.state.lock() {
            state.active_login = Some(ActiveWeixinLogin {
                session_key: session_key.clone(),
                qrcode: qr.qrcode,
                qr_code_url: qr.qrcode_img_content.clone(),
                api_base_url,
                expires_at,
            });
            state.last_error = None;
        }

        Ok(WeixinLoginSession {
            session_key,
            status: "pending".to_string(),
            qr_code_url: Some(qr.qrcode_img_content),
            message: "Scan the QR code with WeChat and confirm the login.".to_string(),
            bot_account_id: None,
            expires_at: Some(expires_at),
        })
    }

    pub fn poll_login(&self, session_key: &str) -> Result<WeixinLoginSession, String> {
        let active_login = self
            .state
            .lock()
            .map_err(|_| "Failed to lock Weixin login state".to_string())?
            .active_login
            .clone()
            .ok_or_else(|| {
                "No active Weixin login session. Start a new QR login first.".to_string()
            })?;

        if active_login.session_key != session_key {
            return Err("Weixin login session key is no longer valid.".to_string());
        }

        if Utc::now() >= active_login.expires_at {
            if let Ok(mut state) = self.state.lock() {
                state.active_login = None;
            }
            return Ok(WeixinLoginSession {
                session_key: session_key.to_string(),
                status: "expired".to_string(),
                qr_code_url: Some(active_login.qr_code_url),
                message: "The QR code has expired. Start a new login session.".to_string(),
                bot_account_id: None,
                expires_at: Some(active_login.expires_at),
            });
        }

        let status = poll_qr_status(&active_login.api_base_url, &active_login.qrcode)?;
        match status.status.as_deref() {
            Some("wait") => Ok(WeixinLoginSession {
                session_key: session_key.to_string(),
                status: "pending".to_string(),
                qr_code_url: Some(active_login.qr_code_url),
                message: "Waiting for QR code scan.".to_string(),
                bot_account_id: None,
                expires_at: Some(active_login.expires_at),
            }),
            Some("scaned") => Ok(WeixinLoginSession {
                session_key: session_key.to_string(),
                status: "scanned".to_string(),
                qr_code_url: Some(active_login.qr_code_url),
                message: "QR code scanned. Confirm the login in WeChat.".to_string(),
                bot_account_id: None,
                expires_at: Some(active_login.expires_at),
            }),
            Some("confirmed") => {
                let bot_token = status
                    .bot_token
                    .clone()
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| "Weixin login confirmed without bot token.".to_string())?;
                let bot_account_id = status
                    .ilink_bot_id
                    .clone()
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| "Weixin login confirmed without bot account id.".to_string())?;

                let mut settings = read_weixin_settings()?;
                settings.bot_token = Some(bot_token);
                settings.bot_account_id = Some(bot_account_id.clone());
                if let Some(base_url) = status.baseurl.filter(|value| !value.trim().is_empty()) {
                    settings.api_base_url = normalize_api_base_url(&base_url);
                }
                write_weixin_settings(&settings)?;
                write_weixin_state(&WeixinStateFile {
                    sync_cursor: None,
                    last_login_at: Some(Utc::now()),
                    last_error: None,
                })?;
                self.sync_settings(&settings);

                if let Ok(mut state) = self.state.lock() {
                    state.active_login = None;
                }

                Ok(WeixinLoginSession {
                    session_key: session_key.to_string(),
                    status: "confirmed".to_string(),
                    qr_code_url: None,
                    message: "Weixin login confirmed and saved.".to_string(),
                    bot_account_id: Some(bot_account_id),
                    expires_at: None,
                })
            }
            Some("expired") => {
                if let Ok(mut state) = self.state.lock() {
                    state.active_login = None;
                }
                Ok(WeixinLoginSession {
                    session_key: session_key.to_string(),
                    status: "expired".to_string(),
                    qr_code_url: Some(active_login.qr_code_url),
                    message: "The QR code expired before confirmation.".to_string(),
                    bot_account_id: None,
                    expires_at: Some(active_login.expires_at),
                })
            }
            _ => Ok(WeixinLoginSession {
                session_key: session_key.to_string(),
                status: "failed".to_string(),
                qr_code_url: Some(active_login.qr_code_url),
                message: "Weixin login failed. Start a new QR login session.".to_string(),
                bot_account_id: None,
                expires_at: Some(active_login.expires_at),
            }),
        }
    }

    fn set_last_error(&self, message: impl Into<String>) {
        let message = message.into();
        if let Ok(mut state) = self.state.lock() {
            state.last_error = Some(message.clone());
            state.running = false;
        }
        let _ = write_weixin_state(&WeixinStateFile {
            sync_cursor: read_weixin_state().ok().and_then(|state| state.sync_cursor),
            last_login_at: read_weixin_state()
                .ok()
                .and_then(|state| state.last_login_at),
            last_error: Some(message),
        });
    }

    fn remember_context_token(&self, peer_id: &str, context_token: String) {
        if let Ok(mut state) = self.state.lock() {
            state
                .context_token_by_peer
                .insert(peer_id.to_string(), context_token);
        }
    }

    fn context_token_for_peer(&self, peer_id: &str) -> Option<String> {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.context_token_by_peer.get(peer_id).cloned())
    }

    fn remember_runtime_for_peer(&self, peer_id: &str, runtime_id: String) {
        if let Ok(mut state) = self.state.lock() {
            state
                .active_runtime_by_peer
                .insert(peer_id.to_string(), runtime_id);
        }
    }

    fn active_runtime_for_peer(&self, peer_id: &str) -> Option<String> {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.active_runtime_by_peer.get(peer_id).cloned())
    }

    fn clear_runtime_for_peer_if_matches(&self, peer_id: &str, runtime_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            let should_remove = state
                .active_runtime_by_peer
                .get(peer_id)
                .is_some_and(|current| current == runtime_id);
            if should_remove {
                state.active_runtime_by_peer.remove(peer_id);
            }
        }
    }

    fn remember_permission_request(&self, request_id: &str, peer_id: &str, runtime_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.permission_owner_by_request.insert(
                request_id.to_string(),
                PermissionOwner {
                    peer_id: peer_id.to_string(),
                    runtime_id: runtime_id.to_string(),
                },
            );
        }
    }

    fn permission_belongs_to_peer(&self, request_id: &str, peer_id: &str) -> bool {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.permission_owner_by_request.get(request_id).cloned())
            .is_some_and(|owner| owner.peer_id == peer_id)
    }

    fn runtime_for_permission_request(&self, request_id: &str) -> Option<String> {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.permission_owner_by_request.get(request_id).cloned())
            .map(|owner| owner.runtime_id)
    }

    fn clear_permission_request(&self, request_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.permission_owner_by_request.remove(request_id);
        }
    }

    fn resolve_permission_for_peer(
        &self,
        peer_id: &str,
        preferred_runtime_id: Option<&str>,
    ) -> PermissionResolution {
        let Ok(state) = self.state.lock() else {
            return PermissionResolution::None;
        };

        let matching = state
            .permission_owner_by_request
            .iter()
            .filter(|(_, owner)| owner.peer_id == peer_id)
            .map(|(request_id, owner)| (request_id.clone(), owner.runtime_id.clone()))
            .collect::<Vec<_>>();

        if matching.is_empty() {
            return PermissionResolution::None;
        }

        if let Some(runtime_id) = preferred_runtime_id {
            let preferred = matching
                .iter()
                .filter(|(_, owner_runtime_id)| owner_runtime_id == runtime_id)
                .map(|(request_id, _)| request_id.clone())
                .collect::<Vec<_>>();
            if preferred.len() == 1 {
                return PermissionResolution::Single(preferred[0].clone());
            }
            if preferred.len() > 1 {
                return PermissionResolution::Ambiguous;
            }
        }

        if matching.len() == 1 {
            PermissionResolution::Single(matching[0].0.clone())
        } else {
            PermissionResolution::Ambiguous
        }
    }

    fn clear_permission_requests_for_runtime(&self, runtime_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            state
                .permission_owner_by_request
                .retain(|_, owner| owner.runtime_id != runtime_id);
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
                                "Weixin bridge worker panicked: {}",
                                panic_payload_to_string(payload)
                            ));
                        } else if state.last_error.is_none() {
                            state.last_error =
                                Some("Weixin bridge worker exited unexpectedly.".to_string());
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
            thread::sleep(Duration::from_millis(WEIXIN_STOP_POLL_INTERVAL_MS));
        }
    }
}

#[derive(Debug, Deserialize)]
struct WeixinQrCodeResponse {
    qrcode: String,
    qrcode_img_content: String,
}

#[derive(Debug, Deserialize)]
struct WeixinQrStatusResponse {
    status: Option<String>,
    bot_token: Option<String>,
    ilink_bot_id: Option<String>,
    baseurl: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WeixinGetUpdatesResponse {
    ret: Option<i32>,
    errcode: Option<i32>,
    errmsg: Option<String>,
    #[serde(default)]
    msgs: Vec<WeixinMessage>,
    #[serde(rename = "get_updates_buf")]
    get_updates_buf: Option<String>,
    #[serde(rename = "longpolling_timeout_ms")]
    longpolling_timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
struct WeixinMessage {
    from_user_id: Option<String>,
    group_id: Option<String>,
    message_type: Option<i32>,
    #[serde(default)]
    item_list: Vec<WeixinMessageItem>,
    context_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct WeixinMessageItem {
    #[serde(rename = "type")]
    item_type: Option<i32>,
    text_item: Option<WeixinTextItem>,
}

#[derive(Debug, Clone, Deserialize)]
struct WeixinTextItem {
    text: Option<String>,
}

fn run_bridge_loop(
    manager: Arc<WeixinBridgeManager>,
    app: AppHandle,
    runtime_manager: Arc<HeadlessRuntimeManager>,
    token: String,
    boot_settings: WeixinSettings,
) {
    let mut sync_cursor = read_weixin_state()
        .ok()
        .and_then(|state| state.sync_cursor)
        .unwrap_or_default();
    let mut next_timeout_ms = WEIXIN_LONG_POLL_TIMEOUT_MS;
    let mut consecutive_failures = 0usize;

    while !manager.stop_flag.load(Ordering::SeqCst) {
        let settings = read_weixin_settings().unwrap_or_else(|_| boot_settings.clone());
        let api_base_url = normalize_api_base_url(&settings.api_base_url);

        match get_updates(&api_base_url, &token, &sync_cursor, next_timeout_ms) {
            Ok(response) => {
                let is_api_error = response.ret.is_some_and(|ret| ret != 0)
                    || response.errcode.is_some_and(|code| code != 0);
                if is_api_error {
                    let errcode = response.errcode.or(response.ret).unwrap_or_default();
                    if errcode == WEIXIN_SESSION_EXPIRED_ERRCODE {
                        manager.set_last_error(
                            "Weixin session expired. Re-scan the QR login code to continue.",
                        );
                        break;
                    }

                    consecutive_failures += 1;
                    eprintln!(
                        "[weixin] getupdates failed: errcode={} errmsg={:?} ({}/{})",
                        errcode,
                        response.errmsg,
                        consecutive_failures,
                        WEIXIN_MAX_CONSECUTIVE_FAILURES
                    );
                    if consecutive_failures >= WEIXIN_MAX_CONSECUTIVE_FAILURES {
                        consecutive_failures = 0;
                        thread::sleep(Duration::from_millis(WEIXIN_BACKOFF_DELAY_MS));
                    } else {
                        thread::sleep(Duration::from_millis(WEIXIN_RETRY_DELAY_MS));
                    }
                    continue;
                }

                consecutive_failures = 0;
                if let Some(timeout_ms) = response.longpolling_timeout_ms.filter(|value| *value > 0)
                {
                    next_timeout_ms = timeout_ms;
                }
                if let Some(cursor) = response.get_updates_buf.filter(|value| !value.is_empty()) {
                    sync_cursor = cursor.clone();
                    let mut state_file = read_weixin_state().unwrap_or_default();
                    state_file.sync_cursor = Some(cursor);
                    state_file.last_error = None;
                    let _ = write_weixin_state(&state_file);
                }

                for message in response.msgs {
                    if manager.stop_flag.load(Ordering::SeqCst) {
                        break;
                    }
                    if let Err(error) =
                        handle_message(&manager, &app, &runtime_manager, &token, &settings, message)
                    {
                        eprintln!("[weixin] failed to handle message: {}", error);
                    }
                }
            }
            Err(error) => {
                if manager.stop_flag.load(Ordering::SeqCst) {
                    break;
                }
                consecutive_failures += 1;
                eprintln!(
                    "[weixin] getupdates error ({}/{}): {}",
                    consecutive_failures, WEIXIN_MAX_CONSECUTIVE_FAILURES, error
                );
                if consecutive_failures >= WEIXIN_MAX_CONSECUTIVE_FAILURES {
                    consecutive_failures = 0;
                    thread::sleep(Duration::from_millis(WEIXIN_BACKOFF_DELAY_MS));
                } else {
                    thread::sleep(Duration::from_millis(WEIXIN_RETRY_DELAY_MS));
                }
            }
        }
    }

    if let Ok(mut state) = manager.state.lock() {
        state.running = false;
    }
}

fn handle_message(
    manager: &Arc<WeixinBridgeManager>,
    app: &AppHandle,
    runtime_manager: &Arc<HeadlessRuntimeManager>,
    token: &str,
    settings: &WeixinSettings,
    message: WeixinMessage,
) -> Result<(), String> {
    if message.message_type != Some(WEIXIN_MESSAGE_TYPE_USER) {
        return Ok(());
    }

    if message
        .group_id
        .as_ref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        return Ok(());
    }

    let peer_id = message
        .from_user_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Weixin message missing sender id".to_string())?
        .to_string();

    if !is_peer_allowed(settings, &peer_id) {
        return Ok(());
    }

    let context_token = message
        .context_token
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Weixin message missing context token".to_string())?;
    manager.remember_context_token(&peer_id, context_token);

    let text = extract_message_text(&message)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_default();
    if text.is_empty() {
        return Ok(());
    }

    let active_runtime_id = resolve_active_runtime_for_peer(manager, runtime_manager, &peer_id);

    if text == "/help" {
        send_text_message(
            manager,
            &settings.api_base_url,
            token,
            &peer_id,
            "CCEM Weixin bridge is running.\nCommands:\n/help\n/whoami\n/envs\n/sessions\n/new <prompt>\n/stop [runtime_id]\n/approve [request_id]\n/deny [request_id]\nYou can also reply with 通过 / 拒绝 when a permission prompt is pending.\nPlain text continues the current session or starts a new headless session.",
        )?;
        return Ok(());
    }

    if text == "/whoami" {
        let bot_account_id = settings.bot_account_id.as_deref().unwrap_or("unknown");
        send_text_message(
            manager,
            &settings.api_base_url,
            token,
            &peer_id,
            &format!("peer_id: {peer_id}\nbot_account_id: {bot_account_id}"),
        )?;
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
        send_text_message(manager, &settings.api_base_url, token, &peer_id, &body)?;
        return Ok(());
    }

    if text == "/sessions" {
        let sessions = runtime_manager
            .list_sessions()
            .into_iter()
            .filter(|session| {
                session.is_active && session_belongs_to_peer(&session.source, &peer_id)
            })
            .collect::<Vec<_>>();
        let active_runtime_id = resolve_active_runtime_for_peer(manager, runtime_manager, &peer_id);
        let body = if sessions.is_empty() {
            "No active Weixin sessions for this peer.".to_string()
        } else {
            sessions
                .into_iter()
                .map(|session| {
                    let suffix =
                        if active_runtime_id.as_deref() == Some(session.runtime_id.as_str()) {
                            " · current"
                        } else {
                            ""
                        };
                    format!(
                        "{} · {} · {}{}",
                        session.runtime_id, session.status, session.project_dir, suffix
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        };
        send_text_message(manager, &settings.api_base_url, token, &peer_id, &body)?;
        return Ok(());
    }

    if text == "/new" {
        send_text_message(
            manager,
            &settings.api_base_url,
            token,
            &peer_id,
            "Usage: /new <prompt>",
        )?;
        return Ok(());
    }

    if let Some(prompt) = text.strip_prefix("/new ").map(str::trim) {
        if prompt.is_empty() {
            send_text_message(
                manager,
                &settings.api_base_url,
                token,
                &peer_id,
                "Usage: /new <prompt>",
            )?;
            return Ok(());
        }
        return create_weixin_session(
            manager,
            app,
            runtime_manager,
            token,
            settings,
            &peer_id,
            prompt,
        );
    }

    if let Some(argument) = text.strip_prefix("/stop").map(str::trim) {
        let runtime_id = if argument.is_empty() {
            active_runtime_id.clone()
        } else {
            Some(argument.to_string())
        };
        let Some(runtime_id) = runtime_id else {
            send_text_message(
                manager,
                &settings.api_base_url,
                token,
                &peer_id,
                "No active Weixin session to stop.",
            )?;
            return Ok(());
        };

        let Some(summary) = runtime_manager.summary(&runtime_id) else {
            send_text_message(
                manager,
                &settings.api_base_url,
                token,
                &peer_id,
                &format!("Unknown runtime: {runtime_id}"),
            )?;
            return Ok(());
        };
        if !session_belongs_to_peer(&summary.source, &peer_id) {
            send_text_message(
                manager,
                &settings.api_base_url,
                token,
                &peer_id,
                "That runtime does not belong to this Weixin peer.",
            )?;
            return Ok(());
        }
        runtime_manager.stop_session(app, &runtime_id)?;
        manager.clear_runtime_for_peer_if_matches(&peer_id, &runtime_id);
        send_text_message(
            manager,
            &settings.api_base_url,
            token,
            &peer_id,
            &format!("Stopping session {runtime_id}"),
        )?;
        return Ok(());
    }

    if text == "/approve" {
        match manager.resolve_permission_for_peer(&peer_id, active_runtime_id.as_deref()) {
            PermissionResolution::Single(request_id) => {
                ensure_permission_runtime_connected(
                    manager,
                    app,
                    runtime_manager,
                    token,
                    settings,
                    &peer_id,
                    &request_id,
                )?;
                runtime_manager.respond_to_permission(app, &request_id, true, "weixin")?;
            }
            PermissionResolution::None => {
                send_text_message(
                    manager,
                    &settings.api_base_url,
                    token,
                    &peer_id,
                    "No pending permission request for this Weixin peer.",
                )?;
            }
            PermissionResolution::Ambiguous => {
                send_text_message(
                    manager,
                    &settings.api_base_url,
                    token,
                    &peer_id,
                    "Multiple permission requests are waiting. Use CCEM Desktop to choose one.",
                )?;
            }
        }
        return Ok(());
    }

    if let Some(request_id) = text.strip_prefix("/approve ").map(str::trim) {
        if !manager.permission_belongs_to_peer(request_id, &peer_id) {
            send_text_message(
                manager,
                &settings.api_base_url,
                token,
                &peer_id,
                "Permission request not found for this Weixin peer.",
            )?;
            return Ok(());
        }
        ensure_permission_runtime_connected(
            manager,
            app,
            runtime_manager,
            token,
            settings,
            &peer_id,
            request_id,
        )?;
        runtime_manager.respond_to_permission(app, request_id, true, "weixin")?;
        return Ok(());
    }

    if text == "/deny" {
        match manager.resolve_permission_for_peer(&peer_id, active_runtime_id.as_deref()) {
            PermissionResolution::Single(request_id) => {
                ensure_permission_runtime_connected(
                    manager,
                    app,
                    runtime_manager,
                    token,
                    settings,
                    &peer_id,
                    &request_id,
                )?;
                runtime_manager.respond_to_permission(app, &request_id, false, "weixin")?;
            }
            PermissionResolution::None => {
                send_text_message(
                    manager,
                    &settings.api_base_url,
                    token,
                    &peer_id,
                    "No pending permission request for this Weixin peer.",
                )?;
            }
            PermissionResolution::Ambiguous => {
                send_text_message(
                    manager,
                    &settings.api_base_url,
                    token,
                    &peer_id,
                    "Multiple permission requests are waiting. Use CCEM Desktop to choose one.",
                )?;
            }
        }
        return Ok(());
    }

    if let Some(request_id) = text.strip_prefix("/deny ").map(str::trim) {
        if !manager.permission_belongs_to_peer(request_id, &peer_id) {
            send_text_message(
                manager,
                &settings.api_base_url,
                token,
                &peer_id,
                "Permission request not found for this Weixin peer.",
            )?;
            return Ok(());
        }
        ensure_permission_runtime_connected(
            manager,
            app,
            runtime_manager,
            token,
            settings,
            &peer_id,
            request_id,
        )?;
        runtime_manager.respond_to_permission(app, request_id, false, "weixin")?;
        return Ok(());
    }

    if let Some(approved) = parse_permission_reply(&text) {
        match manager.resolve_permission_for_peer(&peer_id, active_runtime_id.as_deref()) {
            PermissionResolution::Single(request_id) => {
                ensure_permission_runtime_connected(
                    manager,
                    app,
                    runtime_manager,
                    token,
                    settings,
                    &peer_id,
                    &request_id,
                )?;
                runtime_manager.respond_to_permission(app, &request_id, approved, "weixin")?;
                return Ok(());
            }
            PermissionResolution::Ambiguous => {
                send_text_message(
                    manager,
                    &settings.api_base_url,
                    token,
                    &peer_id,
                    "Multiple permission requests are waiting. Use CCEM Desktop to choose one.",
                )?;
                return Ok(());
            }
            PermissionResolution::None => {}
        }
    }

    if let Some(runtime_id) = active_runtime_id {
        ensure_weixin_output_channel_connected(
            manager,
            app,
            runtime_manager,
            token,
            settings,
            &runtime_id,
            &peer_id,
        )?;
        runtime_manager.send_user_message(app, &runtime_id, &text)?;
        send_text_message(
            manager,
            &settings.api_base_url,
            token,
            &peer_id,
            &format!("Sent follow-up to {runtime_id}"),
        )?;
        return Ok(());
    }

    create_weixin_session(
        manager,
        app,
        runtime_manager,
        token,
        settings,
        &peer_id,
        &text,
    )
}

fn create_weixin_session(
    manager: &Arc<WeixinBridgeManager>,
    app: &AppHandle,
    runtime_manager: &Arc<HeadlessRuntimeManager>,
    token: &str,
    settings: &WeixinSettings,
    peer_id: &str,
    prompt: &str,
) -> Result<(), String> {
    let env_name = settings
        .default_env_name
        .clone()
        .or_else(|| config::read_config().ok().and_then(|cfg| cfg.current))
        .unwrap_or_else(|| "official".to_string());
    let perm_mode = settings
        .default_perm_mode
        .clone()
        .unwrap_or_else(|| "dev".to_string());
    let working_dir = settings
        .default_working_dir
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
            resume_session_id: None,
            initial_prompt: (!prompt.trim().is_empty()).then(|| prompt.to_string()),
            max_budget_usd: None,
            allowed_tools: Vec::new(),
            disallowed_tools: Vec::new(),
            env_vars: resolved.env_vars,
            source: HeadlessSessionSource::Weixin {
                peer_id: peer_id.to_string(),
            },
        },
    )?;

    manager.remember_runtime_for_peer(peer_id, summary.runtime_id.clone());
    send_text_message(
        manager,
        &settings.api_base_url,
        token,
        peer_id,
        &format!(
            "Started {} in {}\nCCEM will reply here when Claude responds.",
            summary.runtime_id, working_dir
        ),
    )?;

    let _ = ensure_weixin_output_channel_connected(
        manager,
        app,
        runtime_manager,
        token,
        settings,
        &summary.runtime_id,
        peer_id,
    )?;

    Ok(())
}

fn parse_permission_reply(text: &str) -> Option<bool> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }

    match trimmed {
        "通过" | "同意" | "批准" | "允许" => return Some(true),
        "拒绝" | "驳回" | "不通过" => return Some(false),
        _ => {}
    }

    match trimmed.to_ascii_lowercase().as_str() {
        "approve" | "approved" | "ok" | "yes" | "y" | "pass" => Some(true),
        "deny" | "denied" | "reject" | "no" | "n" => Some(false),
        _ => None,
    }
}

fn resolve_active_runtime_for_peer(
    manager: &Arc<WeixinBridgeManager>,
    runtime_manager: &Arc<HeadlessRuntimeManager>,
    peer_id: &str,
) -> Option<String> {
    if let Some(runtime_id) = manager.active_runtime_for_peer(peer_id) {
        if runtime_manager
            .summary(&runtime_id)
            .is_some_and(|summary| summary.is_active)
        {
            return Some(runtime_id);
        }
        manager.clear_runtime_for_peer_if_matches(peer_id, &runtime_id);
    }

    let newest = runtime_manager
        .list_sessions()
        .into_iter()
        .filter(|summary| summary.is_active && session_belongs_to_peer(&summary.source, peer_id))
        .max_by_key(|summary| summary.created_at);

    newest.map(|summary| {
        manager.remember_runtime_for_peer(peer_id, summary.runtime_id.clone());
        summary.runtime_id
    })
}

fn session_belongs_to_peer(source: &ManagedSessionSource, peer_id: &str) -> bool {
    source.matches_remote_peer(RemotePlatform::Weixin, peer_id, None)
}

fn ensure_permission_runtime_connected(
    manager: &Arc<WeixinBridgeManager>,
    app: &AppHandle,
    runtime_manager: &Arc<HeadlessRuntimeManager>,
    token: &str,
    settings: &WeixinSettings,
    peer_id: &str,
    request_id: &str,
) -> Result<(), String> {
    let Some(runtime_id) = manager.runtime_for_permission_request(request_id) else {
        return Ok(());
    };
    let _ = ensure_weixin_output_channel_connected(
        manager,
        app,
        runtime_manager,
        token,
        settings,
        &runtime_id,
        peer_id,
    )?;
    Ok(())
}

fn ensure_weixin_output_channel_connected(
    manager: &Arc<WeixinBridgeManager>,
    app: &AppHandle,
    runtime_manager: &Arc<HeadlessRuntimeManager>,
    token: &str,
    settings: &WeixinSettings,
    runtime_id: &str,
    peer_id: &str,
) -> Result<bool, String> {
    let unified_runtime_manager = app.state::<Arc<crate::unified_runtime::UnifiedSessionManager>>();
    let channel_kind = crate::channel::ChannelKind::Weixin {
        peer_id: peer_id.to_string(),
    };
    if unified_runtime_manager
        .inner()
        .has_connected_channel(runtime_id, &channel_kind)
    {
        return Ok(false);
    }

    let channel = Arc::new(WeixinChannel::new(
        Arc::clone(manager),
        token.to_string(),
        normalize_api_base_url(&settings.api_base_url),
        settings.flush_interval_ms,
        runtime_id.to_string(),
        peer_id.to_string(),
    ));
    attach_weixin_output_channel(app, runtime_id, channel.clone())?;
    replay_headless_events_to_channel(runtime_manager, runtime_id, channel.as_ref());
    channel.finish_initial_replay()?;
    spawn_session_monitor(manager, app, runtime_manager, runtime_id, peer_id);
    Ok(true)
}

fn spawn_session_monitor(
    manager: &Arc<WeixinBridgeManager>,
    app: &AppHandle,
    runtime_manager: &Arc<HeadlessRuntimeManager>,
    runtime_id: &str,
    peer_id: &str,
) {
    let manager = Arc::clone(manager);
    let runtime_manager = Arc::clone(runtime_manager);
    let app_handle = app.clone();
    let runtime_id = runtime_id.to_string();
    let peer_id = peer_id.to_string();
    thread::spawn(move || {
        monitor_session_completion(manager, app_handle, runtime_manager, runtime_id, peer_id);
    });
}

fn monitor_session_completion(
    manager: Arc<WeixinBridgeManager>,
    app: AppHandle,
    runtime_manager: Arc<HeadlessRuntimeManager>,
    runtime_id: String,
    peer_id: String,
) {
    loop {
        if manager.stop_flag.load(Ordering::SeqCst) {
            break;
        }

        let is_active = runtime_manager
            .summary(&runtime_id)
            .is_some_and(|summary| summary.is_active);
        if !is_active {
            break;
        }
        thread::sleep(Duration::from_millis(350));
    }

    manager.clear_runtime_for_peer_if_matches(&peer_id, &runtime_id);
    manager.clear_permission_requests_for_runtime(&runtime_id);
    detach_weixin_output_channel(&app, &runtime_id, &peer_id);
}

fn attach_weixin_output_channel(
    app: &AppHandle,
    runtime_id: &str,
    channel: Arc<WeixinChannel>,
) -> Result<(), String> {
    let unified_runtime_manager = app.state::<Arc<crate::unified_runtime::UnifiedSessionManager>>();
    unified_runtime_manager
        .inner()
        .attach_output_channel(runtime_id, channel)
}

fn detach_weixin_output_channel(app: &AppHandle, runtime_id: &str, peer_id: &str) {
    let unified_runtime_manager = app.state::<Arc<crate::unified_runtime::UnifiedSessionManager>>();
    let _ = unified_runtime_manager.inner().detach_channel(
        runtime_id,
        &crate::channel::ChannelKind::Weixin {
            peer_id: peer_id.to_string(),
        },
    );
}

fn replay_headless_events_to_channel(
    runtime_manager: &Arc<HeadlessRuntimeManager>,
    runtime_id: &str,
    channel: &WeixinChannel,
) {
    let Ok(batch) = runtime_manager.replay_events(runtime_id, None) else {
        return;
    };

    for event in batch.events {
        let _ = channel.replay_event(&event);
    }
}

pub fn weixin_settings_path() -> PathBuf {
    config::get_ccem_dir().join("weixin.json")
}

fn weixin_state_path() -> PathBuf {
    config::get_ccem_dir().join("weixin-state.json")
}

pub fn read_weixin_settings() -> Result<WeixinSettings, String> {
    let path = weixin_settings_path();
    if !path.exists() {
        return Ok(WeixinSettings::default());
    }

    let content = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read weixin settings: {}", error))?;
    let settings: WeixinSettings = serde_json::from_str(&content)
        .map_err(|error| format!("Failed to parse weixin settings: {}", error))?;
    let normalized = WeixinSettings {
        api_base_url: normalize_api_base_url(&settings.api_base_url),
        flush_interval_ms: settings.flush_interval_ms.max(500),
        ..settings
    };
    decrypt_weixin_settings(normalized)
}

/// Decrypt the bot token in-place. Values without the `enc:` prefix are
/// returned as-is, so legacy plaintext configs remain readable and are
/// re-encrypted as v2 on the next `write_weixin_settings` call.
fn decrypt_weixin_settings(mut settings: WeixinSettings) -> Result<WeixinSettings, String> {
    settings.bot_token = settings
        .bot_token
        .as_deref()
        .map(|token| crypto::decrypt_local_secret("Weixin bot token", token))
        .transpose()?;
    Ok(settings)
}

pub fn write_weixin_settings(settings: &WeixinSettings) -> Result<(), String> {
    config::ensure_ccem_dir().map_err(|error| format!("Failed to create config dir: {}", error))?;
    let normalized = WeixinSettings {
        api_base_url: normalize_api_base_url(&settings.api_base_url),
        flush_interval_ms: settings.flush_interval_ms.max(500),
        ..settings.clone()
    };
    let persisted = encrypt_weixin_settings(normalized)?;
    let content = serde_json::to_string_pretty(&persisted)
        .map_err(|error| format!("Failed to serialize weixin settings: {}", error))?;
    fs::write(weixin_settings_path(), content)
        .map_err(|error| format!("Failed to write weixin settings: {}", error))
}

/// Encrypt the bot token for at-rest persistence. Empty tokens are left as
/// `None` so the serialized file never carries a token-shaped field when the
/// bot is not logged in. Error messages never include the token value.
fn encrypt_weixin_settings(mut settings: WeixinSettings) -> Result<WeixinSettings, String> {
    settings.bot_token = settings
        .bot_token
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .map(|value| crypto::encrypt(value))
        .transpose()
        .map_err(|e| format!("Failed to encrypt Weixin bot token: {}", e))?;
    Ok(settings)
}

fn read_weixin_state() -> Result<WeixinStateFile, String> {
    let path = weixin_state_path();
    if !path.exists() {
        return Ok(WeixinStateFile::default());
    }
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read weixin state: {}", error))?;
    serde_json::from_str(&content)
        .map_err(|error| format!("Failed to parse weixin state: {}", error))
}

fn write_weixin_state(state: &WeixinStateFile) -> Result<(), String> {
    let content = serde_json::to_string_pretty(state)
        .map_err(|error| format!("Failed to serialize weixin state: {}", error))?;
    fs::write(weixin_state_path(), content)
        .map_err(|error| format!("Failed to write weixin state: {}", error))
}

fn fetch_qr_code(api_base_url: &str) -> Result<WeixinQrCodeResponse, String> {
    let url = format!(
        "{}/ilink/bot/get_bot_qrcode?bot_type={}",
        api_base_url.trim_end_matches('/'),
        WEIXIN_LOGIN_BOT_TYPE
    );
    let client = Client::builder()
        .timeout(Duration::from_millis(WEIXIN_API_TIMEOUT_MS))
        .build()
        .map_err(|error| format!("Failed to build Weixin client: {}", error))?;
    let response = client
        .get(url)
        .send()
        .map_err(|error| format!("Failed to fetch Weixin QR code: {}", error))?;
    parse_json_response(response, "Weixin QR code response")
}

fn poll_qr_status(api_base_url: &str, qrcode: &str) -> Result<WeixinQrStatusResponse, String> {
    let url = format!(
        "{}/ilink/bot/get_qrcode_status?qrcode={}",
        api_base_url.trim_end_matches('/'),
        urlencoding::encode(qrcode)
    );
    let client = Client::builder()
        .timeout(Duration::from_millis(WEIXIN_QR_POLL_TIMEOUT_MS))
        .build()
        .map_err(|error| format!("Failed to build Weixin client: {}", error))?;
    let response = client
        .get(url)
        .header("iLink-App-ClientVersion", "1")
        .send();
    match response {
        Ok(response) => parse_json_response(response, "Weixin QR status response"),
        Err(error) if error.is_timeout() => Ok(WeixinQrStatusResponse {
            status: Some("wait".to_string()),
            bot_token: None,
            ilink_bot_id: None,
            baseurl: None,
        }),
        Err(error) => Err(format!("Failed to poll Weixin QR status: {}", error)),
    }
}

fn get_updates(
    api_base_url: &str,
    token: &str,
    sync_cursor: &str,
    timeout_ms: u64,
) -> Result<WeixinGetUpdatesResponse, String> {
    let url = format!(
        "{}/ilink/bot/getupdates",
        api_base_url.trim_end_matches('/')
    );
    let client = Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .build()
        .map_err(|error| format!("Failed to build Weixin client: {}", error))?;
    let body = json!({
        "get_updates_buf": sync_cursor,
        "base_info": {
            "channel_version": format!("ccem-desktop/{}", env!("CARGO_PKG_VERSION")),
        }
    });
    let response = client
        .post(url)
        .headers(build_weixin_headers(token)?)
        .json(&body)
        .send();

    match response {
        Ok(response) => parse_json_response(response, "Weixin getupdates response"),
        Err(error) if error.is_timeout() => Ok(WeixinGetUpdatesResponse {
            ret: Some(0),
            errcode: None,
            errmsg: None,
            msgs: Vec::new(),
            get_updates_buf: Some(sync_cursor.to_string()),
            longpolling_timeout_ms: None,
        }),
        Err(error) => Err(format!("Failed to poll Weixin updates: {}", error)),
    }
}

fn send_text_message(
    manager: &WeixinBridgeManager,
    api_base_url: &str,
    token: &str,
    peer_id: &str,
    text: &str,
) -> Result<(), String> {
    let context_token = manager
        .context_token_for_peer(peer_id)
        .ok_or_else(|| format!("No Weixin context token available for {}", peer_id))?;

    for chunk in split_text_chunks(text, WEIXIN_TEXT_LIMIT) {
        send_message_request(api_base_url, token, peer_id, &context_token, &chunk)?;
    }
    Ok(())
}

fn send_message_request(
    api_base_url: &str,
    token: &str,
    peer_id: &str,
    context_token: &str,
    text: &str,
) -> Result<(), String> {
    let url = format!(
        "{}/ilink/bot/sendmessage",
        api_base_url.trim_end_matches('/')
    );
    let client = Client::builder()
        .timeout(Duration::from_millis(WEIXIN_API_TIMEOUT_MS))
        .build()
        .map_err(|error| format!("Failed to build Weixin client: {}", error))?;
    let body = json!({
        "msg": {
            "from_user_id": "",
            "to_user_id": peer_id,
            "client_id": generate_client_id("wx-msg"),
            "message_type": 2,
            "message_state": 2,
            "item_list": [
                {
                    "type": 1,
                    "text_item": { "text": text }
                }
            ],
            "context_token": context_token,
        },
        "base_info": {
            "channel_version": format!("ccem-desktop/{}", env!("CARGO_PKG_VERSION")),
        }
    });
    let response = client
        .post(url)
        .headers(build_weixin_headers(token)?)
        .json(&body)
        .send()
        .map_err(|error| format!("Failed to send Weixin message: {}", error))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response
            .text()
            .unwrap_or_else(|_| "<unreadable>".to_string());
        return Err(format!("Weixin sendmessage failed: {} {}", status, body));
    }
    Ok(())
}

fn build_weixin_headers(token: &str) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        "AuthorizationType",
        HeaderValue::from_static("ilink_bot_token"),
    );
    let auth_value = format!("Bearer {}", token.trim());
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&auth_value)
            .map_err(|error| format!("Invalid Weixin authorization header: {}", error))?,
    );
    headers.insert(
        "X-WECHAT-UIN",
        HeaderValue::from_str(&random_wechat_uin())
            .map_err(|error| format!("Invalid Weixin UIN header: {}", error))?,
    );
    Ok(headers)
}

fn parse_json_response<T: for<'de> Deserialize<'de>>(
    response: reqwest::blocking::Response,
    context: &str,
) -> Result<T, String> {
    let status = response.status();
    let body = response
        .text()
        .map_err(|error| format!("Failed to read {}: {}", context, error))?;
    if !status.is_success() {
        return Err(format!("{} {} {}", context, status, body));
    }
    serde_json::from_str(&body).map_err(|error| format!("Failed to parse {}: {}", context, error))
}

fn extract_message_text(message: &WeixinMessage) -> Option<String> {
    message.item_list.iter().find_map(|item| {
        (item.item_type == Some(WEIXIN_MESSAGE_ITEM_TYPE_TEXT))
            .then(|| item.text_item.as_ref().and_then(|text| text.text.clone()))
            .flatten()
    })
}

fn is_peer_allowed(settings: &WeixinSettings, peer_id: &str) -> bool {
    settings.allowed_peer_ids.is_empty()
        || settings
            .allowed_peer_ids
            .iter()
            .any(|value| value.trim() == peer_id)
}

fn split_text_chunks(text: &str, limit: usize) -> Vec<String> {
    if text.chars().count() <= limit {
        return vec![text.to_string()];
    }

    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut current_len = 0usize;
    for ch in text.chars() {
        if current_len >= limit {
            chunks.push(current);
            current = String::new();
            current_len = 0;
        }
        current.push(ch);
        current_len += 1;
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn format_headless_turn_message(runtime_id: &str, stdout: &str, stderr: &str) -> String {
    let mut lines = Vec::new();
    if !stdout.trim().is_empty() {
        lines.push(stdout.trim().to_string());
    }
    if !stderr.trim().is_empty() {
        lines.push(format!("[{runtime_id}] stderr\n{}", stderr.trim()));
    }
    if lines.is_empty() {
        format!("[{runtime_id}] Session update received.")
    } else {
        lines.join("\n\n")
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

fn generate_client_id(prefix: &str) -> String {
    let mut random = [0_u8; 8];
    rand::thread_rng().fill_bytes(&mut random);
    format!(
        "{}-{}-{}",
        prefix,
        Utc::now().timestamp_millis(),
        hex::encode(random)
    )
}

fn random_wechat_uin() -> String {
    let value = rand::thread_rng().next_u32();
    BASE64_STANDARD.encode(value.to_string())
}

fn normalize_api_base_url(value: &str) -> String {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        DEFAULT_WEIXIN_API_BASE.to_string()
    } else {
        trimmed.to_string()
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

#[cfg(test)]
mod tests {
    use super::{
        decrypt_weixin_settings, encrypt_weixin_settings, is_peer_allowed,
        normalize_api_base_url, parse_headless_result_payload, parse_permission_reply,
        split_text_chunks, PermissionOwner, PermissionResolution, WeixinBridgeManager,
        WeixinSettings,
    };
    use std::thread;
    use std::time::Duration;

    #[test]
    fn split_text_chunks_respects_limit() {
        let chunks = split_text_chunks("abcdef", 2);
        assert_eq!(chunks, vec!["ab", "cd", "ef"]);
    }

    #[test]
    fn normalize_api_base_url_falls_back_to_default() {
        assert_eq!(
            normalize_api_base_url("  "),
            "https://ilinkai.weixin.qq.com"
        );
        assert_eq!(
            normalize_api_base_url("https://example.com/"),
            "https://example.com"
        );
    }

    #[test]
    fn allowed_peer_list_defaults_to_open_access() {
        let settings = WeixinSettings::default();
        assert!(is_peer_allowed(&settings, "user@im.wechat"));
    }

    #[test]
    fn allowed_peer_list_requires_exact_match_when_present() {
        let settings = WeixinSettings {
            allowed_peer_ids: vec!["alice@im.wechat".to_string()],
            ..WeixinSettings::default()
        };
        assert!(is_peer_allowed(&settings, "alice@im.wechat"));
        assert!(!is_peer_allowed(&settings, "bob@im.wechat"));
    }

    #[test]
    fn parse_headless_result_payload_reads_result_text() {
        let payload = parse_headless_result_payload(
            r#"{"type":"result","subtype":"success","is_error":false,"result":"hello"}"#,
        )
        .expect("payload should parse");

        assert!(!payload.is_error);
        assert_eq!(payload.result_text.as_deref(), Some("hello"));
    }

    #[test]
    fn parse_permission_reply_supports_short_words() {
        assert_eq!(parse_permission_reply("通过"), Some(true));
        assert_eq!(parse_permission_reply("拒绝"), Some(false));
        assert_eq!(parse_permission_reply("approve"), Some(true));
        assert_eq!(parse_permission_reply("deny"), Some(false));
        assert_eq!(parse_permission_reply("hello"), None);
    }

    #[test]
    fn resolve_permission_for_peer_prefers_unique_current_runtime() {
        let manager = WeixinBridgeManager::default();
        {
            let mut state = manager.state.lock().expect("lock state");
            state.permission_owner_by_request.insert(
                "req-1".to_string(),
                PermissionOwner {
                    peer_id: "peer-a".to_string(),
                    runtime_id: "runtime-a".to_string(),
                },
            );
            state.permission_owner_by_request.insert(
                "req-2".to_string(),
                PermissionOwner {
                    peer_id: "peer-a".to_string(),
                    runtime_id: "runtime-b".to_string(),
                },
            );
        }

        assert!(matches!(
            manager.resolve_permission_for_peer("peer-a", Some("runtime-b")),
            PermissionResolution::Single(request_id) if request_id == "req-2"
        ));
        assert!(matches!(
            manager.resolve_permission_for_peer("peer-a", None),
            PermissionResolution::Ambiguous
        ));
    }

    #[test]
    fn ensure_worker_stopped_waits_for_finished_worker() {
        let manager = WeixinBridgeManager::default();
        let handle = thread::spawn(|| {
            thread::sleep(Duration::from_millis(25));
        });

        {
            let mut worker = manager.worker.lock().expect("lock worker");
            *worker = Some(handle);
        }

        assert!(manager
            .ensure_worker_stopped(Duration::from_millis(250))
            .is_ok());
        assert!(manager.worker.lock().expect("lock worker").is_none());
    }

    // ---- bot_token encryption tests ----
    //
    // These tests exercise the pure encrypt/decrypt helpers directly, avoiding
    // file IO and the process-global home-dir resolution in `config::get_ccem_dir`.
    // The contract mirrors Telegram/WeCom: ciphertext on disk, plaintext in memory.

    #[test]
    fn encrypt_then_decrypt_roundtrip_recovers_original_token() {
        let original = WeixinSettings {
            enabled: true,
            bot_token: Some("wx-bot-secret-12345".to_string()),
            ..WeixinSettings::default()
        };

        let persisted = encrypt_weixin_settings(original.clone()).expect("encrypt should succeed");
        // persisted must carry ciphertext, not the plaintext
        assert_ne!(
            persisted.bot_token.as_deref(),
            Some("wx-bot-secret-12345"),
            "persisted token must be ciphertext, not plaintext"
        );
        assert!(persisted.bot_token.as_deref().unwrap().starts_with("enc:v2:"));

        let restored = decrypt_weixin_settings(persisted).expect("decrypt should succeed");
        assert_eq!(restored.bot_token.as_deref(), original.bot_token.as_deref());
    }

    #[test]
    fn decrypt_accepts_legacy_plaintext_token_for_migration() {
        // Old configs store bot_token as raw plaintext (no `enc:` prefix).
        // `decrypt` must pass these through unchanged so the next write upgrades them.
        let legacy = WeixinSettings {
            bot_token: Some("legacy-plaintext-token".to_string()),
            ..WeixinSettings::default()
        };

        let restored = decrypt_weixin_settings(legacy.clone()).expect("plaintext should pass through");
        assert_eq!(restored.bot_token, legacy.bot_token);
    }

    #[test]
    fn decrypt_tampered_v2_token_fails_without_leaking_value() {
        let tampered = "enc:v2:000000000000000000000000:00:00000000000000000000000000000000";
        let settings = WeixinSettings {
            bot_token: Some(tampered.to_string()),
            ..WeixinSettings::default()
        };

        let error = decrypt_weixin_settings(settings).expect_err("tampered token must fail");

        assert!(
            !error.contains(tampered),
            "Error must not echo encrypted token material: {}",
            error
        );
    }

    #[test]
    fn encrypted_settings_serialize_without_plaintext_token() {
        let plaintext = "do-not-leak-this-token";
        let settings = WeixinSettings {
            bot_token: Some(plaintext.to_string()),
            ..WeixinSettings::default()
        };

        let persisted = encrypt_weixin_settings(settings).expect("encrypt should succeed");
        let json = serde_json::to_string(&persisted).expect("serialize for at-rest check");

        assert!(
            !json.contains(plaintext),
            "Serialized settings must not contain the plaintext token: {}",
            json
        );
        assert!(json.contains("enc:v2:"), "Serialized settings should carry v2 ciphertext");
    }

    #[test]
    fn encrypt_drops_empty_or_whitespace_token() {
        for empty in ["", "   ", "\t\n"] {
            let settings = WeixinSettings {
                bot_token: Some(empty.to_string()),
                ..WeixinSettings::default()
            };
            let persisted = encrypt_weixin_settings(settings).expect("encrypt should succeed");
            assert!(
                persisted.bot_token.is_none(),
                "empty/whitespace token should be dropped to None, got {:?}",
                persisted.bot_token
            );
        }
    }
}
