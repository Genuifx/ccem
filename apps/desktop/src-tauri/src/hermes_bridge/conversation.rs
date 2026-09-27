//! The model receives tools, never chat identity, model credentials or approval authority.
use super::{session_handoff::model_config, store::{digest, now, Route}, HermesBridgeManager};
use serde_json::{json, Value};

pub(super) fn scope(route: &Route) -> String {
    digest(&format!("conversation:{}:{}", route.id, route.generation))
}

#[derive(Clone)]
pub(super) struct PresentedInput {
    pub owner: String,
    pub scope: String,
    pub challenge: String,
    pub expires: i64,
    pub shown_at_ns: u64,
}

impl HermesBridgeManager {
    pub(super) fn conversation_tools_mode(&self, account: &str) -> Result<String, String> {
        self.with_store(|s| s.conversation_tools_mode(account))
    }

    pub(super) fn native_tools_available(&self, account: &str) -> bool {
        self.connection_process(account).or_else(|_| self.host_process())
            .is_ok_and(|process| process.snapshot()["nativeTools"].as_u64() == Some(1))
    }

    pub(super) fn save_conversation_tools(&self, payload: &Value) -> Result<bool, String> {
        let account = payload["accountRef"].as_str().ok_or("account_ref_required")?;
        let mode = payload["toolsMode"].as_str().ok_or("invalid_tools_mode")?;
        if !["ccem", "native"].contains(&mode) { return Err("invalid_tools_mode".into()); }
        self.with_store(|s| s.connection(account))?;
        if self.conversation_tools_mode(account)? == mode { return Ok(false); }
        if mode == "native" && !self.native_tools_available(account) {
            return Err("hermes_native_tools_update_required".into());
        }
        self.with_store(|s| s.set_setting(&format!("conversation_tools:{account}"), mode))?;
        Ok(true)
    }

    pub(super) fn conversation_model(&self, account: &str) -> Result<Value, String> {
        self.with_store(|s| {
            if let Some(saved) = s.setting(&format!("conversation_model:{account}"))? {
                return serde_json::from_str(&saved).map_err(|_| "hermes_model_environment_unavailable".into());
            }
            // Freeze an unambiguous model the bot owner already chose for handoff.
            let routes = s.routes()?;
            let mut models = s.session_bindings()?.into_iter().filter(|b| routes.iter().any(|r|
                r.enabled && r.source.account_ref == account && r.id == b.route_id && r.generation == b.generation))
                .map(|b| (b.model_env, b.model)).collect::<Vec<_>>();
            models.sort();
            models.dedup();
            let inferred = if models.len() == 1 { json!({"envName": models[0].0, "model": models[0].1}) } else { Value::Null };
            if !inferred.is_null() {
                s.set_setting(&format!("conversation_model:{account}"), &inferred.to_string())?;
            }
            Ok(inferred)
        })
    }

    pub(super) fn conversation_snapshot(&self, route: &Route) -> Result<Value, String> {
        let preference = self.conversation_model(&route.source.account_ref)?;
        let model_result = preference["envName"].as_str().ok_or_else(|| "hermes_conversation_model_required".to_string()).and_then(model_config);
        let model_error = model_result.as_ref().err().cloned();
        let mut model = model_result.unwrap_or(Value::Null);
        if let Some(selected) = preference["model"].as_str().filter(|m| !m.trim().is_empty() && model.is_object()) {
            model["model"] = json!(selected);
        }
        self.with_store(|s| {
            let bindings = s.session_bindings()?.into_iter().filter(|b| b.route_id == route.id && b.generation == route.generation)
                .map(|b| json!({"runtimeId":b.runtime_id,"title":b.title})).collect::<Vec<_>>();
            let notifications = s.deliveries()?.into_iter().filter(|d| d.route_id == route.id && d.generation == route.generation && d.status == "sent" && d.conversation_scope.is_none())
                .take(5).map(|d| json!({"id":d.id,"text":d.text,"createdAt":d.created_at})).collect::<Vec<_>>();
            Ok(json!({"scope":scope(route),"model":model,"modelError":model_error,"bindings":bindings,"recentNotifications":notifications,
                "hasPendingCcemInput":!s.pending_chat_inputs(route)?.is_empty()}))
        })
    }

