use super::*;

fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let temp = tempfile::tempdir().expect("fixture");
    let home = fs::canonicalize(temp.path())
        .expect("canonical fixture")
        .join("user");
    fs::create_dir_all(&home).expect("home");
    let base = home.join(".ccem/agents");
    (temp, home, base)
}

fn write(path: &Path, value: &str) {
    fs::create_dir_all(path.parent().unwrap()).expect("fixture parent");
    fs::write(path, value).expect("fixture file");
}

#[test]
fn codex_defaults_to_shared_and_pins_override_only_the_process() {
    let (_temp, home, base) = fixture();
    assert!(!codex_isolation_from(None, &base).unwrap());
    assert!(codex_isolation_from(Some("1"), &base).unwrap());
    assert!(!base.exists(), "reading defaults does not create a profile");
    write(
        &base.join("profiles.json"),
        "{\"codexIsolation\":true,\"other\":7}",
    );
    assert!(codex_isolation_from(None, &base).unwrap());
    assert!(!codex_isolation_from(Some("0"), &base).unwrap());
    assert!(
        read_codex_isolation_preference(&base).unwrap(),
        "pin must not change saved selection"
    );
    write(
        &base.join("profiles.json"),
        "{\"codexIsolation\":\"false\"}",
    );
    assert!(codex_isolation_from(None, &base).is_err());
    assert!(
        !codex_isolation_from(Some("0"), &base).unwrap(),
        "existing shared process remains pinned"
    );
    write(&base.join("profiles.json"), "broken");
    assert!(read_codex_isolation_preference(&base).is_err());
    assert_eq!(
        resolve_shared_codex_home(&home, None, &home),
        home.join(".codex")
    );
    assert_eq!(
        resolve_shared_codex_home(&home, Some("~/custom"), &base),
        home.join("custom")
    );
    assert_eq!(
        resolve_shared_codex_home(&home, Some("relative"), &base),
        base.join("relative")
    );
    assert_eq!(resolve_shared_codex_home(&home, Some("~"), &base), home);
}

#[test]
fn shared_mode_prepares_only_claude_and_never_modifies_codex_home() {
    let (_temp, home, base) = fixture();
    let shared = home.join("custom official codex");
    write(&shared.join("auth.json"), "fixture shared auth");
    write(&shared.join("config.toml"), "model = 'shared-model'");
    write(&shared.join("sessions/session.jsonl"), "shared transcript");
    let before = fs::metadata(&shared).unwrap().modified().unwrap();
    ensure_agent_homes_for_mode_with_guard(&home, &base, &shared, false, |_, _, _, pending| {
        assert_eq!(pending, &["claude"]);
        Ok(())
    })
    .unwrap();
    assert!(base.join("claude").join(MIGRATION_MARKER).exists());
    assert!(!base.join("codex").exists());
    assert!(!shared.join(MIGRATION_MARKER).exists());
    assert_eq!(fs::metadata(&shared).unwrap().modified().unwrap(), before);
    assert_eq!(
        fs::read_to_string(shared.join("auth.json")).unwrap(),
        "fixture shared auth"
    );
    assert_eq!(
        fs::read_to_string(shared.join("config.toml")).unwrap(),
        "model = 'shared-model'"
    );
}

