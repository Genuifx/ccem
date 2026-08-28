use super::capability::{CcemPermissionGate, JsonlSemanticAuditSink, TrustedOriginPolicyGate};
#[cfg(any(target_os = "macos", windows))]
use super::cef::recovery::{EmbeddedOwnerRecordHandle, EmbeddedOwnerRecordStore};
use super::control::{HandoffGrant, LoginBrowserControl};
use super::policy::{BrowserGrantBinding, NormalizedOrigin};
use super::profile::{
    BrowserProfileDescriptor, BrowserProfileLease, BrowserProfileManager, ProfileError, ProfileId,
    TrustedWorkspaceIdentity,
};
use super::provenance::ProvenanceLedger;
use super::session_backend::{
    LaunchedSessionRuntime, SessionBackendProjection, SessionBackendStartSpec, SessionOwnedBackend,
};
use super::session_policy::SessionNavigationPolicy;
use super::session_quiescence::{
    acknowledge_paused_owner, enter_user_control, revoke_and_acknowledge_owner,
};
use super::workspace::{WorkspaceIdentityError, WorkspaceIdentityStore};
use rand::{rngs::OsRng, RngCore};
use serde::Serialize;
use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

#[path = "session_profile_maintenance.rs"]
mod profile_maintenance;
pub(crate) use profile_maintenance::LoginBrowserProfileSummary;
#[path = "session_activity.rs"]
mod activity;
#[path = "session_handoff.rs"]
mod handoff;
#[path = "session_permission.rs"]
mod permission_update;
pub(crate) use activity::LoginBrowserRecentActivity;

#[cfg(test)]
const LOGIN_PROTOCOL_VERSION: &str = "1";
const SESSION_ID_PREFIX: &str = "login-session-";
const SESSION_ID_HEX_LENGTH: usize = 32;
const MAX_TRUSTED_UI_AUTHORIZATION_TTL: Duration = Duration::from_secs(5 * 60);
const DEFAULT_SEMANTIC_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

include!("session_types.rs");

impl LoginBrowserSessionManager {
    pub(crate) fn production(root: PathBuf) -> Result<Self, SessionManagerError> {
        if root.as_os_str().is_empty() || !root.is_absolute() {
            return Err(SessionManagerError::InvalidRoot);
        }
        let workspace_identities =
            WorkspaceIdentityStore::new(root.join("workspaces")).map_err(map_workspace_error)?;
        let profiles = BrowserProfileManager::new(root.join("profile-state"), root.join("cef"))
            .map_err(map_profile_error)?;
        Self::from_initialized_state(root, workspace_identities, profiles)
    }

    #[cfg(test)]
    fn from_parts(
        root: PathBuf,
        workspace_identities: WorkspaceIdentityStore,
        profiles: BrowserProfileManager,
        supervisor: Arc<dyn SessionSupervisor>,
    ) -> Result<Self, SessionManagerError> {
        // Startup is not complete until stale ownership metadata has been reconciled. Otherwise a
        // crashed prior controller could make a profile appear reusable before its domain is gone.
        supervisor.reap_stale(&profiles)?;
        let mut manager = Self::from_initialized_state(root, workspace_identities, profiles)?;
        manager
            .inner
            .as_mut()
            .ok_or(SessionManagerError::StateUnavailable)?
            .supervisor = Some(supervisor);
        Ok(manager)
    }

    fn from_initialized_state(
        root: PathBuf,
        workspace_identities: WorkspaceIdentityStore,
        profiles: BrowserProfileManager,
    ) -> Result<Self, SessionManagerError> {
        let provenance = Arc::new(
            ProvenanceLedger::new(root.join("provenance"))
                .map_err(|_| SessionManagerError::StateUnavailable)?,
        );
        let profile_activity = activity::ProfileActivityStore::new(root.join("profile-activity"))?;
        Ok(Self {
            inner: Some(LoginBrowserSessionManagerInner {
                root,
                workspace_identities,
                profiles,
                #[cfg(test)]
                supervisor: None,
                provenance,
                profile_activity,
                sessions: Mutex::new(HashMap::new()),
                open_gate: Mutex::new(()),
            }),
        })
    }

    /// Infallible placeholder for a damaged or inaccessible persisted Mode 2 state root.
    /// Session/profile entry points fail with the fixed `StateUnavailable` boundary; integration
    /// hooks that only discover an optional Mode 2 handoff treat it as absent so Mode 1 survives.
    pub(crate) fn unavailable() -> Self {
        Self { inner: None }
    }

