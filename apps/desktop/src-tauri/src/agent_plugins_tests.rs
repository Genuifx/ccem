use super::*;

fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().canonicalize().unwrap();
    let source = home.join(".claude");
    let target = home.join(".ccem/agents/claude");
    (temp, source, target)
}

fn write(path: &Path, bytes: impl AsRef<[u8]>) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

fn read(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

fn add_plugin(
    source: &Path,
    id: &str,
    scope: &str,
    project: Option<&Path>,
    version: &str,
) -> PathBuf {
    let (name, market) = id.split_once('@').unwrap();
    let path = source
        .join("plugins/cache")
        .join(market)
        .join(name)
        .join(version);
    write(
        &path.join(".claude-plugin/plugin.json"),
        json!({"name":name,"version":version}).to_string(),
    );
    write(
        &path.join("skills/demo/SKILL.md"),
        format!("# {id} {version}"),
    );
    write(&path.join("hooks/run.sh"), b"#!/bin/sh\nexit 0\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path.join("hooks/run.sh"), fs::Permissions::from_mode(0o755)).unwrap();
    }
    let mut installed = if source.join(INSTALLED).exists() {
        read(&source.join(INSTALLED))
    } else {
        empty_registry()
    };
    installed["plugins"].as_object_mut().unwrap().entry(id).or_insert_with(|| json!([])).as_array_mut().unwrap().push(json!({
        "scope":scope,"projectPath":project.map(|path| path.to_string_lossy()),"installPath":path,"version":version,"installedAt":"2026-10-18T00:00:00Z"
    }));
    write(&source.join(INSTALLED), installed.to_string());
    let market_path = source.join("plugins/marketplaces").join(market);
    let manifest_path = market_path.join(".claude-plugin/marketplace.json");
    let mut manifest = if manifest_path.exists() {
        read(&manifest_path)
    } else {
        json!({"name":market,"plugins":[]})
    };
    if !manifest["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["name"] == name)
    {
        manifest["plugins"].as_array_mut().unwrap().push(json!({"name":name,"source":{"source":"url","url":"https://example.invalid/plugin.git"}}));
    }
    write(&manifest_path, manifest.to_string());
    write(
        &market_path.join(".git/config"),
        b"[core]\nrepositoryformatversion = 0\n",
    );
    let mut known = if source.join(MARKETPLACES).exists() {
        read(&source.join(MARKETPLACES))
    } else {
        json!({})
    };
    known[market] = json!({"source":{"source":"github","repo":"fixture/plugins"},"installLocation":market_path});
    write(&source.join(MARKETPLACES), known.to_string());
    path
}

fn file_state(root: &Path) -> BTreeMap<PathBuf, (Vec<u8>, std::time::SystemTime)> {
    fn visit(
        root: &Path,
        path: &Path,
        result: &mut BTreeMap<PathBuf, (Vec<u8>, std::time::SystemTime)>,
    ) {
        if !path.exists() {
            return;
        }
        let meta = fs::symlink_metadata(path).unwrap();
        assert!(!meta.file_type().is_symlink());
        let bytes = if meta.is_file() {
            fs::read(path).unwrap()
        } else {
            vec![]
        };
        result.insert(
            path.strip_prefix(root).unwrap().to_path_buf(),
            (bytes, meta.modified().unwrap()),
        );
        if meta.is_dir() {
            for entry in fs::read_dir(path).unwrap() {
                visit(root, &entry.unwrap().path(), result);
            }
        }
    }
    let mut result = BTreeMap::new();
    visit(root, root, &mut result);
    result
}

#[test]
fn imports_independent_assets_flags_marketplaces_and_backups_without_auth() {
    let (_temp, source, target) = fixture();
    let source_path = add_plugin(&source, "demo@fixture", "user", None, "1.0.0");
    write(&source.join("settings.json"), json!({"enabledPlugins":{"demo@fixture":true},"env":{"TOKEN":"official-secret"},"hooks":{"SessionStart":[]},"permissions":{"allow":["Bash(*)"]},"extraKnownMarketplaces":{"fixture":{"source":{"source":"directory","path":source.join("plugins/marketplaces/fixture")}}}}).to_string());
    write(&source.join(".credentials.json"), "official auth");
    let old_settings = b"{\"env\":{\"TOKEN\":\"ccem-secret\"},\"custom\":7}";
    write(&target.join("settings.json"), old_settings);
    write(&target.join(INSTALLED), b"{\"version\":2,\"plugins\":{}}\n");
    let before_source = file_state(&source);
    assert!(import_pending(&source, &target).unwrap());
    import_plugins(&source, &target).unwrap();
    assert_eq!(file_state(&source), before_source);
    let path = target.join("plugins/cache/fixture/demo/1.0.0");
    let registry = read(&target.join(INSTALLED));
    assert_eq!(
        registry["plugins"]["demo@fixture"][0]["installPath"],
        path.to_string_lossy().as_ref()
    );
    assert_eq!(
        fs::read(path.join("skills/demo/SKILL.md")).unwrap(),
        fs::read(source_path.join("skills/demo/SKILL.md")).unwrap()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(path.join("hooks/run.sh"))
                .unwrap()
                .permissions()
                .mode()
                & 0o111,
            0o111
        );
    }
    assert!(target
        .join("plugins/marketplaces/fixture/.git/config")
        .is_file());
    assert_eq!(
        read(&target.join(MARKETPLACES))["fixture"]["installLocation"],
        target
            .join("plugins/marketplaces/fixture")
            .to_string_lossy()
            .as_ref()
    );
    let settings = read(&target.join("settings.json"));
    assert_eq!(settings["enabledPlugins"]["demo@fixture"], true);
    assert_eq!(settings["env"]["TOKEN"], "ccem-secret");
    assert_eq!(settings["custom"], 7);
    assert!(settings.get("hooks").is_none());
    assert!(settings.get("permissions").is_none());
    assert!(!target.join(".credentials.json").exists());
    assert_eq!(
        settings["extraKnownMarketplaces"]["fixture"]["source"]["path"],
        target
            .join("plugins/marketplaces/fixture")
            .to_string_lossy()
            .as_ref()
    );
    assert_eq!(
        fs::read(target.join(BACKUP).join("settings.json")).unwrap(),
        old_settings
    );
    assert_eq!(
        read(&target.join(LEDGER)),
        json!({"version":1,"seen":{"demo@fixture":[{"scope":"user","projectPath":null}]}})
    );
    let before_target = file_state(&target);
    assert!(!import_pending(&source, &target).unwrap());
    import_plugins(&source, &target).unwrap();
    assert_eq!(
        file_state(&target),
        before_target,
        "no-change imports must not write anything"
    );
    write(
        &source_path.join("skills/demo/SKILL.md"),
        "official changed later",
    );
    assert_ne!(
        fs::read(source_path.join("skills/demo/SKILL.md")).unwrap(),
        fs::read(path.join("skills/demo/SKILL.md")).unwrap()
    );
}

#[test]
fn new_official_plugins_import_but_uninstalls_disables_and_versions_stay_local() {
    let (_temp, source, target) = fixture();
    add_plugin(&source, "removed@fixture", "user", None, "1");
    add_plugin(&source, "disabled@fixture", "user", None, "1");
    add_plugin(&source, "source-disabled@fixture", "user", None, "1");
    write(&source.join("settings.json"), json!({"enabledPlugins":{"removed@fixture":true,"disabled@fixture":true,"source-disabled@fixture":false}}).to_string());
    import_plugins(&source, &target).unwrap();
    assert_eq!(
        read(&target.join("settings.json"))["enabledPlugins"]["source-disabled@fixture"],
        false
    );
    let mut installed = read(&target.join(INSTALLED));
    installed["plugins"]
        .as_object_mut()
        .unwrap()
        .remove("removed@fixture");
    write(&target.join(INSTALLED), installed.to_string());
    write(
        &target.join("settings.json"),
        json!({"enabledPlugins":{"disabled@fixture":false,"source-disabled@fixture":true}})
            .to_string(),
    );
    let mut official = read(&source.join(INSTALLED));
    for id in [
        "removed@fixture",
        "disabled@fixture",
        "source-disabled@fixture",
    ] {
        official["plugins"][id][0]["version"] = json!("2");
        official["plugins"][id][0]["installPath"] = json!("/not/needed/for/seen/identity");
    }
    write(&source.join(INSTALLED), official.to_string());
    // Moving an already seen plugin into another official scope cannot undo
    // the user's CCEM uninstall.
    add_plugin(
        &source,
        "removed@fixture",
        "project",
        Some(&source.parent().unwrap().join("project")),
        "2",
    );
    add_plugin(&source, "new@fixture", "user", None, "1");
    assert!(import_pending(&source, &target).unwrap());
    import_plugins(&source, &target).unwrap();
    let installed = read(&target.join(INSTALLED));
    assert!(installed["plugins"].get("removed@fixture").is_none());
    assert!(installed["plugins"].get("new@fixture").is_some());
    assert_eq!(installed["plugins"]["disabled@fixture"][0]["version"], "1");
    let settings = read(&target.join("settings.json"));
    assert_eq!(settings["enabledPlugins"]["disabled@fixture"], false);
    assert_eq!(settings["enabledPlugins"]["source-disabled@fixture"], true);
    assert!(settings["enabledPlugins"].get("removed@fixture").is_none());
    assert_eq!(
        read(&target.join(LEDGER))["seen"]["removed@fixture"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn adds_only_missing_marketplace_entries_for_new_plugins_and_copies_local_sources() {
    let (_temp, source, target) = fixture();
    add_plugin(&source, "old@fixture", "user", None, "1");
    import_plugins(&source, &target).unwrap();
    let relative_manifest = "plugins/marketplaces/fixture/.claude-plugin/marketplace.json";
    let mut existing = read(&target.join(relative_manifest));
    existing["owner"] = json!({"name":"CCEM local owner"});
    existing["plugins"][0]["description"] = json!("CCEM local definition");
    write(&target.join(relative_manifest), existing.to_string());
    add_plugin(&source, "new@fixture", "user", None, "1");
    let mut official = read(&source.join(relative_manifest));
    official["plugins"][0]["description"] = json!("official replacement must not win");
    official["plugins"][1]["source"] = json!("./plugins/new");
    write(&source.join(relative_manifest), official.to_string());
    write(
        &source.join("plugins/marketplaces/fixture/plugins/new/skills/demo/SKILL.md"),
        "local marketplace new plugin",
    );
    import_plugins(&source, &target).unwrap();
    let actual = read(&target.join(relative_manifest));
    assert_eq!(actual["owner"], existing["owner"]);
    assert_eq!(actual["plugins"][0], existing["plugins"][0]);
    assert_eq!(actual["plugins"][1]["name"], "new");
    assert_eq!(actual["plugins"][1]["source"], "./plugins/new");
    assert_eq!(
        fs::read_to_string(
            target.join("plugins/marketplaces/fixture/plugins/new/skills/demo/SKILL.md")
        )
        .unwrap(),
        "local marketplace new plugin"
    );
    assert_eq!(read(&target.join(BACKUP).join(relative_manifest)), existing);
    let before = file_state(&target);
    import_plugins(&source, &target).unwrap();
    assert_eq!(file_state(&target), before);
}

#[test]
fn rebases_initial_absolute_local_sources_but_keeps_remote_repository_paths() {
    let (_temp, source, target) = fixture();
    let plugin = add_plugin(&source, "demo@fixture", "user", None, "1");
    let relative_manifest = "plugins/marketplaces/fixture/.claude-plugin/marketplace.json";
    let mut manifest = read(&source.join(relative_manifest));
    manifest["plugins"][0]["source"] = json!(plugin);
    manifest["plugins"].as_array_mut().unwrap().push(json!({"name":"remote","source":{"source":"git-subdir","url":"https://example.invalid/repo.git","path":"plugins/remote"}}));
    write(&source.join(relative_manifest), manifest.to_string());
    let mut known = read(&source.join(MARKETPLACES));
    known["fixture"]["source"]["path"] = json!("catalogues/marketplace.json");
    write(&source.join(MARKETPLACES), known.to_string());
    import_plugins(&source, &target).unwrap();
    let actual = read(&target.join(relative_manifest));
    assert_eq!(
        actual["plugins"][0]["source"],
        target
            .join("plugins/cache/fixture/demo/1")
            .to_string_lossy()
            .as_ref()
    );
    assert_eq!(actual["plugins"][1]["source"]["path"], "plugins/remote");
    assert_eq!(
        read(&target.join(MARKETPLACES))["fixture"]["source"]["path"],
        "catalogues/marketplace.json"
    );
    assert_eq!(read(&source.join(relative_manifest)), manifest);
}

#[test]
fn overlap_and_malformed_identities_fail_without_writes() {
    let (_temp, source, target) = fixture();
    add_plugin(&source, "demo@fixture", "user", None, "1");
    let before = file_state(&source);
    assert!(import_plugins(&source, &source)
        .unwrap_err()
        .contains("overlap"));
    assert_eq!(file_state(&source), before);
    for invalid in [
        "../demo@fixture",
        "demo@..",
        "demo@fixture/escape",
        "demo@fixture@other",
    ] {
        write(
            &target.join(LEDGER),
            json!({"version":1,"seen":{invalid:[{"scope":"user","projectPath":null}]}}).to_string(),
        );
        let before = file_state(&target);
        assert!(import_plugins(&source, &target).is_err());
        assert_eq!(file_state(&target), before);
    }
}

#[test]
fn failed_plugin_import_does_not_block_initialized_sessions_or_write_a_ledger() {
    let (_temp, source, target) = fixture();
    add_plugin(&source, "demo@fixture", "user", None, "1");
    let mut registry = read(&source.join(INSTALLED));
    registry["plugins"]["demo@fixture"][0]["installPath"] = json!(source.join("outside-plugins"));
    write(&source.join(INSTALLED), registry.to_string());
    write(
        &target.join(super::super::MIGRATION_MARKER),
        b"{\"version\":1}\n",
    );
    write(
        &target.join("projects/project/existing-session.jsonl"),
        b"{\"sessionId\":\"original\",\"message\":\"last turn\"}\n",
    );
    let history = fs::read(target.join("projects/project/existing-session.jsonl")).unwrap();
    super::super::ensure_agent_homes_for_mode_with_guard(
        source.parent().unwrap(),
        target.parent().unwrap(),
        &source.parent().unwrap().join(".codex"),
        false,
        |_, _, _, _| panic!("initialized session must not be blocked"),
    )
    .unwrap();
    assert!(!target.join(LEDGER).exists());
    assert_eq!(
        fs::read(target.join("projects/project/existing-session.jsonl")).unwrap(),
        history
    );
}

#[cfg(windows)]
#[test]
fn native_windows_registry_paths_can_import_into_a_canonical_profile() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join(".claude");
    let target = temp
        .path()
        .canonicalize()
        .unwrap()
        .join(".ccem/agents/claude");
    add_plugin(&source, "demo@fixture", "user", None, "1");
    import_plugins(&source, &target).unwrap();
    assert!(target
        .join("plugins/cache/fixture/demo/1/skills/demo/SKILL.md")
        .is_file());
}

#[test]
fn preserves_destination_identities_and_keeps_project_scopes_out_of_user_settings() {
    let (_temp, source, target) = fixture();
    let project = source.parent().unwrap().join("project");
    add_plugin(&source, "both@fixture", "user", None, "1");
    add_plugin(&source, "project@fixture", "project", Some(&project), "1");
    add_plugin(&source, "local@fixture", "local", Some(&project), "1");
    add_plugin(
        &target,
        "both@fixture",
        "project",
        Some(&project),
        "ccem-version",
    );
    add_plugin(&target, "existing@fixture", "user", None, "ccem-only");
    add_plugin(
        &source,
        "existing@fixture",
        "user",
        None,
        "official-version",
    );
    write(
        &target.join("settings.json"),
        json!({"enabledPlugins":{"both@fixture":false,"existing@fixture":false}}).to_string(),
    );
    write(&source.join("settings.json"), json!({"enabledPlugins":{"both@fixture":true,"project@fixture":true,"local@fixture":true,"existing@fixture":true}}).to_string());
    import_plugins(&source, &target).unwrap();
    let registry = read(&target.join(INSTALLED));
    assert_eq!(
        registry["plugins"]["both@fixture"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        registry["plugins"]["both@fixture"][0]["version"],
        "ccem-version"
    );
    assert_eq!(
        registry["plugins"]["existing@fixture"][0]["version"],
        "ccem-only"
    );
    assert!(!target
        .join("plugins/cache/fixture/existing/official-version")
        .exists());
    assert_eq!(
        registry["plugins"]["project@fixture"][0]["projectPath"],
        project.to_string_lossy().as_ref()
    );
    let flags = read(&target.join("settings.json"))["enabledPlugins"].clone();
    assert_eq!(
        flags,
        json!({"both@fixture":false,"existing@fixture":false})
    );
    assert!(!import_pending(&source, &target).unwrap());
}

#[test]
fn initialized_history_and_session_identity_are_unchanged_by_incremental_import() {
    fn linked_state(root: &Path) -> BTreeMap<PathBuf, (Vec<u8>, std::time::SystemTime)> {
        fn visit(path: &Path, result: &mut BTreeMap<PathBuf, (Vec<u8>, std::time::SystemTime)>) {
            let metadata = fs::symlink_metadata(path).unwrap();
            let bytes = if metadata.file_type().is_symlink() {
                fs::read_link(path)
                    .unwrap()
                    .to_string_lossy()
                    .as_bytes()
                    .to_vec()
            } else if metadata.is_file() {
                fs::read(path).unwrap()
            } else {
                vec![]
            };
            result.insert(path.to_path_buf(), (bytes, metadata.modified().unwrap()));
            if metadata.is_dir() {
                for entry in fs::read_dir(path).unwrap() {
                    visit(&entry.unwrap().path(), result);
                }
            }
        }
        let mut result = BTreeMap::new();
        visit(root, &mut result);
        result
    }
    let (_temp, source, target) = fixture();
    add_plugin(&source, "demo@fixture", "user", None, "1");
    write(
        &target.join(super::super::MIGRATION_MARKER),
        b"{\"version\":1,\"fixture\":true}\n",
    );
    write(
        &target.join("projects/project/session-id.jsonl"),
        b"{\"sessionId\":\"stable-id\",\"message\":\"existing turn\"}\n",
    );
    write(
        &target.join(".claude.json"),
        b"{\"hasCompletedOnboarding\":true,\"sessionId\":\"stable-id\"}",
    );
    write(&target.join("CLAUDE.md"), b"CCEM memory");
    let names = [
        super::super::MIGRATION_MARKER,
        "projects/project/session-id.jsonl",
        ".claude.json",
        "CLAUDE.md",
    ];
    let before = names.map(|name| {
        (
            fs::read(target.join(name)).unwrap(),
            fs::metadata(target.join(name)).unwrap().modified().unwrap(),
        )
    });
    super::super::ensure_agent_homes_for_mode_with_guard(
        source.parent().unwrap(),
        target.parent().unwrap(),
        &source.parent().unwrap().join(".codex"),
        false,
        |_, _, _, _| panic!("history is already initialized"),
    )
    .unwrap();
    for (index, name) in names.iter().enumerate() {
        assert_eq!(fs::read(target.join(name)).unwrap(), before[index].0);
        assert_eq!(
            fs::metadata(target.join(name)).unwrap().modified().unwrap(),
            before[index].1
        );
    }
    assert!(target.join(INSTALLED).exists());
    let before = linked_state(&target);
    super::super::ensure_agent_homes_for_mode_with_guard(
        source.parent().unwrap(),
        target.parent().unwrap(),
        &source.parent().unwrap().join(".codex"),
        false,
        |_, _, _, _| panic!("history is already initialized"),
    )
    .unwrap();
    assert_eq!(linked_state(&target), before);
}

#[test]
fn invalid_ledgers_and_concurrent_metadata_changes_do_not_publish() {
    let (_temp, source, target) = fixture();
    add_plugin(&source, "demo@fixture", "user", None, "1");
    for ledger in [
        json!({"version":2,"seen":{}}),
        json!({"version":1,"seen":{"demo@fixture":[{"scope":"user"}]}}),
        json!({"version":1,"seen":{"demo@fixture":[{"scope":"user","projectPath":null},{"scope":"user","projectPath":null}]}}),
        json!({"version":1,"seen":{},"ignored":true}),
    ] {
        write(&target.join(LEDGER), ledger.to_string());
        let before = file_state(&target);
        assert!(import_pending(&source, &target).is_err());
        assert!(import_plugins(&source, &target).is_err());
        assert_eq!(file_state(&target), before);
    }
    fs::remove_file(target.join(LEDGER)).unwrap();
    assert!(import_with_check(&source, &target, || {
        write(&target.join("settings.json"), b"{\"concurrent\":true}");
        Ok(())
    })
    .unwrap_err()
    .contains("changed"));
    assert_eq!(
        read(&target.join("settings.json")),
        json!({"concurrent":true})
    );
    assert!(!target.join(LEDGER).exists());
    assert!(!target.join(INSTALLED).exists());
    assert!(import_with_check(&source, &target, || {
        write(
            &source.join("settings.json"),
            b"{\"concurrentOfficial\":true}",
        );
        Ok(())
    })
    .unwrap_err()
    .contains("changed"));
    assert!(!target.join(LEDGER).exists());
    assert!(!target.join(INSTALLED).exists());
}

#[cfg(unix)]
#[test]
fn materializes_confined_symlinks_and_refuses_escape_cycle_or_destination_links() {
    use crate::test_support::{symlink_dir, symlink_file};
    let (_temp, source, target) = fixture();
    let path = add_plugin(&source, "demo@fixture", "user", None, "1");
    symlink_file("skills/demo/SKILL.md", path.join("linked.md")).unwrap();
    import_plugins(&source, &target).unwrap();
    let linked = target.join("plugins/cache/fixture/demo/1/linked.md");
    assert!(!fs::symlink_metadata(&linked)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(
        fs::read(linked).unwrap(),
        fs::read(path.join("skills/demo/SKILL.md")).unwrap()
    );
    for malicious in ["escape", "cycle", "destination", "destination-internal"] {
        let (_temp, source, target) = fixture();
        let path = add_plugin(&source, "demo@fixture", "user", None, "1");
        match malicious {
            "escape" => {
                write(&source.join(".credentials.json"), "secret");
                symlink_file(source.join(".credentials.json"), path.join("linked")).unwrap();
            }
            "cycle" => symlink_dir(".", path.join("linked")).unwrap(),
            "destination" => {
                fs::create_dir_all(&target).unwrap();
                symlink_dir(source.join("plugins"), target.join("plugins")).unwrap();
            }
            _ => {
                let target_plugin = target.join("plugins/cache/fixture/demo/1");
                fs::create_dir_all(&target_plugin).unwrap();
                symlink_file("/nonexistent/fixture", target_plugin.join("unused-link")).unwrap();
            }
        }
        assert!(import_plugins(&source, &target).is_err());
        assert!(!target.join(LEDGER).exists());
    }
}

#[test]
fn missing_source_writes_nothing_and_asset_conflicts_preserve_existing_files() {
    let (_temp, source, target) = fixture();
    assert!(!import_pending(&source, &target).unwrap());
    import_plugins(&source, &target).unwrap();
    assert!(!target.exists());
    add_plugin(&source, "demo@fixture", "user", None, "1");
    let existing = target.join("plugins/cache/fixture/demo/1/skills/demo/SKILL.md");
    write(&existing, "CCEM local modification");
    let before = fs::read(&existing).unwrap();
    assert!(import_plugins(&source, &target)
        .unwrap_err()
        .contains("conflict"));
    assert_eq!(fs::read(&existing).unwrap(), before);
    assert!(!target.join(INSTALLED).exists());
    assert!(!target.join(LEDGER).exists());
}

#[test]
fn refuses_runtime_data_paths_but_imports_plugins_own_static_data_directories() {
    let (_temp, source, target) = fixture();
    let plugin = add_plugin(&source, "demo@fixture", "user", None, "1");
    write(
        &source.join("plugins/data/secret.json"),
        "official plugin private state",
    );
    write(&plugin.join("data/static.txt"), "plugin shipped asset");
    let mut registry = read(&source.join(INSTALLED));
    let original = registry.clone();
    registry["plugins"]["demo@fixture"][0]["installPath"] = json!(source.join("plugins/data"));
    write(&source.join(INSTALLED), registry.to_string());
    assert!(import_plugins(&source, &target)
        .unwrap_err()
        .contains("runtime data"));
    assert!(!target.join(LEDGER).exists());
    assert!(!target.join(INSTALLED).exists());
    write(&source.join(INSTALLED), original.to_string());
    import_plugins(&source, &target).unwrap();
    assert_eq!(
        fs::read_to_string(target.join("plugins/cache/fixture/demo/1/data/static.txt")).unwrap(),
        "plugin shipped asset"
    );
    assert!(!target.join("plugins/data").exists());
    assert_eq!(
        fs::read_to_string(source.join("plugins/data/secret.json")).unwrap(),
        "official plugin private state"
    );
}

#[cfg(unix)]
#[test]
fn refuses_confined_symlinks_to_runtime_data_without_publishing_metadata() {
    use crate::test_support::symlink_dir;
    let (_temp, source, target) = fixture();
    let plugin = add_plugin(&source, "demo@fixture", "user", None, "1");
    write(
        &source.join("plugins/data/secret.json"),
        "official plugin private state",
    );
    symlink_dir(source.join("plugins/data"), plugin.join("linked-state")).unwrap();
    let installed = fs::read(source.join(INSTALLED)).unwrap();
    let markets = fs::read(source.join(MARKETPLACES)).unwrap();
    assert!(import_plugins(&source, &target)
        .unwrap_err()
        .contains("runtime data"));
    for file in [LEDGER, INSTALLED, MARKETPLACES, "settings.json"] {
        assert!(!target.join(file).exists());
    }
    assert!(!target.join("plugins/data").exists());
    assert_eq!(fs::read(source.join(INSTALLED)).unwrap(), installed);
    assert_eq!(fs::read(source.join(MARKETPLACES)).unwrap(), markets);
    assert_eq!(
        fs::read_to_string(source.join("plugins/data/secret.json")).unwrap(),
        "official plugin private state"
    );
}

#[test]
fn refuses_existing_marketplace_destinations_inside_ccem_runtime_data() {
    let (_temp, source, target) = fixture();
    add_plugin(&source, "demo@fixture", "user", None, "1");
    add_plugin(&target, "existing@fixture", "user", None, "local");
    let destination = target.join("plugins/data/private-marketplace");
    write(
        &destination.join(".claude-plugin/marketplace.json"),
        json!({"name":"fixture","plugins":[]}).to_string(),
    );
    let mut markets = read(&target.join(MARKETPLACES));
    markets["fixture"]["installLocation"] = json!(destination);
    write(&target.join(MARKETPLACES), markets.to_string());
    let before = file_state(&target);
    assert!(import_plugins(&source, &target)
        .unwrap_err()
        .contains("runtime data"));
    assert_eq!(file_state(&target), before);
    assert!(!target.join(LEDGER).exists());
}
