use super::backend::{BackendFailure, SemanticBrowserBackend};
use super::cdp::guard::TrustedNavigationGuard;
use super::cdp::owner::{
    ChromiumLoginBackend, ChromiumLoginBackendConfig, ChromiumOwnerProjection,
};
use super::network::NetworkRedactionConfig;
use super::policy::NormalizedOrigin;
use super::session::SessionManagerError;
use super::supervisor::ManagedLoginRuntime;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SessionBackendProjection {
    pub(super) current_url: String,
    pub(super) current_title: Option<String>,
    pub(super) generation: u64,
    pub(super) ready: bool,
    pub(super) terminated: bool,
}

pub(super) trait SessionOwnedBackend: SemanticBrowserBackend {
    /// This must be a bounded in-memory projection read. Session registry locks may be held by the
    /// caller; implementations must never perform browser I/O here.
    fn projection(&self) -> Result<SessionBackendProjection, SessionManagerError>;

    fn validate_current_origin(
        &self,
        expected: &NormalizedOrigin,
    ) -> Result<SessionBackendProjection, SessionManagerError>;

    fn preflight_handoff(&self, expected: &NormalizedOrigin) -> Result<(), SessionManagerError> {
        self.validate_current_origin(expected).map(|_| ())
    }

    fn begin_diagnostic_segment(&self, _handoff_epoch: u64) -> Result<(), SessionManagerError> {
        Ok(())
    }

    fn stop_diagnostic_segment(&self) -> Result<(), SessionManagerError> {
        Ok(())
    }

    fn with_navigation_policy_quiesced(
        &self,
        transition: &mut dyn FnMut(),
    ) -> Result<(), SessionManagerError>;

    /// Revoke/cancel happens in the session registry before this call. Success means the
    /// supervisor proved the complete ownership domain gone and released the profile lease.
    fn shutdown(&self, force: bool) -> Result<(), SessionManagerError>;

    fn emergency_stop_verified_domain(&self) -> Result<(), SessionManagerError> {
        Err(SessionManagerError::RuntimeUnavailable)
    }
}

pub(super) struct SessionBackendStartSpec {
    pub(super) artifact_root: PathBuf,
    pub(super) network_log_root: PathBuf,
    pub(super) network_session_id: String,
    pub(super) redaction: NetworkRedactionConfig,
    pub(super) command_timeout: Duration,
    pub(super) navigation_guard: Arc<dyn TrustedNavigationGuard>,
}

pub(super) trait SessionLaunchRuntime: Send {
    fn start_backend(
        self: Box<Self>,
        spec: SessionBackendStartSpec,
    ) -> Result<Arc<dyn SessionOwnedBackend>, SessionManagerError>;
}

pub(super) struct LaunchedSessionRuntime {
    pub(super) runtime: Box<dyn SessionLaunchRuntime>,
    pub(super) runtime_version: String,
}

pub(super) struct ProductionRuntime(pub(super) ManagedLoginRuntime);

impl SessionLaunchRuntime for ProductionRuntime {
    fn start_backend(
        self: Box<Self>,
        spec: SessionBackendStartSpec,
    ) -> Result<Arc<dyn SessionOwnedBackend>, SessionManagerError> {
        let Self(runtime) = *self;
        let config = ChromiumLoginBackendConfig::new_trusted(
            spec.artifact_root,
            spec.network_log_root,
            spec.network_session_id,
            spec.redaction,
            spec.command_timeout,
        )
        .map_err(map_backend_failure)?;
        let backend = ChromiumLoginBackend::spawn(runtime, config, spec.navigation_guard)
            .map_err(|error| {
                eprintln!(
                    "Login Browser CDP startup failed ({}): {}",
                    error.code.as_str(),
                    error
                );
                map_backend_failure(error)
            })?;
        Ok(Arc::new(ProductionSessionBackend { backend }))
    }
}

struct ProductionSessionBackend {
    backend: ChromiumLoginBackend,
}

impl SemanticBrowserBackend for ProductionSessionBackend {
    fn execute(
        &self,
        command: &super::backend::SemanticBrowserCommand,
        cancellation: &super::control::OperationCancellation,
    ) -> Result<super::backend::SemanticBrowserResult, BackendFailure> {
        self.backend.execute(command, cancellation)
    }
}

impl SessionOwnedBackend for ProductionSessionBackend {
    fn projection(&self) -> Result<SessionBackendProjection, SessionManagerError> {
        self.backend
            .projection()
            .map(SessionBackendProjection::from)
            .map_err(map_backend_failure)
    }

    fn validate_current_origin(
        &self,
        expected: &NormalizedOrigin,
    ) -> Result<SessionBackendProjection, SessionManagerError> {
        self.backend
            .validate_current_origin(expected.clone())
            .map(SessionBackendProjection::from)
            .map_err(map_backend_failure)
    }

    fn preflight_handoff(&self, expected: &NormalizedOrigin) -> Result<(), SessionManagerError> {
        self.backend
            .preflight_handoff(expected.clone())
            .map_err(map_backend_failure)
    }

    fn begin_diagnostic_segment(&self, handoff_epoch: u64) -> Result<(), SessionManagerError> {
        self.backend
            .begin_diagnostic_segment(handoff_epoch)
            .map_err(map_backend_failure)
    }

    fn stop_diagnostic_segment(&self) -> Result<(), SessionManagerError> {
        self.backend
            .stop_diagnostic_segment()
            .map_err(map_backend_failure)
    }

    fn with_navigation_policy_quiesced(
        &self,
        transition: &mut dyn FnMut(),
    ) -> Result<(), SessionManagerError> {
        self.backend
            .with_owner_quiesced(transition)
            .map_err(map_backend_failure)
    }

    fn shutdown(&self, force: bool) -> Result<(), SessionManagerError> {
        // The owner first requests Browser.close and the supervisor force-terminates its verified
        // process group/Job Object after the fixed graceful deadline. Both close paths therefore
        // retain the same identity-checked cleanup guarantee.
        let stopped = self
            .backend
            .stop_diagnostic_segment()
            .map_err(map_backend_failure);
        let shutdown = self.backend.shutdown(force).map_err(map_backend_failure);
        shutdown?;
        stopped
    }

    fn emergency_stop_verified_domain(&self) -> Result<(), SessionManagerError> {
        self.backend
            .emergency_stop_verified_domain()
            .map_err(map_backend_failure)
    }
}

impl From<ChromiumOwnerProjection> for SessionBackendProjection {
    fn from(value: ChromiumOwnerProjection) -> Self {
        Self {
            current_url: value.current_url,
            current_title: value.current_title,
            generation: value.generation,
            ready: value.ready,
            terminated: value.terminated,
        }
    }
}

fn map_backend_failure(error: BackendFailure) -> SessionManagerError {
    match error.code {
        super::backend::BackendFailureCode::TimedOut => SessionManagerError::OperationTimedOut,
        super::backend::BackendFailureCode::Cancelled => SessionManagerError::ControlUnavailable,
        _ => SessionManagerError::RuntimeUnavailable,
    }
}
