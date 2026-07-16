use super::super::{
    backend::{
        BackendFailure, BackendFailureCode, SemanticBrowserBackend, SemanticBrowserCommand,
        SemanticBrowserResult,
    },
    cdp::{
        owner::{ChromiumLoginBackend, ChromiumLoginBackendConfig},
        OwnerTerminalTermination,
    },
    profile::{BrowserProfileLease, OwnershipDomainGone},
    session::SessionManagerError,
    session_backend::{
        LaunchedSessionRuntime, OwnerSessionBackend, SessionBackendStartSpec, SessionLaunchRuntime,
        SessionOwnedBackend,
    },
};
use super::{
    host::CefHostController,
    recovery::EmbeddedOwnerRecordHandle,
    surface::{
        CefPopupAgentLockError, CefSurfaceConnection, CefSurfaceLifecycle, CefSurfaceStateHandle,
    },
};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::AppHandle;

const CEF_ATTACH_TIMEOUT: Duration = Duration::from_secs(12);
const CEF_CLOSE_TIMEOUT: Duration = Duration::from_secs(12);
pub(in crate::browser::login) const CEF_RUNTIME_VERSION: &str =
    "cef-150.0.10+chromium-150.0.7871.101";

pub(in crate::browser::login) fn prepare_launched_runtime(
    app: AppHandle,
    host: Arc<CefHostController>,
    surface_id: String,
    connection: CefSurfaceConnection,
    profile_lease: BrowserProfileLease,
) -> Result<LaunchedSessionRuntime, SessionManagerError> {
    prepare_launched_runtime_inner(app, host, surface_id, connection, profile_lease, None)
}

/// Crash-safe variant. The record must have been committed before native surface creation.
pub(in crate::browser::login) fn prepare_launched_runtime_with_owner_record(
    app: AppHandle,
    host: Arc<CefHostController>,
    surface_id: String,
    connection: CefSurfaceConnection,
    profile_lease: BrowserProfileLease,
    owner_record: EmbeddedOwnerRecordHandle,
) -> Result<LaunchedSessionRuntime, SessionManagerError> {
    prepare_launched_runtime_inner(
        app,
        host,
        surface_id,
        connection,
        profile_lease,
        Some(owner_record),
    )
}

fn prepare_launched_runtime_inner(
    app: AppHandle,
    host: Arc<CefHostController>,
    surface_id: String,
    connection: CefSurfaceConnection,
    profile_lease: BrowserProfileLease,
    owner_record: Option<EmbeddedOwnerRecordHandle>,
) -> Result<LaunchedSessionRuntime, SessionManagerError> {
    let state = connection.state_handle();
    let termination = Arc::new(CefOwnedSurfaceTermination::new(
        app,
        host,
        surface_id.clone(),
        state.clone(),
        profile_lease,
        owner_record,
    ));

    if termination
        .surface
        .wait_until_attached(CEF_ATTACH_TIMEOUT)
        .is_err()
    {
        let _ = termination.request_terminal_shutdown();
        return Err(SessionManagerError::RuntimeUnavailable);
    }
    if let Err(error) = termination.mark_runtime_owned(&surface_id) {
        let _ = termination.request_terminal_shutdown();
        return Err(error);
    }

    let (reader, writer) = connection.into_devtools_transport();
    let terminal: Arc<dyn OwnerTerminalTermination> = termination;
    Ok(LaunchedSessionRuntime {
        runtime: Box::new(EmbeddedCefSessionRuntime {
            reader: Box::new(reader),
            writer: Box::new(writer),
            termination: terminal,
            surface: state,
        }),
        runtime_version: CEF_RUNTIME_VERSION.to_string(),
    })
}

struct EmbeddedCefSessionRuntime {
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
    termination: Arc<dyn OwnerTerminalTermination>,
    surface: CefSurfaceStateHandle,
}

