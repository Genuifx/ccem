use super::storage::{
    read_regular_file, remove_private_directory_if_present, sync_directory, write_private_new_file,
};
use super::{
    io_error, open_profile_lock, BrowserProfileDescriptor, BrowserProfileManager, ProfileError,
    ProfileId, TrustedWorkspaceIdentity,
};
use fs2::FileExt;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::fs;

const DEFAULT_BINDING_SCHEMA_VERSION: u32 = 1;
const DEFAULT_BINDING_PREFIX: &str = "default-";
const DEFAULT_BINDING_SUFFIX: &str = ".json";
const DEFAULT_BINDING_REVISION_WIDTH: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DefaultProfileBinding {
    schema_version: u32,
    revision: u64,
    profile_id: Option<ProfileId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending_owner_identity: Option<String>,
}

enum DefaultBindingWrite {
    Empty,
    PendingCreate {
        profile_id: ProfileId,
        owner_identity: String,
    },
    Bound(ProfileId),
}

enum DefaultBindingState {
    Uninitialized,
    Empty {
        revision: u64,
    },
    Bound {
        revision: u64,
        descriptor: BrowserProfileDescriptor,
    },
}

impl BrowserProfileManager {
    /// Resolves the one app-global default without rewriting or moving any existing profile.
    ///
    /// The first resolution prefers the requesting workspace's earliest surviving legacy profile,
    /// then falls back to the globally earliest legacy profile. A cleared binding deliberately
    /// does not promote an explicitly isolated profile; the next default open creates a fresh
    /// profile instead.
    pub(crate) fn global_default_profile(
        &self,
        owner_for_new_profile: &TrustedWorkspaceIdentity,
        create_if_empty: bool,
    ) -> Result<Option<BrowserProfileDescriptor>, ProfileError> {
        let lock_file = open_profile_lock(&self.default_profile_root.join("default.lock"))?;
        lock_file
            .lock_exclusive()
            .map_err(|error| io_error("lock global browser default", error))?;

        let result = (|| {
            let state = self.load_default_binding()?;
            match state {
                DefaultBindingState::Bound { descriptor, .. } => Ok(Some(descriptor)),
                DefaultBindingState::Uninitialized => {
                    if let Some(descriptor) =
                        self.legacy_default_candidate(owner_for_new_profile)?
                    {
                        self.persist_default_binding(
                            0,
                            DefaultBindingWrite::Bound(descriptor.profile_id().clone()),
                        )?;
                        return Ok(Some(descriptor));
                    }
                    if !create_if_empty {
                        return Ok(None);
                    }
                    self.create_and_bind_default(0, owner_for_new_profile)
                        .map(Some)
                }
                DefaultBindingState::Empty { revision } => {
                    if !create_if_empty {
                        return Ok(None);
                    }
                    self.create_and_bind_default(revision, owner_for_new_profile)
                        .map(Some)
                }
            }
        })();
        let _ = FileExt::unlock(&lock_file);
        result
    }

    /// Freezes the legacy migration set before creating an explicitly isolated profile.
    ///
    /// Without this durable empty/bound generation, the first explicit profile created in a fresh
    /// installation could be mistaken for a legacy default by a later manager or workspace.
    pub(super) fn seal_legacy_default_before_explicit_profile(
        &self,
        workspace_identity: &TrustedWorkspaceIdentity,
    ) -> Result<(), ProfileError> {
        let lock_file = open_profile_lock(&self.default_profile_root.join("default.lock"))?;
        lock_file
            .lock_exclusive()
            .map_err(|error| io_error("lock global browser default", error))?;
        let result = (|| {
            if matches!(
                self.load_default_binding()?,
                DefaultBindingState::Uninitialized
            ) {
                let profile_id = self
                    .legacy_default_candidate(workspace_identity)?
                    .map(|descriptor| descriptor.profile_id().clone());
                let binding = profile_id
                    .map(DefaultBindingWrite::Bound)
                    .unwrap_or(DefaultBindingWrite::Empty);
                self.persist_default_binding(0, binding)?;
            }
            Ok(())
        })();
        let _ = FileExt::unlock(&lock_file);
        result
    }

    fn legacy_default_candidate(
        &self,
        requested_workspace: &TrustedWorkspaceIdentity,
    ) -> Result<Option<BrowserProfileDescriptor>, ProfileError> {
        if let Some(descriptor) = self.list_profiles(requested_workspace)?.into_iter().next() {
            return Ok(Some(descriptor));
        }
        Ok(self.list_all_profiles()?.into_iter().next())
    }

    pub(crate) fn is_global_default(&self, profile_id: &ProfileId) -> Result<bool, ProfileError> {
        let lock_file = open_profile_lock(&self.default_profile_root.join("default.lock"))?;
        lock_file
            .lock_exclusive()
            .map_err(|error| io_error("lock global browser default", error))?;
        let result = self.load_default_binding().map(|state| {
            matches!(
                state,
                DefaultBindingState::Bound { descriptor, .. }
                    if descriptor.profile_id() == profile_id
            )
        });
        let _ = FileExt::unlock(&lock_file);
        result
    }