    pub(crate) fn is_available(&self) -> bool {
        self.inner.is_some()
    }

    #[cfg(test)]
    fn profiles_for_test(&self) -> &BrowserProfileManager {
        &self
            .inner
            .as_ref()
            .expect("test session manager must be available")
            .profiles
    }

    fn available(&self) -> Result<&LoginBrowserSessionManagerInner, SessionManagerError> {
        self.inner
            .as_ref()
            .ok_or(SessionManagerError::StateUnavailable)
    }

    #[cfg(test)]
    pub(crate) fn open_default_profile(
        &self,
        workspace: TrustedWorkspacePath,
    ) -> Result<OpenedLoginBrowserSession, SessionManagerError> {
        self.open(workspace, ProfileSelection::Default)
    }

    #[cfg(test)]
    pub(crate) fn open_new_profile(
        &self,
        workspace: TrustedWorkspacePath,
    ) -> Result<OpenedLoginBrowserSession, SessionManagerError> {
        self.open(workspace, ProfileSelection::ExplicitNew)
    }

    #[cfg(test)]
    pub(crate) fn open_existing_profile(
        &self,
        workspace: TrustedWorkspacePath,
        profile_id: &str,
    ) -> Result<OpenedLoginBrowserSession, SessionManagerError> {
        let profile_id = ProfileId::parse(profile_id).map_err(map_profile_error)?;
        self.open(workspace, ProfileSelection::Existing(profile_id))
    }

    #[cfg(test)]
    fn open(
        &self,
        workspace: TrustedWorkspacePath,
        selection: ProfileSelection,
    ) -> Result<OpenedLoginBrowserSession, SessionManagerError> {
        let prepared = self.prepare_profile(workspace, selection)?;
        let (registration, profile_lease) = prepared.into_launch_parts();
        let inner = self.available()?;
        let launched = inner
            .supervisor
            .as_ref()
            .ok_or(SessionManagerError::StateUnavailable)?
            .launch_active(profile_lease)?;
        self.register_prepared(registration, launched)
    }

    #[cfg(test)]
    pub(in crate::browser::login) fn prepare_profile(
        &self,
        workspace: TrustedWorkspacePath,
        selection: ProfileSelection,
    ) -> Result<PreparedLoginBrowserProfile, SessionManagerError> {
        let inner = self.available()?;
        let open_guard = inner
            .open_gate
            .lock()
            .map_err(|_| SessionManagerError::StateUnavailable)?;
        let workspace_identity = inner
            .workspace_identities
            .resolve(workspace.as_path())
            .map_err(map_workspace_error)?;
        let descriptor = self.select_profile(&workspace_identity, selection)?;
        let profile_owner_identity = descriptor.owner_identity().map_err(map_profile_error)?;
        let profile_lease = inner
            .profiles
            .acquire_launch_lease(descriptor.profile_id(), &profile_owner_identity)
            .map_err(map_profile_error)?;
        // The gate protects only default selection + lease acquisition. Process launch may be
        // slow and must not serialize an unrelated workspace or an explicit new-profile launch.
        drop(open_guard);
        Ok(PreparedLoginBrowserProfile {
            session_workspace_identity: workspace_identity,
            profile_owner_identity,
            profile_id: descriptor.profile_id().clone(),
            profile_lease,
        })
    }

    #[cfg(any(target_os = "macos", windows))]
    pub(in crate::browser::login) fn prepare_embedded_profile(
        &self,
        workspace: TrustedWorkspacePath,
        selection: ProfileSelection,
        surface_id: &str,
        owner_records: &EmbeddedOwnerRecordStore,
    ) -> Result<PreparedEmbeddedLoginBrowserProfile, EmbeddedProfilePreparationError> {
        let registration = self.select_embedded_registration(workspace, selection)?;
        self.prepare_embedded_profile_for_registration(registration, surface_id, owner_records)
    }

