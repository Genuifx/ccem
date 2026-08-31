use crate::browser::runtime::activation::{
    ActivatedRuntimePointer, ActivationStore, ActiveRuntimeLease, RuntimeActivationError,
};
use crate::browser::runtime::identity::VerifiedRuntimeIdentity;
use crate::browser::runtime::manifest::VerifiedRuntimeManifest;
use chrono::Utc;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::fmt;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub(super) const SUPERVISOR_SCHEMA_VERSION: u32 = 1;
pub(super) const MAX_METADATA_BYTES: u64 = 1024 * 1024;
pub(super) const MAX_IDENTIFIER_BYTES: usize = 192;

/// A launch capability reconstructed only from the active, verified runtime store.
///
/// It is deliberately not deserializable and has no public raw-path constructor. Loading it
/// revalidates the activation receipt, containment, exact executable path, and executable digest.
#[derive(Debug, Clone)]
pub(crate) struct VerifiedRuntimeExecutable {
    executable: PathBuf,
    executable_sha256: String,
    runtime_version: String,
    manifest_sha256: String,
}

impl VerifiedRuntimeExecutable {
    pub(crate) fn from_active_store(store: &ActivationStore) -> Result<Self, SupervisorError> {
        let pointer = store
            .load_pointer()
            .map_err(SupervisorError::RuntimeActivation)?
            .ok_or(SupervisorError::RuntimeUnavailable)?;
        Self::from_active_pointer(store, pointer)
    }

    pub(crate) fn from_active_lease(
        store: &ActivationStore,
        lease: &ActiveRuntimeLease,
    ) -> Result<Self, SupervisorError> {
        Self::from_active_pointer(store, lease.pointer().clone())
    }

