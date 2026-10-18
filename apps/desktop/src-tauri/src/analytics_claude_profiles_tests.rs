use super::*;
use std::io::Write;

fn row(id: &str, tokens: u64, time: &str) -> String {
    serde_json::json!({"type":"assistant", "timestamp":time,
        "message":{"id":id,"model":"claude-sonnet-4-5",
            "usage":{"input_tokens":tokens,"output_tokens":0}}})
    .to_string()
        + "\n"
}

fn refresh(
    roots: &[PathBuf],
    old: &HashMap<String, CacheFileEntry>,
) -> HashMap<String, CacheFileEntry> {
    let (discovered, complete) = discover(roots);
    assert!(complete);
    let mut files = old.clone();
    for file in discovered {
        let key = file.path.to_string_lossy().to_string();
        let entry = refresh_discovered_entry(
            old.get(&key),
            &file,
            get_file_meta(&file.path).unwrap(),
            &default_prices(),
        );
        files.insert(key, entry);
    }
    deduplicate(&mut files, Some(old), roots);
    files
}

fn total(files: &HashMap<String, CacheFileEntry>) -> u64 {
    CacheRollup::from_file_entries(files)
        .buckets
        .iter()
        .map(|bucket| bucket.usage.input_tokens)
        .sum()
}

fn fixture() -> (tempfile::TempDir, Vec<PathBuf>, PathBuf, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let roots = vec![
        temp.path().join(".ccem/agents/claude/projects"),
        temp.path().join(".claude/projects"),
    ];
    let isolated = roots[0].join("project/session.jsonl");
    let official = roots[1].join("project/session.jsonl");
    for file in [&isolated, &official] {
        fs::create_dir_all(file.parent().unwrap()).unwrap();
    }
    (temp, roots, isolated, official)
}

const TIME: &str = "2026-10-18T01:00:00Z";

#[test]
fn idless_usage_does_not_merge_distinct_contents_and_upgrades_old_cache_identities() {
    let (_temp, roots, isolated, official) = fixture();
    let copied = row("", 100, TIME);
    fs::write(&isolated, &copied).unwrap();
    fs::write(&official, &copied).unwrap();
    let mut old = refresh(&roots, &HashMap::new());
    for entry in old.values_mut() {
        entry
            .claude_state
            .as_mut()
            .unwrap()
            .row_fingerprints
            .clear();
        entry.rollup = CacheRollup::from_entries(SOURCE_CLAUDE, &entry.stats.entries);
    }
    assert_eq!(total(&old), 200);
    assert_eq!(
        total(&refresh(&roots, &old)),
        100,
        "v7 idless rows must be reparsed and merged"
    );
    let distinct = copied.replace("\"type\":", "\"uuid\":\"different-record\",\"type\":");
    fs::write(&official, distinct).unwrap();
    assert_eq!(total(&refresh(&roots, &HashMap::new())), 200);
    let mut missing_time: serde_json::Value = serde_json::from_str(&copied).unwrap();
    missing_time.as_object_mut().unwrap().remove("timestamp");
    let missing_time = missing_time.to_string() + "\n";
    fs::write(&official, &missing_time).unwrap();
    fs::write(&isolated, &missing_time).unwrap();
    assert_eq!(total(&refresh(&roots, &HashMap::new())), 100);
}

