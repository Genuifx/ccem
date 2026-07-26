use super::*;
use crate::browser::surface_coordinator::BrowserSurfaceReleaseDisposition;
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

#[cfg(any(target_os = "macos", windows))]
use crate::browser::login::{
    cef::recovery::{EmbeddedOwnerRecoveryDisposition, EmbeddedOwnerRecoveryRecord},
    session::EmbeddedProfileIdentity,
};

#[cfg(any(target_os = "macos", windows))]
fn recovery_record(
    profile_id: &str,
    workspace_id: &str,
    disposition: EmbeddedOwnerRecoveryDisposition,
) -> EmbeddedOwnerRecoveryRecord {
    EmbeddedOwnerRecoveryRecord {
        record_id: "embedded-owner-internal".to_string(),
        surface_id: "login-internal".to_string(),
        profile_id: profile_id.to_string(),
        workspace_identity: workspace_id.to_string(),
        disposition,
    }
}

const CONCURRENCY_TEST_TIMEOUT: Duration = Duration::from_secs(2);

#[test]
fn blocked_acquire_lifecycle_allows_login_and_preview_presentation_mutations() {
    let manager = Arc::new(LoginBrowserSurfaceManager::default());
    let (acquire_blocked_tx, acquire_blocked_rx) = mpsc::sync_channel(0);
    let (release_acquire_tx, release_acquire_rx) = mpsc::sync_channel(0);
    let acquire_manager = Arc::clone(&manager);
    let acquire = thread::spawn(move || {
        // `acquire_login` keeps exactly this guard while native attachment may take seconds.
        let _lifecycle = acquire_manager
            .begin_acquire()
            .expect("begin blocked acquire");
        acquire_blocked_tx
            .send(())
            .expect("publish blocked acquire");
        release_acquire_rx.recv().expect("release blocked acquire");
    });
    acquire_blocked_rx
        .recv_timeout(CONCURRENCY_TEST_TIMEOUT)
        .expect("acquire holds lifecycle gate");

    let (presentation_done_tx, presentation_done_rx) = mpsc::sync_channel(0);
    let presentation_manager = Arc::clone(&manager);
    let presentation = thread::spawn(move || {
        {
            let _operation = presentation_manager
                .mutation_operation()
                .expect("initial Login presentation");
            assert!(presentation_manager
                .state()
                .expect("initial Login state")
                .presentation_epoch
                .accepts_login_visibility(1, "panel-a", true));
        }
        {
            let _operation = presentation_manager
                .mutation_operation()
                .expect("Login hide lane remains available");
            assert!(presentation_manager
                .state()
                .expect("Login hide state")
                .presentation_epoch
                .accepts_login_visibility(2, "panel-a", false));
        }
        {
            let _operation = presentation_manager
                .mutation_operation()
                .expect("Preview show lane remains available");
            let mut state = presentation_manager.state().expect("Preview show state");
            assert!(state
                .presentation_epoch
                .accepts_preview_visibility(2, "preview-a", true));
            assert!(state.presentation_epoch.allows_preview_show("preview-a"));
        }
        {
            let _operation = presentation_manager
                .mutation_operation()
                .expect("Preview hide lane remains available");
            assert!(presentation_manager
                .state()
                .expect("Preview hide state")
                .presentation_epoch
                .accepts_preview_visibility(3, "preview-a", false));
        }
        {
            let _operation = presentation_manager
                .mutation_operation()
                .expect("Login re-show lane remains available");
            assert!(presentation_manager
                .state()
                .expect("Login re-show state")
                .presentation_epoch
                .accepts_login_visibility(3, "panel-a", true));
        }
        let state = presentation_manager
            .state()
            .expect("final presentation state");
        assert_eq!(
            state.presentation_epoch.owner,
            Some(PresentationOwner::Login("panel-a".to_string()))
        );
        drop(state);
        presentation_done_tx
            .send(())
            .expect("publish completed presentation");
    });

    // Presentation must finish before the synthetic CEF attachment is released.
    presentation_done_rx
        .recv_timeout(CONCURRENCY_TEST_TIMEOUT)
        .expect("blocked acquire must not block Login or Preview presentation");
    presentation.join().expect("presentation thread");
    release_acquire_tx
        .send(())
        .expect("release synthetic attachment");
    acquire.join().expect("acquire thread");
}

