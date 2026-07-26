use super::*;

const MAX_INPUT_KEY_CHARS: usize = 128;
const INPUT_SAFETY_RELEASE_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Debug)]
enum InputSafetyRelease {
    MouseLeft {
        x: f64,
        y: f64,
    },
    Key {
        key: String,
        code: String,
        modifiers: Option<u64>,
    },
}

impl InputSafetyRelease {
    fn from_down(method: CdpMethod, params: &Value) -> Result<Self, BackendFailure> {
        let params = params.as_object().ok_or_else(input_sequence_failure)?;
        match method {
            CdpMethod::InputDispatchMouseEvent
                if params.get("type").and_then(Value::as_str) == Some("mousePressed")
                    && params.get("button").and_then(Value::as_str) == Some("left")
                    && params.get("clickCount").and_then(Value::as_u64) == Some(1) =>
            {
                let x = params
                    .get("x")
                    .and_then(Value::as_f64)
                    .filter(|value| value.is_finite())
                    .ok_or_else(input_sequence_failure)?;
                let y = params
                    .get("y")
                    .and_then(Value::as_f64)
                    .filter(|value| value.is_finite())
                    .ok_or_else(input_sequence_failure)?;
                Ok(Self::MouseLeft { x, y })
            }
            CdpMethod::InputDispatchKeyEvent
                if params.get("type").and_then(Value::as_str) == Some("keyDown") =>
            {
                let key = bounded_input_key(params.get("key"))?;
                let code = bounded_input_key(params.get("code"))?;
                let modifiers = match params.get("modifiers") {
                    Some(value) => Some(
                        value
                            .as_u64()
                            .filter(|modifiers| *modifiers <= 15)
                            .ok_or_else(input_sequence_failure)?,
                    ),
                    None => None,
                };
                Ok(Self::Key {
                    key,
                    code,
                    modifiers,
                })
            }
            _ => Err(input_sequence_failure()),
        }
    }

    fn command(&self, safety: bool) -> (CdpMethod, Value) {
        match self {
            Self::MouseLeft { x, y } => (
                CdpMethod::InputDispatchMouseEvent,
                if safety {
                    serde_json::json!({
                        "type": "mouseReleased",
                        "x": x,
                        "y": y,
                        "button": "left",
                        "buttons": 0,
                        "clickCount": 0
                    })
                } else {
                    serde_json::json!({
                        "type": "mouseReleased",
                        "x": x,
                        "y": y,
                        "button": "left",
                        "clickCount": 1
                    })
                },
            ),
            Self::Key {
                key,
                code,
                modifiers,
            } => {
                let mut params = Map::new();
                params.insert("type".to_string(), Value::from("keyUp"));
                params.insert("key".to_string(), Value::from(key.clone()));
                params.insert("code".to_string(), Value::from(code.clone()));
                if let Some(modifiers) = modifiers {
                    params.insert("modifiers".to_string(), Value::from(*modifiers));
                }
                (CdpMethod::InputDispatchKeyEvent, Value::Object(params))
            }
        }
    }
}

/// An unforgeable, single-use proof that one fixed semantic input-down frame crossed the CDP
/// writer boundary. Its only post-retirement capability is the matching safety release derived
/// from that exact frame; callers cannot supply another method or payload.
#[derive(Debug)]
pub(in crate::browser::login::cdp) struct CommittedInputSequence {
    session_id: String,
    release: InputSafetyRelease,
    safety_fence: Option<EffectSafetyFence>,
}

