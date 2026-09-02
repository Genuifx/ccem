//! Crash-safe ownership records for embedded CEF surfaces.
//!
//! CEF runs its browser process inside the CCEM host, so the external-Chromium supervisor's
//! process-group record cannot represent this ownership domain. This store instead records the
//! exact CCEM process birth identity *before* native surface creation. Startup recovery may only
//! unlock a matching profile after that exact host identity is gone and the profile lock can be
//! acquired. Unknown records and external runtime ids always fail closed.

pub(in crate::browser::login) use super::recovery_projection::{
    EmbeddedOwnerRecoveryDisposition, EmbeddedOwnerRecoveryRecord,
};
use super::surface::validate_surface_id;
use crate::browser::login::profile::{
    BrowserProfileManager, EmbeddedProfileLaunchPendingProof, EmbeddedProfileLaunchReservation,
    EmbeddedProfileRecoveryOutcome, EmbeddedProfileReleasedProof, EmbeddedProfileRuntimeOwnedProof,
    OwnershipDomainGone, ProfileCleanupState, ProfileError, ProfileId, TrustedWorkspaceIdentity,
};
use chrono::Utc;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::fmt;
#[cfg(unix)]
use std::fs::File;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

const EMBEDDED_OWNER_SCHEMA_VERSION: u32 = 1;
const MAX_RECORD_BYTES: u64 = 64 * 1024;
const MAX_IDENTIFIER_BYTES: usize = 192;
const RECORD_PREFIX: &str = "embedded-owner-";
const RECORD_SUFFIX: &str = ".json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::browser::login) struct EmbeddedHostProcessIdentity {
    pub(in crate::browser::login) pid: u32,
    pub(in crate::browser::login) birth_token: String,
    pub(in crate::browser::login) executable: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
pub(in crate::browser::login) enum EmbeddedOwnerPhase {
    ProfileReserved,
    NativeOpenPending,
    RuntimeOwned { runtime_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::browser::login) struct EmbeddedOwnerRecord {
    schema_version: u32,
    revision: u64,
    record_id: String,
    host_instance_id: String,
    host: EmbeddedHostProcessIdentity,
    profile_id: String,
    workspace_identity: String,
    ownership_id: String,
    surface_id: String,
    phase: EmbeddedOwnerPhase,
    created_at: String,
    updated_at: String,
}

impl EmbeddedOwnerRecord {
    pub(in crate::browser::login) fn record_id(&self) -> &str {
        &self.record_id
    }

    pub(in crate::browser::login) fn surface_id(&self) -> &str {
        &self.surface_id
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::browser::login) enum EmbeddedHostObservation {
    ExactHostAlive,
    ExactHostGone,
    InspectionUnknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::browser::login) enum ProfileLockObservation {
    Available,
    Held,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::browser::login) enum EmbeddedOwnerRecoveryDecision {
    RetainLiveHost,
    RetainInspectionUnknown,
    RetainProfileLock,
    RetainUnknownOrExternalOwner,
    RecoverLaunchPending,
    RecoverRuntimeOwned,
    RemoveFinishedRecord,
}

#[derive(Debug)]
pub(in crate::browser::login) enum EmbeddedOwnerRecoveryError {
    InvalidRoot,
    InvalidRecord,
    RecordConflict,
    UnsafeRecord,
    InspectionFailed,
    Io(&'static str),
}

impl fmt::Display for EmbeddedOwnerRecoveryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRoot => formatter.write_str("Invalid embedded CEF owner record root."),
            Self::InvalidRecord => formatter.write_str("Embedded CEF owner record is invalid."),
            Self::RecordConflict => {
                formatter.write_str("Embedded CEF owner record already exists or changed.")
            }
            Self::UnsafeRecord => formatter.write_str("Embedded CEF owner record path is unsafe."),
            Self::InspectionFailed => {
                formatter.write_str("Could not inspect the exact CCEM host process identity.")
            }
            Self::Io(action) => write!(
                formatter,
                "Embedded CEF owner record I/O failed while trying to {action}."
            ),
        }
    }
}

impl std::error::Error for EmbeddedOwnerRecoveryError {}

trait EmbeddedHostInspector: Send + Sync {
    fn inspect(
        &self,
        pid: u32,
    ) -> Result<Option<EmbeddedHostProcessIdentity>, EmbeddedOwnerRecoveryError>;
}

#[derive(Debug, Default)]
struct PlatformEmbeddedHostInspector;