#[test]
fn acquire_and_shutdown_are_serialized_without_reopening_after_shutdown() {
    let manager = Arc::new(LoginBrowserSurfaceManager::default());
    let acquire = manager.begin_acquire().expect("acquire starts first");
    let (shutdown_attempted_tx, shutdown_attempted_rx) = mpsc::sync_channel(0);
    let (shutdown_done_tx, shutdown_done_rx) = mpsc::sync_channel(0);
    let shutdown_manager = Arc::clone(&manager);
    let shutdown = thread::spawn(move || {
        shutdown_attempted_tx
            .send(())
            .expect("publish shutdown attempt");
        shutdown_done_tx
            .send(shutdown_manager.begin_shutdown())
            .expect("publish shutdown result");
    });
    shutdown_attempted_rx
        .recv_timeout(CONCURRENCY_TEST_TIMEOUT)
        .expect("shutdown thread started");
    assert!(
        !manager
            .state()
            .expect("state before shutdown")
            .shutting_down,
        "acquire-first ordering must keep shutdown behind the lifecycle guard"
    );
    assert!(matches!(
        shutdown_done_rx.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));

    drop(acquire);
    shutdown_done_rx
        .recv_timeout(CONCURRENCY_TEST_TIMEOUT)
        .expect("shutdown completes after acquire")
        .expect("shutdown result");
    shutdown.join().expect("shutdown thread");
    assert!(manager.state().expect("state after shutdown").shutting_down);
    assert_eq!(
        manager
            .begin_acquire()
            .expect_err("shutdown-first ordering rejects acquire"),
        "Login Browser is shutting down."
    );
    assert_eq!(
        manager
            .mutation_operation()
            .expect_err("shutdown fence rejects a queued show"),
        "Login Browser is shutting down."
    );
}

#[test]
fn shutdown_fences_a_queued_release_before_it_can_close_the_session_again() {
    let manager = LoginBrowserSurfaceManager::default();
    manager.begin_shutdown().expect("begin shutdown");

    assert_eq!(
        manager
            .release_operation()
            .expect_err("shutdown must reject a later explicit release"),
        "Login Browser is shutting down."
    );
}

#[test]
fn destructive_lifecycle_then_operation_order_does_not_deadlock_with_show() {
    let manager = Arc::new(LoginBrowserSurfaceManager::default());
    let show = manager
        .mutation_operation()
        .expect("show owns the short operation lane");
    let (lifecycle_acquired_tx, lifecycle_acquired_rx) = mpsc::sync_channel(0);
    let (destructive_done_tx, destructive_done_rx) = mpsc::sync_channel(0);
    let destructive_manager = Arc::clone(&manager);
    let destructive = thread::spawn(move || {
        // This is the same fixed order used by release, terminal convergence, and shutdown.
        let _lifecycle = destructive_manager
            .lifecycle()
            .expect("destructive lifecycle lane");
        lifecycle_acquired_tx
            .send(())
            .expect("publish lifecycle acquisition");
        let _operation = destructive_manager
            .operation()
            .expect("destructive operation lane");
        destructive_done_tx
            .send(())
            .expect("publish destructive completion");
    });
    lifecycle_acquired_rx
        .recv_timeout(CONCURRENCY_TEST_TIMEOUT)
        .expect("destructive path holds lifecycle before operation");
    assert!(matches!(
        destructive_done_rx.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));

    // A show/sync path never requests lifecycle, so releasing its short mutation finishes the
    // destructive path instead of creating operation -> lifecycle / lifecycle -> operation cycle.
    drop(show);
    destructive_done_rx
        .recv_timeout(CONCURRENCY_TEST_TIMEOUT)
        .expect("close/show lock order completes");
    destructive.join().expect("destructive thread");
}

