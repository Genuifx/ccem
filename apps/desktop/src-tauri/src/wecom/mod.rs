mod channel;
mod media;
mod message;
mod types;

use crate::config;
use crate::crypto;
use crate::remote::RemotePlatform;
use crate::runtime::{HeadlessRuntimeManager, HeadlessSessionOptions, HeadlessSessionSource};
use chrono::Utc;
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{connect, Error as WsError, Message, WebSocket};

use self::channel::WecomChannel;
use self::media::prepare_message_attachments;
use self::message::{
    build_user_admission_prompt, build_user_policy_prompt, contains_mention, is_actor_allowed,
    is_admin, is_group_allowed, normalize_message, parse_admission_decision, peer_id_for_message,
    UserAdmissionDecision, WecomIncomingMessage,
};
pub use self::types::{
    default_ws_url, WecomBotConfig, WecomBotStatus, WecomBridgeStatus, WecomSettings,
    WecomTaskBindingTargetType,
};

const WECOM_READ_TIMEOUT_MS: u64 = 500;
const WECOM_HEARTBEAT_MS: u64 = 30_000;
const WECOM_RECONNECT_BASE_MS: u64 = 1_000;
const WECOM_RECONNECT_MAX_MS: u64 = 30_000;
const WECOM_TEXT_LIMIT: usize = 20_000;
const WECOM_ADMISSION_TIMEOUT_MS: u64 = 30_000;
const WECOM_ADMISSION_POLL_MS: u64 = 250;
const WECOM_SEND_ACK_TIMEOUT_MS: u64 = 5_000;
const WECOM_MARKDOWN_SEND_RETRY_TIMEOUT_MS: u64 = 15_000;
const WECOM_MARKDOWN_SEND_RETRY_MS: u64 = 500;

type WecomSocket = WebSocket<MaybeTlsStream<TcpStream>>;

#[derive(Debug, Clone, Default)]
struct WecomState {
    running: bool,
    last_error: Option<String>,
    bot_statuses: HashMap<String, WecomBotStatus>,
    active_runtime_by_scope: HashMap<String, String>,
    permission_owner_by_request: HashMap<String, (String, String)>,
}

pub struct WecomBridgeManager {
    state: Mutex<WecomState>,
    connections: Mutex<HashMap<String, Arc<WecomConnection>>>,
    stop_flag: AtomicBool,
    workers: Mutex<Vec<thread::JoinHandle<()>>>,
}

impl Default for WecomBridgeManager {
    fn default() -> Self {
        Self {
            state: Mutex::new(WecomState::default()),
            connections: Mutex::new(HashMap::new()),
            stop_flag: AtomicBool::new(false),
            workers: Mutex::new(Vec::new()),
        }
    }
}

impl WecomBridgeManager {
    pub fn status(&self) -> WecomBridgeStatus {
        self.cleanup_finished_workers();
        let state = self
            .state
            .lock()
            .map(|state| state.clone())
            .unwrap_or_default();
        let bots = state.bot_statuses.values().cloned().collect::<Vec<_>>();
        WecomBridgeStatus {
            configured: bots.iter().any(|bot| bot.configured),
            running: state.running,
            active_bot_count: bots.iter().filter(|bot| bot.running).count(),
            last_error: state.last_error,
            bots,
        }
    }

    pub fn start(
        self: &Arc<Self>,
        app: AppHandle,
        runtime_manager: Arc<HeadlessRuntimeManager>,
    ) -> Result<WecomBridgeStatus, String> {
        self.stop();
        let settings = read_wecom_settings()?;
        if !settings.enabled {
            return Err("WeCom bridge is disabled.".to_string());
        }
        let bots = settings
            .bots
            .into_iter()
            .filter(|bot| bot.enabled && !bot.bot_id.trim().is_empty())
            .collect::<Vec<_>>();
        if bots.is_empty() {
            return Err("No enabled WeCom bots are configured.".to_string());
        }

        self.stop_flag.store(false, Ordering::SeqCst);
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Failed to lock WeCom bridge state".to_string())?;
            state.running = true;
            state.last_error = None;
            state.bot_statuses.clear();
            for bot in &bots {
                state.bot_statuses.insert(
                    bot.id.clone(),
                    WecomBotStatus {
                        id: bot.id.clone(),
                        bot_id: bot.bot_id.clone(),
                        name: bot_display_name(bot),
                        configured: bot
                            .secret
                            .as_ref()
                            .is_some_and(|value| !value.trim().is_empty()),
                        running: false,
                        last_error: None,
                        connected_at: None,
                    },
                );
            }
        }

        let mut handles = Vec::new();
        for bot in bots {
            let manager = Arc::clone(self);
            let app = app.clone();
            let runtime_manager = Arc::clone(&runtime_manager);
            handles.push(thread::spawn(move || {
                run_bot_loop(manager, app, runtime_manager, bot);
            }));
        }
        *self
            .workers
            .lock()
            .map_err(|_| "Failed to lock WeCom workers".to_string())? = handles;
        Ok(self.status())
    }

    pub fn stop(&self) -> WecomBridgeStatus {
        self.stop_flag.store(true, Ordering::SeqCst);
        self.cleanup_finished_workers();
        if let Ok(mut workers) = self.workers.lock() {
            for handle in workers.drain(..) {
                let _ = handle.join();
            }
        }
        if let Ok(mut state) = self.state.lock() {
            state.running = false;
            state.active_runtime_by_scope.clear();
            state.permission_owner_by_request.clear();
            for status in state.bot_statuses.values_mut() {
                status.running = false;
            }
        }
        if let Ok(mut connections) = self.connections.lock() {
            connections.clear();
        }
        self.status()
    }

    pub fn sync_settings(&self, settings: &WecomSettings) {
        if let Ok(mut state) = self.state.lock() {
            for bot in &settings.bots {
                state
                    .bot_statuses
                    .entry(bot.id.clone())
                    .or_insert_with(|| WecomBotStatus {
                        id: bot.id.clone(),
                        bot_id: bot.bot_id.clone(),
                        name: bot_display_name(bot),
                        configured: bot
                            .secret
                            .as_ref()
                            .is_some_and(|value| !value.trim().is_empty()),
                        running: false,
                        last_error: None,
                        connected_at: None,
                    });
            }
        }
    }

    fn cleanup_finished_workers(&self) {
        if let Ok(mut workers) = self.workers.lock() {
            let mut active = Vec::new();
            for handle in workers.drain(..) {
                if handle.is_finished() {
                    let _ = handle.join();
                } else {
                    active.push(handle);
                }
            }
            *workers = active;
        }
    }

    fn set_bot_status(&self, bot: &WecomBotConfig, running: bool, error: Option<String>) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(error) = error.as_ref() {
                state.last_error = Some(error.clone());
            }
            state.bot_statuses.insert(
                bot.id.clone(),
                WecomBotStatus {
                    id: bot.id.clone(),
                    bot_id: bot.bot_id.clone(),
                    name: bot_display_name(bot),
                    configured: bot
                        .secret
                        .as_ref()
                        .is_some_and(|value| !value.trim().is_empty()),
                    running,
                    last_error: error,
                    connected_at: running.then(Utc::now),
                },
            );
        }
    }

    fn remember_runtime_for_scope(&self, bot_id: &str, peer_id: &str, runtime_id: String) {
        if let Ok(mut state) = self.state.lock() {
            state
                .active_runtime_by_scope
                .insert(scope_key(bot_id, peer_id), runtime_id);
        }
    }

    fn active_runtime_for_scope(&self, bot_id: &str, peer_id: &str) -> Option<String> {
        self.state.lock().ok().and_then(|state| {
            state
                .active_runtime_by_scope
                .get(&scope_key(bot_id, peer_id))
                .cloned()
        })
    }

    pub fn clear_runtime_for_scope_if_matches(
        &self,
        bot_id: &str,
        peer_id: &str,
        runtime_id: &str,
    ) {
        if let Ok(mut state) = self.state.lock() {
            let key = scope_key(bot_id, peer_id);
            if state
                .active_runtime_by_scope
                .get(&key)
                .is_some_and(|value| value == runtime_id)
            {
                state.active_runtime_by_scope.remove(&key);
            }
            state
                .permission_owner_by_request
                .retain(|_, (_, owner_runtime)| owner_runtime != runtime_id);
        }
    }

    fn remember_permission(&self, request_id: &str, bot_id: &str, runtime_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.permission_owner_by_request.insert(
                request_id.to_string(),
                (bot_id.to_string(), runtime_id.to_string()),
            );
        }
    }

    fn remember_connection(&self, bot: &WecomBotConfig, connection: Arc<WecomConnection>) {
        if let Ok(mut connections) = self.connections.lock() {
            connections.insert(bot.id.clone(), Arc::clone(&connection));
            connections.insert(bot.bot_id.clone(), connection);
        }
    }

    fn forget_connection(&self, bot: &WecomBotConfig, connection: &Arc<WecomConnection>) {
        if let Ok(mut connections) = self.connections.lock() {
            connections.retain(|key, value| {
                let same_key = key == &bot.id || key == &bot.bot_id;
                !(same_key && Arc::ptr_eq(value, connection))
            });
        }
    }

    pub fn send_markdown_message(
        &self,
        bot_id: Option<&str>,
        peer_id: &str,
        content: &str,
    ) -> Result<String, String> {
        let started_at = Instant::now();
        loop {
            match self.try_send_markdown_message(bot_id, peer_id, content) {
                Ok(message_id) => return Ok(message_id),
                Err(error)
                    if wecom_markdown_send_error_is_retryable(&error)
                        && started_at.elapsed()
                            < Duration::from_millis(WECOM_MARKDOWN_SEND_RETRY_TIMEOUT_MS) =>
                {
                    thread::sleep(Duration::from_millis(WECOM_MARKDOWN_SEND_RETRY_MS));
                }
                Err(error) => return Err(error),
            }
        }
    }

    fn try_send_markdown_message(
        &self,
        bot_id: Option<&str>,
        peer_id: &str,
        content: &str,
    ) -> Result<String, String> {
        let connection = self.connection_for_bot(bot_id)?;
        if !connection.is_connected() {
            return Err("WeCom bot connection is not active.".to_string());
        }
        connection.send_markdown_message(&wecom_chatid_from_peer_id(peer_id), content)
    }

    pub fn send_stream_message(
        &self,
        bot_id: Option<&str>,
        peer_id: &str,
        req_id: &str,
        stream_id: &str,
        content: &str,
        finish: bool,
    ) -> Result<String, String> {
        let started_at = Instant::now();
        loop {
            match self.try_send_stream_message(bot_id, peer_id, req_id, stream_id, content, finish)
            {
                Ok(message_id) => return Ok(message_id),
                Err(error)
                    if wecom_markdown_send_error_is_retryable(&error)
                        && started_at.elapsed()
                            < Duration::from_millis(WECOM_MARKDOWN_SEND_RETRY_TIMEOUT_MS) =>
                {
                    thread::sleep(Duration::from_millis(WECOM_MARKDOWN_SEND_RETRY_MS));
                }
                Err(error) => return Err(error),
            }
        }
    }

    fn try_send_stream_message(
        &self,
        bot_id: Option<&str>,
        peer_id: &str,
        req_id: &str,
        stream_id: &str,
        content: &str,
        finish: bool,
    ) -> Result<String, String> {
        let connection = self.connection_for_bot(bot_id)?;
        if !connection.is_connected() {
            return Err("WeCom bot connection is not active.".to_string());
        }
        connection.send_stream_message(
            &wecom_chatid_from_peer_id(peer_id),
            req_id,
            stream_id,
            content,
            finish,
        )
    }

    fn connection_for_bot(&self, bot_id: Option<&str>) -> Result<Arc<WecomConnection>, String> {
        let connections = self
            .connections
            .lock()
            .map_err(|_| "Failed to lock WeCom connections".to_string())?;
        if let Some(bot_id) = bot_id.map(str::trim).filter(|value| !value.is_empty()) {
            return connections
                .get(bot_id)
                .cloned()
                .ok_or_else(|| format!("WeCom bot is not connected: {bot_id}"));
        }

        let mut unique = Vec::<Arc<WecomConnection>>::new();
        for connection in connections.values() {
            if !unique
                .iter()
                .any(|candidate| Arc::ptr_eq(candidate, connection))
            {
                unique.push(Arc::clone(connection));
            }
        }
        match unique.as_slice() {
            [connection] => Ok(Arc::clone(connection)),
            [] => Err("No WeCom bot connection is active.".to_string()),
            _ => Err("Multiple WeCom bot connections are active; bot_id is required.".to_string()),
        }
    }
}

