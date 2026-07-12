use super::activation::{acquire_version_exclusive_lease, RuntimeActivationError};
use super::paths::{sync_directory, RuntimePathError, RuntimePaths};
use chrono::Utc;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_SCAN_ENTRIES: u64 = 200_000;
const MAX_SCAN_DEPTH: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct RuntimeDiskUsage {
    pub(crate) downloads_bytes: u64,
    pub(crate) candidates_bytes: u64,
    pub(crate) versions_bytes: u64,
    pub(crate) state_bytes: u64,
    pub(crate) other_bytes: u64,
    pub(crate) total_bytes: u64,
    pub(crate) retained_versions: u64,
    pub(crate) calculated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct RuntimeDeleteOutcome {
    pub(crate) reclaimed_bytes: u64,
    pub(crate) remaining_bytes: u64,
    pub(crate) deleted_versions: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RuntimeMaintenanceError {
    RuntimeInUse,
    OperationInProgress,
    StateCorrupt,
    ScanLimitExceeded,
    Io,
}

#[derive(Debug, Clone)]
pub(crate) struct RuntimeMaintenanceStore {
    paths: RuntimePaths,
}

impl RuntimeMaintenanceStore {
    pub(crate) fn new(paths: RuntimePaths) -> Self {
        Self { paths }
    }

    pub(crate) fn disk_usage(&self) -> Result<RuntimeDiskUsage, RuntimeMaintenanceError> {
        let _operation = self
            .paths
            .acquire_operation_exclusive()
            .map_err(map_path_error)?;
        let _lock = self.paths.acquire_exclusive().map_err(map_path_error)?;
        self.disk_usage_unlocked()
    }

    /// Delete installed/downloaded runtime payloads while preserving the monotonic manifest
    /// watermark and lock/lease files. Every retained version is exclusively leased before the
    /// active pointer is removed, so a running browser session makes the operation fail without
    /// deleting a single payload byte.
    pub(crate) fn delete_runtime(&self) -> Result<RuntimeDeleteOutcome, RuntimeMaintenanceError> {
        let _operation = self
            .paths
            .acquire_operation_exclusive()
            .map_err(map_path_error)?;
        let _lock = self.paths.acquire_exclusive().map_err(map_path_error)?;
        let before = self.disk_usage_unlocked()?;
        let (version_leases, deleted_versions) = self.acquire_all_version_leases()?;

        remove_file_or_symlink_if_present(&self.paths.active_pointer)?;
        sync_directory(&self.paths.root).map_err(map_path_error)?;
        clear_directory(&self.paths.versions)?;
        clear_directory(&self.paths.candidates)?;
        clear_directory(&self.paths.downloads)?;
        sync_directory(&self.paths.versions).map_err(map_path_error)?;
        sync_directory(&self.paths.candidates).map_err(map_path_error)?;
        sync_directory(&self.paths.downloads).map_err(map_path_error)?;

        drop(version_leases);
        let after = self.disk_usage_unlocked()?;
        Ok(RuntimeDeleteOutcome {
            reclaimed_bytes: before.total_bytes.saturating_sub(after.total_bytes),
            remaining_bytes: after.total_bytes,
            deleted_versions,
        })
    }

    fn acquire_all_version_leases(
        &self,
    ) -> Result<(Vec<super::activation::RuntimeVersionLeaseGuard>, u64), RuntimeMaintenanceError>
    {
        let mut guards = Vec::new();
        let mut versions = 0_u64;
        for entry in fs::read_dir(&self.paths.versions).map_err(|_| RuntimeMaintenanceError::Io)? {
            let entry = entry.map_err(|_| RuntimeMaintenanceError::Io)?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| RuntimeMaintenanceError::StateCorrupt)?;
            let expected = self.paths.version_path(&name).map_err(map_path_error)?;
            if expected != entry.path() {
                return Err(RuntimeMaintenanceError::StateCorrupt);
            }
            let guard =
                acquire_version_exclusive_lease(&self.paths, &name).map_err(
                    |error| match error {
                        RuntimeActivationError::RuntimeInUse => {
                            RuntimeMaintenanceError::RuntimeInUse
                        }
                        RuntimeActivationError::Path(RuntimePathError::LockUnavailable) => {
                            RuntimeMaintenanceError::OperationInProgress
                        }
                        RuntimeActivationError::StateCorrupt
                        | RuntimeActivationError::ReceiptMismatch
                        | RuntimeActivationError::InvalidReceipt
                        | RuntimeActivationError::InvalidCandidate
                        | RuntimeActivationError::VersionConflict => {
                            RuntimeMaintenanceError::StateCorrupt
                        }
                        _ => RuntimeMaintenanceError::Io,
                    },
                )?;
            guards.push(guard);
            versions = versions
                .checked_add(1)
                .ok_or(RuntimeMaintenanceError::ScanLimitExceeded)?;
        }
        Ok((guards, versions))
    }

    fn disk_usage_unlocked(&self) -> Result<RuntimeDiskUsage, RuntimeMaintenanceError> {
        self.paths.prepare_private().map_err(map_path_error)?;
        let downloads = scan_tree(&self.paths.downloads)?;
        let candidates = scan_tree(&self.paths.candidates)?;
        let versions = scan_tree(&self.paths.versions)?;
        let leases = scan_tree(&self.paths.leases)?;
        let active_pointer = file_size_no_follow(&self.paths.active_pointer)?;
        let lock_file = file_size_no_follow(&self.paths.lock_file)?;
        let operation_lock = file_size_no_follow(&self.paths.operation_lock_file)?;
        let watermark = file_size_no_follow(&self.paths.root.join("manifest-sequence.json"))?;
        let known = [
            self.paths.downloads.clone(),
            self.paths.candidates.clone(),
            self.paths.versions.clone(),
            self.paths.leases.clone(),
            self.paths.active_pointer.clone(),
            self.paths.lock_file.clone(),
            self.paths.operation_lock_file.clone(),
            self.paths.root.join("manifest-sequence.json"),
        ];
        let other = scan_unknown_root_entries(&self.paths.root, &known)?;
        let state_bytes = checked_sum(&[
            leases.bytes,
            active_pointer,
            lock_file,
            operation_lock,
            watermark,
        ])?;
        let total_bytes = checked_sum(&[
            downloads.bytes,
            candidates.bytes,
            versions.bytes,
            state_bytes,
            other.bytes,
        ])?;
        Ok(RuntimeDiskUsage {
            downloads_bytes: downloads.bytes,
            candidates_bytes: candidates.bytes,
            versions_bytes: versions.bytes,
            state_bytes,
            other_bytes: other.bytes,
            total_bytes,
            retained_versions: count_version_directories(&self.paths.versions)?,
            calculated_at: Utc::now().to_rfc3339(),
        })
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct ScanUsage {
    bytes: u64,
    entries: u64,
}

fn scan_tree(path: &Path) -> Result<ScanUsage, RuntimeMaintenanceError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| RuntimeMaintenanceError::Io)?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
        return Err(RuntimeMaintenanceError::StateCorrupt);
    }
    let mut usage = ScanUsage::default();
    let mut pending = vec![(path.to_path_buf(), 0_usize)];
    while let Some((directory, depth)) = pending.pop() {
        if depth > MAX_SCAN_DEPTH {
            return Err(RuntimeMaintenanceError::ScanLimitExceeded);
        }
        for entry in fs::read_dir(directory).map_err(|_| RuntimeMaintenanceError::Io)? {
            let entry = entry.map_err(|_| RuntimeMaintenanceError::Io)?;
            usage.entries = usage
                .entries
                .checked_add(1)
                .ok_or(RuntimeMaintenanceError::ScanLimitExceeded)?;
            if usage.entries > MAX_SCAN_ENTRIES {
                return Err(RuntimeMaintenanceError::ScanLimitExceeded);
            }
            let metadata =
                fs::symlink_metadata(entry.path()).map_err(|_| RuntimeMaintenanceError::Io)?;
            if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() {
                pending.push((entry.path(), depth + 1));
            } else {
                usage.bytes = usage
                    .bytes
                    .checked_add(metadata.len())
                    .ok_or(RuntimeMaintenanceError::ScanLimitExceeded)?;
            }
        }
    }
    Ok(usage)
}

