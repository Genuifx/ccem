use super::cef::lifecycle::{CefHostStateMachine, CefHostStatus};

#[cfg(target_os = "macos")]
#[test]
fn unavailable_cef_host_is_a_bounded_mode2_failure_not_an_app_startup_panic() {
    let host = super::cef::host::CefHostController::unavailable("fixture unavailable");
    assert_eq!(host.status(), CefHostStatus::Uninitialized);
    assert_eq!(host.last_error().as_deref(), Some("fixture unavailable"));
}

#[test]
fn cef_host_state_rejects_stale_initialization_and_never_retries_a_failed_process() {
    let mut state = CefHostStateMachine::new();
    assert_eq!(state.status(), CefHostStatus::Uninitialized);
    assert!(!state.can_create_surface());

    let first = state.begin_initialization().expect("start initialization");
    assert_eq!(state.status(), CefHostStatus::Initializing);
    assert_eq!(
        state.mark_ready(first + 1).expect_err("stale completion"),
        "stale_generation"
    );
    state.mark_failed(first).expect("record failed attempt");
    assert_eq!(state.status(), CefHostStatus::Failed);
    assert_eq!(
        state
            .begin_initialization()
            .expect_err("a failed CEF process is terminal"),
        "terminal_state"
    );

    let mut ready = CefHostStateMachine::new();
    let generation = ready.begin_initialization().expect("start ready host");
    ready
        .mark_ready(generation)
        .expect("ready current generation");
    assert_eq!(ready.status(), CefHostStatus::Ready);
    assert!(ready.can_create_surface());

    ready.begin_shutdown().expect("begin shutdown");
    assert_eq!(ready.status(), CefHostStatus::ShuttingDown);
    assert!(!ready.can_create_surface());
    ready.mark_shutdown().expect("finish shutdown");
    assert_eq!(ready.status(), CefHostStatus::Shutdown);
    assert_eq!(
        ready
            .begin_initialization()
            .expect_err("shutdown is terminal"),
        "terminal_state"
    );
}

#[test]
fn cef_host_shutdown_is_valid_before_or_during_initialization() {
    let mut never_started = CefHostStateMachine::new();
    never_started.begin_shutdown().expect("shutdown cold host");
    assert_eq!(never_started.status(), CefHostStatus::Shutdown);

    let mut initializing = CefHostStateMachine::new();
    let generation = initializing
        .begin_initialization()
        .expect("start initialization");
    initializing.begin_shutdown().expect("cancel startup");
    assert_eq!(initializing.status(), CefHostStatus::ShuttingDown);
    assert_eq!(
        initializing
            .mark_ready(generation)
            .expect_err("late readiness must not resurrect host"),
        "invalid_transition"
    );
    initializing.mark_shutdown().expect("finish shutdown");
}
