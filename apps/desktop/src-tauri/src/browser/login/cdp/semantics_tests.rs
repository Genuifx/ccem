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
fn cef_admitted_allowed_oauth_popup_remains_open_during_agent_control() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    engine.primary_target = Some("primary".to_string());
    let (_sender, inbox, _state) = super::super::transport::frame_channel();
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
                    "url":"https://accounts.example.test/oauth/authorize"
                }}),
                session_id: None,
            },
        )
        .unwrap();
    drop(client);

    assert!(output.is_empty());
}

#[test]
fn admitted_oauth_popup_blank_bootstrap_waits_for_its_guarded_https_destination() {
    use crate::browser::login::policy::BrowserGrantBinding;
    use crate::browser::login::session_policy::SessionNavigationPolicy;

    for bootstrap_url in ["", "about:blank", "about:blank#oauth"] {
        let temp = tempfile::tempdir().unwrap();
        let policy = Arc::new(SessionNavigationPolicy::new());
        policy
            .activate(BrowserGrantBinding::new_trusted("w", "p", "s", 1).expect("browser binding"))
            .expect("active Agent browser policy");
        let mut engine = SemanticEngine::new(
            policy,
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
        );
        engine.primary_target = Some("primary".to_string());
        let inbox = inbox_with_responses(|_| serde_json::json!({"success":true}));
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
                        "url": bootstrap_url
                    }}),
                    session_id: None,
                },
            )
            .unwrap();
        engine
            .on_event(
                &mut client,
                CdpEvent {
                    kind: CdpEventKind::TargetInfoChanged,
                    params: serde_json::json!({"targetInfo":{
                        "targetId":"popup",
                        "type":"page",
                        "url":"https://accounts.example.test/oauth/authorize"
                    }}),
                    session_id: None,
                },
            )
            .unwrap();
        drop(client);

        assert!(
            output.is_empty(),
            "blank popup bootstrap must not be closed before its guarded HTTPS destination: {bootstrap_url:?}"
        );
    }
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
    let inputs = parse_commands(&output.bytes)
        .into_iter()
        .filter(|command| command["method"] == "Input.dispatchMouseEvent")
        .collect::<Vec<_>>();
    assert_eq!(inputs.len(), 2);
    assert_eq!(inputs[0]["params"]["type"], "mousePressed");
    assert_eq!(inputs[1]["params"]["type"], "mouseReleased");
    assert_eq!(inputs[1]["params"]["x"], inputs[0]["params"]["x"]);
    assert_eq!(inputs[1]["params"]["y"], inputs[0]["params"]["y"]);
    assert_eq!(inputs[1]["params"]["buttons"], 0);
    assert_eq!(inputs[1]["params"]["clickCount"], 0);
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
    let key_commands = parse_commands(&output.bytes)
        .into_iter()
        .filter(|command| command["method"] == "Input.dispatchKeyEvent")
        .collect::<Vec<_>>();
    assert_eq!(
        key_commands[0]["params"]["commands"],
        serde_json::json!(["selectAll"]),
        "replace typing must ask Chromium's editor to select all instead of relying only on an \
         underspecified synthetic platform shortcut"
    );
    let keys = key_commands
        .iter()
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
fn press_key_dispatches_one_fixed_down_up_pair() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    engine.primary_session = Some("primary".to_string());
    engine.current_url = "https://allowed.example/".to_string();
    let inbox = inbox_with_responses(|_| serde_json::json!({}));
    let (_, cancellation) = cancellable_operation();
    let mut output = Vec::new();
    let result = {
        let mut client = CdpClient::new(&mut output, inbox);
        engine.press_key(
            &mut client,
            SemanticKey::Enter,
            &cancellation,
            Instant::now() + Duration::from_secs(1),
        )
    }
    .unwrap();

    assert_eq!(
        result,
        SemanticBrowserResult::Action(ActionResult { completed: true })
    );
    let inputs = parse_commands(&output)
        .into_iter()
        .filter(|command| command["method"] == "Input.dispatchKeyEvent")
        .collect::<Vec<_>>();
    assert_eq!(inputs.len(), 2);
    assert_eq!(inputs[0]["params"]["type"], "keyDown");
    assert_eq!(inputs[0]["params"]["key"], "Enter");
    assert_eq!(inputs[0]["params"]["code"], "Enter");
    assert_eq!(inputs[0]["params"]["windowsVirtualKeyCode"], 13);
    assert_eq!(inputs[0]["params"]["text"], "\r");
    assert_eq!(inputs[0]["params"]["unmodifiedText"], "\r");
    assert_eq!(inputs[1]["params"]["type"], "keyUp");
    assert!(inputs[1]["params"].get("text").is_none());
    assert!(inputs[1]["params"].get("unmodifiedText").is_none());
}