#[test]
fn both_profiles_add_turns_without_double_counting_migrated_history() {
    let (_temp, roots, isolated, official) = fixture();
    fs::write(
        &isolated,
        row("shared", 100, TIME) + &row("ccem", 200, TIME),
    )
    .unwrap();
    fs::write(
        &official,
        row("shared", 100, TIME) + &row("native", 300, TIME),
    )
    .unwrap();
    let original = [fs::read(&isolated).unwrap(), fs::read(&official).unwrap()];
    let first = refresh(&roots, &HashMap::new());
    assert_eq!(total(&first), 600);
    // Persist/reload raw parse state plus the deduplicated contributions.
    let persisted = serde_json::to_string(&first).unwrap();
    let previous = serde_json::from_str(&persisted).unwrap();
    let warm = refresh(&roots, &previous);
    assert_eq!(warm, first);
    assert_eq!(
        [fs::read(&isolated).unwrap(), fs::read(&official).unwrap()],
        original
    );
    for (file, id, amount) in [(&official, "native-new", 40), (&isolated, "ccem-new", 60)] {
        let mut stream = OpenOptions::new().append(true).open(file).unwrap();
        stream.write_all(row(id, amount, TIME).as_bytes()).unwrap();
    }
    let next = refresh(&roots, &warm);
    assert_eq!(total(&next), 700);
    let existing = CacheFile {
        files: warm.clone(),
        global_rollup: CacheRollup::from_file_entries(&warm),
        ..Default::default()
    };
    assert_eq!(
        update_global_rollup(&existing, &next).0,
        CacheRollup::from_file_entries(&next)
    );
    assert_eq!(total(&refresh(&roots, &next)), 700);
    fs::remove_file(&official).unwrap();
    assert_eq!(
        total(&refresh(&roots, &next)),
        700,
        "retained log history remains deduplicated"
    );
}

#[test]
fn final_snapshot_in_either_profile_replaces_partial_copy() {
    let (_temp, roots, isolated, official) = fixture();
    fs::write(&isolated, row("shared", 10, TIME)).unwrap();
    fs::write(&official, row("shared", 10, TIME)).unwrap();
    let first = refresh(&roots, &HashMap::new());
    OpenOptions::new()
        .append(true)
        .open(&official)
        .unwrap()
        .write_all(row("shared", 100, "2026-10-18T01:00:01Z").as_bytes())
        .unwrap();
    let next = refresh(&roots, &first);
    assert_eq!(total(&next), 100);
    OpenOptions::new()
        .append(true)
        .open(&isolated)
        .unwrap()
        .write_all(row("shared", 150, "2026-10-18T01:00:02Z").as_bytes())
        .unwrap();
    assert_eq!(total(&refresh(&roots, &next)), 150);
}

#[test]
fn idless_copies_preserve_occurrences_and_other_sessions_remain_distinct() {
    let (_temp, roots, isolated, official) = fixture();
    let no_id = row("", 100, TIME);
    fs::write(&isolated, no_id.repeat(2)).unwrap();
    fs::write(&official, no_id.repeat(3)).unwrap();
    let first = refresh(&roots, &HashMap::new());
    assert_eq!(total(&first), 300);
    fs::write(isolated.with_file_name("other.jsonl"), no_id).unwrap();
    assert_eq!(total(&refresh(&roots, &first)), 400);
}

#[test]
fn unfinished_official_lines_are_counted_only_after_newline() {
    let (_temp, roots, isolated, official) = fixture();
    fs::write(&isolated, row("ccem", 10, TIME)).unwrap();
    fs::write(&official, row("official", 20, TIME).trim_end()).unwrap();
    let first = refresh(&roots, &HashMap::new());
    assert_eq!(total(&first), 10);
    OpenOptions::new()
        .append(true)
        .open(&official)
        .unwrap()
        .write_all(b"\n")
        .unwrap();
    assert_eq!(total(&refresh(&roots, &first)), 30);
}

#[test]
fn discovery_reads_subagents_and_skips_symlinks() {
    let (_temp, roots, isolated, official) = fixture();
    fs::write(&official, row("official", 20, TIME)).unwrap();
    let subagent = isolated
        .parent()
        .unwrap()
        .join("session/subagents/agent-a.jsonl");
    fs::create_dir_all(subagent.parent().unwrap()).unwrap();
    fs::write(&subagent, row("agent", 30, TIME)).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&official, isolated.with_file_name("link.jsonl")).unwrap();
    let first = refresh(&roots, &HashMap::new());
    assert_eq!(total(&first), 50);
    assert_eq!(discover(&[roots[1].clone(), roots[1].clone()]).0.len(), 1);
    assert!(!roots[0].parent().unwrap().join(".claude.json").exists());
}