impl EmbeddedHostInspector for PlatformEmbeddedHostInspector {
    fn inspect(
        &self,
        pid: u32,
    ) -> Result<Option<EmbeddedHostProcessIdentity>, EmbeddedOwnerRecoveryError> {
        inspect_process_platform(pid)
    }
}

/// One app-instance store. Keep a single instance for the process lifetime so every record carries
/// the same logical host instance id in addition to PID birth identity.
#[derive(Debug, Clone)]
pub(in crate::browser::login) struct EmbeddedOwnerRecordStore {
    root: PathBuf,
    host_instance_id: String,
    current_host: EmbeddedHostProcessIdentity,
}

impl EmbeddedOwnerRecordStore {
    pub(in crate::browser::login) fn production(
        root: PathBuf,
    ) -> Result<Self, EmbeddedOwnerRecoveryError> {
        let inspector = PlatformEmbeddedHostInspector;
        let current_host = inspector
            .inspect(std::process::id())?
            .ok_or(EmbeddedOwnerRecoveryError::InspectionFailed)?;
        Self::from_identity(root, random_id("cef-host"), current_host)
    }

    fn from_identity(
        root: PathBuf,
        host_instance_id: String,
        current_host: EmbeddedHostProcessIdentity,
    ) -> Result<Self, EmbeddedOwnerRecoveryError> {
        if root.as_os_str().is_empty() || !root.is_absolute() {
            return Err(EmbeddedOwnerRecoveryError::InvalidRoot);
        }
        validate_opaque_id(&host_instance_id, "cef-host-")?;
        validate_host_identity(&current_host)?;
        ensure_private_directory(&root)?;
        Ok(Self {
            root,
            host_instance_id,
            current_host,
        })
    }

    #[cfg(test)]
    pub(in crate::browser::login) fn for_test(
        root: PathBuf,
        host_instance_id: String,
        current_host: EmbeddedHostProcessIdentity,
    ) -> Result<Self, EmbeddedOwnerRecoveryError> {
        Self::from_identity(root, host_instance_id, current_host)
    }

    /// Persist the recovery intent while the profile is exclusively reserved but still Stopped.
    /// This must complete before LaunchPending is committed.
    pub(in crate::browser::login) fn begin_profile_reservation(
        &self,
        reservation: &EmbeddedProfileLaunchReservation,
        surface_id: &str,
    ) -> Result<EmbeddedOwnerRecordHandle, EmbeddedOwnerRecoveryError> {
        validate_surface_id(surface_id).map_err(|_| EmbeddedOwnerRecoveryError::InvalidRecord)?;
        if !surface_id.starts_with("login-") {
            return Err(EmbeddedOwnerRecoveryError::InvalidRecord);
        }
        let now = Utc::now().to_rfc3339();
        let record = EmbeddedOwnerRecord {
            schema_version: EMBEDDED_OWNER_SCHEMA_VERSION,
            revision: 1,
            record_id: random_id(RECORD_PREFIX.trim_end_matches('-')),
            host_instance_id: self.host_instance_id.clone(),
            host: self.current_host.clone(),
            profile_id: reservation.descriptor().profile_id().as_str().to_string(),
            workspace_identity: reservation.descriptor().workspace_identity().to_string(),
            ownership_id: reservation.ownership_id().to_string(),
            surface_id: surface_id.to_string(),
            phase: EmbeddedOwnerPhase::ProfileReserved,
            created_at: now.clone(),
            updated_at: now,
        };
        validate_record(&record)?;
        self.write_new(&record)?;
        Ok(EmbeddedOwnerRecordHandle {
            store: self.clone(),
            record,
            profile_released: false,
        })
    }

    pub(in crate::browser::login) fn reap_stale(
        &self,
        profiles: &BrowserProfileManager,
    ) -> Result<Vec<EmbeddedOwnerRecoveryRecord>, EmbeddedOwnerRecoveryError> {
        self.reap_stale_with(profiles, &PlatformEmbeddedHostInspector)
    }

