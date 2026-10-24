use super::*;

const RT: &str = "steer-coordinator";
const INC: u64 = 17;
const GEN: u64 = 4;
const ROOT: &str = "root-command";

fn running_coordinator(capabilities: &[&str]) -> NativeSessionCoordinator {
    let coordinator = NativeSessionCoordinator::new();
    coordinator.note_incarnation(RT, INC);
    let capabilities = capabilities
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>();
    assert_eq!(
        coordinator.note_session_meta(
            RT,
            INC,
            Some("conversation"),
            Some(&capabilities),
            Some(GEN)
        ),
        LifecycleDecision::Updated
    );
    coordinator.admit_prompt_with_id(RT, INC, ROOT).unwrap();
    coordinator.note_command_admitted(RT, INC, ROOT, GEN);
    coordinator.note_sdk_command_state(RT, INC, ROOT, "started", GEN);
    coordinator
}

fn steer_coordinator() -> NativeSessionCoordinator {
    running_coordinator(&[MSG_LIFECYCLE_CAPABILITY, "ccem_steer_v1"])
}

fn assert_root_owned(coordinator: &NativeSessionCoordinator) {
    let projection = coordinator.projection(RT).unwrap();
    assert_eq!(projection.active_command_id.as_deref(), Some(ROOT));
    assert_eq!(projection.active_phase.as_deref(), Some("sdk_started"));
    assert!(projection.protocol_error.is_none());
}

#[test]
fn steer_admission_keeps_foreground_and_result_owned_by_root() {
    let coordinator = steer_coordinator();
    let fence = coordinator
        .reserve_steer(RT, INC, ROOT, "steer-one")
        .unwrap();
    assert_eq!(fence.command_id, "steer-one");
    assert_eq!(fence.parent_command_id, ROOT);
    assert_eq!(fence.helper_incarnation, INC);
    assert_eq!(fence.query_generation, GEN);
    assert_root_owned(&coordinator);

    // A concurrent ordinary send still cannot become a second foreground.
    assert_eq!(
        coordinator.admit_prompt_with_id(RT, INC, "ordinary-send"),
        Err(AdmissionError::Busy {
            active_command_id: ROOT.into()
        })
    );
    assert_eq!(
        coordinator.note_steer_receipt(RT, INC, "steer-one", GEN, true),
        LifecycleDecision::Updated
    );
    assert_eq!(
        coordinator.wait_for_steer(RT, "steer-one", Duration::ZERO),
        SteerState::Accepted
    );
    assert_root_owned(&coordinator);

    // The injected child has no result/terminal that can release its parent.
    assert_eq!(
        coordinator.note_result_observed(RT, INC, "steer-one", GEN),
        LifecycleDecision::Ignored
    );
    assert_eq!(
        coordinator.note_sdk_command_state(RT, INC, "steer-one", "completed", GEN),
        LifecycleDecision::Ignored
    );
    assert_root_owned(&coordinator);
    assert_eq!(
        coordinator.note_result_observed(RT, INC, ROOT, GEN),
        LifecycleDecision::Updated
    );
    assert_eq!(
        coordinator
            .projection(RT)
            .unwrap()
            .active_command_id
            .as_deref(),
        Some(ROOT)
    );
    assert_eq!(
        coordinator.note_sdk_command_state(RT, INC, ROOT, "completed", GEN),
        LifecycleDecision::Released {
            command_id: ROOT.into()
        }
    );
    coordinator
        .admit_prompt(RT, INC)
        .expect("the next real turn can start");
}

