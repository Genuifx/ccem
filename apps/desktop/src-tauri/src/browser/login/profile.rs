#[path = "profile_storage.rs"]
mod storage;

use self::storage::*;
use chrono::Utc;
use fs2::FileExt;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fmt;
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const PROFILE_SCHEMA_VERSION: u32 = 1;
const PROFILE_FORMAT_VERSION: u32 = 1;
const PROFILE_ID_PREFIX: &str = "profile-";
const PROFILE_ID_HEX_LENGTH: usize = 32;
const METADATA_FILE_PREFIX: &str = "profile-";
const METADATA_FILE_SUFFIX: &str = ".json";
const METADATA_REVISION_WIDTH: usize = 20;
const MAX_RUNTIME_ID_BYTES: usize = 160;
const MAX_RUNTIME_VERSION_BYTES: usize = 160;
const MAX_PROTOCOL_VERSION_BYTES: usize = 80;

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

#[derive(Clone)]
pub(crate) struct BrowserProfileManager {
    root: PathBuf,
    profiles_root: PathBuf,
    active_leases: Arc<Mutex<HashSet<ProfileId>>>,
}

impl BrowserProfileManager {
    pub(crate) fn new(root: PathBuf) -> Result<Self, ProfileError> {
        ensure_private_directory(&root)?;
        let profiles_root = root.join("profiles");
        ensure_private_child_directory(&root, &profiles_root)?;
        Ok(Self {
            root,
            profiles_root,
            active_leases: Arc::new(Mutex::new(HashSet::new())),
        })
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn create_profile(
        &self,
        workspace_identity: &TrustedWorkspaceIdentity,
    ) -> Result<BrowserProfileDescriptor, ProfileError> {
        for _ in 0..16 {
            let profile_id = ProfileId::generate();
            let profile_dir = self.profile_dir(&profile_id);
            match fs::create_dir(&profile_dir) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(io_error("create browser profile directory", error)),
            }
            let initialized = (|| {
                secure_directory(&profile_dir)?;
                ensure_profile_directory(&self.profiles_root, &profile_dir)?;
                ensure_private_child_directory(&profile_dir, &profile_dir.join("user-data"))?;
                ensure_private_lock_file(&profile_dir.join("profile.lock"))?;

                let now = Utc::now().to_rfc3339();
                let descriptor = BrowserProfileDescriptor {
                    schema_version: PROFILE_SCHEMA_VERSION,
                    revision: 1,
                    profile_id,
                    workspace_identity: workspace_identity.as_str().to_string(),
                    created_at: now,
                    last_used_at: None,
                    runtime_compatibility: ProfileRuntimeCompatibility::default(),
                    cleanup_state: ProfileCleanupState::Stopped,
                };
                write_descriptor_generation(&profile_dir, &descriptor)?;
                Ok(descriptor)
            })();
            match initialized {
                Ok(descriptor) => return Ok(descriptor),
                Err(error) => {
                    // This id was never returned, so removing its incomplete private directory
                    // cannot destroy an existing profile or bypass a Chrome singleton lock.
                    let _ = fs::remove_dir_all(&profile_dir);
                    return Err(error);
                }
            }
        }
        Err(ProfileError::Io(
            "failed to allocate a unique browser profile id".to_string(),
        ))
    }

