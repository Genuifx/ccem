// apps/desktop/src-tauri/src/agy_history.rs
//
// Native Antigravity CLI (`agy`) history, transcript, and subagent reader.
// Reads `~/.gemini/antigravity-cli` strictly read-only so active `agy`
// sessions and WAL databases are never mutated or locked for writes.

use crate::agent_home;
use crate::history::{
    CompactSegment, ConversationMessage, HistorySession, SessionSubagentsPayload, SubagentMeta,
};
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

const SOURCE_AGY: &str = "agy";
pub(crate) const AGY_NATIVE_ENV_NAME: &str = "Antigravity";
const SUMMARIES_DB_NAME: &str = "conversation_summaries.db";
const TRANSCRIPT_COMPACT_NAME: &str = "transcript.jsonl";
const TRANSCRIPT_FULL_NAME: &str = "transcript_full.jsonl";
const RESULT_SUMMARY_MAX_CHARS: usize = 160;

#[derive(Debug, Clone, Default)]
struct AgySummaryRow {
    conversation_id: String,
    title: String,
    preview: String,
    step_count: usize,
    last_modified_ms: u64,
    last_user_input_ms: u64,
    workspace_path: String,
    status: String,
    agent_name: String,
    parent_conversation_id: String,
    nesting_depth: i64,
    killed: bool,
    app_data_dir: String,
}

#[derive(Debug, Deserialize)]
struct AgyTranscriptLine {
    #[serde(default)]
    step_index: Option<u64>,
    #[serde(default)]
    source: Option<String>,
    #[serde(rename = "type", default)]
    step_type: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    input_tokens: Option<u64>,
    #[serde(default)]
    output_tokens: Option<u64>,
    #[serde(default)]
    cache_read_tokens: Option<u64>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    thinking: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<AgyToolCall>>,
    #[serde(default)]
    media: Option<Vec<AgyMediaAttachment>>,
}

#[derive(Debug, Deserialize)]
struct AgyToolCall {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    args: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct AgyMediaAttachment {
    #[serde(default)]
    mime_type: Option<String>,
    #[serde(default)]
    uri: Option<String>,
}

#[derive(Debug, Default)]
struct AgyTranscriptQuickScan {
    first_user_prompt: Option<String>,
    first_timestamp_ms: u64,
    last_timestamp_ms: u64,
    has_user_input: bool,
    message_count: usize,
    tool_count: usize,
    last_status: Option<String>,
    last_assistant_text: Option<String>,
}

// ============================================================================
// Public entry points (use configured `agent_home::agy_home()`)
// ============================================================================

pub fn load_agy_history() -> Result<Vec<HistorySession>, String> {
    load_agy_history_from_home(&agent_home::agy_home())
}

pub fn has_agy_session(session_id: &str) -> bool {
    has_agy_session_in(&agent_home::agy_home(), session_id)
}

pub fn load_agy_conversation_detail(
    session_id: &str,
) -> Result<(Vec<ConversationMessage>, Vec<CompactSegment>), String> {
    load_agy_conversation_detail_in(&agent_home::agy_home(), session_id)
}

pub fn load_agy_subagents(
    session_id: &str,
    detail_agent_id: Option<&str>,
) -> Result<SessionSubagentsPayload, String> {
    load_agy_subagents_in(&agent_home::agy_home(), session_id, detail_agent_id)
}

/// Discover per-conversation transcript JSONL files for token analytics.
/// Includes both top-level and subagent conversations because subagents
/// consume real LLM tokens under the same Antigravity account.
/// Picks compact `transcript.jsonl` (identical token fields, much smaller),
/// falling back to `transcript_full.jsonl` when compact is absent.
pub(crate) fn discover_agy_transcript_files(agy_home: &Path) -> (Vec<PathBuf>, bool) {
    let brain_dir = agy_home.join("brain");
    if !brain_dir.exists() {
        return (Vec::new(), true);
    }

    let entries = match fs::read_dir(&brain_dir) {
        Ok(entries) => entries,
        Err(_) => return (Vec::new(), false),
    };

    let mut files = Vec::new();
    let mut complete = true;

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                complete = false;
                continue;
            }
        };
        let Ok(file_type) = entry.file_type() else {
            complete = false;
            continue;
        };
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }
        let logs_dir = entry.path().join(".system_generated").join("logs");
        let compact = logs_dir.join(TRANSCRIPT_COMPACT_NAME);
        if is_regular_file(&compact) {
            files.push(compact);
            continue;
        }
        let full = logs_dir.join(TRANSCRIPT_FULL_NAME);
        if is_regular_file(&full) {
            files.push(full);
        }
    }

    (files, complete)
}

// ============================================================================
// Core home-parameterized implementations (directly unit-testable)
// ============================================================================

pub(crate) fn is_safe_agy_conversation_id(session_id: &str) -> bool {
    let trimmed = session_id.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains(['/', '\\', ':', '\0'])
        || trimmed.contains("..")
    {
        return false;
    }
    let mut components = Path::new(trimmed).components();
    matches!(
        (components.next(), components.next()),
        (Some(std::path::Component::Normal(_)), None)
    )
}

pub(crate) fn find_agy_transcript_path(
    agy_home: &Path,
    session_id: &str,
    prefer_full: bool,
) -> Option<PathBuf> {
    if !is_safe_agy_conversation_id(session_id) {
        return None;
    }
    let logs_dir = agy_home
        .join("brain")
        .join(session_id.trim())
        .join(".system_generated")
        .join("logs");
    let order = if prefer_full {
        [TRANSCRIPT_FULL_NAME, TRANSCRIPT_COMPACT_NAME]
    } else {
        [TRANSCRIPT_COMPACT_NAME, TRANSCRIPT_FULL_NAME]
    };
    order
        .into_iter()
        .map(|name| logs_dir.join(name))
        .find(|path| is_regular_file(path))
}

pub(crate) fn has_agy_session_in(agy_home: &Path, session_id: &str) -> bool {
    if !is_safe_agy_conversation_id(session_id) {
        return false;
    }
    if find_agy_transcript_path(agy_home, session_id, false).is_some() {
        return true;
    }
    let summaries = read_summary_rows(agy_home);
    summaries.contains_key(session_id.trim())
}