#[test]
fn steer_receipts_require_exact_command_generation_and_incarnation() {
    let coordinator = steer_coordinator();
    coordinator
        .reserve_steer(RT, INC, ROOT, "steer-one")
        .unwrap();
    for (incarnation, command, generation) in [
        (INC + 1, "steer-one", GEN),
        (INC, "old-steer", GEN),
        (INC, "steer-one", GEN - 1),
        (INC, "steer-one", GEN + 1),
    ] {
        assert_eq!(
            coordinator.note_steer_receipt(RT, incarnation, command, generation, true),
            LifecycleDecision::Ignored
        );
    }
    assert_eq!(
        coordinator
            .reserve_steer(RT, INC, ROOT, "steer-two")
            .unwrap_err(),
        "unchanged"
    );
    assert_root_owned(&coordinator);
    assert_eq!(
        coordinator.note_steer_receipt(RT, INC, "steer-one", GEN, true),
        LifecycleDecision::Updated
    );
    for accepted in [true, false] {
        assert_eq!(
            coordinator.note_steer_receipt(RT, INC, "steer-one", GEN, accepted),
            LifecycleDecision::Ignored,
            "a duplicate or contradictory receipt cannot change the settled outcome"
        );
    }
    // Keep the first receipt until its caller has observed it.
    assert_eq!(
        coordinator
            .reserve_steer(RT, INC, ROOT, "steer-two")
            .unwrap_err(),
        "unchanged"
    );
    assert_eq!(
        coordinator.wait_for_steer(RT, "steer-one", Duration::ZERO),
        SteerState::Accepted
    );
    coordinator
        .reserve_steer(RT, INC, ROOT, "steer-two")
        .unwrap();
    assert_eq!(
        coordinator.note_steer_receipt(RT, INC, "steer-one", GEN, false),
        LifecycleDecision::Ignored,
        "a previous attempt cannot reject the new pending steer"
    );
    assert_root_owned(&coordinator);
}

#[test]
fn steer_timeout_blocks_replay_until_exact_late_receipt_recovers() {
    let coordinator = steer_coordinator();
    coordinator
        .reserve_steer(RT, INC, ROOT, "steer-one")
        .unwrap();
    assert_eq!(
        coordinator.wait_for_steer(RT, "steer-one", Duration::ZERO),
        SteerState::Uncertain
    );
    assert_eq!(
        coordinator
            .reserve_steer(RT, INC, ROOT, "steer-retry")
            .unwrap_err(),
        "unchanged"
    );
    assert_root_owned(&coordinator);
    assert_eq!(
        coordinator.note_steer_receipt(RT, INC, "steer-one", GEN, true),
        LifecycleDecision::Updated
    );
    assert_eq!(
        coordinator.wait_for_steer(RT, "steer-one", Duration::ZERO),
        SteerState::Accepted
    );
    coordinator
        .reserve_steer(RT, INC, ROOT, "steer-two")
        .expect("late ACK restored the steer lane");
}

#[test]
fn steer_missing_capability_or_legacy_adapter_uses_interrupt_fallback() {
    for capabilities in [
        vec![],
        vec![MSG_LIFECYCLE_CAPABILITY],
        vec!["ccem_steer_v1"],
    ] {
        let coordinator = running_coordinator(&capabilities);
        assert_eq!(
            coordinator
                .reserve_steer(RT, INC, ROOT, "steer-one")
                .unwrap_err(),
            "fallback"
        );
        assert_root_owned(&coordinator);
    }
}

#[test]
fn steer_stale_target_never_interrupts_a_different_foreground() {
    let coordinator = steer_coordinator();
    assert_eq!(
        coordinator
            .reserve_steer(RT, INC, "older-root", "steer-one")
            .unwrap_err(),
        "unchanged"
    );
    assert_eq!(
        coordinator
            .reserve_steer(RT, INC + 1, ROOT, "steer-one")
            .unwrap_err(),
        "unchanged"
    );
    assert_root_owned(&coordinator);
    coordinator
        .reserve_steer(RT, INC, ROOT, "steer-one")
        .expect("stale attempts did not reserve the lane");
}

#[test]
fn steer_pending_settings_and_unstarted_commands_use_fallback() {
    for permission_only in [false, true] {
        let coordinator = steer_coordinator();
        if permission_only {
            coordinator
                .begin_permission_settings_op(RT, INC, "settings")
                .unwrap();
        } else {
            coordinator.begin_settings_op(RT, INC, "settings").unwrap();
        }
        assert_eq!(
            coordinator
                .reserve_steer(RT, INC, ROOT, "steer-one")
                .unwrap_err(),
            "fallback"
        );
        assert_root_owned(&coordinator);
    }
    let coordinator = NativeSessionCoordinator::new();
    coordinator.note_incarnation(RT, INC);
    coordinator.note_session_meta(
        RT,
        INC,
        None,
        Some(&[MSG_LIFECYCLE_CAPABILITY.into(), "ccem_steer_v1".into()]),
        Some(GEN),
    );
    coordinator.admit_prompt_with_id(RT, INC, ROOT).unwrap();
    assert_eq!(
        coordinator
            .reserve_steer(RT, INC, ROOT, "steer-one")
            .unwrap_err(),
        "fallback"
    );
}