#[test]
fn opt_in_snapshots_custom_shared_home_before_preference_and_toggle_preserves_it() {
    let (_temp, home, base) = fixture();
    let shared = home.join("custom-codex");
    write(&shared.join("sessions/session.jsonl"), "shared first turn");
    write(&shared.join("auth.json"), "fixture shared auth");
    write(
        &base.join("profiles.json"),
        "{\"codexIsolation\":false,\"other\":7}",
    );
    let failure =
        set_codex_isolation_with_prepare(&home, &base, true, || Err("still running".into()));
    assert!(failure.is_err());
    assert!(!read_codex_isolation_preference(&base).unwrap());
    set_codex_isolation_with_prepare(&home, &base, true, || {
        ensure_agent_homes_for_mode_with_guard(
            &home,
            &base,
            &shared,
            true,
            |_, _, source, pending| {
                assert_eq!(source, shared);
                assert!(pending.contains(&"codex"));
                Ok(())
            },
        )
    })
    .unwrap();
    assert!(read_codex_isolation_preference(&base).unwrap());
    assert_eq!(read_profile_preferences(&base).unwrap()["other"], 7);
    assert_eq!(
        fs::read_to_string(base.join("codex/sessions/session.jsonl")).unwrap(),
        "shared first turn"
    );
    assert!(!base.join("codex/auth.json").exists());
    set_codex_isolation_with_prepare(&home, &base, false, || panic!("disabling never prepares"))
        .unwrap();
    assert!(!read_codex_isolation_preference(&base).unwrap());
    assert!(base.join("codex").join(MIGRATION_MARKER).exists());
    write(&shared.join("sessions/session.jsonl"), "new shared turn");
    // A prepared helper pins CODEX_HOME to its own root; completed markers
    // bypass source overlap validation and never import a second snapshot.
    ensure_agent_homes_for_mode_with_guard(
        &home,
        &base,
        &base.join("codex"),
        true,
        |_, _, _, _| panic!("completed snapshot"),
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(base.join("codex/sessions/session.jsonl")).unwrap(),
        "shared first turn"
    );
}

#[test]
fn pending_codex_isolation_rejects_overlap_before_writing_directories() {
    let (_temp, home, base) = fixture();
    assert!(
        ensure_agent_homes_for_mode_with_guard(&home, &base, &base, true, |_, _, _, _| Ok(()))
            .unwrap_err()
            .contains("overlap")
    );
    assert!(!base.exists());
}

#[test]
fn snapshot_preserves_history_and_memory_without_credentials_or_config() {
    let (_temp, home, base) = fixture();
    let copied = [
        (".claude/CLAUDE.md", "claude/CLAUDE.md"),
        (".codex/AGENTS.md", "codex/AGENTS.md"),
        (".codex/AGENTS.override.md", "codex/AGENTS.override.md"),
        (
            ".claude/projects/project/session.jsonl",
            "claude/projects/project/session.jsonl",
        ),
        (
            ".claude/projects/project/session/subagents/agent-one.jsonl",
            "claude/projects/project/session/subagents/agent-one.jsonl",
        ),
        (
            ".claude/projects/project/memory/MEMORY.md",
            "claude/projects/project/memory/MEMORY.md",
        ),
        (".claude/history.jsonl", "claude/history.jsonl"),
        (".claude/plans/plan.md", "claude/plans/plan.md"),
        (
            ".claude/file-history/session/file",
            "claude/file-history/session/file",
        ),
        (
            ".codex/sessions/2026/rollout-session.jsonl",
            "codex/sessions/2026/rollout-session.jsonl",
        ),
        (
            ".codex/archived_sessions/rollout-old.jsonl",
            "codex/archived_sessions/rollout-old.jsonl",
        ),
        (".codex/history.jsonl", "codex/history.jsonl"),
        (".codex/session_index.jsonl", "codex/session_index.jsonl"),
        (".codex/memories/MEMORY.md", "codex/memories/MEMORY.md"),
        (
            ".codex/memories_v2/rollout_summaries/old.md",
            "codex/memories_v2/rollout_summaries/old.md",
        ),
    ];
    let excluded = [
        ".claude/.credentials.json",
        ".claude/settings.json",
        ".claude.json",
        ".claude/plugins/installed_plugins.json",
        ".codex/auth.json",
        ".codex/config.toml",
        ".codex/state_5.sqlite",
        ".codex/memories_v2/state.sqlite",
        ".codex/memories_v2/state.sqlite-shm",
        ".codex/memories/nested/cache.db-wal",
        ".codex/plugins/registry.json",
    ];
    for (source, _) in &copied {
        write(&home.join(source), source);
    }
    for source in &excluded {
        write(&home.join(source), "fixture secret/config");
    }
    let before = fs::metadata(home.join(".claude/projects/project/session.jsonl"))
        .unwrap()
        .modified()
        .unwrap();

    ensure_agent_homes_at(&home, &base).expect("snapshot");

    for (source, target) in copied {
        assert_eq!(fs::read_to_string(base.join(target)).unwrap(), source);
        assert_eq!(
            fs::read_to_string(home.join(source)).unwrap(),
            source,
            "official source is unchanged"
        );
    }
    for source in excluded {
        assert_eq!(
            fs::read_to_string(home.join(source)).unwrap(),
            "fixture secret/config"
        );
    }
    for relative in [
        "claude/.credentials.json",
        "claude/settings.json",
        "claude/plugins",
        "codex/auth.json",
        "codex/config.toml",
        "codex/state_5.sqlite",
        "codex/memories_v2/state.sqlite",
        "codex/memories_v2/state.sqlite-shm",
        "codex/memories/nested/cache.db-wal",
        "codex/plugins",
    ] {
        assert!(!base.join(relative).exists(), "must not migrate {relative}");
    }
    assert_eq!(
        fs::read_to_string(base.join("claude/.claude.json")).unwrap(),
        "{\"hasCompletedOnboarding\":true}\n"
    );
    assert_eq!(
        fs::metadata(base.join("claude/projects/project/session.jsonl"))
            .unwrap()
            .modified()
            .unwrap(),
        before
    );
    assert!(!base.join(MIGRATION_LOCK).exists());
}

