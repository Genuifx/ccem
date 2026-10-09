use super::*;

#[test]
fn unopened_installer_does_not_create_runtime_or_profile() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("never-installed");
    let installer = HermesInstaller::new(root.clone());
    assert_eq!(installer.status().state, "not_installed");
    assert!(!root.exists());
    installer.cancel();
    assert!(!root.exists());
    installer.remove_runtime().unwrap();
    assert!(!root.exists());
}

#[test]
fn concurrent_actions_are_rejected_and_guard_recovers() {
    let temp = tempfile::tempdir().unwrap();
    let installer = HermesInstaller::new(temp.path().join("runtime"));
    let clone = installer.clone();
    let guard = installer.begin().unwrap();
    assert_eq!(
        clone.remove_runtime().unwrap_err().code,
        "operation_in_progress"
    );
    drop(guard);
    clone.remove_runtime().unwrap();
}

#[test]
fn cancellation_before_worker_starts_is_not_cleared() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("not-created");
    let installer = HermesInstaller::new(root.clone());
    let prepared = installer.prepare_install().unwrap();
    assert_eq!(installer.status().state, "checking");
    assert!(installer.prepare_install().is_err());
    installer.cancel();
    assert_eq!(prepared.run().unwrap_err().code, "cancelled");
    assert_eq!(installer.status().state, "cancelled");
    assert!(!root.exists());
    // The consumed or dropped reservation releases the same flag seen by the UI commands.
    let next = installer.prepare_install().unwrap();
    drop(next);
    assert_eq!(installer.status().state, "cancelled");
    assert_eq!(installer.status().error.unwrap().code, "interrupted");
    installer.remove_runtime().unwrap();
}

#[test]
fn running_runtime_lock_refuses_update_and_recovers_after_exit() {
    use sha2::{Digest, Sha256};
    let temp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap().join("runtime");
    let installer = HermesInstaller::new(root);
    let paths = installer.paths().unwrap();
    let candidate = paths.create_candidate("fixture").unwrap();
    fs::create_dir_all(candidate.join("python/bin")).unwrap();
    fs::write(candidate.join("python/bin/python3.11"), b"fixture").unwrap();
    let receipt = VerifiedRuntimeReceipt {
        schema_version: 1,
        version: "2026.9.10.1".into(),
        sequence: 1,
        signing_key_id: KEY_ID.into(),
        manifest_sha256: "a".repeat(64),
        archive_sha256: "b".repeat(64),
        platform: RuntimePlatform::Macos,
        architecture: RuntimeArchitecture::Aarch64,
        executable_relative_path: "python/bin/python3.11".into(),
        executable_sha256: hex::encode(Sha256::digest(b"fixture")),
        verified_at: "2026-09-10T00:00:00Z".into(),
    };
    let activation = ActivationStore::new(paths.clone());
    activation
        .activate(&candidate, receipt, ActivationFault::None)
        .unwrap();
    let lease = activation.lease_active().unwrap().unwrap();
    assert_eq!(
        exclusive_active_lease(&paths).unwrap_err().code,
        "runtime_in_use"
    );
    drop(lease);
    assert!(exclusive_active_lease(&paths).unwrap().is_some());
    installer.remove_runtime().unwrap();
}

#[test]
fn private_atomic_record_replacement_leaves_no_partial_file() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("state.json");
    write_private(&path, b"1").unwrap();
    write_private(&path, b"2").unwrap();
    assert_eq!(read_regular(&path, 2).unwrap(), b"2");
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn failed_private_record_replacement_preserves_target_and_cleans_temp_file() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("state.json");
    fs::create_dir(&path).unwrap();
    fs::write(path.join("keep"), b"original").unwrap();
    assert_eq!(
        write_private(&path, b"replacement").unwrap_err().code,
        "filesystem"
    );
    assert_eq!(fs::read(path.join("keep")).unwrap(), b"original");
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
}

