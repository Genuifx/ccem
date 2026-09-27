use super::{
    bounded_chat_text,
    store::{digest, now, Delivery, Route, SessionBinding, SessionDecision, Store},
    HermesBridgeManager,
};
use crate::{
    config,
    event_bus::{NativeEventReplayPage, SessionEventPayload},
    remote_bridge::project_event,
};
use serde_json::{json, Value};

pub(super) fn model_config(env: &str) -> Result<Value, String> {
    if env == "official" || env.trim().is_empty() {
        return Err("hermes_api_environment_required".into());
    }
    let resolved =
        config::resolve_claude_env(env).map_err(|_| "hermes_model_environment_unavailable")?;
    let vars = resolved.env_vars;
    let key = vars
        .get("ANTHROPIC_AUTH_TOKEN")
        .filter(|v| !v.trim().is_empty())
        .ok_or("hermes_api_environment_required")?;
    let base = resolved
        .upstream_base_url
        .filter(|v| v.starts_with("https://") || v.starts_with("http://"))
        .ok_or("hermes_api_environment_required")?;
    let selected = vars
        .get("ANTHROPIC_MODEL")
        .map(String::as_str)
        .unwrap_or("sonnet");
    let selected = match selected {
        "opus" => vars
            .get("ANTHROPIC_DEFAULT_OPUS_MODEL")
            .map(String::as_str)
            .unwrap_or(selected),
        "sonnet" => vars
            .get("ANTHROPIC_DEFAULT_SONNET_MODEL")
            .map(String::as_str)
            .unwrap_or(selected),
        "haiku" => vars
            .get("ANTHROPIC_DEFAULT_HAIKU_MODEL")
            .map(String::as_str)
            .unwrap_or(selected),
        _ => selected,
    };
    if selected.trim().is_empty() || ["opus", "sonnet", "haiku"].contains(&selected) {
        return Err("hermes_concrete_model_required".into());
    }
    Ok(
        json!({"provider":"custom","apiMode":"anthropic_messages","baseUrl":base,"apiKey":key,"model":selected,"authStyle":"bearer"}),
    )
}

pub(super) fn available_models() -> Vec<Value> {
    let mut models = config::read_config().map(|c| c.registries.keys().filter_map(|name| {
        model_config(name).ok().map(|m| json!({"envName":name,"model":m["model"]}))
    }).collect::<Vec<_>>()).unwrap_or_default();
    models.sort_by_key(|m| m["envName"].as_str().unwrap_or("").to_owned());
    models
}

impl HermesBridgeManager {
    pub(super) fn session_handoff_action(
        &self,
        action: &str,
        payload: &Value,
    ) -> Result<Value, String> {
        let runtime = payload["runtimeId"].as_str().ok_or("runtime_id_required")?;
        if action == "detachSession" {
            let _guard = self.lifecycle.lock().map_err(|_| "bridge_lock_poisoned")?;
            self.with_store(|s| {
                s.detach_session(
                    runtime,
                    payload["bindingId"].as_str().ok_or("binding_id_required")?,
                )
            })?;
        } else if action == "bindSession" {
            let session = self
                .native
                .get_session_summary(runtime)?
                .ok_or("session_not_found")?;
            let _guard = self.lifecycle.lock().map_err(|_| "bridge_lock_poisoned")?;
            if !session.is_active {
                return Err("session_not_active".into());
            }
            let env = payload["modelEnv"]
                .as_str()
                .ok_or("hermes_api_environment_required")?;
            let model = model_config(env)?;
            let route = self
                .with_store(|s| s.routes())?
                .into_iter()
                .find(|r| {
                    r.id == payload["routeId"].as_str().unwrap_or("")
                        && r.generation == payload["generation"].as_i64().unwrap_or(0)
                        && r.enabled
                })
                .ok_or("session_pairing_changed")?;
            let host = self.connection_process(&route.source.account_ref)?;
            if host.snapshot()["sessionHandoff"] != 1 || host.snapshot()["state"] != "running" {
                return Err("hermes_handoff_runtime_required".into());
            }
            self.with_store(|s| {
                if !s.connection(&route.source.account_ref)?.enabled { return Err("connection_disabled".into()); }
                if s.binding_for_route(&route, runtime)?.is_some_and(|b| b.model_env == env && b.model == model["model"].as_str().unwrap_or("")) { return Ok(()); }
                let binding = s.bind_session(SessionBinding {
                    id: String::new(), runtime_id: runtime.into(), route_id: route.id.clone(), generation: route.generation,
                    title: session.display_title.clone().unwrap_or_else(|| std::path::Path::new(&session.project_dir).file_name().map(|n|n.to_string_lossy().into_owned()).unwrap_or_else(|| runtime.into())).chars().take(240).collect(), model_env: env.into(),
                    model: model["model"].as_str().unwrap_or("").into(), cursor: session.last_event_seq.unwrap_or(0),
                    input_context: None, created_at: now(), last_decision_at: None, last_decision: None, error: None,
                }, &route)?;
                s.enqueue_delivery(&Delivery {
                    conversation_scope: None, confirmation_preview: None,
                    id: digest(&format!("handoff:{}", binding.id)), route_id: route.id.clone(), generation: route.generation,
                    text: bounded_chat_text(&format!("已接手「{}」。有重要进展我会告诉你，也可以直接问我进度或让我继续。需要执行时，我会先给你看具体内容，回复“确认”后再开始。", binding.title)),
                    status: "pending".into(), receipt: None, created_at: now(), cron: None, session_binding_id: Some(binding.id),
                })
            })?;
        } else if action != "sessionBinding" {
            return Err("unknown_hermes_action".into());
        }
        let default_env = self
            .native
            .get_session_summary(runtime)?
            .map(|s| s.env_name)
            .unwrap_or_default();
        self.session_handoff_snapshot(runtime, &default_env)
    }

