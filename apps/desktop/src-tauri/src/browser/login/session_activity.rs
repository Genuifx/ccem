use super::*;
use chrono::{DateTime, Utc};
use fs2::FileExt;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::time::SystemTime;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

const MAX_DIRECTORY_ENTRIES: usize = 512;
const MAX_RECENT_ARTIFACTS: usize = 12;
const MAX_VISIBLE_ARTIFACT_BYTES: u64 = 32 * 1024 * 1024;
const RANDOM_ID_HEX_LENGTH: usize = 32;
const PROFILE_ACTIVITY_SCHEMA_VERSION: u32 = 1;
pub(super) const MAX_PROFILE_ACTIVITY_SESSIONS: usize = 16;
pub(super) const MAX_PROFILE_ACTIVITY_BYTES: u64 = 4 * 1024;
const MAX_PROFILE_ACTIVITY_ROOT_ENTRIES: usize = 4_096;
const PROFILE_ACTIVITY_KEY_BYTES: usize = 32;
const PROFILE_ACTIVITY_KEY_FILE: &str = "integrity.key";
const PROFILE_ACTIVITY_LOCK_FILE: &str = "activity.lock";
const PROFILE_ACTIVITY_INTEGRITY_DOMAIN: &[u8] = b"ccem-login-browser-profile-activity-v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct LoginBrowserRecentActivity {
    pub artifacts: Vec<LoginBrowserRecentArtifact>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct LoginBrowserRecentArtifact {
    pub kind: LoginBrowserRecentArtifactKind,
    pub artifact_id: String,
    pub byte_size: u64,
    pub modified_at: String,
    pub immutable: bool,
    pub untrusted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LoginBrowserRecentArtifactKind {
    Screenshot,
    InteractionSnapshot,
    ConsoleLog,
    NetworkLog,
    AuditLog,
}

struct ActivityRoots {
    artifacts: PathBuf,
    logs: PathBuf,
    audit: PathBuf,
}

pub(super) struct ProfileActivityStore {
    root: PathBuf,
    lock_path: PathBuf,
    key_path: PathBuf,
    integrity_key: [u8; PROFILE_ACTIVITY_KEY_BYTES],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedProfileActivity {
    schema_version: u32,
    session_ids: Vec<String>,
    integrity_sha256: String,
}

#[derive(Serialize)]
struct ProfileActivityIntegrityPayload<'a> {
    schema_version: u32,
    profile_id: &'a str,
    session_ids: &'a [String],
}

impl ProfileActivityStore {
    pub(super) fn new(root: PathBuf) -> Result<Self, SessionManagerError> {
        if !root.is_absolute() || root.as_os_str().is_empty() {
            return Err(SessionManagerError::StateUnavailable);
        }
        initialize_private_directory(&root)?;
        let lock_path = root.join(PROFILE_ACTIVITY_LOCK_FILE);
        let key_path = root.join(PROFILE_ACTIVITY_KEY_FILE);
        let lock = acquire_profile_activity_lock(&lock_path)?;
        let integrity_key = load_or_create_profile_activity_key(&root, &key_path)?;
        drop(lock);
        Ok(Self {
            root,
            lock_path,
            key_path,
            integrity_key,
        })
    }

    pub(super) fn register(
        &self,
        profile_id: &ProfileId,
        session_id: &SessionId,
    ) -> Result<(), SessionManagerError> {
        ensure_private_directory(&self.root)?;
        let lock = acquire_profile_activity_lock(&self.lock_path)?;
        self.validate_integrity_key()?;
        let mut session_ids = self.load(profile_id)?;
        session_ids.retain(|existing| existing != session_id);
        session_ids.push(session_id.clone());
        if session_ids.len() > MAX_PROFILE_ACTIVITY_SESSIONS {
            session_ids.drain(..session_ids.len() - MAX_PROFILE_ACTIVITY_SESSIONS);
        }
        self.write(profile_id, &session_ids)?;
        drop(lock);
        Ok(())
    }

    fn session_ids(&self, profile_id: &ProfileId) -> Result<Vec<SessionId>, SessionManagerError> {
        ensure_private_directory(&self.root)?;
        let lock = acquire_profile_activity_lock(&self.lock_path)?;
        self.validate_integrity_key()?;
        let result = self.load(profile_id);
        drop(lock);
        result
    }

    fn validate_integrity_key(&self) -> Result<(), SessionManagerError> {
        let bytes = read_bounded_private_file(&self.key_path, PROFILE_ACTIVITY_KEY_BYTES as u64)?;
        if bytes.len() != PROFILE_ACTIVITY_KEY_BYTES
            || !constant_time_equal(&bytes, &self.integrity_key)
        {
            return Err(SessionManagerError::StateUnavailable);
        }
        Ok(())
    }

    fn load(&self, profile_id: &ProfileId) -> Result<Vec<SessionId>, SessionManagerError> {
        let path = profile_activity_path(&self.root, profile_id);
        if !regular_file_presence(&path)? {
            return Ok(Vec::new());
        }
        let bytes = read_bounded_private_file(&path, MAX_PROFILE_ACTIVITY_BYTES)?;
        let persisted = serde_json::from_slice::<PersistedProfileActivity>(&bytes)
            .map_err(|_| SessionManagerError::StateUnavailable)?;
        validate_persisted_profile_activity(profile_id, &persisted, &self.integrity_key)
    }

    fn write(
        &self,
        profile_id: &ProfileId,
        session_ids: &[SessionId],
    ) -> Result<(), SessionManagerError> {
        if session_ids.len() > MAX_PROFILE_ACTIVITY_SESSIONS {
            return Err(SessionManagerError::StateUnavailable);
        }
        let session_ids = session_ids
            .iter()
            .map(|session_id| session_id.as_str().to_string())
            .collect::<Vec<_>>();
        let payload = serialize_profile_activity_payload(profile_id, &session_ids)?;
        let persisted = PersistedProfileActivity {
            schema_version: PROFILE_ACTIVITY_SCHEMA_VERSION,
            session_ids,
            integrity_sha256: hex::encode(hmac_sha256(&self.integrity_key, &payload)),
        };
        let bytes =
            serde_json::to_vec(&persisted).map_err(|_| SessionManagerError::StateUnavailable)?;
        if bytes.len() as u64 > MAX_PROFILE_ACTIVITY_BYTES {
            return Err(SessionManagerError::StateUnavailable);
        }
        let target = profile_activity_path(&self.root, profile_id);
        regular_file_presence(&target)?;
        write_private_atomic(&self.root, &target, &bytes)
    }
}

impl LoginBrowserSessionManager {
    pub(crate) fn recent_activity(
        &self,
        session: &LoginBrowserSessionHandle,
    ) -> Result<LoginBrowserRecentActivity, SessionManagerError> {
        let roots = {
            let sessions = self.lock_sessions()?;
            let record = self.record(&sessions, &session.session_id)?;
            let session_root = record
                .artifact_root
                .parent()
                .ok_or(SessionManagerError::StateUnavailable)?;
            ActivityRoots {
                artifacts: record.artifact_root.clone(),
                logs: session_root.join("logs"),
                audit: record.audit.path().to_path_buf(),
            }
        };
        collect_recent_activity(&roots)
    }

    pub(crate) fn recent_activity_for_profile(
        &self,
        workspace: TrustedWorkspacePath,
        profile_id: &str,
    ) -> Result<LoginBrowserRecentActivity, SessionManagerError> {
        let inner = self.available()?;
        let _gate = inner
            .open_gate
            .lock()
            .map_err(|_| SessionManagerError::StateUnavailable)?;
        let workspace_identity = inner
            .workspace_identities
            .resolve(workspace.as_path())
            .map_err(super::map_workspace_error)?;
        let profile_id = ProfileId::parse(profile_id).map_err(super::map_profile_error)?;
        let global_default = inner
            .profiles
            .global_default_profile(&workspace_identity, false)
            .map_err(super::map_profile_error)?;
        if !global_default
            .as_ref()
            .is_some_and(|descriptor| descriptor.profile_id() == &profile_id)
        {
            inner
                .profiles
                .descriptor(&profile_id, &workspace_identity)
                .map_err(super::map_profile_error)?;
        }
        let session_ids = inner.profile_activity.session_ids(&profile_id)?;
        let mut artifacts = Vec::new();
        if session_ids.is_empty() {
            return Ok(LoginBrowserRecentActivity { artifacts });
        }
        let sessions_root = inner.root.join("sessions");
        ensure_directory_without_symlink(&sessions_root)?;
        for session_id in session_ids.into_iter().rev() {
            let session_root = sessions_root.join(session_id.as_str());
            ensure_directory_without_symlink(&session_root)?;
            let activity = collect_recent_activity(&ActivityRoots {
                artifacts: session_root.join("artifacts"),
                logs: session_root.join("logs"),
                audit: session_root.join("audit").join("actions.jsonl"),
            })?;
            artifacts.extend(activity.artifacts);
        }
        artifacts.sort_by(|left, right| right.modified_at.cmp(&left.modified_at));
        artifacts.truncate(MAX_RECENT_ARTIFACTS);
        Ok(LoginBrowserRecentActivity { artifacts })
    }
}

fn profile_activity_path(root: &Path, profile_id: &ProfileId) -> PathBuf {
    root.join(format!("{}.json", profile_id.as_str()))
}

fn validate_persisted_profile_activity(
    profile_id: &ProfileId,
    persisted: &PersistedProfileActivity,
    integrity_key: &[u8; PROFILE_ACTIVITY_KEY_BYTES],
) -> Result<Vec<SessionId>, SessionManagerError> {
    if persisted.schema_version != PROFILE_ACTIVITY_SCHEMA_VERSION
        || persisted.session_ids.len() > MAX_PROFILE_ACTIVITY_SESSIONS
        || !is_lower_hex_sha256(&persisted.integrity_sha256)
    {
        return Err(SessionManagerError::StateUnavailable);
    }
    let mut unique = HashSet::new();
    let mut session_ids = Vec::with_capacity(persisted.session_ids.len());
    for raw in &persisted.session_ids {
        let session_id = parse_opaque_session_id(raw)?;
        if !unique.insert(raw) {
            return Err(SessionManagerError::StateUnavailable);
        }
        session_ids.push(session_id);
    }
    let payload = serialize_profile_activity_payload(profile_id, &persisted.session_ids)?;
    let expected = hmac_sha256(integrity_key, &payload);
    let actual = hex::decode(&persisted.integrity_sha256)
        .map_err(|_| SessionManagerError::StateUnavailable)?;
    if !constant_time_equal(&expected, &actual) {
        return Err(SessionManagerError::StateUnavailable);
    }
    Ok(session_ids)
}

fn serialize_profile_activity_payload(
    profile_id: &ProfileId,
    session_ids: &[String],
) -> Result<Vec<u8>, SessionManagerError> {
    serde_json::to_vec(&ProfileActivityIntegrityPayload {
        schema_version: PROFILE_ACTIVITY_SCHEMA_VERSION,
        profile_id: profile_id.as_str(),
        session_ids,
    })
    .map_err(|_| SessionManagerError::StateUnavailable)
}

fn parse_opaque_session_id(value: &str) -> Result<SessionId, SessionManagerError> {
    let Some(random) = value.strip_prefix(SESSION_ID_PREFIX) else {
        return Err(SessionManagerError::StateUnavailable);
    };
    if random.len() != SESSION_ID_HEX_LENGTH
        || !random
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(SessionManagerError::StateUnavailable);
    }
    Ok(SessionId(value.to_string()))
}

