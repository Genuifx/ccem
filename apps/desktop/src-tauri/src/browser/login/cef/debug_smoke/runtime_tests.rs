use super::*;

#[test]
fn isolated_lock_rejects_reuse() {
    let root = tempfile::tempdir().expect("temp root");
    let lock = root.path().join("smoke.lock");
    let first = acquire_smoke_instance_lock(&lock).expect("first lock");
    let second = acquire_smoke_instance_lock(&lock).expect_err("second lock rejected");
    assert!(second.contains("instance lock"));
    drop(first);
}

#[test]
fn atomic_receipt_is_create_only() {
    let root = tempfile::tempdir().expect("temp root");
    let receipt = root.path().join("receipt.json");
    write_json_atomic_create(&receipt, &serde_json::json!({"status": "passed"}))
        .expect("first receipt");
    let second = write_json_atomic_create(&receipt, &serde_json::json!({"status": "failed"}))
        .expect_err("second receipt rejected");
    assert!(second.contains("pre-existing"));
}
