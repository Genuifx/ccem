use super::activation::{
    repairable_activation_state_error, ActivatedRuntimePointer, ActivationFault, ActivationStore,
    VerifiedRuntimeReceipt,
};
use super::download::{
    download_archive_blocking_with_reporter, DownloadControl, DownloadErrorCode,
    DownloadProgressReporter, DownloadSpec,
};
use super::extract::{extract_runtime_archive, ExtractionErrorCode};
use super::identity::{verify_runtime_identity, IdentityErrorCode, VerifiedRuntimeIdentity};
use super::maintenance::{
    RuntimeDeleteOutcome, RuntimeDiskUsage, RuntimeMaintenanceError, RuntimeMaintenanceStore,
};
use super::manifest::{
    ManifestEnvironment, ManifestErrorCode, ManifestTrustStore, RuntimeArchitecture,
    RuntimePlatform, VerifiedRuntimeManifest,
};
use super::paths::{write_private_atomic, RuntimePathError, RuntimePaths};
use super::smoke::InstallationSmokeEvidence;
use super::state::{
    RuntimeCandidateSummary, RuntimeErrorCode, RuntimePhase, RuntimeVersionSummary,
};
use chrono::Utc;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

const RUNTIME_PROTOCOL_VERSION: u32 = 1;
const SIGNING_KEY_ID: &str = "ccem-browser-runtime-2026-01";
const SEQUENCE_WATERMARK_SCHEMA_VERSION: u32 = 1;
const MAX_WATERMARK_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Copy)]
pub(crate) struct EmbeddedRuntimeManifest {
    pub(crate) manifest_bytes: &'static [u8],
    pub(crate) signature: &'static str,
    pub(crate) public_key: &'static str,
    pub(crate) signing_key_id: &'static str,
}

pub(crate) fn current_embedded_manifest() -> Option<EmbeddedRuntimeManifest> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return Some(EmbeddedRuntimeManifest {
            manifest_bytes: include_bytes!("../../../runtime-manifests/macos-aarch64.json"),
            signature: include_str!("../../../runtime-manifests/macos-aarch64.json.sig"),
            public_key: include_str!("../../../runtime-manifests/public-key.pub"),
            signing_key_id: SIGNING_KEY_ID,
        });
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return Some(EmbeddedRuntimeManifest {
            manifest_bytes: include_bytes!("../../../runtime-manifests/macos-x86_64.json"),
            signature: include_str!("../../../runtime-manifests/macos-x86_64.json.sig"),
            public_key: include_str!("../../../runtime-manifests/public-key.pub"),
            signing_key_id: SIGNING_KEY_ID,
        });
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return Some(EmbeddedRuntimeManifest {
            manifest_bytes: include_bytes!("../../../runtime-manifests/windows-x86_64.json"),
            signature: include_str!("../../../runtime-manifests/windows-x86_64.json.sig"),
            public_key: include_str!("../../../runtime-manifests/public-key.pub"),
            signing_key_id: SIGNING_KEY_ID,
        });
    }
    #[allow(unreachable_code)]
    None
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RuntimePreparationFailure {
    pub(crate) code: RuntimeErrorCode,
    pub(crate) retryable: bool,
}

