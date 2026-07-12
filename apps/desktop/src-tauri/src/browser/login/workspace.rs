use super::profile::TrustedWorkspaceIdentity;
use chrono::Utc;
use fs2::FileExt;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

const WORKSPACE_REGISTRY_SCHEMA_VERSION: u32 = 1;
const WORKSPACE_ID_PREFIX: &str = "workspace-";
const MAX_REGISTRY_BYTES: u64 = 2 * 1024 * 1024;
const MAX_WORKSPACES: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceIdentityRecord {
    workspace_id: String,
    canonical_path_sha256: String,
    created_at: String,
    last_seen_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceIdentityRegistry {
    schema_version: u32,
    records: Vec<WorkspaceIdentityRecord>,
}

impl Default for WorkspaceIdentityRegistry {
    fn default() -> Self {
        Self {
            schema_version: WORKSPACE_REGISTRY_SCHEMA_VERSION,
            records: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum WorkspaceIdentityError {
    InvalidRoot,
    WorkspaceUnavailable,
    UnsafePath,
    RegistryCorrupt,
    RegistryFull,
    LockUnavailable,
    Io,
}

impl fmt::Display for WorkspaceIdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidRoot => "Login Browser workspace identity root is invalid.",
            Self::WorkspaceUnavailable => "Workspace directory is unavailable.",
            Self::UnsafePath => "Workspace identity storage path is unsafe.",
            Self::RegistryCorrupt => "Workspace identity registry is corrupt.",
            Self::RegistryFull => "Workspace identity registry reached its safety limit.",
            Self::LockUnavailable => "Workspace identity registry is busy.",
            Self::Io => "Workspace identity registry could not be updated.",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for WorkspaceIdentityError {}

#[derive(Debug, Clone)]
pub(crate) struct WorkspaceIdentityStore {
    root: PathBuf,
    registry_path: PathBuf,
    lock_path: PathBuf,
}

impl WorkspaceIdentityStore {
    pub(crate) fn new(root: PathBuf) -> Result<Self, WorkspaceIdentityError> {
        if !root.is_absolute() || root.as_os_str().is_empty() {
            return Err(WorkspaceIdentityError::InvalidRoot);
        }
        ensure_private_directory(&root)?;
        Ok(Self {
            registry_path: root.join("workspaces.json"),
            lock_path: root.join("workspaces.lock"),
            root,
        })
    }

    pub(crate) fn resolve(
        &self,
        trusted_workspace_path: &Path,
    ) -> Result<TrustedWorkspaceIdentity, WorkspaceIdentityError> {
        let canonical = trusted_workspace_path
            .canonicalize()
            .map_err(|_| WorkspaceIdentityError::WorkspaceUnavailable)?;
        let metadata =
            fs::metadata(&canonical).map_err(|_| WorkspaceIdentityError::WorkspaceUnavailable)?;
        if !metadata.is_dir() {
            return Err(WorkspaceIdentityError::WorkspaceUnavailable);
        }
        let path_sha256 = canonical_path_sha256(&canonical);
        let lock = self.acquire_lock()?;
        let mut registry = self.load_registry()?;
        let now = Utc::now().to_rfc3339();
        let workspace_id = if let Some(existing) = registry
            .records
            .iter_mut()
            .find(|record| record.canonical_path_sha256 == path_sha256)
        {
            existing.last_seen_at = now;
            existing.workspace_id.clone()
        } else {
            if registry.records.len() >= MAX_WORKSPACES {
                return Err(WorkspaceIdentityError::RegistryFull);
            }
            let workspace_id = random_workspace_id();
            registry.records.push(WorkspaceIdentityRecord {
                workspace_id: workspace_id.clone(),
                canonical_path_sha256: path_sha256,
                created_at: now.clone(),
                last_seen_at: now,
            });
            workspace_id
        };
        self.write_registry(&registry)?;
        drop(lock);
        TrustedWorkspaceIdentity::from_trusted_store(workspace_id)
            .map_err(|_| WorkspaceIdentityError::RegistryCorrupt)
    }

    fn acquire_lock(&self) -> Result<WorkspaceIdentityLock, WorkspaceIdentityError> {
        reject_symlink_if_present(&self.lock_path)?;
        let mut options = OpenOptions::new();
        options.create(true).read(true).write(true).truncate(false);
        #[cfg(unix)]
        {
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let file = options
            .open(&self.lock_path)
            .map_err(|_| WorkspaceIdentityError::Io)?;
        set_private_file_permissions(&self.lock_path)?;
        file.try_lock_exclusive()
            .map_err(|_| WorkspaceIdentityError::LockUnavailable)?;
        Ok(WorkspaceIdentityLock(file))
    }

    fn load_registry(&self) -> Result<WorkspaceIdentityRegistry, WorkspaceIdentityError> {
        let metadata = match fs::symlink_metadata(&self.registry_path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(WorkspaceIdentityRegistry::default())
            }
            Err(_) => return Err(WorkspaceIdentityError::Io),
        };
        if !metadata.file_type().is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() > MAX_REGISTRY_BYTES
        {
            return Err(WorkspaceIdentityError::RegistryCorrupt);
        }
        let bytes = fs::read(&self.registry_path).map_err(|_| WorkspaceIdentityError::Io)?;
        let registry: WorkspaceIdentityRegistry =
            serde_json::from_slice(&bytes).map_err(|_| WorkspaceIdentityError::RegistryCorrupt)?;
        validate_registry(&registry)?;
        Ok(registry)
    }

    fn write_registry(
        &self,
        registry: &WorkspaceIdentityRegistry,
    ) -> Result<(), WorkspaceIdentityError> {
        validate_registry(registry)?;
        let bytes = serde_json::to_vec_pretty(registry)
            .map_err(|_| WorkspaceIdentityError::RegistryCorrupt)?;
        if bytes.len() as u64 > MAX_REGISTRY_BYTES {
            return Err(WorkspaceIdentityError::RegistryFull);
        }
        let mut nonce = [0_u8; 8];
        OsRng.fill_bytes(&mut nonce);
        let temporary = self.root.join(format!(
            ".workspaces.{}.{}.tmp",
            std::process::id(),
            hex::encode(nonce)
        ));
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let result = (|| {
            let mut file = options
                .open(&temporary)
                .map_err(|_| WorkspaceIdentityError::Io)?;
            file.write_all(&bytes)
                .map_err(|_| WorkspaceIdentityError::Io)?;
            file.sync_all().map_err(|_| WorkspaceIdentityError::Io)?;
            drop(file);
            atomic_replace(&temporary, &self.registry_path)?;
            set_private_file_permissions(&self.registry_path)?;
            sync_directory(&self.root)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

struct WorkspaceIdentityLock(File);

impl Drop for WorkspaceIdentityLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

fn validate_registry(registry: &WorkspaceIdentityRegistry) -> Result<(), WorkspaceIdentityError> {
    if registry.schema_version != WORKSPACE_REGISTRY_SCHEMA_VERSION
        || registry.records.len() > MAX_WORKSPACES
    {
        return Err(WorkspaceIdentityError::RegistryCorrupt);
    }
    let mut ids = std::collections::HashSet::new();
    let mut paths = std::collections::HashSet::new();
    for record in &registry.records {
        TrustedWorkspaceIdentity::from_trusted_store(record.workspace_id.clone())
            .map_err(|_| WorkspaceIdentityError::RegistryCorrupt)?;
        if !record.workspace_id.starts_with(WORKSPACE_ID_PREFIX)
            || !is_sha256(&record.canonical_path_sha256)
            || record.created_at.is_empty()
            || record.last_seen_at.is_empty()
            || !ids.insert(&record.workspace_id)
            || !paths.insert(&record.canonical_path_sha256)
        {
            return Err(WorkspaceIdentityError::RegistryCorrupt);
        }
    }
    Ok(())
}

fn random_workspace_id() -> String {
    let mut bytes = [0_u8; 16];
    OsRng.fill_bytes(&mut bytes);
    format!("{WORKSPACE_ID_PREFIX}{}", hex::encode(bytes))
}

#[cfg(unix)]
fn canonical_path_sha256(path: &Path) -> String {
    hex::encode(Sha256::digest(path.as_os_str().as_bytes()))
}

#[cfg(windows)]
fn canonical_path_sha256(path: &Path) -> String {
    let bytes = path
        .as_os_str()
        .encode_wide()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    hex::encode(Sha256::digest(bytes))
}

#[cfg(all(not(unix), not(windows)))]
fn canonical_path_sha256(path: &Path) -> String {
    hex::encode(Sha256::digest(path.to_string_lossy().as_bytes()))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn ensure_private_directory(path: &Path) -> Result<(), WorkspaceIdentityError> {
    reject_symlink_if_present(path)?;
    fs::create_dir_all(path).map_err(|_| WorkspaceIdentityError::Io)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| WorkspaceIdentityError::Io)?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err(WorkspaceIdentityError::UnsafePath);
    }
    set_private_directory_permissions(path)
}

fn reject_symlink_if_present(path: &Path) -> Result<(), WorkspaceIdentityError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(WorkspaceIdentityError::UnsafePath)
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(WorkspaceIdentityError::Io),
    }
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> Result<(), WorkspaceIdentityError> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|_| WorkspaceIdentityError::Io)
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> Result<(), WorkspaceIdentityError> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) -> Result<(), WorkspaceIdentityError> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|_| WorkspaceIdentityError::Io)
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) -> Result<(), WorkspaceIdentityError> {
    Ok(())
}

#[cfg(unix)]
fn atomic_replace(source: &Path, target: &Path) -> Result<(), WorkspaceIdentityError> {
    fs::rename(source, target).map_err(|_| WorkspaceIdentityError::Io)
}

#[cfg(windows)]
fn atomic_replace(source: &Path, target: &Path) -> Result<(), WorkspaceIdentityError> {
    use std::os::windows::ffi::OsStrExt as _;
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
    // SAFETY: both buffers are valid, NUL-terminated UTF-16 for the duration of the call.
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(WorkspaceIdentityError::Io)
    } else {
        Ok(())
    }
}

#[cfg(all(not(unix), not(windows)))]
fn atomic_replace(source: &Path, target: &Path) -> Result<(), WorkspaceIdentityError> {
    fs::rename(source, target).map_err(|_| WorkspaceIdentityError::Io)
}

fn sync_directory(path: &Path) -> Result<(), WorkspaceIdentityError> {
    #[cfg(unix)]
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| WorkspaceIdentityError::Io)?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_canonical_workspace_reuses_app_owned_identity() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let store = WorkspaceIdentityStore::new(temp.path().join("identity")).unwrap();
        let first = store.resolve(&workspace).unwrap();
        let second = store.resolve(&workspace).unwrap();
        assert_eq!(first, second);
        assert!(first.as_str().starts_with(WORKSPACE_ID_PREFIX));

        #[cfg(unix)]
        {
            let alias = temp.path().join("workspace-alias");
            std::os::unix::fs::symlink(&workspace, &alias).unwrap();
            assert_eq!(store.resolve(&alias).unwrap(), first);
        }
    }

    #[test]
    fn distinct_workspaces_do_not_share_identity() {
        let temp = tempfile::tempdir().unwrap();
        let left = temp.path().join("left");
        let right = temp.path().join("right");
        fs::create_dir(&left).unwrap();
        fs::create_dir(&right).unwrap();
        let store = WorkspaceIdentityStore::new(temp.path().join("identity")).unwrap();
        assert_ne!(
            store.resolve(&left).unwrap(),
            store.resolve(&right).unwrap()
        );
    }

    #[test]
    fn corrupt_registry_fails_closed_instead_of_rebinding() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let root = temp.path().join("identity");
        let store = WorkspaceIdentityStore::new(root.clone()).unwrap();
        fs::write(root.join("workspaces.json"), b"not-json").unwrap();
        assert_eq!(
            store.resolve(&workspace),
            Err(WorkspaceIdentityError::RegistryCorrupt)
        );
    }

    #[test]
    fn registry_and_lock_are_private_on_unix() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let root = temp.path().join("identity");
        let store = WorkspaceIdentityStore::new(root.clone()).unwrap();
        store.resolve(&workspace).unwrap();
        #[cfg(unix)]
        {
            assert_eq!(
                fs::metadata(root.join("workspaces.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(root.join("workspaces.lock"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
}
