use crate::config::read_app_config;
use crate::session_provenance::bind_source_session_id;
use crate::terminal;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

pub const OPENCODE_NATIVE_ENV_NAME: &str = "OpenCode Native";
const OPENCODE_METADATA_FILE: &str = ".ccem/opencode-session-metadata.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenCodeSessionMetadata {
    pub env_name: String,
    pub config_source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default)]
    pub updated_at: u64,
}

#[derive(Debug, Clone)]
pub struct LocalOpenCodeSession {
    pub id: String,
    pub title: String,
    pub updated_at: u64,
    pub created_at: u64,
    pub project: Option<String>,
    pub env_name: Option<String>,
    pub config_source: Option<String>,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cost: f64,
    pub model: Option<String>,
}

#[derive(Debug, Clone)]
pub struct LocalOpenCodeMessage {
    pub id: String,
    pub role: String,
    pub model: Option<String>,
    pub timestamp: u64,
    pub content: Option<String>,
}

#[derive(Debug, Clone)]
pub struct OpenCodeSessionSnapshot {
    pub id: String,
    pub updated_at: u64,
    pub project: Option<String>,
}

pub fn load_session_list_value_from_cli_or_fixture() -> Result<Option<Value>, String> {
    if let Some(fixture_dir) = fixture_dir() {
        let sessions_path = fixture_dir.join("sessions.json");
        if !sessions_path.exists() {
            return Ok(None);
        }

        let content = fs::read_to_string(&sessions_path)
            .map_err(|error| format!("Failed to read OpenCode fixture sessions: {}", error))?;
        let value = serde_json::from_str::<Value>(&content)
            .map_err(|error| format!("Failed to parse OpenCode fixture sessions: {}", error))?;
        return Ok(Some(value));
    }

    let Some(opencode_path) = terminal::resolve_opencode_path() else {
        return Ok(None);
    };

    let output = Command::new(opencode_path)
        .args(["session", "list", "--format", "json"])
        .output()
        .map_err(|error| format!("Failed to execute opencode session list: {}", error))?;

    if !output.status.success() {
        return Ok(None);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let value = serde_json::from_str::<Value>(trimmed)
        .map_err(|error| format!("Failed to parse opencode session list JSON: {}", error))?;
    Ok(Some(value))
}

pub fn load_export_from_cli_or_fixture(session_id: &str) -> Result<Option<Value>, String> {
    if let Some(fixture_dir) = fixture_dir() {
        let export_path = fixture_dir
            .join("exports")
            .join(format!("{session_id}.json"));
        if !export_path.exists() {
            return Ok(None);
        }

        let content = fs::read_to_string(&export_path)
            .map_err(|error| format!("Failed to read OpenCode export fixture: {}", error))?;
        let value = serde_json::from_str::<Value>(&content)
            .map_err(|error| format!("Failed to parse OpenCode export fixture: {}", error))?;
        return Ok(Some(value));
    }

    let Some(opencode_path) = terminal::resolve_opencode_path() else {
        return Ok(None);
    };

    let output = Command::new(opencode_path)
        .args(["export", session_id])
        .output()
        .map_err(|error| format!("Failed to execute opencode export: {}", error))?;

    if !output.status.success() {
        return Ok(None);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let value = serde_json::from_str::<Value>(trimmed)
        .map_err(|error| format!("Failed to parse opencode export JSON: {}", error))?;
    Ok(Some(value))
}

pub fn snapshot_known_session_ids() -> HashSet<String> {
    load_session_list_value_from_cli_or_fixture()
        .ok()
        .flatten()
        .map(|value| {
            parse_session_snapshots(&value)
                .into_iter()
                .map(|item| item.id)
                .collect()
        })
        .unwrap_or_default()
}

pub fn track_launched_session(
    before_session_ids: HashSet<String>,
    env_name: String,
    config_source: String,
    project: String,
    resume_session_id: Option<String>,
    ccem_session_id: Option<String>,
) {
    if let Some(session_id) = resume_session_id {
        let _ = upsert_session_metadata(
            &session_id,
            OpenCodeSessionMetadata {
                env_name,
                config_source,
                project: normalize_optional_text(Some(project)),
                updated_at: current_timestamp_millis(),
            },
        );
        if let Some(ccem_session_id) = ccem_session_id.as_deref() {
            let _ = bind_source_session_id("opencode", ccem_session_id, &session_id);
        }
        return;
    }

    thread::spawn(move || {
        let started_at = Instant::now();
        while started_at.elapsed() < Duration::from_secs(15) {
            if let Ok(Some(value)) = load_session_list_value_from_cli_or_fixture() {
                let mut candidates: Vec<_> = parse_session_snapshots(&value)
                    .into_iter()
                    .filter(|session| !before_session_ids.contains(&session.id))
                    .collect();

                if !candidates.is_empty() {
                    candidates.sort_by_key(|session| std::cmp::Reverse(session.updated_at));
                    let selected = candidates
                        .iter()
                        .find(|session| {
                            session
                                .project
                                .as_ref()
                                .is_some_and(|candidate| candidate == &project)
                        })
                        .or_else(|| candidates.first());

                    if let Some(session) = selected {
                        let _ = upsert_session_metadata(
                            &session.id,
                            OpenCodeSessionMetadata {
                                env_name,
                                config_source,
                                project: normalize_optional_text(Some(project)),
                                updated_at: current_timestamp_millis(),
                            },
                        );
                        if let Some(ccem_session_id) = ccem_session_id.as_deref() {
                            let _ =
                                bind_source_session_id("opencode", ccem_session_id, &session.id);
                        }
                        return;
                    }
                }
            }

            thread::sleep(Duration::from_millis(400));
        }
    });
}

pub fn read_session_metadata(session_id: &str) -> Option<OpenCodeSessionMetadata> {
    read_session_metadata_map().remove(session_id)
}

pub fn list_local_sessions() -> Result<Vec<LocalOpenCodeSession>, String> {
    let metadata = read_session_metadata_map();
    Ok(scan_local_sessions(discover_storage_db_paths(), &metadata).0)
}

/// Analytics needs to distinguish a successful empty inventory from a
/// partial/failed scan. Other callers keep the historical best-effort API
/// above, while this variant exposes completeness without discarding usable
/// sessions returned by healthy databases.
pub fn list_local_sessions_with_completeness() -> (Vec<LocalOpenCodeSession>, bool) {
    let metadata = read_session_metadata_map();
    scan_local_sessions(discover_storage_db_paths(), &metadata)
}

fn scan_local_sessions(
    db_paths: Vec<PathBuf>,
    metadata: &HashMap<String, OpenCodeSessionMetadata>,
) -> (Vec<LocalOpenCodeSession>, bool) {
    let mut sessions_by_id: HashMap<String, LocalOpenCodeSession> = HashMap::new();
    let mut complete = true;

    for db_path in db_paths {
        let conn = match Connection::open(&db_path) {
            Ok(conn) => conn,
            Err(_) => {
                complete = false;
                continue;
            }
        };
        let inferred_project = storage_project_from_db_path(&db_path);

        let mut stmt = match conn.prepare(
            "SELECT s.id, s.title, s.updated_at, s.created_at, s.prompt_tokens, \
                s.completion_tokens, s.cost, \
                (SELECT m.model FROM messages m \
                  WHERE m.session_id = s.id AND m.model IS NOT NULL AND m.model != '' \
                  ORDER BY COALESCE(m.finished_at, m.updated_at, m.created_at) DESC LIMIT 1) AS model \
             FROM sessions s \
             WHERE s.parent_session_id IS NULL",
        ) {
            Ok(stmt) => stmt,
            Err(_) => {
                complete = false;
                continue;
            }
        };

        let rows = match stmt.query_map([], |row| {
            Ok(LocalOpenCodeSession {
                id: row.get::<_, String>(0)?,
                title: row.get::<_, String>(1)?,
                updated_at: normalize_unix_timestamp(row.get::<_, i64>(2)?),
                created_at: normalize_unix_timestamp(row.get::<_, i64>(3)?),
                project: inferred_project.clone(),
                env_name: None,
                config_source: None,
                prompt_tokens: row.get::<_, i64>(4).unwrap_or(0).max(0) as u64,
                completion_tokens: row.get::<_, i64>(5).unwrap_or(0).max(0) as u64,
                cost: row.get::<_, f64>(6).unwrap_or(0.0),
                model: normalize_optional_text(row.get::<_, Option<String>>(7).unwrap_or(None)),
            })
        }) {
            Ok(rows) => rows,
            Err(_) => {
                complete = false;
                continue;
            }
        };

        for row in rows {
            let row = match row {
                Ok(row) => row,
                Err(_) => {
                    complete = false;
                    continue;
                }
            };
            let metadata_entry = metadata.get(&row.id);
            let merged = apply_metadata_to_local_session(row, metadata_entry);
            match sessions_by_id.get(&merged.id) {
                Some(existing) if existing.updated_at >= merged.updated_at => {}
                _ => {
                    sessions_by_id.insert(merged.id.clone(), merged);
                }
            }
        }
    }

    let mut sessions: Vec<_> = sessions_by_id.into_values().collect();
    sessions.sort_by_key(|session| std::cmp::Reverse(session.updated_at));
    (sessions, complete)
}

pub fn load_local_messages(session_id: &str) -> Result<Option<Vec<LocalOpenCodeMessage>>, String> {
    for db_path in discover_storage_db_paths() {
        let Ok(conn) = Connection::open(&db_path) else {
            continue;
        };

        let has_session = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?1 LIMIT 1)",
                [session_id],
                |row| row.get::<_, i64>(0),
            )
            .map(|value| value > 0)
            .unwrap_or(false);

        if !has_session {
            continue;
        }

        let mut stmt = conn
            .prepare(
                "SELECT id, role, parts, model, COALESCE(finished_at, updated_at, created_at) \
                 FROM messages WHERE session_id = ?1 ORDER BY created_at ASC",
            )
            .map_err(|error| {
                format!("Failed to prepare OpenCode local message query: {}", error)
            })?;

        let rows = stmt
            .query_map([session_id], |row| {
                let raw_parts = row.get::<_, String>(2).unwrap_or_else(|_| "[]".to_string());
                Ok(LocalOpenCodeMessage {
                    id: row.get::<_, String>(0)?,
                    role: row.get::<_, String>(1)?,
                    content: extract_text_from_parts_json(&raw_parts),
                    model: normalize_optional_text(row.get::<_, Option<String>>(3).unwrap_or(None)),
                    timestamp: normalize_unix_timestamp(row.get::<_, i64>(4).unwrap_or(0)),
                })
            })
            .map_err(|error| format!("Failed to read OpenCode local messages: {}", error))?;

        let messages: Vec<_> = rows.flatten().collect();
        return Ok(Some(messages));
    }

    Ok(None)
}

