use super::capability::{CcemPermissionGate, JsonlSemanticAuditSink, TrustedOriginPolicyGate};
use super::control::{HandoffGrant, LoginBrowserControl};
use super::policy::{BrowserGrantBinding, NormalizedOrigin};
use super::profile::{
    BrowserProfileLease, BrowserProfileManager, OwnershipDomainGone, ProfileError, ProfileId,
    TrustedWorkspaceIdentity,
};
use super::provenance::ProvenanceLedger;
use super::session_backend::{
    LaunchedSessionRuntime, ProductionRuntime, SessionBackendProjection, SessionBackendStartSpec,
    SessionOwnedBackend,
};
use super::session_policy::SessionNavigationPolicy;
use super::session_quiescence::{
    acknowledge_paused_owner, enter_user_control, revoke_and_acknowledge_owner,
};
use super::supervisor::{
    LoginRuntimeSpec, LoginSupervisor, SupervisorError, VerifiedRuntimeExecutable,
};
use super::workspace::{WorkspaceIdentityError, WorkspaceIdentityStore};
use crate::browser::runtime::activation::ActivationStore;
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

const LOGIN_PROTOCOL_VERSION: &str = "1";
const SESSION_ID_PREFIX: &str = "login-session-";
const SESSION_ID_HEX_LENGTH: usize = 32;
const MAX_TRUSTED_UI_AUTHORIZATION_TTL: Duration = Duration::from_secs(5 * 60);
const DEFAULT_SEMANTIC_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

/// A workspace path resolved by trusted application state, never deserialized from an Agent or
/// page payload. `WorkspaceIdentityStore` canonicalizes it and maps it to a random stable id.
#[derive(Clone)]
pub(crate) struct TrustedWorkspacePath(PathBuf);

impl TrustedWorkspacePath {
    pub(crate) fn from_trusted_app(path: PathBuf) -> Result<Self, SessionManagerError> {
        if path.as_os_str().is_empty() || !path.is_absolute() {
            return Err(SessionManagerError::InvalidTrustedWorkspacePath);
        }
        Ok(Self(path))
    }

