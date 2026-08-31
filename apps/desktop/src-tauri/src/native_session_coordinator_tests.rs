use super::*;

const RT: &str = "runtime-under-test";
const INC: u64 = 7;
const GEN: u64 = 3;

fn coordinator_with_incarnation() -> NativeSessionCoordinator {
    let coordinator = NativeSessionCoordinator::new();
    coordinator.note_incarnation(RT, INC);
    coordinator
}

fn negotiate_full(coordinator: &NativeSessionCoordinator) {
    assert_eq!(
        coordinator.note_session_meta(
            RT,
            INC,
            Some("conversation-a"),
            Some(&[MSG_LIFECYCLE_CAPABILITY.to_string()]),
            Some(GEN),
        ),
        LifecycleDecision::Updated
    );
}

fn negotiate_legacy(coordinator: &NativeSessionCoordinator) {
    assert_eq!(
        coordinator.note_session_meta(RT, INC, Some("conversation-a"), Some(&[]), Some(GEN),),
        LifecycleDecision::Updated
    );
}

#[test]
fn full_result_is_observation_and_completed_is_the_only_normal_release() {
    let coordinator = coordinator_with_incarnation();
    let command_id = coordinator.admit_prompt(RT, INC).expect("admits");
    coordinator.note_command_admitted(RT, INC, &command_id, GEN);
    coordinator.note_sdk_command_state(RT, INC, &command_id, "queued", GEN);
    negotiate_full(&coordinator);

    assert_eq!(
        coordinator.note_result_observed(RT, INC, &command_id, GEN),
        LifecycleDecision::Updated
    );
    assert_eq!(
        coordinator
            .projection(RT)
            .unwrap()
            .active_command_id
            .as_deref(),
        Some(command_id.as_str()),
        "Result must not release FullLifecycle ownership"
    );
    assert!(matches!(
        coordinator.admit_prompt(RT, INC),
        Err(AdmissionError::Busy { .. })
    ));

    assert_eq!(
        coordinator.note_sdk_command_state(RT, INC, &command_id, "completed", GEN),
        LifecycleDecision::Released {
            command_id: command_id.clone()
        }
    );
    coordinator.admit_prompt(RT, INC).expect("next turn admits");
}

#[test]
fn explicit_legacy_requires_legacy_terminal_after_result() {
    let coordinator = coordinator_with_incarnation();
    negotiate_legacy(&coordinator);
    let command_id = coordinator.admit_prompt(RT, INC).expect("admits");
    coordinator.note_command_admitted(RT, INC, &command_id, GEN);
    coordinator.note_result_observed(RT, INC, &command_id, GEN);
    assert!(coordinator
        .projection(RT)
        .unwrap()
        .active_command_id
        .is_some());
    assert!(matches!(
        coordinator.note_legacy_terminal(RT, INC, &command_id, GEN),
        LifecycleDecision::Released { .. }
    ));
}

#[test]
fn full_adapter_rejects_legacy_terminal_without_releasing() {
    let coordinator = coordinator_with_incarnation();
    negotiate_full(&coordinator);
    let command_id = coordinator.admit_prompt(RT, INC).expect("admits");
    coordinator.note_command_admitted(RT, INC, &command_id, GEN);
    assert!(matches!(
        coordinator.note_legacy_terminal(RT, INC, &command_id, GEN),
        LifecycleDecision::ProtocolError { .. }
    ));
    assert_eq!(
        coordinator
            .projection(RT)
            .unwrap()
            .active_command_id
            .as_deref(),
        Some(command_id.as_str())
    );
}

#[test]
fn all_real_full_terminal_states_release() {
    for state in ["completed", "cancelled", "discarded", "refused"] {
        let runtime_id = format!("{RT}-{state}");
        let coordinator = NativeSessionCoordinator::new();
        coordinator.note_incarnation(&runtime_id, INC);
        coordinator.note_session_meta(
            &runtime_id,
            INC,
            Some("conversation-a"),
            Some(&[MSG_LIFECYCLE_CAPABILITY.to_string()]),
            Some(GEN),
        );
        let command_id = coordinator.admit_prompt(&runtime_id, INC).expect("admits");
        coordinator.note_command_admitted(&runtime_id, INC, &command_id, GEN);
        assert!(matches!(
            coordinator.note_sdk_command_state(&runtime_id, INC, &command_id, state, GEN),
            LifecycleDecision::Released { .. }
        ));
    }
}

