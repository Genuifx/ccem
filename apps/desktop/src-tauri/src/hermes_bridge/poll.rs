use super::{
    make_delivery,
    store::{Delivery, Operation, Route, Store},
    HermesBridgeManager,
};
use crate::{
    event_bus::{NativeEventReplayPage, SessionEventPayload, SessionEventRecord},
    remote_bridge::{project_event, RemoteEventKind},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

struct PollSession {
    runtime_id: String,
    project_dir: String,
    title: String,
    created_at: i64,
    last_event_seq: Option<u64>,
}

#[derive(Default, Serialize, Deserialize)]
struct InputState {
    current: Option<TrackedInput>,
    queued_prompt: Option<TrackedInput>,
    terminal_tail: Option<TerminalTail>,
}
#[derive(Default, Serialize, Deserialize)]
struct TrackedInput {
    client_ids: Vec<String>,
    invocation_id: Option<String>,
    command_id: Option<String>,
    bridge_owned: bool,
    started: bool,
    terminal: bool,
}
#[derive(Serialize, Deserialize)]
struct TerminalTail {
    command_id: Option<String>,
}

fn cursor_key(route: &Route, runtime: &str) -> String {
    format!("{}:{}:{runtime}", route.id, route.generation)
}
fn owns(route: &Route, runtime: &str, id: &str, operations: &[Operation]) -> bool {
    operations.iter().any(|op| {
        op.id == id
            && op.route_id == route.id
            && op.generation == route.generation
            && op.runtime_id == runtime
    })
}

pub(super) fn poll(manager: &HermesBridgeManager) -> Result<(), String> {
    if !manager
        .gateway
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|g| g.process.snapshot()["state"] == "running")
    {
        return Ok(());
    }
    let routes = manager.with_store(|store| store.routes())?;
    let sessions: Vec<_> = manager
        .native
        .list_sessions()
        .into_iter()
        .map(|s| PollSession {
            title: s.display_title.unwrap_or_else(|| s.runtime_id.clone()),
            runtime_id: s.runtime_id,
            project_dir: s.project_dir,
            created_at: s.created_at.timestamp_millis(),
            last_event_seq: s.last_event_seq,
        })
        .collect();
    let issues = poll_cycle(
        &routes,
        &sessions,
        |route, session| {
            let key = cursor_key(route, &session.runtime_id);
            let cursor = manager.with_store(|store| store.cursor(&key))?;
            let last = session
                .last_event_seq
                .expect("empty sessions skipped by poll_cycle");
            if cursor.is_some_and(|cursor| cursor >= last) {
                return Ok(());
            }
            let page = manager.native.replay_event_page(
                &session.runtime_id,
                Some(cursor.unwrap_or(0)),
                None,
                100,
            )?;
            manager.with_store(|store| project_page(store, route, session, &page))
        },
        || {
            let deliveries = manager.with_store(|store| store.deliveries())?;
            drain_outbox(
                deliveries,
                |id| {
                    let _guard = manager
                        .lifecycle
                        .lock()
                        .map_err(|_| "bridge_lock_poisoned")?;
                    let process = manager.host_process()?;
                    if process.snapshot()["state"] != "running" {
                        return Ok(None);
                    }
                    manager
                        .with_store(|store| reserve_delivery(store, id))
                        .map(|reserved| {
                            reserved.map(|(delivery, route)| DeliveryReservation {
                                delivery,
                                route,
                                transport: process,
                            })
                        })
                },
                |reserved| {
                    reserved.transport.request("sendStrict", json!({"target":reserved.route.source.target(),"text":reserved.delivery.text}))
                },
                |reserved, receipt| {
                    let _guard = manager
                        .lifecycle
                        .lock()
                        .map_err(|_| "bridge_lock_poisoned")?;
                    let same_host = manager
                        .host_process()
                        .is_ok_and(|process| std::sync::Arc::ptr_eq(&process, &reserved.transport));
                    manager.with_store(|store| {
                        finish_delivery(store, &reserved.delivery, receipt, same_host)
                    })
                },
            )
        },
    )?;
    if !issues.is_empty() {
        *manager.last_error.lock().unwrap() = Some(issues.join("; "));
    }
    Ok(())
}

/// A missing history belongs to that runtime, and cannot block another runtime
/// or a previously committed delivery. Empty runtimes wait for their first event.
fn poll_cycle(
    routes: &[Route],
    sessions: &[PollSession],
    mut project: impl FnMut(&Route, &PollSession) -> Result<(), String>,
    drain: impl FnOnce() -> Result<(), String>,
) -> Result<Vec<String>, String> {
    let mut issues = Vec::new();
    for route in routes.iter().filter(|route| route.enabled) {
        for session in sessions.iter().filter(|session| {
            session.last_event_seq.is_some_and(|seq| seq > 0) && route.permits(&session.project_dir)
        }) {
            if let Err(error) = project(route, session) {
                if issues.len() < 3 {
                    issues.push(format!("{}: {}", session.runtime_id, error));
                }
            }
        }
    }
    drain()?;
    Ok(issues)
}