#[test]
fn close_first_blocks_show_then_the_stale_show_cannot_resurrect_the_instance() {
    let manager = Arc::new(LoginBrowserSurfaceManager::default());
    let slot = Arc::new(std::sync::Mutex::new((true, true)));
    let (close_entered_tx, close_entered_rx) = mpsc::sync_channel(0);
    let (release_close_tx, release_close_rx) = mpsc::sync_channel(0);
    let (close_done_tx, close_done_rx) = mpsc::sync_channel(0);
    let close_manager = Arc::clone(&manager);
    let close_slot = Arc::clone(&slot);
    let close = thread::spawn(move || {
        let guards = close_manager
            .destructive_operation()
            .expect("close owns both lanes");
        close_entered_tx.send(()).expect("publish close ownership");
        release_close_rx.recv().expect("release close");
        *close_slot.lock().expect("close slot") = (false, false);
        drop(guards);
        close_done_tx.send(()).expect("publish close completion");
    });
    close_entered_rx
        .recv_timeout(CONCURRENCY_TEST_TIMEOUT)
        .expect("close acquired both lanes");

    let (show_attempted_tx, show_attempted_rx) = mpsc::sync_channel(0);
    let (show_done_tx, show_done_rx) = mpsc::sync_channel(0);
    let show_manager = Arc::clone(&manager);
    let show_slot = Arc::clone(&slot);
    let show = thread::spawn(move || {
        show_attempted_tx.send(()).expect("publish show attempt");
        let _operation = show_manager
            .mutation_operation()
            .expect("show enters after close");
        let mut slot = show_slot.lock().expect("show slot");
        let applied = slot.0;
        if applied {
            slot.1 = true;
        }
        show_done_tx
            .send(applied)
            .expect("publish stale show result");
    });
    show_attempted_rx
        .recv_timeout(CONCURRENCY_TEST_TIMEOUT)
        .expect("show attempted behind close");
    assert!(matches!(
        show_done_rx.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));

    release_close_tx.send(()).expect("allow close to commit");
    close_done_rx
        .recv_timeout(CONCURRENCY_TEST_TIMEOUT)
        .expect("close committed before show");
    assert!(
        !show_done_rx
            .recv_timeout(CONCURRENCY_TEST_TIMEOUT)
            .expect("stale show completes"),
        "a post-close show must resolve as a no-op"
    );
    close.join().expect("close thread");
    show.join().expect("show thread");
    assert_eq!(
        *slot.lock().expect("final slot"),
        (false, false),
        "the exact closed instance stays absent and hidden"
    );
}

#[test]
fn production_paths_use_the_two_gates_with_one_fixed_destructive_order() {
    let source = include_str!("../surface_commands.rs");
    let acquire_start = source.find("fn acquire_login(").expect("acquire source");
    let acquire_end = source[acquire_start..]
        .find("fn start_state_watcher(")
        .map(|offset| acquire_start + offset)
        .expect("acquire source end");
    let acquire = &source[acquire_start..acquire_end];
    let new_instance = acquire
        .split_once("let mut coordinator")
        .expect("new instance acquire")
        .1;
    assert!(acquire.contains("let _lifecycle = self.begin_acquire()?;"));
    assert!(acquire[..acquire.find("let mut coordinator").unwrap()]
        .contains("let _operation = self.operation()?;"));
    assert!(
        !new_instance.contains("self.operation()?"),
        "native open and attachment must not own the presentation lane"
    );

    let sync_start = source.find("fn sync(").expect("sync source");
    let sync_end = source[sync_start..]
        .find("fn release(")
        .map(|offset| sync_start + offset)
        .expect("sync source end");
    let sync = &source[sync_start..sync_end];
    assert!(sync.contains("let _operation = self.mutation_operation()?;"));
    assert!(!sync.contains("destructive_operation"));

    let release_start = sync_end;
    let release_end = source[release_start..]
        .find("fn navigate(")
        .map(|offset| release_start + offset)
        .expect("release source end");
    assert!(source[release_start..release_end]
        .contains("let _destructive = self.release_operation()?;"));

    let release_operation_start = source
        .find("fn release_operation(")
        .expect("release operation source");
    let release_operation_end = source[release_operation_start..]
        .find("fn state(")
        .map(|offset| release_operation_start + offset)
        .expect("release operation source end");
    let release_operation = &source[release_operation_start..release_operation_end];
    assert!(release_operation.contains("let guards = self.destructive_operation()?;"));
    assert!(release_operation.contains("if self.state()?.shutting_down"));

    let preview_start = source
        .find("pub(crate) fn with_preview_presentation_epoch")
        .expect("Preview presentation source");
    let preview_end = source[preview_start..]
        .find("fn hide_active_login_for_preview")
        .map(|offset| preview_start + offset)
        .expect("Preview presentation source end");
    let preview = &source[preview_start..preview_end];
    assert!(preview.contains("let _operation = self.mutation_operation()?;"));
    assert!(!preview.contains("destructive_operation"));

    let shutdown_start = source
        .find("pub(crate) fn begin_shutdown")
        .expect("shutdown source");
    let shutdown_end = source[shutdown_start..]
        .find("pub(crate) fn with_preview_surface_slot")
        .map(|offset| shutdown_start + offset)
        .expect("shutdown source end");
    assert!(source[shutdown_start..shutdown_end]
        .contains("let _destructive = self.destructive_operation()?;"));
}

