use super::*;
use base64::Engine;
use sha2::{Digest, Sha256, Sha512};

fn available(path: &str, version: &str) -> RuntimeCandidate {
    RuntimeCandidate {
        state: "available".into(),
        path: Some(path.into()),
        version: Some(version.into()),
        detail: None,
    }
}

#[test]
fn claude_runtime_selection_is_system_first_and_explicit_sources_never_fall_back() {
    let system = available("/system/claude", "2.1.221");
    let managed = available("/managed/claude", "2.1.220");
    assert_eq!(
        select_runtime(ClaudeRuntimeSource::Auto, &system, &managed)
            .unwrap()
            .source,
        ClaudeRuntimeSource::System
    );
    assert_eq!(
        select_runtime(
            ClaudeRuntimeSource::Auto,
            &RuntimeCandidate::missing(),
            &managed
        )
        .unwrap()
        .source,
        ClaudeRuntimeSource::Managed
    );
    assert!(select_runtime(
        ClaudeRuntimeSource::System,
        &RuntimeCandidate::missing(),
        &managed
    )
    .is_none());
    assert!(select_runtime(
        ClaudeRuntimeSource::Managed,
        &system,
        &RuntimeCandidate::missing()
    )
    .is_none());
    let incompatible = RuntimeCandidate {
        state: "incompatible".into(),
        ..system.clone()
    };
    assert_eq!(
        select_runtime(ClaudeRuntimeSource::Auto, &incompatible, &managed)
            .unwrap()
            .source,
        ClaudeRuntimeSource::Managed
    );
}

#[test]
fn claude_runtime_status_does_not_create_directories_or_change_preference() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("not-created");
    let manager = ClaudeRuntimeManager::new(root.clone());
    // Seed only the read-only discovery cache to keep this test independent of
    // the developer's installed binaries and PATH.
    *manager.system_cache.lock().unwrap() = Some(ProbeCache {
        candidate: RuntimeCandidate::missing(),
        identity: None,
        at: Instant::now(),
    });
    let status = manager.status(false);
    assert_eq!(status.preference, ClaudeRuntimeSource::Auto);
    assert!(status.selected.is_none());
    assert!(!root.exists());
    assert!(manager
        .resolve_for_launch()
        .unwrap_err()
        .starts_with("CLAUDE_RUNTIME_REQUIRED: "));
    assert!(!root.exists());
}

#[test]
fn claude_runtime_explicit_preference_persists_and_invalid_json_does_not_select_a_runtime() {
    let temp = tempfile::tempdir().unwrap();
    let manager = ClaudeRuntimeManager::new(temp.path().join("runtime"));
    *manager.system_cache.lock().unwrap() = Some(ProbeCache {
        candidate: RuntimeCandidate::missing(),
        identity: None,
        at: Instant::now(),
    });
    assert_eq!(
        manager
            .set_preference(ClaudeRuntimeSource::Managed)
            .unwrap()
            .preference,
        ClaudeRuntimeSource::Managed
    );
    assert_eq!(
        manager.read_preference().unwrap(),
        ClaudeRuntimeSource::Managed
    );
    fs::write(manager.preference_path(), b"not-json").unwrap();
    assert!(manager.read_preference().is_err());
    assert!(manager.status(false).selected.is_none());
}

#[cfg(unix)]
fn script(directory: &Path, name: &str, content: &str) -> String {
    use std::os::unix::fs::PermissionsExt;
    let path = directory.join(name);
    fs::write(&path, content).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    path.to_string_lossy().into_owned()
}

