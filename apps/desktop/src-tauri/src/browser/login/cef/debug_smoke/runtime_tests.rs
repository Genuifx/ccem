use super::*;

#[test]
fn smoke_host_identity_accepts_legacy_and_canonical_dev_instances() {
    let legacy = validate_smoke_host_identity(
        Some("CCEM Desktop Dev"),
        "com.ccem.desktop.dev",
        Path::new("/private/tmp/CCEM Mode 2 Smoke.app/Contents/MacOS/ccem-desktop"),
        None,
    )
    .expect("isolated Dev identity");
    assert_eq!(legacy.product_name, "CCEM Desktop Dev");
    assert_eq!(legacy.bundle_identifier, "com.ccem.desktop.dev");

    let canonical = validate_smoke_host_identity(
        Some("CCEM Desktop Dev agent-browser-mode2-mainline"),
        "com.ccem.desktop.dev.iae338401",
        Path::new("/private/tmp/CCEM Mode 2 Smoke.app/Contents/MacOS/ccem-desktop"),
        Some("agent-browser-mode2-mainline-ae338401"),
    )
    .expect("canonical per-worktree Dev identity");
    assert_eq!(
        canonical.product_name,
        "CCEM Desktop Dev agent-browser-mode2-mainline"
    );
    assert_eq!(
        canonical.bundle_identifier,
        "com.ccem.desktop.dev.iae338401"
    );

    // tauri-dev truncates the normalized basename after 32 bytes, so a
    // delimiter at that exact boundary can legitimately leave a trailing '-'.
    let truncated = validate_smoke_host_identity(
        Some("CCEM Desktop Dev aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-"),
        "com.ccem.desktop.dev.i1234abcd",
        Path::new("/private/tmp/CCEM Mode 2 Smoke.app/Contents/MacOS/ccem-desktop"),
        Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa--1234abcd"),
    )
    .expect("canonical truncated Dev identity");
    assert_eq!(
        truncated.product_name,
        "CCEM Desktop Dev aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-"
    );
}

#[test]
fn smoke_host_identity_rejects_unbound_or_malformed_dev_instances() {
    for (product_name, bundle_identifier, instance_id) in [
        (
            "CCEM Desktop Dev agent-browser-mode2-mainline",
            "com.ccem.desktop.dev.iae338401",
            None,
        ),
        (
            "CCEM Desktop Dev agent-browser-mode2-mainline",
            "com.ccem.desktop.dev.iae338402",
            Some("agent-browser-mode2-mainline-ae338401"),
        ),
        (
            "CCEM Desktop Dev agent-browser-mode2-mainline",
            "com.ccem.desktop.dev.iae338401",
            Some("agent-browser-mode2-mainline-AE338401"),
        ),
        (
            "CCEM Desktop Dev agent--browser",
            "com.ccem.desktop.dev.iae338401",
            Some("agent--browser-ae338401"),
        ),
    ] {
        assert!(validate_smoke_host_identity(
            Some(product_name),
            bundle_identifier,
            Path::new("/private/tmp/ccem-desktop"),
            instance_id,
        )
        .is_err());
    }
}

#[test]
fn smoke_host_identity_rejects_release_identity_and_installed_executable() {
    assert!(validate_smoke_host_identity(
        Some("CCEM Desktop"),
        "com.ccem.desktop",
        Path::new("/private/tmp/ccem-desktop"),
        None,
    )
    .unwrap_err()
    .contains("CCEM Desktop Dev"));
    assert!(validate_smoke_host_identity(
        Some("CCEM Desktop Dev agent-browser-mode2-mainline"),
        "com.ccem.desktop.dev.iae338401",
        Path::new("/Applications/CCEM Desktop.app/Contents/MacOS/ccem-desktop"),
        Some("agent-browser-mode2-mainline-ae338401"),
    )
    .unwrap_err()
    .contains("installed release"));
}

#[test]
fn concurrent_profile_validator_requires_shared_storage_and_retained_private_state() {
    let (empty_a, empty_b, b_after_a, b_after_b, a_after_b) =
        valid_concurrent_profile_observations();

    validate_concurrent_profile_contract(
        &empty_a,
        &empty_b,
        &b_after_a,
        &b_after_b,
        &a_after_b,
        "shared-a",
        "shared-b",
        "private-a",
        "private-b",
    )
    .expect("real shared storage with retained instance state");
}

