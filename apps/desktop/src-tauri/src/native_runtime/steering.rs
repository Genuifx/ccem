use super::*;
use crate::native_session_coordinator::SteerState;

#[cfg(test)]
#[path = "steering_tests.rs"]
mod tests;

impl NativeRuntimeManager {
    pub fn steer_queued_input(
        self: &Arc<Self>,
        app: &AppHandle,
        runtime_id: &str,
        expected_command_id: &str,
    ) -> Result<String, String> {
        self.reject_query_mutation_during_transition(runtime_id, "steer a prompt")?;
        let handle = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native handles")?
            .get(runtime_id)
            .cloned();
        let Some(handle) = handle else {
            return Ok("fallback".into());
        };
        let outcome = self.steer_queued_with(
            runtime_id,
            handle.generation,
            expected_command_id,
            |command| self.write_to_live_child_outcome(&handle, command),
        );
        // A terminal can arrive while a claim is held or rejected. Recheck the
        // normal FIFO after releasing it so that wakeup is not lost.
        if outcome.is_ok() {
            self.maybe_dispatch_queued(app, runtime_id, QueueDispatchTrigger::VisibleUserAction)?;
        }
        outcome
    }

    fn steer_queued_with(
        self: &Arc<Self>,
        runtime_id: &str,
        incarnation: u64,
        expected_command_id: &str,
        deliver: impl FnOnce(&HelperInputCommand<'_>) -> LiveWriteOutcome,
    ) -> Result<String, String> {
        let (batch, attempt, command_id) = match self.input_queue.claim_next(runtime_id) {
            NativeInputClaimOutcome::Claimed {
                batch,
                dispatch_attempt,
                dispatch_command_id,
            } => (batch, dispatch_attempt, dispatch_command_id),
            _ => return Ok("unchanged".into()),
        };
        let client_id = batch.client_message_id().to_owned();
        let release = || {
            self.input_queue
                .release_dispatch(runtime_id, &client_id, attempt);
            self.lifecycle.note_queue_changed(runtime_id);
        };
        if batch
            .messages()
            .iter()
            .any(|m| m.text().trim_start().starts_with('/'))
        {
            release();
            return Ok("fallback".into());
        }
        let fence = match self.lifecycle.reserve_steer(
            runtime_id,
            incarnation,
            expected_command_id,
            &command_id,
        ) {
            Ok(fence) => fence,
            Err(outcome) => {
                release();
                return Ok(outcome.into());
            }
        };
        self.lifecycle.note_queue_changed(runtime_id);
        let client_ids: Vec<_> = batch
            .messages()
            .iter()
            .map(|m| m.client_message_id().to_owned())
            .collect();
        let parts = batch.into_dispatch_parts();
        let command = HelperInputCommand::SteerPrompt {
            command_id: &command_id,
            expected_command_id: &fence.parent_command_id,
            expected_query_generation: fence.query_generation,
            text: &parts.text,
            images: parts.images.as_deref(),
            client_message_ids: &client_ids,
        };
        let timeout = match deliver(&command) {
            LiveWriteOutcome::Written => COMMAND_ADMISSION_ACK_WAIT,
            LiveWriteOutcome::NotStarted(_) => {
                self.lifecycle.note_steer_receipt(
                    runtime_id,
                    incarnation,
                    &command_id,
                    fence.query_generation,
                    false,
                );
                self.input_queue.confirm_rejected(runtime_id, &command_id);
                Duration::ZERO
            }
            LiveWriteOutcome::StartedUnknown(_) => Duration::ZERO,
        };
        let state = self
            .lifecycle
            .wait_for_steer(runtime_id, &command_id, timeout);
        match state {
            SteerState::Accepted => Ok("injected".into()),
            SteerState::Rejected => {
                // Safe even if the exact rejection was already projected.
                self.input_queue.confirm_rejected(runtime_id, &command_id);
                self.lifecycle.note_queue_changed(runtime_id);
                Ok(
                    if self.lifecycle.steer_parent_is_active(runtime_id, &fence) {
                        "fallback"
                    } else {
                        "unchanged"
                    }
                    .into(),
                )
            }
            SteerState::Pending | SteerState::Uncertain => {
                self.input_queue
                    .mark_command_delivery_uncertain(runtime_id, &command_id);
                self.lifecycle.note_queue_changed(runtime_id);
                Err("DELIVERY_UNCERTAIN: steer may have reached Claude; automatic interrupt and replay are disabled".into())
            }
        }
    }
}