#[test]
fn steer_rejected_after_root_terminal_does_not_target_the_next_turn() {
    let coordinator = steer_coordinator();
    let fence = coordinator
        .reserve_steer(RT, INC, ROOT, "steer-one")
        .unwrap();
    coordinator.note_sdk_command_state(RT, INC, ROOT, "completed", GEN);
    coordinator
        .admit_prompt_with_id(RT, INC, "next-root")
        .unwrap();
    coordinator.note_command_admitted(RT, INC, "next-root", GEN);
    coordinator.note_sdk_command_state(RT, INC, "next-root", "started", GEN);
    assert_eq!(
        coordinator.note_steer_receipt(RT, INC, "steer-one", GEN, false),
        LifecycleDecision::Updated
    );
    assert_eq!(
        coordinator.wait_for_steer(RT, "steer-one", Duration::ZERO),
        SteerState::Rejected
    );
    assert!(!coordinator.steer_parent_is_active(RT, &fence));
    assert_eq!(
        coordinator
            .projection(RT)
            .unwrap()
            .active_command_id
            .as_deref(),
        Some("next-root")
    );
}

#[test]
fn steer_receipt_from_a_retired_helper_cannot_settle_old_delivery() {
    let coordinator = steer_coordinator();
    coordinator
        .reserve_steer(RT, INC, ROOT, "steer-one")
        .unwrap();
    coordinator.note_generation_retired(RT, INC);
    coordinator.note_incarnation(RT, INC + 1);
    assert_eq!(
        coordinator.note_steer_receipt(RT, INC, "steer-one", GEN, true),
        LifecycleDecision::Ignored
    );
    assert_eq!(
        coordinator.wait_for_steer(RT, "steer-one", Duration::ZERO),
        SteerState::Uncertain
    );
}

#[test]
fn steer_retired_receipt_lane_reopens_only_after_original_waiter_finishes() {
    for waiter_finished_before_retirement in [false, true] {
        let coordinator = steer_coordinator();
        coordinator
            .reserve_steer(RT, INC, ROOT, "old-steer")
            .unwrap();
        if waiter_finished_before_retirement {
            assert_eq!(
                coordinator.wait_for_steer(RT, "old-steer", Duration::ZERO),
                SteerState::Uncertain
            );
            assert_eq!(
                coordinator
                    .reserve_steer(RT, INC, ROOT, "same-helper-retry")
                    .unwrap_err(),
                "unchanged"
            );
        }
        coordinator.note_generation_retired(RT, INC);
        assert_eq!(
            coordinator.abandon_retired_command(RT, ROOT),
            LifecycleDecision::Released {
                command_id: ROOT.into()
            }
        );
        coordinator.note_incarnation(RT, INC + 1);
        coordinator.note_session_meta(
            RT,
            INC + 1,
            None,
            Some(&[MSG_LIFECYCLE_CAPABILITY.into(), "ccem_steer_v1".into()]),
            Some(1),
        );
        coordinator
            .admit_prompt_with_id(RT, INC + 1, "new-root")
            .unwrap();
        coordinator.note_command_admitted(RT, INC + 1, "new-root", 1);
        coordinator.note_sdk_command_state(RT, INC + 1, "new-root", "started", 1);
        if !waiter_finished_before_retirement {
            assert_eq!(
                coordinator
                    .reserve_steer(RT, INC + 1, "new-root", "new-steer")
                    .unwrap_err(),
                "unchanged"
            );
            assert_eq!(
                coordinator.wait_for_steer(RT, "old-steer", Duration::ZERO),
                SteerState::Uncertain
            );
        }
        let fence = coordinator
            .reserve_steer(RT, INC + 1, "new-root", "new-steer")
            .expect("retired receipt cannot permanently block new helper");
        assert_eq!(fence.helper_incarnation, INC + 1);
        assert_eq!(fence.query_generation, 1);
        assert_eq!(
            coordinator.note_steer_receipt(RT, INC, "old-steer", GEN, true),
            LifecycleDecision::Ignored
        );
        assert_eq!(
            coordinator.note_steer_receipt(RT, INC + 1, "new-steer", 1, true),
            LifecycleDecision::Updated
        );
        assert_eq!(
            coordinator.wait_for_steer(RT, "new-steer", Duration::ZERO),
            SteerState::Accepted
        );
    }
}
