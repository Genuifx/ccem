use super::*;
use std::cell::Cell;
use std::io::Cursor;

struct NoopHandler;

impl ProtocolEventHandler for NoopHandler {
    fn on_event(
        &mut self,
        _client: &mut CdpClient<'_>,
        _event: CdpEvent,
    ) -> Result<(), BackendFailure> {
        Ok(())
    }
}

struct AfterDispatchProbe {
    checks: Cell<usize>,
    cancellation: bool,
}

impl AfterDispatchProbe {
    fn cancelled() -> Self {
        Self {
            checks: Cell::new(0),
            cancellation: true,
        }
    }

    fn timed_out() -> Self {
        Self {
            checks: Cell::new(0),
            cancellation: false,
        }
    }
}

impl CancellationProbe for AfterDispatchProbe {
    fn is_cancelled(&self) -> bool {
        let checks = self.checks.get() + 1;
        self.checks.set(checks);
        if !self.cancellation && checks > 1 {
            std::thread::sleep(Duration::from_millis(2));
        }
        self.cancellation && checks > 1
    }
}

fn call_without_response(
    client: &mut CdpClient<'_>,
    probe: &dyn CancellationProbe,
    deadline: Instant,
) -> BackendFailureCode {
    client
        .call(
            CdpMethod::PageEnable,
            serde_json::json!({}),
            Some("session"),
            deadline,
            probe,
            &mut NoopHandler,
        )
        .unwrap_err()
        .code
}

#[test]
fn abandoned_response_capacity_preserves_primary_cancellation_and_timeout() {
    let (_sender, inbox, _state) = frame_channel();
    let mut output = Vec::new();
    let mut client = CdpClient::new(&mut output, inbox);
    client
        .ignored
        .extend(1..=u64::try_from(MAX_IGNORED_RESPONSES).unwrap());
    client.next_id = u64::try_from(MAX_IGNORED_RESPONSES).unwrap() + 1;

    assert_eq!(
        call_without_response(
            &mut client,
            &AfterDispatchProbe::cancelled(),
            Instant::now() + Duration::from_secs(1),
        ),
        BackendFailureCode::Cancelled
    );
    assert_eq!(client.ignored.len(), MAX_IGNORED_RESPONSES);

    assert_eq!(
        call_without_response(
            &mut client,
            &AfterDispatchProbe::timed_out(),
            Instant::now() + Duration::from_millis(1),
        ),
        BackendFailureCode::TimedOut
    );
    assert_eq!(client.ignored.len(), MAX_IGNORED_RESPONSES);
}

#[test]
fn bounded_frame_queue_absorbs_a_modern_page_navigation_burst() {
    const BURST_FRAMES: usize = 1_024;
    let (sender, inbox, state) = frame_channel();
    let mut input = Vec::new();
    for index in 0..BURST_FRAMES {
        input.extend_from_slice(
            &serde_json::to_vec(&serde_json::json!({
                "method":"Network.requestWillBeSent",
                "params":{"requestId":format!("request-{index}")}
            }))
            .unwrap(),
        );
        input.push(0);
    }

    run_frame_reader(&mut Cursor::new(input), sender, Arc::clone(&state));

    for _ in 0..BURST_FRAMES {
        assert!(inbox
            .recv_timeout(Duration::from_millis(10))
            .unwrap()
            .is_some());
    }
    assert_eq!(state.fault(), Some(TransportFaultCode::PipeEof));
}
