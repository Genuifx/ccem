use super::*;

#[cfg(test)]
#[path = "steer_tests.rs"]
mod tests;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SteerState {
    Pending,
    Accepted,
    Rejected,
    Uncertain,
}

#[derive(Debug, Clone)]
pub struct SteerFence {
    pub command_id: String,
    pub parent_command_id: String,
    pub helper_incarnation: u64,
    pub query_generation: u64,
}

#[derive(Debug)]
pub(super) struct SteerAdmission {
    fence: SteerFence,
    state: SteerState,
    waiter_finished: bool,
}

impl NativeSessionCoordinator {
    /// A steer is an input attached to the foreground, never a second owner.
    /// Only explicit, replay-safe unavailability asks the caller to interrupt.
    pub fn reserve_steer(
        &self,
        runtime_id: &str,
        incarnation: u64,
        expected_parent: &str,
        command_id: &str,
    ) -> Result<SteerFence, &'static str> {
        let mut inner = self.lock_inner();
        let c = Self::coordination_mut(&mut inner, runtime_id);
        // A retired helper cannot ACK a new incarnation. Its uncertain input
        // stays in the FIFO until explicitly discarded; only the receipt lane
        // can be reused, after the original caller has observed its outcome.
        if c.steer.as_ref().is_some_and(|s| {
            !s.waiter_finished
                || (s.fence.helper_incarnation == incarnation
                    && matches!(s.state, SteerState::Pending | SteerState::Uncertain))
        }) {
            return Err("unchanged");
        }
        let Some(active) = c.active.as_ref() else {
            return Err("unchanged");
        };
        if active.command_id != expected_parent || c.incarnation != Some(incarnation) {
            return Err("unchanged");
        }
        if c.adapter != AdapterKind::FullLifecycle
            || !c.capabilities.iter().any(|v| v == "ccem_steer_v1")
        {
            return Err("fallback");
        }
        if !matches!(
            active.phase,
            CommandPhase::SdkQueued | CommandPhase::SdkStarted
        ) || c
            .pending_settings
            .as_ref()
            .is_some_and(|v| v.state.blocks_dispatch())
            || c.pending_permission_settings
                .as_ref()
                .is_some_and(|v| v.state.blocks_dispatch())
        {
            return Err("fallback");
        }
        let Some(generation) = active.query_generation else {
            return Err("fallback");
        };
        let fence = SteerFence {
            command_id: command_id.into(),
            parent_command_id: expected_parent.into(),
            helper_incarnation: incarnation,
            query_generation: generation,
        };
        c.steer = Some(SteerAdmission {
            fence: fence.clone(),
            state: SteerState::Pending,
            waiter_finished: false,
        });
        c.bump();
        Ok(fence)
    }

    pub fn note_steer_receipt(
        &self,
        runtime_id: &str,
        incarnation: u64,
        command_id: &str,
        generation: u64,
        accepted: bool,
    ) -> LifecycleDecision {
        let mut inner = self.lock_inner();
        let Some(c) = inner.get_mut(runtime_id) else {
            return LifecycleDecision::Ignored;
        };
        if c.incarnation != Some(incarnation) {
            return LifecycleDecision::Ignored;
        }
        let Some(s) = c.steer.as_mut() else {
            return LifecycleDecision::Ignored;
        };
        if s.fence.command_id != command_id
            || s.fence.helper_incarnation != incarnation
            || s.fence.query_generation != generation
            || !matches!(s.state, SteerState::Pending | SteerState::Uncertain)
        {
            return LifecycleDecision::Ignored;
        }
        s.state = if accepted {
            SteerState::Accepted
        } else {
            SteerState::Rejected
        };
        c.bump();
        self.steer_signal.notify_all();
        LifecycleDecision::Updated
    }

    pub fn wait_for_steer(
        &self,
        runtime_id: &str,
        command_id: &str,
        timeout: Duration,
    ) -> SteerState {
        let deadline = Instant::now() + timeout;
        let mut inner = self.lock_inner();
        loop {
            let Some(s) = inner
                .get_mut(runtime_id)
                .and_then(|c| c.steer.as_mut())
                .filter(|s| s.fence.command_id == command_id)
            else {
                return SteerState::Uncertain;
            };
            if s.state != SteerState::Pending {
                s.waiter_finished = true;
                return s.state;
            }
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                s.state = SteerState::Uncertain;
                s.waiter_finished = true;
                return SteerState::Uncertain;
            };
            inner = self
                .steer_signal
                .wait_timeout(inner, remaining)
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
    }

    pub fn steer_parent_is_active(&self, runtime_id: &str, fence: &SteerFence) -> bool {
        self.lock_inner().get(runtime_id).is_some_and(|c| {
            c.active.as_ref().is_some_and(|a| {
                a.command_id == fence.parent_command_id
                    && a.helper_incarnation == fence.helper_incarnation
            })
        })
    }
}
