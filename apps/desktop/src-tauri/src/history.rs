// apps/desktop/src-tauri/src/history.rs
//
// Conversation history support for both Claude and Codex sources.

use crate::{dsh_history, opencode, runtime, session_provenance};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const SOURCE_CLAUDE: &str = "claude";
const SOURCE_CODEX: &str = "codex";
const SOURCE_OPENCODE: &str = "opencode";
const SOURCE_DSH: &str = "dsh";
const HISTORY_NEAR_DUPLICATE_WINDOW_MS: u64 = 1_500;
const HISTORY_LIMIT_MAX: usize = 1_000;
const HISTORY_SCAN_LIMIT_MULTIPLIER: usize = 2;

// ============================================================================
// Output types — sent to frontend (camelCase for TypeScript)
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HistorySession {
    pub id: String,
    pub source: String,
    pub display: String,
    pub timestamp: u64,
    pub project: String,
    pub project_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_stage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_sticker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_label: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProjectNode {
    pub project: String,
    pub project_name: String,
    pub session_keys: Vec<String>,
    pub latest_timestamp: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOverviewSnapshot {
    pub sessions: Vec<HistorySession>,
    pub project_nodes: Vec<WorkspaceProjectNode>,
    pub total_sessions: usize,
    pub total_projects: usize,
}

struct WorkspaceProjectNodeDraft {
    project: String,
    project_name: String,
    session_refs: Vec<WorkspaceProjectSessionRef>,
    latest_timestamp: u64,
}

struct WorkspaceProjectSessionRef {
    session_key: String,
    timestamp: u64,
    source: String,
    id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMessage {
    pub msg_type: String,
    pub uuid: Option<String>,
    pub content: serde_json::Value,
    pub model: Option<String>,
    pub summary: Option<String>,
    pub plan_content: Option<String>,
    pub timestamp: u64,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_creation_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub segment_index: usize,
    pub is_compact_boundary: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CompactSegment {
    pub segment_index: usize,
    pub timestamp: u64,
    pub trigger: Option<String>,
    pub pre_tokens: Option<u64>,
    pub message_count: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConversationDetailPayload {
    pub messages: Vec<ConversationMessage>,
    pub segments: Vec<CompactSegment>,
    pub tool_results_merged: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// Metadata for a single Claude Code sub-agent (Task/Agent sidechain).
///
/// Sub-agent conversations live in their own JSONL files at
/// `<project-dir>/<session_id>/subagents/agent-<agentId>.jsonl`, separate from the
/// main session transcript. Claude also writes a sibling
/// `agent-<agentId>.meta.json` sidecar for stable display metadata. This struct
/// is the list entry shown in the review drawer's "子 Agent" panel.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SubagentMeta {
    pub agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// `running` | `completed` | `failed`
    pub status: String,
    pub message_count: usize,
    pub tool_count: usize,
    pub started_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_summary: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionSubagentsPayload {
    pub subagents: Vec<SubagentMeta>,
    /// Full message transcript for the requested `detail_agent_id`, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<Vec<ConversationMessage>>,
}

fn normalize_history_limit(limit: Option<usize>) -> Option<usize> {
    limit.and_then(|value| {
        if value == 0 {
            None
        } else {
            Some(value.min(HISTORY_LIMIT_MAX))
        }
    })
}

fn history_scan_limit(limit: usize) -> usize {
    limit
        .saturating_mul(HISTORY_SCAN_LIMIT_MULTIPLIER)
        .max(limit)
}

// ============================================================================
// Claude JSONL line types
// ============================================================================

#[derive(Debug, Deserialize)]
struct HistoryLine {
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    display: Option<String>,
    timestamp: Option<serde_json::Value>,
    project: Option<String>,
    #[serde(rename = "projectName")]
    project_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MessageLine {
    #[serde(rename = "type")]
    msg_type: Option<String>,
    subtype: Option<String>,
    uuid: Option<String>,
    #[serde(rename = "parentUuid")]
    parent_uuid: Option<serde_json::Value>,
    message: Option<serde_json::Value>,
    summary: Option<String>,
    content: Option<String>,
    #[serde(rename = "compactMetadata")]
    compact_metadata: Option<serde_json::Value>,
    #[serde(rename = "isCompactSummary")]
    is_compact_summary: Option<bool>,
    #[serde(rename = "isMeta")]
    is_meta: Option<bool>,
    timestamp: Option<serde_json::Value>,
    #[serde(rename = "planContent")]
    plan_content: Option<String>,
}

// ============================================================================
// Codex JSONL line types
// ============================================================================

#[derive(Debug, Deserialize)]
struct CodexHistoryLine {
    session_id: Option<String>,
    ts: Option<serde_json::Value>,
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CodexLine {
    #[serde(rename = "type")]
    line_type: Option<String>,
    timestamp: Option<serde_json::Value>,
    payload: Option<serde_json::Value>,
}

#[derive(Debug, Default, Clone)]
struct CodexSessionMeta {
    cwd: Option<String>,
    subagent_parent_thread_id: Option<String>,
}

#[derive(Debug, Clone)]
struct CodexPathConfig {
    home_dir: PathBuf,
    codex_home: PathBuf,
    history_path: PathBuf,
    sessions_root: PathBuf,
    session_index_path: PathBuf,
    sqlite_home: PathBuf,
}

#[derive(Debug, Clone)]
struct CodexSessionFileInfo {
    rollout_path: PathBuf,
    cwd: Option<String>,
    modified_at: u64,
}

#[derive(Debug, Default)]
struct CodexSessionFileCollection {
    files: Vec<(String, CodexSessionFileInfo)>,
    subagent_parent_by_id: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct CodexSessionIndexLine {
    id: Option<String>,
    thread_name: Option<String>,
    updated_at: Option<String>,
}

#[derive(Debug, Clone)]
struct CodexThreadRecord {
    id: String,
    rollout_path: Option<PathBuf>,
    created_at: u64,
    updated_at: u64,
    cwd: Option<String>,
    title: Option<String>,
}

#[derive(Debug, Default, Clone)]
struct CodexSessionRecord {
    id: String,
    display: String,
    display_priority: u8,
    display_timestamp: u64,
    timestamp: u64,
    project: String,
    project_priority: u8,
    project_timestamp: u64,
    rollout_path: Option<PathBuf>,
    rollout_priority: u8,
    rollout_timestamp: u64,
}

const CODEX_TITLE_PRIORITY_HISTORY: u8 = 1;
const CODEX_TITLE_PRIORITY_SQLITE: u8 = 2;
const CODEX_TITLE_PRIORITY_SESSION_INDEX: u8 = 3;
const CODEX_PROJECT_PRIORITY_SESSION_META: u8 = 1;
const CODEX_PROJECT_PRIORITY_SQLITE: u8 = 2;
const CODEX_ROLLOUT_PRIORITY_SESSION_SCAN: u8 = 1;
const CODEX_ROLLOUT_PRIORITY_SQLITE: u8 = 2;

async fn run_blocking<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("Blocking history task failed: {error}"))?
}

// ============================================================================
// Tauri commands
// ============================================================================

/// Read conversation history from Claude/Codex/DSH and return a merged list with diagnostics.
#[tauri::command]
pub async fn get_conversation_history(
    app: tauri::AppHandle,
    source: Option<String>,
    limit: Option<usize>,
) -> Result<HistoryListResult, HistoryCommandError> {
    let source_filter = normalize_history_source(source.as_deref())
        .map_err(|e| HistoryCommandError { code: "invalid_source".to_string(), message: e })?;
    let lim = normalize_history_limit(limit);

    // Legacy sources (sync)
    let legacy_sessions = run_blocking({
        let source_filter = source_filter;
        let lim = lim;
        move || load_legacy_history_sessions_filtered(source_filter, lim)
    }).await
    .map_err(|e| HistoryCommandError { code: "legacy_error".to_string(), message: e })?;

    // DSH (async via helper)
    let dsh_result = if source_filter == Some(SOURCE_DSH) || source_filter.is_none() {
        Some(load_dsh_history_sessions_async(&app).await)
    } else {
        None
    };

    orchestrate_history_list(source_filter, lim, legacy_sessions, dsh_result)
}

#[tauri::command]
pub async fn get_workspace_overview_snapshot(
    limit: Option<usize>,
) -> Result<WorkspaceOverviewSnapshot, String> {
    run_blocking(move || {
        orchestrate_workspace_overview(limit, load_legacy_history_sessions)
    })
    .await
}

/// Production orchestration seam for workspace overview.
/// Accepts a session loader function — production wires `load_legacy_history_sessions`
/// which structurally excludes DSH. Tests can inject alternative loaders to prove
/// that DSH cannot appear in the output when the correct loader is used, and
/// WOULD appear if an all-source loader were substituted.
pub fn orchestrate_workspace_overview<F>(
    limit: Option<usize>,
    loader: F,
) -> Result<WorkspaceOverviewSnapshot, String>
where
    F: FnOnce(Option<usize>) -> Result<Vec<HistorySession>, String>,
{
    let sessions = loader(limit)?;
    Ok(build_workspace_overview_snapshot(sessions))
}

#[tauri::command]
pub async fn search_conversation_history(
    app: tauri::AppHandle,
    query: String,
    source: Option<String>,
    limit: Option<usize>,
) -> Result<HistoryListResult, HistoryCommandError> {
    let source_filter = normalize_history_source(source.as_deref())
        .map_err(|e| HistoryCommandError { code: "invalid_source".to_string(), message: e })?;
    let result_limit = normalize_history_limit(limit).unwrap_or(120);

    // Load legacy sessions (sync)
    let legacy_sessions = run_blocking({
        let source_filter = source_filter;
        move || load_legacy_history_sessions_filtered(source_filter, Some(HISTORY_LIMIT_MAX))
    }).await
    .map_err(|e| HistoryCommandError { code: "legacy_error".to_string(), message: e })?;

    // DSH (async)
    let dsh_result = if source_filter == Some(SOURCE_DSH) || source_filter.is_none() {
        Some(load_dsh_history_sessions_async(&app).await)
    } else {
        None
    };

    let mut list_result = orchestrate_history_list(source_filter, None, legacy_sessions, dsh_result)?;

    // Apply search
    let normalized_query = normalize_history_search_text(&query);
    if normalized_query.is_empty() {
        list_result.sessions.truncate(result_limit);
        return Ok(list_result);
    }

    let terms = normalized_query
        .split_whitespace()
        .filter(|term| !term.is_empty())
        .map(|term| term.to_string())
        .collect::<Vec<_>>();
    let mut scored = list_result.sessions
        .into_iter()
        .filter_map(|session| {
            score_history_search_match(&session, &normalized_query, &terms)
                .map(|score| (score, session))
        })
        .collect::<Vec<_>>();

    scored.sort_by(|(left_score, left), (right_score, right)| {
        right_score
            .cmp(left_score)
            .then_with(|| right.timestamp.cmp(&left.timestamp))
            .then_with(|| left.source.cmp(&right.source))
            .then_with(|| left.id.cmp(&right.id))
    });
    scored.truncate(result_limit);

    let sessions = scored.into_iter().map(|(_, session)| session).collect();
    Ok(HistoryListResult { sessions, diagnostics: list_result.diagnostics })
}

/// Load legacy (non-DSH) sessions with optional source filter. Called from sync run_blocking.
fn load_legacy_history_sessions_filtered(
    source_filter: Option<&'static str>,
    limit: Option<usize>,
) -> Result<Vec<HistorySession>, String> {
    // DSH filter returns empty — DSH is handled async outside this function.
    if source_filter == Some(SOURCE_DSH) {
        return Ok(vec![]);
    }

    let scan_limit = limit.map(history_scan_limit);
    let mut sessions = Vec::new();

    if source_filter.is_none() || source_filter == Some(SOURCE_CLAUDE) {
        sessions.extend(load_claude_history_limited(scan_limit)?);
    }
    if source_filter.is_none() || source_filter == Some(SOURCE_CODEX) {
        sessions.extend(load_codex_history_limited(scan_limit)?);
    }
    if source_filter.is_none() || source_filter == Some(SOURCE_OPENCODE) {
        sessions.extend(load_opencode_history()?);
    }

    Ok(sessions)
}

/// Legacy-only loader — used by Workspace to ensure DSH never leaks into session tree.
fn load_legacy_history_sessions(
    limit: Option<usize>,
) -> Result<Vec<HistorySession>, String> {
    let limit = normalize_history_limit(limit);
    let scan_limit = limit.map(history_scan_limit);
    let mut sessions = Vec::new();

    sessions.extend(load_claude_history_limited(scan_limit)?);
    sessions.extend(load_codex_history_limited(scan_limit)?);
    sessions.extend(load_opencode_history()?);

    sessions = dedupe_history_sessions(sessions);
    sessions.sort_by_key(|session| std::cmp::Reverse(session.timestamp));
    finalize_history_sessions(&mut sessions);

    if let Some(limit) = limit {
        sessions.truncate(limit);
    }

    Ok(sessions)
}

/// Shared finalize step: overlay title overrides, annotations.
fn finalize_history_sessions(sessions: &mut Vec<HistorySession>) {
    // Overlay user-edited title overrides
    let overrides = crate::title_overrides::TitleOverrides::load();
    for session in sessions.iter_mut() {
        if let Some(ov) = overrides.get(&session.source, &session.id) {
            session.display = ov.title.clone();
        }
    }

    // Overlay user-edited task stage, expressive sticker, and short label.
    let annotations = crate::session_annotations::SessionAnnotations::load();
    for session in sessions.iter_mut() {
        if let Some(annotation) = annotations.get(&session.source, &session.id) {
            session.task_stage = annotation.stage.clone();
            session.task_sticker = annotation.sticker.clone();
            session.task_label = annotation.label.clone();
        }
    }
}

pub fn build_workspace_overview_snapshot(
    sessions: Vec<HistorySession>,
) -> WorkspaceOverviewSnapshot {
    let project_nodes = build_workspace_project_nodes(&sessions);
    let total_projects = project_nodes.len();
    let total_sessions = sessions.len();

    WorkspaceOverviewSnapshot {
        sessions,
        project_nodes,
        total_sessions,
        total_projects,
    }
}

fn build_workspace_project_nodes(sessions: &[HistorySession]) -> Vec<WorkspaceProjectNode> {
    let mut nodes_by_project: HashMap<String, WorkspaceProjectNodeDraft> = HashMap::new();

    for session in sessions {
        let node = nodes_by_project
            .entry(session.project.clone())
            .or_insert_with(|| WorkspaceProjectNodeDraft {
                project: session.project.clone(),
                project_name: session.project_name.clone(),
                session_refs: Vec::new(),
                latest_timestamp: 0,
            });

        node.session_refs.push(WorkspaceProjectSessionRef {
            session_key: history_session_key(session),
            timestamp: session.timestamp,
            source: session.source.clone(),
            id: session.id.clone(),
        });
        if session.timestamp > node.latest_timestamp {
            node.latest_timestamp = session.timestamp;
        }
    }

    let mut nodes = nodes_by_project
        .into_values()
        .map(|mut draft| {
            draft.session_refs.sort_by(|left, right| {
                right
                    .timestamp
                    .cmp(&left.timestamp)
                    .then_with(|| left.source.cmp(&right.source))
                    .then_with(|| left.id.cmp(&right.id))
            });

            WorkspaceProjectNode {
                project: draft.project,
                project_name: draft.project_name,
                session_keys: draft
                    .session_refs
                    .into_iter()
                    .map(|session_ref| session_ref.session_key)
                    .collect(),
                latest_timestamp: draft.latest_timestamp,
            }
        })
        .collect::<Vec<_>>();

    nodes.sort_by(|left, right| {
        right
            .latest_timestamp
            .cmp(&left.latest_timestamp)
            .then_with(|| left.project.cmp(&right.project))
    });

    nodes
}

fn history_session_key(session: &HistorySession) -> String {
    format!("{}:{}", session.source, session.id)
}

fn normalize_history_search_text(value: &str) -> String {
    value
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn score_history_search_match(
    session: &HistorySession,
    normalized_query: &str,
    terms: &[String],
) -> Option<u32> {
    let display = normalize_history_search_text(&session.display);
    let project_name = normalize_history_search_text(&session.project_name);
    let project = normalize_history_search_text(&session.project);
    let source = normalize_history_search_text(&session.source);

    let fields = [
        display.as_str(),
        project_name.as_str(),
        project.as_str(),
        source.as_str(),
    ];
    if !terms
        .iter()
        .all(|term| fields.iter().any(|field| field.contains(term)))
    {
        return None;
    }

    let mut score = 0;
    score += score_history_search_field(&display, normalized_query, 240);
    score += score_history_search_field(&project_name, normalized_query, 70);
    score += score_history_search_field(&project, normalized_query, 25);
    score += score_history_search_field(&source, normalized_query, 20);

    for term in terms {
        score += score_history_search_field(&display, term, 24);
        score += score_history_search_field(&project_name, term, 7);
        score += score_history_search_field(&project, term, 3);
        score += score_history_search_field(&source, term, 2);
    }

    Some(score)
}

fn score_history_search_field(field: &str, query: &str, weight: u32) -> u32 {
    if field == query {
        weight * 3
    } else if field.starts_with(query) {
        weight * 2
    } else if field.contains(query) {
        weight
    } else {
        0
    }
}

/// Find and read conversation messages for a given session ID/source.
#[tauri::command]
pub async fn get_conversation_messages(
    app: tauri::AppHandle,
    session_id: String,
    source: Option<String>,
) -> Result<Vec<ConversationMessage>, String> {
    let source_hint = normalize_history_source(source.as_deref())?;

    // DSH: async helper
    if source_hint == Some(SOURCE_DSH) {
        let (messages, _segments, _warnings) = load_dsh_conversation_detail_async(&app, &session_id).await?;
        return Ok(messages);
    }

    run_blocking(move || {
        let (messages, _) = load_legacy_conversation_detail(&session_id, source_hint)?;
        Ok(messages)
    })
    .await
}

#[tauri::command]
pub async fn get_conversation_detail(
    app: tauri::AppHandle,
    session_id: String,
    source: Option<String>,
) -> Result<ConversationDetailPayload, HistoryCommandError> {
    let source_hint = normalize_history_source(source.as_deref())
        .map_err(|e| HistoryCommandError { code: "invalid_source".to_string(), message: e })?;

    // Gather inputs for the single orchestration seam
    let dsh_result = if source_hint == Some(SOURCE_DSH) {
        Some(load_dsh_conversation_detail_async(&app, &session_id).await)
    } else {
        None
    };

    let legacy_result = if source_hint != Some(SOURCE_DSH) {
        let sid = session_id.clone();
        let sh = source_hint;
        Some(run_blocking(move || load_legacy_conversation_detail(&sid, sh)).await)
    } else {
        None
    };

    orchestrate_history_detail(&session_id, source_hint, dsh_result, legacy_result)
}

/// Load conversation detail for legacy sources only (sync).
fn load_legacy_conversation_detail(
    session_id: &str,
    source_hint: Option<&'static str>,
) -> Result<(Vec<ConversationMessage>, Vec<CompactSegment>), String> {
    // Legacy: only resolve among claude/codex/opencode; never probe DSH.
    let resolved_source = match resolve_history_source_for_session(session_id, source_hint) {
        Some(s) => s,
        None => return Ok((vec![], vec![])),
    };

    match resolved_source {
        SOURCE_CLAUDE => {
            let home = dirs::home_dir().ok_or("Could not find home directory")?;
            let projects_dir = home.join(".claude").join("projects");
            if !projects_dir.exists() {
                return Ok((vec![], vec![]));
            }
            let path = match find_claude_session_file(&projects_dir, session_id) {
                Some(p) => p,
                None => return Ok((vec![], vec![])),
            };
            parse_claude_conversation_file(&path)
        }
        SOURCE_CODEX => {
            let path = match find_codex_session_file(session_id) {
                Some(p) => p,
                None => return Ok((vec![], vec![])),
            };
            parse_codex_conversation_file(&path)
        }
        SOURCE_OPENCODE => {
            let export = match load_opencode_export(session_id)? {
                Some(value) => value,
                None => return Ok((vec![], vec![])),
            };
            parse_opencode_conversation_export(&export)
        }
        _ => Ok((vec![], vec![])),
    }
}

fn merge_tool_results_into_messages(
    mut messages: Vec<ConversationMessage>,
) -> Vec<ConversationMessage> {
    let mut tool_use_positions: HashMap<String, (usize, usize)> = HashMap::new();

    for (message_index, message) in messages.iter().enumerate() {
        if !is_assistant_message_type(&message.msg_type) {
            continue;
        }
        let Some(blocks) = message.content.as_array() else {
            continue;
        };
        for (block_index, block) in blocks.iter().enumerate() {
            if block.get("type").and_then(|value| value.as_str()) != Some("tool_use") {
                continue;
            }
            let Some(tool_use_id) = block.get("id").and_then(|value| value.as_str()) else {
                continue;
            };
            tool_use_positions.insert(tool_use_id.to_string(), (message_index, block_index));
        }
    }

    let mut tool_results: Vec<(usize, usize, serde_json::Value, bool)> = Vec::new();
    let mut message_content_updates: Vec<Option<Vec<serde_json::Value>>> =
        vec![None; messages.len()];
    let mut omit_message = vec![false; messages.len()];

    for (message_index, message) in messages.iter().enumerate() {
        if !is_user_message_type(&message.msg_type) {
            continue;
        }
        let Some(blocks) = message.content.as_array() else {
            continue;
        };

        let mut remaining_blocks: Option<Vec<serde_json::Value>> = None;
        for (block_index, block) in blocks.iter().enumerate() {
            let is_tool_result =
                block.get("type").and_then(|value| value.as_str()) == Some("tool_result");
            let target = block
                .get("tool_use_id")
                .and_then(|value| value.as_str())
                .and_then(|tool_use_id| tool_use_positions.get(tool_use_id).copied());

            if is_tool_result {
                if let Some((target_message_index, target_block_index)) = target {
                    tool_results.push((
                        target_message_index,
                        target_block_index,
                        block
                            .get("content")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null),
                        block
                            .get("is_error")
                            .and_then(|value| value.as_bool())
                            .unwrap_or(false),
                    ));
                    if remaining_blocks.is_none() {
                        remaining_blocks = Some(blocks[..block_index].to_vec());
                    }
                    continue;
                }
            }

            if let Some(items) = remaining_blocks.as_mut() {
                items.push(block.clone());
            }
        }

        if let Some(items) = remaining_blocks {
            if items.is_empty() {
                omit_message[message_index] = true;
            } else {
                message_content_updates[message_index] = Some(items);
            }
        }
    }

    for (target_message_index, target_block_index, content, is_error) in tool_results {
        let Some(blocks) = messages
            .get_mut(target_message_index)
            .and_then(|message| message.content.as_array_mut())
        else {
            continue;
        };
        let Some(block) = blocks.get_mut(target_block_index) else {
            continue;
        };
        let Some(object) = block.as_object_mut() else {
            continue;
        };
        object.insert("_result".to_string(), content);
        object.insert(
            "_resultError".to_string(),
            serde_json::Value::Bool(is_error),
        );
    }

    for (message_index, content_update) in message_content_updates.into_iter().enumerate() {
        if let Some(content) = content_update {
            if let Some(message) = messages.get_mut(message_index) {
                message.content = serde_json::Value::Array(content);
            }
        }
    }

    messages
        .into_iter()
        .enumerate()
        .filter_map(|(message_index, message)| {
            if omit_message[message_index] {
                None
            } else {
                Some(message)
            }
        })
        .collect()
}

fn is_assistant_message_type(msg_type: &str) -> bool {
    msg_type == "assistant" || msg_type == "ai"
}

fn is_user_message_type(msg_type: &str) -> bool {
    msg_type == "user" || msg_type == "human"
}

/// List sub-agents (Task/Agent sidechains) for a Claude session and optionally
/// return the full message transcript of one of them.
///
/// Sub-agent conversations live in `<project-dir>/<session_id>/subagents/agent-<agentId>.jsonl`.
/// We locate the project dir via `find_claude_session_file`, enumerate the files,
/// read each sidecar `agent-<agentId>.meta.json`, and enrich runtime status from
/// the main transcript's `Agent`/`Task` tool_use + matching tool_result.
#[tauri::command]
pub async fn get_session_subagents(
    session_id: String,
    source: Option<String>,
    detail_agent_id: Option<String>,
) -> Result<SessionSubagentsPayload, String> {
    run_blocking(move || {
        let empty = || SessionSubagentsPayload {
            subagents: vec![],
            detail: None,
        };
        let source_hint = normalize_history_source(source.as_deref())?;
        let resolved_source = match resolve_history_source_for_session(&session_id, source_hint) {
            Some(s) => s,
            None => return Ok(empty()),
        };
        // v1 supports Claude only — Codex/opencode have different sub-agent layouts.
        if resolved_source != SOURCE_CLAUDE {
            return Ok(empty());
        }

        let home = dirs::home_dir().ok_or("Could not find home directory")?;
        let projects_dir = home.join(".claude").join("projects");
        if !projects_dir.exists() {
            return Ok(empty());
        }
        let main_path = match find_claude_session_file(&projects_dir, &session_id) {
            Some(p) => p,
            None => return Ok(empty()),
        };
        let project_dir = match main_path.parent() {
            Some(p) => p,
            None => return Ok(empty()),
        };
        let subagents_dir = project_dir.join(session_id.as_str()).join("subagents");

        let mut records = discover_subagent_records(&subagents_dir);
        enrich_subagent_records(&mut records, &main_path);
        records.sort_by_key(|record| record.meta.started_at);

        let detail = match &detail_agent_id {
            Some(id) if !id.is_empty() => {
                if let Some(record) = records.iter().find(|record| record.meta.agent_id == *id) {
                    let (msgs, _) = parse_claude_conversation_file(&record.path)?;
                    Some(msgs)
                } else {
                    None
                }
            }
            _ => None,
        };

        Ok(SessionSubagentsPayload {
            subagents: records.into_iter().map(|record| record.meta).collect(),
            detail,
        })
    })
    .await
}

#[derive(Debug, Clone)]
struct SubagentRecord {
    meta: SubagentMeta,
    path: PathBuf,
    prompt_key: Option<String>,
    last_event_at: Option<u64>,
}

#[derive(Debug, Clone, Copy)]
struct SubagentFileStats {
    started_at: u64,
    last_event_at: Option<u64>,
    message_count: usize,
    tool_count: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubagentSidecarMeta {
    #[serde(
        default,
        rename = "agentType",
        alias = "agent_type",
        alias = "subagentType",
        alias = "subagent_type"
    )]
    agent_type: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    status: Option<String>,
}

/// Enumerate `agent-<agentId>.jsonl` files in `subagents_dir`, returning base
/// metadata plus local path/correlation helpers. Status starts as `running` and
/// is refined by `enrich_subagent_records`.
fn discover_subagent_records(subagents_dir: &Path) -> Vec<SubagentRecord> {
    let mut records = Vec::new();
    let Ok(entries) = fs::read_dir(subagents_dir) else {
        return records;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        let Some(agent_id) = name
            .strip_prefix("agent-")
            .and_then(|s| s.strip_suffix(".jsonl"))
        else {
            continue;
        };
        let Some(stats) = scan_subagent_file_stats(&path) else {
            continue;
        };
        let sidecar = read_subagent_sidecar_meta(subagents_dir, agent_id);
        let status =
            normalize_subagent_status(sidecar.as_ref().and_then(|meta| meta.status.as_deref()))
                .unwrap_or_else(|| "running".to_string());
        let completed_at = if status == "running" {
            None
        } else {
            stats.last_event_at
        };
        let prompt_key = read_first_user_prompt(&path).map(|prompt| normalize_prompt_key(&prompt));
        records.push(SubagentRecord {
            meta: SubagentMeta {
                agent_id: agent_id.to_string(),
                subagent_type: sidecar
                    .as_ref()
                    .and_then(|meta| normalize_optional_string(meta.agent_type.as_deref())),
                description: sidecar
                    .as_ref()
                    .and_then(|meta| normalize_optional_string(meta.description.as_deref())),
                status,
                message_count: stats.message_count,
                tool_count: stats.tool_count,
                started_at: stats.started_at,
                completed_at,
                result_summary: None,
            },
            path,
            prompt_key,
            last_event_at: stats.last_event_at,
        });
    }
    records
}

#[cfg(test)]
fn discover_subagent_metas(subagents_dir: &Path) -> Vec<SubagentMeta> {
    discover_subagent_records(subagents_dir)
        .into_iter()
        .map(|record| record.meta)
        .collect()
}

fn read_subagent_sidecar_meta(subagents_dir: &Path, agent_id: &str) -> Option<SubagentSidecarMeta> {
    let path = subagents_dir.join(format!("agent-{}.meta.json", agent_id));
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn normalize_optional_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn normalize_subagent_status(value: Option<&str>) -> Option<String> {
    match value.map(|status| status.trim().to_ascii_lowercase()) {
        Some(status) if matches!(status.as_str(), "running" | "completed" | "failed") => {
            Some(status)
        }
        _ => None,
    }
}

fn apply_agent_call_to_meta(
    meta: &mut SubagentMeta,
    call: &MainAgentCall,
    last_event_at: Option<u64>,
) {
    if meta.subagent_type.is_none() {
        meta.subagent_type = call.subagent_type.clone();
    }
    if meta.description.is_none() {
        meta.description = call.description.clone();
    }
    match &call.status {
        AgentCallStatus::Running => {
            meta.status = "running".to_string();
            meta.completed_at = None;
        }
        AgentCallStatus::Completed => {
            meta.status = "completed".to_string();
            meta.completed_at = last_event_at.or(call.completed_at);
            meta.result_summary = call
                .result_text
                .as_deref()
                .and_then(truncate_subagent_result_summary);
        }
        AgentCallStatus::Failed => {
            meta.status = "failed".to_string();
            meta.completed_at = last_event_at.or(call.completed_at);
            meta.result_summary = call
                .result_text
                .as_deref()
                .and_then(truncate_subagent_result_summary);
        }
    }
}

fn truncate_subagent_result_summary(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    const MAX_CHARS: usize = 1200;
    let mut out = String::new();
    for (index, ch) in trimmed.chars().enumerate() {
        if index >= MAX_CHARS {
            out.push('…');
            return Some(out);
        }
        out.push(ch);
    }
    Some(out)
}

/// Lightweight scan of a sub-agent JSONL: first/last timestamp, user+assistant
/// message count, and tool_use block count. Reuses `parse_timestamp_value`.
fn scan_subagent_file_stats(path: &Path) -> Option<SubagentFileStats> {
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut first_ts: Option<u64> = None;
    let mut last_ts: u64 = 0;
    let mut msg_count = 0usize;
    let mut tool_count = 0usize;
    for line_res in reader.lines() {
        let Ok(line) = line_res else { continue };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        let ts_val = v.get("timestamp").cloned();
        let ts = parse_timestamp_value(&ts_val);
        if first_ts.is_none() {
            first_ts = Some(ts);
        }
        if ts > 0 {
            last_ts = ts;
        }
        let line_type = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if line_type == "user" || line_type == "assistant" {
            msg_count += 1;
        }
        if line_type == "assistant" {
            if let Some(blocks) = v
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
            {
                for block in blocks {
                    if block.get("type").and_then(|x| x.as_str()) == Some("tool_use") {
                        tool_count += 1;
                    }
                }
            }
        }
    }
    Some(SubagentFileStats {
        started_at: first_ts.unwrap_or(0),
        last_event_at: if last_ts > 0 { Some(last_ts) } else { None },
        message_count: msg_count,
        tool_count,
    })
}

/// Enrich sub-agent metadata from the main session transcript: correlate each
/// sub-agent to the `Agent`/`Task` tool_use that spawned it. Prefer stable
/// `agentId` values parsed from the tool_result, then fall back to prompt text
/// and start-time proximity for older/built-in agents.
fn enrich_subagent_records(records: &mut [SubagentRecord], main_path: &Path) {
    if records.is_empty() {
        return;
    }
    let Some(agent_index) = scan_main_transcript_agent_calls(main_path) else {
        return;
    };
    let mut used_calls = HashSet::new();
    for record in records.iter_mut() {
        let call_index = find_agent_call_for_record(record, &agent_index, &used_calls);
        if let Some(index) = call_index {
            used_calls.insert(index);
            let call = &agent_index.calls[index];
            apply_agent_call_to_meta(&mut record.meta, call, record.last_event_at);
        }
    }
}

#[cfg(test)]
fn enrich_subagent_metas(metas: &mut [SubagentMeta], main_path: &Path) {
    let mut records: Vec<SubagentRecord> = metas
        .iter()
        .cloned()
        .map(|meta| SubagentRecord {
            path: main_path
                .parent()
                .unwrap_or_else(|| Path::new(""))
                .join("subagents")
                .join(format!("agent-{}.jsonl", meta.agent_id)),
            prompt_key: None,
            last_event_at: meta.completed_at,
            meta,
        })
        .collect();
    for record in &mut records {
        record.prompt_key =
            read_first_user_prompt(&record.path).map(|prompt| normalize_prompt_key(&prompt));
    }
    enrich_subagent_records(&mut records, main_path);
    for (target, record) in metas.iter_mut().zip(records) {
        *target = record.meta;
    }
}

/// Read the first `type:user` message content (the dispatch prompt) from a
/// sub-agent JSONL file. Returns the trimmed text of the first text/content.
fn read_first_user_prompt(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    for line_res in reader.lines() {
        let Ok(line) = line_res else { continue };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        if v.get("type").and_then(|x| x.as_str()) != Some("user") {
            continue;
        }
        if let Some(text) = extract_plain_text_content(
            v.get("message")
                .and_then(|m| m.get("content"))
                .unwrap_or(&serde_json::Value::Null),
        ) {
            return Some(text);
        }
    }
    None
}

#[derive(Debug, Clone)]
enum AgentCallStatus {
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone)]
struct MainAgentCall {
    prompt_key: String,
    subagent_type: Option<String>,
    description: Option<String>,
    started_at: u64,
    completed_at: Option<u64>,
    status: AgentCallStatus,
    result_text: Option<String>,
}

#[derive(Debug, Default)]
struct AgentCallIndex {
    calls: Vec<MainAgentCall>,
    prompt_to_indices: HashMap<String, Vec<usize>>,
    agent_id_to_index: HashMap<String, usize>,
}

fn find_agent_call_for_record(
    record: &SubagentRecord,
    index: &AgentCallIndex,
    used_calls: &HashSet<usize>,
) -> Option<usize> {
    if let Some(call_index) = index.agent_id_to_index.get(&record.meta.agent_id).copied() {
        if !used_calls.contains(&call_index) {
            return Some(call_index);
        }
    }

    let prompt_key = record.prompt_key.as_ref()?;
    let candidates = index.prompt_to_indices.get(prompt_key)?;
    candidates
        .iter()
        .copied()
        .filter(|call_index| !used_calls.contains(call_index))
        .min_by_key(|call_index| {
            let call = &index.calls[*call_index];
            record.meta.started_at.abs_diff(call.started_at)
        })
}

/// Scan the main transcript for all `Agent`/`Task` tool_use blocks and their
/// matching tool_results. Returns indexes by stable `agentId` and by normalized
/// prompt text for older/built-in agents that do not expose an id in the result.
fn scan_main_transcript_agent_calls(main_path: &Path) -> Option<AgentCallIndex> {
    let file = fs::File::open(main_path).ok()?;
    let reader = BufReader::new(file);
    // tool_use_id -> call_index
    let mut pending: HashMap<String, usize> = HashMap::new();
    let mut index = AgentCallIndex::default();

    for line_res in reader.lines() {
        let Ok(line) = line_res else { continue };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        let line_ts = parse_timestamp_value(&v.get("timestamp").cloned());
        let Some(blocks) = v
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
        else {
            continue;
        };
        for block in blocks {
            let Some(btype) = block.get("type").and_then(|x| x.as_str()) else {
                continue;
            };
            if btype == "tool_use" {
                let name = block.get("name").and_then(|x| x.as_str()).unwrap_or("");
                if name != "Agent" && name != "Task" {
                    continue;
                }
                let Some(id) = block.get("id").and_then(|x| x.as_str()) else {
                    continue;
                };
                let input = block.get("input");
                let subagent_type = input
                    .and_then(|i| i.get("subagent_type"))
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string());
                let description = input
                    .and_then(|i| i.get("description"))
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string());
                let prompt = input
                    .and_then(|i| i.get("prompt"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("");
                let key = normalize_prompt_key(prompt);
                let call_index = index.calls.len();
                index.calls.push(MainAgentCall {
                    prompt_key: key.clone(),
                    subagent_type,
                    description,
                    started_at: line_ts,
                    completed_at: None,
                    status: AgentCallStatus::Running,
                    result_text: None,
                });
                index
                    .prompt_to_indices
                    .entry(key)
                    .or_default()
                    .push(call_index);
                pending.insert(id.to_string(), call_index);
            } else if btype == "tool_result" {
                let Some(tuid) = block.get("tool_use_id").and_then(|x| x.as_str()) else {
                    continue;
                };
                let Some(call_index) = pending.remove(tuid) else {
                    continue;
                };
                let is_error = block
                    .get("is_error")
                    .and_then(|x| x.as_bool())
                    .unwrap_or(false);
                let result_text = extract_plain_text_content(
                    block.get("content").unwrap_or(&serde_json::Value::Null),
                );
                if let Some(agent_id) = result_text
                    .as_deref()
                    .and_then(extract_agent_id_from_result_text)
                {
                    index
                        .agent_id_to_index
                        .entry(agent_id)
                        .or_insert(call_index);
                }
                let call = &mut index.calls[call_index];
                call.status = if is_error {
                    AgentCallStatus::Failed
                } else {
                    AgentCallStatus::Completed
                };
                call.completed_at = (line_ts > 0).then_some(line_ts);
                call.result_text = result_text;
            }
        }
    }
    Some(index)
}

fn extract_agent_id_from_result_text(text: &str) -> Option<String> {
    const MARKERS: &[&str] = &[
        "agentId:",
        "agentId =",
        "agent_id:",
        "agent_id =",
        "agent ID:",
    ];
    for marker in MARKERS {
        let Some(start) = text.find(marker) else {
            continue;
        };
        let rest = text[start + marker.len()..].trim_start();
        let agent_id: String = rest
            .chars()
            .skip_while(|ch| matches!(ch, '`' | '"' | '\'' | '=' | ':' | ' '))
            .take_while(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
            .collect();
        if !agent_id.is_empty() {
            return Some(agent_id);
        }
    }
    None
}

/// Normalize a prompt to a stable correlation key (trim + collapse whitespace +
/// cap length). Prompts are matched between the main transcript's Agent
/// tool_use input and the sub-agent file's first user message.
fn normalize_prompt_key(prompt: &str) -> String {
    let mut out = String::new();
    let mut prev_space = false;
    for ch in prompt.trim().chars().take(512) {
        if ch.is_whitespace() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    out
}

/// Return compact segment metadata for a given session/source.
#[tauri::command]
pub async fn get_conversation_segments(
    app: tauri::AppHandle,
    session_id: String,
    source: Option<String>,
) -> Result<Vec<CompactSegment>, String> {
    let source_hint = normalize_history_source(source.as_deref())?;

    // DSH segments are always empty
    if source_hint == Some(SOURCE_DSH) {
        let (_messages, segments, _warnings) = load_dsh_conversation_detail_async(&app, &session_id).await?;
        return Ok(segments);
    }

    run_blocking(move || {
        let (_, segments) = load_legacy_conversation_detail(&session_id, source_hint)?;
        Ok(segments)
    })
    .await
}

// ============================================================================
// Claude history helpers
// ============================================================================

fn load_claude_history() -> Result<Vec<HistorySession>, String> {
    load_claude_history_limited(None)
}

fn load_claude_history_limited(
    project_scan_limit: Option<usize>,
) -> Result<Vec<HistorySession>, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let history_path = home.join(".claude").join("history.jsonl");
    let projects_dir = home.join(".claude").join("projects");

    load_claude_history_from_paths_limited(&history_path, &projects_dir, project_scan_limit)
}

fn load_claude_history_from_paths(
    history_path: &Path,
    projects_dir: &Path,
) -> Result<Vec<HistorySession>, String> {
    load_claude_history_from_paths_limited(history_path, projects_dir, None)
}

fn load_claude_history_from_paths_limited(
    history_path: &Path,
    projects_dir: &Path,
    project_scan_limit: Option<usize>,
) -> Result<Vec<HistorySession>, String> {
    let provenance_records = session_provenance::list_records_by_client(SOURCE_CLAUDE).ok();
    load_claude_history_from_paths_limited_with_provenance_records(
        history_path,
        projects_dir,
        project_scan_limit,
        provenance_records,
    )
}

fn load_claude_history_from_paths_limited_with_provenance_records(
    history_path: &Path,
    projects_dir: &Path,
    project_scan_limit: Option<usize>,
    provenance_records: Option<HashMap<String, session_provenance::SessionProvenanceRecord>>,
) -> Result<Vec<HistorySession>, String> {
    let mut session_map: HashMap<String, HistorySession> = HashMap::new();

    load_claude_history_index(history_path, &mut session_map, project_scan_limit)?;

    supplement_claude_history_from_projects(projects_dir, &mut session_map, project_scan_limit)?;

    supplement_claude_history_from_runtime_state(&mut session_map);
    if let Some(records) = provenance_records {
        supplement_history_from_provenance_records(
            &mut session_map,
            SOURCE_CLAUDE,
            records,
            Some(projects_dir),
        );
    }
    Ok(session_map.into_values().collect())
}

fn load_claude_history_index(
    history_path: &Path,
    session_map: &mut HashMap<String, HistorySession>,
    history_entry_limit: Option<usize>,
) -> Result<(), String> {
    if !history_path.exists() {
        return Ok(());
    }

    if let Some(limit) = history_entry_limit {
        let content = fs::read_to_string(history_path)
            .map_err(|e| format!("Failed to read history.jsonl: {}", e))?;
        for line in content.lines().rev() {
            merge_claude_history_line(session_map, line);
            if session_map.len() >= limit {
                break;
            }
        }
        return Ok(());
    }

    let file =
        fs::File::open(history_path).map_err(|e| format!("Failed to open history.jsonl: {}", e))?;
    let reader = BufReader::new(file);
    for line_result in reader.lines() {
        let line = match line_result {
            Ok(l) => l,
            Err(_) => continue,
        };
        merge_claude_history_line(session_map, &line);
    }

    Ok(())
}

fn merge_claude_history_line(session_map: &mut HashMap<String, HistorySession>, line: &str) {
    if line.trim().is_empty() {
        return;
    }

    let parsed: HistoryLine = match serde_json::from_str(line) {
        Ok(p) => p,
        Err(_) => return,
    };

    let id = match parsed.session_id {
        Some(id) => id,
        None => return,
    };

    let display = normalize_history_display(parsed.display);
    let timestamp = parse_timestamp_value(&parsed.timestamp);
    let project = parsed.project.unwrap_or_default();
    let project_name = parsed.project_name.unwrap_or_else(|| {
        project
            .split('/')
            .next_back()
            .unwrap_or("unknown")
            .to_string()
    });

    merge_claude_history_session(
        session_map,
        HistorySession {
            id,
            source: SOURCE_CLAUDE.to_string(),
            display,
            timestamp,
            project,
            project_name,
            env_name: None,
            config_source: None,
            task_stage: None,
            task_sticker: None,
            task_label: None,
        },
    );
}

fn supplement_claude_history_from_runtime_state(session_map: &mut HashMap<String, HistorySession>) {
    let state = match runtime::read_runtime_state() {
        Ok(state) => state,
        Err(_) => return,
    };

    for entry in state.sessions {
        let Some(session_id) = entry
            .claude_session_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };

        let Some(existing) = session_map.get_mut(session_id) else {
            continue;
        };

        if existing.source != SOURCE_CLAUDE {
            continue;
        }

        if existing
            .env_name
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
        {
            existing.env_name = Some(entry.env_name.clone());
        }

        if existing.config_source.is_none() {
            existing.config_source = Some("ccem".to_string());
        }

        if existing.project.is_empty() && !entry.project_dir.trim().is_empty() {
            existing.project = entry.project_dir.clone();
            existing.project_name = entry
                .project_dir
                .split(['/', '\\'])
                .next_back()
                .filter(|value| !value.is_empty())
                .unwrap_or("unknown")
                .to_string();
        }
    }
}

fn supplement_history_from_provenance_records(
    session_map: &mut HashMap<String, HistorySession>,
    source: &str,
    records: HashMap<String, session_provenance::SessionProvenanceRecord>,
    claude_projects_dir: Option<&Path>,
) {
    for (source_session_id, record) in records {
        if let Some(existing) = session_map.get_mut(&source_session_id) {
            if existing.source == source {
                apply_provenance_to_history_session(existing, &record);
            }
            continue;
        };

        if source != SOURCE_CLAUDE {
            continue;
        }
        if !is_cron_provenance_record(&record) {
            continue;
        }

        let Some(projects_dir) = claude_projects_dir else {
            continue;
        };
        let Some(mut candidate) =
            load_claude_history_session_from_provenance(projects_dir, &record)
        else {
            continue;
        };

        apply_provenance_to_history_session(&mut candidate, &record);
        merge_claude_history_session(session_map, candidate);
    }
}

fn is_cron_provenance_record(record: &session_provenance::SessionProvenanceRecord) -> bool {
    record.launch_mode.trim().eq_ignore_ascii_case("cron")
        || record.started_via.trim().eq_ignore_ascii_case("cron")
}

fn supplement_history_list_from_provenance(sessions: &mut [HistorySession], source: &str) {
    let records = match session_provenance::list_records_by_client(source) {
        Ok(records) => records,
        Err(_) => return,
    };

    for session in sessions.iter_mut() {
        if session.source != source {
            continue;
        }

        let Some(record) = records.get(&session.id) else {
            continue;
        };

        apply_provenance_to_history_session(session, record);
    }
}

fn apply_provenance_to_history_session(
    session: &mut HistorySession,
    record: &session_provenance::SessionProvenanceRecord,
) {
    let record_config_source = record
        .config_source
        .clone()
        .unwrap_or_else(|| session_provenance::DEFAULT_CONFIG_SOURCE.to_string());
    let should_replace_env = session
        .env_name
        .as_deref()
        .is_none_or(|value| value.trim().is_empty())
        || session.config_source.as_deref() == Some("native");

    if should_replace_env && !record.env_name.trim().is_empty() {
        session.env_name = Some(record.env_name.clone());
    }

    if session.config_source.is_none() || session.config_source.as_deref() == Some("native") {
        session.config_source = Some(record_config_source);
    }

    if session.project.is_empty() && !record.working_dir.trim().is_empty() {
        session.project = record.working_dir.clone();
        session.project_name = record
            .working_dir
            .split(['/', '\\'])
            .next_back()
            .filter(|value| !value.is_empty())
            .unwrap_or("unknown")
            .to_string();
    }
}

fn load_claude_history_session_from_provenance(
    projects_dir: &Path,
    record: &session_provenance::SessionProvenanceRecord,
) -> Option<HistorySession> {
    let fallback = history_session_from_provenance_record(SOURCE_CLAUDE, record)?;
    let source_session_id = record.source_session_id.trim();

    let Some(path) = find_claude_session_file(projects_dir, source_session_id) else {
        return Some(fallback);
    };
    let Some(mut session) = parse_claude_project_session_index(&path) else {
        return Some(fallback);
    };
    if session.source != SOURCE_CLAUDE {
        return Some(fallback);
    }
    if session.id.trim() != source_session_id {
        session.id = source_session_id.to_string();
    }
    if session.timestamp == 0 {
        session.timestamp = fallback.timestamp;
    }

    Some(session)
}

fn history_session_from_provenance_record(
    source: &str,
    record: &session_provenance::SessionProvenanceRecord,
) -> Option<HistorySession> {
    let id = record.source_session_id.trim();
    if id.is_empty() {
        return None;
    }

    let project = record.working_dir.trim().to_string();
    let project_name = project
        .split(['/', '\\'])
        .next_back()
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown")
        .to_string();
    let timestamp = parse_rfc3339_millis(&record.updated_at)
        .or_else(|| parse_rfc3339_millis(&record.created_at))
        .unwrap_or(0);

    Some(HistorySession {
        id: id.to_string(),
        source: source.to_string(),
        display: String::new(),
        timestamp,
        project,
        project_name,
        env_name: Some(record.env_name.clone()).filter(|value| !value.trim().is_empty()),
        config_source: record
            .config_source
            .clone()
            .filter(|value| !value.trim().is_empty()),
        task_stage: None,
        task_sticker: None,
        task_label: None,
    })
}

fn parse_rfc3339_millis(value: &str) -> Option<u64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|timestamp| timestamp.timestamp_millis().max(0) as u64)
}

fn dedupe_history_sessions(sessions: Vec<HistorySession>) -> Vec<HistorySession> {
    let records = collect_history_provenance_records();
    dedupe_history_sessions_with_provenance_records(sessions, &records)
}

fn collect_history_provenance_records() -> Vec<session_provenance::SessionProvenanceRecord> {
    [SOURCE_CLAUDE, SOURCE_CODEX, SOURCE_OPENCODE]
        .into_iter()
        .filter_map(|source| session_provenance::list_records_by_client(source).ok())
        .flat_map(|records| records.into_values())
        .collect()
}

fn dedupe_history_sessions_with_provenance_records(
    sessions: Vec<HistorySession>,
    records: &[session_provenance::SessionProvenanceRecord],
) -> Vec<HistorySession> {
    let sessions = dedupe_provenance_alias_history_sessions(sessions, records);
    dedupe_near_duplicate_history_sessions(sessions)
}

fn dedupe_provenance_alias_history_sessions(
    sessions: Vec<HistorySession>,
    records: &[session_provenance::SessionProvenanceRecord],
) -> Vec<HistorySession> {
    if sessions.len() < 2 || records.is_empty() {
        return sessions;
    }

    let mut aliases: HashMap<(String, String), String> = HashMap::new();
    for record in records {
        let source = record.client.trim().to_lowercase();
        let ccem_session_id = record.ccem_session_id.trim();
        let source_session_id = record.source_session_id.trim();

        if source.is_empty()
            || ccem_session_id.is_empty()
            || source_session_id.is_empty()
            || ccem_session_id == source_session_id
        {
            continue;
        }

        aliases.insert(
            (source, ccem_session_id.to_string()),
            source_session_id.to_string(),
        );
    }

    if aliases.is_empty() {
        return sessions;
    }

    let present_keys = sessions
        .iter()
        .map(|session| {
            (
                session.source.trim().to_lowercase(),
                session.id.trim().to_string(),
            )
        })
        .collect::<HashSet<_>>();
    let mut deduped: Vec<HistorySession> = Vec::with_capacity(sessions.len());
    let mut indexes_by_key: HashMap<(String, String), usize> = HashMap::new();

    for mut session in sessions {
        let source = session.source.trim().to_lowercase();
        let original_id = session.id.trim().to_string();
        let canonical_id = aliases
            .get(&(source.clone(), original_id.clone()))
            .filter(|source_session_id| {
                present_keys.contains(&(source.clone(), (*source_session_id).clone()))
            })
            .cloned()
            .unwrap_or_else(|| original_id.clone());
        let key = (source, canonical_id.clone());

        if let Some(existing_index) = indexes_by_key.get(&key).copied() {
            let mut merged =
                merge_near_duplicate_history_sessions(&deduped[existing_index], &session);
            merged.id = canonical_id;
            deduped[existing_index] = merged;
            continue;
        }

        if session.id != canonical_id {
            session.id = canonical_id.clone();
        }
        indexes_by_key.insert(key, deduped.len());
        deduped.push(session);
    }

    deduped
}

fn dedupe_near_duplicate_history_sessions(sessions: Vec<HistorySession>) -> Vec<HistorySession> {
    let mut deduped = Vec::with_capacity(sessions.len());
    let mut indexes_by_key: HashMap<(String, String, String), Vec<usize>> = HashMap::new();

    for session in sessions {
        let Some(key) = history_dedupe_key(&session) else {
            deduped.push(session);
            continue;
        };

        let duplicate_index = indexes_by_key.get(&key).and_then(|indexes| {
            indexes.iter().copied().find(|index| {
                deduped[*index].timestamp.abs_diff(session.timestamp)
                    <= HISTORY_NEAR_DUPLICATE_WINDOW_MS
            })
        });

        if let Some(index) = duplicate_index {
            deduped[index] = merge_near_duplicate_history_sessions(&deduped[index], &session);
            continue;
        }

        let next_index = deduped.len();
        deduped.push(session);
        indexes_by_key.entry(key).or_default().push(next_index);
    }

    deduped
}

fn history_dedupe_key(session: &HistorySession) -> Option<(String, String, String)> {
    // DSH sessions never participate in near-duplicate merging —
    // different sessions may share the same title without being duplicates.
    if session.source == SOURCE_DSH {
        return None;
    }

    let project = session.project.trim();
    let display = clean_display_title(&session.display);

    if project.is_empty() || display.is_empty() {
        return None;
    }

    Some((
        session.source.trim().to_lowercase(),
        project.replace('\\', "/").to_lowercase(),
        display.to_lowercase(),
    ))
}

fn history_session_preference_score(session: &HistorySession) -> (u8, u8, u8, u64) {
    let config_score = match session.config_source.as_deref() {
        Some("ccem") => 2,
        Some(source) if !source.trim().is_empty() && source != "native" => 1,
        _ => 0,
    };
    let env_score = u8::from(
        session
            .env_name
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty()),
    );
    let project_score = u8::from(!session.project.trim().is_empty());

    (config_score, env_score, project_score, session.timestamp)
}

fn merge_near_duplicate_history_sessions(
    left: &HistorySession,
    right: &HistorySession,
) -> HistorySession {
    let (mut winner, donor) =
        if history_session_preference_score(right) > history_session_preference_score(left) {
            (right.clone(), left)
        } else {
            (left.clone(), right)
        };

    merge_history_session_metadata(&mut winner, donor);
    winner
}

fn merge_history_session_metadata(winner: &mut HistorySession, donor: &HistorySession) {
    winner.timestamp = winner.timestamp.max(donor.timestamp);

    if (winner.project.is_empty() || winner.project_name == "unknown") && !donor.project.is_empty()
    {
        winner.project = donor.project.clone();
        winner.project_name = donor.project_name.clone();
    } else if winner.project_name == "unknown" && donor.project_name != "unknown" {
        winner.project_name = donor.project_name.clone();
    }

    if is_noise_display(&winner.display) && !is_noise_display(&donor.display) {
        winner.display = donor.display.clone();
    }

    if winner
        .env_name
        .as_deref()
        .is_none_or(|value| value.trim().is_empty())
    {
        if let Some(env_name) = donor
            .env_name
            .clone()
            .filter(|value| !value.trim().is_empty())
        {
            winner.env_name = Some(env_name);
        }
    }

    if winner
        .config_source
        .as_deref()
        .is_none_or(|value| value.trim().is_empty() || value == "native")
    {
        if let Some(config_source) = donor
            .config_source
            .clone()
            .filter(|value| !value.trim().is_empty())
        {
            winner.config_source = Some(config_source);
        }
    }

    if winner.task_stage.is_none() {
        winner.task_stage = donor.task_stage.clone();
    }
    if winner.task_sticker.is_none() {
        winner.task_sticker = donor.task_sticker.clone();
    }
    if winner.task_label.is_none() {
        winner.task_label = donor.task_label.clone();
    }
}

fn merge_claude_history_session(
    session_map: &mut HashMap<String, HistorySession>,
    candidate: HistorySession,
) {
    if let Some(existing) = session_map.get_mut(&candidate.id) {
        if candidate.timestamp > existing.timestamp {
            existing.timestamp = candidate.timestamp;
        }
        if (existing.project.is_empty() || existing.project_name == "unknown")
            && !candidate.project.is_empty()
        {
            existing.project = candidate.project.clone();
            existing.project_name = candidate.project_name.clone();
        }
        if (is_noise_display(&existing.display) && !is_noise_display(&candidate.display))
            || (candidate.timestamp >= existing.timestamp && !is_noise_display(&candidate.display))
        {
            existing.display = candidate.display;
        }
    } else {
        session_map.insert(candidate.id.clone(), candidate);
    }
}

fn supplement_claude_history_from_projects(
    projects_dir: &Path,
    session_map: &mut HashMap<String, HistorySession>,
    project_scan_limit: Option<usize>,
) -> Result<(), String> {
    if !projects_dir.exists() {
        return Ok(());
    }

    let projects = fs::read_dir(projects_dir)
        .map_err(|error| format!("Failed to read Claude projects dir: {}", error))?;

    let mut project_session_paths: Vec<(u64, String, PathBuf)> = Vec::new();

    for project_entry in projects.flatten() {
        let project_path = project_entry.path();
        if !project_path.is_dir() {
            continue;
        }

        let entries = match fs::read_dir(&project_path) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
                continue;
            }
            if project_scan_limit.is_some() {
                let path_key = path.to_string_lossy().to_string();
                project_session_paths.push((file_modified_at_millis(&path), path_key, path));
            } else if let Some(candidate) = parse_claude_project_session_index(&path) {
                merge_claude_history_session(session_map, candidate);
            }
        }
    }

    if let Some(limit) = project_scan_limit {
        project_session_paths
            .sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));
        project_session_paths.truncate(limit);

        for (_, _, path) in project_session_paths {
            if let Some(candidate) = parse_claude_project_session_index(&path) {
                merge_claude_history_session(session_map, candidate);
            }
        }
    }

    Ok(())
}