#[test]
fn snapshot_is_frozen_and_resumed_session_changes_stay_in_ccem() {
    let (_temp, home, base) = fixture();
    let source = home.join(".claude/projects/p/session.jsonl");
    let target = base.join("claude/projects/p/session.jsonl");
    write(&source, "first turn\n");
    ensure_agent_homes_at(&home, &base).unwrap();
    write(&source, "first turn\nofficial later turn\n");
    write(
        &home.join(".claude/projects/p/new-official.jsonl"),
        "new official session",
    );
    write(
        &home.join(".codex/sessions/new-official.jsonl"),
        "new official Codex session",
    );
    write(&target, "first turn\nCCEM resumed turn\n");

    ensure_agent_homes_at(&home, &base).unwrap();

    assert_eq!(
        fs::read_to_string(&source).unwrap(),
        "first turn\nofficial later turn\n"
    );
    assert_eq!(
        fs::read_to_string(&target).unwrap(),
        "first turn\nCCEM resumed turn\n"
    );
    assert!(!base.join("claude/projects/p/new-official.jsonl").exists());
    assert!(!base.join("codex/sessions/new-official.jsonl").exists());
}

#[test]
fn interrupted_snapshot_can_retry_without_overwriting_existing_ccem_files() {
    let (_temp, home, base) = fixture();
    write(&home.join(".claude/projects/p/one.jsonl"), "old one");
    write(&home.join(".claude/projects/p/two.jsonl"), "old two");
    write(&base.join("claude/projects/p/one.jsonl"), "already resumed");
    ensure_agent_homes_at(&home, &base).unwrap();
    assert_eq!(
        fs::read_to_string(base.join("claude/projects/p/one.jsonl")).unwrap(),
        "already resumed"
    );
    assert_eq!(
        fs::read_to_string(base.join("claude/projects/p/two.jsonl")).unwrap(),
        "old two"
    );
    assert!(migration_complete(&base.join("claude")).unwrap());
}

#[test]
fn conflicting_destination_does_not_mark_migration_complete() {
    let (_temp, home, base) = fixture();
    write(&home.join(".claude/history.jsonl"), "original history");
    fs::create_dir_all(base.join("claude/history.jsonl")).unwrap();
    assert!(ensure_agent_homes_at(&home, &base)
        .unwrap_err()
        .contains("conflicts with a directory"));
    assert!(!base.join("claude").join(MIGRATION_MARKER).exists());
    assert!(!base.join(MIGRATION_LOCK).exists());
    fs::remove_dir(base.join("claude/history.jsonl")).unwrap();
    ensure_agent_homes_at(&home, &base).unwrap();
    assert_eq!(
        fs::read_to_string(base.join("claude/history.jsonl")).unwrap(),
        "original history"
    );
}