#[test]
fn enter_navigation_after_key_down_finishes_once_without_reporting_a_retryable_failure() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    engine.primary_session = Some("primary".to_string());
    engine.current_url = "https://allowed.example/form".to_string();
    let history = serde_json::json!({
        "currentIndex": 0,
        "entries": [{"url":"https://allowed.example/form","title":"Form"}]
    });
    let inbox = inbox_with_frames([
        serde_json::json!({"id":1,"result":history.clone()}),
        serde_json::json!({"id":2,"result":history}),
        serde_json::json!({"id":3,"result":{}}),
        serde_json::json!({
            "method":"Page.frameNavigated",
            "sessionId":"primary",
            "params":{"frame":{
                "id":"main-frame",
                "loaderId":"submitted-loader",
                "url":"https://allowed.example/submitted"
            }}
        }),
        serde_json::json!({"id":4,"result":{}}),
        serde_json::json!({"id":5,"result":{}}),
    ]);
    let (_, cancellation) = cancellable_operation();
    let mut output = Vec::new();
    let result = {
        let mut client = CdpClient::new(&mut output, inbox);
        engine.press_key(
            &mut client,
            SemanticKey::Enter,
            &cancellation,
            Instant::now() + Duration::from_secs(1),
        )
    }
    .expect("an Enter submission that already navigated is completed, not retryable");

    assert_eq!(
        result,
        SemanticBrowserResult::Action(ActionResult { completed: true })
    );
    let commands = parse_commands(&output);
    let key_types = commands
        .iter()
        .filter(|command| command["method"] == "Input.dispatchKeyEvent")
        .map(|command| command["params"]["type"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(key_types, ["keyDown", "keyUp"]);
    assert_eq!(
        commands
            .iter()
            .filter(|command| command["method"] == "Page.getNavigationHistory")
            .count(),
        2,
        "do not insert a stale-document barrier between the committed Enter down/up pair"
    );
}

#[test]
fn scroll_queries_css_viewport_and_dispatches_one_wheel_event_at_its_center() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    engine.primary_session = Some("primary".to_string());
    engine.current_url = "https://allowed.example/".to_string();
    let inbox = inbox_with_responses(|id| {
        if id == 2 {
            serde_json::json!({
                "cssVisualViewport": {
                    "clientWidth": 1200.0,
                    "clientHeight": 800.0
                }
            })
        } else {
            serde_json::json!({})
        }
    });
    let (_, cancellation) = cancellable_operation();
    let mut output = Vec::new();
    let result = {
        let mut client = CdpClient::new(&mut output, inbox);
        engine.scroll(
            &mut client,
            -600,
            &cancellation,
            Instant::now() + Duration::from_secs(1),
        )
    }
    .unwrap();

    assert_eq!(
        result,
        SemanticBrowserResult::Action(ActionResult { completed: true })
    );
    let commands = parse_commands(&output);
    assert_eq!(
        commands
            .iter()
            .map(|command| command["method"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "Page.getNavigationHistory",
            "Page.getLayoutMetrics",
            "Page.getNavigationHistory",
            "Input.dispatchMouseEvent",
        ],
        "the exact document must be revalidated after reading metrics and before the wheel event"
    );
    let inputs = commands
        .into_iter()
        .filter(|command| command["method"] == "Input.dispatchMouseEvent")
        .collect::<Vec<_>>();
    assert_eq!(inputs.len(), 1);
    assert_eq!(inputs[0]["params"]["type"], "mouseWheel");
    assert_eq!(inputs[0]["params"]["x"], 600.0);
    assert_eq!(inputs[0]["params"]["y"], 400.0);
    assert_eq!(inputs[0]["params"]["deltaY"], -600);
    assert_eq!(inputs[0]["params"]["deltaX"], 0);
}

#[test]
fn scroll_rejects_navigation_observed_while_waiting_for_metrics_before_wheel() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    engine.primary_session = Some("primary".to_string());
    engine.current_url = "https://allowed.example/feed".to_string();
    let history_and_metrics = serde_json::json!({
        "currentIndex": 0,
        "entries": [{"url":"https://allowed.example/feed","title":"Feed"}],
        "cssVisualViewport": {
            "clientWidth": 1200.0,
            "clientHeight": 800.0
        }
    });
    let inbox = inbox_with_frames([
        serde_json::json!({"id":1,"result":history_and_metrics.clone()}),
        serde_json::json!({
            "method":"Page.frameNavigated",
            "sessionId":"primary",
            "params":{"frame":{
                "id":"main-frame",
                "loaderId":"metrics-race-navigation",
                "url":"https://allowed.example/next"
            }}
        }),
        serde_json::json!({"id":2,"result":history_and_metrics.clone()}),
        serde_json::json!({"id":3,"result":history_and_metrics}),
        serde_json::json!({"id":4,"result":{}}),
    ]);
    let (_, cancellation) = cancellable_operation();
    let mut output = Vec::new();
    let error = {
        let mut client = CdpClient::new(&mut output, inbox);
        engine
            .scroll(
                &mut client,
                600,
                &cancellation,
                Instant::now() + Duration::from_secs(1),
            )
            .expect_err("navigation observed before the wheel write must supersede the scroll")
    };

    assert_eq!(error.code, BackendFailureCode::InvalidSemanticReference);
    let commands = parse_commands(&output);
    assert_eq!(
        commands
            .iter()
            .map(|command| command["method"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "Page.getNavigationHistory",
            "Page.getLayoutMetrics",
            "Page.getNavigationHistory",
        ],
        "the navigation must be observed during metrics before the pre-effect revalidation",
    );
    assert_eq!(
        commands
            .iter()
            .filter(|command| command["method"] == "Input.dispatchMouseEvent")
            .count(),
        0,
        "a stale document must not receive the wheel effect",
    );
}

#[test]
fn scroll_navigation_after_wheel_effect_completes_once_without_retryable_failure() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    engine.primary_session = Some("primary".to_string());
    engine.current_url = "https://allowed.example/feed".to_string();
    let history = serde_json::json!({
        "currentIndex": 0,
        "entries": [{"url":"https://allowed.example/feed","title":"Feed"}]
    });
    let inbox = inbox_with_frames([
        serde_json::json!({"id":1,"result":history.clone()}),
        serde_json::json!({
            "id":2,
            "result":{
                "cssVisualViewport": {
                    "clientWidth": 1200.0,
                    "clientHeight": 800.0
                }
            }
        }),
        serde_json::json!({"id":3,"result":history}),
        serde_json::json!({
            "method":"Page.frameNavigated",
            "sessionId":"primary",
            "params":{"frame":{
                "id":"main-frame",
                "loaderId":"wheel-navigation",
                "url":"https://allowed.example/next"
            }}
        }),
        serde_json::json!({"id":4,"result":{}}),
        serde_json::json!({"id":5,"result":{}}),
    ]);
    let (_, cancellation) = cancellable_operation();
    let mut output = Vec::new();
    let result = {
        let mut client = CdpClient::new(&mut output, inbox);
        engine.scroll(
            &mut client,
            600,
            &cancellation,
            Instant::now() + Duration::from_secs(1),
        )
    }
    .expect("a wheel effect that already navigated is completed, not retryable");

    assert_eq!(
        result,
        SemanticBrowserResult::Action(ActionResult { completed: true })
    );
    let commands = parse_commands(&output);
    assert_eq!(
        commands
            .iter()
            .filter(|command| command["method"] == "Input.dispatchMouseEvent")
            .count(),
        1,
        "the committed wheel effect must not be retried"
    );
    assert_eq!(
        commands
            .iter()
            .filter(|command| command["method"] == "Page.getNavigationHistory")
            .count(),
        2,
        "navigation after the wheel effect must not trigger a stale-document barrier"
    );
}

