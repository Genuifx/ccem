use super::*;
use crate::native_session_coordinator::AdmissionError;

const GEN: u64 = 3;
const ROOT: &str = "running-root";

fn running_manager(runtime_id: &str, capabilities: &[&str]) -> (Arc<NativeRuntimeManager>, u64) {
    let manager = Arc::new(super::super::tests::manager_with_handle(runtime_id));
    let incarnation = manager
        .handles
        .lock()
        .unwrap()
        .get(runtime_id)
        .unwrap()
        .generation;
    manager.lifecycle.note_incarnation(runtime_id, incarnation);
    let capabilities = capabilities
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>();
    manager.lifecycle.note_session_meta(
        runtime_id,
        incarnation,
        None,
        Some(&capabilities),
        Some(GEN),
    );
    manager
        .lifecycle
        .admit_prompt_with_id(runtime_id, incarnation, ROOT)
        .unwrap();
    emit_lifecycle(&manager, runtime_id, "command_admitted", ROOT, GEN, ROOT);
    emit_lifecycle(
        &manager,
        runtime_id,
        "sdk_command_state",
        ROOT,
        GEN,
        "started",
    );
    (manager, incarnation)
}

fn steer_manager(runtime_id: &str) -> (Arc<NativeRuntimeManager>, u64) {
    running_manager(runtime_id, &["msg_lifecycle_v1", "ccem_steer_v1"])
}

fn emit_lifecycle(
    manager: &NativeRuntimeManager,
    runtime_id: &str,
    stage: &str,
    command_id: &str,
    generation: u64,
    detail: &str,
) {
    manager
        .process_helper_stdout(
            runtime_id,
            &serde_json::json!({
                "type": "event",
                "payload": {
                    "type": "lifecycle", "stage": stage, "detail": detail,
                    "command_id": command_id, "query_generation": generation,
                },
            })
            .to_string(),
        )
        .unwrap();
}

fn enqueue(
    manager: &NativeRuntimeManager,
    runtime_id: &str,
    client_id: &str,
    text: &str,
    display_text: Option<&str>,
    merge_fence: Option<&str>,
) {
    manager
        .input_queue
        .enqueue(
            runtime_id,
            FrozenNativeInputBatch::new(
                client_id,
                text,
                display_text.map(str::to_string),
                None,
                None,
            ),
            merge_fence,
        )
        .unwrap();
}

fn prompts(manager: &NativeRuntimeManager, runtime_id: &str) -> Vec<(String, String)> {
    manager
        .replay_events(runtime_id, None)
        .unwrap()
        .events
        .into_iter()
        .filter_map(|event| match event.payload {
            SessionEventPayload::UserPrompt {
                text,
                client_message_id,
                ..
            } => Some((
                client_message_id.expect("queued prompt keeps its client identity"),
                text,
            )),
            _ => None,
        })
        .collect()
}

fn assert_root_owned(manager: &NativeRuntimeManager, runtime_id: &str) {
    let projection = manager.lifecycle.projection(runtime_id).unwrap();
    assert_eq!(projection.active_command_id.as_deref(), Some(ROOT));
    assert_eq!(projection.active_phase.as_deref(), Some("sdk_started"));
    assert!(projection.protocol_error.is_none());
}