#[test]
fn unknown_matching_state_poisons_and_never_releases() {
    let coordinator = coordinator_with_incarnation();
    negotiate_full(&coordinator);
    let command_id = coordinator.admit_prompt(RT, INC).expect("admits");
    coordinator.note_command_admitted(RT, INC, &command_id, GEN);
    assert!(matches!(
        coordinator.note_sdk_command_state(RT, INC, &command_id, "mystery", GEN),
        LifecycleDecision::ProtocolError { .. }
    ));
    assert_eq!(coordinator.projection(RT).unwrap().adapter, "poisoned");
    assert!(matches!(
        coordinator.admit_prompt(RT, INC),
        Err(AdmissionError::ProtocolPoisoned { .. })
    ));
}

#[test]
fn poisoned_adapter_blocks_admission_even_without_an_active_command() {
    let coordinator = coordinator_with_incarnation();
    coordinator.note_protocol_error(RT, INC, None, "broken lifecycle wire");
    assert!(matches!(
        coordinator.admit_prompt(RT, INC),
        Err(AdmissionError::ProtocolPoisoned { .. })
    ));
}

#[test]
fn conversation_reset_before_or_after_terminal_never_releases_twice() {
    let coordinator = coordinator_with_incarnation();
    negotiate_full(&coordinator);
    let first = coordinator.admit_prompt(RT, INC).expect("admits");
    coordinator.note_command_admitted(RT, INC, &first, GEN);
    assert_eq!(
        coordinator.note_sdk_command_state(RT, INC, &first, "conversation_reset", GEN),
        LifecycleDecision::Updated
    );
    assert!(coordinator
        .projection(RT)
        .unwrap()
        .active_command_id
        .is_some());
    coordinator.note_sdk_command_state(RT, INC, &first, "completed", GEN);

    let second = coordinator.admit_prompt(RT, INC).expect("second admits");
    coordinator.note_command_admitted(RT, INC, &second, GEN);
    coordinator.note_sdk_command_state(RT, INC, &second, "completed", GEN);
    assert_eq!(
        coordinator.note_sdk_command_state(RT, INC, &second, "conversation_reset", GEN),
        LifecycleDecision::Updated
    );
    assert!(coordinator
        .projection(RT)
        .unwrap()
        .active_command_id
        .is_none());
}

#[test]
fn generic_error_and_ready_do_not_release_an_active_command() {
    let coordinator = coordinator_with_incarnation();
    let command_id = coordinator.admit_prompt(RT, INC).expect("admits");
    assert_eq!(
        coordinator.note_status_line(RT, GENERIC_READY_STATUS),
        StatusDecision::Suppress
    );
    assert_eq!(
        coordinator.note_status_line(RT, "error"),
        StatusDecision::Apply
    );
    assert_eq!(
        coordinator
            .projection(RT)
            .unwrap()
            .active_command_id
            .as_deref(),
        Some(command_id.as_str())
    );
}

#[test]
fn stale_incarnation_and_generation_cannot_mutate_active() {
    let coordinator = coordinator_with_incarnation();
    let command_id = coordinator.admit_prompt(RT, INC).expect("admits");
    assert_eq!(
        coordinator.note_command_admitted(RT, INC - 1, &command_id, GEN),
        LifecycleDecision::Ignored
    );
    coordinator.note_command_admitted(RT, INC, &command_id, GEN);
    assert!(matches!(
        coordinator.note_sdk_command_state(RT, INC, &command_id, "started", GEN + 1),
        LifecycleDecision::ProtocolError { .. }
    ));
    assert!(coordinator
        .projection(RT)
        .unwrap()
        .active_command_id
        .is_some());
}

#[test]
fn incarnation_change_or_retire_preserves_uncertain_ownership() {
    let coordinator = coordinator_with_incarnation();
    let command_id = coordinator.admit_prompt(RT, INC).expect("admits");
    coordinator.note_generation_retired(RT, INC);
    assert_eq!(
        coordinator
            .projection(RT)
            .unwrap()
            .active_command_id
            .as_deref(),
        Some(command_id.as_str())
    );
    coordinator.note_incarnation(RT, INC + 1);
    assert!(matches!(
        coordinator.admit_prompt(RT, INC + 1),
        Err(AdmissionError::DeliveryUncertain { .. })
    ));
}

