use super::super::transport;
use super::tests::test_engine;
use super::*;
use crate::browser::login::control::{
    ControlErrorCode, HandoffControl, HandoffGrant, LoginBrowserControl, OperationCancellation,
};
use crate::browser::login::policy::BrowserGrantBinding;
use std::io::{Error, ErrorKind, Write};
use std::sync::{mpsc, Arc, Mutex};

fn cancellable_operation() -> (Arc<LoginBrowserControl>, OperationCancellation) {
    let binding = BrowserGrantBinding::new_trusted("w", "p", "s", 1).unwrap();
    let control = Arc::new(LoginBrowserControl::new());
    control
        .activate_handoff(HandoffGrant::new_trusted(binding.clone()))
        .unwrap();
    let cancellation = control.begin_operation(&binding, true).unwrap();
    (control, cancellation)
}

fn inbox_with_responses(mut response_for: impl FnMut(u64) -> Value) -> transport::FrameInbox {
    let (sender, inbox, state) = transport::frame_channel();
    for id in 1..=20 {
        let value = serde_json::json!({"id": id, "result": response_for(id)});
        let byte_len = serde_json::to_vec(&value).unwrap().len();
        assert!(state.reserve_bytes(byte_len, usize::MAX));
        sender
            .send(transport::FrameEnvelope { value, byte_len })
            .unwrap();
    }
    inbox
}

fn input_commands(bytes: &[u8]) -> Vec<Value> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|frame| !frame.is_empty())
        .map(|frame| serde_json::from_slice(frame).unwrap())
        .filter(|command: &Value| command["method"] == "Input.dispatchMouseEvent")
        .collect()
}

struct NoopHandler;

impl transport::ProtocolEventHandler for NoopHandler {
    fn on_event(
        &mut self,
        _client: &mut CdpClient<'_>,
        _event: CdpEvent,
    ) -> Result<(), BackendFailure> {
        Ok(())
    }
}

struct CancelOnMouseRelease {
    bytes: Vec<u8>,
    control: Arc<LoginBrowserControl>,
}

