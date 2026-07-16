use super::{truncate_utf8, WecomBridgeManager, WecomConnection};
use crate::channel::{ChannelKind, OutputChannel};
use crate::event_bus::{SessionEventPayload, SessionEventRecord};
use crate::permission_preview::format_permission_preview;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const STREAM_FLUSH_INTERVAL: Duration = Duration::from_millis(2500);
const STREAM_TEXT_LIMIT: usize = 18_000;

#[derive(Default)]
struct WecomChannelState {
    last_event_seq: u64,
    last_flush_at: Option<Instant>,
    content: String,
    stderr: Vec<String>,
    finished: bool,
    replaying: bool,
}

pub struct WecomChannel {
    manager: Arc<WecomBridgeManager>,
    connection: Arc<WecomConnection>,
    runtime_id: String,
    bot_id: String,
    peer_id: String,
    req_id: String,
    stream_id: String,
    connected_at: DateTime<Utc>,
    state: Mutex<WecomChannelState>,
}

impl WecomChannel {
    pub fn new(
        manager: Arc<WecomBridgeManager>,
        connection: Arc<WecomConnection>,
        runtime_id: String,
        bot_id: String,
        peer_id: String,
        req_id: String,
        stream_id: String,
    ) -> Self {
        Self {
            manager,
            connection,
            runtime_id,
            bot_id,
            peer_id,
            req_id,
            stream_id,
            connected_at: Utc::now(),
            state: Mutex::new(WecomChannelState {
                replaying: true,
                ..WecomChannelState::default()
            }),
        }
    }

    pub fn finish_initial_replay(&self) -> Result<(), String> {
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Failed to lock WeCom channel state".to_string())?;
            state.replaying = false;
        }
        self.flush(true)
    }

    pub fn replay_event(&self, event: &SessionEventRecord) -> Result<(), String> {
        self.ingest_event(event, true)
    }

    fn ingest_event(&self, event: &SessionEventRecord, replay: bool) -> Result<(), String> {
        let mut force_flush = false;
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Failed to lock WeCom channel state".to_string())?;
            if !replay && event.seq <= state.last_event_seq {
                return Ok(());
            }
            state.last_event_seq = event.seq;

            match &event.payload {
                SessionEventPayload::AssistantChunk { text } if !text.trim().is_empty() => {
                    state.content.push_str(text);
                }
                SessionEventPayload::StdErrLine { line } if !line.trim().is_empty() => {
                    state.stderr.push(line.clone());
                }
                SessionEventPayload::ClaudeJson {
                    message_type,
                    raw_json,
                } if message_type.as_deref() == Some("result") => {
                    if state.content.trim().is_empty() {
                        if let Some(text) = parse_result_text(raw_json) {
                            state.content.push_str(&text);
                        }
                    }
                    force_flush = true;
                }
                SessionEventPayload::PermissionRequired {
                    request_id,
                    tool_name,
                    ..
                } => {
                    state
                        .content
                        .push_str(&format_permission_required_text(tool_name, request_id));
                    force_flush = true;
                }
                SessionEventPayload::SessionCompleted { reason } => {
                    if reason != "completed" && reason != "stopped" {
                        state.stderr.push(reason.clone());
                    }
                    state.finished = true;
                    force_flush = true;
                }
                SessionEventPayload::Lifecycle { stage, detail }
                    if matches!(stage.as_str(), "process_failure" | "stderr_error") =>
                {
                    state.stderr.push(detail.clone());
                    force_flush = true;
                }
                _ => {}
            }
        }
        self.flush(force_flush)
    }

    fn flush(&self, force: bool) -> Result<(), String> {
        let (content, finished) = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Failed to lock WeCom channel state".to_string())?;
            if state.replaying || (state.content.is_empty() && state.stderr.is_empty()) {
                return Ok(());
            }
            if !force
                && state
                    .last_flush_at
                    .is_some_and(|last| last.elapsed() < STREAM_FLUSH_INTERVAL)
            {
                return Ok(());
            }
            state.last_flush_at = Some(Instant::now());
            let mut content = state.content.clone();
            if !state.stderr.is_empty() {
                content.push_str("\n\n---\n");
                content.push_str(&state.stderr.join("\n"));
            }
            (truncate_utf8(&content, STREAM_TEXT_LIMIT), state.finished)
        };

        self.connection
            .send_stream(&self.req_id, &self.stream_id, &content, finished)?;
        if finished {
            self.manager.clear_runtime_for_scope_if_matches(
                &self.bot_id,
                &self.peer_id,
                &self.runtime_id,
            );
        }
        Ok(())
    }
}

impl OutputChannel for WecomChannel {
    fn channel_kind(&self) -> ChannelKind {
        ChannelKind::Wecom {
            bot_id: self.bot_id.clone(),
            peer_id: self.peer_id.clone(),
        }
    }

    fn connected_at(&self) -> DateTime<Utc> {
        self.connected_at
    }

    fn label(&self) -> Option<String> {
        Some("WeCom".to_string())
    }

    fn send_event(&self, event: &SessionEventRecord) -> Result<(), String> {
        self.ingest_event(event, false)
    }

    fn is_connected(&self) -> bool {
        self.connection.is_connected()
    }
}

#[derive(Deserialize)]
struct ClaudeResultPayload {
    #[serde(default)]
    result: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

fn parse_result_text(raw_json: &str) -> Option<String> {
    serde_json::from_str::<ClaudeResultPayload>(raw_json)
        .ok()
        .and_then(|payload| payload.result.or(payload.error))
        .filter(|text| !text.trim().is_empty())
}

fn format_permission_required_text(tool_name: &str, request_id: &str) -> String {
    let tool_name = format_permission_preview(tool_name, 120);
    let request_id = format_permission_preview(request_id, 240);
    format!(
        "\n\nPermission required: `{tool_name}` ({request_id}). Open CCEM Desktop to approve or deny this request."
    )
}

#[cfg(test)]
mod tests {
    use super::format_permission_required_text;

    #[test]
    fn permission_message_exposes_only_sanitized_display_copies() {
        assert_eq!(
            format_permission_required_text("Bash\u{180f}", "req\n\u{2065}\u{202e}id"),
            "\n\nPermission required: `Bash\\u{180F}` (req\\u{000A}\\u{2065}\\u{202E}id). Open CCEM Desktop to approve or deny this request."
        );
    }
}
