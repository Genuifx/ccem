use super::super::{
    poll::{finish_delivery_with, reserve_delivery_with},
    store::{random_id, Source},
};
use super::*;
use crate::cron::{
    hermes_notifications::{subscription_matches, version_subscription},
    CronHermesDelivery,
};
use std::{fs, path::PathBuf};

struct Fixture {
    root: PathBuf,
    store: Option<Store>,
    task: CronTask,
    run: CronTaskRun,
    route: Route,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("ccem-cron-notify-{}", random_id()));
        let mut store = Store::open(&root).unwrap();
        let account = store
            .save_connection(None, "wecom", Some("Paired bot"), "test-cipher", &[], false)
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
        let target = version_subscription(
            CronHermesNotification {
                route_id: route.id.clone(),
                generation: route.generation,
                subscription_id: String::new(),
            },
            None,
        );
        let mut task: CronTask = serde_json::from_value(json!({
            "id":"task-one", "name":"Daily report", "cronExpression":"0 9 * * *", "prompt":"summarize", "workingDir":"/tmp",
            "envName":null, "enabled":true, "timeoutSecs":30, "templateId":null, "createdAt":"now", "updatedAt":"now"
        })).unwrap();
        task.hermes_notification = Some(target.clone());
        let mut run: CronTaskRun = serde_json::from_value(json!({
            "id":"run-one", "taskId":"task-one", "startedAt":"now", "finishedAt":"later", "exitCode":0,
            "stdout":"Report result", "stderr":"", "durationMs":100, "status":"success"
        })).unwrap();
        run.hermes_notification = Some(CronHermesDelivery {
            target,
            status: "pending".into(),
        });
        Self {
            root,
            store: Some(store),
            task,
            run,
            route,
        }
    }
    fn enqueue(&mut self) -> String {
        enqueue(self.store.as_mut().unwrap(), &self.task, &self.run).unwrap()
    }
    fn delivery(&self) -> Delivery {
        self.store
            .as_ref()
            .unwrap()
            .delivery(&delivery_id(&self.task.id, &self.run.id))
            .unwrap()
            .unwrap()
    }
    fn restart(&mut self) {
        self.store.take();
        self.store = Some(Store::open(&self.root).unwrap());
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.store.take();
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn task_result_uses_paired_chat_without_workspace_or_session_notification_permission() {
    let mut f = Fixture::new();
    assert!(!f.route.notifications && !f.route.allow_input && f.route.workspaces.is_empty());
    assert_eq!(f.enqueue(), "pending");
    let task = f.task.clone();
    let id = f.delivery().id;
    let (reserved, route) = reserve_delivery_with(f.store.as_mut().unwrap(), &id, |d| {
        Ok(subscription_matches(
            &task,
            d.cron.as_ref().unwrap(),
            &d.route_id,
            d.generation,
        ))
    })
    .unwrap()
    .unwrap();
    assert_eq!(route.source.target()["chat_id"], "verified-chat");
    finish_delivery_with(
        f.store.as_mut().unwrap(),
        &reserved,
        Ok(json!({"status":"sent"})),
        true,
        |_| Ok(true),
    )
    .unwrap();
    assert_eq!(f.delivery().status, "sent");
    assert_eq!(f.enqueue(), "sent");
    assert_eq!(f.store.as_ref().unwrap().deliveries().unwrap().len(), 1);
}

#[test]
fn terminal_recovery_is_idempotent_and_does_not_backfill_unsubscribed_history() {
    let mut f = Fixture::new();
    let journal = f.root.join("terminal-run.json");
    crate::secure_fs::write_private_atomic(&journal, &serde_json::to_vec(&f.run).unwrap()).unwrap();
    f.restart(); // terminal journal survived but enqueue had not run
    f.run = serde_json::from_slice(&fs::read(journal).unwrap()).unwrap();
    assert_eq!(f.enqueue(), "pending");
    f.restart();
    assert_eq!(f.enqueue(), "pending");
    f.run.id = "run-two".into();
    f.run.status = "failed".into();
    assert_eq!(f.enqueue(), "pending");
    f.run.id = "run-three".into();
    f.run.status = "timeout".into();
    assert_eq!(f.enqueue(), "pending");
    assert_eq!(f.store.as_ref().unwrap().deliveries().unwrap().len(), 3);
    f.run.id = "old-run".into();
    f.run.hermes_notification = None;
    assert_eq!(
        enqueue(f.store.as_mut().unwrap(), &f.task, &f.run).unwrap_err(),
        "cron_result_not_subscribed"
    );
}

#[test]
fn recovery_scans_persisted_completion_and_isolates_other_task_history_errors() {
    let mut f = Fixture::new();
    let mut broken = f.task.clone();
    broken.id = "broken-task".into();
    let mut unsubscribed = f.run.clone();
    unsubscribed.id = "old".into();
    unsubscribed.hermes_notification = None;
    let mut changed = f.run.clone();
    changed.id = "old-subscription".into();
    changed
        .hermes_notification
        .as_mut()
        .unwrap()
        .target
        .subscription_id = "revoked-grant".into();
    let journal = f.root.join("runs.json");
    fs::write(
        &journal,
        serde_json::to_vec(&vec![unsubscribed, changed, f.run.clone()]).unwrap(),
    )
    .unwrap();
    let (pending, errors) = cron::hermes_notifications::collect_pending_completions(
        vec![broken, f.task.clone()],
        |id| {
            if id == "broken-task" {
                return Err("invalid JSON".into());
            }
            serde_json::from_slice(&fs::read(&journal).unwrap()).map_err(|e| e.to_string())
        },
    );
    assert_eq!(errors.len(), 1);
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].1.id, f.run.id);
    f.restart();
    assert_eq!(
        enqueue(f.store.as_mut().unwrap(), &pending[0].0, &pending[0].1).unwrap(),
        "pending"
    );
}