pub(crate) fn load_agy_history_from_home(agy_home: &Path) -> Result<Vec<HistorySession>, String> {
    if !agy_home.exists() {
        return Ok(Vec::new());
    }

    let (summary_map, known_parent_children) = read_summary_rows_and_parents(agy_home);
    let mut seen_ids: HashSet<String> = known_parent_children;
    let mut sessions = Vec::new();

    // 1. Authoritative rows from conversation_summaries.db (skip subagents and
    //    ghost legacy entries from other app_data_dirs with no local transcript).
    for (id, row) in &summary_map {
        if !is_safe_agy_conversation_id(id) {
            continue;
        }
        if is_subagent_row(row) || seen_ids.contains(id) {
            seen_ids.insert(id.clone());
            continue;
        }
        let transcript_path = find_agy_transcript_path(agy_home, id, false);
        let is_other_app_ghost = !row.app_data_dir.is_empty()
            && !row.app_data_dir.eq_ignore_ascii_case("antigravity-cli")
            && transcript_path.is_none();
        if is_other_app_ghost {
            seen_ids.insert(id.clone());
            continue;
        }

        let transcript_scan = transcript_path
            .as_deref()
            .map(quick_scan_transcript)
            .unwrap_or_default();
        let transcript_mtime = transcript_path
            .as_deref()
            .map(file_modified_millis)
            .unwrap_or(0);

        let display = resolve_session_display(row, &transcript_scan);
        let timestamp = row
            .last_modified_ms
            .max(row.last_user_input_ms)
            .max(transcript_scan.last_timestamp_ms)
            .max(transcript_mtime);
        let project = row.workspace_path.clone();
        let project_name = derive_project_name(&project);
        let cwd = (!project.is_empty()).then(|| project.clone());

        seen_ids.insert(id.clone());
        sessions.push(HistorySession {
            codex_isolated: None,
            id: id.clone(),
            source: SOURCE_AGY.to_string(),
            display,
            timestamp,
            project,
            project_name,
            cwd,
            // Match Claude/Codex disk-discovered history: leave env_name and
            // config_source as None so provenance can enrich CCEM-launched
            // sessions and Workspace treats disk sessions as real provider
            // history (not temporary "native" runtime placeholders).
            env_name: None,
            config_source: None,
            task_stage: None,
            task_sticker: None,
            task_label: None,
            archived: None,
            launch_mode: None,
        });
    }

    // 2. Fallback scan of brain/<id>/.system_generated/logs/transcript*.jsonl
    //    for brand-new conversations not yet flushed to SQLite or when DB is locked/missing.
    let (transcript_files, _) = discover_agy_transcript_files(agy_home);
    for path in transcript_files {
        let Some(id) = extract_conversation_id_from_transcript_path(&path) else {
            continue;
        };
        if seen_ids.contains(&id) || !is_safe_agy_conversation_id(&id) {
            continue;
        }
        let scan = quick_scan_transcript(&path);
        // Any conversation missing from conversation_summaries.db without a
        // direct USER_INPUT step is an unindexed/background subagent transcript;
        // never leak it into the top-level history list.
        if !scan.has_user_input {
            continue;
        }
        let timestamp = scan.last_timestamp_ms.max(file_modified_millis(&path));
        let display = scan
            .first_user_prompt
            .as_deref()
            .map(clean_single_line_title)
            .unwrap_or_default();

        seen_ids.insert(id.clone());
        sessions.push(HistorySession {
            codex_isolated: None,
            id,
            source: SOURCE_AGY.to_string(),
            display,
            timestamp,
            project: String::new(),
            project_name: "unknown".to_string(),
            cwd: None,
            env_name: None,
            config_source: None,
            task_stage: None,
            task_sticker: None,
            task_label: None,
            archived: None,
            launch_mode: None,
        });
    }

    Ok(sessions)
}

pub(crate) fn load_agy_conversation_detail_in(
    agy_home: &Path,
    session_id: &str,
) -> Result<(Vec<ConversationMessage>, Vec<CompactSegment>), String> {
    let Some(path) = find_agy_transcript_path(agy_home, session_id, true) else {
        return Ok((Vec::new(), Vec::new()));
    };
    parse_agy_conversation_file(&path, session_id)
}