fn parse_claude_project_session_index(path: &Path) -> Option<HistorySession> {
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);

    let mut session_id = path.file_stem()?.to_str()?.to_string();
    let mut display: Option<String> = None;
    let mut timestamp = 0;
    let mut project = String::new();

    for line_result in reader.lines() {
        let line = line_result.ok()?;
        if line.trim().is_empty() {
            continue;
        }

        let value: serde_json::Value = serde_json::from_str(&line).ok()?;
        if let Some(id) = value.get("sessionId").and_then(|v| v.as_str()) {
            session_id = id.to_string();
        }

        let line_ts = parse_timestamp_value(&value.get("timestamp").cloned());
        if line_ts > timestamp {
            timestamp = line_ts;
        }

        if project.is_empty() {
            if let Some(cwd) = value.get("cwd").and_then(|v| v.as_str()) {
                project = cwd.to_string();
            }
        }

        let is_meta = value.get("isMeta").and_then(|v| v.as_bool()) == Some(true);
        if is_meta {
            continue;
        }

        if let Some(candidate) = extract_claude_project_display_candidate(&value) {
            let candidate = normalize_history_display(Some(candidate));
            if !candidate.is_empty() {
                display = Some(candidate);
            }
        }
    }

    let project_name = project
        .split('/')
        .next_back()
        .unwrap_or("unknown")
        .to_string();

    Some(HistorySession {
        id: session_id,
        source: SOURCE_CLAUDE.to_string(),
        display: normalize_history_display(display),
        timestamp,
        project,
        project_name,
        env_name: None,
        config_source: None,
        task_stage: None,
        task_sticker: None,
        task_label: None,
    })
}

