use super::model::{
    is_sha256, validate_identifier, OwnershipDomain, RuntimeMetadata, SupervisorError,
    TransportKind, MAX_METADATA_BYTES, SUPERVISOR_SCHEMA_VERSION,
};
use rand::{rngs::OsRng, RngCore};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::fs::File;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

#[derive(Debug, Clone)]
pub(super) struct MetadataStore {
    root: PathBuf,
}

impl MetadataStore {
    pub(super) fn new(root: PathBuf) -> Result<Self, SupervisorError> {
        if root.as_os_str().is_empty() || !root.is_absolute() {
            return Err(SupervisorError::InvalidRoot);
        }
        ensure_private_directory(&root)?;
        Ok(Self { root })
    }

    pub(super) fn write_new(&self, metadata: &RuntimeMetadata) -> Result<(), SupervisorError> {
        validate_metadata(metadata)?;
        if metadata.revision != 1 {
            return Err(SupervisorError::MetadataCorrupt);
        }
        let target = self.path_for(&metadata.runtime_id)?;
        if target.exists() {
            return Err(SupervisorError::MetadataConflict);
        }
        self.write_atomic(&target, metadata, false)
    }

    pub(super) fn update(&self, metadata: &RuntimeMetadata) -> Result<(), SupervisorError> {
        validate_metadata(metadata)?;
        let current = self
            .load(&metadata.runtime_id)?
            .ok_or(SupervisorError::MetadataConflict)?;
        if metadata.revision != current.revision.saturating_add(1) {
            return Err(SupervisorError::MetadataConflict);
        }
        self.write_atomic(&self.path_for(&metadata.runtime_id)?, metadata, true)
    }

    pub(super) fn load(
        &self,
        runtime_id: &str,
    ) -> Result<Option<RuntimeMetadata>, SupervisorError> {
        let path = self.path_for(runtime_id)?;
        let file_metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(SupervisorError::Io("inspect runtime metadata".to_string())),
        };
        if !file_metadata.file_type().is_file()
            || file_metadata.file_type().is_symlink()
            || file_metadata.len() > MAX_METADATA_BYTES
        {
            return Err(SupervisorError::UnsafeMetadata);
        }
        let bytes = fs::read(&path)
            .map_err(|_| SupervisorError::Io("read runtime metadata".to_string()))?;
        let metadata: RuntimeMetadata =
            serde_json::from_slice(&bytes).map_err(|_| SupervisorError::MetadataCorrupt)?;
        validate_metadata(&metadata)?;
        if metadata.runtime_id != runtime_id {
            return Err(SupervisorError::MetadataCorrupt);
        }
        Ok(Some(metadata))
    }

    pub(super) fn list(&self) -> Result<Vec<RuntimeMetadata>, SupervisorError> {
        let mut entries = fs::read_dir(&self.root)
            .map_err(|_| SupervisorError::Io("list runtime metadata".to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| SupervisorError::Io("list runtime metadata".to_string()))?;
        entries.sort_by_key(|entry| entry.file_name());
        let mut result = Vec::new();
        for entry in entries {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            let Some(runtime_id) = name.strip_suffix(".json") else {
                continue;
            };
            if !runtime_id.starts_with("runtime-") {
                continue;
            }
            if let Some(metadata) = self.load(runtime_id)? {
                result.push(metadata);
            }
        }
        Ok(result)
    }

    pub(super) fn remove(&self, runtime_id: &str) -> Result<(), SupervisorError> {
        let path = self.path_for(runtime_id)?;
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err(SupervisorError::Io("inspect runtime metadata".to_string())),
        };
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err(SupervisorError::UnsafeMetadata);
        }
        fs::remove_file(path)
            .map_err(|_| SupervisorError::Io("remove runtime metadata".to_string()))?;
        sync_directory(&self.root)
    }

    #[cfg(test)]
    pub(super) fn path_for_test(&self, runtime_id: &str) -> PathBuf {
        self.path_for(runtime_id).unwrap()
    }

    fn path_for(&self, runtime_id: &str) -> Result<PathBuf, SupervisorError> {
        validate_identifier(runtime_id, "runtime id")?;
        if !runtime_id.starts_with("runtime-") {
            return Err(SupervisorError::InvalidIdentifier("runtime id"));
        }
        Ok(self.root.join(format!("{runtime_id}.json")))
    }

    fn write_atomic(
        &self,
        target: &Path,
        metadata: &RuntimeMetadata,
        replace: bool,
    ) -> Result<(), SupervisorError> {
        let bytes =
            serde_json::to_vec_pretty(metadata).map_err(|_| SupervisorError::MetadataCorrupt)?;
        if bytes.len() as u64 > MAX_METADATA_BYTES {
            return Err(SupervisorError::MetadataCorrupt);
        }
        reject_symlink_if_present(target)?;
        let mut nonce = [0_u8; 8];
        OsRng.fill_bytes(&mut nonce);
        let temporary = self.root.join(format!(
            ".runtime.{}.{}.tmp",
            std::process::id(),
            hex::encode(nonce)
        ));
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        let result = (|| {
            let mut file = options
                .open(&temporary)
                .map_err(|_| SupervisorError::Io("create runtime metadata".to_string()))?;
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|_| SupervisorError::Io("persist runtime metadata".to_string()))?;
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

fn validate_metadata(metadata: &RuntimeMetadata) -> Result<(), SupervisorError> {
    if metadata.schema_version != SUPERVISOR_SCHEMA_VERSION
        || metadata.revision == 0
        || metadata.controller.pid == 0
        || metadata.browser.pid == 0
        || !metadata.controller.executable.is_absolute()
        || !metadata.browser.executable.is_absolute()
        || !metadata.user_data_dir.is_absolute()
        || !is_sha256(&metadata.executable_sha256)
        || !is_sha256(&metadata.manifest_sha256)
        || chrono::DateTime::parse_from_rfc3339(&metadata.created_at).is_err()
        || chrono::DateTime::parse_from_rfc3339(&metadata.updated_at).is_err()
    {
        return Err(SupervisorError::MetadataCorrupt);
    }
    for (value, field) in [
        (&metadata.runtime_id, "runtime id"),
        (&metadata.ownership_id, "ownership id"),
        (&metadata.controller_instance_id, "controller instance id"),
        (&metadata.controller.birth_token, "controller birth token"),
        (&metadata.browser.birth_token, "browser birth token"),
        (&metadata.runtime_version, "runtime version"),
        (&metadata.protocol_version, "protocol version"),
        (&metadata.profile_id, "profile id"),
        (&metadata.workspace_identity, "workspace identity"),
    ] {
        validate_identifier(value, field)?;
    }
    if !metadata.runtime_id.starts_with("runtime-")
        || !metadata.ownership_id.starts_with("ownership-")
        || !metadata.controller_instance_id.starts_with("controller-")
    {
        return Err(SupervisorError::MetadataCorrupt);
    }
    match (&metadata.ownership_domain, metadata.transport) {
        (OwnershipDomain::UnixProcessGroup { pgid }, TransportKind::UnixPrivateFd3Fd4)
            if *pgid > 0 && *pgid as u32 == metadata.browser.pid => {}
        (OwnershipDomain::WindowsJob { name }, TransportKind::WindowsPrivateHandleList) => {
            validate_identifier(name, "Windows Job name")?;
            if !name.starts_with("CCEM.LoginBrowser.") {
                return Err(SupervisorError::MetadataCorrupt);
            }
        }
        _ => return Err(SupervisorError::MetadataCorrupt),
    }
    Ok(())
}

fn ensure_private_directory(path: &Path) -> Result<(), SupervisorError> {
    reject_symlink_if_present(path)?;
    fs::create_dir_all(path)
        .map_err(|_| SupervisorError::Io("create supervisor root".to_string()))?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| SupervisorError::Io("inspect supervisor root".to_string()))?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err(SupervisorError::InvalidRoot);
    }
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|_| SupervisorError::Io("protect supervisor root".to_string()))?;
    Ok(())
}

