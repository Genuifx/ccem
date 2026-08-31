use super::network::SafeNetworkEvent;
use fs2::FileExt as Fs2FileExt;
use rand::{rngs::OsRng, RngCore};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

const MAX_SESSION_ID_BYTES: usize = 160;
const MAX_EVENT_BYTES: usize = 64 * 1024;
const DEFAULT_MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const DEFAULT_ROTATIONS: usize = 3;
const MAX_RECENT_EVENTS: usize = 20;
const MAX_RECENT_TOTAL_BYTES: usize = 256 * 1024;
const MAX_SNAPSHOT_COUNT: usize = 32;
const MAX_SNAPSHOT_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
const SNAPSHOT_PREFIX: &str = "network-snapshot-";
const SNAPSHOT_HEX_BYTES: usize = 16;
const STORE_LOCK_NAME: &str = ".network-log.lock";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum NetworkLogErrorCode {
    InvalidRoot,
    InvalidSession,
    UnsafePath,
    EventTooLarge,
    UnsafeContent,
    Serialize,
    Io,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct NetworkLogError {
    pub(super) code: NetworkLogErrorCode,
}

impl NetworkLogError {
    fn new(code: NetworkLogErrorCode) -> Self {
        Self { code }
    }
}

impl fmt::Display for NetworkLogError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "network log failed: {:?}", self.code)
    }
}

impl std::error::Error for NetworkLogError {}

/// Writes only the already-redacted projection type. Raw CDP events are intentionally not
/// accepted by this API, so redaction must happen before the first disk write.
#[derive(Debug)]
pub(super) struct NetworkLogStore {
    root: PathBuf,
    max_file_bytes: u64,
    rotations: usize,
    writer_lock: Mutex<()>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct NetworkLogArtifact {
    pub(super) artifact_id: String,
    pub(super) path: PathBuf,
    pub(super) sha256: String,
    pub(super) byte_size: u64,
    pub(super) event_count: usize,
    pub(super) invalid_line_count: usize,
    pub(super) recent: Vec<Value>,
    pub(super) untrusted: bool,
}

impl NetworkLogStore {
    pub(super) fn new(root: PathBuf) -> Result<Self, NetworkLogError> {
        Self::with_limits(root, DEFAULT_MAX_FILE_BYTES, DEFAULT_ROTATIONS)
    }

    fn with_limits(
        root: PathBuf,
        max_file_bytes: u64,
        rotations: usize,
    ) -> Result<Self, NetworkLogError> {
        if max_file_bytes < 1024 || rotations == 0 || rotations > 16 {
            return Err(NetworkLogError::new(NetworkLogErrorCode::InvalidRoot));
        }
        ensure_private_directory(&root)?;
        Ok(Self {
            root,
            max_file_bytes,
            rotations,
            writer_lock: Mutex::new(()),
        })
    }

    pub(super) fn append(
        &self,
        session_id: &str,
        event: &SafeNetworkEvent,
    ) -> Result<PathBuf, NetworkLogError> {
        validate_session_id(session_id)?;
        let mut bytes = serde_json::to_vec(event)
            .map_err(|_| NetworkLogError::new(NetworkLogErrorCode::Serialize))?;
        if bytes.len() > MAX_EVENT_BYTES {
            return Err(NetworkLogError::new(NetworkLogErrorCode::EventTooLarge));
        }
        bytes.push(b'\n');
        let _guard = self
            .writer_lock
            .lock()
            .map_err(|_| NetworkLogError::new(NetworkLogErrorCode::Io))?;
        ensure_private_directory(&self.root)?;
        let _store_lock = lock_store(&self.root, STORE_LOCK_NAME)?;
        let path = self.root.join(format!("network-{session_id}.jsonl"));
        ensure_direct_child(&self.root, &path)?;
        reject_symlink_if_present(&path)?;
        let current_size = fs::metadata(&path).map(|value| value.len()).unwrap_or(0);
        if current_size.saturating_add(bytes.len() as u64) > self.max_file_bytes {
            self.rotate(&path)?;
        }
        append_private(&path, &bytes)?;
        Ok(path)
    }