fn extract_claude_project_display_candidate(value: &serde_json::Value) -> Option<String> {
    match value.get("type").and_then(|v| v.as_str()) {
        Some("last-prompt") => value
            .get("lastPrompt")
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        Some("summary") => value
            .get("summary")
            .and_then(|v| v.as_str())
            .or_else(|| value.get("content").and_then(|v| v.as_str()))
            .map(ToString::to_string),
        Some("user") => value
            .get("message")
            .and_then(extract_first_claude_message_text)
            .map(ToString::to_string),
        _ => None,
    }
}

fn extract_first_claude_message_text(message: &serde_json::Value) -> Option<&str> {
    let content = message.get("content")?;

    // Format 1: content is an array of content blocks (CLI sessions)
    //   {content: [{type: "text", text: "hello"}]}
    if let Some(blocks) = content.as_array() {
        return blocks.iter().find_map(|block| {
            block
                .get("text")
                .and_then(|v| v.as_str())
                .filter(|text| !text.trim().is_empty())
        });
    }

    // Format 2: content is a plain string (SDK shorthand, used by native runtime)
    //   {content: "hello"}
    content.as_str().filter(|text| !text.trim().is_empty())
}

fn find_claude_session_file(projects_dir: &Path, session_id: &str) -> Option<PathBuf> {
    let projects = fs::read_dir(projects_dir).ok()?;

    for project_entry in projects.flatten() {
        let project_path = project_entry.path();
        if !project_path.is_dir() {
            continue;
        }

        let candidate = project_path.join(format!("{}.jsonl", session_id));
        if candidate.exists() {
            return Some(candidate);
        }

        if let Ok(dir_entries) = fs::read_dir(&project_path) {
            for entry in dir_entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    if stem == session_id {
                        return Some(path);
                    }
                }
            }
        }
    }

    None
}

fn parse_claude_conversation_file(
    path: &PathBuf,
) -> Result<(Vec<ConversationMessage>, Vec<CompactSegment>), String> {
    let file =
        fs::File::open(path).map_err(|e| format!("Failed to open conversation file: {}", e))?;

    let reader = BufReader::new(file);
    let mut messages: Vec<ConversationMessage> = Vec::new();
    let mut segments: Vec<CompactSegment> = Vec::new();
    let mut current_segment: usize = 0;

    // Segment 0 always exists.
    segments.push(CompactSegment {
        segment_index: 0,
        timestamp: 0,
        trigger: None,
        pre_tokens: None,
        message_count: 0,
    });

    for line_result in reader.lines() {
        let line = match line_result {
            Ok(l) => l,
            Err(_) => continue,
        };
        if line.trim().is_empty() {
            continue;
        }

        let parsed: MessageLine = match serde_json::from_str(&line) {
            Ok(p) => p,
            Err(_) => continue,
        };

        let msg_type = match &parsed.msg_type {
            Some(t) => t.clone(),
            None => continue,
        };

        // Detect compact_boundary (not microcompact).
        if msg_type == "system" && parsed.subtype.as_deref() == Some("compact_boundary") {
            let is_null_parent =
                matches!(&parsed.parent_uuid, Some(serde_json::Value::Null) | None);
            if is_null_parent {
                current_segment += 1;
                let ts = parse_timestamp_value(&parsed.timestamp);
                let trigger = parsed
                    .compact_metadata
                    .as_ref()
                    .and_then(|m| m.get("trigger"))
                    .and_then(|t| t.as_str())
                    .map(|s| s.to_string());
                let pre_tokens = parsed
                    .compact_metadata
                    .as_ref()
                    .and_then(|m| m.get("preTokens"))
                    .and_then(|t| t.as_u64());

                segments.push(CompactSegment {
                    segment_index: current_segment,
                    timestamp: ts,
                    trigger,
                    pre_tokens,
                    message_count: 0,
                });

                messages.push(ConversationMessage {
                    msg_type: "compact_boundary".to_string(),
                    uuid: parsed.uuid,
                    content: serde_json::Value::String(
                        parsed
                            .content
                            .unwrap_or_else(|| "Conversation compacted".to_string()),
                    ),
                    model: None,
                    summary: None,
                    plan_content: None,
                    timestamp: ts,
                    input_tokens: None,
                    output_tokens: None,
                    cache_creation_tokens: None,
                    cache_read_tokens: None,
                    segment_index: current_segment,
                    is_compact_boundary: true,
                });
                continue;
            }
        }

        if parsed.is_compact_summary == Some(true) {
            continue;
        }

        if parsed.is_meta == Some(true) {
            if msg_type == "user" {
                append_claude_meta_images_to_parent(&mut messages, &parsed);
            }
            continue;
        }

        if parsed.subtype.as_deref() == Some("microcompact_boundary") {
            continue;
        }

        if msg_type == "file-history-snapshot" || msg_type == "progress" {
            continue;
        }

        let (
            mut content,
            model,
            input_tokens,
            output_tokens,
            cache_creation_tokens,
            cache_read_tokens,
        ) = if let Some(msg) = &parsed.message {
            let content = msg
                .get("content")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let model = msg
                .get("model")
                .and_then(|m| m.as_str())
                .map(|s| s.to_string());
            let (input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens) =
                extract_usage_fields(msg);
            (
                content,
                model,
                input_tokens,
                output_tokens,
                cache_creation_tokens,
                cache_read_tokens,
            )
        } else {
            (serde_json::Value::Null, None, None, None, None, None)
        };

        if content.is_null() && msg_type != "summary" && parsed.summary.is_none() {
            continue;
        }

        if msg_type == "user" {
            let Some(normalized_content) = normalize_claude_user_content(&content) else {
                continue;
            };
            content = normalized_content;
        }

        if should_skip_claude_conversation_message(&msg_type, &content, model.as_deref()) {
            continue;
        }

        let ts = parse_timestamp_value(&parsed.timestamp);

        if let Some(seg) = segments.get_mut(current_segment) {
            seg.message_count += 1;
        }

        messages.push(ConversationMessage {
            msg_type,
            uuid: parsed.uuid,
            content,
            model,
            summary: parsed.summary,
            plan_content: parsed.plan_content,
            timestamp: ts,
            input_tokens,
            output_tokens,
            cache_creation_tokens,
            cache_read_tokens,
            segment_index: current_segment,
            is_compact_boundary: false,
        });
    }

    Ok((messages, segments))
}

fn append_claude_meta_images_to_parent(messages: &mut [ConversationMessage], parsed: &MessageLine) {
    let Some(parent_uuid) = parsed
        .parent_uuid
        .as_ref()
        .and_then(serde_json::Value::as_str)
    else {
        return;
    };
    let Some(blocks) = parsed
        .message
        .as_ref()
        .and_then(|message| message.get("content"))
        .and_then(serde_json::Value::as_array)
    else {
        return;
    };
    let images: Vec<serde_json::Value> = blocks
        .iter()
        .filter(|block| block.get("type").and_then(serde_json::Value::as_str) == Some("image"))
        .cloned()
        .collect();
    if images.is_empty() {
        return;
    }

    let Some(parent) = messages
        .iter_mut()
        .rev()
        .find(|message| message.uuid.as_deref() == Some(parent_uuid))
    else {
        return;
    };

    let existing = std::mem::replace(&mut parent.content, serde_json::Value::Null);
    let mut combined = match existing {
        serde_json::Value::Array(blocks) => blocks,
        serde_json::Value::String(text) if !text.trim().is_empty() => {
            vec![serde_json::json!({ "type": "text", "text": text })]
        }
        serde_json::Value::Null => Vec::new(),
        other => vec![other],
    };
    combined.extend(images);
    parent.content = serde_json::Value::Array(combined);
}

fn normalize_claude_user_content(content: &serde_json::Value) -> Option<serde_json::Value> {
    match content {
        serde_json::Value::String(text) => {
            if is_claude_user_wrapper_text(text) {
                extract_claude_wrapped_user_request(text).map(serde_json::Value::String)
            } else {
                Some(content.clone())
            }
        }
        serde_json::Value::Array(blocks) => {
            let wrapped_texts: Vec<&str> = blocks
                .iter()
                .filter_map(|block| block.get("text").and_then(serde_json::Value::as_str))
                .filter(|text| is_claude_user_wrapper_text(text))
                .collect();
            if wrapped_texts.is_empty() {
                return Some(content.clone());
            }

            let mut normalized = Vec::new();
            if let Some(request) = wrapped_texts
                .iter()
                .find_map(|text| extract_claude_wrapped_user_request(text))
            {
                normalized.push(serde_json::json!({ "type": "text", "text": request }));
            }
            normalized.extend(
                blocks
                    .iter()
                    .filter(|block| {
                        block.get("type").and_then(serde_json::Value::as_str) == Some("image")
                    })
                    .cloned(),
            );

            (!normalized.is_empty()).then_some(serde_json::Value::Array(normalized))
        }
        _ => Some(content.clone()),
    }
}

fn is_claude_user_wrapper_text(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.starts_with("<command-name>")
        || trimmed.starts_with("<command-message>")
        || trimmed.starts_with("<selected_skills>")
        || trimmed.starts_with("<user_request>")
}

fn extract_claude_wrapped_user_request(text: &str) -> Option<String> {
    if !is_claude_user_wrapper_text(text) {
        return None;
    }

    if let Some(request) = extract_claude_tag_body(text, "<user_request>", "</user_request>") {
        return clean_claude_user_request(request);
    }

    if text.contains("</user_request>") {
        if let Some(args) = extract_claude_tag_body(text, "<command-args>", "</command-args>") {
            return clean_claude_user_request(args);
        }
    }

    None
}

fn extract_claude_tag_body<'a>(text: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = text.find(open)? + open.len();
    let end = text[start..].find(close)? + start;
    Some(&text[start..end])
}

fn clean_claude_user_request(text: &str) -> Option<String> {
    let cleaned = text
        .replace("<user_request>", "")
        .replace("</user_request>", "");
    let trimmed = cleaned.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn should_skip_claude_conversation_message(
    msg_type: &str,
    content: &serde_json::Value,
    model: Option<&str>,
) -> bool {
    match msg_type {
        "user" => is_claude_control_artifact_content(content),
        "assistant" => is_synthetic_no_response_content(content, model),
        _ => false,
    }
}

fn is_claude_control_artifact_content(content: &serde_json::Value) -> bool {
    let Some(text) = extract_plain_text_content(content) else {
        return false;
    };
    is_claude_control_artifact_text(&text)
}

fn is_claude_control_artifact_text(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return true;
    }

    let lowered = trimmed.to_lowercase();
    if lowered.starts_with("<local-command-caveat>")
        || lowered.starts_with("<local-command-stdout>")
        || lowered.starts_with("<command-name>")
        || lowered.starts_with("<command-message>")
        || lowered.starts_with("<selected_skills>")
        || lowered.starts_with("<synthetic>")
    {
        return true;
    }

    if let Some((command, args)) = parse_slash_command(trimmed) {
        return is_noise_slash_command(command, args);
    }

    false
}

fn is_synthetic_no_response_content(content: &serde_json::Value, model: Option<&str>) -> bool {
    if model != Some("<synthetic>") {
        return false;
    }

    extract_plain_text_content(content)
        .map(|text| text.trim() == "No response requested.")
        .unwrap_or(false)
}

fn extract_plain_text_content(content: &serde_json::Value) -> Option<String> {
    match content {
        serde_json::Value::String(text) => {
            let trimmed = text.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        serde_json::Value::Array(blocks) => {
            let mut parts = Vec::new();
            for block in blocks {
                let block_type = block.get("type").and_then(|value| value.as_str())?;
                if block_type != "text" {
                    return None;
                }
                if let Some(text) = block
                    .get("text")
                    .and_then(|value| value.as_str())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    parts.push(text.to_string());
                }
            }
            (!parts.is_empty()).then(|| parts.join("\n"))
        }
        _ => None,
    }
}

// ============================================================================
// Codex history helpers
// ============================================================================

fn load_codex_history() -> Result<Vec<HistorySession>, String> {
    load_codex_history_limited(None)
}

fn load_codex_history_limited(
    session_scan_limit: Option<usize>,
) -> Result<Vec<HistorySession>, String> {
    let config = resolve_codex_path_config()?;
    load_codex_history_from_config_limited(&config, session_scan_limit)
}

#[cfg(test)]
fn upsert_codex_history_session(
    session_map: &mut HashMap<String, HistorySession>,
    parsed: CodexHistoryLine,
) {
    let id = match parsed.session_id {
        Some(id) if !id.is_empty() => id,
        _ => return,
    };

    let timestamp = parse_codex_history_timestamp(&parsed.ts);
    let display = normalize_history_display(parsed.text);

    if let Some(existing) = session_map.get_mut(&id) {
        if timestamp > existing.timestamp {
            existing.timestamp = timestamp;
        }
        if is_noise_display(&existing.display) && !is_noise_display(&display) {
            existing.display = display;
        }
    } else {
        session_map.insert(
            id.clone(),
            HistorySession {
                id,
                source: SOURCE_CODEX.to_string(),
                display,
                timestamp,
                project: String::new(),
                project_name: "unknown".to_string(),
                env_name: None,
                config_source: None,
                task_stage: None,
                task_sticker: None,
                task_label: None,
            },
        );
    }
}

fn find_codex_session_file(session_id: &str) -> Option<PathBuf> {
    let config = resolve_codex_path_config().ok()?;
    find_codex_session_file_with_config(session_id, &config)
}

fn resolve_codex_path_config() -> Result<CodexPathConfig, String> {
    let home_dir = dirs::home_dir().ok_or("Could not find home directory")?;
    let codex_home_env = std::env::var("CODEX_HOME").ok();
    let sqlite_home_env = std::env::var("CODEX_SQLITE_HOME").ok();
    resolve_codex_path_config_from(
        Some(home_dir.as_path()),
        codex_home_env.as_deref(),
        sqlite_home_env.as_deref(),
    )
}

fn resolve_codex_path_config_from(
    home_dir: Option<&Path>,
    codex_home_env: Option<&str>,
    sqlite_home_env: Option<&str>,
) -> Result<CodexPathConfig, String> {
    let home_dir = home_dir.ok_or("Could not find home directory")?;
    let env_base = std::env::current_dir().unwrap_or_else(|_| home_dir.to_path_buf());

    let codex_home = codex_home_env
        .and_then(non_empty_str)
        .map(|raw| resolve_path_value(raw, home_dir, &env_base))
        .unwrap_or_else(|| home_dir.join(".codex"));

    let sqlite_home = sqlite_home_env
        .and_then(non_empty_str)
        .map(|raw| resolve_path_value(raw, home_dir, &env_base))
        .or_else(|| {
            read_codex_sqlite_home_from_config(&codex_home)
                .as_deref()
                .map(|raw| resolve_path_value(raw, home_dir, &codex_home))
        })
        .unwrap_or_else(|| codex_home.clone());

    Ok(CodexPathConfig {
        home_dir: home_dir.to_path_buf(),
        history_path: codex_home.join("history.jsonl"),
        sessions_root: codex_home.join("sessions"),
        session_index_path: codex_home.join("session_index.jsonl"),
        sqlite_home,
        codex_home,
    })
}

fn non_empty_str(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn resolve_path_value(raw: &str, home_dir: &Path, relative_base: &Path) -> PathBuf {
    if raw == "~" {
        return home_dir.to_path_buf();
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        return home_dir.join(rest);
    }

    let path = PathBuf::from(raw);
    if path.is_absolute() {
        path
    } else {
        relative_base.join(path)
    }
}

fn read_codex_sqlite_home_from_config(codex_home: &Path) -> Option<String> {
    let config_path = codex_home.join("config.toml");
    let content = fs::read_to_string(config_path).ok()?;
    let parsed: toml::Value = toml::from_str(&content).ok()?;
    parsed
        .get("sqlite_home")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
}

fn load_codex_history_from_config(config: &CodexPathConfig) -> Result<Vec<HistorySession>, String> {
    load_codex_history_from_config_limited(config, None)
}

fn load_codex_history_from_config_limited(
    config: &CodexPathConfig,
    session_scan_limit: Option<usize>,
) -> Result<Vec<HistorySession>, String> {
    let session_map = build_codex_session_records_limited(config, session_scan_limit)?;
    let mut sessions = session_map
        .into_values()
        .filter_map(|record| {
            let rollout_path = record.rollout_path?;
            if fs::File::open(&rollout_path).is_err() {
                return None;
            }

            let project_name = record
                .project
                .split('/')
                .next_back()
                .unwrap_or("unknown")
                .to_string();

            Some(HistorySession {
                id: record.id,
                source: SOURCE_CODEX.to_string(),
                display: record.display,
                timestamp: record.timestamp,
                project: record.project,
                project_name,
                env_name: None,
                config_source: None,
                task_stage: None,
                task_sticker: None,
                task_label: None,
            })
        })
        .collect::<Vec<_>>();

    supplement_history_list_from_provenance(&mut sessions, SOURCE_CODEX);
    Ok(sessions)
}

fn build_codex_session_records(
    config: &CodexPathConfig,
) -> Result<HashMap<String, CodexSessionRecord>, String> {
    build_codex_session_records_limited(config, None)
}

fn build_codex_session_records_limited(
    config: &CodexPathConfig,
    session_scan_limit: Option<usize>,
) -> Result<HashMap<String, CodexSessionRecord>, String> {
    let session_files =
        collect_codex_session_files_limited(&config.sessions_root, session_scan_limit);
    let history_entries = load_codex_history_index(&config.history_path);
    let session_index_entries = load_codex_session_index(&config.session_index_path);
    let sqlite_threads = load_codex_threads_from_state_db(config);

    let mut session_map: HashMap<String, CodexSessionRecord> = HashMap::new();

    for (session_id, file_info) in session_files.files {
        let record = codex_record(&mut session_map, &session_id);
        apply_codex_rollout_path(
            record,
            file_info.rollout_path,
            CODEX_ROLLOUT_PRIORITY_SESSION_SCAN,
            file_info.modified_at,
        );
        apply_codex_project(
            record,
            file_info.cwd.unwrap_or_default(),
            CODEX_PROJECT_PRIORITY_SESSION_META,
            file_info.modified_at,
        );
        record.timestamp = record.timestamp.max(file_info.modified_at);
    }

    for parsed in history_entries {
        let id = match parsed.session_id {
            Some(id) if !id.is_empty() => id,
            _ => continue,
        };
        let timestamp = parse_codex_history_timestamp(&parsed.ts);
        let display = normalize_history_display(parsed.text);
        let record = codex_record(&mut session_map, &id);
        apply_codex_display(record, display, CODEX_TITLE_PRIORITY_HISTORY, timestamp);
        record.timestamp = record.timestamp.max(timestamp);
    }

    for parsed in session_index_entries {
        let id = match parsed.id {
            Some(id) if !id.is_empty() => id,
            _ => continue,
        };
        let timestamp = parsed
            .updated_at
            .as_deref()
            .map(parse_codex_datetime_string)
            .unwrap_or(0);
        let display = normalize_history_display(parsed.thread_name);
        let record = codex_record(&mut session_map, &id);
        apply_codex_display(
            record,
            display,
            CODEX_TITLE_PRIORITY_SESSION_INDEX,
            timestamp,
        );
        record.timestamp = record.timestamp.max(timestamp);
    }

    for thread in sqlite_threads {
        let timestamp = thread.updated_at.max(thread.created_at);
        let record = codex_record(&mut session_map, &thread.id);
        apply_codex_display(
            record,
            normalize_history_display(thread.title),
            CODEX_TITLE_PRIORITY_SQLITE,
            timestamp,
        );
        apply_codex_project(
            record,
            thread.cwd.unwrap_or_default(),
            CODEX_PROJECT_PRIORITY_SQLITE,
            timestamp,
        );
        if let Some(path) = thread.rollout_path {
            apply_codex_rollout_path(record, path, CODEX_ROLLOUT_PRIORITY_SQLITE, timestamp);
        }
        record.timestamp = record.timestamp.max(timestamp);
    }

    collapse_codex_duplicate_subagent_records(
        &mut session_map,
        &session_files.subagent_parent_by_id,
    );

    Ok(session_map)
}

fn find_codex_session_file_with_config(
    session_id: &str,
    config: &CodexPathConfig,
) -> Option<PathBuf> {
    build_codex_session_records(config)
        .ok()?
        .get(session_id)
        .and_then(|record| record.rollout_path.clone())
        .filter(|path| fs::File::open(path).is_ok())
}

fn load_codex_history_index(path: &Path) -> Vec<CodexHistoryLine> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return vec![],
    };

    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<CodexHistoryLine>(&line).ok())
        .collect()
}

fn load_codex_session_index(path: &Path) -> Vec<CodexSessionIndexLine> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return vec![],
    };

    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<CodexSessionIndexLine>(&line).ok())
        .collect()
}

fn load_codex_threads_from_state_db(config: &CodexPathConfig) -> Vec<CodexThreadRecord> {
    for state_db_path in list_codex_state_db_candidates(&config.sqlite_home) {
        let conn = match Connection::open_with_flags(
            &state_db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        ) {
            Ok(conn) => conn,
            Err(_) => continue,
        };

        let mut stmt = match conn
            .prepare("SELECT id, rollout_path, created_at, updated_at, cwd, title FROM threads")
        {
            Ok(stmt) => stmt,
            Err(_) => continue,
        };

        let rows = match stmt.query_map([], |row| {
            let rollout_path: Option<String> = row.get(1)?;
            Ok(CodexThreadRecord {
                id: row.get(0)?,
                rollout_path: rollout_path
                    .as_deref()
                    .map(|raw| resolve_path_value(raw, &config.home_dir, &config.codex_home))
                    .filter(|path| path.exists()),
                created_at: normalize_unix_timestamp_i64(row.get::<_, i64>(2)?),
                updated_at: normalize_unix_timestamp_i64(row.get::<_, i64>(3)?),
                cwd: row.get(4)?,
                title: row.get(5)?,
            })
        }) {
            Ok(rows) => rows,
            Err(_) => continue,
        };

        return rows.filter_map(|row| row.ok()).collect();
    }

    vec![]
}

fn list_codex_state_db_candidates(sqlite_home: &Path) -> Vec<PathBuf> {
    let entries = match fs::read_dir(sqlite_home) {
        Ok(entries) => entries,
        Err(_) => return vec![],
    };
    let mut candidates: Vec<(u64, String, PathBuf)> = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if !is_codex_state_db(&path) {
            continue;
        }

        let Some(name) = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
        else {
            continue;
        };
        candidates.push((file_modified_at_millis(&path), name, path));
    }

    candidates.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));

    candidates.into_iter().map(|(_, _, path)| path).collect()
}

fn is_codex_state_db(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }

    match path.file_name().and_then(|name| name.to_str()) {
        Some("state.sqlite") => true,
        Some(name) if name.starts_with("state_") && name.ends_with(".sqlite") => true,
        _ => false,
    }
}

fn codex_record<'a>(
    session_map: &'a mut HashMap<String, CodexSessionRecord>,
    session_id: &str,
) -> &'a mut CodexSessionRecord {
    session_map
        .entry(session_id.to_string())
        .or_insert_with(|| CodexSessionRecord {
            id: session_id.to_string(),
            ..Default::default()
        })
}

fn apply_codex_display(
    record: &mut CodexSessionRecord,
    display: String,
    priority: u8,
    timestamp: u64,
) {
    if display.is_empty() {
        return;
    }

    if priority > record.display_priority
        || (priority == record.display_priority
            && (record.display.is_empty() || timestamp >= record.display_timestamp))
    {
        record.display = display;
        record.display_priority = priority;
        record.display_timestamp = timestamp;
    }
}

fn apply_codex_project(
    record: &mut CodexSessionRecord,
    project: String,
    priority: u8,
    timestamp: u64,
) {
    if project.is_empty() {
        return;
    }

    if priority > record.project_priority
        || (priority == record.project_priority
            && (record.project.is_empty() || timestamp >= record.project_timestamp))
    {
        record.project = project;
        record.project_priority = priority;
        record.project_timestamp = timestamp;
    }
}

fn apply_codex_rollout_path(
    record: &mut CodexSessionRecord,
    rollout_path: PathBuf,
    priority: u8,
    timestamp: u64,
) {
    if !rollout_path.exists() {
        return;
    }

    if priority > record.rollout_priority
        || (priority == record.rollout_priority
            && (record.rollout_path.is_none() || timestamp >= record.rollout_timestamp))
    {
        record.rollout_path = Some(rollout_path);
        record.rollout_priority = priority;
        record.rollout_timestamp = timestamp;
    }
}

fn collapse_codex_duplicate_subagent_records(
    session_map: &mut HashMap<String, CodexSessionRecord>,
    subagent_parent_by_id: &HashMap<String, String>,
) {
    if subagent_parent_by_id.is_empty() {
        return;
    }

    let duplicate_ids = subagent_parent_by_id
        .iter()
        .filter_map(|(subagent_id, parent_id)| {
            let subagent = session_map.get(subagent_id)?;
            let parent = session_map.get(parent_id)?;
            if is_duplicate_codex_subagent_record(subagent, parent) {
                Some((subagent_id.clone(), parent_id.clone()))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();

    for (subagent_id, parent_id) in duplicate_ids {
        let Some(subagent) = session_map.remove(&subagent_id) else {
            continue;
        };
        if let Some(parent) = session_map.get_mut(&parent_id) {
            parent.timestamp = parent.timestamp.max(subagent.timestamp);
            if parent.project.is_empty() {
                parent.project = subagent.project;
                parent.project_priority = subagent.project_priority;
                parent.project_timestamp = subagent.project_timestamp;
            }
            if parent.rollout_path.is_none() {
                parent.rollout_path = subagent.rollout_path;
                parent.rollout_priority = subagent.rollout_priority;
                parent.rollout_timestamp = subagent.rollout_timestamp;
            }
        }
    }
}

fn is_duplicate_codex_subagent_record(
    subagent: &CodexSessionRecord,
    parent: &CodexSessionRecord,
) -> bool {
    if parent.rollout_path.is_none() {
        return false;
    }

    let subagent_display = clean_display_title(&subagent.display).to_lowercase();
    let parent_display = clean_display_title(&parent.display).to_lowercase();
    if subagent_display.is_empty() || subagent_display != parent_display {
        return false;
    }

    let subagent_project = normalize_project_for_dedupe(&subagent.project);
    let parent_project = normalize_project_for_dedupe(&parent.project);
    subagent_project.is_empty() || parent_project.is_empty() || subagent_project == parent_project
}

fn normalize_project_for_dedupe(project: &str) -> String {
    project.trim().trim_end_matches('/').to_lowercase()
}

fn collect_codex_session_files(root: &Path) -> CodexSessionFileCollection {
    collect_codex_session_files_limited(root, None)
}

fn collect_codex_session_files_limited(
    root: &Path,
    session_scan_limit: Option<usize>,
) -> CodexSessionFileCollection {
    let mut collection = CodexSessionFileCollection::default();
    if !root.exists() {
        return collection;
    }

    let mut stack = vec![root.to_path_buf()];
    let mut candidates: Vec<(u64, String, String, PathBuf)> = Vec::new();

    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }

            if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
                continue;
            }

            if let Some(path_session_id) = extract_codex_session_id_from_path(&path) {
                let modified_at = file_modified_at_millis(&path);
                let path_key = path.to_string_lossy().to_string();
                candidates.push((modified_at, path_key, path_session_id, path));
            }
        }
    }

    if let Some(limit) = session_scan_limit {
        candidates.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));
        candidates.truncate(limit);
    }

    for (modified_at, _, path_session_id, path) in candidates {
        let meta = read_codex_session_meta(&path);
        let subagent_parent_thread_id = meta
            .as_ref()
            .and_then(|meta| meta.subagent_parent_thread_id.as_deref())
            .filter(|parent_id| *parent_id != path_session_id && looks_like_uuid(parent_id))
            .map(|parent_id| parent_id.to_string());

        if let Some(parent_thread_id) = subagent_parent_thread_id {
            collection
                .subagent_parent_by_id
                .insert(path_session_id.clone(), parent_thread_id);
        }

        collection.files.push((
            path_session_id,
            CodexSessionFileInfo {
                cwd: meta.and_then(|meta| meta.cwd),
                modified_at,
                rollout_path: path,
            },
        ));
    }

    collection
}

fn extract_codex_session_id_from_path(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    if stem.len() < 36 {
        return None;
    }

    let candidate = &stem[stem.len() - 36..];
    if !looks_like_uuid(candidate) {
        return None;
    }

    Some(candidate.to_string())
}

fn looks_like_uuid(value: &str) -> bool {
    if value.len() != 36 {
        return false;
    }

    for (idx, ch) in value.chars().enumerate() {
        if matches!(idx, 8 | 13 | 18 | 23) {
            if ch != '-' {
                return false;
            }
            continue;
        }

        if !ch.is_ascii_hexdigit() {
            return false;
        }
    }

    true
}

fn read_codex_session_meta(path: &Path) -> Option<CodexSessionMeta> {
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);

    for line_result in reader.lines() {
        let line = line_result.ok()?;
        if line.trim().is_empty() {
            continue;
        }

        let parsed: CodexLine = serde_json::from_str(&line).ok()?;
        if parsed.line_type.as_deref() != Some("session_meta") {
            continue;
        }

        let payload = parsed.payload.unwrap_or(serde_json::Value::Null);
        let cwd = payload
            .get("cwd")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let subagent_parent_thread_id = payload
            .pointer("/source/subagent/thread_spawn/parent_thread_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        return Some(CodexSessionMeta {
            cwd,
            subagent_parent_thread_id,
        });
    }

    None
}

fn file_modified_at_millis(path: &Path) -> u64 {
    fs::metadata(path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn parse_codex_datetime_string(value: &str) -> u64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.timestamp_millis() as u64)
        .unwrap_or(0)
}

