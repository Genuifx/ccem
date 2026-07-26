use super::manifest::{RuntimeArchitecture, RuntimePlatform, VerifiedRuntimeManifest};
use super::paths::{
    set_private_file_permissions, sync_directory, write_private_atomic, RuntimePathError,
    RuntimePaths,
};
use super::state::RuntimeVersionSummary;
use fs2::FileExt;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::{Component, Path};

const ACTIVATION_POINTER_SCHEMA_VERSION: u32 = 1;
const VERIFICATION_RECEIPT_SCHEMA_VERSION: u32 = 1;
const RECEIPT_FILE_NAME: &str = "verification-receipt.json";
const MAX_STATE_BYTES: u64 = 1024 * 1024;
const MAX_EXECUTABLE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VerifiedRuntimeReceipt {
    pub schema_version: u32,
    pub version: String,
    pub sequence: u64,
    pub signing_key_id: String,
    pub manifest_sha256: String,
    pub archive_sha256: String,
    pub platform: RuntimePlatform,
    pub architecture: RuntimeArchitecture,
    pub executable_relative_path: String,
    pub executable_sha256: String,
    pub verified_at: String,
}

impl VerifiedRuntimeReceipt {
    pub fn from_verified_manifest(
        verified: &VerifiedRuntimeManifest,
        verified_at: impl Into<String>,
    ) -> Self {
        Self {
            schema_version: VERIFICATION_RECEIPT_SCHEMA_VERSION,
            version: verified.manifest.artifact.version.clone(),
            sequence: verified.manifest.sequence,
            signing_key_id: verified.manifest.signing_key_id.clone(),
            manifest_sha256: verified.exact_bytes_sha256.clone(),
            archive_sha256: verified.manifest.artifact.archive.sha256.clone(),
            platform: verified.manifest.artifact.platform,
            architecture: verified.manifest.artifact.architecture,
            executable_relative_path: verified
                .manifest
                .artifact
                .layout
                .executable
                .relative_path
                .clone(),
            executable_sha256: verified.manifest.artifact.layout.executable.sha256.clone(),
            verified_at: verified_at.into(),
        }
    }

    pub fn summary(&self) -> RuntimeVersionSummary {
        RuntimeVersionSummary {
            version: self.version.clone(),
            sequence: self.sequence,
            manifest_sha256: self.manifest_sha256.clone(),
        }
    }