#[test]
fn only_exact_prewrite_admission_can_be_abandoned() {
    let coordinator = coordinator_with_incarnation();
    let command_id = coordinator.admit_prompt(RT, INC).expect("admits");
    assert!(!coordinator.abandon_admission(RT, INC, "foreign"));
    coordinator.note_command_admitted(RT, INC, &command_id, GEN);
    assert!(!coordinator.abandon_admission(RT, INC, &command_id));

    let other_runtime = "prewrite-runtime";
    coordinator.note_incarnation(other_runtime, INC);
    let prewrite = coordinator
        .admit_prompt(other_runtime, INC)
        .expect("admits");
    assert!(coordinator.abandon_admission(other_runtime, INC, &prewrite));
}

#[test]
fn missing_helper_admission_ack_expires_to_delivery_uncertain() {
    let coordinator = coordinator_with_incarnation();
    let command_id = coordinator.admit_prompt(RT, INC).expect("admits");
    assert!(!coordinator.expire_dispatching_admission(
        RT,
        INC,
        "foreign",
        0,
        Duration::ZERO,
        "timeout",
    ));
    assert!(coordinator.expire_dispatching_admission(
        RT,
        INC,
        &command_id,
        0,
        Duration::ZERO,
        "helper admission ACK timed out",
    ));
    let projection = coordinator.projection(RT).expect("projection");
    assert_eq!(projection.active_phase.as_deref(), Some("uncertain"));
    assert_eq!(projection.delivery_uncertain_count, 1);
}

#[test]
fn late_receipt_from_a_rejected_attempt_cannot_mutate_the_retry() {
    let coordinator = coordinator_with_incarnation();
    let first = "stable-client:dispatch:1";
    coordinator
        .admit_queued_prompt(RT, INC, first, 1)
        .expect("first attempt admits");
    assert!(matches!(
        coordinator.note_command_rejected(RT, INC, first, GEN),
        LifecycleDecision::Released { .. }
    ));

    let retry = "stable-client:dispatch:2";
    coordinator
        .admit_queued_prompt(RT, INC, retry, 2)
        .expect("retry admits");
    assert_eq!(
        coordinator.note_command_rejected(RT, INC, first, GEN),
        LifecycleDecision::Ignored
    );
    assert_eq!(
        coordinator
            .projection(RT)
            .expect("projection")
            .active_command_id
            .as_deref(),
        Some(retry)
    );
}

#[test]
fn exact_abandon_receipt_releases_an_uncertain_command() {
    let coordinator = coordinator_with_incarnation();
    let command_id = coordinator.admit_prompt(RT, INC).expect("admits");
    coordinator.expire_dispatching_admission(
        RT,
        INC,
        &command_id,
        0,
        Duration::ZERO,
        "admission timeout",
    );
    assert!(matches!(
        coordinator.note_command_abandoned(RT, INC, &command_id, GEN),
        LifecycleDecision::Released { .. }
    ));
    assert!(coordinator
        .projection(RT)
        .expect("projection")
        .active_command_id
        .is_none());
}