#[test]
#[cfg(unix)]
fn claude_runtime_probes_versions_capabilities_and_pinned_path_without_reselection() {
    let temp = tempfile::tempdir().unwrap();
    let good = script(temp.path(), "good", "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.220 (Claude Code)'; else echo '--input-format --output-format --permission-mode --resume'; fi\n");
    let old = script(
        temp.path(),
        "old",
        "#!/bin/sh\necho '2.1.100 (Claude Code)'\n",
    );
    let incomplete = script(
        temp.path(),
        "incomplete",
        "#!/bin/sh\necho '2.1.220 (Claude Code)'\n",
    );
    assert_eq!(probe_candidate(&good, "2.1.220").state, "available");
    assert_eq!(probe_candidate(&old, "2.1.220").state, "incompatible");
    assert_eq!(
        probe_candidate(&incomplete, "2.1.220").state,
        "incompatible"
    );
    let manager = ClaudeRuntimeManager::new(temp.path().join("runtime"));
    assert!(manager.validate_pinned_path(&good).is_ok());
    fs::remove_file(&good).unwrap();
    assert!(manager.validate_pinned_path(&good).is_err());
}

#[test]
#[cfg(unix)]
fn claude_runtime_probe_has_a_deadline_even_for_an_exited_wrapper_holding_pipes() {
    let temp = tempfile::tempdir().unwrap();
    let slow = script(temp.path(), "slow", "#!/bin/sh\nsleep 2\n");
    // Warm the login-shell PATH probe cache so its latency stays out of the
    // deadline budget asserted below.
    let _ = crate::terminal::get_user_path();
    let started = Instant::now();
    assert!(
        bounded_output(&slow, "--version", Duration::from_millis(50))
            .unwrap_err()
            .contains("timed out")
    );
    assert!(started.elapsed() < Duration::from_secs(1));
    let wrapper = script(temp.path(), "wrapper", "#!/bin/sh\nsleep 2 &\nexit 0\n");
    let started = Instant::now();
    assert!(bounded_output(&wrapper, "--version", Duration::from_millis(50)).is_err());
    assert!(started.elapsed() < Duration::from_secs(1));
}

fn fixture_package(binary: &[u8]) -> RuntimePackage {
    RuntimePackage {
        platform: "fixture".into(),
        url: "https://registry.npmjs.org/fixture".into(),
        integrity: String::new(),
        binary_path: "package/claude".into(),
        binary_sha256: hex::encode(Sha256::digest(binary)),
        binary_bytes: binary.len() as u64,
        archive_bytes: 0,
        minimum_os_version: None,
    }
}

fn archive_fixture(path: &Path, members: &[(&str, &[u8])]) -> Vec<u8> {
    let output = Vec::new();
    let compression = flate2::write::GzEncoder::new(output, flate2::Compression::default());
    let mut archive = tar::Builder::new(compression);
    for (name, data) in members {
        let mut header = tar::Header::new_gnu();
        header.set_size(data.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        archive.append_data(&mut header, name, *data).unwrap();
    }
    let bytes = archive.into_inner().unwrap().finish().unwrap();
    fs::write(path, &bytes).unwrap();
    bytes
}

#[test]
fn claude_runtime_archive_verification_rejects_partial_corrupt_and_cancelled_downloads() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("package.tgz");
    let original = b"pinned archive fixture";
    fs::write(&path, original).unwrap();
    let mut package = fixture_package(b"binary");
    package.archive_bytes = original.len() as u64;
    package.integrity = format!(
        "sha512-{}",
        base64::engine::general_purpose::STANDARD.encode(Sha512::digest(original))
    );
    assert!(package::verify_archive(&path, &package, || Ok(())).is_ok());
    assert!(package::verify_archive(&path, &package, || Err("cancelled".into())).is_err());
    fs::write(&path, b"partial").unwrap();
    assert!(package::verify_archive(&path, &package, || Ok(()))
        .unwrap_err()
        .contains("incomplete"));
    fs::write(&path, vec![b'x'; original.len()]).unwrap();
    assert!(package::verify_archive(&path, &package, || Ok(()))
        .unwrap_err()
        .contains("checksum"));
}

