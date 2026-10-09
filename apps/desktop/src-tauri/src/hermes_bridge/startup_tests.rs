use super::*;
use std::{sync::mpsc, time::Instant};

// The production queue and publication lock are exercised directly. A signed
// runtime's slow file verification is controlled by a channel; its lease has a
// drop probe. NativeRuntimeManager construction would load the user's sessions,
// so the peer uses the real Store/auth policy and child protocol in a temp dir.
struct LeaseProbe(Arc<AtomicUsize>);

impl Drop for LeaseProbe {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

#[derive(Default)]
struct Harness {
    queue: StartupQueue,
    lifecycle: Mutex<()>,
    blocked: AtomicBool,
    leases: Arc<AtomicUsize>,
    published: Mutex<Vec<(Target, Option<String>)>>,
}

impl Harness {
    fn start(
        self: &Arc<Self>,
    ) -> (
        thread::JoinHandle<()>,
        mpsc::Receiver<()>,
        mpsc::SyncSender<()>,
    ) {
        let (entered_tx, entered_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let state = self.clone();
        let worker = thread::spawn(move || {
            let first = AtomicBool::new(true);
            state.queue.drain(
                &state.lifecycle,
                || state.blocked.load(Ordering::Acquire),
                || {
                    state.leases.fetch_add(1, Ordering::AcqRel);
                    let lease = LeaseProbe(state.leases.clone());
                    if first.swap(false, Ordering::AcqRel) {
                        entered_tx.send(()).unwrap();
                        release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                    }
                    Ok(lease)
                },
                |job, verified| {
                    let _lease = verified.unwrap();
                    state.published.lock().unwrap().push((
                        job.target.clone(),
                        job.connection.as_ref().map(|c| c.cipher.clone()),
                    ));
                },
            );
        });
        (worker, entered_rx, release_tx)
    }

    fn policy_lock(&self) -> std::sync::MutexGuard<'_, ()> {
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            if let Ok(guard) = self.lifecycle.try_lock() {
                return guard;
            }
            assert!(
                Instant::now() < deadline,
                "verification held the policy lock"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }
}

fn connection(account: &str, cipher: &str) -> ConnectionRecord {
    ConnectionRecord {
        account_ref: account.into(),
        platform: "wecom".into(),
        label: account.into(),
        cipher: cipher.into(),
        configured_fields: vec![],
        enabled: true,
    }
}

#[test]
fn blocked_connection_and_discovery_verification_leave_peer_policy_and_rpc_available() {
    let python = crate::hermes_bridge::test_support::python();
    for discovery in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let mut store = Store::open(&root.path().join("store")).unwrap();
        let first = store
            .save_connection(None, "wecom", None, "first", &[], true)
            .unwrap();
        let peer = store
            .save_connection(None, "wecom", None, "peer", &[], true)
            .unwrap();
        let source = Source {
            account_ref: peer.account_ref.clone(),
            platform: "wecom".into(),
            profile: "fixture".into(),
            transport_profile: "fixture".into(),
            user_id: "fixture-user".into(),
            chat_id: "fixture-chat".into(),
            chat_type: "dm".into(),
            thread_id: None,
        };
        let route = store
            .approve_route(
                source.clone(),
                vec![root.path().to_string_lossy().into()],
                true,
                true,
            )
            .unwrap();
        let host = root.path().join("host.py");
        std::fs::write(
            &host,
            r#"import json, sys
json.loads(sys.stdin.readline())
print(json.dumps({'event':'status','payload':{'state':'running','platforms':[]}}), flush=True)
for line in sys.stdin:
    message = json.loads(line)
    if message['method'] == 'stop':
        break
    print(json.dumps({'id':message['id'],'result':{'code':'peer-pairing'}}), flush=True)
"#,
        )
        .unwrap();
        let process = Arc::new(
            GatewayProcess::spawn(
                python,
                &host,
                root.path(),
                &root.path().join("profile"),
                json!({}),
            )
            .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(3);
        while process.snapshot()["state"] != "running" && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(process.snapshot()["state"], "running");
        let state = Arc::new(Harness::default());
        assert!(state
            .queue
            .enqueue(if discovery { None } else { Some(first.clone()) }));
        let (worker, entered, release) = state.start();
        entered.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(state.leases.load(Ordering::Acquire), 1);
        {
            let _guard = state.policy_lock();
            let account = resolve_bearer(
                "Bearer peer-token",
                [(peer.account_ref.as_str(), "peer-token")].into_iter(),
            )
            .unwrap();
            assert_eq!(
                store.route_for_account(&account, &source).unwrap().id,
                route.id
            );
        }
        assert_eq!(
            process.request("openPairing", json!({})).unwrap()["code"],
            "peer-pairing"
        );
        {
            let _guard = state.policy_lock();
            store
                .set_connection_enabled(&peer.account_ref, false)
                .unwrap();
            state.queue.cancel_connection(&peer.account_ref);
            process.stop();
            assert!(!process.alive());
            assert!(store.route_for_account(&peer.account_ref, &source).is_err());
            store.remove_connection(&peer.account_ref).unwrap();
            assert!(store.connection(&peer.account_ref).is_err());
            // Revoke the blocked target, just as stop/remove/install do, before
            // permitting verification to return its successfully checked lease.
            state.queue.cancel_all();
        }
        assert_eq!(state.leases.load(Ordering::Acquire), 1);
        release.send(()).unwrap();
        worker.join().unwrap();
        assert!(state.published.lock().unwrap().is_empty());
        assert_eq!(state.leases.load(Ordering::Acquire), 0);
    }
}

#[test]
fn stop_remove_and_maintenance_prevent_late_start_publication() {
    for action in ["stop", "remove", "install", "removeRuntime", "shutdown"] {
        let state = Arc::new(Harness::default());
        assert!(state.queue.enqueue(Some(connection("a", "old"))));
        let (worker, entered, release) = state.start();
        entered.recv_timeout(Duration::from_secs(2)).unwrap();
        {
            let _guard = state.policy_lock();
            if ["stop", "remove"].contains(&action) {
                state.queue.cancel_connection("a");
            } else {
                state.blocked.store(true, Ordering::Release);
                state.queue.cancel_all();
            }
        }
        release.send(()).unwrap();
        worker.join().unwrap();
        assert!(state.published.lock().unwrap().is_empty(), "{action}");
        assert!(!state.queue.connection_pending("a"));
        assert_eq!(state.leases.load(Ordering::Acquire), 0);
    }
}

#[test]
fn repeated_starts_coalesce_and_only_latest_credentials_are_published() {
    let state = Arc::new(Harness::default());
    assert!(state.queue.enqueue(Some(connection("a", "old"))));
    let (worker, entered, release) = state.start();
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    {
        let _guard = state.policy_lock();
        for _ in 0..100 {
            assert!(!state.queue.enqueue(Some(connection("a", "new"))));
            assert!(!state.queue.enqueue(None));
        }
        let queue = state.queue.state.lock().unwrap();
        assert_eq!(queue.jobs.len(), 2, "one request per account and discovery");
        assert_eq!(queue.current.len(), 2);
    }
    release.send(()).unwrap();
    worker.join().unwrap();
    let published = state.published.lock().unwrap();
    assert_eq!(published.len(), 2);
    assert_eq!(published[0].1.as_deref(), Some("new"));
    assert!(published[1].1.is_none());
    assert_eq!(state.leases.load(Ordering::Acquire), 0);
    assert!(!state.queue.connection_pending("a"));
    assert!(!state.queue.discovery_pending());
}

#[test]
fn maintenance_waits_outside_policy_lock_until_stale_verification_lease_is_dropped() {
    let state = Arc::new(Harness::default());
    assert!(state.queue.enqueue(None));
    let (worker, entered, release) = state.start();
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    {
        let _guard = state.policy_lock();
        state.blocked.store(true, Ordering::Release);
        state.queue.cancel_all();
    }
    let (waiting_tx, waiting_rx) = mpsc::sync_channel(1);
    let (finished_tx, finished_rx) = mpsc::sync_channel(1);
    let maintenance = state.clone();
    let waiter = thread::spawn(move || {
        waiting_tx.send(()).unwrap();
        maintenance.queue.wait_idle(|| false);
        assert_eq!(maintenance.leases.load(Ordering::Acquire), 0);
        finished_tx.send(()).unwrap();
    });
    waiting_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(finished_rx.try_recv().is_err());
    drop(state.policy_lock());
    release.send(()).unwrap();
    finished_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    worker.join().unwrap();
    waiter.join().unwrap();
    assert!(state.published.lock().unwrap().is_empty());
}

#[test]
fn installation_cancellation_wakes_waiter_without_publishing_old_start() {
    let state = Arc::new(Harness::default());
    assert!(state.queue.enqueue(None));
    let (worker, entered, release) = state.start();
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    {
        let _guard = state.policy_lock();
        state.blocked.store(true, Ordering::Release);
        state.queue.cancel_all();
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    let (finished_tx, finished_rx) = mpsc::sync_channel(1);
    let maintenance = state.clone();
    let worker_cancelled = cancelled.clone();
    let waiter = thread::spawn(move || {
        maintenance
            .queue
            .wait_idle(|| worker_cancelled.load(Ordering::Acquire));
        assert!(worker_cancelled.load(Ordering::Acquire));
        finished_tx.send(()).unwrap();
    });
    cancelled.store(true, Ordering::Release);
    state.queue.wake();
    finished_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(state.leases.load(Ordering::Acquire), 1);
    release.send(()).unwrap();
    worker.join().unwrap();
    waiter.join().unwrap();
    assert!(state.published.lock().unwrap().is_empty());
}

#[test]
fn qr_connection_wait_starts_handshake_budget_after_queue_publication() {
    use super::super::setup::ConnectionWait;

    let state = Arc::new(Harness::default());
    assert!(state.queue.enqueue(Some(connection("qr", "credentials"))));
    let (worker, entered, release) = state.start();
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    let mut wait = ConnectionWait::default();
    let start = Instant::now();
    for at in [start, start + Duration::from_secs(600)] {
        let _guard = state.policy_lock();
        let published = state.published.lock().unwrap();
        assert!(published.is_empty());
        assert!(!wait
            .ready(at, state.queue.connection_pending("qr"), None)
            .unwrap());
    }
    release.send(()).unwrap();
    worker.join().unwrap();
    {
        let _guard = state.policy_lock();
        assert_eq!(state.published.lock().unwrap().len(), 1);
        assert!(!state.queue.connection_pending("qr"));
        assert!(!wait
            .ready(start + Duration::from_secs(600), false, Some("starting"))
            .unwrap());
        assert!(wait
            .ready(start + Duration::from_secs(630), false, Some("running"))
            .unwrap());
    }
    let mut failed_handshake = ConnectionWait::default();
    assert!(!failed_handshake
        .ready(start, false, Some("starting"))
        .unwrap());
    assert!(failed_handshake
        .ready(start + Duration::from_secs(60), false, Some("starting"))
        .is_err());
    assert!(ConnectionWait::default().ready(start, false, None).is_err());
}
