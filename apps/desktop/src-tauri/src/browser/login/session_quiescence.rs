use super::control::{ControlErrorCode, LoginBrowserControl};
use super::session::SessionManagerError;
use super::session_backend::SessionOwnedBackend;
use super::session_policy::SessionNavigationPolicy;
use std::time::Duration;

const OWNER_FENCE_ACK_TIMEOUT: Duration = Duration::from_millis(200);

/// Retire Agent authority first, then prove that the protocol owner no longer holds the retired
/// execution epoch. A stuck owner is signalled through the exact identity-bound emergency handle;
/// the retired fence continues to reject every late write even if cleanup finishes asynchronously.
pub(super) fn revoke_and_acknowledge_owner(
    backend: &dyn SessionOwnedBackend,
    control: &LoginBrowserControl,
) -> Result<(), SessionManagerError> {
    let retired = match control.revoke_handoff() {
        Ok(retired) => retired,
        Err(_) => {
            return Err(force_after_failure(
                backend,
                SessionManagerError::ControlUnavailable,
            ))
        }
    };
    match control.wait_for_quiescence(&retired, OWNER_FENCE_ACK_TIMEOUT) {
        Ok(()) => Ok(()),
        Err(error) => {
            let mapped = if error.code == ControlErrorCode::OwnerQuiescenceTimedOut {
                SessionManagerError::OwnerQuiescenceTimedOut
            } else {
                SessionManagerError::ControlUnavailable
            };
            Err(force_after_failure(backend, mapped))
        }
    }
}

/// Enter manual user control only inside an acknowledged owner event-loop barrier.
pub(super) fn enter_user_control(
    backend: &dyn SessionOwnedBackend,
    policy: &SessionNavigationPolicy,
) -> Result<(), SessionManagerError> {
    if let Err(error) = backend.stop_diagnostic_segment() {
        return Err(force_after_failure(backend, error));
    }
    backend
        .with_navigation_policy_quiesced(&mut || policy.resume_user_control())
        .map_err(|error| force_after_failure(backend, error))
}

/// Prove that no idle/event handler spans the pause-return boundary. The policy stays paused.
pub(super) fn acknowledge_paused_owner(
    backend: &dyn SessionOwnedBackend,
) -> Result<(), SessionManagerError> {
    backend
        .stop_diagnostic_segment()
        .map_err(|error| force_after_failure(backend, error))
}

fn force_after_failure(
    backend: &dyn SessionOwnedBackend,
    error: SessionManagerError,
) -> SessionManagerError {
    if backend.emergency_stop_verified_domain().is_ok() {
        error
    } else {
        SessionManagerError::RuntimeUnavailable
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::login::backend::{
        BackendFailure, BackendFailureCode, SemanticBrowserBackend, SemanticBrowserCommand,
        SemanticBrowserResult,
    };
    use crate::browser::login::control::{HandoffControl, HandoffGrant, OperationCancellation};
    use crate::browser::login::policy::BrowserGrantBinding;
    use crate::browser::login::session_backend::SessionBackendProjection;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Instant;

    #[derive(Default)]
    struct StuckBackend {
        emergency_stops: AtomicUsize,
    }

    impl SemanticBrowserBackend for StuckBackend {
        fn execute(
            &self,
            _command: &SemanticBrowserCommand,
            _cancellation: &OperationCancellation,
        ) -> Result<SemanticBrowserResult, BackendFailure> {
            Err(BackendFailure::new(
                BackendFailureCode::RuntimeUnavailable,
                "stuck owner fixture",
            ))
        }
    }

    impl SessionOwnedBackend for StuckBackend {
        fn projection(&self) -> Result<SessionBackendProjection, SessionManagerError> {
            Err(SessionManagerError::RuntimeUnavailable)
        }

        fn with_navigation_policy_quiesced(
            &self,
            transition: &mut dyn FnMut(),
        ) -> Result<(), SessionManagerError> {
            transition();
            Ok(())
        }

        fn shutdown(&self, _force: bool) -> Result<(), SessionManagerError> {
            Ok(())
        }

        fn emergency_stop_verified_domain(&self) -> Result<(), SessionManagerError> {
            self.emergency_stops.fetch_add(1, Ordering::AcqRel);
            Ok(())
        }
    }

    #[test]
    fn stuck_owner_is_fenced_and_identity_bound_stop_is_requested_under_one_second() {
        let backend = StuckBackend::default();
        let control = LoginBrowserControl::new();
        let binding = BrowserGrantBinding::new_trusted("w", "p", "s", 1).unwrap();
        control
            .activate_handoff(HandoffGrant::new_trusted(binding.clone()))
            .unwrap();
        let cancellation = control.begin_operation(&binding, true).unwrap();
        let owner = cancellation.enter_owner_execution().unwrap();
        let started = Instant::now();

        let error = revoke_and_acknowledge_owner(&backend, &control).unwrap_err();

        assert_eq!(error, SessionManagerError::OwnerQuiescenceTimedOut);
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(backend.emergency_stops.load(Ordering::Acquire), 1);
        assert!(cancellation.enter_effect_write().is_err());
        drop(owner);
    }
}
