use super::*;
use crate::browser::surface_coordinator::BrowserSurfaceReleaseDisposition;

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
    assert!(!sync.contains("focus_surface"));
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
    let publish = watcher[fresh_native..]
        .find("self.emit_surface_state(")
        .map(|offset| fresh_native + offset)
        .expect("sequenced publish");

    assert!(operation < fresh_native);
    assert!(fresh_native < publish);
}
