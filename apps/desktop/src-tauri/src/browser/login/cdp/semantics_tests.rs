use super::*;
use crate::browser::login::control::{
    HandoffControl, HandoffGrant, LoginBrowserControl, OperationCancellation,
};
use crate::browser::login::network::NetworkRedactionConfig;
use crate::browser::login::policy::BrowserGrantBinding;
use std::io::{Cursor, Write};

struct AllowNavigation;

impl TrustedNavigationGuard for AllowNavigation {
    fn authorize(
        &self,
        _request: TrustedNavigationRequest<'_>,
    ) -> super::super::guard::TrustedNavigationDecision {
        super::super::guard::TrustedNavigationDecision::allow("allowed")
    }

    fn record_security_event(
        &self,
        _event: super::super::guard::TrustedSecurityEvent,
    ) -> Result<
        super::super::guard::TrustedSecurityAuditDisposition,
        super::super::guard::TrustedSecurityAuditFailure,
    > {
        Ok(super::super::guard::TrustedSecurityAuditDisposition::UserControl)
    }

    fn record_handoff_preflight_denial(
        &self,
        _denial: super::super::guard::TrustedHandoffPreflightDenial<'_>,
    ) -> Result<(), super::super::guard::TrustedSecurityAuditFailure> {
        Ok(())
    }
}

pub(in crate::browser::login::cdp) fn test_engine(temp: &tempfile::TempDir) -> SemanticEngine {
    SemanticEngine::new(
        Arc::new(AllowNavigation),
        CdpArtifactStore::new(temp.path().join("artifacts")).unwrap(),
        NetworkEventRecorder::new(
            temp.path().join("network"),
            "session-test".to_string(),
            NetworkRedactionConfig::default(),
        )
        .unwrap(),
        ConsoleEventRecorder::new(
            temp.path().join("network"),
            "session-test".to_string(),
            NetworkRedactionConfig::default(),
        )
        .unwrap(),
    )
}

fn inbox_with_responses(
    mut response_for: impl FnMut(u64) -> Value,
) -> super::super::transport::FrameInbox {
    let (sender, inbox, state) = super::super::transport::frame_channel();
    let mut bytes = Vec::new();
    for id in 1..=20 {
        let frame = serde_json::json!({"id": id, "result": response_for(id)});
        bytes.extend_from_slice(&serde_json::to_vec(&frame).unwrap());
        bytes.push(0);
    }
    super::super::transport::run_frame_reader(&mut Cursor::new(bytes), sender, state);
    inbox
}

pub(in crate::browser::login::cdp) fn inbox_with_frames(
    frames: impl IntoIterator<Item = Value>,
) -> super::super::transport::FrameInbox {
    let (sender, inbox, state) = super::super::transport::frame_channel();
    let mut bytes = Vec::new();
    for frame in frames {
        bytes.extend_from_slice(&serde_json::to_vec(&frame).unwrap());
        bytes.push(0);
    }
    super::super::transport::run_frame_reader(&mut Cursor::new(bytes), sender, state);
    inbox
}

fn inbox_ending_with_error(
    error_id: u64,
    mut response_for: impl FnMut(u64) -> Value,
) -> super::super::transport::FrameInbox {
    let (sender, inbox, state) = super::super::transport::frame_channel();
    let mut bytes = Vec::new();
    for id in 1..=error_id {
        let frame = if id == error_id {
            serde_json::json!({"id": id, "error": {"code": -32000, "message": "rejected"}})
        } else {
            serde_json::json!({"id": id, "result": response_for(id)})
        };
        bytes.extend_from_slice(&serde_json::to_vec(&frame).unwrap());
        bytes.push(0);
    }
    super::super::transport::run_frame_reader(&mut Cursor::new(bytes), sender, state);
    inbox
}

fn parse_commands(bytes: &[u8]) -> Vec<Value> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|frame| !frame.is_empty())
        .map(|frame| serde_json::from_slice(frame).unwrap())
        .collect()
}

fn cancelled_operation() -> OperationCancellation {
    let binding = BrowserGrantBinding::new_trusted("w", "p", "s", 1).unwrap();
    let control = LoginBrowserControl::new();
    control
        .activate_handoff(HandoffGrant::new_trusted(binding.clone()))
        .unwrap();
    let cancellation = control.begin_operation(&binding, true).unwrap();
    control.cancel_active();
    cancellation
}