pub(crate) fn parse_agy_conversation_file(
    path: &Path,
    session_id: &str,
) -> Result<(Vec<ConversationMessage>, Vec<CompactSegment>), String> {
    let file = fs::File::open(path)
        .map_err(|err| format!("Failed to open agy transcript file: {err}"))?;
    let reader = BufReader::new(file);

    let mut messages: Vec<ConversationMessage> = Vec::new();
    let mut pending_tool_use_ids: VecDeque<String> = VecDeque::new();
    let mut first_timestamp = 0u64;

    for (line_idx, line_res) in reader.lines().enumerate() {
        let Ok(line) = line_res else {
            continue;
        };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(step) = serde_json::from_str::<AgyTranscriptLine>(&line) else {
            continue;
        };

        let step_index = step.step_index.unwrap_or(line_idx as u64);
        let timestamp = step
            .created_at
            .as_deref()
            .map(parse_agy_timestamp_millis)
            .unwrap_or(0);
        if first_timestamp == 0 && timestamp > 0 {
            first_timestamp = timestamp;
        }

        let step_type = step.step_type.as_deref().unwrap_or("");
        match step_type {
            "USER_INPUT" => {
                pending_tool_use_ids.clear();
                let mut blocks = Vec::new();
                if let Some(raw_content) = step.content.as_deref() {
                    if let Some(visible) = extract_agy_user_visible_text(raw_content) {
                        blocks.push(json!({
                            "type": "text",
                            "text": visible,
                        }));
                    }
                }
                if let Some(media) = step.media {
                    for item in media {
                        let label = item
                            .uri
                            .as_deref()
                            .and_then(|uri| Path::new(uri).file_name().and_then(|n| n.to_str()))
                            .unwrap_or("attachment");
                        let mime = item.mime_type.unwrap_or_default();
                        let placeholder = if mime.starts_with("image/") {
                            format!("[Image: {label}]")
                        } else {
                            format!("[Attachment: {label}]")
                        };
                        blocks.push(json!({
                            "type": "image",
                            "placeholder": placeholder,
                        }));
                    }
                }
                if blocks.is_empty() {
                    continue;
                }
                messages.push(ConversationMessage {
                    msg_type: "user".to_string(),
                    uuid: Some(format!("agy:{session_id}:{step_index}")),
                    content: Value::Array(blocks),
                    model: None,
                    summary: None,
                    plan_content: None,
                    timestamp,
                    input_tokens: None,
                    output_tokens: None,
                    cache_creation_tokens: None,
                    cache_read_tokens: None,
                    segment_index: 0,
                    is_compact_boundary: false,
                });
            }
            "PLANNER_RESPONSE" => {
                pending_tool_use_ids.clear();
                let mut blocks = Vec::new();

                if let Some(thinking) = step
                    .thinking
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    blocks.push(json!({
                        "type": "thinking",
                        "thinking": thinking,
                    }));
                }

                if let Some(content) = step
                    .content
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    blocks.push(json!({
                        "type": "text",
                        "text": content,
                    }));
                }

                if let Some(tool_calls) = step.tool_calls {
                    for (tc_idx, tc) in tool_calls.into_iter().enumerate() {
                        let name = tc
                            .name
                            .filter(|v| !v.trim().is_empty())
                            .unwrap_or_else(|| "tool".to_string());
                        let tool_use_id = format!("agy-tool-{step_index}-{tc_idx}");
                        let input = unwrap_agy_tool_args(tc.args);
                        blocks.push(json!({
                            "type": "tool_use",
                            "id": tool_use_id,
                            "name": name,
                            "input": input,
                        }));
                        pending_tool_use_ids.push_back(tool_use_id);
                    }
                }

                let has_tokens = step.input_tokens.is_some()
                    || step.output_tokens.is_some()
                    || step.cache_read_tokens.is_some();
                if blocks.is_empty() && !has_tokens {
                    continue;
                }

                messages.push(ConversationMessage {
                    msg_type: "assistant".to_string(),
                    uuid: Some(format!("agy:{session_id}:{step_index}")),
                    content: Value::Array(blocks),
                    model: step.model.filter(|m| !m.trim().is_empty()),
                    summary: None,
                    plan_content: None,
                    timestamp,
                    input_tokens: step.input_tokens,
                    output_tokens: step.output_tokens,
                    cache_creation_tokens: None,
                    cache_read_tokens: step.cache_read_tokens,
                    segment_index: 0,
                    is_compact_boundary: false,
                });
            }
            "GENERIC" => {
                let Some(tool_use_id) = pending_tool_use_ids.pop_front() else {
                    continue;
                };
                let is_error = step
                    .status
                    .as_deref()
                    .is_some_and(|s| s.eq_ignore_ascii_case("ERROR"))
                    || step
                        .error
                        .as_deref()
                        .is_some_and(|e| !e.trim().is_empty());
                let result_text = format_generic_tool_result(
                    step.content.as_deref(),
                    step.error.as_deref(),
                );
                messages.push(ConversationMessage {
                    msg_type: "user".to_string(),
                    uuid: Some(format!("agy:{session_id}:{step_index}")),
                    content: json!([{
                        "type": "tool_result",
                        "tool_use_id": tool_use_id,
                        "content": result_text,
                        "is_error": is_error,
                    }]),
                    model: None,
                    summary: None,
                    plan_content: None,
                    timestamp,
                    input_tokens: None,
                    output_tokens: None,
                    cache_creation_tokens: None,
                    cache_read_tokens: None,
                    segment_index: 0,
                    is_compact_boundary: false,
                });
            }
            // Internal SYSTEM_MESSAGE nudges and unknown step types are omitted from user chat view.
            _ => {}
        }
    }

    let segments = if messages.is_empty() {
        Vec::new()
    } else {
        vec![CompactSegment {
            segment_index: 0,
            timestamp: first_timestamp,
            trigger: None,
            pre_tokens: None,
            message_count: messages.len(),
        }]
    };

    Ok((messages, segments))
}

pub(crate) fn load_agy_subagents_in(
    agy_home: &Path,
    session_id: &str,
    detail_agent_id: Option<&str>,
) -> Result<SessionSubagentsPayload, String> {
    if !is_safe_agy_conversation_id(session_id) {
        return Ok(SessionSubagentsPayload {
            subagents: Vec::new(),
            detail: None,
        });
    }

    let summary_map = read_summary_rows(agy_home);
    let mut children: Vec<&AgySummaryRow> = summary_map
        .values()
        .filter(|row| {
            row.parent_conversation_id.trim() == session_id.trim()
                && is_safe_agy_conversation_id(&row.conversation_id)
        })
        .collect();

    if children.is_empty() {
        return Ok(SessionSubagentsPayload {
            subagents: Vec::new(),
            detail: None,
        });
    }

    let mut subagents = Vec::with_capacity(children.len());
    for child in children.drain(..) {
        let transcript_path = find_agy_transcript_path(agy_home, &child.conversation_id, false);
        let scan = transcript_path
            .as_deref()
            .map(quick_scan_transcript)
            .unwrap_or_default();

        let started_at = if scan.first_timestamp_ms > 0 {
            scan.first_timestamp_ms
        } else {
            child.last_modified_ms
        };
        let status = resolve_subagent_status(child, &scan);
        let completed_at = if status == "running" {
            None
        } else {
            let ts = scan.last_timestamp_ms.max(child.last_modified_ms);
            (ts > 0).then_some(ts)
        };

        let subagent_type = if !child.agent_name.trim().is_empty() {
            Some(child.agent_name.trim().to_string())
        } else {
            Some("subagent".to_string())
        };
        let description = {
            let title = resolve_session_display(child, &scan);
            if !title.is_empty() {
                Some(title)
            } else {
                None
            }
        };
        let result_summary = scan
            .last_assistant_text
            .as_deref()
            .map(|text| truncate_chars(&clean_single_line_title(text), RESULT_SUMMARY_MAX_CHARS))
            .filter(|text| !text.is_empty());

        subagents.push(SubagentMeta {
            agent_id: child.conversation_id.clone(),
            subagent_type,
            description,
            status,
            message_count: if scan.message_count > 0 {
                scan.message_count
            } else {
                child.step_count
            },
            tool_count: scan.tool_count,
            started_at,
            completed_at,
            result_summary,
        });
    }

    subagents.sort_by(|left, right| {
        left.started_at
            .cmp(&right.started_at)
            .then_with(|| left.agent_id.cmp(&right.agent_id))
    });

    let detail = match detail_agent_id.map(str::trim).filter(|id| !id.is_empty()) {
        Some(target_id) if subagents.iter().any(|agent| agent.agent_id == target_id) => {
            let (msgs, _) = load_agy_conversation_detail_in(agy_home, target_id)?;
            Some(msgs)
        }
        _ => None,
    };

    Ok(SessionSubagentsPayload { subagents, detail })
}

