use super::protocol::{CdpEvent, CdpMethod};
use super::transport::{frame_channel, CancellationProbe, CdpClient, ProtocolEventHandler};
use crate::browser::login::backend::{BackendFailure, BackendFailureCode};
use crate::browser::login::control::{
    HandoffControl, HandoffGrant, LoginBrowserControl, OperationCancellation,
};
use crate::browser::login::execution_fence::EffectWritePermit;
use crate::browser::login::policy::BrowserGrantBinding;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

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

struct PreWriteBarrier {
    cancellation: OperationCancellation,
    entered: Mutex<Option<mpsc::Sender<()>>>,
    release: mpsc::Receiver<()>,
}

impl CancellationProbe for PreWriteBarrier {
    fn is_cancelled(&self) -> bool {
        self.cancellation.is_cancelled()
    }

    fn enter_effect_write(&self) -> Result<Option<EffectWritePermit>, ()> {
        if let Some(entered) = self.entered.lock().map_err(|_| ())?.take() {
            entered.send(()).map_err(|_| ())?;
        }
        self.release.recv().map_err(|_| ())?;
        self.cancellation
            .enter_effect_write()
            .map(Some)
            .map_err(|_| ())
    }
}

fn operation() -> (Arc<LoginBrowserControl>, OperationCancellation) {
    let binding = BrowserGrantBinding::new_trusted("w", "p", "s", 1).expect("binding");
    let control = Arc::new(LoginBrowserControl::new());
    control
        .activate_handoff(HandoffGrant::new_trusted(binding.clone()))
        .expect("activate");
    let cancellation = control
        .begin_operation(&binding, true)
        .expect("begin operation");
    (control, cancellation)
}

#[test]
fn transport_pre_write_barrier_observes_revoke_and_emits_no_frame() {
    let (control, cancellation) = operation();
    let owner = cancellation.enter_owner_execution().expect("owner entered");
    let observer = cancellation.clone();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();

    std::thread::spawn(move || {
        let _owner = owner;
        let (_frames, inbox, _state) = frame_channel();
        let mut output = Vec::new();
        let mut client = CdpClient::new(&mut output, inbox);
        let probe = PreWriteBarrier {
            cancellation,
            entered: Mutex::new(Some(entered_tx)),
            release: release_rx,
        };
        let result = client.call(
            CdpMethod::PageNavigate,
            serde_json::json!({"url":"https://example.com"}),
            Some("session"),
            Instant::now() + Duration::from_secs(1),
            &probe,
            &mut NoopHandler,
        );
        drop(client);
        done_tx.send((result, output)).expect("worker result");
    });

    entered_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("at pre-write boundary");
    let (revoked_tx, revoked_rx) = mpsc::channel();
    std::thread::spawn(move || {
        control.cancel_active();
        revoked_tx.send(()).expect("revoked");
    });
    let revoke_deadline = Instant::now() + Duration::from_secs(1);
    while !observer.is_cancelled() && Instant::now() < revoke_deadline {
        std::thread::yield_now();
    }
    assert!(observer.is_cancelled(), "epoch must retire before release");
    assert!(revoked_rx.try_recv().is_err(), "owner is not quiescent yet");

    release_tx.send(()).expect("release pre-write barrier");
    let (result, output) = done_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("worker stopped");
    revoked_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("revoke acknowledged owner quiescence");
    assert_eq!(
        result.expect_err("stale effect denied").code,
        BackendFailureCode::Cancelled
    );
    assert!(output.is_empty(), "stale command must emit no CDP frame");
}

#[test]
fn queued_stale_command_emits_no_frame() {
    let (control, cancellation) = operation();
    control.cancel_active();
    let (_frames, inbox, _state) = frame_channel();
    let mut output = Vec::new();
    let mut client = CdpClient::new(&mut output, inbox);

    let error = client
        .call(
            CdpMethod::PageNavigate,
            serde_json::json!({"url":"https://example.com"}),
            Some("session"),
            Instant::now() + Duration::from_secs(1),
            &cancellation,
            &mut NoopHandler,
        )
        .expect_err("queued stale command denied");
    drop(client);

    assert_eq!(error.code, BackendFailureCode::Cancelled);
    assert!(output.is_empty());
}