    fn as_path(&self) -> &Path {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct SessionId(String);

impl SessionId {
    fn generate() -> Self {
        let mut bytes = [0_u8; 16];
        OsRng.fill_bytes(&mut bytes);
        Self(format!("{SESSION_ID_PREFIX}{}", hex::encode(bytes)))
    }

    fn as_str(&self) -> &str {
        &self.0
    }
}

/// Non-serializable handle retained by trusted UI/session state. A raw string can identify a
/// snapshot, but cannot manufacture the authority needed for handoff, pause, takeover, or close.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LoginBrowserSessionHandle {
    session_id: SessionId,
}

impl LoginBrowserSessionHandle {
    pub(crate) fn as_str(&self) -> &str {
        self.session_id.as_str()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SessionControlOwner {
    User,
    Agent,
    Paused,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LoginBrowserSessionStatus {
    Running,
    Closing,
    CleanupRequired,
}

/// The complete serializable session projection. It intentionally contains no filesystem path,
/// PID, process-group/Job identity, CDP descriptor, pipe handle, or profile lock information.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct LoginBrowserSessionSnapshot {
    pub session_id: String,
    pub profile_id: String,
    pub workspace_id: String,
    pub runtime_version: String,
    pub control: SessionControlOwner,
    pub handoff_epoch: u64,
    pub current_origin: Option<String>,
    pub status: LoginBrowserSessionStatus,
}

pub(crate) struct OpenedLoginBrowserSession {
    pub handle: LoginBrowserSessionHandle,
    pub snapshot: LoginBrowserSessionSnapshot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TrustedUiControlAction {
    HandoffToAgent,
    PauseAgent,
    TakeoverByUser,
}

/// Single-use, action-bound trusted UI capability. It is neither Clone, Serialize, nor
/// Deserialize, so ordinary IPC/Agent arguments cannot mint or replay control authority.
pub(crate) struct TrustedUiControlAuthorization {
    session_id: SessionId,
    action: TrustedUiControlAction,
    expires_at: Instant,
}

impl TrustedUiControlAuthorization {
    pub(crate) fn from_trusted_ui(
        session: &LoginBrowserSessionHandle,
        action: TrustedUiControlAction,
        ttl: Duration,
    ) -> Result<Self, SessionManagerError> {
        if ttl.is_zero() || ttl > MAX_TRUSTED_UI_AUTHORIZATION_TTL {
            return Err(SessionManagerError::InvalidTrustedUiAuthorization);
        }
        Ok(Self {
            session_id: session.session_id.clone(),
            action,
            expires_at: Instant::now() + ttl,
        })
    }

    fn validate(
        &self,
        session_id: &SessionId,
        expected: TrustedUiControlAction,
    ) -> Result<(), SessionManagerError> {
        if &self.session_id != session_id || self.action != expected {
            return Err(SessionManagerError::TrustedUiActionMismatch);
        }
        if Instant::now() > self.expires_at {
            return Err(SessionManagerError::TrustedUiAuthorizationExpired);
        }
        Ok(())
    }
}

/// Active Agent authority issued by an explicit trusted UI handoff.
///
/// This is an in-process capability, not wire data. The control object rejects the binding after
/// pause, takeover, a newer handoff epoch, or session close.
pub(crate) struct SessionAgentGrant {
    binding: BrowserGrantBinding,
    control: Arc<LoginBrowserControl>,
}

impl SessionAgentGrant {
    pub(super) fn binding(&self) -> &BrowserGrantBinding {
        &self.binding
    }

    pub(super) fn control(&self) -> Arc<LoginBrowserControl> {
        Arc::clone(&self.control)
    }
}

pub(super) struct AgentExecutionLease {
    pub(super) binding: BrowserGrantBinding,
    pub(super) workspace_identity: TrustedWorkspaceIdentity,
    pub(super) current_url: String,
    pub(super) control: Arc<LoginBrowserControl>,
    pub(super) origin: Arc<TrustedOriginPolicyGate>,
    pub(super) audit: Arc<JsonlSemanticAuditSink>,
    pub(super) backend: Arc<dyn SessionOwnedBackend>,
    pub(super) permission: Arc<CcemPermissionGate>,
    pub(super) operation_ids: Arc<AtomicU64>,
    pub(super) artifact_root: PathBuf,
    pub(super) provenance: Arc<ProvenanceLedger>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ProfileSelection {
    Default,
    ExplicitNew,
    Existing(ProfileId),
}

trait SessionSupervisor: Send + Sync {
    fn reap_stale(&self, profiles: &BrowserProfileManager) -> Result<(), SessionManagerError>;

    fn launch_active(
        &self,
        profile_lease: BrowserProfileLease,
        activation_store: &ActivationStore,
    ) -> Result<LaunchedSessionRuntime, SessionManagerError>;
}

struct ProductionSessionSupervisor {
    inner: LoginSupervisor,
}

impl SessionSupervisor for ProductionSessionSupervisor {
    fn reap_stale(&self, profiles: &BrowserProfileManager) -> Result<(), SessionManagerError> {
        self.inner
            .reap_stale(profiles)
            .map(|_| ())
            .map_err(map_supervisor_error)
    }

    fn launch_active(
        &self,
        profile_lease: BrowserProfileLease,
        activation_store: &ActivationStore,
    ) -> Result<LaunchedSessionRuntime, SessionManagerError> {
        let runtime_lease = match activation_store.lease_active() {
            Ok(Some(lease)) => lease,
            Ok(None) => {
                release_lease_without_runtime(profile_lease)?;
                return Err(SessionManagerError::NoActiveRuntime);
            }
            Err(error) => {
                release_lease_without_runtime(profile_lease)?;
                return Err(map_supervisor_error(SupervisorError::RuntimeActivation(
                    error,
                )));
            }
        };
        let executable =
            match VerifiedRuntimeExecutable::from_active_lease(activation_store, &runtime_lease) {
                Ok(executable) => executable,
                Err(error) => {
                    release_lease_without_runtime(profile_lease)?;
                    return Err(map_supervisor_error(error));
                }
            };
        let runtime_version = executable.runtime_version().to_string();
        let spec = match LoginRuntimeSpec::new(executable, LOGIN_PROTOCOL_VERSION) {
            Ok(spec) => spec,
            Err(error) => {
                release_lease_without_runtime(profile_lease)?;
                return Err(map_supervisor_error(error));
            }
        };
        let runtime = self
            .inner
            .launch_with_runtime_lease(profile_lease, spec, runtime_lease)
            .map_err(map_supervisor_error)?;
        Ok(LaunchedSessionRuntime {
            runtime: Box::new(ProductionRuntime(runtime)),
            runtime_version,
        })
    }
}

struct SessionRecord {
    snapshot: LoginBrowserSessionSnapshot,
    backend: Arc<dyn SessionOwnedBackend>,
    control: Arc<LoginBrowserControl>,
    navigation_policy: Arc<SessionNavigationPolicy>,
    handoff_candidate: Option<handoff::HandoffCandidateId>,
    active_binding: Option<BrowserGrantBinding>,
    origin_gate: Option<Arc<TrustedOriginPolicyGate>>,
    audit: Arc<JsonlSemanticAuditSink>,
    permission: Arc<CcemPermissionGate>,
    operation_ids: Arc<AtomicU64>,
    artifact_root: PathBuf,
}

impl Drop for SessionRecord {
    fn drop(&mut self) {
        // A grant may be held by an in-flight owner task after the registry entry disappears.
        // Revoke before dropping the runtime/control Arcs so that capability always fails closed.
        let _ = self.navigation_policy.pause_agent();
        let _ = self.control.revoke_handoff();
        let _ = acknowledge_paused_owner(self.backend.as_ref());
    }
}

pub(crate) struct LoginBrowserSessionManager {
    root: PathBuf,
    workspace_identities: WorkspaceIdentityStore,
    profiles: BrowserProfileManager,
    activation_store: ActivationStore,
    supervisor: Arc<dyn SessionSupervisor>,
    provenance: Arc<ProvenanceLedger>,
    profile_activity: activity::ProfileActivityStore,
    sessions: Mutex<HashMap<SessionId, SessionRecord>>,
    open_gate: Mutex<()>,
}

impl LoginBrowserSessionManager {
    pub(crate) fn production(
        root: PathBuf,
        activation_store: ActivationStore,
    ) -> Result<Self, SessionManagerError> {
        if root.as_os_str().is_empty() || !root.is_absolute() {
            return Err(SessionManagerError::InvalidRoot);
        }
        let workspace_identities =
            WorkspaceIdentityStore::new(root.join("workspaces")).map_err(map_workspace_error)?;
        let profiles =
            BrowserProfileManager::new(root.join("profile-state")).map_err(map_profile_error)?;
        let supervisor = Arc::new(ProductionSessionSupervisor {
            inner: LoginSupervisor::production(root.join("supervisor"))
                .map_err(map_supervisor_error)?,
        });
        Self::from_parts(
            root,
            workspace_identities,
            profiles,
            activation_store,
            supervisor,
        )
    }

    fn from_parts(
        root: PathBuf,
        workspace_identities: WorkspaceIdentityStore,
        profiles: BrowserProfileManager,
        activation_store: ActivationStore,
        supervisor: Arc<dyn SessionSupervisor>,
    ) -> Result<Self, SessionManagerError> {
        // Startup is not complete until stale ownership metadata has been reconciled. Otherwise a
        // crashed prior controller could make a profile appear reusable before its domain is gone.
        supervisor.reap_stale(&profiles)?;
        let provenance = Arc::new(
            ProvenanceLedger::new(root.join("provenance"))
                .map_err(|_| SessionManagerError::StateUnavailable)?,
        );
        let profile_activity = activity::ProfileActivityStore::new(root.join("profile-activity"))?;
        Ok(Self {
            root,
            workspace_identities,
            profiles,
            activation_store,
            supervisor,
            provenance,
            profile_activity,
            sessions: Mutex::new(HashMap::new()),
            open_gate: Mutex::new(()),
        })
    }

    pub(crate) fn open_default_profile(
        &self,
        workspace: TrustedWorkspacePath,
    ) -> Result<OpenedLoginBrowserSession, SessionManagerError> {
        self.open(workspace, ProfileSelection::Default)
    }

    pub(crate) fn open_new_profile(
        &self,
        workspace: TrustedWorkspacePath,
    ) -> Result<OpenedLoginBrowserSession, SessionManagerError> {
        self.open(workspace, ProfileSelection::ExplicitNew)
    }

    pub(crate) fn open_existing_profile(
        &self,
        workspace: TrustedWorkspacePath,
        profile_id: &str,
    ) -> Result<OpenedLoginBrowserSession, SessionManagerError> {
        let profile_id = ProfileId::parse(profile_id).map_err(map_profile_error)?;
        self.open(workspace, ProfileSelection::Existing(profile_id))
    }

    fn open(
        &self,
        workspace: TrustedWorkspacePath,
        selection: ProfileSelection,
    ) -> Result<OpenedLoginBrowserSession, SessionManagerError> {
        let open_guard = self
            .open_gate
            .lock()
            .map_err(|_| SessionManagerError::StateUnavailable)?;
        let workspace_identity = self
            .workspace_identities
            .resolve(workspace.as_path())
            .map_err(map_workspace_error)?;
        let descriptor = match selection {
            ProfileSelection::Default => self
                .profiles
                .list_profiles(&workspace_identity)
                .map_err(map_profile_error)?
                .into_iter()
                .next()
                .map(Ok)
                .unwrap_or_else(|| self.profiles.create_profile(&workspace_identity))
                .map_err(map_profile_error)?,
            ProfileSelection::ExplicitNew => self
                .profiles
                .create_profile(&workspace_identity)
                .map_err(map_profile_error)?,
            ProfileSelection::Existing(profile_id) => self
                .profiles
                .descriptor(&profile_id, &workspace_identity)
                .map_err(map_profile_error)?,
        };
        let profile_lease = self
            .profiles
            .acquire_launch_lease(descriptor.profile_id(), &workspace_identity)
            .map_err(map_profile_error)?;
        // The gate protects only default selection + lease acquisition. Process launch may be
        // slow and must not serialize an unrelated workspace or an explicit new-profile launch.
        drop(open_guard);
        let launched = self
            .supervisor
            .launch_active(profile_lease, &self.activation_store)?;
        self.register_launched(
            workspace_identity,
            descriptor.profile_id().clone(),
            launched,
        )
    }

    fn register_launched(
        &self,
        workspace_identity: TrustedWorkspaceIdentity,
        profile_id: ProfileId,
        launched: LaunchedSessionRuntime,
    ) -> Result<OpenedLoginBrowserSession, SessionManagerError> {
        let session_id = SessionId::generate();
        let session_root = self.root.join("sessions").join(session_id.as_str());
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
        apply_backend_projection(&mut snapshot, backend.projection()?)?;
        let handle = LoginBrowserSessionHandle {
            session_id: session_id.clone(),
        };
        let mut sessions = match self.sessions.lock() {
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
        if let Err(error) = self.profile_activity.register(&profile_id, &session_id) {
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

    pub(super) fn agent_execution_for_workspace(
        &self,
        workspace: &TrustedWorkspacePath,
    ) -> Result<Option<AgentExecutionLease>, SessionManagerError> {
        let workspace_identity = self
            .workspace_identities
            .resolve(workspace.as_path())
            .map_err(map_workspace_error)?;
        let mut sessions = self.lock_sessions()?;
        let matching = sessions
            .iter()
            .filter(|(_, record)| {
                record.snapshot.workspace_id == workspace_identity.as_str()
                    && record.snapshot.status == LoginBrowserSessionStatus::Running
                    && record.snapshot.control == SessionControlOwner::Agent
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        if matching.len() > 1 {
            return Err(SessionManagerError::AgentSessionConflict);
        }
        let Some(session_id) = matching.first() else {
            return Ok(None);
        };
        let record = self.record_mut(&mut sessions, session_id)?;
        let projection = record.backend.projection()?;
        apply_backend_projection(&mut record.snapshot, projection.clone())?;
        let binding = record
            .active_binding
            .clone()
            .ok_or(SessionManagerError::ControlUnavailable)?;
        let origin = record
            .origin_gate
            .as_ref()
            .cloned()
            .ok_or(SessionManagerError::OriginUnavailable)?;
        Ok(Some(AgentExecutionLease {
            binding,
            workspace_identity,
            current_url: projection.current_url,
            control: Arc::clone(&record.control),
            origin,
            audit: Arc::clone(&record.audit),
            backend: Arc::clone(&record.backend),
            permission: Arc::clone(&record.permission),
            operation_ids: Arc::clone(&record.operation_ids),
            artifact_root: record.artifact_root.clone(),
            provenance: Arc::clone(&self.provenance),
        }))
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
        )
    }

    fn transition_away_from_agent(
        &self,
        authorization: TrustedUiControlAuthorization,
        expected_action: TrustedUiControlAction,
        target: SessionControlOwner,
    ) -> Result<LoginBrowserSessionSnapshot, SessionManagerError> {
        let mut sessions = self.lock_sessions()?;
        let record = self.record_mut(&mut sessions, &authorization.session_id)?;
        authorization.validate(&record_session_id(record)?, expected_action)?;
        ensure_running(record)?;
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
            record.snapshot.handoff_epoch = epoch;
            record.snapshot.control = SessionControlOwner::Paused;
            record.snapshot.status = LoginBrowserSessionStatus::CleanupRequired;
            return Err(error);
        }
        record.active_binding = None;
        record.origin_gate = None;
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
        let mut sessions = self
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
        self.sessions
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

fn release_lease_without_runtime(
    profile_lease: BrowserProfileLease,
) -> Result<(), SessionManagerError> {
    let proof = OwnershipDomainGone::from_supervisor(profile_lease.ownership_id().to_string())
        .map_err(map_profile_error)?;
    profile_lease
        .release_after_ownership_domain_gone(proof)
        .map(|_| ())
        .map_err(map_profile_error)
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

fn map_supervisor_error(error: SupervisorError) -> SessionManagerError {
    match error {
        SupervisorError::RuntimeUnavailable | SupervisorError::RuntimeActivation(_) => {
            SessionManagerError::NoActiveRuntime
        }
        SupervisorError::TransportFailed => SessionManagerError::TransportUnavailable,
        _ => SessionManagerError::RuntimeUnavailable,
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
