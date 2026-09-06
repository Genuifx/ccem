//! User-selected, read-only conversation context and explicit handoff.
use crate::{
    event_bus::{NativeEventReplayPage, SessionEventPayload},
    native_runtime::{NativeProvider, NativeRuntimeManager, NativeSessionSummary},
    title_overrides::TitleOverrides,
};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::State;
const MAX_CHARS: usize = 12_000;
const EVENT_LIMIT: u64 = 200;

#[derive(Serialize)]
pub struct WorkspaceSessionReference {
    pub runtime_id: String,
    pub title: String,
    pub provider: String,
    pub can_send: bool,
}
#[derive(Serialize)]
pub struct WorkspaceSessionReferenceContent {
    pub runtime_id: String,
    pub title: String,
    pub text: String,
    pub text_available: bool,
    pub truncated: bool,
}
fn workspace_path(path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err("Workspace must be an absolute directory".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "Workspace directory is unavailable")?;
    if !canonical.is_dir() {
        return Err("Workspace is not a directory".into());
    }
    Ok(canonical)
}
fn validate_scope(summary: &NativeSessionSummary, workspace: &Path) -> Result<(), String> {
    if summary.provider != NativeProvider::Claude
        || workspace_path(&summary.project_dir)? != workspace
    {
        return Err("Session is not a Claude session in this workspace".into());
    }
    Ok(())
}
fn scoped_summary(
    manager: &NativeRuntimeManager,
    workspace: &Path,
    runtime_id: &str,
) -> Result<NativeSessionSummary, String> {
    let mut summary = manager
        .get_session_summary(runtime_id)?
        .ok_or("Session is unavailable")?;
    validate_scope(&summary, workspace)?;
    TitleOverrides::load().apply_native_session_title(&mut summary);
    Ok(summary)
}
fn title(summary: &NativeSessionSummary) -> String {
    summary
        .display_title
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(&summary.runtime_id)
        .chars()
        .take(160)
        .collect()
}
#[tauri::command]
pub fn list_workspace_session_references(
    native_state: State<'_, Arc<NativeRuntimeManager>>,
    working_dir: String,
    current_runtime_id: Option<String>,
) -> Result<Vec<WorkspaceSessionReference>, String> {
    let workspace = workspace_path(&working_dir)?;
    let mut summaries = native_state.list_sessions();
    TitleOverrides::load().apply_native_session_titles(&mut summaries);
    summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(summaries
        .into_iter()
        .filter(|s| {
            Some(s.runtime_id.as_str()) != current_runtime_id.as_deref()
                && validate_scope(s, &workspace).is_ok()
        })
        .map(|s| WorkspaceSessionReference {
            title: title(&s),
            provider: "claude".into(),
            can_send: native_state
                .ensure_session_handoff_target(&s.runtime_id)
                .is_ok(),
            runtime_id: s.runtime_id,
        })
        .collect())
}
fn extract_text(
    page: &NativeEventReplayPage,
    tail_omitted: bool,
) -> Result<(String, bool), String> {
    if !page.source_available {
        return Err("Session history is unavailable".into());
    }
    if page.gap_detected || page.decode_failure_count > 0 || page.oversized_event_count > 0 {
        return Err("Session history is incomplete; reference was not attached".into());
    }
    let mut text = String::new();
    let mut assistant_open = false;
    for event in &page.events {
        match &event.payload {
            SessionEventPayload::UserPrompt { text: value, .. } => {
                if let Some(visible) =
                    crate::user_prompt_display::normalize_user_visible_prompt(value)
                {
                    text.push_str("\nUser: ");
                    text.push_str(&visible);
                    assistant_open = false;
                }
            }
            SessionEventPayload::AssistantChunk { text: value } => {
                if !assistant_open {
                    text.push_str("\nAssistant: ");
                    assistant_open = true;
                }
                text.push_str(value);
            }
            // Do not copy raw provider JSON, reasoning, tools, system or permission events.
            _ => {}
        }
    }
    let count = text.chars().count();
    let truncated = tail_omitted || page.has_more || count > MAX_CHARS;
    if count > MAX_CHARS {
        text = text.chars().skip(count - MAX_CHARS).collect();
    }
    Ok((text, truncated))
}
#[tauri::command]
pub async fn read_workspace_session_reference(
    native_state: State<'_, Arc<NativeRuntimeManager>>,
    working_dir: String,
    runtime_id: String,
) -> Result<WorkspaceSessionReferenceContent, String> {
    let manager = Arc::clone(native_state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = workspace_path(&working_dir)?;
        let summary = scoped_summary(&manager, &workspace, &runtime_id)?;
        let (text, truncated) = read_reference_text(&manager, &runtime_id)?;
        Ok(WorkspaceSessionReferenceContent {
            runtime_id,
            title: title(&summary),
            text_available: !text.trim().is_empty(),
            text,
            truncated,
        })
    })
    .await
    .map_err(|e| format!("Session reference read failed: {e}"))?
}
pub(crate) fn read_reference_text(
    manager: &NativeRuntimeManager,
    runtime_id: &str,
) -> Result<(String, bool), String> {
    // Pin a snapshot, then read only its recent tail with the existing byte-bounded API.
    let head = manager.replay_event_page(runtime_id, None, None, 1)?;
    if !head.source_available {
        return Err("Session history is unavailable".into());
    }
    let newest = head
        .snapshot_newest_seq
        .ok_or("Session history is unavailable")?;
    let after = newest.saturating_sub(EVENT_LIMIT);
    let page = manager.replay_event_page(runtime_id, Some(after), Some(newest), EVENT_LIMIT)?;
    extract_text(&page, after > 0)
}
fn validate_handoff(source: &str, target: &str, text: &str, client_id: &str) -> Result<(), String> {
    if source == target {
        return Err("Choose another session for handoff".into());
    }
    if text.trim().is_empty() || text.chars().count() > MAX_CHARS {
        return Err("Handoff must contain between 1 and 12000 characters".into());
    }
    if client_id.trim().is_empty() || client_id.len() > 200 {
        return Err("A bounded client message ID is required".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn send_workspace_session_handoff(
    app: tauri::AppHandle,
    native_state: State<'_, Arc<NativeRuntimeManager>>,
    environment_mutations: State<'_, Arc<crate::config::EnvironmentMutationCoordinator>>,
    working_dir: String,
    source_runtime_id: String,
    target_runtime_id: String,
    text: String,
    client_message_id: String,
) -> Result<(), String> {
    validate_handoff(
        &source_runtime_id,
        &target_runtime_id,
        &text,
        &client_message_id,
    )?;
    let manager = Arc::clone(native_state.inner());
    let mutations = Arc::clone(environment_mutations.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = mutations.lock()?;
        enqueue_workspace_session_handoff(
            Some(&app),
            &manager,
            &working_dir,
            &source_runtime_id,
            &target_runtime_id,
            &text,
            &client_message_id,
        )
    })
    .await
    .map_err(|e| format!("Session handoff failed: {e}"))?
}

/// Shared host admission for explicit UI sends and the current agent's tool.
/// Callers hold the environment mutation guard; tool callers additionally hold
/// source incarnation and permission authority until the immutable queue write.
pub(crate) fn enqueue_workspace_session_handoff(
    app: Option<&tauri::AppHandle>,
    manager: &Arc<NativeRuntimeManager>,
    working_dir: &str,
    source_runtime_id: &str,
    target_runtime_id: &str,
    text: &str,
    client_message_id: &str,
) -> Result<(), String> {
    validate_handoff(
        source_runtime_id,
        target_runtime_id,
        text,
        client_message_id,
    )?;
    let workspace = workspace_path(working_dir)?;
    let source = scoped_summary(manager, &workspace, source_runtime_id)?;
    scoped_summary(manager, &workspace, target_runtime_id)?;
    manager.ensure_session_handoff_target(target_runtime_id)?;
    let message = format!(
        "[User-directed handoff from session {} ({})]\n{}",
        title(&source),
        source.runtime_id,
        text.trim()
    );
    manager.send_user_message_with_dispatch(
        app,
        target_runtime_id,
        &message,
        Some(&message),
        None,
        None,
        Some(client_message_id),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event_bus::SessionEventRecord;
    fn page(payloads: Vec<SessionEventPayload>) -> NativeEventReplayPage {
        NativeEventReplayPage {
            source_available: true,
            gap_detected: false,
            decode_failure_count: 0,
            oversized_event_count: 0,
            oldest_available_seq: Some(1),
            snapshot_newest_seq: Some(payloads.len() as u64),
            next_cursor: None,
            has_more: false,
            events: payloads
                .into_iter()
                .enumerate()
                .map(|(i, payload)| SessionEventRecord {
                    runtime_id: "fixture".into(),
                    seq: i as u64 + 1,
                    occurred_at: chrono::Utc::now(),
                    payload,
                })
                .collect(),
        }
    }
    #[test]
    fn reference_excludes_raw_and_system_content() {
        let p = page(vec![
            SessionEventPayload::SystemMessage {
                message: "private".into(),
            },
            SessionEventPayload::ClaudeJson {
                message_type: None,
                raw_json: "secret reasoning".into(),
            },
            SessionEventPayload::AssistantChunk {
                text: "visible".into(),
            },
        ]);
        assert_eq!(
            extract_text(&p, false).unwrap(),
            ("\nAssistant: visible".into(), false)
        );
    }
    #[test]
    fn reference_strips_legacy_hidden_prompt_wrappers() {
        let prompt: SessionEventPayload = serde_json::from_value(serde_json::json!({
            "type": "user_prompt", "text": "<selected_skills>hidden</selected_skills><user_request>visible</user_request>",
            "image_count": 0
        })).unwrap();
        assert_eq!(
            extract_text(&page(vec![prompt]), false).unwrap().0,
            "\nUser: visible"
        );
    }
    #[test]
    fn incomplete_and_unavailable_history_fail_closed() {
        let mut p = page(vec![SessionEventPayload::AssistantChunk {
            text: "visible".into(),
        }]);
        p.source_available = false;
        assert!(extract_text(&p, false).is_err());
        p.source_available = true;
        p.gap_detected = true;
        assert!(extract_text(&p, false).is_err());
        p.gap_detected = false;
        p.decode_failure_count = 1;
        assert!(extract_text(&p, false).is_err());
        p.decode_failure_count = 0;
        p.oversized_event_count = 1;
        assert!(extract_text(&p, false).is_err());
        assert_eq!(extract_text(&page(vec![]), false).unwrap(), (String::new(), false));
        let hidden_tail = page(vec![SessionEventPayload::SystemMessage {
            message: "hidden".into(),
        }]);
        assert_eq!(extract_text(&hidden_tail, true).unwrap(), (String::new(), true));
    }
    #[test]
    fn unicode_tail_is_bounded_and_marked() {
        let p = page(vec![SessionEventPayload::AssistantChunk {
            text: "中".repeat(MAX_CHARS + 1),
        }]);
        let (text, truncated) = extract_text(&p, false).unwrap();
        assert_eq!(text.chars().count(), MAX_CHARS);
        assert!(truncated);
    }
    #[test]
    fn handoff_rejects_self_empty_oversize_and_missing_identity() {
        assert!(validate_handoff("a", "a", "x", "id").is_err());
        assert!(validate_handoff("a", "b", " ", "id").is_err());
        assert!(validate_handoff("a", "b", &"x".repeat(MAX_CHARS + 1), "id").is_err());
        assert!(validate_handoff("a", "b", "x", "").is_err());
        assert!(validate_handoff("a", "b", "x", "id").is_ok());
    }
    #[test]
    fn different_workspace_and_provider_are_rejected() {
        let workspace = std::env::current_dir().unwrap().canonicalize().unwrap();
        let mut summary: NativeSessionSummary = serde_json::from_value(serde_json::json!({
            "runtime_id":"fixture", "provider":"claude", "transport":"native_sdk",
            "project_dir": workspace.to_str().unwrap(), "env_name":"fixture", "perm_mode":"dev",
            "status":"idle", "created_at": "2026-01-01T00:00:00Z", "updated_at":"2026-01-01T00:00:00Z",
            "is_active":true, "can_handoff_to_terminal":false
        })).unwrap();
        assert!(validate_scope(&summary, &workspace).is_ok());
        assert!(validate_scope(&summary, workspace.parent().unwrap()).is_err());
        summary.provider = NativeProvider::Codex;
        assert!(validate_scope(&summary, &workspace).is_err());
    }
    #[test]
    fn workspace_requires_existing_absolute_directory() {
        assert!(workspace_path(".").is_err());
        assert!(workspace_path("/nonexistent-ccem-reference-fixture").is_err());
    }
}