#[cfg(any(target_os = "macos", windows))]
#[test]
fn recovery_projection_is_profile_scoped_and_retained_states_survive_acknowledgement() {
    let profile_a = EmbeddedProfileIdentity::from_recovery_record(
        "profile-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
        "workspace-a".to_string(),
    );
    let profile_b = EmbeddedProfileIdentity::from_recovery_record(
        "profile-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_string(),
        "workspace-b".to_string(),
    );
    let mut registry = EmbeddedRecoveryRegistry::from_records(vec![
        recovery_record(
            "profile-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "workspace-a",
            EmbeddedOwnerRecoveryDisposition::RetainedProfileLock,
        ),
        recovery_record(
            "profile-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "workspace-a",
            EmbeddedOwnerRecoveryDisposition::RecoveredRuntimeOwned,
        ),
        recovery_record(
            "profile-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "workspace-b",
            EmbeddedOwnerRecoveryDisposition::RemovedFinishedRecord,
        ),
    ]);

    assert_eq!(
        registry
            .states_for(&profile_a)
            .into_iter()
            .map(EmbeddedOwnerRecoveryDisposition::as_str)
            .collect::<Vec<_>>(),
        vec!["recovered_runtime_owned", "retained_profile_lock"]
    );
    assert_eq!(
        registry
            .states_for(&profile_b)
            .into_iter()
            .map(EmbeddedOwnerRecoveryDisposition::as_str)
            .collect::<Vec<_>>(),
        vec!["removed_finished_record"]
    );

    registry.acknowledge_successful_acquire(&profile_a);
    registry.acknowledge_successful_acquire(&profile_b);
    assert_eq!(
        registry.states_for(&profile_a),
        vec![EmbeddedOwnerRecoveryDisposition::RetainedProfileLock]
    );
    assert!(registry.states_for(&profile_b).is_empty());
}

#[cfg(any(target_os = "macos", windows))]
#[test]
fn recovery_error_exposes_only_stable_states() {
    let message = recovery_aware_error(
        "The Login Browser profile is already in use.",
        &[
            EmbeddedOwnerRecoveryDisposition::RetainedLiveHost,
            EmbeddedOwnerRecoveryDisposition::RetainedProfileLock,
        ],
    );
    assert_eq!(
        message,
        "Login Browser startup recovery states: retained_live_host,retained_profile_lock. The Login Browser profile is already in use."
    );
    for forbidden in ["embedded-owner-", "login-internal", "/Users/", "pid="] {
        assert!(!message.contains(forbidden));
    }
}

