use super::super::console_events::ConsoleEventRecorder;
use super::*;
use crate::browser::login::capability::JsonlSemanticAuditSink;
use crate::browser::login::network::NetworkRedactionConfig;
use crate::browser::login::policy::BrowserGrantBinding;
use crate::browser::login::session_policy::SessionNavigationPolicy;
use std::path::PathBuf;

fn engine_with_policy(temp: &tempfile::TempDir, active_grant: bool) -> (SemanticEngine, PathBuf) {
    let audit_path = temp.path().join("audit").join("actions.jsonl");
    let audit = Arc::new(JsonlSemanticAuditSink::new(audit_path.clone()));
    let policy = Arc::new(SessionNavigationPolicy::with_audit(audit));
    if active_grant {
        policy
            .activate(
                BrowserGrantBinding::new_trusted("workspace", "profile", "session", 7).unwrap(),
                ["https://allowed.example"],
            )
            .unwrap();
    }
    let engine = SemanticEngine::new(
        policy,
        CdpArtifactStore::new(temp.path().join("artifacts")).unwrap(),
        NetworkEventRecorder::new(
            temp.path().join("logs"),
            "session".to_string(),
            NetworkRedactionConfig::default(),
        )
        .unwrap(),
        ConsoleEventRecorder::new(
            temp.path().join("logs"),
            "session".to_string(),
            NetworkRedactionConfig::default(),
        )
        .unwrap(),
    );
    (engine, audit_path)
}

fn empty_client<'a>(output: &'a mut Vec<u8>) -> CdpClient<'a> {
    let (_sender, inbox, _state) = super::super::transport::frame_channel();
    CdpClient::new(output, inbox)
}

fn blocked_events() -> [CdpEvent; 3] {
    [
        CdpEvent {
            kind: CdpEventKind::FileChooserOpened,
            params: serde_json::json!({
                "frameId": "main-frame",
                "mode": "selectSingle",
                "backendNodeId": 42,
                "url": "https://raw.example/private?token=RAW_SENTINEL",
                "guid": "RAW_GUID_SENTINEL",
                "suggestedFilename": "RAW_FILENAME_SENTINEL",
                "filePath": "/RAW/PATH/SENTINEL"
            }),
            session_id: Some("primary".to_string()),
        },
        CdpEvent {
            kind: CdpEventKind::DownloadWillBegin,
            params: serde_json::json!({
                "url": "https://raw.example/private?token=RAW_SENTINEL",
                "guid": "RAW_GUID_SENTINEL",
                "suggestedFilename": "RAW_FILENAME_SENTINEL"
            }),
            session_id: None,
        },
        CdpEvent {
            kind: CdpEventKind::DownloadProgress,
            params: serde_json::json!({
                "guid": "RAW_GUID_SENTINEL",
                "state": "canceled",
                "filePath": "/RAW/PATH/SENTINEL"
            }),
            session_id: None,
        },
    ]
}

#[test]
fn blocked_transfer_events_share_actions_jsonl_without_raw_browser_payload() {
    let temp = tempfile::tempdir().unwrap();
    let (mut engine, audit_path) = engine_with_policy(&temp, true);
    engine.primary_session = Some("primary".to_string());
    engine.configured_sessions.insert("primary".to_string());
    let mut output = Vec::new();
    let mut client = empty_client(&mut output);

    for event in blocked_events() {
        engine.on_event(&mut client, event).unwrap();
    }

    let contents = std::fs::read_to_string(audit_path).unwrap();
    let records = contents
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(records.len(), 3);
    assert_eq!(records[0]["record"]["event"], "upload_blocked");
    assert_eq!(records[1]["record"]["event"], "download_blocked");
    assert_eq!(records[2]["record"]["event"], "download_canceled");
    for sentinel in [
        "RAW_SENTINEL",
        "RAW_GUID_SENTINEL",
        "RAW_FILENAME_SENTINEL",
        "/RAW/PATH/SENTINEL",
        "raw.example",
    ] {
        assert!(!contents.contains(sentinel));
    }
}

#[test]
fn user_control_does_not_fabricate_agent_transfer_audit() {
    let temp = tempfile::tempdir().unwrap();
    let (mut engine, audit_path) = engine_with_policy(&temp, false);
    engine.primary_session = Some("primary".to_string());
    engine.configured_sessions.insert("primary".to_string());
    let mut output = Vec::new();
    let mut client = empty_client(&mut output);
    for event in blocked_events() {
        engine.on_event(&mut client, event).unwrap();
    }
    assert!(!audit_path.exists());
}

#[cfg(unix)]
#[test]
fn transfer_audit_failure_is_terminal_and_not_counted_as_successful_observability() {
    let temp = tempfile::tempdir().unwrap();
    let (mut engine, audit_path) = engine_with_policy(&temp, true);
    engine.primary_session = Some("primary".to_string());
    engine.configured_sessions.insert("primary".to_string());
    std::fs::create_dir_all(audit_path.parent().unwrap()).unwrap();
    let outside = temp.path().join("outside.jsonl");
    std::fs::write(&outside, b"sentinel").unwrap();
    std::os::unix::fs::symlink(&outside, &audit_path).unwrap();
    let mut output = Vec::new();
    let mut client = empty_client(&mut output);

    let error = engine
        .on_event(&mut client, blocked_events().into_iter().next().unwrap())
        .unwrap_err();
    assert_eq!(error.code, BackendFailureCode::RuntimeUnavailable);
    assert_eq!(engine.projection().blocked_file_chooser_count, 0);
    assert_eq!(std::fs::read(outside).unwrap(), b"sentinel");
}
