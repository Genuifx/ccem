use fs2::FileExt;
use rand::{rngs::OsRng, RngCore};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimePathError {
    InvalidRoot,
    InvalidName,
    SymlinkRejected,
    AlreadyExists,
    LockUnavailable,
    Io,
}

impl fmt::Display for RuntimePathError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidRoot => "Browser runtime root is invalid.",
            Self::InvalidName => "Browser runtime path name is invalid.",
            Self::SymlinkRejected => "Browser runtime path cannot be a symlink.",
            Self::AlreadyExists => "Browser runtime path already exists.",
            Self::LockUnavailable => "Browser runtime mutation lock is unavailable.",
            Self::Io => "Browser runtime filesystem operation failed.",
        })
    }
}

impl std::error::Error for RuntimePathError {}

#[derive(Debug, Clone)]
pub struct RuntimePaths {
    pub root: PathBuf,
    pub downloads: PathBuf,
    pub candidates: PathBuf,
    pub versions: PathBuf,
    pub leases: PathBuf,
    pub active_pointer: PathBuf,
    pub lock_file: PathBuf,
    pub operation_lock_file: PathBuf,
}

impl RuntimePaths {
    pub fn under(root: PathBuf) -> Result<Self, RuntimePathError> {
        if root.as_os_str().is_empty() || !root.is_absolute() {
            return Err(RuntimePathError::InvalidRoot);
        }
        Ok(Self {
            downloads: root.join("downloads"),
            candidates: root.join("candidates"),
            versions: root.join("versions"),
            leases: root.join("leases"),
            active_pointer: root.join("active.json"),
            lock_file: root.join("runtime.lock"),
            operation_lock_file: root.join("runtime-operation.lock"),
            root,
        })
    }

    pub fn prepare_private(&self) -> Result<(), RuntimePathError> {
        ensure_private_directory(&self.root)?;
        for directory in [
            &self.downloads,
            &self.candidates,
            &self.versions,
            &self.leases,
        ] {
            ensure_direct_child(&self.root, directory)?;
            ensure_private_directory(directory)?;
        }
        Ok(())
    }

    pub fn acquire_exclusive(&self) -> Result<RuntimeLockGuard, RuntimePathError> {
        self.prepare_private()?;
        acquire_exclusive_file_lock(&self.lock_file)
    }

    pub fn acquire_operation_exclusive(&self) -> Result<RuntimeLockGuard, RuntimePathError> {
        self.prepare_private()?;
        acquire_exclusive_file_lock(&self.operation_lock_file)
    }

    pub fn create_candidate(&self, candidate_id: &str) -> Result<PathBuf, RuntimePathError> {
        self.prepare_private()?;
        validate_opaque_name(candidate_id)?;
        let candidate = self.candidates.join(candidate_id);
        ensure_direct_child(&self.candidates, &candidate)?;
        match fs::create_dir(&candidate) {
            Ok(()) => {
                set_private_directory_permissions(&candidate)?;
                Ok(candidate)
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                Err(RuntimePathError::AlreadyExists)
            }
            Err(_) => Err(RuntimePathError::Io),
        }
    }

    pub fn version_path(&self, directory_name: &str) -> Result<PathBuf, RuntimePathError> {
        validate_opaque_name(directory_name)?;
        let path = self.versions.join(directory_name);
        ensure_direct_child(&self.versions, &path)?;
        Ok(path)
    }

    pub fn version_lease_path(&self, directory_name: &str) -> Result<PathBuf, RuntimePathError> {
        validate_opaque_name(directory_name)?;
        let path = self.leases.join(format!("{directory_name}.lock"));
        ensure_direct_child(&self.leases, &path)?;
        Ok(path)
    }
}

fn acquire_exclusive_file_lock(path: &Path) -> Result<RuntimeLockGuard, RuntimePathError> {
    reject_symlink_if_present(path)?;
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(|_| RuntimePathError::Io)?;
    set_private_file_permissions(path)?;
    file.try_lock_exclusive()
        .map_err(|_| RuntimePathError::LockUnavailable)?;
    Ok(RuntimeLockGuard { file })
}

pub struct RuntimeLockGuard {
    file: File,
}

