use super::*;
use crate::channel::{ChannelKind, OutputChannel};
use crate::event_bus::{SessionEventPayload, SessionEventRecord};
use crate::permission_preview::format_permission_preview;

struct WeixinChannelState {
    last_flush_at: Instant,
    last_event_seq: u64,
    pending_stdout: Vec<String>,
    pending_stderr: Vec<String>,
    saw_stdout_this_turn: bool,
    saw_stderr_this_turn: bool,
    live_ready: bool,
    buffered_live_events: Vec<SessionEventRecord>,
}

impl Default for WeixinChannelState {
    fn default() -> Self {
        Self {
            last_flush_at: Instant::now(),
            last_event_seq: 0,
            pending_stdout: Vec::new(),
            pending_stderr: Vec::new(),
            saw_stdout_this_turn: false,
            saw_stderr_this_turn: false,
            live_ready: false,
            buffered_live_events: Vec::new(),
        }
    }
}

pub struct WeixinChannel {
    manager: Arc<WeixinBridgeManager>,
    token: String,
    api_base_url: String,
    flush_interval_ms: u64,
    runtime_id: String,
    peer_id: String,
    connected_at: DateTime<Utc>,
    state: Mutex<WeixinChannelState>,
}

impl WeixinChannel {
    pub fn new(
        manager: Arc<WeixinBridgeManager>,
        token: String,
        api_base_url: String,
        flush_interval_ms: u64,
        runtime_id: String,
        peer_id: String,
    ) -> Self {
        Self {
            manager,
            token,
            api_base_url,
            flush_interval_ms,
            runtime_id,
            peer_id,
            connected_at: Utc::now(),
            state: Mutex::new(WeixinChannelState::default()),
        }
    }

    fn flush_if_due(&self, force: bool) -> Result<(), String> {
        let flush_interval = Duration::from_millis(self.flush_interval_ms.max(500));
        let (stdout, stderr) = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Failed to lock Weixin channel state".to_string())?;
            if state.pending_stdout.is_empty() && state.pending_stderr.is_empty() {
                return Ok(());
            }
            if !force && state.last_flush_at.elapsed() < flush_interval {
                return Ok(());
            }
            state.last_flush_at = Instant::now();
            (
                std::mem::take(&mut state.pending_stdout).join("\n"),
                std::mem::take(&mut state.pending_stderr).join("\n"),
            )
        };

        send_text_message(
            &self.manager,
            &self.api_base_url,
            &self.token,
            &self.peer_id,
            &format_headless_turn_message(&self.runtime_id, &stdout, &stderr),
        )
    }

    fn try_mark_live_event_seen(&self, seq: u64) -> Result<bool, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Failed to lock Weixin channel state".to_string())?;
        if seq <= state.last_event_seq {
            return Ok(false);
        }
        state.last_event_seq = seq;
        Ok(true)
    }

    fn mark_replayed_event_seen(&self, seq: u64) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Failed to lock Weixin channel state".to_string())?;
        if seq > state.last_event_seq {
            state.last_event_seq = seq;
        }
        Ok(())
    }

    fn buffer_live_event_if_initializing(
        &self,
        event: &SessionEventRecord,
    ) -> Result<bool, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Failed to lock Weixin channel state".to_string())?;
        if state.live_ready {
            return Ok(false);
        }
        state.buffered_live_events.push(event.clone());
        Ok(true)
    }

    fn process_event_payload(&self, event: &SessionEventRecord) -> Result<(), String> {
        let mut should_flush = false;
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Failed to lock Weixin channel state".to_string())?;
            match &event.payload {
                SessionEventPayload::AssistantChunk { text } if !text.trim().is_empty() => {
                    state.pending_stdout.push(text.clone());
                    state.saw_stdout_this_turn = true;
                }
                SessionEventPayload::StdErrLine { line } if !line.trim().is_empty() => {
                    state.pending_stderr.push(line.clone());
                    state.saw_stderr_this_turn = true;
                }
                SessionEventPayload::Lifecycle { stage, detail } => {
                    if matches!(
                        stage.as_str(),
                        "stderr_error" | "stdout_error" | "process_failure"
                    ) {
                        state.pending_stderr.push(format!("[{stage}] {detail}"));
                        state.saw_stderr_this_turn = true;
                    }
                }
                SessionEventPayload::PermissionRequired {
                    request_id,
                    tool_name,
                    ..
                } => {
                    self.manager.remember_permission_request(
                        request_id,
                        &self.peer_id,
                        &self.runtime_id,
                    );
                    drop(state);
                    send_text_message(
                        &self.manager,
                        &self.api_base_url,
                        &self.token,
                        &self.peer_id,
                        &format_permission_required_text(tool_name, request_id),
                    )?;
                    return Ok(());
                }
                SessionEventPayload::PermissionResponded {
                    request_id,
                    approved,
                    responder,
                    ..
                } => {
                    self.manager.clear_permission_request(request_id);
                    drop(state);
                    send_text_message(
                        &self.manager,
                        &self.api_base_url,
                        &self.token,
                        &self.peer_id,
                        &format_permission_response_text(request_id, *approved, responder),
                    )?;
                    return Ok(());
                }
                SessionEventPayload::ClaudeJson {
                    message_type,
                    raw_json,
                } if message_type.as_deref() == Some("result") => {
                    let result = parse_headless_result_payload(raw_json);
                    if !state.saw_stdout_this_turn {
                        if let Some(text) = result
                            .as_ref()
                            .and_then(|payload| payload.result_text.as_deref())
                            .filter(|text| !text.trim().is_empty())
                            .filter(|_| !result.as_ref().is_some_and(|payload| payload.is_error))
                        {
                            state.pending_stdout.push(text.to_string());
                        }
                    }
                    if !state.saw_stderr_this_turn {
                        if let Some(text) = result
                            .as_ref()
                            .and_then(|payload| payload.result_text.as_deref())
                            .filter(|text| !text.trim().is_empty())
                            .filter(|_| result.as_ref().is_some_and(|payload| payload.is_error))
                        {
                            state.pending_stderr.push(text.to_string());
                        }
                    }
                    state.saw_stdout_this_turn = false;
                    state.saw_stderr_this_turn = false;
                    should_flush = true;
                }
                SessionEventPayload::SessionCompleted { reason } => {
                    if reason != "completed" && reason != "stopped" {
                        state.pending_stderr.push(reason.clone());
                        state.saw_stderr_this_turn = true;
                    }
                    state.saw_stdout_this_turn = false;
                    state.saw_stderr_this_turn = false;
                    should_flush = true;
                }
                _ => {}
            }
        }

        self.flush_if_due(should_flush)
    }

    pub fn replay_event(&self, event: &SessionEventRecord) -> Result<(), String> {
        self.mark_replayed_event_seen(event.seq)?;
        self.process_event_payload(event)
    }

    pub fn finish_initial_replay(&self) -> Result<(), String> {
        loop {
            let mut buffered = {
                let mut state = self
                    .state
                    .lock()
                    .map_err(|_| "Failed to lock Weixin channel state".to_string())?;
                if state.buffered_live_events.is_empty() {
                    state.live_ready = true;
                    return Ok(());
                }
                std::mem::take(&mut state.buffered_live_events)
            };
            buffered.sort_by_key(|event| event.seq);

            for event in buffered {
                if self.try_mark_live_event_seen(event.seq)? {
                    self.process_event_payload(&event)?;
                }
            }
        }
    }
}

