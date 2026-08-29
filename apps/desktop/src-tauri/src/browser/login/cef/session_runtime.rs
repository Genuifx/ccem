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
use std::collections::HashSet;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::AppHandle;

const CEF_ATTACH_TIMEOUT: Duration = Duration::from_secs(12);
const CEF_CLOSE_TIMEOUT: Duration = Duration::from_secs(12);
pub(in crate::browser::login) const CEF_RUNTIME_VERSION: &str =
    "cef-150.0.10+chromium-150.0.7871.101";

/// The one durable owner for all embedded CEF surfaces that share a profile.
///
/// A Browser is an independently-running CEF instance, while a persistent profile is shared
/// storage. Keeping the OS/in-process profile lease on each Browser would make the first close
/// unlock storage that another Browser still uses. This group instead owns the lease and recovery
/// record once, and releases them only after its final member observed a verified native close.
pub(in crate::browser::login) struct EmbeddedProfileGroup {
    runtime_id: String,
    owner_member_surface_id: String,
    state: Mutex<EmbeddedProfileGroupState>,
}

struct EmbeddedProfileGroupState {
    members: HashSet<String>,
    profile_lease: Option<BrowserProfileLease>,
    owner_record: Option<EmbeddedOwnerRecordHandle>,
    runtime_owned: bool,
}

impl EmbeddedProfileGroup {
    pub(in crate::browser::login) fn new(
        runtime_id: String,
        owner_member_surface_id: String,
        profile_lease: BrowserProfileLease,
        owner_record: Option<EmbeddedOwnerRecordHandle>,
    ) -> Arc<Self> {
        Arc::new(Self {
            runtime_id,
            owner_member_surface_id,
            state: Mutex::new(EmbeddedProfileGroupState {
                members: HashSet::new(),
                profile_lease: Some(profile_lease),
                owner_record,
                runtime_owned: false,
            }),
        })
    }

    /// Adds a concrete native surface before its CEF BrowserHost is opened.
    pub(in crate::browser::login) fn attach_surface(
        &self,
        surface_id: &str,
    ) -> Result<(), SessionManagerError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| SessionManagerError::StateUnavailable)?;
        if state.profile_lease.is_none() || !state.members.insert(surface_id.to_string()) {
            return Err(SessionManagerError::ProfileUnavailable);
        }
        Ok(())
    }

    /// Cancels a member before a native CEF ownership domain exists. This path is only valid for
    /// a launch-pending first member; a joined group merely removes the failed joiner.
    pub(in crate::browser::login) fn abort_surface_before_native_open(
        &self,
        surface_id: &str,
    ) -> Result<(), SessionManagerError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| SessionManagerError::StateUnavailable)?;
        if !state.members.contains(surface_id) {
            return Ok(());
        }
        if state.members.len() > 1 {
            state.members.remove(surface_id);
            return Ok(());
        }
        if state.runtime_owned {
            return Err(SessionManagerError::ProfileUnavailable);
        }

        let lease = state
            .profile_lease
            .take()
            .ok_or(SessionManagerError::ProfileUnavailable)?;
        let (_, release_proof) = lease
            .cancel_pending_embedded_launch()
            .map_err(|_| SessionManagerError::ProfileUnavailable)?;
        if let Some(record) = state.owner_record.as_mut() {
            record
                .finish_after_profile_release(release_proof)
                .map_err(|_| SessionManagerError::StateUnavailable)?;
        }
        state.owner_record.take();
        state.members.remove(surface_id);
        Ok(())
    }

    fn mark_runtime_owned(&self, surface_id: &str) -> Result<(), SessionManagerError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| SessionManagerError::StateUnavailable)?;
        if state.runtime_owned {
            return Ok(());
        }
        if self.owner_member_surface_id != surface_id {
            return Err(SessionManagerError::ProfileUnavailable);
        }
        let lease = state
            .profile_lease
            .as_mut()
            .ok_or(SessionManagerError::ProfileUnavailable)?;
        let (_descriptor, proof) = lease
            .mark_embedded_runtime_owned(&self.runtime_id, CEF_RUNTIME_VERSION, "1")
            .map_err(|_| SessionManagerError::ProfileUnavailable)?;
        // The profile transition is durable before the owner record update. Keeping the group
        // marked RuntimeOwned on record-update failure makes terminal cleanup use the verified
        // close path instead of incorrectly treating the persistent profile as launch-pending.
        state.runtime_owned = true;
        if let Some(record) = state.owner_record.as_mut() {
            record
                .mark_runtime_owned(&proof)
                .map_err(|_| SessionManagerError::StateUnavailable)?;
        }
        Ok(())
    }

    /// Called only after this exact surface observed CEF `OnBeforeClose` (or an equivalent
    /// verified closed lifecycle). Non-final members disappear without touching persistent
    /// profile ownership; the last member performs the durable Stopped + unlock transition.
    fn release_surface_after_verified_close(&self, surface_id: &str) -> Result<(), BackendFailure> {
        let mut state = self.state.lock().map_err(|_| terminal_failure())?;
        if !state.members.contains(surface_id) {
            return Ok(());
        }
        if state.members.len() > 1 {
            state.members.remove(surface_id);
            return Ok(());
        }

        if let Some(lease) = state.profile_lease.as_mut() {
            let proof =
                OwnershipDomainGone::from_closed_cef_surface(lease.ownership_id().to_string())
                    .map_err(|_| terminal_failure())?;
            let (_descriptor, release_proof) = lease
                .try_release_embedded_after_ownership_domain_gone(proof)
                .map_err(|_| terminal_failure())?;
            // Never discard the lease before metadata and OS/in-process unlock have succeeded.
            state.profile_lease.take();
            if let Some(record) = state.owner_record.as_mut() {
                record
                    .finish_after_profile_release(release_proof)
                    .map_err(|_| terminal_failure())?;
            }
            state.owner_record.take();
        } else if let Some(record) = state.owner_record.as_ref() {
            record
                .retry_finish_after_profile_release()
                .map_err(|_| terminal_failure())?;
            state.owner_record.take();
        }
        state.members.remove(surface_id);
        Ok(())
    }

    pub(in crate::browser::login) fn is_empty(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.members.is_empty())
            .unwrap_or(false)
    }

    #[cfg(test)]
    fn member_count(&self) -> usize {
        self.state
            .lock()
            .map(|state| state.members.len())
            .unwrap_or(0)
    }

    #[cfg(test)]
    fn holds_profile_lease(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.profile_lease.is_some())
            .unwrap_or(false)
    }
}