#[test]
fn embedded_profile_handshake_precedes_native_surface_open() {
    let source = include_str!("../surface_commands.rs");
    let acquire = source
        .split_once("fn acquire_login(")
        .expect("acquire_login source")
        .1;
    let prepare = acquire
        .find(".prepare_embedded_profile_for_registration(")
        .expect("two-phase embedded preparation");
    let native_open = acquire
        .find("cef_host.open_surface(")
        .expect("native CEF open");
    let runtime = acquire
        .find("prepare_launched_runtime_with_profile_group(")
        .expect("profile-group-owned session runtime");

    assert!(prepare < native_open);
    assert!(native_open < runtime);
    assert!(!acquire[..native_open].contains(".prepare_profile("));
    assert!(!acquire[..native_open].contains("begin_native_open"));
}

#[test]
fn acquire_keeps_cef_hidden_until_the_current_frontend_lease_syncs_visibility() {
    let source = include_str!("../surface_commands.rs");
    let acquire_start = source.find("fn acquire_login(").expect("acquire source");
    let acquire_end = source[acquire_start..]
        .find("fn start_state_watcher(")
        .map(|offset| acquire_start + offset)
        .expect("acquire source end");
    let acquire = &source[acquire_start..acquire_end];
    assert!(acquire.contains("visible: false"));
    assert!(!acquire.contains("set_surface_visible"));
    assert!(!acquire.contains("hide_active_before_activation"));
    assert!(!acquire.contains("preview.hide_all"));
    assert!(!acquire.contains("focus_surface"));

    let existing = acquire
        .split_once("if let Some(existing)")
        .expect("retained instance acquire")
        .1
        .split_once("let mut coordinator")
        .expect("new instance acquire")
        .0;
    assert!(!existing.contains("cef_host.open_surface("));
    assert!(!existing.contains("hide_active_before_activation"));

    let new_instance = acquire
        .split_once("let mut coordinator")
        .expect("new instance acquire")
        .1;
    assert!(!new_instance.contains("instances.activate(&panel_session_id)"));

    let sync_start = source.find("fn sync(").expect("sync source");
    let sync_end = source[sync_start..]
        .find("fn release(")
        .map(|offset| sync_start + offset)
        .expect("sync source end");
    let sync = &source[sync_start..sync_end];
    assert!(sync.contains("set_surface_visible"));
    assert!(!sync.contains("occlude_surface"));
    assert!(!sync.contains("focus_surface"));
}

#[test]
fn trusted_overlay_occlusion_pauses_effects_before_capturing_native_focus_and_hiding() {
    let source = include_str!("../surface_commands.rs");
    let control_start = source
        .find("fn transition_control(")
        .expect("control source");
    let control_end = source[control_start..]
        .find("fn close_popup(")
        .map(|offset| control_start + offset)
        .expect("control source end");
    let control = &source[control_start..control_end];
    let occlude = control
        .split_once("BrowserSurfaceControlActionArg::Occlude =>")
        .expect("occlude branch")
        .1;
    let pause = occlude
        .find("pause_agent_if_active")
        .expect("effect cleanup acknowledgement");
    let native_occlude = occlude
        .find("occlude_surface")
        .expect("native focus capture and hide");

    assert!(pause < native_occlude);
    assert!(!occlude[..native_occlude].contains("set_surface_visible"));
}

#[test]
fn runtime_actor_is_revalidated_around_handoff_and_rolled_back_before_publish() {
    let source = include_str!("../surface_commands.rs");
    let control_start = source
        .find("fn transition_control(")
        .expect("control source");
    let control_end = source[control_start..]
        .find("fn close_popup(")
        .map(|offset| control_start + offset)
        .expect("control source end");
    let control = &source[control_start..control_end];
    let handoff = control
        .split_once("BrowserSurfaceControlActionArg::Handoff =>")
        .expect("handoff branch")
        .1
        .split_once("BrowserSurfaceControlActionArg::Pause =>")
        .expect("handoff branch end")
        .0;

    let first_validation = handoff
        .find("validate_actor(agent_actor_id)?")
        .expect("pre-commit actor validation");
    let commit = handoff
        .find("handoff_to_agent_for_actor")
        .expect("Agent handoff commit");
    let post_validation = handoff[commit..]
        .find("validate_actor(agent_actor_id)")
        .map(|offset| commit + offset)
        .expect("post-commit actor validation");
    let rollback = handoff[post_validation..]
        .find("pause_agent_if_active")
        .map(|offset| post_validation + offset)
        .expect("stale Agent rollback");
    let snapshot = handoff
        .rfind(".snapshot(&active.session)")
        .expect("published session snapshot");

    assert!(first_validation < commit);
    assert!(commit < post_validation);
    assert!(post_validation < rollback);
    assert!(rollback < snapshot);
}

