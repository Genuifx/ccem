use super::*;

fn build() -> BuildIdentity<'static> {
    BuildIdentity {
        windows: true,
        release: true,
        source_commit: Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        run_id: Some("12345"),
        run_attempt: Some("2"),
    }
}

fn environment() -> BTreeMap<&'static str, String> {
    let base = r"D:\a\_temp\ccem-mode2-production-smoke\12345-2";
    BTreeMap::from([
        (ENV_ALLOW, "1".to_string()),
        (ENV_NONCE, "b".repeat(64)),
        (ENV_EVIDENCE_ROOT, format!(r"{base}\evidence")),
        (
            ENV_OBSERVATION_PATH,
            format!(r"{base}\evidence\observation-ready.json"),
        ),
        (
            ENV_ACK_PATH,
            format!(r"{base}\evidence\observation-ack.json"),
        ),
        (
            ENV_RECEIPT_PATH,
            format!(r"{base}\evidence\runtime-receipt.json"),
        ),
        (ENV_EXPECTED_EXE, format!(r"{base}\app\ccem-desktop.exe")),
        ("GITHUB_ACTIONS", "true".to_string()),
        ("RUNNER_OS", "Windows".to_string()),
        ("RUNNER_TEMP", r"D:\a\_temp".to_string()),
        (
            "GITHUB_SHA",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
        ),
        ("GITHUB_RUN_ID", "12345".to_string()),
        ("GITHUB_RUN_ATTEMPT", "2".to_string()),
    ])
}

fn enabled_config() -> WindowsMode2SmokeConfig {
    match evaluate_gate(build(), &environment()) {
        WindowsMode2SmokeGate::Enabled(config) => config,
        WindowsMode2SmokeGate::Disabled => panic!("smoke unexpectedly disabled"),
        WindowsMode2SmokeGate::Rejected(error) => panic!("smoke rejected: {error}"),
    }
}

#[test]
fn absent_explicit_environment_leaves_normal_user_path_disabled() {
    assert!(matches!(
        evaluate_gate(build(), &BTreeMap::new()),
        WindowsMode2SmokeGate::Disabled
    ));
}

#[test]
fn complete_ci_release_identity_enables_exact_evidence_paths() {
    let config = enabled_config();
    assert_eq!(
        config.receipt_path.to_string_lossy(),
        r"D:\a\_temp\ccem-mode2-production-smoke\12345-2\evidence\runtime-receipt.json"
    );
    assert_eq!(
        config.expected_executable,
        r"D:\a\_temp\ccem-mode2-production-smoke\12345-2\app\ccem-desktop.exe"
    );
    assert_eq!(
        config.data_root.to_string_lossy(),
        r"D:\a\_temp\ccem-mode2-production-smoke\12345-2\data"
    );
    assert_eq!(
        config.workspace_root.to_string_lossy(),
        r"D:\a\_temp\ccem-mode2-production-smoke\12345-2\workspace"
    );
    assert_eq!(
        config.owner_record_root.to_string_lossy(),
        r"D:\a\_temp\ccem-mode2-production-smoke\12345-2\data\login\embedded-owners"
    );
}

#[test]
fn every_gate_dimension_fails_closed() {
    let cases = [
        (ENV_ALLOW, "0"),
        ("GITHUB_ACTIONS", "false"),
        ("RUNNER_OS", "macOS"),
        (ENV_NONCE, "ABC"),
        ("GITHUB_RUN_ID", "001"),
        (ENV_RECEIPT_PATH, r"D:\a\_temp\receipt.json"),
        (ENV_EXPECTED_EXE, r"C:\Program Files\CCEM\ccem-desktop.exe"),
    ];
    for (name, value) in cases {
        let mut environment = environment();
        environment.insert(name, value.to_string());
        assert!(matches!(
            evaluate_gate(build(), &environment),
            WindowsMode2SmokeGate::Rejected(_)
        ));
    }

    let mut debug = build();
    debug.release = false;
    assert!(matches!(
        evaluate_gate(debug, &environment()),
        WindowsMode2SmokeGate::Rejected(_)
    ));

    let mut wrong_build = build();
    wrong_build.source_commit = Some("cccccccccccccccccccccccccccccccccccccccc");
    assert!(matches!(
        evaluate_gate(wrong_build, &environment()),
        WindowsMode2SmokeGate::Rejected(_)
    ));
}

#[test]
fn path_validation_rejects_traversal_and_ambiguous_windows_paths() {
    for path in [
        r"D:\a\..\escape",
        r"D:/a/evidence",
        r"relative\evidence",
        "D:\\a\\evidence\\",
        r"D:\a\bad.\evidence",
        r"D:\a\stream:fork",
    ] {
        assert!(validate_windows_path(path, "fixture").is_err(), "{path}");
    }
}

