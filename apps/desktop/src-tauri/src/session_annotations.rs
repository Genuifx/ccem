// apps/desktop/src-tauri/src/session_annotations.rs
//
// User-editable workflow stage, expressive sticker, short label, and archive
// metadata for history sessions. Persisted outside provider history so
// Claude/Codex files remain immutable.

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::config::get_ccem_dir;

const VALID_STAGES: &[&str] = &[
    "ideation",
    "implementation",
    "validation",
    "release",
    "done",
];
const VALID_STICKERS: &[&str] = &[
    "focused",
    "excited",
    "calm",
    "blocked",
    "confused",
    "waiting",
    "urgent",
    "reviewing",
    "shipping",
    "celebrating",
    "risky",
    "archived",
];
const MAX_LABEL_CHARS: usize = 24;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct SessionAnnotation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sticker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Explicit user archive choice. `None` defers to the provider's native
    /// archive state (Codex `archived_sessions`); `Some(false)` overrides it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    /// Milliseconds, same unit as `HistorySession.timestamp`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<u64>,
    pub updated_at: u64,
}

impl SessionAnnotation {
    fn is_empty(&self) -> bool {
        self.stage.is_none()
            && self.sticker.is_none()
            && self.label.is_none()
            && self.archived.is_none()
    }
}

/// Effective archive state. A session archived in CCEM resurfaces once it has
/// activity newer than the archive time (e.g. resumed from the CLI).
pub fn effective_archived(
    annotation: Option<&SessionAnnotation>,
    native_archived: bool,
    last_activity_ms: u64,
) -> bool {
    match annotation.and_then(|item| item.archived.map(|archived| (archived, item.archived_at))) {
        Some((true, archived_at)) => last_activity_ms <= archived_at.unwrap_or(u64::MAX),
        Some((false, _)) => false,
        None => native_archived,
    }
}

#[derive(Serialize, Deserialize, Default, Debug)]
pub struct SessionAnnotations {
    entries: HashMap<String, SessionAnnotation>,
}

impl SessionAnnotations {
    fn path() -> PathBuf {
        get_ccem_dir().join("session_annotations.json")
    }

    fn lock_path() -> PathBuf {
        get_ccem_dir().join("session_annotations.json.lock")
    }

    fn key(source: &str, id: &str) -> String {
        format!("{}:{}", source, id)
    }

    pub fn load() -> Self {
        Self::load_from_path(&Self::path()).unwrap_or_default()
    }

    pub fn load_from_path(path: &Path) -> std::io::Result<Self> {
        match fs::read_to_string(path) {
            Ok(content) => Ok(serde_json::from_str(&content).unwrap_or_default()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(error),
        }
    }

    pub fn save_to_path(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self)
            .map_err(|error| std::io::Error::new(ErrorKind::InvalidData, error))?;
        fs::write(path, json)
    }

    fn load_locked() -> std::io::Result<(Self, fs::File)> {
        let path = Self::path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        let lock_file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(Self::lock_path())?;
        lock_file.lock_exclusive()?;

        let data = Self::load_from_path(&path).unwrap_or_default();
        Ok((data, lock_file))
    }

    fn save_locked(&self) -> std::io::Result<()> {
        let path = Self::path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        let json = serde_json::to_string_pretty(self)
            .map_err(|error| std::io::Error::new(ErrorKind::InvalidData, error))?;
        let tmp = path.with_extension("tmp");
        fs::write(&tmp, json)?;
        fs::rename(tmp, path)
    }

    pub fn get(&self, source: &str, id: &str) -> Option<&SessionAnnotation> {
        self.entries.get(&Self::key(source, id))
    }

    pub fn set(&mut self, source: &str, id: &str, annotation: SessionAnnotation) {
        self.entries.insert(Self::key(source, id), annotation);
    }

    pub fn remove(&mut self, source: &str, id: &str) {
        self.entries.remove(&Self::key(source, id));
    }