fn normalize_unix_timestamp_i64(ts: i64) -> u64 {
    if ts <= 0 {
        0
    } else {
        normalize_unix_timestamp(ts as u64)
    }
}

fn parse_codex_conversation_file(
    path: &PathBuf,
) -> Result<(Vec<ConversationMessage>, Vec<CompactSegment>), String> {
    let file =
        fs::File::open(path).map_err(|e| format!("Failed to open codex session file: {}", e))?;

    let reader = BufReader::new(file);
    let mut lines: Vec<CodexLine> = Vec::new();

    for line_result in reader.lines() {
        let line = match line_result {
            Ok(line) => line,
            Err(_) => continue,
        };
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<CodexLine>(&line) {
            lines.push(parsed);
        }
    }

    let has_event_chat = lines.iter().any(|line| {
        if line.line_type.as_deref() != Some("event_msg") {
            return false;
        }
        let payload_type = line
            .payload
            .as_ref()
            .and_then(|payload| payload.get("type"))
            .and_then(|v| v.as_str());
        matches!(
            payload_type,
            Some("user_message") | Some("agent_message") | Some("agent_reasoning")
        )
    });

    let mut messages: Vec<ConversationMessage> = Vec::new();
    let mut segments: Vec<CompactSegment> = Vec::new();
    let mut current_segment: usize = 0;
    let mut current_model: Option<String> = None;

    segments.push(CompactSegment {
        segment_index: 0,
        timestamp: 0,
        trigger: None,
        pre_tokens: None,
        message_count: 0,
    });

    for line in lines {
        let line_type = match line.line_type.as_deref() {
            Some(t) => t,
            None => continue,
        };

        if line_type == "turn_context" {
            let model = line
                .payload
                .as_ref()
                .and_then(|payload| payload.get("model"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            if model.is_some() {
                current_model = model;
            }
            continue;
        }

        match line_type {
            "event_msg" => {
                let payload = match &line.payload {
                    Some(payload) => payload,
                    None => continue,
                };
                let payload_type = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let ts = parse_timestamp_value(&line.timestamp);

                match payload_type {
                    "user_message" => {
                        let text = payload
                            .get("message")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        if text.is_empty() {
                            continue;
                        }

                        push_message(
                            &mut messages,
                            &mut segments,
                            current_segment,
                            ConversationMessage {
                                msg_type: "user".to_string(),
                                uuid: None,
                                content: json!([{
                                    "type": "text",
                                    "text": text,
                                }]),
                                model: None,
                                summary: None,
                                plan_content: None,
                                timestamp: ts,
                                input_tokens: None,
                                output_tokens: None,
                                cache_creation_tokens: None,
                                cache_read_tokens: None,
                                segment_index: current_segment,
                                is_compact_boundary: false,
                            },
                        );
                    }
                    "agent_message" => {
                        let text = payload
                            .get("message")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        if text.is_empty() {
                            continue;
                        }

                        push_message(
                            &mut messages,
                            &mut segments,
                            current_segment,
                            ConversationMessage {
                                msg_type: "assistant".to_string(),
                                uuid: None,
                                content: json!([{
                                    "type": "text",
                                    "text": text,
                                }]),
                                model: current_model.clone(),
                                summary: None,
                                plan_content: None,
                                timestamp: ts,
                                input_tokens: None,
                                output_tokens: None,
                                cache_creation_tokens: None,
                                cache_read_tokens: None,
                                segment_index: current_segment,
                                is_compact_boundary: false,
                            },
                        );
                    }
                    "agent_reasoning" => {
                        let text = payload
                            .get("text")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        if text.is_empty() {
                            continue;
                        }

                        push_message(
                            &mut messages,
                            &mut segments,
                            current_segment,
                            ConversationMessage {
                                msg_type: "assistant".to_string(),
                                uuid: None,
                                content: json!([{
                                    "type": "thinking",
                                    "thinking": text,
                                }]),
                                model: current_model.clone(),
                                summary: None,
                                plan_content: None,
                                timestamp: ts,
                                input_tokens: None,
                                output_tokens: None,
                                cache_creation_tokens: None,
                                cache_read_tokens: None,
                                segment_index: current_segment,
                                is_compact_boundary: false,
                            },
                        );
                    }
                    "context_compacted" => {
                        current_segment += 1;
                        segments.push(CompactSegment {
                            segment_index: current_segment,
                            timestamp: ts,
                            trigger: None,
                            pre_tokens: None,
                            message_count: 0,
                        });

                        messages.push(ConversationMessage {
                            msg_type: "compact_boundary".to_string(),
                            uuid: None,
                            content: serde_json::Value::String(
                                "Conversation compacted".to_string(),
                            ),
                            model: None,
                            summary: None,
                            plan_content: None,
                            timestamp: ts,
                            input_tokens: None,
                            output_tokens: None,
                            cache_creation_tokens: None,
                            cache_read_tokens: None,
                            segment_index: current_segment,
                            is_compact_boundary: true,
                        });
                    }
                    _ => {}
                }
            }
            "response_item" => {
                let payload = match &line.payload {
                    Some(payload) => payload,
                    None => continue,
                };
                let payload_type = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let ts = parse_timestamp_value(&line.timestamp);

                match payload_type {
                    "function_call" | "custom_tool_call" => {
                        let tool_name = payload
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("tool")
                            .to_string();
                        let call_id = payload
                            .get("call_id")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());

                        let input = payload
                            .get("arguments")
                            .or_else(|| payload.get("input"))
                            .map(parse_maybe_json)
                            .unwrap_or(serde_json::Value::Null);

                        let mut block = json!({
                            "type": "tool_use",
                            "name": tool_name,
                            "input": input,
                        });
                        if let Some(id) = &call_id {
                            block["id"] = serde_json::Value::String(id.clone());
                        }

                        push_message(
                            &mut messages,
                            &mut segments,
                            current_segment,
                            ConversationMessage {
                                msg_type: "assistant".to_string(),
                                uuid: None,
                                content: json!([block]),
                                model: current_model.clone(),
                                summary: None,
                                plan_content: None,
                                timestamp: ts,
                                input_tokens: None,
                                output_tokens: None,
                                cache_creation_tokens: None,
                                cache_read_tokens: None,
                                segment_index: current_segment,
                                is_compact_boundary: false,
                            },
                        );
                    }
                    "function_call_output" | "custom_tool_call_output" => {
                        let call_id = payload
                            .get("call_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();

                        if call_id.is_empty() {
                            continue;
                        }

                        let output = payload
                            .get("output")
                            .map(parse_maybe_json)
                            .unwrap_or(serde_json::Value::Null);

                        push_message(
                            &mut messages,
                            &mut segments,
                            current_segment,
                            ConversationMessage {
                                msg_type: "user".to_string(),
                                uuid: None,
                                content: json!([{
                                    "type": "tool_result",
                                    "tool_use_id": call_id,
                                    "content": output,
                                    "is_error": false,
                                }]),
                                model: None,
                                summary: None,
                                plan_content: None,
                                timestamp: ts,
                                input_tokens: None,
                                output_tokens: None,
                                cache_creation_tokens: None,
                                cache_read_tokens: None,
                                segment_index: current_segment,
                                is_compact_boundary: false,
                            },
                        );
                    }
                    "reasoning" => {
                        if has_event_chat {
                            continue;
                        }

                        let text = extract_reasoning_text(payload);
                        if text.is_empty() {
                            continue;
                        }

                        push_message(
                            &mut messages,
                            &mut segments,
                            current_segment,
                            ConversationMessage {
                                msg_type: "assistant".to_string(),
                                uuid: None,
                                content: json!([{
                                    "type": "thinking",
                                    "thinking": text,
                                }]),
                                model: current_model.clone(),
                                summary: None,
                                plan_content: None,
                                timestamp: ts,
                                input_tokens: None,
                                output_tokens: None,
                                cache_creation_tokens: None,
                                cache_read_tokens: None,
                                segment_index: current_segment,
                                is_compact_boundary: false,
                            },
                        );
                    }
                    "message" => {
                        if has_event_chat {
                            continue;
                        }

                        let role = payload.get("role").and_then(|v| v.as_str()).unwrap_or("");
                        let msg_type = match role {
                            "user" => "user",
                            "assistant" => "assistant",
                            _ => continue,
                        };

                        let blocks = extract_codex_text_blocks(payload);
                        if blocks.is_empty() {
                            continue;
                        }

                        push_message(
                            &mut messages,
                            &mut segments,
                            current_segment,
                            ConversationMessage {
                                msg_type: msg_type.to_string(),
                                uuid: None,
                                content: serde_json::Value::Array(blocks),
                                model: if msg_type == "assistant" {
                                    current_model.clone()
                                } else {
                                    None
                                },
                                summary: None,
                                plan_content: None,
                                timestamp: ts,
                                input_tokens: None,
                                output_tokens: None,
                                cache_creation_tokens: None,
                                cache_read_tokens: None,
                                segment_index: current_segment,
                                is_compact_boundary: false,
                            },
                        );
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    Ok((messages, segments))
}

fn push_message(
    messages: &mut Vec<ConversationMessage>,
    segments: &mut [CompactSegment],
    current_segment: usize,
    message: ConversationMessage,
) {
    if let Some(seg) = segments.get_mut(current_segment) {
        seg.message_count += 1;
    }
    messages.push(message);
}

fn parse_maybe_json(value: &serde_json::Value) -> serde_json::Value {
    if let Some(text) = value.as_str() {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(text) {
            return parsed;
        }
        return serde_json::Value::String(text.to_string());
    }

    value.clone()
}

fn extract_codex_text_blocks(payload: &serde_json::Value) -> Vec<serde_json::Value> {
    let mut blocks = Vec::new();

    if let Some(content_items) = payload.get("content").and_then(|v| v.as_array()) {
        for item in content_items {
            let text = item
                .get("text")
                .and_then(|v| v.as_str())
                .or_else(|| item.get("input_text").and_then(|v| v.as_str()))
                .or_else(|| item.get("output_text").and_then(|v| v.as_str()));

            if let Some(text) = text {
                if !text.is_empty() {
                    blocks.push(json!({
                        "type": "text",
                        "text": text,
                    }));
                }
            }
        }
    }

    blocks
}

fn extract_reasoning_text(payload: &serde_json::Value) -> String {
    if let Some(summary_items) = payload.get("summary").and_then(|v| v.as_array()) {
        let mut parts = Vec::new();
        for item in summary_items {
            if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                if !text.trim().is_empty() {
                    parts.push(text.trim().to_string());
                }
            }
        }
        if !parts.is_empty() {
            return parts.join("\n");
        }
    }

    payload
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

// ============================================================================
// OpenCode history helpers
// ============================================================================

fn load_opencode_history() -> Result<Vec<HistorySession>, String> {
    let mut session_map: HashMap<String, HistorySession> = HashMap::new();

    if let Some(raw_value) = opencode::load_session_list_value_from_cli_or_fixture()? {
        if let Some(items) = raw_value.as_array() {
            for item in items {
                if let Some(session) = parse_opencode_history_session(item) {
                    merge_opencode_history_session(&mut session_map, session);
                }
            }
        }

        if let Some(items) = raw_value.get("sessions").and_then(|value| value.as_array()) {
            for item in items {
                if let Some(session) = parse_opencode_history_session(item) {
                    merge_opencode_history_session(&mut session_map, session);
                }
            }
        }
    }

    for session in opencode::list_local_sessions()? {
        merge_opencode_history_session(
            &mut session_map,
            local_opencode_session_to_history_session(session),
        );
    }

    let mut sessions = session_map.into_values().collect::<Vec<_>>();
    supplement_history_list_from_provenance(&mut sessions, SOURCE_OPENCODE);
    Ok(sessions)
}

fn parse_opencode_history_session(value: &serde_json::Value) -> Option<HistorySession> {
    let id = extract_opencode_string(value, &["id", "sessionId", "session_id"])?;
    let metadata = opencode::read_session_metadata(&id);
    let project = extract_opencode_string(value, &["cwd", "path", "projectPath", "project"])
        .or_else(|| metadata.as_ref().and_then(|item| item.project.clone()))
        .unwrap_or_default();
    let project_name = project
        .split(['/', '\\'])
        .next_back()
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown")
        .to_string();
    let timestamp = extract_opencode_timestamp(value)
        .or_else(|| {
            extract_opencode_string(
                value,
                &["updatedAt", "createdAt", "timestamp", "lastUpdated"],
            )
            .map(|text| parse_string_timestamp(&text))
        })
        .unwrap_or(0);
    let display = normalize_history_display(extract_opencode_string(
        value,
        &["title", "display", "summary", "preview", "name"],
    ));

    Some(HistorySession {
        id,
        source: SOURCE_OPENCODE.to_string(),
        display,
        timestamp,
        project,
        project_name,
        env_name: extract_opencode_string(value, &["envName", "environment", "env"]).or_else(
            || {
                metadata
                    .as_ref()
                    .map(|item| item.env_name.clone())
                    .or_else(|| Some(opencode::OPENCODE_NATIVE_ENV_NAME.to_string()))
            },
        ),
        config_source: extract_opencode_string(value, &["configSource"]).or_else(|| {
            metadata
                .as_ref()
                .map(|item| item.config_source.clone())
                .or_else(|| Some("native".to_string()))
        }),
        task_stage: None,
        task_sticker: None,
        task_label: None,
    })
}

fn merge_opencode_history_session(
    session_map: &mut HashMap<String, HistorySession>,
    candidate: HistorySession,
) {
    if let Some(existing) = session_map.get_mut(&candidate.id) {
        if candidate.timestamp > existing.timestamp {
            existing.timestamp = candidate.timestamp;
        }
        if existing.project.is_empty() && !candidate.project.is_empty() {
            existing.project = candidate.project.clone();
            existing.project_name = candidate.project_name.clone();
        }
        if (existing.env_name.is_none()
            || existing.env_name.as_deref() == Some(opencode::OPENCODE_NATIVE_ENV_NAME))
            && candidate.env_name.is_some()
            && candidate.env_name.as_deref() != Some(opencode::OPENCODE_NATIVE_ENV_NAME)
        {
            existing.env_name = candidate.env_name.clone();
        }
        if (existing.config_source.is_none() || existing.config_source.as_deref() == Some("native"))
            && candidate.config_source.as_deref() == Some("ccem")
        {
            existing.config_source = candidate.config_source.clone();
        }
        if (existing.display.is_empty() || is_noise_display(&existing.display))
            && !candidate.display.is_empty()
            && !is_noise_display(&candidate.display)
        {
            existing.display = candidate.display;
        }
    } else {
        session_map.insert(candidate.id.clone(), candidate);
    }
}

fn load_opencode_export(session_id: &str) -> Result<Option<serde_json::Value>, String> {
    if let Some(value) = opencode::load_export_from_cli_or_fixture(session_id)? {
        return Ok(Some(value));
    }

    let messages = opencode::load_local_messages(session_id)?;
    Ok(messages.map(build_local_opencode_export))
}

fn parse_opencode_conversation_export(
    value: &serde_json::Value,
) -> Result<(Vec<ConversationMessage>, Vec<CompactSegment>), String> {
    let Some(items) = find_opencode_message_array(value) else {
        return Ok((Vec::new(), Vec::new()));
    };

    let mut messages = Vec::new();
    for item in items {
        let msg_type = extract_opencode_string(item, &["role", "type", "kind"])
            .unwrap_or_else(|| "assistant".to_string());
        let content_text = extract_opencode_content_text(item);
        let usage = extract_opencode_usage(item);
        let timestamp = extract_opencode_timestamp(item)
            .or_else(|| {
                extract_opencode_string(item, &["timestamp", "createdAt", "updatedAt"])
                    .map(|text| parse_string_timestamp(&text))
            })
            .unwrap_or(0);

        messages.push(ConversationMessage {
            msg_type,
            uuid: extract_opencode_string(item, &["id", "uuid"]),
            content: content_text.map_or(serde_json::Value::Null, |text| json!(text)),
            model: extract_opencode_string(item, &["model"]),
            summary: None,
            plan_content: None,
            timestamp,
            input_tokens: usage.as_ref().map(|usage| usage.input_tokens),
            output_tokens: usage.as_ref().map(|usage| usage.output_tokens),
            cache_creation_tokens: usage.as_ref().map(|usage| usage.cache_creation_tokens),
            cache_read_tokens: usage.as_ref().map(|usage| usage.cache_read_tokens),
            segment_index: 0,
            is_compact_boundary: false,
        });
    }

    Ok((messages, Vec::new()))
}

#[derive(Debug, Clone, Default)]
struct OpenCodeUsage {
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
}

fn find_opencode_message_array(value: &serde_json::Value) -> Option<&Vec<serde_json::Value>> {
    if let Some(array) = value.as_array() {
        if array.iter().any(opencode_message_candidate) {
            return Some(array);
        }
        return None;
    }

    let object = value.as_object()?;
    for key in ["messages", "items", "entries", "conversation"] {
        if let Some(candidate) = object.get(key) {
            if let Some(array) = find_opencode_message_array(candidate) {
                return Some(array);
            }
        }
    }

    for child in object.values() {
        if let Some(array) = find_opencode_message_array(child) {
            return Some(array);
        }
    }

    None
}

fn opencode_message_candidate(value: &serde_json::Value) -> bool {
    value
        .as_object()
        .map(|object| {
            object.contains_key("role")
                || object.contains_key("type")
                || object.contains_key("content")
                || object.contains_key("message")
                || object.contains_key("text")
        })
        .unwrap_or(false)
}

fn extract_opencode_string(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    if let Some(object) = value.as_object() {
        for key in keys {
            if let Some(raw) = object.get(*key) {
                if let Some(text) = raw.as_str().filter(|text| !text.trim().is_empty()) {
                    return Some(text.to_string());
                }
                if let Some(nested) = raw
                    .as_object()
                    .and_then(|nested| nested.get("path"))
                    .and_then(|nested| nested.as_str())
                    .filter(|text| !text.trim().is_empty())
                {
                    return Some(nested.to_string());
                }
            }
        }
    }

    None
}

fn extract_opencode_timestamp(value: &serde_json::Value) -> Option<u64> {
    for key in ["timestamp", "updatedAt", "createdAt", "lastUpdated"] {
        let Some(raw) = value.get(key) else {
            continue;
        };

        if let Some(number) = raw.as_u64() {
            return Some(normalize_unix_timestamp(number));
        }
        if let Some(text) = raw.as_str().filter(|text| !text.trim().is_empty()) {
            let parsed = parse_string_timestamp(text);
            if parsed > 0 {
                return Some(parsed);
            }
        }
    }

    None
}

fn parse_string_timestamp(value: &str) -> u64 {
    if let Ok(number) = value.parse::<u64>() {
        return normalize_unix_timestamp(number);
    }

    chrono::DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.timestamp_millis() as u64)
        .unwrap_or(0)
}

fn extract_opencode_content_text(value: &serde_json::Value) -> Option<String> {
    if let Some(text) = value.as_str().filter(|text| !text.trim().is_empty()) {
        return Some(text.to_string());
    }

    if let Some(array) = value.as_array() {
        let parts = array
            .iter()
            .filter_map(extract_opencode_content_text)
            .collect::<Vec<_>>();
        if !parts.is_empty() {
            return Some(parts.join("\n\n"));
        }
    }

    let object = value.as_object()?;
    for key in [
        "content", "text", "body", "message", "input", "output", "result",
    ] {
        if let Some(text) = object.get(key).and_then(extract_opencode_content_text) {
            return Some(text);
        }
    }

    None
}

fn extract_opencode_usage(value: &serde_json::Value) -> Option<OpenCodeUsage> {
    let usage_node = value
        .get("usage")
        .or_else(|| value.get("tokens"))
        .or_else(|| value.get("stats"))
        .or_else(|| value.get("cost"))?;
    let object = usage_node.as_object()?;

    Some(OpenCodeUsage {
        input_tokens: object
            .get("inputTokens")
            .or_else(|| object.get("input_tokens"))
            .and_then(|value| value.as_u64())
            .unwrap_or(0),
        output_tokens: object
            .get("outputTokens")
            .or_else(|| object.get("output_tokens"))
            .and_then(|value| value.as_u64())
            .unwrap_or(0),
        cache_read_tokens: object
            .get("cacheReadTokens")
            .or_else(|| object.get("cache_read_tokens"))
            .and_then(|value| value.as_u64())
            .unwrap_or(0),
        cache_creation_tokens: object
            .get("cacheCreationTokens")
            .or_else(|| object.get("cache_creation_tokens"))
            .and_then(|value| value.as_u64())
            .unwrap_or(0),
    })
}

fn local_opencode_session_to_history_session(
    session: opencode::LocalOpenCodeSession,
) -> HistorySession {
    let project = session.project.unwrap_or_default();
    let project_name = project
        .split(['/', '\\'])
        .next_back()
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown")
        .to_string();

    HistorySession {
        id: session.id,
        source: SOURCE_OPENCODE.to_string(),
        display: normalize_history_display(Some(session.title)),
        timestamp: session.updated_at.max(session.created_at),
        project,
        project_name,
        env_name: session.env_name,
        config_source: session.config_source,
        task_stage: None,
        task_sticker: None,
        task_label: None,
    }
}

fn build_local_opencode_export(messages: Vec<opencode::LocalOpenCodeMessage>) -> serde_json::Value {
    json!({
        "messages": messages
            .into_iter()
            .map(|message| {
                json!({
                    "id": message.id,
                    "role": message.role,
                    "timestamp": message.timestamp,
                    "model": message.model,
                    "content": message.content,
                })
            })
            .collect::<Vec<_>>()
    })
}

// ============================================================================
// DSH History integration (read-only, via Phase 1 async helper)
// ============================================================================

/// Diagnostic for partial source failures (used in source=all).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceDiagnostic {
    pub source: String,
    pub code: String,
    pub message: String,
}

/// Error type for DSH list failures (structured).
#[derive(Debug, Clone)]
pub(crate) struct DshListError {
    pub(crate) code: String,
    pub(crate) message: String,
}

/// Typed command error for history IPC commands.
/// Tauri serializes this as the error payload when a command returns Err.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryCommandError {
    pub code: String,
    pub message: String,
}

impl std::fmt::Display for HistoryCommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

/// Map DshHistoryError into a stable code string.
fn error_code(e: &dsh_history::DshHistoryError) -> String {
    match e {
        dsh_history::DshHistoryError::Absent => "absent".to_string(),
        dsh_history::DshHistoryError::InvalidHome(_) => "invalid_home".to_string(),
        dsh_history::DshHistoryError::HelperUnavailable(_) => "helper_unavailable".to_string(),
        dsh_history::DshHistoryError::Timeout => "timeout".to_string(),
        dsh_history::DshHistoryError::OutputTooLarge => "output_too_large".to_string(),
        dsh_history::DshHistoryError::HelperFailed(_) => "helper_failed".to_string(),
        dsh_history::DshHistoryError::SourceError { code, .. } => code.clone(),
        dsh_history::DshHistoryError::UnsupportedFormat(_) => "unsupported_format".to_string(),
        dsh_history::DshHistoryError::BusyCorrupt(_) => "busy_corrupt".to_string(),
    }
}

/// Envelope for history list/search results with optional diagnostics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryListResult {
    pub sessions: Vec<HistorySession>,
    pub diagnostics: Vec<SourceDiagnostic>,
}

/// Composite DSH session ID: `<16hex-sourceInstanceId>:<sessionId>`
fn make_dsh_composite_id(source_instance_id: &str, session_id: &str) -> String {
    format!("{}:{}", source_instance_id, session_id)
}

/// Parse a composite DSH ID. Returns (source_instance_id, session_id).
/// Validates that source_instance_id is exactly 16 hex characters.
fn parse_dsh_composite_id(composite: &str) -> Result<(&str, &str), String> {
    let (fingerprint, session_id) = composite
        .split_once(':')
        .ok_or_else(|| format!("Invalid DSH composite ID (no ':'): {}", composite))?;

    if fingerprint.len() != 16 || !fingerprint.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!(
            "Invalid DSH composite ID fingerprint (expected 16 hex chars): {}",
            fingerprint
        ));
    }

    if session_id.is_empty() {
        return Err(format!("Invalid DSH composite ID (empty sessionId): {}", composite));
    }

    Ok((fingerprint, session_id))
}

/// Map a DshSessionListItem from the helper into a HistorySession.
pub fn map_dsh_list_item(item: &dsh_history::DshSessionListItem) -> HistorySession {
    let composite_id = make_dsh_composite_id(&item.source_instance_id, &item.session_id);
    let timestamp_raw = item.last_event_at.unwrap_or(item.created_at);
    let timestamp_ms = if timestamp_raw > 1_000_000_000_000 {
        timestamp_raw as u64
    } else {
        (timestamp_raw as u64).saturating_mul(1000)
    };

    let project = item.cwd.clone().unwrap_or_default();
    let project_name = item.project_name.clone().unwrap_or_else(|| {
        Path::new(&project)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string()
    });
    let title = item.title.clone().unwrap_or_default();

    HistorySession {
        id: composite_id,
        source: SOURCE_DSH.to_string(),
        display: if title.is_empty() { project_name.clone() } else { title },
        timestamp: timestamp_ms,
        project,
        project_name,
        env_name: item.provider.clone(),
        config_source: None,
        task_stage: None,
        task_sticker: None,
        task_label: None,
    }
}

/// Map a DshSurfaceEvent content block into ConversationMessage content JSON.
/// Returns (Option<message>, Vec<warnings>) — warnings for unknown block types.
pub fn map_dsh_event_to_message(
    event: &dsh_history::DshSurfaceEvent,
    source_instance_id: &str,
    session_id: &str,
) -> (Option<ConversationMessage>, Vec<String>) {
    let timestamp_ms = event.time.map(|t| {
        if t > 1_000_000_000_000 { t as u64 } else { (t as u64).saturating_mul(1000) }
    }).unwrap_or(0);

    // Map role: user → human, assistant → assistant
    let base_msg_type = match event.role {
        dsh_history::DshEventRole::User => "human",
        dsh_history::DshEventRole::Assistant => "assistant",
    };

    // Map content blocks from the event's content array
    let content_blocks = event.content.as_deref().unwrap_or(&[]);

    // Phase 1 helper forwards official DSH content blocks from @deepseek-ai/dsh-llm:
    // - { type: "text", text } → text block
    // - { type: "reasoning", text } → thinking block
    // - { type: "tool-call", id, name, arguments } → tool_use block
    // - { type: "tool-result", toolCallId, content, isError? } → tool_result block
    let mut mapped_blocks: Vec<serde_json::Value> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    for block in content_blocks {
        let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match block_type {
            "text" => {
                let text = block.get("text").and_then(|v| v.as_str()).unwrap_or("");
                mapped_blocks.push(json!({"type": "text", "text": text}));
            }
            "reasoning" => {
                let text = block.get("text").and_then(|v| v.as_str()).unwrap_or("");
                mapped_blocks.push(json!({"type": "thinking", "thinking": text}));
            }
            "tool-call" => {
                let id = block.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let arguments_str = block.get("arguments").and_then(|v| v.as_str()).unwrap_or("{}");
                let input = match serde_json::from_str::<serde_json::Value>(arguments_str) {
                    Ok(val) => val,
                    Err(_) => {
                        // Preserve original raw string — never fabricate an empty object
                        warnings.push(format!(
                            "tool-call '{}' in seq={}: arguments is not valid JSON, preserving raw string",
                            name, event.seq
                        ));
                        json!(arguments_str)
                    }
                };
                mapped_blocks.push(json!({
                    "type": "tool_use",
                    "id": id,
                    "name": name,
                    "input": input
                }));
            }
            "tool-result" => {
                let tool_call_id = block.get("toolCallId").and_then(|v| v.as_str()).unwrap_or("");
                let content = block.get("content").cloned().unwrap_or(json!(""));
                let is_error = block.get("isError").and_then(|v| v.as_bool()).unwrap_or(false);
                mapped_blocks.push(json!({
                    "type": "tool_result",
                    "tool_use_id": tool_call_id,
                    "content": content,
                    "is_error": is_error
                }));
            }
            _ => {
                warnings.push(format!(
                    "Unknown block type '{}' in event seq={}", block_type, event.seq
                ));
            }
        }
    }

    if mapped_blocks.is_empty() {
        return (None, warnings); // No valid content → omit event
    }

    let msg_type = base_msg_type;
    let uuid = format!("dsh:{}:{}:{}", source_instance_id, session_id, event.seq);

    (Some(ConversationMessage {
        msg_type: msg_type.to_string(),
        uuid: Some(uuid),
        content: json!(mapped_blocks),
        model: event.model.clone(),
        summary: None,
        plan_content: None,
        timestamp: timestamp_ms,
        input_tokens: None,
        output_tokens: None,
        cache_creation_tokens: None,
        cache_read_tokens: None,
        segment_index: 0,
        is_compact_boundary: false,
    }), warnings)
}

/// Map a DshSessionDetail into (messages, segments, warnings).
/// Segments are always empty for DSH. Warnings from unmappable events are collected.
pub fn map_dsh_detail(
    detail: &dsh_history::DshSessionDetail,
) -> (Vec<ConversationMessage>, Vec<CompactSegment>, Vec<String>) {
    let mut messages = Vec::new();
    let mut warnings = detail.warnings.clone();

    for event in &detail.events {
        let (msg_opt, block_warnings) = map_dsh_event_to_message(event, &detail.source_instance_id, &detail.session_id);
        warnings.extend(block_warnings);
        match msg_opt {
            Some(msg) => messages.push(msg),
            None => {
                warnings.push(format!(
                    "Unmappable event seq={} type={}",
                    event.seq, event.event_type
                ));
            }
        }
    }

    // DSH segments are always empty
    (messages, vec![], warnings)
}

/// Load DSH sessions via the Phase 1 async helper.
async fn load_dsh_history_sessions_async(
    app: &tauri::AppHandle,
) -> Result<(Vec<HistorySession>, Vec<String>), DshListError> {
    let dsh_source = match dsh_history::resolve_dsh_source() {
        Ok(source) => source,
        Err(dsh_history::DshHistoryError::Absent) => return Ok((vec![], vec![])),
        Err(e) => return Err(DshListError { code: error_code(&e), message: e.to_string() }),
    };

    let roots = vec![dsh_source.sessions_root.to_string_lossy().to_string()];
    let request = dsh_history::DshHistoryRequest::List { roots: roots.clone(), limit: Some(500) };

    let (items, warnings): (Vec<dsh_history::DshSessionListItem>, Vec<String>) =
        dsh_history::invoke_dsh_helper(app, &request, &roots)
            .await
            .map_err(|e| DshListError { code: error_code(&e), message: e.to_string() })?;

    Ok((items.iter().map(map_dsh_list_item).collect(), warnings))
}

/// Load DSH conversation detail via the Phase 1 async helper.
async fn load_dsh_conversation_detail_async(
    app: &tauri::AppHandle,
    composite_id: &str,
) -> Result<(Vec<ConversationMessage>, Vec<CompactSegment>, Vec<String>), String> {
    let (source_instance_id, session_id) = parse_dsh_composite_id(composite_id)?;

    let dsh_source = dsh_history::resolve_dsh_source()
        .map_err(|e| format!("DSH: {}", e))?;

    let roots = vec![dsh_source.sessions_root.to_string_lossy().to_string()];
    let request = dsh_history::DshHistoryRequest::Detail {
        source_instance_id: source_instance_id.to_string(),
        session_id: session_id.to_string(),
    };

    let (detail, envelope_warnings): (dsh_history::DshSessionDetail, Vec<String>) =
        dsh_history::invoke_dsh_helper(app, &request, &roots)
            .await
            .map_err(|e| format!("DSH detail: {}", e))?;

    let (messages, segments, mapping_warnings) = map_dsh_detail(&detail);

    // Combine all warning sources: envelope + detail.warnings (already in mapping) + mapping
    let mut all_warnings = envelope_warnings;
    all_warnings.extend(mapping_warnings);

    Ok((messages, segments, all_warnings))
}

/// Resume allowlist: only claude, codex, opencode are resumable.
/// DSH is explicitly excluded. Returns true if the source is allowed to resume.
pub fn is_resumable_source(source: &str) -> bool {
    matches!(
        source.to_ascii_lowercase().as_str(),
        SOURCE_CLAUDE | SOURCE_CODEX | SOURCE_OPENCODE
    )
}

// ============================================================================
// Shared helpers
// ============================================================================

fn normalize_history_source(source: Option<&str>) -> Result<Option<&'static str>, String> {
    let raw = match source {
        Some(value) => value.trim(),
        None => return Ok(None),
    };

    if raw.is_empty() || raw.eq_ignore_ascii_case("all") {
        return Ok(None);
    }

    let lowered = raw.to_ascii_lowercase();
    match lowered.as_str() {
        SOURCE_CLAUDE => Ok(Some(SOURCE_CLAUDE)),
        SOURCE_CODEX => Ok(Some(SOURCE_CODEX)),
        SOURCE_OPENCODE => Ok(Some(SOURCE_OPENCODE)),
        SOURCE_DSH => Ok(Some(SOURCE_DSH)),
        _ => Err(format!(
            "Unsupported source '{}'. Use claude, codex, opencode, dsh, or all.",
            raw
        )),
    }
}