pub struct WecomConnection {
    socket: Mutex<Option<WecomSocket>>,
    pending_acks: Mutex<HashMap<String, mpsc::Sender<Result<(), String>>>>,
    connected: AtomicBool,
}

impl Default for WecomConnection {
    fn default() -> Self {
        Self {
            socket: Mutex::new(None),
            pending_acks: Mutex::new(HashMap::new()),
            connected: AtomicBool::new(false),
        }
    }
}

impl WecomConnection {
    fn set_socket(&self, socket: WecomSocket) -> Result<(), String> {
        let mut guard = self
            .socket
            .lock()
            .map_err(|_| "Failed to lock WeCom socket".to_string())?;
        *guard = Some(socket);
        self.connected.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn clear_socket(&self) {
        if let Ok(mut guard) = self.socket.lock() {
            *guard = None;
        }
        self.connected.store(false, Ordering::SeqCst);
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    fn send_frame(&self, frame: Value) -> Result<(), String> {
        let mut guard = self
            .socket
            .lock()
            .map_err(|_| "Failed to lock WeCom socket".to_string())?;
        let socket = guard
            .as_mut()
            .ok_or_else(|| "WeCom socket is not connected".to_string())?;
        socket
            .send(Message::Text(frame.to_string().into()))
            .map_err(|error| format!("Failed to send WeCom frame: {}", error))
    }

    pub fn send_stream(
        &self,
        req_id: &str,
        stream_id: &str,
        content: &str,
        finish: bool,
    ) -> Result<(), String> {
        self.send_frame(json!({
            "cmd": "aibot_respond_msg",
            "headers": { "req_id": req_id },
            "body": {
                "msgtype": "stream",
                "stream": {
                    "id": stream_id,
                    "finish": finish,
                    "content": truncate_utf8(content, WECOM_TEXT_LIMIT),
                }
            }
        }))
    }

    pub fn send_markdown_message(&self, chatid: &str, content: &str) -> Result<String, String> {
        let req_id = generate_req_id("aibot_send_msg");
        match self.send_frame_waiting_for_ack(
            &req_id,
            json!({
                "cmd": "aibot_send_msg",
                "headers": { "req_id": req_id.clone() },
                "body": {
                    "chatid": chatid,
                    "msgtype": "markdown",
                    "markdown": {
                        "content": truncate_utf8(content, WECOM_TEXT_LIMIT),
                    }
                }
            }),
        ) {
            Ok(()) => {}
            Err(error) if error.starts_with("WeCom send ack timed out:") => {
                eprintln!("WeCom send markdown ack timeout warning: {}", error);
            }
            Err(error) => return Err(error),
        }
        Ok(req_id)
    }

    pub fn send_stream_message(
        &self,
        chatid: &str,
        req_id: &str,
        stream_id: &str,
        content: &str,
        finish: bool,
    ) -> Result<String, String> {
        match self.send_frame_waiting_for_ack(
            req_id,
            build_active_stream_message_frame(req_id, chatid, stream_id, content, finish),
        ) {
            Ok(()) => {}
            Err(error) if error.starts_with("WeCom send ack timed out:") => {
                eprintln!("WeCom send active stream ack timeout warning: {}", error);
            }
            Err(error) => return Err(error),
        }
        Ok(req_id.to_string())
    }

    fn send_frame_waiting_for_ack(&self, req_id: &str, frame: Value) -> Result<(), String> {
        let (sender, receiver) = mpsc::channel();
        self.pending_acks
            .lock()
            .map_err(|_| "Failed to lock WeCom pending acks".to_string())?
            .insert(req_id.to_string(), sender);
        if let Err(error) = self.send_frame(frame) {
            if let Ok(mut pending) = self.pending_acks.lock() {
                pending.remove(req_id);
            }
            return Err(error);
        }
        match receiver.recv_timeout(Duration::from_millis(WECOM_SEND_ACK_TIMEOUT_MS)) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Ok(mut pending) = self.pending_acks.lock() {
                    pending.remove(req_id);
                }
                Err(format!("WeCom send ack timed out: {req_id}"))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err(format!("WeCom send ack channel closed: {req_id}"))
            }
        }
    }

    fn complete_pending_ack(&self, frame: &WecomFrame) -> bool {
        let req_id = frame.headers.req_id.as_str();
        let sender = self
            .pending_acks
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(req_id));
        let Some(sender) = sender else {
            return false;
        };
        let result = match frame.errcode {
            Some(code) if code != 0 => Err(format!(
                "WeCom send ack failed: {}",
                frame
                    .errmsg
                    .clone()
                    .unwrap_or_else(|| format!("errcode {code}"))
            )),
            _ => Ok(()),
        };
        let _ = sender.send(result);
        true
    }
}

fn build_active_stream_message_frame(
    req_id: &str,
    chatid: &str,
    stream_id: &str,
    content: &str,
    finish: bool,
) -> Value {
    json!({
        "cmd": "aibot_send_msg",
        "headers": { "req_id": req_id },
        "body": {
            "chatid": chatid,
            "msgtype": "stream",
            "stream": {
                "id": stream_id,
                "finish": finish,
                "content": truncate_utf8(content, WECOM_TEXT_LIMIT),
            }
        }
    })
}

fn run_bot_loop(
    manager: Arc<WecomBridgeManager>,
    app: AppHandle,
    runtime_manager: Arc<HeadlessRuntimeManager>,
    bot: WecomBotConfig,
) {
    let Some(secret) = bot
        .secret
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        manager.set_bot_status(&bot, false, Some("Missing WeCom bot secret.".to_string()));
        return;
    };
    let connection = Arc::new(WecomConnection::default());
    let mut reconnect_attempt = 0u32;

    while !manager.stop_flag.load(Ordering::SeqCst) {
        match connect(bot.ws_url.as_str()) {
            Ok((mut socket, _)) => {
                set_socket_read_timeout(&mut socket);
                if connection.set_socket(socket).is_err() {
                    return;
                }
                if manager.stop_flag.load(Ordering::SeqCst) {
                    connection.clear_socket();
                    return;
                }
                manager.remember_connection(&bot, Arc::clone(&connection));
                manager.set_bot_status(&bot, true, None);
                reconnect_attempt = 0;
                let _ = send_auth(&connection, &bot, secret);
                let mut last_heartbeat = Instant::now();

                while !manager.stop_flag.load(Ordering::SeqCst) && connection.is_connected() {
                    if last_heartbeat.elapsed() >= Duration::from_millis(WECOM_HEARTBEAT_MS) {
                        let _ = send_ping(&connection);
                        last_heartbeat = Instant::now();
                    }

                    match read_next_frame(&connection) {
                        Ok(Some(frame)) => {
                            if handle_frame(
                                &manager,
                                &app,
                                &runtime_manager,
                                &connection,
                                &bot,
                                frame,
                            )
                            .is_err()
                            {
                                break;
                            }
                        }
                        Ok(None) => {}
                        Err(error) => {
                            manager.set_bot_status(&bot, false, Some(error));
                            break;
                        }
                    }
                }
                connection.clear_socket();
                manager.forget_connection(&bot, &connection);
            }
            Err(error) => {
                manager.set_bot_status(
                    &bot,
                    false,
                    Some(format!("Failed to connect WeCom bot: {}", error)),
                );
            }
        }

        reconnect_attempt = reconnect_attempt.saturating_add(1);
        let delay = (WECOM_RECONNECT_BASE_MS * 2u64.saturating_pow(reconnect_attempt.min(5)))
            .min(WECOM_RECONNECT_MAX_MS);
        interruptible_sleep(&manager, Duration::from_millis(delay));
    }
    connection.clear_socket();
    manager.forget_connection(&bot, &connection);
    manager.set_bot_status(&bot, false, None);
}

fn handle_frame(
    manager: &Arc<WecomBridgeManager>,
    app: &AppHandle,
    runtime_manager: &Arc<HeadlessRuntimeManager>,
    connection: &Arc<WecomConnection>,
    bot: &WecomBotConfig,
    frame: WecomFrame,
) -> Result<(), String> {
    if frame.cmd.as_deref() == Some("aibot_msg_callback") {
        let req_id = frame.headers.req_id.clone();
        let Some(body) = frame.body.clone() else {
            return Ok(());
        };
        let message: WecomIncomingMessage = serde_json::from_value(body)
            .map_err(|error| format!("Failed to parse WeCom message: {}", error))?;
        let manager = Arc::clone(manager);
        let app = app.clone();
        let runtime_manager = Arc::clone(runtime_manager);
        let connection = Arc::clone(connection);
        let bot = bot.clone();
        thread::spawn(move || {
            if let Err(error) = handle_message(
                &manager,
                &app,
                &runtime_manager,
                &connection,
                &bot,
                frame,
                message,
            ) {
                let _ = connection.send_stream(
                    req_id.as_str(),
                    &generate_req_id("stream"),
                    &format!("WeCom message failed: {error}"),
                    true,
                );
            }
        });
        return Ok(());
    }

    if frame.cmd.as_deref() == Some("aibot_event_callback")
        && frame
            .body
            .as_ref()
            .and_then(|body| body.get("event"))
            .and_then(|event| event.get("eventtype"))
            .and_then(Value::as_str)
            == Some("disconnected_event")
    {
        return Err(
            "Server disconnected this bot because a new connection was established.".to_string(),
        );
    }

    if frame.headers.req_id.starts_with("aibot_subscribe")
        && frame.errcode.is_some_and(|code| code != 0)
    {
        return Err(format!(
            "WeCom auth failed: {}",
            frame.errmsg.unwrap_or_else(|| "unknown error".to_string())
        ));
    }
    if connection.complete_pending_ack(&frame) {
        return Ok(());
    }
    Ok(())
}

