//! Task-scoped result subscriptions. Pairing does not grant workspace access.
use super::{read_runs, read_tasks, CronTask, CronTaskRun};
use crate::hermes_bridge::HermesBridgeManager;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CronHermesNotification {
    pub route_id: String,
    pub generation: i64,
    #[serde(default)]
    pub subscription_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronHermesDelivery {
    pub target: CronHermesNotification,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CronDeliveryScope {
    pub task_id: String,
    pub run_id: String,
    pub subscription_id: String,
}

pub fn same_target(a: &CronHermesNotification, b: &CronHermesNotification) -> bool {
    a.route_id == b.route_id && a.generation == b.generation
}

/// Ignore client-provided subscription IDs. Turning a subscription off and on
/// must not revive notifications belonging to an earlier grant.
pub fn version_subscription(
    mut target: CronHermesNotification,
    previous: Option<&CronHermesNotification>,
) -> CronHermesNotification {
    target.subscription_id = previous
        .filter(|old| same_target(old, &target) && !old.subscription_id.is_empty())
        .map(|old| old.subscription_id.clone())
        .unwrap_or_else(|| hex::encode(rand::random::<[u8; 24]>()));
    target
}

pub fn is_terminal(run: &CronTaskRun) -> bool {
    run.finished_at.is_some() && matches!(run.status.as_str(), "success" | "failed" | "timeout")
}

pub fn subscription_matches(
    task: &CronTask,
    scope: &CronDeliveryScope,
    route_id: &str,
    generation: i64,
) -> bool {
    !scope.run_id.is_empty()
        && !scope.subscription_id.is_empty()
        && task.id == scope.task_id
        && task.hermes_notification.as_ref().is_some_and(|target| {
            target.route_id == route_id
                && target.generation == generation
                && target.subscription_id == scope.subscription_id
        })
}

pub fn delivery_authorized(
    scope: &CronDeliveryScope,
    route_id: &str,
    generation: i64,
) -> Result<bool, String> {
    // A temporary file/parse error is not a revocation: leave the outbox alone.
    Ok(read_tasks()?
        .iter()
        .any(|task| subscription_matches(task, scope, route_id, generation)))
}

type PendingCompletions = (Vec<(CronTask, CronTaskRun)>, Vec<String>);

pub fn pending_completions() -> Result<PendingCompletions, String> {
    Ok(collect_pending_completions(read_tasks()?, read_runs))
}

pub fn collect_pending_completions(
    tasks: Vec<CronTask>,
    mut load_runs: impl FnMut(&str) -> Result<Vec<CronTaskRun>, String>,
) -> PendingCompletions {
    let mut pending = Vec::new();
    let mut issues = Vec::new();
    for task in tasks {
        if task.hermes_notification.is_none() {
            continue;
        }
        let runs = match load_runs(&task.id) {
            Ok(runs) => runs,
            Err(_) => {
                if issues.len() < 3 {
                    issues.push(format!("cron_run_history_unavailable: {}", task.id));
                }
                continue;
            }
        };
        for run in runs {
            if is_terminal(&run)
                && run.task_id == task.id
                && run.hermes_notification.as_ref().is_some_and(|delivery| {
                    delivery.status == "pending"
                        && Some(&delivery.target) == task.hermes_notification.as_ref()
                })
            {
                pending.push((task.clone(), run));
            }
        }
    }
    (pending, issues)
}

pub fn bridge(app: &AppHandle) -> Result<Arc<HermesBridgeManager>, String> {
    app.try_state::<Arc<HermesBridgeManager>>()
        .map(|state| state.inner().clone())
        .ok_or_else(|| "hermes_unavailable".into())
}

pub fn complete(app: &AppHandle, task: &CronTask, run: &mut CronTaskRun) {
    if run.hermes_notification.is_none() {
        return;
    }
    // Re-read: the user may have removed or changed the recipient during the run.
    let result = (|| {
        let current = read_tasks()?
            .into_iter()
            .find(|current| current.id == task.id);
        let Some(current) = current else {
            return Ok("revoked".to_string());
        };
        bridge(app)?.enqueue_cron_notification(&current, run)
    })();
    if let Some(delivery) = run.hermes_notification.as_mut() {
        delivery.status = result.unwrap_or_else(|_| "pending".into());
    }
}

pub fn hydrate(app: &AppHandle, run: &mut CronTaskRun) {
    let Some(snapshot) = run.hermes_notification.clone() else {
        return;
    };
    if !is_terminal(run) {
        return;
    }
    let status = bridge(app)
        .and_then(|bridge| bridge.cron_notification_status(&run.task_id, &run.id, &snapshot.target))
        .unwrap_or_else(|_| "unavailable".into());
    if let Some(delivery) = run.hermes_notification.as_mut() {
        delivery.status = status;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subscription_version_survives_unrelated_edits_but_not_reenable_or_retarget() {
        let chosen = CronHermesNotification {
            route_id: "paired".into(),
            generation: 1,
            subscription_id: "client-invented".into(),
        };
        let a = version_subscription(chosen.clone(), None);
        assert_ne!(a.subscription_id, chosen.subscription_id);
        let edited = version_subscription(chosen.clone(), Some(&a));
        assert_eq!(edited, a);
        let reopened = version_subscription(chosen.clone(), None);
        assert_ne!(reopened.subscription_id, a.subscription_id);
        let b = version_subscription(
            CronHermesNotification {
                route_id: "other".into(),
                ..chosen.clone()
            },
            Some(&a),
        );
        let a_again = version_subscription(chosen, Some(&b));
        assert_ne!(a_again.subscription_id, a.subscription_id);
    }
}