    fn session_handoff_snapshot(&self, runtime: &str, default_env: &str) -> Result<Value, String> {
        let mut targets = self.cron_notification_targets()?;
        if let Some(targets) = targets.as_array_mut() {
            for target in targets {
                let snapshot = target["accountRef"]
                    .as_str()
                    .and_then(|id| self.connection_process(id).ok())
                    .map(|p| p.snapshot());
                target["handoffReady"] = json!(snapshot
                    .as_ref()
                    .is_some_and(|s| s["state"] == "running" && s["sessionHandoff"] == 1));
            }
        }
        let mut models = Vec::new();
        for name in config::read_config()?.registries.keys() {
            if let Ok(model) = model_config(name) {
                models.push(json!({"envName":name,"model":model["model"]}));
            }
        }
        models.sort_by_key(|m| m["envName"].as_str().unwrap_or("").to_owned());
        self.with_store(|s| {
            let binding = s.session_binding(runtime)?;
            let valid = binding.as_ref().map(|b| s.binding_route(b)).transpose()?.flatten().is_some();
            let delivery = s.deliveries()?.into_iter().find(|d| binding.as_ref().is_some_and(|b| d.session_binding_id.as_deref() == Some(&b.id)));
            Ok(json!({"binding":binding,"bindingValid":valid,"deliveryStatus":delivery.map(|d|d.status),"targets":targets,"models":models,"defaultModelEnv":default_env}))
        })
    }

    pub(super) fn input_route(&self, paired: &Route, runtime: &str) -> Result<Route, String> {
        self.scoped_session(paired, runtime)?;
        Ok(self
            .with_store(|s| s.binding_for_route(paired, runtime))?
            .map(|b| b.scoped_route(paired))
            .unwrap_or_else(|| paired.clone()))
    }

    pub(super) fn confirmation_route(
        &self,
        paired: &Route,
        challenge: &str,
    ) -> Result<(Route, String), String> {
        self.with_store(|s| s.confirmation_route(paired, challenge))
    }