#[test]
fn steer_acceptance_projects_each_client_once_and_keeps_root_result_ownership() {
    let runtime_id = "steer-admitted-batch";
    let (manager, incarnation) = steer_manager(runtime_id);
    enqueue(
        &manager,
        runtime_id,
        "client-one",
        "first raw prompt",
        Some("first visible prompt"),
        Some(ROOT),
    );
    enqueue(
        &manager,
        runtime_id,
        "client-two",
        "second raw prompt",
        Some("second visible prompt"),
        Some(ROOT),
    );
    enqueue(
        &manager,
        runtime_id,
        "client-later",
        "later batch",
        None,
        None,
    );
    let mut delivered = None;
    let outcome = manager
        .steer_queued_with(runtime_id, incarnation, ROOT, |command| {
            let command = serde_json::to_value(command).unwrap();
            assert_eq!(command["type"], "steer_prompt");
            assert_eq!(command["expected_command_id"], ROOT);
            assert_eq!(command["expected_query_generation"], GEN);
            assert_eq!(
                command["client_message_ids"],
                serde_json::json!(["client-one", "client-two"])
            );
            let text = command["text"].as_str().unwrap();
            assert!(
                text.find("first raw prompt").unwrap() < text.find("second raw prompt").unwrap()
            );
            assert_eq!(
                manager.input_queue.count(runtime_id),
                3,
                "the queue remains visible until ACK"
            );
            assert!(prompts(&manager, runtime_id).is_empty());
            assert_eq!(
                manager.lifecycle.admit_prompt(runtime_id, incarnation),
                Err(AdmissionError::Busy {
                    active_command_id: ROOT.into()
                })
            );
            let id = command["command_id"].as_str().unwrap();
            assert_ne!(id, ROOT);
            emit_lifecycle(&manager, runtime_id, "steer_admitted", id, GEN, ROOT);
            delivered = Some(command.clone());
            LiveWriteOutcome::Written
        })
        .unwrap();

    assert_eq!(outcome, "injected");
    assert_root_owned(&manager, runtime_id);
    assert_eq!(manager.input_queue.count(runtime_id), 1);
    assert_eq!(
        manager
            .input_queue
            .peek(runtime_id)
            .unwrap()
            .batch()
            .client_message_id(),
        "client-later"
    );
    assert_eq!(
        prompts(&manager, runtime_id),
        vec![
            ("client-one".into(), "first visible prompt".into()),
            ("client-two".into(), "second visible prompt".into()),
        ]
    );
    let delivered = delivered.unwrap();
    let steer_id = delivered["command_id"].as_str().unwrap();
    emit_lifecycle(&manager, runtime_id, "steer_admitted", steer_id, GEN, ROOT);
    emit_lifecycle(
        &manager,
        runtime_id,
        "steer_rejected",
        steer_id,
        GEN,
        "late duplicate",
    );
    emit_lifecycle(
        &manager,
        runtime_id,
        "sdk_command_state",
        steer_id,
        GEN,
        "completed",
    );
    assert_eq!(prompts(&manager, runtime_id).len(), 2);
    assert_eq!(manager.input_queue.count(runtime_id), 1);
    assert_root_owned(&manager, runtime_id);

    emit_lifecycle(
        &manager,
        runtime_id,
        "turn_result_observed",
        ROOT,
        GEN,
        "success",
    );
    assert_eq!(
        manager
            .lifecycle
            .projection(runtime_id)
            .unwrap()
            .active_command_id
            .as_deref(),
        Some(ROOT)
    );
    emit_lifecycle(
        &manager,
        runtime_id,
        "sdk_command_state",
        ROOT,
        GEN,
        "completed",
    );
    assert!(manager
        .lifecycle
        .projection(runtime_id)
        .unwrap()
        .active_command_id
        .is_none());
    manager
        .lifecycle
        .admit_prompt(runtime_id, incarnation)
        .expect("only the root terminal frees foreground");
}

#[test]
fn steer_legacy_and_missing_capability_restore_pending_without_writing() {
    for capabilities in [vec![], vec!["msg_lifecycle_v1"]] {
        let runtime_id = format!("steer-fallback-{}", capabilities.len());
        let (manager, incarnation) = running_manager(&runtime_id, &capabilities);
        enqueue(
            &manager,
            &runtime_id,
            "client-one",
            "steer text",
            None,
            None,
        );
        let outcome = manager
            .steer_queued_with(&runtime_id, incarnation, ROOT, |_| {
                panic!("unsupported helper must not receive an injection")
            })
            .unwrap();
        assert_eq!(outcome, "fallback");
        assert_root_owned(&manager, &runtime_id);
        let queued = manager.input_queue.peek(&runtime_id).unwrap();
        assert_eq!(queued.delivery_state(), QueuedInputDeliveryState::Pending);
        assert!(queued.dispatch_command_id().is_none());
        assert_eq!(manager.input_queue.count(&runtime_id), 1);
        assert!(prompts(&manager, &runtime_id).is_empty());
    }
}

#[test]
fn steer_slash_command_anywhere_in_merged_batch_uses_fallback() {
    let runtime_id = "steer-slash-fallback";
    let (manager, incarnation) = steer_manager(runtime_id);
    enqueue(
        &manager,
        runtime_id,
        "client-one",
        "ordinary text",
        None,
        Some(ROOT),
    );
    enqueue(
        &manager,
        runtime_id,
        "client-two",
        "  /compact keep the decision",
        None,
        Some(ROOT),
    );
    assert_eq!(
        manager
            .steer_queued_with(runtime_id, incarnation, ROOT, |_| {
                panic!("slash commands must retain normal foreground semantics")
            })
            .unwrap(),
        "fallback"
    );
    assert_eq!(manager.input_queue.count(runtime_id), 2);
    assert_eq!(
        manager
            .input_queue
            .peek(runtime_id)
            .unwrap()
            .delivery_state(),
        QueuedInputDeliveryState::Pending
    );
    assert!(prompts(&manager, runtime_id).is_empty());
    assert_root_owned(&manager, runtime_id);
}

