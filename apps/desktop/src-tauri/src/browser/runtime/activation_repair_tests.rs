use super::*;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

fn receipt(version: &str, sequence: u64, marker: u8) -> VerifiedRuntimeReceipt {
    VerifiedRuntimeReceipt {
        schema_version: VERIFICATION_RECEIPT_SCHEMA_VERSION,
        version: version.to_string(),
        sequence,
        signing_key_id: "fixture-runtime-key".to_string(),
        manifest_sha256: hex::encode(Sha256::digest([marker, 1])),
        archive_sha256: hex::encode(Sha256::digest([marker, 2])),
        platform: RuntimePlatform::Macos,
        architecture: RuntimeArchitecture::Aarch64,
        executable_relative_path: "Browser.app/Contents/MacOS/Browser".to_string(),
        executable_sha256: hex::encode(Sha256::digest(b"verified-runtime-fixture")),
        verified_at: "2026-07-11T00:00:00Z".to_string(),
    }
}

fn candidate(store: &ActivationStore, id: &str, receipt: &VerifiedRuntimeReceipt) -> PathBuf {
    let path = store.paths().create_candidate(id).unwrap();
    let executable = path.join(&receipt.executable_relative_path);
    fs::create_dir_all(executable.parent().unwrap()).unwrap();
    fs::write(executable, b"verified-runtime-fixture").unwrap();
    path
}

fn seeded_store() -> (tempfile::TempDir, ActivationStore, VerifiedRuntimeReceipt) {
    let temp = tempfile::tempdir().unwrap();
    let paths = RuntimePaths::under(temp.path().join("runtime")).unwrap();
    let store = ActivationStore::new(paths);
    let active = receipt("149.0.1", 1, 11);
    let active_candidate = candidate(&store, "active-candidate", &active);
    store
        .activate(&active_candidate, active.clone(), ActivationFault::None)
        .unwrap();
    (temp, store, active)
}

#[test]
fn explicit_repair_replaces_a_corrupt_active_executable_and_quarantines_old_bytes() {
    let (_temp, store, active) = seeded_store();
    let version_name = active.version_directory_name().unwrap();
    let version_directory = store.paths().version_path(&version_name).unwrap();
    let executable = version_directory.join(&active.executable_relative_path);
    fs::write(&executable, b"corrupt-active-runtime").unwrap();
    let replacement = candidate(&store, "repair-candidate", &active);

    assert_eq!(
        store.activate(&replacement, active.clone(), ActivationFault::None),
        Err(RuntimeActivationError::ReceiptMismatch)
    );

    let repaired = store
        .repair_and_activate(&replacement, active.clone(), ActivationFault::None)
        .expect("explicit repair should recover corrupt active state");
    assert_eq!(repaired.active, active);
    assert!(repaired.previous.is_none());
    assert_eq!(fs::read(executable).unwrap(), b"verified-runtime-fixture");
    assert_eq!(store.load_pointer().unwrap().unwrap(), repaired);

    let quarantine = fs::read_dir(&store.paths().versions)
        .unwrap()
        .filter_map(Result::ok)
        .find(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("quarantine-")
        })
        .expect("corrupt runtime must be retained for safe deferred cleanup")
        .path();
    assert_eq!(
        fs::read(quarantine.join(&active.executable_relative_path)).unwrap(),
        b"corrupt-active-runtime"
    );
}

#[test]
fn explicit_repair_rewrites_a_corrupt_pointer_without_replacing_valid_runtime_bytes() {
    let (_temp, store, active) = seeded_store();
    let version_directory = store
        .paths()
        .version_path(&active.version_directory_name().unwrap())
        .unwrap();
    let executable = version_directory.join(&active.executable_relative_path);
    fs::write(&store.paths().active_pointer, b"{corrupt-pointer").unwrap();
    let replacement = candidate(&store, "pointer-repair-candidate", &active);

    let repaired = store
        .repair_and_activate(&replacement, active.clone(), ActivationFault::None)
        .expect("valid installed bytes can be rebound to a repaired pointer");

    assert_eq!(repaired.active, active);
    assert_eq!(fs::read(executable).unwrap(), b"verified-runtime-fixture");
    assert!(!replacement.exists());
    assert_eq!(
        fs::read_dir(&store.paths().versions).unwrap().count(),
        1,
        "valid runtime directory must not be needlessly quarantined"
    );
}