// ============================================================================
// SQLite & transcript helpers
// ============================================================================

fn read_summary_rows(agy_home: &Path) -> HashMap<String, AgySummaryRow> {
    read_summary_rows_and_parents(agy_home).0
}

fn read_summary_rows_and_parents(
    agy_home: &Path,
) -> (HashMap<String, AgySummaryRow>, HashSet<String>) {
    let db_path = agy_home.join(SUMMARIES_DB_NAME);
    if !db_path.is_file() {
        return (HashMap::new(), HashSet::new());
    }

    let conn = match Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(conn) => conn,
        Err(_) => return (HashMap::new(), HashSet::new()),
    };
    let _ = conn.busy_timeout(Duration::from_millis(500));
    let _ = conn.execute_batch("PRAGMA query_only = ON;");

    let columns = summary_table_columns(&conn);
    if !columns.contains("conversation_id") {
        return (HashMap::new(), HashSet::new());
    }

    let col_or = |name: &str, fallback: &str| -> String {
        if columns.contains(name) {
            format!("COALESCE({name}, {fallback})")
        } else {
            fallback.to_string()
        }
    };
    let sql = format!(
        "SELECT conversation_id, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {} \
         FROM conversation_summaries",
        col_or("title", "''"),
        col_or("preview", "''"),
        col_or("step_count", "0"),
        col_or("last_modified_time", "''"),
        col_or("last_user_input_time", "''"),
        col_or("workspace_uris", "''"),
        col_or("status", "''"),
        col_or("agent_name", "''"),
        col_or("parent_conversation_id", "''"),
        col_or("nesting_depth", "0"),
        col_or("killed", "0"),
        col_or("app_data_dir", "''"),
    );

    let mut rows_by_id = HashMap::new();
    if let Ok(mut stmt) = conn.prepare(&sql) {
        let iter = stmt.query_map([], |row| {
            let conversation_id: String = row.get(0).unwrap_or_default();
            let title: String = row.get(1).unwrap_or_default();
            let preview: String = row.get(2).unwrap_or_default();
            let step_count: i64 = row.get(3).unwrap_or(0);
            let last_modified_raw: String = row.get(4).unwrap_or_default();
            let last_user_input_raw: String = row.get(5).unwrap_or_default();
            let workspace_uris_raw: String = row.get(6).unwrap_or_default();
            let status: String = row.get(7).unwrap_or_default();
            let agent_name: String = row.get(8).unwrap_or_default();
            let parent_conversation_id: String = row.get(9).unwrap_or_default();
            let nesting_depth: i64 = row.get(10).unwrap_or(0);
            let killed: bool = row.get(11).unwrap_or(false);
            let app_data_dir: String = row.get(12).unwrap_or_default();

            Ok(AgySummaryRow {
                conversation_id,
                title,
                preview,
                step_count: step_count.max(0) as usize,
                last_modified_ms: parse_agy_timestamp_millis(&last_modified_raw),
                last_user_input_ms: parse_agy_timestamp_millis(&last_user_input_raw),
                workspace_path: extract_primary_workspace_path(&workspace_uris_raw)
                    .unwrap_or_default(),
                status,
                agent_name,
                parent_conversation_id,
                nesting_depth,
                killed,
                app_data_dir,
            })
        });

        if let Ok(mapped) = iter {
            for item in mapped.flatten() {
                if !item.conversation_id.trim().is_empty() {
                    rows_by_id.insert(item.conversation_id.clone(), item);
                }
            }
        }
    }

    // Backfill parent_conversation_id from conversation_parents if populated separately,
    // and track every child_id even if not yet present in conversation_summaries.
    let mut known_parent_children = HashSet::new();
    if let Ok(mut stmt) =
        conn.prepare("SELECT conversation_id, parent_id FROM conversation_parents")
    {
        if let Ok(mapped) = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0).unwrap_or_default(),
                row.get::<_, String>(1).unwrap_or_default(),
            ))
        }) {
            for (child_id, parent_id) in mapped.flatten() {
                let child_trimmed = child_id.trim();
                let parent_trimmed = parent_id.trim();
                if child_trimmed.is_empty() || parent_trimmed.is_empty() {
                    continue;
                }
                known_parent_children.insert(child_trimmed.to_string());
                if let Some(entry) = rows_by_id.get_mut(child_trimmed) {
                    if entry.parent_conversation_id.trim().is_empty() {
                        entry.parent_conversation_id = parent_trimmed.to_string();
                    }
                }
            }
        }
    }

    (rows_by_id, known_parent_children)
}

fn summary_table_columns(conn: &Connection) -> HashSet<String> {
    let mut columns = HashSet::new();
    if let Ok(mut stmt) = conn.prepare("PRAGMA table_info(conversation_summaries)") {
        if let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(1)) {
            for col in rows.flatten() {
                columns.insert(col);
            }
        }
    }
    columns
}

fn is_subagent_row(row: &AgySummaryRow) -> bool {
    !row.parent_conversation_id.trim().is_empty() || row.nesting_depth > 0
}

fn resolve_subagent_status(row: &AgySummaryRow, scan: &AgyTranscriptQuickScan) -> String {
    if row.status.eq_ignore_ascii_case("CASCADE_RUN_STATUS_RUNNING") {
        return "running".to_string();
    }
    if scan
        .last_status
        .as_deref()
        .is_some_and(|s| s.eq_ignore_ascii_case("ERROR"))
    {
        return "failed".to_string();
    }
    if row.killed && scan.last_assistant_text.is_none() && scan.message_count == 0 {
        return "failed".to_string();
    }
    "completed".to_string()
}

fn resolve_session_display(row: &AgySummaryRow, scan: &AgyTranscriptQuickScan) -> String {
    let title = clean_single_line_title(&row.title);
    if !title.is_empty() {
        return title;
    }
    if let Some(visible_preview) = extract_agy_user_visible_text(&row.preview) {
        let cleaned = clean_single_line_title(&visible_preview);
        if !cleaned.is_empty() {
            return cleaned;
        }
    }
    if let Some(first_prompt) = scan.first_user_prompt.as_deref() {
        let cleaned = clean_single_line_title(first_prompt);
        if !cleaned.is_empty() {
            return cleaned;
        }
    }
    String::new()
}