    /// Resolves the trusted workspace/profile pair without acquiring the exclusive profile lease.
    ///
    /// The embedded surface manager uses this before choosing whether a new CEF browser joins an
    /// existing in-process profile group or becomes that group's first member. Lease acquisition
    /// remains in `prepare_embedded_profile_for_registration`, so an external browser or stale
    /// recovery marker still blocks the first group member fail-closed.
    #[cfg(any(target_os = "macos", windows))]
    pub(in crate::browser::login) fn select_embedded_registration(
        &self,
        workspace: TrustedWorkspacePath,
        selection: ProfileSelection,
    ) -> Result<PreparedLoginBrowserRegistration, EmbeddedProfilePreparationError> {
        let inner = self
            .available()
            .map_err(EmbeddedProfilePreparationError::before_profile)?;
        let open_guard = inner.open_gate.lock().map_err(|_| {
            EmbeddedProfilePreparationError::before_profile(SessionManagerError::StateUnavailable)
        })?;
        let workspace_identity = inner
            .workspace_identities
            .resolve(workspace.as_path())
            .map_err(map_workspace_error)
            .map_err(EmbeddedProfilePreparationError::before_profile)?;
        let requested_identity = match &selection {
            ProfileSelection::Existing(profile_id) => Some(EmbeddedProfileIdentity::new(
                profile_id,
                &workspace_identity,
            )),
            ProfileSelection::Default | ProfileSelection::ExplicitNew => None,
        };
        let descriptor = self
            .select_profile(&workspace_identity, selection)
            .map_err(|error| {
                requested_identity.clone().map_or_else(
                    || EmbeddedProfilePreparationError::before_profile(error),
                    |identity| EmbeddedProfilePreparationError::for_profile(error, identity),
                )
            })?;
        let profile_owner_identity = descriptor
            .owner_identity()
            .map_err(map_profile_error)
            .map_err(EmbeddedProfilePreparationError::before_profile)?;
        drop(open_guard);
        Ok(PreparedLoginBrowserRegistration {
            session_workspace_identity: workspace_identity,
            profile_owner_identity,
            profile_id: descriptor.profile_id().clone(),
        })
    }

    /// Acquires the first-owner profile lease for one already-selected embedded profile.
    ///
    /// Joiners of a live profile group deliberately do not call this method: the group retains
    /// the original OS/in-process lease and recovery record until its final CEF surface has
    /// reached verified terminal close.
    #[cfg(any(target_os = "macos", windows))]
    pub(in crate::browser::login) fn prepare_embedded_profile_for_registration(
        &self,
        registration: PreparedLoginBrowserRegistration,
        surface_id: &str,
        owner_records: &EmbeddedOwnerRecordStore,
    ) -> Result<PreparedEmbeddedLoginBrowserProfile, EmbeddedProfilePreparationError> {
        let inner = self
            .available()
            .map_err(EmbeddedProfilePreparationError::before_profile)?;
        let recovery_identity = EmbeddedProfileIdentity::new(
            registration.profile_id(),
            registration.profile_owner_identity(),
        );
        let reservation = inner
            .profiles
            .reserve_embedded_launch(
                registration.profile_id(),
                registration.profile_owner_identity(),
            )
            .map_err(map_profile_error)
            .map_err(|error| {
                EmbeddedProfilePreparationError::for_profile(error, recovery_identity.clone())
            })?;
        let mut owner_record = owner_records
            .begin_profile_reservation(&reservation, surface_id)
            .map_err(|_| {
                EmbeddedProfilePreparationError::for_profile(
                    SessionManagerError::StateUnavailable,
                    recovery_identity.clone(),
                )
            })?;
        let (profile_lease, launch_pending_proof) = reservation
            .commit_launch_pending()
            .map_err(map_profile_error)
            .map_err(|error| {
                EmbeddedProfilePreparationError::for_profile(error, recovery_identity.clone())
            })?;
        if owner_record
            .mark_launch_pending(&launch_pending_proof)
            .is_err()
        {
            if let Ok((_, release_proof)) = profile_lease.cancel_pending_embedded_launch() {
                let _ = owner_record.finish_after_profile_release(release_proof);
            }
            return Err(EmbeddedProfilePreparationError::for_profile(
                SessionManagerError::StateUnavailable,
                recovery_identity,
            ));
        }
        Ok(PreparedEmbeddedLoginBrowserProfile {
            registration,
            profile_lease,
            owner_record,
        })
    }