#[test]
fn running_or_unfinished_results_are_never_enqueued() {
    let mut f = Fixture::new();
    f.run.status = "running".into();
    assert!(enqueue(f.store.as_mut().unwrap(), &f.task, &f.run).is_err());
    f.run.status = "success".into();
    f.run.finished_at = None;
    assert!(enqueue(f.store.as_mut().unwrap(), &f.task, &f.run).is_err());
    assert!(f.store.as_ref().unwrap().deliveries().unwrap().is_empty());
}

#[test]
fn target_change_or_reenable_during_run_cannot_revive_old_results() {
    let mut f = Fixture::new();
    let old = f.task.hermes_notification.take().unwrap();
    f.task.hermes_notification = Some(version_subscription(old, None));
    assert_eq!(f.enqueue(), "revoked");
    assert_ne!(
        f.task.hermes_notification,
        f.run.hermes_notification.as_ref().map(|d| d.target.clone())
    );
}

#[test]
fn removing_or_repairing_route_revokes_result_without_rerouting() {
    for remove in [true, false] {
        let mut f = Fixture::new();
        if remove {
            f.store
                .as_mut()
                .unwrap()
                .remove_connection(&f.route.source.account_ref)
                .unwrap();
        } else {
            f.store
                .as_mut()
                .unwrap()
                .approve_route(f.route.source.clone(), vec![], false, false)
                .unwrap();
        }
        assert_eq!(f.enqueue(), "revoked");
    }
}

#[test]
fn authorization_failure_leaves_pending_and_explicit_revocation_cancels() {
    let mut f = Fixture::new();
    f.enqueue();
    let id = f.delivery().id;
    assert!(reserve_delivery_with(
        f.store.as_mut().unwrap(),
        &id,
        |_| Err("read_failed".into())
    )
    .is_err());
    assert_eq!(f.delivery().status, "pending");
    assert!(
        reserve_delivery_with(f.store.as_mut().unwrap(), &id, |_| Ok(false))
            .unwrap()
            .is_none()
    );
    assert_eq!(f.delivery().status, "revoked");
}

#[test]
fn ambiguous_receipts_restarts_and_mid_send_revocations_never_resend() {
    for outcome in ["restart", "error", "not_sent", "revoked"] {
        let mut f = Fixture::new();
        f.enqueue();
        let id = f.delivery().id;
        let (reserved, _) = reserve_delivery_with(f.store.as_mut().unwrap(), &id, |_| Ok(true))
            .unwrap()
            .unwrap();
        if outcome == "restart" {
            f.restart();
        } else {
            let receipt = if outcome == "error" {
                Err("timeout".into())
            } else {
                Ok(json!({"status":if outcome == "not_sent" { "not_sent" } else { "sent" }}))
            };
            finish_delivery_with(f.store.as_mut().unwrap(), &reserved, receipt, true, |_| {
                Ok(outcome != "revoked")
            })
            .unwrap();
        }
        let expected = if outcome == "not_sent" {
            "not_sent"
        } else {
            "unknown"
        };
        assert_eq!(f.enqueue(), expected);
        assert!(
            reserve_delivery_with(f.store.as_mut().unwrap(), &id, |_| Ok(true))
                .unwrap()
                .is_none()
        );
    }
}

#[test]
fn legacy_workspace_delivery_still_requires_workspace_notification_permission() {
    let mut f = Fixture::new();
    let delivery =
        super::super::make_delivery(&f.route, "workspace-event", "private output".into());
    f.store
        .as_ref()
        .unwrap()
        .enqueue_delivery(&delivery)
        .unwrap();
    assert!(
        reserve_delivery_with(f.store.as_mut().unwrap(), &delivery.id, |_| Ok(true))
            .unwrap()
            .is_none()
    );
    assert_eq!(
        f.store
            .as_ref()
            .unwrap()
            .delivery(&delivery.id)
            .unwrap()
            .unwrap()
            .status,
        "revoked"
    );
}