fn quick_scan_transcript(path: &Path) -> AgyTranscriptQuickScan {
    let Ok(file) = fs::File::open(path) else {
        return AgyTranscriptQuickScan::default();
    };
    let reader = BufReader::new(file);
    let mut scan = AgyTranscriptQuickScan::default();

    for line in reader.lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(step) = serde_json::from_str::<AgyTranscriptLine>(&line) else {
            continue;
        };

        if let Some(ts) = step.created_at.as_deref().map(parse_agy_timestamp_millis) {
            if ts > 0 {
                if scan.first_timestamp_ms == 0 {
                    scan.first_timestamp_ms = ts;
                }
                scan.last_timestamp_ms = scan.last_timestamp_ms.max(ts);
            }
        }
        if let Some(status) = step.status.as_deref() {
            scan.last_status = Some(status.to_string());
        }

        match step.step_type.as_deref().unwrap_or("") {
            "USER_INPUT" => {
                scan.has_user_input = true;
                scan.message_count += 1;
                if scan.first_user_prompt.is_none() {
                    if let Some(raw) = step.content.as_deref() {
                        scan.first_user_prompt = extract_agy_user_visible_text(raw);
                    }
                }
            }
            "PLANNER_RESPONSE" => {
                scan.message_count += 1;
                if let Some(calls) = step.tool_calls.as_ref() {
                    scan.tool_count += calls.len();
                }
                if let Some(text) = step
                    .content
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    scan.last_assistant_text = Some(text.to_string());
                }
            }
            _ => {}
        }
    }

    scan
}

fn format_generic_tool_result(content: Option<&str>, error: Option<&str>) -> String {
    let content = content.map(str::trim).unwrap_or("");
    let error = error.map(str::trim).unwrap_or("");
    match (content.is_empty(), error.is_empty()) {
        (false, true) => content.to_string(),
        (true, false) => error.to_string(),
        (false, false) => {
            if content.contains(error) {
                content.to_string()
            } else {
                format!("{error}\n\n{content}")
            }
        }
        (true, true) => String::new(),
    }
}

/// Unwrap Antigravity's JSON-encoded tool arg values (e.g. `"\"/path\""` -> `"/path"`,
/// `"5000"` -> `5000`) into clean JSON values for display and tool summaries.
fn unwrap_agy_tool_args(args: Option<Value>) -> Value {
    let Some(Value::Object(map)) = args else {
        return args.unwrap_or_else(|| json!({}));
    };
    let mut unwrapped = serde_json::Map::with_capacity(map.len());
    for (key, value) in map {
        let next = match value {
            Value::String(raw) => serde_json::from_str::<Value>(&raw).unwrap_or(Value::String(raw)),
            other => other,
        };
        unwrapped.insert(key, next);
    }
    Value::Object(unwrapped)
}

/// Extract user-visible text from an Antigravity `USER_INPUT` content payload.
/// Strips Antigravity's `<USER_REQUEST>`, `<ADDITIONAL_METADATA>`, and
/// `<USER_SETTINGS_CHANGE>` envelopes, then delegates to CCEM's shared
/// `normalize_user_visible_prompt` to strip `<system_tip>` / `<selected_skills>`.
pub(crate) fn extract_agy_user_visible_text(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let inner = if let Some(start) = trimmed.find("<USER_REQUEST>") {
        let body_start = start + "<USER_REQUEST>".len();
        if let Some(rel_end) = trimmed[body_start..].rfind("</USER_REQUEST>") {
            &trimmed[body_start..body_start + rel_end]
        } else {
            &trimmed[body_start..]
        }
    } else {
        trimmed
    };

    let stripped = strip_agy_trailing_envelopes(inner);
    crate::user_prompt_display::normalize_user_visible_prompt(&stripped)
}

fn strip_agy_trailing_envelopes(input: &str) -> String {
    let mut out = input.to_string();
    for (open, close) in [
        ("<ADDITIONAL_METADATA>", "</ADDITIONAL_METADATA>"),
        ("<USER_SETTINGS_CHANGE>", "</USER_SETTINGS_CHANGE>"),
    ] {
        while let Some(start) = out.find(open) {
            if let Some(rel_end) = out[start..].find(close) {
                let end = start + rel_end + close.len();
                out.replace_range(start..end, "");
            } else {
                out.truncate(start);
                break;
            }
        }
    }
    out.trim().to_string()
}

pub(crate) fn parse_agy_timestamp_millis(raw: &str) -> u64 {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.starts_with("0001-01-01") {
        return 0;
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(trimmed) {
        return dt.timestamp_millis().max(0) as u64;
    }
    // Go's sqlite driver formats timestamps with a space separator:
    // "2026-11-21 08:57:18.264499+00:00"
    if let Some((date_part, rest)) = trimmed.split_once(' ') {
        let normalized = format!("{date_part}T{rest}");
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&normalized) {
            return dt.timestamp_millis().max(0) as u64;
        }
    }
    0
}

pub(crate) fn extract_primary_workspace_path(workspace_uris_raw: &str) -> Option<String> {
    let trimmed = workspace_uris_raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(trimmed) {
        for item in items {
            if let Some(uri) = item.as_str() {
                if let Some(path) = parse_file_uri_path(uri) {
                    return Some(path);
                }
            }
        }
        return None;
    }
    parse_file_uri_path(trimmed)
}

pub(crate) fn parse_file_uri_path(uri: &str) -> Option<String> {
    let trimmed = uri.trim();
    if trimmed.is_empty() {
        return None;
    }
    let raw_path = if let Some(rest) = trimmed.strip_prefix("file://") {
        let path_part = if rest.len() >= "localhost/".len()
            && rest[.."localhost/".len()].eq_ignore_ascii_case("localhost/")
        {
            &rest["localhost".len()..]
        } else {
            rest
        };
        percent_decode_utf8(path_part)
    } else {
        trimmed.to_string()
    };

    // Windows file URIs look like `/C:/Users/...` -> strip leading `/` before drive letter.
    let bytes = raw_path.as_bytes();
    let normalized = if bytes.len() >= 3
        && bytes[0] == b'/'
        && bytes[1].is_ascii_alphabetic()
        && bytes[2] == b':'
    {
        raw_path[1..].to_string()
    } else {
        raw_path
    };

    let cleaned = normalized.trim().trim_end_matches(['/', '\\']).to_string();
    if cleaned.is_empty() && normalized.starts_with('/') {
        return Some("/".to_string());
    }
    (!cleaned.is_empty()).then_some(cleaned)
}

