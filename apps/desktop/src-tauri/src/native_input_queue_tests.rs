use super::{
    FrozenNativeInputBatch, FrozenNativeInputMessage, NativeInputCancelOutcome,
    NativeInputClaimOutcome, NativeInputPopOutcome, NativeInputQueue, NativeInputQueueError,
    QueuedInputDeliveryState,
};
use serde_json::json;
use std::sync::{Arc, Barrier};
use std::thread;

fn batch(client_message_id: &str, text: &str) -> FrozenNativeInputBatch {
    FrozenNativeInputBatch::new(
        client_message_id,
        text,
        Some(format!("display:{text}")),
        Some(vec![json!({ "mediaType": "image/png", "data": text })]),
        Some(vec![json!({ "quote": text, "note": "note" })]),
    )
}

fn is_uuid_v4(value: &str) -> bool {
    value.len() == 36
        && value.as_bytes()[8] == b'-'
        && value.as_bytes()[13] == b'-'
        && value.as_bytes()[18] == b'-'
        && value.as_bytes()[23] == b'-'
        && value.as_bytes()[14] == b'4'
        && matches!(value.as_bytes()[19], b'8' | b'9' | b'a' | b'b')
        && value
            .bytes()
            .enumerate()
            .all(|(index, byte)| matches!(index, 8 | 13 | 18 | 23) || byte.is_ascii_hexdigit())
}

fn claim(queue: &NativeInputQueue, runtime_id: &str) -> (FrozenNativeInputBatch, u64, String) {
    match queue.claim_next(runtime_id) {
        NativeInputClaimOutcome::Claimed {
            batch,
            dispatch_attempt,
            dispatch_command_id,
        } => (batch, dispatch_attempt, dispatch_command_id),
        other => panic!("expected claim, got {other:?}"),
    }
}

fn batch_ids(batch: &FrozenNativeInputBatch) -> Vec<&str> {
    batch
        .messages()
        .iter()
        .map(FrozenNativeInputMessage::client_message_id)
        .collect()
}

#[test]
fn queues_are_fifo_and_isolated_per_runtime() {
    let queue = NativeInputQueue::default();
    queue
        .enqueue("runtime-a", batch("a-1", "one"), None)
        .unwrap();
    queue
        .enqueue("runtime-a", batch("a-2", "two"), None)
        .unwrap();
    queue
        .enqueue("runtime-b", batch("b-1", "other"), None)
        .unwrap();

    assert_eq!(queue.count("runtime-a"), 2);
    assert_eq!(queue.count("runtime-b"), 1);
    assert_eq!(queue.peek("runtime-a").unwrap().batch().text(), "one");

    let NativeInputPopOutcome::Ready(first) = queue.pop("runtime-a") else {
        panic!("expected first queued batch");
    };
    let NativeInputPopOutcome::Ready(second) = queue.pop("runtime-a") else {
        panic!("expected second queued batch");
    };
    assert_eq!(batch_ids(&first), vec!["a-1"]);
    assert_eq!(batch_ids(&second), vec!["a-2"]);
    assert_eq!(queue.count("runtime-b"), 1);
}

#[test]
fn pending_messages_freeze_into_one_ordered_dispatch_batch() {
    let queue = NativeInputQueue::default();
    queue
        .enqueue(
            "runtime-a",
            FrozenNativeInputBatch::new(
                "a-1",
                "first",
                Some("visible first".to_owned()),
                Some(vec![json!({ "image": 1 })]),
                Some(vec![json!({ "annotation": 1 })]),
            ),
            Some("blocker-a"),
        )
        .unwrap();
    queue
        .enqueue(
            "runtime-a",
            FrozenNativeInputBatch::new(
                "a-2",
                "second",
                Some("visible second".to_owned()),
                Some(vec![json!({ "image": 2 })]),
                Some(vec![json!({ "annotation": 2 })]),
            ),
            Some("blocker-a"),
        )
        .unwrap();

    let (batch, _, _) = claim(&queue, "runtime-a");
    let parts = batch.into_dispatch_parts();

    assert_eq!(
        parts.text,
        "first\n\n另外还有这些后续消息，请按顺序继续处理：\n2. second"
    );
    assert_eq!(
        parts.display_text.as_deref(),
        Some("visible first\n\n另外还有这些后续消息，请按顺序继续处理：\n2. visible second")
    );
    assert_eq!(
        parts.images,
        Some(vec![json!({ "image": 1 }), json!({ "image": 2 })])
    );
    assert_eq!(
        parts.annotations,
        Some(vec![json!({ "annotation": 1 }), json!({ "annotation": 2 })])
    );
    assert_eq!(
        parts
            .messages
            .iter()
            .map(FrozenNativeInputMessage::client_message_id)
            .collect::<Vec<_>>(),
        vec!["a-1", "a-2"]
    );
}