fn cancellable_operation() -> (Arc<LoginBrowserControl>, OperationCancellation) {
    let binding = BrowserGrantBinding::new_trusted("w", "p", "s", 1).unwrap();
    let control = Arc::new(LoginBrowserControl::new());
    control
        .activate_handoff(HandoffGrant::new_trusted(binding.clone()))
        .unwrap();
    let cancellation = control.begin_operation(&binding, true).unwrap();
    (control, cancellation)
}

#[test]
fn agent_inventory_closes_an_authorized_secondary_page_before_semantic_work() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    engine.primary_target = Some("primary".to_string());
    let inbox = inbox_with_frames([serde_json::json!({"id":1,"result":{"success":true}})]);
    let mut output = Vec::new();
    let mut client = CdpClient::new(&mut output, inbox);

    engine
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
        .unwrap();
    drop(client);

    let commands = parse_commands(&output);
    assert_eq!(commands.len(), 1);
    assert_eq!(commands[0]["method"], "Target.closeTarget");
    assert_eq!(commands[0]["params"]["targetId"], "popup");
}

struct CancelOnMousePress {
    bytes: Vec<u8>,
    control: Arc<LoginBrowserControl>,
}

struct CancelOnKeyDown {
    bytes: Vec<u8>,
    control: Arc<LoginBrowserControl>,
}

struct DelayOnInput {
    bytes: Vec<u8>,
    method: &'static str,
    event_type: &'static str,
    deadline: Instant,
    triggered: bool,
}