    pub(super) fn read_artifact(
        &self,
        artifact_id: &str,
    ) -> Result<NetworkLogArtifact, NetworkLogError> {
        let session_id = artifact_id
            .strip_prefix("network-")
            .ok_or_else(|| NetworkLogError::new(NetworkLogErrorCode::InvalidSession))?;
        validate_session_id(session_id)?;
        let _guard = self
            .writer_lock
            .lock()
            .map_err(|_| NetworkLogError::new(NetworkLogErrorCode::Io))?;
        ensure_private_directory(&self.root)?;
        let _store_lock = lock_store(&self.root, STORE_LOCK_NAME)?;
        let path = self.root.join(format!("{artifact_id}.jsonl"));
        ensure_direct_child(&self.root, &path)?;
        reject_symlink_if_present(&path)?;
        if !path.exists() {
            append_private(&path, &[])?;
        }
        let (_, bytes) = read_private_file(&self.root, &path, self.max_file_bytes)?;
        let (event_count, recent) = inspect_network_bytes(&bytes)?;
        let snapshot_id = generate_snapshot_id();
        let snapshot_path = write_snapshot_atomic(&self.root, &snapshot_id, &bytes)?;
        prune_snapshots(
            &self.root,
            &snapshot_path,
            MAX_SNAPSHOT_COUNT,
            MAX_SNAPSHOT_TOTAL_BYTES,
        )?;
        Ok(NetworkLogArtifact {
            artifact_id: snapshot_id,
            path: snapshot_path,
            sha256: hex::encode(Sha256::digest(&bytes)),
            byte_size: bytes.len() as u64,
            event_count,
            invalid_line_count: 0,
            recent,
            untrusted: true,
        })
    }

    pub(super) fn read_snapshot(
        &self,
        artifact_id: &str,
    ) -> Result<NetworkLogArtifact, NetworkLogError> {
        validate_snapshot_id(artifact_id)?;
        let _guard = self
            .writer_lock
            .lock()
            .map_err(|_| NetworkLogError::new(NetworkLogErrorCode::Io))?;
        ensure_private_directory(&self.root)?;
        let _store_lock = lock_store(&self.root, STORE_LOCK_NAME)?;
        let path = self.root.join(format!("{artifact_id}.jsonl"));
        ensure_direct_child(&self.root, &path)?;
        reject_symlink_if_present(&path)?;
        let (canonical_path, bytes) = read_private_file(&self.root, &path, self.max_file_bytes)?;
        let (event_count, recent) = inspect_network_bytes(&bytes)?;
        Ok(NetworkLogArtifact {
            artifact_id: artifact_id.to_string(),
            path: canonical_path,
            sha256: hex::encode(Sha256::digest(&bytes)),
            byte_size: bytes.len() as u64,
            event_count,
            invalid_line_count: 0,
            recent,
            untrusted: true,
        })
    }

