use super::*;

fn write(path: &Path, bytes: impl AsRef<[u8]>) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

fn read(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

fn fixture(local: bool) -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let source = root.join("official");
    let target = root.join("private");
    let cache = source.join("plugins/cache/market/demo/1.0.0");
    let market = source.join("plugins/marketplaces/market");
    for code in [cache.clone(), market.join("plugins/demo")] {
        write(
            &code.join(".claude-plugin/plugin.json"),
            json!({"name":"demo","version":"1.0.0"}).to_string(),
        );
        write(
            &code.join("skills/hello/SKILL.md"),
            b"original plugin skill",
        );
        write(&code.join("hooks/run.sh"), b"#!/bin/sh\nexit 0\n");
        write(&code.join(".git/config"), b"local git bookkeeping");
    }
    write(&source.join(INSTALLED), json!({"version":2,"plugins":{"demo@market":[{"scope":"user","projectPath":null,"version":"1.0.0","installPath":cache}]}}).to_string());
    write(&source.join(KNOWN), json!({"market":{"source":{"source":"github","repo":"example/plugins"},"installLocation":market}}).to_string());
    let catalogue_source = if local {
        json!("./plugins/demo")
    } else {
        json!({"source":"url","url":"https://example.invalid/plugin.git"})
    };
    write(&market.join(".claude-plugin/marketplace.json"), json!({"name":"market","owner":{"name":"fixture"},"plugins":[{"name":"demo","source":catalogue_source,"description":"keep private catalogue metadata"}]}).to_string());
    write(
        &target.join("settings.json"),
        b"{\"enabledPlugins\":{\"demo@market\":false},\"env\":{\"TOKEN\":\"private\"}}\n",
    );
    super::super::plugins::import_plugins(&source, &target).unwrap();
    let code = if local {
        market.join("plugins/demo")
    } else {
        cache
    };
    (temporary, source, target, code)
}

fn add_root_plugin(source: &Path, name: &str, market: &str) -> PathBuf {
    let cache = source.join(format!("plugins/cache/{market}/{name}/1.0.0"));
    let code = source.join("plugins/marketplaces").join(market);
    for root in [&cache, &code] {
        write(
            &root.join(".claude-plugin/plugin.json"),
            json!({"name":name,"version":"1.0.0"}).to_string(),
        );
        write(&root.join("skills/hello/SKILL.md"), b"root plugin skill");
    }
    let mut installed = if source.join(INSTALLED).exists() {
        read(&source.join(INSTALLED))
    } else {
        empty_registry()
    };
    installed["plugins"][format!("{name}@{market}")] = json!([{
        "scope":"user","projectPath":null,"version":"1.0.0","installPath":cache
    }]);
    write(&source.join(INSTALLED), installed.to_string());
    let mut known = if source.join(KNOWN).exists() {
        read(&source.join(KNOWN))
    } else {
        json!({})
    };
    known[market] =
        json!({"source":{"source":"github","repo":"fixture/plugins"},"installLocation":code});
    write(&source.join(KNOWN), known.to_string());
    write(
        &code.join(".claude-plugin/marketplace.json"),
        json!({"name":market,"owner":{"name":"fixture"},"plugins":[{
            "name":name,"source":"./","description":"private marketplace metadata"
        }]})
        .to_string(),
    );
    code
}

fn root_fixture() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let source = root.join("official");
    let target = root.join("private");
    let code = add_root_plugin(&source, "demo", "market");
    write(
        &target.join("settings.json"),
        b"{\"enabledPlugins\":{\"demo@market\":false}}",
    );
    super::super::plugins::import_plugins(&source, &target).unwrap();
    (temporary, source, target, code)
}

fn install(target: &Path) -> PathBuf {
    PathBuf::from(
        read(&target.join(INSTALLED))["plugins"]["demo@market"][0]["installPath"]
            .as_str()
            .unwrap(),
    )
}

fn all_state(root: &Path) -> BTreeMap<PathBuf, (Vec<u8>, std::time::SystemTime)> {
    fn visit(
        root: &Path,
        path: &Path,
        output: &mut BTreeMap<PathBuf, (Vec<u8>, std::time::SystemTime)>,
    ) {
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
        output.insert(
            path.strip_prefix(root).unwrap().to_path_buf(),
            (bytes, metadata.modified().unwrap()),
        );
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            for child in fs::read_dir(path).unwrap() {
                visit(root, &child.unwrap().path(), output);
            }
        }
    }
    let mut output = BTreeMap::new();
    visit(root, root, &mut output);
    output
}