    pub(crate) fn clear_global_default(
        &self,
        expected_profile_id: &ProfileId,
    ) -> Result<bool, ProfileError> {
        let lock_file = open_profile_lock(&self.default_profile_root.join("default.lock"))?;
        lock_file
            .lock_exclusive()
            .map_err(|error| io_error("lock global browser default", error))?;
        let result = (|| {
            match self.load_default_binding()? {
                DefaultBindingState::Bound {
                    revision,
                    descriptor,
                } if descriptor.profile_id() == expected_profile_id => {
                    self.persist_default_binding(revision, DefaultBindingWrite::Empty)?;
                    Ok(true)
                }
                // Deletion removes the descriptor directory before publishing the empty binding.
                // `load_default_binding` repairs that crash window while this lock is held, so an
                // already-empty result means the caller's previously verified default deletion
                // reached its durable terminal state.
                DefaultBindingState::Empty { .. } => Ok(true),
                _ => Ok(false),
            }
        })();
        let _ = FileExt::unlock(&lock_file);
        result
    }

    fn load_default_binding(&self) -> Result<DefaultBindingState, ProfileError> {
        let mut generations = Vec::new();
        for entry in fs::read_dir(&self.default_profile_root)
            .map_err(|error| io_error("list global browser default", error))?
        {
            let entry = entry.map_err(|error| io_error("inspect global browser default", error))?;
            let Some(name) = entry.file_name().to_str().map(ToOwned::to_owned) else {
                continue;
            };
            let Some(revision) = parse_binding_revision(&name) else {
                continue;
            };
            let file_type = entry
                .file_type()
                .map_err(|error| io_error("inspect global browser default type", error))?;
            if file_type.is_symlink() || !file_type.is_file() {
                return Err(ProfileError::UnsafePath(format!(
                    "global default generation {name} is not a regular file"
                )));
            }
            generations.push((revision, entry.path()));
        }
        generations.sort_by_key(|(revision, _)| *revision);
        let Some((revision, path)) = generations.pop() else {
            return Ok(DefaultBindingState::Uninitialized);
        };
        let bytes = read_regular_file(&path)?;
        let binding: DefaultProfileBinding = serde_json::from_slice(&bytes)
            .map_err(|error| ProfileError::CorruptMetadata(error.to_string()))?;
        if binding.schema_version != DEFAULT_BINDING_SCHEMA_VERSION || binding.revision != revision
        {
            return Err(ProfileError::CorruptMetadata(
                "global default binding identity mismatch".to_string(),
            ));
        }
        let profile_id = match (binding.profile_id, binding.pending_owner_identity) {
            (None, None) => return Ok(DefaultBindingState::Empty { revision }),
            (None, Some(_)) => {
                return Err(ProfileError::CorruptMetadata(
                    "pending global default binding has no profile id".to_string(),
                ))
            }
            (Some(profile_id), Some(owner_identity)) => {
                let owner_identity = TrustedWorkspaceIdentity::from_trusted_store(owner_identity)
                    .map_err(|_| {
                    ProfileError::CorruptMetadata(
                        "pending global default owner identity is invalid".to_string(),
                    )
                })?;
                let descriptor = self.recover_pending_default(&profile_id, &owner_identity)?;
                let committed_revision =
                    self.persist_default_binding(revision, DefaultBindingWrite::Bound(profile_id))?;
                return Ok(DefaultBindingState::Bound {
                    revision: committed_revision,
                    descriptor,
                });
            }
            (Some(profile_id), None) => profile_id,
        };
        match self.descriptor_unscoped(&profile_id) {
            Ok(descriptor) => Ok(DefaultBindingState::Bound {
                revision,
                descriptor,
            }),
            // A successful delete can crash after removing the profile but before publishing the
            // empty binding. Recover that exact committed absence without promoting an isolated
            // sibling profile.
            Err(ProfileError::ProfileNotFound(_)) => {
                let empty_revision =
                    self.persist_default_binding(revision, DefaultBindingWrite::Empty)?;
                Ok(DefaultBindingState::Empty {
                    revision: empty_revision,
                })
            }
            Err(error) => Err(error),
        }
    }