    fn rotate(&self, active: &Path) -> Result<(), NetworkLogError> {
        for index in (1..=self.rotations).rev() {
            let source = if index == 1 {
                active.to_path_buf()
            } else {
                PathBuf::from(format!("{}.{}", active.display(), index - 1))
            };
            let target = PathBuf::from(format!("{}.{}", active.display(), index));
            ensure_direct_child(&self.root, &source)?;
            ensure_direct_child(&self.root, &target)?;
            reject_symlink_if_present(&source)?;
            reject_symlink_if_present(&target)?;
            if target.exists() {
                fs::remove_file(&target)
                    .map_err(|_| NetworkLogError::new(NetworkLogErrorCode::Io))?;
            }
            if source.exists() {
                fs::rename(&source, &target)
                    .map_err(|_| NetworkLogError::new(NetworkLogErrorCode::Io))?;
            }
        }
        sync_directory(&self.root)
    }
}

fn inspect_network_bytes(bytes: &[u8]) -> Result<(usize, Vec<Value>), NetworkLogError> {
    let mut recent = VecDeque::with_capacity(MAX_RECENT_EVENTS);
    let mut recent_total_bytes = 2_usize;
    let mut event_count = 0_usize;
    for line in bytes.split(|byte| *byte == b'\n') {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        if line.len() > MAX_EVENT_BYTES {
            return Err(NetworkLogError::new(NetworkLogErrorCode::UnsafeContent));
        }
        let event: Value = serde_json::from_slice(line)
            .map_err(|_| NetworkLogError::new(NetworkLogErrorCode::UnsafeContent))?;
        validate_network_event(&event)?;
        event_count = event_count
            .checked_add(1)
            .ok_or_else(|| NetworkLogError::new(NetworkLogErrorCode::UnsafeContent))?;
        let encoded_bytes = line.len();
        while recent.len() == MAX_RECENT_EVENTS
            || recent_total_bytes
                .saturating_add(encoded_bytes)
                .saturating_add(usize::from(!recent.is_empty()))
                > MAX_RECENT_TOTAL_BYTES
        {
            let Some((_, removed_bytes)) = recent.pop_front() else {
                break;
            };
            recent_total_bytes = recent_total_bytes
                .saturating_sub(removed_bytes)
                .saturating_sub(usize::from(!recent.is_empty()));
        }
        recent_total_bytes = recent_total_bytes
            .saturating_add(encoded_bytes)
            .saturating_add(usize::from(!recent.is_empty()));
        recent.push_back((event, encoded_bytes));
    }
    Ok((
        event_count,
        recent.into_iter().map(|(event, _)| event).collect(),
    ))
}

fn validate_session_id(value: &str) -> Result<(), NetworkLogError> {
    if value.is_empty()
        || value.len() > MAX_SESSION_ID_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(NetworkLogError::new(NetworkLogErrorCode::InvalidSession));
    }
    Ok(())
}

fn generate_snapshot_id() -> String {
    let mut bytes = [0_u8; SNAPSHOT_HEX_BYTES];
    OsRng.fill_bytes(&mut bytes);
    format!("{SNAPSHOT_PREFIX}{}", hex::encode(bytes))
}

fn validate_snapshot_id(value: &str) -> Result<(), NetworkLogError> {
    let Some(hex) = value.strip_prefix(SNAPSHOT_PREFIX) else {
        return Err(NetworkLogError::new(NetworkLogErrorCode::InvalidSession));
    };
    if hex.len() != SNAPSHOT_HEX_BYTES * 2
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(NetworkLogError::new(NetworkLogErrorCode::InvalidSession));
    }
    Ok(())
}

fn lock_store(root: &Path, name: &str) -> Result<File, NetworkLogError> {
    let path = root.join(name);
    ensure_direct_child(root, &path)?;
    reject_symlink_if_present(&path)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(&path)
        .map_err(|_| NetworkLogError::new(NetworkLogErrorCode::Io))?;
    if !file
        .metadata()
        .map_err(|_| NetworkLogError::new(NetworkLogErrorCode::Io))?
        .is_file()
    {
        return Err(NetworkLogError::new(NetworkLogErrorCode::UnsafePath));
    }
    set_private_file(&file)?;
    Fs2FileExt::lock_exclusive(&file).map_err(|_| NetworkLogError::new(NetworkLogErrorCode::Io))?;
    Ok(file)
}

