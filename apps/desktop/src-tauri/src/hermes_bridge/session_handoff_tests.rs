use super::super::{
    poll::{finish_delivery_with, reserve_delivery_with},
    store::{random_id, Source},
};
use super::*;
use crate::event_bus::SessionEventRecord;
use chrono::Utc;
use std::{fs, path::PathBuf};

struct Fixture {
    root: PathBuf,
    store: Option<Store>,
    route: Route,
    binding: SessionBinding,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("ccem-session-handoff-{}", random_id()));
        let mut store = Store::open(&root).unwrap();
        let account = store
            .save_connection(None, "wecom", Some("Bot"), "test-cipher", &[], false)
            .unwrap();
        let route = store
            .approve_route(
                Source {
                    account_ref: account.account_ref,
                    platform: "wecom".into(),
                    profile: "one".into(),
                    transport_profile: "one".into(),
                    user_id: "verified-user".into(),
                    chat_id: "verified-chat".into(),
                    thread_id: None,
                    chat_type: "dm".into(),
                },
                vec![],
                false,
                false,
            )
            .unwrap();
        let binding = store
            .bind_session(
                SessionBinding {
                    id: String::new(),
                    runtime_id: "native-one".into(),
                    route_id: route.id.clone(),
                    generation: route.generation,
                    title: "Only this session".into(),
                    model_env: "api".into(),
                    model: "model".into(),
                    cursor: 40,
                    input_context: None,
                    created_at: 0,
                    last_decision_at: None,
                    last_decision: None,
                    error: None,
                },
                &route,
            )
            .unwrap();
        Self {
            root,
            store: Some(store),
            route,
            binding,
        }
    }
    fn store(&mut self) -> &mut Store {
        self.store.as_mut().unwrap()
    }
    fn restart(&mut self) {
        self.store.take();
        self.store = Some(Store::open(&self.root).unwrap());
    }
    fn decision(&self) -> SessionDecision {
        SessionDecision {
            id: random_id(),
            binding_id: self.binding.id.clone(),
            runtime_id: self.binding.runtime_id.clone(),
            next_cursor: 45,
            input_context: Some("What is 17+25?".into()),
            events: json!([{"text":"completed"}]),
            state: "pending".into(),
            retry_after: 0,
        }
    }
    fn delivery(&self) -> Delivery {
        Delivery {
            conversation_scope: None, confirmation_preview: None,
            id: random_id(),
            route_id: self.route.id.clone(),
            generation: self.route.generation,
            text: "Result".into(),
            status: "pending".into(),
            receipt: None,
            created_at: now(),
            cron: None,
            session_binding_id: Some(self.binding.id.clone()),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.store.take();
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn exact_session_grant_does_not_expand_workspace_access() {
    let mut f = Fixture::new();
    let route = f.route.clone();
    let binding = f.binding.clone();
    assert!(route.workspaces.is_empty() && !route.allow_input && !route.notifications);
    assert!(f
        .store()
        .binding_for_route(&route, "native-two")
        .unwrap()
        .is_none());
    let scoped = binding.scoped_route(&route);
    assert_eq!(
        f.store()
            .prepare(&route, "input-one", "native-one", "continue")
            .unwrap_err(),
        "input_not_allowed"
    );
    let challenge = f
        .store()
        .prepare(&scoped, "input-one", "native-one", "continue")
        .unwrap();
    let id = challenge["challenge"].as_str().unwrap();
    assert!(f
        .store()
        .confirm(&scoped, "input-one", id, "native-one")
        .is_err());
    let (op, submit) = f
        .store()
        .confirm(&scoped, "confirm-one", id, "native-one")
        .unwrap();
    assert!(submit);
    assert!(
        !f.store()
            .confirm(&scoped, "confirm-one", id, "native-one")
            .unwrap()
            .1
    );
    let page = page(vec![SessionEventPayload::InputOperation {
        operation_id: "actual-provider-call".into(),
        client_message_ids: vec![op.id.clone()],
        provider: "claude".into(),
        stage: "completed".into(),
        detail: "real terminal".into(),
        command_id: None,
        provider_turn_id: None,
    }]);
    observe_session_operations(f.store(), &page, 40, 41).unwrap();
    assert_eq!(f.store().operation(&op.id).unwrap().state, "completed");
    let actual = f.store().routes().unwrap().remove(0);
    assert!(actual.workspaces.is_empty() && !actual.allow_input && !actual.notifications);
}

#[test]
fn detach_and_rebind_revoke_old_confirmation_decision_and_outbox() {
    let mut f = Fixture::new();
    let binding = f.binding.clone();
    let route = f.route.clone();
    let scoped = binding.scoped_route(&route);
    let challenge = f
        .store()
        .prepare(&scoped, "input", "native-one", "continue")
        .unwrap();
    let decision = f.decision();
    let delivery = f.delivery();
    f.store()
        .enqueue_session_decision(&binding, &decision)
        .unwrap();
    f.store().enqueue_delivery(&delivery).unwrap();
    f.store().detach_session("native-one", &binding.id).unwrap();
    let new = f.store().bind_session(binding.clone(), &route).unwrap();
    assert_ne!(new.id, binding.id);
    assert!(f
        .store()
        .confirm(
            &scoped,
            "confirm",
            challenge["challenge"].as_str().unwrap(),
            "native-one"
        )
        .is_err());
    assert!(f.store().pending_session_decisions().unwrap().is_empty());
    assert_eq!(
        f.store().delivery(&delivery.id).unwrap().unwrap().status,
        "revoked"
    );
    f.store()
        .finish_session_decision(&decision, Some(&delivery), None)
        .unwrap();
    assert!(reserve_delivery_with(f.store(), &delivery.id, |_| Ok(true))
        .unwrap()
        .is_none());
    assert_eq!(
        f.store()
            .detach_session("native-one", &binding.id)
            .unwrap_err(),
        "session_binding_changed"
    );
    assert_eq!(
        f.store().session_binding("native-one").unwrap().unwrap().id,
        new.id
    );
}

#[test]
fn wake_cursor_and_silent_decision_survive_restart_without_replay() {
    let mut f = Fixture::new();
    let binding = f.binding.clone();
    let decision = f.decision();
    f.store()
        .enqueue_session_decision(&binding, &decision)
        .unwrap();
    f.restart();
    assert_eq!(
        f.store()
            .session_binding("native-one")
            .unwrap()
            .unwrap()
            .cursor,
        45
    );
    assert_eq!(f.store().pending_session_decisions().unwrap().len(), 1);
    assert_eq!(
        f.store()
            .session_binding("native-one")
            .unwrap()
            .unwrap()
            .input_context
            .as_deref(),
        Some("What is 17+25?")
    );
    f.store()
        .finish_session_decision(&decision, None, None)
        .unwrap();
    f.restart();
    assert!(f.store().pending_session_decisions().unwrap().is_empty());
    assert_eq!(
        f.store()
            .session_binding("native-one")
            .unwrap()
            .unwrap()
            .last_decision
            .as_deref(),
        Some("silent")
    );
    assert!(f.store().deliveries().unwrap().is_empty());
    assert!(f
        .store()
        .enqueue_session_decision(&binding, &decision)
        .is_err());
}

#[test]
fn model_error_retries_judgment_but_sends_only_one_durable_result() {
    let mut f = Fixture::new();
    let binding = f.binding.clone();
    let decision = f.decision();
    let delivery = f.delivery();
    f.store()
        .enqueue_session_decision(&binding, &decision)
        .unwrap();
    f.store()
        .finish_session_decision(&decision, None, Some("model_failed"))
        .unwrap();
    f.restart();
    let retry = f.store().pending_session_decisions().unwrap().remove(0);
    assert!(retry.retry_after > now());
    assert!(f.store().deliveries().unwrap().is_empty());
    f.store()
        .finish_session_decision(&retry, Some(&delivery), None)
        .unwrap();
    f.store()
        .finish_session_decision(&retry, Some(&delivery), None)
        .unwrap();
    assert_eq!(f.store().deliveries().unwrap().len(), 1);
    let (reserved, route) = reserve_delivery_with(f.store(), &delivery.id, |_| Ok(false))
        .unwrap()
        .unwrap();
    assert_eq!(route.source.chat_id, "verified-chat");
    finish_delivery_with(
        f.store(),
        &reserved,
        Ok(json!({"status":"sent"})),
        true,
        |_| Ok(false),
    )
    .unwrap();
    assert_eq!(
        f.store().delivery(&delivery.id).unwrap().unwrap().status,
        "sent"
    );
    assert!(
        reserve_delivery_with(f.store(), &delivery.id, |_| Ok(false))
            .unwrap()
            .is_none()
    );
}

#[test]
fn revocation_during_send_is_unknown_and_cannot_retry() {
    let mut f = Fixture::new();
    let delivery = f.delivery();
    let binding = f.binding.clone();
    f.store().enqueue_delivery(&delivery).unwrap();
    let (reserved, _) = reserve_delivery_with(f.store(), &delivery.id, |_| Ok(false))
        .unwrap()
        .unwrap();
    f.store().detach_session("native-one", &binding.id).unwrap();
    finish_delivery_with(
        f.store(),
        &reserved,
        Ok(json!({"status":"sent"})),
        true,
        |_| Ok(false),
    )
    .unwrap();
    assert_eq!(
        f.store().delivery(&delivery.id).unwrap().unwrap().status,
        "unknown"
    );
    assert!(reserve_delivery_with(f.store(), &delivery.id, |_| Ok(true))
        .unwrap()
        .is_none());
}

#[test]
fn pairing_generation_change_revokes_current_session_delivery() {
    let mut f = Fixture::new();
    let delivery = f.delivery();
    let binding = f.binding.clone();
    let route = f.route.clone();
    f.store().enqueue_delivery(&delivery).unwrap();
    f.store()
        .approve_route(route.source, vec![], false, false)
        .unwrap();
    assert!(f.store().binding_route(&binding).unwrap().is_none());
    assert!(reserve_delivery_with(f.store(), &delivery.id, |_| Ok(true))
        .unwrap()
        .is_none());
}

fn page(payloads: Vec<SessionEventPayload>) -> NativeEventReplayPage {
    let events: Vec<_> = payloads
        .into_iter()
        .enumerate()
        .map(|(i, payload)| SessionEventRecord {
            runtime_id: "native-one".into(),
            seq: 41 + i as u64,
            occurred_at: Utc::now(),
            payload,
        })
        .collect();
    NativeEventReplayPage {
        source_available: true,
        gap_detected: false,
        decode_failure_count: 0,
        oversized_event_count: 0,
        oldest_available_seq: Some(1),
        snapshot_newest_seq: events.last().map(|e| e.seq),
        next_cursor: events.last().map(|e| e.seq),
        has_more: false,
        events,
    }
}

#[test]
fn unicode_history_is_bounded_and_no_events_are_skipped_between_pages() {
    let page = page(
        (0..100)
            .map(|_| SessionEventPayload::ToolUseCompleted {
                tool_use_id: "tool".into(),
                raw_name: "名".repeat(50_000),
                result_summary: "结果".repeat(2000),
                result_content: None,
                success: true,
                todo_snapshot: None,
            })
            .collect(),
    );
    let mut cursor = 40;
    let mut seen = Vec::new();
    while cursor < 140 {
        let (next, events) = bounded_session_events(&page, cursor);
        assert!(next > cursor && serde_json::to_vec(&events).unwrap().len() < 24_100);
        for event in events {
            seen.push(event["seq"].as_u64().unwrap());
        }
        cursor = next;
    }
    assert_eq!(seen, (41..=140).collect::<Vec<_>>());
}

#[test]
fn pending_model_error_does_not_hold_back_the_input_operation_ledger() {
    let mut f = Fixture::new();
    let binding = f.binding.clone();
    let decision = f.decision();
    let scoped = binding.scoped_route(&f.route);
    f.store()
        .enqueue_session_decision(&binding, &decision)
        .unwrap();
    f.store()
        .finish_session_decision(&decision, None, Some("model_failed"))
        .unwrap();
    let challenge = f
        .store()
        .prepare(&scoped, "input-new", "native-one", "continue")
        .unwrap();
    let (op, _) = f
        .store()
        .confirm(
            &scoped,
            "confirm-new",
            challenge["challenge"].as_str().unwrap(),
            "native-one",
        )
        .unwrap();
    let mut page = page(vec![SessionEventPayload::InputOperation {
        operation_id: "provider-new".into(),
        client_message_ids: vec![op.id.clone()],
        provider: "codex".into(),
        stage: "completed".into(),
        detail: "result".into(),
        command_id: None,
        provider_turn_id: None,
    }]);
    page.events[0].seq = 46;
    observe_session_operations(f.store(), &page, 45, 46).unwrap();
    f.store()
        .enqueue_page("session-input:test", 46, &[])
        .unwrap();
    f.restart();
    assert_eq!(f.store().operation(&op.id).unwrap().state, "completed");
    assert_eq!(f.store().cursor("session-input:test").unwrap(), Some(46));
    assert_eq!(f.store().pending_session_decisions().unwrap().len(), 1);
}