#[test]
fn exact_abandon_recovers_an_interrupt_target_mismatch_without_unpoisoning_real_protocol_errors() {
    let coordinator = coordinator_with_incarnation();
    negotiate_full(&coordinator);
    let command_id = coordinator.admit_prompt(RT, INC).expect("admits");
    assert_eq!(
        coordinator.note_interrupt_target_mismatch(
            RT,
            INC,
            &command_id,
            GEN,
            "helper owns a different foreground",
        ),
        LifecycleDecision::Updated
    );
    let mismatched = coordinator.projection(RT).expect("projection");
    assert_eq!(mismatched.adapter, "full_lifecycle");
    assert_eq!(mismatched.active_phase.as_deref(), Some("protocol_error"));
    assert!(matches!(
        coordinator.admit_prompt(RT, INC),
        Err(AdmissionError::DeliveryUncertain { .. })
    ));

    assert!(matches!(
        coordinator.note_command_abandoned(RT, INC, &command_id, GEN),
        LifecycleDecision::Released { .. }
    ));
    let reconciled = coordinator.projection(RT).expect("projection");
    assert_eq!(reconciled.adapter, "full_lifecycle");
    assert!(reconciled.protocol_error.is_none());
    coordinator
        .admit_prompt(RT, INC)
        .expect("exact abandon restores admission");

    let poisoned_runtime = "poisoned-abandon-runtime";
    coordinator.note_incarnation(poisoned_runtime, INC);
    coordinator.note_session_meta(
        poisoned_runtime,
        INC,
        Some("conversation-poisoned"),
        Some(&[MSG_LIFECYCLE_CAPABILITY.to_string()]),
        Some(GEN),
    );
    let poisoned = coordinator
        .admit_prompt(poisoned_runtime, INC)
        .expect("admits before poison");
    coordinator.note_protocol_error(
        poisoned_runtime,
        INC,
        Some(&poisoned),
        "malformed lifecycle wire",
    );
    coordinator.note_command_abandoned(poisoned_runtime, INC, &poisoned, GEN);
    assert!(matches!(
        coordinator.admit_prompt(poisoned_runtime, INC),
        Err(AdmissionError::ProtocolPoisoned { .. })
    ));
}

#[test]
fn exact_user_stop_can_abandon_only_after_the_owned_generation_retires() {
    let coordinator = coordinator_with_incarnation();
    let command_id = coordinator.admit_prompt(RT, INC).expect("admits");
    coordinator.expire_dispatching_admission(
        RT,
        INC,
        &command_id,
        0,
        Duration::ZERO,
        "admission timeout",
    );
    assert_eq!(
        coordinator.abandon_retired_command(RT, &command_id),
        LifecycleDecision::Ignored,
        "a live owning generation must answer for its command"
    );
    coordinator.note_generation_retired(RT, INC);
    assert!(matches!(
        coordinator.abandon_retired_command(RT, &command_id),
        LifecycleDecision::Released { .. }
    ));
    coordinator.note_incarnation(RT, INC + 1);
    coordinator
        .admit_prompt(RT, INC + 1)
        .expect("new generation admits after explicit abandon");
}

#[test]
fn definite_not_started_evidence_releases_only_a_retired_prewrite_admission() {
    let coordinator = coordinator_with_incarnation();
    let command_id = coordinator.admit_prompt(RT, INC).expect("admits");
    assert!(!coordinator.abandon_not_started_after_retirement(RT, INC, &command_id));
    coordinator.note_generation_retired(RT, INC);
    assert!(coordinator.abandon_not_started_after_retirement(RT, INC, &command_id));
    assert!(coordinator
        .projection(RT)
        .expect("projection")
        .active_command_id
        .is_none());
}

#[test]
fn proven_not_started_command_can_be_readmitted_once_on_a_new_incarnation() {
    let coordinator = coordinator_with_incarnation();
    let command_id = "same-wire-command";
    coordinator
        .admit_queued_prompt(RT, INC, command_id, 1)
        .expect("first incarnation admits queue claim");
    coordinator.note_generation_retired(RT, INC);
    assert!(coordinator.abandon_not_started_after_retirement(RT, INC, command_id));

    coordinator.note_incarnation(RT, INC + 1);
    coordinator
        .admit_queued_prompt(RT, INC + 1, command_id, 1)
        .expect("exact non-delivery evidence permits one same-id reconnect write");
    let projection = coordinator.projection(RT).expect("projection");
    assert_eq!(projection.active_command_id.as_deref(), Some(command_id));
    assert_eq!(projection.active_helper_incarnation, Some(INC + 1));
}