    fn persist_default_binding(
        &self,
        current_revision: u64,
        state: DefaultBindingWrite,
    ) -> Result<u64, ProfileError> {
        let revision = current_revision.checked_add(1).ok_or_else(|| {
            ProfileError::CorruptMetadata("global default revision overflow".to_string())
        })?;
        let (profile_id, pending_owner_identity) = match state {
            DefaultBindingWrite::Empty => (None, None),
            DefaultBindingWrite::PendingCreate {
                profile_id,
                owner_identity,
            } => (Some(profile_id), Some(owner_identity)),
            DefaultBindingWrite::Bound(profile_id) => (Some(profile_id), None),
        };
        let binding = DefaultProfileBinding {
            schema_version: DEFAULT_BINDING_SCHEMA_VERSION,
            revision,
            profile_id,
            pending_owner_identity,
        };
        let target = self.default_profile_root.join(binding_file_name(revision));
        if target.exists() {
            return Err(ProfileError::CorruptMetadata(format!(
                "global default revision {revision} already exists"
            )));
        }
        let mut nonce = [0_u8; 8];
        OsRng.fill_bytes(&mut nonce);
        let temporary = self.default_profile_root.join(format!(
            ".default-{revision:0width$}-{}.tmp",
            hex::encode(nonce),
            width = DEFAULT_BINDING_REVISION_WIDTH,
        ));
        let bytes = serde_json::to_vec_pretty(&binding)
            .map_err(|error| ProfileError::CorruptMetadata(error.to_string()))?;
        write_private_new_file(&temporary, &bytes)?;
        if let Err(error) = fs::rename(&temporary, &target) {
            let _ = fs::remove_file(&temporary);
            return Err(io_error("commit global browser default", error));
        }
        sync_directory(&self.default_profile_root)?;
        Ok(revision)
    }

    fn create_and_bind_default(
        &self,
        current_revision: u64,
        owner: &TrustedWorkspaceIdentity,
    ) -> Result<BrowserProfileDescriptor, ProfileError> {
        let profile_id = self.allocate_pending_default_profile_id()?;
        let pending_revision = self.persist_default_binding(
            current_revision,
            DefaultBindingWrite::PendingCreate {
                profile_id: profile_id.clone(),
                owner_identity: owner.as_str().to_string(),
            },
        )?;
        let descriptor = self.create_profile_record_with_id(&profile_id, owner)?;
        self.validate_pending_default_descriptor(&descriptor, owner)?;
        self.persist_default_binding(pending_revision, DefaultBindingWrite::Bound(profile_id))?;
        Ok(descriptor)
    }

    fn recover_pending_default(
        &self,
        profile_id: &ProfileId,
        owner: &TrustedWorkspaceIdentity,
    ) -> Result<BrowserProfileDescriptor, ProfileError> {
        let staging_dir = self.pending_default_profile_staging_dir(profile_id);
        remove_private_directory_if_present(&self.profiles_root, &staging_dir)?;
        sync_directory(&self.profiles_root)?;
        let descriptor = match self.descriptor_unscoped(profile_id) {
            Ok(descriptor) => descriptor,
            Err(ProfileError::ProfileNotFound(_)) => {
                self.create_profile_record_with_id(profile_id, owner)?
            }
            Err(error) => return Err(error),
        };
        self.validate_pending_default_descriptor(&descriptor, owner)?;
        Ok(descriptor)
    }

    fn validate_pending_default_descriptor(
        &self,
        descriptor: &BrowserProfileDescriptor,
        owner: &TrustedWorkspaceIdentity,
    ) -> Result<(), ProfileError> {
        if descriptor.workspace_identity() != owner.as_str() {
            return Err(ProfileError::CorruptMetadata(
                "pending global default owner does not match its exact profile".to_string(),
            ));
        }
        if !descriptor.cleanup_state().is_stopped() {
            return Err(ProfileError::CorruptMetadata(
                "pending global default profile is not stopped".to_string(),
            ));
        }
        Ok(())
    }

    fn allocate_pending_default_profile_id(&self) -> Result<ProfileId, ProfileError> {
        for _ in 0..16 {
            let profile_id = ProfileId::generate();
            let profile_dir = self.profile_dir(&profile_id);
            let staging_dir = self.pending_default_profile_staging_dir(&profile_id);
            let profile_absent = match fs::symlink_metadata(&profile_dir) {
                Ok(_) => false,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
                Err(error) => {
                    return Err(io_error("inspect pending global default profile id", error))
                }
            };
            let staging_absent = match fs::symlink_metadata(&staging_dir) {
                Ok(_) => false,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
                Err(error) => {
                    return Err(io_error("inspect pending global default staging id", error))
                }
            };
            if profile_absent && staging_absent {
                return Ok(profile_id);
            }
        }
        Err(ProfileError::Io(
            "failed to allocate a pending global default profile id".to_string(),
        ))
    }
}

fn binding_file_name(revision: u64) -> String {
    format!(
        "{DEFAULT_BINDING_PREFIX}{revision:0width$}{DEFAULT_BINDING_SUFFIX}",
        width = DEFAULT_BINDING_REVISION_WIDTH,
    )
}

fn parse_binding_revision(name: &str) -> Option<u64> {
    let raw = name
        .strip_prefix(DEFAULT_BINDING_PREFIX)?
        .strip_suffix(DEFAULT_BINDING_SUFFIX)?;
    if raw.len() != DEFAULT_BINDING_REVISION_WIDTH || !raw.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    raw.parse().ok()
}