fn write_snapshot_atomic(
    root: &Path,
    artifact_id: &str,
    bytes: &[u8],
) -> Result<PathBuf, NetworkLogError> {
    validate_snapshot_id(artifact_id)?;
    let final_path = root.join(format!("{artifact_id}.jsonl"));
    ensure_direct_child(root, &final_path)?;
    reject_symlink_if_present(&final_path)?;
    if final_path.exists() {
        return Err(NetworkLogError::new(NetworkLogErrorCode::UnsafePath));
    }
    let temp_id = generate_snapshot_id();
    let temp_path = root.join(format!(".{temp_id}.tmp"));
    ensure_direct_child(root, &temp_path)?;
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options
            .open(&temp_path)
            .map_err(|_| NetworkLogError::new(NetworkLogErrorCode::Io))?;
        set_private_file(&file)?;
        file.write_all(bytes)
            .and_then(|_| file.sync_data())
            .map_err(|_| NetworkLogError::new(NetworkLogErrorCode::Io))?;
        drop(file);
        reject_symlink_if_present(&final_path)?;
        if final_path.exists() {
            return Err(NetworkLogError::new(NetworkLogErrorCode::UnsafePath));
        }
        fs::rename(&temp_path, &final_path)
            .map_err(|_| NetworkLogError::new(NetworkLogErrorCode::Io))?;
        sync_directory(root)?;
        final_path
            .canonicalize()
            .map_err(|_| NetworkLogError::new(NetworkLogErrorCode::Io))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn prune_snapshots(
    root: &Path,
    protected: &Path,
    maximum_count: usize,
    maximum_bytes: u64,
) -> Result<(), NetworkLogError> {
    let mut snapshots = Vec::new();
    for entry in fs::read_dir(root).map_err(|_| NetworkLogError::new(NetworkLogErrorCode::Io))? {
        let entry = entry.map_err(|_| NetworkLogError::new(NetworkLogErrorCode::Io))?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(id) = name.strip_suffix(".jsonl") else {
            continue;
        };
        if !id.starts_with(SNAPSHOT_PREFIX) {
            continue;
        }
        validate_snapshot_id(id)?;
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|_| NetworkLogError::new(NetworkLogErrorCode::Io))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(NetworkLogError::new(NetworkLogErrorCode::UnsafePath));
        }
        snapshots.push((
            entry.path(),
            metadata.len(),
            metadata.modified().unwrap_or(UNIX_EPOCH),
        ));
    }
    snapshots.sort_by(|left, right| {
        left.2
            .cmp(&right.2)
            .then_with(|| left.0.as_os_str().cmp(right.0.as_os_str()))
    });
    let mut total = snapshots.iter().map(|entry| entry.1).sum::<u64>();
    let mut changed = false;
    while snapshots.len() > maximum_count || total > maximum_bytes {
        let Some(index) = snapshots
            .iter()
            .position(|entry| entry.0.file_name() != protected.file_name())
        else {
            return Err(NetworkLogError::new(NetworkLogErrorCode::UnsafeContent));
        };
        let (path, bytes, _) = snapshots.remove(index);
        fs::remove_file(path).map_err(|_| NetworkLogError::new(NetworkLogErrorCode::Io))?;
        total = total.saturating_sub(bytes);
        changed = true;
    }
    if changed {
        sync_directory(root)?;
    }
    Ok(())
}

fn ensure_direct_child(parent: &Path, child: &Path) -> Result<(), NetworkLogError> {
    if child.parent() != Some(parent) {
        return Err(NetworkLogError::new(NetworkLogErrorCode::UnsafePath));
    }
    Ok(())
}

fn reject_symlink_if_present(path: &Path) -> Result<(), NetworkLogError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(NetworkLogError::new(NetworkLogErrorCode::UnsafePath))
        }
        Ok(metadata) if !metadata.file_type().is_file() => {
            Err(NetworkLogError::new(NetworkLogErrorCode::UnsafePath))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(NetworkLogError::new(NetworkLogErrorCode::Io)),
    }
}

fn ensure_private_directory(path: &Path) -> Result<(), NetworkLogError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() => {
            return Err(NetworkLogError::new(NetworkLogErrorCode::InvalidRoot))
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(|_| NetworkLogError::new(NetworkLogErrorCode::Io))?;
        }
        Err(_) => return Err(NetworkLogError::new(NetworkLogErrorCode::Io)),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| NetworkLogError::new(NetworkLogErrorCode::Io))?;
    }
    Ok(())
}

fn append_private(path: &Path, bytes: &[u8]) -> Result<(), NetworkLogError> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .map_err(|_| NetworkLogError::new(NetworkLogErrorCode::Io))?;
    set_private_file(&file)?;
    file.write_all(bytes)
        .and_then(|_| file.flush())
        .map_err(|_| NetworkLogError::new(NetworkLogErrorCode::Io))
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), NetworkLogError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| NetworkLogError::new(NetworkLogErrorCode::Io))
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), NetworkLogError> {
    Ok(())
}

