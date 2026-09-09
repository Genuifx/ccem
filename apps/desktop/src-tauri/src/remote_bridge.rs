//! Channel-independent remote event projection. Legacy bindings and Hermes use the same contract.
use crate::event_bus::{
    InteractiveToolPrompt, SessionEventPayload, SessionEventRecord, ToolCategory,
};
use crate::permission_preview::format_permission_preview;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteEventKind {
    TaskCard,
    EventUpdate,
    InteractiveOutput,
    InboundCommand,
    PermissionPrompt,
    SessionCompleted,
    Error,
}

#[derive(Debug, Serialize)]
pub struct RemoteEvent {
    pub version: u8,
    pub event_id: String,
    pub runtime_id: String,
    pub seq: u64,
    pub occurred_at: chrono::DateTime<chrono::Utc>,
    pub kind: RemoteEventKind,
    pub title: String,
    pub text: String,
}

/// The cursor follows raw records, including events omitted from chat projection.
/// This prevents telemetry-only pages from trapping a subscriber in a replay loop.
pub fn project_batch(
    batch: crate::event_bus::NativeEventReplayPage,
    since: Option<u64>,
) -> serde_json::Value {
    let cursor = batch.next_cursor.or(since);
    let events: Vec<_> = batch.events.iter().filter_map(project_event).collect();
    serde_json::json!({
        "version": 1,
        "sourceAvailable": batch.source_available,
        "gapDetected": batch.gap_detected,
        "decodeFailureCount": batch.decode_failure_count,
        "oversizedEventCount": batch.oversized_event_count,
        "hasMore": batch.has_more,
        "nextCursor": cursor,
        "events": events,
    })
}

pub fn project_event(event: &SessionEventRecord) -> Option<RemoteEvent> {
    let summary = summarize_session_event(event)?;
    Some(RemoteEvent {
        version: 1,
        event_id: format!("{}:{}", event.runtime_id, event.seq),
        runtime_id: event.runtime_id.clone(),
        seq: event.seq,
        occurred_at: event.occurred_at,
        kind: summary.kind,
        title: summary.title,
        text: summary.text,
    })
}

pub(crate) struct EventSummary {
    pub(crate) kind: RemoteEventKind,
    pub(crate) title: String,
    pub(crate) text: String,
}

pub(crate) fn summarize_session_event(event: &SessionEventRecord) -> Option<EventSummary> {
    summarize_payload(&event.payload)
}