#[test]
fn pointer_repair_reuses_the_exact_persisted_receipt_not_a_new_observation_timestamp() {
    let (_temp, store, active) = seeded_store();
    fs::write(&store.paths().active_pointer, b"{corrupt-pointer").unwrap();
    let mut reverified = active.clone();
    reverified.verified_at = "2026-07-11T02:00:00Z".to_string();
    let replacement = candidate(&store, "timestamp-repair-candidate", &reverified);

    let repaired = store
        .repair_and_activate(&replacement, reverified, ActivationFault::None)
        .expect("same signed runtime may repair its pointer");

    assert_eq!(repaired.active, active);
    assert_eq!(store.load_pointer().unwrap().unwrap(), repaired);
}

#[test]
fn active_runtime_lease_blocks_destructive_repair_until_session_releases_it() {
    let (_temp, store, active) = seeded_store();
    let lease = store
        .lease_active()
        .expect("lease active runtime")
        .expect("active runtime exists");
    let version_directory = store
        .paths()
        .version_path(&active.version_directory_name().unwrap())
        .unwrap();
    fs::write(
        version_directory.join(&active.executable_relative_path),
        b"corrupt-while-session-is-running",
    )
    .unwrap();
    let replacement = candidate(&store, "leased-repair-candidate", &active);

    assert_eq!(
        store.repair_and_activate(&replacement, active.clone(), ActivationFault::None),
        Err(RuntimeActivationError::RuntimeInUse)
    );
    assert!(replacement.exists());

    drop(lease);
    store
        .repair_and_activate(&replacement, active, ActivationFault::None)
        .expect("repair may proceed after the session lease is released");
}

#[test]
fn explicit_repair_quarantines_a_syntactically_valid_but_mismatched_receipt() {
    let (_temp, store, active) = seeded_store();
    let version_directory = store
        .paths()
        .version_path(&active.version_directory_name().unwrap())
        .unwrap();
    let mut mismatched = active.clone();
    mismatched.archive_sha256 = "ab".repeat(32);
    fs::write(
        version_directory.join(RECEIPT_FILE_NAME),
        serde_json::to_vec_pretty(&mismatched).unwrap(),
    )
    .unwrap();
    let replacement = candidate(&store, "receipt-repair-candidate", &active);

    store
        .repair_and_activate(&replacement, active.clone(), ActivationFault::None)
        .expect("explicit reinstall may replace a mismatched persisted receipt");

    assert_eq!(store.load_pointer().unwrap().unwrap().active, active);
}

#[cfg(unix)]
#[test]
fn explicit_repair_replaces_an_active_pointer_symlink_without_touching_its_target() {
    let (temp, store, active) = seeded_store();
    let external_pointer = temp.path().join("external-active.json");
    let original_bytes = fs::read(&store.paths().active_pointer).unwrap();
    fs::write(&external_pointer, &original_bytes).unwrap();
    fs::remove_file(&store.paths().active_pointer).unwrap();
    std::os::unix::fs::symlink(&external_pointer, &store.paths().active_pointer).unwrap();
    let replacement = candidate(&store, "symlink-pointer-repair", &active);

    store
        .repair_and_activate(&replacement, active.clone(), ActivationFault::None)
        .expect("explicit repair may quarantine the pointer symlink itself");

    let metadata = fs::symlink_metadata(&store.paths().active_pointer).unwrap();
    assert!(metadata.file_type().is_file());
    assert!(!metadata.file_type().is_symlink());
    assert_eq!(fs::read(external_pointer).unwrap(), original_bytes);
    assert_eq!(store.load_pointer().unwrap().unwrap().active, active);
}