#[test]
fn migration_waits_for_legacy_writer_then_copies_final_turns_and_freezes() {
    let (_temp, home, base) = fixture();
    let source = home.join(".claude/projects/p/session.jsonl");
    write(&source, "first turn\n");
    let error = ensure_agent_homes_with_guard(&home, &base, |_, _, pending| {
        assert_eq!(pending, &["claude", "codex"]);
        Err(legacy_writer_error(12345, "claude"))
    })
    .unwrap_err();
    assert!(error.contains("Finish or stop"));
    assert!(!base.join("claude/projects").exists());
    assert!(!base.join("claude").join(MIGRATION_MARKER).exists());
    assert!(!base.join(MIGRATION_LOCK).exists());
    write(&source, "first turn\nfinal legacy turn\n");
    ensure_agent_homes_with_guard(&home, &base, |_, _, _| Ok(())).unwrap();
    assert_eq!(
        fs::read_to_string(base.join("claude/projects/p/session.jsonl")).unwrap(),
        "first turn\nfinal legacy turn\n"
    );
    ensure_agent_homes_with_guard(&home, &base, |_, _, _| {
        panic!("completed migration must never inspect official writers")
    })
    .unwrap();
}

#[test]
fn legacy_writer_classifier_requires_ccem_ownership_and_source_home() {
    let (_temp, home, base) = fixture();
    let mut env = HashMap::from([("HOME".into(), home.to_string_lossy().to_string())]);
    let classify = |env: &HashMap<String, String>, provider, pending: &[&str]| {
        legacy_writer_provider(
            12345,
            999,
            provider,
            env,
            &home,
            &home.join(".codex"),
            &base,
            pending,
        )
    };
    assert_eq!(
        classify(&env, "claude", &["claude", "codex"]),
        None,
        "official process"
    );
    env.insert("CCEM_SESSION_ID".into(), "legacy-session".into());
    assert_eq!(
        classify(&env, "claude", &["claude", "codex"]),
        Some("claude")
    );
    assert_eq!(classify(&env, "codex", &["claude", "codex"]), Some("codex"));
    assert_eq!(
        classify(&env, "claude", &["codex"]),
        None,
        "completed provider"
    );
    assert_eq!(
        legacy_writer_provider(
            12345,
            12345,
            "claude",
            &env,
            &home,
            &home.join(".codex"),
            &base,
            &["claude"]
        ),
        None,
        "self"
    );
    env.insert(
        "CLAUDE_CONFIG_DIR".into(),
        base.join("claude").to_string_lossy().to_string(),
    );
    assert_eq!(
        classify(&env, "claude", &["claude"]),
        None,
        "already isolated"
    );
    env.insert(
        "CLAUDE_CONFIG_DIR".into(),
        home.join("another-profile").to_string_lossy().to_string(),
    );
    assert_eq!(
        classify(&env, "claude", &["claude"]),
        None,
        "other independent source"
    );
    env.remove("CLAUDE_CONFIG_DIR");
    env.insert(
        "HOME".into(),
        home.join("other-user").to_string_lossy().to_string(),
    );
    assert_eq!(
        classify(&env, "native", &["claude", "codex"]),
        None,
        "another user's home"
    );
}

#[test]
fn unavailable_environment_requires_persisted_source_ownership() {
    let (_temp, home, base) = fixture();
    assert!(!is_persisted_legacy_pid(
        &home,
        &home.join(".codex"),
        12345,
        "claude",
        &["claude"]
    ));
    write(
        &home.join(".ccem/sessions.json"),
        &serde_json::json!([
            {"pid":12345,"client":"claude"},
            {"pid":12346,"client":"codex","jsonl_path":base.join("codex/sessions/a.jsonl")}
        ])
        .to_string(),
    );
    assert!(is_persisted_legacy_pid(
        &home,
        &home.join(".codex"),
        12345,
        "claude",
        &["claude"]
    ));
    assert!(!is_persisted_legacy_pid(
        &home,
        &home.join(".codex"),
        12345,
        "codex",
        &["codex"]
    ));
    assert!(!is_persisted_legacy_pid(
        &home,
        &home.join(".codex"),
        12346,
        "codex",
        &["codex"]
    ));
    assert!(!is_persisted_legacy_pid(
        &home,
        &home.join(".codex"),
        999,
        "claude",
        &["claude"]
    ));
}

