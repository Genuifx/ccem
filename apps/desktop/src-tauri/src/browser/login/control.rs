use super::execution_fence::{
    EffectWritePermit, ExecutionFence, FenceUnavailable, OwnerExecutionPermit,
};
use super::policy::BrowserGrantBinding;
use std::fmt;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

const DEFAULT_OWNER_ACK_TIMEOUT: Duration = Duration::from_millis(250);

/// An explicit, trusted handoff from the CCEM session registry to Login Browser.
///
/// It deliberately does not implement `Deserialize`: workspace/profile/session/epoch authority
/// cannot be supplied by an Agent command or page payload.
#[derive(Debug, Clone)]
pub(super) struct HandoffGrant {
    binding: BrowserGrantBinding,
}

impl HandoffGrant {
    pub(super) fn new_trusted(binding: BrowserGrantBinding) -> Self {
        Self { binding }
    }

    pub(super) fn binding(&self) -> &BrowserGrantBinding {
        &self.binding
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ControlErrorCode {
    NoActiveHandoff,
    GrantBindingMismatch,
    HandoffEpochMismatch,
    AgentControlPaused,
    AuditDegraded,
    OwnerQuiescenceTimedOut,
    StateUnavailable,
}

impl ControlErrorCode {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::NoActiveHandoff => "no_active_handoff",
            Self::GrantBindingMismatch => "grant_binding_mismatch",
            Self::HandoffEpochMismatch => "handoff_epoch_mismatch",
            Self::AgentControlPaused => "agent_control_paused",
            Self::AuditDegraded => "audit_degraded",
            Self::OwnerQuiescenceTimedOut => "owner_quiescence_timed_out",
            Self::StateUnavailable => "state_unavailable",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ControlError {
    pub(super) code: ControlErrorCode,
    message: &'static str,
}

impl ControlError {
    fn new(code: ControlErrorCode, message: &'static str) -> Self {
        Self { code, message }
    }
}

impl fmt::Display for ControlError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for ControlError {}

#[derive(Debug)]
struct CancellationState {
    fence: Arc<ExecutionFence>,
    wait_lock: Mutex<()>,
    wake: Condvar,
}

impl CancellationState {
    fn new() -> Self {
        Self {
            fence: Arc::new(ExecutionFence::new()),
            wait_lock: Mutex::new(()),
            wake: Condvar::new(),
        }
    }

    fn capture(self: &Arc<Self>) -> OperationCancellation {
        OperationCancellation {
            state: Arc::clone(self),
            generation: self.fence.capture_generation(),
        }
    }

    fn cancel(&self) -> RetiredOperationEpoch {
        let retired = self.fence.retire_current();
        self.wake.notify_all();
        RetiredOperationEpoch {
            generation: retired,
        }
    }

    fn wait_for_quiescence(
        &self,
        retired: &RetiredOperationEpoch,
        maximum_wait: Duration,
    ) -> Result<(), ControlError> {
        self.fence
            .wait_for_retired_timeout(retired.generation, maximum_wait)
            .map_err(|_| {
                ControlError::new(
                    ControlErrorCode::OwnerQuiescenceTimedOut,
                    "Login Browser protocol owner did not acknowledge cancellation before the fixed deadline.",
                )
            })
    }

    fn cancel_and_wait(&self, maximum_wait: Duration) -> Result<(), ControlError> {
        let retired = self.cancel();
        self.wait_for_quiescence(&retired, maximum_wait)
    }
}

/// Opaque proof that the prior operation epoch was retired before a control transition became
/// visible. Only trusted session code can wait on it; an Agent or page cannot manufacture one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct RetiredOperationEpoch {
    generation: u64,
}

/// Cooperative cancellation signal passed to every semantic backend operation.
///
/// `wait_cancelled` is backed by a condition variable, so pause/revoke/cancel wakes active waits
/// immediately rather than relying on a multi-second polling interval.
#[derive(Debug, Clone)]
pub(super) struct OperationCancellation {
    state: Arc<CancellationState>,
    generation: u64,
}

impl OperationCancellation {
    pub(super) fn is_cancelled(&self) -> bool {
        !self.state.fence.is_current(self.generation)
    }

    pub(super) fn enter_owner_execution(&self) -> Result<OwnerExecutionPermit, FenceUnavailable> {
        self.state.fence.enter_owner(self.generation)
    }

    pub(super) fn enter_effect_write(&self) -> Result<EffectWritePermit, FenceUnavailable> {
        self.state.fence.enter_effect(self.generation)
    }

    pub(super) fn wait_cancelled(&self, maximum_wait: Duration) -> bool {
        if self.is_cancelled() {
            return true;
        }
        let guard = match self.state.wait_lock.lock() {
            Ok(guard) => guard,
            Err(_) => return true,
        };
        if self.is_cancelled() {
            return true;
        }
        match self
            .state
            .wake
            .wait_timeout_while(guard, maximum_wait, |_| !self.is_cancelled())
        {
            Ok(_) => self.is_cancelled(),
            Err(_) => true,
        }
    }
}

#[derive(Debug)]
struct ControlState {
    active_handoff: Option<HandoffGrant>,
    last_handoff_binding: Option<BrowserGrantBinding>,
    paused: bool,
    audit_degraded: bool,
}

/// The control boundary is split into two calls so the service can enforce the global authority
/// order: grant first, permission second, pause/cancel third.
pub(super) trait HandoffControl: Send + Sync {
    fn validate_grant(&self, binding: &BrowserGrantBinding) -> Result<(), ControlError>;

    fn begin_operation(
        &self,
        binding: &BrowserGrantBinding,
        write_capability: bool,
    ) -> Result<OperationCancellation, ControlError>;

    fn mark_audit_degraded(&self);
}

#[derive(Debug)]
pub(super) struct LoginBrowserControl {
    state: Mutex<ControlState>,
    cancellation: Arc<CancellationState>,
}

impl LoginBrowserControl {
    pub(super) fn new() -> Self {
        Self {
            state: Mutex::new(ControlState {
                active_handoff: None,
                last_handoff_binding: None,
                paused: false,
                audit_degraded: false,
            }),
            cancellation: Arc::new(CancellationState::new()),
        }
    }

    pub(super) fn activate_handoff(&self, grant: HandoffGrant) -> Result<(), ControlError> {
        let mut state = self.lock_state()?;
        if let Some(previous) = state.last_handoff_binding.as_ref() {
            let incoming = grant.binding();
            if same_identity(previous, incoming)
                && incoming.handoff_epoch() <= previous.handoff_epoch()
            {
                return Err(ControlError::new(
                    ControlErrorCode::HandoffEpochMismatch,
                    "Login Browser handoff epoch must advance before authority is restored.",
                ));
            }
        }
        state.last_handoff_binding = Some(grant.binding().clone());
        state.active_handoff = Some(grant);
        state.paused = false;
        state.audit_degraded = false;
        // Keep the lock held while invalidating old tokens: a new operation can only capture the
        // post-activation generation after it observes the new grant.
        self.cancellation
            .cancel_and_wait(DEFAULT_OWNER_ACK_TIMEOUT)?;
        Ok(())
    }

    pub(super) fn revoke_handoff(&self) -> Result<RetiredOperationEpoch, ControlError> {
        let mut state = self.lock_state()?;
        state.active_handoff = None;
        state.paused = true;
        Ok(self.cancellation.cancel())
    }

    pub(super) fn set_paused(&self, paused: bool) -> Result<(), ControlError> {
        let mut state = self.lock_state()?;
        state.paused = paused;
        if paused {
            self.cancellation
                .cancel_and_wait(DEFAULT_OWNER_ACK_TIMEOUT)?;
        }
        Ok(())
    }

    /// Retire the active operation epoch and require bounded owner acknowledgement. Production
    /// permission changes must inspect this result so a stuck CDP writer can trigger the exact
    /// verified-domain emergency stop instead of being silently ignored.
    pub(super) fn cancel_active_and_wait(&self) -> Result<(), ControlError> {
        self.cancellation.cancel_and_wait(DEFAULT_OWNER_ACK_TIMEOUT)
    }

    #[cfg(test)]
    pub(super) fn cancel_active(&self) {
        let _ = self.cancel_active_and_wait();
    }

    pub(super) fn wait_for_quiescence(
        &self,
        retired: &RetiredOperationEpoch,
        maximum_wait: Duration,
    ) -> Result<(), ControlError> {
        self.cancellation.wait_for_quiescence(retired, maximum_wait)
    }

    pub(super) fn is_audit_degraded(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.audit_degraded)
            .unwrap_or(true)
    }

    fn lock_state(&self) -> Result<std::sync::MutexGuard<'_, ControlState>, ControlError> {
        self.state.lock().map_err(|_| {
            ControlError::new(
                ControlErrorCode::StateUnavailable,
                "Login Browser control state is unavailable.",
            )
        })
    }
}