    fn select_profile(
        &self,
        workspace_identity: &TrustedWorkspaceIdentity,
        selection: ProfileSelection,
    ) -> Result<BrowserProfileDescriptor, SessionManagerError> {
        let inner = self.available()?;
        match selection {
            ProfileSelection::Default => inner
                .profiles
                .global_default_profile(workspace_identity, true)
                .map_err(map_profile_error)?
                .ok_or(SessionManagerError::ProfileUnavailable),
            ProfileSelection::ExplicitNew => inner
                .profiles
                .create_profile(workspace_identity)
                .map_err(map_profile_error),
            ProfileSelection::Existing(profile_id) => {
                let global = inner
                    .profiles
                    .global_default_profile(workspace_identity, false)
                    .map_err(map_profile_error)?;
                if let Some(descriptor) =
                    global.filter(|descriptor| descriptor.profile_id() == &profile_id)
                {
                    Ok(descriptor)
                } else {
                    inner
                        .profiles
                        .descriptor(&profile_id, workspace_identity)
                        .map_err(map_profile_error)
                }
            }
        }
    }

    #[cfg(any(target_os = "macos", windows))]
    pub(in crate::browser::login) fn reap_embedded_owner_records(
        &self,
        store: &super::cef::recovery::EmbeddedOwnerRecordStore,
    ) -> Result<Vec<super::cef::recovery::EmbeddedOwnerRecoveryRecord>, SessionManagerError> {
        let inner = self.available()?;
        store
            .reap_stale(&inner.profiles)
            .map_err(|_| SessionManagerError::StateUnavailable)
    }

    pub(in crate::browser::login) fn register_prepared(
        &self,
        prepared: PreparedLoginBrowserRegistration,
        launched: LaunchedSessionRuntime,
    ) -> Result<OpenedLoginBrowserSession, SessionManagerError> {
        let PreparedLoginBrowserRegistration {
            session_workspace_identity,
            profile_owner_identity: _,
            profile_id,
        } = prepared;
        self.register_launched(session_workspace_identity, profile_id, launched)
    }

    fn register_launched(
        &self,
        workspace_identity: TrustedWorkspaceIdentity,
        profile_id: ProfileId,
        launched: LaunchedSessionRuntime,
    ) -> Result<OpenedLoginBrowserSession, SessionManagerError> {
        let inner = self.available()?;
        let session_id = SessionId::generate();
        let session_root = inner.root.join("sessions").join(session_id.as_str());
        let artifact_root = session_root.join("artifacts");
        let audit = Arc::new(JsonlSemanticAuditSink::new(
            session_root.join("audit").join("actions.jsonl"),
        ));
        let control = Arc::new(LoginBrowserControl::new());
        let navigation_policy = Arc::new(SessionNavigationPolicy::with_audit(Arc::clone(&audit)));
        let backend = launched.runtime.start_backend(SessionBackendStartSpec {
            artifact_root: artifact_root.clone(),
            network_log_root: session_root.join("logs"),
            network_session_id: session_id.as_str().to_string(),
            redaction: super::network_config::configured_network_redaction(),
            command_timeout: DEFAULT_SEMANTIC_COMMAND_TIMEOUT,
            navigation_guard: Arc::clone(&navigation_policy)
                as Arc<dyn super::cdp::guard::TrustedNavigationGuard>,
        })?;
        let permission = Arc::new(CcemPermissionGate::new("safe"));
        let operation_ids = Arc::new(AtomicU64::new(1));
        let mut snapshot = LoginBrowserSessionSnapshot {
            session_id: session_id.as_str().to_string(),
            profile_id: profile_id.as_str().to_string(),
            workspace_id: workspace_identity.as_str().to_string(),
            runtime_version: launched.runtime_version,
            control: SessionControlOwner::User,
            handoff_epoch: 0,
            current_origin: None,
            status: LoginBrowserSessionStatus::Running,
        };
        if let Err(projection_error) = backend
            .projection()
            .and_then(|projection| apply_backend_projection(&mut snapshot, projection))
        {
            // Opening is not allowed to return while an unregistered runtime still owns the
            // profile. The backend performs its bounded, concrete terminal cleanup here; a cleanup
            // failure is more authoritative than the earlier projection failure.
            return match backend.shutdown(true) {
                Ok(()) => Err(projection_error),
                Err(cleanup_error) => Err(cleanup_error),
            };
        }
        let handle = LoginBrowserSessionHandle {
            session_id: session_id.clone(),
        };
        let mut sessions = match inner.sessions.lock() {
            Ok(sessions) => sessions,
            Err(_) => {
                let _ = backend.shutdown(true);
                return Err(SessionManagerError::StateUnavailable);
            }
        };
        if sessions.contains_key(&session_id) {
            drop(sessions);
            let _ = backend.shutdown(true);
            return Err(SessionManagerError::StateUnavailable);
        }
        if let Err(error) =
            inner
                .profile_activity
                .register(&profile_id, &session_id, &workspace_identity)
        {
            drop(sessions);
            let _ = backend.shutdown(true);
            return Err(error);
        }
        sessions.insert(
            session_id,
            SessionRecord {
                snapshot: snapshot.clone(),
                backend,
                control,
                navigation_policy,
                handoff_candidate: None,
                agent_actor_id: None,
                active_binding: None,
                origin_gate: None,
                audit,
                permission,
                operation_ids,
                artifact_root,
            },
        );
        Ok(OpenedLoginBrowserSession { handle, snapshot })
    }