    /// Lists app-owned profiles for one trusted workspace in stable default-selection order.
    ///
    /// The earliest created surviving profile is first. An explicit new-profile flow therefore
    /// never silently replaces the workspace's established default on the next app launch.
    pub(crate) fn list_profiles(
        &self,
        workspace_identity: &TrustedWorkspaceIdentity,
    ) -> Result<Vec<BrowserProfileDescriptor>, ProfileError> {
        let entries = fs::read_dir(&self.profiles_root)
            .map_err(|error| io_error("list browser profiles", error))?;
        let mut descriptors = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|error| io_error("list browser profiles", error))?;
            let Some(name) = entry.file_name().to_str().map(ToOwned::to_owned) else {
                continue;
            };
            let Ok(profile_id) = ProfileId::parse(&name) else {
                continue;
            };
            let profile_dir = entry.path();
            ensure_profile_directory(&self.profiles_root, &profile_dir)?;
            let descriptor = load_current_descriptor(&profile_dir, &profile_id)?;
            if descriptor.workspace_identity == workspace_identity.as_str() {
                descriptors.push(descriptor);
            }
        }
        descriptors.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.profile_id.as_str().cmp(right.profile_id.as_str()))
        });
        Ok(descriptors)
    }

    pub(crate) fn descriptor(
        &self,
        profile_id: &ProfileId,
        workspace_identity: &TrustedWorkspaceIdentity,
    ) -> Result<BrowserProfileDescriptor, ProfileError> {
        let profile_dir = self.checked_profile_dir(profile_id)?;
        let descriptor = load_current_descriptor(&profile_dir, profile_id)?;
        verify_workspace(&descriptor, workspace_identity)?;
        Ok(descriptor)
    }

    pub(crate) fn acquire_launch_lease(
        &self,
        profile_id: &ProfileId,
        workspace_identity: &TrustedWorkspaceIdentity,
    ) -> Result<BrowserProfileLease, ProfileError> {
        self.reserve_in_process(profile_id)?;
        let result = self.acquire_launch_lease_reserved(profile_id, workspace_identity);
        if result.is_err() {
            self.release_in_process(profile_id);
        }
        result
    }

    fn acquire_launch_lease_reserved(
        &self,
        profile_id: &ProfileId,
        workspace_identity: &TrustedWorkspaceIdentity,
    ) -> Result<BrowserProfileLease, ProfileError> {
        let profile_dir = self.checked_profile_dir(profile_id)?;
        let lock_file = open_profile_lock(&profile_dir.join("profile.lock"))?;
        lock_file
            .try_lock_exclusive()
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::WouldBlock => ProfileError::ProfileInUse,
                _ => io_error("lock browser profile", error),
            })?;

        let mut descriptor = load_current_descriptor(&profile_dir, profile_id)?;
        verify_workspace(&descriptor, workspace_identity)?;
        if !descriptor.cleanup_state.is_stopped() {
            let _ = FileExt::unlock(&lock_file);
            return Err(ProfileError::ProfileRequiresCleanup);
        }

        let ownership_id = random_opaque_id("ownership");
        descriptor.cleanup_state = ProfileCleanupState::LaunchPending {
            ownership_id: ownership_id.clone(),
            since: Utc::now().to_rfc3339(),
        };
        descriptor = persist_next_descriptor(&profile_dir, descriptor)?;

        Ok(BrowserProfileLease {
            profile_dir,
            descriptor,
            ownership_id,
            lock_file: Some(lock_file),
            active_leases: Arc::clone(&self.active_leases),
        })
    }

    pub(crate) fn recover_after_ownership_domain_gone(
        &self,
        profile_id: &ProfileId,
        workspace_identity: &TrustedWorkspaceIdentity,
        proof: OwnershipDomainGone,
    ) -> Result<BrowserProfileDescriptor, ProfileError> {
        let mut maintenance = self.acquire_maintenance_lock(profile_id, workspace_identity)?;
        let Some(expected) = maintenance.descriptor.cleanup_state.ownership_id() else {
            return Err(ProfileError::OwnershipMismatch);
        };
        if expected != proof.ownership_id {
            return Err(ProfileError::OwnershipMismatch);
        }
        maintenance.descriptor.cleanup_state = ProfileCleanupState::Stopped;
        maintenance.persist_and_release()
    }

    pub(crate) fn reset_profile(
        &self,
        authorization: DestructiveProfileAuthorization,
    ) -> Result<BrowserProfileDescriptor, ProfileError> {
        authorization.validate(DestructiveProfileAction::Reset)?;
        let mut maintenance = self.acquire_maintenance_lock(
            &authorization.profile_id,
            &authorization.workspace_identity,
        )?;
        let reset_id = match &maintenance.descriptor.cleanup_state {
            ProfileCleanupState::Stopped => {
                let reset_id = authorization.authorization_id.clone();
                maintenance.descriptor.cleanup_state = ProfileCleanupState::Resetting {
                    authorization_id: reset_id.clone(),
                    since: Utc::now().to_rfc3339(),
                };
                maintenance.persist()?;
                reset_id
            }
            // A prior trusted reset can be resumed after a controller crash. The new trusted
            // authorization permits the retry; the persisted id locates its existing tombstone.
            ProfileCleanupState::Resetting {
                authorization_id, ..
            } => authorization_id.clone(),
            _ => return Err(ProfileError::ProfileNotStopped),
        };

        let user_data = maintenance.profile_dir.join("user-data");
        let tombstone = maintenance
            .profile_dir
            .join(format!("user-data.reset-{reset_id}"));
        // Reset replaces the complete, stopped profile after trusted confirmation. It never
        // targets Chrome's Singleton* files to bypass an active browser's own lock protocol.
        ensure_path_is_not_symlink(&user_data)?;
        if tombstone.exists() {
            remove_private_directory(&maintenance.profile_dir, &tombstone)?;
        }
        if user_data.exists() {
            fs::rename(&user_data, &tombstone)
                .map_err(|error| io_error("stage browser profile reset", error))?;
        }
        if let Err(error) = ensure_private_child_directory(&maintenance.profile_dir, &user_data) {
            let _ = fs::rename(&tombstone, &user_data);
            return Err(error);
        }

        maintenance.descriptor.last_used_at = None;
        maintenance.descriptor.runtime_compatibility = ProfileRuntimeCompatibility::default();
        maintenance.descriptor.cleanup_state = ProfileCleanupState::Stopped;
        let descriptor = maintenance.persist_and_release()?;
        if tombstone.exists() {
            remove_private_directory(&maintenance.profile_dir, &tombstone)?;
        }
        Ok(descriptor)
    }

    pub(crate) fn delete_profile(
        &self,
        authorization: DestructiveProfileAuthorization,
    ) -> Result<(), ProfileError> {
        authorization.validate(DestructiveProfileAction::Delete)?;
        let mut maintenance = self.acquire_maintenance_lock(
            &authorization.profile_id,
            &authorization.workspace_identity,
        )?;
        match &maintenance.descriptor.cleanup_state {
            ProfileCleanupState::Stopped => {
                maintenance.descriptor.cleanup_state = ProfileCleanupState::Deleting {
                    authorization_id: authorization.authorization_id,
                    since: Utc::now().to_rfc3339(),
                };
                maintenance.persist()?;
            }
            // Deletion is idempotently resumable after a crash, but still requires a fresh trusted
            // confirmation. Launch remains blocked while the persisted state is Deleting.
            ProfileCleanupState::Deleting { .. } => {}
            _ => return Err(ProfileError::ProfileNotStopped),
        }
        let profile_dir = maintenance.profile_dir.clone();
        maintenance.release_without_state_change()?;
        remove_private_directory(&self.profiles_root, &profile_dir)
    }

    fn acquire_maintenance_lock(
        &self,
        profile_id: &ProfileId,
        workspace_identity: &TrustedWorkspaceIdentity,
    ) -> Result<ProfileMaintenanceLease, ProfileError> {
        self.reserve_in_process(profile_id)?;
        let result = (|| {
            let profile_dir = self.checked_profile_dir(profile_id)?;
            let lock_file = open_profile_lock(&profile_dir.join("profile.lock"))?;
            lock_file
                .try_lock_exclusive()
                .map_err(|error| match error.kind() {
                    std::io::ErrorKind::WouldBlock => ProfileError::ProfileInUse,
                    _ => io_error("lock browser profile for maintenance", error),
                })?;
            let descriptor = load_current_descriptor(&profile_dir, profile_id)?;
            verify_workspace(&descriptor, workspace_identity)?;
            Ok(ProfileMaintenanceLease {
                profile_dir,
                descriptor,
                profile_id: profile_id.clone(),
                lock_file: Some(lock_file),
                active_leases: Arc::clone(&self.active_leases),
            })
        })();
        if result.is_err() {
            self.release_in_process(profile_id);
        }
        result
    }

    fn checked_profile_dir(&self, profile_id: &ProfileId) -> Result<PathBuf, ProfileError> {
        ProfileId::parse(profile_id.as_str())?;
        let profile_dir = self.profile_dir(profile_id);
        if !profile_dir.exists() {
            return Err(ProfileError::ProfileNotFound(
                profile_id.as_str().to_string(),
            ));
        }
        ensure_profile_directory(&self.profiles_root, &profile_dir)?;
        Ok(profile_dir)
    }

    fn profile_dir(&self, profile_id: &ProfileId) -> PathBuf {
        self.profiles_root.join(profile_id.as_str())
    }

    fn reserve_in_process(&self, profile_id: &ProfileId) -> Result<(), ProfileError> {
        let mut active = self
            .active_leases
            .lock()
            .map_err(|_| ProfileError::ProfileInUse)?;
        if !active.insert(profile_id.clone()) {
            return Err(ProfileError::ProfileInUse);
        }
        Ok(())
    }

    fn release_in_process(&self, profile_id: &ProfileId) {
        if let Ok(mut active) = self.active_leases.lock() {
            active.remove(profile_id);
        }
    }
}

