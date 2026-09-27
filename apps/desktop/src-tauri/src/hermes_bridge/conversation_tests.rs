use super::*;
use super::super::{poll::{finish_delivery_with, reserve_delivery_with}, store::*};
use std::{collections::HashMap, fs, path::PathBuf};

struct Fixture { root: PathBuf, store: Option<Store>, route: Route, shown: HashMap<String, PresentedInput> }
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("ccem-hermes-chat-{}", random_id()));
        fs::create_dir_all(root.join("workspace")).unwrap();
        let mut store = Store::open(&root.join("state")).unwrap();
        let route = store.approve_route(Source { account_ref:"account".into(), platform:"wecom".into(), profile:"managed".into(),
            transport_profile:"managed".into(), user_id:"user".into(), chat_id:"chat".into(), thread_id:None, chat_type:"dm".into() },
            vec![root.join("workspace").to_string_lossy().into_owned()], true, false).unwrap();
        Self { root, store:Some(store), route, shown:HashMap::new() }
    }
    fn s(&mut self) -> &mut Store { self.store.as_mut().unwrap() }
    fn prepare(&mut self, message: &str) -> String {
        let route=self.route.clone();
        self.s().prepare(&route, message, "runtime", "Original frozen instruction").unwrap()["challenge"].as_str().unwrap().into()
    }
    fn delivery(&self, challenge: Option<&str>) -> Delivery {
        Delivery { id:random_id(), route_id:self.route.id.clone(), generation:self.route.generation,
            text:"Original frozen instruction".into(), status:"pending".into(), receipt:None, created_at:now(), cron:None,
            session_binding_id:None, conversation_scope:Some(scope(&self.route)),
            confirmation_preview:challenge.map(|c| ConfirmationPreview { challenge:c.into(), owner:digest("Bearer fixture") }) }
    }
    fn finish(&mut self, delivery: &Delivery, status: &str, same_host: bool) {
        finish_delivery_with(self.s(), delivery, Ok(json!({"status":status,"confirmedAtNs":200})), same_host, |_| Ok(false)).unwrap();
        if let Some(shown)=presented_from_delivery(self.s(), &delivery.id).unwrap() { self.shown.insert(shown.challenge.clone(), shown); }
    }
    fn choose(&self, message: &str) -> Result<String, String> {
        self.choose_at(message, Some(300))
    }
    fn choose_at(&self, message: &str, received_at_ns: Option<u64>) -> Result<String, String> {
        select_confirmation(self.store.as_ref().unwrap(), &self.route, "Bearer fixture", message, "ccem.bridge.confirm", received_at_ns, &self.shown)
    }
    fn restart(&mut self) {
        self.store.take(); self.store=Some(Store::open(&self.root.join("state")).unwrap()); self.shown.clear();
    }
}
impl Drop for Fixture { fn drop(&mut self) { self.store.take(); let _=fs::remove_dir_all(&self.root); } }

#[test]
fn queued_and_sending_preview_cannot_confirm_until_verified_ack() {
    let mut f=Fixture::new(); let c=f.prepare("input-a"); let d=f.delivery(Some(&c)); f.s().enqueue_delivery(&d).unwrap();
    assert!(presented_from_delivery(f.s(), &d.id).unwrap().is_none());
    assert!(f.choose("too-early").is_err());
    let (reserved,_)=reserve_delivery_with(f.s(), &d.id, |_| Ok(false)).unwrap().unwrap();
    assert!(presented_from_delivery(f.s(), &d.id).unwrap().is_none());
    f.finish(&reserved,"sent",true);
    assert_eq!(f.choose("user-confirm").unwrap(),c);
    // A previously rejected native message is never reinterpreted after delivery.
    assert!(f.choose("too-early").is_err());
    let route=f.route.clone();
    assert!(f.s().confirm(&route,"user-confirm",&c,"runtime").unwrap().1);
    assert!(!f.s().confirm(&route,"user-confirm",&c,"runtime").unwrap().1);
    assert_eq!(f.s().operations().unwrap().len(),1);
}

#[test]
fn failed_or_unknown_delivery_never_opens_confirmation_and_is_not_retried() {
    for (status,same_host) in [("not_sent",true),("unknown",true),("sent",false)] {
        let mut f=Fixture::new();let c=f.prepare("input-a");let d=f.delivery(Some(&c));f.s().enqueue_delivery(&d).unwrap();
        let (reserved,_)=reserve_delivery_with(f.s(),&d.id,|_|Ok(false)).unwrap().unwrap();f.finish(&reserved,status,same_host);
        assert!(f.shown.is_empty());assert!(f.choose("confirm").is_err());
        assert!(reserve_delivery_with(f.s(),&d.id,|_|Ok(false)).unwrap().is_none());assert!(f.s().operations().unwrap().is_empty());
    }
}

#[test]
fn restart_owner_change_and_rebinding_cannot_authorize_old_preview() {
    let mut f=Fixture::new();let c=f.prepare("input-a");let d=f.delivery(Some(&c));f.s().enqueue_delivery(&d).unwrap();
    let (reserved,_)=reserve_delivery_with(f.s(),&d.id,|_|Ok(false)).unwrap().unwrap();f.finish(&reserved,"sent",true);
    let route=f.route.clone();
    let shown=f.shown.clone();
    assert!(select_confirmation(f.s(),&route,"Bearer other","other-owner","ccem.bridge.confirm",Some(300),&shown).is_err());
    f.restart();assert!(f.choose("after-restart").is_err());
    let old=f.route.clone();f.route=f.s().approve_route(old.source,old.workspaces,true,false).unwrap();
    assert!(f.choose("after-restart").is_err());assert!(f.s().operations().unwrap().is_empty());
}