#[test]
fn steer_stale_parent_releases_claim_without_requesting_interrupt() {
    let runtime_id = "steer-stale-parent";
    let (manager, incarnation) = steer_manager(runtime_id);
    enqueue(&manager, runtime_id, "client-one", "steer text", None, None);
    assert_eq!(
        manager
            .steer_queued_with(runtime_id, incarnation, "already-finished-root", |_| {
                panic!("a stale UI target must never write to the current turn")
            })
            .unwrap(),
        "unchanged"
    );
    assert_root_owned(&manager, runtime_id);
    assert_eq!(
        manager
            .input_queue
            .peek(runtime_id)
            .unwrap()
            .delivery_state(),
        QueuedInputDeliveryState::Pending
    );
    assert!(prompts(&manager, runtime_id).is_empty());
}

#[test]
fn steer_definitely_not_written_is_replay_safe_fallback() {
    let runtime_id = "steer-write-not-started";
    let (manager, incarnation) = steer_manager(runtime_id);
    enqueue(&manager, runtime_id, "client-one", "steer text", None, None);
    assert_eq!(
        manager
            .steer_queued_with(runtime_id, incarnation, ROOT, |_| {
                LiveWriteOutcome::NotStarted("child was unavailable before write".into())
            })
            .unwrap(),
        "fallback"
    );
    assert_root_owned(&manager, runtime_id);
    assert_eq!(
        manager
            .input_queue
            .peek(runtime_id)
            .unwrap()
            .delivery_state(),
        QueuedInputDeliveryState::Pending
    );
    assert!(prompts(&manager, runtime_id).is_empty());

    // A later user action can retry this proven-not-delivered item once.
    assert_eq!(
        manager
            .steer_queued_with(runtime_id, incarnation, ROOT, |command| {
                let command = serde_json::to_value(command).unwrap();
                emit_lifecycle(
                    &manager,
                    runtime_id,
                    "steer_admitted",
                    command["command_id"].as_str().unwrap(),
                    GEN,
                    ROOT,
                );
                LiveWriteOutcome::Written
            })
            .unwrap(),
        "injected"
    );
    assert_eq!(
        prompts(&manager, runtime_id),
        vec![("client-one".into(), "steer text".into())]
    );
}

#[test]
fn steer_explicit_rejection_after_root_terminal_restores_pending_for_normal_dispatch() {
    let runtime_id = "steer-rejected-after-terminal";
    let (manager, incarnation) = steer_manager(runtime_id);
    enqueue(&manager, runtime_id, "client-one", "steer text", None, None);
    let outcome = manager
        .steer_queued_with(runtime_id, incarnation, ROOT, |command| {
            let command = serde_json::to_value(command).unwrap();
            emit_lifecycle(
                &manager,
                runtime_id,
                "sdk_command_state",
                ROOT,
                GEN,
                "completed",
            );
            emit_lifecycle(
                &manager,
                runtime_id,
                "steer_rejected",
                command["command_id"].as_str().unwrap(),
                GEN,
                "foreground_changed",
            );
            LiveWriteOutcome::Written
        })
        .unwrap();
    assert_eq!(
        outcome, "unchanged",
        "the completed root must not be interrupted"
    );
    assert!(manager
        .lifecycle
        .projection(runtime_id)
        .unwrap()
        .active_command_id
        .is_none());
    assert_eq!(
        manager
            .input_queue
            .peek(runtime_id)
            .unwrap()
            .delivery_state(),
        QueuedInputDeliveryState::Pending
    );
    assert!(prompts(&manager, runtime_id).is_empty());

    let (attempt, command_id) = match manager.input_queue.claim_next(runtime_id) {
        NativeInputClaimOutcome::Claimed {
            dispatch_attempt,
            dispatch_command_id,
            ..
        } => (dispatch_attempt, dispatch_command_id),
        other => panic!("rejected steer must be available to normal FIFO, got {other:?}"),
    };
    manager
        .lifecycle
        .admit_queued_prompt(runtime_id, incarnation, &command_id, attempt)
        .unwrap();
    emit_lifecycle(
        &manager,
        runtime_id,
        "command_admitted",
        &command_id,
        GEN,
        &command_id,
    );
    assert_eq!(manager.input_queue.count(runtime_id), 0);
    assert_eq!(
        prompts(&manager, runtime_id),
        vec![("client-one".into(), "steer text".into())]
    );
}