#[test]
fn claude_runtime_extraction_preserves_license_and_rejects_unexpected_or_duplicate_members() {
    let temp = tempfile::tempdir().unwrap();
    let archive = temp.path().join("package.tgz");
    let output = temp.path().join("output");
    fs::create_dir(&output).unwrap();
    let binary = b"verified native binary fixture";
    let package = fixture_package(binary);
    let members: Vec<(&str, &[u8])> = vec![
        ("package/claude", binary),
        ("package/LICENSE.md", b"license"),
        ("package/README.md", b"readme"),
        ("package/package.json", b"{}"),
    ];
    archive_fixture(&archive, &members);
    package::extract_archive(&archive, &output, &package, || Ok(())).unwrap();
    package::verify_binary(&output.join("claude"), &package).unwrap();
    assert_eq!(fs::read(output.join("LICENSE.md")).unwrap(), b"license");
    assert!(!output.join("package.json").exists());
    for addition in ["package/extra", "package/claude"] {
        let next = temp.path().join(addition.replace('/', "-"));
        fs::create_dir(&next).unwrap();
        let mut bad = members.clone();
        bad.push((addition, b"untrusted"));
        archive_fixture(&archive, &bad);
        assert!(package::extract_archive(&archive, &next, &package, || Ok(())).is_err());
    }
}

#[test]
fn claude_runtime_corrupt_managed_binary_is_not_an_available_candidate() {
    let temp = tempfile::tempdir().unwrap();
    let package = fixture_package(b"trusted");
    let manager = ClaudeRuntimeManager::new(temp.path().join("runtime"));
    let directory = manager.managed_dir(&package);
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("claude"), b"changed").unwrap();
    let candidate = manager.managed_candidate(&package, true, true);
    assert_eq!(candidate.state, "error");
    assert!(candidate.resolved(ClaudeRuntimeSource::Managed).is_none());
}

#[test]
fn claude_runtime_repair_activation_keeps_previous_generation_and_rejects_pointer_escape() {
    let temp = tempfile::tempdir().unwrap();
    let package = fixture_package(b"trusted");
    let manager = ClaudeRuntimeManager::new(temp.path().join("runtime"));
    let old = manager.managed_dir(&package);
    let repaired = old.with_file_name(format!(
        "{}-fixture-0123456789abcdef",
        manifest().claude_version
    ));
    fs::create_dir_all(&old).unwrap();
    fs::create_dir(&repaired).unwrap();
    fs::write(old.join("claude"), b"damaged").unwrap();
    fs::write(repaired.join("claude"), b"trusted").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(repaired.join("claude"), fs::Permissions::from_mode(0o500)).unwrap();
    }
    assert_eq!(
        manager.managed_candidate(&package, true, true).state,
        "error"
    );
    manager.activate_managed_dir(&repaired, &package).unwrap();
    let candidate = manager.managed_candidate(&package, false, true);
    assert_eq!(candidate.state, "available");
    assert_eq!(candidate.path.as_deref(), repaired.join("claude").to_str());
    assert_eq!(
        fs::read(old.join("claude")).unwrap(),
        b"damaged",
        "repair must not remove or rewrite the old pinned binary"
    );
    let escaped = serde_json::json!({ "version": manifest().claude_version, "platform": "fixture", "directory": "../../other" });
    fs::write(
        manager.root.join("active.json"),
        serde_json::to_vec(&escaped).unwrap(),
    )
    .unwrap();
    assert!(manager.active_managed_dir(&package).is_err());
}

#[test]
fn claude_runtime_install_claim_is_single_owner_and_cancellation_survives_worker_start() {
    if current_package().is_err() {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("runtime");
    let manager = Arc::new(ClaudeRuntimeManager::new(root.clone()));
    *manager.system_cache.lock().unwrap() = Some(ProbeCache {
        candidate: RuntimeCandidate::missing(),
        identity: None,
        at: Instant::now(),
    });
    let prepared = manager.prepare_install().unwrap();
    assert!(manager.prepare_install().is_err());
    manager.cancel_install();
    assert!(prepared.run().unwrap_err().contains("cancelled"));
    assert!(
        !root.exists(),
        "cancellation before worker start must not write files"
    );
    assert_eq!(manager.status(false).install.state, "cancelled");
    assert!(
        manager.prepare_install().is_ok(),
        "settled install releases single-owner guard"
    );
}

#[test]
#[cfg(unix)]
fn claude_runtime_preference_and_managed_binary_reject_symlinks() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let actual = temp.path().join("actual");
    fs::create_dir(&actual).unwrap();
    let root = temp.path().join("linked");
    symlink(&actual, &root).unwrap();
    let manager = ClaudeRuntimeManager::new(root);
    assert!(manager.read_preference().is_err());
    assert!(manager
        .set_preference(ClaudeRuntimeSource::Managed)
        .is_err());
    let binary = temp.path().join("binary");
    fs::write(&binary, b"trusted").unwrap();
    let link = temp.path().join("claude");
    symlink(&binary, &link).unwrap();
    assert!(package::verify_binary(&link, &fixture_package(b"trusted")).is_err());
}