fn project_page(
    store: &mut Store,
    route: &Route,
    session: &PollSession,
    page: &NativeEventReplayPage,
) -> Result<(), String> {
    if !page.source_available
        || page.gap_detected
        || page.decode_failure_count > 0
        || page.oversized_event_count > 0
    {
        return Err("event_history_incomplete".into());
    }
    let Some(next) = page.next_cursor else {
        return Ok(());
    };
    let key = cursor_key(route, &session.runtime_id);
    let cursor = store.cursor(&key)?.unwrap_or(0);
    if next <= cursor {
        return Ok(());
    }
    let mut state: InputState = store
        .notification_input_state(&key)?
        .map(|raw| serde_json::from_str(&raw))
        .transpose()
        .map_err(|_| "notification_input_state_invalid")?
        .unwrap_or_default();
    let operations = store.operations()?;
    let mut deliveries = Vec::new();
    for event in page.events.iter().filter(|event| event.seq > cursor) {
        // Approval captures cursors before it commits. Older routes without a
        // captured baseline replay safely, omitting only pre-approval history.
        if event.occurred_at.timestamp_millis() < route.created_at {
            continue;
        }
        if event.runtime_id != session.runtime_id || event.seq > next {
            return Err("event_history_scope_mismatch".into());
        }
        match &event.payload {
            SessionEventPayload::UserPrompt {
                client_message_id, ..
            } => {
                let prompt = TrackedInput {
                    client_ids: client_message_id.iter().cloned().collect(),
                    bridge_owned: client_message_id
                        .as_ref()
                        .is_some_and(|id| owns(route, &session.runtime_id, id, &operations)),
                    ..Default::default()
                };
                if let Some(current) = state
                    .current
                    .as_ref()
                    .filter(|current| current.started && !current.terminal)
                {
                    // Rust's written UserPrompt can follow helper started. It is
                    // the same input, whereas an already-written Codex queue is next.
                    if !client_message_id
                        .as_ref()
                        .is_some_and(|id| current.client_ids.contains(id))
                    {
                        state.queued_prompt = Some(prompt);
                    }
                } else {
                    state.current = Some(prompt);
                }
            }
            SessionEventPayload::InputOperation {
                operation_id,
                client_message_ids,
                stage,
                detail,
                command_id,
                ..
            } => {
                if client_message_ids.is_empty()
                    || !["started", "completed", "failed", "unknown"].contains(&stage.as_str())
                {
                    continue;
                }
                let owned_ids: Vec<_> = client_message_ids
                    .iter()
                    .filter(|id| owns(route, &session.runtime_id, id, &operations))
                    .collect();
                let terminal = stage != "started";
                for id in client_message_ids {
                    store.observe_operation(
                        id,
                        &session.runtime_id,
                        operation_id,
                        stage,
                        detail,
                    )?;
                }
                if terminal && route.notifications {
                    for id in &owned_ids {
                        let op = store.operation(id)?;
                        deliveries.push(make_delivery(
                            route,
                            &format!("operation:{id}:{operation_id}:{stage}"),
                            format!(
                                "CCEM · {}\n{}\n{}\n/ccem operation {}",
                                session.title, op.state, op.detail, id
                            ),
                        ));
                    }
                    if owned_ids.is_empty() {
                        deliveries.push(make_delivery(
                            route,
                            &format!("input:{operation_id}:terminal"),
                            format!(
                                "CCEM · {}\n{}\n{}\n/ccem status {}",
                                session.title, stage, detail, session.runtime_id
                            ),
                        ));
                    }
                }
                let matches_current = state.current.as_ref().is_none_or(|current| {
                    current.invocation_id.as_deref() == Some(operation_id)
                        || (current.invocation_id.is_none()
                            && current
                                .client_ids
                                .iter()
                                .any(|id| client_message_ids.contains(id)))
                });
                if !terminal || matches_current {
                    state.current = Some(TrackedInput {
                        client_ids: client_message_ids.clone(),
                        invocation_id: Some(operation_id.clone()),
                        command_id: command_id.clone(),
                        bridge_owned: !owned_ids.is_empty(),
                        started: true,
                        terminal,
                    });
                    if state.queued_prompt.as_ref().is_some_and(|prompt| {
                        prompt
                            .client_ids
                            .iter()
                            .any(|id| client_message_ids.contains(id))
                    }) {
                        state.queued_prompt = None;
                    }
                    state.terminal_tail = terminal.then(|| TerminalTail {
                        command_id: command_id.clone(),
                    });
                }
            }
            SessionEventPayload::Lifecycle {
                stage, command_id, ..
            } if stage == "turn_started" => {
                if !state
                    .current
                    .as_ref()
                    .is_some_and(|current| current.started && !current.terminal)
                {
                    if let Some(queued) = state.queued_prompt.take() {
                        state.current = Some(queued);
                    }
                    let current = state.current.get_or_insert_with(TrackedInput::default);
                    current.started = true;
                    current.terminal = false;
                    current.command_id = command_id.clone();
                }
                state.terminal_tail = None;
            }
            _ => project_generic(route, session, event, &mut state, &mut deliveries),
        }
    }
    let state = serde_json::to_string(&state).map_err(|e| e.to_string())?;
    store.enqueue_notification_page(&key, next, &deliveries, Some(&state))
}