#[test]
fn messages_arriving_after_a_claim_form_the_next_dispatch_batch() {
    let queue = NativeInputQueue::default();
    queue
        .enqueue("runtime-a", batch("a-1", "one"), None)
        .unwrap();
    let (_, _, first_command_id) = claim(&queue, "runtime-a");

    queue
        .enqueue("runtime-a", batch("a-2", "two"), Some("blocker-a"))
        .unwrap();
    queue
        .enqueue("runtime-a", batch("a-3", "three"), Some("blocker-a"))
        .unwrap();

    assert!(queue
        .confirm_admitted("runtime-a", &first_command_id)
        .is_some());
    let (next_batch, _, _) = claim(&queue, "runtime-a");
    assert_eq!(batch_ids(&next_batch), vec!["a-2", "a-3"]);
}

#[test]
fn queued_payload_is_an_owned_snapshot() {
    let queue = NativeInputQueue::default();
    let mut images = vec![json!({ "data": "before" })];
    let mut annotations = vec![json!({ "note": "before" })];
    queue
        .enqueue(
            "runtime-a",
            FrozenNativeInputBatch::new(
                "message-1",
                "prompt",
                Some("visible prompt".to_owned()),
                Some(images.clone()),
                Some(annotations.clone()),
            ),
            None,
        )
        .unwrap();

    images[0]["data"] = json!("after");
    annotations[0]["note"] = json!("after");

    let queued = queue.peek("runtime-a").unwrap();
    assert_eq!(queued.batch().display_text(), Some("visible prompt"));
    assert_eq!(queued.batch().images().unwrap()[0]["data"], "before");
    assert_eq!(queued.batch().annotations().unwrap()[0]["note"], "before");
}

#[test]
fn duplicate_client_message_id_is_rejected_only_within_the_runtime() {
    let queue = NativeInputQueue::default();
    queue
        .enqueue("runtime-a", batch("stable-id", "one"), None)
        .unwrap();

    assert_eq!(
        queue.enqueue("runtime-a", batch("stable-id", "retry"), None),
        Err(NativeInputQueueError::ConflictingClientMessage)
    );
    assert_eq!(
        queue.enqueue("runtime-a", batch("stable-id", "one"), None),
        Err(NativeInputQueueError::DuplicateClientMessage)
    );
    assert_eq!(
        queue.enqueue("runtime-b", batch("stable-id", "other"), None),
        Ok(1)
    );

    assert!(matches!(
        queue.pop("runtime-a"),
        NativeInputPopOutcome::Ready(_)
    ));
    assert_eq!(
        queue.enqueue("runtime-a", batch("stable-id", "completed retry"), None),
        Err(NativeInputQueueError::ConflictingClientMessage)
    );
    assert_eq!(
        queue.enqueue("runtime-a", batch("stable-id", "one"), None),
        Err(NativeInputQueueError::DuplicateClientMessage)
    );
}

#[test]
fn delivery_uncertain_head_cannot_be_automatically_popped() {
    let queue = NativeInputQueue::default();
    queue
        .enqueue("runtime-a", batch("message-1", "one"), None)
        .unwrap();
    queue
        .enqueue("runtime-a", batch("message-2", "two"), None)
        .unwrap();
    let (_, attempt, _) = claim(&queue, "runtime-a");
    assert!(queue.mark_claim_delivery_uncertain("runtime-a", "message-1", attempt));

    let head = queue.peek("runtime-a").unwrap();
    assert_eq!(
        head.delivery_state(),
        QueuedInputDeliveryState::DeliveryUncertain
    );
    assert_eq!(
        queue.pop("runtime-a"),
        NativeInputPopOutcome::BlockedByDeliveryUncertain {
            client_message_id: "message-1".to_owned(),
        }
    );
    assert_eq!(queue.count("runtime-a"), 2);

    let removed = queue.remove("runtime-a", "message-1").unwrap();
    assert_eq!(batch_ids(removed.batch()), vec!["message-1"]);
    assert!(matches!(
        queue.pop("runtime-a"),
        NativeInputPopOutcome::Ready(batch) if batch_ids(&batch) == vec!["message-2"]
    ));
}

