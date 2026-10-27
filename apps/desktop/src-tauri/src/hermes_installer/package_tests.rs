use super::*;
use std::io::Write;

fn fixture() -> (
    tempfile::TempDir,
    HermesLaunch,
    VerifiedRuntimeManifest,
    PathBuf,
) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("payload");
    let mut files = Vec::new();
    let names = [
        "python/bin/python3.11",
        "source/uv.lock",
        "ccem_gateway_host.py",
        "LICENSE",
        "NOTICE",
    ]
    .into_iter()
    .map(str::to_owned)
    .chain((0..70).map(|i| format!("source/module_{i}.py")));
    for name in names {
        let path = root.join(&name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"verified payload").unwrap();
        files.push(serde_json::json!({"path":name,"size":16,"sha256":hex::encode(Sha256::digest(b"verified payload"))}));
    }
    let identity = serde_json::to_vec(&serde_json::json!({
        "schemaVersion":1,"protocolVersion":HERMES_PROTOCOL_VERSION,
        "hermesCommit":HERMES_SOURCE_COMMIT,"uvLockSha256":HERMES_LOCK_SHA256,
        "pythonVersion":HERMES_PYTHON_VERSION,"platform":"macos","architecture":"aarch64",
        "channels":["wecom"],"files":files,
    }))
    .unwrap();
    fs::write(root.join("runtime.json"), &identity).unwrap();
    let archive = temp.path().join("payload.zip");
    let mut zip = zip::ZipWriter::new(File::create(&archive).unwrap());
    zip.start_file(
        "hermes-runtime/runtime.json",
        zip::write::SimpleFileOptions::default(),
    )
    .unwrap();
    zip.write_all(&identity).unwrap();
    zip.finish().unwrap();
    let mut manifest: crate::browser::runtime::manifest::RuntimeManifest =
        serde_json::from_slice(include_bytes!("fixtures/manifest.json")).unwrap();
    let bytes = fs::read(&archive).unwrap();
    manifest.artifact.archive.byte_size = bytes.len() as u64;
    manifest.artifact.archive.sha256 = hex::encode(Sha256::digest(&bytes));
    let launch = HermesLaunch {
        python: root.join("python/bin/python3.11"),
        source: root.join("source"),
        host: root.join("ccem_gateway_host.py"),
        runtime_root: root,
    };
    (
        temp,
        launch,
        VerifiedRuntimeManifest {
            manifest,
            exact_bytes_sha256: "fixture".into(),
        },
        archive,
    )
}

#[test]
fn verification_reports_real_files_and_preserves_integrity_checks() {
    let (_temp, launch, manifest, archive) = fixture();
    let mut reports = Vec::new();
    verify_package_with_control(
        &launch,
        &manifest,
        &archive,
        &AtomicBool::new(false),
        &mut |done, total| reports.push((done, total)),
    )
    .unwrap();
    assert_eq!(reports.first(), Some(&(0, 75)));
    assert_eq!(reports.last(), Some(&(75, 75)));
    fs::write(&launch.host, b"tampered payload").unwrap();
    assert_eq!(
        verify_package(&launch, &manifest, &archive)
            .unwrap_err()
            .code,
        "package_integrity"
    );
    fs::write(&launch.host, b"verified payload").unwrap();
    fs::write(launch.source.join("unsigned.py"), b"unsigned").unwrap();
    assert_eq!(
        verify_package(&launch, &manifest, &archive)
            .unwrap_err()
            .code,
        "package_integrity"
    );
}

#[test]
fn cancellation_during_verification_and_directory_scan_can_retry() {
    let (_temp, launch, manifest, archive) = fixture();
    for stop_at in [0, 64, 75] {
        let cancelled = AtomicBool::new(false);
        let error = verify_package_with_control(
            &launch,
            &manifest,
            &archive,
            &cancelled,
            &mut |done, _| {
                if done >= stop_at {
                    cancelled.store(true, Ordering::Release);
                }
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "cancelled");
        assert!(error.retryable);
        verify_package(&launch, &manifest, &archive).unwrap();
    }
    assert_eq!(
        hash_file(
            &archive,
            manifest.manifest.artifact.archive.byte_size,
            &AtomicBool::new(true)
        )
        .unwrap_err()
        .code,
        "cancelled"
    );
}

#[test]
fn phase_changes_clear_file_counts_without_reusing_download_progress() {
    let (_temp, launch, manifest, archive) = fixture();
    let installer = HermesInstaller::new(launch.runtime_root.join("installer"));
    installer.try_report(100, 100);
    installer
        .verify_install_package("verifying", &launch, &manifest, &archive)
        .unwrap();
    let progress = installer.status();
    assert_eq!(progress.phase_completed, 75);
    assert_eq!(progress.phase_total, Some(75));
    installer.set_phase("health_check");
    let progress = installer.status();
    assert_eq!(progress.state, "health_check");
    assert_eq!(progress.phase_completed, 0);
    assert_eq!(progress.phase_total, None);
    assert_eq!(progress.downloaded_bytes, 100);
}