    pub(crate) fn snapshot(
        &self,
        session: &LoginBrowserSessionHandle,
    ) -> Result<LoginBrowserSessionSnapshot, SessionManagerError> {
        let mut sessions = self.lock_sessions()?;
        let record = self.record_mut(&mut sessions, &session.session_id)?;
        refresh_record_projection(record)?;
        Ok(record.snapshot.clone())
    }

    pub(crate) fn list_snapshots(
        &self,
    ) -> Result<Vec<LoginBrowserSessionSnapshot>, SessionManagerError> {
        let mut sessions = self.lock_sessions()?;
        let mut snapshots = Vec::with_capacity(sessions.len());
        for record in sessions.values_mut() {
            refresh_record_projection(record)?;
            snapshots.push(record.snapshot.clone());
        }
        snapshots.sort_by(|left, right| left.session_id.cmp(&right.session_id));
        Ok(snapshots)
    }

    pub(super) fn update_current_origin(
        &self,
        session: &LoginBrowserSessionHandle,
        origin: Option<&NormalizedOrigin>,
    ) -> Result<(), SessionManagerError> {
        let mut sessions = self.lock_sessions()?;
        let record = self.record_mut(&mut sessions, &session.session_id)?;
        ensure_running(record)?;
        record.snapshot.current_origin = origin.map(NormalizedOrigin::as_serialized_origin);
        Ok(())
    }

    pub(crate) fn pause_agent(
        &self,
        authorization: TrustedUiControlAuthorization,
    ) -> Result<LoginBrowserSessionSnapshot, SessionManagerError> {
        self.transition_away_from_agent(
            authorization,
            TrustedUiControlAction::PauseAgent,
            SessionControlOwner::Paused,
            false,
        )
    }

    /// Trusted host overlays need an idempotent pause barrier: user-owned and
    /// already-paused sessions are safe, while Agent-owned sessions must revoke
    /// authority and acknowledge cancellation before the native child is hidden.
    pub(crate) fn pause_agent_if_active(
        &self,
        authorization: TrustedUiControlAuthorization,
    ) -> Result<LoginBrowserSessionSnapshot, SessionManagerError> {
        self.transition_away_from_agent(
            authorization,
            TrustedUiControlAction::PauseAgent,
            SessionControlOwner::Paused,
            true,
        )
    }

    pub(crate) fn takeover_by_user(
        &self,
        authorization: TrustedUiControlAuthorization,
    ) -> Result<LoginBrowserSessionSnapshot, SessionManagerError> {
        self.transition_away_from_agent(
            authorization,
            TrustedUiControlAction::TakeoverByUser,
            SessionControlOwner::User,
            false,
        )
    }