pub(crate) struct BrowserProfileLease {
    profile_dir: PathBuf,
    descriptor: BrowserProfileDescriptor,
    ownership_id: String,
    lock_file: Option<File>,
    active_leases: Arc<Mutex<HashSet<ProfileId>>>,
}

impl BrowserProfileLease {
    pub(crate) fn descriptor(&self) -> &BrowserProfileDescriptor {
        &self.descriptor
    }

    pub(crate) fn ownership_id(&self) -> &str {
        &self.ownership_id
    }

    pub(crate) fn user_data_dir(&self) -> PathBuf {
        self.profile_dir.join("user-data")
    }

    pub(crate) fn mark_runtime_owned(
        &mut self,
        runtime_id: &str,
        runtime_version: &str,
        protocol_version: &str,
    ) -> Result<BrowserProfileDescriptor, ProfileError> {
        validate_bounded_identifier(runtime_id, MAX_RUNTIME_ID_BYTES, "runtime id")?;
        validate_bounded_identifier(
            runtime_version,
            MAX_RUNTIME_VERSION_BYTES,
            "runtime version",
        )?;
        validate_bounded_identifier(
            protocol_version,
            MAX_PROTOCOL_VERSION_BYTES,
            "protocol version",
        )?;
        if !matches!(
            &self.descriptor.cleanup_state,
            ProfileCleanupState::LaunchPending { ownership_id, .. }
                if ownership_id == &self.ownership_id
        ) {
            return Err(ProfileError::OwnershipMismatch);
        }

        let now = Utc::now().to_rfc3339();
        self.descriptor.last_used_at = Some(now.clone());
        self.descriptor.runtime_compatibility = ProfileRuntimeCompatibility {
            profile_format_version: PROFILE_FORMAT_VERSION,
            last_runtime_version: Some(runtime_version.to_string()),
            last_protocol_version: Some(protocol_version.to_string()),
        };
        self.descriptor.cleanup_state = ProfileCleanupState::RuntimeOwned {
            ownership_id: self.ownership_id.clone(),
            runtime_id: runtime_id.to_string(),
            since: now,
        };
        self.descriptor = persist_next_descriptor(&self.profile_dir, self.descriptor.clone())?;
        Ok(self.descriptor.clone())
    }