fn manager_without_system_probe(root: PathBuf) -> Arc<ClaudeRuntimeManager> {
    let manager = Arc::new(ClaudeRuntimeManager::new(root));
    *manager.system_cache.lock().unwrap() = Some(ProbeCache {
        candidate: RuntimeCandidate::missing(),
        identity: None,
        at: Instant::now(),
    });
    manager
}

#[test]
fn claude_runtime_registry_normalizes_https_bases_and_rejects_unsafe_configuration() {
    assert_eq!(
        registry::normalize(" https://REGISTRY.NPMJS.ORG ").unwrap(),
        registry::DEFAULT_REGISTRY
    );
    assert_eq!(
        registry::normalize("https://example.test:8443/repository/npm").unwrap(),
        "https://example.test:8443/repository/npm/"
    );
    assert_eq!(
        registry::normalize("https://example.test/npm%20proxy/").unwrap(),
        "https://example.test/npm%20proxy/"
    );
    for invalid in [
        "",
        "registry.npmjs.org",
        "http://registry.npmjs.org/",
        "file:///registry/",
        "https://user:secret@example.test/",
        "https://user@example.test/",
        "https://example.test/?token=secret",
        "https://example.test/#fragment",
        "https://example.test/?",
        "https://example.test/#",
        "https://example.test/a\nb",
    ] {
        assert!(
            registry::normalize(invalid).is_err(),
            "must reject {invalid}"
        );
    }
    assert!(registry::normalize(&format!("https://example.test/{}", "a".repeat(2048))).is_err());
}

#[test]
fn claude_runtime_registry_download_keeps_manifest_identity_and_custom_path_prefix() {
    for package in &manifest().packages {
        assert_eq!(
            registry::download_url(registry::DEFAULT_REGISTRY, package)
                .unwrap()
                .as_str(),
            package.url
        );
        let mirrored =
            registry::download_url("https://mirror.example/repository/npm", package).unwrap();
        let official = reqwest::Url::parse(&package.url).unwrap();
        assert_eq!(mirrored.host_str(), Some("mirror.example"));
        assert_eq!(
            mirrored.path(),
            format!("/repository/npm{}", official.path())
        );
        assert!(mirrored.query().is_none());
        assert!(mirrored.fragment().is_none());
    }
    let mut changed = manifest().packages[0].clone();
    changed.url =
        "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-darwin-arm64/-/latest.tgz"
            .into();
    assert!(registry::download_url(registry::DEFAULT_REGISTRY, &changed).is_err());
}

#[test]
fn claude_runtime_registry_default_status_is_read_only_and_persistence_is_independent() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("runtime");
    let manager = manager_without_system_probe(root.clone());
    let status = manager.status(false);
    assert_eq!(status.registry_url, registry::DEFAULT_REGISTRY);
    assert!(status.registry_error.is_none());
    assert!(!root.exists());

    let status = manager.set_registry("https://mirror.example/npm").unwrap();
    assert_eq!(status.registry_url, "https://mirror.example/npm/");
    assert_eq!(status.preference, ClaudeRuntimeSource::Auto);
    assert!(
        !manager.preference_path().exists(),
        "registry must not rewrite runtime source selection"
    );
    manager
        .set_preference(ClaudeRuntimeSource::Managed)
        .unwrap();
    let reloaded = manager_without_system_probe(root);
    assert_eq!(
        reloaded.read_registry().unwrap(),
        "https://mirror.example/npm/"
    );
    assert_eq!(
        reloaded.read_preference().unwrap(),
        ClaudeRuntimeSource::Managed
    );
    reloaded.set_registry(registry::DEFAULT_REGISTRY).unwrap();
    assert_eq!(
        reloaded.read_preference().unwrap(),
        ClaudeRuntimeSource::Managed
    );
}

