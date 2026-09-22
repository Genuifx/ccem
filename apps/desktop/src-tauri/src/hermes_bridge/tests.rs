use super::store::*;
use serde_json::json;
use std::{fs, path::PathBuf};

struct Fixture {
    root: PathBuf,
    store: Option<Store>,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("ccem-hermes-{}", random_id()));
        fs::create_dir_all(root.join("workspace")).unwrap();
        let store = Store::open(&root.join("state")).unwrap();
        Self {
            root,
            store: Some(store),
        }
    }
    fn store(&mut self) -> &mut Store {
        self.store.as_mut().unwrap()
    }
    fn route(&mut self) -> Route {
        let workspace = self.root.join("workspace").to_string_lossy().into_owned();
        self.store()
            .approve_route(source(), vec![workspace], true, true)
            .unwrap()
    }
    fn restart(&mut self) {
        self.store.take();
        self.store = Some(Store::open(&self.root.join("state")).unwrap())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.store.take();
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn source() -> Source {
    Source {
        account_ref: "test-account".into(),
        platform: "test".into(),
        profile: "custom".into(),
        transport_profile: "custom".into(),
        user_id: "subject".into(),
        chat_id: "target".into(),
        thread_id: Some("thread".into()),
        chat_type: "dm".into(),
    }
}
fn challenge(f: &mut Fixture, r: &Route) -> String {
    f.store()
        .prepare(r, "input-message", "runtime-a", "continue exactly this")
        .unwrap()["challenge"]
        .as_str()
        .unwrap()
        .into()
}

#[test]
fn native_identity_and_destination_must_both_match() {
    let mut f = Fixture::new();
    f.route();
    assert!(f.store().route(&source()).is_ok());
    for field in 0..6 {
        let mut s = source();
        match field {
            0 => s.user_id = "other".into(),
            1 => s.chat_id = "other".into(),
            2 => s.thread_id = None,
            3 => s.profile = "other".into(),
            4 => s.transport_profile = "other".into(),
            _ => s.account_ref = "other".into(),
        };
        assert!(f.store().route(&s).is_err())
    }
}
#[test]
fn separate_confirmation_reserves_submission_only_once_across_restart() {
    let mut f = Fixture::new();
    let r = f.route();
    let c = challenge(&mut f, &r);
    assert!(f
        .store()
        .confirm(&r, "input-message", &c, "runtime-a")
        .is_err());
    let (op, submit) = f
        .store()
        .confirm(&r, "confirm-message", &c, "runtime-a")
        .unwrap();
    assert!(submit);
    assert_eq!(op.text, "continue exactly this");
    assert!(
        !f.store()
            .confirm(&r, "confirm-message", &c, "runtime-a")
            .unwrap()
            .1
    );
    assert!(
        !f.store()
            .confirm(&r, "new-confirm-message", &c, "runtime-a")
            .unwrap()
            .1
    );
    f.restart();
    assert_eq!(f.store().operation(&op.id).unwrap().state, "unknown");
    let (again, submit) = f
        .store()
        .confirm(&r, "confirm-message", &c, "runtime-a")
        .unwrap();
    assert!(!submit);
    assert_eq!(again.id, op.id);
}
#[test]
fn input_replay_freezes_payload_and_conflicts_fail_closed() {
    let mut f = Fixture::new();
    let r = f.route();
    let c = challenge(&mut f, &r);
    assert_eq!(challenge(&mut f, &r), c);
    assert!(f
        .store()
        .prepare(&r, "input-message", "runtime-a", "changed text")
        .is_err());
    assert!(f
        .store()
        .prepare(&r, "input-message", "runtime-b", "continue exactly this")
        .is_err());
    assert!(f.store().prepare(&r, "", "runtime-a", "text").is_err());
}
#[test]
fn confirmation_message_cannot_confirm_different_challenges() {
    let mut f = Fixture::new();
    let r = f.route();
    let first = challenge(&mut f, &r);
    let second = f
        .store()
        .prepare(&r, "input-2", "runtime-a", "different")
        .unwrap()["challenge"]
        .as_str()
        .unwrap()
        .to_string();
    f.store()
        .confirm(&r, "confirm-message", &first, "runtime-a")
        .unwrap();
    assert!(f
        .store()
        .confirm(&r, "confirm-message", &second, "runtime-a")
        .is_err());
    assert!(f
        .store()
        .confirm(&r, "other-message", &second, "wrong-runtime")
        .is_err());
}
#[test]
fn revocation_and_scope_change_invalidate_pending_challenges() {
    let mut f = Fixture::new();
    let r = f.route();
    let c = challenge(&mut f, &r);
    f.store().disable_route(&r.id).unwrap();
    assert!(f.store().route(&source()).is_err());
    let new = f.route();
    assert!(new.generation > r.generation);
    assert!(f.store().confirm(&new, "confirm", &c, "runtime-a").is_err());
}
#[test]
fn cancelled_challenge_is_never_submitted() {
    let mut f = Fixture::new();
    let r = f.route();
    let c = challenge(&mut f, &r);
    f.store().cancel(&r, &c).unwrap();
    assert!(f.store().confirm(&r, "confirm", &c, "runtime-a").is_err());
}
#[test]
fn editing_connection_retains_identity_and_revokes_only_its_authorization() {
    let mut f = Fixture::new();
    let connection = f
        .store()
        .save_connection(None, "test", None, "encrypted-old-credentials", &[], true)
        .unwrap();
    let mut own_source = source();
    own_source.account_ref = connection.account_ref.clone();
    let workspace = f.root.join("workspace").to_string_lossy().into_owned();
    let route = f
        .store()
        .approve_route(own_source.clone(), vec![workspace], true, true)
        .unwrap();
    let unrelated = f.route();
    let pending = challenge(&mut f, &route);
    let changed = f
        .store()
        .save_connection(
            Some(&connection.account_ref),
            "test",
            None,
            "encrypted-new-credentials",
            &[],
            true,
        )
        .unwrap();
    assert_eq!(changed.account_ref, connection.account_ref);
    assert_eq!(changed.cipher, "encrypted-new-credentials");
    assert!(f.store().route(&unrelated.source).is_ok());
    assert!(f
        .store()
        .confirm(&route, "after-replacement", &pending, "runtime-a")
        .is_err());
    f.restart();
    assert_eq!(
        f.store()
            .connection(&connection.account_ref)
            .unwrap()
            .cipher,
        "encrypted-new-credentials"
    );
    assert!(f.store().route(&own_source).is_err());
    assert!(f.store().route(&unrelated.source).is_ok());
}
#[test]
fn exact_invocation_is_required_for_terminal_state() {
    let mut f = Fixture::new();
    let r = f.route();
    let c = challenge(&mut f, &r);
    let (op, _) = f.store().confirm(&r, "confirm", &c, "runtime-a").unwrap();
    f.store()
        .observe_operation(
            &op.id,
            "wrong-runtime",
            "invocation-a",
            "completed",
            "wrong",
        )
        .unwrap();
    assert_eq!(f.store().operation(&op.id).unwrap().state, "submitting");
    f.store()
        .observe_operation(&op.id, "runtime-a", "invocation-a", "started", "started")
        .unwrap();
    assert_eq!(f.store().operation(&op.id).unwrap().state, "running");
    f.store()
        .observe_operation(&op.id, "runtime-a", "invocation-a", "completed", "verified")
        .unwrap();
    assert_eq!(f.store().operation(&op.id).unwrap().state, "completed");
    f.store()
        .observe_operation(
            &op.id,
            "runtime-a",
            "invocation-b",
            "completed",
            "duplicate execution",
        )
        .unwrap();
    assert_eq!(f.store().operation(&op.id).unwrap().state, "unknown");
    f.store()
        .observe_operation(&op.id, "runtime-a", "invocation-a", "completed", "replayed")
        .unwrap();
    assert_eq!(f.store().operation(&op.id).unwrap().state, "unknown");
}
#[test]
fn outbox_cursor_is_atomic_and_ambiguous_send_is_not_requeued() {
    let mut f = Fixture::new();
    let r = f.route();
    let d = Delivery {
        id: "event-a".into(),
        route_id: r.id.clone(),
        generation: r.generation,
        text: "done".into(),
        status: "pending".into(),
        receipt: None,
        created_at: now(),
    };
    f.store().enqueue_page("cursor", 42, &[d.clone()]).unwrap();
    f.store().enqueue_page("cursor", 42, &[d.clone()]).unwrap();
    assert_eq!(f.store().deliveries().unwrap().len(), 1);
    assert_eq!(f.store().cursor("cursor").unwrap(), Some(42));
    let mut sending = d;
    sending.status = "sending".into();
    f.store().save_delivery(&sending).unwrap();
    f.restart();
    assert_eq!(f.store().deliveries().unwrap()[0].status, "unknown");
    f.store().enqueue_page("cursor", 42, &[sending]).unwrap();
    assert_eq!(f.store().deliveries().unwrap()[0].status, "unknown");
}
#[test]
fn same_store_has_one_process_owner() {
    let f = Fixture::new();
    assert!(Store::open(&f.root.join("state")).is_err());
}
#[test]
fn workspace_scope_is_canonical_and_not_string_prefix() {
    let mut f = Fixture::new();
    let r = f.route();
    let child = f.root.join("workspace/child");
    fs::create_dir_all(&child).unwrap();
    let sibling = f.root.join("workspace-other");
    fs::create_dir_all(&sibling).unwrap();
    assert!(r.permits(child.to_str().unwrap()));
    assert!(!r.permits(sibling.to_str().unwrap()));
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&sibling, f.root.join("workspace/escape")).unwrap();
        assert!(!r.permits(f.root.join("workspace/escape").to_str().unwrap()))
    }
    assert!(f
        .store()
        .approve_route(source(), vec!["/".into()], true, true)
        .is_err());
}
#[test]
fn source_deserialization_rejects_model_asserted_extra_fields() {
    let mut value = json!(source());
    value["authorized"] = json!(true);
    assert!(serde_json::from_value::<Source>(value).is_err());
}