#[test]
fn unavailable_surface_manager_retains_a_bounded_mode2_reason() {
    let manager = LoginBrowserSurfaceManager::unavailable("fixture unavailable");
    assert_eq!(
        manager
            .state()
            .expect("surface state")
            .unavailable_reason
            .as_deref(),
        Some("fixture unavailable")
    );
}

#[test]
fn superseded_and_released_watchers_are_fenced_without_mutation() {
    let mut coordinator = BrowserSurfaceCoordinator::new();
    let first = coordinator
        .acquire(BrowserSurfaceBackend::Login, 1)
        .expect("first lease")
        .current;
    assert!(
        current_watcher_lease(&coordinator, &first.lease.lease_id, first.lease.generation)
            .is_some()
    );

    let second = coordinator
        .acquire(BrowserSurfaceBackend::Login, 2)
        .expect("second lease")
        .current;
    assert!(
        current_watcher_lease(&coordinator, &first.lease.lease_id, first.lease.generation)
            .is_none()
    );
    assert!(current_watcher_lease(
        &coordinator,
        &second.lease.lease_id,
        second.lease.generation,
    )
    .is_some());

    assert!(matches!(
        coordinator.release(
            &second.lease.lease_id,
            second.lease.generation,
            3,
            BrowserSurfaceReleaseDisposition::Close,
        ),
        BrowserSurfaceApplyOutcome::Applied(_)
    ));
    assert!(current_watcher_lease(
        &coordinator,
        &second.lease.lease_id,
        second.lease.generation,
    )
    .is_none());
}

#[test]
fn retained_panel_registry_switches_a_to_b_to_a_without_removing_a() {
    let mut instances = BrowserSurfaceInstanceRegistry::default();
    instances.insert("panel-a".to_string(), "surface-a");
    instances.insert("panel-b".to_string(), "surface-b");

    instances.activate("panel-a");
    assert_eq!(instances.active_panel_session_id(), Some("panel-a"));
    instances.activate("panel-b");
    assert_eq!(instances.active_panel_session_id(), Some("panel-b"));
    instances.activate("panel-a");

    assert_eq!(instances.active_panel_session_id(), Some("panel-a"));
    assert_eq!(instances.get("panel-a"), Some(&"surface-a"));
    assert_eq!(instances.get("panel-b"), Some(&"surface-b"));

    // A status hide releases only visible ownership; the retained physical instance stays
    // registered until a later `sync(visible: true)` activates it again.
    assert!(instances.deactivate("panel-a"));
    assert_eq!(instances.active_panel_session_id(), None);
    assert_eq!(instances.get("panel-a"), Some(&"surface-a"));
}

#[test]
fn retained_reacquire_preflight_happens_before_lease_rotation() {
    let source = include_str!("../surface_commands.rs");
    let acquire_start = source.find("fn acquire_login(").expect("acquire source");
    let acquire_end = source[acquire_start..]
        .find("let mut coordinator")
        .map(|offset| acquire_start + offset)
        .expect("new-instance boundary");
    let retained = &source[acquire_start..acquire_end];
    let snapshot = retained
        .find("existing.native_state.snapshot()")
        .expect("thread-safe native preflight");
    let operation = retained
        .find("let _operation = self.operation()?;")
        .expect("short lease-rotation lane");
    let rotate = retained
        .find(".acquire(BrowserSurfaceBackend::Login, client_revision)")
        .expect("lease rotation");

    assert!(snapshot < operation);
    assert!(operation < rotate);
    assert!(!retained.contains("cef_host.surface_snapshot"));
}