#[test]
fn steer_ambiguous_write_is_not_replayed_and_late_ack_projects_once() {
    let runtime_id = "steer-ambiguous-write";
    let (manager, incarnation) = steer_manager(runtime_id);
    enqueue(&manager, runtime_id, "client-one", "steer text", None, None);
    enqueue(&manager, runtime_id, "client-two", "later text", None, None);
    let mut steer_id = String::new();
    let error = manager
        .steer_queued_with(runtime_id, incarnation, ROOT, |command| {
            let command = serde_json::to_value(command).unwrap();
            steer_id = command["command_id"].as_str().unwrap().to_owned();
            LiveWriteOutcome::StartedUnknown("write may have reached the helper".into())
        })
        .unwrap_err();
    assert!(error.starts_with("DELIVERY_UNCERTAIN:"));
    assert_root_owned(&manager, runtime_id);
    assert_eq!(
        manager
            .input_queue
            .peek(runtime_id)
            .unwrap()
            .delivery_state(),
        QueuedInputDeliveryState::DeliveryUncertain
    );
    assert_eq!(manager.input_queue.delivery_uncertain_count(runtime_id), 1);
    assert!(prompts(&manager, runtime_id).is_empty());
    assert_eq!(
        manager
            .steer_queued_with(runtime_id, incarnation, ROOT, |_| {
                panic!("an uncertain steer must never be replayed")
            })
            .unwrap(),
        "unchanged"
    );

    emit_lifecycle(
        &manager,
        runtime_id,
        "steer_admitted",
        "other-steer",
        GEN,
        ROOT,
    );
    emit_lifecycle(
        &manager,
        runtime_id,
        "steer_admitted",
        &steer_id,
        GEN + 1,
        ROOT,
    );
    emit_lifecycle(
        &manager,
        runtime_id,
        "steer_rejected",
        &steer_id,
        GEN - 1,
        "stale",
    );
    assert_eq!(manager.input_queue.delivery_uncertain_count(runtime_id), 1);
    assert!(prompts(&manager, runtime_id).is_empty());
    emit_lifecycle(&manager, runtime_id, "steer_admitted", &steer_id, GEN, ROOT);
    emit_lifecycle(&manager, runtime_id, "steer_admitted", &steer_id, GEN, ROOT);
    emit_lifecycle(
        &manager,
        runtime_id,
        "steer_rejected",
        &steer_id,
        GEN,
        "duplicate contradiction",
    );
    assert_root_owned(&manager, runtime_id);
    assert_eq!(manager.input_queue.delivery_uncertain_count(runtime_id), 0);
    assert_eq!(manager.input_queue.count(runtime_id), 1);
    assert_eq!(
        manager
            .input_queue
            .peek(runtime_id)
            .unwrap()
            .batch()
            .client_message_id(),
        "client-two"
    );
    assert_eq!(
        prompts(&manager, runtime_id),
        vec![("client-one".into(), "steer text".into())]
    );
}

#[test]
fn steer_late_acceptance_after_root_terminal_still_removes_and_projects_exact_claim() {
    let runtime_id = "steer-late-ack-after-terminal";
    let (manager, incarnation) = steer_manager(runtime_id);
    enqueue(
        &manager,
        runtime_id,
        "client-one",
        "accepted before terminal",
        None,
        None,
    );
    let mut steer_id = String::new();
    manager
        .steer_queued_with(runtime_id, incarnation, ROOT, |command| {
            let command = serde_json::to_value(command).unwrap();
            steer_id = command["command_id"].as_str().unwrap().to_owned();
            LiveWriteOutcome::StartedUnknown("late receipt".into())
        })
        .unwrap_err();
    emit_lifecycle(
        &manager,
        runtime_id,
        "sdk_command_state",
        ROOT,
        GEN,
        "completed",
    );
    emit_lifecycle(&manager, runtime_id, "steer_admitted", &steer_id, GEN, ROOT);
    emit_lifecycle(&manager, runtime_id, "steer_admitted", &steer_id, GEN, ROOT);
    assert!(manager
        .lifecycle
        .projection(runtime_id)
        .unwrap()
        .active_command_id
        .is_none());
    assert_eq!(manager.input_queue.count(runtime_id), 0);
    assert_eq!(
        prompts(&manager, runtime_id),
        vec![("client-one".into(), "accepted before terminal".into())]
    );
}