fn read_private_file(
    root: &Path,
    path: &Path,
    maximum_bytes: u64,
) -> Result<(PathBuf, Vec<u8>), NetworkLogError> {
    let canonical_root = root
        .canonicalize()
        .map_err(|_| NetworkLogError::new(NetworkLogErrorCode::InvalidRoot))?;
    let canonical_path = path
        .canonicalize()
        .map_err(|_| NetworkLogError::new(NetworkLogErrorCode::Io))?;
    if canonical_path.parent() != Some(canonical_root.as_path()) {
        return Err(NetworkLogError::new(NetworkLogErrorCode::UnsafePath));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(&canonical_path)
        .map_err(|_| NetworkLogError::new(NetworkLogErrorCode::Io))?;
    let opened = file
        .metadata()
        .map_err(|_| NetworkLogError::new(NetworkLogErrorCode::Io))?;
    if !opened.is_file() || opened.len() > maximum_bytes {
        return Err(NetworkLogError::new(NetworkLogErrorCode::UnsafePath));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if opened.permissions().mode() & 0o077 != 0 {
            return Err(NetworkLogError::new(NetworkLogErrorCode::UnsafePath));
        }
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    Read::by_ref(&mut file)
        .take(maximum_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| NetworkLogError::new(NetworkLogErrorCode::Io))?;
    if bytes.len() as u64 > maximum_bytes {
        return Err(NetworkLogError::new(NetworkLogErrorCode::UnsafeContent));
    }
    let final_metadata = fs::symlink_metadata(&canonical_path)
        .map_err(|_| NetworkLogError::new(NetworkLogErrorCode::Io))?;
    if final_metadata.file_type().is_symlink()
        || !final_metadata.is_file()
        || final_metadata.len() != bytes.len() as u64
    {
        return Err(NetworkLogError::new(NetworkLogErrorCode::UnsafePath));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if opened.dev() != final_metadata.dev() || opened.ino() != final_metadata.ino() {
            return Err(NetworkLogError::new(NetworkLogErrorCode::UnsafePath));
        }
    }
    Ok((canonical_path, bytes))
}

fn validate_network_event(event: &Value) -> Result<(), NetworkLogError> {
    const KEYS: &[&str] = &[
        "schema_version",
        "event",
        "projection_code",
        "captured_at",
        "request_id",
        "method",
        "url",
        "status",
        "mime_type",
        "resource_type",
        "headers",
        "redacted_header_count",
        "ignored_header_count",
        "duration_ms",
        "encoded_bytes",
        "failure_code",
        "body_captured",
        "untrusted",
    ];
    let object = event
        .as_object()
        .filter(|object| object.len() == KEYS.len())
        .ok_or_else(|| NetworkLogError::new(NetworkLogErrorCode::UnsafeContent))?;
    if object.keys().any(|key| !KEYS.contains(&key.as_str()))
        || object.get("schema_version").and_then(Value::as_u64) != Some(1)
        || !matches!(
            object.get("event").and_then(Value::as_str),
            Some("request" | "response" | "loading_finished" | "loading_failed")
        )
        || !matches!(
            object.get("projection_code").and_then(Value::as_str),
            Some("captured" | "invalid_url_redacted" | "redaction_unavailable")
        )
        || object.get("body_captured").and_then(Value::as_bool) != Some(false)
        || object.get("untrusted").and_then(Value::as_bool) != Some(true)
        || !bounded_json_string(object.get("captured_at"), 64, false)
        || !bounded_json_string(object.get("request_id"), 128, false)
        || !bounded_json_string(object.get("url"), 16_384, false)
        || !optional_bounded_json_string(object.get("method"), 16)
        || !optional_bounded_json_string(object.get("mime_type"), 128)
        || !optional_bounded_json_string(object.get("resource_type"), 64)
        || !optional_u64(object.get("status"))
        || !optional_u64(object.get("duration_ms"))
        || !optional_u64(object.get("encoded_bytes"))
        || !optional_failure_code(object.get("failure_code"))
        || object
            .get("redacted_header_count")
            .and_then(Value::as_u64)
            .is_none()
        || object
            .get("ignored_header_count")
            .and_then(Value::as_u64)
            .is_none()
        || !valid_projected_headers(object.get("headers"))
    {
        return Err(NetworkLogError::new(NetworkLogErrorCode::UnsafeContent));
    }
    Ok(())
}

fn bounded_json_string(value: Option<&Value>, maximum: usize, allow_empty: bool) -> bool {
    value.and_then(Value::as_str).is_some_and(|value| {
        (allow_empty || !value.is_empty())
            && value.chars().count() <= maximum
            && !value.contains('\0')
    })
}

fn optional_bounded_json_string(value: Option<&Value>, maximum: usize) -> bool {
    matches!(value, Some(Value::Null)) || bounded_json_string(value, maximum, true)
}

fn optional_u64(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Null)) || value.and_then(Value::as_u64).is_some()
}