fn apply_metadata_to_local_session(
    mut session: LocalOpenCodeSession,
    metadata: Option<&OpenCodeSessionMetadata>,
) -> LocalOpenCodeSession {
    if let Some(metadata) = metadata {
        if session.project.is_none() {
            session.project = metadata.project.clone();
        }
        if session.env_name.is_none() {
            session.env_name = Some(metadata.env_name.clone());
        }
        if session.config_source.is_none() {
            session.config_source = Some(metadata.config_source.clone());
        }
    }

    if session.env_name.is_none() {
        session.env_name = Some(OPENCODE_NATIVE_ENV_NAME.to_string());
    }
    if session.config_source.is_none() {
        session.config_source = Some("native".to_string());
    }

    session
}

fn upsert_session_metadata(
    session_id: &str,
    metadata: OpenCodeSessionMetadata,
) -> Result<(), String> {
    let path = metadata_file_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create OpenCode metadata directory: {}", error))?;
    }

    let mut all = read_session_metadata_map();
    all.insert(session_id.to_string(), metadata);
    let payload = serde_json::to_string_pretty(&all)
        .map_err(|error| format!("Failed to encode OpenCode metadata: {}", error))?;
    fs::write(&path, payload)
        .map_err(|error| format!("Failed to write OpenCode metadata: {}", error))?;
    Ok(())
}