#[test]
fn claim_is_single_owner_until_completed_released_or_uncertain() {
    let queue = NativeInputQueue::default();
    queue
        .enqueue("runtime-a", batch("message-1", "one"), None)
        .unwrap();
    let (first, first_attempt, first_command) = claim(&queue, "runtime-a");
    assert_eq!(first.client_message_id(), "message-1");
    assert_eq!(first_attempt, 1);
    assert!(is_uuid_v4(&first_command));
    assert_eq!(
        queue.claim_next("runtime-a"),
        NativeInputClaimOutcome::AlreadyDispatching {
            client_message_id: "message-1".to_owned(),
        }
    );
    assert!(!queue.release_dispatch("runtime-a", "message-1", 2));
    assert!(queue.release_dispatch("runtime-a", "message-1", 1));
    let (_, second_attempt, second_command) = claim(&queue, "runtime-a");
    assert_eq!(second_attempt, 2);
    assert!(is_uuid_v4(&second_command));
    assert_ne!(first_command, second_command);
    assert!(!queue.complete_dispatch("runtime-a", &first_command));
    assert!(queue.complete_dispatch("runtime-a", &second_command));
    assert_eq!(queue.count("runtime-a"), 0);
}

#[test]
fn admission_timeout_only_marks_the_exact_dispatching_head_uncertain() {
    let queue = NativeInputQueue::default();
    queue
        .enqueue("runtime-a", batch("message-1", "one"), None)
        .unwrap();
    assert!(!queue.mark_dispatch_delivery_uncertain("runtime-a", "foreign", 1));
    let (_, attempt, command_id) = claim(&queue, "runtime-a");
    assert_eq!(attempt, 1);
    assert!(!queue.mark_dispatch_delivery_uncertain("runtime-a", "foreign", 1));
    assert!(!queue.mark_dispatch_delivery_uncertain("runtime-a", &command_id, 2));
    assert!(queue.mark_dispatch_delivery_uncertain("runtime-a", &command_id, attempt));
    assert_eq!(
        queue.claim_next("runtime-a"),
        NativeInputClaimOutcome::BlockedByDeliveryUncertain {
            client_message_id: "message-1".to_string(),
        }
    );
}

#[test]
fn late_exact_helper_receipts_heal_a_local_admission_timeout() {
    let queue = NativeInputQueue::default();
    queue
        .enqueue("runtime-a", batch("admitted", "one"), None)
        .unwrap();
    let (_, admitted_attempt, admitted_command) = claim(&queue, "runtime-a");
    assert!(queue.mark_dispatch_delivery_uncertain(
        "runtime-a",
        &admitted_command,
        admitted_attempt
    ));
    assert!(queue
        .confirm_admitted("runtime-a", &admitted_command)
        .is_some());
    assert_eq!(queue.count("runtime-a"), 0);

    queue
        .enqueue("runtime-a", batch("rejected", "two"), None)
        .unwrap();
    let (_, rejected_attempt, rejected_command) = claim(&queue, "runtime-a");
    assert!(queue.mark_dispatch_delivery_uncertain(
        "runtime-a",
        &rejected_command,
        rejected_attempt
    ));
    assert!(queue.confirm_rejected("runtime-a", &rejected_command));
    let (retried, retry_attempt, retry_command) = claim(&queue, "runtime-a");
    assert_eq!(retried.client_message_id(), "rejected");
    assert_eq!(retry_attempt, 2);
    assert_ne!(rejected_command, retry_command);

    assert!(!queue.confirm_rejected("runtime-a", &rejected_command));
    assert!(queue
        .confirm_admitted("runtime-a", &rejected_command)
        .is_none());
    assert!(!queue.mark_dispatch_delivery_uncertain(
        "runtime-a",
        &rejected_command,
        rejected_attempt
    ));
    assert_eq!(queue.peek("runtime-a").unwrap().dispatch_attempt(), 2);
    assert_eq!(
        queue.peek("runtime-a").unwrap().dispatch_command_id(),
        Some(retry_command.as_str())
    );
}