    pub(super) fn save_conversation_model(&self, payload: &Value) -> Result<(), String> {
        let account = payload["accountRef"].as_str().ok_or("account_ref_required")?;
        let env = payload["modelEnv"].as_str().ok_or("hermes_api_environment_required")?;
        let model = model_config(env)?;
        self.with_store(|s| {
            s.connection(account)?;
            s.set_setting(&format!("conversation_model:{account}"), &json!({"envName":env,"model":model["model"]}).to_string())
        })
    }

    pub(super) fn mark_presented_input(&self, delivery_id: &str) -> Result<(), String> {
        let Some(input) = self.with_store(|s| presented_from_delivery(s, delivery_id))? else { return Ok(()); };
        let mut presented = self.presented_inputs.lock().map_err(|_| "bridge_lock_poisoned")?;
        presented.retain(|_, p| p.expires > now());
        if presented.len() >= 256 && !presented.contains_key(&input.challenge) { return Err("confirmation_queue_full".into()); }
        presented.insert(input.challenge.clone(), input);
        Ok(())
    }

    pub(super) fn enqueue_confirmation_preview(&self, route: &Route, owner: &str, input: &Value) -> Result<(), String> {
        let challenge = input["challenge"].as_str().ok_or("challenge_required")?;
        let runtime = input["runtimeId"].as_str().ok_or("runtime_id_required")?;
        let text = input["text"].as_str().ok_or("input_text_required")?;
        let title = self.native.get_session_summary(runtime)?.and_then(|s| s.display_title).unwrap_or_else(|| "当前任务".into());
        let title: String = title.chars().take(80).collect();
        let preview = format!("准备交给「{title}」执行：\n\n{text}\n\n回复“确认”后开始，回复“取消”放弃。两分钟内有效。");
        // The preview must contain the entire frozen instruction on every supported channel.
        if preview.len() > 1900 { return Err("confirmation_preview_too_large".into()); }
        self.with_store(|s| {
            let id = digest(&format!("confirmation-preview:{challenge}"));
            if s.delivery(&id)?.is_none() {
                s.enqueue_delivery(&super::store::Delivery {
                    id, route_id:route.id.clone(), generation:route.generation, text:preview,
                    status:"pending".into(), receipt:None, created_at:now(), cron:None,
                    session_binding_id:None, conversation_scope:Some(scope(route)),
                    confirmation_preview:Some(super::store::ConfirmationPreview { challenge:challenge.into(), owner:digest(owner) }),
                })?;
            }
            Ok(())
        })
    }

    pub(super) fn short_confirmation(&self, route: &Route, owner: &str, message: &str, action: &str, received_at_ns: Option<u64>) -> Result<String, String> {
        let presented = self.presented_inputs.lock().map_err(|_| "bridge_lock_poisoned")?;
        self.with_store(|s| select_confirmation(s, route, owner, message, action, received_at_ns, &presented))
    }

    pub(super) fn enqueue_conversation_reply(&self, route: &Route, message: &str, text: &str, delivery_key: Option<&str>) -> Result<Value, String> {
        self.with_store(|s| enqueue_reply(s, route, message, text, delivery_key))
    }
}

fn enqueue_reply(s: &mut super::store::Store, route: &Route, message: &str, text: &str, delivery_key: Option<&str>) -> Result<Value, String> {
        if message.trim().is_empty() || message.len() > 512 { return Err("source_message_id_required".into()); }
        if text.trim().is_empty() || text.len() > 32_000 { return Err("invalid_conversation_reply".into()); }
        let delivered_text = if delivery_key.is_some() {
            if text.len() > 3500 { return Err("invalid_conversation_reply".into()); }
            text.to_owned()
        } else { super::bounded_chat_text(text) };
        let scope = scope(route);
        let id = conversation_delivery_id(&scope, message, delivery_key)?;
            if let Some(existing) = s.delivery(&id)? {
                if existing.text != delivered_text { return Err("source_message_payload_conflict".into()); }
                return Ok(json!({"deliveryId":id,"status":existing.status}));
            }
            s.enqueue_delivery(&super::store::Delivery {
                id:id.clone(), route_id:route.id.clone(), generation:route.generation,
                text:delivered_text, status:"pending".into(), receipt:None,
                created_at:now(), cron:None, session_binding_id:None, conversation_scope:Some(scope), confirmation_preview: None,
            })?;
            Ok(json!({"deliveryId":id,"status":s.delivery(&id)?.map(|d| d.status)}))
}