fn read_session_metadata_map() -> HashMap<String, OpenCodeSessionMetadata> {
    let Ok(path) = metadata_file_path() else {
        return HashMap::new();
    };

    let Ok(content) = fs::read_to_string(path) else {
        return HashMap::new();
    };

    serde_json::from_str::<HashMap<String, OpenCodeSessionMetadata>>(&content).unwrap_or_default()
}

fn metadata_file_path() -> Result<PathBuf, String> {
    let home = std::env::var("CCEM_OPENCODE_METADATA_HOME")
        .ok()
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .ok_or_else(|| "Failed to resolve home directory".to_string())?;
    Ok(home.join(OPENCODE_METADATA_FILE))
}

fn fixture_dir() -> Option<PathBuf> {
    std::env::var("CCEM_OPENCODE_FIXTURE_DIR")
        .ok()
        .map(PathBuf::from)
        .filter(|path| path.exists())
}

fn parse_session_snapshots(value: &Value) -> Vec<OpenCodeSessionSnapshot> {
    let items = value
        .as_array()
        .or_else(|| value.get("sessions").and_then(|raw| raw.as_array()));

    let mut sessions = Vec::new();
    if let Some(items) = items {
        for item in items {
            let Some(id) = extract_string(item, &["id", "sessionId", "session_id"]) else {
                continue;
            };

            sessions.push(OpenCodeSessionSnapshot {
                id,
                updated_at: extract_timestamp(item).unwrap_or(0),
                project: normalize_optional_text(extract_string(
                    item,
                    &["cwd", "path", "projectPath", "project"],
                )),
            });
        }
    }

    sessions
}

