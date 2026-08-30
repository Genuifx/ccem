//! Process-local FIFO storage for native-session input that cannot be dispatched yet.
//!
//! The queue deliberately has no persistence layer. A queued batch owns a frozen
//! copy of its payload, and a delivery-uncertain head blocks automatic popping so
//! callers cannot accidentally replay a prompt after an ambiguous pipe write.

use rand::RngCore;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::sync::{Mutex, MutexGuard};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FrozenNativeInputBatch {
    client_message_id: String,
    text: String,
    display_text: Option<String>,
    images: Option<Vec<Value>>,
    annotations: Option<Vec<Value>>,
}

impl FrozenNativeInputBatch {
    pub fn new(
        client_message_id: impl Into<String>,
        text: impl Into<String>,
        display_text: Option<String>,
        images: Option<Vec<Value>>,
        annotations: Option<Vec<Value>>,
    ) -> Self {
        Self {
            client_message_id: client_message_id.into(),
            text: text.into(),
            display_text,
            images,
            annotations,
        }
    }

    pub fn client_message_id(&self) -> &str {
        &self.client_message_id
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn display_text(&self) -> Option<&str> {
        self.display_text.as_deref()
    }

    pub fn images(&self) -> Option<&[Value]> {
        self.images.as_deref()
    }

    pub fn annotations(&self) -> Option<&[Value]> {
        self.annotations.as_deref()
    }

    pub fn into_parts(self) -> FrozenNativeInputParts {
        FrozenNativeInputParts {
            client_message_id: self.client_message_id,
            text: self.text,
            display_text: self.display_text,
            images: self.images,
            annotations: self.annotations,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct FrozenNativeInputParts {
    pub client_message_id: String,
    pub text: String,
    pub display_text: Option<String>,
    pub images: Option<Vec<Value>>,
    pub annotations: Option<Vec<Value>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueuedInputDeliveryState {
    Pending,
    Dispatching,
    DeliveryUncertain,
}

#[derive(Debug, Clone, PartialEq)]
pub struct QueuedNativeInput {
    batch: FrozenNativeInputBatch,
    delivery_state: QueuedInputDeliveryState,
    dispatch_attempt: u64,
    dispatch_command_id: Option<String>,
}

impl QueuedNativeInput {
    pub fn batch(&self) -> &FrozenNativeInputBatch {
        &self.batch
    }

    pub fn delivery_state(&self) -> QueuedInputDeliveryState {
        self.delivery_state
    }

    pub fn dispatch_attempt(&self) -> u64 {
        self.dispatch_attempt
    }

    pub fn dispatch_command_id(&self) -> Option<&str> {
        self.dispatch_command_id.as_deref()
    }

    pub fn into_batch(self) -> FrozenNativeInputBatch {
        self.batch
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeInputQueueError {
    EmptyRuntimeId,
    EmptyClientMessageId,
    DuplicateClientMessageId,
    ConflictingClientMessageId,
}

impl fmt::Display for NativeInputQueueError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyRuntimeId => formatter.write_str("runtime_id must not be empty"),
            Self::EmptyClientMessageId => {
                formatter.write_str("client_message_id must not be empty")
            }
            Self::DuplicateClientMessageId => {
                formatter.write_str("client_message_id is already queued for this runtime")
            }
            Self::ConflictingClientMessageId => formatter.write_str(
                "client_message_id was already used for a different native input payload",
            ),
        }
    }
}

impl std::error::Error for NativeInputQueueError {}

#[derive(Debug, Clone, PartialEq)]
pub enum NativeInputPopOutcome {
    Ready(FrozenNativeInputBatch),
    BlockedByDispatching { client_message_id: String },
    BlockedByDeliveryUncertain { client_message_id: String },
    Empty,
}

#[derive(Debug, Clone, PartialEq)]
pub enum NativeInputClaimOutcome {
    Claimed {
        batch: FrozenNativeInputBatch,
        dispatch_attempt: u64,
        dispatch_command_id: String,
    },
    AlreadyDispatching {
        client_message_id: String,
    },
    BlockedByDeliveryUncertain {
        client_message_id: String,
    },
    Empty,
}

#[derive(Debug, Default)]
pub struct NativeInputQueue {
    queues: Mutex<HashMap<String, VecDeque<QueuedNativeInput>>>,
    /// Process-local idempotency ledger. Completed IDs stay here until the
    /// runtime is explicitly cleared, so a renderer retry cannot redispatch a
    /// batch that already left the queue.
    seen_client_message_ids: Mutex<HashMap<String, HashMap<String, [u8; 32]>>>,
}

impl NativeInputQueue {
    pub fn enqueue(
        &self,
        runtime_id: &str,
        batch: FrozenNativeInputBatch,
    ) -> Result<usize, NativeInputQueueError> {
        if runtime_id.trim().is_empty() {
            return Err(NativeInputQueueError::EmptyRuntimeId);
        }
        if batch.client_message_id().trim().is_empty() {
            return Err(NativeInputQueueError::EmptyClientMessageId);
        }

        let fingerprint = batch_fingerprint(&batch);
        let mut queues = self.lock_queues();
        let mut seen = self.lock_seen();
        let runtime_seen = seen.entry(runtime_id.to_owned()).or_default();
        if let Some(existing) = runtime_seen.get(batch.client_message_id()) {
            return Err(if existing == &fingerprint {
                NativeInputQueueError::DuplicateClientMessageId
            } else {
                NativeInputQueueError::ConflictingClientMessageId
            });
        }
        let queue = queues.entry(runtime_id.to_owned()).or_default();
        runtime_seen.insert(batch.client_message_id().to_owned(), fingerprint);
        queue.push_back(QueuedNativeInput {
            batch,
            delivery_state: QueuedInputDeliveryState::Pending,
            dispatch_attempt: 0,
            dispatch_command_id: None,
        });
        Ok(queue.len())
    }

    pub fn peek(&self, runtime_id: &str) -> Option<QueuedNativeInput> {
        self.lock_queues()
            .get(runtime_id)
            .and_then(|queue| queue.front())
            .cloned()
    }

    /// Atomically reserves the FIFO head for one dispatcher without removing
    /// it. The caller must complete, release, or mark the exact claim
    /// uncertain after the pipe-write outcome is known.
    pub fn claim_next(&self, runtime_id: &str) -> NativeInputClaimOutcome {
        let mut queues = self.lock_queues();
        let Some(head) = queues
            .get_mut(runtime_id)
            .and_then(|queue| queue.front_mut())
        else {
            return NativeInputClaimOutcome::Empty;
        };
        match head.delivery_state {
            QueuedInputDeliveryState::Pending => {
                head.delivery_state = QueuedInputDeliveryState::Dispatching;
                head.dispatch_attempt = head.dispatch_attempt.saturating_add(1);
                // The Claude Agent SDK types this wire identity as a UUID and
                // echoes it through command_lifecycle. Keep the stable client
                // message id solely as our idempotency key; each delivery
                // attempt gets a fresh standards-compliant v4 fence.
                let dispatch_command_id = fresh_dispatch_command_id();
                head.dispatch_command_id = Some(dispatch_command_id.clone());
                NativeInputClaimOutcome::Claimed {
                    batch: head.batch.clone(),
                    dispatch_attempt: head.dispatch_attempt,
                    dispatch_command_id,
                }
            }
            QueuedInputDeliveryState::Dispatching => NativeInputClaimOutcome::AlreadyDispatching {
                client_message_id: head.batch.client_message_id().to_owned(),
            },
            QueuedInputDeliveryState::DeliveryUncertain => {
                NativeInputClaimOutcome::BlockedByDeliveryUncertain {
                    client_message_id: head.batch.client_message_id().to_owned(),
                }
            }
        }
    }

    pub fn complete_dispatch(&self, runtime_id: &str, dispatch_command_id: &str) -> bool {
        let mut queues = self.lock_queues();
        let should_remove = queues
            .get(runtime_id)
            .and_then(|queue| queue.front())
            .is_some_and(|head| {
                head.dispatch_command_id.as_deref() == Some(dispatch_command_id)
                    && head.delivery_state == QueuedInputDeliveryState::Dispatching
            });
        if !should_remove {
            return false;
        }
        let queue = queues
            .get_mut(runtime_id)
            .expect("the checked runtime queue still exists");
        queue.pop_front();
        if queue.is_empty() {
            queues.remove(runtime_id);
        }
        true
    }

    /// Removes an exact head after a correlated helper fact proves admission.
    /// A late ACK is allowed to heal a locally timed-out uncertain receipt.
    pub fn confirm_admitted(&self, runtime_id: &str, dispatch_command_id: &str) -> bool {
        let mut queues = self.lock_queues();
        let should_remove = queues
            .get(runtime_id)
            .and_then(|queue| queue.front())
            .is_some_and(|head| {
                head.dispatch_command_id.as_deref() == Some(dispatch_command_id)
                    && matches!(
                        head.delivery_state,
                        QueuedInputDeliveryState::Dispatching
                            | QueuedInputDeliveryState::DeliveryUncertain
                    )
            });
        if !should_remove {
            return false;
        }
        let queue = queues
            .get_mut(runtime_id)
            .expect("the checked runtime queue still exists");
        queue.pop_front();
        if queue.is_empty() {
            queues.remove(runtime_id);
        }
        true
    }

    pub fn release_dispatch(
        &self,
        runtime_id: &str,
        client_message_id: &str,
        dispatch_attempt: u64,
    ) -> bool {
        let mut queues = self.lock_queues();
        let Some(head) = queues
            .get_mut(runtime_id)
            .and_then(|queue| queue.front_mut())
        else {
            return false;
        };
        if head.batch.client_message_id() != client_message_id
            || head.dispatch_attempt != dispatch_attempt
            || head.delivery_state != QueuedInputDeliveryState::Dispatching
        {
            return false;
        }
        head.delivery_state = QueuedInputDeliveryState::Pending;
        head.dispatch_command_id = None;
        true
    }

    /// Restores a definitely-not-written claim while retaining its exact wire
    /// id. An exact Stop racing this transition can therefore discard the
    /// prompt the user targeted instead of flushing it as a fresh attempt.
    pub fn release_not_started(
        &self,
        runtime_id: &str,
        client_message_id: &str,
        dispatch_command_id: &str,
        dispatch_attempt: u64,
    ) -> bool {
        let mut queues = self.lock_queues();
        let Some(head) = queues
            .get_mut(runtime_id)
            .and_then(|queue| queue.front_mut())
        else {
            return false;
        };
        if head.batch.client_message_id() != client_message_id
            || head.dispatch_command_id.as_deref() != Some(dispatch_command_id)
            || head.dispatch_attempt != dispatch_attempt
            || head.delivery_state != QueuedInputDeliveryState::Dispatching
        {
            return false;
        }
        head.delivery_state = QueuedInputDeliveryState::Pending;
        true
    }

    /// Restores an exact head after a correlated helper rejection proves the
    /// prompt did not enter the provider queue. This also heals a local ACK
    /// timeout that raced the rejection receipt.
    pub fn confirm_rejected(&self, runtime_id: &str, dispatch_command_id: &str) -> bool {
        let mut queues = self.lock_queues();
        let Some(head) = queues
            .get_mut(runtime_id)
            .and_then(|queue| queue.front_mut())
        else {
            return false;
        };
        if head.dispatch_command_id.as_deref() != Some(dispatch_command_id)
            || !matches!(
                head.delivery_state,
                QueuedInputDeliveryState::Dispatching | QueuedInputDeliveryState::DeliveryUncertain
            )
        {
            return false;
        }
        head.delivery_state = QueuedInputDeliveryState::Pending;
        head.dispatch_command_id = None;
        true
    }

    /// Pops the next replay-safe batch.
    ///
    /// A delivery-uncertain head is retained and reported as blocked. Only an
    /// explicit `remove` or `clear` may discard it.
    pub fn pop(&self, runtime_id: &str) -> NativeInputPopOutcome {
        let mut queues = self.lock_queues();
        let Some(queue) = queues.get_mut(runtime_id) else {
            return NativeInputPopOutcome::Empty;
        };

        if let Some(head) = queue.front() {
            match head.delivery_state {
                QueuedInputDeliveryState::Pending => {}
                QueuedInputDeliveryState::Dispatching => {
                    return NativeInputPopOutcome::BlockedByDispatching {
                        client_message_id: head.batch.client_message_id().to_owned(),
                    };
                }
                QueuedInputDeliveryState::DeliveryUncertain => {
                    return NativeInputPopOutcome::BlockedByDeliveryUncertain {
                        client_message_id: head.batch.client_message_id().to_owned(),
                    };
                }
            }
        }

        let popped = queue.pop_front().map(QueuedNativeInput::into_batch);
        if queue.is_empty() {
            queues.remove(runtime_id);
        }

        popped
            .map(NativeInputPopOutcome::Ready)
            .unwrap_or(NativeInputPopOutcome::Empty)
    }

    pub fn remove(&self, runtime_id: &str, client_message_id: &str) -> Option<QueuedNativeInput> {
        let mut queues = self.lock_queues();
        let queue = queues.get_mut(runtime_id)?;
        let index = queue
            .iter()
            .position(|queued| queued.batch.client_message_id() == client_message_id)?;
        let removed = queue.remove(index);
        if queue.is_empty() {
            queues.remove(runtime_id);
        }
        removed
    }

    pub fn mark_claim_delivery_uncertain(
        &self,
        runtime_id: &str,
        client_message_id: &str,
        dispatch_attempt: u64,
    ) -> bool {
        let mut queues = self.lock_queues();
        let Some(queued) = queues.get_mut(runtime_id).and_then(|queue| {
            queue
                .iter_mut()
                .find(|queued| queued.batch.client_message_id() == client_message_id)
        }) else {
            return false;
        };

        if queued.dispatch_attempt != dispatch_attempt
            || queued.delivery_state != QueuedInputDeliveryState::Dispatching
        {
            return false;
        }
        queued.delivery_state = QueuedInputDeliveryState::DeliveryUncertain;
        true
    }

    pub fn mark_command_delivery_uncertain(
        &self,
        runtime_id: &str,
        dispatch_command_id: &str,
    ) -> bool {
        let mut queues = self.lock_queues();
        let Some(head) = queues
            .get_mut(runtime_id)
            .and_then(|queue| queue.front_mut())
        else {
            return false;
        };
        if head.dispatch_command_id.as_deref() != Some(dispatch_command_id)
            || head.delivery_state != QueuedInputDeliveryState::Dispatching
        {
            return false;
        }
        head.delivery_state = QueuedInputDeliveryState::DeliveryUncertain;
        true
    }

    pub fn mark_dispatch_delivery_uncertain(
        &self,
        runtime_id: &str,
        dispatch_command_id: &str,
        dispatch_attempt: u64,
    ) -> bool {
        let mut queues = self.lock_queues();
        let Some(head) = queues
            .get_mut(runtime_id)
            .and_then(|queue| queue.front_mut())
        else {
            return false;
        };
        if head.dispatch_command_id.as_deref() != Some(dispatch_command_id)
            || head.dispatch_attempt != dispatch_attempt
            || head.delivery_state != QueuedInputDeliveryState::Dispatching
        {
            return false;
        }
        head.delivery_state = QueuedInputDeliveryState::DeliveryUncertain;
        true
    }

    /// Removes the queue head after an exact-ID user stop. A Pending head is
    /// eligible only when `release_not_started` retained the same wire id;
    /// ordinary replayable Pending entries have no dispatch id.
    pub fn remove_dispatch(
        &self,
        runtime_id: &str,
        dispatch_command_id: &str,
    ) -> Option<QueuedNativeInput> {
        let mut queues = self.lock_queues();
        let queue = queues.get_mut(runtime_id)?;
        let matches = queue.front().is_some_and(|head| {
            head.dispatch_command_id.as_deref() == Some(dispatch_command_id)
                && matches!(
                    head.delivery_state,
                    QueuedInputDeliveryState::Pending
                        | QueuedInputDeliveryState::Dispatching
                        | QueuedInputDeliveryState::DeliveryUncertain
                )
        });
        if !matches {
            return None;
        }
        let removed = queue.pop_front();
        if queue.is_empty() {
            queues.remove(runtime_id);
        }
        removed
    }

    pub fn clear(&self, runtime_id: &str) -> usize {
        let removed = self
            .lock_queues()
            .remove(runtime_id)
            .map_or(0, |queue| queue.len());
        self.lock_seen().remove(runtime_id);
        removed
    }

    pub fn count(&self, runtime_id: &str) -> usize {
        self.lock_queues().get(runtime_id).map_or(0, VecDeque::len)
    }

    pub fn delivery_uncertain_count(&self, runtime_id: &str) -> usize {
        self.lock_queues().get(runtime_id).map_or(0, |queue| {
            queue
                .iter()
                .filter(|queued| {
                    queued.delivery_state == QueuedInputDeliveryState::DeliveryUncertain
                })
                .count()
        })
    }

    fn lock_queues(&self) -> MutexGuard<'_, HashMap<String, VecDeque<QueuedNativeInput>>> {
        self.queues
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lock_seen(&self) -> MutexGuard<'_, HashMap<String, HashMap<String, [u8; 32]>>> {
        self.seen_client_message_ids
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn batch_fingerprint(batch: &FrozenNativeInputBatch) -> [u8; 32] {
    let bytes = serde_json::to_vec(batch)
        .expect("frozen native input contains only JSON-serializable values");
    Sha256::digest(bytes).into()
}

fn fresh_dispatch_command_id() -> String {
    let mut bytes = [0_u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3],
        bytes[4], bytes[5],
        bytes[6], bytes[7],
        bytes[8], bytes[9],
        bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15],
    )
}

#[cfg(test)]
mod tests {
    use super::{
        FrozenNativeInputBatch, NativeInputClaimOutcome, NativeInputPopOutcome, NativeInputQueue,
        NativeInputQueueError, QueuedInputDeliveryState,
    };
    use serde_json::json;

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

    #[test]
    fn queues_are_fifo_and_isolated_per_runtime() {
        let queue = NativeInputQueue::default();
        queue.enqueue("runtime-a", batch("a-1", "one")).unwrap();
        queue.enqueue("runtime-a", batch("a-2", "two")).unwrap();
        queue.enqueue("runtime-b", batch("b-1", "other")).unwrap();

        assert_eq!(queue.count("runtime-a"), 2);
        assert_eq!(queue.count("runtime-b"), 1);
        assert_eq!(queue.peek("runtime-a").unwrap().batch().text(), "one");

        let NativeInputPopOutcome::Ready(first) = queue.pop("runtime-a") else {
            panic!("expected first queued batch");
        };
        let NativeInputPopOutcome::Ready(second) = queue.pop("runtime-a") else {
            panic!("expected second queued batch");
        };
        assert_eq!(first.client_message_id(), "a-1");
        assert_eq!(second.client_message_id(), "a-2");
        assert_eq!(queue.count("runtime-b"), 1);
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
            .enqueue("runtime-a", batch("stable-id", "one"))
            .unwrap();

        assert_eq!(
            queue.enqueue("runtime-a", batch("stable-id", "retry")),
            Err(NativeInputQueueError::ConflictingClientMessageId)
        );
        assert_eq!(
            queue.enqueue("runtime-a", batch("stable-id", "one")),
            Err(NativeInputQueueError::DuplicateClientMessageId)
        );
        assert_eq!(
            queue.enqueue("runtime-b", batch("stable-id", "other")),
            Ok(1)
        );

        assert!(matches!(
            queue.pop("runtime-a"),
            NativeInputPopOutcome::Ready(_)
        ));
        assert_eq!(
            queue.enqueue("runtime-a", batch("stable-id", "completed retry")),
            Err(NativeInputQueueError::ConflictingClientMessageId)
        );
        assert_eq!(
            queue.enqueue("runtime-a", batch("stable-id", "one")),
            Err(NativeInputQueueError::DuplicateClientMessageId)
        );
    }

    #[test]
    fn delivery_uncertain_head_cannot_be_automatically_popped() {
        let queue = NativeInputQueue::default();
        queue
            .enqueue("runtime-a", batch("message-1", "one"))
            .unwrap();
        queue
            .enqueue("runtime-a", batch("message-2", "two"))
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
        assert_eq!(removed.batch().client_message_id(), "message-1");
        assert!(matches!(
            queue.pop("runtime-a"),
            NativeInputPopOutcome::Ready(batch) if batch.client_message_id() == "message-2"
        ));
    }

    #[test]
    fn claim_is_single_owner_until_completed_released_or_uncertain() {
        let queue = NativeInputQueue::default();
        queue
            .enqueue("runtime-a", batch("message-1", "one"))
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
            .enqueue("runtime-a", batch("message-1", "one"))
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
            .enqueue("runtime-a", batch("admitted", "one"))
            .unwrap();
        let (_, admitted_attempt, admitted_command) = claim(&queue, "runtime-a");
        assert!(queue.mark_dispatch_delivery_uncertain(
            "runtime-a",
            &admitted_command,
            admitted_attempt
        ));
        assert!(queue.confirm_admitted("runtime-a", &admitted_command));
        assert_eq!(queue.count("runtime-a"), 0);

        queue
            .enqueue("runtime-a", batch("rejected", "two"))
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
        assert!(!queue.confirm_admitted("runtime-a", &rejected_command));
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
        queue.enqueue("runtime-a", batch("a-1", "one")).unwrap();
        queue.enqueue("runtime-a", batch("a-2", "two")).unwrap();
        queue.enqueue("runtime-a", batch("a-3", "three")).unwrap();
        queue.enqueue("runtime-b", batch("b-1", "other")).unwrap();

        assert_eq!(
            queue
                .remove("runtime-a", "a-2")
                .unwrap()
                .batch()
                .client_message_id(),
            "a-2"
        );
        assert!(matches!(
            queue.pop("runtime-a"),
            NativeInputPopOutcome::Ready(batch) if batch.client_message_id() == "a-1"
        ));
        assert!(matches!(
            queue.pop("runtime-a"),
            NativeInputPopOutcome::Ready(batch) if batch.client_message_id() == "a-3"
        ));
        assert_eq!(queue.clear("runtime-a"), 0);
        assert_eq!(queue.clear("runtime-b"), 1);
        assert_eq!(queue.count("runtime-b"), 0);
    }

    #[test]
    fn exact_dispatch_removal_only_discards_the_claimed_head() {
        let queue = NativeInputQueue::default();
        queue.enqueue("runtime-a", batch("a-1", "one")).unwrap();
        queue.enqueue("runtime-a", batch("a-2", "two")).unwrap();
        let (_, _, command_id) = claim(&queue, "runtime-a");

        assert!(queue.remove_dispatch("runtime-a", "foreign").is_none());
        let removed = queue
            .remove_dispatch("runtime-a", &command_id)
            .expect("exact dispatch removed");
        assert_eq!(removed.batch().client_message_id(), "a-1");
        assert_eq!(
            queue.peek("runtime-a").unwrap().batch().client_message_id(),
            "a-2"
        );
    }

    #[test]
    fn exact_stop_can_remove_a_not_started_claim_after_it_returns_to_pending() {
        let queue = NativeInputQueue::default();
        queue.enqueue("runtime-a", batch("a-1", "one")).unwrap();
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
            queue.enqueue(" ", batch("message-1", "one")),
            Err(NativeInputQueueError::EmptyRuntimeId)
        );
        assert_eq!(
            queue.enqueue("runtime-a", batch(" ", "one")),
            Err(NativeInputQueueError::EmptyClientMessageId)
        );
        assert!(!queue.mark_claim_delivery_uncertain("runtime-a", "missing", 1));
        assert!(!queue.mark_command_delivery_uncertain("runtime-a", "missing"));
        assert_eq!(queue.remove("runtime-a", "missing"), None);
        assert_eq!(queue.pop("runtime-a"), NativeInputPopOutcome::Empty);
    }
}