impl super::store::Store {
    pub(super) fn conversation_tools_mode(&self, account: &str) -> Result<String, String> {
        // Existing paired bots retain their granted capabilities until the owner opts in.
        Ok(match self.setting(&format!("conversation_tools:{account}"))?.as_deref() {
            Some("native") => "native",
            _ => "ccem",
        }.into())
    }
}

fn conversation_delivery_id(scope: &str, message: &str, key: Option<&str>) -> Result<String, String> {
    match key {
        None => Ok(digest(&format!("conversation-reply:{scope}:{message}"))),
        Some(key) if !key.is_empty() && key.len() <= 160 && key.bytes().all(|c| c.is_ascii_alphanumeric() || b"-_:".contains(&c)) => {
            Ok(digest(&format!("conversation-part:{}", json!([scope, message, key]))))
        }
        _ => Err("invalid_delivery_key".into()),
    }
}

fn presented_from_delivery(store: &super::store::Store, id: &str) -> Result<Option<PresentedInput>, String> {
    let Some(delivery) = store.delivery(id)?.filter(|d| d.status == "sent") else { return Ok(None); };
    // Both timestamps come from this authenticated host's monotonic clock. A
    // restart rotates the owner, so a stamp is never compared across processes.
    let Some(shown_at_ns) = delivery.receipt.as_ref().and_then(|r| r["confirmedAtNs"].as_u64()).filter(|t| *t > 0) else { return Ok(None); };
    let Some(preview) = delivery.confirmation_preview else { return Ok(None); };
    let Some(route) = store.routes()?.into_iter().find(|r| r.id == delivery.route_id && r.generation == delivery.generation && r.enabled) else { return Ok(None); };
    let (input_route, _) = store.confirmation_route(&route, &preview.challenge)?;
    let (expires, state) = store.challenge_state(&input_route, &preview.challenge)?;
    if state != "pending" || expires <= now() { return Ok(None); }
    Ok(Some(PresentedInput { owner:preview.owner, scope:scope(&route), challenge:preview.challenge, expires, shown_at_ns }))
}

fn select_confirmation(store: &super::store::Store, route: &Route, owner: &str, message: &str, action: &str, received_at_ns: Option<u64>, presented: &std::collections::HashMap<String, PresentedInput>) -> Result<String, String> {
        let remembered = store.short_reply_choice(route, message, action, None)?;
        let candidates = presented.values()
            .filter(|p| p.owner == digest(owner) && p.scope == scope(route) && p.expires > now()
                && received_at_ns.is_some_and(|t| t > p.shown_at_ns))
            .cloned().collect::<Vec<_>>();
        let mut pending = Vec::new();
        for p in candidates {
            if let Ok((input_route, _)) = store.confirmation_route(route, &p.challenge) {
                if store.challenge_state(&input_route, &p.challenge).is_ok_and(|(expires,state)| expires > now() && state == "pending") {
                    pending.push(p.challenge);
                }
            }
        }
        if let Some(choice) = remembered {
            let (input_route, _) = store.confirmation_route(route, &choice)?;
            let (_, state) = store.challenge_state(&input_route, &choice)?;
            // A duplicate may observe its original result, but never choose another input.
            if state == "confirmed" || pending.contains(&choice) { return Ok(choice); }
            return Err("challenge_expired_or_revoked".into());
        }
        if pending.len() != 1 {
            let reason = if pending.is_empty() {"no_presented_confirmation"} else {"ambiguous_confirmation"};
            store.reject_short_reply(route, message, action, reason)?;
            return Err(reason.into());
        }
        if store.pending_chat_inputs(route)? != pending {
            store.reject_short_reply(route, message, action, "ambiguous_confirmation")?;
            return Err("ambiguous_confirmation".into());
        }
        store.short_reply_choice(route, message, action, Some(&pending[0]))?
            .ok_or_else(|| "no_presented_confirmation".into())
}

#[cfg(test)]
#[path = "conversation_tests.rs"]
mod tests;
