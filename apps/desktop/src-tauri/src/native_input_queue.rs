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
pub struct FrozenNativeInputMessage {
    client_message_id: String,
    text: String,
    display_text: Option<String>,
    images: Option<Vec<Value>>,
    annotations: Option<Vec<Value>>,
}

impl FrozenNativeInputMessage {
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

    pub fn into_parts(self) -> FrozenNativeInputMessageParts {
        FrozenNativeInputMessageParts {
            client_message_id: self.client_message_id,
            text: self.text,
            display_text: self.display_text,
            images: self.images,
            annotations: self.annotations,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct FrozenNativeInputMessageParts {
    pub client_message_id: String,
    pub text: String,
    pub display_text: Option<String>,
    pub images: Option<Vec<Value>>,
    pub annotations: Option<Vec<Value>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FrozenNativeInputBatch {
    messages: Vec<FrozenNativeInputMessage>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FrozenNativeDispatchParts {
    pub client_message_id: String,
    pub text: String,
    pub display_text: Option<String>,
    pub images: Option<Vec<Value>>,
    pub annotations: Option<Vec<Value>>,
    pub messages: Vec<FrozenNativeInputMessage>,
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
            messages: vec![FrozenNativeInputMessage::new(
                client_message_id,
                text,
                display_text,
                images,
                annotations,
            )],
        }
    }

    pub fn client_message_id(&self) -> &str {
        self.messages
            .first()
            .map(FrozenNativeInputMessage::client_message_id)
            .unwrap_or("")
    }

    pub fn text(&self) -> &str {
        self.messages
            .first()
            .map(FrozenNativeInputMessage::text)
            .unwrap_or("")
    }

    pub fn display_text(&self) -> Option<&str> {
        self.messages
            .first()
            .and_then(FrozenNativeInputMessage::display_text)
    }

    pub fn images(&self) -> Option<&[Value]> {
        self.messages
            .first()
            .and_then(FrozenNativeInputMessage::images)
    }

    pub fn annotations(&self) -> Option<&[Value]> {
        self.messages
            .first()
            .and_then(FrozenNativeInputMessage::annotations)
    }

    pub fn len(&self) -> usize {
        self.messages.len()
    }

    pub fn is_empty(&self) -> bool {
        self.messages.is_empty()
    }

    pub fn contains_client_message_id(&self, client_message_id: &str) -> bool {
        self.messages
            .iter()
            .any(|message| message.client_message_id() == client_message_id)
    }

    pub fn messages(&self) -> &[FrozenNativeInputMessage] {
        &self.messages
    }

    pub fn merge_pending(&mut self, mut other: Self) {
        self.messages.append(&mut other.messages);
    }

    pub fn remove_client_message_id(
        &mut self,
        client_message_id: &str,
    ) -> Option<FrozenNativeInputMessage> {
        let index = self
            .messages
            .iter()
            .position(|message| message.client_message_id() == client_message_id)?;
        Some(self.messages.remove(index))
    }

    pub fn into_dispatch_parts(self) -> FrozenNativeDispatchParts {
        let client_message_id = self.client_message_id().to_owned();
        let text = combine_message_texts(&self.messages, FrozenNativeInputMessage::text);
        let display_text = Some(combine_message_texts(&self.messages, |message| {
            message.display_text().unwrap_or_else(|| message.text())
        }))
        .filter(|value| !value.trim().is_empty());
        let images = flatten_message_values(&self.messages, FrozenNativeInputMessage::images);
        let annotations =
            flatten_message_values(&self.messages, FrozenNativeInputMessage::annotations);
        FrozenNativeDispatchParts {
            client_message_id,
            text,
            display_text,
            images,
            annotations,
            messages: self.messages,
        }
    }
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
    merge_fence: Option<String>,
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

/// Renderer-facing projection of one queued prompt that has not been admitted
/// by the helper yet. `display_text` is the same preview the persisted
/// `user_prompt` event will carry, so a remounted view can rebuild the exact
/// pending row it would otherwise have lost with its local optimistic state.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QueuedNativeInputSnapshotItem {
    pub client_message_id: String,
    pub display_text: String,
    pub images: Option<Vec<Value>>,
    pub annotations: Option<Vec<Value>>,
    pub delivery_state: &'static str,
}

impl QueuedInputDeliveryState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Dispatching => "dispatching",
            Self::DeliveryUncertain => "delivery_uncertain",
        }
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
        merge_fence: Option<&str>,
    ) -> Result<usize, NativeInputQueueError> {
        if runtime_id.trim().is_empty() {
            return Err(NativeInputQueueError::EmptyRuntimeId);
        }
        if batch.is_empty()
            || batch
                .messages()
                .iter()
                .any(|message| message.client_message_id().trim().is_empty())
        {
            return Err(NativeInputQueueError::EmptyClientMessageId);
        }
        let mut queues = self.lock_queues();
        let mut seen = self.lock_seen();
        let runtime_seen = seen.entry(runtime_id.to_owned()).or_default();
        for message in batch.messages() {
            let fingerprint = batch_fingerprint(message);
            if let Some(existing) = runtime_seen.get(message.client_message_id()) {
                return Err(if existing == &fingerprint {
                    NativeInputQueueError::DuplicateClientMessageId
                } else {
                    NativeInputQueueError::ConflictingClientMessageId
                });
            }
        }
        let queue = queues.entry(runtime_id.to_owned()).or_default();
        for message in batch.messages() {
            runtime_seen.insert(
                message.client_message_id().to_owned(),
                batch_fingerprint(message),
            );
        }
        if let Some(merge_fence) = merge_fence {
            if let Some(tail) = queue.back_mut() {
                if tail.delivery_state == QueuedInputDeliveryState::Pending
                    && tail.merge_fence.as_deref() == Some(merge_fence)
                {
                    tail.batch.merge_pending(batch);
                    return Ok(queue.iter().map(|queued| queued.batch.len()).sum());
                }
            }
        }
        queue.push_back(QueuedNativeInput {
            batch,
            merge_fence: merge_fence.map(str::to_owned),
            delivery_state: QueuedInputDeliveryState::Pending,
            dispatch_attempt: 0,
            dispatch_command_id: None,
        });
        Ok(queue.iter().map(|queued| queued.batch.len()).sum())
    }