pub(in crate::browser::login) fn prepare_launched_runtime(
    app: AppHandle,
    host: Arc<CefHostController>,
    surface_id: String,
    connection: CefSurfaceConnection,
    profile_lease: BrowserProfileLease,
) -> Result<LaunchedSessionRuntime, SessionManagerError> {
    let group =
        EmbeddedProfileGroup::new(surface_id.clone(), surface_id.clone(), profile_lease, None);
    group.attach_surface(&surface_id)?;
    prepare_launched_runtime_inner(app, host, surface_id, connection, group)
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
    let group = EmbeddedProfileGroup::new(
        surface_id.clone(),
        surface_id.clone(),
        profile_lease,
        Some(owner_record),
    );
    group.attach_surface(&surface_id)?;
    prepare_launched_runtime_inner(app, host, surface_id, connection, group)
}

/// Starts a CEF runtime that has already joined an in-process persistent-profile group.
/// The caller attaches the member before native creation and rolls it back on a pre-open error.
pub(in crate::browser::login) fn prepare_launched_runtime_with_profile_group(
    app: AppHandle,
    host: Arc<CefHostController>,
    surface_id: String,
    connection: CefSurfaceConnection,
    profile_group: Arc<EmbeddedProfileGroup>,
) -> Result<LaunchedSessionRuntime, SessionManagerError> {
    prepare_launched_runtime_inner(app, host, surface_id, connection, profile_group)
}