fn collect_recent_activity(
    roots: &ActivityRoots,
) -> Result<LoginBrowserRecentActivity, SessionManagerError> {
    let mut artifacts = Vec::new();
    scan_directory(&roots.artifacts, classify_page_artifact, &mut artifacts)?;
    scan_directory(&roots.logs, classify_log_artifact, &mut artifacts)?;
    if let Some(audit) = inspect_audit(&roots.audit)? {
        artifacts.push(audit);
    }
    artifacts.sort_by(|left, right| right.modified_at.cmp(&left.modified_at));
    artifacts.truncate(MAX_RECENT_ARTIFACTS);
    Ok(LoginBrowserRecentActivity { artifacts })
}

struct ProfileActivityLock(File);

impl Drop for ProfileActivityLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

fn initialize_private_directory(path: &Path) -> Result<(), SessionManagerError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(SessionManagerError::StateUnavailable)
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(|_| SessionManagerError::StateUnavailable)?;
        }
        Err(_) => return Err(SessionManagerError::StateUnavailable),
    }
    set_private_directory_permissions(path)?;
    ensure_private_directory(path)
}

fn ensure_directory_without_symlink(path: &Path) -> Result<(), SessionManagerError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| SessionManagerError::StateUnavailable)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(SessionManagerError::StateUnavailable);
    }
    Ok(())
}