    fn from_active_pointer(
        store: &ActivationStore,
        pointer: ActivatedRuntimePointer,
    ) -> Result<Self, SupervisorError> {
        let receipt = pointer.active;
        let version_directory_name = format!(
            "runtime-{}-{}",
            receipt.version,
            &receipt.manifest_sha256[..16]
        );
        let version_directory = store
            .paths()
            .version_path(&version_directory_name)
            .map_err(|_| SupervisorError::RuntimeUnavailable)?;
        let executable = version_directory.join(&receipt.executable_relative_path);
        let metadata =
            fs::symlink_metadata(&executable).map_err(|_| SupervisorError::RuntimeUnavailable)?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err(SupervisorError::ExecutableIdentityMismatch);
        }
        let canonical_root = version_directory
            .canonicalize()
            .map_err(|_| SupervisorError::RuntimeUnavailable)?;
        let canonical_executable = executable
            .canonicalize()
            .map_err(|_| SupervisorError::RuntimeUnavailable)?;
        if !canonical_executable.starts_with(&canonical_root)
            || sha256_file(&canonical_executable)? != receipt.executable_sha256
        {
            return Err(SupervisorError::ExecutableIdentityMismatch);
        }
        Ok(Self {
            executable: canonical_executable,
            executable_sha256: receipt.executable_sha256,
            runtime_version: receipt.version,
            manifest_sha256: receipt.manifest_sha256,
        })
    }

    /// Build a pre-activation launch capability for installation smoke.
    ///
    /// The caller must supply the non-deserializable products of manifest and platform identity
    /// verification. This method nevertheless rechecks the complete binding and file digest at the
    /// candidate path, so stale evidence or a candidate mutated after verification is rejected.
    pub(crate) fn from_verified_candidate(
        candidate_root: &Path,
        verified_manifest: &VerifiedRuntimeManifest,
        verified_identity: &VerifiedRuntimeIdentity,
    ) -> Result<Self, SupervisorError> {
        let artifact = &verified_manifest.manifest.artifact;
        let root_metadata = fs::symlink_metadata(candidate_root)
            .map_err(|_| SupervisorError::RuntimeUnavailable)?;
        if !root_metadata.file_type().is_dir() || root_metadata.file_type().is_symlink() {
            return Err(SupervisorError::ExecutableIdentityMismatch);
        }
        let canonical_root = candidate_root
            .canonicalize()
            .map_err(|_| SupervisorError::RuntimeUnavailable)?;
        let executable = candidate_root.join(&artifact.layout.executable.relative_path);
        let executable_metadata =
            fs::symlink_metadata(&executable).map_err(|_| SupervisorError::RuntimeUnavailable)?;
        if !executable_metadata.file_type().is_file()
            || executable_metadata.file_type().is_symlink()
            || executable_metadata.len() != artifact.layout.executable.byte_size
            || executable_metadata.len() != verified_identity.executable_size
        {
            return Err(SupervisorError::ExecutableIdentityMismatch);
        }
        let canonical_executable = executable
            .canonicalize()
            .map_err(|_| SupervisorError::RuntimeUnavailable)?;
        let identity_executable = verified_identity
            .executable_path
            .canonicalize()
            .map_err(|_| SupervisorError::ExecutableIdentityMismatch)?;
        let digest = sha256_file(&canonical_executable)?;
        let platform = &verified_identity.platform_identity;
        if !canonical_executable.starts_with(&canonical_root)
            || canonical_executable != identity_executable
            || digest != artifact.layout.executable.sha256
            || digest != verified_identity.executable_sha256
            || platform.platform != artifact.platform
            || !platform.architectures.contains(&artifact.architecture)
            || platform.product_name != artifact.product_identity.product_name
            || platform.product_version != artifact.product_identity.product_version
            || platform.bundle_identifier != artifact.product_identity.bundle_identifier
            || platform.publisher != artifact.product_identity.publisher
            || artifact.version != artifact.product_identity.product_version
            || !is_sha256(&verified_manifest.exact_bytes_sha256)
        {
            return Err(SupervisorError::ExecutableIdentityMismatch);
        }
        Ok(Self {
            executable: canonical_executable,
            executable_sha256: digest,
            runtime_version: artifact.version.clone(),
            manifest_sha256: verified_manifest.exact_bytes_sha256.clone(),
        })
    }

    pub(crate) fn executable(&self) -> &Path {
        &self.executable
    }

    pub(crate) fn executable_sha256(&self) -> &str {
        &self.executable_sha256
    }

    pub(crate) fn runtime_version(&self) -> &str {
        &self.runtime_version
    }

    pub(crate) fn manifest_sha256(&self) -> &str {
        &self.manifest_sha256
    }

    pub(super) fn verify_unchanged(&self) -> Result<(), SupervisorError> {
        let metadata = fs::symlink_metadata(&self.executable)
            .map_err(|_| SupervisorError::ExecutableIdentityMismatch)?;
        let canonical = self
            .executable
            .canonicalize()
            .map_err(|_| SupervisorError::ExecutableIdentityMismatch)?;
        if !metadata.file_type().is_file()
            || metadata.file_type().is_symlink()
            || canonical != self.executable
            || sha256_file(&self.executable)? != self.executable_sha256
        {
            return Err(SupervisorError::ExecutableIdentityMismatch);
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn for_test(
        executable: PathBuf,
        executable_sha256: String,
        runtime_version: impl Into<String>,
    ) -> Self {
        Self {
            executable,
            executable_sha256,
            runtime_version: runtime_version.into(),
            manifest_sha256: "11".repeat(32),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct LoginRuntimeSpec {
    runtime: VerifiedRuntimeExecutable,
    protocol_version: String,
}

impl LoginRuntimeSpec {
    pub(crate) fn new(
        runtime: VerifiedRuntimeExecutable,
        protocol_version: impl Into<String>,
    ) -> Result<Self, SupervisorError> {
        let protocol_version = protocol_version.into();
        validate_identifier(&protocol_version, "protocol version")?;
        Ok(Self {
            runtime,
            protocol_version,
        })
    }

    pub(crate) fn runtime(&self) -> &VerifiedRuntimeExecutable {
        &self.runtime
    }

    pub(crate) fn protocol_version(&self) -> &str {
        &self.protocol_version
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ProcessIdentity {
    pub pid: u32,
    pub birth_token: String,
    pub executable: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum OwnershipDomain {
    UnixProcessGroup { pgid: i32 },
    WindowsJob { name: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum TransportKind {
    UnixPrivateFd3Fd4,
    WindowsPrivateHandleList,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum CleanupState {
    Running,
    GracefulCloseRequested,
    ForceStopRequested,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RuntimeMetadata {
    pub schema_version: u32,
    pub revision: u64,
    pub runtime_id: String,
    pub ownership_id: String,
    pub controller_instance_id: String,
    pub controller: ProcessIdentity,
    pub browser: ProcessIdentity,
    pub ownership_domain: OwnershipDomain,
    pub executable_sha256: String,
    pub manifest_sha256: String,
    pub runtime_version: String,
    pub protocol_version: String,
    pub profile_id: String,
    pub workspace_identity: String,
    pub user_data_dir: PathBuf,
    pub transport: TransportKind,
    pub cleanup_state: CleanupState,
    pub created_at: String,
    pub updated_at: String,
}

impl RuntimeMetadata {
    pub(super) fn touch_cleanup(&mut self, cleanup_state: CleanupState) {
        self.revision = self.revision.saturating_add(1);
        self.cleanup_state = cleanup_state;
        self.updated_at = Utc::now().to_rfc3339();
    }
}

pub(crate) struct PrivateCdpTransport {
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
}

impl PrivateCdpTransport {
    pub(super) fn new(
        reader: impl Read + Send + 'static,
        writer: impl Write + Send + 'static,
    ) -> Self {
        Self {
            reader: Box::new(reader),
            writer: Box::new(writer),
        }
    }

    pub(super) fn with_io<T>(
        &mut self,
        callback: impl FnOnce(&mut dyn Read, &mut dyn Write) -> T,
    ) -> T {
        callback(self.reader.as_mut(), self.writer.as_mut())
    }

    pub(super) fn request_browser_close(&mut self) -> Result<(), SupervisorError> {
        self.writer
            .write_all(b"{\"id\":1,\"method\":\"Browser.close\"}\0")
            .and_then(|_| self.writer.flush())
            .map_err(|_| SupervisorError::TransportFailed)
    }
}

pub(super) trait OwnershipGuard: Send {
    fn reap_leader_if_exited(&mut self) {}
}

pub(super) struct LaunchedRuntime {
    pub identity: ProcessIdentity,
    pub ownership_domain: OwnershipDomain,
    pub transport_kind: TransportKind,
    pub transport: PrivateCdpTransport,
    pub guard: Box<dyn OwnershipGuard>,
}

#[derive(Debug, Clone)]
pub(super) struct PlatformLaunchRequest {
    pub executable: VerifiedRuntimeExecutable,
    pub arguments: Vec<OsString>,
    pub runtime_id: String,
}

pub(super) trait RuntimeLauncher: Send + Sync {
    fn launch(&self, request: PlatformLaunchRequest) -> Result<LaunchedRuntime, SupervisorError>;
}

pub(super) trait ProcessInspector: Send + Sync {
    fn inspect_process(&self, pid: u32) -> Result<Option<ProcessIdentity>, SupervisorError>;
    fn ownership_domain_alive(
        &self,
        ownership_domain: &OwnershipDomain,
    ) -> Result<bool, SupervisorError>;
    fn terminate_ownership_domain(
        &self,
        ownership_domain: &OwnershipDomain,
    ) -> Result<(), SupervisorError>;
}

#[derive(Debug)]
pub(crate) enum SupervisorError {
    InvalidRoot,
    InvalidIdentifier(&'static str),
    RuntimeUnavailable,
    RuntimeActivation(RuntimeActivationError),
    ExecutableIdentityMismatch,
    ProcessIdentityMismatch,
    OwnershipDomainMismatch,
    UnsafeMetadata,
    MetadataCorrupt,
    MetadataConflict,
    LaunchFailed,
    InspectionFailed,
    TransportFailed,
    CleanupTimedOut,
    Profile(String),
    Io(String),
    UnsupportedPlatform,
}

impl fmt::Display for SupervisorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRoot => formatter.write_str("Invalid Login Browser supervisor root."),
            Self::InvalidIdentifier(field) => write!(formatter, "Invalid {field}."),
            Self::RuntimeUnavailable => {
                formatter.write_str("No verified browser runtime is active.")
            }
            Self::RuntimeActivation(error) => {
                write!(formatter, "Runtime activation error: {error:?}")
            }
            Self::ExecutableIdentityMismatch => {
                formatter.write_str("Verified browser executable identity changed.")
            }
            Self::ProcessIdentityMismatch => {
                formatter.write_str("Managed browser PID identity no longer matches metadata.")
            }
            Self::OwnershipDomainMismatch => {
                formatter.write_str("Managed browser ownership domain does not match its leader.")
            }
            Self::UnsafeMetadata => formatter.write_str("Supervisor metadata path is unsafe."),
            Self::MetadataCorrupt => formatter.write_str("Supervisor metadata is corrupt."),
            Self::MetadataConflict => formatter.write_str("Supervisor metadata already exists."),
            Self::LaunchFailed => formatter.write_str("Managed browser process launch failed."),
            Self::InspectionFailed => formatter.write_str("Managed process inspection failed."),
            Self::TransportFailed => formatter.write_str("Private CDP pipe operation failed."),
            Self::CleanupTimedOut => {
                formatter.write_str("Managed browser ownership domain did not exit.")
            }
            Self::Profile(error) => write!(formatter, "Browser profile state error: {error}"),
            Self::Io(action) => {
                write!(formatter, "Supervisor I/O failed while trying to {action}.")
            }
            Self::UnsupportedPlatform => {
                formatter.write_str("Managed browser supervision is unsupported on this platform.")
            }
        }
    }
}

impl std::error::Error for SupervisorError {}

pub(super) fn random_id(prefix: &str) -> String {
    let mut bytes = [0_u8; 16];
    OsRng.fill_bytes(&mut bytes);
    format!("{prefix}-{}", hex::encode(bytes))
}

pub(super) fn headed_arguments(user_data_dir: &Path, runtime_id: &str) -> Vec<OsString> {
    // This is a closed allowlist. In particular, production login launches never inherit the
    // spike's headless, keychain-bypass, startup-window suppression, or IPC-flooding switches.
    vec![
        OsString::from("--remote-debugging-pipe"),
        OsString::from(format!("--user-data-dir={}", user_data_dir.display())),
        OsString::from(format!("--ccem-managed-runtime-id={runtime_id}")),
        OsString::from("--no-first-run"),
        OsString::from("--no-default-browser-check"),
        OsString::from("--disable-component-update"),
        OsString::from("about:blank"),
    ]
}

pub(super) fn validate_identifier(value: &str, field: &'static str) -> Result<(), SupervisorError> {
    if value.is_empty()
        || value.len() > MAX_IDENTIFIER_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(SupervisorError::InvalidIdentifier(field));
    }
    Ok(())
}

pub(super) fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn sha256_file(path: &Path) -> Result<String, SupervisorError> {
    let mut file = File::open(path)
        .map_err(|_| SupervisorError::Io("open the verified executable".to_string()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| SupervisorError::Io("hash the verified executable".to_string()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}