impl Drop for RuntimeLockGuard {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

pub(super) fn write_private_atomic(target: &Path, bytes: &[u8]) -> Result<(), RuntimePathError> {
    let parent = target.parent().ok_or(RuntimePathError::InvalidRoot)?;
    reject_symlink_if_present(target)?;
    ensure_private_directory(parent)?;
    let mut nonce = [0_u8; 8];
    OsRng.fill_bytes(&mut nonce);
    let temp = parent.join(format!(
        ".{}.{}.{}.tmp",
        target
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("runtime-state"),
        std::process::id(),
        hex::encode(nonce)
    ));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&temp).map_err(|_| RuntimePathError::Io)?;
        file.write_all(bytes).map_err(|_| RuntimePathError::Io)?;
        file.sync_all().map_err(|_| RuntimePathError::Io)?;
        drop(file);
        atomic_replace(&temp, target)?;
        set_private_file_permissions(target)?;
        sync_directory(parent)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

pub(super) fn sync_directory(path: &Path) -> Result<(), RuntimePathError> {
    #[cfg(unix)]
    {
        File::open(path)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| RuntimePathError::Io)?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn ensure_private_directory(path: &Path) -> Result<(), RuntimePathError> {
    reject_symlink_if_present(path)?;
    fs::create_dir_all(path).map_err(|_| RuntimePathError::Io)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| RuntimePathError::Io)?;
    if !metadata.file_type().is_dir() {
        return Err(RuntimePathError::InvalidRoot);
    }
    set_private_directory_permissions(path)
}

fn reject_symlink_if_present(path: &Path) -> Result<(), RuntimePathError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(RuntimePathError::SymlinkRejected),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(RuntimePathError::Io),
    }
}

fn ensure_direct_child(parent: &Path, child: &Path) -> Result<(), RuntimePathError> {
    if child.parent() != Some(parent) {
        return Err(RuntimePathError::InvalidRoot);
    }
    Ok(())
}

fn validate_opaque_name(value: &str) -> Result<(), RuntimePathError> {
    if value.is_empty()
        || value.len() > 128
        || value == "."
        || value == ".."
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(RuntimePathError::InvalidName);
    }
    Ok(())
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> Result<(), RuntimePathError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| RuntimePathError::Io)
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> Result<(), RuntimePathError> {
    // Windows inherits the current user's protected profile/app-data ACL. The caller supplies that
    // app-owned root; unlike Unix there is no portable mode bit to widen accidentally here.
    Ok(())
}

#[cfg(unix)]
pub(super) fn set_private_file_permissions(path: &Path) -> Result<(), RuntimePathError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|_| RuntimePathError::Io)
}

#[cfg(not(unix))]
pub(super) fn set_private_file_permissions(_path: &Path) -> Result<(), RuntimePathError> {
    Ok(())
}

#[cfg(unix)]
fn atomic_replace(source: &Path, target: &Path) -> Result<(), RuntimePathError> {
    fs::rename(source, target).map_err(|_| RuntimePathError::Io)
}

#[cfg(windows)]
fn atomic_replace(source: &Path, target: &Path) -> Result<(), RuntimePathError> {
    use std::os::windows::ffi::OsStrExt;
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
    // SAFETY: both paths are owned, NUL-terminated UTF-16 buffers valid for the duration of call.
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(RuntimePathError::Io)
    } else {
        Ok(())
    }
}

#[cfg(all(not(unix), not(windows)))]
fn atomic_replace(source: &Path, target: &Path) -> Result<(), RuntimePathError> {
    fs::rename(source, target).map_err(|_| RuntimePathError::Io)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_paths_are_private_and_reject_symlink_roots() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("runtime");
        let paths = RuntimePaths::under(root.clone()).unwrap();
        paths.prepare_private().unwrap();
        assert!(paths.downloads.is_dir());
        assert!(paths.candidates.is_dir());
        assert!(paths.versions.is_dir());
        assert!(paths.leases.is_dir());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&root).unwrap().permissions().mode() & 0o777,
                0o700
            );
            let link_root = temp.path().join("linked-runtime");
            std::os::unix::fs::symlink(&root, &link_root).unwrap();
            let linked = RuntimePaths::under(link_root).unwrap();
            assert_eq!(
                linked.prepare_private(),
                Err(RuntimePathError::SymlinkRejected)
            );
        }
    }

    #[test]
    fn exclusive_lock_allows_only_one_mutator() {
        let temp = tempfile::tempdir().unwrap();
        let paths = RuntimePaths::under(temp.path().join("runtime")).unwrap();
        let first = paths.acquire_exclusive().unwrap();
        assert!(matches!(
            paths.acquire_exclusive(),
            Err(RuntimePathError::LockUnavailable)
        ));
        drop(first);
        assert!(paths.acquire_exclusive().is_ok());
    }

    #[test]
    fn candidate_names_cannot_escape_runtime_root() {
        let temp = tempfile::tempdir().unwrap();
        let paths = RuntimePaths::under(temp.path().join("runtime")).unwrap();
        assert_eq!(
            paths.create_candidate("../escape"),
            Err(RuntimePathError::InvalidName)
        );
        let candidate = paths.create_candidate("candidate-01").unwrap();
        assert_eq!(candidate.parent(), Some(paths.candidates.as_path()));
    }

    #[test]
    fn atomic_writer_replaces_complete_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("active.json");
        write_private_atomic(&target, b"old").unwrap();
        write_private_atomic(&target, b"new-complete-state").unwrap();
        assert_eq!(fs::read(target).unwrap(), b"new-complete-state");
    }
}
