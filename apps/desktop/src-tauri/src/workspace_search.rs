use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

const INDEX_TTL: Duration = Duration::from_secs(45);
const DEFAULT_LIMIT: usize = 12;
const MAX_LIMIT: usize = 40;
const MAX_INDEX_ENTRIES: usize = 60_000;

static WORKSPACE_FILE_INDEX: OnceLock<Mutex<HashMap<String, CachedWorkspaceIndex>>> =
    OnceLock::new();

const IGNORED_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".idea",
    ".vscode",
    "node_modules",
    "dist",
    "build",
    "target",
    "coverage",
    ".next",
    ".nuxt",
    ".turbo",
    ".cache",
];

const PRIORITY_FILES: &[&str] = &[
    "readme.md",
    "readme_zh.md",
    "package.json",
    "cargo.toml",
    "agests.md",
    "agents.md",
    "tsconfig.json",
    "vite.config.ts",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceFileSuggestion {
    pub absolute_path: String,
    pub relative_path: String,
    pub display_name: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone)]
struct FileIndexEntry {
    absolute_path: String,
    relative_path: String,
    display_name: String,
    lower_relative_path: String,
    lower_display_name: String,
    segments: Vec<String>,
    depth: usize,
    is_dir: bool,
}

#[derive(Debug, Clone)]
struct CachedWorkspaceIndex {
    built_at: Instant,
    entries: Vec<FileIndexEntry>,
}

fn workspace_index_cache() -> &'static Mutex<HashMap<String, CachedWorkspaceIndex>> {
    WORKSPACE_FILE_INDEX.get_or_init(|| Mutex::new(HashMap::new()))
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn should_skip_entry(name: &str, is_dir: bool) -> bool {
    if name.is_empty() {
        return true;
    }

    if is_dir
        && IGNORED_DIRS
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(name))
    {
        return true;
    }

    if name.starts_with('.') && name != ".claude" && name != ".github" {
        return true;
    }

    false
}

fn collect_workspace_entries(
    root: &Path,
    dir: &Path,
    entries: &mut Vec<FileIndexEntry>,
) -> Result<(), String> {
    let read_dir = fs::read_dir(dir).map_err(|error| {
        format!(
            "Failed to read workspace directory {}: {}",
            dir.display(),
            error
        )
    })?;

    let mut children = read_dir.flatten().collect::<Vec<_>>();

    children.sort_by_key(|entry| entry.file_name());

    for child in children {
        if entries.len() >= MAX_INDEX_ENTRIES {
            break;
        }

        let file_type = match child.file_type() {
            Ok(value) => value,
            Err(_) => continue,
        };
        let is_dir = file_type.is_dir();
        let name = child.file_name().to_string_lossy().to_string();
        if should_skip_entry(&name, is_dir) {
            continue;
        }

        let path = child.path();
        let relative = path.strip_prefix(root).unwrap_or(&path);
        let relative_path = normalize_path(relative);
        let absolute_path = normalize_path(&path);
        let lower_relative_path = relative_path.to_ascii_lowercase();
        let lower_display_name = name.to_ascii_lowercase();

        entries.push(FileIndexEntry {
            absolute_path,
            relative_path: relative_path.clone(),
            display_name: name,
            lower_relative_path: lower_relative_path.clone(),
            lower_display_name,
            segments: lower_relative_path
                .split('/')
                .map(|segment| segment.to_string())
                .collect(),
            depth: relative_path.matches('/').count(),
            is_dir,
        });

        if is_dir {
            collect_workspace_entries(root, &path, entries)?;
        }
    }

    Ok(())
}

fn build_workspace_index(root: &Path) -> Result<CachedWorkspaceIndex, String> {
    let mut entries = Vec::new();
    collect_workspace_entries(root, root, &mut entries)?;
    Ok(CachedWorkspaceIndex {
        built_at: Instant::now(),
        entries,
    })
}

fn get_workspace_index(root: &Path) -> Result<Vec<FileIndexEntry>, String> {
    let root_key = normalize_path(root);
    let cache = workspace_index_cache();
    {
        let guard = cache
            .lock()
            .map_err(|_| "Failed to lock workspace file index cache".to_string())?;
        if let Some(cached) = guard.get(&root_key) {
            if cached.built_at.elapsed() <= INDEX_TTL {
                return Ok(cached.entries.clone());
            }
        }
    }

    let rebuilt = build_workspace_index(root)?;
    let entries = rebuilt.entries.clone();
    let mut guard = cache
        .lock()
        .map_err(|_| "Failed to lock workspace file index cache".to_string())?;
    guard.insert(root_key, rebuilt);
    Ok(entries)
}