#[test]
fn deferred_missing_foreign_and_stale_settings_acks_still_block() {
    let coordinator = coordinator_with_incarnation();
    negotiate_full(&coordinator);
    coordinator
        .begin_settings_op(RT, INC, "req-1")
        .expect("settings op");
    coordinator.note_settings_ack(RT, INC, None, "applied", Some(GEN));
    coordinator.note_settings_ack(RT, INC, Some("foreign"), "applied", Some(GEN));
    coordinator.note_settings_ack(RT, INC - 1, Some("req-1"), "applied", Some(GEN));
    coordinator.note_settings_ack(RT, INC, Some("req-1"), "deferred", Some(GEN));
    assert_eq!(
        coordinator.wait_for_settings_convergence(RT, Duration::from_millis(25)),
        SettingsWaitOutcome::Deferred
    );
    assert!(matches!(
        coordinator.admit_prompt(RT, INC),
        Err(AdmissionError::SettingsPending { .. })
    ));
    coordinator.note_settings_ack(RT, INC, Some("req-1"), "applied", Some(GEN));
    assert_eq!(
        coordinator.wait_for_settings_convergence(RT, Duration::from_millis(25)),
        SettingsWaitOutcome::Converged
    );
    coordinator
        .admit_prompt(RT, INC)
        .expect("applied deferred settings admit");
}

#[test]
fn exact_deferred_settings_receipt_can_advance_generation_without_timing_out() {
    let coordinator = coordinator_with_incarnation();
    negotiate_full(&coordinator);
    coordinator
        .begin_settings_op(RT, INC, "settings-generation")
        .expect("settings op");
    coordinator.note_settings_ack(
        RT,
        INC,
        Some("settings-generation"),
        "deferred",
        Some(GEN + 1),
    );
    assert_eq!(
        coordinator.wait_for_settings_ack(RT, "settings-generation", Duration::from_millis(1),),
        SettingsWaitOutcome::Deferred
    );
    assert!(matches!(
        coordinator.admit_prompt(RT, INC),
        Err(AdmissionError::SettingsPending { .. })
    ));
    coordinator.note_settings_ack(
        RT,
        INC,
        Some("settings-generation"),
        "applied",
        Some(GEN + 1),
    );
    assert_eq!(
        coordinator.wait_for_settings_ack(RT, "settings-generation", Duration::from_millis(1),),
        SettingsWaitOutcome::Converged
    );
}

#[test]
fn live_permission_lane_can_resolve_without_erasing_deferred_general_settings() {
    let coordinator = coordinator_with_incarnation();
    negotiate_full(&coordinator);
    coordinator
        .begin_settings_op(RT, INC, "settings-env")
        .expect("general settings begin");
    coordinator.note_settings_ack(RT, INC, Some("settings-env"), "deferred", Some(GEN));

    coordinator
        .begin_permission_settings_op(RT, INC, "settings-plan-exit")
        .expect("live Plan permission can cross a deferred environment update");
    assert!(coordinator.settings_request_is_current(RT, "settings-env"));
    assert!(coordinator.settings_request_is_current(RT, "settings-plan-exit"));
    assert!(matches!(
        coordinator.admit_prompt(RT, INC),
        Err(AdmissionError::SettingsPending { .. })
    ));

    coordinator.note_settings_ack(RT, INC, Some("settings-plan-exit"), "applied", Some(GEN));
    assert_eq!(
        coordinator.wait_for_settings_ack(RT, "settings-plan-exit", Duration::from_millis(1),),
        SettingsWaitOutcome::Converged
    );
    assert_eq!(
        coordinator.wait_for_settings_convergence(RT, Duration::from_millis(1)),
        SettingsWaitOutcome::Deferred,
        "Plan approval may resolve after its exact permission ACK while the unrelated environment remains deferred"
    );
    assert!(matches!(
        coordinator.admit_prompt(RT, INC),
        Err(AdmissionError::SettingsPending { .. })
    ));

    coordinator.note_settings_ack(RT, INC, Some("settings-env"), "applied", Some(GEN));
    coordinator
        .admit_prompt(RT, INC)
        .expect("FIFO unblocks only after both settings lanes settle");
}

#[test]
fn definite_settings_failure_is_resolved_for_future_prompt_admission() {
    let coordinator = coordinator_with_incarnation();
    negotiate_full(&coordinator);
    coordinator
        .begin_settings_op(RT, INC, "settings-failed")
        .expect("settings begin");
    coordinator.note_settings_ack(RT, INC, Some("settings-failed"), "failed", Some(GEN));
    assert_eq!(
        coordinator.wait_for_settings_ack(RT, "settings-failed", Duration::from_millis(1),),
        SettingsWaitOutcome::Failed
    );
    assert_eq!(
        coordinator.wait_for_settings_convergence(RT, Duration::from_millis(1)),
        SettingsWaitOutcome::Converged
    );
    assert!(!coordinator.projection(RT).unwrap().settings_pending);
    coordinator
        .admit_prompt(RT, INC)
        .expect("a definite rejection cannot strand the next queued prompt");
}

