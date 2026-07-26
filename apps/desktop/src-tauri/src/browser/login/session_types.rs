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

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LoginBrowserShutdownFailure {
    pub(crate) session_id: String,
    pub(crate) error: SessionManagerError,
}

/// Result of one bounded exit-time sweep over the sessions present when it began.
///
/// An individual backend failure is reported here rather than aborting the sweep. The failed
/// record remains registered as `CleanupRequired`, while successfully terminated records are
/// removed. `shutdown_all` itself returns `Err` only when the registry cannot be acquired before
/// any backend shutdown is attempted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LoginBrowserShutdownReport {
    pub(crate) attempted: usize,
    pub(crate) closed: usize,
    pub(crate) failures: Vec<LoginBrowserShutdownFailure>,
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
pub(in crate::browser::login) enum ProfileSelection {
    Default,
    ExplicitNew,
    Existing(ProfileId),
}

/// Non-serializable profile authority prepared for one concrete runtime launch.
///
/// Selection and lease acquisition stay under the session manager's gate; the native CEF host
/// consumes the lease and must either return it through a verified close or leave the persisted
/// cleanup marker fail-closed.
#[cfg(test)]
pub(in crate::browser::login) struct PreparedLoginBrowserProfile {
    workspace_identity: TrustedWorkspaceIdentity,
    profile_id: ProfileId,
    profile_lease: BrowserProfileLease,
}

#[derive(Clone)]
pub(in crate::browser::login) struct PreparedLoginBrowserRegistration {
    workspace_identity: TrustedWorkspaceIdentity,
    profile_id: ProfileId,
}

impl PreparedLoginBrowserRegistration {
    pub(in crate::browser::login) fn profile_id(&self) -> &ProfileId {
        &self.profile_id
    }

    pub(in crate::browser::login) fn workspace_identity(&self) -> &TrustedWorkspaceIdentity {
        &self.workspace_identity
    }
}

#[cfg(any(target_os = "macos", windows))]
pub(in crate::browser::login) struct PreparedEmbeddedLoginBrowserProfile {
    registration: PreparedLoginBrowserRegistration,
    profile_lease: BrowserProfileLease,
    owner_record: EmbeddedOwnerRecordHandle,
}

/// Opaque persisted identities used only to associate startup recovery with the profile selected
/// by trusted application state. Neither the workspace path nor native/process ownership details
/// cross this boundary.
#[cfg(any(target_os = "macos", windows))]
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(in crate::browser::login) struct EmbeddedProfileIdentity {
    profile_id: String,
    workspace_id: String,
}

#[cfg(any(target_os = "macos", windows))]
impl EmbeddedProfileIdentity {
    pub(in crate::browser::login) fn new(
        profile_id: &ProfileId,
        workspace_identity: &TrustedWorkspaceIdentity,
    ) -> Self {
        Self {
            profile_id: profile_id.as_str().to_string(),
            workspace_id: workspace_identity.as_str().to_string(),
        }
    }

    pub(in crate::browser::login) fn from_recovery_record(
        profile_id: String,
        workspace_id: String,
    ) -> Self {
        Self {
            profile_id,
            workspace_id,
        }
    }
}

#[cfg(any(target_os = "macos", windows))]
#[derive(Debug)]
pub(in crate::browser::login) struct EmbeddedProfilePreparationError {
    source: SessionManagerError,
    identity: Option<EmbeddedProfileIdentity>,
}

#[cfg(any(target_os = "macos", windows))]
impl EmbeddedProfilePreparationError {
    pub(in crate::browser::login) fn before_profile(source: SessionManagerError) -> Self {
        Self {
            source,
            identity: None,
        }
    }

    pub(in crate::browser::login) fn for_profile(
        source: SessionManagerError,
        identity: EmbeddedProfileIdentity,
    ) -> Self {
        Self {
            source,
            identity: Some(identity),
        }
    }

    pub(in crate::browser::login) fn identity(&self) -> Option<&EmbeddedProfileIdentity> {
        self.identity.as_ref()
    }
}

#[cfg(any(target_os = "macos", windows))]
impl fmt::Display for EmbeddedProfilePreparationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.source.fmt(formatter)
    }
}

#[cfg(any(target_os = "macos", windows))]
impl std::error::Error for EmbeddedProfilePreparationError {}

#[cfg(any(target_os = "macos", windows))]
impl PreparedEmbeddedLoginBrowserProfile {
    pub(in crate::browser::login) fn profile_id(&self) -> &ProfileId {
        &self.registration.profile_id
    }

    pub(in crate::browser::login) fn recovery_identity(&self) -> EmbeddedProfileIdentity {
        EmbeddedProfileIdentity::new(
            &self.registration.profile_id,
            &self.registration.workspace_identity,
        )
    }

    pub(in crate::browser::login) fn into_launch_parts(
        self,
    ) -> (
        PreparedLoginBrowserRegistration,
        BrowserProfileLease,
        EmbeddedOwnerRecordHandle,
    ) {
        (self.registration, self.profile_lease, self.owner_record)
    }
}

#[cfg(test)]
impl PreparedLoginBrowserProfile {
    pub(in crate::browser::login) fn profile_id(&self) -> &ProfileId {
        &self.profile_id
    }

    pub(in crate::browser::login) fn into_launch_parts(
        self,
    ) -> (PreparedLoginBrowserRegistration, BrowserProfileLease) {
        (
            PreparedLoginBrowserRegistration {
                workspace_identity: self.workspace_identity,
                profile_id: self.profile_id,
            },
            self.profile_lease,
        )
    }
}

#[cfg(test)]
trait SessionSupervisor: Send + Sync {
    fn reap_stale(&self, profiles: &BrowserProfileManager) -> Result<(), SessionManagerError>;

    fn launch_active(
        &self,
        profile_lease: BrowserProfileLease,
    ) -> Result<LaunchedSessionRuntime, SessionManagerError>;
}

struct SessionRecord {
    snapshot: LoginBrowserSessionSnapshot,
    backend: Arc<dyn SessionOwnedBackend>,
    control: Arc<LoginBrowserControl>,
    navigation_policy: Arc<SessionNavigationPolicy>,
    handoff_candidate: Option<handoff::HandoffCandidateId>,
    /// Opaque native conversation lineage that owns the current Agent handoff.
    ///
    /// This is deliberately separate from workspace/profile identity: multiple CCEM
    /// conversations may share both while retaining independent Browser instances.
    agent_actor_id: Option<String>,
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

struct LoginBrowserSessionManagerInner {
    root: PathBuf,
    workspace_identities: WorkspaceIdentityStore,
    profiles: BrowserProfileManager,
    #[cfg(test)]
    supervisor: Option<Arc<dyn SessionSupervisor>>,
    provenance: Arc<ProvenanceLedger>,
    profile_activity: activity::ProfileActivityStore,
    sessions: Mutex<HashMap<SessionId, SessionRecord>>,
    open_gate: Mutex<()>,
}

pub(crate) struct LoginBrowserSessionManager {
    inner: Option<LoginBrowserSessionManagerInner>,
}