#[test]
fn process_environment_parser_keeps_paths_with_spaces_and_ignores_prompt_markers() {
    let command = "/opt/claude -p explain CCEM_SESSION_ID=quoted";
    let expanded = format!("{command} HOME=/Users/Fixture User PATH=/bin CCEM_RUNTIME_ID=real CLAUDE_CONFIG_DIR=/Users/Fixture User/.claude ANTHROPIC_API_KEY=must-not-retain");
    let env = parse_ps_environment(command, &expanded).unwrap();
    assert_eq!(env.get("CCEM_RUNTIME_ID").map(String::as_str), Some("real"));
    assert_eq!(
        env.get("HOME").map(String::as_str),
        Some("/Users/Fixture User")
    );
    assert_eq!(
        env.get("CLAUDE_CONFIG_DIR").map(String::as_str),
        Some("/Users/Fixture User/.claude")
    );
    assert!(!env.contains_key("CCEM_SESSION_ID"));
    assert!(!env.contains_key("ANTHROPIC_API_KEY"));
    assert_eq!(
        process_provider(
            "/opt/node",
            "/opt/node /sdk/@anthropic-ai/claude-code/cli.js"
        ),
        Some("claude")
    );
    assert_eq!(
        process_provider("/opt/bun", "/opt/bun /app/native-runtime-helper.mjs"),
        Some("native")
    );
    assert_eq!(
        process_provider("/opt/node", "/opt/node unrelated.js"),
        None
    );
    assert_eq!(
        process_provider("/opt/claude-helper", "/opt/claude-helper"),
        None
    );
    for executable in [
        "/opt/claude",
        "/opt/@anthropic-ai/claude-code/bin/claude.exe",
        "/opt/codex.exe",
        "/opt/node",
        "/app/ccem-node-aarch64-apple-darwin",
    ] {
        assert!(
            potential_agent_executable(executable),
            "must inspect {executable}"
        );
    }
    assert!(!potential_agent_executable("/opt/unrelated-claude-helper"));
    let rows = parse_process_rows("  42 /Applications/CCEM Desktop.app/Contents/MacOS/ccem-node /app/native-runtime-helper.mjs\n99 /opt/claude.exe --resume id\n");
    assert_eq!(rows.get(&42).map(String::as_str), Some("/Applications/CCEM Desktop.app/Contents/MacOS/ccem-node /app/native-runtime-helper.mjs"));
    assert_eq!(
        rows.get(&99).map(String::as_str),
        Some("/opt/claude.exe --resume id")
    );
}

#[cfg(unix)]
#[test]
fn process_environment_probe_reads_only_owned_fixture_process() {
    use std::process::{Command, Stdio};
    let (_temp, home, _base) = fixture();
    // macOS omits env for SIP-protected /bin/sleep even when we own it. Node
    // exercises the same observable process kind as the agent helpers.
    let node = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|directory| directory.join("node"))
        .find(|path| path.is_file())
        .expect("Node workspace runtime");
    let mut child = Command::new(node)
        .args(["-e", "setInterval(() => {}, 10000)"])
        .env_clear()
        .env("HOME", &home)
        .env("CCEM_SESSION_ID", "fixture-owned")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let pid = child.id().to_string();
    let command = Command::new("ps")
        .args(["ww", "-p", &pid, "-o", "command="])
        .output();
    let expanded = Command::new("ps")
        .args(["eww", "-p", &pid, "-o", "command="])
        .output();
    let _ = child.kill();
    let _ = child.wait();
    let command = command.unwrap();
    let expanded = expanded.unwrap();
    assert!(command.status.success());
    assert!(expanded.status.success());
    let env = parse_ps_environment(
        &String::from_utf8_lossy(&command.stdout),
        &String::from_utf8_lossy(&expanded.stdout),
    )
    .unwrap();
    assert_eq!(
        env.get("CCEM_SESSION_ID").map(String::as_str),
        Some("fixture-owned")
    );
    assert_eq!(env.get("HOME"), Some(&home.to_string_lossy().to_string()));
}

