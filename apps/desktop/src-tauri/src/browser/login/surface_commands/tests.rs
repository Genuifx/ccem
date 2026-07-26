use super::*;
use crate::browser::surface_coordinator::BrowserSurfaceReleaseDisposition;

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
        .find(".prepare_embedded_profile(")
        .expect("two-phase embedded preparation");
    let native_open = acquire
        .find("cef_host.open_surface(")
        .expect("native CEF open");
    let runtime = acquire
        .find("prepare_launched_runtime_with_owner_record(")
        .expect("record-owned session runtime");

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
    assert!(!acquire.contains("focus_surface"));

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