#[test]
fn bearer_capabilities_are_account_bound_and_removed_tokens_expire() {
    let mut accounts = std::collections::HashMap::from([
        ("account-a".to_string(), "token-a".to_string()),
        ("account-b".to_string(), "token-b".to_string()),
    ]);
    let resolve = |header: &str, accounts: &std::collections::HashMap<String, String>| {
        super::resolve_bearer(
            header,
            accounts.iter().map(|(a, t)| (a.as_str(), t.as_str())),
        )
    };
    assert_eq!(
        resolve("Bearer token-a", &accounts).as_deref(),
        Some("account-a")
    );
    assert_eq!(
        resolve("Bearer token-b", &accounts).as_deref(),
        Some("account-b")
    );
    assert!(resolve("Bearer discovery-token", &accounts).is_none());
    assert!(resolve("Bearer token-a-extra", &accounts).is_none());
    accounts.insert("account-a".into(), "rotated-token-a".into());
    assert!(resolve("Bearer token-a", &accounts).is_none());
    assert_eq!(
        resolve("Bearer token-b", &accounts).as_deref(),
        Some("account-b")
    );
    accounts.remove("account-b");
    assert!(resolve("Bearer token-b", &accounts).is_none());
}

#[test]
fn notification_budget_is_bounded_for_multibyte_text() {
    for text in ["x".repeat(2000), "完成🤖".repeat(1000)] {
        let result = super::bounded_chat_text(&text);
        assert!(result.len() <= 1800);
        assert!(result.ends_with('…'));
    }
    assert_eq!(super::bounded_chat_text(&"x".repeat(1800)).len(), 1800);
}