#[test]
fn remove_preserves_fifo_order_and_clear_is_runtime_scoped() {
    let queue = NativeInputQueue::default();
    queue
        .enqueue("runtime-a", batch("a-1", "one"), None)
        .unwrap();
    queue
        .enqueue("runtime-a", batch("a-2", "two"), None)
        .unwrap();
    queue
        .enqueue("runtime-a", batch("a-3", "three"), None)
        .unwrap();
    queue
        .enqueue("runtime-b", batch("b-1", "other"), None)
        .unwrap();

    assert_eq!(
        queue
            .remove("runtime-a", "a-2")
            .unwrap()
            .batch()
            .client_message_id(),
        "a-2"
    );
    let NativeInputPopOutcome::Ready(remaining) = queue.pop("runtime-a") else {
        panic!("expected first remaining batch");
    };
    let NativeInputPopOutcome::Ready(last) = queue.pop("runtime-a") else {
        panic!("expected second remaining batch");
    };
    assert_eq!(batch_ids(&remaining), vec!["a-1"]);
    assert_eq!(batch_ids(&last), vec!["a-3"]);
    assert_eq!(queue.clear("runtime-a"), 0);
    assert_eq!(queue.clear("runtime-b"), 1);
    assert_eq!(queue.count("runtime-b"), 0);
}

#[test]
fn cancel_pending_removes_only_the_exact_message_and_keeps_its_id_retired() {
    let queue = NativeInputQueue::default();
    queue
        .enqueue("runtime-a", batch("a-1", "one"), Some("blocker-a"))
        .unwrap();
    queue
        .enqueue("runtime-a", batch("a-2", "two"), Some("blocker-a"))
        .unwrap();
    queue
        .enqueue("runtime-a", batch("a-3", "three"), None)
        .unwrap();

    assert_eq!(
        queue.cancel_pending("runtime-a", "a-1"),
        NativeInputCancelOutcome::Cancelled { remaining_count: 2 }
    );
    assert_eq!(
        queue
            .snapshot("runtime-a")
            .into_iter()
            .map(|item| item.client_message_id)
            .collect::<Vec<_>>(),
        vec!["a-2", "a-3"]
    );
    assert_eq!(
        queue.enqueue("runtime-a", batch("a-1", "one"), None),
        Err(NativeInputQueueError::DuplicateClientMessage),
        "a cancelled client id stays retired so a stale renderer retry cannot replay it",
    );
}

#[test]
fn cancel_pending_refuses_claimed_or_uncertain_delivery_and_reports_missing_ids() {
    let queue = NativeInputQueue::default();
    queue
        .enqueue("runtime-a", batch("dispatching", "one"), None)
        .unwrap();
    let (_, attempt, _) = claim(&queue, "runtime-a");
    assert_eq!(
        queue.cancel_pending("runtime-a", "dispatching"),
        NativeInputCancelOutcome::Dispatching,
    );
    assert!(queue.mark_claim_delivery_uncertain("runtime-a", "dispatching", attempt));
    assert_eq!(
        queue.cancel_pending("runtime-a", "dispatching"),
        NativeInputCancelOutcome::DeliveryUncertain,
    );
    assert_eq!(
        queue.cancel_pending("runtime-a", "missing"),
        NativeInputCancelOutcome::NotFound,
    );
    assert_eq!(queue.count("runtime-a"), 1);
}

#[test]
fn cancel_and_claim_are_linearized_by_the_queue_owner() {
    let queue = Arc::new(NativeInputQueue::default());
    queue
        .enqueue("runtime-a", batch("race", "one"), None)
        .unwrap();
    let barrier = Arc::new(Barrier::new(3));

    let cancel_queue = Arc::clone(&queue);
    let cancel_barrier = Arc::clone(&barrier);
    let cancel = thread::spawn(move || {
        cancel_barrier.wait();
        cancel_queue.cancel_pending("runtime-a", "race")
    });
    let claim_queue = Arc::clone(&queue);
    let claim_barrier = Arc::clone(&barrier);
    let claim = thread::spawn(move || {
        claim_barrier.wait();
        claim_queue.claim_next("runtime-a")
    });
    barrier.wait();

    let cancel_outcome = cancel.join().expect("cancel thread");
    let claim_outcome = claim.join().expect("claim thread");
    match (cancel_outcome, claim_outcome) {
        (
            NativeInputCancelOutcome::Cancelled { remaining_count: 0 },
            NativeInputClaimOutcome::Empty,
        ) => {}
        (
            NativeInputCancelOutcome::Dispatching,
            NativeInputClaimOutcome::Claimed { batch, .. },
        ) => assert_eq!(batch.client_message_id(), "race"),
        other => panic!("cancel/claim produced a non-linearizable outcome: {other:?}"),
    }
}