#[test]
fn scroll_fails_before_input_when_css_viewport_metrics_are_unavailable_or_unsafe() {
    let malformed_metrics = [
        serde_json::json!({}),
        serde_json::json!({"cssVisualViewport": {}}),
        serde_json::json!({
            "cssVisualViewport": {"clientWidth": 0.0, "clientHeight": 800.0}
        }),
        serde_json::json!({
            "cssVisualViewport": {"clientWidth": 1200.0, "clientHeight": -1.0}
        }),
        serde_json::json!({
            "cssVisualViewport": {"clientWidth": 1.0e20, "clientHeight": 800.0}
        }),
        serde_json::json!({
            "cssVisualViewport": {"clientWidth": "1200", "clientHeight": 800.0}
        }),
    ];

    for metrics in malformed_metrics {
        let temp = tempfile::tempdir().unwrap();
        let mut engine = test_engine(&temp);
        engine.primary_session = Some("primary".to_string());
        engine.current_url = "https://allowed.example/".to_string();
        let inbox = inbox_with_responses(|id| {
            if id == 2 {
                metrics.clone()
            } else {
                serde_json::json!({})
            }
        });
        let (_, cancellation) = cancellable_operation();
        let mut output = Vec::new();
        let error = {
            let mut client = CdpClient::new(&mut output, inbox);
            engine
                .scroll(
                    &mut client,
                    600,
                    &cancellation,
                    Instant::now() + Duration::from_secs(1),
                )
                .unwrap_err()
        };

        assert_eq!(error.code, BackendFailureCode::ProtocolViolation);
        assert!(error.to_string().contains("viewport metrics"));
        let commands = parse_commands(&output);
        assert_eq!(commands.last().unwrap()["method"], "Page.getLayoutMetrics");
        assert!(
            commands
                .iter()
                .all(|command| command["method"] != "Input.dispatchMouseEvent"),
            "malformed viewport metrics must fail before any wheel effect"
        );
    }
}