fn discover_storage_db_paths() -> Vec<PathBuf> {
    let mut discovered = Vec::new();
    let mut seen = HashSet::new();

    let mut push = |path: PathBuf| {
        if path.exists() && seen.insert(path.clone()) {
            discovered.push(path);
        }
    };

    if let Some(root) = configured_data_root() {
        push(root.join("opencode.db"));
        push(root.join("storage").join("opencode.db"));

        let project_root = root.join("project");
        if let Ok(entries) = fs::read_dir(&project_root) {
            for entry in entries.flatten() {
                let path = entry.path();
                push(path.join("storage").join("opencode.db"));
                push(path.join("opencode.db"));
            }
        }
    }

    for project_root in known_project_roots() {
        push(project_root.join(".opencode").join("opencode.db"));
        push(
            project_root
                .join(".opencode")
                .join("storage")
                .join("opencode.db"),
        );
    }

    discovered
}

fn configured_data_root() -> Option<PathBuf> {
    std::env::var("CCEM_OPENCODE_DATA_DIR")
        .ok()
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".local").join("share").join("opencode")))
        .filter(|path| path.exists())
}

fn known_project_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let mut seen = HashSet::new();

    let mut push = |path: PathBuf| {
        if path.exists() && seen.insert(path.clone()) {
            roots.push(path);
        }
    };

    if let Ok(app_config) = read_app_config() {
        for favorite in app_config.favorites {
            push(PathBuf::from(favorite.path));
        }
        for recent in app_config.recent {
            push(PathBuf::from(recent.path));
        }
        for project in app_config.vscode_projects {
            push(PathBuf::from(project.path));
        }
        for project in app_config.jetbrains_projects {
            push(PathBuf::from(project.path));
        }
    }

    for metadata in read_session_metadata_map().into_values() {
        if let Some(project) = metadata.project {
            push(PathBuf::from(project));
        }
    }

    roots
}

fn storage_project_from_db_path(db_path: &Path) -> Option<String> {
    let parent = db_path.parent()?;
    let parent_name = parent.file_name().and_then(|name| name.to_str());

    if parent_name == Some(".opencode") {
        return parent
            .parent()
            .map(|path| path.to_string_lossy().to_string());
    }

    if parent_name == Some("storage") {
        let container = parent.parent()?;
        let container_name = container.file_name().and_then(|name| name.to_str());
        if container_name == Some(".opencode") {
            return container
                .parent()
                .map(|path| path.to_string_lossy().to_string());
        }
        if let Some(slug) = container_name {
            return infer_project_root_from_slug(slug);
        }
    }

    if parent
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        == Some("project")
    {
        return parent
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(infer_project_root_from_slug);
    }

    None
}

fn infer_project_root_from_slug(slug: &str) -> Option<String> {
    let mut matches = known_project_roots()
        .into_iter()
        .filter(|path| path.file_name().and_then(|name| name.to_str()) == Some(slug));

    let first = matches.next()?;
    if matches.next().is_some() {
        return None;
    }

    Some(first.to_string_lossy().to_string())
}