#[cfg(windows)]
#[test]
fn link_target_spelling_handles_verbatim_paths_without_resolving_missing_code() {
    for (native, verbatim) in [
        (r"C:\missing\plugin\skills", r"\\?\C:\missing\plugin\skills"),
        (
            r"\\server\share\missing\skills",
            r"\\?\UNC\server\share\missing\skills",
        ),
    ] {
        assert!(same_link_target(Path::new(native), Path::new(verbatim)));
        assert!(same_link_target(Path::new(verbatim), Path::new(native)));
    }
    for changed in [
        r"D:\missing\plugin\skills",
        r"C:\missing\other\skills",
        r"C:\missing\plugin\skills\child",
        r"missing\plugin\skills",
        r"\\other\share\missing\skills",
    ] {
        assert!(!same_link_target(
            Path::new(changed),
            Path::new(r"\\?\C:\missing\plugin\skills"),
        ));
    }
    assert!(!same_link_target(
        Path::new(r"\\server\other\missing\skills"),
        Path::new(r"\\?\UNC\server\share\missing\skills"),
    ));
}

#[test]
fn removing_code_links_preserves_targets_and_refuses_private_files() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    for (name, directory) in [("folder", true), ("file", false)] {
        let source = root.join(name);
        if directory {
            write(&source.join("code.md"), b"official code");
        } else {
            write(&source, b"official code");
        }
        let link = root.join(format!("{name}-link"));
        symlink_code(&source, &link).unwrap();
        remove_code_link(&link).unwrap();
        assert!(source.exists());
        assert!(fs::symlink_metadata(&link).is_err());
        symlink_code(&source, &link).unwrap();
        if directory {
            fs::remove_dir_all(&source).unwrap();
        } else {
            fs::remove_file(&source).unwrap();
        }
        remove_code_link(&link).unwrap();
        assert!(fs::symlink_metadata(&link).is_err());
    }
    let private = root.join("private.md");
    write(&private, b"private edit");
    assert!(remove_code_link(&private).is_err());
    assert_eq!(fs::read(&private).unwrap(), b"private edit");
}

