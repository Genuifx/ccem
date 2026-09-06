//! Persist only Claude list metadata. Transcript bytes are read again only
//! when the source file's identity, length or modification time changes.
use super::HistorySession;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
    time::UNIX_EPOCH,
};

static INDEX_LOCK: Mutex<()> = Mutex::new(());
const VERSION: u32 = 1;
const MAX_CACHE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct FileStamp {
    size: u64,
    modified_ns: u128,
    identity: u64,
}

fn stamp(path: &Path) -> Option<FileStamp> {
    let meta = fs::metadata(path).ok()?;
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        meta.ino()
    };
    #[cfg(not(unix))]
    let identity = 0;
    Some(FileStamp {
        size: meta.len(),
        modified_ns: meta
            .modified()
            .ok()?
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_nanos(),
        identity,
    })
}

#[derive(Clone, Serialize, Deserialize)]
struct Entry {
    stamp: FileStamp,
    session: Option<HistorySession>,
}

#[derive(Default, Serialize, Deserialize)]
struct Index {
    version: u32,
    entries: HashMap<String, Entry>,
}

fn read_index(path: &Path) -> Index {
    let read = || -> Option<Index> {
        let file = fs::File::open(path).ok()?;
        if file.metadata().ok()?.len() > MAX_CACHE_BYTES {
            return None;
        }
        let index: Index = serde_json::from_reader(file.take(MAX_CACHE_BYTES)).ok()?;
        (index.version == VERSION).then_some(index)
    };
    read().unwrap_or_default()
}

pub(super) fn load(
    paths: &[PathBuf],
    cache_path: Option<&Path>,
    mut parse: impl FnMut(&Path) -> Option<HistorySession>,
) -> Vec<HistorySession> {
    // Serializes concurrent fresh page loads; only worker threads call here.
    let _guard = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut previous = cache_path.map(read_index).unwrap_or_default();
    let mut next = Index {
        version: VERSION,
        ..Default::default()
    };
    let mut changed = previous.version != VERSION;
    let mut sessions = Vec::new();
    for path in paths {
        let Some(before) = stamp(path) else {
            continue;
        };
        let key = path.to_string_lossy().into_owned();
        let entry = match previous.entries.remove(&key) {
            Some(cached) if cached.stamp == before => cached,
            _ => {
                changed = true;
                Entry {
                    stamp: before.clone(),
                    session: parse(path),
                }
            }
        };
        if let Some(session) = &entry.session {
            sessions.push(session.clone());
        }
        // An active transcript may append while it is parsed. Never label a
        // partial read as a stable index for the next app launch.
        if stamp(path).as_ref() == Some(&before) {
            next.entries.insert(key, entry);
        } else {
            changed = true;
        }
    }
    changed |= !previous.entries.is_empty();
    if changed {
        if let Some(path) = cache_path {
            if let Ok(bytes) = serde_json::to_vec(&next) {
                if bytes.len() as u64 <= MAX_CACHE_BYTES {
                    // The cache is disposable. A read-only disk must not hide
                    // sessions. Atomic unique-temp writes also tolerate another
                    // app instance rebuilding the same index concurrently.
                    let _ = crate::secure_fs::write_private_atomic(path, &bytes);
                }
            }
        }
    }
    sessions
}

#[cfg(test)]
mod tests {
    use super::*;
    fn parse(path: &Path) -> Option<HistorySession> {
        Some(HistorySession {
            id: path.file_stem()?.to_str()?.into(),
            source: "claude".into(),
            display: fs::read_to_string(path).ok()?,
            timestamp: 1,
            project: "/fixture".into(),
            project_name: "fixture".into(),
            env_name: None,
            config_source: None,
            task_stage: None,
            task_sticker: None,
            task_label: None,
        })
    }

    #[test]
    fn new_cache_reader_reuses_unchanged_files_and_reparses_changed_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let cache = dir.path().join("index.json");
        fs::write(&path, "first").unwrap();
        let paths = vec![path.clone()];
        assert_eq!(load(&paths, Some(&cache), parse)[0].display, "first");
        let mut reads = 0;
        let result = load(&paths, Some(&cache), |_| {
            reads += 1;
            None
        });
        assert_eq!(reads, 0);
        assert_eq!(result[0].display, "first");
        fs::write(&path, "updated prompt").unwrap();
        assert_eq!(
            load(&paths, Some(&cache), parse)[0].display,
            "updated prompt"
        );
        fs::remove_file(&path).unwrap();
        assert!(load(&paths, Some(&cache), parse).is_empty());
        assert!(read_index(&cache).entries.is_empty());
    }

    #[test]
    fn corrupt_cache_and_write_failure_do_not_hide_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let cache = dir.path().join("index.json");
        fs::write(&path, "visible").unwrap();
        fs::write(&cache, "broken json").unwrap();
        assert_eq!(load(&[path.clone()], Some(&cache), parse).len(), 1);
        assert_eq!(load(&[path], Some(dir.path()), parse).len(), 1);
    }

    #[test]
    fn append_during_parse_is_not_cached() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let cache = dir.path().join("index.json");
        fs::write(&path, "before").unwrap();
        load(&[path.clone()], Some(&cache), |path| {
            let result = parse(path);
            fs::write(path, "appended while reading").unwrap();
            result
        });
        assert!(read_index(&cache).entries.is_empty());
        assert_eq!(
            load(&[path], Some(&cache), parse)[0].display,
            "appended while reading"
        );
    }
}