fn project_generic(
    route: &Route,
    session: &PollSession,
    event: &SessionEventRecord,
    state: &mut InputState,
    deliveries: &mut Vec<Delivery>,
) {
    let Some(mut projected) = project_event(event) else {
        return;
    };
    let command_id = match &event.payload {
        SessionEventPayload::Lifecycle {
            stage, command_id, ..
        } if stage == "turn_completed" => {
            projected.kind = RemoteEventKind::SessionCompleted;
            projected.title = "Turn completed".into();
            command_id.clone()
        }
        _ => None,
    };
    if projected.kind == RemoteEventKind::SessionCompleted {
        let terminal_tail = state
            .terminal_tail
            .as_ref()
            .is_some_and(|tail| command_id.is_none() || tail.command_id == command_id);
        let current_suppresses = state.current.as_ref().is_some_and(|current| {
            current.bridge_owned || current.terminal || current.invocation_id.is_some()
        });
        if terminal_tail || current_suppresses {
            return;
        }
        state
            .current
            .get_or_insert_with(TrackedInput::default)
            .terminal = true;
        state.terminal_tail = Some(TerminalTail { command_id });
    } else if ![RemoteEventKind::Error, RemoteEventKind::PermissionPrompt].contains(&projected.kind)
    {
        return;
    }
    if route.notifications {
        deliveries.push(make_delivery(
            route,
            &projected.event_id,
            format!(
                "CCEM · {}\n{}\n{}\n/ccem status {}",
                session.title, projected.title, projected.text, session.runtime_id
            ),
        ));
    }
}

struct DeliveryReservation<T> {
    delivery: Delivery,
    route: Route,
    transport: T,
}

fn reserve_delivery(store: &mut Store, id: &str) -> Result<Option<(Delivery, Route)>, String> {
    let Some(mut delivery) = store.delivery(id)? else {
        return Ok(None);
    };
    if delivery.status != "pending" {
        return Ok(None);
    }
    let route = store.routes()?.into_iter().find(|route| {
        route.id == delivery.route_id
            && route.generation == delivery.generation
            && route.enabled
            && route.notifications
    });
    let Some(route) = route else {
        delivery.status = "revoked".into();
        store.save_delivery(&delivery)?;
        return Ok(None);
    };
    delivery.status = "sending".into();
    store.save_delivery(&delivery)?;
    Ok(Some((delivery, route)))
}

fn finish_delivery(
    store: &mut Store,
    delivery: &Delivery,
    receipt: Result<Value, String>,
    same_host: bool,
) -> Result<(), String> {
    let Some(mut current) = store.delivery(&delivery.id)? else {
        return Ok(());
    };
    if current.status != "sending" {
        return Ok(());
    }
    let authorized = same_host
        && store.routes()?.iter().any(|route| {
            route.id == current.route_id
                && route.generation == current.generation
                && route.enabled
                && route.notifications
        });
    if !authorized {
        current.status = "unknown".into();
        current.receipt = Some(json!({"errorCode":"delivery_authority_changed"}));
    } else {
        match receipt {
            Ok(receipt) => {
                current.status = match receipt["status"].as_str() {
                    Some("sent") => "sent",
                    Some("not_sent") => "not_sent",
                    _ => "unknown",
                }
                .into();
                current.receipt = Some(receipt);
            }
            Err(_) => {
                current.status = "unknown".into();
                current.receipt = Some(json!({"errorCode":"gateway_response_unknown"}));
            }
        }
    }
    store.save_delivery(&current)
}

fn drain_outbox<T>(
    deliveries: Vec<Delivery>,
    mut reserve: impl FnMut(&str) -> Result<Option<DeliveryReservation<T>>, String>,
    mut send: impl FnMut(&DeliveryReservation<T>) -> Result<Value, String>,
    mut finish: impl FnMut(DeliveryReservation<T>, Result<Value, String>) -> Result<(), String>,
) -> Result<(), String> {
    for delivery in deliveries
        .into_iter()
        .rev()
        .filter(|delivery| delivery.status == "pending")
        .take(5)
    {
        let Some(reserved) = reserve(&delivery.id)? else {
            continue;
        };
        // No policy, store, or gateway-owner lock crosses this network wait.
        let receipt = send(&reserved);
        finish(reserved, receipt)?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "poll_tests.rs"]
mod tests;