    fn version_directory_name(&self) -> Result<String, RuntimeActivationError> {
        validate_receipt(self)?;
        Ok(format!(
            "runtime-{}-{}",
            self.version,
            &self.manifest_sha256[..16]
        ))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivatedRuntimePointer {
    pub schema_version: u32,
    pub generation: u64,
    pub active: VerifiedRuntimeReceipt,
    pub previous: Option<VerifiedRuntimeReceipt>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivationFault {
    None,
    AfterReceiptPersisted,
    AfterVersionPublished,
    BeforePointerCommit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeActivationError {
    Path(RuntimePathError),
    InvalidCandidate,
    InvalidReceipt,
    ReceiptMismatch,
    StateCorrupt,
    VersionConflict,
    RuntimeInUse,
    NoPreviousRuntime,
    InjectedFault(ActivationFault),
    Io,
}

impl From<RuntimePathError> for RuntimeActivationError {
    fn from(value: RuntimePathError) -> Self {
        Self::Path(value)
    }
}

#[derive(Debug, Clone)]
pub struct ActivationStore {
    paths: RuntimePaths,
}

#[derive(Debug)]
pub(crate) struct ActiveRuntimeLease {
    pointer: ActivatedRuntimePointer,
    _guard: RuntimeVersionLeaseGuard,
}

impl ActiveRuntimeLease {
    pub(crate) fn pointer(&self) -> &ActivatedRuntimePointer {
        &self.pointer
    }
}

#[derive(Debug)]
pub(super) struct RuntimeVersionLeaseGuard {
    file: File,
}

impl Drop for RuntimeVersionLeaseGuard {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

impl ActivationStore {
    pub fn new(paths: RuntimePaths) -> Self {
        Self { paths }
    }

    pub fn paths(&self) -> &RuntimePaths {
        &self.paths
    }

    pub fn load_pointer(&self) -> Result<Option<ActivatedRuntimePointer>, RuntimeActivationError> {
        let bytes = match read_bounded_file(&self.paths.active_pointer)? {
            Some(bytes) => bytes,
            None => return Ok(None),
        };
        let pointer: ActivatedRuntimePointer =
            serde_json::from_slice(&bytes).map_err(|_| RuntimeActivationError::StateCorrupt)?;
        validate_pointer(&pointer)?;
        self.verify_persisted_receipt(&pointer.active)?;
        if let Some(previous) = &pointer.previous {
            self.verify_persisted_receipt(previous)?;
        }
        Ok(Some(pointer))
    }

    /// Pin the currently active version for the complete lifetime of a browser session.
    ///
    /// The shared per-version OS lock is acquired while the global mutation lock is held, so a
    /// destructive repair/delete cannot race between pointer validation and lease acquisition.
    pub(crate) fn lease_active(
        &self,
    ) -> Result<Option<ActiveRuntimeLease>, RuntimeActivationError> {
        let _mutation_lock = self.paths.acquire_exclusive()?;
        let Some(pointer) = self.load_pointer()? else {
            return Ok(None);
        };
        let version_name = pointer.active.version_directory_name()?;
        let guard = acquire_version_shared_lease(&self.paths, &version_name)?;
        Ok(Some(ActiveRuntimeLease {
            pointer,
            _guard: guard,
        }))
    }

    pub fn activate(
        &self,
        candidate_directory: &Path,
        receipt: VerifiedRuntimeReceipt,
        fault: ActivationFault,
    ) -> Result<ActivatedRuntimePointer, RuntimeActivationError> {
        self.activate_with_repair(candidate_directory, receipt, fault, false)
    }

    /// Recover only activation-state corruption after a freshly verified candidate completed the
    /// entire production pipeline. Transient IO/path errors remain fail-closed, and a leased
    /// version is never renamed or deleted under a running browser session.
    pub(crate) fn repair_and_activate(
        &self,
        candidate_directory: &Path,
        receipt: VerifiedRuntimeReceipt,
        fault: ActivationFault,
    ) -> Result<ActivatedRuntimePointer, RuntimeActivationError> {
        self.activate_with_repair(candidate_directory, receipt, fault, true)
    }

    fn activate_with_repair(
        &self,
        candidate_directory: &Path,
        mut receipt: VerifiedRuntimeReceipt,
        fault: ActivationFault,
        allow_corrupt_state_repair: bool,
    ) -> Result<ActivatedRuntimePointer, RuntimeActivationError> {
        let _lock = self.paths.acquire_exclusive()?;
        validate_receipt(&receipt)?;
        validate_candidate_directory(&self.paths, candidate_directory, &receipt)?;
        let (previous_pointer, repairing_corrupt_state) = match self.load_pointer() {
            Ok(pointer) => (pointer, false),
            Err(error)
                if allow_corrupt_state_repair && repairable_activation_state_error(&error) =>
            {
                (None, true)
            }
            Err(error) => return Err(error),
        };
        if let Some(current) = previous_pointer.as_ref() {
            if same_runtime_identity(&current.active, &receipt) {
                fs::remove_dir_all(candidate_directory).map_err(|_| RuntimeActivationError::Io)?;
                return Ok(current.clone());
            }
        }

        let receipt_path = candidate_directory.join(RECEIPT_FILE_NAME);
        write_json_atomic(&receipt_path, &receipt)?;
        maybe_inject(fault, ActivationFault::AfterReceiptPersisted)?;

        let version_name = receipt.version_directory_name()?;
        let version_directory = self.paths.version_path(&version_name)?;
        let version_exists = match fs::symlink_metadata(&version_directory) {
            Ok(_) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(_) => return Err(RuntimeActivationError::Io),
        };
        if version_exists {
            let existing = self.verify_existing_version(&version_directory, &receipt);
            match existing {
                Ok(persisted) => {
                    fs::remove_dir_all(candidate_directory)
                        .map_err(|_| RuntimeActivationError::Io)?;
                    receipt = persisted;
                }
                Err(error) if repairing_corrupt_state && repairable_existing_error(&error) => {
                    let _version_lease =
                        acquire_version_exclusive_lease(&self.paths, &version_name)?;
                    let quarantine = quarantine_version_directory(&self.paths, &version_directory)?;
                    if fs::rename(candidate_directory, &version_directory).is_err() {
                        let _ = fs::rename(&quarantine, &version_directory);
                        let _ = sync_directory(&self.paths.versions);
                        return Err(RuntimeActivationError::Io);
                    }
                    sync_directory(&self.paths.versions)?;
                }
                Err(error) => return Err(error),
            }
        } else {
            fs::rename(candidate_directory, &version_directory)
                .map_err(|_| RuntimeActivationError::Io)?;
            sync_directory(&self.paths.versions)?;
        }
        maybe_inject(fault, ActivationFault::AfterVersionPublished)?;

        let generation = previous_pointer
            .as_ref()
            .map(|pointer| pointer.generation.saturating_add(1))
            .unwrap_or(1);
        let pointer = ActivatedRuntimePointer {
            schema_version: ACTIVATION_POINTER_SCHEMA_VERSION,
            generation,
            active: receipt,
            previous: previous_pointer.map(|pointer| pointer.active),
        };
        maybe_inject(fault, ActivationFault::BeforePointerCommit)?;
        let quarantined_pointer = if repairing_corrupt_state {
            quarantine_corrupt_pointer(&self.paths)?
        } else {
            None
        };
        if let Err(error) = write_json_atomic(&self.paths.active_pointer, &pointer) {
            if let Some(quarantine) = quarantined_pointer {
                restore_quarantined_pointer(&self.paths, &quarantine);
            }
            return Err(error);
        }
        Ok(pointer)
    }

    pub fn rollback_to_previous(&self) -> Result<ActivatedRuntimePointer, RuntimeActivationError> {
        let _lock = self.paths.acquire_exclusive()?;
        let current = self
            .load_pointer()?
            .ok_or(RuntimeActivationError::NoPreviousRuntime)?;
        let previous = current
            .previous
            .clone()
            .ok_or(RuntimeActivationError::NoPreviousRuntime)?;
        self.verify_persisted_receipt(&previous)?;
        let pointer = ActivatedRuntimePointer {
            schema_version: ACTIVATION_POINTER_SCHEMA_VERSION,
            generation: current.generation.saturating_add(1),
            active: previous,
            previous: Some(current.active),
        };
        write_json_atomic(&self.paths.active_pointer, &pointer)?;
        Ok(pointer)
    }

    fn verify_persisted_receipt(
        &self,
        expected: &VerifiedRuntimeReceipt,
    ) -> Result<(), RuntimeActivationError> {
        let directory = self
            .paths
            .version_path(&expected.version_directory_name()?)?;
        let directory_metadata = fs::symlink_metadata(&directory)
            .map_err(|_| RuntimeActivationError::ReceiptMismatch)?;
        if !directory_metadata.file_type().is_dir() || directory_metadata.file_type().is_symlink() {
            return Err(RuntimeActivationError::ReceiptMismatch);
        }
        let persisted = read_receipt(&directory)?;
        if &persisted != expected {
            return Err(RuntimeActivationError::ReceiptMismatch);
        }
        let executable = validate_contained_executable(
            &directory,
            &expected.executable_relative_path,
            RuntimeActivationError::ReceiptMismatch,
        )?;
        if sha256_file_bounded(&executable)? != expected.executable_sha256 {
            return Err(RuntimeActivationError::ReceiptMismatch);
        }
        Ok(())
    }

    fn verify_existing_version(
        &self,
        directory: &Path,
        expected: &VerifiedRuntimeReceipt,
    ) -> Result<VerifiedRuntimeReceipt, RuntimeActivationError> {
        let persisted = read_receipt(directory)?;
        if !same_runtime_identity(&persisted, expected) {
            return Err(RuntimeActivationError::VersionConflict);
        }
        self.verify_persisted_receipt(&persisted)?;
        Ok(persisted)
    }
}

pub(super) fn repairable_activation_state_error(error: &RuntimeActivationError) -> bool {
    matches!(
        error,
        RuntimeActivationError::InvalidReceipt
            | RuntimeActivationError::ReceiptMismatch
            | RuntimeActivationError::StateCorrupt
    )
}

fn repairable_existing_error(error: &RuntimeActivationError) -> bool {
    repairable_activation_state_error(error)
        || matches!(error, RuntimeActivationError::VersionConflict)
}

fn quarantine_version_directory(
    paths: &RuntimePaths,
    version_directory: &Path,
) -> Result<std::path::PathBuf, RuntimeActivationError> {
    fs::symlink_metadata(version_directory).map_err(|_| RuntimeActivationError::ReceiptMismatch)?;
    for _ in 0..8 {
        let mut nonce = [0_u8; 16];
        OsRng.fill_bytes(&mut nonce);
        let quarantine = paths.version_path(&format!("quarantine-{}", hex::encode(nonce)))?;
        if quarantine.exists() {
            continue;
        }
        fs::rename(version_directory, &quarantine).map_err(|_| RuntimeActivationError::Io)?;
        sync_directory(&paths.versions)?;
        return Ok(quarantine);
    }
    Err(RuntimeActivationError::Io)
}

fn quarantine_corrupt_pointer(
    paths: &RuntimePaths,
) -> Result<Option<std::path::PathBuf>, RuntimeActivationError> {
    match fs::symlink_metadata(&paths.active_pointer) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(RuntimeActivationError::Io),
    }
    for _ in 0..8 {
        let mut nonce = [0_u8; 16];
        OsRng.fill_bytes(&mut nonce);
        let quarantine = paths
            .candidates
            .join(format!("quarantine-active-{}.json", hex::encode(nonce)));
        if fs::symlink_metadata(&quarantine).is_ok() {
            continue;
        }
        fs::rename(&paths.active_pointer, &quarantine).map_err(|_| RuntimeActivationError::Io)?;
        sync_directory(&paths.root)?;
        sync_directory(&paths.candidates)?;
        return Ok(Some(quarantine));
    }
    Err(RuntimeActivationError::Io)
}

fn restore_quarantined_pointer(paths: &RuntimePaths, quarantine: &Path) {
    if matches!(
        fs::symlink_metadata(&paths.active_pointer),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound
    ) {
        let _ = fs::rename(quarantine, &paths.active_pointer);
        let _ = sync_directory(&paths.root);
        let _ = sync_directory(&paths.candidates);
    }
}

fn acquire_version_shared_lease(
    paths: &RuntimePaths,
    version_name: &str,
) -> Result<RuntimeVersionLeaseGuard, RuntimeActivationError> {
    let file = open_version_lease(paths, version_name)?;
    FileExt::try_lock_shared(&file).map_err(|_| RuntimeActivationError::RuntimeInUse)?;
    Ok(RuntimeVersionLeaseGuard { file })
}

pub(super) fn acquire_version_exclusive_lease(
    paths: &RuntimePaths,
    version_name: &str,
) -> Result<RuntimeVersionLeaseGuard, RuntimeActivationError> {
    let file = open_version_lease(paths, version_name)?;
    FileExt::try_lock_exclusive(&file).map_err(|_| RuntimeActivationError::RuntimeInUse)?;
    Ok(RuntimeVersionLeaseGuard { file })
}

fn open_version_lease(
    paths: &RuntimePaths,
    version_name: &str,
) -> Result<File, RuntimeActivationError> {
    paths.prepare_private()?;
    let lease_path = paths.version_lease_path(version_name)?;
    match fs::symlink_metadata(&lease_path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.file_type().is_file() => {
            return Err(RuntimeActivationError::StateCorrupt);
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(RuntimeActivationError::Io),
    }
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(&lease_path)
        .map_err(|_| RuntimeActivationError::Io)?;
    let metadata = file.metadata().map_err(|_| RuntimeActivationError::Io)?;
    if !metadata.file_type().is_file() {
        return Err(RuntimeActivationError::StateCorrupt);
    }
    set_private_file_permissions(&lease_path)?;
    Ok(file)
}

fn validate_pointer(pointer: &ActivatedRuntimePointer) -> Result<(), RuntimeActivationError> {
    if pointer.schema_version != ACTIVATION_POINTER_SCHEMA_VERSION || pointer.generation == 0 {
        return Err(RuntimeActivationError::StateCorrupt);
    }
    validate_receipt(&pointer.active)?;
    if let Some(previous) = &pointer.previous {
        validate_receipt(previous)?;
        if previous == &pointer.active {
            return Err(RuntimeActivationError::StateCorrupt);
        }
    }
    Ok(())
}

fn validate_receipt(receipt: &VerifiedRuntimeReceipt) -> Result<(), RuntimeActivationError> {
    if receipt.schema_version != VERIFICATION_RECEIPT_SCHEMA_VERSION
        || receipt.sequence == 0
        || receipt.version.is_empty()
        || receipt.version.len() > 128
        || !receipt
            .version
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'.')
        || receipt.signing_key_id.is_empty()
        || receipt.signing_key_id.len() > 128
        || !is_sha256(&receipt.manifest_sha256)
        || !is_sha256(&receipt.archive_sha256)
        || !is_sha256(&receipt.executable_sha256)
        || receipt.verified_at.is_empty()
        || receipt.verified_at.len() > 128
        || chrono::DateTime::parse_from_rfc3339(&receipt.verified_at).is_err()
        || !safe_relative_path(&receipt.executable_relative_path)
    {
        return Err(RuntimeActivationError::InvalidReceipt);
    }
    Ok(())
}

fn validate_candidate_directory(
    paths: &RuntimePaths,
    candidate: &Path,
    receipt: &VerifiedRuntimeReceipt,
) -> Result<(), RuntimeActivationError> {
    if candidate.parent() != Some(paths.candidates.as_path()) {
        return Err(RuntimeActivationError::InvalidCandidate);
    }
    let metadata =
        fs::symlink_metadata(candidate).map_err(|_| RuntimeActivationError::InvalidCandidate)?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err(RuntimeActivationError::InvalidCandidate);
    }
    let canonical_candidates = fs::canonicalize(&paths.candidates)
        .map_err(|_| RuntimeActivationError::InvalidCandidate)?;
    let canonical_candidate =
        fs::canonicalize(candidate).map_err(|_| RuntimeActivationError::InvalidCandidate)?;
    if canonical_candidate.parent() != Some(canonical_candidates.as_path()) {
        return Err(RuntimeActivationError::InvalidCandidate);
    }
    let executable = validate_contained_executable(
        candidate,
        &receipt.executable_relative_path,
        RuntimeActivationError::InvalidCandidate,
    )?;
    let digest =
        sha256_file_bounded(&executable).map_err(|_| RuntimeActivationError::InvalidCandidate)?;
    if digest != receipt.executable_sha256 {
        return Err(RuntimeActivationError::InvalidCandidate);
    }
    Ok(())
}

fn validate_contained_executable(
    root: &Path,
    relative_path: &str,
    error: RuntimeActivationError,
) -> Result<std::path::PathBuf, RuntimeActivationError> {
    let canonical_root = fs::canonicalize(root).map_err(|_| error.clone())?;
    let components = Path::new(relative_path).components().collect::<Vec<_>>();
    let mut current = canonical_root.clone();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(component) = component else {
            return Err(error.clone());
        };
        current.push(component);
        let metadata = fs::symlink_metadata(&current).map_err(|_| error.clone())?;
        if metadata.file_type().is_symlink() {
            return Err(error.clone());
        }
        let is_last = index + 1 == components.len();
        if (is_last && !metadata.file_type().is_file())
            || (!is_last && !metadata.file_type().is_dir())
        {
            return Err(error.clone());
        }
    }
    let canonical_executable = fs::canonicalize(&current).map_err(|_| error.clone())?;
    if !canonical_executable.starts_with(&canonical_root) {
        return Err(error);
    }
    Ok(canonical_executable)
}

fn same_runtime_identity(left: &VerifiedRuntimeReceipt, right: &VerifiedRuntimeReceipt) -> bool {
    left.schema_version == right.schema_version
        && left.version == right.version
        && left.sequence == right.sequence
        && left.signing_key_id == right.signing_key_id
        && left.manifest_sha256 == right.manifest_sha256
        && left.archive_sha256 == right.archive_sha256
        && left.platform == right.platform
        && left.architecture == right.architecture
        && left.executable_relative_path == right.executable_relative_path
        && left.executable_sha256 == right.executable_sha256
}

fn sha256_file_bounded(path: &Path) -> Result<String, RuntimeActivationError> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| RuntimeActivationError::ReceiptMismatch)?;
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() == 0
        || metadata.len() > MAX_EXECUTABLE_BYTES
    {
        return Err(RuntimeActivationError::ReceiptMismatch);
    }
    let mut file = File::open(path).map_err(|_| RuntimeActivationError::ReceiptMismatch)?;
    let mut digest = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| RuntimeActivationError::ReceiptMismatch)?;
        if read == 0 {
            break;
        }
        total = total.saturating_add(read as u64);
        if total > MAX_EXECUTABLE_BYTES {
            return Err(RuntimeActivationError::ReceiptMismatch);
        }
        digest.update(&buffer[..read]);
    }
    if total != metadata.len() {
        return Err(RuntimeActivationError::ReceiptMismatch);
    }
    Ok(hex::encode(digest.finalize()))
}

