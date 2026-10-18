//! Read both Claude profiles without preparing/migrating either one. Only the
//! cached contributions are deduplicated; transcripts and parse cursors stay intact.
use super::*;

pub(super) fn roots() -> Vec<PathBuf> {
    let mut roots = vec![agent_home::claude_home().join("projects")];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".claude/projects"));
    }
    roots
}

pub(super) fn discover(roots: &[PathBuf]) -> (Vec<DiscoveredFile>, bool) {
    let mut files = Vec::new();
    let mut complete = true;
    let mut seen = HashSet::new();
    for root in roots {
        let canonical = fs::canonicalize(root).unwrap_or_else(|_| root.clone());
        if !seen.insert(canonical) {
            continue;
        }
        let projects = match fs::read_dir(root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                complete = false;
                continue;
            }
        };
        for project in projects {
            match project {
                Ok(project) if project.file_type().is_ok_and(|kind| kind.is_dir()) => {
                    complete &= collect_claude_jsonl_dir(&project.path(), 0, 3, &mut files);
                }
                Err(_) => complete = false,
                _ => {}
            }
        }
    }
    (files, complete)
}

fn keys(entry: &CacheFileEntry, file: &str) -> Vec<String> {
    let ids: HashMap<usize, &str> = entry
        .claude_state
        .as_ref()
        .map(|state| {
            state
                .message_entry_indexes
                .iter()
                .map(|(id, index)| (*index, id.as_str()))
                .collect()
        })
        .unwrap_or_default();
    let mut occurrences = HashMap::<String, usize>::new();
    entry
        .stats
        .entries
        .iter()
        .enumerate()
        .map(|(index, _row)| {
            if let Some(id) = ids.get(&index) {
                return format!("id:{id}");
            }
            // Without a response id, match only identical observations, preserving
            // repeated identical lines within either transcript (multiset union).
            let fingerprint = entry
                .claude_state
                .as_ref()
                .and_then(|state| state.row_fingerprints.get(&index))
                .cloned()
                // A legacy cache with no source left cannot prove a copy.
                .unwrap_or_else(|| format!("{file}:{index}"));
            let count = occurrences.entry(fingerprint.clone()).or_default();
            *count += 1;
            format!("row:{fingerprint}:{}", *count)
        })
        .collect()
}

fn snapshot_order(row: &CacheEntry) -> (Option<i64>, u128) {
    let timestamp = chrono::DateTime::parse_from_rfc3339(&row.timestamp)
        .ok()
        .map(|time| time.timestamp_millis());
    let usage = &row.usage;
    (
        timestamp,
        u128::from(usage.input_tokens)
            + u128::from(usage.output_tokens)
            + u128::from(usage.cache_read_tokens)
            + u128::from(usage.cache_creation_tokens),
    )
}

fn unchanged(old: &CacheFileEntry, next: &CacheFileEntry) -> bool {
    let identities = |entry: &CacheFileEntry| {
        entry.claude_state.as_ref().map(|state| {
            (
                state.message_entry_indexes.len(),
                state.row_fingerprints.len(),
            )
        })
    };
    old.meta == next.meta
        && old.parse_offset == next.parse_offset
        && old.append_anchor == next.append_anchor
        && identities(old) == identities(next)
}

pub(super) fn deduplicate(
    files: &mut HashMap<String, CacheFileEntry>,
    previous: Option<&HashMap<String, CacheFileEntry>>,
    roots: &[PathBuf],
) {
    let [isolated, official] = roots else {
        return;
    };
    if isolated == official {
        return;
    }
    let pairs: Vec<_> = files
        .keys()
        .filter_map(|key| {
            let relative = Path::new(key).strip_prefix(isolated).ok()?;
            let peer = official.join(relative).to_string_lossy().to_string();
            files.contains_key(&peer).then(|| (key.clone(), peer))
        })
        .collect();
    for (isolated_key, official_key) in pairs {
        let isolated = &files[&isolated_key];
        let official = &files[&official_key];
        // Both cached rollups already represent this pair. Unchanged history
        // must not be folded row-by-row on every analytics refresh.
        if previous.is_some_and(|old| {
            old.get(&isolated_key)
                .is_some_and(|entry| unchanged(entry, isolated))
                && old
                    .get(&official_key)
                    .is_some_and(|entry| unchanged(entry, official))
        }) {
            continue;
        }

        let official_indexes: HashMap<_, _> = keys(official, &official_key)
            .into_iter()
            .enumerate()
            .map(|(index, key)| (key, index))
            .collect();
        let mut official_keep = vec![true; official.stats.entries.len()];
        let mut isolated_keep = vec![true; isolated.stats.entries.len()];
        for (index, key) in keys(isolated, &isolated_key).into_iter().enumerate() {
            let Some(&peer) = official_indexes.get(&key) else {
                continue;
            };
            if snapshot_order(&isolated.stats.entries[index])
                >= snapshot_order(&official.stats.entries[peer])
            {
                official_keep[peer] = false;
            } else {
                isolated_keep[index] = false;
            }
        }
        for (key, keep) in [(isolated_key, isolated_keep), (official_key, official_keep)] {
            let file = files.get_mut(&key).expect("paired file exists");
            let unique: Vec<_> = file
                .stats
                .entries
                .iter()
                .zip(keep)
                .filter_map(|(row, keep)| keep.then_some(row.clone()))
                .collect();
            file.rollup = CacheRollup::from_entries(SOURCE_CLAUDE, &unique);
        }
    }
}

#[cfg(test)]
#[path = "analytics_claude_profiles_tests.rs"]
mod tests;