fn boost_priority_file(entry: &FileIndexEntry) -> i32 {
    if PRIORITY_FILES.contains(&entry.lower_display_name.as_str()) {
        45
    } else {
        0
    }
}

fn subsequence_score(haystack: &str, needle: &str) -> Option<i32> {
    if needle.is_empty() {
        return Some(0);
    }

    let mut haystack_indices = haystack.char_indices();
    let mut last_match = None;
    let mut total_gap_penalty = 0;

    for needle_char in needle.chars() {
        let mut found = None;
        for (idx, hay_char) in haystack_indices.by_ref() {
            if hay_char == needle_char {
                found = Some(idx);
                break;
            }
        }

        let idx = found?;

        if let Some(previous_idx) = last_match {
            total_gap_penalty += (idx.saturating_sub(previous_idx + 1)) as i32;
        }
        last_match = Some(idx);
    }

    Some(320 - total_gap_penalty.min(180))
}

fn score_entry(entry: &FileIndexEntry, normalized_query: &str) -> Option<i32> {
    if normalized_query.is_empty() {
        let score = 460 - (entry.depth as i32 * 16) - if entry.is_dir { 22 } else { 0 }
            + boost_priority_file(entry);
        return Some(score);
    }

    let mut best_score = i32::MIN;

    if entry.lower_display_name == normalized_query {
        best_score = best_score.max(1_000);
    }
    if entry.lower_relative_path == normalized_query {
        best_score = best_score.max(980);
    }
    if entry.lower_display_name.starts_with(normalized_query) {
        best_score = best_score.max(930 - entry.depth as i32 * 4);
    }
    if entry.lower_relative_path.starts_with(normalized_query) {
        best_score = best_score.max(890 - entry.depth as i32 * 4);
    }
    if entry
        .segments
        .iter()
        .any(|segment| segment.starts_with(normalized_query))
    {
        best_score = best_score.max(830 - entry.depth as i32 * 6);
    }
    if let Some(index) = entry.lower_display_name.find(normalized_query) {
        best_score = best_score.max(760 - index as i32 * 10);
    }
    if let Some(index) = entry.lower_relative_path.find(normalized_query) {
        best_score = best_score.max(720 - index as i32 * 5);
    }
    if let Some(score) = subsequence_score(&entry.lower_display_name, normalized_query) {
        best_score = best_score.max(score);
    }
    if let Some(score) = subsequence_score(&entry.lower_relative_path, normalized_query) {
        best_score = best_score.max(score - 24);
    }

    if best_score == i32::MIN {
        return None;
    }

    Some(best_score - if entry.is_dir { 18 } else { 0 } + boost_priority_file(entry))
}

#[tauri::command]
pub fn search_workspace_files(
    working_dir: String,
    query: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<WorkspaceFileSuggestion>, String> {
    let root = fs::canonicalize(PathBuf::from(&working_dir)).map_err(|error| {
        format!(
            "Failed to resolve workspace path {}: {}",
            working_dir, error
        )
    })?;
    if !root.is_dir() {
        return Err(format!(
            "Workspace path {} is not a directory",
            root.display()
        ));
    }

    let normalized_query = query.unwrap_or_default().trim().to_ascii_lowercase();
    let capped_limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let entries = get_workspace_index(&root)?;

    let mut ranked = entries
        .iter()
        .filter_map(|entry| score_entry(entry, &normalized_query).map(|score| (score, entry)))
        .collect::<Vec<_>>();

    ranked.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| left.1.depth.cmp(&right.1.depth))
            .then_with(|| left.1.relative_path.len().cmp(&right.1.relative_path.len()))
            .then_with(|| left.1.relative_path.cmp(&right.1.relative_path))
    });

    Ok(ranked
        .into_iter()
        .take(capped_limit)
        .map(|(_, entry)| WorkspaceFileSuggestion {
            absolute_path: entry.absolute_path.clone(),
            relative_path: entry.relative_path.clone(),
            display_name: entry.display_name.clone(),
            is_dir: entry.is_dir,
        })
        .collect())
}

/// A workspace file detected as written/modified at or after a point in time
/// (the owning session's start), regardless of which tool produced it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct WorkspaceRecentFile {
    /// Path relative to the scanned working dir, forward slashes.
    pub path: String,
    pub modified_ms: u64,
    pub byte_size: u64,
}