    pub(crate) fn release_after_ownership_domain_gone(
        mut self,
        proof: OwnershipDomainGone,
    ) -> Result<BrowserProfileDescriptor, ProfileError> {
        if proof.ownership_id != self.ownership_id
            || self.descriptor.cleanup_state.ownership_id() != Some(self.ownership_id.as_str())
        {
            return Err(ProfileError::OwnershipMismatch);
        }
        self.descriptor.cleanup_state = ProfileCleanupState::Stopped;
        self.descriptor = persist_next_descriptor(&self.profile_dir, self.descriptor.clone())?;
        self.release_lock()?;
        Ok(self.descriptor.clone())
    }

    fn release_lock(&mut self) -> Result<(), ProfileError> {
        if let Some(lock_file) = self.lock_file.take() {
            FileExt::unlock(&lock_file)
                .map_err(|error| io_error("unlock browser profile", error))?;
        }
        if let Ok(mut active) = self.active_leases.lock() {
            active.remove(&self.descriptor.profile_id);
        }
        Ok(())
    }
}

impl Drop for BrowserProfileLease {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active_leases.lock() {
            active.remove(&self.descriptor.profile_id);
        }
        // The OS releases the file lock on process death or accidental drop. The persisted
        // LaunchPending/RuntimeOwned state intentionally remains non-stopped, so a subsequent launch
        // still requires an OwnershipDomainGone proof from the supervisor.
    }
}