impl Write for CancelOnMouseRelease {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.bytes.extend_from_slice(bytes);
        if bytes.ends_with(&[0]) {
            let command: Value = serde_json::from_slice(&bytes[..bytes.len() - 1]).unwrap();
            if command["method"] == "Input.dispatchMouseEvent"
                && command["params"]["type"] == "mouseReleased"
                && command["params"]["clickCount"] == 1
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
fn cancellation_after_release_commit_emits_exactly_one_matching_release() {
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
    let mut output = CancelOnMouseRelease {
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
    let inputs = input_commands(&output.bytes);
    assert_eq!(inputs.len(), 2);
    assert_eq!(inputs[0]["params"]["type"], "mousePressed");
    assert_eq!(inputs[1]["params"]["type"], "mouseReleased");
    assert_eq!(inputs[1]["params"]["x"], inputs[0]["params"]["x"]);
    assert_eq!(inputs[1]["params"]["y"], inputs[0]["params"]["y"]);
    assert_eq!(inputs[1]["params"]["clickCount"], 1);
    assert!(
        inputs
            .iter()
            .all(|command| command["params"]["clickCount"] != 0),
        "a committed normal release must not be followed by a safety release"
    );
}

struct BlockingSafetyReleaseWriter {
    commands: Arc<Mutex<Vec<Value>>>,
    sender: mpsc::SyncSender<transport::FrameEnvelope>,
    state: Arc<transport::ReaderState>,
    down_committed: Option<mpsc::Sender<()>>,
    safety_started: Option<mpsc::Sender<()>>,
    allow_safety: mpsc::Receiver<()>,
}

impl BlockingSafetyReleaseWriter {
    fn enqueue_response(&self, id: u64, result: Value) {
        let value = serde_json::json!({"id": id, "result": result});
        let byte_len = serde_json::to_vec(&value).unwrap().len();
        assert!(self.state.reserve_bytes(byte_len, usize::MAX));
        self.sender
            .send(transport::FrameEnvelope { value, byte_len })
            .unwrap();
    }
}

impl Write for BlockingSafetyReleaseWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let command: Value = serde_json::from_slice(&bytes[..bytes.len() - 1]).unwrap();
        self.commands.lock().unwrap().push(command.clone());
        let id = command["id"].as_u64().unwrap();
        match (
            command["method"].as_str(),
            command["params"]["type"].as_str(),
            command["params"]["clickCount"].as_u64(),
        ) {
            (Some("Input.dispatchMouseEvent"), Some("mousePressed"), Some(1)) => {
                self.down_committed.take().unwrap().send(()).unwrap();
            }
            (Some("Input.dispatchMouseEvent"), Some("mouseReleased"), Some(0)) => {
                self.safety_started.take().unwrap().send(()).unwrap();
                self.allow_safety
                    .recv_timeout(Duration::from_secs(1))
                    .expect("release safety cleanup");
                self.enqueue_response(id, serde_json::json!({}));
            }
            (Some("DOM.getBoxModel"), _, _) => self.enqueue_response(
                id,
                serde_json::json!({
                    "model": {"content": [0, 0, 10, 0, 10, 20, 0, 20]}
                }),
            ),
            _ => self.enqueue_response(id, serde_json::json!({})),
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[test]
fn pause_ack_waits_until_bound_safety_release_finishes() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    engine.primary_session = Some("primary".to_string());
    engine.current_url = "https://allowed.example/".to_string();
    let element_ref = engine.elements.insert(42).unwrap();
    let (sender, inbox, state) = transport::frame_channel();
    let commands = Arc::new(Mutex::new(Vec::new()));
    let (down_tx, down_rx) = mpsc::channel();
    let (safety_tx, safety_rx) = mpsc::channel();
    let (allow_safety_tx, allow_safety_rx) = mpsc::channel();
    let (control, cancellation) = cancellable_operation();
    let mut writer = BlockingSafetyReleaseWriter {
        commands: Arc::clone(&commands),
        sender,
        state,
        down_committed: Some(down_tx),
        safety_started: Some(safety_tx),
        allow_safety: allow_safety_rx,
    };
    let owner = cancellation.enter_owner_execution().unwrap();
    let (worker_tx, worker_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _owner = owner;
        let mut client = CdpClient::new(&mut writer, inbox);
        let result = engine.click(
            &mut client,
            &element_ref,
            &cancellation,
            Instant::now() + Duration::from_secs(1),
        );
        worker_tx.send(result).unwrap();
    });

    down_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("mouse down committed");
    let (pause_tx, pause_rx) = mpsc::channel();
    let pause_control = Arc::clone(&control);
    std::thread::spawn(move || {
        pause_tx.send(pause_control.set_paused(true)).unwrap();
    });
    if safety_rx.recv_timeout(Duration::from_millis(200)).is_err() {
        let _ = allow_safety_tx.send(());
        panic!("safety release did not start before the pause acknowledgement deadline");
    }
    assert!(
        pause_rx.try_recv().is_err(),
        "pause must not acknowledge while the safety release is blocked"
    );

    allow_safety_tx.send(()).unwrap();
    let error = worker_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("semantic operation stopped")
        .unwrap_err();
    assert_eq!(error.code, BackendFailureCode::Cancelled);
    pause_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("pause returned after cleanup")
        .expect("pause acknowledged");

    let inputs = commands
        .lock()
        .unwrap()
        .iter()
        .filter(|command| command["method"] == "Input.dispatchMouseEvent")
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(inputs.len(), 2);
    assert_eq!(inputs[0]["params"]["type"], "mousePressed");
    assert_eq!(inputs[1]["params"]["type"], "mouseReleased");
    assert_eq!(inputs[1]["params"]["clickCount"], 0);
    assert_eq!(inputs[1]["params"]["buttons"], 0);
}

#[derive(Clone, Copy)]
enum SafetyReleaseFault {
    WriterFailure,
    ResponseTimeout,
}

struct FaultingSafetyReleaseWriter {
    fault: SafetyReleaseFault,
    commands: Arc<Mutex<Vec<Value>>>,
    sender: mpsc::SyncSender<transport::FrameEnvelope>,
    state: Arc<transport::ReaderState>,
}

impl FaultingSafetyReleaseWriter {
    fn enqueue_response(&self, id: u64) {
        let value = serde_json::json!({"id": id, "result": {}});
        let byte_len = serde_json::to_vec(&value).unwrap().len();
        assert!(self.state.reserve_bytes(byte_len, usize::MAX));
        self.sender
            .send(transport::FrameEnvelope { value, byte_len })
            .unwrap();
    }
}

impl Write for FaultingSafetyReleaseWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let command: Value = serde_json::from_slice(&bytes[..bytes.len() - 1]).unwrap();
        self.commands.lock().unwrap().push(command.clone());
        let id = command["id"].as_u64().unwrap();
        if command["params"]["type"] == "mouseReleased" && command["params"]["clickCount"] == 0 {
            return match self.fault {
                SafetyReleaseFault::WriterFailure => {
                    Err(Error::new(ErrorKind::BrokenPipe, "release writer fault"))
                }
                SafetyReleaseFault::ResponseTimeout => Ok(bytes.len()),
            };
        }
        self.enqueue_response(id);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn exercise_unconfirmed_safety_release(
    fault: SafetyReleaseFault,
) -> (BackendFailureCode, ControlErrorCode, Duration, Vec<Value>) {
    let (control, cancellation) = cancellable_operation();
    let owner = cancellation.enter_owner_execution().unwrap();
    let (sender, inbox, state) = transport::frame_channel();
    let commands = Arc::new(Mutex::new(Vec::new()));
    let mut writer = FaultingSafetyReleaseWriter {
        fault,
        commands: Arc::clone(&commands),
        sender,
        state,
    };
    let started = Instant::now();
    let release_error = {
        let mut client = CdpClient::new(&mut writer, inbox);
        let (_, sequence) = client
            .begin_input_sequence(
                CdpMethod::InputDispatchMouseEvent,
                serde_json::json!({
                    "type": "mousePressed",
                    "x": 10.0,
                    "y": 20.0,
                    "button": "left",
                    "clickCount": 1
                }),
                "primary",
                Instant::now() + Duration::from_secs(2),
                &cancellation,
                &mut NoopHandler,
            )
            .unwrap();
        client
            .abort_input_sequence(sequence, &mut NoopHandler)
            .unwrap_err()
    };
    let elapsed = started.elapsed();
    drop(owner);
    let retired = control.revoke_handoff().unwrap();
    let acknowledgement_error = control
        .wait_for_quiescence(&retired, Duration::from_millis(25))
        .unwrap_err();
    drop(writer);
    let commands = Arc::try_unwrap(commands).unwrap().into_inner().unwrap();
    (
        release_error.code,
        acknowledgement_error.code,
        elapsed,
        commands,
    )
}

#[test]
fn safety_release_writer_failure_marks_the_bound_effect_fence_unsafe() {
    let (release, acknowledgement, elapsed, commands) =
        exercise_unconfirmed_safety_release(SafetyReleaseFault::WriterFailure);

    assert_eq!(release, BackendFailureCode::RuntimeUnavailable);
    assert_eq!(acknowledgement, ControlErrorCode::EffectSafetyUnconfirmed);
    assert!(elapsed < Duration::from_secs(1));
    assert_eq!(commands.len(), 2);
    assert!(commands
        .iter()
        .all(|command| command["sessionId"] == "primary"));
}

#[test]
fn safety_release_timeout_marks_the_bound_effect_fence_unsafe_at_fixed_deadline() {
    let (release, acknowledgement, elapsed, commands) =
        exercise_unconfirmed_safety_release(SafetyReleaseFault::ResponseTimeout);

    assert_eq!(release, BackendFailureCode::TimedOut);
    assert_eq!(acknowledgement, ControlErrorCode::EffectSafetyUnconfirmed);
    assert!(
        elapsed >= Duration::from_millis(900),
        "elapsed: {elapsed:?}"
    );
    assert!(
        elapsed < Duration::from_millis(1_500),
        "elapsed: {elapsed:?}"
    );
    assert_eq!(commands.len(), 2);
    assert_eq!(commands[1]["params"]["buttons"], 0);
    assert_eq!(commands[1]["params"]["clickCount"], 0);
}

#[test]
fn safety_release_writer_failure_preserves_original_cancellation_and_protocol_errors() {
    for original_code in [
        BackendFailureCode::Cancelled,
        BackendFailureCode::ProtocolViolation,
    ] {
        let (control, cancellation) = cancellable_operation();
        let (sender, inbox, state) = transport::frame_channel();
        let commands = Arc::new(Mutex::new(Vec::new()));
        let mut writer = FaultingSafetyReleaseWriter {
            fault: SafetyReleaseFault::WriterFailure,
            commands,
            sender,
            state,
        };
        let returned = {
            let mut client = CdpClient::new(&mut writer, inbox);
            let (_, sequence) = client
                .begin_input_sequence(
                    CdpMethod::InputDispatchMouseEvent,
                    serde_json::json!({
                        "type": "mousePressed",
                        "x": 10.0,
                        "y": 20.0,
                        "button": "left",
                        "clickCount": 1
                    }),
                    "primary",
                    Instant::now() + Duration::from_secs(1),
                    &cancellation,
                    &mut NoopHandler,
                )
                .unwrap();
            client.abort_input_sequence_preserving_error(
                sequence,
                &mut NoopHandler,
                BackendFailure::new(original_code, "original semantic failure"),
            )
        };

        assert_eq!(returned.code, original_code);
        assert!(cancellation.is_cancelled());
        assert_eq!(
            control
                .begin_operation(
                    &BrowserGrantBinding::new_trusted("w", "p", "s", 1).unwrap(),
                    true,
                )
                .unwrap_err()
                .code,
            ControlErrorCode::EffectSafetyUnconfirmed
        );
    }
}
