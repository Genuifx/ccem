use super::*;
use std::{fs, path::Path, sync::mpsc};

// Exercise the production completion function and real child-process protocol
// without loading the user's NativeRuntimeManager state or a signed runtime.
struct PairingState {
    lifecycle: Mutex<()>,
    setup: Mutex<Option<Setup>>,
    shutdown: AtomicBool,
    host: Mutex<Option<Arc<GatewayProcess>>>,
}

struct Fixture {
    root: tempfile::TempDir,
    process: Arc<GatewayProcess>,
    state: Arc<PairingState>,
    id: String,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let host = root.path().join("host.py");
        fs::write(
            &host,
            r#"import json, sys, threading, time
from pathlib import Path
json.loads(sys.stdin.readline())
print(json.dumps({'event':'status','payload':{'state':'running','platforms':[]}}), flush=True)
def reply_when_released(message):
    while not Path('release-reply').exists():
        time.sleep(0.01)
    print(json.dumps({'id':message['id'],'result':{'code':'fixture-pairing'}}), flush=True)
for line in sys.stdin:
    message = json.loads(line)
    if message['method'] == 'openPairing':
        Path('request-started').write_text('started')
        threading.Thread(target=reply_when_released, args=(message,), daemon=True).start()
    elif message['method'] == 'stop':
        break
"#,
        )
        .unwrap();
        let process = Arc::new(
            GatewayProcess::spawn(
                Path::new("/usr/bin/python3"),
                &host,
                root.path(),
                &root.path().join("profile"),
                json!({}),
            )
            .unwrap(),
        );
        let mut setup = Setup::new("wecom", now());
        let id = setup.id.clone();
        setup.finish("connecting", None);
        let state = Arc::new(PairingState {
            lifecycle: Mutex::new(()),
            setup: Mutex::new(Some(setup)),
            shutdown: AtomicBool::new(false),
            host: Mutex::new(Some(process.clone())),
        });
        Self {
            root,
            process,
            state,
            id,
        }
    }

    fn begin(&self) -> (thread::JoinHandle<()>, mpsc::Receiver<Result<(), String>>) {
        let (tx, rx) = mpsc::sync_channel(1);
        let state = self.state.clone();
        let process = self.process.clone();
        let id = self.id.clone();
        let worker = thread::spawn(move || {
            let result = finish_pairing(
                &state.lifecycle,
                &state.setup,
                &state.shutdown,
                &id,
                &process,
                || {
                    state
                        .host
                        .lock()
                        .unwrap()
                        .clone()
                        .ok_or_else(|| "gateway_not_running".into())
                },
            );
            let _ = tx.send(result);
        });
        let started = self.root.path().join("profile/request-started");
        let deadline = Instant::now() + Duration::from_secs(3);
        while !started.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(started.exists(), "the real host must receive openPairing");
        (worker, rx)
    }

    fn lifecycle_before_reply(&self) -> std::sync::MutexGuard<'_, ()> {
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            if let Ok(guard) = self.state.lifecycle.try_lock() {
                return guard;
            }
            assert!(
                Instant::now() < deadline,
                "a blocked host reply must not own the lifecycle lock"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn release_reply(&self) {
        fs::write(self.root.path().join("profile/release-reply"), "reply").unwrap();
    }

    fn snapshot(&self) -> Value {
        json!(*self.state.setup.lock().unwrap())
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.process.stop();
    }
}

#[test]
fn slow_open_pairing_allows_stop_before_a_reply() {
    let fixture = Fixture::new();
    let (worker, done) = fixture.begin();
    let started = Instant::now();
    {
        let _guard = fixture.lifecycle_before_reply();
        fixture
            .state
            .setup
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .finish("cancelled", None);
        fixture.state.host.lock().unwrap().take().unwrap().stop();
    }
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(!fixture.process.alive());
    assert_eq!(fixture.snapshot()["state"], "cancelled");
    assert_eq!(
        done.recv_timeout(Duration::from_secs(1)).unwrap(),
        Err("setup_pairing_failed".into())
    );
    worker.join().unwrap();
    assert_eq!(fixture.snapshot()["state"], "cancelled");
}

#[test]
fn late_pairing_reply_cannot_complete_revoked_replaced_or_shutdown_setup() {
    for transition in ["revoke", "replace", "shutdown"] {
        let fixture = Fixture::new();
        let (worker, done) = fixture.begin();
        {
            let _guard = fixture.lifecycle_before_reply();
            match transition {
                "revoke" => fixture
                    .state
                    .setup
                    .lock()
                    .unwrap()
                    .as_mut()
                    .unwrap()
                    .finish("cancelled", None),
                "replace" => {
                    *fixture.state.setup.lock().unwrap() = Some(Setup::new("wecom", now()));
                }
                _ => fixture.state.shutdown.store(true, Ordering::Release),
            }
        }
        let expected = fixture.snapshot();
        assert!(done.try_recv().is_err(), "the host reply is still withheld");
        fixture.release_reply();
        assert_eq!(done.recv_timeout(Duration::from_secs(3)).unwrap(), Ok(()));
        worker.join().unwrap();
        assert_eq!(fixture.snapshot(), expected, "transition: {transition}");
    }
}

#[test]
fn late_pairing_reply_from_replaced_host_cannot_complete_current_setup() {
    let fixture = Fixture::new();
    let replacement = Fixture::new();
    let (worker, done) = fixture.begin();
    {
        let _guard = fixture.lifecycle_before_reply();
        *fixture.state.host.lock().unwrap() = Some(replacement.process.clone());
    }
    fixture.release_reply();
    assert_eq!(
        done.recv_timeout(Duration::from_secs(3)).unwrap(),
        Err("setup_connection_failed".into())
    );
    worker.join().unwrap();
    assert_eq!(fixture.snapshot()["state"], "connecting");
}

#[test]
fn pairing_reply_from_current_host_completes_current_setup() {
    let fixture = Fixture::new();
    let (worker, done) = fixture.begin();
    assert_eq!(fixture.snapshot()["state"], "connecting");
    fixture.release_reply();
    assert_eq!(done.recv_timeout(Duration::from_secs(3)).unwrap(), Ok(()));
    worker.join().unwrap();
    assert_eq!(fixture.snapshot()["state"], "connected");
    assert_eq!(fixture.snapshot()["id"], fixture.id);
}