impl Default for LoginBrowserControl {
    fn default() -> Self {
        Self::new()
    }
}

impl HandoffControl for LoginBrowserControl {
    fn validate_grant(&self, binding: &BrowserGrantBinding) -> Result<(), ControlError> {
        let state = self.lock_state()?;
        validate_active_binding(&state, binding)
    }

    fn begin_operation(
        &self,
        binding: &BrowserGrantBinding,
        write_capability: bool,
    ) -> Result<OperationCancellation, ControlError> {
        let state = self.lock_state()?;
        // Repeat the binding check to close the race between grant and permission evaluation.
        validate_active_binding(&state, binding)?;
        if state.paused {
            return Err(ControlError::new(
                ControlErrorCode::AgentControlPaused,
                "Login Browser Agent control is paused.",
            ));
        }
        if write_capability && state.audit_degraded {
            return Err(ControlError::new(
                ControlErrorCode::AuditDegraded,
                "Login Browser write capability is blocked while audit is degraded.",
            ));
        }
        Ok(self.cancellation.capture())
    }

    fn mark_audit_degraded(&self) {
        // Poison is itself a fail-closed state. Recover only to persist the degraded bit and cancel
        // in-flight effects; all ordinary reads of a poisoned state still fail closed.
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.audit_degraded = true;
        let _ = self.cancellation.cancel_and_wait(DEFAULT_OWNER_ACK_TIMEOUT);
    }
}