fn handle_message(
    manager: &Arc<WecomBridgeManager>,
    app: &AppHandle,
    runtime_manager: &Arc<HeadlessRuntimeManager>,
    connection: &Arc<WecomConnection>,
    bot: &WecomBotConfig,
    frame: WecomFrame,
    message: WecomIncomingMessage,
) -> Result<(), String> {
    let actor = message.from.userid.trim().to_string();
    if actor.is_empty() || !is_actor_allowed(bot, &actor) {
        return Ok(());
    }
    if message.chattype == "group" && !is_group_allowed(bot, message.chatid.as_deref()) {
        return Ok(());
    }

    let mut normalized = normalize_message(&message);
    if normalized.text.trim().is_empty() && normalized.attachments.is_empty() {
        return Ok(());
    }
    if message.chattype == "group"
        && bot.require_mention
        && !contains_mention(bot, &normalized.text)
    {
        return Ok(());
    }

    let role = if is_admin(bot, &actor) {
        UserRole::Admin
    } else {
        UserRole::User
    };
    let peer_id = peer_id_for_message(&message);
    let stream_id = generate_req_id("stream");
    if try_route_bot_binding_message(
        manager,
        app,
        runtime_manager,
        connection,
        bot,
        &actor,
        role,
        &peer_id,
        &frame,
        &mut normalized,
        &stream_id,
    )? {
        return Ok(());
    }

    let prompt = match role {
        UserRole::Admin => {
            prepare_message_attachments(bot, &peer_id, &frame.headers.req_id, &mut normalized);
            normalized.to_prompt()
        }
        UserRole::User => {
            connection.send_stream(
                &frame.headers.req_id,
                &stream_id,
                "收到，正在判断是否符合普通用户范围...",
                false,
            )?;
            let decision = match evaluate_user_admission(
                manager,
                app,
                runtime_manager,
                bot,
                &actor,
                &normalized,
            ) {
                Ok(decision) => decision,
                Err(error) => {
                    connection.send_stream(
                        &frame.headers.req_id,
                        &stream_id,
                        &format!("普通用户准入判断失败：{}", error),
                        true,
                    )?;
                    return Ok(());
                }
            };
            if !decision.allow {
                connection.send_stream(
                    &frame.headers.req_id,
                    &stream_id,
                    &format!("未通过普通用户权限策略：{}", decision.reason),
                    true,
                )?;
                return Ok(());
            }
            prepare_message_attachments(bot, &peer_id, &frame.headers.req_id, &mut normalized);
            build_user_policy_prompt(&bot.user_access_policy, &normalized)
        }
    };
    connection.send_stream(
        &frame.headers.req_id,
        &stream_id,
        "收到，正在处理...",
        false,
    )?;

    if let Some(runtime_id) = manager.active_runtime_for_scope(&bot.bot_id, &peer_id) {
        if runtime_manager
            .summary(&runtime_id)
            .is_some_and(|summary| summary.is_active)
        {
            attach_wecom_output_channel(
                manager,
                app,
                runtime_manager,
                connection,
                bot,
                &peer_id,
                &runtime_id,
                &frame.headers.req_id,
                &stream_id,
            )?;
            runtime_manager.send_user_message(app, &runtime_id, &prompt)?;
            return Ok(());
        }
        manager.clear_runtime_for_scope_if_matches(&bot.bot_id, &peer_id, &runtime_id);
    }

    create_wecom_session(
        manager,
        app,
        runtime_manager,
        connection,
        bot,
        &peer_id,
        &frame.headers.req_id,
        &stream_id,
        &prompt,
        role,
    )
}

fn evaluate_user_admission(
    manager: &Arc<WecomBridgeManager>,
    app: &AppHandle,
    runtime_manager: &Arc<HeadlessRuntimeManager>,
    bot: &WecomBotConfig,
    actor: &str,
    normalized: &self::message::NormalizedMessage,
) -> Result<UserAdmissionDecision, String> {
    let policy = bot.user_access_policy.trim();
    if policy.is_empty() {
        return Ok(UserAdmissionDecision {
            allow: false,
            reason: "管理员未配置普通用户允许范围。".to_string(),
        });
    }

    let env_name = bot
        .default_env_name
        .clone()
        .or_else(|| config::read_config().ok().and_then(|cfg| cfg.current))
        .unwrap_or_else(|| "official".to_string());
    let resolved = config::resolve_claude_env(&env_name)?;
    let admission_peer_id = format!("admission:{actor}:{}", Utc::now().timestamp_millis());
    let prompt = build_user_admission_prompt(policy, actor, normalized);
    let summary = runtime_manager.create_session(
        app.clone(),
        HeadlessSessionOptions {
            env_name: resolved.env_name,
            perm_mode: "readonly".to_string(),
            working_dir: bot.workspace_dir.clone(),
            resume_session_id: None,
            initial_prompt: Some(prompt),
            max_budget_usd: Some(0.05),
            allowed_tools: Vec::new(),
            disallowed_tools: Vec::new(),
            env_vars: resolved.env_vars,
            source: HeadlessSessionSource::Wecom {
                bot_id: bot.bot_id.clone(),
                peer_id: admission_peer_id.clone(),
            },
        },
    )?;

    let result = wait_for_admission_decision(runtime_manager, &summary.runtime_id);
    if runtime_manager
        .summary(&summary.runtime_id)
        .is_some_and(|summary| summary.is_active)
    {
        let _ = runtime_manager.stop_session(app, &summary.runtime_id);
    }
    manager.clear_runtime_for_scope_if_matches(
        &bot.bot_id,
        &admission_peer_id,
        &summary.runtime_id,
    );
    result
}

fn wait_for_admission_decision(
    runtime_manager: &Arc<HeadlessRuntimeManager>,
    runtime_id: &str,
) -> Result<UserAdmissionDecision, String> {
    let started_at = Instant::now();
    let mut last_error = None;
    while started_at.elapsed() < Duration::from_millis(WECOM_ADMISSION_TIMEOUT_MS) {
        let batch = runtime_manager.replay_events(runtime_id, None)?;
        for event in batch.events.iter().rev() {
            if let crate::event_bus::SessionEventPayload::ClaudeJson {
                message_type,
                raw_json,
            } = &event.payload
            {
                if message_type.as_deref() == Some("result") {
                    let text = extract_claude_result_text(raw_json)?;
                    match parse_admission_decision(&text) {
                        Ok(decision) => return Ok(decision),
                        Err(error) => last_error = Some(error),
                    }
                }
            }
        }

        if runtime_manager
            .summary(runtime_id)
            .is_some_and(|summary| !summary.is_active)
        {
            break;
        }
        thread::sleep(Duration::from_millis(WECOM_ADMISSION_POLL_MS));
    }

    Err(last_error
        .unwrap_or_else(|| "普通用户准入判断超时，未能得到模型返回的 JSON 决策。".to_string()))
}