fn read_receipt(directory: &Path) -> Result<VerifiedRuntimeReceipt, RuntimeActivationError> {
    let bytes = read_bounded_file(&directory.join(RECEIPT_FILE_NAME))?
        .ok_or(RuntimeActivationError::ReceiptMismatch)?;
    let receipt =
        serde_json::from_slice(&bytes).map_err(|_| RuntimeActivationError::ReceiptMismatch)?;
    validate_receipt(&receipt)?;
    Ok(receipt)
}

fn read_bounded_file(path: &Path) -> Result<Option<Vec<u8>>, RuntimeActivationError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(RuntimeActivationError::Io),
    };
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_STATE_BYTES
    {
        return Err(RuntimeActivationError::StateCorrupt);
    }
    fs::read(path)
        .map(Some)
        .map_err(|_| RuntimeActivationError::Io)
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), RuntimeActivationError> {
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|_| RuntimeActivationError::StateCorrupt)?;
    write_private_atomic(path, &bytes).map_err(RuntimeActivationError::Path)
}

fn maybe_inject(
    configured: ActivationFault,
    point: ActivationFault,
) -> Result<(), RuntimeActivationError> {
    if configured == point {
        Err(RuntimeActivationError::InjectedFault(point))
    } else {
        Ok(())
    }
}

