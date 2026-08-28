use super::storage::{read_regular_file, write_private_new_file};
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
    /// The first resolution migrates the earliest surviving legacy profile into the binding. A
    /// cleared binding deliberately does not promote an explicitly isolated profile; the next
    /// default open creates a fresh profile instead.
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
                        self.persist_default_binding(0, Some(descriptor.profile_id().clone()))?;
                        return Ok(Some(descriptor));
                    }
                    if !create_if_empty {
                        return Ok(None);
                    }
                    let descriptor = self.create_profile_record(owner_for_new_profile)?;
                    self.persist_default_binding(0, Some(descriptor.profile_id().clone()))?;
                    Ok(Some(descriptor))
                }
                DefaultBindingState::Empty { revision } => {
                    if !create_if_empty {
                        return Ok(None);
                    }
                    let descriptor = self.create_profile_record(owner_for_new_profile)?;
                    self.persist_default_binding(revision, Some(descriptor.profile_id().clone()))?;
                    Ok(Some(descriptor))
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
                self.persist_default_binding(0, profile_id)?;
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
                    self.persist_default_binding(revision, None)?;
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
        let Some(profile_id) = binding.profile_id else {
            return Ok(DefaultBindingState::Empty { revision });
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
                self.persist_default_binding(revision, None)?;
                Ok(DefaultBindingState::Empty {
                    revision: revision + 1,
                })
            }
            Err(error) => Err(error),
        }
    }

    fn persist_default_binding(
        &self,
        current_revision: u64,
        profile_id: Option<ProfileId>,
    ) -> Result<(), ProfileError> {
        let revision = current_revision.checked_add(1).ok_or_else(|| {
            ProfileError::CorruptMetadata("global default revision overflow".to_string())
        })?;
        let binding = DefaultProfileBinding {
            schema_version: DEFAULT_BINDING_SCHEMA_VERSION,
            revision,
            profile_id,
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
        // Reuse the profile generation helper's directory fsync by committing an inert metadata
        // generation is not appropriate here; sync the dedicated binding directory directly.
        std::fs::File::open(&self.default_profile_root)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| io_error("sync global browser default", error))
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