fn extract_text_from_parts_json(raw_parts: &str) -> Option<String> {
    let Ok(value) = serde_json::from_str::<Value>(raw_parts) else {
        return None;
    };
    extract_text_from_value(&value)
}

fn extract_text_from_value(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str().filter(|text| !text.trim().is_empty()) {
        return Some(text.to_string());
    }

    if let Some(array) = value.as_array() {
        let parts = array
            .iter()
            .filter_map(|item| {
                let wrapped = item
                    .get("data")
                    .and_then(extract_text_from_value)
                    .or_else(|| item.get("text").and_then(extract_text_from_value))
                    .or_else(|| item.get("thinking").and_then(extract_text_from_value))
                    .or_else(|| item.get("content").and_then(extract_text_from_value));
                wrapped
            })
            .collect::<Vec<_>>();

        if !parts.is_empty() {
            return Some(parts.join("\n\n"));
        }
    }

    let object = value.as_object()?;
    for key in [
        "data", "text", "thinking", "content", "message", "body", "output", "input",
    ] {
        if let Some(text) = object.get(key).and_then(extract_text_from_value) {
            return Some(text);
        }
    }

    None
}

fn extract_string(value: &Value, keys: &[&str]) -> Option<String> {
    let object = value.as_object()?;
    for key in keys {
        let Some(raw) = object.get(*key) else {
            continue;
        };

        if let Some(text) = raw.as_str().filter(|text| !text.trim().is_empty()) {
            return Some(text.to_string());
        }

        if let Some(path) = raw
            .as_object()
            .and_then(|nested| nested.get("path"))
            .and_then(|nested| nested.as_str())
            .filter(|text| !text.trim().is_empty())
        {
            return Some(path.to_string());
        }
    }

    None
}

