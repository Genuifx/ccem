#[test]
fn queued_boot_cannot_claim_a_later_page_that_has_not_registered_a_document_yet() {
    use std::sync::{mpsc, Arc};
    const DOCUMENT_C: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    let recovery = Arc::new(browser_recovery());
    recovery.0.lock().unwrap().policy.page_started();
    assert_eq!(recovery.boot_generation_ticket().unwrap(), 0);
    recovery.boot_document(DOCUMENT_A, 0, || Ok(())).unwrap();
    recovery
        .0
        .lock()
        .unwrap()
        .policy
        .ready(DOCUMENT_A, 0)
        .unwrap();
    let (entered_tx, entered_rx) = mpsc::sync_channel(1);
    let (finish_tx, finish_rx) = mpsc::sync_channel(1);
    let old_recovery = Arc::clone(&recovery);
    let old_browser = std::thread::spawn(move || {
        old_recovery.with_document(DOCUMENT_A, 0, || {
            entered_tx.send(()).unwrap();
            finish_rx.recv_timeout(Duration::from_secs(3)).unwrap();
            Ok(())
        })
    });
    entered_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    recovery.0.lock().unwrap().policy.page_started();
    let ticket_b = recovery.boot_generation_ticket().unwrap();
    let (queued_tx, queued_rx) = mpsc::sync_channel(1);
    let boot_recovery = Arc::clone(&recovery);
    let boot_b = std::thread::spawn(move || {
        queued_tx.send(()).unwrap();
        boot_recovery.boot_document(DOCUMENT_B, ticket_b, || panic!("retired boot reset"))
    });
    queued_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(recovery.1.try_write().is_err());
    {
        let mut state = recovery.0.lock().unwrap();
        assert!(state.policy.document_id.is_none());
        state.policy.page_started();
    }
    let ticket_c = recovery.boot_generation_ticket().unwrap();
    assert_eq!(ticket_c, ticket_b + 1);
    finish_tx.send(()).unwrap();
    old_browser.join().unwrap().unwrap();
    assert!(boot_b.join().unwrap().unwrap_err().contains("boot ticket"));
    let current = recovery
        .boot_document(DOCUMENT_C, ticket_c, || Ok(()))
        .unwrap();
    assert_eq!(current.document_id, DOCUMENT_C);
    recovery
        .with_document(DOCUMENT_C, ticket_c, || Ok(()))
        .unwrap();
}

#[test]
fn workspace_removal_closes_exact_targets_and_preserves_rebound_runtime() {
    let recovery = browser_recovery();
    recovery.boot_document(DOCUMENT_A, 0, || Ok(())).unwrap();
    let mut initial = workspace_fixture(3);
    let mut panel_b = initial.targets["runtime:session-a"].clone();
    panel_b.surface_session_id = "panel-b".into();
    let mut panel_c = panel_b.clone();
    panel_c.surface_session_id = "panel-c".into();
    initial.targets.insert("session-b".into(), panel_b);
    initial.targets.insert("session-c".into(), panel_c);
    recovery
        .save_browser_workspace(DOCUMENT_A, 0, 1, initial.clone())
        .unwrap();
    let mut next = initial;
    let rebound = next.targets.remove("runtime:session-a").unwrap();
    next.targets.clear();
    next.targets.insert("provider:session-a".into(), rebound);
    let mut visited = Vec::new();
    recovery
        .save_browser_workspace_with_cleanup(DOCUMENT_A, 0, 2, next, |panel| {
            assert!(
                recovery.1.try_read().is_err(),
                "acquire must wait for cleanup"
            );
            assert!(
                recovery.0.try_lock().is_ok(),
                "native callbacks must remain unblocked"
            );
            visited.push(panel.to_string());
            Ok(true)
        })
        .unwrap();
    assert_eq!(visited, ["panel-b", "panel-c"]);
    let state = recovery.0.lock().unwrap();
    assert!(state.closed_browser_targets.contains("panel-b"));
    assert!(state.closed_browser_targets.contains("panel-c"));
    assert_eq!(
        state.browser_workspace.as_ref().unwrap().targets["provider:session-a"].surface_session_id,
        "runtime:session-a:2"
    );
}