    pub(super) fn poll_session_handoffs(&self, account: &str) -> Result<(), String> {
        let bindings = self.with_store(|s| s.session_bindings())?;
        let mut issues = Vec::new();
        for binding in bindings {
            let route = self.with_store(|s| s.binding_route(&binding))?;
            if route.is_none_or(|r| r.source.account_ref != account) {
                continue;
            }
            if let Err(error) = self.collect_session_operations(&binding) {
                issues.push(error);
            }
            if let Err(error) = self.collect_session_wake(&binding) {
                issues.push(error);
            }
        }
        // A failed evaluator cannot occupy a send reservation. Retry only the
        // side-effect-free judgment, never an uncertain channel send.
        let mut processed = 0;
        for decision in self
            .with_store(|s| s.pending_session_decisions())?
            .into_iter()
            .filter(|d| d.retry_after <= now())
        {
            let Some(binding) = self
                .with_store(|s| s.session_binding(&decision.runtime_id))?
                .filter(|b| b.id == decision.binding_id)
            else {
                continue;
            };
            let Some(route) = self
                .with_store(|s| s.binding_route(&binding))?
                .filter(|r| r.source.account_ref == account)
            else {
                continue;
            };
            if processed == 3 {
                break;
            }
            processed += 1;
            let outcome: Result<Option<Delivery>, String> = (|| {
                let mut model = model_config(&binding.model_env)?;
                model["model"] = json!(binding.model);
                let previous = self
                    .with_store(|s| s.deliveries())?
                    .into_iter()
                    .find(|d| {
                        d.session_binding_id.as_deref() == Some(&binding.id) && d.status == "sent"
                    })
                    .map(|d| d.text.chars().take(800).collect::<String>());
                let mut events = decision
                    .events
                    .as_array()
                    .cloned()
                    .ok_or("hermes_invalid_decision")?;
                if let Some(prompt) = &decision.input_context {
                    events.insert(0, json!({"kind":"current_input_context","text":prompt}));
                }
                if let Some(session) = self.native.get_session_summary(&binding.runtime_id)? {
                    events.push(json!({"kind":"current_session_state","isActive":session.is_active,"status":session.status}));
                }
                let response = self.connection_process(account)?.request("decideSessionNotification", json!({"model":model,"title":binding.title.chars().take(240).collect::<String>(),"events":events,"previousNotification":previous}))?;
                let notify = response["notify"]
                    .as_bool()
                    .ok_or("hermes_invalid_decision")?;
                let text = response["text"].as_str().ok_or("hermes_invalid_decision")?;
                if notify && (text.trim().is_empty() || text.len() > 12_000) {
                    return Err("hermes_invalid_decision".into());
                }
                Ok(notify.then(|| Delivery {
                    conversation_scope: None, confirmation_preview: None,
                    id: digest(&format!("session-notice:{}", decision.id)),
                    route_id: route.id.clone(),
                    generation: route.generation,
                    text: bounded_chat_text(&format!(
                        "「{}」\n{}",
                        binding.title, text
                    )),
                    status: "pending".into(),
                    receipt: None,
                    created_at: now(),
                    cron: None,
                    session_binding_id: Some(binding.id.clone()),
                }))
            })();
            let _guard = self.lifecycle.lock().map_err(|_| "bridge_lock_poisoned")?;
            match outcome {
                Ok(delivery) => self.with_store(|s| {
                    s.finish_session_decision(&decision, delivery.as_ref(), None)
                })?,
                Err(_) => {
                    self.with_store(|s| {
                        s.finish_session_decision(
                            &decision,
                            None,
                            Some("hermes_notification_decision_failed"),
                        )
                    })?;
                    issues.push("hermes_notification_decision_failed".into());
                }
            }
        }
        if issues.is_empty() {
            Ok(())
        } else {
            Err(issues.into_iter().take(3).collect::<Vec<_>>().join("; "))
        }
    }

    fn collect_session_operations(&self, binding: &SessionBinding) -> Result<(), String> {
        // Model failures must not hold the input operation ledger behind a
        // pending notification decision. This cursor has no send authority.
        let key = format!("session-input:{}", binding.id);
        let cursor = self
            .with_store(|s| s.cursor(&key))?
            .unwrap_or(binding.cursor);
        let page = self
            .native
            .replay_event_page(&binding.runtime_id, Some(cursor), None, 100)?;
        if !page.source_available
            || page.gap_detected
            || page.decode_failure_count > 0
            || page.oversized_event_count > 0
        {
            return Err("session_event_history_incomplete".into());
        }
        let Some(next) = page.next_cursor.filter(|next| *next > cursor) else {
            return Ok(());
        };
        if page
            .events
            .iter()
            .any(|e| e.runtime_id != binding.runtime_id || e.seq > next)
        {
            return Err("session_event_scope_mismatch".into());
        }
        let _guard = self.lifecycle.lock().map_err(|_| "bridge_lock_poisoned")?;
        self.with_store(|s| {
            if s.binding_route(binding)?.is_none() {
                return Ok(());
            }
            observe_session_operations(s, &page, cursor, next)?;
            s.enqueue_page(&key, next, &[])
        })
    }