    fn transition_away_from_agent(
        &self,
        authorization: TrustedUiControlAuthorization,
        expected_action: TrustedUiControlAction,
        target: SessionControlOwner,
        allow_already_safe: bool,
    ) -> Result<LoginBrowserSessionSnapshot, SessionManagerError> {
        let mut sessions = self.lock_sessions()?;
        let record = self.record_mut(&mut sessions, &authorization.session_id)?;
        authorization.validate(&record_session_id(record)?, expected_action)?;
        ensure_running(record)?;
        if allow_already_safe
            && target == SessionControlOwner::Paused
            && record.snapshot.control != SessionControlOwner::Agent
        {
            return Ok(record.snapshot.clone());
        }
        let valid_source = match target {
            SessionControlOwner::Paused => record.snapshot.control == SessionControlOwner::Agent,
            SessionControlOwner::User => matches!(
                record.snapshot.control,
                SessionControlOwner::Agent | SessionControlOwner::Paused
            ),
            SessionControlOwner::Agent => false,
        };
        if !valid_source {
            return Err(SessionManagerError::InvalidControlTransition);
        }
        let epoch = next_epoch(record.snapshot.handoff_epoch)?;
        record
            .navigation_policy
            .pause_agent()
            .map_err(|_| SessionManagerError::ControlUnavailable)?;
        let transition = revoke_and_acknowledge_owner(record.backend.as_ref(), &record.control)
            .and_then(|()| match target {
                SessionControlOwner::User => {
                    enter_user_control(record.backend.as_ref(), &record.navigation_policy)
                }
                SessionControlOwner::Paused => acknowledge_paused_owner(record.backend.as_ref()),
                SessionControlOwner::Agent => unreachable!(),
            });
        if let Err(error) = transition {
            // Keep an in-flight handoff reservation until its preflight returns. This prevents a
            // second candidate from reusing the shared policy/control objects while the first
            // owner call is still outstanding.
            record.active_binding = None;
            record.origin_gate = None;
            record.agent_actor_id = None;
            record.snapshot.handoff_epoch = epoch;
            record.snapshot.control = SessionControlOwner::Paused;
            record.snapshot.status = LoginBrowserSessionStatus::CleanupRequired;
            return Err(error);
        }
        record.active_binding = None;
        record.origin_gate = None;
        record.agent_actor_id = None;
        record.snapshot.handoff_epoch = epoch;
        record.snapshot.control = target;
        Ok(record.snapshot.clone())
    }

    pub(crate) fn close(
        &self,
        session: &LoginBrowserSessionHandle,
    ) -> Result<(), SessionManagerError> {
        self.stop(session, false)
    }

    pub(crate) fn force_stop(
        &self,
        session: &LoginBrowserSessionHandle,
    ) -> Result<(), SessionManagerError> {
        self.stop(session, true)
    }

    /// Revokes every current session authority before performing any backend I/O, then makes one
    /// bounded force-shutdown attempt per backend outside the registry mutex.
    pub(crate) fn shutdown_all(&self) -> Result<LoginBrowserShutdownReport, SessionManagerError> {
        if !self.is_available() {
            return Ok(LoginBrowserShutdownReport {
                attempted: 0,
                closed: 0,
                failures: Vec::new(),
            });
        }
        let mut candidates = {
            let mut sessions = self.lock_sessions()?;
            let mut candidates = Vec::with_capacity(sessions.len());
            for (session_id, record) in sessions.iter_mut() {
                let next_handoff_epoch = next_epoch(record.snapshot.handoff_epoch);
                // These are in-process capability mutations. Backend acknowledgement and terminal
                // cleanup deliberately happen only after the registry guard has been released.
                let _ = record.navigation_policy.pause_agent();
                let _ = record.control.revoke_handoff();
                record.active_binding = None;
                record.origin_gate = None;
                record.agent_actor_id = None;
                record.handoff_candidate = None;
                if let Ok(epoch) = next_handoff_epoch {
                    record.snapshot.handoff_epoch = epoch;
                }
                record.snapshot.control = SessionControlOwner::Paused;
                record.snapshot.status = LoginBrowserSessionStatus::Closing;
                candidates.push((session_id.clone(), Arc::clone(&record.backend)));
            }
            candidates
        };
        candidates.sort_by(|(left, _), (right, _)| left.as_str().cmp(right.as_str()));

        let attempted = candidates.len();
        let mut outcomes = Vec::with_capacity(attempted);
        for (session_id, backend) in candidates {
            outcomes.push((session_id, backend.shutdown(true)));
        }

        let mut closed = 0;
        let mut failures = Vec::new();
        let mut removed = Vec::new();
        {
            let mut sessions = self
                .available()?
                .sessions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            for (session_id, result) in outcomes {
                match result {
                    Ok(()) => {
                        if let Some(record) = sessions.remove(&session_id) {
                            removed.push(record);
                        }
                        closed += 1;
                    }
                    Err(error) => {
                        if let Some(record) = sessions.get_mut(&session_id) {
                            record.snapshot.status = LoginBrowserSessionStatus::CleanupRequired;
                        }
                        failures.push(LoginBrowserShutdownFailure {
                            session_id: session_id.as_str().to_string(),
                            error,
                        });
                    }
                }
            }
        }
        // `SessionRecord::drop` acknowledges its backend. Keep that backend I/O outside the
        // registry mutex even after a successful terminal shutdown.
        drop(removed);

        Ok(LoginBrowserShutdownReport {
            attempted,
            closed,
            failures,
        })
    }