fn percent_decode_utf8(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_nibble(bytes[i + 1]), hex_nibble(bytes[i + 2])) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn derive_project_name(project: &str) -> String {
    project
        .split(['/', '\\'])
        .next_back()
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown")
        .to_string()
}

fn clean_single_line_title(raw: &str) -> String {
    raw.replace(['\n', '\r'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let truncated: String = value.chars().take(max_chars.saturating_sub(1)).collect();
    format!("{}…", truncated.trim_end())
}

fn is_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_file())
}

fn file_modified_millis(path: &Path) -> u64 {
    fs::metadata(path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|mtime| mtime.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn extract_conversation_id_from_transcript_path(path: &Path) -> Option<String> {
    // <agy_home>/brain/<conversation_id>/.system_generated/logs/transcript*.jsonl
    let logs_dir = path.parent()?;
    let sys_dir = logs_dir.parent()?;
    let conv_dir = sys_dir.parent()?;
    conv_dir
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::user_prompt_display::WORKSPACE_FILE_PREVIEW_SYSTEM_TIP;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn make_temp_dir(prefix: &str) -> PathBuf {
        let seq = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "ccem-agy-history-test-{prefix}-{}-{seq}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn write_transcript(agy_home: &Path, id: &str, file_name: &str, lines: &[Value]) -> PathBuf {
        let logs_dir = agy_home
            .join("brain")
            .join(id)
            .join(".system_generated")
            .join("logs");
        fs::create_dir_all(&logs_dir).expect("create logs dir");
        let path = logs_dir.join(file_name);
        let body = lines
            .iter()
            .map(|v| serde_json::to_string(v).unwrap())
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        fs::write(&path, body).expect("write transcript");
        path
    }

    fn create_summaries_db(agy_home: &Path) -> Connection {
        let db_path = agy_home.join(SUMMARIES_DB_NAME);
        let conn = Connection::open(&db_path).expect("open summaries db");
        conn.execute_batch(
            "CREATE TABLE conversation_summaries (
                conversation_id text PRIMARY KEY,
                title text NOT NULL DEFAULT '',
                preview text NOT NULL DEFAULT '',
                step_count integer NOT NULL DEFAULT 0,
                last_modified_time datetime NOT NULL,
                workspace_uris text NOT NULL,
                status text NOT NULL DEFAULT '',
                source text NOT NULL DEFAULT '',
                project_id text NOT NULL DEFAULT '',
                agent_name text NOT NULL DEFAULT '',
                parent_conversation_id text NOT NULL DEFAULT '',
                nesting_depth integer NOT NULL DEFAULT 0,
                battle_id text NOT NULL DEFAULT '',
                winning_conversation_id text NOT NULL DEFAULT '',
                not_fully_idle numeric NOT NULL DEFAULT false,
                killed numeric NOT NULL DEFAULT false,
                last_user_input_time datetime NOT NULL,
                last_user_input_step_index integer NOT NULL DEFAULT -1,
                app_data_dir text NOT NULL DEFAULT '',
                raw_summary blob,
                group_id text NOT NULL DEFAULT ''
            );
            CREATE TABLE conversation_parents (
                conversation_id TEXT PRIMARY KEY,
                parent_id TEXT NOT NULL
            ) WITHOUT ROWID;",
        )
        .expect("create schema");
        conn
    }

    #[test]
    fn unwraps_agy_user_request_and_ccem_tips() {
        let raw = format!(
            "<USER_REQUEST>\n<system_tip>{WORKSPACE_FILE_PREVIEW_SYSTEM_TIP}</system_tip>\n\n<selected_skills>hidden</selected_skills>\n\n<user_request>\n给 ccem 加上 agy 统计\n</user_request>\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-21T16:55:16+08:00.\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nThe user changed setting.\n</USER_SETTINGS_CHANGE>"
        );
        assert_eq!(
            extract_agy_user_visible_text(&raw).as_deref(),
            Some("给 ccem 加上 agy 统计")
        );
    }

    #[test]
    fn parses_file_uris_with_spaces_utf8_and_windows_drive() {
        assert_eq!(
            parse_file_uri_path("file:///Users/wzt/My%20Repo/%E6%B5%8B%E8%AF%95"),
            Some("/Users/wzt/My Repo/测试".to_string())
        );
        assert_eq!(
            parse_file_uri_path("file:///C:/Users/wzt/project/"),
            Some("C:/Users/wzt/project".to_string())
        );
        assert_eq!(
            extract_primary_workspace_path(r#"["file:///Users/wzt/G/ccem"]"#),
            Some("/Users/wzt/G/ccem".to_string())
        );
    }

    #[test]
    fn parses_go_sqlite_and_rfc3339_timestamps_and_rejects_zero_time() {
        assert_eq!(parse_agy_timestamp_millis("0001-01-01 00:00:00+00:00"), 0);
        assert!(parse_agy_timestamp_millis("2026-11-21 08:57:18.264499+00:00") > 0);
        assert_eq!(
            parse_agy_timestamp_millis("2026-11-21T03:52:10Z"),
            parse_agy_timestamp_millis("2026-11-21 03:52:10+00:00")
        );
    }

    #[test]
    fn loads_history_from_db_excludes_subagents_and_ghosts_and_includes_brain_fallback() {
        let dir = make_temp_dir("history-load");
        let conn = create_summaries_db(&dir);

        // 1. Main conversation in DB with title + workspace
        conn.execute(
            "INSERT INTO conversation_summaries \
             (conversation_id, title, preview, step_count, last_modified_time, last_user_input_time, workspace_uris, status, parent_conversation_id, nesting_depth, app_data_dir) \
             VALUES (?1, ?2, ?3, 12, '2026-11-21 05:58:59+00:00', '2026-11-21 05:57:42+00:00', ?4, 'CASCADE_RUN_STATUS_IDLE', '', 0, 'antigravity-cli')",
            rusqlite::params![
                "parent-1",
                "CCEM Agy Integration",
                "raw preview",
                r#"["file:///Users/wzt/G/ccem"]"#,
            ],
        )
        .unwrap();

        // 2. Subagent conversation -> must be hidden from top-level list
        conn.execute(
            "INSERT INTO conversation_summaries \
             (conversation_id, title, preview, step_count, last_modified_time, last_user_input_time, workspace_uris, status, parent_conversation_id, nesting_depth, app_data_dir) \
             VALUES ('child-1', '', '', 40, '2026-11-21 05:59:00+00:00', '0001-01-01 00:00:00+00:00', ?1, 'CASCADE_RUN_STATUS_IDLE', 'parent-1', 1, 'antigravity-cli')",
            rusqlite::params![r#"["file:///Users/wzt/G/ccem"]"#],
        )
        .unwrap();

        // 3. Ghost entry from another app_data_dir with no transcript -> skipped
        conn.execute(
            "INSERT INTO conversation_summaries \
             (conversation_id, title, preview, step_count, last_modified_time, last_user_input_time, workspace_uris, status, parent_conversation_id, nesting_depth, app_data_dir) \
             VALUES ('ghost-1', '', '', 2, '2025-12-27 15:16:45+00:00', '0001-01-01 00:00:00+00:00', '', '', '', 0, 'antigravity')",
            [],
        )
        .unwrap();
        drop(conn);

        // 4. Brand-new conversation only on disk under brain/ (not yet in DB)
        write_transcript(
            &dir,
            "fresh-1",
            TRANSCRIPT_COMPACT_NAME,
            &[json!({
                "step_index": 0,
                "source": "USER_EXPLICIT",
                "type": "USER_INPUT",
                "status": "DONE",
                "created_at": "2026-11-21T09:00:00Z",
                "content": "<USER_REQUEST>\n新创建的 agy 会话\n</USER_REQUEST>"
            })],
        );

        let sessions = load_agy_history_from_home(&dir).expect("load agy history");
        let ids: HashSet<&str> = sessions.iter().map(|s| s.id.as_str()).collect();
        assert!(ids.contains("parent-1"));
        assert!(ids.contains("fresh-1"));
        assert!(!ids.contains("child-1"));
        assert!(!ids.contains("ghost-1"));

        let parent = sessions.iter().find(|s| s.id == "parent-1").unwrap();
        assert_eq!(parent.source, "agy");
        assert_eq!(parent.display, "CCEM Agy Integration");
        assert_eq!(parent.project, "/Users/wzt/G/ccem");
        assert_eq!(parent.project_name, "ccem");
        assert_eq!(parent.cwd.as_deref(), Some("/Users/wzt/G/ccem"));
        assert_eq!(parent.env_name, None);
        assert_eq!(parent.config_source, None);

        let fresh = sessions.iter().find(|s| s.id == "fresh-1").unwrap();
        assert_eq!(fresh.display, "新创建的 agy 会话");
        assert_eq!(fresh.config_source, None);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn hides_unflushed_system_only_subagent_even_when_db_is_populated() {
        let dir = make_temp_dir("unflushed-subagent");
        let conn = create_summaries_db(&dir);
        conn.execute(
            "INSERT INTO conversation_summaries \
             (conversation_id, title, preview, step_count, last_modified_time, last_user_input_time, workspace_uris, status, parent_conversation_id, nesting_depth, app_data_dir) \
             VALUES ('main-1', 'Main Thread', '', 4, '2026-11-21 05:58:59+00:00', '2026-11-21 05:57:42+00:00', '[\"file:///repo\"]', 'CASCADE_RUN_STATUS_IDLE', '', 0, 'antigravity-cli')",
            [],
        )
        .unwrap();
        drop(conn);

        // Subagent transcript written to disk before conversation_summaries row exists
        write_transcript(
            &dir,
            "unflushed-sub-1",
            TRANSCRIPT_COMPACT_NAME,
            &[json!({
                "step_index": 0,
                "source": "SYSTEM",
                "type": "SYSTEM_MESSAGE",
                "status": "DONE",
                "created_at": "2026-11-21T06:00:00Z",
                "content": "subagent boot"
            })],
        );

        let sessions = load_agy_history_from_home(&dir).expect("load history");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "main-1");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn tolerates_minimal_summaries_schema_without_optional_columns() {
        let dir = make_temp_dir("minimal-schema");
        let db_path = dir.join(SUMMARIES_DB_NAME);
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE conversation_summaries (
                conversation_id text PRIMARY KEY,
                title text,
                last_modified_time datetime,
                workspace_uris text
            );
            INSERT INTO conversation_summaries (conversation_id, title, last_modified_time, workspace_uris)
            VALUES ('legacy-1', 'Old Schema Session', '2026-11-21 08:00:00+00:00', '[\"file://LOCALHOST/Users/wzt/repo\"]');",
        )
        .unwrap();
        drop(conn);

        let sessions = load_agy_history_from_home(&dir).expect("load minimal schema");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "legacy-1");
        assert_eq!(sessions[0].display, "Old Schema Session");
        assert_eq!(sessions[0].project, "/Users/wzt/repo");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_conversation_detail_with_thinking_unwrapped_tool_args_and_results() {
        let dir = make_temp_dir("detail-parse");
        let path = write_transcript(
            &dir,
            "conv-1",
            TRANSCRIPT_FULL_NAME,
            &[
                json!({
                    "step_index": 0,
                    "source": "USER_EXPLICIT",
                    "type": "USER_INPUT",
                    "status": "DONE",
                    "created_at": "2026-11-21T03:52:10Z",
                    "content": "<USER_REQUEST>\n检查文件\n</USER_REQUEST>\n<ADDITIONAL_METADATA>meta</ADDITIONAL_METADATA>"
                }),
                json!({
                    "step_index": 1,
                    "source": "MODEL",
                    "type": "PLANNER_RESPONSE",
                    "status": "DONE",
                    "created_at": "2026-11-21T03:52:11Z",
                    "model": "gemini-4-neon-high",
                    "input_tokens": 14126,
                    "cache_read_tokens": 0,
                    "output_tokens": 542,
                    "thinking": "Let me read the file.",
                    "tool_calls": [
                        {
                            "name": "read_file",
                            "args": { "Path": "\"/repo/src/lib.rs\"", "StartLine": "1" }
                        },
                        {
                            "name": "run_command",
                            "args": { "CommandLine": "\"cargo test\"" }
                        }
                    ]
                }),
                json!({
                    "step_index": 2,
                    "source": "MODEL",
                    "type": "GENERIC",
                    "status": "DONE",
                    "created_at": "2026-11-21T03:52:12Z",
                    "content": "fn main() {}"
                }),
                json!({
                    "step_index": 3,
                    "source": "MODEL",
                    "type": "GENERIC",
                    "status": "ERROR",
                    "error": "exit code 1",
                    "created_at": "2026-11-21T03:52:13Z",
                    "content": "test failed"
                }),
                json!({
                    "step_index": 4,
                    "source": "SYSTEM",
                    "type": "SYSTEM_MESSAGE",
                    "status": "DONE",
                    "created_at": "2026-11-21T03:52:14Z",
                    "content": "internal nudge"
                }),
                json!({
                    "step_index": 5,
                    "source": "MODEL",
                    "type": "PLANNER_RESPONSE",
                    "status": "DONE",
                    "created_at": "2026-11-21T03:52:15Z",
                    "model": "gemini-4-neon-high",
                    "input_tokens": 1200,
                    "cache_read_tokens": 14127,
                    "output_tokens": 80,
                    "content": "检查完成。"
                }),
            ],
        );

        let (messages, segments) =
            parse_agy_conversation_file(&path, "conv-1").expect("parse detail");
        assert_eq!(segments.len(), 1);
        // user + planner + 2 tool_result synthetic users + final planner (SYSTEM_MESSAGE skipped)
        assert_eq!(messages.len(), 5);
        assert_eq!(messages[0].msg_type, "user");
        assert_eq!(messages[0].content[0]["text"], "检查文件");

        let planner = &messages[1];
        assert_eq!(planner.msg_type, "assistant");
        assert_eq!(planner.model.as_deref(), Some("gemini-4-neon-high"));
        assert_eq!(planner.input_tokens, Some(14126));
        assert_eq!(planner.cache_read_tokens, Some(0));
        assert_eq!(planner.output_tokens, Some(542));
        let blocks = planner.content.as_array().unwrap();
        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[0]["type"], "thinking");
        assert_eq!(blocks[1]["type"], "tool_use");
        assert_eq!(blocks[1]["name"], "read_file");
        assert_eq!(blocks[1]["input"]["Path"], "/repo/src/lib.rs");
        assert_eq!(blocks[1]["input"]["StartLine"], 1);
        assert_eq!(blocks[2]["name"], "run_command");
        assert_eq!(blocks[2]["input"]["CommandLine"], "cargo test");

        // Tool results match tool_use IDs and preserve error flag
        assert_eq!(messages[2].content[0]["type"], "tool_result");
        assert_eq!(messages[2].content[0]["tool_use_id"], blocks[1]["id"]);
        assert_eq!(messages[2].content[0]["is_error"], false);
        assert_eq!(messages[3].content[0]["tool_use_id"], blocks[2]["id"]);
        assert_eq!(messages[3].content[0]["is_error"], true);
        assert!(messages[3].content[0]["content"]
            .as_str()
            .unwrap()
            .contains("exit code 1"));

        let final_msg = &messages[4];
        assert_eq!(final_msg.content[0]["text"], "检查完成。");
        assert_eq!(final_msg.cache_read_tokens, Some(14127));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn loads_subagents_and_detail_for_parent_conversation() {
        let dir = make_temp_dir("subagents");
        let conn = create_summaries_db(&dir);
        conn.execute(
            "INSERT INTO conversation_summaries \
             (conversation_id, title, preview, step_count, last_modified_time, last_user_input_time, workspace_uris, status, agent_name, parent_conversation_id, nesting_depth, killed, app_data_dir) \
             VALUES ('sub-1', 'Backend Recon', '', 10, '2026-11-21 02:32:05+00:00', '0001-01-01 00:00:00+00:00', '[\"file:///repo\"]', 'CASCADE_RUN_STATUS_IDLE', 'recon-backend', 'parent-1', 1, 1, 'antigravity-cli')",
            [],
        )
        .unwrap();
        drop(conn);

        write_transcript(
            &dir,
            "sub-1",
            TRANSCRIPT_COMPACT_NAME,
            &[
                json!({
                    "step_index": 0,
                    "source": "SYSTEM",
                    "type": "SYSTEM_MESSAGE",
                    "status": "DONE",
                    "created_at": "2026-11-21T02:20:00Z",
                    "content": "boot"
                }),
                json!({
                    "step_index": 1,
                    "source": "MODEL",
                    "type": "PLANNER_RESPONSE",
                    "status": "DONE",
                    "created_at": "2026-11-21T02:21:00Z",
                    "model": "gemini-4-neon-high",
                    "input_tokens": 1000,
                    "output_tokens": 100,
                    "content": "Recon finished successfully.",
                    "tool_calls": [{ "name": "read_file", "args": { "Path": "\"/repo/a.rs\"" } }]
                }),
            ],
        );

        let payload = load_agy_subagents_in(&dir, "parent-1", Some("sub-1")).expect("subagents");
        assert_eq!(payload.subagents.len(), 1);
        let meta = &payload.subagents[0];
        assert_eq!(meta.agent_id, "sub-1");
        assert_eq!(meta.subagent_type.as_deref(), Some("recon-backend"));
        assert_eq!(meta.description.as_deref(), Some("Backend Recon"));
        assert_eq!(meta.status, "completed");
        assert_eq!(meta.tool_count, 1);
        assert_eq!(
            meta.result_summary.as_deref(),
            Some("Recon finished successfully.")
        );
        assert!(payload.detail.as_ref().is_some_and(|msgs| msgs.len() == 1));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_path_traversal_session_ids() {
        let dir = make_temp_dir("traversal");
        for bad in ["../etc/passwd", "a/b", ".", "..", "C:evil", "bad\0id"] {
            assert!(!has_agy_session_in(&dir, bad), "expected reject for {bad:?}");
            assert!(find_agy_transcript_path(&dir, bad, true).is_none());
        }
        let (msgs, _) = load_agy_conversation_detail_in(&dir, "../escape").unwrap();
        assert!(msgs.is_empty());
        assert_eq!(
            parse_file_uri_path("file://LOCALHOST/Users/wzt/app"),
            Some("/Users/wzt/app".to_string())
        );
        assert_eq!(
            parse_file_uri_path("file://localhost2/share"),
            Some("localhost2/share".to_string())
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