fn acquire_profile_activity_lock(path: &Path) -> Result<ProfileActivityLock, SessionManagerError> {
    regular_file_presence(path)?;
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true).truncate(false);
    configure_private_open_options(&mut options);
    let file = options
        .open(path)
        .map_err(|_| SessionManagerError::StateUnavailable)?;
    set_private_file_permissions(path)?;
    file.lock_exclusive()
        .map_err(|_| SessionManagerError::StateUnavailable)?;
    Ok(ProfileActivityLock(file))
}

fn load_or_create_profile_activity_key(
    root: &Path,
    path: &Path,
) -> Result<[u8; PROFILE_ACTIVITY_KEY_BYTES], SessionManagerError> {
    if regular_file_presence(path)? {
        return read_profile_activity_key(path);
    }
    if profile_activity_root_has_state(root)? {
        return Err(SessionManagerError::StateUnavailable);
    }
    let mut key = [0_u8; PROFILE_ACTIVITY_KEY_BYTES];
    OsRng
        .try_fill_bytes(&mut key)
        .map_err(|_| SessionManagerError::StateUnavailable)?;
    write_new_private_file(path, &key)?;
    sync_directory(root)?;
    Ok(key)
}

fn read_profile_activity_key(
    path: &Path,
) -> Result<[u8; PROFILE_ACTIVITY_KEY_BYTES], SessionManagerError> {
    let bytes = read_bounded_private_file(path, PROFILE_ACTIVITY_KEY_BYTES as u64)?;
    if bytes.len() != PROFILE_ACTIVITY_KEY_BYTES {
        return Err(SessionManagerError::StateUnavailable);
    }
    let mut key = [0_u8; PROFILE_ACTIVITY_KEY_BYTES];
    key.copy_from_slice(&bytes);
    Ok(key)
}