#[test]
fn evaluate_uses_only_fixed_return_by_value_await_promise_runtime_call() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    engine.primary_session = Some("primary".to_string());
    engine.current_url = "https://allowed.example/".to_string();
    let inbox = inbox_with_responses(|id| {
        if id == 3 {
            serde_json::json!({"result":{"type":"object","value":{"ok":true}}})
        } else {
            serde_json::json!({})
        }
    });
    let (_, cancellation) = cancellable_operation();
    let mut output = Vec::new();
    let result = {
        let mut client = CdpClient::new(&mut output, inbox);
        engine.evaluate(
            &mut client,
            "Promise.resolve({ ok: true })",
            &cancellation,
            Instant::now() + Duration::from_secs(1),
        )
    }
    .unwrap();

    assert_eq!(
        result,
        SemanticBrowserResult::Evaluation(EvaluationResult {
            value: serde_json::json!({"ok":true}),
            untrusted: true,
        })
    );
    let commands = parse_commands(&output);
    let evaluate = commands
        .iter()
        .find(|command| command["method"] == "Runtime.evaluate")
        .unwrap();
    assert_eq!(
        evaluate["params"]["expression"],
        "Promise.resolve({ ok: true })"
    );
    assert_eq!(evaluate["params"]["returnByValue"], true);
    assert_eq!(evaluate["params"]["awaitPromise"], true);
    assert!(evaluate["params"]["timeout"]
        .as_u64()
        .is_some_and(|timeout| timeout > 0 && timeout < 1_000));
    assert!(evaluate["params"].get("objectGroup").is_none());
}