#[test]
fn links_code_and_keeps_markers_settings_and_legacy_copies_private() {
    let (_temporary, source, target, code) = fixture(false);
    let old = install(&target);
    write(&code.join(".in_use"), b"official runtime marker");
    write(&old.join(".in_use"), b"existing private session marker");
    let before_source = all_state(&source);
    let before_settings = fs::read(target.join("settings.json")).unwrap();
    assert!(links_pending(&source, &target).unwrap());
    link_plugins(&source, &target).unwrap();
    let linked = install(&target);
    assert_ne!(linked, old);
    assert!(!fs::symlink_metadata(&linked)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(
        linked.join("skills").canonicalize().unwrap(),
        code.join("skills").canonicalize().unwrap()
    );
    assert_eq!(read(&linked.join(MARKER)), marker_value(&code));
    assert_eq!(
        read(&target.join(INSTALLED))["plugins"]["demo@market"][0]["version"],
        linked.file_name().unwrap().to_str().unwrap()
    );
    assert!(!linked.join(".git").exists());
    assert!(!linked.join(".in_use").exists());
    write(&linked.join(".in_use"), b"private runtime marker");
    assert_eq!(
        fs::read(code.join(".in_use")).unwrap(),
        b"official runtime marker"
    );
    assert_eq!(
        fs::read(old.join(".in_use")).unwrap(),
        b"existing private session marker"
    );
    assert_eq!(
        fs::read(old.join("skills/hello/SKILL.md")).unwrap(),
        b"original plugin skill"
    );
    assert_eq!(
        fs::read(target.join("settings.json")).unwrap(),
        before_settings
    );
    assert_eq!(all_state(&source), before_source);
    let unchanged = all_state(&target);
    assert!(!links_pending(&source, &target).unwrap());
    link_plugins(&source, &target).unwrap();
    assert_eq!(all_state(&target), unchanged);
}

#[test]
fn source_changes_and_new_top_level_children_follow_without_copying() {
    let (_temporary, source, target, code) = fixture(false);
    // Add a top-level file after the initial import, then refresh its link.
    link_plugins(&source, &target).unwrap();
    let linked = install(&target);
    write(&code.join("README.md"), b"official readme");
    link_plugins(&source, &target).unwrap();
    assert_eq!(
        fs::read(linked.join("README.md")).unwrap(),
        b"official readme"
    );
    write(
        &code.join("skills/hello/SKILL.md"),
        b"updated official skill",
    );
    assert_eq!(
        fs::read(linked.join("skills/hello/SKILL.md")).unwrap(),
        b"updated official skill"
    );
    write(&code.join("commands/new.md"), b"new official command");
    fs::remove_dir_all(code.join("hooks")).unwrap();
    fs::remove_file(code.join("README.md")).unwrap();
    let before_source = all_state(&source);
    assert!(links_pending(&source, &target).unwrap());
    link_plugins(&source, &target).unwrap();
    assert_eq!(
        fs::read(linked.join("commands/new.md")).unwrap(),
        b"new official command"
    );
    assert!(fs::symlink_metadata(linked.join("hooks")).is_err());
    assert!(fs::symlink_metadata(linked.join("README.md")).is_err());
    assert_eq!(all_state(&source), before_source);
    assert!(!links_pending(&source, &target).unwrap());
}

fn upgrade(source: &Path, version: &str) -> PathBuf {
    let new = source.join("plugins/cache/market/demo").join(version);
    write(
        &new.join(".claude-plugin/plugin.json"),
        json!({"name":"demo","version":version}).to_string(),
    );
    write(&new.join("skills/hello/SKILL.md"), version.as_bytes());
    let mut registry = read(&source.join(INSTALLED));
    registry["plugins"]["demo@market"][0]["installPath"] = json!(new);
    registry["plugins"]["demo@market"][0]["version"] = json!(version);
    write(&source.join(INSTALLED), registry.to_string());
    new
}

#[test]
fn version_updates_move_only_managed_pointers_and_retain_older_roots() {
    let (_temporary, source, target, _code) = fixture(false);
    let copy = install(&target);
    link_plugins(&source, &target).unwrap();
    let old = install(&target);
    let new_source = upgrade(&source, "1.1.0");
    assert!(links_pending(&source, &target).unwrap());
    link_plugins(&source, &target).unwrap();
    let new = install(&target);
    assert_ne!(new, old);
    assert_eq!(read(&new.join(MARKER)), marker_value(&new_source));
    assert_eq!(
        fs::read(new.join("skills/hello/SKILL.md")).unwrap(),
        b"1.1.0"
    );
    assert!(old.join("skills/hello/SKILL.md").exists());
    assert!(copy.join("skills/hello/SKILL.md").exists());
    assert_eq!(
        read(&target.join("settings.json"))["enabledPlugins"]["demo@market"],
        false
    );
}

#[test]
fn local_edits_and_uninstalls_are_terminal_and_not_resurrected() {
    let (_temporary, source, target, _code) = fixture(false);
    let copy = install(&target);
    write(&copy.join("skills/hello/SKILL.md"), b"private edit");
    link_plugins(&source, &target).unwrap();
    assert_eq!(
        read(&target.join(LEDGER))["plugins"]["demo@market"][0],
        json!({"scope":"user","projectPath":null,"local":true})
    );
    upgrade(&source, "1.1.0");
    assert!(!links_pending(&source, &target).unwrap());
    assert_eq!(install(&target), copy);
    assert_eq!(
        fs::read(copy.join("skills/hello/SKILL.md")).unwrap(),
        b"private edit"
    );

    let (_temporary, source, target, _code) = fixture(false);
    link_plugins(&source, &target).unwrap();
    write(&target.join(INSTALLED), empty_registry().to_string());
    link_plugins(&source, &target).unwrap();
    assert_eq!(
        read(&target.join(LEDGER))["plugins"]["demo@market"][0]["local"],
        true
    );
    upgrade(&source, "1.1.0");
    link_plugins(&source, &target).unwrap();
    assert_eq!(read(&target.join(INSTALLED)), empty_registry());
}

#[test]
fn registry_local_override_is_preserved_and_not_rejoined() {
    let (_temporary, source, target, _code) = fixture(false);
    link_plugins(&source, &target).unwrap();
    let mut registry = read(&target.join(INSTALLED));
    registry["plugins"]["demo@market"][0]["version"] = json!("local-version");
    let bytes = registry.to_string();
    write(&target.join(INSTALLED), &bytes);
    link_plugins(&source, &target).unwrap();
    assert_eq!(fs::read_to_string(target.join(INSTALLED)).unwrap(), bytes);
    assert_eq!(
        read(&target.join(LEDGER))["plugins"]["demo@market"][0]["local"],
        true
    );
}

#[test]
fn official_uninstall_and_missing_code_leave_private_state_untouched() {
    let (_temporary, source, target, code) = fixture(false);
    link_plugins(&source, &target).unwrap();
    let registry = fs::read(source.join(INSTALLED)).unwrap();
    write(&source.join(INSTALLED), empty_registry().to_string());
    let before = all_state(&target);
    link_plugins(&source, &target).unwrap();
    assert_eq!(all_state(&target), before);
    write(&source.join(INSTALLED), registry);
    fs::remove_dir_all(code).unwrap();
    link_plugins(&source, &target).unwrap();
    assert_eq!(all_state(&target), before);
    upgrade(&source, "1.1.0");
    link_plugins(&source, &target).unwrap();
    assert_eq!(
        fs::read(install(&target).join("skills/hello/SKILL.md")).unwrap(),
        b"1.1.0"
    );
}

#[test]
fn local_catalogue_sources_use_linked_code_and_preserve_catalogue_metadata() {
    let (_temporary, source, target, code) = fixture(true);
    let manifest = target.join("plugins/marketplaces/market/.claude-plugin/marketplace.json");
    let old = read(&manifest);
    link_plugins(&source, &target).unwrap();
    let linked = install(&target);
    assert_eq!(read(&linked.join(MARKER)), marker_value(&code));
    let mut expected = old;
    expected["plugins"][0]["source"] = json!(linked);
    assert_eq!(read(&manifest), expected);
    write(
        &code.join("skills/hello/SKILL.md"),
        b"local marketplace update",
    );
    assert_eq!(
        fs::read(linked.join("skills/hello/SKILL.md")).unwrap(),
        b"local marketplace update"
    );
}

#[test]
fn root_marketplace_links_code_without_sharing_management_or_runtime_state() {
    let (_temporary, source, target, code) = root_fixture();
    let old = install(&target);
    write(&old.join(".in_use"), b"existing session marker");
    write(&code.join(".in_use"), b"official session marker");
    write(
        &source.join("plugins/data/demo@market/state.json"),
        b"official state",
    );
    write(
        &target.join("plugins/data/demo@market/state.json"),
        b"private state",
    );
    let source_before = all_state(&source);
    let old_before = all_state(&old);
    let settings_before = fs::read(target.join("settings.json")).unwrap();
    let manifest = target.join("plugins/marketplaces/market/.claude-plugin/marketplace.json");
    let mut expected_manifest = read(&manifest);
    assert!(links_pending(&source, &target).unwrap());
    link_plugins(&source, &target).unwrap();
    let linked = install(&target);
    assert_ne!(linked, old);
    assert!(linked
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("1.0.0.ccem-layout-v2.ccem-linked-"));
    assert!(fs::symlink_metadata(linked.join(".claude-plugin"))
        .unwrap()
        .is_dir());
    assert!(!fs::symlink_metadata(linked.join(".claude-plugin"))
        .unwrap()
        .file_type()
        .is_symlink());
    assert!(
        fs::symlink_metadata(linked.join(".claude-plugin/plugin.json"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert!(!linked.join(".claude-plugin/marketplace.json").exists());
    assert!(!linked.join(".in_use").exists());
    write(&linked.join(".in_use"), b"new private session marker");
    expected_manifest["plugins"][0]["source"] = json!(linked);
    assert_eq!(read(&manifest), expected_manifest);
    assert_eq!(all_state(&source), source_before);
    assert_eq!(all_state(&old), old_before);
    assert_eq!(
        fs::read(target.join("settings.json")).unwrap(),
        settings_before
    );
    assert_eq!(
        fs::read(target.join("plugins/data/demo@market/state.json")).unwrap(),
        b"private state"
    );
    assert!(!links_pending(&source, &target).unwrap());
    write(&code.join("skills/hello/SKILL.md"), b"updated root skill");
    assert_eq!(
        fs::read(linked.join("skills/hello/SKILL.md")).unwrap(),
        b"updated root skill"
    );
}

#[test]
fn newly_installed_root_marketplace_is_imported_incrementally_and_stays_disabled() {
    let (_temporary, source, target, _code) = root_fixture();
    link_plugins(&source, &target).unwrap();
    let first = install(&target);
    let first_before = all_state(&first);
    let extra = add_root_plugin(&source, "extra", "second");
    let settings = json!({"enabledPlugins":{"demo@market":false,"extra@second":false}});
    write(&target.join("settings.json"), settings.to_string());
    let source_before = all_state(&source);
    super::super::plugins::import_plugins(&source, &target).unwrap();
    link_plugins(&source, &target).unwrap();
    let installed = read(&target.join(INSTALLED));
    let linked = PathBuf::from(
        installed["plugins"]["extra@second"][0]["installPath"]
            .as_str()
            .unwrap(),
    );
    assert!(same_link_target(
        &fs::read_link(linked.join("skills")).unwrap(),
        &extra.join("skills")
    ));
    assert!(!linked.join(".claude-plugin/marketplace.json").exists());
    assert_eq!(read(&target.join("settings.json")), settings);
    assert_eq!(all_state(&source), source_before);
    assert_eq!(all_state(&first), first_before);
    assert!(!links_pending(&source, &target).unwrap());
}

#[test]
fn legacy_wrapper_layout_is_upgraded_without_changing_its_existing_session_files() {
    for ledger_exists in [false, true] {
        let (_temporary, source, target, code) = fixture(false);
        let suffix = hex::encode(Sha256::digest(code.to_str().unwrap().as_bytes()));
        let version = format!("1.0.0.ccem-linked-{}", &suffix[..8]);
        let old = target.join("plugins/cache/market/demo").join(&version);
        write(&old.join(MARKER), marker_value(&code).to_string());
        for name in tree_names(&code, true).unwrap() {
            symlink_code(&code.join(&name), &old.join(name)).unwrap();
        }
        write(&old.join(".in_use"), b"running old session");
        let mut registry = read(&target.join(INSTALLED));
        registry["plugins"]["demo@market"][0]["installPath"] = json!(old);
        registry["plugins"]["demo@market"][0]["version"] = json!(version);
        write(&target.join(INSTALLED), registry.to_string());
        if ledger_exists {
            write(&target.join(LEDGER), json!({"version":1,"plugins":{"demo@market":[{
                "scope":"user","projectPath":null,"sourcePath":code,"installPath":old,"version":version
            }]}}).to_string());
        }
        let before = all_state(&old);
        assert!(links_pending(&source, &target).unwrap());
        link_plugins(&source, &target).unwrap();
        let linked = install(&target);
        assert_ne!(linked, old);
        assert!(fs::symlink_metadata(linked.join(".claude-plugin"))
            .unwrap()
            .is_dir());
        assert_eq!(all_state(&old), before);
        assert!(!links_pending(&source, &target).unwrap());
    }
}

#[test]
fn metadata_child_links_refresh_and_local_metadata_changes_are_preserved() {
    for local_catalogue in [false, true] {
        let (_temporary, source, target, code) = root_fixture();
        link_plugins(&source, &target).unwrap();
        let linked = install(&target);
        write(
            &code.join(".claude-plugin/config.json"),
            b"official extra manifest",
        );
        link_plugins(&source, &target).unwrap();
        assert!(same_link_target(
            &fs::read_link(linked.join(".claude-plugin/config.json")).unwrap(),
            &code.join(".claude-plugin/config.json")
        ));
        fs::remove_file(code.join(".claude-plugin/config.json")).unwrap();
        link_plugins(&source, &target).unwrap();
        assert!(fs::symlink_metadata(linked.join(".claude-plugin/config.json")).is_err());
        let edited = if local_catalogue {
            linked.join(".claude-plugin/marketplace.json")
        } else {
            let path = linked.join(".claude-plugin/plugin.json");
            remove_code_link(&path).unwrap();
            path
        };
        write(&edited, b"private management edit");
        let before = all_state(&linked);
        upgrade(&source, "1.1.0");
        link_plugins(&source, &target).unwrap();
        assert_eq!(install(&target), linked);
        assert_eq!(all_state(&linked), before);
        assert_eq!(
            read(&target.join(LEDGER))["plugins"]["demo@market"][0]["local"],
            true
        );
    }
}

#[cfg(unix)]
#[test]
fn root_catalogue_omission_does_not_allow_other_aliases_or_runtime_markers() {
    for kind in [
        "alias",
        "nested-metadata",
        "metadata-marker",
        "replaced-private-dir",
    ] {
        let (_temporary, source, target, code) = root_fixture();
        let catalogue = code.join(".claude-plugin/marketplace.json");
        match kind {
            "alias" => symlink_code(&catalogue, &code.join(".claude-plugin/alias.json")).unwrap(),
            "nested-metadata" => {
                fs::create_dir_all(code.join("nested")).unwrap();
                symlink_code(
                    &code.join(".claude-plugin"),
                    &code.join("nested/.claude-plugin"),
                )
                .unwrap();
            }
            "metadata-marker" => write(&code.join(".claude-plugin/.in_use"), b"official marker"),
            _ => {
                link_plugins(&source, &target).unwrap();
                let linked = install(&target);
                fs::remove_dir_all(linked.join(".claude-plugin")).unwrap();
                symlink_code(&code.join(".claude-plugin"), &linked.join(".claude-plugin")).unwrap();
                let before = all_state(&linked);
                upgrade(&source, "1.1.0");
                link_plugins(&source, &target).unwrap();
                assert_eq!(all_state(&linked), before);
                assert_eq!(install(&target), linked);
                assert_eq!(
                    read(&target.join(LEDGER))["plugins"]["demo@market"][0]["local"],
                    true
                );
                continue;
            }
        }
        let before = all_state(&target);
        assert!(link_plugins(&source, &target).is_err());
        assert_eq!(all_state(&target), before);
    }
}

#[test]
fn recovers_catalogue_and_registry_publications_without_a_ledger() {
    for registry_already_moved in [false, true] {
        let (_temporary, source, target, _code) = fixture(true);
        let old_registry = fs::read(target.join(INSTALLED)).unwrap();
        link_plugins(&source, &target).unwrap();
        let alias = install(&target);
        fs::remove_file(target.join(LEDGER)).unwrap();
        if !registry_already_moved {
            write(&target.join(INSTALLED), old_registry);
        }
        assert!(links_pending(&source, &target).unwrap());
        link_plugins(&source, &target).unwrap();
        assert_eq!(install(&target), alias);
        assert_eq!(
            read(&target.join(LEDGER))["plugins"]["demo@market"][0]["installPath"],
            json!(alias)
        );
        assert!(!links_pending(&source, &target).unwrap());
    }
}

#[test]
fn concurrent_metadata_changes_prevent_publication() {
    let (_temporary, source, target, _code) = fixture(false);
    let registry = target.join(INSTALLED);
    let copy = install(&target);
    let mut changed = read(&registry);
    changed["plugins"]["demo@market"][0]["version"] = json!("private concurrent update");
    let error = link_with_check(&source, &target, || {
        write(&registry, changed.to_string());
        Ok(())
    })
    .unwrap_err();
    assert!(error.contains("metadata changed"));
    assert!(!target.join(LEDGER).exists());
    assert_eq!(read(&registry), changed);
    assert_eq!(install(&target), copy);
    assert!(!target.join(BACKUP).exists());
}

#[test]
fn malformed_ledgers_and_unimported_identities_are_not_managed() {
    let (_temporary, source, target, _code) = fixture(false);
    for ledger in [
        json!({"version":1,"plugins":{"demo@market":[{"scope":"user","local":true}]}}),
        json!({"version":1,"plugins":{"demo@market":[{"scope":"user","projectPath":null,"local":false}]}}),
        json!({"version":1,"plugins":{"demo@market":[]}}),
        json!({"version":1,"plugins":{"demo@market":[{"scope":"user","projectPath":null,"local":true,"extra":1}]}}),
    ] {
        write(&target.join(LEDGER), ledger.to_string());
        let before = all_state(&target);
        assert!(link_plugins(&source, &target).is_err());
        assert_eq!(all_state(&target), before);
    }
    fs::remove_file(target.join(LEDGER)).unwrap();
    fs::remove_file(target.join(IMPORTS)).unwrap();
    let before = all_state(&target);
    assert!(!links_pending(&source, &target).unwrap());
    link_plugins(&source, &target).unwrap();
    assert_eq!(all_state(&target), before);
}

#[cfg(unix)]
#[test]
fn source_escape_private_data_cycles_and_destination_links_are_rejected() {
    for kind in ["outside", "private", "cycle", "registry", "marker"] {
        let (_temporary, source, target, code) = fixture(false);
        let destination = match kind {
            "outside" => source.join("credentials"),
            "private" => source.join("plugins/data/demo/secrets"),
            "registry" => source.join(INSTALLED),
            "marker" => source.join("plugins/cache/market/other/1.0/.in_use"),
            _ => code.clone(),
        };
        if kind != "cycle" && kind != "registry" {
            write(&destination, b"must not be shared");
        }
        std::os::unix::fs::symlink(&destination, code.join("unsafe")).unwrap();
        let before = all_state(&target);
        assert!(link_plugins(&source, &target).is_err());
        assert_eq!(all_state(&target), before);
        assert!(!target.join(LEDGER).exists());
    }
    let (_temporary, source, target, _code) = fixture(false);
    let copy = install(&target);
    fs::remove_dir_all(copy.join("skills")).unwrap();
    std::os::unix::fs::symlink(
        source.join("plugins/cache/market/demo/1.0.0/skills"),
        copy.join("skills"),
    )
    .unwrap();
    link_plugins(&source, &target).unwrap();
    assert_eq!(
        read(&target.join(LEDGER))["plugins"]["demo@market"][0]["local"],
        true
    );
    assert_eq!(install(&target), copy);
}

#[test]
fn recovers_managed_version_update_after_partial_publication() {
    for registry_already_moved in [false, true] {
        let (_temporary, source, target, _code) = fixture(true);
        link_plugins(&source, &target).unwrap();
        let old_registry = fs::read(target.join(INSTALLED)).unwrap();
        let old_ledger = fs::read(target.join(LEDGER)).unwrap();
        upgrade(&source, "1.1.0");
        link_plugins(&source, &target).unwrap();
        let alias = install(&target);
        write(&target.join(LEDGER), old_ledger);
        if !registry_already_moved {
            write(&target.join(INSTALLED), old_registry);
        }
        link_plugins(&source, &target).unwrap();
        assert_eq!(install(&target), alias);
        assert_eq!(
            read(&target.join(LEDGER))["plugins"]["demo@market"][0]["installPath"],
            json!(alias)
        );
        assert!(!links_pending(&source, &target).unwrap());
    }
}

#[test]
fn interrupted_owned_version_can_recover_after_official_version_advances_again() {
    for registry_already_moved in [false, true] {
        let (_temporary, source, target, _code) = fixture(true);
        link_plugins(&source, &target).unwrap();
        let old_registry = fs::read(target.join(INSTALLED)).unwrap();
        let old_ledger = fs::read(target.join(LEDGER)).unwrap();
        upgrade(&source, "1.1.0");
        link_plugins(&source, &target).unwrap();
        write(&target.join(LEDGER), old_ledger);
        if !registry_already_moved {
            write(&target.join(INSTALLED), old_registry);
        }
        upgrade(&source, "1.2.0");
        link_plugins(&source, &target).unwrap();
        assert!(install(&target)
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("1.2.0.ccem-layout-v2.ccem-linked-"));
        assert!(read(&target.join(LEDGER))["plugins"]["demo@market"][0]
            .get("local")
            .is_none());
        assert!(!links_pending(&source, &target).unwrap());
    }
}

#[cfg(unix)]
#[test]
fn refuses_registered_catalogue_links_but_allows_static_marketplace_named_assets() {
    let (_temporary, source, target, code) = fixture(false);
    let metadata = source.join("plugins/marketplaces/market/.claude-plugin/marketplace.json");
    std::os::unix::fs::symlink(&metadata, code.join("catalogue-copy.json")).unwrap();
    let before = all_state(&target);
    assert!(link_plugins(&source, &target)
        .unwrap_err()
        .contains("catalogue metadata"));
    assert_eq!(all_state(&target), before);
    fs::remove_file(code.join("catalogue-copy.json")).unwrap();
    write(
        &code.join("static/marketplace.json"),
        b"ordinary plugin code asset",
    );
    write(
        &install(&target).join("static/marketplace.json"),
        b"ordinary plugin code asset",
    );
    link_plugins(&source, &target).unwrap();
    assert_eq!(
        fs::read(install(&target).join("static/marketplace.json")).unwrap(),
        b"ordinary plugin code asset"
    );
}

#[test]
fn same_version_source_path_changes_follow_and_unimported_scope_stays_local() {
    let (_temporary, source, target, code) = fixture(false);
    let project = target.join("unimported-project");
    let project_copy = target.join("plugins/cache/market/demo/project-local");
    write(&project_copy.join("private.txt"), b"local project plugin");
    let mut target_registry = read(&target.join(INSTALLED));
    target_registry["plugins"]["demo@market"].as_array_mut().unwrap().push(json!({"scope":"project","projectPath":project,"installPath":project_copy,"version":"private"}));
    write(&target.join(INSTALLED), target_registry.to_string());
    link_plugins(&source, &target).unwrap();
    let old = install(&target);
    let new_source = source.join("plugins/cache/market/demo/relocated-1.0.0");
    fs::rename(code, &new_source).unwrap();
    let mut source_registry = read(&source.join(INSTALLED));
    source_registry["plugins"]["demo@market"][0]["installPath"] = json!(new_source);
    write(&source.join(INSTALLED), source_registry.to_string());
    link_plugins(&source, &target).unwrap();
    assert_ne!(install(&target), old);
    assert!(old.is_dir());
    assert_eq!(
        read(&target.join(INSTALLED))["plugins"]["demo@market"][1],
        target_registry["plugins"]["demo@market"][1]
    );
    assert_eq!(
        read(&target.join(LEDGER))["plugins"]["demo@market"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn replaced_managed_children_are_not_overwritten_even_on_version_update() {
    let (_temporary, source, target, code) = fixture(false);
    link_plugins(&source, &target).unwrap();
    let linked = install(&target);
    #[cfg(windows)]
    fs::remove_dir(linked.join("skills")).unwrap();
    #[cfg(not(windows))]
    fs::remove_file(linked.join("skills")).unwrap();
    assert!(code.join("skills/hello/SKILL.md").exists());
    write(&linked.join("skills/private.md"), b"private edit");
    upgrade(&source, "1.1.0");
    let before = fs::read(target.join(INSTALLED)).unwrap();
    link_plugins(&source, &target).unwrap();
    assert_eq!(fs::read(target.join(INSTALLED)).unwrap(), before);
    assert_eq!(
        fs::read(linked.join("skills/private.md")).unwrap(),
        b"private edit"
    );
    assert_eq!(
        read(&target.join(LEDGER))["plugins"]["demo@market"][0]["local"],
        true
    );
    assert!(!links_pending(&source, &target).unwrap());
    assert_eq!(install(&target), linked);
}

#[test]
fn published_registry_recovers_before_an_official_uninstall() {
    let (_temporary, source, target, _code) = fixture(false);
    link_plugins(&source, &target).unwrap();
    let old_ledger = fs::read(target.join(LEDGER)).unwrap();
    upgrade(&source, "1.1.0");
    link_plugins(&source, &target).unwrap();
    let new_ledger = fs::read(target.join(LEDGER)).unwrap();
    write(&target.join(LEDGER), old_ledger);
    let source_registry = fs::read(source.join(INSTALLED)).unwrap();
    write(&source.join(INSTALLED), empty_registry().to_string());
    link_plugins(&source, &target).unwrap();
    assert_eq!(fs::read(target.join(LEDGER)).unwrap(), new_ledger);
    write(&source.join(INSTALLED), source_registry);
    upgrade(&source, "1.2.0");
    link_plugins(&source, &target).unwrap();
    assert!(install(&target)
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("1.2.0.ccem-layout-v2.ccem-linked-"));
}

#[test]
fn missing_target_registry_creates_only_a_tombstone() {
    let (_temporary, source, target, _code) = fixture(false);
    fs::remove_file(target.join(INSTALLED)).unwrap();
    link_plugins(&source, &target).unwrap();
    assert!(!target.join(INSTALLED).exists());
    assert_eq!(
        read(&target.join(LEDGER))["plugins"]["demo@market"][0]["local"],
        true
    );
}