    fn reap_stale_with(
        &self,
        profiles: &BrowserProfileManager,
        inspector: &dyn EmbeddedHostInspector,
    ) -> Result<Vec<EmbeddedOwnerRecoveryRecord>, EmbeddedOwnerRecoveryError> {
        let mut outcomes = Vec::new();
        for record in self.list()? {
            let host = match inspector.inspect(record.host.pid) {
                Ok(Some(identity)) if identity == record.host => {
                    EmbeddedHostObservation::ExactHostAlive
                }
                Ok(None | Some(_)) => EmbeddedHostObservation::ExactHostGone,
                Err(_) => EmbeddedHostObservation::InspectionUnknown,
            };

            let profile_id = match ProfileId::parse(&record.profile_id) {
                Ok(profile_id) => profile_id,
                Err(_) => {
                    outcomes.push(outcome(
                        &record,
                        EmbeddedOwnerRecoveryDisposition::RetainedProfileUnavailable,
                    ));
                    continue;
                }
            };
            let workspace = match TrustedWorkspaceIdentity::from_trusted_store(
                record.workspace_identity.clone(),
            ) {
                Ok(workspace) => workspace,
                Err(_) => {
                    outcomes.push(outcome(
                        &record,
                        EmbeddedOwnerRecoveryDisposition::RetainedProfileUnavailable,
                    ));
                    continue;
                }
            };
            let descriptor = match profiles.descriptor(&profile_id, &workspace) {
                Ok(descriptor) => descriptor,
                Err(_) => {
                    outcomes.push(outcome(
                        &record,
                        EmbeddedOwnerRecoveryDisposition::RetainedProfileUnavailable,
                    ));
                    continue;
                }
            };
            let decision = classify_recovery(
                &record,
                host,
                ProfileLockObservation::Available,
                descriptor.cleanup_state(),
            );
            let disposition = match decision {
                EmbeddedOwnerRecoveryDecision::RetainLiveHost => {
                    EmbeddedOwnerRecoveryDisposition::RetainedLiveHost
                }
                EmbeddedOwnerRecoveryDecision::RetainInspectionUnknown => {
                    EmbeddedOwnerRecoveryDisposition::RetainedInspectionUnknown
                }
                EmbeddedOwnerRecoveryDecision::RetainProfileLock => {
                    EmbeddedOwnerRecoveryDisposition::RetainedProfileLock
                }
                EmbeddedOwnerRecoveryDecision::RetainUnknownOrExternalOwner => {
                    EmbeddedOwnerRecoveryDisposition::RetainedUnknownOrExternalOwner
                }
                recover @ (EmbeddedOwnerRecoveryDecision::RecoverLaunchPending
                | EmbeddedOwnerRecoveryDecision::RecoverRuntimeOwned
                | EmbeddedOwnerRecoveryDecision::RemoveFinishedRecord) => {
                    let proof =
                        OwnershipDomainGone::from_dead_cef_host(record.ownership_id.clone())
                            .map_err(|_| EmbeddedOwnerRecoveryError::InvalidRecord)?;
                    match profiles.recover_embedded_after_host_gone(&profile_id, &workspace, proof)
                    {
                        Ok(EmbeddedProfileRecoveryOutcome::Recovered)
                        | Ok(EmbeddedProfileRecoveryOutcome::AlreadyStopped) => {
                            self.remove(&record.record_id)?;
                            match recover {
                                EmbeddedOwnerRecoveryDecision::RecoverLaunchPending => {
                                    EmbeddedOwnerRecoveryDisposition::RecoveredLaunchPending
                                }
                                EmbeddedOwnerRecoveryDecision::RecoverRuntimeOwned => {
                                    EmbeddedOwnerRecoveryDisposition::RecoveredRuntimeOwned
                                }
                                EmbeddedOwnerRecoveryDecision::RemoveFinishedRecord => {
                                    EmbeddedOwnerRecoveryDisposition::RemovedFinishedRecord
                                }
                                _ => unreachable!(),
                            }
                        }
                        Err(ProfileError::ProfileInUse) => {
                            EmbeddedOwnerRecoveryDisposition::RetainedProfileLock
                        }
                        Err(ProfileError::OwnershipMismatch | ProfileError::ProfileNotStopped) => {
                            EmbeddedOwnerRecoveryDisposition::RetainedUnknownOrExternalOwner
                        }
                        Err(_) => EmbeddedOwnerRecoveryDisposition::RetainedProfileUnavailable,
                    }
                }
            };
            outcomes.push(outcome(&record, disposition));
        }
        Ok(outcomes)
    }

    fn write_new(&self, record: &EmbeddedOwnerRecord) -> Result<(), EmbeddedOwnerRecoveryError> {
        ensure_private_directory(&self.root)?;
        validate_record(record)?;
        let target = self.path_for(&record.record_id)?;
        if target.exists() {
            return Err(EmbeddedOwnerRecoveryError::RecordConflict);
        }
        self.write_atomic(&target, record, false)
    }

