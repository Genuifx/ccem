use super::{
    random_opaque_id, validate_bounded_identifier, BrowserProfileDescriptor, ProfileCleanupState,
    ProfileError, ProfileId, TrustedWorkspaceIdentity, MAX_RUNTIME_ID_BYTES, METADATA_FILE_PREFIX,
    METADATA_FILE_SUFFIX, METADATA_REVISION_WIDTH, PROFILE_FORMAT_VERSION, PROFILE_SCHEMA_VERSION,
};
use chrono::DateTime;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

pub(super) fn load_current_descriptor(
    profile_dir: &Path,
    expected_profile_id: &ProfileId,
) -> Result<BrowserProfileDescriptor, ProfileError> {
    let mut generations = Vec::new();
    for entry in fs::read_dir(profile_dir)
        .map_err(|error| io_error("list browser profile metadata", error))?
    {
        let entry = entry.map_err(|error| io_error("inspect browser profile metadata", error))?;
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        if let Some(revision) = parse_metadata_revision(file_name) {
            let file_type = entry
                .file_type()
                .map_err(|error| io_error("inspect browser profile metadata type", error))?;
            if file_type.is_symlink() || !file_type.is_file() {
                return Err(ProfileError::UnsafePath(format!(
                    "metadata generation {file_name} is not a regular file"
                )));
            }
            generations.push((revision, entry.path()));
        }
    }
    generations.sort_by_key(|(revision, _)| *revision);
    let Some((revision, path)) = generations.pop() else {
        return Err(ProfileError::CorruptMetadata(
            "no committed descriptor generation exists".to_string(),
        ));
    };
    let bytes = read_regular_file(&path)?;
    let descriptor: BrowserProfileDescriptor = serde_json::from_slice(&bytes)
        .map_err(|error| ProfileError::CorruptMetadata(error.to_string()))?;
    validate_descriptor(&descriptor, expected_profile_id, revision)?;
    Ok(descriptor)
}

fn validate_descriptor(
    descriptor: &BrowserProfileDescriptor,
    expected_profile_id: &ProfileId,
    expected_revision: u64,
) -> Result<(), ProfileError> {
    if descriptor.schema_version != PROFILE_SCHEMA_VERSION {
        return Err(ProfileError::CorruptMetadata(format!(
            "unsupported schema version {}",
            descriptor.schema_version
        )));
    }
    if &descriptor.profile_id != expected_profile_id || descriptor.revision != expected_revision {
        return Err(ProfileError::CorruptMetadata(
            "descriptor identity does not match its app-owned path".to_string(),
        ));
    }
    TrustedWorkspaceIdentity::from_trusted_store(descriptor.workspace_identity.clone())?;
    if descriptor.runtime_compatibility.profile_format_version != PROFILE_FORMAT_VERSION {
        return Err(ProfileError::CorruptMetadata(format!(
            "unsupported profile format version {}",
            descriptor.runtime_compatibility.profile_format_version
        )));
    }
    parse_rfc3339(&descriptor.created_at, "created_at")?;
    if let Some(last_used_at) = descriptor.last_used_at.as_deref() {
        parse_rfc3339(last_used_at, "last_used_at")?;
    }
    match &descriptor.cleanup_state {
        ProfileCleanupState::Stopped => {}
        ProfileCleanupState::LaunchPending {
            ownership_id,
            since,
        } => {
            validate_bounded_identifier(ownership_id, MAX_RUNTIME_ID_BYTES, "ownership id")?;
            parse_rfc3339(since, "cleanup since")?;
        }
        ProfileCleanupState::RuntimeOwned {
            ownership_id,
            runtime_id,
            since,
        } => {
            validate_bounded_identifier(ownership_id, MAX_RUNTIME_ID_BYTES, "ownership id")?;
            validate_bounded_identifier(runtime_id, MAX_RUNTIME_ID_BYTES, "runtime id")?;
            parse_rfc3339(since, "cleanup since")?;
        }
        ProfileCleanupState::Resetting {
            authorization_id,
            since,
        }
        | ProfileCleanupState::Deleting {
            authorization_id,
            since,
        } => {
            validate_bounded_identifier(
                authorization_id,
                MAX_RUNTIME_ID_BYTES,
                "authorization id",
            )?;
            parse_rfc3339(since, "cleanup since")?;
        }
    }
    Ok(())
}

fn parse_rfc3339(value: &str, field: &str) -> Result<(), ProfileError> {
    DateTime::parse_from_rfc3339(value)
        .map(|_| ())
        .map_err(|error| ProfileError::CorruptMetadata(format!("invalid {field}: {error}")))
}