impl CdpClient<'_> {
    pub(in crate::browser::login::cdp) fn begin_input_sequence<H: ProtocolEventHandler>(
        &mut self,
        method: CdpMethod,
        params: Value,
        session_id: &str,
        deadline: Instant,
        cancellation: &dyn CancellationProbe,
        handler: &mut H,
    ) -> Result<(Value, CommittedInputSequence), BackendFailure> {
        let release = InputSafetyRelease::from_down(method, &params)?;
        let mut committed = false;
        let result = self.call_with_rejection_tracking_commit(
            method,
            params,
            Some(session_id),
            deadline,
            cancellation,
            handler,
            BackendFailureCode::ProtocolViolation,
            &mut committed,
        );
        let sequence = CommittedInputSequence {
            session_id: session_id.to_string(),
            release,
            safety_fence: cancellation.effect_safety_fence(),
        };
        match result {
            Ok(result) => Ok((result, sequence)),
            Err(error) => {
                if committed {
                    return Err(
                        self.abort_input_sequence_preserving_error(sequence, handler, error)
                    );
                }
                Err(error)
            }
        }
    }

    pub(in crate::browser::login::cdp) fn finish_input_sequence<H: ProtocolEventHandler>(
        &mut self,
        sequence: CommittedInputSequence,
        deadline: Instant,
        cancellation: &dyn CancellationProbe,
        handler: &mut H,
    ) -> Result<Value, BackendFailure> {
        let (method, params) = sequence.release.command(false);
        let mut committed = false;
        let result = self.call_with_rejection_tracking_commit(
            method,
            params,
            Some(&sequence.session_id),
            deadline,
            cancellation,
            handler,
            BackendFailureCode::ProtocolViolation,
            &mut committed,
        );
        match result {
            Ok(result) => Ok(result),
            Err(error) => {
                if !committed {
                    return Err(
                        self.abort_input_sequence_preserving_error(sequence, handler, error)
                    );
                }
                Err(error)
            }
        }
    }

    pub(in crate::browser::login::cdp) fn abort_input_sequence<H: ProtocolEventHandler>(
        &mut self,
        sequence: CommittedInputSequence,
        handler: &mut H,
    ) -> Result<(), BackendFailure> {
        self.dispatch_input_safety_release(sequence, handler)
    }

    pub(in crate::browser::login::cdp) fn abort_input_sequence_preserving_error<
        H: ProtocolEventHandler,
    >(
        &mut self,
        sequence: CommittedInputSequence,
        handler: &mut H,
        original_error: BackendFailure,
    ) -> BackendFailure {
        // The fixed release still runs and marks the bound effect fence unsafe on failure.
        // The semantic caller's earlier cancellation/protocol decision remains authoritative.
        match self.dispatch_input_safety_release(sequence, handler) {
            Ok(()) | Err(_) => original_error,
        }
    }

    fn dispatch_input_safety_release<H: ProtocolEventHandler>(
        &mut self,
        sequence: CommittedInputSequence,
        handler: &mut H,
    ) -> Result<(), BackendFailure> {
        let CommittedInputSequence {
            session_id,
            release,
            safety_fence,
        } = sequence;
        let result = self.dispatch_input_safety_release_inner(session_id, release, handler);
        if result.is_err() {
            if let Some(safety_fence) = safety_fence {
                safety_fence.mark_unconfirmed();
            }
        }
        result
    }

    fn dispatch_input_safety_release_inner<H: ProtocolEventHandler>(
        &mut self,
        session_id: String,
        release: InputSafetyRelease,
        handler: &mut H,
    ) -> Result<(), BackendFailure> {
        let deadline = Instant::now()
            .checked_add(INPUT_SAFETY_RELEASE_TIMEOUT)
            .unwrap_or_else(Instant::now);
        let (method, params) = release.command(true);
        let id = self.allocate_id()?;
        // This deliberately bypasses the retired Agent epoch only for the fixed release encoded
        // by `CommittedInputSequence`. Unlike `NeverCancelled`, no arbitrary method or caller
        // payload can pass through this path.
        self.write_command(id, method, params, Some(&session_id), None)?;
        loop {
            if Instant::now() >= deadline {
                // Preserve the fixed safety-release deadline even when ignored-response tracking
                // is already saturated. The caller separately poisons the bound effect fence.
                let _ = self.abandon_response(id);
                return Err(BackendFailure::new(
                    BackendFailureCode::TimedOut,
                    "Browser input safety release reached its fixed deadline.",
                ));
            }
            if let Some(response) = self.take_pending(id) {
                return map_command_result(response.result, BackendFailureCode::ProtocolViolation)
                    .map(|_| ());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            let timeout = remaining.min(OWNER_POLL_INTERVAL);
            let Some(frame) = self.inbox.recv_timeout(timeout)? else {
                continue;
            };
            match classify_frame(frame.value)? {
                IncomingFrame::Response {
                    id: response_id,
                    result,
                } if response_id == id => {
                    return map_command_result(result, BackendFailureCode::ProtocolViolation)
                        .map(|_| ())
                }
                IncomingFrame::Response {
                    id: response_id,
                    result,
                } => self.store_response(response_id, result, frame.byte_len)?,
                IncomingFrame::Event(event) => {
                    if let Err(error) = handler.on_event(self, event) {
                        if matches!(
                            error.code,
                            BackendFailureCode::Cancelled | BackendFailureCode::TimedOut
                        ) {
                            let _ = self.abandon_response(id);
                        }
                        return Err(error);
                    }
                }
            }
        }
    }
}

fn bounded_input_key(value: Option<&Value>) -> Result<String, BackendFailure> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.chars().count() <= MAX_INPUT_KEY_CHARS)
        .map(str::to_string)
        .ok_or_else(input_sequence_failure)
}

fn input_sequence_failure() -> BackendFailure {
    BackendFailure::new(
        BackendFailureCode::ProtocolViolation,
        "Browser input sequence violated the fixed semantic protocol.",
    )
}