fn profile_activity_root_has_state(root: &Path) -> Result<bool, SessionManagerError> {
    let mut entries = 0_usize;
    for entry in fs::read_dir(root).map_err(|_| SessionManagerError::StateUnavailable)? {
        entries = entries.saturating_add(1);
        if entries > MAX_PROFILE_ACTIVITY_ROOT_ENTRIES {
            return Err(SessionManagerError::StateUnavailable);
        }
        let entry = entry.map_err(|_| SessionManagerError::StateUnavailable)?;
        if entry.file_name().to_str() != Some(PROFILE_ACTIVITY_LOCK_FILE) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn regular_file_presence(path: &Path) -> Result<bool, SessionManagerError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() && !metadata.file_type().is_symlink() => {
            Ok(true)
        }
        Ok(_) => Err(SessionManagerError::StateUnavailable),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(SessionManagerError::StateUnavailable),
    }
}

fn read_bounded_private_file(path: &Path, max: u64) -> Result<Vec<u8>, SessionManagerError> {
    if !regular_file_presence(path)? {
        return Err(SessionManagerError::StateUnavailable);
    }
    let mut options = OpenOptions::new();
    options.read(true);
    configure_no_follow_open_options(&mut options);
    let mut file = options
        .open(path)
        .map_err(|_| SessionManagerError::StateUnavailable)?;
    let metadata = file
        .metadata()
        .map_err(|_| SessionManagerError::StateUnavailable)?;
    if !metadata.is_file() || metadata.len() > max || !private_file_permissions(&metadata) {
        return Err(SessionManagerError::StateUnavailable);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|_| SessionManagerError::StateUnavailable)?;
    if bytes.len() as u64 != metadata.len() || bytes.len() as u64 > max {
        return Err(SessionManagerError::StateUnavailable);
    }
    Ok(bytes)
}

