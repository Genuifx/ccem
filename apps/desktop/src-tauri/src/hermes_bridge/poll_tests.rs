use super::super::store::{now, random_id, Source};
use super::*;
use chrono::Utc;
use std::{cell::RefCell, fs, path::PathBuf};

struct Fixture {
    root: PathBuf,
    store: Option<Store>,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("ccem-hermes-poll-{}", random_id()));
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
    fn restart(&mut self) {
        self.store.take();
        self.store = Some(Store::open(&self.root.join("state")).unwrap());
    }
    fn route(&mut self, user: &str) -> Route {
        let workspace = self.root.join("workspace").to_string_lossy().into_owned();
        self.store()
            .approve_route(
                Source {
                    account_ref: "account".into(),
                    platform: "test".into(),
                    profile: "profile".into(),
                    transport_profile: "transport".into(),
                    user_id: user.into(),
                    chat_id: format!("chat-{user}"),
                    thread_id: None,
                    chat_type: "dm".into(),
                },
                vec![workspace],
                true,
                true,
            )
            .unwrap()
    }
    fn session(&self, runtime: &str) -> PollSession {
        PollSession {
            runtime_id: runtime.into(),
            project_dir: self.root.join("workspace").to_string_lossy().into_owned(),
            title: runtime.into(),
            created_at: now(),
            last_event_seq: Some(100),
        }
    }
    fn operation(&mut self, route: &Route, runtime: &str) -> Operation {
        let input = random_id();
        let challenge = self
            .store()
            .prepare(route, &input, runtime, "continue remotely")
            .unwrap();
        self.store()
            .confirm(
                route,
                &random_id(),
                challenge["challenge"].as_str().unwrap(),
                runtime,
            )
            .unwrap()
            .0
    }
    fn project(
        &mut self,
        route: &Route,
        session: &PollSession,
        start: u64,
        payloads: Vec<SessionEventPayload>,
    ) {
        let page = page(&session.runtime_id, start, payloads);
        project_page(self.store(), route, session, &page).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.store.take();
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn page(runtime: &str, start: u64, payloads: Vec<SessionEventPayload>) -> NativeEventReplayPage {
    let events: Vec<_> = payloads
        .into_iter()
        .enumerate()
        .map(|(index, payload)| SessionEventRecord {
            runtime_id: runtime.into(),
            seq: start + index as u64,
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
        snapshot_newest_seq: events.last().map(|event| event.seq),
        next_cursor: events.last().map(|event| event.seq),
        has_more: false,
        events,
    }
}
fn prompt(id: Option<&str>) -> SessionEventPayload {
    SessionEventPayload::UserPrompt {
        text: "real input".into(),
        image_count: 0,
        client_message_id: id.map(str::to_owned),
        images: None,
        annotations: None,
        canonical_hash: None,
    }
}
fn lifecycle(stage: &str) -> SessionEventPayload {
    SessionEventPayload::Lifecycle {
        stage: stage.into(),
        detail: stage.into(),
        assistant_message_uuid: None,
        command_id: None,
        query_generation: None,
        user_message_uuid: None,
    }
}
fn input(invocation: &str, ids: &[&str], stage: &str) -> SessionEventPayload {
    SessionEventPayload::InputOperation {
        operation_id: invocation.into(),
        client_message_ids: ids.iter().map(|id| (*id).to_string()).collect(),
        provider: "codex".into(),
        stage: stage.into(),
        detail: format!("{invocation} {stage}"),
        command_id: None,
        provider_turn_id: None,
    }
}

#[test]
fn removing_all_workspace_access_stops_projection_and_revokes_pending_delivery() {
    let mut f = Fixture::new();
    let route = f.route("one");
    let session = f.session("runtime-a");
    let delivery = make_delivery(&route, "old-notice", "old completion".into());
    f.store()
        .enqueue_page("old-cursor", 1, &[delivery.clone()])
        .unwrap();
    let unbound = f
        .store()
        .approve_route(route.source.clone(), vec![], true, true)
        .unwrap();
    let mut visits = 0;
    poll_cycle(
        &[unbound],
        &[session],
        |_, _| {
            visits += 1;
            Ok(())
        },
        || Ok(()),
    )
    .unwrap();
    assert_eq!(
        visits, 0,
        "no session events can be read for an unbound account"
    );
    assert!(reserve_delivery(f.store(), &delivery.id).unwrap().is_none());
    assert_eq!(
        f.store().delivery(&delivery.id).unwrap().unwrap().status,
        "revoked"
    );
    assert_eq!(f.store().deliveries().unwrap().len(), 1);
}

#[test]
fn local_remote_confirm_local_notifies_once_each_across_pages_and_restart() {
    let mut f = Fixture::new();
    let route = f.route("one");
    let session = f.session("runtime");
    f.project(
        &route,
        &session,
        1,
        vec![
            prompt(None),
            lifecycle("turn_started"),
            lifecycle("turn_completed"),
        ],
    );
    assert_eq!(f.store().deliveries().unwrap().len(), 1);
    let operation = f.operation(&route, &session.runtime_id);
    f.project(
        &route,
        &session,
        4,
        vec![
            prompt(Some(&operation.id)),
            input("remote", &[&operation.id], "started"),
        ],
    );
    f.restart();
    f.project(
        &route,
        &session,
        6,
        vec![
            input("remote", &[&operation.id], "completed"),
            lifecycle("turn_completed"),
            SessionEventPayload::SessionCompleted {
                reason: "same remote terminal".into(),
            },
        ],
    );
    assert_eq!(f.store().deliveries().unwrap().len(), 2);
    assert_eq!(
        f.store().operation(&operation.id).unwrap().state,
        "completed"
    );
    f.restart();
    let local = vec![
        prompt(Some("local-again")),
        input("local-turn", &["local-again"], "started"),
        input("local-turn", &["local-again"], "completed"),
        lifecycle("turn_completed"),
    ];
    f.project(&route, &session, 9, local.clone());
    f.restart();
    f.project(&route, &session, 9, local);
    let deliveries = f.store().deliveries().unwrap();
    assert_eq!(
        deliveries.len(),
        3,
        "old remote operation cannot suppress the next local input or duplicate its terminal"
    );
    assert_eq!(
        deliveries
            .iter()
            .filter(|d| d.text.contains("/ccem operation"))
            .count(),
        1
    );
    assert_eq!(
        deliveries
            .iter()
            .filter(|d| d.text.contains("/ccem status"))
            .count(),
        2
    );
    let key = cursor_key(&route, &session.runtime_id);
    let state: InputState =
        serde_json::from_str(&f.store().notification_input_state(&key).unwrap().unwrap()).unwrap();
    assert!(!state.current.unwrap().bridge_owned);
    assert_eq!(f.store().cursor(&key).unwrap(), Some(12));
}

#[test]
fn queued_local_prompt_does_not_steal_the_active_remote_terminal() {
    let mut f = Fixture::new();
    let route = f.route("one");
    let session = f.session("runtime");
    let operation = f.operation(&route, &session.runtime_id);
    f.project(
        &route,
        &session,
        1,
        vec![
            prompt(Some(&operation.id)),
            input("remote", &[&operation.id], "started"),
            prompt(Some("queued-local")),
        ],
    );
    f.restart();
    f.project(
        &route,
        &session,
        4,
        vec![
            input("remote", &[&operation.id], "completed"),
            lifecycle("turn_completed"),
            input("local", &["queued-local"], "started"),
            input("local", &["queued-local"], "completed"),
            lifecycle("turn_completed"),
        ],
    );
    let deliveries = f.store().deliveries().unwrap();
    assert_eq!(deliveries.len(), 2);
    assert_eq!(
        deliveries
            .iter()
            .filter(|d| d.text.contains("/ccem operation"))
            .count(),
        1
    );
}

#[test]
fn merged_batch_uses_its_bridge_operation_notice_and_other_routes_still_receive_completion() {
    let mut f = Fixture::new();
    let first = f.route("one");
    let second = f.route("two");
    let session = f.session("runtime");
    let operation = f.operation(&first, &session.runtime_id);
    let payloads = vec![
        prompt(Some(&operation.id)),
        prompt(Some("merged-local")),
        input("merged", &[&operation.id, "merged-local"], "started"),
        input("merged", &[&operation.id, "merged-local"], "completed"),
        lifecycle("turn_completed"),
    ];
    f.project(&first, &session, 1, payloads.clone());
    f.project(&second, &session, 1, payloads);
    let deliveries = f.store().deliveries().unwrap();
    assert_eq!(deliveries.len(), 2);
    assert_eq!(
        deliveries
            .iter()
            .filter(|d| d.route_id == first.id && d.text.contains("/ccem operation"))
            .count(),
        1
    );
    assert_eq!(
        deliveries
            .iter()
            .filter(|d| d.route_id == second.id && d.text.contains("/ccem status"))
            .count(),
        1
    );
}

#[test]
fn rejected_queued_operation_and_late_remote_terminal_do_not_replace_current_local_origin() {
    let mut f = Fixture::new();
    let route = f.route("one");
    let session = f.session("runtime");
    let operation = f.operation(&route, &session.runtime_id);
    f.project(
        &route,
        &session,
        1,
        vec![
            prompt(Some("local")),
            input("local", &["local"], "started"),
            input("rejected-remote", &[&operation.id], "failed"),
        ],
    );
    let key = cursor_key(&route, &session.runtime_id);
    let state: InputState =
        serde_json::from_str(&f.store().notification_input_state(&key).unwrap().unwrap()).unwrap();
    assert_eq!(
        state.current.unwrap().invocation_id.as_deref(),
        Some("local")
    );
    f.project(
        &route,
        &session,
        4,
        vec![
            input("local", &["local"], "completed"),
            lifecycle("turn_completed"),
        ],
    );
    assert_eq!(f.store().deliveries().unwrap().len(), 2);
}

#[test]
fn permission_alerts_remain_visible_during_remote_input_but_ready_is_never_completion() {
    let mut f = Fixture::new();
    let route = f.route("one");
    let session = f.session("runtime");
    let operation = f.operation(&route, &session.runtime_id);
    f.project(
        &route,
        &session,
        1,
        vec![
            prompt(Some(&operation.id)),
            input("remote", &[&operation.id], "started"),
            lifecycle("ready"),
            SessionEventPayload::PermissionRequired {
                request_id: "permission".into(),
                tool_use_id: None,
                tool_name: "file write".into(),
                input_summary: Some("await local approval".into()),
                background_task_id: None,
            },
        ],
    );
    let deliveries = f.store().deliveries().unwrap();
    assert_eq!(deliveries.len(), 1);
    assert!(deliveries[0].text.contains("Permission required"));
    assert_eq!(f.store().operation(&operation.id).unwrap().state, "running");
}

#[test]
fn disabled_notifications_still_advance_operation_and_origin_without_creating_outbox() {
    let mut f = Fixture::new();
    let mut route = f.route("one");
    route.notifications = false;
    let session = f.session("runtime");
    let operation = f.operation(&route, &session.runtime_id);
    f.project(
        &route,
        &session,
        1,
        vec![
            prompt(Some(&operation.id)),
            input("remote", &[&operation.id], "started"),
            input("remote", &[&operation.id], "completed"),
            lifecycle("turn_completed"),
            prompt(Some("local")),
            input("local", &["local"], "started"),
            input("local", &["local"], "completed"),
        ],
    );
    assert!(f.store().deliveries().unwrap().is_empty());
    assert_eq!(
        f.store().operation(&operation.id).unwrap().state,
        "completed"
    );
    assert_eq!(
        f.store()
            .cursor(&cursor_key(&route, &session.runtime_id))
            .unwrap(),
        Some(7)
    );
}

#[test]
fn incomplete_or_absent_history_does_not_starve_healthy_runtime_or_pending_outbox() {
    let mut f = Fixture::new();
    let route = f.route("one");
    let bad = f.session("missing-history");
    let healthy = f.session("healthy");
    let mut empty = f.session("empty");
    empty.last_event_seq = None;
    let pending = make_delivery(
        &route,
        "already-committed",
        "previous pending delivery".into(),
    );
    f.store().enqueue_page("unrelated", 1, &[pending]).unwrap();
    let healthy_page = page(
        "healthy",
        1,
        vec![
            prompt(None),
            lifecycle("turn_started"),
            lifecycle("turn_completed"),
        ],
    );
    let store = RefCell::new(f.store());
    let mut visited = Vec::new();
    let mut sent = Vec::new();
    let issues = poll_cycle(
        &[route.clone()],
        &[bad, empty, healthy],
        |route, session| {
            visited.push(session.runtime_id.clone());
            if session.runtime_id == "missing-history" {
                let mut broken = healthy_page.clone();
                broken.source_available = false;
                project_page(&mut store.borrow_mut(), route, session, &broken)
            } else {
                project_page(&mut store.borrow_mut(), route, session, &healthy_page)
            }
        },
        || {
            let pending = store.borrow().deliveries()?;
            drain_outbox(
                pending,
                |id| {
                    reserve_delivery(&mut store.borrow_mut(), id).map(|reserved| {
                        reserved.map(|(delivery, route)| DeliveryReservation {
                            delivery,
                            route,
                            transport: (),
                        })
                    })
                },
                |reserved| {
                    sent.push(reserved.delivery.text.clone());
                    Ok(json!({"status":"sent","messageId":random_id()}))
                },
                |reserved, receipt| {
                    finish_delivery(&mut store.borrow_mut(), &reserved.delivery, receipt, true)
                },
            )
        },
    )
    .unwrap();
    assert_eq!(visited, ["missing-history", "healthy"]);
    assert_eq!(issues.len(), 1);
    assert!(issues[0].contains("missing-history: event_history_incomplete"));
    assert_eq!(
        sent.len(),
        2,
        "new healthy completion and previous outbox both drain"
    );
    assert!(sent.iter().any(|text| text == "previous pending delivery"));
    assert_eq!(
        store
            .borrow()
            .cursor(&cursor_key(&route, "missing-history"))
            .unwrap(),
        None
    );
    assert_eq!(
        store.borrow().cursor(&cursor_key(&route, "empty")).unwrap(),
        None
    );
    assert_eq!(
        store
            .borrow()
            .cursor(&cursor_key(&route, "healthy"))
            .unwrap(),
        Some(3)
    );
    assert!(store
        .borrow()
        .deliveries()
        .unwrap()
        .iter()
        .all(|d| d.status == "sent"));
}

#[test]
fn approval_baseline_preserves_old_runtime_completion_before_first_poll() {
    let mut f = Fixture::new();
    let original = f.route("one");
    let mut session = f.session("old-runtime");
    session.created_at = original.created_at - 60_000;
    session.last_event_seq = Some(9);
    let route = f
        .store()
        .approve_route_with_baselines(
            original.source,
            original.workspaces,
            true,
            true,
            &[(session.runtime_id.clone(), session.project_dir.clone(), 7)],
        )
        .unwrap();
    let key = cursor_key(&route, &session.runtime_id);
    assert_eq!(f.store().cursor(&key).unwrap(), Some(7));
    // The task ends after approval, before the first 2-second poll. It was
    // created earlier, and there is no bridge operation for this runtime.
    let mut ending = page(
        &session.runtime_id,
        8,
        vec![lifecycle("turn_started"), lifecycle("turn_completed")],
    );
    for event in &mut ending.events {
        event.occurred_at = chrono::DateTime::from_timestamp_millis(route.created_at + 1).unwrap();
    }
    poll_cycle(
        &[route.clone()],
        &[session],
        |route, session| project_page(f.store(), route, session, &ending),
        || Ok(()),
    )
    .unwrap();
    assert_eq!(f.store().cursor(&key).unwrap(), Some(9));
    assert_eq!(f.store().deliveries().unwrap().len(), 1);
}

#[test]
fn preexisting_route_without_baseline_only_omits_events_before_approval() {
    let mut f = Fixture::new();
    let route = f.route("one");
    let mut session = f.session("old-runtime");
    session.created_at = route.created_at - 60_000;
    let mut replay = page(
        &session.runtime_id,
        1,
        vec![
            lifecycle("turn_completed"),
            prompt(None),
            lifecycle("turn_started"),
            lifecycle("turn_completed"),
        ],
    );
    replay.events[0].occurred_at =
        chrono::DateTime::from_timestamp_millis(route.created_at - 1).unwrap();
    for event in &mut replay.events[1..] {
        event.occurred_at = chrono::DateTime::from_timestamp_millis(route.created_at + 1).unwrap();
    }
    poll_cycle(
        &[route.clone()],
        &[session],
        |route, session| project_page(f.store(), route, session, &replay),
        || Ok(()),
    )
    .unwrap();
    assert_eq!(f.store().deliveries().unwrap().len(), 1);
}

#[test]
fn slow_delivery_releases_policy_lock_and_revocation_stops_the_next_pending_send() {
    use std::sync::{mpsc, Arc, Mutex};
    use std::{thread, time::Duration};
    let mut f = Fixture::new();
    let route = f.route("one");
    let first = make_delivery(&route, "first", "first".into());
    let second = make_delivery(&route, "second", "second".into());
    f.store()
        .enqueue_page("seed", 1, &[first.clone(), second.clone()])
        .unwrap();
    let store = Arc::new(Mutex::new(f.store.take().unwrap()));
    let policy = Arc::new(Mutex::new(()));
    let (started_tx, started_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let worker_store = store.clone();
    let worker_policy = policy.clone();
    let worker = thread::spawn(move || {
        let deliveries = worker_store.lock().unwrap().deliveries().unwrap();
        let mut sends = 0;
        drain_outbox(
            deliveries,
            |id| {
                let _guard = worker_policy.lock().unwrap();
                reserve_delivery(&mut worker_store.lock().unwrap(), id).map(|reserved| {
                    reserved.map(|(delivery, route)| DeliveryReservation {
                        delivery,
                        route,
                        transport: (),
                    })
                })
            },
            |_| {
                sends += 1;
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(json!({"status":"sent"}))
            },
            |reserved, receipt| {
                let _guard = worker_policy.lock().unwrap();
                finish_delivery(
                    &mut worker_store.lock().unwrap(),
                    &reserved.delivery,
                    receipt,
                    true,
                )
            },
        )
        .unwrap();
        sends
    });
    started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    {
        let _guard = policy
            .try_lock()
            .expect("network wait must release the lifecycle lock");
        store.lock().unwrap().disable_route(&route.id).unwrap();
    }
    release_tx.send(()).unwrap();
    assert_eq!(worker.join().unwrap(), 1);
    let mut store = Arc::try_unwrap(store).ok().unwrap().into_inner().unwrap();
    assert_eq!(
        store.delivery(&first.id).unwrap().unwrap().status,
        "unknown"
    );
    assert_eq!(
        store.delivery(&second.id).unwrap().unwrap().status,
        "revoked"
    );
    assert!(reserve_delivery(&mut store, &first.id).unwrap().is_none());
    f.store = Some(store);
}

#[test]
fn replacing_gateway_during_inflight_delivery_keeps_result_unknown_without_retry() {
    let mut f = Fixture::new();
    let route = f.route("one");
    let delivery = make_delivery(&route, "host-old", "pending".into());
    f.store()
        .enqueue_page("seed", 1, &[delivery.clone()])
        .unwrap();
    let (reserved, _) = reserve_delivery(f.store(), &delivery.id).unwrap().unwrap();
    finish_delivery(f.store(), &reserved, Ok(json!({"status":"sent"})), false).unwrap();
    assert_eq!(
        f.store().delivery(&delivery.id).unwrap().unwrap().status,
        "unknown"
    );
    assert!(reserve_delivery(f.store(), &delivery.id).unwrap().is_none());
}

#[test]
fn one_accounts_backlog_and_blocked_send_do_not_starve_another_account() {
    use std::sync::{mpsc, Arc, Mutex};
    use std::{thread, time::Duration};
    let mut f = Fixture::new();
    let a = f
        .store()
        .save_connection(None, "test", None, "cipher-a", &[], true)
        .unwrap();
    let b = f
        .store()
        .save_connection(None, "test", None, "cipher-b", &[], true)
        .unwrap();
    let template = f.route("template");
    let mut source_a = template.source.clone();
    source_a.account_ref = a.account_ref.clone();
    let mut source_b = template.source.clone();
    source_b.account_ref = b.account_ref.clone();
    let route_a = f
        .store()
        .approve_route(source_a, template.workspaces.clone(), true, true)
        .unwrap();
    let route_b = f
        .store()
        .approve_route(source_b, template.workspaces, true, true)
        .unwrap();
    let older: Vec<_> = (0..20)
        .map(|i| make_delivery(&route_a, &format!("a-{i}"), format!("a-{i}")))
        .collect();
    f.store().enqueue_page("seed-a", 1, &older).unwrap();
    let newer = make_delivery(&route_b, "b", "B completion".into());
    f.store()
        .enqueue_page("seed-b", 1, &[newer.clone()])
        .unwrap();
    // Stop pauses the target without changing delivery state or route authority.
    f.store()
        .set_connection_enabled(&a.account_ref, false)
        .unwrap();
    assert!(
        reserve_account_delivery(f.store(), &a.account_ref, &older[0].id)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        f.store().delivery(&older[0].id).unwrap().unwrap().status,
        "pending"
    );
    assert!(
        reserve_account_delivery(f.store(), &b.account_ref, &older[0].id)
            .unwrap()
            .is_none()
    );
    f.store()
        .set_connection_enabled(&a.account_ref, true)
        .unwrap();

    let store = Arc::new(Mutex::new(f.store.take().unwrap()));
    let policy = Arc::new(Mutex::new(()));
    let (started_tx, started_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let worker_store = store.clone();
    let worker_policy = policy.clone();
    let worker = thread::spawn(move || {
        let deliveries = deliveries_for_account(
            worker_store.lock().unwrap().deliveries().unwrap(),
            &[route_a],
        );
        let mut first = true;
        drain_outbox(
            deliveries,
            |id| {
                let _guard = worker_policy.lock().unwrap();
                reserve_account_delivery(&mut worker_store.lock().unwrap(), &a.account_ref, id).map(
                    |r| {
                        r.map(|(delivery, route)| DeliveryReservation {
                            delivery,
                            route,
                            transport: (),
                        })
                    },
                )
            },
            |_| {
                if first {
                    first = false;
                    started_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                }
                Ok(json!({"status":"sent"}))
            },
            |reserved, receipt| {
                let _guard = worker_policy.lock().unwrap();
                finish_delivery(
                    &mut worker_store.lock().unwrap(),
                    &reserved.delivery,
                    receipt,
                    true,
                )
            },
        )
        .unwrap();
    });
    started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let deliveries =
        deliveries_for_account(store.lock().unwrap().deliveries().unwrap(), &[route_b]);
    drain_outbox(
        deliveries,
        |id| {
            let _guard = policy
                .try_lock()
                .expect("A's network wait releases the policy lock");
            reserve_account_delivery(&mut store.lock().unwrap(), &b.account_ref, id).map(|r| {
                r.map(|(delivery, route)| DeliveryReservation {
                    delivery,
                    route,
                    transport: (),
                })
            })
        },
        |reserved| {
            assert_eq!(reserved.route.source.account_ref, b.account_ref);
            Ok(json!({"status":"sent"}))
        },
        |reserved, receipt| {
            finish_delivery(
                &mut store.lock().unwrap(),
                &reserved.delivery,
                receipt,
                true,
            )
        },
    )
    .unwrap();
    assert_eq!(
        store
            .lock()
            .unwrap()
            .delivery(&newer.id)
            .unwrap()
            .unwrap()
            .status,
        "sent",
        "B completes before A is released"
    );
    assert_eq!(
        store
            .lock()
            .unwrap()
            .delivery(&older[0].id)
            .unwrap()
            .unwrap()
            .status,
        "sending"
    );
    release_tx.send(()).unwrap();
    worker.join().unwrap();
    f.store = Some(Arc::try_unwrap(store).ok().unwrap().into_inner().unwrap());
}

#[test]
fn all_replay_integrity_failures_preserve_the_previous_cursor_and_input_state() {
    let mut f = Fixture::new();
    let route = f.route("one");
    let session = f.session("runtime");
    f.project(
        &route,
        &session,
        1,
        vec![prompt(Some("local")), input("local", &["local"], "started")],
    );
    let key = cursor_key(&route, &session.runtime_id);
    let before = f.store().notification_input_state(&key).unwrap();
    for fault in 0..4 {
        let mut broken = page("runtime", 3, vec![input("local", &["local"], "completed")]);
        match fault {
            0 => broken.source_available = false,
            1 => broken.gap_detected = true,
            2 => broken.decode_failure_count = 1,
            _ => broken.oversized_event_count = 1,
        }
        assert_eq!(
            project_page(f.store(), &route, &session, &broken).unwrap_err(),
            "event_history_incomplete"
        );
        assert_eq!(f.store().cursor(&key).unwrap(), Some(2));
        assert_eq!(f.store().notification_input_state(&key).unwrap(), before);
        assert!(f.store().deliveries().unwrap().is_empty());
    }
}