impl SessionLaunchRuntime for EmbeddedCefSessionRuntime {
    fn start_backend(
        self: Box<Self>,
        spec: SessionBackendStartSpec,
    ) -> Result<Arc<dyn SessionOwnedBackend>, SessionManagerError> {
        let Self {
            reader,
            writer,
            termination,
            surface,
        } = *self;
        let config = ChromiumLoginBackendConfig::new_trusted(
            spec.artifact_root,
            spec.network_log_root,
            spec.network_session_id,
            spec.redaction,
            spec.command_timeout,
        )
        .map_err(map_backend_failure)?;
        let backend = ChromiumLoginBackend::spawn_embedded(
            reader,
            writer,
            config,
            spec.navigation_guard,
            termination,
        )
        .map_err(map_backend_failure)?;
        Ok(Arc::new(EmbeddedCefSessionBackend {
            inner: OwnerSessionBackend::new(backend),
            surface,
        }))
    }
}

/// Adds the user-popup admission boundary to the existing semantic owner.
/// Popup state never crosses into Agent capabilities; it only gates the exact
/// handoff/owner transitions around the shared CEF surface.
struct EmbeddedCefSessionBackend {
    inner: OwnerSessionBackend,
    surface: CefSurfaceStateHandle,
}

impl SemanticBrowserBackend for EmbeddedCefSessionBackend {
    fn execute(
        &self,
        command: &SemanticBrowserCommand,
        cancellation: &super::super::control::OperationCancellation,
    ) -> Result<SemanticBrowserResult, BackendFailure> {
        self.inner.execute(command, cancellation)
    }
}

impl SessionOwnedBackend for EmbeddedCefSessionBackend {
    fn projection(
        &self,
    ) -> Result<super::super::session_backend::SessionBackendProjection, SessionManagerError> {
        self.inner.projection()
    }

    fn validate_current_origin(
        &self,
        expected: &super::super::policy::NormalizedOrigin,
    ) -> Result<super::super::session_backend::SessionBackendProjection, SessionManagerError> {
        self.inner.validate_current_origin(expected)
    }

    fn preflight_handoff(
        &self,
        expected: &super::super::policy::NormalizedOrigin,
    ) -> Result<(), SessionManagerError> {
        if self.surface.popup_active() {
            return Err(SessionManagerError::PopupActive);
        }
        self.inner.preflight_handoff(expected)
    }

    fn begin_diagnostic_segment(&self, handoff_epoch: u64) -> Result<(), SessionManagerError> {
        self.surface
            .lock_popups_for_agent()
            .map_err(map_popup_gate_error)?;
        // Keep admission denied on failure. The handoff rollback restores User
        // admission only inside the acknowledged owner-quiescence barrier.
        self.inner.begin_diagnostic_segment(handoff_epoch)
    }

    fn stop_diagnostic_segment(&self) -> Result<(), SessionManagerError> {
        self.surface.deny_popups();
        self.inner.stop_diagnostic_segment()
    }

    fn with_navigation_policy_quiesced(
        &self,
        transition: &mut dyn FnMut(),
    ) -> Result<(), SessionManagerError> {
        let mut popup_result = Ok(());
        let mut restore_user = || {
            transition();
            popup_result = self
                .surface
                .allow_user_popups()
                .map_err(map_popup_gate_error);
        };
        self.inner
            .with_navigation_policy_quiesced(&mut restore_user)?;
        popup_result
    }

    fn shutdown(&self, force: bool) -> Result<(), SessionManagerError> {
        self.surface.deny_popups();
        self.inner.shutdown(force)
    }

    fn emergency_stop_verified_domain(&self) -> Result<(), SessionManagerError> {
        self.surface.deny_popups();
        self.inner.emergency_stop_verified_domain()
    }
}

fn map_popup_gate_error(error: CefPopupAgentLockError) -> SessionManagerError {
    match error {
        CefPopupAgentLockError::PopupActive => SessionManagerError::PopupActive,
        CefPopupAgentLockError::SurfaceUnavailable => SessionManagerError::RuntimeUnavailable,
    }
}

/// Owns the exact CEF child surface and the corresponding persistent profile lease.
///
/// The close gate makes startup failure, protocol failure, explicit shutdown, emergency shutdown,
/// and Drop cleanup converge on one idempotent sequence. A lease is released only after the shared
/// lifecycle observed `OnBeforeClose` for this surface.
struct CefOwnedSurfaceTermination {
    app: AppHandle,
    host: Arc<CefHostController>,
    surface_id: String,
    surface: CefSurfaceStateHandle,
    close_gate: Mutex<()>,
    profile_lease: Mutex<Option<BrowserProfileLease>>,
    owner_record: Mutex<Option<EmbeddedOwnerRecordHandle>>,
}