#[test]
fn source_rejects_credentials_redirect_origins_and_unapproved_protocol() {
    let source = Source {
        manifest_url: "https://releases.ccem.invalid/manifest.json".into(),
        public_key: String::new(),
        development_loopback: false,
    };
    assert!(source
        .artifact_url("https://releases.ccem.invalid/0.21.0.1/pkg.zip")
        .is_ok());
    for url in [
        "http://releases.ccem.invalid/0.21.0.1/pkg.zip",
        "https://other.invalid/pkg.zip",
        "https://user:password@releases.ccem.invalid/pkg.zip",
        "https://releases.ccem.invalid/pkg.zip?x=1",
        "https://releases.ccem.invalid:444/pkg.zip",
        "file:///tmp/archive.zip",
    ] {
        assert!(source.artifact_url(url).is_err(), "{url}");
    }
    let dev = Source {
        manifest_url: "http://127.0.0.1:57890/manifest.json".into(),
        public_key: String::new(),
        development_loopback: true,
    };
    assert_eq!(
        dev.artifact_url("https://127.0.0.1:57890/0.21.0.1/pkg.zip")
            .unwrap(),
        "http://127.0.0.1:57890/0.21.0.1/pkg.zip"
    );
    assert!(dev.artifact_url("https://127.0.0.1:57891/pkg.zip").is_err());
}

fn fixture_manifest_environment(minimum_sequence: u64) -> ManifestEnvironment {
    ManifestEnvironment {
        platform: RuntimePlatform::Macos,
        architecture: RuntimeArchitecture::Aarch64,
        os_version: "14.0".into(),
        protocol_version: HERMES_PROTOCOL_VERSION,
        minimum_sequence,
    }
}

#[test]
fn authenticated_manifest_tampering_and_downgrade_are_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let installer = HermesInstaller::new(temp.path().join("runtime"));
    let source = Source {
        manifest_url: "http://127.0.0.1:57890/manifest.json".into(),
        public_key: include_str!("fixtures/public-key.pub").into(),
        development_loopback: true,
    };
    let bytes = include_bytes!("fixtures/manifest.json");
    let signature = include_bytes!("fixtures/manifest.json.sig");
    let valid = installer
        .verify_manifest_for_environment(
            &source,
            bytes,
            signature,
            &fixture_manifest_environment(1),
        )
        .unwrap();
    assert_eq!(valid.manifest.sequence, 7);
    let mut tampered = bytes.to_vec();
    let index = tampered.iter().position(|b| *b == b'7').unwrap();
    tampered[index] = b'8';
    for (manifest, signature, minimum_sequence, reason) in [
        (
            tampered.as_slice(),
            signature.as_slice(),
            1,
            "InvalidSignature",
        ),
        (bytes.as_slice(), signature.as_slice(), 8, "RollbackRejected"),
        (
            bytes.as_slice(),
            b"not a signature".as_slice(),
            1,
            "InvalidSignature",
        ),
    ] {
        let error = installer
            .verify_manifest_for_environment(
                &source,
                manifest,
                signature,
                &fixture_manifest_environment(minimum_sequence),
            )
            .unwrap_err();
        assert_eq!(error.code, "manifest_rejected");
        assert!(error.message.contains(reason), "{error:?}");
    }
    assert!(!temp.path().join("runtime").exists());
}

#[test]
fn advancing_release_source_preserves_cached_manifest_trust_but_rejects_old_downloads() {
    let temp = tempfile::tempdir().unwrap();
    let installer = HermesInstaller::new(temp.path().join("runtime"));
    let next_source = Source {
        manifest_url: "https://github.com/Genuifx/ccem/releases/download/2026.10.3.1/manifest.json"
            .into(),
        public_key: include_str!("fixtures/public-key.pub").into(),
        development_loopback: false,
    };
    let verified = installer
        .verify_manifest_for_environment(
            &next_source,
            include_bytes!("fixtures/manifest.json"),
            include_bytes!("fixtures/manifest.json.sig"),
            &fixture_manifest_environment(7),
        )
        .unwrap();
    assert!(next_source
        .artifact_url(&verified.manifest.artifact.source_url)
        .is_err());
    let old_release =
        "https://github.com/Genuifx/ccem/releases/download/2026.10.2.1/hermes-macos-aarch64.zip";
    assert!(next_source.artifact_url(old_release).is_err());
    assert!(next_source.artifact_url("https://github.com/Genuifx/ccem/releases/download/2026.10.3.1/hermes-macos-aarch64.zip").is_ok());
    assert!(!temp.path().join("runtime").exists());
}