#[test]
fn confirmation_received_before_ack_cannot_be_upgraded_by_processing_delay() {
    let mut f=Fixture::new();let c=f.prepare("input-a");let d=f.delivery(Some(&c));f.s().enqueue_delivery(&d).unwrap();
    // The native event arrived at 100, then waited for a command slot. ACK at
    // 200 precedes its first Rust call; checking only the processing time is unsafe.
    let (reserved,_)=reserve_delivery_with(f.s(),&d.id,|_|Ok(false)).unwrap().unwrap();f.finish(&reserved,"sent",true);
    for (message, stamp) in [("queued-early",Some(100)),("same-instant",Some(200)),("missing-ingress",None)] {
        assert_eq!(f.choose_at(message,stamp).unwrap_err(),"no_presented_confirmation");
        assert!(f.choose_at(message,Some(300)).is_err());
    }
    let route=f.route.clone();assert_eq!(f.choose_at("after-ack",Some(300)).unwrap(),c);
    assert!(f.s().confirm(&route,"after-ack",&c,"runtime").unwrap().1);
    f.restart();assert!(f.choose_at("queued-early",Some(400)).is_err());
    assert_eq!(f.choose_at("after-ack",Some(400)).unwrap(),c);
    assert!(!f.s().confirm(&route,"after-ack",&c,"runtime").unwrap().1);
    assert_eq!(f.s().operations().unwrap().len(),1);
}

#[test]
fn unstamped_ack_cannot_open_short_confirmation() {
    for stamp in [Value::Null,json!(0),json!(-1),json!(true),json!(1.5),json!("200")] {
        let mut f=Fixture::new();let c=f.prepare("input-a");let d=f.delivery(Some(&c));f.s().enqueue_delivery(&d).unwrap();
        let (reserved,_)=reserve_delivery_with(f.s(),&d.id,|_|Ok(false)).unwrap().unwrap();
        finish_delivery_with(f.s(),&reserved,Ok(json!({"status":"sent","confirmedAtNs":stamp})),true,|_|Ok(false)).unwrap();
        assert!(presented_from_delivery(f.s(),&d.id).unwrap().is_none());
        assert!(f.choose("missing-ack-stamp").is_err());
    }
}

#[test]
fn multiple_pending_is_rejected_even_if_only_one_preview_was_shown() {
    let mut f=Fixture::new();let c=f.prepare("input-a");let d=f.delivery(Some(&c));f.s().enqueue_delivery(&d).unwrap();
    let (reserved,_)=reserve_delivery_with(f.s(),&d.id,|_|Ok(false)).unwrap().unwrap();f.finish(&reserved,"sent",true);
    let other=f.prepare("input-b");assert_eq!(f.choose("ambiguous").unwrap_err(),"ambiguous_confirmation");
    let route=f.route.clone();f.s().cancel(&route,&other).unwrap();
    assert!(f.choose("ambiguous").is_err());assert_eq!(f.choose("new-confirm").unwrap(),c);assert!(f.s().operations().unwrap().is_empty());
}

#[test]
fn duplicate_confirm_never_selects_a_newer_challenge_even_after_restart() {
    let mut f=Fixture::new();let c=f.prepare("input-a");let d=f.delivery(Some(&c));f.s().enqueue_delivery(&d).unwrap();
    let (reserved,_)=reserve_delivery_with(f.s(),&d.id,|_|Ok(false)).unwrap().unwrap();f.finish(&reserved,"sent",true);
    f.choose("confirmed-a").unwrap();let route=f.route.clone();assert!(f.s().confirm(&route,"confirmed-a",&c,"runtime").unwrap().1);
    let other=f.prepare("input-b");f.restart();assert_eq!(f.choose("confirmed-a").unwrap(),c);
    assert!(!f.s().confirm(&route,"confirmed-a",&c,"runtime").unwrap().1);
    assert_eq!(f.s().challenge_state(&route,&other).unwrap().1,"pending");assert_eq!(f.s().operations().unwrap().len(),1);
    assert!(f.s().short_reply_choice(&route,"confirmed-a","ccem.bridge.cancel",None).is_err());
}

#[test]
fn revoked_route_or_cancelled_input_stops_queued_preview() {
    for revoke in [true,false] {
        let mut f=Fixture::new();let c=f.prepare("input-a");let d=f.delivery(Some(&c));f.s().enqueue_delivery(&d).unwrap();let route=f.route.clone();
        if revoke { f.s().disable_route(&route.id).unwrap(); } else { f.s().cancel(&route,&c).unwrap(); }
        assert!(reserve_delivery_with(f.s(),&d.id,|_|Ok(false)).unwrap().is_none());assert!(f.s().operations().unwrap().is_empty());
    }
}

#[test]
fn zero_workspace_conversation_can_reply_but_cannot_execute() {
    let mut f=Fixture::new();let source=f.route.source.clone();f.route=f.s().approve_route(source,vec![],false,false).unwrap();
    let d=f.delivery(None);f.s().enqueue_delivery(&d).unwrap();assert!(reserve_delivery_with(f.s(),&d.id,|_|Ok(false)).unwrap().is_some());
    let route=f.route.clone();assert!(f.s().prepare(&route,"input","runtime","run").is_err());assert!(f.s().operations().unwrap().is_empty());
}