fn scan_unknown_root_entries(
    root: &Path,
    known: &[PathBuf],
) -> Result<ScanUsage, RuntimeMaintenanceError> {
    let mut usage = ScanUsage::default();
    for entry in fs::read_dir(root).map_err(|_| RuntimeMaintenanceError::Io)? {
        let entry = entry.map_err(|_| RuntimeMaintenanceError::Io)?;
        if known.iter().any(|path| path == &entry.path()) {
            continue;
        }
        let metadata =
            fs::symlink_metadata(entry.path()).map_err(|_| RuntimeMaintenanceError::Io)?;
        let nested = if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() {
            scan_tree(&entry.path())?
        } else {
            ScanUsage {
                bytes: metadata.len(),
                entries: 1,
            }
        };
        usage.bytes = usage
            .bytes
            .checked_add(nested.bytes)
            .ok_or(RuntimeMaintenanceError::ScanLimitExceeded)?;
        usage.entries = usage
            .entries
            .checked_add(nested.entries)
            .ok_or(RuntimeMaintenanceError::ScanLimitExceeded)?;
        if usage.entries > MAX_SCAN_ENTRIES {
            return Err(RuntimeMaintenanceError::ScanLimitExceeded);
        }
    }
    Ok(usage)
}

fn file_size_no_follow(path: &Path) -> Result<u64, RuntimeMaintenanceError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => Err(RuntimeMaintenanceError::StateCorrupt),
        Ok(metadata) => Ok(metadata.len()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(_) => Err(RuntimeMaintenanceError::Io),
    }
}