const RECENT_SCAN_MAX_ENTRIES: usize = 60_000;
const RECENT_SCAN_MAX_RESULTS: usize = 500;

/// Heavy/VCS directories skipped by the recent-file scan. Unlike the suggestion
/// index, dot directories are NOT skipped wholesale: sessions legitimately
/// write into places like `.artifacts/` or `.claude/`.
const RECENT_SCAN_SKIP_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "dist",
    "build",
    "coverage",
    ".next",
    ".nuxt",
    ".turbo",
    ".cache",
    "__pycache__",
    ".venv",
];

fn collect_recent_files(
    root: &Path,
    dir: &Path,
    since: SystemTime,
    walked: &mut usize,
    files: &mut Vec<WorkspaceRecentFile>,
) {
    let Ok(read_dir) = fs::read_dir(dir) else {
        return;
    };
    for child in read_dir.flatten() {
        if *walked >= RECENT_SCAN_MAX_ENTRIES {
            return;
        }
        *walked += 1;
        let Ok(file_type) = child.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            let name = child.file_name().to_string_lossy().to_string();
            if RECENT_SCAN_SKIP_DIRS
                .iter()
                .any(|skipped| skipped.eq_ignore_ascii_case(&name))
            {
                continue;
            }
            collect_recent_files(root, &child.path(), since, walked, files);
            continue;
        }
        // Regular files only; symlinks are skipped (no follows, no broken links).
        if !file_type.is_file() {
            continue;
        }
        let Ok(metadata) = child.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if modified < since {
            continue;
        }
        let absolute = child.path();
        let relative = absolute.strip_prefix(root).unwrap_or(&absolute);
        files.push(WorkspaceRecentFile {
            path: normalize_path(relative),
            modified_ms: modified
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|value| value.as_millis() as u64)
                .unwrap_or(0),
            byte_size: metadata.len(),
        });
    }
}

/// Lists files under `working_dir` whose mtime is at or after `since_ms`
/// (epoch milliseconds), newest first, bounded to keep large trees cheap.
#[tauri::command]
pub async fn get_workspace_recent_files(
    working_dir: String,
    since_ms: u64,
) -> Result<Vec<WorkspaceRecentFile>, String> {
    let root = fs::canonicalize(PathBuf::from(&working_dir)).map_err(|error| {
        format!(
            "Failed to resolve workspace path {}: {}",
            working_dir, error
        )
    })?;
    if !root.is_dir() {
        return Err(format!(
            "Workspace path {} is not a directory",
            root.display()
        ));
    }

    let since = SystemTime::UNIX_EPOCH
        .checked_add(Duration::from_millis(since_ms))
        .ok_or_else(|| format!("Invalid since timestamp: {since_ms}"))?;
    let mut walked = 0usize;
    let mut files = Vec::new();
    collect_recent_files(&root, &root, since, &mut walked, &mut files);
    Ok(rank_recent_files(files))
}

/// Newest first (stable path tiebreak), bounded for UI consumption.
fn rank_recent_files(mut files: Vec<WorkspaceRecentFile>) -> Vec<WorkspaceRecentFile> {
    files.sort_by(|left, right| {
        right
            .modified_ms
            .cmp(&left.modified_ms)
            .then_with(|| left.path.cmp(&right.path))
    });
    files.truncate(RECENT_SCAN_MAX_RESULTS);
    files
}

#[cfg(test)]
mod tests {
    use super::{score_entry, FileIndexEntry};

    fn make_entry(relative_path: &str) -> FileIndexEntry {
        let display_name = relative_path
            .split('/')
            .next_back()
            .unwrap_or(relative_path)
            .to_string();
        FileIndexEntry {
            absolute_path: format!("/tmp/{relative_path}"),
            relative_path: relative_path.to_string(),
            display_name: display_name.clone(),
            lower_relative_path: relative_path.to_ascii_lowercase(),
            lower_display_name: display_name.to_ascii_lowercase(),
            segments: relative_path
                .to_ascii_lowercase()
                .split('/')
                .map(|segment| segment.to_string())
                .collect(),
            depth: relative_path.matches('/').count(),
            is_dir: false,
        }
    }