#[test]
fn partial_workspace_cleanup_retains_retryable_metadata_and_never_repeats_a_completed_close() {
    let recovery = browser_recovery();
    recovery.boot_document(DOCUMENT_A, 0, || Ok(())).unwrap();
    let mut initial = workspace_fixture(3);
    let mut panel_b = initial.targets["runtime:session-a"].clone();
    panel_b.surface_session_id = "runtime:session-b:3".into();
    initial.targets.insert("session-b".into(), panel_b);
    recovery
        .save_browser_workspace(DOCUMENT_A, 0, 1, initial.clone())
        .unwrap();
    let mut empty = initial;
    empty.targets.clear();
    let mut first_attempt = Vec::new();
    assert!(recovery
        .save_browser_workspace_with_cleanup(DOCUMENT_A, 0, 2, empty.clone(), |panel| {
            first_attempt.push(panel.to_string());
            if panel == "runtime:session-b:3" {
                Err("native close temporarily failed".into())
            } else {
                Ok(true)
            }
        })
        .is_err());
    assert_eq!(
        first_attempt,
        ["runtime:session-a:2", "runtime:session-b:3"]
    );
    {
        let state = recovery.0.lock().unwrap();
        assert_eq!(state.browser_workspace_revision, 1);
        let remaining = &state.browser_workspace.as_ref().unwrap().targets;
        assert!(!remaining.contains_key("runtime:session-a"));
        assert!(remaining.contains_key("session-b"));
    }
    let mut retry = Vec::new();
    recovery
        .save_browser_workspace_with_cleanup(DOCUMENT_A, 0, 2, empty.clone(), |panel| {
            retry.push(panel.to_string());
            Ok(true)
        })
        .unwrap();
    assert_eq!(retry, ["runtime:session-b:3"]);
    recovery
        .save_browser_workspace_with_cleanup(DOCUMENT_A, 0, 2, empty, |_| {
            panic!("idempotent ACK must not close anything")
        })
        .unwrap();
    let state = recovery.0.lock().unwrap();
    assert_eq!(state.browser_workspace_revision, 2);
    assert!(state.browser_workspace.as_ref().unwrap().targets.is_empty());
}

#[cfg(any(target_os = "macos", windows))]
#[test]
fn removing_a_leased_target_closes_its_real_managers_before_reload_without_an_unmount_release() {
    use crate::browser::login::{
        session::{LoginBrowserSessionStatus, SessionLifecycleFixture, SessionManagerError},
        surface_commands::retained_workspace_manager_fixture,
    };
    let sessions = SessionLifecycleFixture::new();
    let (first, second) = sessions.open_workspace_removal_pair();
    let surfaces = retained_workspace_manager_fixture(&first, &second);
    let recovery = browser_recovery();
    recovery.boot_document(DOCUMENT_A, 0, || Ok(())).unwrap();
    let mut workspace = workspace_fixture(3);
    let mut other_target = workspace.targets["runtime:session-a"].clone();
    other_target.surface_session_id = "runtime:session-b:3".into();
    workspace.targets.insert("session-b".into(), other_target);
    recovery
        .save_browser_workspace(DOCUMENT_A, 0, 1, workspace.clone())
        .unwrap();
    workspace.targets.remove("runtime:session-a");
    recovery
        .save_browser_workspace_with_cleanup(DOCUMENT_A, 0, 2, workspace, |panel_id| {
            surfaces.close_removed_workspace_target(&sessions.manager, panel_id)
        })
        .unwrap();
    // This invokes the production surface + session managers and the existing
    // fake supervisor's verified backend shutdown; no unmount release is sent.
    assert_eq!(sessions.close_count(), 1);
    assert!(matches!(
        sessions.manager.snapshot(&first.handle),
        Err(SessionManagerError::SessionNotFound)
    ));
    assert_eq!(
        sessions.manager.snapshot(&second.handle).unwrap().status,
        LoginBrowserSessionStatus::Running
    );
    assert!(!surfaces
        .close_removed_workspace_target(&sessions.manager, "runtime:session-a:2")
        .unwrap());
    assert_eq!(sessions.close_count(), 1);
    {
        let mut state = recovery.0.lock().unwrap();
        state.policy.ready(DOCUMENT_A, 0).unwrap();
        state.policy.page_started();
    }
    let restored = recovery
        .boot_document(DOCUMENT_B, 1, || Ok(()))
        .unwrap()
        .browser_workspace
        .unwrap();
    assert!(!restored.targets.contains_key("runtime:session-a"));
    assert!(restored.targets.contains_key("session-b"));
    assert_eq!(sessions.manager.list_snapshots().unwrap().len(), 1);
    assert!(surfaces
        .close_removed_workspace_target(&sessions.manager, "runtime:session-b:3")
        .unwrap());
    assert_eq!(sessions.close_count(), 2);
}