#[test]
fn new_surface_open_failure_rolls_back_its_profile_group_member_before_native_open() {
    let source = include_str!("../surface_commands.rs");
    let attach = source
        .find(".attach_surface(&surface_id)")
        .expect("profile-group attach");
    let native_open = source[attach..]
        .find("cef_host.open_surface(")
        .map(|offset| attach + offset)
        .expect("native CEF open");
    let rollback = source[native_open..]
        .find("abort_surface_before_native_open(&surface_id)")
        .map(|offset| native_open + offset)
        .expect("profile-group rollback");

    assert!(attach < native_open);
    assert!(native_open < rollback);
}

#[test]
fn cross_backend_presentation_epoch_rejects_stale_preview_after_login_to_preview_to_login() {
    let mut epoch = PresentationEpoch::default();
    let mut instances = BrowserSurfaceInstanceRegistry::default();
    instances.insert("panel-a".to_string(), "surface-a");

    // Login A is initially visible. Preview B accepts one epoch for both old-hide and new-show.
    assert!(epoch.accepts_login_visibility(1, "panel-a", true));
    instances.activate("panel-a");
    assert!(epoch.accepts_login_visibility(2, "panel-a", false));
    assert!(instances.deactivate("panel-a"));
    assert!(epoch.accepts_preview_visibility(2, "preview-b", true));
    assert!(epoch.allows_preview_show("preview-b"));

    // A newer Login A activation wins even when Preview B's old queued show reaches later.
    assert!(epoch.accepts_login_visibility(3, "panel-a", true));
    instances.activate("panel-a");
    assert!(!epoch.accepts_preview_visibility(2, "preview-b", true));
    assert!(!epoch.allows_preview_show("preview-b"));
    assert_eq!(instances.active_panel_session_id(), Some("panel-a"));
    assert_eq!(instances.get("panel-a"), Some(&"surface-a"));
}

#[test]
fn queued_preview_navigation_cannot_hide_a_login_owner_selected_by_a_newer_epoch() {
    let surface = include_str!("../surface_commands.rs");
    let preview_gate_start = surface
        .find("pub(crate) fn with_preview_surface_slot")
        .expect("preview slot gate");
    let preview_gate_end = surface[preview_gate_start..]
        .find("pub(crate) fn with_preview_presentation_epoch")
        .map(|offset| preview_gate_start + offset)
        .expect("preview epoch gate");
    let preview_gate = &surface[preview_gate_start..preview_gate_end];
    assert!(preview_gate.contains("allows_preview_show(preview_session_id)"));
    assert!(preview_gate.contains("Preview Browser show is stale"));

    let browser = include_str!("../../../browser.rs");
    let navigate_start = browser.find("pub fn navigate(").expect("preview navigate");
    let navigate = &browser[navigate_start..];
    assert!(navigate.contains("with_preview_surface_slot(app, &session_id"));
}

#[test]
fn stale_client_revision_cannot_advance_the_global_presentation_epoch() {
    let mut coordinator = BrowserSurfaceCoordinator::new();
    let acquired = coordinator
        .acquire(BrowserSurfaceBackend::Login, 1)
        .expect("first lease")
        .current;
    let epoch = PresentationEpoch::default();
    let stale = coordinator.sync(
        &acquired.lease.lease_id,
        acquired.lease.generation,
        acquired.last_applied_revision,
    );
    assert!(matches!(stale, BrowserSurfaceApplyOutcome::Noop));
    assert_eq!(epoch.last_applied, 0);

    let source = include_str!("../surface_commands.rs");
    let sync_start = source.find("fn sync(").expect("sync source");
    let sync_end = source[sync_start..]
        .find("fn release(")
        .map(|offset| sync_start + offset)
        .expect("sync source end");
    let sync = &source[sync_start..sync_end];
    let coordinator_sync = sync
        .find("self.apply_instance_revision")
        .expect("coordinator revision fence");
    let epoch_accept = sync
        .find("accepts_login_visibility")
        .expect("presentation epoch fence");
    assert!(coordinator_sync < epoch_accept);
}

