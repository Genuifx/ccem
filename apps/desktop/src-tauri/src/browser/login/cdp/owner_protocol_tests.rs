use super::artifacts::CdpArtifactStore;
use super::console_events::ConsoleEventRecorder;
use super::guard::{TrustedNavigationDecision, TrustedNavigationGuard, TrustedNavigationRequest};
use super::network_events::NetworkEventRecorder;
use super::owner::{ChromiumOwnerProjection, OwnerRequest};
use super::owner_protocol::{run_protocol_owner, OwnerTerminalTermination};
use super::owner_transition::owner_transition_channel;
use super::semantics::SemanticEngine;
use crate::browser::login::network::NetworkRedactionConfig;
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, Instant};

struct AllowGuard;

struct PipeClosingTermination {
    release: Mutex<Option<mpsc::SyncSender<()>>>,
    request_count: AtomicUsize,
}

impl OwnerTerminalTermination for PipeClosingTermination {
    fn request_force_verified_domain(
        &self,
    ) -> Result<(), crate::browser::login::backend::BackendFailure> {
        self.request_count.fetch_add(1, Ordering::AcqRel);
        if let Some(release) = self.release.lock().unwrap().take() {
            let _ = release.send(());
        }
        Ok(())
    }
}

impl TrustedNavigationGuard for AllowGuard {
    fn authorize(&self, _request: TrustedNavigationRequest<'_>) -> TrustedNavigationDecision {
        TrustedNavigationDecision::allow("allowed")
    }
}

fn test_engine(temp: &tempfile::TempDir) -> SemanticEngine {
    SemanticEngine::new(
        Arc::new(AllowGuard),
        CdpArtifactStore::new(temp.path().join("artifacts")).unwrap(),
        NetworkEventRecorder::new(
            temp.path().join("network"),
            "terminal-owner".to_string(),
            NetworkRedactionConfig::default(),
        )
        .unwrap(),
        ConsoleEventRecorder::new(
            temp.path().join("network"),
            "terminal-owner".to_string(),
            NetworkRedactionConfig::default(),
        )
        .unwrap(),
    )
}

fn read_frame(reader: &mut BufReader<UnixStream>) -> Value {
    let mut bytes = Vec::new();
    reader.read_until(0, &mut bytes).unwrap();
    assert_eq!(bytes.pop(), Some(0));
    serde_json::from_slice(&bytes).unwrap()
}

fn write_frame(stream: &mut UnixStream, value: Value) {
    let mut bytes = serde_json::to_vec(&value).unwrap();
    bytes.push(0);
    stream.write_all(&bytes).unwrap();
    stream.flush().unwrap();
}