impl CefOwnedSurfaceTermination {
    fn new(
        app: AppHandle,
        host: Arc<CefHostController>,
        surface_id: String,
        surface: CefSurfaceStateHandle,
        profile_lease: BrowserProfileLease,
        owner_record: Option<EmbeddedOwnerRecordHandle>,
    ) -> Self {
        Self {
            app,
            host,
            surface_id,
            surface,
            close_gate: Mutex::new(()),
            profile_lease: Mutex::new(Some(profile_lease)),
            owner_record: Mutex::new(owner_record),
        }
    }

    fn mark_runtime_owned(&self, runtime_id: &str) -> Result<(), SessionManagerError> {
        let mut lease = self
            .profile_lease
            .lock()
            .map_err(|_| SessionManagerError::StateUnavailable)?;
        let lease = lease
            .as_mut()
            .ok_or(SessionManagerError::ProfileUnavailable)?;
        let (_descriptor, proof) = lease
            .mark_embedded_runtime_owned(runtime_id, CEF_RUNTIME_VERSION, "1")
            .map_err(|_| SessionManagerError::ProfileUnavailable)?;
        if let Some(record) = self
            .owner_record
            .lock()
            .map_err(|_| SessionManagerError::StateUnavailable)?
            .as_mut()
        {
            record
                .mark_runtime_owned(&proof)
                .map_err(|_| SessionManagerError::StateUnavailable)?;
        }
        Ok(())
    }

    fn close_and_release(&self) -> Result<(), BackendFailure> {
        let _close = self.close_gate.lock().map_err(|_| terminal_failure())?;
        if self
            .profile_lease
            .lock()
            .map_err(|_| terminal_failure())?
            .is_none()
        {
            let mut owner_slot = self.owner_record.lock().map_err(|_| terminal_failure())?;
            if let Some(record) = owner_slot.as_ref() {
                record
                    .retry_finish_after_profile_release()
                    .map_err(|_| terminal_failure())?;
                owner_slot.take();
            }
            return Ok(());
        }

        let snapshot = self.surface.snapshot();
        if snapshot.lifecycle != CefSurfaceLifecycle::Closed {
            self.host
                .close_surface(&self.app, self.surface_id.clone())
                .map_err(|_| terminal_failure())?;
            self.surface
                .wait_until_closed(CEF_CLOSE_TIMEOUT)
                .map_err(|_| terminal_failure())?;
        }

        let mut lease_slot = self.profile_lease.lock().map_err(|_| terminal_failure())?;
        let lease = lease_slot.as_mut().ok_or_else(terminal_failure)?;
        let proof = OwnershipDomainGone::from_closed_cef_surface(lease.ownership_id().to_string())
            .map_err(|_| terminal_failure())?;
        let (_descriptor, release_proof) = lease
            .try_release_embedded_after_ownership_domain_gone(proof)
            .map_err(|_| terminal_failure())?;
        // Only discard the lease after both Stopped persistence and OS/in-process unlock
        // succeeded. Any earlier error leaves the same lease available for a retry.
        lease_slot.take();
        let mut owner_slot = self.owner_record.lock().map_err(|_| terminal_failure())?;
        if let Some(record) = owner_slot.as_mut() {
            record
                .finish_after_profile_release(release_proof)
                .map_err(|_| terminal_failure())?;
            owner_slot.take();
        }
        Ok(())
    }
}

impl OwnerTerminalTermination for CefOwnedSurfaceTermination {
    fn request_terminal_shutdown(&self) -> Result<(), BackendFailure> {
        self.close_and_release()
    }
}

fn map_backend_failure(error: BackendFailure) -> SessionManagerError {
    match error.code {
        BackendFailureCode::TimedOut => SessionManagerError::OperationTimedOut,
        BackendFailureCode::Cancelled => SessionManagerError::ControlUnavailable,
        _ => SessionManagerError::RuntimeUnavailable,
    }
}

fn terminal_failure() -> BackendFailure {
    BackendFailure::new(
        BackendFailureCode::RuntimeUnavailable,
        "Embedded browser surface did not reach verified terminal state.",
    )
}