    #[test]
    fn exact_name_beats_partial_path() {
        let exact = make_entry("src/composer.ts");
        let partial = make_entry("src/components/workspace/composer-panel.tsx");

        let exact_score = score_entry(&exact, "composer.ts").expect("exact score");
        let partial_score = score_entry(&partial, "composer.ts").expect("partial score");

        assert!(exact_score > partial_score);
    }

    #[test]
    fn empty_query_prefers_shallow_priority_files() {
        let readme = make_entry("README.md");
        let nested = make_entry("packages/core/src/runtime/helpers.ts");

        let readme_score = score_entry(&readme, "").expect("readme score");
        let nested_score = score_entry(&nested, "").expect("nested score");

        assert!(readme_score > nested_score);
    }

    #[test]
    fn subsequence_match_can_still_surface_a_result() {
        let entry =
            make_entry("apps/desktop/src/components/workspace/WorkspaceSessionComposer.tsx");
        let score = score_entry(&entry, "wsc").expect("fuzzy score");
        assert!(score > 0);
    }

    mod recent_files {
        use super::super::{collect_recent_files, rank_recent_files, WorkspaceRecentFile};
        use std::fs;
        use std::path::Path;
        use std::process::Command;
        use std::time::{Duration, SystemTime};

        fn write_file(root: &Path, relative: &str) {
            let path = root.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("create parent");
            }
            fs::write(&path, "content").expect("write file");
        }

        /// Backdates a file's mtime via `touch -t` (unix-only helper for tests).
        fn backdate(path: &Path, stamp: &str) {
            let status = Command::new("touch")
                .arg("-t")
                .arg(stamp)
                .arg(path)
                .status()
                .expect("run touch");
            assert!(status.success(), "touch -t {stamp} failed");
        }

        fn paths(files: &[WorkspaceRecentFile]) -> Vec<String> {
            files.iter().map(|file| file.path.clone()).collect()
        }

        #[test]
        fn returns_only_files_modified_at_or_after_since() {
            let root = std::env::temp_dir().join(format!(
                "ccem-recent-{}",
                std::time::SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&root).expect("create root");
            write_file(&root, "fresh.txt");
            write_file(&root, "nested/out.json");
            write_file(&root, "stale.txt");
            backdate(&root.join("stale.txt"), "202001010000");

            let since = SystemTime::now() - Duration::from_secs(5);
            let mut walked = 0usize;
            let mut files = Vec::new();
            collect_recent_files(&root, &root, since, &mut walked, &mut files);

            let mut listed = paths(&files);
            listed.sort();
            assert_eq!(listed, vec!["fresh.txt".to_string(), "nested/out.json".to_string()]);
            assert!(files.iter().all(|file| file.byte_size > 0));
            assert!(files.iter().all(|file| file.modified_ms > 0));
            fs::remove_dir_all(&root).ok();
        }

        #[test]
        fn skips_heavy_dirs_but_keeps_dot_dirs_like_artifacts() {
            let root = std::env::temp_dir().join(format!(
                "ccem-recent-{}",
                std::time::SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&root).expect("create root");
            write_file(&root, ".artifacts/shot.png");
            write_file(&root, ".claude/settings.json");
            write_file(&root, "node_modules/pkg/index.js");
            write_file(&root, ".git/HEAD");
            write_file(&root, "target/debug/skip.bin");

            let mut walked = 0usize;
            let mut files = Vec::new();
            collect_recent_files(
                &root,
                &root,
                SystemTime::UNIX_EPOCH,
                &mut walked,
                &mut files,
            );

            let mut listed = paths(&files);
            listed.sort();
            assert_eq!(
                listed,
                vec![
                    ".artifacts/shot.png".to_string(),
                    ".claude/settings.json".to_string(),
                ]
            );
            fs::remove_dir_all(&root).ok();
        }

        #[test]
        fn newest_files_sort_first_with_stable_tiebreak() {
            let root = std::env::temp_dir().join(format!(
                "ccem-recent-{}",
                std::time::SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&root).expect("create root");
            write_file(&root, "older.txt");
            std::thread::sleep(Duration::from_millis(20));
            write_file(&root, "newer.txt");

            let mut walked = 0usize;
            let mut files = Vec::new();
            collect_recent_files(
                &root,
                &root,
                SystemTime::UNIX_EPOCH,
                &mut walked,
                &mut files,
            );
            let ranked = rank_recent_files(files);

            assert_eq!(paths(&ranked), vec!["newer.txt".to_string(), "older.txt".to_string()]);
            fs::remove_dir_all(&root).ok();
        }
    }
}