impl OutputChannel for WeixinChannel {
    fn channel_kind(&self) -> ChannelKind {
        ChannelKind::Weixin {
            peer_id: self.peer_id.clone(),
        }
    }

    fn connected_at(&self) -> DateTime<Utc> {
        self.connected_at
    }

    fn label(&self) -> Option<String> {
        Some(format!("Weixin {}", self.peer_id))
    }

    fn send_event(&self, event: &SessionEventRecord) -> Result<(), String> {
        if self.buffer_live_event_if_initializing(event)? {
            return Ok(());
        }
        if !self.try_mark_live_event_seen(event.seq)? {
            return Ok(());
        }
        self.process_event_payload(event)
    }

    fn is_connected(&self) -> bool {
        !self.manager.stop_flag.load(Ordering::SeqCst)
    }
}

fn format_permission_required_text(tool_name: &str, request_id: &str) -> String {
    let tool_name = format_permission_preview(tool_name, 120);
    let request_id = format_permission_preview(request_id, 240);
    format!(
        "Permission required for {tool_name}.\nrequest_id: {request_id}\nReply with 通过 / 拒绝. If multiple requests are pending, use CCEM Desktop."
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event_bus::SessionEventPayload;

    fn test_event(seq: u64, text: &str) -> SessionEventRecord {
        SessionEventRecord {
            runtime_id: "runtime-1".to_string(),
            seq,
            occurred_at: Utc::now(),
            payload: SessionEventPayload::AssistantChunk {
                text: text.to_string(),
            },
        }
    }

    #[test]
    fn initial_replay_drains_buffered_live_events_without_dropping_ordered_tail() {
        let channel = WeixinChannel::new(
            Arc::new(WeixinBridgeManager::default()),
            "token".to_string(),
            "https://ilinkai.weixin.qq.com".to_string(),
            3_000,
            "runtime-1".to_string(),
            "peer-1".to_string(),
        );

        channel
            .send_event(&test_event(2, "second"))
            .expect("buffer live event");
        channel
            .replay_event(&test_event(1, "first"))
            .expect("replay historical event");
        channel.finish_initial_replay().expect("finish replay");

        let state = channel.state.lock().expect("lock channel state");
        assert!(state.live_ready);
        assert!(state.buffered_live_events.is_empty());
        assert_eq!(state.last_event_seq, 2);
        assert_eq!(state.pending_stdout, vec!["first", "second"]);
    }

    #[test]
    fn initial_replay_dedupes_buffered_live_event_when_same_seq_was_replayed() {
        let channel = WeixinChannel::new(
            Arc::new(WeixinBridgeManager::default()),
            "token".to_string(),
            "https://ilinkai.weixin.qq.com".to_string(),
            3_000,
            "runtime-1".to_string(),
            "peer-1".to_string(),
        );

        channel
            .send_event(&test_event(1, "only-once"))
            .expect("buffer live event");
        channel
            .replay_event(&test_event(1, "only-once"))
            .expect("replay historical event");
        channel.finish_initial_replay().expect("finish replay");

        let state = channel.state.lock().expect("lock channel state");
        assert!(state.live_ready);
        assert_eq!(state.last_event_seq, 1);
        assert_eq!(state.pending_stdout, vec!["only-once"]);
    }

    #[test]
    fn permission_messages_expose_only_sanitized_display_copies() {
        let request_id = "req\n\u{e0080}\u{202e}id";
        let tool_name = "Bash\u{17b5}";

        assert_eq!(
            format_permission_required_text(tool_name, request_id),
            "Permission required for Bash\\u{17B5}.\nrequest_id: req\\u{000A}\\u{E0080}\\u{202E}id\nReply with 通过 / 拒绝. If multiple requests are pending, use CCEM Desktop."
        );
        assert_eq!(
            format_permission_response_text(request_id, false, "weixin"),
            "Permission request req\\u{000A}\\u{E0080}\\u{202E}id was denied by weixin."
        );
    }
}