struct ProfileMaintenanceLease {
    profile_dir: PathBuf,
    descriptor: BrowserProfileDescriptor,
    profile_id: ProfileId,
    lock_file: Option<File>,
    active_leases: Arc<Mutex<HashSet<ProfileId>>>,
}

impl ProfileMaintenanceLease {
    fn persist(&mut self) -> Result<(), ProfileError> {
        self.descriptor = persist_next_descriptor(&self.profile_dir, self.descriptor.clone())?;
        Ok(())
    }

    fn persist_and_release(&mut self) -> Result<BrowserProfileDescriptor, ProfileError> {
        self.persist()?;
        self.release_without_state_change()?;
        Ok(self.descriptor.clone())
    }

    fn release_without_state_change(&mut self) -> Result<(), ProfileError> {
        if let Some(lock_file) = self.lock_file.take() {
            FileExt::unlock(&lock_file)
                .map_err(|error| io_error("unlock browser profile maintenance lease", error))?;
        }
        if let Ok(mut active) = self.active_leases.lock() {
            active.remove(&self.profile_id);
        }
        Ok(())
    }
}

impl Drop for ProfileMaintenanceLease {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active_leases.lock() {
            active.remove(&self.profile_id);
        }
    }
}

fn verify_workspace(
    descriptor: &BrowserProfileDescriptor,
    workspace_identity: &TrustedWorkspaceIdentity,
) -> Result<(), ProfileError> {
    if descriptor.workspace_identity == workspace_identity.as_str() {
        Ok(())
    } else {
        Err(ProfileError::WorkspaceMismatch)
    }
}

fn validate_bounded_identifier(
    value: &str,
    max_bytes: usize,
    field: &str,
) -> Result<(), ProfileError> {
    if value.is_empty()
        || value.len() > max_bytes
        || value.chars().any(char::is_control)
        || value.contains('/')
        || value.contains('\\')
    {
        return Err(ProfileError::InvalidRuntimeIdentity(field.to_string()));
    }
    Ok(())
}

fn random_opaque_id(prefix: &str) -> String {
    let mut bytes = [0_u8; 16];
    OsRng.fill_bytes(&mut bytes);
    format!("{prefix}-{}", hex::encode(bytes))
}

#[cfg(test)]
#[path = "profile_tests.rs"]
mod tests;