    fn update(&self, record: &EmbeddedOwnerRecord) -> Result<(), EmbeddedOwnerRecoveryError> {
        ensure_private_directory(&self.root)?;
        validate_record(record)?;
        let current = self
            .load(&record.record_id)?
            .ok_or(EmbeddedOwnerRecoveryError::RecordConflict)?;
        if record.revision != current.revision.saturating_add(1)
            || record.created_at != current.created_at
            || record.host_instance_id != current.host_instance_id
            || record.host != current.host
            || record.profile_id != current.profile_id
            || record.workspace_identity != current.workspace_identity
            || record.ownership_id != current.ownership_id
            || record.surface_id != current.surface_id
        {
            return Err(EmbeddedOwnerRecoveryError::RecordConflict);
        }
        self.write_atomic(&self.path_for(&record.record_id)?, record, true)
    }

    fn load(
        &self,
        record_id: &str,
    ) -> Result<Option<EmbeddedOwnerRecord>, EmbeddedOwnerRecoveryError> {
        ensure_private_directory(&self.root)?;
        let path = self.path_for(record_id)?;
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(EmbeddedOwnerRecoveryError::Io("inspect owner record")),
        };
        if !metadata.file_type().is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() > MAX_RECORD_BYTES
        {
            return Err(EmbeddedOwnerRecoveryError::UnsafeRecord);
        }
        let bytes =
            fs::read(path).map_err(|_| EmbeddedOwnerRecoveryError::Io("read owner record"))?;
        let record: EmbeddedOwnerRecord = serde_json::from_slice(&bytes)
            .map_err(|_| EmbeddedOwnerRecoveryError::InvalidRecord)?;
        validate_record(&record)?;
        if record.record_id != record_id {
            return Err(EmbeddedOwnerRecoveryError::InvalidRecord);
        }
        Ok(Some(record))
    }

    fn list(&self) -> Result<Vec<EmbeddedOwnerRecord>, EmbeddedOwnerRecoveryError> {
        ensure_private_directory(&self.root)?;
        let mut entries = fs::read_dir(&self.root)
            .map_err(|_| EmbeddedOwnerRecoveryError::Io("list owner records"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| EmbeddedOwnerRecoveryError::Io("list owner records"))?;
        entries.sort_by_key(|entry| entry.file_name());
        let mut records = Vec::new();
        for entry in entries {
            let Some(name) = entry.file_name().to_str().map(ToOwned::to_owned) else {
                continue;
            };
            let Some(record_id) = name.strip_suffix(RECORD_SUFFIX) else {
                continue;
            };
            if !record_id.starts_with(RECORD_PREFIX) {
                continue;
            }
            match self.load(record_id) {
                Ok(Some(record)) => records.push(record),
                Ok(None) => {}
                Err(_) => {
                    // `load` also revalidates the shared root. Preserve that root-level boundary
                    // even though failures attributable to this individual entry are isolated.
                    ensure_private_directory(&self.root)?;
                    // Once the root itself is known safe and enumerable, one corrupt, untrusted,
                    // or unreadable crash record must not make every browser profile
                    // unavailable. Leave it untouched for diagnosis and recover valid peers.
                }
            }
        }
        Ok(records)
    }

    fn remove(&self, record_id: &str) -> Result<(), EmbeddedOwnerRecoveryError> {
        ensure_private_directory(&self.root)?;
        let path = self.path_for(record_id)?;
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err(EmbeddedOwnerRecoveryError::Io("inspect owner record")),
        };
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err(EmbeddedOwnerRecoveryError::UnsafeRecord);
        }
        fs::remove_file(path).map_err(|_| EmbeddedOwnerRecoveryError::Io("remove owner record"))?;
        sync_directory(&self.root)
    }

    fn path_for(&self, record_id: &str) -> Result<PathBuf, EmbeddedOwnerRecoveryError> {
        validate_opaque_id(record_id, RECORD_PREFIX)?;
        Ok(self.root.join(format!("{record_id}{RECORD_SUFFIX}")))
    }

    fn write_atomic(
        &self,
        target: &Path,
        record: &EmbeddedOwnerRecord,
        replace: bool,
    ) -> Result<(), EmbeddedOwnerRecoveryError> {
        let bytes = serde_json::to_vec_pretty(record)
            .map_err(|_| EmbeddedOwnerRecoveryError::InvalidRecord)?;
        if bytes.len() as u64 > MAX_RECORD_BYTES {
            return Err(EmbeddedOwnerRecoveryError::InvalidRecord);
        }
        reject_symlink_if_present(target)?;
        let temporary = self.root.join(format!(
            ".embedded-owner.{}.{}.tmp",
            std::process::id(),
            random_hex()
        ));
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        let result = (|| {
            let mut file = options
                .open(&temporary)
                .map_err(|_| EmbeddedOwnerRecoveryError::Io("create owner record"))?;
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|_| EmbeddedOwnerRecoveryError::Io("persist owner record"))?;
            drop(file);
            atomic_publish(&temporary, target, replace)?;
            set_private_file_permissions(target)?;
            sync_directory(&self.root)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

/// Owned handle whose clean completion is intentionally explicit. Dropping it retains the record
/// so a controller crash cannot erase the only evidence needed to recover the profile.
pub(in crate::browser::login) struct EmbeddedOwnerRecordHandle {
    store: EmbeddedOwnerRecordStore,
    record: EmbeddedOwnerRecord,
    profile_released: bool,
}

impl EmbeddedOwnerRecordHandle {
    /// Advance the durable intent after the same ownership id was committed as LaunchPending.
    /// Native CEF creation is forbidden until this update succeeds.
    pub(in crate::browser::login) fn mark_launch_pending(
        &mut self,
        proof: &EmbeddedProfileLaunchPendingProof,
    ) -> Result<(), EmbeddedOwnerRecoveryError> {
        if !matches!(self.record.phase, EmbeddedOwnerPhase::ProfileReserved)
            || proof.profile_id().as_str() != self.record.profile_id
            || proof.workspace_identity() != self.record.workspace_identity
            || proof.ownership_id() != self.record.ownership_id
        {
            return Err(EmbeddedOwnerRecoveryError::InvalidRecord);
        }
        let mut next = self.record.clone();
        next.revision = next.revision.saturating_add(1);
        next.phase = EmbeddedOwnerPhase::NativeOpenPending;
        next.updated_at = Utc::now().to_rfc3339();
        self.store.update(&next)?;
        self.record = next;
        Ok(())
    }

    /// Call only after the profile has durably transitioned to RuntimeOwned. If this update is
    /// interrupted, startup accepts a matching RuntimeOwned profile with the still-pending record,
    /// which closes that exact crash window without accepting an external runtime id.
    pub(in crate::browser::login) fn mark_runtime_owned(
        &mut self,
        proof: &EmbeddedProfileRuntimeOwnedProof,
    ) -> Result<(), EmbeddedOwnerRecoveryError> {
        if !matches!(self.record.phase, EmbeddedOwnerPhase::NativeOpenPending)
            || proof.profile_id().as_str() != self.record.profile_id
            || proof.workspace_identity() != self.record.workspace_identity
            || proof.ownership_id() != self.record.ownership_id
            || proof.runtime_id() != self.record.surface_id
        {
            return Err(EmbeddedOwnerRecoveryError::InvalidRecord);
        }
        validate_identifier_value(proof.runtime_id())?;
        let mut next = self.record.clone();
        next.revision = next.revision.saturating_add(1);
        next.phase = EmbeddedOwnerPhase::RuntimeOwned {
            runtime_id: proof.runtime_id().to_string(),
        };
        next.updated_at = Utc::now().to_rfc3339();
        self.store.update(&next)?;
        self.record = next;
        Ok(())
    }

    /// Delete only after OnBeforeClose was observed and the profile state was persisted Stopped
    /// with its file lock released.
    pub(in crate::browser::login) fn finish_after_profile_release(
        &mut self,
        proof: EmbeddedProfileReleasedProof,
    ) -> Result<(), EmbeddedOwnerRecoveryError> {
        if proof.profile_id().as_str() != self.record.profile_id
            || proof.workspace_identity() != self.record.workspace_identity
            || proof.ownership_id() != self.record.ownership_id
        {
            return Err(EmbeddedOwnerRecoveryError::InvalidRecord);
        }
        self.profile_released = true;
        self.retry_finish_after_profile_release()
    }

    /// Retry a metadata deletion that failed after the profile was already safely released.
    pub(in crate::browser::login) fn retry_finish_after_profile_release(
        &self,
    ) -> Result<(), EmbeddedOwnerRecoveryError> {
        if !self.profile_released {
            return Err(EmbeddedOwnerRecoveryError::InvalidRecord);
        }
        self.store.remove(&self.record.record_id)
    }

    pub(in crate::browser::login) fn record_id(&self) -> &str {
        self.record.record_id()
    }
}

pub(in crate::browser::login) fn classify_recovery(
    record: &EmbeddedOwnerRecord,
    host: EmbeddedHostObservation,
    profile_lock: ProfileLockObservation,
    cleanup_state: &ProfileCleanupState,
) -> EmbeddedOwnerRecoveryDecision {
    match host {
        EmbeddedHostObservation::ExactHostAlive => {
            return EmbeddedOwnerRecoveryDecision::RetainLiveHost
        }
        EmbeddedHostObservation::InspectionUnknown => {
            return EmbeddedOwnerRecoveryDecision::RetainInspectionUnknown
        }
        EmbeddedHostObservation::ExactHostGone => {}
    }
    match profile_lock {
        ProfileLockObservation::Held | ProfileLockObservation::Unknown => {
            return EmbeddedOwnerRecoveryDecision::RetainProfileLock
        }
        ProfileLockObservation::Available => {}
    }
    match cleanup_state {
        ProfileCleanupState::Stopped => EmbeddedOwnerRecoveryDecision::RemoveFinishedRecord,
        ProfileCleanupState::LaunchPending { ownership_id, .. }
            if ownership_id == &record.ownership_id
                && matches!(
                    record.phase,
                    EmbeddedOwnerPhase::ProfileReserved | EmbeddedOwnerPhase::NativeOpenPending
                ) =>
        {
            EmbeddedOwnerRecoveryDecision::RecoverLaunchPending
        }
        ProfileCleanupState::RuntimeOwned {
            ownership_id,
            runtime_id,
            ..
        } if ownership_id == &record.ownership_id && runtime_id == &record.surface_id => {
            // Both record phases are accepted. RuntimeOwned + NativeOpenPending is the deliberate
            // crash window after the profile transition and before the record phase update.
            EmbeddedOwnerRecoveryDecision::RecoverRuntimeOwned
        }
        ProfileCleanupState::LaunchPending { .. }
        | ProfileCleanupState::RuntimeOwned { .. }
        | ProfileCleanupState::Resetting { .. }
        | ProfileCleanupState::Deleting { .. } => {
            EmbeddedOwnerRecoveryDecision::RetainUnknownOrExternalOwner
        }
    }
}

fn outcome(
    record: &EmbeddedOwnerRecord,
    disposition: EmbeddedOwnerRecoveryDisposition,
) -> EmbeddedOwnerRecoveryRecord {
    EmbeddedOwnerRecoveryRecord {
        record_id: record.record_id.clone(),
        surface_id: record.surface_id.clone(),
        profile_id: record.profile_id.clone(),
        workspace_identity: record.workspace_identity.clone(),
        disposition,
    }
}

fn validate_record(record: &EmbeddedOwnerRecord) -> Result<(), EmbeddedOwnerRecoveryError> {
    if record.schema_version != EMBEDDED_OWNER_SCHEMA_VERSION
        || record.revision == 0
        || chrono::DateTime::parse_from_rfc3339(&record.created_at).is_err()
        || chrono::DateTime::parse_from_rfc3339(&record.updated_at).is_err()
    {
        return Err(EmbeddedOwnerRecoveryError::InvalidRecord);
    }
    validate_opaque_id(&record.record_id, RECORD_PREFIX)?;
    validate_opaque_id(&record.host_instance_id, "cef-host-")?;
    validate_host_identity(&record.host)?;
    ProfileId::parse(&record.profile_id).map_err(|_| EmbeddedOwnerRecoveryError::InvalidRecord)?;
    TrustedWorkspaceIdentity::from_trusted_store(record.workspace_identity.clone())
        .map_err(|_| EmbeddedOwnerRecoveryError::InvalidRecord)?;
    validate_opaque_id(&record.ownership_id, "ownership-")?;
    validate_surface_id(&record.surface_id)
        .map_err(|_| EmbeddedOwnerRecoveryError::InvalidRecord)?;
    if !record.surface_id.starts_with("login-") {
        return Err(EmbeddedOwnerRecoveryError::InvalidRecord);
    }
    match &record.phase {
        EmbeddedOwnerPhase::ProfileReserved if record.revision == 1 => {}
        EmbeddedOwnerPhase::NativeOpenPending if record.revision == 2 => {}
        EmbeddedOwnerPhase::RuntimeOwned { runtime_id }
            if record.revision == 3 && runtime_id == &record.surface_id =>
        {
            validate_identifier_value(runtime_id)?;
        }
        _ => return Err(EmbeddedOwnerRecoveryError::InvalidRecord),
    }
    Ok(())
}

fn validate_host_identity(
    identity: &EmbeddedHostProcessIdentity,
) -> Result<(), EmbeddedOwnerRecoveryError> {
    if identity.pid == 0 || !identity.executable.is_absolute() {
        return Err(EmbeddedOwnerRecoveryError::InvalidRecord);
    }
    validate_identifier_value(&identity.birth_token)
}

fn validate_opaque_id(value: &str, prefix: &str) -> Result<(), EmbeddedOwnerRecoveryError> {
    let Some(suffix) = value.strip_prefix(prefix) else {
        return Err(EmbeddedOwnerRecoveryError::InvalidRecord);
    };
    if suffix.len() != 32 || !suffix.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(EmbeddedOwnerRecoveryError::InvalidRecord);
    }
    Ok(())
}

fn validate_identifier_value(value: &str) -> Result<(), EmbeddedOwnerRecoveryError> {
    if value.is_empty()
        || value.len() > MAX_IDENTIFIER_BYTES
        || value.contains('/')
        || value.contains('\\')
        || value.chars().any(char::is_control)
    {
        return Err(EmbeddedOwnerRecoveryError::InvalidRecord);
    }
    Ok(())
}

fn random_id(prefix: &str) -> String {
    format!("{prefix}-{}", random_hex())
}

fn random_hex() -> String {
    let mut bytes = [0_u8; 16];
    OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn ensure_private_directory(path: &Path) -> Result<(), EmbeddedOwnerRecoveryError> {
    reject_symlink_if_present(path)?;
    fs::create_dir_all(path)
        .map_err(|_| EmbeddedOwnerRecoveryError::Io("create owner record root"))?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| EmbeddedOwnerRecoveryError::Io("inspect owner record root"))?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err(EmbeddedOwnerRecoveryError::InvalidRoot);
    }
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|_| EmbeddedOwnerRecoveryError::Io("protect owner record root"))?;
    Ok(())
}