#[test]
fn claude_runtime_registry_bad_disk_configuration_never_falls_back_or_starts_installation() {
    let temp = tempfile::tempdir().unwrap();
    let manager = manager_without_system_probe(temp.path().join("runtime"));
    fs::create_dir_all(&manager.root).unwrap();
    for invalid in [
        b"broken-json".to_vec(),
        br#""http://mirror.example/""#.to_vec(),
        vec![b'x'; 4097],
    ] {
        fs::write(manager.registry_path(), invalid).unwrap();
        let status = manager.status(false);
        assert_eq!(status.registry_url, "");
        assert!(status.registry_error.is_some());
        assert!(manager.read_registry().is_err());
        assert!(manager.prepare_install().is_err());
        assert!(!manager.busy.load(Ordering::Acquire));
        assert!(!manager.root.join("versions").exists());
        assert!(!manager.root.join("install.lock").exists());
    }
}

#[test]
fn claude_runtime_registry_is_snapshotted_at_install_claim_and_cannot_change_while_busy() {
    if current_package().is_err() {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let manager = manager_without_system_probe(temp.path().join("runtime"));
    manager.set_registry("https://first.example/npm").unwrap();
    let prepared = manager.prepare_install().unwrap();
    assert_eq!(prepared.registry_url, "https://first.example/npm/");
    assert!(manager.set_registry("https://second.example/npm/").is_err());
    assert_eq!(manager.read_registry().unwrap(), prepared.registry_url);

    // Simulate another CCEM process changing its settings after this worker was
    // claimed. The request must still use the first registry's captured URL.
    fs::write(manager.registry_path(), br#""https://second.example/npm/""#).unwrap();
    assert_eq!(
        manager.read_registry().unwrap(),
        "https://second.example/npm/"
    );
    assert_eq!(
        registry::download_url(&prepared.registry_url, current_package().unwrap())
            .unwrap()
            .host_str(),
        Some("first.example")
    );
    manager.cancel_install();
    assert!(prepared.run().unwrap_err().contains("cancelled"));
    assert!(!manager.root.join("versions").exists());
    let next = manager.prepare_install().unwrap();
    assert_eq!(next.registry_url, "https://second.example/npm/");
}

#[test]
fn claude_runtime_registry_redirects_allow_https_cdns_but_reject_downgrade_credentials_and_sixth_hop(
) {
    let cdn = reqwest::Url::parse("https://cdn.example/package.tgz?signature=temporary").unwrap();
    for hop in 1..=5 {
        assert!(registry::validate_redirect(&cdn, hop).is_ok());
    }
    assert!(registry::validate_redirect(&cdn, 6).is_err());
    for unsafe_url in [
        "http://cdn.example/package.tgz",
        "https://user:secret@cdn.example/package.tgz",
        "file:///package.tgz",
    ] {
        assert!(registry::validate_redirect(&reqwest::Url::parse(unsafe_url).unwrap(), 1).is_err());
    }
    let too_long =
        reqwest::Url::parse(&format!("https://cdn.example/{}", "a".repeat(8192))).unwrap();
    assert!(registry::validate_redirect(&too_long, 1).is_err());
}

#[test]
#[cfg(unix)]
fn claude_runtime_registry_symlink_is_rejected_without_modifying_its_target() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let manager = manager_without_system_probe(temp.path().join("runtime"));
    fs::create_dir_all(&manager.root).unwrap();
    let outside = temp.path().join("outside.json");
    let original = br#""https://original.example/""#;
    fs::write(&outside, original).unwrap();
    symlink(&outside, manager.registry_path()).unwrap();
    assert!(manager.read_registry().is_err());
    assert!(manager.set_registry("https://mirror.example/").is_err());
    assert_eq!(fs::read(&outside).unwrap(), original);
}