impl RuntimePreparationFailure {
    fn new(code: RuntimeErrorCode, retryable: bool) -> Self {
        Self { code, retryable }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RuntimePreparationStop {
    Paused,
    Failed(RuntimePreparationFailure),
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct RuntimePreparationOutcome {
    pub(crate) active: RuntimeVersionSummary,
    pub(crate) activated: bool,
    pub(crate) smoke: Option<InstallationSmokeEvidence>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ActivePreparationState {
    pointer: Option<ActivatedRuntimePointer>,
    repair_corrupt_activation: bool,
}

pub(crate) trait RuntimePreparationObserver: Send + Sync {
    fn candidate_verified(&self, candidate: RuntimeCandidateSummary);
    fn phase_changed(&self, phase: RuntimePhase);
    fn download_progress(&self, completed_bytes: u64, total_bytes: u64);
}

pub(crate) trait InstallationSmokeRunner: Send + Sync {
    fn run(
        &self,
        manifest: &VerifiedRuntimeManifest,
        identity: &VerifiedRuntimeIdentity,
        candidate_root: &Path,
    ) -> Result<InstallationSmokeEvidence, RuntimePreparationFailure>;
}

#[derive(Clone)]
pub(crate) struct ProductionRuntimeInstaller {
    paths: RuntimePaths,
    activation: ActivationStore,
    smoke_runner: Arc<dyn InstallationSmokeRunner>,
}

impl ProductionRuntimeInstaller {
    pub(crate) fn new(paths: RuntimePaths, smoke_runner: Arc<dyn InstallationSmokeRunner>) -> Self {
        Self {
            activation: ActivationStore::new(paths.clone()),
            paths,
            smoke_runner,
        }
    }

    pub(crate) fn recover_active(
        &self,
    ) -> Result<Option<RuntimeVersionSummary>, RuntimePreparationFailure> {
        self.paths.prepare_private().map_err(map_path_error)?;
        self.activation
            .load_pointer()
            .map(|pointer| pointer.map(|value| value.active.summary()))
            .map_err(|_| RuntimePreparationFailure::new(RuntimeErrorCode::StateCorrupt, false))
    }

    pub(crate) fn disk_usage(&self) -> Result<RuntimeDiskUsage, RuntimeMaintenanceError> {
        RuntimeMaintenanceStore::new(self.paths.clone()).disk_usage()
    }

    pub(crate) fn delete_runtime(&self) -> Result<RuntimeDeleteOutcome, RuntimeMaintenanceError> {
        RuntimeMaintenanceStore::new(self.paths.clone()).delete_runtime()
    }

    /// Blocking production pipeline. The caller must run this on a dedicated worker thread.
    pub(crate) fn prepare(
        &self,
        control: &DownloadControl,
        observer: &dyn RuntimePreparationObserver,
        force_reinstall: bool,
    ) -> Result<RuntimePreparationOutcome, RuntimePreparationStop> {
        self.paths
            .prepare_private()
            .map_err(|error| RuntimePreparationStop::Failed(map_path_error(error)))?;
        let _operation = self
            .paths
            .acquire_operation_exclusive()
            .map_err(|error| RuntimePreparationStop::Failed(map_path_error(error)))?;
        let active_state = load_active_for_preparation(&self.activation, force_reinstall)?;
        let active_pointer = active_state.pointer;
        let active = active_pointer
            .as_ref()
            .map(|pointer| pointer.active.summary());
        let watermark =
            load_sequence_watermark(&self.paths).map_err(RuntimePreparationStop::Failed)?;
        let minimum_sequence = active
            .as_ref()
            .map(|value| value.sequence)
            .unwrap_or(0)
            .max(watermark.as_ref().map(|value| value.sequence).unwrap_or(0));
        let embedded = current_embedded_manifest()
            .ok_or_else(|| failed(RuntimeErrorCode::UnsupportedPlatform, false))?;
        let environment = current_manifest_environment(minimum_sequence)
            .map_err(RuntimePreparationStop::Failed)?;
        let verified = verify_embedded_manifest(embedded, &environment)
            .map_err(RuntimePreparationStop::Failed)?;
        let candidate = RuntimeCandidateSummary {
            version: verified.manifest.artifact.version.clone(),
            sequence: verified.manifest.sequence,
            manifest_sha256: verified.exact_bytes_sha256.clone(),
        };
        persist_sequence_watermark(&self.paths, &verified)
            .map_err(RuntimePreparationStop::Failed)?;

        if !force_reinstall
            && active.as_ref().is_some_and(|active| {
                active.version == candidate.version
                    && active.sequence == candidate.sequence
                    && active.manifest_sha256 == candidate.manifest_sha256
            })
        {
            return Ok(RuntimePreparationOutcome {
                active: active.expect("checked active"),
                activated: false,
                smoke: None,
            });
        }

        observer.candidate_verified(candidate);
        observer.phase_changed(RuntimePhase::Downloading);
        let archive = &verified.manifest.artifact.archive;
        let archive_path = self.paths.downloads.join(format!(
            "runtime-{}-{}.zip",
            verified.manifest.artifact.version,
            &archive.sha256[..16]
        ));
        let reporter = ObserverDownloadReporter { observer };
        let download = download_archive_blocking_with_reporter(
            &DownloadSpec {
                source_url: verified.manifest.artifact.source_url.clone(),
                expected_size: archive.byte_size,
                expected_sha256: archive.sha256.clone(),
                completed_path: archive_path,
            },
            control,
            &reporter,
        )
        .map_err(|error| map_download_error(error.code))?;

        observer.phase_changed(RuntimePhase::ArchiveVerifying);
        if download.byte_size != archive.byte_size || download.sha256 != archive.sha256 {
            return Err(failed(RuntimeErrorCode::ArchiveHashMismatch, true));
        }

        observer.phase_changed(RuntimePhase::Extracting);
        let candidate_id = random_candidate_id();
        let candidate_root = self
            .paths
            .create_candidate(&candidate_id)
            .map_err(|error| RuntimePreparationStop::Failed(map_path_error(error)))?;
        let result = self.prepare_candidate(
            &verified,
            &download.completed_path,
            &candidate_root,
            observer,
            active_state.repair_corrupt_activation,
        );
        if result.is_err() && candidate_root.exists() {
            let _ = fs::remove_dir_all(&candidate_root);
        }
        result
    }

    fn prepare_candidate(
        &self,
        verified: &VerifiedRuntimeManifest,
        archive_path: &Path,
        candidate_root: &Path,
        observer: &dyn RuntimePreparationObserver,
        repair_corrupt_activation: bool,
    ) -> Result<RuntimePreparationOutcome, RuntimePreparationStop> {
        extract_runtime_archive(archive_path, candidate_root, &verified.manifest.artifact)
            .map_err(|error| map_extraction_error(error.code))?;
        observer.phase_changed(RuntimePhase::IdentityVerifying);
        let identity = verify_runtime_identity(candidate_root, &verified.manifest.artifact)
            .map_err(|error| map_identity_error(error.code))?;
        observer.phase_changed(RuntimePhase::SmokeTesting);
        let smoke = self
            .smoke_runner
            .run(verified, &identity, candidate_root)
            .map_err(RuntimePreparationStop::Failed)?;
        validate_smoke_evidence(&smoke, verified)?;
        let smoke_bytes = serde_json::to_vec_pretty(&smoke)
            .map_err(|_| failed(RuntimeErrorCode::SmokeFailed, false))?;
        write_private_atomic(
            &candidate_root.join("installation-smoke.json"),
            &smoke_bytes,
        )
        .map_err(|_| failed(RuntimeErrorCode::Io, true))?;

        observer.phase_changed(RuntimePhase::Activating);
        let receipt =
            VerifiedRuntimeReceipt::from_verified_manifest(verified, Utc::now().to_rfc3339());
        let activation = if repair_corrupt_activation {
            self.activation
                .repair_and_activate(candidate_root, receipt, ActivationFault::None)
        } else {
            self.activation
                .activate(candidate_root, receipt, ActivationFault::None)
        };
        let pointer = activation.map_err(|_| failed(RuntimeErrorCode::ActivationFailed, true))?;
        Ok(RuntimePreparationOutcome {
            active: pointer.active.summary(),
            activated: true,
            smoke: Some(smoke),
        })
    }
}

fn load_active_for_preparation(
    activation: &ActivationStore,
    force_reinstall: bool,
) -> Result<ActivePreparationState, RuntimePreparationStop> {
    match activation.load_pointer() {
        Ok(pointer) => Ok(ActivePreparationState {
            pointer,
            repair_corrupt_activation: force_reinstall,
        }),
        Err(error) if force_reinstall && repairable_activation_state_error(&error) => {
            Ok(ActivePreparationState {
                pointer: None,
                repair_corrupt_activation: true,
            })
        }
        Err(error) if repairable_activation_state_error(&error) => {
            Err(failed(RuntimeErrorCode::StateCorrupt, false))
        }
        Err(_) => Err(failed(RuntimeErrorCode::Io, true)),
    }
}

struct ObserverDownloadReporter<'a> {
    observer: &'a dyn RuntimePreparationObserver,
}

impl DownloadProgressReporter for ObserverDownloadReporter<'_> {
    fn try_report(&self, completed_bytes: u64, total_bytes: u64) -> bool {
        self.observer
            .download_progress(completed_bytes, total_bytes);
        true
    }
}

fn verify_embedded_manifest(
    embedded: EmbeddedRuntimeManifest,
    environment: &ManifestEnvironment,
) -> Result<VerifiedRuntimeManifest, RuntimePreparationFailure> {
    let mut trust = ManifestTrustStore::new();
    trust
        .add_minisign_key(embedded.signing_key_id, embedded.public_key)
        .map_err(|_| RuntimePreparationFailure::new(RuntimeErrorCode::ManifestInvalid, false))?;
    trust
        .verify_exact_bytes(
            embedded.signing_key_id,
            embedded.manifest_bytes,
            embedded.signature,
            environment,
        )
        .map_err(|error| map_manifest_error(error.code))
}

fn validate_smoke_evidence(
    smoke: &InstallationSmokeEvidence,
    verified: &VerifiedRuntimeManifest,
) -> Result<(), RuntimePreparationStop> {
    if smoke.schema_version != 1
        || smoke.browser_version != verified.manifest.artifact.version
        || smoke.screenshot_bytes == 0
        || smoke.screenshot_sha256.len() != 64
        || !smoke
            .screenshot_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || smoke.transport != "remote_debugging_pipe_nul_json"
        || !smoke.target_closed
    {
        return Err(failed(RuntimeErrorCode::SmokeFailed, false));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SequenceWatermark {
    schema_version: u32,
    sequence: u64,
    manifest_sha256: String,
    updated_at: String,
}

fn watermark_path(paths: &RuntimePaths) -> PathBuf {
    paths.root.join("manifest-sequence.json")
}

fn load_sequence_watermark(
    paths: &RuntimePaths,
) -> Result<Option<SequenceWatermark>, RuntimePreparationFailure> {
    let path = watermark_path(paths);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(RuntimePreparationFailure::new(RuntimeErrorCode::Io, true)),
    };
    if metadata.file_type().is_symlink()
        || !metadata.file_type().is_file()
        || metadata.len() > MAX_WATERMARK_BYTES
    {
        return Err(RuntimePreparationFailure::new(
            RuntimeErrorCode::StateCorrupt,
            false,
        ));
    }
    let bytes =
        fs::read(path).map_err(|_| RuntimePreparationFailure::new(RuntimeErrorCode::Io, true))?;
    let watermark: SequenceWatermark = serde_json::from_slice(&bytes)
        .map_err(|_| RuntimePreparationFailure::new(RuntimeErrorCode::StateCorrupt, false))?;
    if watermark.schema_version != SEQUENCE_WATERMARK_SCHEMA_VERSION
        || watermark.sequence == 0
        || watermark.manifest_sha256.len() != 64
        || !watermark
            .manifest_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || chrono::DateTime::parse_from_rfc3339(&watermark.updated_at).is_err()
    {
        return Err(RuntimePreparationFailure::new(
            RuntimeErrorCode::StateCorrupt,
            false,
        ));
    }
    Ok(Some(watermark))
}

fn persist_sequence_watermark(
    paths: &RuntimePaths,
    verified: &VerifiedRuntimeManifest,
) -> Result<(), RuntimePreparationFailure> {
    let current = load_sequence_watermark(paths)?;
    if current
        .as_ref()
        .is_some_and(|value| value.sequence >= verified.manifest.sequence)
    {
        return Ok(());
    }
    let watermark = SequenceWatermark {
        schema_version: SEQUENCE_WATERMARK_SCHEMA_VERSION,
        sequence: verified.manifest.sequence,
        manifest_sha256: verified.exact_bytes_sha256.clone(),
        updated_at: Utc::now().to_rfc3339(),
    };
    let bytes = serde_json::to_vec_pretty(&watermark)
        .map_err(|_| RuntimePreparationFailure::new(RuntimeErrorCode::Io, true))?;
    write_private_atomic(&watermark_path(paths), &bytes).map_err(map_path_error)
}

fn current_manifest_environment(
    minimum_sequence: u64,
) -> Result<ManifestEnvironment, RuntimePreparationFailure> {
    let platform = RuntimePlatform::current().ok_or_else(|| {
        RuntimePreparationFailure::new(RuntimeErrorCode::UnsupportedPlatform, false)
    })?;
    let architecture = RuntimeArchitecture::current().ok_or_else(|| {
        RuntimePreparationFailure::new(RuntimeErrorCode::UnsupportedArchitecture, false)
    })?;
    let os_version = current_os_version()?;
    Ok(ManifestEnvironment {
        platform,
        architecture,
        os_version,
        protocol_version: RUNTIME_PROTOCOL_VERSION,
        minimum_sequence,
    })
}

#[cfg(target_os = "macos")]
fn current_os_version() -> Result<String, RuntimePreparationFailure> {
    let output = Command::new("/usr/bin/sw_vers")
        .arg("-productVersion")
        .output()
        .map_err(|_| {
            RuntimePreparationFailure::new(RuntimeErrorCode::UnsupportedOsVersion, false)
        })?;
    if !output.status.success() {
        return Err(RuntimePreparationFailure::new(
            RuntimeErrorCode::UnsupportedOsVersion,
            false,
        ));
    }
    validate_os_version(String::from_utf8_lossy(&output.stdout).trim())
}

#[cfg(target_os = "windows")]
fn current_os_version() -> Result<String, RuntimePreparationFailure> {
    // Tauri 2's supported Windows baseline is Windows 10. The exact build remains part of the
    // platform supervisor evidence; this manifest gate intentionally compares the product family.
    validate_os_version("10.0")
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn current_os_version() -> Result<String, RuntimePreparationFailure> {
    Err(RuntimePreparationFailure::new(
        RuntimeErrorCode::UnsupportedPlatform,
        false,
    ))
}

fn validate_os_version(value: &str) -> Result<String, RuntimePreparationFailure> {
    if value.is_empty()
        || value.len() > 64
        || value.split('.').any(|part| {
            part.is_empty() || part.len() > 10 || !part.bytes().all(|byte| byte.is_ascii_digit())
        })
    {
        return Err(RuntimePreparationFailure::new(
            RuntimeErrorCode::UnsupportedOsVersion,
            false,
        ));
    }
    Ok(value.to_string())
}

fn random_candidate_id() -> String {
    let mut bytes = [0_u8; 16];
    OsRng.fill_bytes(&mut bytes);
    format!("candidate-{}", hex::encode(bytes))
}

fn failed(code: RuntimeErrorCode, retryable: bool) -> RuntimePreparationStop {
    RuntimePreparationStop::Failed(RuntimePreparationFailure::new(code, retryable))
}

fn map_manifest_error(code: ManifestErrorCode) -> RuntimePreparationFailure {
    let code = match code {
        ManifestErrorCode::InvalidSignature => RuntimeErrorCode::ManifestSignatureInvalid,
        ManifestErrorCode::RollbackRejected => RuntimeErrorCode::ManifestRollbackRejected,
        ManifestErrorCode::UnsupportedPlatform => RuntimeErrorCode::UnsupportedPlatform,
        ManifestErrorCode::UnsupportedArchitecture => RuntimeErrorCode::UnsupportedArchitecture,
        ManifestErrorCode::UnsupportedOs => RuntimeErrorCode::UnsupportedOsVersion,
        ManifestErrorCode::ProtocolTooOld => RuntimeErrorCode::ProtocolTooOld,
        ManifestErrorCode::UnknownKey
        | ManifestErrorCode::InvalidKey
        | ManifestErrorCode::InvalidEncoding
        | ManifestErrorCode::InvalidSchema
        | ManifestErrorCode::InvalidField => RuntimeErrorCode::ManifestInvalid,
    };
    RuntimePreparationFailure::new(code, false)
}

fn map_path_error(error: RuntimePathError) -> RuntimePreparationFailure {
    match error {
        RuntimePathError::LockUnavailable => {
            RuntimePreparationFailure::new(RuntimeErrorCode::LockUnavailable, true)
        }
        RuntimePathError::SymlinkRejected | RuntimePathError::InvalidRoot => {
            RuntimePreparationFailure::new(RuntimeErrorCode::StateCorrupt, false)
        }
        RuntimePathError::InvalidName | RuntimePathError::AlreadyExists | RuntimePathError::Io => {
            RuntimePreparationFailure::new(RuntimeErrorCode::Io, true)
        }
    }
}

fn map_download_error(code: DownloadErrorCode) -> RuntimePreparationStop {
    match code {
        DownloadErrorCode::Paused => RuntimePreparationStop::Paused,
        DownloadErrorCode::Cancelled | DownloadErrorCode::DownloadInterrupted => {
            failed(RuntimeErrorCode::DownloadInterrupted, true)
        }
        DownloadErrorCode::HashMismatch => failed(RuntimeErrorCode::ArchiveHashMismatch, true),
        DownloadErrorCode::SizeLimitExceeded => {
            failed(RuntimeErrorCode::ArchiveSizeMismatch, false)
        }
        DownloadErrorCode::InvalidRequest
        | DownloadErrorCode::DestinationConflict
        | DownloadErrorCode::JournalCorrupt
        | DownloadErrorCode::ResponseEncodingRejected => {
            failed(RuntimeErrorCode::StateCorrupt, false)
        }
        DownloadErrorCode::Network
        | DownloadErrorCode::RedirectRejected
        | DownloadErrorCode::MissingValidator
        | DownloadErrorCode::ValidatorChanged
        | DownloadErrorCode::RangeRejected
        | DownloadErrorCode::Io => failed(RuntimeErrorCode::DownloadFailed, true),
    }
}

fn map_extraction_error(code: ExtractionErrorCode) -> RuntimePreparationStop {
    match code {
        ExtractionErrorCode::ArchiveSizeMismatch => {
            failed(RuntimeErrorCode::ArchiveSizeMismatch, false)
        }
        ExtractionErrorCode::Io => failed(RuntimeErrorCode::Io, true),
        _ => failed(RuntimeErrorCode::ExtractionRejected, false),
    }
}

fn map_identity_error(code: IdentityErrorCode) -> RuntimePreparationStop {
    match code {
        IdentityErrorCode::Io => failed(RuntimeErrorCode::Io, true),
        IdentityErrorCode::PlatformVerificationUnsupported => {
            failed(RuntimeErrorCode::UnsupportedPlatform, false)
        }
        _ => failed(RuntimeErrorCode::ExecutableIdentityMismatch, false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_manifest_is_signed_for_the_exact_current_target() {
        let embedded = current_embedded_manifest().expect("supported test target");
        let environment = current_manifest_environment(0).expect("current environment");
        let verified = verify_embedded_manifest(embedded, &environment).expect("signed manifest");
        assert_eq!(verified.manifest.signing_key_id, SIGNING_KEY_ID);
        assert_eq!(verified.manifest.artifact.platform, environment.platform);
        assert_eq!(
            verified.manifest.artifact.architecture,
            environment.architecture
        );
        assert_eq!(verified.exact_bytes_sha256.len(), 64);
    }

    #[test]
    fn durable_sequence_watermark_is_monotonic_and_corruption_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let paths = RuntimePaths::under(temp.path().join("runtime")).unwrap();
        paths.prepare_private().unwrap();
        let verified = verify_embedded_manifest(
            current_embedded_manifest().unwrap(),
            &current_manifest_environment(0).unwrap(),
        )
        .unwrap();
        persist_sequence_watermark(&paths, &verified).unwrap();
        let watermark = load_sequence_watermark(&paths).unwrap().unwrap();
        assert_eq!(watermark.sequence, verified.manifest.sequence);
        assert_eq!(watermark.manifest_sha256, verified.exact_bytes_sha256);

        fs::write(watermark_path(&paths), b"{corrupt").unwrap();
        assert_eq!(
            load_sequence_watermark(&paths).unwrap_err().code,
            RuntimeErrorCode::StateCorrupt
        );
    }

    #[test]
    fn os_version_and_failure_codes_are_bounded() {
        assert!(validate_os_version("14.6.1").is_ok());
        for invalid in ["", "14..1", "14.beta", "1.2.3.4.5.12345678901"] {
            assert_eq!(
                validate_os_version(invalid).unwrap_err().code,
                RuntimeErrorCode::UnsupportedOsVersion
            );
        }
        assert_eq!(
            map_manifest_error(ManifestErrorCode::InvalidSignature).code,
            RuntimeErrorCode::ManifestSignatureInvalid
        );
        assert_eq!(
            map_download_error(DownloadErrorCode::Paused),
            RuntimePreparationStop::Paused
        );
        assert_eq!(
            map_extraction_error(ExtractionErrorCode::DuplicatePath),
            failed(RuntimeErrorCode::ExtractionRejected, false)
        );
    }

    #[test]
    fn only_explicit_reinstall_can_enter_corrupt_activation_repair_mode() {
        let temp = tempfile::tempdir().unwrap();
        let paths = RuntimePaths::under(temp.path().join("runtime")).unwrap();
        paths.prepare_private().unwrap();
        fs::write(&paths.active_pointer, b"{corrupt-active-pointer").unwrap();
        let activation = ActivationStore::new(paths);

        assert_eq!(
            load_active_for_preparation(&activation, false),
            Err(RuntimePreparationStop::Failed(RuntimePreparationFailure {
                code: RuntimeErrorCode::StateCorrupt,
                retryable: false,
            }))
        );
        assert_eq!(
            load_active_for_preparation(&activation, true).unwrap(),
            ActivePreparationState {
                pointer: None,
                repair_corrupt_activation: true,
            }
        );
    }
}