#[test]
fn terminal_error_cannot_wait_forever_when_browser_close_keeps_pipe_open() {
    let temp = tempfile::tempdir().unwrap();
    let (owner_stream, peer_stream) = UnixStream::pair().unwrap();
    let mut owner_reader = owner_stream.try_clone().unwrap();
    let mut owner_writer = owner_stream;
    let mut peer_reader = BufReader::new(peer_stream.try_clone().unwrap());
    let mut peer_writer = peer_stream;
    let (_request_tx, request_rx) = mpsc::sync_channel::<OwnerRequest>(4);
    let (_transition, transition_inbox) = owner_transition_channel();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let projection = Arc::new(RwLock::new(ChromiumOwnerProjection::default()));
    let (done_tx, done_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let termination = Arc::new(PipeClosingTermination {
        release: Mutex::new(Some(release_tx)),
        request_count: AtomicUsize::new(0),
    });
    let owner_termination = Arc::clone(&termination);
    let owner = thread::spawn(move || {
        let mut engine = Some(test_engine(&temp));
        let mut ready = Some(ready_tx);
        let result = run_protocol_owner(
            &mut owner_reader,
            &mut owner_writer,
            &mut engine,
            &request_rx,
            &transition_inbox,
            &shutdown,
            owner_termination.as_ref(),
            &mut ready,
            &projection,
        );
        let _ = done_tx.send(result);
    });
    let (close_seen_tx, close_seen_rx) = mpsc::sync_channel(1);
    let peer = thread::spawn(move || loop {
        let command = read_frame(&mut peer_reader);
        let id = command["id"].as_u64().unwrap();
        let method = command["method"].as_str().unwrap();
        if method == "Browser.close" {
            close_seen_tx.send(()).unwrap();
            let _ = release_rx.recv();
            break;
        }
        let result = match method {
            "Target.createTarget" => serde_json::json!({"targetId":"target-1"}),
            "Target.attachToTarget" => serde_json::json!({"sessionId":"session-1"}),
            "Target.getTargets" => serde_json::json!({
                "targetInfos":[{"targetId":"target-1","type":"page","url":"about:blank"}]
            }),
            "Page.getNavigationHistory" => serde_json::json!({
                "currentIndex":0,
                "entries":[{"url":"about:blank","title":""}]
            }),
            _ => serde_json::json!({}),
        };
        write_frame(
            &mut peer_writer,
            serde_json::json!({"id":id,"result":result}),
        );
        if method == "Page.getNavigationHistory" {
            write_frame(
                &mut peer_writer,
                serde_json::json!({
                    "method":"Inspector.targetCrashed",
                    "sessionId":"session-1",
                    "params":{}
                }),
            );
        }
    });

    ready_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .unwrap();
    close_seen_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let started = Instant::now();
    let bounded = done_rx.recv_timeout(Duration::from_secs(1));
    let elapsed = started.elapsed();
    peer.join().unwrap();
    owner.join().unwrap();

    assert!(
        bounded.is_ok(),
        "terminal owner remained blocked after Browser.close"
    );
    assert!(elapsed < Duration::from_secs(1));
    assert_eq!(termination.request_count.load(Ordering::Acquire), 1);
}

#[test]
fn ordinary_shutdown_does_not_request_terminal_termination() {
    let temp = tempfile::tempdir().unwrap();
    let (owner_stream, peer_stream) = UnixStream::pair().unwrap();
    let mut owner_reader = owner_stream.try_clone().unwrap();
    let mut owner_writer = owner_stream;
    let mut peer_reader = BufReader::new(peer_stream.try_clone().unwrap());
    let mut peer_writer = peer_stream;
    let (request_tx, request_rx) = mpsc::sync_channel::<OwnerRequest>(4);
    let (_transition, transition_inbox) = owner_transition_channel();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let projection = Arc::new(RwLock::new(ChromiumOwnerProjection::default()));
    let (done_tx, done_rx) = mpsc::sync_channel(1);
    let termination = Arc::new(PipeClosingTermination {
        release: Mutex::new(None),
        request_count: AtomicUsize::new(0),
    });
    let owner_termination = Arc::clone(&termination);
    let owner = thread::spawn(move || {
        let mut engine = Some(test_engine(&temp));
        let mut ready = Some(ready_tx);
        let result = run_protocol_owner(
            &mut owner_reader,
            &mut owner_writer,
            &mut engine,
            &request_rx,
            &transition_inbox,
            &shutdown,
            owner_termination.as_ref(),
            &mut ready,
            &projection,
        );
        let _ = done_tx.send(result);
    });
    let peer = thread::spawn(move || loop {
        let command = read_frame(&mut peer_reader);
        let id = command["id"].as_u64().unwrap();
        let method = command["method"].as_str().unwrap();
        let result = match method {
            "Target.createTarget" => serde_json::json!({"targetId":"target-1"}),
            "Target.attachToTarget" => serde_json::json!({"sessionId":"session-1"}),
            "Target.getTargets" => serde_json::json!({
                "targetInfos":[{"targetId":"target-1","type":"page","url":"about:blank"}]
            }),
            "Page.getNavigationHistory" => serde_json::json!({
                "currentIndex":0,
                "entries":[{"url":"about:blank","title":""}]
            }),
            _ => serde_json::json!({}),
        };
        write_frame(
            &mut peer_writer,
            serde_json::json!({"id":id,"result":result}),
        );
        if method == "Browser.close" {
            break;
        }
    });

    ready_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .unwrap();
    request_tx.send(OwnerRequest::Shutdown).unwrap();
    done_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("ordinary owner shutdown stayed bounded")
        .unwrap();
    peer.join().unwrap();
    owner.join().unwrap();
    assert_eq!(termination.request_count.load(Ordering::Acquire), 0);
}

#[test]
fn terminal_diagnostic_protocol_failure_stops_owner_before_returning_to_user_control() {
    let temp = tempfile::tempdir().unwrap();
    let (owner_stream, peer_stream) = UnixStream::pair().unwrap();
    let mut owner_reader = owner_stream.try_clone().unwrap();
    let mut owner_writer = owner_stream;
    let mut peer_reader = BufReader::new(peer_stream.try_clone().unwrap());
    let mut peer_writer = peer_stream;
    let (request_tx, request_rx) = mpsc::sync_channel::<OwnerRequest>(4);
    let (_transition, transition_inbox) = owner_transition_channel();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let projection = Arc::new(RwLock::new(ChromiumOwnerProjection::default()));
    let (done_tx, done_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let termination = Arc::new(PipeClosingTermination {
        release: Mutex::new(Some(release_tx)),
        request_count: AtomicUsize::new(0),
    });
    let owner_termination = Arc::clone(&termination);
    let owner = thread::spawn(move || {
        let mut engine = Some(test_engine(&temp));
        let mut ready = Some(ready_tx);
        let result = run_protocol_owner(
            &mut owner_reader,
            &mut owner_writer,
            &mut engine,
            &request_rx,
            &transition_inbox,
            &shutdown,
            owner_termination.as_ref(),
            &mut ready,
            &projection,
        );
        let _ = done_tx.send(result);
    });
    let peer = thread::spawn(move || loop {
        let command = read_frame(&mut peer_reader);
        let id = command["id"].as_u64().unwrap();
        let method = command["method"].as_str().unwrap();
        if method == "Browser.close" {
            let _ = release_rx.recv();
            break;
        }
        let result = match method {
            "Target.createTarget" => serde_json::json!({"targetId":"target-1"}),
            "Target.attachToTarget" => serde_json::json!({"sessionId":"session-1"}),
            "Target.getTargets" => serde_json::json!({
                "targetInfos":[{"targetId":"target-1","type":"page","url":"about:blank"}]
            }),
            "Page.getNavigationHistory" => serde_json::json!({
                "currentIndex":0,
                "entries":[{"url":"about:blank","title":""}]
            }),
            // A diagnostic begin barrier without frameTree is a protocol violation, not an
            // ordinary handoff denial that may return the compromised owner to manual control.
            "Page.getFrameTree" => serde_json::json!({}),
            _ => serde_json::json!({}),
        };
        write_frame(
            &mut peer_writer,
            serde_json::json!({"id":id,"result":result}),
        );
    });

    ready_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .unwrap();
    let (response_tx, response_rx) = mpsc::sync_channel(1);
    request_tx
        .send(OwnerRequest::BeginDiagnosticSegment {
            handoff_epoch: 1,
            response: response_tx,
        })
        .unwrap();
    let error = response_rx
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .unwrap_err();
    assert_eq!(
        error.code,
        crate::browser::login::backend::BackendFailureCode::ProtocolViolation
    );
    done_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("terminal diagnostic failure left owner alive")
        .unwrap_err();
    peer.join().unwrap();
    owner.join().unwrap();
    assert_eq!(termination.request_count.load(Ordering::Acquire), 1);
}