    pub fn peek(&self, runtime_id: &str) -> Option<QueuedNativeInput> {
        self.lock_queues()
            .get(runtime_id)
            .and_then(|queue| queue.front())
            .cloned()
    }

    /// FIFO-ordered projection of every message still owned by the queue,
    /// including a head that is mid-dispatch or delivery-uncertain: until the
    /// helper proves admission, that prompt has not become a persisted
    /// `user_prompt` and the renderer must keep showing it as queued.
    pub fn snapshot(&self, runtime_id: &str) -> Vec<QueuedNativeInputSnapshotItem> {
        self.lock_queues()
            .get(runtime_id)
            .map(|queue| {
                queue
                    .iter()
                    .flat_map(|queued| {
                        let delivery_state = queued.delivery_state.as_str();
                        queued.batch.messages().iter().map(move |message| {
                            QueuedNativeInputSnapshotItem {
                                client_message_id: message.client_message_id().to_owned(),
                                display_text: message
                                    .display_text()
                                    .unwrap_or_else(|| message.text())
                                    .to_owned(),
                                images: message.images().map(<[Value]>::to_vec),
                                annotations: message.annotations().map(<[Value]>::to_vec),
                                delivery_state,
                            }
                        })
                    })
                    .collect()
            })
            .unwrap_or_default()
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
    pub fn confirm_admitted(
        &self,
        runtime_id: &str,
        dispatch_command_id: &str,
    ) -> Option<QueuedNativeInput> {
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
            return None;
        }
        let queue = queues
            .get_mut(runtime_id)
            .expect("the checked runtime queue still exists");
        let confirmed = queue.pop_front();
        if queue.is_empty() {
            queues.remove(runtime_id);
        }
        confirmed
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
        if !head.batch.contains_client_message_id(client_message_id)
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
        if !head.batch.contains_client_message_id(client_message_id)
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
            .position(|queued| queued.batch.contains_client_message_id(client_message_id))?;
        if !matches!(
            queue[index].delivery_state,
            QueuedInputDeliveryState::Pending
        ) {
            let removed = queue.remove(index);
            if queue.is_empty() {
                queues.remove(runtime_id);
            }
            return removed;
        }
        let queued = queue
            .get_mut(index)
            .expect("located queued batch must still exist");
        let removed_message = queued.batch.remove_client_message_id(client_message_id)?;
        let remove_batch = queued.batch.is_empty();
        let delivery_state = queued.delivery_state;
        let dispatch_attempt = queued.dispatch_attempt;
        let dispatch_command_id = queued.dispatch_command_id.clone();
        let merge_fence = queued.merge_fence.clone();
        if remove_batch {
            queue.remove(index);
        }
        if queue.is_empty() {
            queues.remove(runtime_id);
        }
        Some(QueuedNativeInput {
            batch: FrozenNativeInputBatch {
                messages: vec![removed_message],
            },
            merge_fence,
            delivery_state,
            dispatch_attempt,
            dispatch_command_id,
        })
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
                .find(|queued| queued.batch.contains_client_message_id(client_message_id))
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
        let removed = self.lock_queues().remove(runtime_id).map_or(0, |queue| {
            queue.into_iter().map(|queued| queued.batch.len()).sum()
        });
        self.lock_seen().remove(runtime_id);
        removed
    }

    pub fn count(&self, runtime_id: &str) -> usize {
        self.lock_queues().get(runtime_id).map_or(0, |queue| {
            queue.iter().map(|queued| queued.batch.len()).sum()
        })
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

fn combine_message_texts(
    messages: &[FrozenNativeInputMessage],
    select: impl Fn(&FrozenNativeInputMessage) -> &str,
) -> String {
    let mut iter = messages.iter();
    let Some(first) = iter.next() else {
        return String::new();
    };
    let first_text = select(first).trim().to_string();
    let remaining = iter
        .enumerate()
        .map(|(index, message)| format!("{}. {}", index + 2, select(message).trim()))
        .collect::<Vec<_>>();
    if remaining.is_empty() {
        return first_text;
    }
    [
        first_text,
        String::new(),
        "另外还有这些后续消息，请按顺序继续处理：".to_string(),
        remaining.join("\n\n"),
    ]
    .join("\n")
}

fn flatten_message_values(
    messages: &[FrozenNativeInputMessage],
    select: impl Fn(&FrozenNativeInputMessage) -> Option<&[Value]>,
) -> Option<Vec<Value>> {
    let flattened = messages
        .iter()
        .filter_map(select)
        .flat_map(|values| values.iter().cloned())
        .collect::<Vec<_>>();
    (!flattened.is_empty()).then_some(flattened)
}

fn batch_fingerprint(message: &FrozenNativeInputMessage) -> [u8; 32] {
    let bytes = serde_json::to_vec(message)
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
#[path = "native_input_queue_tests.rs"]
mod tests;