    fn stop(
        &self,
        session: &LoginBrowserSessionHandle,
        force: bool,
    ) -> Result<(), SessionManagerError> {
        let backend = {
            let mut sessions = self.lock_sessions()?;
            let record = self.record_mut(&mut sessions, &session.session_id)?;
            if record.snapshot.status == LoginBrowserSessionStatus::Running {
                let epoch = next_epoch(record.snapshot.handoff_epoch)?;
                record
                    .navigation_policy
                    .pause_agent()
                    .map_err(|_| SessionManagerError::ControlUnavailable)?;
                record
                    .control
                    .revoke_handoff()
                    .map_err(|_| SessionManagerError::ControlUnavailable)?;
                record.active_binding = None;
                record.origin_gate = None;
                record.agent_actor_id = None;
                record.handoff_candidate = None;
                record.snapshot.handoff_epoch = epoch;
                record.snapshot.control = SessionControlOwner::Paused;
            } else if !matches!(
                record.snapshot.status,
                LoginBrowserSessionStatus::Closing | LoginBrowserSessionStatus::CleanupRequired
            ) {
                return Err(SessionManagerError::SessionNotRunning);
            }
            record.snapshot.status = LoginBrowserSessionStatus::Closing;
            Arc::clone(&record.backend)
        };
        let result = backend.shutdown(force);
        let mut sessions = self
            .available()?
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if result.is_ok() {
            sessions.remove(&session.session_id);
        } else if let Some(record) = sessions.get_mut(&session.session_id) {
            record.snapshot.status = LoginBrowserSessionStatus::CleanupRequired;
        }
        result
    }

    fn mark_cleanup_required(&self, session_id: &SessionId) {
        let Some(inner) = self.inner.as_ref() else {
            return;
        };
        let mut sessions = inner
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(record) = sessions.get_mut(session_id) {
            record.snapshot.status = LoginBrowserSessionStatus::CleanupRequired;
        }
    }

    fn lock_sessions(
        &self,
    ) -> Result<MutexGuard<'_, HashMap<SessionId, SessionRecord>>, SessionManagerError> {
        self.available()?
            .sessions
            .lock()
            .map_err(|_| SessionManagerError::StateUnavailable)
    }

    fn record<'a>(
        &self,
        sessions: &'a HashMap<SessionId, SessionRecord>,
        session_id: &SessionId,
    ) -> Result<&'a SessionRecord, SessionManagerError> {
        sessions
            .get(session_id)
            .ok_or(SessionManagerError::SessionNotFound)
    }

    fn record_mut<'a>(
        &self,
        sessions: &'a mut HashMap<SessionId, SessionRecord>,
        session_id: &SessionId,
    ) -> Result<&'a mut SessionRecord, SessionManagerError> {
        sessions
            .get_mut(session_id)
            .ok_or(SessionManagerError::SessionNotFound)
    }
}

fn ensure_running(record: &SessionRecord) -> Result<(), SessionManagerError> {
    if record.snapshot.status != LoginBrowserSessionStatus::Running {
        return Err(SessionManagerError::SessionNotRunning);
    }
    Ok(())
}

fn refresh_record_projection(record: &mut SessionRecord) -> Result<(), SessionManagerError> {
    let projection = record.backend.projection()?;
    apply_backend_projection(&mut record.snapshot, projection)
}

fn apply_backend_projection(
    snapshot: &mut LoginBrowserSessionSnapshot,
    projection: SessionBackendProjection,
) -> Result<(), SessionManagerError> {
    if !projection.ready && !projection.terminated {
        return Err(SessionManagerError::RuntimeUnavailable);
    }
    snapshot.current_origin = NormalizedOrigin::parse(&projection.current_url)
        .ok()
        .map(|origin| origin.as_serialized_origin());
    if projection.terminated && snapshot.status == LoginBrowserSessionStatus::Running {
        snapshot.status = LoginBrowserSessionStatus::CleanupRequired;
    }
    Ok(())
}

