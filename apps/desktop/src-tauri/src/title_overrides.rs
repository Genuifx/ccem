// apps/desktop/src-tauri/src/title_overrides.rs
//
// User-editable title overrides for history sessions.
// Persisted to ~/.ccem/title_overrides.json with atomic writes + file locking.

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::ErrorKind;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::config::get_ccem_dir;
use crate::native_runtime::NativeSessionSummary;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TitleOverride {
    pub title: String,
    pub updated_at: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct PendingNativeTitle {
    title: String,
    overwrite_existing: bool,
    #[serde(default)]
    updated_at: u64,
}

#[derive(Serialize, Deserialize, Default, Debug)]
pub struct TitleOverrides {
    entries: HashMap<String, TitleOverride>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    cleared_titles: HashMap<String, u64>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pending_native_titles: HashMap<String, PendingNativeTitle>,
}

impl TitleOverrides {
    fn parse(content: &str) -> std::io::Result<Self> {
        serde_json::from_str(content).map_err(|error| {
            std::io::Error::new(
                ErrorKind::InvalidData,
                format!("Failed to parse title overrides: {error}"),
            )
        })
    }

    fn path() -> PathBuf {
        get_ccem_dir().join("title_overrides.json")
    }

    fn lock_path() -> PathBuf {
        get_ccem_dir().join("title_overrides.json.lock")
    }

    /// Acquire an exclusive lock and load from disk.
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

        let data = match fs::read_to_string(&path) {
            Ok(content) => Self::parse(&content)?,
            Err(e) if e.kind() == ErrorKind::NotFound => Self::default(),
            Err(error) => return Err(error),
        };

        Ok((data, lock_file))
    }

    /// Load without locking (read-only, e.g. for overlay in get_conversation_history).
    pub fn load() -> Self {
        match fs::read_to_string(Self::path()) {
            Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
            Err(e) if e.kind() == ErrorKind::NotFound => Self::default(),
            Err(_) => Self::default(),
        }
    }

    /// Atomic write: write-to-tmp + rename. Caller must hold the lock.
    fn save_locked(&self) -> std::io::Result<()> {
        let path = Self::path();
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| std::io::Error::new(ErrorKind::InvalidData, e))?;
        let tmp = path.with_extension("tmp");
        fs::write(&tmp, json)?;
        fs::rename(tmp, path)
    }

    fn title_key(source: &str, id: &str) -> String {
        format!("{}:{}", source, id)
    }

    fn next_revision(&self) -> u64 {
        let wall_clock = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_micros()
            .try_into()
            .unwrap_or(u64::MAX);
        let latest_stored = self
            .entries
            .values()
            .map(|entry| entry.updated_at)
            .chain(self.cleared_titles.values().copied())
            .chain(
                self.pending_native_titles
                    .values()
                    .map(|pending| pending.updated_at),
            )
            .max()
            .unwrap_or_default();
        wall_clock.max(latest_stored.saturating_add(1))
    }

    pub fn get(&self, source: &str, id: &str) -> Option<&TitleOverride> {
        let key = Self::title_key(source, id);
        let entry = self.entries.get(&key)?;
        if self
            .cleared_titles
            .get(&key)
            .is_some_and(|cleared_at| *cleared_at >= entry.updated_at)
        {
            return None;
        }
        Some(entry)
    }

    fn title_state(&self, source: &str, id: &str) -> (Option<String>, u64) {
        let id = id.trim();
        if id.is_empty() {
            return (None, 0);
        }
        let key = Self::title_key(source, id);
        let entry = self.entries.get(&key);
        let cleared_at = self.cleared_titles.get(&key).copied().unwrap_or_default();
        if let Some(entry) = entry {
            if cleared_at < entry.updated_at {
                return (
                    Some(entry.title.trim().to_string()).filter(|title| !title.is_empty()),
                    entry.updated_at,
                );
            }
        }
        (None, cleared_at)
    }

    fn title(&self, source: &str, id: &str) -> Option<String> {
        self.title_state(source, id).0
    }

    pub fn resolve_native_session_title(
        &self,
        source: &str,
        runtime_id: &str,
        provider_session_id: Option<&str>,
    ) -> Option<String> {
        self.resolve_native_session_title_state(source, runtime_id, provider_session_id)
            .0
    }

    fn resolve_native_session_title_state(
        &self,
        source: &str,
        runtime_id: &str,
        provider_session_id: Option<&str>,
    ) -> (Option<String>, u64) {
        if let Some(provider_session_id) = provider_session_id
            .map(str::trim)
            .filter(|id| !id.is_empty())
        {
            // Once a provider id is authoritative, its key is the single source
            // of truth. Falling back to an old runtime alias would resurrect a
            // title that the user deliberately cleared from the provider row.
            return self.title_state(source, provider_session_id);
        }

        self.title_state(source, runtime_id)
    }

    pub fn apply_native_session_title(&self, summary: &mut NativeSessionSummary) {
        let (display_title, display_title_revision) = self.resolve_native_session_title_state(
            summary.provider.as_str(),
            &summary.runtime_id,
            summary.provider_session_id.as_deref(),
        );
        summary.display_title = display_title;
        summary.display_title_revision = display_title_revision;
    }

    pub fn apply_native_session_titles(&self, summaries: &mut [NativeSessionSummary]) {
        for summary in summaries {
            self.apply_native_session_title(summary);
        }
    }

    fn pending_native_title_key(source: &str, runtime_id: &str) -> String {
        format!("{}:{}", source, runtime_id)
    }

    fn queue_native_title_sync(
        &mut self,
        source: &str,
        runtime_id: &str,
        title: &str,
        overwrite_existing: bool,
        updated_at: u64,
    ) {
        let runtime_id = runtime_id.trim();
        if runtime_id.is_empty() {
            return;
        }
        let key = Self::pending_native_title_key(source, runtime_id);
        if self.pending_native_titles.get(&key).is_some_and(|pending| {
            pending.updated_at > updated_at || (pending.overwrite_existing && !overwrite_existing)
        }) {
            // A late generated title must not replace an earlier manual rename
            // while the provider id is still unknown.
            return;
        }
        self.pending_native_titles.insert(
            key,
            PendingNativeTitle {
                title: title.trim().to_string(),
                overwrite_existing,
                updated_at,
            },
        );
    }

    fn sync_pending_native_title(
        &mut self,
        source: &str,
        runtime_id: &str,
        provider_session_id: &str,
    ) -> bool {
        let runtime_id = runtime_id.trim();
        let provider_session_id = provider_session_id.trim();
        if runtime_id.is_empty() || provider_session_id.is_empty() {
            return false;
        }
        let Some(pending) = self
            .pending_native_titles
            .remove(&Self::pending_native_title_key(source, runtime_id))
        else {
            return false;
        };

        let (_, provider_revision) = self.title_state(source, provider_session_id);
        if pending.overwrite_existing {
            if provider_revision <= pending.updated_at {
                if pending.title.is_empty() {
                    self.clear_at(source, provider_session_id, pending.updated_at);
                } else {
                    self.set_at(
                        source,
                        provider_session_id,
                        pending.title,
                        pending.updated_at,
                    );
                }
            }
        } else if provider_revision == 0 && !pending.title.is_empty() {
            self.set_at(
                source,
                provider_session_id,
                pending.title,
                pending.updated_at,
            );
        }
        true
    }

    fn has_syncable_native_title(&self, summaries: &[NativeSessionSummary]) -> bool {
        summaries.iter().any(|summary| {
            summary
                .provider_session_id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .is_some()
                && self
                    .pending_native_titles
                    .contains_key(&Self::pending_native_title_key(
                        summary.provider.as_str(),
                        &summary.runtime_id,
                    ))
        })
    }

    fn sync_pending_native_titles(&mut self, summaries: &[NativeSessionSummary]) -> bool {
        let mut changed = false;
        for summary in summaries {
            let Some(provider_session_id) = summary
                .provider_session_id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
            else {
                continue;
            };
            changed |= self.sync_pending_native_title(
                summary.provider.as_str(),
                &summary.runtime_id,
                provider_session_id,
            );
        }
        changed
    }

    /// Add persisted display titles to the IPC projection. Pending runtime-key
    /// titles are reconciled here, outside the native runtime's helper/reconnect
    /// locks, so a provider id arriving around an app restart cannot lose a
    /// rename or block the runtime hot path on cross-process file I/O.
    pub fn enrich_native_session_titles(summaries: &mut [NativeSessionSummary]) {
        let mut overrides = Self::load();
        if overrides.has_syncable_native_title(summaries) {
            match Self::load_locked() {
                Ok((mut locked_overrides, _lock)) => {
                    if locked_overrides.sync_pending_native_titles(summaries) {
                        if let Err(error) = locked_overrides.save_locked() {
                            eprintln!("Failed to synchronize native session titles: {error}");
                        } else {
                            overrides = locked_overrides;
                        }
                    } else {
                        overrides = locked_overrides;
                    }
                }
                Err(error) => {
                    eprintln!("Failed to load native session titles for synchronization: {error}");
                }
            }
        }
        overrides.apply_native_session_titles(summaries);
    }

    pub fn enrich_native_session_title(summary: &mut NativeSessionSummary) {
        Self::enrich_native_session_titles(std::slice::from_mut(summary));
    }

    pub fn set(&mut self, source: &str, id: &str, title: String) {
        let updated_at = self.next_revision();
        self.set_at(source, id, title, updated_at);
    }

    fn set_at(&mut self, source: &str, id: &str, title: String, updated_at: u64) {
        let key = Self::title_key(source, id);
        self.cleared_titles.remove(&key);
        self.entries
            .insert(key, TitleOverride { title, updated_at });
    }

    fn clear_at(&mut self, source: &str, id: &str, updated_at: u64) {
        let key = Self::title_key(source, id);
        self.entries.remove(&key);
        self.cleared_titles.insert(key, updated_at);
    }

    pub fn remove(&mut self, source: &str, id: &str) {
        let key = Self::title_key(source, id);
        self.entries.remove(&key);
        self.cleared_titles.remove(&key);
    }

    fn normalized_title_ids(session_id: &str, alias_session_ids: &[String]) -> Vec<String> {
        let mut ids = alias_session_ids
            .iter()
            .map(|id| id.trim())
            .chain(std::iter::once(session_id.trim()))
            .filter(|id| !id.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>();
        ids.sort_unstable();
        ids.dedup();
        ids
    }

    fn can_fill_generated_title(&self, source: &str, ids: &[String], title: &str) -> bool {
        if title.is_empty() {
            return false;
        }
        ids.iter().all(|id| {
            let key = Self::title_key(source, id);
            !self.cleared_titles.contains_key(&key)
                && self
                    .entries
                    .get(&key)
                    .is_none_or(|entry| entry.title.trim() == title)
        })
    }

    fn apply_title_update_at(
        &mut self,
        source: &str,
        session_id: &str,
        alias_session_ids: &[String],
        title: &str,
        overwrite_existing: bool,
        updated_at: u64,
    ) -> bool {
        let ids = Self::normalized_title_ids(session_id, alias_session_ids);
        if ids.is_empty() {
            return false;
        }

        let title = title.trim();
        if !overwrite_existing && !self.can_fill_generated_title(source, &ids, title) {
            return false;
        }

        for id in ids {
            if title.is_empty() {
                self.clear_at(source, &id, updated_at);
            } else {
                self.set_at(source, &id, title.to_string(), updated_at);
            }
        }
        true
    }

    fn apply_title_update(
        &mut self,
        source: &str,
        session_id: &str,
        alias_session_ids: &[String],
        title: &str,
        overwrite_existing: bool,
    ) -> u64 {
        let updated_at = self.next_revision();
        self.apply_title_update_at(
            source,
            session_id,
            alias_session_ids,
            title,
            overwrite_existing,
            updated_at,
        );
        updated_at
    }

    fn apply_native_title_operation(
        &mut self,
        source: &str,
        session_id: &str,
        alias_session_ids: &[String],
        native_runtime_ids: &[String],
        title: &str,
        overwrite_existing: bool,
    ) -> (u64, bool) {
        let updated_at = self.next_revision();
        let applied = self.apply_title_update_at(
            source,
            session_id,
            alias_session_ids,
            title,
            overwrite_existing,
            updated_at,
        );
        if applied {
            for runtime_id in native_runtime_ids {
                self.queue_native_title_sync(
                    source,
                    runtime_id,
                    title,
                    overwrite_existing,
                    updated_at,
                );
            }
        }
        (updated_at, applied)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTitleUpdateResult {
    revision: u64,
    applied: bool,
}

#[tauri::command]
pub async fn set_session_title(
    source: String,
    session_id: String,
    title: String,
    alias_session_ids: Option<Vec<String>>,
    overwrite_existing: Option<bool>,
    native_runtime_ids: Option<Vec<String>>,
) -> Result<SessionTitleUpdateResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (mut overrides, _lock) =
            TitleOverrides::load_locked().map_err(|e| format!("Failed to acquire lock: {}", e))?;
        let overwrite_existing = overwrite_existing.unwrap_or(true);
        let (revision, applied) = overrides.apply_native_title_operation(
            &source,
            &session_id,
            &alias_session_ids.unwrap_or_default(),
            &native_runtime_ids.unwrap_or_default(),
            &title,
            overwrite_existing,
        );
        overrides
            .save_locked()
            .map_err(|e| format!("Failed to save title override: {}", e))?;
        // _lock dropped here, releasing the exclusive lock
        Ok(SessionTitleUpdateResult { revision, applied })
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_title_uses_provider_key_without_stale_runtime_fallback() {
        let mut overrides = TitleOverrides::default();
        overrides.set("claude", "native-1", "旧 runtime 标题".into());

        assert_eq!(
            overrides.resolve_native_session_title("claude", "native-1", None),
            Some("旧 runtime 标题".into())
        );
        assert_eq!(
            overrides.resolve_native_session_title("claude", "native-1", Some("provider-1")),
            None
        );

        overrides.set("claude", "provider-1", "权威 provider 标题".into());
        assert_eq!(
            overrides.resolve_native_session_title("claude", "native-1", Some("provider-1")),
            Some("权威 provider 标题".into())
        );
    }

    #[test]
    fn generated_title_only_fills_missing_aliases_but_manual_title_updates_all_aliases() {
        let mut overrides = TitleOverrides::default();
        overrides.set("claude", "provider-1", "手工标题".into());
        overrides.set("claude", "native-existing", "先到的手工标题".into());
        let aliases = vec!["provider-1".to_string()];

        overrides.apply_title_update("claude", "native-1", &aliases, "新的自动标题", false);
        assert_eq!(overrides.title("claude", "native-1"), None);
        assert_eq!(
            overrides.title("claude", "provider-1"),
            Some("手工标题".into())
        );

        overrides.apply_title_update("claude", "native-existing", &[], "晚到的自动标题", false);
        assert_eq!(
            overrides.title("claude", "native-existing"),
            Some("先到的手工标题".into()),
            "late automatic generation must not overwrite a manual runtime title"
        );

        let mut generated = TitleOverrides::default();
        generated.apply_title_update("claude", "native-generated", &[], "自动标题", false);
        generated.apply_title_update(
            "claude",
            "native-generated",
            &["provider-generated".to_string()],
            "自动标题",
            false,
        );
        assert_eq!(
            generated.title("claude", "provider-generated"),
            Some("自动标题".into())
        );

        overrides.apply_title_update(
            "claude",
            "provider-1",
            &["native-1".to_string(), "native-2".to_string()],
            "统一改名",
            true,
        );
        for id in ["provider-1", "native-1", "native-2"] {
            assert_eq!(overrides.title("claude", id), Some("统一改名".into()));
        }

        overrides.apply_title_update(
            "claude",
            "provider-1",
            &["native-1".to_string(), "native-2".to_string()],
            " ",
            true,
        );
        for id in ["provider-1", "native-1", "native-2"] {
            assert_eq!(overrides.title("claude", id), None);
        }

        overrides.apply_title_update(
            "claude",
            "provider-1",
            &["native-1".to_string(), "native-2".to_string()],
            "晚到的自动标题",
            false,
        );
        for id in ["provider-1", "native-1", "native-2"] {
            assert_eq!(
                overrides.title("claude", id),
                None,
                "an explicit clear tombstone must reject late automatic title generation"
            );
        }
    }

    #[test]
    fn pending_runtime_title_survives_restart_and_converges_after_provider_binding() {
        let mut before_restart = TitleOverrides::default();
        let (_, manual_applied) = before_restart.apply_native_title_operation(
            "claude",
            "native-1",
            &[],
            &["native-1".to_string()],
            "绑定前手工改名",
            true,
        );
        let (_, late_generated_applied) = before_restart.apply_native_title_operation(
            "claude",
            "native-1",
            &[],
            &["native-1".to_string()],
            "晚到的自动标题",
            false,
        );
        assert!(manual_applied);
        assert!(!late_generated_applied);

        let serialized = serde_json::to_string(&before_restart).expect("serialize pending title");
        let mut restored = TitleOverrides::parse(&serialized).expect("restore pending title");
        assert!(restored.sync_pending_native_title("claude", "native-1", "provider-1"));
        assert_eq!(
            restored.title("claude", "provider-1"),
            Some("绑定前手工改名".into())
        );
        assert!(restored.pending_native_titles.is_empty());

        let (_, clear_applied) = restored.apply_native_title_operation(
            "claude",
            "native-1",
            &["provider-1".to_string()],
            &["native-1".to_string()],
            "",
            true,
        );
        let (_, generated_after_clear_applied) = restored.apply_native_title_operation(
            "claude",
            "native-1",
            &["provider-1".to_string()],
            &["native-1".to_string()],
            "晚到的自动标题",
            false,
        );
        assert!(clear_applied);
        assert!(!generated_after_clear_applied);
        assert!(restored.sync_pending_native_title("claude", "native-1", "provider-1"));
        assert_eq!(restored.title("claude", "provider-1"), None);
        assert_eq!(restored.title("claude", "native-1"), None);

        let mut newer_provider_edit = TitleOverrides::default();
        newer_provider_edit.apply_native_title_operation(
            "claude",
            "native-2",
            &[],
            &["native-2".to_string()],
            "绑定前标题",
            true,
        );
        newer_provider_edit.apply_title_update(
            "claude",
            "provider-2",
            &[],
            "绑定后的手工改名",
            true,
        );
        assert!(newer_provider_edit.sync_pending_native_title("claude", "native-2", "provider-2"));
        assert_eq!(
            newer_provider_edit.title("claude", "provider-2"),
            Some("绑定后的手工改名".into()),
            "a stale pending runtime title must not overwrite a newer provider edit"
        );
    }

    #[test]
    fn malformed_title_override_json_is_rejected_before_any_write() {
        let error = TitleOverrides::parse(r#"{"entries":{"claude:broken":}"#)
            .expect_err("malformed title overrides must fail closed");
        assert_eq!(error.kind(), ErrorKind::InvalidData);
    }
}
