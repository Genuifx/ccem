use super::*;
use std::io::Write;

const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NONCE: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TARGET: &str = "aarch64-apple-darwin";
const REPOSITORY: &str = "Genuifx/claude-code-env-manager";
const WORKFLOW_REF: &str =
    "Genuifx/claude-code-env-manager/.github/workflows/mode2-signed-readiness.yml@refs/heads/main";
const PRODUCER_WORKFLOW_REF: &str =
    "Genuifx/claude-code-env-manager/.github/workflows/mode2-signed-producer.yml@refs/heads/main";
const JOB: &str = "build-desktop";

fn build() -> BuildIdentity<'static> {
    BuildIdentity {
        macos: true,
        release: true,
        source_commit: Some(SHA),
        run_id: Some("12345"),
        run_attempt: Some("2"),
        target: Some(TARGET),
        repository: Some(REPOSITORY),
        workflow_ref: Some(WORKFLOW_REF),
        producer_workflow_ref: Some(PRODUCER_WORKFLOW_REF),
        job: Some(JOB),
    }
}

fn valid_environment() -> BTreeMap<&'static str, String> {
    let runner_temp = "/private/tmp/runner";
    let run_root = format!("{runner_temp}/{SMOKE_DIRECTORY}/12345-2-{}", &NONCE[..16]);
    let scenario_root = format!("{run_root}/scenarios/clean");
    BTreeMap::from([
        (ENV_ALLOW, "1".to_string()),
        (ENV_NONCE, NONCE.to_string()),
        (ENV_ROOT, run_root.clone()),
        (ENV_SCENARIO, "clean".to_string()),
        (ENV_PHASE, "prime".to_string()),
        (ENV_SCENARIO_ROOT, scenario_root.clone()),
        (
            ENV_RECEIPT,
            format!("{scenario_root}/evidence/prime-runtime.json"),
        ),
        (ENV_TICKET, format!("{scenario_root}/tickets/prime.ticket")),
        (
            ENV_EXPECTED_EXE,
            format!("{run_root}/app/CCEM.app/Contents/MacOS/ccem-desktop"),
        ),
        (
            ENV_KEYCHAIN,
            format!("{scenario_root}/keychain/smoke.keychain-db"),
        ),
        (
            ENV_ISOLATION,
            format!("{scenario_root}/keychain/isolation.json"),
        ),
        (ENV_TARGET, TARGET.to_string()),
        (ENV_PRODUCER_WORKFLOW_REF, PRODUCER_WORKFLOW_REF.to_string()),
        ("GITHUB_ACTIONS", "true".to_string()),
        ("CI", "true".to_string()),
        ("RUNNER_OS", "macOS".to_string()),
        ("RUNNER_TEMP", runner_temp.to_string()),
        ("GITHUB_SHA", SHA.to_string()),
        ("GITHUB_RUN_ID", "12345".to_string()),
        ("GITHUB_RUN_ATTEMPT", "2".to_string()),
        ("GITHUB_REPOSITORY", REPOSITORY.to_string()),
        ("GITHUB_WORKFLOW_REF", WORKFLOW_REF.to_string()),
        ("GITHUB_JOB", JOB.to_string()),
    ])
}

#[test]
fn gate_is_disabled_without_any_explicit_smoke_environment() {
    assert!(matches!(
        evaluate_gate(build(), &BTreeMap::new()),
        MacosSafeStorageSmokeGate::Disabled
    ));
}

#[test]
fn gate_rejects_local_debug_and_partial_invocations() {
    let environment = valid_environment();
    for identity in [
        BuildIdentity {
            macos: false,
            ..build()
        },
        BuildIdentity {
            release: false,
            ..build()
        },
    ] {
        assert!(matches!(
            evaluate_gate(identity, &environment),
            MacosSafeStorageSmokeGate::Rejected(_)
        ));
    }
    for name in EXPLICIT_ENVIRONMENT {
        assert!(matches!(
            evaluate_gate(build(), &BTreeMap::from([(name, "1".to_string())])),
            MacosSafeStorageSmokeGate::Rejected(_)
        ));
    }
}

#[test]
fn gate_requires_exact_github_build_identity() {
    for name in ["GITHUB_ACTIONS", "CI", "RUNNER_OS"] {
        let mut environment = valid_environment();
        environment.insert(name, "false".to_string());
        assert!(matches!(
            evaluate_gate(build(), &environment),
            MacosSafeStorageSmokeGate::Rejected(_)
        ));
    }
    for name in [
        "GITHUB_SHA",
        "GITHUB_RUN_ID",
        "GITHUB_RUN_ATTEMPT",
        ENV_TARGET,
        "GITHUB_REPOSITORY",
        "GITHUB_WORKFLOW_REF",
        ENV_PRODUCER_WORKFLOW_REF,
        "GITHUB_JOB",
    ] {
        let mut environment = valid_environment();
        environment.insert(name, "9".repeat(environment[name].len()));
        assert!(matches!(
            evaluate_gate(build(), &environment),
            MacosSafeStorageSmokeGate::Rejected(_)
        ));
    }
}