#[test]
fn stages_are_strictly_ordered_and_monotonic() {
    let mut recorder = StageRecorder::new();
    for stage in [
        "direct_ready",
        "direct_cdp",
        "direct_closed",
        "production_acquired_hidden_ready",
        "production_shown",
        "production_hidden",
        "production_reshown",
        "production_handoff",
        "production_semantic_read_write",
        "production_occluded",
        "production_stale_write_denied",
        "production_restored",
        "production_rehandoff",
        "production_post_pause_verified",
        "production_paused",
        "production_takeover",
        "production_released",
        "production_reopened_ready",
        "production_reopened_shown",
        "production_reclosed",
        "production_cleanup_verified",
    ] {
        recorder.record(stage).unwrap();
    }
    assert!(recorder
        .stages
        .windows(2)
        .all(|pair| pair[0].monotonic_ms < pair[1].monotonic_ms));
    assert!(StageRecorder::new().record("direct_cdp").is_err());
}

#[test]
fn observation_ack_is_bound_to_nonce_run_and_pid() {
    let config = enabled_config();
    let ack = ObservationAck {
        schema_version: SCHEMA_VERSION,
        nonce: config.nonce.clone(),
        run_id: config.run_id.clone(),
        run_attempt: config.run_attempt.clone(),
        main_pid: 42,
        observed: true,
    };
    validate_ack(&config, &ack, 42).unwrap();

    let replay = ObservationAck {
        nonce: "c".repeat(64),
        ..ack
    };
    assert!(validate_ack(&config, &replay, 42).is_err());
}

#[test]
fn atomic_publication_is_machine_readable_and_create_only() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("runtime-receipt.json");
    let receipt = RuntimeReceipt {
        schema_version: SCHEMA_VERSION,
        nonce: "d".repeat(64),
        source_commit: "a".repeat(40),
        app_version: "1.2.3".to_string(),
        main_pid: 42,
        executable_path: r"D:\smoke\app\ccem-desktop.exe".to_string(),
        sandbox_enabled: true,
        network_service_sandbox_feature: NETWORK_SERVICE_SANDBOX_FEATURE,
        network_service_sandbox_requested: true,
        network_service_lpac_feature: NETWORK_SERVICE_LPAC_FEATURE,
        network_service_lpac_requested: true,
        production_path: ProductionPathReceipt {
            checkpoint: ProductionPathCheckpoint {
                verified: true,
                manager: "LoginBrowserSurfaceManager",
                data_root: r"D:\smoke\data".to_string(),
                workspace_root: r"D:\smoke\workspace".to_string(),
                owner_record_root: r"D:\smoke\data\login\embedded-owners".to_string(),
                profile_state_root: r"D:\smoke\data\login\profile-state".to_string(),
                cef_cache_root: r"D:\smoke\data\login\cef".to_string(),
                profile_id: "profile-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
                native_window:
                    crate::browser::login::cef::surface::WindowsNativeWindowObservation {
                        hwnd: "0x1234".to_string(),
                        parent_hwnd: "0x4321".to_string(),
                        owner_pid: std::process::id(),
                        x: 120,
                        y: 100,
                        width: 720,
                        height: 480,
                        parent_client_width: 1200,
                        parent_client_height: 800,
                        visible: true,
                        dpi: 144,
                    },
            },
            semantic: ProductionSemanticProof {
                read_via_capability: true,
                write_via_capability: true,
                write_observed: true,
                post_pause_write_denied: true,
                post_pause_value_unchanged: true,
            },
            reopened_profile_id: "profile-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
            cleanup: ProductionCleanupProof {
                active_surface_count: 0,
                active_session_count: 0,
                owner_record_count: 0,
                persisted_profile_count: 1,
                profile_lock_available: true,
            },
        },
        stages: vec![SmokeStage {
            name: "direct_ready".to_string(),
            monotonic_ms: 1,
        }],
    };
    write_json_atomic_create(&target, &receipt).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&fs::read(&target).unwrap()).unwrap();
    assert_eq!(value["schemaVersion"], SCHEMA_VERSION);
    assert_eq!(value["sandboxEnabled"], true);
    assert!(write_json_atomic_create(&target, &receipt).is_err());
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
}

#[test]
fn ack_json_rejects_unknown_fields() {
    let bytes = br#"{"schemaVersion":3,"nonce":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","runId":"12345","runAttempt":"2","mainPid":42,"observed":true,"extra":false}"#;
    assert!(serde_json::from_slice::<ObservationAck>(bytes).is_err());
}