fn resolve_history_source_for_session(
    session_id: &str,
    source_hint: Option<&'static str>,
) -> Option<&'static str> {
    if let Some(source) = source_hint {
        return Some(source);
    }

    let has_claude = has_claude_session(session_id);
    let has_codex = has_codex_session(session_id);
    let has_opencode = has_opencode_session(session_id);

    if has_claude {
        // Keep legacy behavior: if both exist, default to Claude unless caller passes source.
        return Some(SOURCE_CLAUDE);
    }

    if has_codex {
        return Some(SOURCE_CODEX);
    }

    if has_opencode {
        return Some(SOURCE_OPENCODE);
    }

    None
}

fn has_claude_session(session_id: &str) -> bool {
    let home = match dirs::home_dir() {
        Some(home) => home,
        None => return false,
    };
    let projects_dir = home.join(".claude").join("projects");
    find_claude_session_file(&projects_dir, session_id).is_some()
}

fn has_codex_session(session_id: &str) -> bool {
    find_codex_session_file(session_id).is_some()
}

fn has_opencode_session(session_id: &str) -> bool {
    load_opencode_export(session_id)
        .map(|value| value.is_some())
        .unwrap_or(false)
}

/// Parse timestamp value that could be number or ISO string.
fn parse_timestamp_value(val: &Option<serde_json::Value>) -> u64 {
    match val {
        Some(serde_json::Value::Number(n)) => n.as_u64().unwrap_or(0),
        Some(serde_json::Value::String(s)) => chrono::DateTime::parse_from_rfc3339(s)
            .map(|dt| dt.timestamp_millis() as u64)
            .unwrap_or(0),
        _ => 0,
    }
}

/// Parse Codex history ts where values may be seconds or milliseconds.
fn parse_codex_history_timestamp(val: &Option<serde_json::Value>) -> u64 {
    match val {
        Some(serde_json::Value::Number(n)) => normalize_unix_timestamp(n.as_u64().unwrap_or(0)),
        Some(serde_json::Value::String(s)) => {
            if let Ok(num) = s.parse::<u64>() {
                return normalize_unix_timestamp(num);
            }
            chrono::DateTime::parse_from_rfc3339(s)
                .map(|dt| dt.timestamp_millis() as u64)
                .unwrap_or(0)
        }
        _ => 0,
    }
}

fn normalize_unix_timestamp(ts: u64) -> u64 {
    if ts > 10_000_000_000 {
        // Already milliseconds.
        ts
    } else {
        // Seconds -> milliseconds.
        ts.saturating_mul(1000)
    }
}

fn normalize_history_display(display: Option<String>) -> String {
    let raw = display.unwrap_or_default();
    let cleaned = clean_display_title(&raw);
    if is_noise_display(&cleaned) {
        return String::new();
    }
    // Return empty string — frontend fallback chain handles "Untitled" display
    cleaned
}

/// Non-destructive cleanup: strip noise artifacts but do NOT truncate.
/// Search and export rely on the raw string; truncation is handled by frontend CSS.
fn clean_display_title(raw: &str) -> String {
    let s = raw.trim();
    if s.is_empty() {
        return String::new();
    }

    // 1. Replace newlines with spaces
    let s = s.replace('\n', " ").replace('\r', "");

    // 2. Strip leading artifact markers (only from start to preserve legitimate content)
    //    Loop to handle stacked markers like "[Request interrupted][Error ...]actual title"
    let mut s = s;
    loop {
        let cleaned = strip_leading_bracket(&s, "[Request interrupted");
        let cleaned = strip_leading_system_error(&cleaned);
        let cleaned = cleaned
            .trim_start()
            .trim_start_matches("<synthetic>")
            .trim_start();
        let cleaned = strip_leading_image_marker(cleaned);
        let cleaned = strip_leading_image_source_marker(&cleaned);
        let cleaned = strip_leading_skill_reference(&cleaned);
        if cleaned == s {
            break;
        }
        s = cleaned;
    }

    // 3. Collapse consecutive whitespace
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");

    s.trim().to_string()
}

/// Strip a leading system error bracket like "[Error]", "[Error: ...]", "[Error - ...]".
/// Only strips system artifact formats — NOT "[Error boundary]" or "[Error handling]".
fn strip_leading_system_error(text: &str) -> String {
    let lowered = text.trim_start().to_lowercase();
    if !lowered.starts_with("[error") {
        return text.to_string();
    }
    // Reuse the same precise matching as is_noise_display
    if !lower_starts_with_error_artifact(&lowered) {
        return text.to_string();
    }
    // Match confirmed — find closing ']' and strip
    let chars: Vec<char> = text.trim_start().chars().collect();
    if let Some(offset) = chars.iter().position(|&c| c == ']') {
        let rest: String = chars[offset + 1..].iter().collect();
        rest.trim_start().to_string()
    } else {
        text.to_string()
    }
}

/// Remove a leading "[...]" segment starting with `prefix` from `text`.
/// Only strips from the **beginning** of the string to avoid mangling legitimate
/// titles like "Fix [Error boundary] crash".
/// UTF-8 safe: operates on `Vec<char>`, not byte indices.
fn strip_leading_bracket(text: &str, prefix: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let prefix_chars: Vec<char> = prefix.chars().collect();
    if chars.len() <= prefix_chars.len() || chars[0] != '[' {
        return text.to_string();
    }
    let matches_prefix = chars[..prefix_chars.len()]
        .iter()
        .zip(prefix_chars.iter())
        .all(|(a, b)| a == b);
    if !matches_prefix {
        return text.to_string();
    }
    // Find closing ']' for the leading bracket
    if let Some(offset) = chars.iter().position(|&c| c == ']') {
        let rest: String = chars[offset + 1..].iter().collect();
        rest.trim_start().to_string()
    } else {
        text.to_string()
    }
}

/// Remove a leading "[Image #N]" or "[image #N]" pattern from `text`.
/// Only strips from the **beginning** to preserve legitimate content.
/// UTF-8 safe: char-based.
fn strip_leading_image_marker(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= 7 || chars[0] != '[' {
        return text.to_string();
    }
    let tag: String = chars[..7].iter().collect();
    if tag != "[Image " && tag != "[image " {
        return text.to_string();
    }
    if let Some(offset) = chars.iter().position(|&c| c == ']') {
        let rest: String = chars[offset + 1..].iter().collect();
        rest.trim_start().to_string()
    } else {
        text.to_string()
    }
}

/// Remove a leading "[Image: source: ...]" marker from `text`.
/// Only strips from the beginning to preserve legitimate content later in the title.
fn strip_leading_image_source_marker(text: &str) -> String {
    let trimmed = text.trim_start();
    if !trimmed.starts_with("[Image: source:") && !trimmed.starts_with("[image: source:") {
        return text.to_string();
    }

    if let Some(offset) = trimmed.find(']') {
        return trimmed[offset + 1..].trim_start().to_string();
    }

    text.to_string()
}

/// Strip a leading skill marker such as:
/// - `[$skill](/path/to/SKILL.md)`
/// - `$skill-name`
///
/// Only strips from the beginning so normal markdown links in real titles are preserved.
fn strip_leading_skill_reference(text: &str) -> String {
    let trimmed = text.trim_start();
    let cleaned = strip_one_leading_markdown_skill_link(trimmed);
    if cleaned != trimmed {
        return cleaned;
    }

    strip_one_leading_skill_token(trimmed)
}

fn strip_one_leading_markdown_skill_link(text: &str) -> String {
    if !text.starts_with('[') {
        return text.to_string();
    }

    let Some(label_end) = text.find("](") else {
        return text.to_string();
    };
    let target_start = label_end + 2;
    let Some(target_end_rel) = text[target_start..].find(')') else {
        return text.to_string();
    };
    let target_end = target_start + target_end_rel;
    let target = &text[target_start..target_end];
    if !target.contains("/SKILL.md") {
        return text.to_string();
    }

    text[target_end + 1..].trim_start().to_string()
}

fn strip_one_leading_skill_token(text: &str) -> String {
    if !text.starts_with('$') {
        return text.to_string();
    }

    let token_end = text
        .char_indices()
        .find(|(_, c)| c.is_whitespace())
        .map(|(i, _)| i)
        .unwrap_or(text.len());
    let token = &text[..token_end];
    if token.len() <= 1 {
        return text.to_string();
    }

    let body = &token[1..];
    let valid = body
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ':' || c == '.');
    let looks_like_skill = body.chars().any(|c| c.is_ascii_alphabetic());
    if !valid || !looks_like_skill {
        return text.to_string();
    }

    text[token_end..].trim_start().to_string()
}

/// Check if a lowered string starts with a Claude system error artifact.
/// Matches "[error]" (bare), "[error:" (with details), "[error -" (dash format).
/// Does NOT match "[error boundary]" or "[error handling]" — legitimate user titles.
fn lower_starts_with_error_artifact(lowered: &str) -> bool {
    if !lowered.starts_with("[error") {
        return false;
    }
    let rest = &lowered[6..]; // after "[error"
    if rest.is_empty() {
        return true; // "[error" alone
    }
    let next_char = rest.chars().next().unwrap();
    // Only treat as noise if followed by ']', ':', '-', or '/'
    // Space is intentionally excluded to preserve "[Error boundary]", "[Error handling]", etc.
    matches!(next_char, ']' | ':' | '-' | '/')
}

/// Returns true if display text is command noise, not a real topic.
fn is_noise_display(display: &str) -> bool {
    let trimmed = display.trim();
    if trimmed.is_empty() {
        return true;
    }

    // Filter out very short / punctuation-only content ("？", "??", "...")
    // Use chars() for correct Unicode handling (CJK, emoji, etc.)
    let meaningful: usize = trimmed
        .chars()
        .filter(|c| c.is_alphanumeric() || (*c as u32) >= 0x4E00)
        .count();
    if meaningful < 2 {
        return true;
    }

    if is_low_signal_followup(trimmed) {
        return true;
    }

    // System message patterns — match specific Claude system artifacts only.
    // Use exact prefixes to avoid catching legitimate user titles like "[Error boundary] crash".
    let lowered = trimmed.to_lowercase();
    if lowered.starts_with("[request interrupted") {
        return true;
    }
    // Only match "[error]" (bare) or "[error:" (with details), not "[error boundary]"
    if lower_starts_with_error_artifact(&lowered) {
        return true;
    }
    if lowered.starts_with("<synthetic>") {
        return true;
    }
    if lowered.starts_with("unknown skill:") {
        return true;
    }
    if lowered.starts_with("base directory for this skill:") {
        return true;
    }
    if lowered.starts_with("[image: source:") {
        return true;
    }
    if lowered.starts_with("<local-command-caveat>")
        || lowered.starts_with("<local-command-stdout>")
        || lowered.starts_with("<command-name>")
        || lowered.starts_with("<command-message>")
    {
        return true;
    }

    if lowered == "clear" || lowered == "compact" {
        return true;
    }

    if let Some((command, args)) = parse_slash_command(trimmed) {
        return is_noise_slash_command(command, args);
    }

    if looks_like_bang_command(trimmed) {
        return true;
    }

    false
}

fn is_low_signal_followup(display: &str) -> bool {
    let trimmed = display
        .trim()
        .trim_start_matches(|c: char| {
            matches!(c, '?' | '？' | '!' | '！' | '.' | '。' | ',' | '，')
        })
        .trim_start();

    matches!(trimmed, "继续" | "继续呢" | "继续啊" | "怎么样了")
}

/// Heuristic: slash command token such as /clear, /superpowers:executing-plans.
/// Paths like /Users/g/... are excluded (they contain an additional '/').
fn parse_slash_command(text: &str) -> Option<(&str, &str)> {
    if !text.starts_with('/') {
        return None;
    }

    let first_ws = text
        .char_indices()
        .find(|(_, c)| c.is_whitespace())
        .map(|(i, _)| i);
    let (token, args) = match first_ws {
        Some(i) => (&text[..i], text[i..].trim()),
        None => (text, ""),
    };

    if token.len() <= 1 {
        return None;
    }

    let command = &token[1..];
    if command.contains('/') {
        return None;
    }

    let valid = command
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ':' || c == '.');

    if !valid {
        return None;
    }

    Some((command, args))
}

/// System commands should not become conversation titles.
/// Slash commands with arguments are treated as meaningful by default.
fn is_noise_slash_command(command: &str, args: &str) -> bool {
    let cmd = command.to_ascii_lowercase();

    const ALWAYS_NOISE: &[&str] = &[
        "clear", "compact", "help", "quit", "exit", "new", "resume", "status", "stats", "config",
        "mcp", "plugin", "skills",
        // System/display-only commands — never meaningful as conversation titles
        "buddy", "doctor", "cost", "memory", "login", "model",
    ];
    if ALWAYS_NOISE.contains(&cmd.as_str()) {
        return true;
    }

    if args.is_empty() {
        return true;
    }

    false
}

/// Heuristic: local shell command entered from history, e.g. !ls, !open.
fn looks_like_bang_command(text: &str) -> bool {
    if !text.starts_with('!') {
        return false;
    }

    let token = text.split_whitespace().next().unwrap_or("");
    token.len() > 1
}

fn extract_usage_fields(
    message: &serde_json::Value,
) -> (Option<u64>, Option<u64>, Option<u64>, Option<u64>) {
    let usage = match message.get("usage") {
        Some(u) => u,
        None => return (None, None, None, None),
    };

    let input_tokens = usage.get("input_tokens").and_then(|v| v.as_u64());
    let output_tokens = usage.get("output_tokens").and_then(|v| v.as_u64());
    let cache_creation_tokens = usage
        .get("cache_creation_input_tokens")
        .and_then(|v| v.as_u64());
    let cache_read_tokens = usage
        .get("cache_read_input_tokens")
        .and_then(|v| v.as_u64());

    (
        input_tokens,
        output_tokens,
        cache_creation_tokens,
        cache_read_tokens,
    )
}