fn record_session_id(record: &SessionRecord) -> Result<SessionId, SessionManagerError> {
    let raw = &record.snapshot.session_id;
    let Some(hex) = raw.strip_prefix(SESSION_ID_PREFIX) else {
        return Err(SessionManagerError::StateUnavailable);
    };
    if hex.len() != SESSION_ID_HEX_LENGTH || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(SessionManagerError::StateUnavailable);
    }
    Ok(SessionId(raw.clone()))
}

fn next_epoch(current: u64) -> Result<u64, SessionManagerError> {
    current
        .checked_add(1)
        .ok_or(SessionManagerError::HandoffEpochExhausted)
}

fn map_workspace_error(_error: WorkspaceIdentityError) -> SessionManagerError {
    SessionManagerError::WorkspaceUnavailable
}

fn map_profile_error(error: ProfileError) -> SessionManagerError {
    match error {
        ProfileError::ProfileInUse => SessionManagerError::ProfileInUse,
        ProfileError::ProfileRequiresCleanup => SessionManagerError::ProfileRequiresCleanup,
        _ => SessionManagerError::ProfileUnavailable,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SessionManagerError {
    InvalidRoot,
    InvalidTrustedWorkspacePath,
    WorkspaceUnavailable,
    ProfileInUse,
    ProfileRequiresCleanup,
    ProfileUnavailable,
    ProfileChanged,
    NoActiveRuntime,
    RuntimeUnavailable,
    TransportUnavailable,
    OriginUnavailable,
    HandoffPreflightRejected,
    PopupActive,
    OperationTimedOut,
    OwnerQuiescenceTimedOut,
    AgentSessionConflict,
    SessionNotFound,
    SessionNotRunning,
    DestructiveConfirmationRequired,
    InvalidTrustedUiAuthorization,
    TrustedUiActionMismatch,
    TrustedUiAuthorizationExpired,
    InvalidControlTransition,
    HandoffEpochExhausted,
    ControlUnavailable,
    StateUnavailable,
}

impl fmt::Display for SessionManagerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidRoot => "Invalid Login Browser session root.",
            Self::InvalidTrustedWorkspacePath => "Invalid trusted workspace path.",
            Self::WorkspaceUnavailable => "Trusted workspace identity is unavailable.",
            Self::ProfileInUse => "The Login Browser profile is already in use.",
            Self::ProfileRequiresCleanup => "The Login Browser profile requires cleanup.",
            Self::ProfileUnavailable => "The Login Browser profile is unavailable.",
            Self::ProfileChanged => {
                "The default Login Browser profile changed after confirmation. Review it and try again."
            }
            Self::NoActiveRuntime => "No verified Login Browser runtime is active.",
            Self::RuntimeUnavailable => "The Login Browser runtime is unavailable.",
            Self::TransportUnavailable => "The private browser transport is unavailable.",
            Self::OriginUnavailable => {
                "The current page has no HTTP or HTTPS origin available for Agent handoff."
            }
            Self::HandoffPreflightRejected => {
                "The current page did not pass the browser handoff safety check."
            }
            Self::PopupActive => {
                "Close the Login Browser popup before handing control to the Agent."
            }
            Self::OperationTimedOut => "The Login Browser operation reached its deadline.",
            Self::OwnerQuiescenceTimedOut => {
                "Login Browser control was revoked, but its protocol owner required an emergency stop."
            }
            Self::AgentSessionConflict => {
                "More than one Login Browser session has Agent control for this workspace."
            }
            Self::SessionNotFound => "The Login Browser session was not found.",
            Self::SessionNotRunning => "The Login Browser session is not running.",
            Self::DestructiveConfirmationRequired => {
                "Explicit confirmation is required for Login Browser profile maintenance."
            }
            Self::InvalidTrustedUiAuthorization => "Invalid trusted UI authorization.",
            Self::TrustedUiActionMismatch => "Trusted UI authorization does not match the action.",
            Self::TrustedUiAuthorizationExpired => "Trusted UI authorization expired.",
            Self::InvalidControlTransition => "Invalid Login Browser control transition.",
            Self::HandoffEpochExhausted => "Login Browser handoff epoch is exhausted.",
            Self::ControlUnavailable => "Login Browser control state is unavailable.",
            Self::StateUnavailable => "Login Browser session state is unavailable.",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for SessionManagerError {}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;