pub(super) fn persist_next_descriptor(
    profile_dir: &Path,
    mut descriptor: BrowserProfileDescriptor,
) -> Result<BrowserProfileDescriptor, ProfileError> {
    descriptor.revision = descriptor
        .revision
        .checked_add(1)
        .ok_or_else(|| ProfileError::CorruptMetadata("descriptor revision overflow".to_string()))?;
    write_descriptor_generation(profile_dir, &descriptor)?;
    Ok(descriptor)
}

pub(super) fn write_descriptor_generation(
    profile_dir: &Path,
    descriptor: &BrowserProfileDescriptor,
) -> Result<(), ProfileError> {
    ensure_path_is_not_symlink(profile_dir)?;
    let target = profile_dir.join(metadata_file_name(descriptor.revision));
    if target.exists() {
        return Err(ProfileError::CorruptMetadata(format!(
            "descriptor revision {} already exists",
            descriptor.revision
        )));
    }
    let temporary = profile_dir.join(format!(
        ".profile-{:0width$}-{}.tmp",
        descriptor.revision,
        random_opaque_id("write"),
        width = METADATA_REVISION_WIDTH
    ));
    let bytes = serde_json::to_vec_pretty(descriptor)
        .map_err(|error| ProfileError::CorruptMetadata(error.to_string()))?;
    write_private_new_file(&temporary, &bytes)?;
    if let Err(error) = fs::rename(&temporary, &target) {
        let _ = fs::remove_file(&temporary);
        return Err(io_error("commit browser profile metadata", error));
    }
    sync_directory(profile_dir)?;
    Ok(())
}

pub(super) fn metadata_file_name(revision: u64) -> String {
    format!(
        "{METADATA_FILE_PREFIX}{revision:0width$}{METADATA_FILE_SUFFIX}",
        width = METADATA_REVISION_WIDTH
    )
}

fn parse_metadata_revision(file_name: &str) -> Option<u64> {
    let raw = file_name
        .strip_prefix(METADATA_FILE_PREFIX)?
        .strip_suffix(METADATA_FILE_SUFFIX)?;
    if raw.len() != METADATA_REVISION_WIDTH || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    raw.parse().ok()
}

pub(super) fn ensure_profile_directory(
    profiles_root: &Path,
    profile_dir: &Path,
) -> Result<(), ProfileError> {
    ensure_path_is_not_symlink(profiles_root)?;
    ensure_path_is_not_symlink(profile_dir)?;
    let canonical_root = profiles_root
        .canonicalize()
        .map_err(|error| io_error("resolve browser profiles root", error))?;
    let canonical_profile = profile_dir
        .canonicalize()
        .map_err(|error| io_error("resolve browser profile directory", error))?;
    if !canonical_profile.starts_with(&canonical_root) || canonical_profile == canonical_root {
        return Err(ProfileError::UnsafePath(
            "profile directory escaped the app-owned root".to_string(),
        ));
    }
    let metadata = fs::symlink_metadata(profile_dir)
        .map_err(|error| io_error("inspect browser profile directory", error))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(ProfileError::UnsafePath(
            "profile path is not a real directory".to_string(),
        ));
    }
    Ok(())
}

pub(super) fn ensure_private_directory(path: &Path) -> Result<(), ProfileError> {
    if path.exists() {
        ensure_path_is_not_symlink(path)?;
        let metadata = fs::symlink_metadata(path)
            .map_err(|error| io_error("inspect browser profile root", error))?;
        if !metadata.is_dir() {
            return Err(ProfileError::UnsafePath(
                "app-owned profile root is not a directory".to_string(),
            ));
        }
    } else {
        fs::create_dir_all(path).map_err(|error| io_error("create browser profile root", error))?;
        ensure_path_is_not_symlink(path)?;
    }
    secure_directory(path)
}

pub(super) fn ensure_private_child_directory(
    parent: &Path,
    child: &Path,
) -> Result<(), ProfileError> {
    ensure_path_is_not_symlink(parent)?;
    if child.exists() {
        ensure_path_is_not_symlink(child)?;
        let metadata = fs::symlink_metadata(child)
            .map_err(|error| io_error("inspect browser profile directory", error))?;
        if !metadata.is_dir() {
            return Err(ProfileError::UnsafePath(
                "profile child path is not a directory".to_string(),
            ));
        }
    } else {
        fs::create_dir(child)
            .map_err(|error| io_error("create browser profile directory", error))?;
    }
    secure_directory(child)?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|error| io_error("resolve browser profile parent", error))?;
    let canonical_child = child
        .canonicalize()
        .map_err(|error| io_error("resolve browser profile child", error))?;
    if !canonical_child.starts_with(&canonical_parent) || canonical_child == canonical_parent {
        return Err(ProfileError::UnsafePath(
            "profile child escaped its app-owned parent".to_string(),
        ));
    }
    Ok(())
}