pub(crate) fn summarize_payload(payload: &SessionEventPayload) -> Option<EventSummary> {
    match payload {
        SessionEventPayload::UserPrompt { text, .. } => Some(EventSummary {
            kind: RemoteEventKind::EventUpdate,
            title: "User prompt".to_string(),
            text: truncate_text(text, 1200),
        }),
        SessionEventPayload::SystemMessage { message } => Some(EventSummary {
            kind: RemoteEventKind::EventUpdate,
            title: "System message".to_string(),
            text: truncate_text(message, 1200),
        }),
        SessionEventPayload::Lifecycle { stage, detail, .. } => Some(EventSummary {
            kind: RemoteEventKind::EventUpdate,
            title: format!("Lifecycle · {stage}"),
            text: truncate_text(detail, 1200),
        }),
        // Router request ledger entries — telemetry-grade, not for bot chat.
        SessionEventPayload::RoutedRequest { .. } => None,
        SessionEventPayload::StdErrLine { line } if !line.trim().is_empty() => Some(EventSummary {
            kind: RemoteEventKind::Error,
            title: "stderr".to_string(),
            text: truncate_text(line, 1200),
        }),
        SessionEventPayload::AssistantChunk { text } if !text.trim().is_empty() => {
            Some(EventSummary {
                kind: RemoteEventKind::EventUpdate,
                title: "Assistant update".to_string(),
                text: truncate_text(text, 1600),
            })
        }
        SessionEventPayload::ToolUseStarted {
            raw_name,
            input_summary,
            category,
            prompt,
            ..
        } => Some(EventSummary {
            kind: RemoteEventKind::EventUpdate,
            title: format!(
                "Tool started · {}",
                tool_display_name(raw_name, category, prompt.as_ref())
            ),
            text: truncate_text(
                &format_tool_started_text(input_summary, category, prompt.as_ref()),
                1200,
            ),
        }),
        SessionEventPayload::ToolUseCompleted {
            raw_name,
            result_summary,
            success,
            ..
        } => Some(EventSummary {
            kind: if *success {
                RemoteEventKind::EventUpdate
            } else {
                RemoteEventKind::Error
            },
            title: format!(
                "Tool completed · {}",
                if is_subagent_tool(
                    raw_name,
                    &ToolCategory::Unknown {
                        raw_name: raw_name.to_string()
                    }
                ) {
                    "Subagent"
                } else {
                    raw_name
                }
            ),
            text: truncate_text(result_summary, 1200),
        }),
        SessionEventPayload::PermissionRequired {
            request_id,
            tool_name,
            input_summary,
            ..
        } => Some(EventSummary {
            kind: RemoteEventKind::PermissionPrompt,
            title: format!(
                "Permission required · {}",
                format_permission_preview(tool_name, 120)
            ),
            text: {
                let request_id = format_permission_preview(request_id, 240);
                let prefix = format!("request_id: {request_id}\n");
                let remaining = 1200usize.saturating_sub(prefix.chars().count());
                format!(
                    "{prefix}{}",
                    format_permission_preview(input_summary.as_deref().unwrap_or(""), remaining)
                )
            },
        }),
        SessionEventPayload::PermissionResponded {
            request_id,
            approved,
            responder,
            ..
        } => Some(EventSummary {
            kind: RemoteEventKind::EventUpdate,
            title: "Permission responded".to_string(),
            text: format!(
                "request_id: {}\napproved: {approved}\nresponder: {}",
                format_permission_preview(request_id, 240),
                format_permission_preview(responder, 120)
            ),
        }),
        SessionEventPayload::CheckpointCreated {
            checkpoint_id,
            prompt_summary,
            ..
        } => Some(EventSummary {
            kind: RemoteEventKind::EventUpdate,
            title: "File checkpoint".to_string(),
            text: truncate_text(
                &format!(
                    "checkpoint_id: {}\nprompt: {}",
                    checkpoint_id,
                    prompt_summary.as_deref().unwrap_or("n/a")
                ),
                1200,
            ),
        }),
        SessionEventPayload::FilesRewound {
            checkpoint_id,
            files_changed,
            ..
        } => Some(EventSummary {
            kind: RemoteEventKind::EventUpdate,
            title: "Files rewound".to_string(),
            text: truncate_text(
                &format!(
                    "checkpoint_id: {}\nfiles_changed: {}",
                    checkpoint_id,
                    files_changed.len()
                ),
                1200,
            ),
        }),
        SessionEventPayload::FileRewindFailed {
            checkpoint_id,
            error,
            ..
        } => Some(EventSummary {
            kind: RemoteEventKind::Error,
            title: "File rewind failed".to_string(),
            text: truncate_text(
                &format!("checkpoint_id: {checkpoint_id}\nerror: {error}"),
                1200,
            ),
        }),
        SessionEventPayload::SessionCompleted { reason } => Some(EventSummary {
            kind: RemoteEventKind::SessionCompleted,
            title: "Session completed".to_string(),
            text: truncate_text(reason, 1200),
        }),
        SessionEventPayload::TerminalPromptRequired { prompt_text, .. } => Some(EventSummary {
            kind: RemoteEventKind::PermissionPrompt,
            title: "Terminal prompt required".to_string(),
            text: truncate_text(prompt_text, 1200),
        }),
        SessionEventPayload::TerminalPromptResolved { approved, .. } => Some(EventSummary {
            kind: RemoteEventKind::EventUpdate,
            title: "Terminal prompt resolved".to_string(),
            text: format!("approved: {approved}"),
        }),
        SessionEventPayload::TokenUsage {
            input_tokens,
            output_tokens,
            total_cost_usd,
            ..
        } => Some(EventSummary {
            kind: RemoteEventKind::EventUpdate,
            title: "Token usage".to_string(),
            text: format!(
                "input: {input_tokens}\noutput: {output_tokens}\ncost_usd: {}",
                total_cost_usd
                    .map(|cost| format!("{cost:.6}"))
                    .unwrap_or_else(|| "n/a".to_string())
            ),
        }),
        SessionEventPayload::ContextUsage {
            used_tokens,
            max_tokens,
            percentage,
            model,
            ..
        } => Some(EventSummary {
            kind: RemoteEventKind::EventUpdate,
            title: "Context usage".to_string(),
            text: format!("{model}: {used_tokens}/{max_tokens} ({percentage:.1}%)"),
        }),
        SessionEventPayload::ClaudeJson { .. } | SessionEventPayload::GapNotification { .. } => {
            None
        }
        // Session usage snapshots duplicate the token_usage frames already
        // forwarded per turn — don't spam bot outboxes with them. Interactive
        // receipts are consumed by the desktop attention layer (Slice C).
        SessionEventPayload::SessionUsage { .. }
        | SessionEventPayload::RuntimeSettingsChanged { .. }
        | SessionEventPayload::InteractiveResponseResult { .. }
        | SessionEventPayload::BackgroundTasksChanged { .. }
        | SessionEventPayload::BackgroundTaskUpdated { .. }
        | SessionEventPayload::StdErrLine { .. }
        | SessionEventPayload::AssistantChunk { .. } => None,
    }
}

