use super::tests::{inbox_with_frames, test_engine};
use super::*;

struct DenyNavigation;

impl TrustedNavigationGuard for DenyNavigation {
    fn authorize(&self, _request: TrustedNavigationRequest<'_>) -> TrustedNavigationDecision {
        TrustedNavigationDecision::deny("origin_not_granted")
    }
}

struct AuditUnavailable;

impl TrustedNavigationGuard for AuditUnavailable {
    fn authorize(&self, _request: TrustedNavigationRequest<'_>) -> TrustedNavigationDecision {
        TrustedNavigationDecision::deny_terminal("navigation_audit_unavailable")
    }
}

#[test]
fn unacknowledged_secondary_page_close_is_a_terminal_protocol_failure() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    engine.primary_target = Some("primary".to_string());
    let inbox = inbox_with_frames([serde_json::json!({"id":1,"result":{"success":false}})]);
    let mut output = Vec::new();
    let mut client = CdpClient::new(&mut output, inbox);

    let error = engine
        .on_event(
            &mut client,
            CdpEvent {
                kind: CdpEventKind::TargetCreated,
                params: serde_json::json!({"targetInfo":{
                    "targetId":"popup",
                    "type":"page",
                    "url":"https://allowed.example/popup"
                }}),
                session_id: None,
            },
        )
        .unwrap_err();

    assert_eq!(error.code, BackendFailureCode::ProtocolViolation);
}

#[test]
fn rejected_fetch_fail_ack_is_a_terminal_protocol_failure() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    engine.primary_session = Some("primary".to_string());
    engine.main_frame = Some("main".to_string());
    engine.guard = Arc::new(DenyNavigation);
    let inbox = inbox_with_frames([serde_json::json!({
        "id":1,
        "error":{"code":-32000,"message":"rejected"}
    })]);
    let mut output = Vec::new();
    let mut client = CdpClient::new(&mut output, inbox);

    let error = engine
        .on_event(
            &mut client,
            CdpEvent {
                kind: CdpEventKind::RequestPaused,
                params: serde_json::json!({
                    "requestId":"blocked-request",
                    "resourceType":"Document",
                    "frameId":"main",
                    "request":{"url":"https://allowed.example/redirect"}
                }),
                session_id: Some("primary".to_string()),
            },
        )
        .unwrap_err();

    assert_eq!(error.code, BackendFailureCode::ProtocolViolation);
}

#[test]
fn navigation_audit_failure_stops_owner_before_any_fetch_disposition() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    engine.primary_session = Some("primary".to_string());
    engine.guard = Arc::new(AuditUnavailable);
    let (_sender, inbox, _state) = super::super::transport::frame_channel();
    let mut output = Vec::new();
    let mut client = CdpClient::new(&mut output, inbox);

    let error = engine
        .on_event(
            &mut client,
            CdpEvent {
                kind: CdpEventKind::RequestPaused,
                params: serde_json::json!({
                    "requestId":"blocked-request",
                    "resourceType":"Document",
                    "request":{"url":"https://denied.example/redirect"}
                }),
                session_id: Some("primary".to_string()),
            },
        )
        .unwrap_err();

    assert_eq!(error.code, BackendFailureCode::RuntimeUnavailable);
    assert!(output.is_empty());
}

fn engine_with_secondary_target(temp: &tempfile::TempDir) -> (SemanticEngine, Vec<u8>, CdpEvent) {
    let mut engine = test_engine(temp);
    engine.primary_target = Some("primary-target".to_string());
    engine.primary_session = Some("primary-session".to_string());
    let attached = CdpEvent {
        kind: CdpEventKind::TargetAttached,
        params: serde_json::json!({
            "sessionId":"secondary-session",
            "targetInfo":{
                "targetId":"secondary-target",
                "type":"page",
                "url":"https://allowed.example/popup"
            }
        }),
        session_id: None,
    };
    (engine, Vec::new(), attached)
}