fn write_new_private_file(path: &Path, bytes: &[u8]) -> Result<(), SessionManagerError> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    configure_private_open_options(&mut options);
    let mut file = options
        .open(path)
        .map_err(|_| SessionManagerError::StateUnavailable)?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| SessionManagerError::StateUnavailable)?;
    set_private_file_permissions(path)
}

fn write_private_atomic(
    root: &Path,
    target: &Path,
    bytes: &[u8],
) -> Result<(), SessionManagerError> {
    let mut nonce = [0_u8; 8];
    OsRng
        .try_fill_bytes(&mut nonce)
        .map_err(|_| SessionManagerError::StateUnavailable)?;
    let temporary = root.join(format!(
        ".profile-activity.{}.{}.tmp",
        std::process::id(),
        hex::encode(nonce)
    ));
    let result = (|| {
        write_new_private_file(&temporary, bytes)?;
        atomic_replace(&temporary, target)?;
        set_private_file_permissions(target)?;
        sync_directory(root)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
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

#[cfg(unix)]
fn private_file_permissions(metadata: &fs::Metadata) -> bool {
    metadata.permissions().mode() & 0o077 == 0
}

#[cfg(not(unix))]
fn private_file_permissions(_metadata: &fs::Metadata) -> bool {
    true
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> Result<(), SessionManagerError> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|_| SessionManagerError::StateUnavailable)
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> Result<(), SessionManagerError> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) -> Result<(), SessionManagerError> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|_| SessionManagerError::StateUnavailable)
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) -> Result<(), SessionManagerError> {
    Ok(())
}

#[cfg(unix)]
fn atomic_replace(source: &Path, target: &Path) -> Result<(), SessionManagerError> {
    fs::rename(source, target).map_err(|_| SessionManagerError::StateUnavailable)
}

#[cfg(windows)]
fn atomic_replace(source: &Path, target: &Path) -> Result<(), SessionManagerError> {
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
        Err(SessionManagerError::StateUnavailable)
    } else {
        Ok(())
    }
}

#[cfg(all(not(unix), not(windows)))]
fn atomic_replace(source: &Path, target: &Path) -> Result<(), SessionManagerError> {
    fs::rename(source, target).map_err(|_| SessionManagerError::StateUnavailable)
}

