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
fn replacing_channel_rotates_account_and_revokes_old_pending_input() {
    let mut f = Fixture::new();
    let route = f.route();
    let pending = challenge(&mut f, &route);
    f.store().set_setting("accountRef", "old-account").unwrap();
    f.store().replace_channel("wecom", "encrypted-new-credentials", &["WECOM_BOT_ID".into(), "WECOM_SECRET".into()]).unwrap();
    assert_ne!(f.store().setting("accountRef").unwrap().as_deref(), Some("old-account"));
    assert_eq!(f.store().setting("channelSecrets").unwrap().as_deref(), Some("encrypted-new-credentials"));
    assert!(f.store().routes().unwrap().iter().all(|r| !r.enabled));
    assert!(f.store().confirm(&route, "after-replacement", &pending, "runtime-a").is_err());
    f.restart();
    assert_eq!(f.store().setting("platform").unwrap().as_deref(), Some("wecom"));
    assert!(f.store().route(&source()).is_err());
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