#[test]
fn auto_attached_workers_are_resumed_instead_of_remaining_debugger_paused() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    engine.primary_target = Some("primary-target".to_string());
    engine.primary_session = Some("primary-session".to_string());
    let inbox = inbox_with_frames([serde_json::json!({"id":1,"result":{}})]);
    let mut output = Vec::new();
    let mut client = CdpClient::new(&mut output, inbox);

    engine
        .on_event(
            &mut client,
            CdpEvent {
                kind: CdpEventKind::TargetAttached,
                params: serde_json::json!({
                    "sessionId":"worker-session",
                    "targetInfo":{
                        "targetId":"worker-target",
                        "type":"worker",
                        "url":"https://allowed.example/worker.js"
                    }
                }),
                session_id: None,
            },
        )
        .unwrap();

    let commands = output
        .split(|byte| *byte == 0)
        .filter(|frame| !frame.is_empty())
        .map(|frame| serde_json::from_slice::<Value>(frame).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(commands.len(), 1);
    assert_eq!(commands[0]["method"], "Runtime.runIfWaitingForDebugger");
    assert_eq!(commands[0]["sessionId"], "worker-session");
    assert!(!engine
        .pending_sessions
        .iter()
        .any(|session| session == "worker-session"));
    assert!(!engine.configured_sessions.contains("worker-session"));
    assert!(!engine.session_targets.contains_key("worker-session"));
}

#[test]
fn auto_attached_service_worker_allows_bounded_cold_start_latency() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    engine.primary_target = Some("primary-target".to_string());
    engine.primary_session = Some("primary-session".to_string());
    let (sender, inbox, state) = super::super::transport::frame_channel();
    let responder = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(450));
        let value = serde_json::json!({"id":1,"result":{}});
        let byte_len = serde_json::to_vec(&value).unwrap().len();
        assert!(state.reserve_bytes(byte_len, usize::MAX));
        sender
            .send(super::super::transport::FrameEnvelope { value, byte_len })
            .unwrap();
    });
    let mut output = Vec::new();
    let mut client = CdpClient::new(&mut output, inbox);

    engine
        .on_event(
            &mut client,
            CdpEvent {
                kind: CdpEventKind::TargetAttached,
                params: serde_json::json!({
                    "sessionId":"service-worker-session",
                    "targetInfo":{
                        "targetId":"service-worker-target",
                        "type":"service_worker",
                        "url":"https://allowed.example/sw.js"
                    }
                }),
                session_id: None,
            },
        )
        .unwrap();
    responder.join().unwrap();

    let command = output
        .split(|byte| *byte == 0)
        .find(|frame| !frame.is_empty())
        .map(|frame| serde_json::from_slice::<Value>(frame).unwrap())
        .unwrap();
    assert_eq!(command["method"], "Runtime.runIfWaitingForDebugger");
    assert_eq!(command["sessionId"], "service-worker-session");
}

#[test]
fn unknown_auto_attached_target_types_fail_terminal_without_resuming() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    engine.primary_target = Some("primary-target".to_string());
    engine.primary_session = Some("primary-session".to_string());
    let (_sender, inbox, _state) = super::super::transport::frame_channel();
    let mut output = Vec::new();
    let mut client = CdpClient::new(&mut output, inbox);

    let error = engine
        .on_event(
            &mut client,
            CdpEvent {
                kind: CdpEventKind::TargetAttached,
                params: serde_json::json!({
                    "sessionId":"unknown-session",
                    "targetInfo":{
                        "targetId":"unknown-target",
                        "type":"future_privileged_target",
                        "url":"https://allowed.example/unknown"
                    }
                }),
                session_id: None,
            },
        )
        .unwrap_err();

    assert_eq!(error.code, BackendFailureCode::ProtocolViolation);
    assert!(output.is_empty());
}