    pub fn validate_stage(value: Option<&str>) -> Result<(), String> {
        match value {
            Some(stage) if !VALID_STAGES.contains(&stage) => {
                Err(format!("Unsupported session stage: {}", stage))
            }
            _ => Ok(()),
        }
    }

    pub fn validate_sticker(value: Option<&str>) -> Result<(), String> {
        match value {
            Some(sticker) if !VALID_STICKERS.contains(&sticker) => {
                Err(format!("Unsupported session sticker: {}", sticker))
            }
            _ => Ok(()),
        }
    }
}

fn normalize_optional(value: Option<String>) -> Option<String> {
    value.and_then(|item| {
        let trimmed = item.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn normalize_label(value: Option<String>) -> Option<String> {
    normalize_optional(value).map(|label| label.chars().take(MAX_LABEL_CHARS).collect())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[tauri::command]
pub async fn set_session_annotation(
    source: String,
    session_id: String,
    stage: Option<String>,
    sticker: Option<String>,
    label: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let stage = normalize_optional(stage);
        let sticker = normalize_optional(sticker);
        let label = normalize_label(label);

        SessionAnnotations::validate_stage(stage.as_deref())?;
        SessionAnnotations::validate_sticker(sticker.as_deref())?;

        let (mut annotations, _lock) = SessionAnnotations::load_locked()
            .map_err(|error| format!("Failed to acquire annotation lock: {}", error))?;

        // Stage/sticker/label edits must not drop the archive state.
        let existing = annotations.get(&source, &session_id).cloned().unwrap_or_default();
        let next = SessionAnnotation {
            stage,
            sticker,
            label,
            archived: existing.archived,
            archived_at: existing.archived_at,
            updated_at: now_secs(),
        };
        if next.is_empty() {
            annotations.remove(&source, &session_id);
        } else {
            annotations.set(&source, &session_id, next);
        }

        annotations
            .save_locked()
            .map_err(|error| format!("Failed to save session annotation: {}", error))?;
        Ok(())
    })
    .await
    .map_err(|error| format!("Task error: {}", error))?
}

#[tauri::command]
pub async fn clear_session_annotation(source: String, session_id: String) -> Result<(), String> {
    set_session_annotation(source, session_id, None, None, None).await
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionArchiveTarget {
    pub source: String,
    pub session_id: String,
}

impl SessionAnnotations {
    /// `None` clears the override (undo), deferring to the native state.
    pub fn set_archived(&mut self, source: &str, id: &str, archived: Option<bool>, now_ms: u64) {
        let mut next = self.get(source, id).cloned().unwrap_or_default();
        next.archived = archived;
        next.archived_at = (archived == Some(true)).then_some(now_ms);
        next.updated_at = now_ms / 1000;
        if next.is_empty() {
            self.remove(source, id);
        } else {
            self.set(source, id, next);
        }
    }
}

/// Archive or unarchive sessions in one locked write (row action, bulk
/// project archive, and undo all go through here).
#[tauri::command]
pub async fn set_sessions_archived(
    targets: Vec<SessionArchiveTarget>,
    archived: Option<bool>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (mut annotations, _lock) = SessionAnnotations::load_locked()
            .map_err(|error| format!("Failed to acquire annotation lock: {}", error))?;
        let now = now_millis();
        for target in &targets {
            annotations.set_archived(&target.source, &target.session_id, archived, now);
        }
        annotations
            .save_locked()
            .map_err(|error| format!("Failed to save session archive state: {}", error))
    })
    .await
    .map_err(|error| format!("Task error: {}", error))?
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionArchiveOverlayEntry {
    pub source: String,
    pub session_id: String,
    pub archived_at: u64,
}

impl SessionAnnotations {
    fn archive_overlay(&self) -> Vec<SessionArchiveOverlayEntry> {
        self.entries
            .iter()
            .filter(|(_, item)| item.archived == Some(true))
            .filter_map(|(key, item)| {
                let (source, session_id) = key.split_once(':')?;
                Some(SessionArchiveOverlayEntry {
                    source: source.to_string(),
                    session_id: session_id.to_string(),
                    archived_at: item.archived_at.unwrap_or(u64::MAX),
                })
            })
            .collect()
    }
}

/// CCEM-archived sessions only (no provider scan). The workspace uses it to
/// hide live native rows, which bypass the history list's archive filter.
#[tauri::command]
pub async fn get_session_archive_overlay() -> Result<Vec<SessionArchiveOverlayEntry>, String> {
    tauri::async_runtime::spawn_blocking(|| SessionAnnotations::load().archive_overlay())
        .await
        .map_err(|error| format!("Task error: {}", error))
}

#[cfg(test)]
mod tests {
    use super::{effective_archived, SessionAnnotation, SessionAnnotations};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_annotations_path(prefix: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        std::env::temp_dir().join(format!("ccem-session-annotations-{prefix}-{unique}.json"))
    }

    #[test]
    fn stores_and_reloads_session_annotation_by_source_and_id() {
        let path = temp_annotations_path("roundtrip");
        let mut annotations = SessionAnnotations::default();

        annotations.set(
            "codex",
            "session-1",
            SessionAnnotation {
                stage: Some("validation".to_string()),
                sticker: Some("focused".to_string()),
                label: Some("等我跑完整回归".to_string()),
                updated_at: 42,
                ..Default::default()
            },
        );
        annotations.save_to_path(&path).expect("save annotations");

        let reloaded = SessionAnnotations::load_from_path(&path).expect("load annotations");
        let annotation = reloaded
            .get("codex", "session-1")
            .expect("annotation exists");

        assert_eq!(annotation.stage.as_deref(), Some("validation"));
        assert_eq!(annotation.sticker.as_deref(), Some("focused"));
        assert_eq!(annotation.label.as_deref(), Some("等我跑完整回归"));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn rejects_unknown_stages_and_stickers() {
        assert!(SessionAnnotations::validate_stage(Some("validation")).is_ok());
        assert!(SessionAnnotations::validate_stage(Some("bogus")).is_err());
        assert!(SessionAnnotations::validate_sticker(Some("celebrating")).is_ok());
        assert!(SessionAnnotations::validate_sticker(Some("bogus")).is_err());
    }

    #[test]
    fn archive_state_resolves_overlay_native_and_resurfacing() {
        let mut annotations = SessionAnnotations::default();
        // No overlay: follow provider-native archive state.
        assert!(!effective_archived(None, false, 10));
        assert!(effective_archived(None, true, 10));

        annotations.set_archived("claude", "a", Some(true), 1_000);
        let archived = annotations.get("claude", "a");
        assert!(effective_archived(archived, false, 1_000));
        // Newer activity after archiving brings the session back.
        assert!(!effective_archived(archived, false, 1_001));

        // Explicit unarchive overrides a native Codex archive.
        annotations.set_archived("codex", "b", Some(false), 2_000);
        let unarchived = annotations.get("codex", "b");
        assert!(!effective_archived(unarchived, true, 10));
        assert_eq!(unarchived.and_then(|item| item.archived_at), None);
    }

    #[test]
    fn archive_survives_stage_edits_and_keeps_entry_non_empty() {
        let mut annotations = SessionAnnotations::default();
        annotations.set_archived("claude", "a", Some(true), 5_000);
        let entry = annotations.get("claude", "a").cloned().unwrap();
        assert!(!entry.is_empty());
        assert_eq!(entry.archived_at, Some(5_000));

        let overlay = annotations.archive_overlay();
        assert_eq!(overlay.len(), 1);
        assert_eq!(overlay[0].source, "claude");
        assert_eq!(overlay[0].session_id, "a");

        // Undo clears the override entirely when nothing else is stored.
        annotations.set_archived("claude", "a", None, 6_000);
        assert!(annotations.get("claude", "a").is_none());
    }
}