#[cfg(not(target_os = "macos"))]
#[test]
fn production_manifest_verification_still_rejects_unsupported_hosts() {
    let temp = tempfile::tempdir().unwrap();
    let installer = HermesInstaller::new(temp.path().join("runtime"));
    let source = Source {
        manifest_url: "http://127.0.0.1:57890/manifest.json".into(),
        public_key: include_str!("fixtures/public-key.pub").into(),
        development_loopback: true,
    };
    assert_eq!(
        installer
            .verify_manifest(
                &source,
                include_bytes!("fixtures/manifest.json"),
                include_bytes!("fixtures/manifest.json.sig"),
                1,
            )
            .unwrap_err()
            .code,
        "unsupported_platform"
    );
    assert!(!temp.path().join("runtime").exists());
}

#[cfg(unix)]
#[test]
fn symlinked_runtime_root_or_parent_is_rejected_without_writes() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let outside = temp.path().join("outside");
    fs::create_dir(&outside).unwrap();
    let linked = temp.path().join("linked");
    symlink(&outside, &linked).unwrap();
    let installer = HermesInstaller::new(linked.join("runtime"));
    assert_eq!(installer.paths().unwrap_err().code, "unsafe_path");
    assert!(!outside.join("runtime").exists());
}

#[cfg(unix)]
#[test]
fn readonly_runtime_directory_is_not_silently_chmod_repaired() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap().join("runtime");
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o500)).unwrap();
    let installer = HermesInstaller::new(root.clone());
    assert_eq!(installer.paths().unwrap_err().code, "filesystem");
    assert_eq!(
        fs::metadata(&root).unwrap().permissions().mode() & 0o777,
        0o500
    );
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
}

#[test]
fn restart_surfaces_a_bounded_pending_download_without_resuming_it() {
    let temp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap().join("runtime");
    fs::create_dir_all(root.join("downloads")).unwrap();
    fs::write(
        root.join("downloads/.fixture.zip.download.json"),
        br#"{"completed_bytes":65536,"expected_size":1000000,"status":"paused"}"#,
    )
    .unwrap();
    let installer = HermesInstaller::new(root);
    let status = installer.status();
    assert_eq!(status.state, "paused");
    assert_eq!(status.downloaded_bytes, 65536);
    assert_eq!(status.total_bytes, Some(1_000_000));
    assert!(status.retryable);
}

/// This test drives the real HTTP/download/zip/private-Python/activation path against a locally
/// signed build. It is opt-in because ordinary tests must never download or install a runtime.
#[test]
#[ignore = "requires explicit CCEM_HERMES_TEST_MANIFEST_URL, PUBLIC_KEY and SMOKE_ROOT"]
fn signed_package_install_relocation_lease_and_remove() {
    let root = PathBuf::from(
        std::env::var("CCEM_HERMES_TEST_SMOKE_ROOT").expect("explicit private smoke root"),
    );
    assert!(!root.exists(), "use a new smoke root");
    let installer = HermesInstaller::new(root.clone());
    assert_eq!(installer.status().state, "not_installed");
    assert!(!root.exists());
    let status = installer.install().expect("signed package installation");
    assert_eq!(status.state, "installed");
    assert!(status.downloaded_bytes > 0);
    let lease = installer
        .lease_runtime()
        .expect("full payload verification and lease");
    assert!(lease.launch.python.is_file());
    assert!(
        installer.remove_runtime().is_err(),
        "a live lease protects every payload"
    );
    assert!(lease.launch.python.exists());
    let mut fake_profile = root.parent().unwrap().join("profile");
    fake_profile.push("keep-test-credential");
    fs::create_dir_all(fake_profile.parent().unwrap()).unwrap();
    fs::write(&fake_profile, "synthetic credential").unwrap();
    let host = lease.launch.host.clone();
    drop(lease);
    let pointer_before = fs::read(root.join("active.json")).unwrap();
    installer
        .install()
        .expect("an identical verified package is already installed");
    assert_eq!(fs::read(root.join("active.json")).unwrap(), pointer_before);
    // A newer Desktop points downloads at a newer component. Its existing local
    // runtime must still obtain a fully verified lease without visiting that source.
    let next_source = Source {
        manifest_url: "https://github.com/Genuifx/ccem/releases/download/2026.10.3.1/manifest.json"
            .into(),
        public_key: Source::configured().unwrap().public_key,
        development_loopback: false,
    };
    drop(
        installer
            .lease_runtime_with_source(&next_source)
            .expect("cached runtime survives the next Release URL"),
    );
    assert_eq!(fs::read(root.join("active.json")).unwrap(), pointer_before);
    assert!(fs::read_dir(root.join("candidates"))
        .unwrap()
        .next()
        .is_none());
    let original = fs::read(&host).unwrap();
    fs::write(&host, b"raise RuntimeError('unsigned replacement')").unwrap();
    assert!(
        installer.lease_runtime().is_err(),
        "a replaced host cannot obtain a launch lease"
    );
    fs::write(&host, original).unwrap();
    installer.remove_runtime().unwrap();
    assert_eq!(installer.status().state, "not_installed");
    assert!(fake_profile.exists());
    assert!(root.join("manifest-sequence.json").exists());
    assert!(fs::read_dir(root.join("versions"))
        .unwrap()
        .next()
        .is_none());
}