#[test]
fn invalid_roots_and_live_or_malformed_locks_fail_before_migration() {
    let (_temp, home, base) = fixture();
    for invalid in [
        PathBuf::from("relative"),
        home.clone(),
        home.join(".claude/ccem"),
        home.join(".codex"),
        home.join("../escape"),
    ] {
        assert!(
            ensure_agent_homes_at(&home, &invalid).is_err(),
            "reject {}",
            invalid.display()
        );
    }
    write(&home.join(".claude/projects/p/session.jsonl"), "original");
    write(
        &base.join(MIGRATION_LOCK),
        &format!("{{\"pid\":{}}}", std::process::id()),
    );
    assert!(ensure_agent_homes_at(&home, &base)
        .unwrap_err()
        .contains("owned by process"));
    assert!(!base.join("claude/projects").exists());
    write(&base.join(MIGRATION_LOCK), "");
    assert!(ensure_agent_homes_at(&home, &base)
        .unwrap_err()
        .contains("Invalid agent migration lock"));
    assert!(!base.join("claude").join(MIGRATION_MARKER).exists());
}

#[test]
fn migration_lock_recovers_only_an_exited_process() {
    let (_temp, _home, base) = fixture();
    fs::create_dir_all(&base).unwrap();
    // A real child that has been waited is better evidence than assuming an
    // arbitrary high pid is unused on the test machine.
    #[cfg(unix)]
    let mut child = std::process::Command::new("sh")
        .args(["-c", "exit 0"])
        .spawn()
        .unwrap();
    #[cfg(windows)]
    let mut child = std::process::Command::new("cmd")
        .args(["/C", "exit 0"])
        .spawn()
        .unwrap();
    #[cfg(any(unix, windows))]
    {
        let pid = child.id();
        child.wait().unwrap();
        write(&base.join(MIGRATION_LOCK), &format!("{{\"pid\":{pid}}}"));
        let lock = MigrationLock::acquire(&base).expect("recover proven dead owner");
        assert_eq!(fs::read(&lock.path).unwrap(), lock.bytes);
        drop(lock);
        assert!(!base.join(MIGRATION_LOCK).exists());
    }
}

#[cfg(unix)]
#[test]
fn snapshot_skips_source_symlinks_and_rejects_destination_symlinks() {
    use std::os::unix::fs::symlink;
    let (_temp, home, base) = fixture();
    write(&home.join(".claude/projects/p/real.jsonl"), "transcript");
    write(
        &home.join(".claude/.credentials.json"),
        "fixture credential",
    );
    symlink(
        home.join(".claude/.credentials.json"),
        home.join(".claude/projects/p/linked.jsonl"),
    )
    .unwrap();
    symlink(home.join(".claude"), home.join(".claude/projects/p/loop")).unwrap();
    ensure_agent_homes_at(&home, &base).unwrap();
    assert!(base.join("claude/projects/p/real.jsonl").exists());
    assert!(!base.join("claude/projects/p/linked.jsonl").exists());
    assert!(!base.join("claude/projects/p/loop").exists());

    let linked_base = home.join("linked-agents");
    symlink(&base, &linked_base).unwrap();
    assert!(ensure_agent_homes_at(&home, &linked_base)
        .unwrap_err()
        .contains("symlink"));
    let second_base = home.join("second-agents");
    fs::create_dir_all(&second_base).unwrap();
    symlink(home.join(".claude"), second_base.join("claude")).unwrap();
    assert!(ensure_agent_homes_at(&home, &second_base)
        .unwrap_err()
        .contains("symlink"));
}