pub(crate) fn truncate_text(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut truncated = text.chars().take(max_chars).collect::<String>();
    truncated.push_str("...");
    truncated
}

fn tool_display_name(
    raw_name: &str,
    category: &ToolCategory,
    prompt: Option<&InteractiveToolPrompt>,
) -> String {
    match prompt {
        Some(InteractiveToolPrompt::PlanEntry) => "Plan".to_string(),
        Some(InteractiveToolPrompt::PlanExit { .. }) => "Plan review".to_string(),
        Some(InteractiveToolPrompt::AskUserQuestion { .. }) => "Question".to_string(),
        None => {
            if is_subagent_tool(raw_name, category) {
                "Subagent".to_string()
            } else {
                raw_name.to_string()
            }
        }
    }
}

fn format_tool_started_text(
    input_summary: &str,
    category: &ToolCategory,
    prompt: Option<&InteractiveToolPrompt>,
) -> String {
    match prompt {
        Some(InteractiveToolPrompt::PlanEntry) => "进入计划模式".to_string(),
        Some(InteractiveToolPrompt::PlanExit { plan_summary, .. }) => plan_summary
            .as_deref()
            .filter(|summary| !summary.trim().is_empty())
            .unwrap_or(input_summary)
            .to_string(),
        Some(InteractiveToolPrompt::AskUserQuestion { questions }) => questions
            .first()
            .map(|question| question.question.clone())
            .filter(|question| !question.trim().is_empty())
            .unwrap_or_else(|| input_summary.to_string()),
        None if is_subagent_tool("", category) => input_summary.to_string(),
        None => input_summary.to_string(),
    }
}

fn is_subagent_tool(raw_name: &str, category: &ToolCategory) -> bool {
    raw_name == "Agent"
        || raw_name == "Task"
        || matches!(
            category,
            ToolCategory::TaskMgmt { raw_name } if raw_name == "Agent" || raw_name == "Task"
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event_bus::NativeEventReplayPage;

    fn event(seq: u64, payload: SessionEventPayload) -> SessionEventRecord {
        SessionEventRecord {
            runtime_id: "runtime-test".into(),
            seq,
            occurred_at: chrono::Utc::now(),
            payload,
        }
    }

    #[test]
    fn projection_has_stable_identity_and_preserves_completion() {
        let record = event(
            7,
            SessionEventPayload::SessionCompleted {
                reason: "completed".into(),
            },
        );
        let projected = project_event(&record).unwrap();
        assert_eq!(projected.event_id, "runtime-test:7");
        assert_eq!(projected.kind, RemoteEventKind::SessionCompleted);
        assert_eq!(projected.text, "completed");
        assert_eq!(projected.occurred_at, record.occurred_at);
        assert_eq!(serde_json::to_value(projected).unwrap()["version"], 1);
    }

    #[test]
    fn filtered_records_advance_cursor_without_hiding_integrity_errors() {
        let batch = NativeEventReplayPage {
            source_available: true,
            gap_detected: true,
            has_more: true,
            decode_failure_count: 1,
            oversized_event_count: 2,
            oldest_available_seq: Some(1),
            snapshot_newest_seq: Some(20),
            next_cursor: Some(9),
            events: vec![
                event(
                    8,
                    SessionEventPayload::AssistantChunk {
                        text: "answer".into(),
                    },
                ),
                event(9, SessionEventPayload::AssistantChunk { text: "".into() }),
            ],
        };
        let value = project_batch(batch, Some(0));
        assert_eq!(value["nextCursor"], 9);
        assert_eq!(value["events"].as_array().unwrap().len(), 1);
        assert_eq!(value["gapDetected"], true);
        assert_eq!(value["hasMore"], true);
        assert_eq!(value["decodeFailureCount"], 1);
        assert_eq!(value["oversizedEventCount"], 2);
    }
}