#[test]
fn evaluate_navigation_after_script_effect_returns_once_without_retryable_failure() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    engine.primary_session = Some("primary".to_string());
    engine.current_url = "https://allowed.example/start".to_string();
    let history = serde_json::json!({
        "currentIndex": 0,
        "entries": [{"url":"https://allowed.example/start","title":"Start"}]
    });
    let inbox = inbox_with_frames([
        serde_json::json!({"id":1,"result":history.clone()}),
        serde_json::json!({"id":2,"result":history}),
        serde_json::json!({
            "method":"Page.frameNavigated",
            "sessionId":"primary",
            "params":{"frame":{
                "id":"main-frame",
                "loaderId":"script-navigation",
                "url":"https://allowed.example/next"
            }}
        }),
        serde_json::json!({
            "id":3,
            "result":{"result":{"type":"string","value":"navigation-started"}}
        }),
        serde_json::json!({"id":4,"result":{}}),
    ]);
    let (_, cancellation) = cancellable_operation();
    let mut output = Vec::new();
    let result = {
        let mut client = CdpClient::new(&mut output, inbox);
        engine.evaluate(
            &mut client,
            "location.href = 'https://allowed.example/next'; 'navigation-started'",
            &cancellation,
            Instant::now() + Duration::from_secs(1),
        )
    }
    .expect("a script effect that already navigated returns its result, not a retryable failure");

    assert_eq!(
        result,
        SemanticBrowserResult::Evaluation(EvaluationResult {
            value: Value::String("navigation-started".to_string()),
            untrusted: true,
        })
    );
    let commands = parse_commands(&output);
    assert_eq!(
        commands
            .iter()
            .filter(|command| command["method"] == "Runtime.evaluate")
            .count(),
        1,
        "the committed script effect must not be retried"
    );
    assert_eq!(
        commands
            .iter()
            .filter(|command| command["method"] == "Page.getNavigationHistory")
            .count(),
        2,
        "navigation after the script effect must not trigger a stale-document barrier"
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
fn rejected_committed_key_up_is_not_duplicated_and_preserves_protocol_error() {
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
    assert_eq!(key_types, ["keyDown", "keyUp"]);
}

#[test]
fn initialization_owns_the_explicitly_created_page_when_the_profile_has_multiple_pages() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    let inbox = inbox_with_responses(|id| match id {
        2 => serde_json::json!({
            "targetId": "managed-target",
            "targetInfos": [
                {"targetId":"restored-a","type":"page","url":"https://a.example/"},
                {"targetId":"restored-b","type":"page","url":"https://b.example/"}
            ]
        }),
        3 => serde_json::json!({"sessionId":"session-1"}),
        14 => serde_json::json!({
            "targetInfos": [
                {"targetId":"restored-a","type":"page","url":"https://a.example/"},
                {"targetId":"managed-target","type":"page","url":"about:blank"},
                {"targetId":"restored-b","type":"page","url":"https://b.example/"},
                {"targetId":"service-worker","type":"service_worker","url":"https://b.example/sw.js"}
            ]
        }),
        15 | 16 => serde_json::json!({"success": true}),
        17 => serde_json::json!({
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
    assert!(!commands
        .iter()
        .any(|command| command["method"] == "Browser.setDownloadBehavior"));
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
    assert_eq!(commands[1]["method"], "Target.createTarget");
    assert_eq!(commands[1]["params"]["url"], "about:blank");
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
        &session_methods[..9],
        [
            "Fetch.enable",
            "Target.setAutoAttach",
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
    assert!(!commands
        .iter()
        .any(|command| { command["method"] == "Page.setInterceptFileChooserDialog" }));
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
fn embedded_initialization_attaches_the_current_cef_page_without_creating_or_closing_targets() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = SemanticEngine::new_for_existing_target(
        Arc::new(AllowNavigation),
        CdpArtifactStore::new(temp.path().join("artifacts")).unwrap(),
        NetworkEventRecorder::new(
            temp.path().join("network"),
            "session-cef".to_string(),
            NetworkRedactionConfig::default(),
        )
        .unwrap(),
        ConsoleEventRecorder::new(
            temp.path().join("network"),
            "session-cef".to_string(),
            NetworkRedactionConfig::default(),
        )
        .unwrap(),
    );
    let inbox = inbox_with_responses(|id| match id {
        1 => serde_json::json!({
            "targetInfo": {
                "targetId": "cef-current-page",
                "type": "page",
                "title": "Login",
                "url": "https://login.example/",
                "attached": true
            }
        }),
        2 => serde_json::json!({"sessionId":"cef-session"}),
        12 => serde_json::json!({
            "currentIndex": 0,
            "entries": [{"url":"https://login.example/","title":"Login"}]
        }),
        _ => serde_json::json!({}),
    });
    let mut output = Vec::new();
    let mut client = CdpClient::new(&mut output, inbox);

    engine
        .initialize(&mut client, Instant::now() + Duration::from_secs(1))
        .unwrap();

    let commands = parse_commands(&output);
    assert_eq!(commands[0]["method"], "Target.getTargetInfo");
    assert!(
        !commands
            .iter()
            .any(|command| command["method"] == "Target.setDiscoverTargets"),
        "an embedded CEF owner must not subscribe to sibling Browser targets in the shared Profile"
    );
    let embedded_auto_attach = commands
        .iter()
        .filter(|command| command["method"] == "Target.setAutoAttach")
        .collect::<Vec<_>>();
    assert_eq!(
        embedded_auto_attach.len(),
        1,
        "the exact CEF page must install one session-scoped auto-attach boundary"
    );
    assert_eq!(
        embedded_auto_attach[0]["sessionId"], "cef-session",
        "embedded auto-attach must be scoped to the exact current CEF page"
    );
    let attach = commands
        .iter()
        .find(|command| command["method"] == "Target.attachToTarget")
        .expect("current CEF page is attached explicitly");
    assert_eq!(attach["params"]["targetId"], "cef-current-page");
    assert!(!commands.iter().any(|command| {
        matches!(
            command["method"].as_str(),
            Some("Target.createTarget" | "Target.closeTarget" | "Target.getTargets")
        )
    }));
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
    let resume_index = methods
        .iter()
        .position(|method| method == "Runtime.runIfWaitingForDebugger")
        .unwrap();
    assert!(!methods
        .iter()
        .any(|method| method == "Page.setInterceptFileChooserDialog"));
    assert!(resume_index > 0);
    assert_eq!(
        methods.last().map(String::as_str),
        Some("Runtime.runIfWaitingForDebugger")
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