#[test]
fn concurrent_profile_validator_rejects_false_positive_observations() {
    let (empty_a, empty_b, b_after_a, b_after_b, a_after_b) =
        valid_concurrent_profile_observations();

    let mut missing_shared_storage = b_after_a.clone();
    missing_shared_storage.indexed_db.clear();
    assert!(validate_concurrent_profile_contract(
        &empty_a,
        &empty_b,
        &missing_shared_storage,
        &b_after_b,
        &a_after_b,
        "shared-a",
        "shared-b",
        "private-a",
        "private-b",
    )
    .unwrap_err()
    .contains("shared storage"));

    let mut duplicate_boot = empty_b.clone();
    duplicate_boot.boot_id = empty_a.boot_id.clone();
    assert!(validate_concurrent_profile_contract(
        &empty_a,
        &duplicate_boot,
        &b_after_a,
        &b_after_b,
        &a_after_b,
        "shared-a",
        "shared-b",
        "private-a",
        "private-b",
    )
    .unwrap_err()
    .contains("distinct page boots"));

    let mut recreated_b = b_after_b.clone();
    recreated_b.boot_id = "recreated-b".to_string();
    assert!(validate_concurrent_profile_contract(
        &empty_a,
        &empty_b,
        &b_after_a,
        &recreated_b,
        &a_after_b,
        "shared-a",
        "shared-b",
        "private-a",
        "private-b",
    )
    .unwrap_err()
    .contains("private state"));

    let mut leaked_private_state = b_after_a.clone();
    leaked_private_state.session_storage = "private-a".to_string();
    assert!(validate_concurrent_profile_contract(
        &empty_a,
        &empty_b,
        &leaked_private_state,
        &b_after_b,
        &a_after_b,
        "shared-a",
        "shared-b",
        "private-a",
        "private-b",
    )
    .unwrap_err()
    .contains("private state isolated"));

    let mut changed_history = a_after_b.clone();
    changed_history.history_length = empty_a.history_length;
    assert!(validate_concurrent_profile_contract(
        &empty_a,
        &empty_b,
        &b_after_a,
        &b_after_b,
        &changed_history,
        "shared-a",
        "shared-b",
        "private-a",
        "private-b",
    )
    .unwrap_err()
    .contains("A-B-A switching"));
}

#[test]
fn exact_close_validator_requires_the_peer_instance_to_remain_unchanged() {
    let (_, empty_b, _, b_after_b, _) = valid_concurrent_profile_observations();
    validate_peer_after_exact_close(&empty_b, &b_after_b, "shared-b", "private-b")
        .expect("Browser B survives exact close of Browser A");

    let mut recreated_peer = b_after_b.clone();
    recreated_peer.boot_id = "recreated-after-close".to_string();
    assert!(
        validate_peer_after_exact_close(&empty_b, &recreated_peer, "shared-b", "private-b")
            .unwrap_err()
            .contains("damaged retained Browser B")
    );

    let mut changed_peer_history = b_after_b.clone();
    changed_peer_history.history_length = empty_b.history_length;
    assert!(validate_peer_after_exact_close(
        &empty_b,
        &changed_peer_history,
        "shared-b",
        "private-b"
    )
    .is_err());
}

#[test]
fn rejected_outcome_is_not_reported_as_an_execution_failure() {
    let outcome = SmokeOutcome::failed(EXIT_GATE_REJECTED, "wrong host".to_string());
    assert_eq!(outcome.status, "rejected");
}

#[test]
fn manager_semantic_snapshot_requires_exact_refs_and_retained_values() {
    let url = "http://127.0.0.1:43111/fixture?conversation=a";
    // Snapshot artifacts intentionally redact query parameters. The manager smoke must compare
    // the redacted artifact identity without weakening the full runtime URL contract.
    let snapshot = manager_semantic_snapshot(
        "http://127.0.0.1:43111/fixture",
        "boot-a",
        "private-a",
        "shared-a",
    );
    let page = manager_page_from_snapshot(&snapshot, url).expect("semantic manager page");

    assert!(page.input_ref.starts_with("el-"));
    assert!(page.commit_ref.starts_with("el-"));
    assert!(page.refresh_ref.starts_with("el-"));
    require_manager_observation(
        &page.observation,
        "private-a",
        "shared-a",
        url,
        Some("boot-a"),
    )
    .expect("retained manager state");

    let mut wrong_profile = page.observation.clone();
    wrong_profile.indexed_db = "other-profile".to_string();
    assert!(require_manager_observation(
        &wrong_profile,
        "private-a",
        "shared-a",
        url,
        Some("boot-a"),
    )
    .is_err());
}