#[test]
fn gate_accepts_only_exact_current_run_scenario_paths() {
    let gate = evaluate_gate(build(), &valid_environment());
    let MacosSafeStorageSmokeGate::Enabled(config) = gate else {
        panic!("exact release CI gate was not enabled");
    };
    assert_eq!(config.scenario, "clean");
    assert_eq!(config.phase, "prime");
    assert_eq!(config.source_commit, SHA);
    assert_eq!(config.run_id, "12345");
    assert_eq!(config.run_attempt, "2");
    assert_eq!(config.target, TARGET);
    assert_eq!(config.repository, REPOSITORY);
    assert_eq!(config.workflow_ref, WORKFLOW_REF);
    assert_eq!(config.producer_workflow_ref, PRODUCER_WORKFLOW_REF);
    assert_eq!(config.job, JOB);
    assert_eq!(
        config.cef_cache_root,
        PathBuf::from(format!(
            "/private/tmp/runner/{SMOKE_DIRECTORY}/12345-2-{}/scenarios/clean/data/login/cef",
            &NONCE[..16]
        ))
    );
}

#[test]
fn gate_rejects_path_escape_invalid_scenario_and_replay_receipt() {
    for (name, value) in [
        (ENV_SCENARIO, "login-keychain"),
        (ENV_PHASE, "third"),
        (ENV_SCENARIO_ROOT, "/private/tmp/runner/elsewhere"),
        (ENV_RECEIPT, "/private/tmp/receipt.json"),
        (
            ENV_KEYCHAIN,
            "/Users/runner/Library/Keychains/login.keychain-db",
        ),
        (ENV_TICKET, "/private/tmp/ticket"),
        (
            ENV_EXPECTED_EXE,
            "/Applications/CCEM.app/Contents/MacOS/ccem-desktop",
        ),
    ] {
        let mut environment = valid_environment();
        environment.insert(name, value.to_string());
        assert!(matches!(
            evaluate_gate(build(), &environment),
            MacosSafeStorageSmokeGate::Rejected(_)
        ));
    }
}

#[test]
fn one_shot_ticket_is_bound_and_consumed_by_no_replace_hard_link() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let ticket_path = temporary.path().join("prime.ticket");
    let mut ticket = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&ticket_path)
        .expect("create ticket");
    writeln!(
        ticket,
        "{{\"schemaVersion\":2,\"nonce\":\"{NONCE}\",\"scenario\":\"clean\",\"phase\":\"prime\"}}"
    )
    .expect("write ticket");
    let config = MacosSafeStorageSmokeConfig {
        nonce: NONCE.to_string(),
        source_commit: SHA.to_string(),
        run_id: "12345".to_string(),
        run_attempt: "2".to_string(),
        target: TARGET.to_string(),
        repository: REPOSITORY.to_string(),
        workflow_ref: WORKFLOW_REF.to_string(),
        producer_workflow_ref: PRODUCER_WORKFLOW_REF.to_string(),
        job: JOB.to_string(),
        scenario: "clean".to_string(),
        phase: "prime".to_string(),
        smoke_root: temporary.path().to_path_buf(),
        cef_cache_root: temporary.path().join("cef"),
        receipt_path: temporary.path().join("receipt.json"),
        ticket_path: ticket_path.clone(),
        expected_executable: temporary.path().join("ccem-desktop"),
        keychain_path: temporary.path().join("smoke.keychain-db"),
        isolation_receipt_path: temporary.path().join("isolation.json"),
    };
    consume_one_shot_ticket(&config).expect("consume ticket");
    assert!(!ticket_path.exists());
    assert!(temporary.path().join("prime.consumed").is_file());
    assert!(consume_one_shot_ticket(&config).is_err());
}

#[test]
fn one_shot_ticket_rejects_wrong_nonce_scenario_or_phase() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    for (field, value) in [
        ("nonce", "c".repeat(64)),
        ("scenario", "generic-conflict".to_string()),
        ("phase", "verify".to_string()),
    ] {
        let ticket_path = temporary.path().join(format!("{field}.ticket"));
        let mut body = serde_json::json!({
            "schemaVersion": 2,
            "nonce": NONCE,
            "scenario": "clean",
            "phase": "prime",
        });
        body[field] = serde_json::Value::String(value);
        fs::write(&ticket_path, serde_json::to_vec(&body).unwrap()).unwrap();
        let config = MacosSafeStorageSmokeConfig {
            nonce: NONCE.to_string(),
            source_commit: SHA.to_string(),
            run_id: "12345".to_string(),
            run_attempt: "2".to_string(),
            target: TARGET.to_string(),
            repository: REPOSITORY.to_string(),
            workflow_ref: WORKFLOW_REF.to_string(),
            producer_workflow_ref: PRODUCER_WORKFLOW_REF.to_string(),
            job: JOB.to_string(),
            scenario: "clean".to_string(),
            phase: "prime".to_string(),
            smoke_root: temporary.path().to_path_buf(),
            cef_cache_root: temporary.path().join("cef"),
            receipt_path: temporary.path().join("receipt.json"),
            ticket_path,
            expected_executable: temporary.path().join("ccem-desktop"),
            keychain_path: temporary.path().join("smoke.keychain-db"),
            isolation_receipt_path: temporary.path().join("isolation.json"),
        };
        assert!(consume_one_shot_ticket(&config).is_err());
    }
}