fn reject_symlink_if_present(path: &Path) -> Result<(), EmbeddedOwnerRecoveryError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(EmbeddedOwnerRecoveryError::UnsafeRecord)
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(EmbeddedOwnerRecoveryError::Io("inspect owner record path")),
    }
}

#[cfg(unix)]
fn atomic_publish(
    source: &Path,
    target: &Path,
    replace: bool,
) -> Result<(), EmbeddedOwnerRecoveryError> {
    if !replace {
        fs::hard_link(source, target).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                EmbeddedOwnerRecoveryError::RecordConflict
            } else {
                EmbeddedOwnerRecoveryError::Io("publish owner record")
            }
        })?;
        fs::remove_file(source)
            .map_err(|_| EmbeddedOwnerRecoveryError::Io("finish owner record publish"))?;
        return Ok(());
    }
    fs::rename(source, target).map_err(|_| EmbeddedOwnerRecoveryError::Io("publish owner record"))
}

#[cfg(windows)]
fn atomic_publish(
    source: &Path,
    target: &Path,
    replace: bool,
) -> Result<(), EmbeddedOwnerRecoveryError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS};
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let flags = MOVEFILE_WRITE_THROUGH
        | if replace {
            MOVEFILE_REPLACE_EXISTING
        } else {
            0
        };
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), flags) } == 0 {
        let error = unsafe { GetLastError() };
        if !replace && matches!(error, ERROR_ALREADY_EXISTS | ERROR_FILE_EXISTS) {
            return Err(EmbeddedOwnerRecoveryError::RecordConflict);
        }
        return Err(EmbeddedOwnerRecoveryError::Io("publish owner record"));
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn atomic_publish(
    source: &Path,
    target: &Path,
    replace: bool,
) -> Result<(), EmbeddedOwnerRecoveryError> {
    if !replace && target.exists() {
        return Err(EmbeddedOwnerRecoveryError::RecordConflict);
    }
    fs::rename(source, target).map_err(|_| EmbeddedOwnerRecoveryError::Io("publish owner record"))
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) -> Result<(), EmbeddedOwnerRecoveryError> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|_| EmbeddedOwnerRecoveryError::Io("protect owner record"))
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) -> Result<(), EmbeddedOwnerRecoveryError> {
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), EmbeddedOwnerRecoveryError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| EmbeddedOwnerRecoveryError::Io("sync owner record root"))
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), EmbeddedOwnerRecoveryError> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn inspect_process_platform(
    pid: u32,
) -> Result<Option<EmbeddedHostProcessIdentity>, EmbeddedOwnerRecoveryError> {
    use std::mem::{size_of, zeroed};
    use std::os::unix::ffi::OsStringExt;

    if pid == 0 || pid > i32::MAX as u32 {
        return Err(EmbeddedOwnerRecoveryError::InspectionFailed);
    }
    let mut info: libc::proc_bsdinfo = unsafe { zeroed() };
    let read = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size_of::<libc::proc_bsdinfo>() as i32,
        )
    };
    if read != size_of::<libc::proc_bsdinfo>() as i32 {
        return if process_absent(pid) {
            Ok(None)
        } else {
            Err(EmbeddedOwnerRecoveryError::InspectionFailed)
        };
    }
    let mut path = vec![0_u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let path_length =
        unsafe { libc::proc_pidpath(pid as i32, path.as_mut_ptr().cast(), path.len() as u32) };
    if path_length <= 0 {
        return if process_absent(pid) {
            Ok(None)
        } else {
            Err(EmbeddedOwnerRecoveryError::InspectionFailed)
        };
    }
    path.truncate(path_length as usize);
    let executable = PathBuf::from(std::ffi::OsString::from_vec(path))
        .canonicalize()
        .map_err(|_| EmbeddedOwnerRecoveryError::InspectionFailed)?;
    Ok(Some(EmbeddedHostProcessIdentity {
        pid,
        birth_token: format!("mac:{}:{}", info.pbi_start_tvsec, info.pbi_start_tvusec),
        executable,
    }))
}

