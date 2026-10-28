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