#[test]
#[ignore = "requires an explicit signed artifact server and CCEM_HERMES_TEST_FAULT_FILE"]
fn signed_package_faults_cancel_resume_and_preserve_previous() {
    use std::time::{Duration, Instant};
    let root = PathBuf::from(std::env::var("CCEM_HERMES_TEST_SMOKE_ROOT").unwrap())
        .with_extension("faults");
    let fault = PathBuf::from(std::env::var("CCEM_HERMES_TEST_FAULT_FILE").unwrap());
    assert!(!root.exists());
    let installer = HermesInstaller::new(root.clone());
    fs::write(&fault, br#"{"badSignature":true}"#).unwrap();
    assert_eq!(installer.install().unwrap_err().code, "manifest_rejected");
    assert!(!root.join("active.json").exists());
    fs::write(&fault, "{}").unwrap();
    std::env::set_var("CCEM_HERMES_TEST_AVAILABLE_BYTES", "0");
    assert_eq!(installer.install().unwrap_err().code, "insufficient_space");
    std::env::remove_var("CCEM_HERMES_TEST_AVAILABLE_BYTES");
    fs::write(&fault, br#"{"chunkDelayMs":5}"#).unwrap();
    let worker = installer.clone();
    let thread = std::thread::spawn(move || worker.install());
    let started = Instant::now();
    while installer.status().downloaded_bytes < 512 * 1024 {
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "download made no progress"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
    installer.cancel();
    assert_eq!(thread.join().unwrap().unwrap_err().code, "cancelled");
    assert!(!root.join("active.json").exists());
    fs::write(&fault, br#"{"truncateAfterBytes":1048576}"#).unwrap();
    assert_eq!(installer.install().unwrap_err().code, "download_failed");
    let restarted = HermesInstaller::new(root.clone());
    assert_eq!(restarted.status().state, "paused");
    assert!(restarted.status().downloaded_bytes > 0);
    fs::write(&fault, "{}").unwrap();
    restarted.install().expect("resume completes and activates");
    let previous = fs::read(root.join("active.json")).unwrap();
    fs::write(&fault, br#"{"badSignature":true}"#).unwrap();
    assert_eq!(restarted.install().unwrap_err().code, "manifest_rejected");
    assert_eq!(fs::read(root.join("active.json")).unwrap(), previous);
    assert!(restarted.status().launch.is_some());
    fs::write(&fault, "{}").unwrap();
    let lease = restarted.lease_runtime().unwrap();
    assert_eq!(restarted.install().unwrap_err().code, "runtime_in_use");
    assert_eq!(fs::read(root.join("active.json")).unwrap(), previous);
    drop(lease);
    restarted.remove_runtime().unwrap();
}