#[test]
fn primary_crash_during_attach_stops_initialization_before_target_setup() {
    for crash_frames in [
        vec![serde_json::json!({
            "method":"Target.targetCrashed",
            "params":{
                "targetId":"primary-target",
                "status":"crashed",
                "errorCode":5
            }
        })],
        vec![
            serde_json::json!({
                "method":"Target.attachedToTarget",
                "params":{
                    "sessionId":"primary-session",
                    "targetInfo":{
                        "targetId":"primary-target",
                        "type":"page",
                        "url":"about:blank"
                    }
                }
            }),
            serde_json::json!({
                "method":"Inspector.targetCrashed",
                "sessionId":"primary-session",
                "params":{}
            }),
        ],
        vec![serde_json::json!({
            "method":"Inspector.targetCrashed",
            "sessionId":"primary-session",
            "params":{}
        })],
    ] {
        let temp = tempfile::tempdir().unwrap();
        let mut engine = test_engine(&temp);
        let mut frames = vec![
            serde_json::json!({"id":1,"result":{}}),
            serde_json::json!({"id":2,"result":{}}),
            serde_json::json!({"id":3,"result":{"targetId":"primary-target"}}),
        ];
        frames.extend(crash_frames);
        frames.push(serde_json::json!({
            "id":4,
            "result":{"sessionId":"primary-session"}
        }));
        let inbox = inbox_with_frames(frames);
        let mut output = Vec::new();
        let mut client = CdpClient::new(&mut output, inbox);

        let error = engine
            .initialize(
                &mut client,
                Instant::now() + std::time::Duration::from_secs(1),
            )
            .unwrap_err();

        assert_eq!(error.code, BackendFailureCode::RuntimeUnavailable);
        let commands = output
            .split(|byte| *byte == 0)
            .filter(|frame| !frame.is_empty())
            .map(|frame| serde_json::from_slice::<Value>(frame).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(commands.len(), 4);
        assert_eq!(commands[3]["method"], "Target.attachToTarget");
    }
}

#[test]
fn secondary_target_and_inspector_crashes_cleanup_only_the_secondary_registry() {
    for initially_configured in [false, true] {
        for crash in [
            CdpEvent {
                kind: CdpEventKind::TargetCrashed,
                params: serde_json::json!({
                    "targetId":"secondary-target",
                    "status":"crashed",
                    "errorCode":5
                }),
                session_id: None,
            },
            CdpEvent {
                kind: CdpEventKind::TargetCrashed,
                params: serde_json::json!({}),
                session_id: Some("secondary-session".to_string()),
            },
        ] {
            let temp = tempfile::tempdir().unwrap();
            let (mut engine, mut output, attached) = engine_with_secondary_target(&temp);
            if initially_configured {
                engine
                    .configured_sessions
                    .insert("secondary-session".to_string());
            }
            let (_sender, inbox, _state) = super::super::transport::frame_channel();
            let mut client = CdpClient::new(&mut output, inbox);
            engine.on_event(&mut client, attached).unwrap();
            assert_eq!(
                engine
                    .session_targets
                    .get("secondary-session")
                    .map(String::as_str),
                Some("secondary-target")
            );

            engine.on_event(&mut client, crash).unwrap();

            assert_eq!(engine.primary_target.as_deref(), Some("primary-target"));
            assert_eq!(engine.primary_session.as_deref(), Some("primary-session"));
            assert!(!engine.configured_sessions.contains("secondary-session"));
            assert!(!engine
                .pending_sessions
                .iter()
                .any(|session| session == "secondary-session"));
            assert!(!engine.session_targets.contains_key("secondary-session"));
        }
    }
}

#[test]
fn inspector_crash_for_an_extra_session_mapped_to_the_primary_target_is_terminal() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    engine.primary_target = Some("primary-target".to_string());
    engine.primary_session = Some("primary-session".to_string());
    let (_sender, inbox, _state) = super::super::transport::frame_channel();
    let mut output = Vec::new();
    let mut client = CdpClient::new(&mut output, inbox);
    engine
        .on_event(
            &mut client,
            CdpEvent {
                kind: CdpEventKind::TargetAttached,
                params: serde_json::json!({
                    "sessionId":"extra-primary-session",
                    "targetInfo":{
                        "targetId":"primary-target",
                        "type":"page",
                        "url":"https://allowed.example/"
                    }
                }),
                session_id: None,
            },
        )
        .unwrap();

    let error = engine
        .on_event(
            &mut client,
            CdpEvent {
                kind: CdpEventKind::TargetCrashed,
                params: serde_json::json!({}),
                session_id: Some("extra-primary-session".to_string()),
            },
        )
        .unwrap_err();

    assert_eq!(error.code, BackendFailureCode::RuntimeUnavailable);
}

#[test]
fn primary_target_and_inspector_crashes_are_terminal() {
    for crash in [
        CdpEvent {
            kind: CdpEventKind::TargetCrashed,
            params: serde_json::json!({
                "targetId":"primary-target",
                "status":"crashed",
                "errorCode":5
            }),
            session_id: None,
        },
        CdpEvent {
            kind: CdpEventKind::TargetCrashed,
            params: serde_json::json!({}),
            session_id: Some("primary-session".to_string()),
        },
    ] {
        let temp = tempfile::tempdir().unwrap();
        let mut engine = test_engine(&temp);
        engine.primary_target = Some("primary-target".to_string());
        engine.primary_session = Some("primary-session".to_string());
        let (_sender, inbox, _state) = super::super::transport::frame_channel();
        let mut output = Vec::new();
        let mut client = CdpClient::new(&mut output, inbox);

        let error = engine.on_event(&mut client, crash).unwrap_err();

        assert_eq!(error.code, BackendFailureCode::RuntimeUnavailable);
    }
}