pub(super) fn ensure_private_lock_file(path: &Path) -> Result<(), ProfileError> {
    let file = open_profile_lock(path)?;
    file.sync_all()
        .map_err(|error| io_error("sync browser profile lock file", error))
}

pub(super) fn open_profile_lock(path: &Path) -> Result<File, ProfileError> {
    if path.exists() {
        ensure_path_is_not_symlink(path)?;
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    configure_private_open_options(&mut options);
    let file = options
        .open(path)
        .map_err(|error| io_error("open browser profile lock file", error))?;
    let metadata = file
        .metadata()
        .map_err(|error| io_error("inspect browser profile lock file", error))?;
    if !metadata.is_file() {
        return Err(ProfileError::UnsafePath(
            "profile lock is not a regular file".to_string(),
        ));
    }
    secure_file(path)?;
    Ok(file)
}

pub(super) fn read_regular_file(path: &Path) -> Result<Vec<u8>, ProfileError> {
    ensure_path_is_not_symlink(path)?;
    let mut options = OpenOptions::new();
    options.read(true);
    configure_no_follow_open_options(&mut options);
    let mut file = options
        .open(path)
        .map_err(|error| io_error("open browser profile metadata", error))?;
    let metadata = file
        .metadata()
        .map_err(|error| io_error("inspect browser profile metadata", error))?;
    if !metadata.is_file() {
        return Err(ProfileError::UnsafePath(
            "profile metadata is not a regular file".to_string(),
        ));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| io_error("read browser profile metadata", error))?;
    Ok(bytes)
}

pub(super) fn write_private_new_file(path: &Path, bytes: &[u8]) -> Result<(), ProfileError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    configure_private_open_options(&mut options);
    let mut file = options
        .open(path)
        .map_err(|error| io_error("create browser profile metadata", error))?;
    file.write_all(bytes)
        .map_err(|error| io_error("write browser profile metadata", error))?;
    file.sync_all()
        .map_err(|error| io_error("sync browser profile metadata", error))?;
    secure_file(path)
}

#[cfg(unix)]
fn configure_private_open_options(options: &mut OpenOptions) {
    options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
}

#[cfg(not(unix))]
fn configure_private_open_options(_options: &mut OpenOptions) {}

#[cfg(unix)]
fn configure_no_follow_open_options(options: &mut OpenOptions) {
    options.custom_flags(libc::O_NOFOLLOW);
}

#[cfg(not(unix))]
fn configure_no_follow_open_options(_options: &mut OpenOptions) {}

pub(super) fn ensure_path_is_not_symlink(path: &Path) -> Result<(), ProfileError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(ProfileError::UnsafePath(
            format!("{} is a symlink", path.display()),
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error("inspect browser profile path", error)),
    }
}

pub(super) fn remove_private_directory(parent: &Path, target: &Path) -> Result<(), ProfileError> {
    ensure_path_is_not_symlink(parent)?;
    ensure_path_is_not_symlink(target)?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|error| io_error("resolve profile deletion parent", error))?;
    let canonical_target = target
        .canonicalize()
        .map_err(|error| io_error("resolve profile deletion target", error))?;
    if canonical_target == canonical_parent || !canonical_target.starts_with(&canonical_parent) {
        return Err(ProfileError::UnsafePath(
            "refusing to delete outside the app-owned profile root".to_string(),
        ));
    }
    fs::remove_dir_all(target).map_err(|error| io_error("delete browser profile data", error))
}

pub(super) fn remove_private_directory_if_present(
    parent: &Path,
    target: &Path,
) -> Result<(), ProfileError> {
    ensure_path_is_not_symlink(parent)?;
    ensure_path_is_not_symlink(target)?;
    match fs::symlink_metadata(target) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            remove_private_directory(parent, target)
        }
        Ok(_) => Err(ProfileError::UnsafePath(format!(
            "{} is not a real directory",
            target.display()
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error("inspect browser profile deletion target", error)),
    }
}

#[cfg(unix)]
pub(super) fn secure_directory(path: &Path) -> Result<(), ProfileError> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| io_error("secure browser profile directory", error))
}

#[cfg(not(unix))]
pub(super) fn secure_directory(_path: &Path) -> Result<(), ProfileError> {
    Ok(())
}

#[cfg(unix)]
fn secure_file(path: &Path) -> Result<(), ProfileError> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| io_error("secure browser profile metadata", error))
}

#[cfg(not(unix))]
fn secure_file(_path: &Path) -> Result<(), ProfileError> {
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), ProfileError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| io_error("sync browser profile directory", error))
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), ProfileError> {
    Ok(())
}

pub(super) fn io_error(context: &str, error: std::io::Error) -> ProfileError {
    ProfileError::Io(format!("{context}: {error}"))
}