#[test]
fn steer_helper_retirement_does_not_replay_or_remove_uncertain_queue_input() {
    let runtime_id = "steer-uncertain-retired-helper";
    let (manager, incarnation) = steer_manager(runtime_id);
    enqueue(
        &manager,
        runtime_id,
        "client-one",
        "possibly delivered",
        None,
        None,
    );
    manager
        .steer_queued_with(runtime_id, incarnation, ROOT, |_| {
            LiveWriteOutcome::StartedUnknown("uncertain write".into())
        })
        .unwrap_err();
    manager
        .lifecycle
        .note_generation_retired(runtime_id, incarnation);
    manager.lifecycle.abandon_retired_command(runtime_id, ROOT);
    manager
        .lifecycle
        .note_incarnation(runtime_id, incarnation + 1);
    manager.lifecycle.note_session_meta(
        runtime_id,
        incarnation + 1,
        None,
        Some(&["msg_lifecycle_v1".into(), "ccem_steer_v1".into()]),
        Some(1),
    );
    manager
        .lifecycle
        .admit_prompt_with_id(runtime_id, incarnation + 1, "new-root")
        .unwrap();
    manager
        .lifecycle
        .note_command_admitted(runtime_id, incarnation + 1, "new-root", 1);
    manager
        .lifecycle
        .note_sdk_command_state(runtime_id, incarnation + 1, "new-root", "started", 1);
    assert_eq!(
        manager
            .steer_queued_with(runtime_id, incarnation + 1, "new-root", |_| {
                panic!("helper retirement does not prove non-delivery of the old input")
            })
            .unwrap(),
        "unchanged"
    );
    assert_eq!(manager.input_queue.count(runtime_id), 1);
    assert_eq!(
        manager
            .input_queue
            .peek(runtime_id)
            .unwrap()
            .delivery_state(),
        QueuedInputDeliveryState::DeliveryUncertain
    );
    assert!(prompts(&manager, runtime_id).is_empty());
}

