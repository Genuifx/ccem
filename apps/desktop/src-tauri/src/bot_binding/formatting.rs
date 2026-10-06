use super::{bot_binding_route_id, BotBindingInfo};
pub(super) use crate::remote_bridge::{summarize_session_event, truncate_text};
#[cfg(test)]
pub(super) use crate::remote_bridge::summarize_payload;

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