fn sync_directory(path: &Path) -> Result<(), SessionManagerError> {
    #[cfg(unix)]
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| SessionManagerError::StateUnavailable)?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK_BYTES: usize = 64;
    let mut block = [0_u8; BLOCK_BYTES];
    if key.len() > BLOCK_BYTES {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner_key = [0x36_u8; BLOCK_BYTES];
    let mut outer_key = [0x5c_u8; BLOCK_BYTES];
    for index in 0..BLOCK_BYTES {
        inner_key[index] ^= block[index];
        outer_key[index] ^= block[index];
    }
    let mut inner = Sha256::new();
    inner.update(inner_key);
    inner.update(message);
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(outer_key);
    outer.update(inner);
    outer.finalize().into()
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn is_lower_hex_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn scan_directory(
    root: &Path,
    classify: fn(&str) -> Option<(LoginBrowserRecentArtifactKind, String)>,
    output: &mut Vec<LoginBrowserRecentArtifact>,
) -> Result<(), SessionManagerError> {
    ensure_private_directory(root)?;
    let mut scanned = 0_usize;
    for entry in fs::read_dir(root).map_err(|_| SessionManagerError::StateUnavailable)? {
        scanned = scanned.saturating_add(1);
        if scanned > MAX_DIRECTORY_ENTRIES {
            return Err(SessionManagerError::StateUnavailable);
        }
        let entry = entry.map_err(|_| SessionManagerError::StateUnavailable)?;
        let path = entry.path();
        if path.parent() != Some(root) {
            return Err(SessionManagerError::StateUnavailable);
        }
        let metadata =
            fs::symlink_metadata(&path).map_err(|_| SessionManagerError::StateUnavailable)?;
        if metadata.file_type().is_symlink() {
            return Err(SessionManagerError::StateUnavailable);
        }
        if !metadata.is_file() {
            continue;
        }
        let file_name = entry
            .file_name()
            .into_string()
            .map_err(|_| SessionManagerError::StateUnavailable)?;
        let Some((kind, artifact_id)) = classify(&file_name) else {
            continue;
        };
        output.push(project_artifact(kind, artifact_id, &metadata, true, true)?);
    }
    Ok(())
}

fn inspect_audit(path: &Path) -> Result<Option<LoginBrowserRecentArtifact>, SessionManagerError> {
    let Some(parent) = path.parent() else {
        return Err(SessionManagerError::StateUnavailable);
    };
    if !path.exists() {
        return Ok(None);
    }
    ensure_private_directory(parent)?;
    if path.parent() != Some(parent)
        || path.file_name().and_then(|value| value.to_str()) != Some("actions.jsonl")
    {
        return Err(SessionManagerError::StateUnavailable);
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| SessionManagerError::StateUnavailable)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(SessionManagerError::StateUnavailable);
    }
    project_artifact(
        LoginBrowserRecentArtifactKind::AuditLog,
        "semantic-audit".to_string(),
        &metadata,
        false,
        false,
    )
    .map(Some)
}

fn project_artifact(
    kind: LoginBrowserRecentArtifactKind,
    artifact_id: String,
    metadata: &fs::Metadata,
    immutable: bool,
    untrusted: bool,
) -> Result<LoginBrowserRecentArtifact, SessionManagerError> {
    if metadata.len() > MAX_VISIBLE_ARTIFACT_BYTES {
        return Err(SessionManagerError::StateUnavailable);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(SessionManagerError::StateUnavailable);
        }
    }
    let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    Ok(LoginBrowserRecentArtifact {
        kind,
        artifact_id,
        byte_size: metadata.len(),
        modified_at: DateTime::<Utc>::from(modified).to_rfc3339(),
        immutable,
        untrusted,
    })
}

fn ensure_private_directory(path: &Path) -> Result<(), SessionManagerError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| SessionManagerError::StateUnavailable)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(SessionManagerError::StateUnavailable);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(SessionManagerError::StateUnavailable);
        }
    }
    Ok(())
}

fn classify_page_artifact(file_name: &str) -> Option<(LoginBrowserRecentArtifactKind, String)> {
    classify_random_artifact(file_name, "shot-", ".png")
        .map(|id| (LoginBrowserRecentArtifactKind::Screenshot, id))
        .or_else(|| {
            classify_random_artifact(file_name, "snapshot-", ".json")
                .map(|id| (LoginBrowserRecentArtifactKind::InteractionSnapshot, id))
        })
}

fn classify_log_artifact(file_name: &str) -> Option<(LoginBrowserRecentArtifactKind, String)> {
    classify_random_artifact(file_name, "console-snapshot-", ".jsonl")
        .map(|id| (LoginBrowserRecentArtifactKind::ConsoleLog, id))
        .or_else(|| {
            classify_random_artifact(file_name, "network-snapshot-", ".jsonl")
                .map(|id| (LoginBrowserRecentArtifactKind::NetworkLog, id))
        })
}

fn classify_random_artifact(file_name: &str, prefix: &str, suffix: &str) -> Option<String> {
    let stem = file_name.strip_suffix(suffix)?;
    let random = stem.strip_prefix(prefix)?;
    if random.len() != RANDOM_ID_HEX_LENGTH
        || !random
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return None;
    }
    Some(stem.to_string())
}
