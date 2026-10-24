//! Parent/child links between workspace sessions spawned from a proposal card.
//!
//! Keys are the frontend sidebar keys (`claude:<id>`, `codex:<id>`). A child is
//! first recorded under its runtime key and again under its provider key once
//! the provider id is known, so the link survives the runtime going away.

use crate::session_provenance::state_db_path;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::time::Duration;

const MAX_KEY_LEN: usize = 300;

fn open_db(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create sqlite state dir: {}", error))?;
    }
    let conn = Connection::open(path)
        .map_err(|error| format!("Failed to open sqlite state db: {}", error))?;
    conn.busy_timeout(Duration::from_secs(3))
        .map_err(|error| format!("Failed to configure sqlite busy timeout: {}", error))?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS session_lineage_links (
             child_key TEXT PRIMARY KEY,
             parent_key TEXT NOT NULL,
             proposal_id TEXT,
             created_at TEXT NOT NULL
         );",
    )
    .map_err(|error| format!("Failed to initialize session_lineage_links: {}", error))?;
    Ok(conn)
}

fn validate_key(value: &str) -> Result<&str, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_KEY_LEN || !trimmed.contains(':') {
        return Err(format!("Invalid session key: {:?}", value));
    }
    Ok(trimmed)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionParentLink {
    pub child_key: String,
    pub parent_key: String,
    pub proposal_id: Option<String>,
}

fn record_at(
    path: &Path,
    child_key: &str,
    parent_key: &str,
    proposal_id: Option<&str>,
) -> Result<(), String> {
    let child = validate_key(child_key)?;
    let parent = validate_key(parent_key)?;
    if child == parent {
        return Err("A session cannot be its own parent".to_string());
    }
    let proposal = proposal_id
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= MAX_KEY_LEN);
    open_db(path)?
        .execute(
            "INSERT INTO session_lineage_links (child_key, parent_key, proposal_id, created_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(child_key) DO UPDATE SET
                 parent_key = excluded.parent_key,
                 proposal_id = COALESCE(excluded.proposal_id, session_lineage_links.proposal_id)",
            params![child, parent, proposal, chrono::Utc::now().to_rfc3339()],
        )
        .map_err(|error| format!("Failed to record session parent: {}", error))?;
    Ok(())
}

fn list_at(path: &Path) -> Result<Vec<SessionParentLink>, String> {
    let conn = open_db(path)?;
    let mut statement = conn
        .prepare("SELECT child_key, parent_key, proposal_id FROM session_lineage_links ORDER BY created_at")
        .map_err(|error| format!("Failed to read session parents: {}", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok(SessionParentLink {
                child_key: row.get(0)?,
                parent_key: row.get(1)?,
                proposal_id: row.get(2)?,
            })
        })
        .map_err(|error| format!("Failed to read session parents: {}", error))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read session parents: {}", error))
}

#[tauri::command]
pub fn record_session_parent(
    child_key: String,
    parent_key: String,
    proposal_id: Option<String>,
) -> Result<(), String> {
    record_at(&state_db_path(), &child_key, &parent_key, proposal_id.as_deref())
}

#[tauri::command]
pub fn list_session_parents() -> Result<Vec<SessionParentLink>, String> {
    list_at(&state_db_path())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_upserts_and_lists_parent_links() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.sqlite");
        record_at(&path, "claude:rt-child", "claude:parent", Some("toolu_1")).unwrap();
        record_at(&path, "claude:provider-child", "claude:parent", None).unwrap();
        // A later bind without a proposal id keeps the original proposal id.
        record_at(&path, "claude:rt-child", "claude:other", None).unwrap();
        let links = list_at(&path).unwrap();
        assert_eq!(links.len(), 2);
        let rt = links.iter().find(|link| link.child_key == "claude:rt-child").unwrap();
        assert_eq!(rt.parent_key, "claude:other");
        assert_eq!(rt.proposal_id.as_deref(), Some("toolu_1"));
        let provider = links.iter().find(|link| link.child_key == "claude:provider-child").unwrap();
        assert_eq!(provider.proposal_id, None);
    }

    #[test]
    fn rejects_self_parent_and_malformed_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.sqlite");
        assert!(record_at(&path, "claude:a", "claude:a", None).is_err());
        assert!(record_at(&path, "", "claude:a", None).is_err());
        assert!(record_at(&path, "no-colon", "claude:a", None).is_err());
        assert!(list_at(&path).unwrap().is_empty());
    }
}