fn prepare_launched_runtime_inner(
    app: AppHandle,
    host: Arc<CefHostController>,
    surface_id: String,
    connection: CefSurfaceConnection,
    profile_group: Arc<EmbeddedProfileGroup>,
) -> Result<LaunchedSessionRuntime, SessionManagerError> {
    let state = connection.state_handle();
    let termination = Arc::new(CefOwnedSurfaceTermination::new(
        app,
        host,
        surface_id.clone(),
        state.clone(),
        profile_group,
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

/// Adds the gesture-gated popup admission boundary to the existing semantic owner.
/// Popup state never crosses into Agent capabilities; an active popup still blocks the exact
/// transition that begins Agent-owned diagnostics on the shared CEF surface.
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

    fn begin_diagnostic_segment(&self, handoff_epoch: u64) -> Result<(), SessionManagerError> {
        self.surface
            .allow_agent_popups()
            .map_err(map_popup_gate_error)?;
        // A real CEF user gesture remains mandatory in the native popup client. Agent ownership
        // only keeps that fixed admission path available for semantic clicks that open OAuth.
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

/// Owns the exact CEF child surface and one membership in a persistent profile group.
///
/// The close gate makes startup failure, protocol failure, explicit shutdown, emergency shutdown,
/// and Drop cleanup converge on one idempotent sequence. A profile lease is released only after
/// the group's final surface observed `OnBeforeClose`.
struct CefOwnedSurfaceTermination {
    app: AppHandle,
    host: Arc<CefHostController>,
    surface_id: String,
    surface: CefSurfaceStateHandle,
    close_gate: Mutex<()>,
    profile_group: Arc<EmbeddedProfileGroup>,
}

impl CefOwnedSurfaceTermination {
    fn new(
        app: AppHandle,
        host: Arc<CefHostController>,
        surface_id: String,
        surface: CefSurfaceStateHandle,
        profile_group: Arc<EmbeddedProfileGroup>,
    ) -> Self {
        Self {
            app,
            host,
            surface_id,
            surface,
            close_gate: Mutex::new(()),
            profile_group,
        }
    }

    fn mark_runtime_owned(&self, runtime_id: &str) -> Result<(), SessionManagerError> {
        self.profile_group.mark_runtime_owned(runtime_id)
    }

    fn close_and_release(&self) -> Result<(), BackendFailure> {
        let _close = self.close_gate.lock().map_err(|_| terminal_failure())?;
        let snapshot = self.surface.snapshot();
        if snapshot.lifecycle != CefSurfaceLifecycle::Closed {
            self.host
                .close_surface(&self.app, self.surface_id.clone())
                .map_err(|_| terminal_failure())?;
            self.surface
                .wait_until_closed(CEF_CLOSE_TIMEOUT)
                .map_err(|_| terminal_failure())?;
        }

        self.profile_group
            .release_surface_after_verified_close(&self.surface_id)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::login::profile::{
        BrowserProfileManager, ProfileCleanupState, TrustedWorkspaceIdentity,
    };

    fn profile_fixture() -> (
        tempfile::TempDir,
        BrowserProfileManager,
        TrustedWorkspaceIdentity,
    ) {
        let temp = tempfile::tempdir().expect("temporary profile root");
        let profiles = BrowserProfileManager::new(
            temp.path().join("login/profile-state"),
            temp.path().join("login/cef"),
        )
        .expect("profile manager");
        let workspace = TrustedWorkspaceIdentity::from_trusted_store("workspace-profile-group")
            .expect("trusted workspace identity");
        (temp, profiles, workspace)
    }

    #[test]
    fn one_profile_group_keeps_the_lease_until_its_final_verified_surface_close() {
        let (_temp, profiles, workspace) = profile_fixture();
        let descriptor = profiles.create_profile(&workspace).expect("profile");
        let reservation = profiles
            .reserve_embedded_launch(descriptor.profile_id(), &workspace)
            .expect("profile reservation");
        let (lease, _launch_proof) = reservation.commit_launch_pending().expect("launch pending");
        let group = EmbeddedProfileGroup::new(
            "login-group-test".to_string(),
            "surface-a".to_string(),
            lease,
            None,
        );

        group.attach_surface("surface-a").expect("first member");
        group
            .mark_runtime_owned("surface-a")
            .expect("mark group runtime owned");
        group.attach_surface("surface-b").expect("second member");
        assert_eq!(group.member_count(), 2);
        assert!(group.holds_profile_lease());
        assert!(matches!(
            profiles.reserve_embedded_launch(descriptor.profile_id(), &workspace),
            Err(crate::browser::login::profile::ProfileError::ProfileInUse)
        ));

        // A stale or spoofed terminal callback cannot decrement either member.
        group
            .release_surface_after_verified_close("surface-not-a-member")
            .expect("ignore stale close");
        assert_eq!(group.member_count(), 2);

        group
            .release_surface_after_verified_close("surface-a")
            .expect("first verified close");
        assert_eq!(group.member_count(), 1);
        assert!(group.holds_profile_lease());
        assert!(matches!(
            profiles
                .descriptor(descriptor.profile_id(), &workspace)
                .expect("profile after first close")
                .cleanup_state(),
            ProfileCleanupState::RuntimeOwned { .. }
        ));

        group
            .release_surface_after_verified_close("surface-b")
            .expect("final verified close");
        assert!(group.is_empty());
        assert!(!group.holds_profile_lease());
        assert!(matches!(
            profiles
                .descriptor(descriptor.profile_id(), &workspace)
                .expect("profile after final close")
                .cleanup_state(),
            ProfileCleanupState::Stopped
        ));
    }
}