fn extract_timestamp(value: &Value) -> Option<u64> {
    for key in ["timestamp", "updatedAt", "createdAt", "lastUpdated"] {
        let Some(raw) = value.get(key) else {
            continue;
        };

        if let Some(number) = raw.as_i64() {
            return Some(normalize_unix_timestamp(number));
        }
        if let Some(text) = raw.as_str().filter(|text| !text.trim().is_empty()) {
            if let Ok(number) = text.parse::<i64>() {
                return Some(normalize_unix_timestamp(number));
            }
            if let Ok(timestamp) = chrono::DateTime::parse_from_rfc3339(text) {
                return Some(timestamp.timestamp_millis() as u64);
            }
        }
    }

    None
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|text| {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn normalize_unix_timestamp(value: i64) -> u64 {
    if value <= 0 {
        return 0;
    }

    let value = value as u64;
    if value > 10_000_000_000 {
        value
    } else {
        value.saturating_mul(1000)
    }
}

fn current_timestamp_millis() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}

#[cfg(test)]
mod tests {
    use super::{
        extract_text_from_parts_json, list_local_sessions, load_local_messages,
        read_session_metadata, storage_project_from_db_path, track_launched_session,
        scan_local_sessions, OPENCODE_NATIVE_ENV_NAME,
    };
    use rusqlite::Connection;
    use std::collections::{HashMap, HashSet};
    use std::fs;
    use std::path::PathBuf;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "ccem-opencode-test-{}-{}",
            name,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create temp root");
        root
    }

    fn create_test_db(path: &PathBuf) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create db parent");
        }

        let conn = Connection::open(path).expect("open sqlite");
        conn.execute_batch(
            "CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                parent_session_id TEXT,
                title TEXT NOT NULL,
                message_count INTEGER NOT NULL DEFAULT 0,
                prompt_tokens INTEGER NOT NULL DEFAULT 0,
                completion_tokens INTEGER NOT NULL DEFAULT 0,
                cost REAL NOT NULL DEFAULT 0.0,
                updated_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                summary_message_id TEXT
             );
             CREATE TABLE messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                parts TEXT NOT NULL,
                model TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                finished_at INTEGER
             );",
        )
        .expect("create schema");

        conn.execute(
            "INSERT INTO sessions (id, parent_session_id, title, message_count, prompt_tokens, completion_tokens, cost, updated_at, created_at)
             VALUES (?1, NULL, ?2, 2, 1200, 340, 0.42, 1713170110, 1713170090)",
            ("fixture-session", "Fixture session"),
        )
        .expect("insert session");
        conn.execute(
            "INSERT INTO messages (id, session_id, role, parts, model, created_at, updated_at, finished_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 1713170090, 1713170090, 1713170090)",
            (
                "msg-1",
                "fixture-session",
                "user",
                r#"[{"type":"text","data":{"text":"检查 OpenCode fallback"}}]"#,
                Option::<String>::None,
            ),
        )
        .expect("insert user msg");
        conn.execute(
            "INSERT INTO messages (id, session_id, role, parts, model, created_at, updated_at, finished_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 1713170110, 1713170110, 1713170110)",
            (
                "msg-2",
                "fixture-session",
                "assistant",
                r#"[{"type":"text","data":{"text":"已经进入 fallback 路径"}}]"#,
                Some("anthropic/claude-sonnet-4-5".to_string()),
            ),
        )
        .expect("insert assistant msg");
    }

    #[test]
    fn extract_text_from_parts_json_reads_wrapped_parts() {
        assert_eq!(
            extract_text_from_parts_json(
                r#"[{"type":"text","data":{"text":"hello"}},{"type":"reasoning","data":{"thinking":"world"}}]"#
            )
            .as_deref(),
            Some("hello\n\nworld")
        );
    }

    #[test]
    fn local_db_fallback_loads_sessions_and_messages() {
        let root = temp_root("db");
        let db_path = root
            .join("project")
            .join("demo")
            .join("storage")
            .join("opencode.db");
        create_test_db(&db_path);
        std::env::set_var("CCEM_OPENCODE_DATA_DIR", &root);

        let sessions = list_local_sessions().expect("load local sessions");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "fixture-session");
        assert_eq!(
            sessions[0].env_name.as_deref(),
            Some(OPENCODE_NATIVE_ENV_NAME)
        );
        assert_eq!(
            sessions[0].model.as_deref(),
            Some("anthropic/claude-sonnet-4-5")
        );

        let messages = load_local_messages("fixture-session")
            .expect("load local messages")
            .expect("messages present");
        assert_eq!(messages.len(), 2);
        assert_eq!(
            messages[0].content.as_deref(),
            Some("检查 OpenCode fallback")
        );
        assert_eq!(
            messages[1].content.as_deref(),
            Some("已经进入 fallback 路径")
        );

        std::env::remove_var("CCEM_OPENCODE_DATA_DIR");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn corrupt_local_db_marks_session_inventory_incomplete() {
        let root = temp_root("corrupt-db");
        let db_path = root.join("opencode.db");
        fs::write(&db_path, b"not a sqlite database").expect("write corrupt db fixture");

        let (sessions, complete) =
            scan_local_sessions(vec![db_path], &HashMap::new());

        assert!(sessions.is_empty());
        assert!(
            !complete,
            "a discovered but unreadable DB must not become an authoritative empty inventory"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn storage_project_from_project_local_db_returns_absolute_project_root() {
        let project_root = temp_root("project-root");
        let db_path = project_root
            .join(".opencode")
            .join("storage")
            .join("opencode.db");

        assert_eq!(
            storage_project_from_db_path(&db_path).as_deref(),
            Some(project_root.to_string_lossy().as_ref())
        );
    }

    #[test]
    fn resume_tracking_persists_metadata_immediately() {
        let home = temp_root("home");
        std::env::set_var("CCEM_OPENCODE_METADATA_HOME", &home);
        track_launched_session(
            HashSet::new(),
            "Fixture Anthropic".to_string(),
            "ccem".to_string(),
            "/tmp/project".to_string(),
            Some("resume-session".to_string()),
            Some("ccem-session".to_string()),
        );

        let metadata = read_session_metadata("resume-session").expect("metadata");
        assert_eq!(metadata.env_name, "Fixture Anthropic");
        assert_eq!(metadata.config_source, "ccem");
        assert_eq!(metadata.project.as_deref(), Some("/tmp/project"));

        std::env::remove_var("CCEM_OPENCODE_METADATA_HOME");
        let _ = fs::remove_dir_all(home);
    }
}