fn count_version_directories(path: &Path) -> Result<u64, RuntimeMaintenanceError> {
    let mut count = 0_u64;
    for entry in fs::read_dir(path).map_err(|_| RuntimeMaintenanceError::Io)? {
        let entry = entry.map_err(|_| RuntimeMaintenanceError::Io)?;
        let metadata =
            fs::symlink_metadata(entry.path()).map_err(|_| RuntimeMaintenanceError::Io)?;
        if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() {
            count = count
                .checked_add(1)
                .ok_or(RuntimeMaintenanceError::ScanLimitExceeded)?;
        }
    }
    Ok(count)
}

fn remove_file_or_symlink_if_present(path: &Path) -> Result<(), RuntimeMaintenanceError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => Err(RuntimeMaintenanceError::StateCorrupt),
        Ok(_) => fs::remove_file(path).map_err(|_| RuntimeMaintenanceError::Io),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(RuntimeMaintenanceError::Io),
    }
}

fn clear_directory(path: &Path) -> Result<(), RuntimeMaintenanceError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| RuntimeMaintenanceError::Io)?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
        return Err(RuntimeMaintenanceError::StateCorrupt);
    }
    for entry in fs::read_dir(path).map_err(|_| RuntimeMaintenanceError::Io)? {
        let entry = entry.map_err(|_| RuntimeMaintenanceError::Io)?;
        let metadata =
            fs::symlink_metadata(entry.path()).map_err(|_| RuntimeMaintenanceError::Io)?;
        if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() {
            fs::remove_dir_all(entry.path()).map_err(|_| RuntimeMaintenanceError::Io)?;
        } else {
            fs::remove_file(entry.path()).map_err(|_| RuntimeMaintenanceError::Io)?;
        }
    }
    Ok(())
}

fn checked_sum(values: &[u64]) -> Result<u64, RuntimeMaintenanceError> {
    values.iter().try_fold(0_u64, |total, value| {
        total
            .checked_add(*value)
            .ok_or(RuntimeMaintenanceError::ScanLimitExceeded)
    })
}