fn optional_failure_code(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Null))
        || matches!(
            value.and_then(Value::as_str),
            Some(
                "blocked_by_policy"
                    | "cancelled"
                    | "timeout"
                    | "connection_failed"
                    | "tls_failed"
                    | "other"
            )
        )
}

fn valid_projected_headers(value: Option<&Value>) -> bool {
    let Some(headers) = value.and_then(Value::as_object) else {
        return false;
    };
    headers.len() <= 8
        && headers.iter().all(|(name, value)| {
            matches!(
                name.as_str(),
                "location"
                    | "referer"
                    | "origin"
                    | "content-type"
                    | "content-length"
                    | "content-encoding"
                    | "cache-control"
            ) && bounded_json_string(Some(value), 1_024, true)
        })
}

#[cfg(unix)]
fn set_private_file(file: &File) -> Result<(), NetworkLogError> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|_| NetworkLogError::new(NetworkLogErrorCode::Io))
}

#[cfg(not(unix))]
fn set_private_file(_file: &File) -> Result<(), NetworkLogError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::login::network::{
        project_network_event, NetworkEventInput, NetworkHeaderRef, NetworkRedactionConfig,
        SafeNetworkEventKind,
    };

    fn safe_event(secret: &str) -> SafeNetworkEvent {
        let headers = [NetworkHeaderRef {
            name: "Authorization",
            value: secret,
        }];
        project_network_event(
            NetworkEventInput {
                kind: SafeNetworkEventKind::Request,
                request_id: "request-1",
                method: Some("POST"),
                url: &format!("https://example.test/path?token={secret}"),
                status: None,
                mime_type: None,
                resource_type: Some("Fetch"),
                headers: &headers,
                duration_ms: None,
                encoded_bytes: None,
                failure_code: None,
            },
            &NetworkRedactionConfig::new_trusted([secret]),
        )
    }

    #[test]
    fn writer_accepts_only_safe_projection_and_never_persists_secret() {
        let temp = tempfile::tempdir().unwrap();
        let store = NetworkLogStore::new(temp.path().join("network")).unwrap();
        let secret = "NETWORK_LOG_SECRET_SENTINEL";
        let path = store.append("session-1", &safe_event(secret)).unwrap();
        let bytes = fs::read_to_string(path).unwrap();
        assert!(!bytes.contains(secret));
        assert!(!bytes.to_ascii_lowercase().contains("authorization"));
        assert!(bytes.contains("REDACTED"));
        assert_eq!(bytes.lines().count(), 1);
    }

    #[test]
    fn rotation_is_bounded_and_session_paths_cannot_escape() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("network");
        let store = NetworkLogStore::with_limits(root.clone(), 1024, 2).unwrap();
        for _ in 0..20 {
            store.append("session-1", &safe_event("secret")).unwrap();
        }
        assert!(root.join("network-session-1.jsonl").exists());
        assert!(root.join("network-session-1.jsonl.1").exists());
        assert!(root.join("network-session-1.jsonl.2").exists());
        assert!(!root.join("network-session-1.jsonl.3").exists());
        assert_eq!(
            store
                .append("../escape", &safe_event("secret"))
                .unwrap_err()
                .code,
            NetworkLogErrorCode::InvalidSession
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_log_target_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("network");
        let store = NetworkLogStore::new(root.clone()).unwrap();
        let outside = temp.path().join("outside");
        fs::write(&outside, b"do not overwrite").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("network-session-1.jsonl")).unwrap();
        assert_eq!(
            store
                .append("session-1", &safe_event("secret"))
                .unwrap_err()
                .code,
            NetworkLogErrorCode::UnsafePath
        );
        assert_eq!(fs::read(&outside).unwrap(), b"do not overwrite");
    }

    #[test]
    fn reader_returns_a_hashed_bounded_recent_artifact() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("network");
        let store = NetworkLogStore::new(root.clone()).unwrap();
        for _ in 0..25 {
            store.append("session-1", &safe_event("secret")).unwrap();
        }

        let artifact = store.read_artifact("network-session-1").unwrap();

        assert!(artifact.artifact_id.starts_with(SNAPSHOT_PREFIX));
        validate_snapshot_id(&artifact.artifact_id).unwrap();
        assert_eq!(artifact.sha256.len(), 64);
        assert_eq!(
            artifact.byte_size,
            fs::metadata(&artifact.path).unwrap().len()
        );
        assert_eq!(artifact.event_count, 25);
        assert_eq!(artifact.recent.len(), 20);
        assert!(artifact.untrusted);
        assert_eq!(
            artifact.path.parent(),
            Some(root.canonicalize().unwrap().as_path())
        );
        assert_ne!(artifact.path, root.join("network-session-1.jsonl"));
        let serialized = serde_json::to_string(&artifact.recent).unwrap();
        assert!(!serialized.contains("secret"));
    }

    #[test]
    fn reader_creates_a_private_empty_artifact_and_bounds_recent_total_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("network");
        let store = NetworkLogStore::new(root.clone()).unwrap();
        let empty = store.read_artifact("network-empty-session").unwrap();
        assert!(empty.artifact_id.starts_with(SNAPSHOT_PREFIX));
        assert_eq!(empty.byte_size, 0);
        assert_eq!(empty.event_count, 0);
        assert!(empty.recent.is_empty());
        assert_eq!(store.read_snapshot(&empty.artifact_id).unwrap(), empty);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&empty.path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        let large_path = format!("/{}", "x".repeat(15_000));
        for index in 0..25 {
            let url = format!("https://example.test{large_path}?view={index}");
            let event = project_network_event(
                NetworkEventInput {
                    kind: SafeNetworkEventKind::Request,
                    request_id: "large-request",
                    method: Some("GET"),
                    url: &url,
                    status: None,
                    mime_type: None,
                    resource_type: Some("Fetch"),
                    headers: &[],
                    duration_ms: None,
                    encoded_bytes: None,
                    failure_code: None,
                },
                &NetworkRedactionConfig::new_trusted(["configured-but-absent"]),
            );
            store.append("large-session", &event).unwrap();
        }
        let artifact = store.read_artifact("network-large-session").unwrap();
        assert!(artifact.recent.len() < 20);
        assert!(serde_json::to_vec(&artifact.recent).unwrap().len() <= 256 * 1024);
    }

    #[test]
    fn network_artifact_bytes_stay_immutable_after_live_rotation() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("network");
        let store = NetworkLogStore::with_limits(root.clone(), 1024, 2).unwrap();
        store
            .append("session-1", &safe_event("NETWORK_SECRET"))
            .unwrap();
        let artifact = store.read_artifact("network-session-1").unwrap();
        let original = std::fs::read(&artifact.path).unwrap();

        for _ in 0..40 {
            store
                .append("session-1", &safe_event("NETWORK_SECRET"))
                .unwrap();
        }

        assert_ne!(artifact.path, root.join("network-session-1.jsonl"));
        assert_eq!(std::fs::read(&artifact.path).unwrap(), original);
        assert_eq!(hex::encode(Sha256::digest(&original)), artifact.sha256);
        assert_eq!(original.len() as u64, artifact.byte_size);
    }

    #[test]
    fn network_snapshot_retention_and_tamper_checks_preserve_live_logs() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("network");
        let store = NetworkLogStore::with_limits(root.clone(), 1024, 2).unwrap();
        for _ in 0..6 {
            store.append("session-1", &safe_event("secret")).unwrap();
        }
        assert!(root.join("network-session-1.jsonl.1").exists());
        let mut newest = None;
        for _ in 0..=MAX_SNAPSHOT_COUNT {
            newest = Some(store.read_artifact("network-session-1").unwrap());
        }
        let snapshots = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(SNAPSHOT_PREFIX)
            })
            .count();
        assert_eq!(snapshots, MAX_SNAPSHOT_COUNT);
        assert!(root.join("network-session-1.jsonl").exists());
        assert!(root.join("network-session-1.jsonl.1").exists());
        let newest = newest.unwrap();
        assert!(newest.path.exists());
        std::fs::write(&newest.path, b"{\"objectId\":\"raw\"}\n").unwrap();
        assert_eq!(
            store.read_snapshot(&newest.artifact_id).unwrap_err().code,
            NetworkLogErrorCode::UnsafeContent
        );
    }

    #[test]
    fn separate_network_store_instances_never_snapshot_a_partial_rotation() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("network");
        let reader = NetworkLogStore::with_limits(root.clone(), 1024, 2).unwrap();
        reader.append("session-1", &safe_event("secret")).unwrap();
        let writer_root = root.clone();
        let writer = std::thread::spawn(move || {
            let store = NetworkLogStore::with_limits(writer_root, 1024, 2).unwrap();
            for _ in 0..60 {
                store.append("session-1", &safe_event("secret")).unwrap();
            }
        });
        for _ in 0..16 {
            let artifact = reader.read_artifact("network-session-1").unwrap();
            assert_eq!(
                reader.read_snapshot(&artifact.artifact_id).unwrap(),
                artifact
            );
        }
        writer.join().unwrap();
    }

    #[test]
    fn reader_accepts_the_closed_paranoid_redaction_projection() {
        let temp = tempfile::tempdir().unwrap();
        let store = NetworkLogStore::new(temp.path().join("network")).unwrap();
        let event = project_network_event(
            NetworkEventInput {
                kind: SafeNetworkEventKind::Request,
                request_id: "private-request",
                method: Some("GET"),
                url: "https://example.test/private?unknown=secret",
                status: None,
                mime_type: None,
                resource_type: Some("Fetch"),
                headers: &[],
                duration_ms: None,
                encoded_bytes: None,
                failure_code: None,
            },
            &NetworkRedactionConfig::paranoid(),
        );
        store.append("session-1", &event).unwrap();
        let artifact = store.read_artifact("network-session-1").unwrap();
        assert_eq!(artifact.event_count, 1);
        assert_eq!(
            artifact.recent[0]["projection_code"],
            "redaction_unavailable"
        );
    }

    #[cfg(unix)]
    #[test]
    fn reader_rejects_symlink_and_tampered_schema() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("network");
        let store = NetworkLogStore::new(root.clone()).unwrap();
        store.append("session-1", &safe_event("secret")).unwrap();
        let path = root.join("network-session-1.jsonl");
        fs::write(&path, b"{\"objectId\":\"raw-handle\"}\n").unwrap();
        assert_eq!(
            store.read_artifact("network-session-1").unwrap_err().code,
            NetworkLogErrorCode::UnsafeContent
        );

        fs::remove_file(&path).unwrap();
        let outside = temp.path().join("outside.jsonl");
        fs::write(&outside, b"{}\n").unwrap();
        std::os::unix::fs::symlink(&outside, &path).unwrap();
        assert_eq!(
            store.read_artifact("network-session-1").unwrap_err().code,
            NetworkLogErrorCode::UnsafePath
        );
    }
}