#[test]
fn steer_late_rejected_ack_after_timeout_and_terminal_wakes_normal_fifo_once() {
    let runtime_id = "steer-late-rejection-autodrain";
    let (manager, incarnation) = steer_manager(runtime_id);
    enqueue(
        &manager,
        runtime_id,
        "client-one",
        "retry after definite rejection",
        None,
        None,
    );
    let mut steer_id = String::new();
    let error = manager
        .steer_queued_with(runtime_id, incarnation, ROOT, |command| {
            steer_id = serde_json::to_value(command).unwrap()["command_id"]
                .as_str()
                .unwrap()
                .to_owned();
            // The write succeeded, but the real admission-ACK deadline expires.
            LiveWriteOutcome::Written
        })
        .unwrap_err();
    assert!(error.starts_with("DELIVERY_UNCERTAIN:"));
    assert_eq!(
        manager
            .input_queue
            .peek(runtime_id)
            .unwrap()
            .delivery_state(),
        QueuedInputDeliveryState::DeliveryUncertain
    );

    let before_terminal = manager.lifecycle.projection(runtime_id);
    emit_lifecycle(
        &manager,
        runtime_id,
        "sdk_command_state",
        ROOT,
        GEN,
        "completed",
    );
    let after_terminal = manager.lifecycle.projection(runtime_id);
    assert!(super::super::lifecycle_transition_unblocked_queue(
        before_terminal.as_ref(),
        after_terminal.as_ref()
    ));
    manager
        .dispatch_queued_with(
            runtime_id,
            QueueDispatchTrigger::AuthoritativeLifecycle,
            |_, _, _, _, _, _, _| panic!("the terminal wake cannot replay an uncertain steer"),
        )
        .unwrap();

    // Stale receipts must not create a wake merely because they name the stage.
    for (command_id, generation) in [("other-steer", GEN), (steer_id.as_str(), GEN + 1)] {
        let before = manager.input_queue.peek(runtime_id);
        emit_lifecycle(
            &manager,
            runtime_id,
            "steer_rejected",
            command_id,
            generation,
            "stale",
        );
        let after = manager.input_queue.peek(runtime_id);
        let lifecycle = manager.lifecycle.projection(runtime_id);
        assert!(!super::super::queue_head_transition_unblocked_queue(
            before.as_ref(),
            after.as_ref(),
            lifecycle.as_ref()
        ));
    }

    let before = manager.input_queue.peek(runtime_id);
    emit_lifecycle(
        &manager,
        runtime_id,
        "steer_rejected",
        &steer_id,
        GEN,
        "foreground_already_completed",
    );
    let after = manager.input_queue.peek(runtime_id);
    let lifecycle = manager.lifecycle.projection(runtime_id);
    assert_eq!(
        after.as_ref().unwrap().delivery_state(),
        QueuedInputDeliveryState::Pending
    );
    assert!(prompts(&manager, runtime_id).is_empty());
    let should_drain = super::super::queue_head_transition_unblocked_queue(
        before.as_ref(),
        after.as_ref(),
        lifecycle.as_ref(),
    );
    assert!(
        should_drain,
        "an exact late rejection must create another wake after the terminal wake was blocked"
    );

    // This wake uses ordinary FIFO rules; it cannot bypass a new owner,
    // settings change, or unresolved adapter negotiation.
    let idle = lifecycle.unwrap();
    let mut blocked = idle.clone();
    blocked.active_command_id = Some("new-owner".into());
    assert!(!super::super::queue_head_transition_unblocked_queue(
        before.as_ref(),
        after.as_ref(),
        Some(&blocked)
    ));
    blocked = idle.clone();
    blocked.settings_pending = true;
    assert!(!super::super::queue_head_transition_unblocked_queue(
        before.as_ref(),
        after.as_ref(),
        Some(&blocked)
    ));
    blocked = idle;
    blocked.adapter = "negotiating".into();
    assert!(!super::super::queue_head_transition_unblocked_queue(
        before.as_ref(),
        after.as_ref(),
        Some(&blocked)
    ));

    let mut dispatches = 0;
    if should_drain {
        manager
            .dispatch_queued_with(
                runtime_id,
                QueueDispatchTrigger::AuthoritativeLifecycle,
                |text, _, _, _, command_id, attempt, client_ids| {
                    dispatches += 1;
                    assert_eq!(text, "retry after definite rejection");
                    assert_eq!(client_ids, &["client-one".to_string()]);
                    assert_ne!(command_id, steer_id);
                    manager
                        .lifecycle
                        .admit_queued_prompt(runtime_id, incarnation, command_id, attempt)
                        .unwrap();
                    emit_lifecycle(
                        &manager,
                        runtime_id,
                        "command_admitted",
                        command_id,
                        GEN,
                        command_id,
                    );
                    Ok(())
                },
            )
            .unwrap();
    }
    assert_eq!(dispatches, 1);
    assert_eq!(manager.input_queue.count(runtime_id), 0);
    assert_eq!(
        prompts(&manager, runtime_id),
        vec![("client-one".into(), "retry after definite rejection".into())]
    );
    let before_duplicate = manager.input_queue.peek(runtime_id);
    emit_lifecycle(
        &manager,
        runtime_id,
        "steer_rejected",
        &steer_id,
        GEN,
        "duplicate",
    );
    let after_duplicate = manager.input_queue.peek(runtime_id);
    let lifecycle = manager.lifecycle.projection(runtime_id);
    assert!(!super::super::queue_head_transition_unblocked_queue(
        before_duplicate.as_ref(),
        after_duplicate.as_ref(),
        lifecycle.as_ref()
    ));
    assert_eq!(prompts(&manager, runtime_id).len(), 1);
}