fn map_path_error(error: RuntimePathError) -> RuntimeMaintenanceError {
    match error {
        RuntimePathError::LockUnavailable => RuntimeMaintenanceError::OperationInProgress,
        RuntimePathError::InvalidRoot
        | RuntimePathError::InvalidName
        | RuntimePathError::SymlinkRejected => RuntimeMaintenanceError::StateCorrupt,
        RuntimePathError::AlreadyExists | RuntimePathError::Io => RuntimeMaintenanceError::Io,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::runtime::activation::{
        ActivationFault, ActivationStore, VerifiedRuntimeReceipt,
    };
    use crate::browser::runtime::manifest::{RuntimeArchitecture, RuntimePlatform};
    use crate::browser::runtime::paths::RuntimePaths;
    use sha2::{Digest, Sha256};
    use std::fs;

    fn seeded_runtime() -> (
        tempfile::TempDir,
        RuntimePaths,
        ActivationStore,
        VerifiedRuntimeReceipt,
    ) {
        let temp = tempfile::tempdir().unwrap();
        let paths = RuntimePaths::under(temp.path().join("runtime")).unwrap();
        let store = ActivationStore::new(paths.clone());
        let executable_bytes = b"verified-runtime-for-maintenance";
        let receipt = VerifiedRuntimeReceipt {
            schema_version: 1,
            version: "150.0.7871.115".to_string(),
            sequence: 1,
            signing_key_id: "fixture-runtime-key".to_string(),
            manifest_sha256: hex::encode(Sha256::digest(b"manifest")),
            archive_sha256: hex::encode(Sha256::digest(b"archive")),
            platform: RuntimePlatform::Macos,
            architecture: RuntimeArchitecture::Aarch64,
            executable_relative_path: "Browser.app/Contents/MacOS/Browser".to_string(),
            executable_sha256: hex::encode(Sha256::digest(executable_bytes)),
            verified_at: "2026-07-11T00:00:00Z".to_string(),
        };
        let candidate = paths.create_candidate("maintenance-fixture").unwrap();
        let executable = candidate.join(&receipt.executable_relative_path);
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        fs::write(executable, executable_bytes).unwrap();
        store
            .activate(&candidate, receipt.clone(), ActivationFault::None)
            .unwrap();
        (temp, paths, store, receipt)
    }

    #[test]
    fn disk_usage_is_bounded_to_the_managed_tree_and_does_not_follow_symlinks() {
        let (temp, paths, _activation, _receipt) = seeded_runtime();
        fs::write(paths.downloads.join("archive.zip"), vec![1_u8; 17]).unwrap();
        fs::write(paths.candidates.join("leftover.bin"), vec![2_u8; 23]).unwrap();
        let outside = temp.path().join("outside.bin");
        fs::write(&outside, vec![3_u8; 1024 * 1024]).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, paths.versions.join("outside-link")).unwrap();

        let usage = RuntimeMaintenanceStore::new(paths)
            .disk_usage()
            .expect("bounded managed-runtime usage");

        assert!(usage.downloads_bytes >= 17);
        assert!(usage.candidates_bytes >= 23);
        assert!(usage.versions_bytes > 0);
        assert!(usage.total_bytes < 1024 * 1024);
        assert_eq!(usage.retained_versions, 1);
    }

    #[test]
    fn delete_is_all_or_nothing_while_a_session_holds_the_active_runtime_lease() {
        let (_temp, paths, activation, _receipt) = seeded_runtime();
        fs::write(paths.downloads.join("archive.zip"), b"download").unwrap();
        fs::write(
            paths.root.join("manifest-sequence.json"),
            b"security-watermark",
        )
        .unwrap();
        let lease = activation
            .lease_active()
            .unwrap()
            .expect("active runtime lease");
        let maintenance = RuntimeMaintenanceStore::new(paths.clone());

        assert_eq!(
            maintenance.delete_runtime(),
            Err(RuntimeMaintenanceError::RuntimeInUse)
        );
        assert!(paths.active_pointer.exists());
        assert_eq!(fs::read_dir(&paths.versions).unwrap().count(), 1);

        drop(lease);
        let deleted = maintenance
            .delete_runtime()
            .expect("delete after session release");
        assert_eq!(deleted.deleted_versions, 1);
        assert!(deleted.reclaimed_bytes > 0);
        assert!(!paths.active_pointer.exists());
        assert_eq!(fs::read_dir(&paths.versions).unwrap().count(), 0);
        assert_eq!(fs::read_dir(&paths.downloads).unwrap().count(), 0);
        assert_eq!(fs::read_dir(&paths.candidates).unwrap().count(), 0);
        assert_eq!(
            fs::read(paths.root.join("manifest-sequence.json")).unwrap(),
            b"security-watermark"
        );
    }

    #[test]
    fn preparation_operation_lock_blocks_delete_before_any_payload_mutation() {
        let (_temp, paths, _activation, _receipt) = seeded_runtime();
        let operation = paths.acquire_operation_exclusive().unwrap();
        let maintenance = RuntimeMaintenanceStore::new(paths.clone());

        assert_eq!(
            maintenance.delete_runtime(),
            Err(RuntimeMaintenanceError::OperationInProgress)
        );
        assert!(paths.active_pointer.exists());
        assert_eq!(fs::read_dir(&paths.versions).unwrap().count(), 1);

        drop(operation);
        maintenance.delete_runtime().unwrap();
    }

    #[test]
    fn explicit_delete_recovers_even_when_the_active_pointer_is_corrupt() {
        let (_temp, paths, _activation, _receipt) = seeded_runtime();
        fs::write(&paths.active_pointer, b"{corrupt-pointer").unwrap();

        RuntimeMaintenanceStore::new(paths.clone())
            .delete_runtime()
            .expect("delete must not require trusting corrupt activation state");

        assert!(!paths.active_pointer.exists());
        assert_eq!(fs::read_dir(paths.versions).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn delete_unlinks_managed_tree_symlinks_without_following_external_targets() {
        let (temp, paths, _activation, _receipt) = seeded_runtime();
        let outside = temp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("keep.txt"), b"must survive runtime delete").unwrap();
        std::os::unix::fs::symlink(&outside, paths.candidates.join("external-link")).unwrap();

        RuntimeMaintenanceStore::new(paths)
            .delete_runtime()
            .expect("managed symlink itself is removable");

        assert_eq!(
            fs::read(outside.join("keep.txt")).unwrap(),
            b"must survive runtime delete"
        );
    }
}