fn reject_symlink_if_present(path: &Path) -> Result<(), SupervisorError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(SupervisorError::UnsafeMetadata),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(SupervisorError::Io("inspect metadata path".to_string())),
    }
}

#[cfg(unix)]
fn atomic_publish(source: &Path, target: &Path, replace: bool) -> Result<(), SupervisorError> {
    if !replace {
        // A same-directory hard link is an atomic create-if-absent publication. Unlike an
        // exists-then-rename sequence, a competing writer cannot cause write_new to clobber a
        // committed runtime record between the check and publication.
        fs::hard_link(source, target).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                SupervisorError::MetadataConflict
            } else {
                SupervisorError::Io("publish runtime metadata".to_string())
            }
        })?;
        fs::remove_file(source)
            .map_err(|_| SupervisorError::Io("finish runtime metadata publish".to_string()))?;
        return Ok(());
    }
    fs::rename(source, target)
        .map_err(|_| SupervisorError::Io("publish runtime metadata".to_string()))
}

#[cfg(windows)]
fn atomic_publish(source: &Path, target: &Path, replace: bool) -> Result<(), SupervisorError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    if !replace && target.exists() {
        return Err(SupervisorError::MetadataConflict);
    }
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
        return Err(SupervisorError::Io("publish runtime metadata".to_string()));
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn atomic_publish(source: &Path, target: &Path, replace: bool) -> Result<(), SupervisorError> {
    if !replace && target.exists() {
        return Err(SupervisorError::MetadataConflict);
    }
    fs::rename(source, target)
        .map_err(|_| SupervisorError::Io("publish runtime metadata".to_string()))
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) -> Result<(), SupervisorError> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|_| SupervisorError::Io("protect runtime metadata".to_string()))
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) -> Result<(), SupervisorError> {
    // The app-owned LocalAppData root supplies the current-user ACL on Windows.
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), SupervisorError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| SupervisorError::Io("sync supervisor root".to_string()))
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), SupervisorError> {
    Ok(())
}