#[test]
fn permission_failure_keeps_fifo_blocked_for_host_quarantine() {
    let coordinator = coordinator_with_incarnation();
    negotiate_full(&coordinator);
    coordinator
        .begin_permission_settings_op(RT, INC, "settings-permission-failed")
        .expect("permission settings begin");

    assert_eq!(
        coordinator.note_settings_ack(
            RT,
            INC,
            Some("settings-permission-failed"),
            "failed",
            Some(GEN - 1),
        ),
        LifecycleDecision::Ignored,
        "a stale generation cannot finalize the permission lane"
    );
    assert_eq!(
        coordinator
            .projection(RT)
            .expect("pending projection")
            .settings_state
            .as_deref(),
        Some("pending")
    );

    assert_eq!(
        coordinator.note_settings_ack(
            RT,
            INC,
            Some("settings-permission-failed"),
            "failed",
            Some(GEN),
        ),
        LifecycleDecision::Updated
    );
    let projection = coordinator.projection(RT).expect("failed projection");
    assert!(projection.settings_pending);
    assert_eq!(
        projection.settings_state.as_deref(),
        Some("reconcile_required")
    );
    assert_eq!(
        coordinator.wait_for_settings_ack(
            RT,
            "settings-permission-failed",
            Duration::from_millis(1),
        ),
        SettingsWaitOutcome::Failed
    );
    assert!(matches!(
        coordinator.admit_prompt(RT, INC),
        Err(AdmissionError::SettingsPending { .. })
    ));
}

#[test]
fn exact_late_settings_failure_resolves_reconcile_required() {
    let coordinator = coordinator_with_incarnation();
    negotiate_full(&coordinator);
    coordinator
        .begin_settings_op(RT, INC, "settings-late-failed")
        .expect("settings begin");
    assert_eq!(
        coordinator.wait_for_settings_convergence(RT, Duration::from_millis(1)),
        SettingsWaitOutcome::Timeout
    );
    assert!(coordinator.projection(RT).unwrap().settings_pending);

    assert_eq!(
        coordinator.note_settings_ack(RT, INC, Some("settings-late-failed"), "failed", Some(GEN),),
        LifecycleDecision::Updated
    );
    assert!(!coordinator.projection(RT).unwrap().settings_pending);
    coordinator
        .admit_prompt(RT, INC)
        .expect("definite late failure unblocks prompt admission");
}

#[test]
fn projection_serializes_snake_case_and_never_payloads() {
    let coordinator = coordinator_with_incarnation();
    let command_id = coordinator.admit_prompt(RT, INC).expect("admits");
    let projection = coordinator.projection(RT).unwrap();
    assert_eq!(
        projection.active_command_id.as_deref(),
        Some(command_id.as_str())
    );
    let value = serde_json::to_value(&projection).expect("serialize");
    assert_eq!(value["active_command_id"], command_id);
    assert!(value.get("activeCommandId").is_none());
    assert!(!value.to_string().contains("prompt"));
}

#[test]
fn initial_prompt_is_a_generation_bound_formal_command() {
    let coordinator = coordinator_with_incarnation();
    let command_id = coordinator
        .register_initial_prompt(RT, INC)
        .expect("initial prompt admits");
    assert_eq!(
        coordinator
            .projection(RT)
            .unwrap()
            .active_command_id
            .as_deref(),
        Some(command_id.as_str())
    );
}

#[test]
fn interactive_ack_requires_exact_operation_tool_generation_and_incarnation() {
    let coordinator = coordinator_with_incarnation();
    negotiate_full(&coordinator);
    assert_eq!(
        coordinator
            .begin_interactive_op(RT, INC, "reply-1", "plan-1")
            .expect("begin"),
        Some(GEN)
    );
    coordinator.note_interactive_ack(RT, INC, Some("foreign"), "plan-1", "applied", Some(GEN));
    coordinator.note_interactive_ack(RT, INC, Some("reply-1"), "plan-1", "applied", Some(GEN + 1));
    assert_eq!(
        coordinator.wait_for_interactive_ack(RT, "reply-1", Duration::from_millis(25)),
        InteractiveWaitOutcome::Timeout
    );
    coordinator.note_interactive_ack(RT, INC, Some("reply-1"), "plan-1", "applied", Some(GEN));
    assert_eq!(
        coordinator.wait_for_interactive_ack(RT, "reply-1", Duration::from_millis(25)),
        InteractiveWaitOutcome::Applied
    );
}

