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
const CEF_CACHE_ROOT_NAME: &str = "cef";
const CEF_PROFILE_DIRECTORY_PREFIX: &str = "Profile-";
const MAX_RUNTIME_ID_BYTES: usize = 160;
const MAX_RUNTIME_VERSION_BYTES: usize = 160;
const MAX_PROTOCOL_VERSION_BYTES: usize = 80;

include!("profile_types.rs");

#[derive(Clone)]
pub(crate) struct BrowserProfileManager {
    root: PathBuf,
    profiles_root: PathBuf,
    cef_cache_root: PathBuf,
    active_leases: Arc<Mutex<HashSet<ProfileId>>>,
}

impl BrowserProfileManager {
    pub(crate) fn new(root: PathBuf, cef_cache_root: PathBuf) -> Result<Self, ProfileError> {
        if !root.is_absolute() || !cef_cache_root.is_absolute() {
            return Err(ProfileError::UnsafePath(
                "profile roots must be absolute".to_string(),
            ));
        }
        let storage_parent = root.parent().ok_or_else(|| {
            ProfileError::UnsafePath("profile state root has no app-owned parent".to_string())
        })?;
        if root == cef_cache_root
            || cef_cache_root.parent() != Some(storage_parent)
            || cef_cache_root.file_name().and_then(|name| name.to_str())
                != Some(CEF_CACHE_ROOT_NAME)
        {
            return Err(ProfileError::UnsafePath(
                "CEF cache root must be the cef sibling of profile state".to_string(),
            ));
        }

        ensure_private_directory(storage_parent)?;
        ensure_private_child_directory(storage_parent, &root)?;
        ensure_private_child_directory(storage_parent, &cef_cache_root)?;
        let profiles_root = root.join("profiles");
        ensure_private_child_directory(&root, &profiles_root)?;
        Ok(Self {
            root,
            profiles_root,
            cef_cache_root,
            active_leases: Arc::new(Mutex::new(HashSet::new())),
        })
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    #[cfg(test)]
    pub(crate) fn cef_cache_root(&self) -> &Path {
        &self.cef_cache_root
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

    /// Reserve a stopped profile for an embedded launch without changing its persisted cleanup
    /// state. The reservation owns both the in-process slot and the OS file lock. Its ownership id
    /// is generated before the crash-recovery intent is written and before LaunchPending exists.
    pub(in crate::browser::login) fn reserve_embedded_launch(
        &self,
        profile_id: &ProfileId,
        workspace_identity: &TrustedWorkspaceIdentity,
    ) -> Result<EmbeddedProfileLaunchReservation, ProfileError> {
        self.reserve_in_process(profile_id)?;
        let result = (|| {
            let profile_dir = self.checked_profile_dir(profile_id)?;
            let lock_file = open_profile_lock(&profile_dir.join("profile.lock"))?;
            lock_file
                .try_lock_exclusive()
                .map_err(|error| match error.kind() {
                    std::io::ErrorKind::WouldBlock => ProfileError::ProfileInUse,
                    _ => io_error("reserve embedded browser profile", error),
                })?;
            let descriptor = load_current_descriptor(&profile_dir, profile_id)?;
            verify_workspace(&descriptor, workspace_identity)?;
            if !descriptor.cleanup_state.is_stopped() {
                let _ = FileExt::unlock(&lock_file);
                return Err(ProfileError::ProfileRequiresCleanup);
            }
            Ok(EmbeddedProfileLaunchReservation {
                profile_dir,
                descriptor,
                ownership_id: random_opaque_id("ownership"),
                lock_file: Some(lock_file),
                active_leases: Arc::clone(&self.active_leases),
                reserved: true,
            })
        })();
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

    /// Atomically checks the profile lock and reconciles an embedded CEF owner whose exact host
    /// process is gone. The caller must first validate the persisted owner record, host process
    /// birth identity, workspace, and (for RuntimeOwned) the CEF surface runtime id.
    ///
    /// `AlreadyStopped` covers the final clean-shutdown crash window: OnBeforeClose was observed
    /// and the profile was persisted/unlocked, but deleting the owner record did not finish.
    pub(in crate::browser::login) fn recover_embedded_after_host_gone(
        &self,
        profile_id: &ProfileId,
        workspace_identity: &TrustedWorkspaceIdentity,
        proof: OwnershipDomainGone,
    ) -> Result<EmbeddedProfileRecoveryOutcome, ProfileError> {
        let mut maintenance = self.acquire_maintenance_lock(profile_id, workspace_identity)?;
        match maintenance.descriptor.cleanup_state.ownership_id() {
            Some(expected) if expected == proof.ownership_id => {
                maintenance.descriptor.cleanup_state = ProfileCleanupState::Stopped;
                maintenance.persist_and_release()?;
                Ok(EmbeddedProfileRecoveryOutcome::Recovered)
            }
            None if maintenance.descriptor.cleanup_state.is_stopped() => {
                maintenance.release_without_state_change()?;
                Ok(EmbeddedProfileRecoveryOutcome::AlreadyStopped)
            }
            _ => Err(ProfileError::OwnershipMismatch),
        }
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
        let cef_profile_dir = self.checked_cef_profile_dir(&authorization.profile_id)?;
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
        let cef_tombstone = self.cef_cache_root.join(format!(
            "{CEF_PROFILE_DIRECTORY_PREFIX}{}.reset-{reset_id}",
            authorization.profile_id.as_str()
        ));
        // Reset replaces the complete, stopped profile after trusted confirmation. It never
        // targets Chrome's Singleton* files to bypass an active browser's own lock protocol.
        reset_private_child_directory(&maintenance.profile_dir, &user_data, &tombstone)?;
        reset_private_child_directory(&self.cef_cache_root, &cef_profile_dir, &cef_tombstone)?;

        maintenance.descriptor.last_used_at = None;
        maintenance.descriptor.runtime_compatibility = ProfileRuntimeCompatibility::default();
        maintenance.descriptor.cleanup_state = ProfileCleanupState::Stopped;
        let descriptor = maintenance.persist_and_release()?;
        remove_private_directory_if_present(&maintenance.profile_dir, &tombstone)?;
        remove_private_directory_if_present(&self.cef_cache_root, &cef_tombstone)?;
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
        let cef_profile_dir = self.checked_cef_profile_dir(&authorization.profile_id)?;
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
        // Keep the descriptor and its maintenance lock until the external CEF cache is gone. If
        // the process stops here, the persisted Deleting state gives a fresh trusted retry enough
        // information to finish. The descriptor directory is deliberately the final deletion.
        remove_private_directory_if_present(&self.cef_cache_root, &cef_profile_dir)?;
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

    fn checked_cef_profile_dir(&self, profile_id: &ProfileId) -> Result<PathBuf, ProfileError> {
        ProfileId::parse(profile_id.as_str())?;
        let storage_parent = self.root.parent().ok_or_else(|| {
            ProfileError::UnsafePath("profile state root has no app-owned parent".to_string())
        })?;
        ensure_private_child_directory(storage_parent, &self.cef_cache_root)?;
        let path = self.cef_cache_root.join(format!(
            "{CEF_PROFILE_DIRECTORY_PREFIX}{}",
            profile_id.as_str()
        ));
        if path.parent() != Some(self.cef_cache_root.as_path()) {
            return Err(ProfileError::UnsafePath(
                "CEF profile cache escaped its direct-child root".to_string(),
            ));
        }
        ensure_path_is_not_symlink(&path)?;
        Ok(path)
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

fn reset_private_child_directory(
    parent: &Path,
    target: &Path,
    tombstone: &Path,
) -> Result<(), ProfileError> {
    if target.parent() != Some(parent) || tombstone.parent() != Some(parent) || target == tombstone
    {
        return Err(ProfileError::UnsafePath(
            "profile reset paths must be distinct direct children".to_string(),
        ));
    }
    ensure_path_is_not_symlink(parent)?;
    ensure_path_is_not_symlink(target)?;
    ensure_path_is_not_symlink(tombstone)?;
    remove_private_directory_if_present(parent, tombstone)?;

    let staged = match fs::symlink_metadata(target) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            fs::rename(target, tombstone)
                .map_err(|error| io_error("stage browser profile reset", error))?;
            true
        }
        Ok(_) => {
            return Err(ProfileError::UnsafePath(format!(
                "{} is not a real directory",
                target.display()
            )))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(io_error("inspect browser profile reset target", error)),
    };

    if let Err(error) = ensure_private_child_directory(parent, target) {
        let _ = remove_private_directory_if_present(parent, target);
        if staged {
            let _ = fs::rename(tombstone, target);
        }
        return Err(error);
    }
    Ok(())
}

pub(crate) struct BrowserProfileLease {
    profile_dir: PathBuf,
    descriptor: BrowserProfileDescriptor,
    ownership_id: String,
    lock_file: Option<File>,
    active_leases: Arc<Mutex<HashSet<ProfileId>>>,
}

/// A stopped profile held exclusively while its embedded-owner intent is made durable.
pub(in crate::browser::login) struct EmbeddedProfileLaunchReservation {
    profile_dir: PathBuf,
    descriptor: BrowserProfileDescriptor,
    ownership_id: String,
    lock_file: Option<File>,
    active_leases: Arc<Mutex<HashSet<ProfileId>>>,
    reserved: bool,
}

impl EmbeddedProfileLaunchReservation {
    pub(in crate::browser::login) fn descriptor(&self) -> &BrowserProfileDescriptor {
        &self.descriptor
    }

    pub(in crate::browser::login) fn ownership_id(&self) -> &str {
        &self.ownership_id
    }

    /// Commit LaunchPending only after the embedded owner intent has been fsynced. On any error,
    /// Drop releases the reservation but deliberately does not guess whether a failed metadata
    /// publish became durable; the already-written intent remains for startup reconciliation.
    pub(in crate::browser::login) fn commit_launch_pending(
        mut self,
    ) -> Result<(BrowserProfileLease, EmbeddedProfileLaunchPendingProof), ProfileError> {
        if !self.descriptor.cleanup_state.is_stopped() {
            return Err(ProfileError::ProfileRequiresCleanup);
        }
        self.descriptor.cleanup_state = ProfileCleanupState::LaunchPending {
            ownership_id: self.ownership_id.clone(),
            since: Utc::now().to_rfc3339(),
        };
        self.descriptor = persist_next_descriptor(&self.profile_dir, self.descriptor.clone())?;
        let proof = EmbeddedProfileLaunchPendingProof {
            profile_id: self.descriptor.profile_id.clone(),
            workspace_identity: self.descriptor.workspace_identity.clone(),
            ownership_id: self.ownership_id.clone(),
        };
        let lock_file = self.lock_file.take().ok_or(ProfileError::ProfileInUse)?;
        self.reserved = false;
        Ok((
            BrowserProfileLease {
                profile_dir: self.profile_dir.clone(),
                descriptor: self.descriptor.clone(),
                ownership_id: self.ownership_id.clone(),
                lock_file: Some(lock_file),
                active_leases: Arc::clone(&self.active_leases),
            },
            proof,
        ))
    }
}

impl Drop for EmbeddedProfileLaunchReservation {
    fn drop(&mut self) {
        if let Some(lock_file) = self.lock_file.take() {
            let _ = FileExt::unlock(&lock_file);
        }
        if self.reserved {
            if let Ok(mut active) = self.active_leases.lock() {
                active.remove(&self.descriptor.profile_id);
            }
        }
    }
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

    /// CEF-specific transition that also returns a non-forgeable record-update capability.
    pub(in crate::browser::login) fn mark_embedded_runtime_owned(
        &mut self,
        runtime_id: &str,
        runtime_version: &str,
        protocol_version: &str,
    ) -> Result<(BrowserProfileDescriptor, EmbeddedProfileRuntimeOwnedProof), ProfileError> {
        let descriptor = self.mark_runtime_owned(runtime_id, runtime_version, protocol_version)?;
        let proof = EmbeddedProfileRuntimeOwnedProof {
            profile_id: descriptor.profile_id.clone(),
            workspace_identity: descriptor.workspace_identity.clone(),
            ownership_id: self.ownership_id.clone(),
            runtime_id: runtime_id.to_string(),
        };
        Ok((descriptor, proof))
    }

    /// Cancel a launch that failed before any native/process ownership domain was created.
    /// Once `mark_runtime_owned` succeeds, callers must instead provide the concrete runtime's
    /// verified terminal proof.
    pub(in crate::browser::login) fn cancel_pending_launch(
        mut self,
    ) -> Result<BrowserProfileDescriptor, ProfileError> {
        if !matches!(
            &self.descriptor.cleanup_state,
            ProfileCleanupState::LaunchPending { ownership_id, .. }
                if ownership_id == &self.ownership_id
        ) {
            return Err(ProfileError::OwnershipMismatch);
        }
        self.descriptor.cleanup_state = ProfileCleanupState::Stopped;
        self.descriptor = persist_next_descriptor(&self.profile_dir, self.descriptor.clone())?;
        self.release_lock()?;
        Ok(self.descriptor.clone())
    }

    /// Cancel a recorded embedded launch before a native surface owner was created, then mint the
    /// capability required to remove that matching pending owner record.
    pub(in crate::browser::login) fn cancel_pending_embedded_launch(
        self,
    ) -> Result<(BrowserProfileDescriptor, EmbeddedProfileReleasedProof), ProfileError> {
        let profile_id = self.descriptor.profile_id.clone();
        let workspace_identity = self.descriptor.workspace_identity.clone();
        let ownership_id = self.ownership_id.clone();
        let descriptor = self.cancel_pending_launch()?;
        Ok((
            descriptor,
            EmbeddedProfileReleasedProof {
                profile_id,
                workspace_identity,
                ownership_id,
            },
        ))
    }

    pub(crate) fn release_after_ownership_domain_gone(
        mut self,
        proof: OwnershipDomainGone,
    ) -> Result<BrowserProfileDescriptor, ProfileError> {
        self.try_release_after_ownership_domain_gone(proof)
    }

    /// Retryable core of terminal profile release. The lease remains intact if persistence or
    /// unlock fails, so the verified owner can retry without waiting for process restart recovery.
    /// `Stopped` is accepted only on this still-held lease to cover a durable metadata write
    /// followed by a transient unlock failure.
    fn try_release_after_ownership_domain_gone(
        &mut self,
        proof: OwnershipDomainGone,
    ) -> Result<BrowserProfileDescriptor, ProfileError> {
        if proof.ownership_id != self.ownership_id {
            return Err(ProfileError::OwnershipMismatch);
        }
        match self.descriptor.cleanup_state.ownership_id() {
            Some(ownership_id) if ownership_id == self.ownership_id => {
                let mut stopped = self.descriptor.clone();
                stopped.cleanup_state = ProfileCleanupState::Stopped;
                self.descriptor = persist_next_descriptor(&self.profile_dir, stopped)?;
            }
            None if self.descriptor.cleanup_state.is_stopped() => {}
            _ => return Err(ProfileError::OwnershipMismatch),
        }
        self.release_lock()?;
        Ok(self.descriptor.clone())
    }

    /// Release a closed embedded surface and return the capability that permits deleting its owner
    /// record. The capability is minted only after Stopped was durable and the profile lock gone.
    pub(in crate::browser::login) fn release_embedded_after_ownership_domain_gone(
        mut self,
        proof: OwnershipDomainGone,
    ) -> Result<(BrowserProfileDescriptor, EmbeddedProfileReleasedProof), ProfileError> {
        self.try_release_embedded_after_ownership_domain_gone(proof)
    }

    /// Borrowing variant used by the embedded surface owner so transient storage failures retain
    /// the exact OS lock and in-process reservation for an immediate, authoritative retry.
    pub(in crate::browser::login) fn try_release_embedded_after_ownership_domain_gone(
        &mut self,
        proof: OwnershipDomainGone,
    ) -> Result<(BrowserProfileDescriptor, EmbeddedProfileReleasedProof), ProfileError> {
        let profile_id = self.descriptor.profile_id.clone();
        let workspace_identity = self.descriptor.workspace_identity.clone();
        let ownership_id = self.ownership_id.clone();
        let descriptor = self.try_release_after_ownership_domain_gone(proof)?;
        Ok((
            descriptor,
            EmbeddedProfileReleasedProof {
                profile_id,
                workspace_identity,
                ownership_id,
            },
        ))
    }

    fn release_lock(&mut self) -> Result<(), ProfileError> {
        if let Some(lock_file) = self.lock_file.as_ref() {
            FileExt::unlock(lock_file)
                .map_err(|error| io_error("unlock browser profile", error))?;
        }
        self.lock_file.take();
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