fn extract_claude_result_text(raw_json: &str) -> Result<String, String> {
    let value: Value = serde_json::from_str(raw_json)
        .map_err(|error| format!("Failed to parse admission result event: {}", error))?;
    value
        .get("result")
        .or_else(|| value.get("error"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| "Admission result event did not include result text.".to_string())
}

#[allow(clippy::too_many_arguments)]
fn create_wecom_session(
    manager: &Arc<WecomBridgeManager>,
    app: &AppHandle,
    runtime_manager: &Arc<HeadlessRuntimeManager>,
    connection: &Arc<WecomConnection>,
    bot: &WecomBotConfig,
    peer_id: &str,
    req_id: &str,
    stream_id: &str,
    prompt: &str,
    role: UserRole,
) -> Result<(), String> {
    let metadata = fs::metadata(&bot.workspace_dir)
        .map_err(|error| format!("Workspace directory is not accessible: {}", error))?;
    if !metadata.is_dir() {
        return Err(format!(
            "Workspace path is not a directory: {}",
            bot.workspace_dir
        ));
    }

    let env_name = bot
        .default_env_name
        .clone()
        .or_else(|| config::read_config().ok().and_then(|cfg| cfg.current))
        .unwrap_or_else(|| "official".to_string());
    let perm_mode = match role {
        UserRole::Admin => bot.admin_perm_mode.clone(),
        UserRole::User => bot.user_perm_mode.clone(),
    };
    let resolved = config::resolve_claude_env(&env_name)?;

    let summary = runtime_manager.create_session(
        app.clone(),
        HeadlessSessionOptions {
            env_name: resolved.env_name,
            perm_mode,
            working_dir: bot.workspace_dir.clone(),
            resume_session_id: None,
            initial_prompt: (!prompt.trim().is_empty()).then(|| prompt.to_string()),
            max_budget_usd: None,
            allowed_tools: Vec::new(),
            disallowed_tools: Vec::new(),
            env_vars: resolved.env_vars,
            source: HeadlessSessionSource::Wecom {
                bot_id: bot.bot_id.clone(),
                peer_id: peer_id.to_string(),
            },
        },
    )?;
    manager.remember_runtime_for_scope(&bot.bot_id, peer_id, summary.runtime_id.clone());
    attach_wecom_output_channel(
        manager,
        app,
        runtime_manager,
        connection,
        bot,
        peer_id,
        &summary.runtime_id,
        req_id,
        stream_id,
    )?;
    spawn_session_monitor(
        manager,
        app,
        runtime_manager,
        &bot.bot_id,
        peer_id,
        &summary.runtime_id,
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn attach_wecom_output_channel(
    manager: &Arc<WecomBridgeManager>,
    app: &AppHandle,
    runtime_manager: &Arc<HeadlessRuntimeManager>,
    connection: &Arc<WecomConnection>,
    bot: &WecomBotConfig,
    peer_id: &str,
    runtime_id: &str,
    req_id: &str,
    stream_id: &str,
) -> Result<(), String> {
    let unified_runtime_manager = app.state::<Arc<crate::unified_runtime::UnifiedSessionManager>>();
    let channel = Arc::new(WecomChannel::new(
        Arc::clone(manager),
        Arc::clone(connection),
        runtime_id.to_string(),
        bot.bot_id.clone(),
        peer_id.to_string(),
        req_id.to_string(),
        stream_id.to_string(),
    ));
    unified_runtime_manager
        .inner()
        .attach_output_channel(runtime_id, channel.clone())?;
    if let Ok(batch) = runtime_manager.replay_events(runtime_id, None) {
        for event in batch.events {
            if let crate::event_bus::SessionEventPayload::PermissionRequired {
                request_id, ..
            } = &event.payload
            {
                manager.remember_permission(request_id, &bot.bot_id, runtime_id);
            }
            let _ = channel.replay_event(&event);
        }
    }
    channel.finish_initial_replay()?;
    Ok(())
}

fn spawn_session_monitor(
    manager: &Arc<WecomBridgeManager>,
    app: &AppHandle,
    runtime_manager: &Arc<HeadlessRuntimeManager>,
    bot_id: &str,
    peer_id: &str,
    runtime_id: &str,
) {
    let manager = Arc::clone(manager);
    let runtime_manager = Arc::clone(runtime_manager);
    let app = app.clone();
    let bot_id = bot_id.to_string();
    let peer_id = peer_id.to_string();
    let runtime_id = runtime_id.to_string();
    thread::spawn(move || {
        while runtime_manager
            .summary(&runtime_id)
            .is_some_and(|summary| summary.is_active)
        {
            thread::sleep(Duration::from_millis(500));
        }
        manager.clear_runtime_for_scope_if_matches(&bot_id, &peer_id, &runtime_id);
        let unified_runtime_manager =
            app.state::<Arc<crate::unified_runtime::UnifiedSessionManager>>();
        let _ = unified_runtime_manager.inner().detach_channel(
            &runtime_id,
            &crate::channel::ChannelKind::Wecom { bot_id, peer_id },
        );
    });
}

pub fn wecom_settings_path() -> PathBuf {
    config::get_ccem_dir().join("wecom.json")
}

pub fn read_wecom_settings() -> Result<WecomSettings, String> {
    let path = wecom_settings_path();
    if !path.exists() {
        return Ok(WecomSettings {
            enabled: false,
            bots: Vec::new(),
        });
    }
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read WeCom settings: {}", error))?;
    let settings: WecomSettings = serde_json::from_str(&content)
        .map_err(|error| format!("Failed to parse WeCom settings: {}", error))?;
    decrypt_wecom_settings(settings)
}

fn decrypt_wecom_settings(mut settings: WecomSettings) -> Result<WecomSettings, String> {
    for bot in &mut settings.bots {
        bot.secret = bot
            .secret
            .as_deref()
            .map(|value| crypto::decrypt_local_secret("WeCom bot secret", value))
            .transpose()?;
        if bot.id.trim().is_empty() {
            bot.id = generate_req_id("bot");
        }
        if bot.ws_url.trim().is_empty() {
            bot.ws_url = default_ws_url();
        }
    }
    Ok(settings)
}

pub fn write_wecom_settings(settings: &WecomSettings) -> Result<(), String> {
    config::ensure_ccem_dir().map_err(|error| format!("Failed to create config dir: {}", error))?;
    let mut persisted = settings.clone();
    for bot in &mut persisted.bots {
        bot.secret = bot
            .secret
            .as_ref()
            .filter(|value| !value.trim().is_empty())
            .map(|value| crypto::encrypt(value))
            .transpose()
            .map_err(|e| format!("Failed to encrypt WeCom bot secret: {}", e))?;
        if bot.id.trim().is_empty() {
            bot.id = generate_req_id("bot");
        }
    }
    let content = serde_json::to_string_pretty(&persisted)
        .map_err(|error| format!("Failed to serialize WeCom settings: {}", error))?;
    fs::write(wecom_settings_path(), content)
        .map_err(|error| format!("Failed to write WeCom settings: {}", error))
}

#[derive(Debug, Clone, Deserialize)]
struct WecomFrame {
    #[serde(default)]
    cmd: Option<String>,
    headers: WecomHeaders,
    #[serde(default)]
    body: Option<Value>,
    #[serde(default)]
    errcode: Option<i64>,
    #[serde(default)]
    errmsg: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct WecomHeaders {
    req_id: String,
}

#[derive(Clone, Copy)]
enum UserRole {
    Admin,
    User,
}

struct BotBindingRouteMarkers {
    quoted_task_id: Option<String>,
    correlation_marker: Option<String>,
}

fn extract_bot_binding_route_markers(
    message: &self::message::NormalizedMessage,
) -> BotBindingRouteMarkers {
    let texts = [
        message.quote.as_deref().unwrap_or(""),
        message.text.as_str(),
    ];
    BotBindingRouteMarkers {
        quoted_task_id: texts
            .iter()
            .find_map(|text| extract_marker_token(text, "ccem-task-")),
        correlation_marker: texts.iter().find_map(|text| {
            extract_marker_token(text, "ccem-bot-binding:")
                .or_else(|| extract_marker_token(text, "ccem:"))
                .or_else(|| extract_hash_route_token(text))
        }),
    }
}

fn extract_marker_token(text: &str, prefix: &str) -> Option<String> {
    let start = text.find(prefix)?;
    let token = text[start..]
        .split(is_route_token_separator)
        .next()
        .unwrap_or("")
        .trim_matches(|ch: char| matches!(ch, '.' | ',' | ':' | ';' | '。' | '，' | '：'))
        .to_string();
    (!token.is_empty()).then_some(token)
}

fn extract_hash_route_token(text: &str) -> Option<String> {
    text.split(is_route_token_separator).find_map(|token| {
        let candidate = token
            .trim()
            .trim_matches(|ch: char| matches!(ch, '.' | ',' | ':' | ';' | '。' | '，' | '：'))
            .strip_prefix('#')?;
        is_short_route_id(candidate).then(|| candidate.to_string())
    })
}

fn is_route_token_separator(ch: char) -> bool {
    ch.is_whitespace()
        || matches!(
            ch,
            '`' | '"' | '\'' | '<' | '>' | '(' | ')' | '[' | ']' | '，' | '。' | '；' | '：'
        )
}

fn is_short_route_id(value: &str) -> bool {
    let len = value.chars().count();
    (6..=8).contains(&len) && value.chars().all(|ch| ch.is_ascii_alphanumeric())
}

fn reply_text(connection: &WecomConnection, frame: &WecomFrame, text: &str) -> Result<(), String> {
    connection.send_stream(
        &frame.headers.req_id,
        &generate_req_id("stream"),
        text,
        true,
    )
}

fn send_auth(
    connection: &WecomConnection,
    bot: &WecomBotConfig,
    secret: &str,
) -> Result<(), String> {
    connection.send_frame(json!({
        "cmd": "aibot_subscribe",
        "headers": { "req_id": generate_req_id("aibot_subscribe") },
        "body": { "bot_id": bot.bot_id, "secret": secret }
    }))
}

fn send_ping(connection: &WecomConnection) -> Result<(), String> {
    connection.send_frame(json!({
        "cmd": "ping",
        "headers": { "req_id": generate_req_id("ping") }
    }))
}

fn wecom_chatid_from_peer_id(peer_id: &str) -> String {
    peer_id
        .trim()
        .strip_prefix("single:")
        .or_else(|| peer_id.trim().strip_prefix("group:"))
        .unwrap_or_else(|| peer_id.trim())
        .to_string()
}

fn wecom_markdown_send_error_is_retryable(error: &str) -> bool {
    error == "WeCom socket is not connected"
        || error == "WeCom bot connection is not active."
        || error == "No WeCom bot connection is active."
        || error.starts_with("WeCom bot is not connected:")
        || error.starts_with("Failed to send WeCom frame:")
        || error.starts_with("WeCom send ack channel closed:")
}

fn read_next_frame(connection: &WecomConnection) -> Result<Option<WecomFrame>, String> {
    let mut guard = connection
        .socket
        .lock()
        .map_err(|_| "Failed to lock WeCom socket".to_string())?;
    let Some(socket) = guard.as_mut() else {
        return Ok(None);
    };
    match socket.read() {
        Ok(Message::Text(text)) => serde_json::from_str::<WecomFrame>(text.as_ref())
            .map(Some)
            .map_err(|error| format!("Failed to parse WeCom frame: {}", error)),
        Ok(Message::Binary(bytes)) => serde_json::from_slice::<WecomFrame>(&bytes)
            .map(Some)
            .map_err(|error| format!("Failed to parse WeCom binary frame: {}", error)),
        Ok(Message::Ping(payload)) => {
            let _ = socket.send(Message::Pong(payload));
            Ok(None)
        }
        Ok(Message::Close(_)) => Err("WeCom WebSocket closed".to_string()),
        Ok(_) => Ok(None),
        Err(WsError::Io(error))
            if matches!(
                error.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            ) =>
        {
            Ok(None)
        }
        Err(error) => Err(format!("WeCom WebSocket read failed: {}", error)),
    }
}

#[allow(clippy::too_many_arguments)]
fn try_route_bot_binding_message(
    manager: &Arc<WecomBridgeManager>,
    app: &AppHandle,
    runtime_manager: &Arc<HeadlessRuntimeManager>,
    connection: &Arc<WecomConnection>,
    bot: &WecomBotConfig,
    actor: &str,
    role: UserRole,
    peer_id: &str,
    frame: &WecomFrame,
    normalized: &mut self::message::NormalizedMessage,
    stream_id: &str,
) -> Result<bool, String> {
    let markers = extract_bot_binding_route_markers(normalized);
    let bot_binding_manager = app.state::<Arc<crate::bot_binding::BotBindingManager>>();
    let has_route_marker = markers.quoted_task_id.is_some() || markers.correlation_marker.is_some();
    let binding = if has_route_marker {
        match bot_binding_manager.find_binding_for_route(
            RemotePlatform::Wecom,
            Some(&bot.bot_id),
            peer_id,
            markers.quoted_task_id.as_deref(),
            markers.correlation_marker.as_deref(),
        ) {
            Some(binding) => binding,
            None => {
                connection.send_stream(
                    &frame.headers.req_id,
                    stream_id,
                    "没有找到这个 CCEM 绑定会话。请确认回复里带的是最新的 #短ID。",
                    true,
                )?;
                return Ok(true);
            }
        }
    } else {
        let candidates =
            active_bot_bindings_for_target(app, bot_binding_manager.inner(), &bot.bot_id, peer_id);
        match candidates.as_slice() {
            [binding] => binding.clone(),
            [] => return Ok(false),
            _ => {
                connection.send_stream(
                    &frame.headers.req_id,
                    stream_id,
                    &format_ambiguous_bot_binding_reply(&candidates),
                    true,
                )?;
                return Ok(true);
            }
        }
    };

    let prompt = match role {
        UserRole::Admin => {
            prepare_message_attachments(bot, peer_id, &frame.headers.req_id, normalized);
            normalized.to_prompt()
        }
        UserRole::User => {
            connection.send_stream(
                &frame.headers.req_id,
                stream_id,
                "收到，正在判断是否符合普通用户范围...",
                false,
            )?;
            let decision = match evaluate_user_admission(
                manager,
                app,
                runtime_manager,
                bot,
                actor,
                normalized,
            ) {
                Ok(decision) => decision,
                Err(error) => {
                    connection.send_stream(
                        &frame.headers.req_id,
                        stream_id,
                        &format!("普通用户准入判断失败：{}", error),
                        true,
                    )?;
                    return Ok(true);
                }
            };
            if !decision.allow {
                connection.send_stream(
                    &frame.headers.req_id,
                    stream_id,
                    &format!("未通过普通用户权限策略：{}", decision.reason),
                    true,
                )?;
                return Ok(true);
            }
            prepare_message_attachments(bot, peer_id, &frame.headers.req_id, normalized);
            build_user_policy_prompt(&bot.user_access_policy, normalized)
        }
    };

    let unified_state = app.state::<Arc<crate::unified_runtime::UnifiedSessionManager>>();
    let native_state = app.state::<Arc<crate::native_runtime::NativeRuntimeManager>>();
    let outbox_cursor = bot_binding_manager
        .outbox(Some(binding.binding_id.clone()))
        .len();
    bot_binding_manager.send_inbound_command(
        app,
        unified_state.inner().as_ref(),
        native_state.inner().clone(),
        crate::bot_binding::BotBindingInboundRequest {
            binding_id: binding.binding_id.clone(),
            client_message_id: Some(frame.headers.req_id.clone()),
            text: prompt,
            quoted_task_id: markers
                .quoted_task_id
                .or_else(|| Some(binding.task_id.clone())),
            responder: Some(actor.to_string()),
        },
    )?;
    connection.send_stream(
        &frame.headers.req_id,
        stream_id,
        "已转入绑定的 CCEM 会话。",
        false,
    )?;
    spawn_bot_binding_stream_relay(
        Arc::clone(manager),
        bot_binding_manager.inner().clone(),
        binding.binding_id.clone(),
        binding.bot_id.clone(),
        crate::bot_binding::bot_binding_route_id(&binding),
        frame.headers.req_id.clone(),
        stream_id.to_string(),
        outbox_cursor,
    )?;
    Ok(true)
}

fn active_bot_bindings_for_target(
    app: &AppHandle,
    bot_binding_manager: &crate::bot_binding::BotBindingManager,
    bot_id: &str,
    peer_id: &str,
) -> Vec<crate::bot_binding::BotBindingInfo> {
    let unified_state = app.state::<Arc<crate::unified_runtime::UnifiedSessionManager>>();
    let native_state = app.state::<Arc<crate::native_runtime::NativeRuntimeManager>>();
    let unified_sessions = unified_state.inner().list_sessions();
    let native_sessions = native_state.inner().list_sessions();

    bot_binding_manager
        .find_bindings_for_target(RemotePlatform::Wecom, Some(bot_id), peer_id)
        .into_iter()
        .filter(|binding| {
            unified_sessions
                .iter()
                .any(|session| session.id == binding.runtime_id && session.is_active)
                || native_sessions
                    .iter()
                    .any(|session| session.runtime_id == binding.runtime_id && session.is_active)
        })
        .collect()
}

fn format_ambiguous_bot_binding_reply(bindings: &[crate::bot_binding::BotBindingInfo]) -> String {
    let mut lines = vec!["当前会话里有多个活跃的 CCEM 绑定任务，请带 #短ID 回复：".to_string()];
    for binding in bindings.iter().rev().take(6) {
        lines.push(format!(
            "- #{} {}",
            crate::bot_binding::bot_binding_route_id(binding),
            binding.task_title
        ));
    }
    lines.join("\n")
}

fn spawn_bot_binding_stream_relay(
    manager: Arc<WecomBridgeManager>,
    bot_binding_manager: Arc<crate::bot_binding::BotBindingManager>,
    binding_id: String,
    bot_id: Option<String>,
    route_id: String,
    req_id: String,
    stream_id: String,
    start_cursor: usize,
) -> Result<(), String> {
    const POLL_MS: u64 = 750;
    const MAX_MS: u64 = 6 * 60 * 60 * 1_000;
    const TEXT_LIMIT: usize = 18_000;

    thread::Builder::new()
        .name(format!("wecom-bot-binding-relay-{binding_id}"))
        .spawn(move || {
            let started_at = Instant::now();
            let mut cursor = start_cursor;
            let mut content = String::new();
            let mut last_sent = String::new();

            loop {
                let frames = bot_binding_manager.outbox(Some(binding_id.clone()));
                let mut should_finish = false;

                if cursor < frames.len() {
                    for frame in frames.iter().skip(cursor) {
                        let has_content = !content.trim().is_empty();
                        if let Some(block) = format_bot_binding_stream_block(frame, has_content) {
                            append_bot_binding_stream_block(
                                &mut content,
                                &block,
                                bot_binding_frame_is_inline_text(frame),
                            );
                        }
                        if bot_binding_frame_finishes_stream(frame) {
                            should_finish = true;
                            break;
                        }
                    }
                    cursor = frames.len();

                    if should_finish && content.trim().is_empty() {
                        content.push_str("完成。");
                    }

                    if should_finish || content != last_sent {
                        let payload = truncate_utf8(
                            &with_bot_binding_route_footer(&content, &route_id),
                            TEXT_LIMIT,
                        );
                        match send_bot_binding_stream_update(
                            &manager,
                            bot_id.as_deref(),
                            &req_id,
                            &stream_id,
                            &payload,
                            should_finish,
                        ) {
                            Ok(()) => last_sent = content.clone(),
                            Err(error) => {
                                eprintln!("WeCom bot binding relay warning: {}", error);
                                break;
                            }
                        }
                    }
                }

                if should_finish {
                    break;
                }

                if started_at.elapsed() >= Duration::from_millis(MAX_MS) {
                    append_bot_binding_stream_block(
                        &mut content,
                        "绑定会话仍在运行，企微本次推送窗口已结束。",
                        false,
                    );
                    let payload = truncate_utf8(
                        &with_bot_binding_route_footer(&content, &route_id),
                        TEXT_LIMIT,
                    );
                    if let Err(error) = send_bot_binding_stream_update(
                        &manager,
                        bot_id.as_deref(),
                        &req_id,
                        &stream_id,
                        &payload,
                        true,
                    ) {
                        eprintln!("WeCom bot binding relay timeout warning: {}", error);
                    }
                    break;
                }

                thread::sleep(Duration::from_millis(POLL_MS));
            }
        })
        .map(|_| ())
        .map_err(|error| format!("Failed to spawn WeCom bot binding relay: {}", error))
}

pub fn start_bot_binding_markdown_relay(
    manager: Arc<WecomBridgeManager>,
    bot_binding_manager: Arc<crate::bot_binding::BotBindingManager>,
    binding: crate::bot_binding::BotBindingInfo,
    start_cursor: usize,
) -> Result<(), String> {
    if binding.platform != RemotePlatform::Wecom {
        return Ok(());
    }

    const POLL_MS: u64 = 750;
    const MAX_MS: u64 = 6 * 60 * 60 * 1_000;
    const TEXT_LIMIT: usize = 18_000;

    let binding_id = binding.binding_id.clone();
    let bot_id = binding.bot_id.clone();
    let peer_id = binding.peer_id.clone();
    thread::Builder::new()
        .name(format!("wecom-bot-binding-markdown-relay-{binding_id}"))
        .spawn(move || {
            let started_at = Instant::now();
            let mut cursor = start_cursor;
            let mut sent_any = false;
            let mut skipping_streamed_reply = false;
            let route_id = crate::bot_binding::bot_binding_route_id(&binding);
            let progress_req_id = generate_req_id("aibot_send_msg");
            let progress_stream_id = generate_req_id("botbind_active_stream");
            let mut progress_content = String::new();
            let mut last_progress_sent = String::new();
            let mut progress_mode = BotBindingActiveProgressMode::Stream;
            let mut turn_text = String::new();

            loop {
                let frames = bot_binding_manager.outbox(Some(binding_id.clone()));
                let mut normal_blocks = Vec::<String>::new();
                let mut should_finish = false;
                let mut skipped_streamed_reply_finished = false;
                let mut next_cursor = cursor;
                let mut next_skipping_streamed_reply = skipping_streamed_reply;
                let mut next_turn_text = turn_text.clone();
                let mut next_progress_content = progress_content.clone();
                let mut progress_changed = false;

                if cursor < frames.len() {
                    for (index, frame) in frames.iter().enumerate().skip(cursor) {
                        next_cursor = index + 1;
                        if matches!(
                            &frame.kind,
                            crate::bot_binding::BotBindingOutboxFrameKind::InboundCommand
                        ) {
                            next_skipping_streamed_reply = true;
                            continue;
                        }
                        let frame_finishes = bot_binding_frame_finishes_stream(frame);
                        if next_skipping_streamed_reply {
                            if frame_finishes {
                                next_skipping_streamed_reply = false;
                                skipped_streamed_reply_finished = true;
                                should_finish = true;
                                break;
                            }
                            continue;
                        }

                        let delivery_kind = bot_binding_markdown_relay_frame_kind(frame);
                        let has_prior_content = sent_any
                            || !normal_blocks.is_empty()
                            || !next_turn_text.trim().is_empty();
                        let block = format_bot_binding_stream_block(frame, has_prior_content);
                        match delivery_kind {
                            BotBindingRelayFrameKind::Skip => {}
                            BotBindingRelayFrameKind::Progress => {
                                if bot_binding_frame_is_inline_text(frame) {
                                    append_bot_binding_turn_text(&mut next_turn_text, frame);
                                } else if bot_binding_frame_is_active_progress_message(frame) {
                                    if let Some(block) = block {
                                        append_bot_binding_stream_block(
                                            &mut next_progress_content,
                                            &block,
                                            false,
                                        );
                                        progress_changed = true;
                                    }
                                }
                            }
                            BotBindingRelayFrameKind::Key => {
                                if let Some(block) = block {
                                    normal_blocks.push(block);
                                }
                            }
                            BotBindingRelayFrameKind::TurnComplete => {
                                if let Some(final_text) =
                                    take_bot_binding_turn_text(&mut next_turn_text, block)
                                {
                                    normal_blocks.push(final_text);
                                }
                            }
                        }
                        if frame_finishes {
                            should_finish = true;
                            break;
                        }
                    }
                    if bot_binding_should_emit_completion_fallback(
                        should_finish,
                        normal_blocks.is_empty(),
                        &next_turn_text,
                        &next_progress_content,
                        progress_mode,
                        skipped_streamed_reply_finished,
                    ) {
                        normal_blocks.push("完成。".to_string());
                    }

                    let mut progress_delivered = true;
                    if (progress_changed && next_progress_content != last_progress_sent)
                        || (should_finish && !next_progress_content.trim().is_empty())
                    {
                        let progress_payload =
                            bot_binding_progress_payload(&next_progress_content, should_finish);
                        let payload = truncate_utf8(
                            &with_bot_binding_route_footer(&progress_payload, &route_id),
                            TEXT_LIMIT,
                        );
                        if progress_mode == BotBindingActiveProgressMode::Stream {
                            match manager.send_stream_message(
                                bot_id.as_deref(),
                                &peer_id,
                                &progress_req_id,
                                &progress_stream_id,
                                &payload,
                                should_finish,
                            ) {
                                Ok(_) => {
                                    last_progress_sent = next_progress_content.clone();
                                }
                                Err(error) => {
                                    eprintln!(
                                        "WeCom bot binding active stream relay warning: {}",
                                        error
                                    );
                                    if bot_binding_active_stream_error_is_unsupported(&error) {
                                        progress_mode = BotBindingActiveProgressMode::Unsupported;
                                        last_progress_sent = next_progress_content.clone();
                                    } else {
                                        progress_delivered = false;
                                    }
                                }
                            }
                        }
                    }

                    let mut batch_delivered = normal_blocks.is_empty();
                    let mut stop_relay = false;
                    if !normal_blocks.is_empty() {
                        let payload = truncate_utf8(
                            &with_bot_binding_route_footer(&normal_blocks.join("\n\n"), &route_id),
                            TEXT_LIMIT,
                        );
                        match manager.send_markdown_message(bot_id.as_deref(), &peer_id, &payload) {
                            Ok(_) => {
                                sent_any = true;
                                batch_delivered = true;
                            }
                            Err(error) => {
                                eprintln!("WeCom bot binding markdown relay warning: {}", error);
                                match bot_binding_markdown_send_outcome(&error) {
                                    BotBindingMarkdownSendOutcome::AssumeDelivered => {
                                        sent_any = true;
                                        batch_delivered = true;
                                    }
                                    BotBindingMarkdownSendOutcome::RetryLater => {}
                                    BotBindingMarkdownSendOutcome::Fatal => {
                                        stop_relay = true;
                                    }
                                }
                            }
                        }
                    }

                    if progress_delivered && batch_delivered {
                        cursor = next_cursor;
                        skipping_streamed_reply = next_skipping_streamed_reply;
                        turn_text = next_turn_text;
                        progress_content = next_progress_content;
                    }
                    if stop_relay || (should_finish && progress_delivered && batch_delivered) {
                        break;
                    }
                }

                if started_at.elapsed() >= Duration::from_millis(MAX_MS) {
                    let payload = "绑定会话仍在运行，企微本次同步窗口已结束。";
                    if let Err(error) =
                        manager.send_markdown_message(bot_id.as_deref(), &peer_id, payload)
                    {
                        eprintln!(
                            "WeCom bot binding markdown relay timeout warning: {}",
                            error
                        );
                    }
                    break;
                }

                thread::sleep(Duration::from_millis(POLL_MS));
            }
        })
        .map(|_| ())
        .map_err(|error| {
            format!(
                "Failed to spawn WeCom bot binding markdown relay: {}",
                error
            )
        })
}

fn send_bot_binding_stream_update(
    manager: &WecomBridgeManager,
    bot_id: Option<&str>,
    req_id: &str,
    stream_id: &str,
    content: &str,
    finish: bool,
) -> Result<(), String> {
    let connection = manager.connection_for_bot(bot_id)?;
    if !connection.is_connected() {
        return Err("WeCom bot connection is not active.".to_string());
    }
    connection.send_stream(req_id, stream_id, content, finish)
}

fn format_bot_binding_stream_block(
    frame: &crate::bot_binding::BotBindingOutboxFrame,
    has_prior_content: bool,
) -> Option<String> {
    let text = frame.text.trim();
    match &frame.kind {
        crate::bot_binding::BotBindingOutboxFrameKind::TaskCard
        | crate::bot_binding::BotBindingOutboxFrameKind::InboundCommand => None,
        crate::bot_binding::BotBindingOutboxFrameKind::EventUpdate
            if matches!(
                frame.title.as_str(),
                "User prompt" | "System message" | "Token usage" | "Context usage"
            ) =>
        {
            None
        }
        crate::bot_binding::BotBindingOutboxFrameKind::EventUpdate
            if frame.title == "Assistant update" =>
        {
            (!frame.text.trim().is_empty()).then(|| frame.text.clone())
        }
        crate::bot_binding::BotBindingOutboxFrameKind::EventUpdate
            if frame.title.starts_with("Tool started · ") =>
        {
            format_tool_started_stream_block(
                frame.title.trim_start_matches("Tool started · "),
                text,
            )
        }
        crate::bot_binding::BotBindingOutboxFrameKind::EventUpdate
            if frame.title.starts_with("Tool completed · ") =>
        {
            format_tool_completed_stream_block(
                frame.title.trim_start_matches("Tool completed · "),
                text,
            )
        }
        crate::bot_binding::BotBindingOutboxFrameKind::EventUpdate
            if frame.title == "Lifecycle · turn_completed" =>
        {
            if has_prior_content || text.is_empty() {
                Some("完成。".to_string())
            } else {
                Some(format!("完成：{text}"))
            }
        }
        crate::bot_binding::BotBindingOutboxFrameKind::EventUpdate => {
            format_titled_bot_binding_block(&frame.title, text)
        }
        crate::bot_binding::BotBindingOutboxFrameKind::InteractiveOutput => {
            Some(format!("{}\n{}", frame.title, text))
        }
        crate::bot_binding::BotBindingOutboxFrameKind::PermissionPrompt => {
            format_titled_bot_binding_block(&format!("需要处理：{}", frame.title), text)
        }
        crate::bot_binding::BotBindingOutboxFrameKind::SessionCompleted => {
            if has_prior_content || text.is_empty() || matches!(text, "completed" | "stopped") {
                Some("完成。".to_string())
            } else {
                Some(format!("完成：{text}"))
            }
        }
        crate::bot_binding::BotBindingOutboxFrameKind::Error => {
            format_titled_bot_binding_block(&format!("错误：{}", frame.title), text)
        }
    }
}

fn format_tool_started_stream_block(tool_name: &str, text: &str) -> Option<String> {
    let display_text = text.trim();
    match tool_name {
        "Plan" if display_text.is_empty() || display_text == "进入计划模式" => {
            Some("计划：已进入计划模式。".to_string())
        }
        "Plan" => Some(format!("计划：\n{display_text}")),
        "Plan review" => Some(format!("计划待确认：\n{display_text}")),
        "Question" => Some(format!("需要确认：\n{display_text}")),
        "Subagent" => Some(format!("子 Agent：{}", compact_progress_text(display_text))),
        _ => Some(
            format!(
                "处理中：{} {}",
                tool_name,
                compact_progress_text(display_text)
            )
            .trim()
            .to_string(),
        ),
    }
}

fn format_tool_completed_stream_block(tool_name: &str, text: &str) -> Option<String> {
    let display_text = text.trim();
    match tool_name {
        "Subagent" if !display_text.is_empty() => Some(format!("子 Agent 结果：\n{display_text}")),
        "Plan review" | "Question" => None,
        _ => Some(format!("处理中：{} 完成", tool_name)),
    }
}

fn compact_progress_text(text: &str) -> String {
    let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= 120 {
        return compact;
    }
    let mut value = compact.chars().take(119).collect::<String>();
    value.push('…');
    value
}

fn format_titled_bot_binding_block(title: &str, text: &str) -> Option<String> {
    if title.trim().is_empty() && text.is_empty() {
        None
    } else if text.is_empty() {
        Some(title.trim().to_string())
    } else if title.trim().is_empty() {
        Some(text.to_string())
    } else {
        Some(format!("{}：\n{}", title.trim(), text))
    }
}

fn append_bot_binding_stream_block(content: &mut String, block: &str, inline: bool) {
    if inline {
        if !block.trim().is_empty() {
            remove_trailing_progress_block(content);
            content.push_str(block);
        }
        return;
    }

    let trimmed = block.trim();
    if trimmed.is_empty() {
        return;
    }
    if is_progress_block(trimmed) {
        if replace_trailing_progress_block(content, trimmed) {
            return;
        }
    } else {
        remove_trailing_progress_block(content);
    }
    if !content.trim().is_empty() {
        content.push_str("\n\n");
    }
    content.push_str(trimmed);
}

fn append_bot_binding_stream_vec_block(blocks: &mut Vec<String>, block: String, inline: bool) {
    if inline {
        if block.trim().is_empty() {
            return;
        }
        remove_trailing_progress_vec_block(blocks);
        match blocks.last_mut() {
            Some(last) if !last.contains('\n') => {
                last.push_str(&block);
            }
            _ => blocks.push(block),
        }
        return;
    }

    let trimmed = block.trim();
    if !trimmed.is_empty() {
        if is_progress_block(trimmed) {
            if let Some(last) = blocks.last_mut() {
                if is_progress_block(last) {
                    *last = trimmed.to_string();
                    return;
                }
            }
        } else {
            remove_trailing_progress_vec_block(blocks);
        }
        blocks.push(trimmed.to_string());
    }
}

fn is_progress_block(block: &str) -> bool {
    block.trim_start().starts_with("处理中：")
}

fn replace_trailing_progress_block(content: &mut String, next: &str) -> bool {
    let trimmed = content.trim_end();
    if trimmed.is_empty() {
        return false;
    }
    let start = trimmed.rfind("\n\n").map(|index| index + 2).unwrap_or(0);
    if !is_progress_block(&trimmed[start..]) {
        return false;
    }
    content.truncate(start);
    content.push_str(next);
    true
}

fn remove_trailing_progress_block(content: &mut String) {
    let trimmed = content.trim_end();
    if trimmed.is_empty() {
        content.clear();
        return;
    }
    let start = trimmed.rfind("\n\n").map(|index| index + 2).unwrap_or(0);
    if !is_progress_block(&trimmed[start..]) {
        return;
    }
    content.truncate(start.saturating_sub(2));
}

fn remove_trailing_progress_vec_block(blocks: &mut Vec<String>) {
    if blocks.last().is_some_and(|block| is_progress_block(block)) {
        blocks.pop();
    }
}

fn with_bot_binding_route_footer(content: &str, route_id: &str) -> String {
    let trimmed = content.trim();
    if route_id.trim().is_empty() {
        return trimmed.to_string();
    }
    if trimmed.contains(&format!("#{route_id}")) {
        return trimmed.to_string();
    }
    if trimmed.is_empty() {
        format!("ID：#{route_id}")
    } else {
        format!("{trimmed}\n\nID：#{route_id}")
    }
}

fn bot_binding_frame_is_inline_text(frame: &crate::bot_binding::BotBindingOutboxFrame) -> bool {
    matches!(
        &frame.kind,
        crate::bot_binding::BotBindingOutboxFrameKind::EventUpdate
    ) && frame.title == "Assistant update"
}

fn bot_binding_frame_is_active_progress_message(
    frame: &crate::bot_binding::BotBindingOutboxFrame,
) -> bool {
    matches!(
        &frame.kind,
        crate::bot_binding::BotBindingOutboxFrameKind::EventUpdate
    ) && (frame.title.starts_with("Tool started · ")
        || frame.title.starts_with("Tool completed · "))
        && bot_binding_markdown_relay_frame_kind(frame) == BotBindingRelayFrameKind::Progress
}

fn bot_binding_progress_payload(content: &str, finish: bool) -> String {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return if finish {
            "中间过程已完成。".to_string()
        } else {
            "处理中。".to_string()
        };
    }
    if finish {
        format!("{trimmed}\n\n中间过程已完成。")
    } else {
        trimmed.to_string()
    }
}

fn bot_binding_should_emit_completion_fallback(
    should_finish: bool,
    normal_blocks_empty: bool,
    turn_text: &str,
    progress_content: &str,
    progress_mode: BotBindingActiveProgressMode,
    skipped_streamed_reply_finished: bool,
) -> bool {
    should_finish
        && normal_blocks_empty
        && turn_text.trim().is_empty()
        && (progress_mode == BotBindingActiveProgressMode::Unsupported
            || progress_content.trim().is_empty())
        && !skipped_streamed_reply_finished
}

fn bot_binding_active_stream_error_is_unsupported(error: &str) -> bool {
    error.starts_with("WeCom send ack failed:")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BotBindingActiveProgressMode {
    Stream,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BotBindingRelayFrameKind {
    Skip,
    Progress,
    Key,
    TurnComplete,
}

fn bot_binding_markdown_relay_frame_kind(
    frame: &crate::bot_binding::BotBindingOutboxFrame,
) -> BotBindingRelayFrameKind {
    match &frame.kind {
        crate::bot_binding::BotBindingOutboxFrameKind::TaskCard
        | crate::bot_binding::BotBindingOutboxFrameKind::InboundCommand => {
            BotBindingRelayFrameKind::Skip
        }
        crate::bot_binding::BotBindingOutboxFrameKind::EventUpdate
            if matches!(
                frame.title.as_str(),
                "User prompt" | "System message" | "Token usage" | "Context usage"
            ) =>
        {
            BotBindingRelayFrameKind::Skip
        }
        crate::bot_binding::BotBindingOutboxFrameKind::EventUpdate
            if frame.title == "Lifecycle · turn_completed" =>
        {
            BotBindingRelayFrameKind::TurnComplete
        }
        crate::bot_binding::BotBindingOutboxFrameKind::SessionCompleted => {
            BotBindingRelayFrameKind::TurnComplete
        }
        crate::bot_binding::BotBindingOutboxFrameKind::EventUpdate
            if frame.title == "Assistant update" =>
        {
            BotBindingRelayFrameKind::Progress
        }
        crate::bot_binding::BotBindingOutboxFrameKind::EventUpdate
            if frame.title.starts_with("Tool started · ") =>
        {
            match frame.title.trim_start_matches("Tool started · ") {
                "Plan" | "Plan review" | "Question" => BotBindingRelayFrameKind::Key,
                _ => BotBindingRelayFrameKind::Progress,
            }
        }
        crate::bot_binding::BotBindingOutboxFrameKind::EventUpdate
            if frame.title.starts_with("Tool completed · ") =>
        {
            match frame.title.trim_start_matches("Tool completed · ") {
                "Subagent" if !frame.text.trim().is_empty() => BotBindingRelayFrameKind::Key,
                "Plan review" | "Question" => BotBindingRelayFrameKind::Skip,
                _ => BotBindingRelayFrameKind::Progress,
            }
        }
        crate::bot_binding::BotBindingOutboxFrameKind::EventUpdate => {
            BotBindingRelayFrameKind::Progress
        }
        crate::bot_binding::BotBindingOutboxFrameKind::InteractiveOutput
        | crate::bot_binding::BotBindingOutboxFrameKind::PermissionPrompt
        | crate::bot_binding::BotBindingOutboxFrameKind::Error => BotBindingRelayFrameKind::Key,
    }
}

fn append_bot_binding_turn_text(
    turn_text: &mut String,
    frame: &crate::bot_binding::BotBindingOutboxFrame,
) {
    if !bot_binding_frame_is_inline_text(frame) {
        return;
    }
    let text = frame.text.as_str();
    if text.is_empty() {
        return;
    }
    if !turn_text.is_empty() && text.starts_with(turn_text.as_str()) {
        *turn_text = text.to_string();
        return;
    }
    turn_text.push_str(text);
}

fn take_bot_binding_turn_text(
    turn_text: &mut String,
    fallback_block: Option<String>,
) -> Option<String> {
    let text = turn_text.trim();
    if !text.is_empty() {
        let output = text.to_string();
        turn_text.clear();
        return Some(output);
    }
    match fallback_block {
        Some(block) if block.trim() != "完成。" => Some(block),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BotBindingMarkdownSendOutcome {
    AssumeDelivered,
    RetryLater,
    Fatal,
}

fn bot_binding_markdown_send_outcome(error: &str) -> BotBindingMarkdownSendOutcome {
    if error.starts_with("WeCom send ack timed out:") {
        return BotBindingMarkdownSendOutcome::AssumeDelivered;
    }
    if error.starts_with("WeCom send ack failed:") {
        return BotBindingMarkdownSendOutcome::Fatal;
    }
    BotBindingMarkdownSendOutcome::RetryLater
}

fn bot_binding_frame_finishes_stream(frame: &crate::bot_binding::BotBindingOutboxFrame) -> bool {
    matches!(
        &frame.kind,
        crate::bot_binding::BotBindingOutboxFrameKind::SessionCompleted
    ) || (matches!(
        &frame.kind,
        crate::bot_binding::BotBindingOutboxFrameKind::EventUpdate
    ) && frame.title == "Lifecycle · turn_completed")
}

fn set_socket_read_timeout(socket: &mut WecomSocket) {
    let _ = match socket.get_mut() {
        MaybeTlsStream::Plain(stream) => {
            stream.set_read_timeout(Some(Duration::from_millis(WECOM_READ_TIMEOUT_MS)))
        }
        MaybeTlsStream::NativeTls(stream) => stream
            .get_ref()
            .set_read_timeout(Some(Duration::from_millis(WECOM_READ_TIMEOUT_MS))),
        #[allow(unreachable_patterns)]
        _ => Ok(()),
    };
}

fn interruptible_sleep(manager: &WecomBridgeManager, duration: Duration) {
    let deadline = Instant::now() + duration;
    while Instant::now() < deadline && !manager.stop_flag.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(100));
    }
}

fn scope_key(bot_id: &str, peer_id: &str) -> String {
    format!("{bot_id}:{peer_id}")
}

fn bot_display_name(bot: &WecomBotConfig) -> String {
    if bot.name.trim().is_empty() {
        bot.bot_id.clone()
    } else {
        bot.name.clone()
    }
}

pub fn truncate_utf8(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    format!("{}…", &text[..end])
}

fn generate_req_id(prefix: &str) -> String {
    let mut random = [0u8; 4];
    rand::thread_rng().fill_bytes(&mut random);
    format!(
        "{prefix}_{}_{}",
        Utc::now().timestamp_millis(),
        hex::encode(random)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bot_binding::{BotBindingOutboxFrame, BotBindingOutboxFrameKind};

    #[test]
    fn read_wecom_settings_rejects_tampered_v2_secret_without_exposing_value() {
        let tampered = "enc:v2:000000000000000000000000:00:00000000000000000000000000000000";
        let settings = WecomSettings {
            enabled: true,
            bots: vec![WecomBotConfig {
                id: "bot-1".to_string(),
                name: "test bot".to_string(),
                bot_id: "ww-bot".to_string(),
                secret: Some(tampered.to_string()),
                workspace_dir: "/tmp".to_string(),
                ..WecomBotConfig::default()
            }],
        };

        let error = decrypt_wecom_settings(settings).expect_err("tampered v2 secret should fail");

        assert!(
            !error.contains(tampered),
            "Error should not include encrypted secret material"
        );
    }

    #[test]
    fn wecom_chatid_from_peer_id_strips_internal_scope_prefixes() {
        assert_eq!(wecom_chatid_from_peer_id("single:user_a"), "user_a");
        assert_eq!(wecom_chatid_from_peer_id("group:chat_1"), "chat_1");
        assert_eq!(wecom_chatid_from_peer_id(" raw_id "), "raw_id");
    }

    #[test]
    fn wecom_markdown_send_retries_transient_connection_errors() {
        assert!(wecom_markdown_send_error_is_retryable(
            "WeCom socket is not connected"
        ));
        assert!(wecom_markdown_send_error_is_retryable(
            "WeCom bot is not connected: webot"
        ));
        assert!(wecom_markdown_send_error_is_retryable(
            "Failed to send WeCom frame: AlreadyClosed"
        ));
        assert!(!wecom_markdown_send_error_is_retryable(
            "WeCom send ack failed: invalid chatid"
        ));
    }

    #[test]
    fn extract_bot_binding_route_markers_reads_quote_before_text() {
        let message = self::message::NormalizedMessage {
            text: "继续推进 ccem-task-other".to_string(),
            attachments: Vec::new(),
            quote: Some(
                "**Task**\n任务：`ccem-task-runtime`\n标记：`ccem-bot-binding:binding:ccem-task-runtime`"
                    .to_string(),
            ),
        };

        let markers = extract_bot_binding_route_markers(&message);

        assert_eq!(markers.quoted_task_id.as_deref(), Some("ccem-task-runtime"));
        assert_eq!(
            markers.correlation_marker.as_deref(),
            Some("ccem-bot-binding:binding:ccem-task-runtime")
        );
    }

    #[test]
    fn extract_bot_binding_route_markers_accepts_short_ids() {
        let quoted = self::message::NormalizedMessage {
            text: "继续".to_string(),
            attachments: Vec::new(),
            quote: Some("上次进度\n\nID：#A1B2C3D4".to_string()),
        };
        let inline = self::message::NormalizedMessage {
            text: "ccem:A1B2C3D4 继续写测试".to_string(),
            attachments: Vec::new(),
            quote: None,
        };

        assert_eq!(
            extract_bot_binding_route_markers(&quoted)
                .correlation_marker
                .as_deref(),
            Some("A1B2C3D4")
        );
        assert_eq!(
            extract_bot_binding_route_markers(&inline)
                .correlation_marker
                .as_deref(),
            Some("ccem:A1B2C3D4")
        );
    }

    #[test]
    fn bot_binding_stream_block_skips_routing_noise() {
        let user_prompt = bot_binding_frame(
            BotBindingOutboxFrameKind::EventUpdate,
            "User prompt",
            "[ccem bot-bound command]\ncontinue",
        );
        let system_message = bot_binding_frame(
            BotBindingOutboxFrameKind::EventUpdate,
            "System message",
            "internal native sdk chunk",
        );
        let inbound = bot_binding_frame(
            BotBindingOutboxFrameKind::InboundCommand,
            "Inbound bot command",
            "continue",
        );

        assert_eq!(format_bot_binding_stream_block(&user_prompt, false), None);
        assert_eq!(
            format_bot_binding_stream_block(&system_message, false),
            None
        );
        assert_eq!(format_bot_binding_stream_block(&inbound, false), None);
    }

    #[test]
    fn bot_binding_assistant_chunks_preserve_spacing_and_merge_inline() {
        let first = bot_binding_frame(
            BotBindingOutboxFrameKind::EventUpdate,
            "Assistant update",
            "最新",
        );
        let second = bot_binding_frame(
            BotBindingOutboxFrameKind::EventUpdate,
            "Assistant update",
            " AI",
        );
        let mut blocks = Vec::new();

        let first_block = format_bot_binding_stream_block(&first, false).unwrap();
        let second_block = format_bot_binding_stream_block(&second, true).unwrap();
        append_bot_binding_stream_vec_block(
            &mut blocks,
            first_block,
            bot_binding_frame_is_inline_text(&first),
        );
        append_bot_binding_stream_vec_block(
            &mut blocks,
            second_block,
            bot_binding_frame_is_inline_text(&second),
        );

        assert_eq!(blocks, vec!["最新 AI"]);
    }

    #[test]
    fn bot_binding_turn_completed_finishes_stream_without_repeating_answer() {
        let assistant = bot_binding_frame(
            BotBindingOutboxFrameKind::EventUpdate,
            "Assistant update",
            "已经定位到问题。",
        );
        let completed = bot_binding_frame(
            BotBindingOutboxFrameKind::EventUpdate,
            "Lifecycle · turn_completed",
            "已经定位到问题。",
        );

        assert_eq!(
            format_bot_binding_stream_block(&assistant, false).as_deref(),
            Some("已经定位到问题。")
        );
        assert_eq!(
            format_bot_binding_stream_block(&completed, true).as_deref(),
            Some("完成。")
        );
        assert!(bot_binding_frame_finishes_stream(&completed));
    }

    #[test]
    fn bot_binding_tool_events_are_streamed_as_progress() {
        let first_tool = bot_binding_frame(
            BotBindingOutboxFrameKind::EventUpdate,
            "Tool started · rg",
            "rg -n bot_binding",
        );
        let second_tool = bot_binding_frame(
            BotBindingOutboxFrameKind::EventUpdate,
            "Tool started · Read",
            "apps/desktop/src-tauri/src/wecom/mod.rs",
        );
        let assistant = bot_binding_frame(
            BotBindingOutboxFrameKind::EventUpdate,
            "Assistant update",
            "已经收敛输出。",
        );
        let mut content = String::new();

        assert_eq!(
            format_bot_binding_stream_block(&first_tool, false).as_deref(),
            Some("处理中：rg rg -n bot_binding")
        );
        append_bot_binding_stream_block(
            &mut content,
            &format_bot_binding_stream_block(&first_tool, false).unwrap(),
            bot_binding_frame_is_inline_text(&first_tool),
        );
        append_bot_binding_stream_block(
            &mut content,
            &format_bot_binding_stream_block(&second_tool, true).unwrap(),
            bot_binding_frame_is_inline_text(&second_tool),
        );
        assert_eq!(
            content,
            "处理中：Read apps/desktop/src-tauri/src/wecom/mod.rs"
        );
        append_bot_binding_stream_block(
            &mut content,
            &format_bot_binding_stream_block(&assistant, true).unwrap(),
            bot_binding_frame_is_inline_text(&assistant),
        );
        assert_eq!(content, "已经收敛输出。");
        assert!(!bot_binding_frame_finishes_stream(&first_tool));
    }

    #[test]
    fn bot_binding_key_tools_get_special_blocks() {
        let plan = bot_binding_frame(
            BotBindingOutboxFrameKind::EventUpdate,
            "Tool started · Plan review",
            "1. 调整路由\n2. 验证输出",
        );
        let subagent = bot_binding_frame(
            BotBindingOutboxFrameKind::EventUpdate,
            "Tool started · Subagent",
            "检查企微格式",
        );

        assert_eq!(
            format_bot_binding_stream_block(&plan, false).as_deref(),
            Some("计划待确认：\n1. 调整路由\n2. 验证输出")
        );
        assert_eq!(
            format_bot_binding_stream_block(&subagent, false).as_deref(),
            Some("子 Agent：检查企微格式")
        );
    }

    #[test]
    fn bot_binding_route_footer_keeps_followup_anchor_visible() {
        assert_eq!(
            with_bot_binding_route_footer("已经完成。", "A1B2C3D4"),
            "已经完成。\n\nID：#A1B2C3D4"
        );
        assert_eq!(
            with_bot_binding_route_footer("已经完成。\n\nID：#A1B2C3D4", "A1B2C3D4"),
            "已经完成。\n\nID：#A1B2C3D4"
        );
    }

    #[test]
    fn active_stream_message_uses_proactive_send_channel() {
        let frame = build_active_stream_message_frame(
            "req-1",
            "chat-1",
            "stream-1",
            "处理中：Read 文件",
            false,
        );

        assert_eq!(frame["cmd"], json!("aibot_send_msg"));
        assert_eq!(frame["headers"]["req_id"], json!("req-1"));
        assert_eq!(frame["body"]["chatid"], json!("chat-1"));
        assert_eq!(frame["body"]["msgtype"], json!("stream"));
        assert_eq!(frame["body"]["stream"]["id"], json!("stream-1"));
        assert_eq!(frame["body"]["stream"]["finish"], json!(false));
        assert_eq!(
            frame["body"]["stream"]["content"],
            json!("处理中：Read 文件")
        );
    }

    #[test]
    fn active_stream_updates_keep_the_same_send_request_id() {
        let first = build_active_stream_message_frame(
            "aibot_send_msg_stable",
            "chat-1",
            "stream-1",
            "处理中：Read 文件",
            false,
        );
        let second = build_active_stream_message_frame(
            "aibot_send_msg_stable",
            "chat-1",
            "stream-1",
            "处理中：Bash 完成",
            false,
        );
        let final_frame = build_active_stream_message_frame(
            "aibot_send_msg_stable",
            "chat-1",
            "stream-1",
            "中间过程已完成。",
            true,
        );

        assert_eq!(first["headers"]["req_id"], second["headers"]["req_id"]);
        assert_eq!(
            second["headers"]["req_id"],
            final_frame["headers"]["req_id"]
        );
        assert_eq!(
            first["body"]["stream"]["id"],
            second["body"]["stream"]["id"]
        );
        assert_eq!(
            second["body"]["stream"]["id"],
            final_frame["body"]["stream"]["id"]
        );
    }

    #[test]
    fn bot_binding_progress_payload_finishes_without_transcript() {
        assert_eq!(
            bot_binding_progress_payload("处理中：Read 文件", false),
            "处理中：Read 文件"
        );
        assert_eq!(
            bot_binding_progress_payload("处理中：Read 文件", true),
            "处理中：Read 文件\n\n中间过程已完成。"
        );
    }

    #[test]
    fn unsupported_active_stream_allows_completion_fallback() {
        assert!(bot_binding_should_emit_completion_fallback(
            true,
            true,
            "",
            "处理中：Read 文件",
            BotBindingActiveProgressMode::Unsupported,
            false,
        ));
        assert!(!bot_binding_should_emit_completion_fallback(
            true,
            true,
            "",
            "处理中：Read 文件",
            BotBindingActiveProgressMode::Stream,
            false,
        ));
    }

    #[test]
    fn bot_binding_markdown_relay_routes_middle_process_to_stream() {
        let assistant = bot_binding_frame(
            BotBindingOutboxFrameKind::EventUpdate,
            "Assistant update",
            "Let me inspect the code.",
        );
        let generic_tool = bot_binding_frame(
            BotBindingOutboxFrameKind::EventUpdate,
            "Tool started · Glob",
            "apps/desktop/src/**/*.tsx",
        );
        let checkpoint = bot_binding_frame(
            BotBindingOutboxFrameKind::EventUpdate,
            "File checkpoint",
            "checkpoint_id: abc",
        );
        let plan = bot_binding_frame(
            BotBindingOutboxFrameKind::EventUpdate,
            "Tool started · Plan review",
            "1. 保留关键输出",
        );
        let subagent_result = bot_binding_frame(
            BotBindingOutboxFrameKind::EventUpdate,
            "Tool completed · Subagent",
            "发现 2 个风险",
        );
        let completed = bot_binding_frame(
            BotBindingOutboxFrameKind::SessionCompleted,
            "Session completed",
            "completed",
        );

        assert_eq!(
            bot_binding_markdown_relay_frame_kind(&assistant),
            BotBindingRelayFrameKind::Progress
        );
        assert_eq!(
            bot_binding_markdown_relay_frame_kind(&generic_tool),
            BotBindingRelayFrameKind::Progress
        );
        assert_eq!(
            bot_binding_markdown_relay_frame_kind(&checkpoint),
            BotBindingRelayFrameKind::Progress
        );
        assert_eq!(
            bot_binding_markdown_relay_frame_kind(&plan),
            BotBindingRelayFrameKind::Key
        );
        assert_eq!(
            bot_binding_markdown_relay_frame_kind(&subagent_result),
            BotBindingRelayFrameKind::Key
        );
        assert_eq!(
            bot_binding_markdown_relay_frame_kind(&completed),
            BotBindingRelayFrameKind::TurnComplete
        );
        assert!(!bot_binding_frame_is_active_progress_message(&assistant));
        assert!(bot_binding_frame_is_active_progress_message(&generic_tool));
        assert!(!bot_binding_frame_is_active_progress_message(&checkpoint));
        assert!(!bot_binding_frame_is_active_progress_message(&plan));
    }

    #[test]
    fn bot_binding_turn_text_flushes_as_normal_transcript_output() {
        let first = bot_binding_frame(
            BotBindingOutboxFrameKind::EventUpdate,
            "Assistant update",
            "Using ",
        );
        let second = bot_binding_frame(
            BotBindingOutboxFrameKind::EventUpdate,
            "Assistant update",
            "vercel-react-best-practices",
        );
        let cumulative = bot_binding_frame(
            BotBindingOutboxFrameKind::EventUpdate,
            "Assistant update",
            "Using vercel-react-best-practices skill.",
        );
        let mut turn_text = String::new();

        append_bot_binding_turn_text(&mut turn_text, &first);
        append_bot_binding_turn_text(&mut turn_text, &second);
        append_bot_binding_turn_text(&mut turn_text, &cumulative);

        assert_eq!(
            take_bot_binding_turn_text(&mut turn_text, Some("完成。".to_string())).as_deref(),
            Some("Using vercel-react-best-practices skill.")
        );
        assert!(turn_text.is_empty());
        assert_eq!(
            take_bot_binding_turn_text(&mut turn_text, Some("完成：stopped".to_string()))
                .as_deref(),
            Some("完成：stopped")
        );
        assert!(take_bot_binding_turn_text(&mut turn_text, Some("完成。".to_string())).is_none());
    }

    #[test]
    fn bot_binding_markdown_relay_keeps_running_on_send_ack_timeout() {
        assert_eq!(
            bot_binding_markdown_send_outcome("WeCom send ack timed out: aibot_send_msg_1"),
            BotBindingMarkdownSendOutcome::AssumeDelivered
        );
        assert_eq!(
            bot_binding_markdown_send_outcome("WeCom socket is not connected"),
            BotBindingMarkdownSendOutcome::RetryLater
        );
        assert_eq!(
            bot_binding_markdown_send_outcome("WeCom send ack failed: errcode 1"),
            BotBindingMarkdownSendOutcome::Fatal
        );
    }

    fn bot_binding_frame(
        kind: BotBindingOutboxFrameKind,
        title: &str,
        text: &str,
    ) -> BotBindingOutboxFrame {
        BotBindingOutboxFrame {
            frame_id: "frame-1".to_string(),
            binding_id: "binding-1".to_string(),
            runtime_id: "runtime-1".to_string(),
            task_id: "ccem-task-runtime-1".to_string(),
            kind,
            title: title.to_string(),
            text: text.to_string(),
            quoted_task_id: None,
            correlation_marker: None,
            delivery_message_id: None,
            occurred_at: Utc::now(),
        }
    }
}