#[test]
fn long_notifications_preserve_the_full_query_command() {
    let mut fixture = Fixture::new();
    let route = fixture.route();
    for (command, id) in [
        ("operation", "operation-full-identity"),
        ("status", "runtime-full-identity"),
    ] {
        let tail = format!("/ccem {command} {id}");
        let text = format!("CCEM · Long task\n{}\n{tail}", "完成🤖".repeat(1000));
        let delivery = super::make_delivery(&route, command, text);
        assert!(delivery.text.len() <= 1800);
        assert!(delivery.text.starts_with("CCEM · Long task\n"));
        assert!(delivery.text.ends_with(&format!("…\n{tail}")));
        assert_eq!(delivery.text.lines().last(), Some(tail.as_str()));
    }
}

#[test]
fn history_projection_failure_does_not_turn_a_running_connection_into_a_retry_card() {
    let mut live =
        json!({"state":"running", "pending":[{"id":"pairing"}], "pairing":{"code":"code"}});
    super::apply_connection_error(&mut live, "event_history_incomplete");
    assert_eq!(live["state"], "running");
    assert_eq!(live["error"], "event_history_incomplete");
    assert_eq!(live["pending"][0]["id"], "pairing");
    assert_eq!(live["pairing"]["code"], "code");

    let mut failed_start = json!({"state":"stopped"});
    super::apply_connection_error(&mut failed_start, "gateway_spawn_failed");
    assert_eq!(failed_start["state"], "error");
    assert_eq!(failed_start["error"], "gateway_spawn_failed");

    let mut network_error = json!({"state":"error", "error":"connection_failed"});
    super::apply_connection_error(&mut network_error, "old_history_gap");
    assert_eq!(
        network_error["error"], "connection_failed",
        "the current transport error outranks an older projection diagnostic"
    );
}

#[test]
fn queued_runtime_start_rechecks_install_reservation_after_acquiring_lifecycle() {
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    };
    let lifecycle = Arc::new(Mutex::new(()));
    let installing = Arc::new(AtomicBool::new(false));
    let launches = Arc::new(AtomicUsize::new(0));
    let owner = lifecycle.lock().unwrap();
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let worker_lifecycle = lifecycle.clone();
    let worker_installing = installing.clone();
    let worker_launches = launches.clone();
    let worker = std::thread::spawn(move || {
        assert!(!worker_installing.load(Ordering::Acquire));
        ready_tx.send(()).unwrap();
        match super::idle_lifecycle(&worker_lifecycle, &worker_installing) {
            Ok(_guard) => {
                worker_launches.fetch_add(1, Ordering::AcqRel);
                Ok(())
            }
            Err(error) => Err(error),
        }
    });
    ready_rx
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap();
    // An update wins the lifecycle lock after the watcher/UI preflight saw idle.
    installing.store(true, Ordering::Release);
    drop(owner);
    assert_eq!(
        worker.join().unwrap().unwrap_err(),
        "installation_already_running"
    );
    assert_eq!(launches.load(Ordering::Acquire), 0);
    assert_eq!(
        super::idle_lifecycle(&lifecycle, &installing)
            .err()
            .unwrap(),
        "installation_already_running"
    );
    installing.store(false, Ordering::Release);
    assert!(
        super::idle_lifecycle(&lifecycle, &installing).is_ok(),
        "retry is allowed after the installation settles"
    );
}