fn validate_active_binding(
    state: &ControlState,
    binding: &BrowserGrantBinding,
) -> Result<(), ControlError> {
    let Some(active) = state.active_handoff.as_ref() else {
        return Err(ControlError::new(
            ControlErrorCode::NoActiveHandoff,
            "No active Login Browser handoff exists.",
        ));
    };
    let active = active.binding();
    if !same_identity(active, binding) {
        return Err(ControlError::new(
            ControlErrorCode::GrantBindingMismatch,
            "Login Browser handoff binding does not match the active session.",
        ));
    }
    if active.handoff_epoch() != binding.handoff_epoch() {
        return Err(ControlError::new(
            ControlErrorCode::HandoffEpochMismatch,
            "Login Browser handoff epoch is stale.",
        ));
    }
    Ok(())
}

fn same_identity(left: &BrowserGrantBinding, right: &BrowserGrantBinding) -> bool {
    left.workspace_identity() == right.workspace_identity()
        && left.profile_id() == right.profile_id()
        && left.session_id() == right.session_id()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Instant;

    fn binding(session: &str, epoch: u64) -> BrowserGrantBinding {
        BrowserGrantBinding::new_trusted("workspace-a", "profile-a", session, epoch)
            .expect("trusted binding")
    }

    #[test]
    fn handoff_is_bound_to_workspace_profile_session_and_epoch() {
        let control = LoginBrowserControl::new();
        control
            .activate_handoff(HandoffGrant::new_trusted(binding("session-a", 7)))
            .expect("activate handoff");

        assert!(control.validate_grant(&binding("session-a", 7)).is_ok());
        assert_eq!(
            control
                .validate_grant(&binding("session-b", 7))
                .expect_err("wrong session")
                .code,
            ControlErrorCode::GrantBindingMismatch
        );
        assert_eq!(
            control
                .validate_grant(&binding("session-a", 6))
                .expect_err("stale epoch")
                .code,
            ControlErrorCode::HandoffEpochMismatch
        );
    }

    #[test]
    fn pause_cancels_active_wait_well_under_one_second() {
        let control = Arc::new(LoginBrowserControl::new());
        let current = binding("session-a", 1);
        control
            .activate_handoff(HandoffGrant::new_trusted(current.clone()))
            .expect("activate");
        let token = control
            .begin_operation(&current, true)
            .expect("begin operation");
        let owner = token.enter_owner_execution().expect("owner entered");
        let (ready_tx, ready_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let pausing_control = Arc::clone(&control);
        std::thread::spawn(move || {
            ready_tx.send(()).expect("ready");
            let started = Instant::now();
            let result = pausing_control.set_paused(true);
            done_tx.send((result, started.elapsed())).expect("done");
        });
        ready_rx.recv().expect("waiter ready");
        assert!(token.wait_cancelled(Duration::from_secs(1)));
        // The protocol owner acknowledges only after it has observed the retired epoch.
        drop(owner);
        let (result, elapsed) = done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("pause acknowledged");
        result.expect("pause");
        assert!(elapsed < Duration::from_secs(1), "elapsed: {elapsed:?}");
        assert_eq!(
            control
                .begin_operation(&current, true)
                .expect_err("paused gate")
                .code,
            ControlErrorCode::AgentControlPaused
        );
    }

    #[test]
    fn revoke_has_a_bounded_owner_acknowledgement_and_keeps_effects_fenced() {
        let control = LoginBrowserControl::new();
        let current = binding("session-a", 1);
        control
            .activate_handoff(HandoffGrant::new_trusted(current.clone()))
            .expect("activate");
        let token = control
            .begin_operation(&current, true)
            .expect("begin operation");
        let owner = token.enter_owner_execution().expect("owner entered");

        let retired = control.revoke_handoff().expect("authority revoked");
        let started = Instant::now();
        let error = control
            .wait_for_quiescence(&retired, Duration::from_millis(25))
            .expect_err("stuck owner must hit the fixed deadline");
        assert_eq!(error.code, ControlErrorCode::OwnerQuiescenceTimedOut);
        assert!(started.elapsed() < Duration::from_millis(250));
        assert!(
            token.enter_effect_write().is_err(),
            "the retired epoch must remain unable to emit an effect after timeout"
        );

        drop(owner);
        control
            .wait_for_quiescence(&retired, Duration::from_millis(25))
            .expect("owner eventually acknowledged retirement");
    }

    #[test]
    fn generic_cancellation_cannot_hang_on_an_uncooperative_owner() {
        let control = LoginBrowserControl::new();
        let current = binding("session-a", 1);
        control
            .activate_handoff(HandoffGrant::new_trusted(current.clone()))
            .expect("activate");
        let token = control
            .begin_operation(&current, true)
            .expect("begin operation");
        let owner = token.enter_owner_execution().expect("owner entered");
        let started = Instant::now();

        control.cancel_active();

        assert!(
            started.elapsed() < Duration::from_secs(1),
            "generic cancellation exceeded the trusted UI deadline: {:?}",
            started.elapsed()
        );
        assert!(token.enter_effect_write().is_err());
        drop(owner);
    }

    #[test]
    fn audit_degradation_blocks_writes_but_preserves_read_diagnostics() {
        let control = LoginBrowserControl::new();
        let current = binding("session-a", 1);
        control
            .activate_handoff(HandoffGrant::new_trusted(current.clone()))
            .expect("activate");
        control.mark_audit_degraded();

        assert!(control.is_audit_degraded());
        assert_eq!(
            control
                .begin_operation(&current, true)
                .expect_err("write blocked")
                .code,
            ControlErrorCode::AuditDegraded
        );
        assert!(control.begin_operation(&current, false).is_ok());
        assert_eq!(
            control
                .activate_handoff(HandoffGrant::new_trusted(current.clone()))
                .expect_err("same epoch cannot clear degradation")
                .code,
            ControlErrorCode::HandoffEpochMismatch
        );
        assert!(control.is_audit_degraded());
        control
            .activate_handoff(HandoffGrant::new_trusted(binding("session-a", 2)))
            .expect("new epoch restores authority");
        assert!(!control.is_audit_degraded());
    }

    #[test]
    fn revoke_invalidates_grant_and_active_token() {
        let control = LoginBrowserControl::new();
        let current = binding("session-a", 1);
        control
            .activate_handoff(HandoffGrant::new_trusted(current.clone()))
            .expect("activate");
        let token = control
            .begin_operation(&current, true)
            .expect("begin operation");
        control.revoke_handoff().expect("revoke");
        assert!(token.is_cancelled());
        assert_eq!(
            control
                .validate_grant(&current)
                .expect_err("grant revoked")
                .code,
            ControlErrorCode::NoActiveHandoff
        );
    }
}