#[test]
fn exact_dispatch_removal_only_discards_the_claimed_head() {
    let queue = NativeInputQueue::default();
    queue
        .enqueue("runtime-a", batch("a-1", "one"), None)
        .unwrap();
    queue
        .enqueue("runtime-a", batch("a-2", "two"), None)
        .unwrap();
    let (_, _, command_id) = claim(&queue, "runtime-a");

    assert!(queue.remove_dispatch("runtime-a", "foreign").is_none());
    let removed = queue
        .remove_dispatch("runtime-a", &command_id)
        .expect("exact dispatch removed");
    assert_eq!(batch_ids(removed.batch()), vec!["a-1"]);
    assert_eq!(
        batch_ids(queue.peek("runtime-a").unwrap().batch()),
        vec!["a-2"]
    );
}

#[test]
fn exact_stop_can_remove_a_not_started_claim_after_it_returns_to_pending() {
    let queue = NativeInputQueue::default();
    queue
        .enqueue("runtime-a", batch("a-1", "one"), None)
        .unwrap();
    let (batch, attempt, command_id) = claim(&queue, "runtime-a");
    assert!(queue.release_not_started(
        "runtime-a",
        batch.client_message_id(),
        &command_id,
        attempt,
    ));
    let pending = queue.peek("runtime-a").expect("pending head");
    assert_eq!(pending.delivery_state(), QueuedInputDeliveryState::Pending);
    assert_eq!(pending.dispatch_command_id(), Some(command_id.as_str()));
    assert!(queue.remove_dispatch("runtime-a", "foreign").is_none());
    assert!(queue.remove_dispatch("runtime-a", &command_id).is_some());
    assert_eq!(queue.count("runtime-a"), 0);
}

#[test]
fn rejects_empty_identifiers_and_handles_missing_entries() {
    let queue = NativeInputQueue::default();
    assert_eq!(
        queue.enqueue(" ", batch("message-1", "one"), None),
        Err(NativeInputQueueError::EmptyRuntime)
    );
    assert_eq!(
        queue.enqueue("runtime-a", batch(" ", "one"), None),
        Err(NativeInputQueueError::EmptyClientMessage)
    );
    assert!(!queue.mark_claim_delivery_uncertain("runtime-a", "missing", 1));
    assert!(!queue.mark_command_delivery_uncertain("runtime-a", "missing"));
    assert_eq!(queue.remove("runtime-a", "missing"), None);
    assert_eq!(queue.pop("runtime-a"), NativeInputPopOutcome::Empty);
}

#[test]
fn snapshot_projects_fifo_messages_with_delivery_state() {
    let queue = NativeInputQueue::default();
    assert!(queue.snapshot("runtime-a").is_empty());

    queue
        .enqueue("runtime-a", batch("snap-1", "one"), None)
        .unwrap();
    queue
        .enqueue("runtime-a", batch("snap-2", "two"), None)
        .unwrap();

    let pending = queue.snapshot("runtime-a");
    assert_eq!(
        pending
            .iter()
            .map(|item| (item.client_message_id.as_str(), item.delivery_state))
            .collect::<Vec<_>>(),
        vec![("snap-1", "pending"), ("snap-2", "pending")]
    );
    assert_eq!(pending[0].display_text, "display:one");
    assert_eq!(
        pending[0].images,
        Some(vec![json!({ "mediaType": "image/png", "data": "one" })])
    );
    assert_eq!(
        pending[0].annotations,
        Some(vec![json!({ "quote": "one", "note": "note" })])
    );

    let (_, _, command_id) = claim(&queue, "runtime-a");
    let dispatching = queue.snapshot("runtime-a");
    assert_eq!(dispatching[0].delivery_state, "dispatching");
    assert_eq!(dispatching[1].delivery_state, "pending");

    // An admitted head leaves the snapshot; the persisted user_prompt event
    // takes over its projection from here.
    assert!(queue.confirm_admitted("runtime-a", &command_id).is_some());
    let remaining = queue.snapshot("runtime-a");
    assert_eq!(
        remaining
            .iter()
            .map(|item| item.client_message_id.as_str())
            .collect::<Vec<_>>(),
        vec!["snap-2"]
    );
}