#[cfg(test)]
mod tests {
    use super::{
        build_workspace_overview_snapshot, collect_codex_session_files_limited,
        dedupe_history_sessions_with_provenance_records, dedupe_near_duplicate_history_sessions,
        discover_subagent_metas, discover_subagent_records, enrich_subagent_metas,
        enrich_subagent_records, find_codex_session_file_with_config, is_noise_display,
        load_claude_history_from_paths_limited_with_provenance_records,
        load_codex_history_from_config, merge_opencode_history_session,
        merge_tool_results_into_messages, normalize_history_display, normalize_history_limit,
        normalize_history_source, parse_claude_conversation_file, parse_codex_history_timestamp,
        parse_opencode_conversation_export, parse_opencode_history_session,
        resolve_codex_path_config_from, score_history_search_match,
        supplement_history_from_provenance_records, upsert_codex_history_session, CodexHistoryLine,
        CodexPathConfig, ConversationMessage, HistorySession, HISTORY_LIMIT_MAX, SOURCE_CLAUDE,
    };
    use crate::session_provenance::SessionProvenanceRecord;
    use rusqlite::Connection;
    use std::collections::HashMap;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn temp_history_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("ccem-history-{prefix}-{unique}"));
        fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    fn temp_codex_config(root: &Path, sqlite_home: &Path) -> CodexPathConfig {
        CodexPathConfig {
            home_dir: root.to_path_buf(),
            codex_home: root.to_path_buf(),
            history_path: root.join("history.jsonl"),
            sessions_root: root.join("sessions"),
            session_index_path: root.join("session_index.jsonl"),
            sqlite_home: sqlite_home.to_path_buf(),
        }
    }

    fn write_codex_session_file(root: &Path, session_id: &str, cwd: &str) -> PathBuf {
        let session_dir = root.join("sessions").join("2026").join("04").join("15");
        fs::create_dir_all(&session_dir).expect("create codex session dir");
        let path = session_dir.join(format!("rollout-2026-04-15T12-00-00-{session_id}.jsonl"));
        fs::write(
            &path,
            format!(
                concat!(
                    "{{\"timestamp\":\"2026-04-15T12:00:00.000Z\",\"type\":\"session_meta\",\"payload\":",
                    "{{\"id\":\"{session_id}\",\"cwd\":\"{cwd}\"}}}}\n",
                    "{{\"timestamp\":\"2026-04-15T12:00:01.000Z\",\"type\":\"event_msg\",\"payload\":",
                    "{{\"type\":\"user_message\",\"message\":\"hello\"}}}}\n"
                ),
                session_id = session_id,
                cwd = cwd,
            ),
        )
        .expect("write codex session file");
        path
    }

    fn write_codex_subagent_session_file(
        root: &Path,
        session_id: &str,
        parent_thread_id: &str,
        cwd: &str,
    ) -> PathBuf {
        let session_dir = root.join("sessions").join("2026").join("04").join("15");
        fs::create_dir_all(&session_dir).expect("create codex session dir");
        let path = session_dir.join(format!("rollout-2026-04-15T12-10-00-{session_id}.jsonl"));
        fs::write(
            &path,
            format!(
                concat!(
                    "{{\"timestamp\":\"2026-04-15T12:10:00.000Z\",\"type\":\"session_meta\",\"payload\":",
                    "{{\"id\":\"{session_id}\",\"forked_from_id\":\"{parent_thread_id}\",\"cwd\":\"{cwd}\",",
                    "\"source\":{{\"subagent\":{{\"thread_spawn\":{{\"parent_thread_id\":\"{parent_thread_id}\"}}}}}}}}}}\n",
                    "{{\"timestamp\":\"2026-04-15T12:10:01.000Z\",\"type\":\"event_msg\",\"payload\":",
                    "{{\"type\":\"thread_name_updated\",\"thread_id\":\"{parent_thread_id}\",\"thread_name\":\"Parent title\"}}}}\n"
                ),
                session_id = session_id,
                parent_thread_id = parent_thread_id,
                cwd = cwd,
            ),
        )
        .expect("write codex subagent session file");
        path
    }

    fn create_state_db(sqlite_home: &PathBuf, filename: &str, statements: &[&str]) -> PathBuf {
        fs::create_dir_all(sqlite_home).expect("create sqlite home");
        let db_path = sqlite_home.join(filename);
        let conn = Connection::open(&db_path).expect("open sqlite");
        conn.execute_batch(concat!(
            "CREATE TABLE threads (",
            "id TEXT PRIMARY KEY,",
            "rollout_path TEXT NOT NULL,",
            "created_at INTEGER NOT NULL,",
            "updated_at INTEGER NOT NULL,",
            "source TEXT NOT NULL DEFAULT '',",
            "model_provider TEXT NOT NULL DEFAULT '',",
            "cwd TEXT NOT NULL DEFAULT '',",
            "title TEXT NOT NULL DEFAULT '',",
            "sandbox_policy TEXT NOT NULL DEFAULT '',",
            "approval_mode TEXT NOT NULL DEFAULT '',",
            "tokens_used INTEGER NOT NULL DEFAULT 0,",
            "has_user_event INTEGER NOT NULL DEFAULT 0,",
            "archived INTEGER NOT NULL DEFAULT 0,",
            "archived_at INTEGER,",
            "git_sha TEXT,",
            "git_branch TEXT,",
            "git_origin_url TEXT,",
            "cli_version TEXT NOT NULL DEFAULT '',",
            "first_user_message TEXT NOT NULL DEFAULT '',",
            "agent_nickname TEXT,",
            "agent_role TEXT,",
            "memory_mode TEXT NOT NULL DEFAULT 'enabled',",
            "model TEXT,",
            "reasoning_effort TEXT,",
            "agent_path TEXT",
            ");"
        ))
        .expect("create threads table");

        for statement in statements {
            conn.execute_batch(statement).expect("insert thread row");
        }

        drop(conn);
        db_path
    }

    #[test]
    fn test_is_noise_display_for_system_commands() {
        assert!(is_noise_display("/clear"));
        assert!(is_noise_display("/resume "));
        assert!(is_noise_display("/new"));
        assert!(is_noise_display("/new my-topic"));
        assert!(is_noise_display("/status"));
        assert!(is_noise_display("!ls"));
        assert!(is_noise_display("!open /tmp"));
    }

    #[test]
    fn test_is_noise_display_for_meaningful_slash_inputs() {
        assert!(!is_noise_display(
            "/superpowers:executing-plans docs/plans/2026-03-01-whole-repo-refactor-implementation.md"
        ));
        assert!(!is_noise_display(
            "/writing-plans docs/plans/2026-03-01-whole-repo-refactor-design.md"
        ));
        assert!(!is_noise_display("/baymax 帮我整理一下这份方案"));
    }

    #[test]
    fn test_is_noise_display_for_real_topics() {
        assert!(!is_noise_display("继续完成所有的任务"));
        assert!(!is_noise_display("How do we handle auth token refresh?"));
        assert!(!is_noise_display("/Users/g/Github/ccem/docs"));
        assert!(!is_noise_display("I typed /clear but this is a sentence"));
    }

    #[test]
    fn test_normalize_history_display_strips_skill_prefixes() {
        assert_eq!(
            normalize_history_display(Some(
                "[$vercel-react-best-practices](/Users/g/.agents/skills/vercel-react-best-practices/SKILL.md) Dashboard 现在一点进去有卡顿定位下问题".to_string()
            )),
            "Dashboard 现在一点进去有卡顿定位下问题"
        );
        assert_eq!(
            normalize_history_display(Some(
                "$pua [$vercel-react-best-practices](/Users/g/.agents/skills/vercel-react-best-practices/SKILL.md) 最近有多个用户向我反馈说 ui 很卡".to_string()
            )),
            "最近有多个用户向我反馈说 ui 很卡"
        );
        assert_eq!(
            normalize_history_display(Some(
                "[$done](/Users/g/.codex/claude-done/skills/done/SKILL.md)".to_string()
            )),
            ""
        );
    }

    #[test]
    fn test_normalize_history_display_filters_low_signal_noise() {
        assert_eq!(
            normalize_history_display(Some("Unknown skill: codex:setup".to_string())),
            ""
        );
        assert_eq!(normalize_history_display(Some("继续".to_string())), "");
        assert_eq!(normalize_history_display(Some("继续呢".to_string())), "");
        assert_eq!(normalize_history_display(Some("怎么样了".to_string())), "");
        assert_eq!(normalize_history_display(Some("/status".to_string())), "");
        assert_eq!(
            normalize_history_display(Some("[Image: source: /tmp/test.png]".to_string())),
            ""
        );
        assert_eq!(
            normalize_history_display(Some("[Image #1] 右边的空状态为啥有个新会按钮".to_string())),
            "右边的空状态为啥有个新会按钮"
        );
    }

    #[test]
    fn test_codex_history_parsing_with_missing_fields() {
        let mut map = HashMap::new();

        upsert_codex_history_session(
            &mut map,
            CodexHistoryLine {
                session_id: Some("sid-1".to_string()),
                ts: Some(serde_json::Value::Number(serde_json::Number::from(
                    1700000000u64,
                ))),
                text: None,
            },
        );

        let item = map.get("sid-1").expect("session should exist");
        // Now returns empty string — frontend handles the fallback
        assert_eq!(item.display, "");
        assert_eq!(item.source, "codex");
        assert_eq!(item.timestamp, 1_700_000_000_000);

        // Missing ID should be ignored.
        upsert_codex_history_session(
            &mut map,
            CodexHistoryLine {
                session_id: None,
                ts: None,
                text: Some("ignored".to_string()),
            },
        );
        assert_eq!(map.len(), 1);
    }

    #[test]
    fn test_history_source_filtering() {
        assert_eq!(normalize_history_source(None).unwrap(), None);
        assert_eq!(normalize_history_source(Some("all")).unwrap(), None);
        assert_eq!(
            normalize_history_source(Some("claude")).unwrap(),
            Some("claude")
        );
        assert_eq!(
            normalize_history_source(Some("CoDeX")).unwrap(),
            Some("codex")
        );
        assert_eq!(
            normalize_history_source(Some("OpenCode")).unwrap(),
            Some("opencode")
        );
        assert!(normalize_history_source(Some("other")).is_err());
    }

    #[test]
    fn test_history_limit_normalization_clamps_untrusted_values() {
        assert_eq!(normalize_history_limit(None), None);
        assert_eq!(normalize_history_limit(Some(0)), None);
        assert_eq!(normalize_history_limit(Some(24)), Some(24));
        assert_eq!(
            normalize_history_limit(Some(HISTORY_LIMIT_MAX + 50)),
            Some(HISTORY_LIMIT_MAX)
        );
    }

    #[test]
    fn test_workspace_overview_snapshot_groups_projects_in_recency_order() {
        let sessions = vec![
            HistorySession {
                id: "older-alpha".to_string(),
                source: "claude".to_string(),
                display: "Older alpha".to_string(),
                timestamp: 100,
                project: "/repo/alpha".to_string(),
                project_name: "alpha".to_string(),
                env_name: None,
                config_source: None,
                task_stage: None,
                task_sticker: None,
                task_label: None,
            },
            HistorySession {
                id: "newer-beta".to_string(),
                source: "codex".to_string(),
                display: "Newer beta".to_string(),
                timestamp: 300,
                project: "/repo/beta".to_string(),
                project_name: "beta".to_string(),
                env_name: None,
                config_source: None,
                task_stage: None,
                task_sticker: None,
                task_label: None,
            },
            HistorySession {
                id: "newer-alpha".to_string(),
                source: "claude".to_string(),
                display: "Newer alpha".to_string(),
                timestamp: 200,
                project: "/repo/alpha".to_string(),
                project_name: "alpha".to_string(),
                env_name: None,
                config_source: None,
                task_stage: None,
                task_sticker: None,
                task_label: None,
            },
        ];

        let snapshot = build_workspace_overview_snapshot(sessions);

        assert_eq!(snapshot.total_sessions, 3);
        assert_eq!(snapshot.total_projects, 2);
        assert_eq!(
            snapshot
                .project_nodes
                .iter()
                .map(|node| node.project.as_str())
                .collect::<Vec<_>>(),
            vec!["/repo/beta", "/repo/alpha"]
        );
        assert_eq!(snapshot.project_nodes[1].latest_timestamp, 200);
        assert_eq!(
            snapshot.project_nodes[1]
                .session_keys
                .iter()
                .map(|session_key| session_key.as_str())
                .collect::<Vec<_>>(),
            vec!["claude:newer-alpha", "claude:older-alpha"]
        );
    }

    #[test]
    fn test_history_search_score_prefers_title_matches() {
        let session = |display: &str, project_name: &str| HistorySession {
            id: display.to_string(),
            source: SOURCE_CLAUDE.to_string(),
            display: display.to_string(),
            timestamp: 100,
            project: format!("/repo/{project_name}"),
            project_name: project_name.to_string(),
            env_name: None,
            config_source: None,
            task_stage: None,
            task_sticker: None,
            task_label: None,
        };
        let title_match = session("Optimize workspace performance", "ccem");
        let project_match = session("Refactor UI", "workspace-performance");
        let miss = session("Refactor UI", "ccem");
        let terms = vec!["workspace".to_string()];

        let title_score =
            score_history_search_match(&title_match, "workspace", &terms).expect("title match");
        let project_score =
            score_history_search_match(&project_match, "workspace", &terms).expect("project match");

        assert!(title_score > project_score);
        assert!(score_history_search_match(&miss, "workspace", &terms).is_none());
    }

    #[test]
    fn test_merge_tool_results_into_messages_attaches_results_to_tool_use() {
        let message = |msg_type: &str, content: serde_json::Value| ConversationMessage {
            msg_type: msg_type.to_string(),
            uuid: None,
            content,
            model: None,
            summary: None,
            plan_content: None,
            timestamp: 0,
            input_tokens: None,
            output_tokens: None,
            cache_creation_tokens: None,
            cache_read_tokens: None,
            segment_index: 0,
            is_compact_boundary: false,
        };

        let merged = merge_tool_results_into_messages(vec![
            message(
                "assistant",
                serde_json::json!([
                    {
                        "type": "tool_use",
                        "id": "call_1",
                        "name": "Read",
                        "input": { "file_path": "src/main.rs" }
                    }
                ]),
            ),
            message(
                "user",
                serde_json::json!([
                    {
                        "type": "tool_result",
                        "tool_use_id": "call_1",
                        "content": "done",
                        "is_error": true
                    }
                ]),
            ),
            message(
                "user",
                serde_json::json!([
                    { "type": "text", "text": "keep me" },
                    {
                        "type": "tool_result",
                        "tool_use_id": "missing",
                        "content": "left alone"
                    }
                ]),
            ),
        ]);

        assert_eq!(merged.len(), 2);
        let tool_use = merged[0]
            .content
            .as_array()
            .and_then(|blocks| blocks.first())
            .expect("tool use block");
        assert_eq!(
            tool_use.get("_result").and_then(|value| value.as_str()),
            Some("done")
        );
        assert_eq!(
            tool_use
                .get("_resultError")
                .and_then(|value| value.as_bool()),
            Some(true)
        );
        assert_eq!(merged[1].msg_type, "user");
        assert_eq!(
            merged[1]
                .content
                .as_array()
                .expect("remaining content")
                .len(),
            2
        );
    }

    #[test]
    fn test_limited_claude_history_scans_only_recent_project_files() {
        let root = temp_history_dir("claude-limited");
        let history_path = root.join("history.jsonl");
        let projects_dir = root.join("projects");
        let project_dir = projects_dir.join("-Users-g-cc-home");
        fs::create_dir_all(&project_dir).expect("create project dir");

        fs::write(
            project_dir.join("a-old-session.jsonl"),
            concat!(
                "{\"type\":\"progress\",\"cwd\":\"/Users/g/old\",\"sessionId\":\"old-session\",\"timestamp\":\"2026-03-11T15:43:34.800Z\"}\n",
                "{\"type\":\"last-prompt\",\"sessionId\":\"old-session\",\"lastPrompt\":\"Old prompt\",\"timestamp\":\"2026-03-11T15:44:22.971Z\"}\n"
            ),
        )
        .expect("write old session file");
        fs::write(
            project_dir.join("z-new-session.jsonl"),
            concat!(
                "{\"type\":\"progress\",\"cwd\":\"/Users/g/new\",\"sessionId\":\"new-session\",\"timestamp\":\"2026-03-12T15:43:34.800Z\"}\n",
                "{\"type\":\"last-prompt\",\"sessionId\":\"new-session\",\"lastPrompt\":\"New prompt\",\"timestamp\":\"2026-03-12T15:44:22.971Z\"}\n"
            ),
        )
        .expect("write new session file");

        let sessions = load_claude_history_from_paths_limited_with_provenance_records(
            &history_path,
            &projects_dir,
            Some(1),
            Some(HashMap::new()),
        )
        .expect("load limited history");
        let session_ids = sessions
            .iter()
            .map(|session| session.id.as_str())
            .collect::<Vec<_>>();

        assert!(session_ids.contains(&"new-session"));
        assert!(!session_ids.contains(&"old-session"));
        assert_eq!(
            sessions
                .iter()
                .find(|session| session.id == "new-session")
                .map(|session| session.display.as_str()),
            Some("New prompt")
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn test_limited_claude_history_merges_recent_projects_with_recent_index() {
        let root = temp_history_dir("claude-index-limited");
        let history_path = root.join("history.jsonl");
        let projects_dir = root.join("projects");
        let project_dir = projects_dir.join("-Users-g-cc-home");
        fs::create_dir_all(&project_dir).expect("create project dir");

        fs::write(
            &history_path,
            concat!(
                "{\"sessionId\":\"indexed-session\",\"display\":\"/clear\",",
                "\"timestamp\":\"2026-03-12T15:44:22.971Z\",\"project\":\"\",",
                "\"projectName\":\"unknown\"}\n"
            ),
        )
        .expect("write history index");
        fs::write(
            project_dir.join("a-indexed-session.jsonl"),
            concat!(
                "{\"type\":\"progress\",\"cwd\":\"/Users/g/indexed\",\"sessionId\":\"indexed-session\",\"timestamp\":\"2026-03-12T15:45:00.000Z\"}\n",
                "{\"type\":\"last-prompt\",\"sessionId\":\"indexed-session\",\"lastPrompt\":\"Indexed real prompt\",\"timestamp\":\"2026-03-12T15:45:01.000Z\"}\n"
            ),
        )
        .expect("write indexed project session file");
        fs::write(
            project_dir.join("z-project-only.jsonl"),
            concat!(
                "{\"type\":\"progress\",\"cwd\":\"/Users/g/project\",\"sessionId\":\"project-only\",\"timestamp\":\"2026-03-13T15:43:34.800Z\"}\n",
                "{\"type\":\"last-prompt\",\"sessionId\":\"project-only\",\"lastPrompt\":\"Project prompt\",\"timestamp\":\"2026-03-13T15:44:22.971Z\"}\n"
            ),
        )
        .expect("write project session file");

        let sessions = load_claude_history_from_paths_limited_with_provenance_records(
            &history_path,
            &projects_dir,
            Some(2),
            Some(HashMap::new()),
        )
        .expect("load limited history");
        let session_ids = sessions
            .iter()
            .map(|session| session.id.as_str())
            .collect::<Vec<_>>();

        assert!(session_ids.contains(&"indexed-session"));
        assert!(session_ids.contains(&"project-only"));
        let indexed = sessions
            .iter()
            .find(|session| session.id == "indexed-session")
            .expect("indexed session should be merged with project metadata");
        assert_eq!(indexed.display, "Indexed real prompt");
        assert_eq!(indexed.project, "/Users/g/indexed");
        let project_only = sessions
            .iter()
            .find(|session| session.id == "project-only")
            .expect("project-only session should be visible");
        assert_eq!(project_only.display, "Project prompt");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn test_provenance_recovers_claude_project_session_missing_from_recent_index() {
        let root = temp_history_dir("claude-provenance-project");
        let projects_dir = root.join("projects");
        let project_dir = projects_dir.join("-Users-g-ccem");
        fs::create_dir_all(&project_dir).expect("create project dir");

        fs::write(
            project_dir.join("cron-provider-session.jsonl"),
            concat!(
                "{\"type\":\"progress\",\"cwd\":\"/Users/g/ccem\",\"sessionId\":\"cron-provider-session\",\"timestamp\":\"2026-07-04T04:00:27.000Z\"}\n",
                "{\"type\":\"last-prompt\",\"sessionId\":\"cron-provider-session\",\"lastPrompt\":\"Run scheduled release audit\",\"timestamp\":\"2026-07-04T04:00:28.000Z\"}\n"
            ),
        )
        .expect("write cron project session file");

        let record = SessionProvenanceRecord {
            ccem_session_id: "run-1783137626281-ef83".to_string(),
            client: SOURCE_CLAUDE.to_string(),
            source_session_id: "cron-provider-session".to_string(),
            env_name: "glm-official".to_string(),
            config_source: Some("ccem".to_string()),
            working_dir: "/Users/g/ccem".to_string(),
            perm_mode: Some("dev".to_string()),
            launch_mode: "cron".to_string(),
            started_via: "cron".to_string(),
            created_at: "2026-07-04T04:00:26Z".to_string(),
            updated_at: "2026-07-04T04:00:29Z".to_string(),
        };
        let mut records = HashMap::new();
        records.insert(record.source_session_id.clone(), record);
        let mut session_map = HashMap::new();

        supplement_history_from_provenance_records(
            &mut session_map,
            SOURCE_CLAUDE,
            records,
            Some(&projects_dir),
        );

        let session = session_map
            .get("cron-provider-session")
            .expect("provenance-backed project session should be visible");
        assert_eq!(session.display, "Run scheduled release audit");
        assert_eq!(session.project, "/Users/g/ccem");
        assert_eq!(session.project_name, "ccem");
        assert_eq!(session.env_name.as_deref(), Some("glm-official"));
        assert_eq!(session.config_source.as_deref(), Some("ccem"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn test_provenance_recovers_claude_cron_session_without_provider_history_file() {
        let root = temp_history_dir("claude-provenance-only");
        let projects_dir = root.join("projects");
        fs::create_dir_all(&projects_dir).expect("create projects dir");

        let record = SessionProvenanceRecord {
            ccem_session_id: "run-1783137626281-ef83".to_string(),
            client: SOURCE_CLAUDE.to_string(),
            source_session_id: "cron-provider-session".to_string(),
            env_name: "KimiCodePlan".to_string(),
            config_source: Some("ccem".to_string()),
            working_dir: "/Users/g/baymax".to_string(),
            perm_mode: Some("dev".to_string()),
            launch_mode: "cron".to_string(),
            started_via: "cron".to_string(),
            created_at: "2026-07-04T04:00:26Z".to_string(),
            updated_at: "2026-07-04T04:00:29Z".to_string(),
        };
        let mut records = HashMap::new();
        records.insert(record.source_session_id.clone(), record);
        let mut session_map = HashMap::new();

        supplement_history_from_provenance_records(
            &mut session_map,
            SOURCE_CLAUDE,
            records,
            Some(&projects_dir),
        );

        let session = session_map
            .get("cron-provider-session")
            .expect("sqlite provenance should make cron session visible");
        assert_eq!(session.display, "");
        assert_eq!(session.project, "/Users/g/baymax");
        assert_eq!(session.project_name, "baymax");
        assert_eq!(session.env_name.as_deref(), Some("KimiCodePlan"));
        assert_eq!(session.config_source.as_deref(), Some("ccem"));
        assert_eq!(session.timestamp, 1_783_137_629_000);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn test_provenance_project_recovery_is_limited_to_cron_records() {
        let root = temp_history_dir("claude-provenance-non-cron-project");
        let projects_dir = root.join("projects");
        let project_dir = projects_dir.join("-Users-g-ccem");
        fs::create_dir_all(&project_dir).expect("create project dir");

        fs::write(
            project_dir.join("manual-provider-session.jsonl"),
            concat!(
                "{\"type\":\"progress\",\"cwd\":\"/Users/g/ccem\",\"sessionId\":\"manual-provider-session\",\"timestamp\":\"2026-07-04T04:00:27.000Z\"}\n",
                "{\"type\":\"last-prompt\",\"sessionId\":\"manual-provider-session\",\"lastPrompt\":\"Manual task\",\"timestamp\":\"2026-07-04T04:00:28.000Z\"}\n"
            ),
        )
        .expect("write manual project session file");

        let record = SessionProvenanceRecord {
            ccem_session_id: "run-manual".to_string(),
            client: SOURCE_CLAUDE.to_string(),
            source_session_id: "manual-provider-session".to_string(),
            env_name: "glm-official".to_string(),
            config_source: Some("ccem".to_string()),
            working_dir: "/Users/g/ccem".to_string(),
            perm_mode: Some("dev".to_string()),
            launch_mode: "manual".to_string(),
            started_via: "desktop".to_string(),
            created_at: "2026-07-04T04:00:26Z".to_string(),
            updated_at: "2026-07-04T04:00:29Z".to_string(),
        };
        let mut records = HashMap::new();
        records.insert(record.source_session_id.clone(), record);
        let mut session_map = HashMap::new();

        supplement_history_from_provenance_records(
            &mut session_map,
            SOURCE_CLAUDE,
            records,
            Some(&projects_dir),
        );

        assert!(
            session_map.is_empty(),
            "non-cron provenance should not expand recent history from project files"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn test_limited_codex_session_collection_reads_only_recent_candidates() {
        let root = temp_history_dir("codex-limited");
        let old_session_id = "00000000-0000-4000-8000-000000000001";
        let new_session_id = "ffffffff-ffff-4fff-8fff-ffffffffffff";

        write_codex_session_file(&root, old_session_id, "/Users/g/old");
        write_codex_session_file(&root, new_session_id, "/Users/g/new");

        let collection = collect_codex_session_files_limited(&root.join("sessions"), Some(1));

        assert_eq!(collection.files.len(), 1);
        assert_eq!(collection.files[0].0, new_session_id);
        assert_eq!(collection.files[0].1.cwd.as_deref(), Some("/Users/g/new"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn test_parse_opencode_history_session_uses_title_and_project() {
        let value = serde_json::json!({
            "id": "opencode-session-1",
            "cwd": "/tmp/opencode-workspace",
            "title": "排查 OpenCode 集成",
            "updatedAt": "2026-04-15T12:34:56.000Z"
        });

        let session = parse_opencode_history_session(&value).expect("session parsed");
        assert_eq!(session.id, "opencode-session-1");
        assert_eq!(session.source, "opencode");
        assert_eq!(session.project, "/tmp/opencode-workspace");
        assert_eq!(session.project_name, "opencode-workspace");
        assert_eq!(session.display, "排查 OpenCode 集成");
        assert_eq!(session.timestamp, 1_776_256_496_000);
    }

    #[test]
    fn test_merge_opencode_history_session_promotes_local_ccem_metadata() {
        let mut map = HashMap::new();
        map.insert(
            "opencode-session-1".to_string(),
            HistorySession {
                id: "opencode-session-1".to_string(),
                source: "opencode".to_string(),
                display: "".to_string(),
                timestamp: 10,
                project: "".to_string(),
                project_name: "unknown".to_string(),
                env_name: Some(super::opencode::OPENCODE_NATIVE_ENV_NAME.to_string()),
                config_source: Some("native".to_string()),
                task_stage: None,
                task_sticker: None,
                task_label: None,
            },
        );

        merge_opencode_history_session(
            &mut map,
            HistorySession {
                id: "opencode-session-1".to_string(),
                source: "opencode".to_string(),
                display: "补齐元数据".to_string(),
                timestamp: 20,
                project: "/tmp/demo".to_string(),
                project_name: "demo".to_string(),
                env_name: Some("Fixture Anthropic".to_string()),
                config_source: Some("ccem".to_string()),
                task_stage: None,
                task_sticker: None,
                task_label: None,
            },
        );

        let merged = map.get("opencode-session-1").expect("merged session");
        assert_eq!(merged.timestamp, 20);
        assert_eq!(merged.project, "/tmp/demo");
        assert_eq!(merged.project_name, "demo");
        assert_eq!(merged.display, "补齐元数据");
        assert_eq!(merged.env_name.as_deref(), Some("Fixture Anthropic"));
        assert_eq!(merged.config_source.as_deref(), Some("ccem"));
    }

    #[test]
    fn test_parse_opencode_conversation_export_reads_messages_and_usage() {
        let export = serde_json::json!({
            "messages": [
                {
                    "id": "msg-1",
                    "role": "user",
                    "timestamp": "2026-04-15T12:34:56.000Z",
                    "content": [{"type": "text", "text": "请帮我检查 OpenCode 接入"}]
                },
                {
                    "id": "msg-2",
                    "role": "assistant",
                    "timestamp": "2026-04-15T12:35:10.000Z",
                    "model": "anthropic/claude-sonnet-4-5",
                    "content": [{"type": "text", "text": "已经开始检查。"}],
                    "usage": {
                        "inputTokens": 1200,
                        "outputTokens": 340,
                        "cacheReadTokens": 80,
                        "cacheCreationTokens": 20
                    }
                }
            ]
        });

        let (messages, segments) =
            parse_opencode_conversation_export(&export).expect("export parsed");

        assert!(segments.is_empty());
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].msg_type, "user");
        assert_eq!(
            messages[1].model.as_deref(),
            Some("anthropic/claude-sonnet-4-5")
        );
        assert_eq!(messages[1].input_tokens, Some(1200));
        assert_eq!(messages[1].output_tokens, Some(340));
        assert_eq!(messages[1].cache_read_tokens, Some(80));
        assert_eq!(messages[1].cache_creation_tokens, Some(20));
    }

    #[test]
    fn test_parse_codex_seconds_timestamp_to_millis() {
        let ts = parse_codex_history_timestamp(&Some(serde_json::Value::Number(
            serde_json::Number::from(1_700_000_000u64),
        )));
        assert_eq!(ts, 1_700_000_000_000);
    }

    #[test]
    fn test_normalize_history_display_falls_back_for_blank_values() {
        // Empty string — frontend handles "Untitled" display
        assert_eq!(normalize_history_display(None), "");
        assert_eq!(normalize_history_display(Some(String::new())), "");
        assert_eq!(
            normalize_history_display(Some("   keep title   ".to_string())),
            "keep title"
        );
    }

    #[test]
    fn test_claude_history_falls_back_to_project_sessions_when_index_missing() {
        let root = temp_history_dir("fallback");
        let history_path = root.join("history.jsonl");
        let projects_dir = root.join("projects");
        let project_dir = projects_dir.join("-Users-g-cc-home");
        fs::create_dir_all(&project_dir).expect("create project dir");

        fs::write(
            project_dir.join("session-1.jsonl"),
            concat!(
                "{\"type\":\"progress\",\"cwd\":\"/Users/g/cc-home\",\"sessionId\":\"session-1\",\"timestamp\":\"2026-03-11T15:43:34.800Z\"}\n",
                "{\"type\":\"user\",\"sessionId\":\"session-1\",\"timestamp\":\"2026-03-11T15:43:34.817Z\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Say exactly ok\"}]}}\n",
                "{\"type\":\"last-prompt\",\"sessionId\":\"session-1\",\"lastPrompt\":\"Say exactly ok\",\"timestamp\":\"2026-03-11T15:44:22.971Z\"}\n"
            ),
        )
        .expect("write session file");

        let sessions = load_claude_history_from_paths_limited_with_provenance_records(
            &history_path,
            &projects_dir,
            None,
            Some(HashMap::new()),
        )
        .expect("load history");
        let session = sessions
            .into_iter()
            .find(|session| session.id == "session-1")
            .expect("session should be indexed");

        assert_eq!(session.project, "/Users/g/cc-home");
        assert_eq!(session.project_name, "cc-home");
        assert_eq!(session.display, "Say exactly ok");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn test_claude_conversation_file_accepts_mixed_content_shapes() {
        let root = temp_history_dir("mixed-content-shapes");
        let session_path = root.join("session-mixed.jsonl");
        fs::write(
            &session_path,
            concat!(
                "{\"type\":\"progress\",\"cwd\":\"/Users/g/cc-home\",\"sessionId\":\"session-mixed\",\"timestamp\":\"2026-03-11T15:43:34.800Z\"}\n",
                "{\"not\":\"valid conversation\"}\n",
                "{\"type\":\"user\",\"uuid\":\"user-1\",\"timestamp\":\"2026-03-11T15:43:34.817Z\",\"message\":{\"content\":\"Native prompt\"}}\n",
                "{\"type\":\"assistant\",\"uuid\":\"assistant-1\",\"timestamp\":\"2026-03-11T15:43:40.817Z\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"CLI reply\"}],\"model\":\"claude-test\"}}\n"
            ),
        )
        .expect("write mixed session file");

        let (messages, segments) =
            parse_claude_conversation_file(&session_path).expect("parse conversation");

        assert_eq!(messages.len(), 2);
        assert_eq!(segments[0].message_count, 2);
        assert_eq!(messages[0].msg_type, "user");
        assert_eq!(
            messages[0].content,
            serde_json::Value::String("Native prompt".to_string())
        );
        assert_eq!(messages[1].msg_type, "assistant");
        assert_eq!(messages[1].model.as_deref(), Some("claude-test"));
        assert!(
            matches!(&messages[1].content, serde_json::Value::Array(blocks) if blocks.len() == 1)
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn test_subagent_discovery_and_prompt_correlation() {
        let root = temp_history_dir("subagents");
        let main_path = root.join("session-sub.jsonl");
        // Main transcript: an Agent tool_use (with subagent_type/description/prompt)
        // followed by its tool_result. The prompt must match the sub-agent file's
        // first user message so enrichment can correlate them.
        fs::write(
            &main_path,
            concat!(
                "{\"type\":\"user\",\"uuid\":\"u1\",\"timestamp\":\"2026-06-14T10:00:00.000Z\",\"message\":{\"content\":\"go\"}}\n",
                "{\"type\":\"assistant\",\"uuid\":\"a1\",\"timestamp\":\"2026-06-14T10:00:01.000Z\",\"message\":{\"content\":[",
                "{\"type\":\"tool_use\",\"id\":\"call_1\",\"name\":\"Agent\",\"input\":{\"subagent_type\":\"Explore\",\"description\":\"Find transcript rendering\",\"prompt\":\"Search the codebase for transcript logic\"}}",
                "],\"model\":\"claude-test\"}}\n",
                "{\"type\":\"user\",\"uuid\":\"u2\",\"timestamp\":\"2026-06-14T10:00:05.000Z\",\"message\":{\"content\":[",
                "{\"type\":\"tool_result\",\"tool_use_id\":\"call_1\",\"content\":[{\"type\":\"text\",\"text\":\"Found 3 files\"}]}",
                "]}}\n"
            ),
        )
        .expect("write main transcript");

        let subagents_dir = root.join("subagents");
        fs::create_dir_all(&subagents_dir).expect("create subagents dir");
        // Sub-agent file: first line is the dispatch prompt (must match input.prompt),
        // then an assistant turn with one tool_use (so tool_count >= 1).
        fs::write(
            subagents_dir.join("agent-deadbeef.jsonl"),
            concat!(
                "{\"type\":\"user\",\"uuid\":\"s1\",\"timestamp\":\"2026-06-14T10:00:02.000Z\",\"agentId\":\"deadbeef\",\"isSidechain\":true,\"message\":{\"content\":\"Search the codebase for transcript logic\"}}\n",
                "{\"type\":\"assistant\",\"uuid\":\"s2\",\"timestamp\":\"2026-06-14T10:00:03.000Z\",\"agentId\":\"deadbeef\",\"isSidechain\":true,\"message\":{\"content\":[",
                "{\"type\":\"text\",\"text\":\"looking...\"},",
                "{\"type\":\"tool_use\",\"id\":\"call_x\",\"name\":\"Grep\",\"input\":{\"pattern\":\"transcript\"}}",
                "],\"model\":\"claude-test\"}}\n"
            ),
        )
        .expect("write subagent file");

        let mut metas = discover_subagent_metas(&subagents_dir);
        assert_eq!(metas.len(), 1, "should discover one sub-agent file");
        assert_eq!(metas[0].agent_id, "deadbeef");
        assert!(metas[0].tool_count >= 1, "should count the tool_use");
        assert_eq!(metas[0].status, "running", "pre-enrich default is running");

        enrich_subagent_metas(&mut metas, &main_path);
        let meta = &metas[0];
        assert_eq!(meta.subagent_type.as_deref(), Some("Explore"));
        assert_eq!(
            meta.description.as_deref(),
            Some("Find transcript rendering")
        );
        assert_eq!(meta.status, "completed");
        assert_eq!(meta.result_summary.as_deref(), Some("Found 3 files"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn test_subagent_enrichment_uses_real_session_subdirectory_and_sidecar_meta() {
        let root = temp_history_dir("subagents-real-layout");
        let project_dir = root.join("project");
        let session_id = "session-real";
        fs::create_dir_all(&project_dir).expect("create project dir");
        let main_path = project_dir.join(format!("{session_id}.jsonl"));
        fs::write(
            &main_path,
            concat!(
                "{\"type\":\"assistant\",\"uuid\":\"a1\",\"timestamp\":\"2026-06-14T10:00:01.000Z\",\"message\":{\"content\":[",
                "{\"type\":\"tool_use\",\"id\":\"call_1\",\"name\":\"Agent\",\"input\":{\"subagent_type\":\"general-purpose\",\"description\":\"Old prompt description\",\"prompt\":\"Prompt text from parent\"}}",
                "],\"model\":\"claude-test\"}}\n",
                "{\"type\":\"user\",\"uuid\":\"u2\",\"timestamp\":\"2026-06-14T10:00:05.000Z\",\"message\":{\"content\":[",
                "{\"type\":\"tool_result\",\"tool_use_id\":\"call_1\",\"content\":\"Done\\nagentId: a123\"}",
                "]}}\n"
            ),
        )
        .expect("write main transcript");

        let subagents_dir = project_dir.join(session_id).join("subagents");
        fs::create_dir_all(&subagents_dir).expect("create subagents dir");
        fs::write(
            subagents_dir.join("agent-a123.meta.json"),
            "{\"agentType\":\"reviewer\",\"description\":\"Sidecar reviewer\"}\n",
        )
        .expect("write sidecar");
        fs::write(
            subagents_dir.join("agent-a123.jsonl"),
            concat!(
                "{\"type\":\"user\",\"uuid\":\"s1\",\"timestamp\":\"2026-06-14T10:00:02.000Z\",\"agentId\":\"a123\",\"isSidechain\":true,\"message\":{\"content\":\"Different prompt text\"}}\n",
                "{\"type\":\"assistant\",\"uuid\":\"s2\",\"timestamp\":\"2026-06-14T10:00:03.000Z\",\"agentId\":\"a123\",\"isSidechain\":true,\"message\":{\"content\":[",
                "{\"type\":\"text\",\"text\":\"checking\"},",
                "{\"type\":\"tool_use\",\"id\":\"call_x\",\"name\":\"Read\",\"input\":{\"file_path\":\"src/main.rs\"}}",
                "],\"model\":\"claude-test\"}}\n"
            ),
        )
        .expect("write subagent file");

        let mut records = discover_subagent_records(&subagents_dir);
        assert_eq!(records.len(), 1);
        enrich_subagent_records(&mut records, &main_path);
        let meta = &records[0].meta;
        assert_eq!(meta.agent_id, "a123");
        assert_eq!(meta.subagent_type.as_deref(), Some("reviewer"));
        assert_eq!(meta.description.as_deref(), Some("Sidecar reviewer"));
        assert_eq!(meta.status, "completed");
        assert_eq!(meta.completed_at, Some(1_781_431_203_000));
        assert_eq!(meta.result_summary.as_deref(), Some("Done\nagentId: a123"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn test_claude_conversation_file_filters_command_artifacts() {
        let root = temp_history_dir("command-artifacts");
        let session_path = root.join("session-command-noise.jsonl");
        fs::write(
            &session_path,
            concat!(
                "{\"type\":\"user\",\"uuid\":\"model-command\",\"timestamp\":\"2026-03-11T15:43:34.817Z\",\"message\":{\"content\":\"<command-name>/model</command-name>\\n            <command-message>model</command-message>\\n            <command-args>default</command-args>\"}}\n",
                "{\"type\":\"user\",\"uuid\":\"model-stdout\",\"timestamp\":\"2026-03-11T15:43:34.818Z\",\"message\":{\"content\":\"<local-command-stdout>Set model to glm-4.7</local-command-stdout>\"}}\n",
                "{\"type\":\"assistant\",\"uuid\":\"no-response\",\"timestamp\":\"2026-03-11T15:43:34.819Z\",\"message\":{\"model\":\"<synthetic>\",\"content\":[{\"type\":\"text\",\"text\":\"No response requested.\"}]}}\n",
                "{\"type\":\"user\",\"uuid\":\"real-user\",\"timestamp\":\"2026-03-11T15:43:34.820Z\",\"message\":{\"content\":\"真正的问题\"}}\n",
                "{\"type\":\"assistant\",\"uuid\":\"real-assistant\",\"timestamp\":\"2026-03-11T15:43:40.817Z\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"真正的回答\"}],\"model\":\"claude-test\"}}\n"
            ),
        )
        .expect("write command-noise session file");

        let (messages, segments) =
            parse_claude_conversation_file(&session_path).expect("parse conversation");

        assert_eq!(messages.len(), 2);
        assert_eq!(segments[0].message_count, 2);
        assert_eq!(messages[0].msg_type, "user");
        assert_eq!(
            messages[0].content,
            serde_json::Value::String("真正的问题".to_string())
        );
        assert_eq!(messages[1].msg_type, "assistant");
        assert_eq!(messages[1].model.as_deref(), Some("claude-test"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn test_claude_conversation_file_preserves_wrapped_requests_and_meta_images() {
        let root = temp_history_dir("wrapped-user-request");
        let session_path = root.join("session-wrapped-user-request.jsonl");
        let wrapped_prompt = concat!(
            "<command-message>lightweight-dev-mode</command-message>\n",
            "<command-name>/lightweight-dev-mode</command-name>\n",
            "<command-args> workspace 审查 - 改动的文件 现在没法支持多媒体\n",
            "</user_request></command-args>"
        );
        let selected_skill_prompt = concat!(
            "<selected_skills><skill name=\"finishing-a-development-branch\" /></selected_skills>\n",
            "<user_request>/superpowers:finishing-a-development-branch merge back main</user_request>"
        );
        let lines = [
            serde_json::json!({
                "type": "user",
                "uuid": "prompt-1",
                "timestamp": "2026-07-09T15:03:56.337Z",
                "message": { "content": wrapped_prompt }
            }),
            serde_json::json!({
                "type": "user",
                "uuid": "meta-1",
                "parentUuid": "prompt-1",
                "isMeta": true,
                "timestamp": "2026-07-09T15:03:56.337Z",
                "message": {
                    "content": [
                        { "type": "text", "text": "<selected_skills>metadata</selected_skills>" },
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/png",
                                "data": "iVBORw0KGgo="
                            }
                        },
                        { "type": "text", "text": "Base directory for this skill: /tmp/skill" }
                    ]
                }
            }),
            serde_json::json!({
                "type": "assistant",
                "uuid": "assistant-1",
                "timestamp": "2026-07-09T15:04:05.946Z",
                "message": {
                    "content": [{ "type": "text", "text": "开始处理" }],
                    "model": "claude-test"
                }
            }),
            serde_json::json!({
                "type": "user",
                "uuid": "prompt-2",
                "timestamp": "2026-07-09T15:17:25.645Z",
                "message": { "content": selected_skill_prompt }
            }),
        ]
        .into_iter()
        .map(|line| line.to_string())
        .collect::<Vec<_>>()
        .join("\n");
        fs::write(&session_path, format!("{lines}\n")).expect("write wrapped session file");

        let (messages, segments) =
            parse_claude_conversation_file(&session_path).expect("parse wrapped session");

        assert_eq!(messages.len(), 3);
        assert_eq!(segments[0].message_count, 3);
        let first_blocks = messages[0]
            .content
            .as_array()
            .expect("wrapped prompt should include its image");
        assert_eq!(first_blocks.len(), 2);
        assert_eq!(
            first_blocks[0]
                .get("text")
                .and_then(serde_json::Value::as_str),
            Some("workspace 审查 - 改动的文件 现在没法支持多媒体")
        );
        assert_eq!(
            first_blocks[1]
                .get("type")
                .and_then(serde_json::Value::as_str),
            Some("image")
        );
        assert_eq!(
            messages[2].content,
            serde_json::Value::String(
                "/superpowers:finishing-a-development-branch merge back main".to_string()
            )
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn test_claude_history_merges_project_metadata_into_indexed_sessions() {
        let root = temp_history_dir("merge");
        let history_path = root.join("history.jsonl");
        let projects_dir = root.join("projects");
        let project_dir = projects_dir.join("-Users-g-cc-home");
        fs::create_dir_all(&project_dir).expect("create project dir");

        fs::write(
            &history_path,
            "{\"display\":\"/new my-topic\",\"timestamp\":1773243810000,\"project\":\"\",\"sessionId\":\"session-2\"}\n",
        )
        .expect("write history index");

        fs::write(
            project_dir.join("session-2.jsonl"),
            concat!(
                "{\"type\":\"progress\",\"cwd\":\"/Users/g/cc-home\",\"sessionId\":\"session-2\",\"timestamp\":\"2026-03-11T15:43:34.800Z\"}\n",
                "{\"type\":\"user\",\"sessionId\":\"session-2\",\"timestamp\":\"2026-03-11T15:43:34.817Z\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Real follow-up\"}]}}\n"
            ),
        )
        .expect("write session file");

        let sessions = load_claude_history_from_paths_limited_with_provenance_records(
            &history_path,
            &projects_dir,
            None,
            Some(HashMap::new()),
        )
        .expect("load history");
        let session = sessions
            .into_iter()
            .find(|session| session.id == "session-2")
            .expect("session should be merged");

        assert_eq!(session.project, "/Users/g/cc-home");
        assert_eq!(session.project_name, "cc-home");
        assert_eq!(session.display, "Real follow-up");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn test_claude_project_index_ignores_meta_skill_payload_for_title() {
        let root = temp_history_dir("meta-skip");
        let history_path = root.join("history.jsonl");
        let projects_dir = root.join("projects");
        let project_dir = projects_dir.join("-Users-g-ccem");
        fs::create_dir_all(&project_dir).expect("create project dir");

        fs::write(
            project_dir.join("session-1.jsonl"),
            concat!(
                "{\"type\":\"user\",\"sessionId\":\"session-1\",\"timestamp\":\"2026-03-31T15:54:28.964Z\",\"cwd\":\"/Users/g/ccem\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Base directory for this skill: /Users/g/.claude/skills/foo\\n\\nARGUMENTS: hello\"}]},\"isMeta\":true}\n",
                "{\"type\":\"file-history-snapshot\",\"sessionId\":\"session-1\",\"timestamp\":\"2026-03-31T15:54:29.000Z\",\"cwd\":\"/Users/g/ccem\"}\n"
            ),
        )
        .expect("write session file");

        let sessions = load_claude_history_from_paths_limited_with_provenance_records(
            &history_path,
            &projects_dir,
            None,
            Some(HashMap::new()),
        )
        .expect("load history");
        let session = sessions
            .into_iter()
            .find(|session| session.id == "session-1")
            .expect("session should be indexed");

        assert_eq!(session.project, "/Users/g/ccem");
        assert_eq!(session.project_name, "ccem");
        assert_eq!(session.display, "");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn test_dedupe_near_duplicate_history_sessions_prefers_ccem_metadata() {
        let sessions = vec![
            HistorySession {
                id: "session-ccem".to_string(),
                source: SOURCE_CLAUDE.to_string(),
                display: "9.9-9.11=？".to_string(),
                timestamp: 1_776_489_728_117,
                project: "/Users/g/baymax".to_string(),
                project_name: "baymax".to_string(),
                env_name: Some("3891".to_string()),
                config_source: Some("ccem".to_string()),
                task_stage: None,
                task_sticker: None,
                task_label: None,
            },
            HistorySession {
                id: "session-plain".to_string(),
                source: SOURCE_CLAUDE.to_string(),
                display: "9.9-9.11=？".to_string(),
                timestamp: 1_776_489_728_586,
                project: "/Users/g/baymax".to_string(),
                project_name: "baymax".to_string(),
                env_name: None,
                config_source: None,
                task_stage: None,
                task_sticker: None,
                task_label: None,
            },
            HistorySession {
                id: "session-later".to_string(),
                source: SOURCE_CLAUDE.to_string(),
                display: "9.9-9.11=？".to_string(),
                timestamp: 1_776_489_735_000,
                project: "/Users/g/baymax".to_string(),
                project_name: "baymax".to_string(),
                env_name: Some("3891".to_string()),
                config_source: Some("ccem".to_string()),
                task_stage: None,
                task_sticker: None,
                task_label: None,
            },
        ];

        let deduped = dedupe_near_duplicate_history_sessions(sessions);

        assert_eq!(deduped.len(), 2);

        let merged = deduped
            .iter()
            .find(|session| session.id == "session-ccem")
            .expect("near duplicate should keep the ccem session");
        assert_eq!(merged.timestamp, 1_776_489_728_586);
        assert_eq!(merged.env_name.as_deref(), Some("3891"));
        assert_eq!(merged.config_source.as_deref(), Some("ccem"));

        assert!(deduped.iter().any(|session| session.id == "session-later"));
    }

    #[test]
    fn test_dedupe_history_sessions_merges_workspace_runtime_aliases() {
        let records = vec![SessionProvenanceRecord {
            ccem_session_id: "native-1776489728117".to_string(),
            client: SOURCE_CLAUDE.to_string(),
            source_session_id: "provider-session-1".to_string(),
            env_name: "3891".to_string(),
            config_source: Some("ccem".to_string()),
            working_dir: "/Users/g/baymax".to_string(),
            perm_mode: Some("dev".to_string()),
            launch_mode: "native_sdk".to_string(),
            started_via: "desktop".to_string(),
            created_at: "2026-04-17T12:00:00Z".to_string(),
            updated_at: "2026-04-17T12:00:02Z".to_string(),
        }];
        let sessions = vec![
            HistorySession {
                id: "native-1776489728117".to_string(),
                source: SOURCE_CLAUDE.to_string(),
                display: "整理工作间会话关系".to_string(),
                timestamp: 1_776_489_728_117,
                project: "/Users/g/baymax".to_string(),
                project_name: "baymax".to_string(),
                env_name: Some("3891".to_string()),
                config_source: Some("ccem".to_string()),
                task_stage: None,
                task_sticker: None,
                task_label: None,
            },
            HistorySession {
                id: "provider-session-1".to_string(),
                source: SOURCE_CLAUDE.to_string(),
                display: "整理工作间会话关系".to_string(),
                timestamp: 1_776_489_738_586,
                project: "/Users/g/baymax".to_string(),
                project_name: "baymax".to_string(),
                env_name: None,
                config_source: None,
                task_stage: None,
                task_sticker: None,
                task_label: None,
            },
        ];

        let deduped = dedupe_history_sessions_with_provenance_records(sessions, &records);

        assert_eq!(deduped.len(), 1);
        let merged = deduped.first().expect("merged session");
        assert_eq!(merged.id, "provider-session-1");
        assert_eq!(merged.timestamp, 1_776_489_738_586);
        assert_eq!(merged.env_name.as_deref(), Some("3891"));
        assert_eq!(merged.config_source.as_deref(), Some("ccem"));
    }

    #[test]
    fn test_dedupe_history_sessions_keeps_runtime_id_until_provider_history_exists() {
        let records = vec![SessionProvenanceRecord {
            ccem_session_id: "native-1776489728117".to_string(),
            client: SOURCE_CLAUDE.to_string(),
            source_session_id: "provider-session-1".to_string(),
            env_name: "3891".to_string(),
            config_source: Some("ccem".to_string()),
            working_dir: "/Users/g/baymax".to_string(),
            perm_mode: Some("dev".to_string()),
            launch_mode: "native_sdk".to_string(),
            started_via: "desktop".to_string(),
            created_at: "2026-04-17T12:00:00Z".to_string(),
            updated_at: "2026-04-17T12:00:02Z".to_string(),
        }];
        let sessions = vec![HistorySession {
            id: "native-1776489728117".to_string(),
            source: SOURCE_CLAUDE.to_string(),
            display: "整理工作间会话关系".to_string(),
            timestamp: 1_776_489_728_117,
            project: "/Users/g/baymax".to_string(),
            project_name: "baymax".to_string(),
            env_name: Some("3891".to_string()),
            config_source: Some("ccem".to_string()),
            task_stage: None,
            task_sticker: None,
            task_label: None,
        }];

        let deduped = dedupe_history_sessions_with_provenance_records(sessions, &records);

        assert_eq!(deduped.len(), 1);
        assert_eq!(deduped[0].id, "native-1776489728117");
    }

    #[test]
    fn test_codex_history_uses_session_index_when_history_missing() {
        let root = temp_history_dir("codex-session-index");
        let sqlite_home = root.join("sqlite");
        write_codex_session_file(
            &root,
            "019d8ca8-cf4d-74e2-be37-5554a73ec50a",
            "/Users/g/ccem",
        );
        fs::write(
            root.join("session_index.jsonl"),
            "{\"id\":\"019d8ca8-cf4d-74e2-be37-5554a73ec50a\",\"thread_name\":\"排查 ccem 无法抓取 Codex 聊天记录\",\"updated_at\":\"2026-04-14T15:43:05.46082Z\"}\n",
        )
        .expect("write session index");

        let config = temp_codex_config(&root, &sqlite_home);
        let sessions = load_codex_history_from_config(&config).expect("load codex history");
        let session = sessions
            .into_iter()
            .find(|session| session.id == "019d8ca8-cf4d-74e2-be37-5554a73ec50a")
            .expect("session should exist");

        assert_eq!(session.display, "排查 ccem 无法抓取 Codex 聊天记录");
        assert_eq!(session.project, "/Users/g/ccem");
        assert_eq!(session.project_name, "ccem");
        assert!(session.timestamp > 0);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn test_codex_history_uses_sqlite_threads_when_session_index_missing() {
        let root = temp_history_dir("codex-sqlite-only");
        let sqlite_home = root.join("sqlite");
        let rollout_path = write_codex_session_file(
            &root,
            "019d8c8b-16d2-7c22-bb28-dfe820b21994",
            "/Users/g/sqlite",
        );

        create_state_db(
            &sqlite_home,
            "state_9.sqlite",
            &[&format!(
                concat!(
                    "INSERT INTO threads (",
                    "id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode",
                    ") VALUES (",
                    "'019d8c8b-16d2-7c22-bb28-dfe820b21994', '{}', 1776183186, 1776183187, 'vscode', 'openai', '/Users/g/sqlite', 'SQLite 标题', 'workspace-write', 'never'",
                    ");"
                ),
                rollout_path.display()
            )],
        );

        let config = temp_codex_config(&root, &sqlite_home);
        let sessions = load_codex_history_from_config(&config).expect("load codex history");
        let session = sessions
            .into_iter()
            .find(|session| session.id == "019d8c8b-16d2-7c22-bb28-dfe820b21994")
            .expect("session should exist");

        assert_eq!(session.display, "SQLite 标题");
        assert_eq!(session.project, "/Users/g/sqlite");
        assert_eq!(session.project_name, "sqlite");
        assert!(session.timestamp >= 1_776_183_187_000);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn test_codex_history_collapses_subagent_rollouts_under_parent_thread() {
        let root = temp_history_dir("codex-subagent-collapse");
        let sqlite_home = root.join("sqlite");
        let parent_id = "019dd43b-1460-7621-af7b-d05a495ee171";
        let subagent_a = "019dd510-a117-7a63-b574-9051b6f1ba9b";
        let subagent_b = "019dd510-a257-7bb0-930b-e9b8716317cd";
        let parent_path = write_codex_session_file(&root, parent_id, "/Users/g/Github/AG");
        let subagent_a_path =
            write_codex_subagent_session_file(&root, subagent_a, parent_id, "/Users/g/Github/AG");
        let subagent_b_path =
            write_codex_subagent_session_file(&root, subagent_b, parent_id, "/Users/g/Github/AG");

        create_state_db(
            &sqlite_home,
            "state_5.sqlite",
            &[
                &format!(
                    concat!(
                        "INSERT INTO threads (",
                        "id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode",
                        ") VALUES (",
                        "'{}', '{}', 1776182000, 1776182001, 'vscode', 'openai', '/Users/g/Github/AG', 'Parent title', 'workspace-write', 'never'",
                        ");"
                    ),
                    parent_id,
                    parent_path.display()
                ),
                &format!(
                    concat!(
                        "INSERT INTO threads (",
                        "id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode",
                        ") VALUES (",
                        "'{}', '{}', 1776182100, 1776182101, 'vscode', 'openai', '/Users/g/Github/AG', 'Parent title', 'workspace-write', 'never'",
                        ");"
                    ),
                    subagent_a,
                    subagent_a_path.display()
                ),
                &format!(
                    concat!(
                        "INSERT INTO threads (",
                        "id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode",
                        ") VALUES (",
                        "'{}', '{}', 1776182200, 1776182201, 'vscode', 'openai', '/Users/g/Github/AG', 'Parent title', 'workspace-write', 'never'",
                        ");"
                    ),
                    subagent_b,
                    subagent_b_path.display()
                ),
            ],
        );

        let config = temp_codex_config(&root, &sqlite_home);
        let sessions = load_codex_history_from_config(&config).expect("load codex history");

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, parent_id);
        assert_eq!(sessions[0].display, "Parent title");
        assert_eq!(sessions[0].project, "/Users/g/Github/AG");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn test_codex_history_keeps_titled_subagent_rollouts() {
        let root = temp_history_dir("codex-subagent-keep-titled");
        let sqlite_home = root.join("sqlite");
        let parent_id = "019dd43b-1460-7621-af7b-d05a495ee171";
        let subagent_id = "019dd4ea-e946-7930-82a1-96429b98aca9";
        let parent_path = write_codex_session_file(&root, parent_id, "/Users/g/Github/AG");
        let subagent_path =
            write_codex_subagent_session_file(&root, subagent_id, parent_id, "/Users/g/Github/AG");

        create_state_db(
            &sqlite_home,
            "state_5.sqlite",
            &[
                &format!(
                    concat!(
                        "INSERT INTO threads (",
                        "id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode",
                        ") VALUES (",
                        "'{}', '{}', 1776182000, 1776182001, 'vscode', 'openai', '/Users/g/Github/AG', 'Parent title', 'workspace-write', 'never'",
                        ");"
                    ),
                    parent_id,
                    parent_path.display()
                ),
                &format!(
                    concat!(
                        "INSERT INTO threads (",
                        "id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode",
                        ") VALUES (",
                        "'{}', '{}', 1776182100, 1776182101, 'vscode', 'openai', '/Users/g/Github/AG', 'Child task title', 'workspace-write', 'never'",
                        ");"
                    ),
                    subagent_id,
                    subagent_path.display()
                ),
            ],
        );

        let config = temp_codex_config(&root, &sqlite_home);
        let sessions = load_codex_history_from_config(&config).expect("load codex history");

        assert_eq!(sessions.len(), 2);
        assert!(sessions
            .iter()
            .any(|session| session.id == parent_id && session.display == "Parent title"));
        assert!(sessions
            .iter()
            .any(|session| session.id == subagent_id && session.display == "Child task title"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn test_codex_title_precedence_prefers_session_index_then_sqlite_then_history() {
        let root = temp_history_dir("codex-precedence");
        let sqlite_home = root.join("sqlite");
        let rollout_path = write_codex_session_file(
            &root,
            "019d7d58-6c57-76d3-8712-d9126006a5cb",
            "/Users/g/ccem",
        );
        fs::write(
            root.join("history.jsonl"),
            "{\"session_id\":\"019d7d58-6c57-76d3-8712-d9126006a5cb\",\"ts\":1776183000,\"text\":\"历史标题\"}\n",
        )
        .expect("write history");
        fs::write(
            root.join("session_index.jsonl"),
            "{\"id\":\"019d7d58-6c57-76d3-8712-d9126006a5cb\",\"thread_name\":\"Session Index 标题\",\"updated_at\":\"2026-04-14T15:43:05.46082Z\"}\n",
        )
        .expect("write session index");
        create_state_db(
            &sqlite_home,
            "state_2.sqlite",
            &[&format!(
                concat!(
                    "INSERT INTO threads (",
                    "id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode",
                    ") VALUES (",
                    "'019d7d58-6c57-76d3-8712-d9126006a5cb', '{}', 1776182000, 1776182001, 'vscode', 'openai', '/Users/g/sqlite', 'SQLite 标题', 'workspace-write', 'never'",
                    ");"
                ),
                rollout_path.display()
            )],
        );

        let config = temp_codex_config(&root, &sqlite_home);
        let sessions = load_codex_history_from_config(&config).expect("load codex history");
        let session = sessions
            .into_iter()
            .find(|session| session.id == "019d7d58-6c57-76d3-8712-d9126006a5cb")
            .expect("session should exist");

        assert_eq!(session.display, "Session Index 标题");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn test_resolve_codex_paths_honors_env_and_config() {
        let root = temp_history_dir("codex-paths");
        let home_dir = root.join("home");
        let codex_home = root.join("custom-codex");
        let sqlite_from_config = root.join("sqlite-from-config");
        fs::create_dir_all(&home_dir).expect("create home");
        fs::create_dir_all(&codex_home).expect("create codex home");
        fs::write(
            codex_home.join("config.toml"),
            "sqlite_home = \"sqlite-from-config\"\n",
        )
        .expect("write config");

        let resolved = resolve_codex_path_config_from(
            Some(home_dir.as_path()),
            Some(codex_home.to_str().expect("utf8 path")),
            None,
        )
        .expect("resolve codex path config");

        assert_eq!(resolved.codex_home, codex_home);
        assert_eq!(resolved.sqlite_home, codex_home.join("sqlite-from-config"));

        let env_override = root.join("sqlite-from-env");
        let overridden = resolve_codex_path_config_from(
            Some(home_dir.as_path()),
            Some(codex_home.to_str().expect("utf8 path")),
            Some(env_override.to_str().expect("utf8 path")),
        )
        .expect("resolve codex path config with env override");

        assert_eq!(overridden.sqlite_home, env_override);

        let defaulted = resolve_codex_path_config_from(Some(home_dir.as_path()), None, None)
            .expect("resolve default config");
        assert_eq!(defaulted.codex_home, home_dir.join(".codex"));
        assert_eq!(defaulted.sqlite_home, home_dir.join(".codex"));
        assert_eq!(resolved.sqlite_home, codex_home.join("sqlite-from-config"));
        assert_ne!(sqlite_from_config, resolved.sqlite_home);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn test_threads_rollout_path_is_used_for_session_lookup() {
        let root = temp_history_dir("codex-find-rollout");
        let sqlite_home = root.join("sqlite");
        let rollout_path = write_codex_session_file(
            &root,
            "019cbc5a-5720-7451-905e-84b96a508abb",
            "/Users/g/state",
        );
        create_state_db(
            &sqlite_home,
            "state_5.sqlite",
            &[&format!(
                concat!(
                    "INSERT INTO threads (",
                    "id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode",
                    ") VALUES (",
                    "'019cbc5a-5720-7451-905e-84b96a508abb', '{}', 1776181000, 1776181001, 'vscode', 'openai', '/Users/g/state', 'State title', 'workspace-write', 'never'",
                    ");"
                ),
                rollout_path.display()
            )],
        );

        let config = temp_codex_config(&root, &sqlite_home);
        let found =
            find_codex_session_file_with_config("019cbc5a-5720-7451-905e-84b96a508abb", &config)
                .expect("find rollout path");

        assert_eq!(found, rollout_path);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn test_invalid_sqlite_falls_back_to_session_index_and_sessions() {
        let root = temp_history_dir("codex-invalid-sqlite");
        let sqlite_home = root.join("sqlite");
        write_codex_session_file(
            &root,
            "019cc871-ada9-7a30-a350-f7d9ef7771a7",
            "/Users/g/fallback",
        );
        fs::create_dir_all(&sqlite_home).expect("create sqlite dir");
        fs::write(sqlite_home.join("state_999.sqlite"), "not a sqlite file")
            .expect("write bad sqlite");
        fs::write(
            root.join("session_index.jsonl"),
            "{\"id\":\"019cc871-ada9-7a30-a350-f7d9ef7771a7\",\"thread_name\":\"Fallback 标题\",\"updated_at\":\"2026-04-14T15:14:18.712062Z\"}\n",
        )
        .expect("write session index");

        let config = temp_codex_config(&root, &sqlite_home);
        let sessions = load_codex_history_from_config(&config).expect("load codex history");
        let session = sessions
            .into_iter()
            .find(|session| session.id == "019cc871-ada9-7a30-a350-f7d9ef7771a7")
            .expect("session should exist");

        assert_eq!(session.display, "Fallback 标题");
        assert_eq!(session.project, "/Users/g/fallback");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn test_newer_invalid_state_db_falls_back_to_older_valid_db() {
        let root = temp_history_dir("codex-fallback-older-valid-db");
        let sqlite_home = root.join("sqlite");
        let rollout_path = write_codex_session_file(
            &root,
            "019dd111-aaaa-7bbb-8ccc-1234567890ab",
            "/Users/g/fallback-sqlite",
        );

        create_state_db(
            &sqlite_home,
            "state_4.sqlite",
            &[&format!(
                concat!(
                    "INSERT INTO threads (",
                    "id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode",
                    ") VALUES (",
                    "'019dd111-aaaa-7bbb-8ccc-1234567890ab', '{}', 1776186000, 1776186001, 'vscode', 'openai', '/Users/g/fallback-sqlite', 'Older valid SQLite 标题', 'workspace-write', 'never'",
                    ");"
                ),
                rollout_path.display()
            )],
        );

        std::thread::sleep(Duration::from_millis(20));
        fs::write(sqlite_home.join("state_5.sqlite"), "not a sqlite file")
            .expect("write newer invalid sqlite");

        let config = temp_codex_config(&root, &sqlite_home);
        let sessions = load_codex_history_from_config(&config).expect("load codex history");
        let session = sessions
            .into_iter()
            .find(|session| session.id == "019dd111-aaaa-7bbb-8ccc-1234567890ab")
            .expect("session should exist");

        assert_eq!(session.display, "Older valid SQLite 标题");
        assert_eq!(session.project, "/Users/g/fallback-sqlite");
        assert_eq!(session.project_name, "fallback-sqlite");

        let _ = fs::remove_dir_all(root);
    }
}

// ============================================================================
// Production orchestration seams (testable without AppHandle)
// ============================================================================

/// Production orchestration seam for history list.
/// Combines legacy + DSH results, builds diagnostics, dedupes, and finalizes.
pub fn orchestrate_history_list(
    source_filter: Option<&'static str>,
    limit: Option<usize>,
    legacy_sessions: Vec<HistorySession>,
    dsh_result: Option<Result<(Vec<HistorySession>, Vec<String>), DshListError>>,
) -> Result<HistoryListResult, HistoryCommandError> {
    let mut sessions = legacy_sessions;
    let mut diagnostics = Vec::new();

    if let Some(dsh_res) = dsh_result {
        match dsh_res {
            Ok((dsh_sessions, dsh_warnings)) => {
                sessions.extend(dsh_sessions);
                for w in dsh_warnings {
                    diagnostics.push(SourceDiagnostic {
                        source: SOURCE_DSH.to_string(),
                        code: "helper_warning".to_string(),
                        message: w,
                    });
                }
            }
            Err(err) => {
                if source_filter == Some(SOURCE_DSH) {
                    return Err(HistoryCommandError {
                        code: err.code,
                        message: format!("DSH: {}", err.message),
                    });
                }
                diagnostics.push(SourceDiagnostic {
                    source: SOURCE_DSH.to_string(),
                    code: err.code,
                    message: err.message,
                });
            }
        }
    }

    sessions = dedupe_history_sessions(sessions);
    sessions.sort_by_key(|session| std::cmp::Reverse(session.timestamp));
    finalize_history_sessions(&mut sessions);

    if let Some(lim) = limit {
        sessions.truncate(lim);
    }

    Ok(HistoryListResult { sessions, diagnostics })
}

/// Production orchestration seam for history detail.
/// Called by get_conversation_detail IPC command — this IS the production path.
/// Resolves DSH vs legacy, merges tool results, propagates warnings.
pub fn orchestrate_history_detail(
    _session_id: &str,
    source_hint: Option<&'static str>,
    dsh_result: Option<Result<(Vec<ConversationMessage>, Vec<CompactSegment>, Vec<String>), String>>,
    legacy_result: Option<Result<(Vec<ConversationMessage>, Vec<CompactSegment>), String>>,
) -> Result<ConversationDetailPayload, HistoryCommandError> {
    if source_hint == Some(SOURCE_DSH) {
        let result = dsh_result.unwrap_or_else(|| Err("DSH result not provided".to_string()));
        match result {
            Ok((messages, segments, warnings)) => Ok(ConversationDetailPayload {
                messages: merge_tool_results_into_messages(messages),
                segments,
                tool_results_merged: true,
                warnings,
            }),
            Err(e) => Err(HistoryCommandError {
                code: "dsh_detail_error".to_string(),
                message: e,
            }),
        }
    } else {
        let result = legacy_result.unwrap_or_else(|| Ok((vec![], vec![])));
        match result {
            Ok((messages, segments)) => Ok(ConversationDetailPayload {
                messages: merge_tool_results_into_messages(messages),
                segments,
                tool_results_merged: true,
                warnings: vec![],
            }),
            Err(e) => Err(HistoryCommandError {
                code: "legacy_detail_error".to_string(),
                message: e,
            }),
        }
    }
}

/// Validate a launch client name. Only claude, codex, opencode are allowed.
/// Returns the normalized lowercase client name or an error.
pub fn validate_launch_client(client: Option<&str>) -> Result<String, String> {
    let name = client.unwrap_or("claude").to_lowercase();
    if name != "claude" && name != "codex" && name != "opencode" {
        return Err(format!("Unsupported client '{}'", name));
    }
    Ok(name)
}

#[cfg(test)]
mod dsh_integration_tests {
    use super::*;

    // --- Fixtures matching real Phase 1 helper DTOs ---

    fn fixture_list_item() -> dsh_history::DshSessionListItem {
        dsh_history::DshSessionListItem {
            source_instance_id: "abcdef0123456789".to_string(),
            session_id: "sess-001".to_string(),
            cwd: Some("/home/user/project".to_string()),
            project_name: Some("project".to_string()),
            title: Some("Fix authentication bug".to_string()),
            created_at: 1700000000000,
            last_event_at: Some(1700001000000),
            model: Some("deepseek-chat".to_string()),
            provider: Some("deepseek".to_string()),
            parent_session: None,
            seed_length: 0,
            delegation_depth: 0,
            event_count: 5,
            revision: None,
        }
    }

    fn fixture_list_item_no_title() -> dsh_history::DshSessionListItem {
        dsh_history::DshSessionListItem {
            source_instance_id: "1234567890abcdef".to_string(),
            session_id: "sess-002".to_string(),
            cwd: Some("/tmp/myapp".to_string()),
            project_name: None,
            title: None,
            created_at: 1700000500,
            last_event_at: None,
            model: None,
            provider: None,
            parent_session: None,
            seed_length: 0,
            delegation_depth: 0,
            event_count: 2,
            revision: None,
        }
    }

    fn fixture_detail() -> dsh_history::DshSessionDetail {
        dsh_history::DshSessionDetail {
            source_instance_id: "abcdef0123456789".to_string(),
            session_id: "sess-001".to_string(),
            header: dsh_history::DshSessionHeader {
                version: 1,
                id: "sess-001".to_string(),
                created_at: 1700000000000,
                cwd: Some("/home/user/project".to_string()),
                parent_session: None,
                seed_length: 0,
                delegation_depth: 0,
            },
            events: vec![
                dsh_history::DshSurfaceEvent {
                    seq: 1,
                    event_type: "user/message".to_string(),
                    time: Some(1700000000000),
                    role: dsh_history::DshEventRole::User,
                    content: Some(vec![json!({"type": "text", "text": "Fix the login bug"})]),
                    model: None,
                    provider: None,
                },
                dsh_history::DshSurfaceEvent {
                    seq: 2,
                    event_type: "assistant/message".to_string(),
                    time: Some(1700000001000),
                    role: dsh_history::DshEventRole::Assistant,
                    content: Some(vec![json!({"type": "reasoning", "text": "Let me analyze..."})]),
                    model: Some("deepseek-chat".to_string()),
                    provider: Some("deepseek".to_string()),
                },
                dsh_history::DshSurfaceEvent {
                    seq: 3,
                    event_type: "assistant/message".to_string(),
                    time: Some(1700000002000),
                    role: dsh_history::DshEventRole::Assistant,
                    content: Some(vec![json!({
                        "type": "tool-call",
                        "id": "call_001",
                        "name": "read_file",
                        "arguments": "{\"path\":\"src/auth.ts\"}"
                    })]),
                    model: Some("deepseek-chat".to_string()),
                    provider: None,
                },
                dsh_history::DshSurfaceEvent {
                    seq: 4,
                    event_type: "tool/result".to_string(),
                    time: Some(1700000003000),
                    role: dsh_history::DshEventRole::User,
                    content: Some(vec![json!({
                        "type": "tool-result",
                        "toolCallId": "call_001",
                        "content": [{"type": "text", "text": "export function login() { ... }"}],
                        "isError": false
                    })]),
                    model: None,
                    provider: None,
                },
                dsh_history::DshSurfaceEvent {
                    seq: 5,
                    event_type: "assistant/message".to_string(),
                    time: Some(1700000004000),
                    role: dsh_history::DshEventRole::Assistant,
                    content: Some(vec![json!({"type": "text", "text": "I found the issue."})]),
                    model: Some("deepseek-chat".to_string()),
                    provider: None,
                },
            ],
            warnings: vec![],
        }
    }

    // --- normalize_history_source ---

    #[test]
    fn normalize_history_source_accepts_dsh() {
        assert_eq!(normalize_history_source(Some("dsh")).unwrap(), Some(SOURCE_DSH));
        assert_eq!(normalize_history_source(Some("DSH")).unwrap(), Some(SOURCE_DSH));
        assert_eq!(normalize_history_source(Some("Dsh")).unwrap(), Some(SOURCE_DSH));
    }

    #[test]
    fn normalize_history_source_rejects_unknown() {
        let result = normalize_history_source(Some("unknown"));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unsupported source"));
    }

    #[test]
    fn normalize_history_source_accepts_all_known() {
        assert_eq!(normalize_history_source(Some("claude")).unwrap(), Some(SOURCE_CLAUDE));
        assert_eq!(normalize_history_source(Some("codex")).unwrap(), Some(SOURCE_CODEX));
        assert_eq!(normalize_history_source(Some("opencode")).unwrap(), Some(SOURCE_OPENCODE));
        assert_eq!(normalize_history_source(Some("dsh")).unwrap(), Some(SOURCE_DSH));
        assert_eq!(normalize_history_source(None).unwrap(), None);
        assert_eq!(normalize_history_source(Some("all")).unwrap(), None);
        assert_eq!(normalize_history_source(Some("")).unwrap(), None);
    }

    // --- composite ID ---

    #[test]
    fn composite_id_roundtrip() {
        let id = make_dsh_composite_id("abcdef0123456789", "session-123");
        assert_eq!(id, "abcdef0123456789:session-123");
        let (fingerprint, session_id) = parse_dsh_composite_id(&id).unwrap();
        assert_eq!(fingerprint, "abcdef0123456789");
        assert_eq!(session_id, "session-123");
    }

    #[test]
    fn composite_id_rejects_short_fingerprint() {
        assert!(parse_dsh_composite_id("abc123:session-1").is_err());
    }

    #[test]
    fn composite_id_rejects_non_hex_fingerprint() {
        assert!(parse_dsh_composite_id("abcdefghijklmnop:session-1").is_err());
    }

    #[test]
    fn composite_id_rejects_no_colon() {
        assert!(parse_dsh_composite_id("abcdef0123456789session1").is_err());
    }

    #[test]
    fn composite_id_rejects_empty_session_id() {
        assert!(parse_dsh_composite_id("abcdef0123456789:").is_err());
    }

    // --- map_dsh_list_item ---

    #[test]
    fn map_list_item_produces_correct_history_session() {
        let item = fixture_list_item();
        let session = map_dsh_list_item(&item);

        assert_eq!(session.id, "abcdef0123456789:sess-001");
        assert_eq!(session.source, SOURCE_DSH);
        assert_eq!(session.display, "Fix authentication bug");
        assert_eq!(session.timestamp, 1700001000000); // lastEventAt preferred
        assert_eq!(session.project, "/home/user/project");
        assert_eq!(session.project_name, "project");
        assert_eq!(session.env_name, Some("deepseek".to_string()));
        assert_eq!(session.config_source, None);
    }

    #[test]
    fn map_list_item_derives_project_name_from_cwd_when_missing() {
        let item = fixture_list_item_no_title();
        let session = map_dsh_list_item(&item);

        assert_eq!(session.id, "1234567890abcdef:sess-002");
        assert_eq!(session.project_name, "myapp"); // derived from /tmp/myapp
        assert_eq!(session.display, "myapp"); // title missing → project_name
        // created_at in seconds → converted to ms
        assert_eq!(session.timestamp, 1700000500000);
    }

    #[test]
    fn map_list_item_stable_composite_id() {
        let item = fixture_list_item();
        let s1 = map_dsh_list_item(&item);
        let s2 = map_dsh_list_item(&item);
        assert_eq!(s1.id, s2.id); // deterministic
    }

    // --- map_dsh_detail: text/thinking/tool_use/tool_result ---

    #[test]
    fn map_detail_text_event() {
        let detail = fixture_detail();
        let (messages, segments, warnings) = map_dsh_detail(&detail);

        // 5 events → 5 messages (all have valid content blocks)
        assert_eq!(messages.len(), 5);
        assert!(segments.is_empty()); // DSH segments always empty
        assert!(warnings.is_empty());

        // First: user text
        let m0 = &messages[0];
        assert_eq!(m0.msg_type, "human");
        assert_eq!(m0.uuid.as_deref(), Some("dsh:abcdef0123456789:sess-001:1"));
        let blocks = m0.content.as_array().unwrap();
        assert_eq!(blocks[0]["type"], "text");
        assert_eq!(blocks[0]["text"], "Fix the login bug");
    }

    #[test]
    fn map_detail_thinking_event() {
        let detail = fixture_detail();
        let (messages, _, _) = map_dsh_detail(&detail);

        let m1 = &messages[1];
        assert_eq!(m1.msg_type, "assistant");
        let blocks = m1.content.as_array().unwrap();
        assert_eq!(blocks[0]["type"], "thinking");
        assert_eq!(blocks[0]["thinking"], "Let me analyze...");
    }

    #[test]
    fn map_detail_tool_use_event() {
        let detail = fixture_detail();
        let (messages, _, _) = map_dsh_detail(&detail);

        let m2 = &messages[2];
        assert_eq!(m2.msg_type, "assistant");
        let blocks = m2.content.as_array().unwrap();
        assert_eq!(blocks[0]["type"], "tool_use");
        assert_eq!(blocks[0]["id"], "call_001");
        assert_eq!(blocks[0]["name"], "read_file");
        assert_eq!(blocks[0]["input"]["path"], "src/auth.ts");
    }

    #[test]
    fn map_detail_tool_result_event() {
        let detail = fixture_detail();
        let (messages, _, _) = map_dsh_detail(&detail);

        let m3 = &messages[3];
        // Tool results come from User role → "human" msg_type (for merge compatibility)
        assert_eq!(m3.msg_type, "human");
        let blocks = m3.content.as_array().unwrap();
        assert_eq!(blocks[0]["type"], "tool_result");
        assert_eq!(blocks[0]["tool_use_id"], "call_001");
        // content is preserved as-is (array of content blocks from DSH)
        let content = &blocks[0]["content"];
        assert!(content.is_array());
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "export function login() { ... }");
        assert_eq!(blocks[0]["is_error"], false);
    }

    #[test]
    fn map_detail_stable_uuids_from_seq() {
        let detail = fixture_detail();
        let (messages, _, _) = map_dsh_detail(&detail);

        for (i, msg) in messages.iter().enumerate() {
            let expected_uuid = format!("dsh:abcdef0123456789:sess-001:{}", i + 1);
            assert_eq!(msg.uuid.as_deref(), Some(expected_uuid.as_str()));
        }
    }

    #[test]
    fn map_detail_segments_always_empty() {
        let detail = fixture_detail();
        let (_, segments, _) = map_dsh_detail(&detail);
        assert!(segments.is_empty());
    }

    #[test]
    fn map_detail_unknown_block_type_produces_warning() {
        let mut detail = fixture_detail();
        detail.events.push(dsh_history::DshSurfaceEvent {
            seq: 99,
            event_type: "unknown/event".to_string(),
            time: Some(1700099000000),
            role: dsh_history::DshEventRole::Assistant,
            content: Some(vec![json!({"type": "mystery", "data": "???"})]),
            model: None,
            provider: None,
        });

        let (messages, _, warnings) = map_dsh_detail(&detail);
        // Original 5 events + 1 unknown = 5 messages (unknown omitted)
        assert_eq!(messages.len(), 5);
        // Two warnings: one for the unknown block type, one for the unmappable event
        assert_eq!(warnings.len(), 2);
        assert!(warnings[0].contains("Unknown block type 'mystery'"));
        assert!(warnings[0].contains("seq=99"));
        assert!(warnings[1].contains("Unmappable event seq=99"));
    }

    #[test]
    fn map_detail_merge_tool_results() {
        let detail = fixture_detail();
        let (messages, _, _) = map_dsh_detail(&detail);
        assert_eq!(messages.len(), 5); // pre-merge

        // After merge, the "human" message at index 3 (containing tool_result block)
        // is omitted, and its content is merged INTO the tool_use block at index 2
        // as `_result` and `_resultError` fields.
        let merged = merge_tool_results_into_messages(messages);
        assert_eq!(merged.len(), 4);

        // The tool_use block in the merged assistant message gets _result/_resultError
        let m2_blocks = merged[2].content.as_array().unwrap();
        let tool_use_block = &m2_blocks[0];
        assert_eq!(tool_use_block["type"], "tool_use");
        assert_eq!(tool_use_block["id"], "call_001");
        // _result contains the tool's output content (array from DSH)
        let result = &tool_use_block["_result"];
        assert!(result.is_array());
        assert_eq!(result[0]["text"], "export function login() { ... }");
        assert_eq!(tool_use_block["_resultError"], false);
    }

    // --- tool-call arguments: valid JSON vs raw/invalid ---

    #[test]
    fn map_detail_tool_call_valid_json_arguments() {
        let detail = dsh_history::DshSessionDetail {
            source_instance_id: "abcdef0123456789".to_string(),
            session_id: "sess-args-valid".to_string(),
            header: dsh_history::DshSessionHeader {
                version: 1,
                id: "sess-args-valid".to_string(),
                created_at: 1700000000000,
                cwd: None,
                parent_session: None,
                seed_length: 0,
                delegation_depth: 0,
            },
            events: vec![dsh_history::DshSurfaceEvent {
                seq: 1,
                event_type: "assistant/message".to_string(),
                time: Some(1700000000000),
                role: dsh_history::DshEventRole::Assistant,
                content: Some(vec![json!({
                    "type": "tool-call",
                    "id": "call_valid",
                    "name": "write_file",
                    "arguments": "{\"path\":\"src/main.rs\",\"content\":\"fn main() {}\"}"
                })]),
                model: Some("deepseek-chat".to_string()),
                provider: None,
            }],
            warnings: vec![],
        };

        let (messages, _, warnings) = map_dsh_detail(&detail);
        assert_eq!(messages.len(), 1);
        assert!(warnings.is_empty(), "Valid JSON must not emit warnings");
        let blocks = messages[0].content.as_array().unwrap();
        assert_eq!(blocks[0]["type"], "tool_use");
        assert_eq!(blocks[0]["input"]["path"], "src/main.rs");
        assert_eq!(blocks[0]["input"]["content"], "fn main() {}");
    }

    #[test]
    fn map_detail_tool_call_invalid_json_preserves_raw_string() {
        let raw_invalid = "this is not JSON {{{";
        let detail = dsh_history::DshSessionDetail {
            source_instance_id: "abcdef0123456789".to_string(),
            session_id: "sess-args-invalid".to_string(),
            header: dsh_history::DshSessionHeader {
                version: 1,
                id: "sess-args-invalid".to_string(),
                created_at: 1700000000000,
                cwd: None,
                parent_session: None,
                seed_length: 0,
                delegation_depth: 0,
            },
            events: vec![dsh_history::DshSurfaceEvent {
                seq: 7,
                event_type: "assistant/message".to_string(),
                time: Some(1700000000000),
                role: dsh_history::DshEventRole::Assistant,
                content: Some(vec![json!({
                    "type": "tool-call",
                    "id": "call_bad",
                    "name": "shell_exec",
                    "arguments": raw_invalid
                })]),
                model: Some("deepseek-chat".to_string()),
                provider: None,
            }],
            warnings: vec![],
        };

        let (messages, _, warnings) = map_dsh_detail(&detail);
        assert_eq!(messages.len(), 1);
        // Warning emitted about invalid JSON
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("tool-call 'shell_exec' in seq=7"));
        assert!(warnings[0].contains("not valid JSON"));
        // Input is preserved as the raw string, not fabricated as {}
        let blocks = messages[0].content.as_array().unwrap();
        assert_eq!(blocks[0]["type"], "tool_use");
        assert_eq!(blocks[0]["input"], raw_invalid);
    }

    #[test]
    fn map_detail_tool_call_empty_arguments_string() {
        // Empty string is not valid JSON object — should preserve raw and warn
        let detail = dsh_history::DshSessionDetail {
            source_instance_id: "abcdef0123456789".to_string(),
            session_id: "sess-args-empty".to_string(),
            header: dsh_history::DshSessionHeader {
                version: 1,
                id: "sess-args-empty".to_string(),
                created_at: 1700000000000,
                cwd: None,
                parent_session: None,
                seed_length: 0,
                delegation_depth: 0,
            },
            events: vec![dsh_history::DshSurfaceEvent {
                seq: 3,
                event_type: "assistant/message".to_string(),
                time: Some(1700000000000),
                role: dsh_history::DshEventRole::Assistant,
                content: Some(vec![json!({
                    "type": "tool-call",
                    "id": "call_empty",
                    "name": "no_args_tool",
                    "arguments": ""
                })]),
                model: None,
                provider: None,
            }],
            warnings: vec![],
        };

        let (messages, _, warnings) = map_dsh_detail(&detail);
        assert_eq!(messages.len(), 1);
        // Empty string is not valid JSON → warning + preserve raw
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("not valid JSON"));
        let blocks = messages[0].content.as_array().unwrap();
        assert_eq!(blocks[0]["input"], "");
    }

    // --- DSH never deduplicates ---

    #[test]
    fn dsh_sessions_never_dedupe() {
        let session = HistorySession {
            id: "abcdef0123456789:session-1".to_string(),
            source: SOURCE_DSH.to_string(),
            display: "Fix bug".to_string(),
            timestamp: 1000,
            project: "/home/user/project".to_string(),
            project_name: "project".to_string(),
            env_name: Some("deepseek".to_string()),
            config_source: None,
            task_stage: None,
            task_sticker: None,
            task_label: None,
        };
        assert_eq!(history_dedupe_key(&session), None);
    }

    #[test]
    fn claude_sessions_still_dedupe() {
        let session = HistorySession {
            id: "uuid-123".to_string(),
            source: SOURCE_CLAUDE.to_string(),
            display: "Fix bug".to_string(),
            timestamp: 1000,
            project: "/home/user/project".to_string(),
            project_name: "project".to_string(),
            env_name: None,
            config_source: None,
            task_stage: None,
            task_sticker: None,
            task_label: None,
        };
        assert!(history_dedupe_key(&session).is_some());
    }

    // --- is_resumable_source ---

    #[test]
    fn is_resumable_source_allows_legacy_rejects_dsh() {
        assert!(is_resumable_source("claude"));
        assert!(is_resumable_source("Claude"));
        assert!(is_resumable_source("codex"));
        assert!(is_resumable_source("opencode"));
        assert!(!is_resumable_source("dsh"));
        assert!(!is_resumable_source("DSH"));
        assert!(!is_resumable_source("unknown"));
        assert!(!is_resumable_source(""));
    }

    // --- Workspace loader exclusion ---

    #[test]
    fn workspace_overview_production_seam_with_legacy_loader_excludes_dsh() {
        // Test the exact production orchestration seam with a mock legacy-only loader.
        // The loader returns only Claude sessions — proving DSH cannot enter the output.
        let snapshot = orchestrate_workspace_overview(Some(10), |_limit| {
            Ok(vec![
                HistorySession {
                    id: "s1".to_string(),
                    source: SOURCE_CLAUDE.to_string(),
                    display: "Claude session".to_string(),
                    timestamp: 2000,
                    project: "/p1".to_string(),
                    project_name: "p1".to_string(),
                    env_name: None,
                    config_source: None,
                    task_stage: None,
                    task_sticker: None,
                    task_label: None,
                },
                HistorySession {
                    id: "s2".to_string(),
                    source: SOURCE_CODEX.to_string(),
                    display: "Codex session".to_string(),
                    timestamp: 1000,
                    project: "/p1".to_string(),
                    project_name: "p1".to_string(),
                    env_name: None,
                    config_source: None,
                    task_stage: None,
                    task_sticker: None,
                    task_label: None,
                },
            ])
        }).unwrap();

        assert_eq!(snapshot.total_sessions, 2);
        assert!(snapshot.sessions.iter().all(|s| s.source != SOURCE_DSH));
        // project_nodes also DSH-free
        for node in &snapshot.project_nodes {
            for key in &node.session_keys {
                assert!(!key.starts_with("dsh:"), "sessionKeys must not contain DSH");
            }
        }
    }

    #[test]
    fn workspace_overview_would_leak_dsh_if_all_source_loader_used() {
        // Proves the test contract: if someone rewires to an all-source loader that
        // includes DSH, the workspace snapshot WOULD contain DSH. This is the inverse
        // test — it validates that our production boundary is meaningful.
        let snapshot = orchestrate_workspace_overview(Some(10), |_limit| {
            Ok(vec![
                HistorySession {
                    id: "s1".to_string(),
                    source: SOURCE_CLAUDE.to_string(),
                    display: "Claude".to_string(),
                    timestamp: 2000,
                    project: "/p1".to_string(),
                    project_name: "p1".to_string(),
                    env_name: None,
                    config_source: None,
                    task_stage: None,
                    task_sticker: None,
                    task_label: None,
                },
                HistorySession {
                    id: "abcdef0123456789:dsh-leak".to_string(),
                    source: SOURCE_DSH.to_string(),
                    display: "DSH leak".to_string(),
                    timestamp: 3000,
                    project: "/p1".to_string(),
                    project_name: "p1".to_string(),
                    env_name: Some("deepseek".to_string()),
                    config_source: None,
                    task_stage: None,
                    task_sticker: None,
                    task_label: None,
                },
            ])
        }).unwrap();

        // An all-source loader WOULD allow DSH to appear
        assert!(snapshot.sessions.iter().any(|s| s.source == SOURCE_DSH),
            "All-source loader should include DSH — proving the boundary matters");
        assert_eq!(snapshot.total_sessions, 2);
    }

    #[test]
    fn workspace_overview_production_loader_structurally_excludes_dsh() {
        // Verify load_legacy_history_sessions_filtered returns empty for DSH filter
        let dsh_only = load_legacy_history_sessions_filtered(Some(SOURCE_DSH), None).unwrap();
        assert!(dsh_only.is_empty(), "Production legacy loader never returns DSH sessions");
    }

    // --- DSH finalization (title overrides apply to DSH too) ---

    #[test]
    fn dsh_sessions_pass_through_finalization() {
        let item = fixture_list_item();
        let mut sessions = vec![map_dsh_list_item(&item)];
        // finalize should not panic on DSH
        finalize_history_sessions(&mut sessions);
        assert_eq!(sessions[0].source, SOURCE_DSH);
        assert_eq!(sessions[0].display, "Fix authentication bug");
    }

    // --- load_legacy_history_sessions_filtered excludes DSH ---

    #[test]
    fn legacy_filtered_returns_empty_for_dsh() {
        let result = load_legacy_history_sessions_filtered(Some(SOURCE_DSH), None);
        assert!(result.unwrap().is_empty());
    }

    // --- Warnings propagation ---

    #[test]
    fn map_detail_propagates_detail_warnings() {
        let mut detail = fixture_detail();
        detail.warnings = vec!["session truncated".to_string()];
        let (_, _, warnings) = map_dsh_detail(&detail);
        // detail.warnings are propagated
        assert!(warnings.iter().any(|w| w.contains("session truncated")));
    }

    #[test]
    fn map_event_mixed_known_and_unknown_blocks() {
        // Event with both a known and an unknown block type: known block is mapped,
        // unknown block produces a warning but does not skip the whole event.
        let event = dsh_history::DshSurfaceEvent {
            seq: 10,
            event_type: "assistant/message".to_string(),
            time: Some(1700000000000),
            role: dsh_history::DshEventRole::Assistant,
            content: Some(vec![
                json!({"type": "text", "text": "hello"}),
                json!({"type": "exotic_widget", "data": 42}),
            ]),
            model: None,
            provider: None,
        };

        let (msg_opt, warnings) = map_dsh_event_to_message(&event, "abcdef0123456789", "sess-001");
        // The text block is mapped, unknown block is skipped with warning
        let msg = msg_opt.expect("should produce a message");
        let blocks = msg.content.as_array().unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["text"], "hello");
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("exotic_widget"));
    }

    // --- Typed errors (HistoryCommandError) ---

    #[test]
    fn history_command_error_display() {
        let err = HistoryCommandError {
            code: "timeout".to_string(),
            message: "DSH helper timed out".to_string(),
        };
        assert_eq!(err.to_string(), "[timeout] DSH helper timed out");
    }

    #[test]
    fn history_command_error_serializes() {
        let err = HistoryCommandError {
            code: "helper_failed".to_string(),
            message: "exit code 1".to_string(),
        };
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["code"], "helper_failed");
        assert_eq!(json["message"], "exit code 1");
    }

    // --- Orchestration seam ---

    #[test]
    fn orchestrate_list_combines_legacy_and_dsh() {
        let legacy = vec![HistorySession {
            id: "uuid-1".to_string(),
            source: SOURCE_CLAUDE.to_string(),
            display: "Legacy".to_string(),
            timestamp: 1000,
            project: "/p".to_string(),
            project_name: "p".to_string(),
            env_name: None,
            config_source: None,
            task_stage: None,
            task_sticker: None,
            task_label: None,
        }];
        let dsh = vec![HistorySession {
            id: "abcdef0123456789:s1".to_string(),
            source: SOURCE_DSH.to_string(),
            display: "DSH".to_string(),
            timestamp: 2000,
            project: "/q".to_string(),
            project_name: "q".to_string(),
            env_name: Some("deepseek".to_string()),
            config_source: None,
            task_stage: None,
            task_sticker: None,
            task_label: None,
        }];

        let result = orchestrate_history_list(
            None,
            None,
            legacy,
            Some(Ok((dsh, vec!["truncated".to_string()]))),
        ).unwrap();

        assert_eq!(result.sessions.len(), 2);
        // DSH is newer → first after sort
        assert_eq!(result.sessions[0].source, SOURCE_DSH);
        // Warning propagated as diagnostic
        assert_eq!(result.diagnostics.len(), 1);
        assert_eq!(result.diagnostics[0].code, "helper_warning");
        assert!(result.diagnostics[0].message.contains("truncated"));
    }

    #[test]
    fn orchestrate_list_dsh_error_source_all_soft_fail() {
        let legacy = vec![HistorySession {
            id: "uuid-1".to_string(),
            source: SOURCE_CLAUDE.to_string(),
            display: "Legacy".to_string(),
            timestamp: 1000,
            project: "/p".to_string(),
            project_name: "p".to_string(),
            env_name: None,
            config_source: None,
            task_stage: None,
            task_sticker: None,
            task_label: None,
        }];

        let result = orchestrate_history_list(
            None, // source=all
            None,
            legacy,
            Some(Err(DshListError { code: "timeout".to_string(), message: "timed out".to_string() })),
        ).unwrap();

        // Still succeeds with legacy sessions
        assert_eq!(result.sessions.len(), 1);
        assert_eq!(result.diagnostics.len(), 1);
        assert_eq!(result.diagnostics[0].code, "timeout");
    }

    #[test]
    fn orchestrate_list_dsh_error_source_dsh_hard_fail() {
        let result = orchestrate_history_list(
            Some(SOURCE_DSH),
            None,
            vec![],
            Some(Err(DshListError { code: "timeout".to_string(), message: "timed out".to_string() })),
        );

        let err = result.unwrap_err();
        assert_eq!(err.code, "timeout");
        assert!(err.message.contains("timed out"));
    }

    #[test]
    fn orchestrate_detail_dsh_success_with_warnings() {
        let messages = vec![ConversationMessage {
            msg_type: "human".to_string(),
            uuid: Some("u1".to_string()),
            content: json!([{"type": "text", "text": "hi"}]),
            model: None,
            summary: None,
            plan_content: None,
            timestamp: 1000,
            input_tokens: None,
            output_tokens: None,
            cache_creation_tokens: None,
            cache_read_tokens: None,
            segment_index: 0,
            is_compact_boundary: false,
        }];

        let result = orchestrate_history_detail(
            "abcdef0123456789:sess-001",
            Some(SOURCE_DSH),
            Some(Ok((messages, vec![], vec!["some warning".to_string()]))),
            None,
        ).unwrap();

        assert_eq!(result.messages.len(), 1);
        assert!(result.tool_results_merged);
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].contains("some warning"));
    }

    #[test]
    fn orchestrate_detail_dsh_error() {
        let result = orchestrate_history_detail(
            "abcdef0123456789:sess-001",
            Some(SOURCE_DSH),
            Some(Err("connection refused".to_string())),
            None,
        );

        let err = result.unwrap_err();
        assert_eq!(err.code, "dsh_detail_error");
        assert!(err.message.contains("connection refused"));
    }

    #[test]
    fn orchestrate_detail_legacy_success() {
        let messages = vec![ConversationMessage {
            msg_type: "human".to_string(),
            uuid: Some("u1".to_string()),
            content: json!([{"type": "text", "text": "hello"}]),
            model: None,
            summary: None,
            plan_content: None,
            timestamp: 2000,
            input_tokens: None,
            output_tokens: None,
            cache_creation_tokens: None,
            cache_read_tokens: None,
            segment_index: 0,
            is_compact_boundary: false,
        }];

        let result = orchestrate_history_detail(
            "uuid-123",
            Some(SOURCE_CLAUDE),
            None,
            Some(Ok((messages, vec![]))),
        ).unwrap();

        assert_eq!(result.messages.len(), 1);
        assert!(result.warnings.is_empty());
    }

    // --- Launcher client validation ---

    #[test]
    fn validate_launch_client_accepts_known() {
        assert_eq!(validate_launch_client(Some("claude")).unwrap(), "claude");
        assert_eq!(validate_launch_client(Some("Claude")).unwrap(), "claude");
        assert_eq!(validate_launch_client(Some("CODEX")).unwrap(), "codex");
        assert_eq!(validate_launch_client(Some("opencode")).unwrap(), "opencode");
        assert_eq!(validate_launch_client(None).unwrap(), "claude"); // default
    }

    #[test]
    fn validate_launch_client_rejects_dsh() {
        let err = validate_launch_client(Some("dsh")).unwrap_err();
        assert!(err.contains("Unsupported client"));
        assert!(err.contains("dsh"));
    }

    #[test]
    fn validate_launch_client_rejects_unknown() {
        assert!(validate_launch_client(Some("vim")).is_err());
        assert!(validate_launch_client(Some("")).is_err());
    }

    #[test]
    fn validate_launch_client_shared_by_both_launch_entrypoints() {
        // Production contract: both launch_claude_code and create_interactive_session
        // call validate_launch_client. On failure, create_interactive_session emits
        // "backend.create_interactive_session.unsupported_client" diagnostic event
        // with the raw client name, then returns the error string.
        // The validator error format is the exact message surfaced to the frontend.
        let err = validate_launch_client(Some("dsh")).unwrap_err();
        assert_eq!(err, "Unsupported client 'dsh'");
        let err2 = validate_launch_client(Some("vim")).unwrap_err();
        assert_eq!(err2, "Unsupported client 'vim'");
        // Valid clients succeed through both paths
        assert_eq!(validate_launch_client(Some("claude")).unwrap(), "claude");
        assert_eq!(validate_launch_client(Some("codex")).unwrap(), "codex");
        assert_eq!(validate_launch_client(Some("opencode")).unwrap(), "opencode");
        assert_eq!(validate_launch_client(None).unwrap(), "claude"); // default
    }
}
