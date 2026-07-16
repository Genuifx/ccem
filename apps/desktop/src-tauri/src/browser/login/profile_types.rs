#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct ProfileId(String);

impl ProfileId {
    fn generate() -> Self {
        let mut bytes = [0_u8; 16];
        OsRng.fill_bytes(&mut bytes);
        Self(format!("{PROFILE_ID_PREFIX}{}", hex::encode(bytes)))
    }

    pub(crate) fn parse(value: &str) -> Result<Self, ProfileError> {
        let Some(hex) = value.strip_prefix(PROFILE_ID_PREFIX) else {
            return Err(ProfileError::InvalidProfileId);
        };
        if hex.len() != PROFILE_ID_HEX_LENGTH || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(ProfileError::InvalidProfileId);
        }
        Ok(Self(value.to_ascii_lowercase()))
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

/// A stable workspace identity resolved by trusted CCEM state.
///
/// This type is deliberately not deserializable. Agent arguments and mutable display paths must be
/// resolved by the trusted application layer before they can authorize access to a login profile.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct TrustedWorkspaceIdentity(String);

impl TrustedWorkspaceIdentity {
    pub(crate) fn from_trusted_store(value: impl Into<String>) -> Result<Self, ProfileError> {
        let value = value.into();
        let trimmed = value.trim();
        if trimmed.is_empty()
            || trimmed.len() > 160
            || trimmed != value
            || trimmed.contains('/')
            || trimmed.contains('\\')
            || !trimmed.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':')
            })
        {
            return Err(ProfileError::InvalidWorkspaceIdentity);
        }
        Ok(Self(value))
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ProfileRuntimeCompatibility {
    pub profile_format_version: u32,
    pub last_runtime_version: Option<String>,
    pub last_protocol_version: Option<String>,
}