#[test]
fn per_instance_change_is_not_acknowledged_until_its_own_lease_event_is_published() {
    let source = include_str!("../surface_commands.rs");
    let watcher_start = source
        .find("fn run_state_watcher(")
        .expect("watcher source");
    let watcher_end = source[watcher_start..]
        .find("fn converge_terminal_watcher_locked(")
        .map(|offset| watcher_start + offset)
        .expect("watcher source end");
    let watcher = &source[watcher_start..watcher_end];
    let publish_gate = watcher
        .rfind("if let Some(current) = self.current_watcher_snapshot")
        .expect("visible-owner publish gate");
    let advance = watcher[publish_gate..]
        .find("last_emitted = response;")
        .map(|offset| publish_gate + offset)
        .expect("advance only after publish");

    assert!(advance > publish_gate);
    assert!(!watcher[..publish_gate].contains("last_emitted = response;"));
}

#[test]
fn inactive_instance_terminal_cleanup_state_is_published_on_its_own_current_lease() {
    let source = include_str!("../surface_commands.rs");
    let watcher_snapshot_start = source
        .find("fn current_watcher_snapshot(")
        .expect("watcher snapshot source");
    let watcher_snapshot_end = source[watcher_snapshot_start..]
        .find("fn sync(")
        .map(|offset| watcher_snapshot_start + offset)
        .expect("watcher snapshot source end");
    let watcher_snapshot = &source[watcher_snapshot_start..watcher_snapshot_end];
    assert!(!watcher_snapshot.contains("active_panel_session_id"));

    let watcher_start = source
        .find("fn run_state_watcher(")
        .expect("watcher source");
    let watcher_end = source[watcher_start..]
        .find("fn converge_terminal_watcher_locked(")
        .map(|offset| watcher_start + offset)
        .expect("watcher source end");
    let watcher = &source[watcher_start..watcher_end];
    let cleanup = watcher
        .find("native_close_cleanup_required")
        .expect("terminal cleanup event");
    let current = watcher[..cleanup]
        .rfind("self.current_watcher_snapshot")
        .expect("per-instance watcher lease");
    assert!(current < cleanup);
}

#[test]
fn acquire_response_carries_a_stable_physical_surface_id_separate_from_its_lease() {
    let response = BrowserSurfaceLeaseResponse {
        lease_id: "presentation-lease-b".to_string(),
        generation: 2,
        surface_id: Some("login-1-presentation-lease-a".to_string()),
        client_revision: 3,
        server_sequence: 4,
        backend: "login",
        profile_id: Some("profile-a".to_string()),
        snapshot: None,
    };
    let json = serde_json::to_value(response).expect("serialize acquire response");
    assert_eq!(json["lease_id"], "presentation-lease-b");
    assert_eq!(json["surface_id"], "login-1-presentation-lease-a");
}

#[test]
fn watcher_reloads_authoritative_state_inside_the_command_operation_lane() {
    let source = include_str!("../surface_commands.rs");
    let watcher_start = source
        .find("fn run_state_watcher(")
        .expect("watcher source");
    let watcher_end = source[watcher_start..]
        .find("fn converge_terminal_watcher_locked(")
        .map(|offset| watcher_start + offset)
        .expect("watcher source end");
    let watcher = &source[watcher_start..watcher_end];
    let operation = watcher
        .rfind("let _operation = match self.operation()")
        .expect("operation lane before non-terminal publish");
    let fresh_native = watcher[operation..]
        .find("native = native_state.snapshot()")
        .map(|offset| operation + offset)
        .expect("fresh native snapshot");
    let recovery_fence = watcher[fresh_native..]
        .find("pause_for_renderer_recovery(")
        .map(|offset| fresh_native + offset)
        .expect("renderer recovery control fence");
    let fresh_response = watcher[recovery_fence..]
        .find("let response = snapshot_response(")
        .map(|offset| recovery_fence + offset)
        .expect("post-fence snapshot");
    let publish = watcher[fresh_response..]
        .find("self.emit_surface_state(")
        .map(|offset| fresh_response + offset)
        .expect("sequenced publish");

    assert!(operation < fresh_native);
    assert!(fresh_native < recovery_fence);
    assert!(recovery_fence < fresh_response);
    assert!(fresh_response < publish);
    assert!(!watcher[operation..publish].contains("force_stop"));
}