#[test]
fn manager_semantic_snapshot_treats_null_textbox_text_as_an_empty_value() {
    let url = "http://127.0.0.1:43111/fixture?conversation=empty";
    let snapshot =
        manager_semantic_snapshot("http://127.0.0.1:43111/fixture", "boot-empty", "", "");
    let page = manager_page_from_snapshot(&snapshot, url).expect("empty semantic manager page");

    require_manager_observation(&page.observation, "", "", url, Some("boot-empty"))
        .expect("empty textbox values remain observable");
}

#[test]
fn manager_stage_order_covers_two_retained_instances_and_exact_cleanup() {
    let stages = Arc::new(Mutex::new(Vec::new()));
    let recorder = StageRecorder::new(Arc::clone(&stages));
    for stage in [
        "ready_a",
        "ready_b",
        "shared_a_to_b",
        "private_state_isolated",
        "switch_a_b_a",
        "shared_b_to_a",
        "closed_a_peer_live",
        "closed_b",
        "manager_ready_a",
        "manager_ready_b",
        "manager_exact_actor_routes",
        "manager_switch_a_b_a",
        "manager_closed_a_peer_live",
        "manager_closed_b_clean",
    ] {
        recorder.record(stage).expect("ordered stage");
    }
    assert_eq!(stages.lock().unwrap().len(), 14);
    assert!(recorder.record("unexpected").is_err());
}

fn manager_semantic_snapshot(
    url: &str,
    boot_id: &str,
    private_marker: &str,
    shared_marker: &str,
) -> serde_json::Value {
    let element = |role: &str, name: &str, element_ref: &str, text: &str| {
        serde_json::json!({
            "role": role,
            "name": name,
            "element_ref": element_ref,
            "text": (!text.is_empty()).then_some(text),
        })
    };
    serde_json::json!({
        "schema_version": 1,
        "kind": "interaction_snapshot",
        "backend": "chromium_cdp_semantic",
        "provenance": {"untrusted": true},
        "page": {
            "url": url,
            "title": FIXTURE_TITLE,
            "untrusted": true,
            "elements": [
                element("textbox", "CCEM Mode 2 private input", "el-input", private_marker),
                element("button", "Commit CCEM Mode 2 shared storage", "el-commit", ""),
                element("button", "Refresh CCEM Mode 2 shared storage", "el-refresh", ""),
                element("textbox", "CCEM Mode 2 cookie marker", "el-cookie", shared_marker),
                element("textbox", "CCEM Mode 2 local storage marker", "el-local", shared_marker),
                element("textbox", "CCEM Mode 2 indexed db marker", "el-indexed", shared_marker),
                element("textbox", "CCEM Mode 2 boot marker", "el-boot", boot_id),
            ],
        },
    })
}

fn valid_concurrent_profile_observations() -> (
    PageObservation,
    PageObservation,
    PageObservation,
    PageObservation,
    PageObservation,
) {
    let empty_a = PageObservation {
        title: FIXTURE_TITLE.to_string(),
        fixture_marker: FIXTURE_MARKER.to_string(),
        boot_id: "boot-a".to_string(),
        cookie: String::new(),
        local_storage: String::new(),
        indexed_db: String::new(),
        session_storage: String::new(),
        dom_marker: String::new(),
        href: "http://127.0.0.1:43111/fixture".to_string(),
        history_length: 2,
    };
    let empty_b = PageObservation {
        boot_id: "boot-b".to_string(),
        ..empty_a.clone()
    };
    let b_after_a = PageObservation {
        cookie: "shared-a".to_string(),
        local_storage: "shared-a".to_string(),
        indexed_db: "shared-a".to_string(),
        ..empty_b.clone()
    };
    let b_after_b = PageObservation {
        cookie: "shared-b".to_string(),
        local_storage: "shared-b".to_string(),
        indexed_db: "shared-b".to_string(),
        session_storage: "private-b".to_string(),
        dom_marker: "private-b".to_string(),
        href: "http://127.0.0.1:43111/fixture#b".to_string(),
        history_length: 3,
        ..empty_b.clone()
    };
    let a_after_b = PageObservation {
        cookie: "shared-b".to_string(),
        local_storage: "shared-b".to_string(),
        indexed_db: "shared-b".to_string(),
        session_storage: "private-a".to_string(),
        dom_marker: "private-a".to_string(),
        href: "http://127.0.0.1:43111/fixture#a".to_string(),
        history_length: 3,
        ..empty_a.clone()
    };

    (empty_a, empty_b, b_after_a, b_after_b, a_after_b)
}

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