#[test]
fn interactive_generation_mismatch_rejects_immediately_but_foreign_applied_does_not() {
    let coordinator = coordinator_with_incarnation();
    negotiate_full(&coordinator);
    coordinator
        .begin_interactive_op(RT, INC, "reply-mismatch", "plan-1")
        .expect("begin mismatched reply");

    assert_eq!(
        coordinator.note_interactive_ack(
            RT,
            INC,
            Some("reply-mismatch"),
            "plan-1",
            "generation_mismatch",
            Some(GEN + 1),
        ),
        LifecycleDecision::Updated
    );
    assert_eq!(
        coordinator.wait_for_interactive_ack(RT, "reply-mismatch", Duration::from_millis(25),),
        InteractiveWaitOutcome::Rejected
    );
    coordinator
        .begin_interactive_op(RT, INC, "reply-next", "plan-1")
        .expect("a definite mismatch permits retry");
    coordinator.note_interactive_ack(
        RT,
        INC,
        Some("reply-next"),
        "plan-1",
        "applied",
        Some(GEN + 1),
    );
    assert_eq!(
        coordinator.wait_for_interactive_ack(RT, "reply-next", Duration::from_millis(25)),
        InteractiveWaitOutcome::Timeout
    );
}

#[test]
fn unresolved_control_operations_cannot_be_overwritten() {
    let coordinator = coordinator_with_incarnation();
    negotiate_full(&coordinator);

    coordinator
        .begin_settings_op(RT, INC, "settings-1")
        .expect("first settings op begins");
    assert!(matches!(
        coordinator.begin_settings_op(RT, INC, "settings-2"),
        Err(AdmissionError::SettingsPending { .. })
    ));
    coordinator.note_settings_ack(RT, INC, Some("settings-1"), "failed", Some(GEN));
    coordinator
        .begin_settings_op(RT, INC, "settings-2")
        .expect("definitely failed settings op is replaceable");
    coordinator.note_settings_ack(RT, INC, Some("settings-2"), "applied", Some(GEN));

    coordinator
        .begin_interactive_op(RT, INC, "reply-1", "plan-1")
        .expect("first reply begins");
    assert!(matches!(
        coordinator.begin_interactive_op(RT, INC, "reply-2", "plan-1"),
        Err(AdmissionError::InteractivePending { .. })
    ));
    coordinator.note_interactive_ack(RT, INC, Some("reply-1"), "plan-1", "rejected", Some(GEN));
    coordinator
        .begin_interactive_op(RT, INC, "reply-2", "plan-1")
        .expect("definitely rejected reply is replaceable");
}

#[test]
fn control_ack_timeouts_leave_explicit_recovery_paths() {
    let coordinator = coordinator_with_incarnation();
    negotiate_full(&coordinator);

    coordinator
        .begin_settings_op(RT, INC, "settings-timeout")
        .expect("settings begins");
    assert_eq!(
        coordinator.wait_for_settings_convergence(RT, Duration::from_millis(1)),
        SettingsWaitOutcome::Timeout
    );
    let projection = coordinator.projection(RT).expect("projection");
    assert_eq!(
        projection.settings_state.as_deref(),
        Some("reconcile_required")
    );
    coordinator
        .begin_settings_op(RT, INC, "settings-retry")
        .expect("absolute settings retry reconciles an ACK timeout");
    coordinator.note_settings_ack(RT, INC, Some("settings-retry"), "applied", Some(GEN));

    coordinator
        .begin_interactive_op(RT, INC, "reply-timeout", "ask-1")
        .expect("reply begins");
    assert_eq!(
        coordinator.wait_for_interactive_ack(RT, "reply-timeout", Duration::from_millis(1)),
        InteractiveWaitOutcome::Timeout
    );
    coordinator
        .begin_interactive_op(RT, INC, "reply-retry", "ask-1")
        .expect("single-consumer resolver makes retry safe");
}
