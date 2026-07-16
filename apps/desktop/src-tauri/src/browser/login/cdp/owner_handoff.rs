use super::super::backend::{BackendFailure, BackendFailureCode};
use super::super::policy::NormalizedOrigin;
use super::owner::{runtime_failure, ChromiumLoginBackend, OwnerRequest, TRUSTED_BARRIER_TIMEOUT};
use super::semantics::SemanticEngine;
use super::transport::CdpClient;
use std::sync::atomic::Ordering;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Instant;

const CONTROL_BARRIER_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(300);

pub(super) fn run_handoff_preflight(
    engine: &mut SemanticEngine,
    client: &mut CdpClient<'_>,
    expected: &NormalizedOrigin,
) -> Result<(), BackendFailure> {
    engine.preflight_handoff(client, expected, Instant::now() + TRUSTED_BARRIER_TIMEOUT)
}

impl ChromiumLoginBackend {
    pub(in crate::browser::login) fn preflight_handoff(
        &self,
        expected: NormalizedOrigin,
    ) -> Result<(), BackendFailure> {
        if self.shutdown.load(Ordering::Acquire) {
            return Err(runtime_failure());
        }
        let (response, result) = mpsc::sync_channel(1);
        self.requests
            .try_send(OwnerRequest::PreflightHandoff { expected, response })
            .map_err(|_| runtime_failure())?;
        result
            .recv_timeout(TRUSTED_BARRIER_TIMEOUT)
            .map_err(|error| match error {
                RecvTimeoutError::Timeout => BackendFailure::new(
                    BackendFailureCode::TimedOut,
                    "Browser handoff preflight reached its fixed deadline.",
                ),
                RecvTimeoutError::Disconnected => runtime_failure(),
            })?
    }

    pub(in crate::browser::login) fn begin_diagnostic_segment(
        &self,
        handoff_epoch: u64,
    ) -> Result<(), BackendFailure> {
        if self.shutdown.load(Ordering::Acquire) {
            return Err(runtime_failure());
        }
        let (response, result) = mpsc::sync_channel(1);
        self.requests
            .try_send(OwnerRequest::BeginDiagnosticSegment {
                handoff_epoch,
                response,
            })
            .map_err(|_| runtime_failure())?;
        result
            .recv_timeout(CONTROL_BARRIER_TIMEOUT)
            .map_err(|error| match error {
                RecvTimeoutError::Timeout => BackendFailure::new(
                    BackendFailureCode::TimedOut,
                    "Browser diagnostic start reached its fixed control deadline.",
                ),
                RecvTimeoutError::Disconnected => runtime_failure(),
            })?
    }

    pub(in crate::browser::login) fn stop_diagnostic_segment(&self) -> Result<(), BackendFailure> {
        if self.shutdown.load(Ordering::Acquire) {
            return Err(runtime_failure());
        }
        let (response, result) = mpsc::sync_channel(1);
        self.requests
            .try_send(OwnerRequest::StopDiagnosticSegment { response })
            .map_err(|_| runtime_failure())?;
        result
            .recv_timeout(CONTROL_BARRIER_TIMEOUT)
            .map_err(|error| match error {
                RecvTimeoutError::Timeout => BackendFailure::new(
                    BackendFailureCode::TimedOut,
                    "Browser diagnostic stop reached its fixed control deadline.",
                ),
                RecvTimeoutError::Disconnected => runtime_failure(),
            })?
    }

    pub(in crate::browser::login) fn emergency_stop_verified_domain(
        &self,
    ) -> Result<(), BackendFailure> {
        self.shutdown.store(true, Ordering::Release);
        let _ = self.requests.try_send(OwnerRequest::Shutdown);
        self.termination.request_terminal_shutdown()
    }
}
