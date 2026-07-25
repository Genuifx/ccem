use super::{bot_binding_route_id, BotBindingInfo, BotBindingOutboxFrameKind};
use crate::event_bus::{
    InteractiveToolPrompt, SessionEventPayload, SessionEventRecord, ToolCategory,
};
use crate::permission_preview::format_permission_preview;

pub(super) struct EventSummary {
    pub(super) kind: BotBindingOutboxFrameKind,
    pub(super) title: String,
    pub(super) text: String,
}

pub(super) fn summarize_session_event(event: &SessionEventRecord) -> Option<EventSummary> {
    summarize_payload(&event.payload)
}

pub(super) fn summarize_payload(payload: &SessionEventPayload) -> Option<EventSummary> {
    match payload {
        SessionEventPayload::UserPrompt { text, .. } => Some(EventSummary {
            kind: BotBindingOutboxFrameKind::EventUpdate,
            title: "User prompt".to_string(),
            text: truncate_text(text, 1200),
        }),
        SessionEventPayload::SystemMessage { message } => Some(EventSummary {
            kind: BotBindingOutboxFrameKind::EventUpdate,
            title: "System message".to_string(),
            text: truncate_text(message, 1200),
        }),
        SessionEventPayload::Lifecycle { stage, detail } => Some(EventSummary {
            kind: BotBindingOutboxFrameKind::EventUpdate,
            title: format!("Lifecycle · {stage}"),
            text: truncate_text(detail, 1200),
        }),
        SessionEventPayload::StdErrLine { line } if !line.trim().is_empty() => Some(EventSummary {
            kind: BotBindingOutboxFrameKind::Error,
            title: "stderr".to_string(),
            text: truncate_text(line, 1200),
        }),
        SessionEventPayload::AssistantChunk { text } if !text.trim().is_empty() => {
            Some(EventSummary {
                kind: BotBindingOutboxFrameKind::EventUpdate,
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
            kind: BotBindingOutboxFrameKind::EventUpdate,
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
                BotBindingOutboxFrameKind::EventUpdate
            } else {
                BotBindingOutboxFrameKind::Error
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
            kind: BotBindingOutboxFrameKind::PermissionPrompt,
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
            kind: BotBindingOutboxFrameKind::EventUpdate,
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
            kind: BotBindingOutboxFrameKind::EventUpdate,
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
            kind: BotBindingOutboxFrameKind::EventUpdate,
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
            kind: BotBindingOutboxFrameKind::Error,
            title: "File rewind failed".to_string(),
            text: truncate_text(
                &format!("checkpoint_id: {checkpoint_id}\nerror: {error}"),
                1200,
            ),
        }),
        SessionEventPayload::SessionCompleted { reason } => Some(EventSummary {
            kind: BotBindingOutboxFrameKind::SessionCompleted,
            title: "Session completed".to_string(),
            text: truncate_text(reason, 1200),
        }),
        SessionEventPayload::TerminalPromptRequired { prompt_text, .. } => Some(EventSummary {
            kind: BotBindingOutboxFrameKind::PermissionPrompt,
            title: "Terminal prompt required".to_string(),
            text: truncate_text(prompt_text, 1200),
        }),
        SessionEventPayload::TerminalPromptResolved { approved, .. } => Some(EventSummary {
            kind: BotBindingOutboxFrameKind::EventUpdate,
            title: "Terminal prompt resolved".to_string(),
            text: format!("approved: {approved}"),
        }),
        SessionEventPayload::TokenUsage {
            input_tokens,
            output_tokens,
            total_cost_usd,
            ..
        } => Some(EventSummary {
            kind: BotBindingOutboxFrameKind::EventUpdate,
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
            kind: BotBindingOutboxFrameKind::EventUpdate,
            title: "Context usage".to_string(),
            text: format!("{model}: {used_tokens}/{max_tokens} ({percentage:.1}%)"),
        }),
        SessionEventPayload::ClaudeJson { .. } | SessionEventPayload::GapNotification { .. } => {
            None
        }
        SessionEventPayload::StdErrLine { .. }
        | SessionEventPayload::AssistantChunk { .. } => None,
    }
}

pub(super) fn format_task_card(info: &BotBindingInfo) -> String {
    let summary = info
        .task_summary
        .as_deref()
        .unwrap_or("No summary provided.");
    let route_id = bot_binding_route_id(info);
    let project = info
        .project_label
        .as_deref()
        .map(|label| format!("\nproject: {label}"))
        .unwrap_or_default();
    format!(
        "title: {}\nid: {}{}\nplatform: {}\nsummary: {}",
        info.task_title,
        route_id,
        project,
        info.platform.display_name(),
        summary
    )
}

pub(super) fn format_inbound_prompt(
    info: &BotBindingInfo,
    text: &str,
    quoted_task_id: Option<&str>,
) -> String {
    let quoted = quoted_task_id.unwrap_or(&info.task_id);
    let route_id = bot_binding_route_id(info);
    format!(
        "[ccem bot-bound command]\nplatform: {}\npeer_id: {}\nruntime_id: {}\ntask_id: {}\nroute_id: {}\nquoted_task_id: {}\ncorrelation_marker: {}\n\n{}",
        info.platform.display_name(),
        info.peer_id,
        info.runtime_id,
        info.task_id,
        route_id,
        quoted,
        info.correlation_marker,
        text
    )
}

pub(super) fn truncate_text(text: &str, max_chars: usize) -> String {
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