#[test]
fn steer_late_admitted_ack_after_terminal_wakes_the_next_pending_batch() {
    let runtime_id = "steer-late-admission-autodrain";
    let (manager, incarnation) = steer_manager(runtime_id);
    enqueue(
        &manager,
        runtime_id,
        "client-one",
        "accepted steer",
        None,
        None,
    );
    enqueue(
        &manager,
        runtime_id,
        "client-two",
        "next queued batch",
        None,
        None,
    );
    let mut steer_id = String::new();
    manager
        .steer_queued_with(runtime_id, incarnation, ROOT, |command| {
            steer_id = serde_json::to_value(command).unwrap()["command_id"]
                .as_str()
                .unwrap()
                .to_owned();
            LiveWriteOutcome::StartedUnknown("receipt delayed".into())
        })
        .unwrap_err();
    emit_lifecycle(
        &manager,
        runtime_id,
        "sdk_command_state",
        ROOT,
        GEN,
        "completed",
    );
    let before = manager.input_queue.peek(runtime_id);
    emit_lifecycle(&manager, runtime_id, "steer_admitted", &steer_id, GEN, ROOT);
    let after = manager.input_queue.peek(runtime_id);
    let lifecycle = manager.lifecycle.projection(runtime_id);
    assert_eq!(
        after.as_ref().unwrap().batch().client_message_id(),
        "client-two"
    );
    assert!(
        super::super::queue_head_transition_unblocked_queue(
            before.as_ref(),
            after.as_ref(),
            lifecycle.as_ref()
        ),
        "late admission must wake the next head after removing the uncertain one"
    );
    assert_eq!(
        prompts(&manager, runtime_id),
        vec![("client-one".into(), "accepted steer".into())]
    );

    let before_duplicate = manager.input_queue.peek(runtime_id);
    emit_lifecycle(&manager, runtime_id, "steer_admitted", &steer_id, GEN, ROOT);
    let after_duplicate = manager.input_queue.peek(runtime_id);
    let lifecycle = manager.lifecycle.projection(runtime_id);
    assert!(
        !super::super::queue_head_transition_unblocked_queue(
            before_duplicate.as_ref(),
            after_duplicate.as_ref(),
            lifecycle.as_ref()
        ),
        "duplicate receipt does not cause another queue transition"
    );
}

#[test]
fn steer_receipt_autodrain_never_clears_or_bypasses_initialization_fence() {
    let runtime_id = "steer-autodrain-initialization-fence";
    let (manager, incarnation) = steer_manager(runtime_id);
    enqueue(
        &manager,
        runtime_id,
        "client-one",
        "waiting for a settled helper",
        None,
        None,
    );
    let mut steer_id = String::new();
    manager
        .steer_queued_with(runtime_id, incarnation, ROOT, |command| {
            steer_id = serde_json::to_value(command).unwrap()["command_id"]
                .as_str()
                .unwrap()
                .to_owned();
            LiveWriteOutcome::StartedUnknown("late rejection".into())
        })
        .unwrap_err();
    emit_lifecycle(
        &manager,
        runtime_id,
        "sdk_command_state",
        ROOT,
        GEN,
        "completed",
    );
    manager
        .initializing_runtimes
        .lock()
        .unwrap()
        .insert(runtime_id.into());
    let receipt = serde_json::json!({
        "type": "event",
        "payload": {
            "type": "lifecycle", "stage": "steer_rejected", "detail": "foreground_completed",
            "command_id": steer_id, "query_generation": GEN,
        },
    })
    .to_string();
    assert!(super::super::helper_output_has_steer_receipt(&receipt));
    assert!(
        !super::super::helper_output_requests_queue_autodrain(&receipt),
        "steer receipt must not masquerade as initialization_settled"
    );
    for unrelated in [
        r#"{"type":"event","payload":{"type":"lifecycle","stage":"initialization_settled"}}"#,
        r#"{"type":"event","payload":{"type":"assistant_message","stage":"steer_rejected"}}"#,
        r#"{"type":"status","payload":{"type":"lifecycle","stage":"steer_rejected"}}"#,
    ] {
        assert!(!super::super::helper_output_has_steer_receipt(unrelated));
    }
    let handle = manager
        .handles
        .lock()
        .unwrap()
        .get(runtime_id)
        .unwrap()
        .clone();
    manager
        .process_helper_stdout_if_current(None, runtime_id, &receipt, &handle)
        .unwrap();
    assert!(manager
        .initializing_runtimes
        .lock()
        .unwrap()
        .contains(runtime_id));
    assert_eq!(
        manager
            .input_queue
            .peek(runtime_id)
            .unwrap()
            .delivery_state(),
        QueuedInputDeliveryState::Pending
    );
    manager
        .dispatch_queued_with(
            runtime_id,
            QueueDispatchTrigger::AuthoritativeLifecycle,
            |_, _, _, _, _, _, _| panic!("steer ACK must honor an initialization fence"),
        )
        .unwrap();
    assert_eq!(manager.input_queue.count(runtime_id), 1);
    assert!(prompts(&manager, runtime_id).is_empty());
}