impl Default for ProfileRuntimeCompatibility {
    fn default() -> Self {
        Self {
            profile_format_version: PROFILE_FORMAT_VERSION,
            last_runtime_version: None,
            last_protocol_version: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub(crate) enum ProfileCleanupState {
    Stopped,
    LaunchPending {
        ownership_id: String,
        since: String,
    },
    RuntimeOwned {
        ownership_id: String,
        runtime_id: String,
        since: String,
    },
    Resetting {
        authorization_id: String,
        since: String,
    },
    Deleting {
        authorization_id: String,
        since: String,
    },
}

impl ProfileCleanupState {
    fn ownership_id(&self) -> Option<&str> {
        match self {
            Self::LaunchPending { ownership_id, .. } | Self::RuntimeOwned { ownership_id, .. } => {
                Some(ownership_id)
            }
            Self::Stopped | Self::Resetting { .. } | Self::Deleting { .. } => None,
        }
    }

    fn is_stopped(&self) -> bool {
        matches!(self, Self::Stopped)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct BrowserProfileDescriptor {
    schema_version: u32,
    revision: u64,
    profile_id: ProfileId,
    workspace_identity: String,
    created_at: String,
    last_used_at: Option<String>,
    runtime_compatibility: ProfileRuntimeCompatibility,
    cleanup_state: ProfileCleanupState,
}

impl BrowserProfileDescriptor {
    pub(crate) fn profile_id(&self) -> &ProfileId {
        &self.profile_id
    }

    pub(crate) fn workspace_identity(&self) -> &str {
        &self.workspace_identity
    }

    pub(crate) fn last_used_at(&self) -> Option<&str> {
        self.last_used_at.as_deref()
    }

    pub(crate) fn runtime_compatibility(&self) -> &ProfileRuntimeCompatibility {
        &self.runtime_compatibility
    }

    pub(crate) fn cleanup_state(&self) -> &ProfileCleanupState {
        &self.cleanup_state
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DestructiveProfileAction {
    Reset,
    Delete,
}

/// A single-use capability minted by the trusted CCEM UI layer.
///
/// It is intentionally neither serializable nor clonable, so an Agent request cannot manufacture
/// or replay this authorization as ordinary JSON input.
pub(crate) struct DestructiveProfileAuthorization {
    authorization_id: String,
    action: DestructiveProfileAction,
    profile_id: ProfileId,
    workspace_identity: TrustedWorkspaceIdentity,
    expires_at: Instant,
}

impl DestructiveProfileAuthorization {
    pub(crate) fn from_trusted_ui(
        action: DestructiveProfileAction,
        profile_id: ProfileId,
        workspace_identity: TrustedWorkspaceIdentity,
        ttl: Duration,
    ) -> Result<Self, ProfileError> {
        if ttl.is_zero() || ttl > Duration::from_secs(5 * 60) {
            return Err(ProfileError::InvalidDestructiveAuthorization);
        }
        Ok(Self {
            authorization_id: random_opaque_id("destructive"),
            action,
            profile_id,
            workspace_identity,
            expires_at: Instant::now() + ttl,
        })
    }

    fn validate(&self, expected: DestructiveProfileAction) -> Result<(), ProfileError> {
        if self.action != expected {
            return Err(ProfileError::DestructiveActionMismatch);
        }
        if Instant::now() > self.expires_at {
            return Err(ProfileError::DestructiveAuthorizationExpired);
        }
        Ok(())
    }
}

/// Evidence produced only after the supervisor has observed the complete process group or Job
/// Object ownership domain disappear. It is not accepted from IPC or Agent input.
pub(crate) struct OwnershipDomainGone {
    ownership_id: String,
}

impl OwnershipDomainGone {
    pub(crate) fn from_supervisor(ownership_id: impl Into<String>) -> Result<Self, ProfileError> {
        let ownership_id = ownership_id.into();
        validate_bounded_identifier(&ownership_id, MAX_RUNTIME_ID_BYTES, "ownership id")?;
        Ok(Self { ownership_id })
    }

    /// Minted only after the CEF host observed `OnBeforeClose` for the exact owned surface.
    /// Embedded CEF has no external process group, so its native child-view lifecycle is the
    /// ownership domain that must disappear before a persistent profile can be unlocked.
    pub(in crate::browser::login) fn from_closed_cef_surface(
        ownership_id: impl Into<String>,
    ) -> Result<Self, ProfileError> {
        let ownership_id = ownership_id.into();
        validate_bounded_identifier(&ownership_id, MAX_RUNTIME_ID_BYTES, "ownership id")?;
        Ok(Self { ownership_id })
    }

    /// Minted by the embedded-owner startup reaper only after it has proved that the exact CCEM
    /// host process recorded before native surface creation no longer exists. A PID by itself is
    /// never sufficient evidence because it may have been reused.
    pub(in crate::browser::login) fn from_dead_cef_host(
        ownership_id: impl Into<String>,
    ) -> Result<Self, ProfileError> {
        let ownership_id = ownership_id.into();
        validate_bounded_identifier(&ownership_id, MAX_RUNTIME_ID_BYTES, "ownership id")?;
        Ok(Self { ownership_id })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::browser::login) enum EmbeddedProfileRecoveryOutcome {
    Recovered,
    AlreadyStopped,
}

/// Non-serializable evidence that this exact lease durably entered RuntimeOwned.
pub(in crate::browser::login) struct EmbeddedProfileRuntimeOwnedProof {
    profile_id: ProfileId,
    workspace_identity: String,
    ownership_id: String,
    runtime_id: String,
}

/// Non-serializable evidence that the reserved embedded ownership id was durably committed as
/// LaunchPending. The recovery record consumes this before any native CEF surface may be opened.
pub(in crate::browser::login) struct EmbeddedProfileLaunchPendingProof {
    profile_id: ProfileId,
    workspace_identity: String,
    ownership_id: String,
}

impl EmbeddedProfileLaunchPendingProof {
    pub(in crate::browser::login) fn profile_id(&self) -> &ProfileId {
        &self.profile_id
    }

    pub(in crate::browser::login) fn workspace_identity(&self) -> &str {
        &self.workspace_identity
    }

    pub(in crate::browser::login) fn ownership_id(&self) -> &str {
        &self.ownership_id
    }
}

impl EmbeddedProfileRuntimeOwnedProof {
    pub(in crate::browser::login) fn profile_id(&self) -> &ProfileId {
        &self.profile_id
    }

    pub(in crate::browser::login) fn workspace_identity(&self) -> &str {
        &self.workspace_identity
    }

    pub(in crate::browser::login) fn ownership_id(&self) -> &str {
        &self.ownership_id
    }

    pub(in crate::browser::login) fn runtime_id(&self) -> &str {
        &self.runtime_id
    }
}

/// Non-serializable evidence returned only after the exact embedded lease persisted Stopped and
/// released its OS file lock. It authorizes deletion of the matching crash-recovery record.
pub(in crate::browser::login) struct EmbeddedProfileReleasedProof {
    profile_id: ProfileId,
    workspace_identity: String,
    ownership_id: String,
}

impl EmbeddedProfileReleasedProof {
    pub(in crate::browser::login) fn profile_id(&self) -> &ProfileId {
        &self.profile_id
    }

    pub(in crate::browser::login) fn workspace_identity(&self) -> &str {
        &self.workspace_identity
    }

    pub(in crate::browser::login) fn ownership_id(&self) -> &str {
        &self.ownership_id
    }
}

#[derive(Debug)]
pub(crate) enum ProfileError {
    InvalidProfileId,
    InvalidWorkspaceIdentity,
    InvalidRuntimeIdentity(String),
    InvalidDestructiveAuthorization,
    DestructiveActionMismatch,
    DestructiveAuthorizationExpired,
    ProfileNotFound(String),
    WorkspaceMismatch,
    ProfileInUse,
    ProfileRequiresCleanup,
    ProfileNotStopped,
    OwnershipMismatch,
    UnsafePath(String),
    CorruptMetadata(String),
    Io(String),
}

impl fmt::Display for ProfileError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidProfileId => write!(formatter, "Invalid opaque browser profile id."),
            Self::InvalidWorkspaceIdentity => {
                write!(formatter, "Invalid trusted workspace identity.")
            }
            Self::InvalidRuntimeIdentity(field) => {
                write!(formatter, "Invalid managed browser {field}.")
            }
            Self::InvalidDestructiveAuthorization => {
                write!(formatter, "Invalid destructive profile authorization.")
            }
            Self::DestructiveActionMismatch => {
                write!(
                    formatter,
                    "Destructive profile authorization action does not match."
                )
            }
            Self::DestructiveAuthorizationExpired => {
                write!(formatter, "Destructive profile authorization expired.")
            }
            Self::ProfileNotFound(profile_id) => {
                write!(formatter, "Browser profile {profile_id} was not found.")
            }
            Self::WorkspaceMismatch => {
                write!(
                    formatter,
                    "Browser profile belongs to another workspace identity."
                )
            }
            Self::ProfileInUse => write!(formatter, "Browser profile is already in use."),
            Self::ProfileRequiresCleanup => write!(
                formatter,
                "Browser profile requires verified ownership-domain cleanup before launch."
            ),
            Self::ProfileNotStopped => {
                write!(
                    formatter,
                    "Browser profile must be stopped before this operation."
                )
            }
            Self::OwnershipMismatch => write!(
                formatter,
                "Ownership-domain proof does not match the browser profile lease."
            ),
            Self::UnsafePath(message) => {
                write!(formatter, "Unsafe browser profile path: {message}")
            }
            Self::CorruptMetadata(message) => {
                write!(formatter, "Corrupt browser profile metadata: {message}")
            }
            Self::Io(message) => write!(formatter, "Browser profile storage error: {message}"),
        }
    }
}

impl std::error::Error for ProfileError {}