#[cfg(windows)]
fn inspect_process_platform(
    pid: u32,
) -> Result<Option<EmbeddedHostProcessIdentity>, EmbeddedOwnerRecoveryError> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, FILETIME, STILL_ACTIVE},
        System::Threading::{
            GetExitCodeProcess, GetProcessTimes, OpenProcess, QueryFullProcessImageNameW,
            PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        },
    };

    if pid == 0 {
        return Err(EmbeddedOwnerRecoveryError::InspectionFailed);
    }
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return if unsafe { GetLastError() } == ERROR_INVALID_PARAMETER {
            Ok(None)
        } else {
            Err(EmbeddedOwnerRecoveryError::InspectionFailed)
        };
    }

    let inspect = || {
        let mut exit_code = 0_u32;
        if unsafe { GetExitCodeProcess(process, &mut exit_code) } == 0 {
            return Err(EmbeddedOwnerRecoveryError::InspectionFailed);
        }
        if exit_code != STILL_ACTIVE as u32 {
            return Ok(None);
        }

        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        if unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) }
            == 0
        {
            return Err(EmbeddedOwnerRecoveryError::InspectionFailed);
        }

        let mut path = vec![0_u16; 32_768];
        let mut path_length = path.len() as u32;
        if unsafe {
            QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_WIN32,
                path.as_mut_ptr(),
                &mut path_length,
            )
        } == 0
            || path_length == 0
        {
            return Err(EmbeddedOwnerRecoveryError::InspectionFailed);
        }
        path.truncate(path_length as usize);
        let executable = PathBuf::from(
            String::from_utf16(&path).map_err(|_| EmbeddedOwnerRecoveryError::InspectionFailed)?,
        )
        .canonicalize()
        .map_err(|_| EmbeddedOwnerRecoveryError::InspectionFailed)?;
        Ok(Some(EmbeddedHostProcessIdentity {
            pid,
            birth_token: format!(
                "win:{:08x}{:08x}",
                creation.dwHighDateTime, creation.dwLowDateTime
            ),
            executable,
        }))
    };
    let result = inspect();
    unsafe {
        CloseHandle(process);
    }
    result
}

#[cfg(not(any(target_os = "macos", windows)))]
fn inspect_process_platform(
    _pid: u32,
) -> Result<Option<EmbeddedHostProcessIdentity>, EmbeddedOwnerRecoveryError> {
    Err(EmbeddedOwnerRecoveryError::InspectionFailed)
}

#[cfg(unix)]
fn process_absent(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

#[cfg(test)]
#[path = "recovery_tests.rs"]
mod tests;
