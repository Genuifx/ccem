use super::*;
use std::path::PathBuf;

#[test]
fn durable_jsonl_sink_writes_pre_and_result_records() {
    let path = std::env::temp_dir().join(format!(
        "ccem-semantic-audit-{}-{}.jsonl",
        std::process::id(),
        std::thread::current().name().unwrap_or("test")
    ));
    let sink = JsonlSemanticAuditSink::new(&path);
    let pre = AuditPreRecord {
        operation_id: 1,
        request_id: "request-1".to_string(),
        actor_id: "runtime-1".to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
        workspace_identity: "workspace-a".to_string(),
        profile_id: "profile-a".to_string(),
        session_id: "session-a".to_string(),
        handoff_epoch: 1,
        decision: AuditDecision::Allowed,
        cause_code: "authorized".to_string(),
        origin_policy_code: Some("allowed".to_string()),
        target_origin: Some("https://allowed.example:443".to_string()),
        command: SemanticBrowserCommand::ReadPage.audit_summary(),
    };
    sink.write_pre(&pre).expect("write pre");
    sink.write_result(&AuditResultRecord {
        operation_id: 1,
        completed_at: chrono::Utc::now().to_rfc3339(),
        success: true,
        outcome_code: "completed".to_string(),
    })
    .expect("write result");
    let contents = std::fs::read_to_string(sink.path()).expect("read audit");
    let phases = contents
        .lines()
        .map(|line| {
            serde_json::from_str::<serde_json::Value>(line)
                .expect("jsonl")
                .get("phase")
                .and_then(serde_json::Value::as_str)
                .expect("phase")
                .to_string()
        })
        .collect::<Vec<_>>();
    assert_eq!(phases, vec!["decision", "result"]);
    assert!(!contents.contains("url"));
    assert!(!contents.contains("guid"));
    assert!(!contents.contains("filename"));
    assert!(!contents.contains("path"));
    std::fs::remove_file(path).expect("remove audit");
}

#[test]
fn denied_navigation_audit_fingerprints_page_controlled_origins() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("audit").join("actions.jsonl");
    let sink = JsonlSemanticAuditSink::new(path.clone());
    let secret_host = "credential-sentinel-91.denied.example";

    sink.write_navigation_denied(
        &binding("session-a", 7),
        "redirect",
        "origin_not_granted",
        Some(&format!("https://{secret_host}:8443")),
    )
    .expect("write denied navigation");

    let contents = std::fs::read_to_string(path).unwrap();
    assert!(!contents.contains(secret_host));
    assert!(!contents.contains("target_origin\""));
    let record = &serde_json::from_str::<serde_json::Value>(contents.lines().next().unwrap())
        .unwrap()["record"];
    assert_eq!(record["target_scheme"], "https");
    assert_eq!(record["target_port"], 8443);
    let fingerprint = record["target_origin_sha256"].as_str().unwrap();
    assert_eq!(fingerprint.len(), 64);
    assert!(fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit()));
}

#[test]
fn durable_audit_rotation_is_bounded_and_keeps_jsonl_records_intact() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("audit").join("actions.jsonl");
    let sink = JsonlSemanticAuditSink::with_limits(path.clone(), 1024, 2);
    for operation_id in 1..=80 {
        let pre = AuditPreRecord {
            operation_id,
            request_id: format!("request-{operation_id}"),
            actor_id: "runtime-1".to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
            workspace_identity: "workspace-a".to_string(),
            profile_id: "profile-a".to_string(),
            session_id: "session-a".to_string(),
            handoff_epoch: 1,
            decision: AuditDecision::Denied,
            cause_code: "origin_not_granted".to_string(),
            origin_policy_code: None,
            target_origin: Some("https://denied.example:443".to_string()),
            command: SemanticBrowserCommand::Navigate {
                url: "https://denied.example/private".to_string(),
            }
            .audit_summary(),
        };
        sink.write_pre(&pre).expect("rotating decision audit");
    }
    assert!(path.exists());
    assert!(PathBuf::from(format!("{}.1", path.display())).exists());
    assert!(PathBuf::from(format!("{}.2", path.display())).exists());
    assert!(!PathBuf::from(format!("{}.3", path.display())).exists());
    for candidate in [
        path.clone(),
        PathBuf::from(format!("{}.1", path.display())),
        PathBuf::from(format!("{}.2", path.display())),
    ] {
        for line in std::fs::read_to_string(candidate).unwrap().lines() {
            serde_json::from_str::<serde_json::Value>(line).expect("intact jsonl record");
        }
    }
}
