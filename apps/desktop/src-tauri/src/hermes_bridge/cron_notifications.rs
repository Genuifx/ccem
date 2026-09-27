use super::{
    bounded_chat_text,
    store::{digest, now, Delivery, Route, Store},
    HermesBridgeManager,
};
use crate::cron::{self, CronDeliveryScope, CronHermesNotification, CronTask, CronTaskRun};
use serde_json::{json, Value};

fn delivery_id(task_id: &str, run_id: &str) -> String {
    digest(&format!("cron-result:{task_id}:{run_id}"))
}

fn target_route(store: &Store, target: &CronHermesNotification) -> Result<Option<Route>, String> {
    Ok(store.routes()?.into_iter().find(|route| {
        route.id == target.route_id
            && route.generation == target.generation
            && route.enabled
            && store
                .connection(&route.source.account_ref)
                .is_ok_and(|connection| connection.platform == route.source.platform)
    }))
}

fn enqueue(store: &mut Store, task: &CronTask, run: &CronTaskRun) -> Result<String, String> {
    if !cron::hermes_notifications::is_terminal(run) || task.id != run.task_id {
        return Err("cron_result_not_terminal".into());
    }
    let snapshot = run
        .hermes_notification
        .as_ref()
        .ok_or("cron_result_not_subscribed")?;
    let id = delivery_id(&task.id, &run.id);
    if let Some(existing) = store.delivery(&id)? {
        return Ok(existing.status);
    }
    let scope = CronDeliveryScope {
        task_id: task.id.clone(),
        run_id: run.id.clone(),
        subscription_id: snapshot.target.subscription_id.clone(),
    };
    let authorized = cron::hermes_notifications::subscription_matches(
        task,
        &scope,
        &snapshot.target.route_id,
        snapshot.target.generation,
    ) && target_route(store, &snapshot.target)?.is_some();
    let delivery = Delivery {
        conversation_scope: None, confirmation_preview: None,
        session_binding_id: None,
        id,
        route_id: snapshot.target.route_id.clone(),
        generation: snapshot.target.generation,
        text: bounded_chat_text(&cron::format_cron_notification(task, run)),
        status: if authorized { "pending" } else { "revoked" }.into(),
        receipt: None,
        created_at: now(),
        cron: Some(scope),
    };
    store.enqueue_delivery(&delivery)?;
    Ok(delivery.status)
}

impl HermesBridgeManager {
    pub fn cron_notification_targets(&self) -> Result<Value, String> {
        self.with_store(|store| {
            let connections = store.connections()?;
            let targets: Vec<_> = store
                .routes()?
                .iter()
                .filter(|route| route.enabled)
                .filter_map(|route| {
                    let connection = connections.iter().find(|c| {
                        c.account_ref == route.source.account_ref
                            && c.enabled
                            && c.platform == route.source.platform
                    })?;
                    Some(json!({
                        "routeId": route.id, "generation": route.generation,
                        "accountRef": connection.account_ref, "platform": connection.platform,
                        "label": connection.label, "chatId": route.source.chat_id,
                        "threadId": route.source.thread_id, "userId": route.source.user_id,
                        "chatType": route.source.chat_type,
                    }))
                })
                .collect();
            Ok(json!(targets))
        })
    }

    pub fn validate_cron_target(&self, target: &CronHermesNotification) -> Result<(), String> {
        self.with_store(|store| {
            let route =
                target_route(store, target)?.ok_or("hermes_notification_target_unavailable")?;
            if !store.connection(&route.source.account_ref)?.enabled {
                return Err("hermes_notification_target_unavailable".into());
            }
            Ok(())
        })
    }

    pub fn enqueue_cron_notification(
        &self,
        task: &CronTask,
        run: &CronTaskRun,
    ) -> Result<String, String> {
        let _guard = self.lifecycle.lock().map_err(|_| "bridge_lock_poisoned")?;
        self.with_store(|store| enqueue(store, task, run))
    }

    pub fn cron_notification_status(
        &self,
        task_id: &str,
        run_id: &str,
        target: &CronHermesNotification,
    ) -> Result<String, String> {
        self.with_store(|store| {
            if let Some(delivery) = store.delivery(&delivery_id(task_id, run_id))? {
                return Ok(delivery.status);
            }
            let scope = CronDeliveryScope {
                task_id: task_id.into(),
                run_id: run_id.into(),
                subscription_id: target.subscription_id.clone(),
            };
            if !cron::hermes_notifications::delivery_authorized(
                &scope,
                &target.route_id,
                target.generation,
            )? || target_route(store, target)?.is_none()
            {
                return Ok("revoked".into());
            }
            Ok("pending".into())
        })
    }

    pub(super) fn reconcile_cron_notifications(&self, account: &str) -> Result<(), String> {
        // The immutable run snapshot is the recovery journal for the gap between
        // saving a terminal run and inserting its deterministic outbox record.
        let (pending, issues) = cron::hermes_notifications::pending_completions()?;
        let _guard = self.lifecycle.lock().map_err(|_| "bridge_lock_poisoned")?;
        self.with_store(|store| {
            let routes = store.routes()?;
            for (task, run) in pending {
                if run.hermes_notification.as_ref().is_some_and(|d| {
                    routes
                        .iter()
                        .any(|r| r.id == d.target.route_id && r.source.account_ref == account)
                }) {
                    enqueue(store, &task, &run)?;
                }
            }
            if issues.is_empty() {
                Ok(())
            } else {
                Err(issues.join("; "))
            }
        })
    }
}

#[cfg(test)]
#[path = "cron_notification_tests.rs"]
mod tests;