impl Write for DelayOnInput {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.bytes.extend_from_slice(bytes);
        if !self.triggered && bytes.ends_with(&[0]) {
            let command: Value = serde_json::from_slice(&bytes[..bytes.len() - 1]).unwrap();
            if command["method"] == self.method && command["params"]["type"] == self.event_type {
                self.triggered = true;
                std::thread::sleep(
                    self.deadline.saturating_duration_since(Instant::now())
                        + Duration::from_millis(10),
                );
            }
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Write for CancelOnKeyDown {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.bytes.extend_from_slice(bytes);
        if bytes.ends_with(&[0]) {
            let command: Value = serde_json::from_slice(&bytes[..bytes.len() - 1]).unwrap();
            if command["method"] == "Input.dispatchKeyEvent"
                && command["params"]["type"] == "keyDown"
            {
                self.control.cancel_active();
            }
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Write for CancelOnMousePress {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.bytes.extend_from_slice(bytes);
        if bytes.ends_with(&[0]) {
            let command: Value = serde_json::from_slice(&bytes[..bytes.len() - 1]).unwrap();
            if command["method"] == "Input.dispatchMouseEvent"
                && command["params"]["type"] == "mousePressed"
            {
                self.control.cancel_active();
            }
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[test]
fn cancelled_click_releases_a_dispatched_mouse_press_before_returning_original_error() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    engine.primary_session = Some("primary".to_string());
    engine.current_url = "https://allowed.example/".to_string();
    let element_ref = engine.elements.insert(42).unwrap();
    let inbox = inbox_with_responses(|id| {
        if id == 2 {
            serde_json::json!({
                "model": {"content": [0, 0, 10, 0, 10, 20, 0, 20]}
            })
        } else {
            serde_json::json!({})
        }
    });
    let (control, cancellation) = cancellable_operation();
    let mut output = CancelOnMousePress {
        bytes: Vec::new(),
        control,
    };
    let error = {
        let mut client = CdpClient::new(&mut output, inbox);
        engine
            .click(
                &mut client,
                &element_ref,
                &cancellation,
                Instant::now() + Duration::from_secs(1),
            )
            .unwrap_err()
    };

    assert_eq!(error.code, BackendFailureCode::Cancelled);
    let input_types = parse_commands(&output.bytes)
        .into_iter()
        .filter(|command| command["method"] == "Input.dispatchMouseEvent")
        .map(|command| command["params"]["type"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(input_types, ["mousePressed", "mouseReleased"]);
}

#[test]
fn cancelled_replace_type_releases_a_dispatched_key_down_before_returning_original_error() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    engine.primary_session = Some("primary".to_string());
    engine.current_url = "https://allowed.example/".to_string();
    let element_ref = engine.elements.insert(42).unwrap();
    let inbox = inbox_with_responses(|_| serde_json::json!({}));
    let (control, cancellation) = cancellable_operation();
    let mut output = CancelOnKeyDown {
        bytes: Vec::new(),
        control,
    };
    let error = {
        let mut client = CdpClient::new(&mut output, inbox);
        engine
            .type_text(
                &mut client,
                &element_ref,
                "replacement",
                true,
                &cancellation,
                Instant::now() + Duration::from_secs(1),
            )
            .unwrap_err()
    };

    assert_eq!(error.code, BackendFailureCode::Cancelled);
    let keys = parse_commands(&output.bytes)
        .into_iter()
        .filter(|command| command["method"] == "Input.dispatchKeyEvent")
        .map(|command| {
            (
                command["params"]["type"].as_str().unwrap().to_string(),
                command["params"]["key"].as_str().unwrap().to_string(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        keys,
        [
            ("keyDown".to_string(), "a".to_string()),
            ("keyUp".to_string(), "a".to_string()),
        ]
    );
}

#[test]
fn timed_out_click_uses_an_independent_deadline_to_release_mouse_input() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    engine.primary_session = Some("primary".to_string());
    engine.current_url = "https://allowed.example/".to_string();
    let element_ref = engine.elements.insert(42).unwrap();
    let inbox = inbox_with_responses(|id| {
        if id == 2 {
            serde_json::json!({
                "model": {"content": [0, 0, 10, 0, 10, 20, 0, 20]}
            })
        } else {
            serde_json::json!({})
        }
    });
    let (_, cancellation) = cancellable_operation();
    let deadline = Instant::now() + Duration::from_millis(250);
    let mut output = DelayOnInput {
        bytes: Vec::new(),
        method: "Input.dispatchMouseEvent",
        event_type: "mousePressed",
        deadline,
        triggered: false,
    };
    let error = {
        let mut client = CdpClient::new(&mut output, inbox);
        engine
            .click(&mut client, &element_ref, &cancellation, deadline)
            .unwrap_err()
    };

    assert_eq!(error.code, BackendFailureCode::TimedOut);
    let inputs = parse_commands(&output.bytes)
        .into_iter()
        .filter(|command| command["method"] == "Input.dispatchMouseEvent")
        .collect::<Vec<_>>();
    assert_eq!(inputs.len(), 2);
    assert_eq!(inputs[0]["params"]["type"], "mousePressed");
    assert_eq!(inputs[1]["params"]["type"], "mouseReleased");
    assert_eq!(inputs[1]["params"]["clickCount"], 0);
}

#[test]
fn rejected_mouse_press_still_attempts_release_without_masking_protocol_error() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    engine.primary_session = Some("primary".to_string());
    engine.current_url = "https://allowed.example/".to_string();
    let element_ref = engine.elements.insert(42).unwrap();
    let inbox = inbox_ending_with_error(6, |id| {
        if id == 2 {
            serde_json::json!({
                "model": {"content": [0, 0, 10, 0, 10, 20, 0, 20]}
            })
        } else {
            serde_json::json!({})
        }
    });
    let (_, cancellation) = cancellable_operation();
    let mut output = Vec::new();
    let error = {
        let mut client = CdpClient::new(&mut output, inbox);
        engine
            .click(
                &mut client,
                &element_ref,
                &cancellation,
                Instant::now() + Duration::from_secs(1),
            )
            .unwrap_err()
    };

    assert_eq!(error.code, BackendFailureCode::ProtocolViolation);
    let input_types = parse_commands(&output)
        .into_iter()
        .filter(|command| command["method"] == "Input.dispatchMouseEvent")
        .map(|command| command["params"]["type"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(input_types, ["mousePressed", "mouseReleased"]);
}

#[test]
fn timed_out_replace_type_uses_an_independent_deadline_to_release_keyboard_input() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    engine.primary_session = Some("primary".to_string());
    engine.current_url = "https://allowed.example/".to_string();
    let element_ref = engine.elements.insert(42).unwrap();
    let inbox = inbox_with_responses(|_| serde_json::json!({}));
    let (_, cancellation) = cancellable_operation();
    let deadline = Instant::now() + Duration::from_millis(250);
    let mut output = DelayOnInput {
        bytes: Vec::new(),
        method: "Input.dispatchKeyEvent",
        event_type: "keyDown",
        deadline,
        triggered: false,
    };
    let error = {
        let mut client = CdpClient::new(&mut output, inbox);
        engine
            .type_text(
                &mut client,
                &element_ref,
                "replacement",
                true,
                &cancellation,
                deadline,
            )
            .unwrap_err()
    };

    assert_eq!(error.code, BackendFailureCode::TimedOut);
    let key_types = parse_commands(&output.bytes)
        .into_iter()
        .filter(|command| command["method"] == "Input.dispatchKeyEvent")
        .map(|command| command["params"]["type"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(key_types, ["keyDown", "keyUp"]);
}

#[test]
fn rejected_key_up_is_retried_without_masking_the_original_protocol_error() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    engine.primary_session = Some("primary".to_string());
    engine.current_url = "https://allowed.example/".to_string();
    let element_ref = engine.elements.insert(42).unwrap();
    let inbox = inbox_ending_with_error(7, |_| serde_json::json!({}));
    let (_, cancellation) = cancellable_operation();
    let mut output = Vec::new();
    let error = {
        let mut client = CdpClient::new(&mut output, inbox);
        engine
            .type_text(
                &mut client,
                &element_ref,
                "replacement",
                true,
                &cancellation,
                Instant::now() + Duration::from_secs(1),
            )
            .unwrap_err()
    };

    assert_eq!(error.code, BackendFailureCode::ProtocolViolation);
    let key_types = parse_commands(&output)
        .into_iter()
        .filter(|command| command["method"] == "Input.dispatchKeyEvent")
        .map(|command| command["params"]["type"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(key_types, ["keyDown", "keyUp", "keyUp"]);
}

#[test]
fn initialization_owns_the_explicitly_created_page_when_the_profile_has_multiple_pages() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    let inbox = inbox_with_responses(|id| match id {
        3 => serde_json::json!({
            "targetId": "managed-target",
            "targetInfos": [
                {"targetId":"restored-a","type":"page","url":"https://a.example/"},
                {"targetId":"restored-b","type":"page","url":"https://b.example/"}
            ]
        }),
        4 => serde_json::json!({"sessionId":"session-1"}),
        16 => serde_json::json!({
            "targetInfos": [
                {"targetId":"restored-a","type":"page","url":"https://a.example/"},
                {"targetId":"managed-target","type":"page","url":"about:blank"},
                {"targetId":"restored-b","type":"page","url":"https://b.example/"},
                {"targetId":"service-worker","type":"service_worker","url":"https://b.example/sw.js"}
            ]
        }),
        17 | 18 => serde_json::json!({"success": true}),
        19 => serde_json::json!({
            "currentIndex":0,
            "entries":[{"url":"about:blank","title":""}]
        }),
        _ => serde_json::json!({}),
    });
    let mut output = Vec::new();
    let mut client = CdpClient::new(&mut output, inbox);

    engine
        .initialize(&mut client, Instant::now() + Duration::from_secs(1))
        .unwrap();
    let commands = parse_commands(&output);
    assert_eq!(commands[0]["method"], "Browser.setDownloadBehavior");
    assert_eq!(
        commands[0]["params"],
        serde_json::json!({"behavior":"deny","eventsEnabled":true})
    );
    assert!(commands
        .iter()
        .filter(|command| command["method"] == "Target.setAutoAttach")
        .all(|command| command["params"]["waitForDebuggerOnStart"] == true));
    let expected_target_filter = serde_json::json!([
        {"type":"page","exclude":false},
        {"type":"iframe","exclude":false},
        {"type":"worker","exclude":false},
        {"type":"service_worker","exclude":false},
        {"type":"shared_worker","exclude":false},
        {"type":"worklet","exclude":false},
        {"exclude":true}
    ]);
    assert!(commands
        .iter()
        .filter(|command| command["method"] == "Target.setAutoAttach")
        .all(|command| command["params"]["filter"] == expected_target_filter));
    assert_eq!(commands[2]["method"], "Target.createTarget");
    assert_eq!(commands[2]["params"]["url"], "about:blank");
    let attach = commands
        .iter()
        .find(|command| command["method"] == "Target.attachToTarget")
        .expect("the launch-owned target is attached explicitly");
    assert_eq!(attach["params"]["targetId"], "managed-target");

    let session_methods = commands
        .iter()
        .filter(|command| command["sessionId"] == "session-1")
        .map(|command| command["method"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        &session_methods[..10],
        [
            "Fetch.enable",
            "Target.setAutoAttach",
            "Page.setInterceptFileChooserDialog",
            "Page.enable",
            "Page.setLifecycleEventsEnabled",
            "Accessibility.enable",
            "DOM.enable",
            "Network.enable",
            "Runtime.enable",
            "Runtime.runIfWaitingForDebugger",
        ]
    );
    let resume_index = commands
        .iter()
        .position(|command| command["method"] == "Runtime.runIfWaitingForDebugger")
        .unwrap();
    let chooser_intercept_index = commands
        .iter()
        .position(|command| command["method"] == "Page.setInterceptFileChooserDialog")
        .expect("file chooser interception is installed for the target");
    assert!(chooser_intercept_index < resume_index);
    assert_eq!(
        commands[chooser_intercept_index]["params"],
        serde_json::json!({"enabled": true, "cancel": true})
    );
    assert!(!commands.iter().any(|command| {
        command["method"] == "Page.setInterceptFileChooserDialog"
            && command["params"]["enabled"] == false
    }));
    let enumerate_index = commands
        .iter()
        .position(|command| command["method"] == "Target.getTargets")
        .expect("non-primary pages are enumerated only after the primary target is secured");
    assert!(resume_index < enumerate_index);
    let closed_targets = commands
        .iter()
        .filter(|command| command["method"] == "Target.closeTarget")
        .map(|command| command["params"]["targetId"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(closed_targets, ["restored-a", "restored-b"]);
    assert!(!closed_targets.contains(&"managed-target"));
}

#[test]
fn download_deny_enables_events_and_projects_only_terminal_counters() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    let (_sender, inbox, _state) = super::super::transport::frame_channel();
    let mut output = Vec::new();
    let mut client = CdpClient::new(&mut output, inbox);

    for event in [
        CdpEvent {
            kind: CdpEventKind::DownloadWillBegin,
            params: serde_json::json!({
                "guid": "raw-download-guid",
                "url": "https://example.test/private?token=secret",
                "suggestedFilename": "secret.txt"
            }),
            session_id: None,
        },
        CdpEvent {
            kind: CdpEventKind::DownloadProgress,
            params: serde_json::json!({
                "guid": "raw-download-guid",
                "state": "canceled",
                "filePath": "/Users/alice/Downloads/secret.txt"
            }),
            session_id: None,
        },
    ] {
        engine.on_event(&mut client, event).unwrap();
    }

    let projection = engine.projection();
    assert_eq!(projection.blocked_download_count, 1);
    assert_eq!(projection.canceled_download_count, 1);
    let debug = format!("{projection:?}");
    for raw in [
        "raw-download-guid",
        "token=secret",
        "secret.txt",
        "/Users/alice",
    ] {
        assert!(!debug.contains(raw));
    }
}

fn navigation_url(result: SemanticBrowserResult) -> String {
    match result {
        SemanticBrowserResult::Navigation(result) => result.url,
        other => panic!("unexpected result: {other:?}"),
    }
}

#[test]
fn navigation_keeps_the_matching_redirect_commit_when_event_precedes_response() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    engine.primary_session = Some("primary".to_string());
    engine.current_url = "https://allowed.example/start".to_string();
    let inbox = inbox_with_frames([
        serde_json::json!({
            "method": "Page.frameNavigated",
            "sessionId": "primary",
            "params": {"frame": {
                "id": "main-frame",
                "loaderId": "loader-new",
                "url": "https://allowed.example/final"
            }}
        }),
        serde_json::json!({
            "id": 1,
            "result": {"frameId": "main-frame", "loaderId": "loader-new"}
        }),
    ]);
    let mut output = Vec::new();
    let mut client = CdpClient::new(&mut output, inbox);
    let (_control, cancellation) = cancellable_operation();

    let result = engine
        .navigate(
            &mut client,
            "https://allowed.example/redirect",
            &cancellation,
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();

    assert_eq!(navigation_url(result), "https://allowed.example/final");
    assert_eq!(engine.current_url, "https://allowed.example/final");
}

#[test]
fn navigation_waits_past_a_stale_loader_when_response_precedes_final_commit() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    engine.primary_session = Some("primary".to_string());
    engine.current_url = "https://allowed.example/start".to_string();
    let inbox = inbox_with_frames([
        serde_json::json!({
            "id": 1,
            "result": {"frameId": "main-frame", "loaderId": "loader-new"}
        }),
        serde_json::json!({
            "method": "Page.frameNavigated",
            "sessionId": "primary",
            "params": {"frame": {
                "id": "main-frame",
                "loaderId": "loader-old",
                "url": "https://allowed.example/stale"
            }}
        }),
        serde_json::json!({
            "method": "Page.frameNavigated",
            "sessionId": "primary",
            "params": {"frame": {
                "id": "main-frame",
                "loaderId": "loader-new",
                "url": "https://allowed.example/final"
            }}
        }),
    ]);
    let mut output = Vec::new();
    let mut client = CdpClient::new(&mut output, inbox);
    let (_control, cancellation) = cancellable_operation();

    let result = engine
        .navigate(
            &mut client,
            "https://allowed.example/redirect",
            &cancellation,
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();

    assert_eq!(navigation_url(result), "https://allowed.example/final");
    assert_eq!(engine.current_url, "https://allowed.example/final");
}

#[test]
fn agent_cancellation_cannot_interrupt_security_setup_for_a_paused_target() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    engine.queue_session("session-2".to_string()).unwrap();
    let inbox = inbox_with_responses(|_| serde_json::json!({}));
    let mut output = Vec::new();
    let mut client = CdpClient::new(&mut output, inbox);

    engine
        .flush_pending_sessions(
            &mut client,
            Instant::now() + Duration::from_secs(1),
            &cancelled_operation(),
        )
        .unwrap();
    assert!(engine.pending_sessions.is_empty());
    assert!(engine.configured_sessions.contains("session-2"));
    let methods = parse_commands(&output)
        .into_iter()
        .map(|command| command["method"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(methods.first().map(String::as_str), Some("Fetch.enable"));
    let chooser_intercept_index = methods
        .iter()
        .position(|method| method == "Page.setInterceptFileChooserDialog")
        .expect("cancelled Agent setup still installs file chooser interception");
    let resume_index = methods
        .iter()
        .position(|method| method == "Runtime.runIfWaitingForDebugger")
        .unwrap();
    assert!(chooser_intercept_index < resume_index);
    assert_eq!(
        methods.last().map(String::as_str),
        Some("Runtime.runIfWaitingForDebugger")
    );
}

#[test]
fn intercepted_file_chooser_is_projected_as_blocked_without_exposing_a_path_capability() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    engine.primary_session = Some("primary".to_string());
    engine.configured_sessions.insert("primary".to_string());
    let (_sender, inbox, _state) = super::super::transport::frame_channel();
    let mut output = Vec::new();
    let mut client = CdpClient::new(&mut output, inbox);

    engine
        .on_event(
            &mut client,
            CdpEvent {
                kind: CdpEventKind::FileChooserOpened,
                params: serde_json::json!({
                    "frameId": "main-frame",
                    "mode": "selectSingle",
                    "backendNodeId": 42,
                    "untrustedExtra": "/Users/alice/secret.txt"
                }),
                session_id: Some("primary".to_string()),
            },
        )
        .unwrap();

    let projection = engine.projection();
    assert_eq!(projection.blocked_file_chooser_count, 1);
    assert!(!format!("{projection:?}").contains("secret.txt"));
    assert!(
        output.is_empty(),
        "blocked chooser must not gain a file-path command"
    );
}

#[test]
fn failed_security_setup_keeps_the_target_pending_and_is_terminal() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    engine.queue_session("session-3".to_string()).unwrap();
    let (sender, inbox, state) = super::super::transport::frame_channel();
    let mut bytes = serde_json::to_vec(&serde_json::json!({
        "id":1,
        "error":{"code":-32000,"message":"rejected"}
    }))
    .unwrap();
    bytes.push(0);
    super::super::transport::run_frame_reader(&mut Cursor::new(bytes), sender, state);
    let mut output = Vec::new();
    let mut client = CdpClient::new(&mut output, inbox);

    let error = engine
        .flush_pending_sessions(
            &mut client,
            Instant::now() + Duration::from_secs(1),
            &NeverCancelled,
        )
        .unwrap_err();
    assert!(matches!(
        error.code,
        BackendFailureCode::ProtocolViolation | BackendFailureCode::RuntimeUnavailable
    ));
    assert_eq!(
        engine.pending_sessions.front().map(String::as_str),
        Some("session-3")
    );
    assert!(!engine.configured_sessions.contains("session-3"));
}

#[test]
fn only_the_primary_frame_current_loader_lifecycle_completes_a_load() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    engine.primary_session = Some("primary".to_string());
    engine.configured_sessions.insert("secondary".to_string());
    engine.pending_sessions.push_back("secondary".to_string());
    let (_sender, inbox, _state) = super::super::transport::frame_channel();
    let mut output = Vec::new();
    let mut client = CdpClient::new(&mut output, inbox);

    engine
        .on_event(
            &mut client,
            CdpEvent {
                kind: CdpEventKind::FrameNavigated,
                params: serde_json::json!({"frame": {
                    "id": "main-frame",
                    "loaderId": "loader-current",
                    "url": "https://allowed.example/current"
                }}),
                session_id: Some("primary".to_string()),
            },
        )
        .unwrap();
    assert_eq!(engine.load_generation, 0);
    for (session_id, frame_id, loader_id) in [
        ("popup", "main-frame", "loader-current"),
        ("primary", "child-frame", "loader-current"),
        ("primary", "main-frame", "loader-stale"),
    ] {
        engine
            .on_event(
                &mut client,
                CdpEvent {
                    kind: CdpEventKind::LifecycleEvent,
                    params: serde_json::json!({
                        "frameId": frame_id,
                        "loaderId": loader_id,
                        "name": "load"
                    }),
                    session_id: Some(session_id.to_string()),
                },
            )
            .unwrap();
    }
    // The legacy load event has no frame/loader identity and therefore cannot authorize a
    // completion for the document currently owned by the Agent.
    engine
        .on_event(
            &mut client,
            CdpEvent {
                kind: CdpEventKind::LoadEventFired,
                params: serde_json::json!({}),
                session_id: Some("primary".to_string()),
            },
        )
        .unwrap();
    assert_eq!(engine.load_generation, 0);
    engine
        .on_event(
            &mut client,
            CdpEvent {
                kind: CdpEventKind::LifecycleEvent,
                params: serde_json::json!({
                    "frameId": "main-frame",
                    "loaderId": "loader-current",
                    "name": "load"
                }),
                session_id: Some("primary".to_string()),
            },
        )
        .unwrap();
    assert_eq!(engine.load_generation, 1);

    // Duplicate lifecycle delivery is idempotent for the same committed loader.
    engine
        .on_event(
            &mut client,
            CdpEvent {
                kind: CdpEventKind::LifecycleEvent,
                params: serde_json::json!({
                    "frameId": "main-frame",
                    "loaderId": "loader-current",
                    "name": "load"
                }),
                session_id: Some("primary".to_string()),
            },
        )
        .unwrap();
    assert_eq!(engine.load_generation, 1);

    engine
        .on_event(
            &mut client,
            CdpEvent {
                kind: CdpEventKind::TargetDetached,
                params: serde_json::json!({"sessionId":"secondary"}),
                session_id: None,
            },
        )
        .unwrap();
    assert!(!engine.configured_sessions.contains("secondary"));
    assert!(!engine
        .pending_sessions
        .iter()
        .any(|value| value == "secondary"));
}

#[test]
fn navigation_or_target_generation_invalidates_old_element_refs() {
    let mut registry = ElementRegistry::new();
    let backend_node_id = u64::MAX;
    let reference = registry.insert(backend_node_id).unwrap();
    assert_eq!(registry.resolve(&reference).unwrap(), backend_node_id);
    registry.invalidate();
    assert_eq!(
        registry.resolve(&reference).unwrap_err().code,
        BackendFailureCode::InvalidSemanticReference
    );
    assert!(!reference.contains(&backend_node_id.to_string()));
}

#[test]
fn box_model_center_uses_only_numeric_dom_geometry() {
    assert_eq!(
        box_center(&serde_json::json!({
            "model": {"content": [0, 0, 10, 0, 10, 20, 0, 20]}
        })),
        Some((5.0, 10.0))
    );
    assert!(box_center(&serde_json::json!({"model":{"content":[0]}})).is_none());
}

#[test]
fn document_interception_distinguishes_redirect_popup_and_iframe() {
    assert_eq!(
        classify_document_surface(Some("primary"), Some("primary"), Some("main"), Some("main")),
        TrustedNavigationSurface::Redirect
    );
    assert_eq!(
        classify_document_surface(Some("popup"), Some("primary"), Some("main"), Some("main")),
        TrustedNavigationSurface::Popup
    );
    assert_eq!(
        classify_document_surface(
            Some("primary"),
            Some("primary"),
            Some("child"),
            Some("main")
        ),
        TrustedNavigationSurface::Iframe
    );
}