fn safe_relative_path(value: &str) -> bool {
    if value.is_empty()
        || value.len() > 4096
        || value.contains(['\0', '\\'])
        || value.split('/').any(|part| part.is_empty())
    {
        return false;
    }
    Path::new(value)
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::path::PathBuf;

    fn receipt(version: &str, sequence: u64, marker: u8) -> VerifiedRuntimeReceipt {
        VerifiedRuntimeReceipt {
            schema_version: VERIFICATION_RECEIPT_SCHEMA_VERSION,
            version: version.to_string(),
            sequence,
            signing_key_id: "fixture-runtime-key".to_string(),
            manifest_sha256: hex::encode(Sha256::digest([marker, 1])),
            archive_sha256: hex::encode(Sha256::digest([marker, 2])),
            platform: RuntimePlatform::Macos,
            architecture: RuntimeArchitecture::Aarch64,
            executable_relative_path: "Browser.app/Contents/MacOS/Browser".to_string(),
            executable_sha256: hex::encode(Sha256::digest(b"verified-runtime-fixture")),
            verified_at: "2026-07-11T00:00:00Z".to_string(),
        }
    }

    fn candidate(store: &ActivationStore, id: &str, receipt: &VerifiedRuntimeReceipt) -> PathBuf {
        let path = store.paths().create_candidate(id).unwrap();
        let executable = path.join(&receipt.executable_relative_path);
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        fs::write(executable, b"verified-runtime-fixture").unwrap();
        path
    }

    fn seeded_store() -> (tempfile::TempDir, ActivationStore, VerifiedRuntimeReceipt) {
        let temp = tempfile::tempdir().unwrap();
        let paths = RuntimePaths::under(temp.path().join("runtime")).unwrap();
        let store = ActivationStore::new(paths);
        let old = receipt("149.0.1", 1, 11);
        let old_candidate = candidate(&store, "old-candidate", &old);
        store
            .activate(&old_candidate, old.clone(), ActivationFault::None)
            .unwrap();
        (temp, store, old)
    }

    #[test]
    fn activation_persists_receipt_and_retains_previous_version() {
        let (_temp, store, old) = seeded_store();
        let new = receipt("150.0.1", 2, 22);
        let new_candidate = candidate(&store, "new-candidate", &new);
        let activated = store
            .activate(&new_candidate, new.clone(), ActivationFault::None)
            .unwrap();
        assert_eq!(activated.active, new);
        assert_eq!(activated.previous, Some(old.clone()));
        assert_eq!(activated.generation, 2);

        let reloaded = ActivationStore::new(store.paths().clone())
            .load_pointer()
            .unwrap()
            .unwrap();
        assert_eq!(reloaded, activated);
        assert!(store
            .paths()
            .version_path(&old.version_directory_name().unwrap())
            .unwrap()
            .is_dir());
    }

    #[test]
    fn every_precommit_fault_leaves_old_active_pointer_unchanged() {
        for fault in [
            ActivationFault::AfterReceiptPersisted,
            ActivationFault::AfterVersionPublished,
            ActivationFault::BeforePointerCommit,
        ] {
            let (_temp, store, old) = seeded_store();
            let new = receipt("150.0.1", 2, fault as u8 + 30);
            let new_candidate = candidate(&store, "new-candidate", &new);
            assert_eq!(
                store.activate(&new_candidate, new, fault),
                Err(RuntimeActivationError::InjectedFault(fault))
            );
            let after = store.load_pointer().unwrap().unwrap();
            assert_eq!(after.active, old, "fault point {fault:?}");
            assert_eq!(after.generation, 1, "fault point {fault:?}");
        }
    }

    #[test]
    fn rollback_atomically_swaps_to_retained_previous_runtime() {
        let (_temp, store, old) = seeded_store();
        let new = receipt("150.0.1", 2, 22);
        let new_candidate = candidate(&store, "new-candidate", &new);
        store
            .activate(&new_candidate, new.clone(), ActivationFault::None)
            .unwrap();
        let rolled_back = store.rollback_to_previous().unwrap();
        assert_eq!(rolled_back.active, old);
        assert_eq!(rolled_back.previous, Some(new));
        assert_eq!(rolled_back.generation, 3);
        assert_eq!(store.load_pointer().unwrap().unwrap(), rolled_back);
    }

    #[test]
    fn reactivating_identical_verified_receipt_is_idempotent() {
        let (_temp, store, active) = seeded_store();
        let duplicate_candidate = candidate(&store, "duplicate-candidate", &active);
        let pointer = store
            .activate(&duplicate_candidate, active.clone(), ActivationFault::None)
            .unwrap();
        assert_eq!(pointer.generation, 1);
        assert_eq!(pointer.active, active);
        assert!(pointer.previous.is_none());
        assert!(!duplicate_candidate.exists());
    }

    #[test]
    fn revalidating_same_signed_runtime_ignores_observation_timestamp() {
        let (_temp, store, active) = seeded_store();
        let mut reverified = active.clone();
        reverified.verified_at = "2026-07-11T01:00:00Z".to_string();
        let duplicate_candidate = candidate(&store, "reverified-candidate", &reverified);
        let pointer = store
            .activate(&duplicate_candidate, reverified, ActivationFault::None)
            .expect("same signed bits are idempotent");
        assert_eq!(pointer.generation, 1);
        assert_eq!(pointer.active, active);
        assert!(!duplicate_candidate.exists());
    }

    #[test]
    fn active_executable_digest_is_rechecked_on_every_load() {
        let (_temp, store, active) = seeded_store();
        let directory = store
            .paths()
            .version_path(&active.version_directory_name().unwrap())
            .unwrap();
        fs::write(
            directory.join(&active.executable_relative_path),
            b"mutated-after-activation",
        )
        .unwrap();
        assert_eq!(
            store.load_pointer(),
            Err(RuntimeActivationError::ReceiptMismatch)
        );
    }

    #[cfg(unix)]
    #[test]
    fn active_version_directory_cannot_be_replaced_by_a_symlink() {
        let (temp, store, active) = seeded_store();
        let directory = store
            .paths()
            .version_path(&active.version_directory_name().unwrap())
            .unwrap();
        let outside = temp.path().join("outside-runtime");
        fs::rename(&directory, &outside).unwrap();
        std::os::unix::fs::symlink(&outside, &directory).unwrap();

        assert_eq!(
            store.load_pointer(),
            Err(RuntimeActivationError::ReceiptMismatch)
        );
    }

    #[test]
    fn candidate_mutated_after_identity_verification_is_rejected_before_publish() {
        let temp = tempfile::tempdir().unwrap();
        let paths = RuntimePaths::under(temp.path().join("runtime")).unwrap();
        let store = ActivationStore::new(paths);
        let runtime = receipt("150.0.1", 1, 44);
        let candidate = candidate(&store, "mutated-candidate", &runtime);
        fs::write(
            candidate.join(&runtime.executable_relative_path),
            b"changed-after-verification",
        )
        .unwrap();
        assert_eq!(
            store.activate(&candidate, runtime, ActivationFault::None),
            Err(RuntimeActivationError::InvalidCandidate)
        );
        assert!(store.load_pointer().unwrap().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn candidate_executable_cannot_escape_through_parent_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let paths = RuntimePaths::under(temp.path().join("runtime")).unwrap();
        let store = ActivationStore::new(paths);
        let runtime = receipt("150.0.1", 2, 42);
        let candidate = store.paths().create_candidate("symlink-candidate").unwrap();
        let outside = temp.path().join("outside-app");
        let outside_executable = outside.join("Contents/MacOS/Browser");
        fs::create_dir_all(outside_executable.parent().unwrap()).unwrap();
        fs::write(&outside_executable, b"not-contained").unwrap();
        std::os::unix::fs::symlink(&outside, candidate.join("Browser.app")).unwrap();

        assert_eq!(
            store.activate(&candidate, runtime, ActivationFault::None),
            Err(RuntimeActivationError::InvalidCandidate)
        );
        assert!(store.load_pointer().unwrap().is_none());
    }

    #[test]
    fn corrupt_or_missing_receipt_never_loads_as_active() {
        let (_temp, store, active) = seeded_store();
        let directory = store
            .paths()
            .version_path(&active.version_directory_name().unwrap())
            .unwrap();
        fs::write(directory.join(RECEIPT_FILE_NAME), b"not-json").unwrap();
        assert!(matches!(
            store.load_pointer(),
            Err(RuntimeActivationError::ReceiptMismatch)
        ));
    }
}

#[cfg(test)]
#[path = "activation_repair_tests.rs"]
mod repair_tests;