    fn collect_session_wake(&self, binding: &SessionBinding) -> Result<(), String> {
        if self
            .with_store(|s| s.pending_session_decisions())?
            .iter()
            .any(|d| d.binding_id == binding.id)
        {
            return Ok(());
        }
        let page =
            self.native
                .replay_event_page(&binding.runtime_id, Some(binding.cursor), None, 100)?;
        if !page.source_available
            || page.gap_detected
            || page.decode_failure_count > 0
            || page.oversized_event_count > 0
        {
            return Err("session_event_history_incomplete".into());
        }
        let Some(next) = page.next_cursor.filter(|c| *c > binding.cursor) else {
            return Ok(());
        };
        if page
            .events
            .iter()
            .any(|e| e.runtime_id != binding.runtime_id || e.seq > next)
        {
            return Err("session_event_scope_mismatch".into());
        }
        let (next, events) = bounded_session_events(&page, binding.cursor);
        if next <= binding.cursor {
            return Ok(());
        }
        // Process bounded replay pages, keeping message content available to the
        // evaluator rather than streaming every tool chunk to the destination.
        let decision = SessionDecision {
            id: digest(&format!("{}:{}:{next}", binding.id, binding.cursor)),
            binding_id: binding.id.clone(),
            runtime_id: binding.runtime_id.clone(),
            next_cursor: next,
            input_context: page
                .events
                .iter()
                .filter(|e| e.seq > binding.cursor && e.seq <= next)
                .rev()
                .find_map(|e| match &e.payload {
                    SessionEventPayload::UserPrompt { text, .. } => {
                        Some(text.chars().take(600).collect::<String>())
                    }
                    _ => None,
                })
                .or_else(|| binding.input_context.clone()),
            events: json!(events),
            state: "pending".into(),
            retry_after: 0,
        };
        let _guard = self.lifecycle.lock().map_err(|_| "bridge_lock_poisoned")?;
        self.with_store(|s| {
            if s.binding_route(binding)?.is_none() {
                return Ok(());
            }
            s.enqueue_session_decision(binding, &decision)?;
            if events.is_empty() {
                s.finish_session_decision(&decision, None, None)?;
            }
            Ok(())
        })
    }
}

fn observe_session_operations(
    store: &Store,
    page: &NativeEventReplayPage,
    cursor: u64,
    next: u64,
) -> Result<(), String> {
    for event in page
        .events
        .iter()
        .filter(|e| e.seq > cursor && e.seq <= next)
    {
        if let SessionEventPayload::InputOperation {
            operation_id,
            client_message_ids,
            stage,
            detail,
            ..
        } = &event.payload
        {
            for id in client_message_ids {
                store.observe_operation(id, &event.runtime_id, operation_id, stage, detail)?;
            }
        }
    }
    Ok(())
}

fn bounded_session_events(page: &NativeEventReplayPage, cursor: u64) -> (u64, Vec<Value>) {
    let mut events = Vec::new();
    let mut bytes = 0;
    let mut next = cursor;
    for event in page.events.iter().filter(|e| e.seq > cursor) {
        let projected = if let SessionEventPayload::InputOperation { stage, detail, .. } =
            &event.payload
        {
            ["completed","failed","unknown"].contains(&stage.as_str()).then(|| json!({"seq":event.seq,"kind":"input_result","title":stage,"text":detail.chars().take(1000).collect::<String>()}))
        } else if let SessionEventPayload::SessionCompleted { reason } = &event.payload {
            Some(
                json!({"seq":event.seq,"kind":"turn_complete","title":"Input turn completed","text":reason.chars().take(1000).collect::<String>()}),
            )
        } else {
            project_event(event).map(|e|json!({"seq":e.seq,"kind":e.kind,"title":e.title.chars().take(240).collect::<String>(),"text":e.text}))
        };
        if let Some(value) = projected {
            let size = serde_json::to_vec(&value).map_or(24_001, |v| v.len());
            if bytes + size > 24_000 {
                break;
            }
            bytes += size;
            events.push(value);
        }
        next = event.seq;
    }
    (next, events)
}

#[cfg(test)]
#[path = "session_handoff_tests.rs"]
mod tests;
