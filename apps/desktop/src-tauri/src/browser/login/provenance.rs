use super::policy::NormalizedOrigin;
use super::profile::TrustedWorkspaceIdentity;
use fs2::FileExt;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

const SCHEMA_VERSION: u32 = 1;
const MAX_ACTOR_ID_BYTES: usize = 256;
const MAX_ENTRIES: usize = 4_096;
const MAX_LEDGER_BYTES: u64 = 2 * 1024 * 1024;
const INTEGRITY_KEY_BYTES: usize = 32;
const KEY_DOMAIN: &[u8] = b"ccem-login-browser-provenance-key-v1";
const ORIGIN_DOMAIN: &[u8] = b"ccem-login-browser-provenance-origin-v1";

/// Opaque authority derived only from app-owned workspace identity and a bounded actor id.
///
/// The raw components are deliberately discarded after hashing. Session, profile, and handoff
/// ids are deliberately absent so taint remains monotonic across those lifecycle boundaries.
#[derive(Clone, PartialEq, Eq)]
pub(super) struct ProvenanceKey([u8; 32]);

impl ProvenanceKey {
    pub(super) fn new_trusted(
        workspace: &TrustedWorkspaceIdentity,
        actor_id: &str,
    ) -> Result<Self, ProvenanceError> {
        if actor_id.is_empty()
            || actor_id.trim() != actor_id
            || actor_id.len() > MAX_ACTOR_ID_BYTES
            || actor_id.chars().any(char::is_control)
        {
            return Err(ProvenanceError::InvalidActorId);
        }
        Ok(Self(length_prefixed_digest(
            KEY_DOMAIN,
            &[workspace.as_str().as_bytes(), actor_id.as_bytes()],
        )))
    }

    fn hex(&self) -> String {
        hex::encode(self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct OriginFingerprint([u8; 32]);

impl OriginFingerprint {
    fn new(origin: &NormalizedOrigin) -> Self {
        Self(length_prefixed_digest(
            ORIGIN_DOMAIN,
            &[origin.as_serialized_origin().as_bytes()],
        ))
    }

    fn from_hex(value: &str) -> Result<Self, ProvenanceError> {
        if !is_sha256(value) {
            return Err(ProvenanceError::Corrupt);
        }
        let bytes = hex::decode(value).map_err(|_| ProvenanceError::Corrupt)?;
        let mut digest = [0_u8; 32];
        digest.copy_from_slice(&bytes);
        Ok(Self(digest))
    }

    fn hex(&self) -> String {
        hex::encode(self.0)
    }

    pub(super) fn matches(&self, origin: &NormalizedOrigin) -> bool {
        constant_time_equal(&self.0, &Self::new(origin).0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ProvenanceState {
    Untainted,
    SingleOrigin(OriginFingerprint),
    Mixed,
}

/// A write-specific view that prevents callers from having to compare origin fingerprints.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ProvenanceWriteState {
    Untainted,
    SingleOriginSame,
    SingleOriginDifferent,
    Mixed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ProvenanceError {
    InvalidRoot,
    InvalidActorId,
    UnsafePath,
    Corrupt,
    Full,
    Io,
}

impl fmt::Display for ProvenanceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidRoot => "Login Browser provenance root is invalid.",
            Self::InvalidActorId => "Login Browser provenance actor id is invalid.",
            Self::UnsafePath => "Login Browser provenance storage path is unsafe.",
            Self::Corrupt => "Login Browser provenance state failed integrity validation.",
            Self::Full => "Login Browser provenance ledger reached its safety limit.",
            Self::Io => "Login Browser provenance state could not be persisted.",
        })
    }
}

impl std::error::Error for ProvenanceError {}

#[derive(Clone)]
pub(super) struct ProvenanceLedger {
    root: PathBuf,
    ledger_path: PathBuf,
    registry_lock_path: PathBuf,
    operation_locks_root: PathBuf,
    integrity_key: [u8; INTEGRITY_KEY_BYTES],
}

impl ProvenanceLedger {
    pub(super) fn new(root: PathBuf) -> Result<Self, ProvenanceError> {
        if !root.is_absolute() || root.as_os_str().is_empty() {
            return Err(ProvenanceError::InvalidRoot);
        }
        ensure_private_directory(&root)?;
        let operation_locks_root = root.join("operation-locks");
        ensure_private_directory(&operation_locks_root)?;
        let ledger_path = root.join("provenance.json");
        let integrity_path = root.join("integrity.key");
        let registry_lock_path = root.join("provenance.lock");
        let initialization_lock = acquire_lock(&registry_lock_path)?;

        let ledger_exists = regular_file_presence(&ledger_path)?;
        let integrity_exists = regular_file_presence(&integrity_path)?;
        let integrity_key = match (ledger_exists, integrity_exists) {
            (false, false) => {
                let mut key = [0_u8; INTEGRITY_KEY_BYTES];
                OsRng.fill_bytes(&mut key);
                write_new_private_file(&integrity_path, &key)?;
                sync_directory(&root)?;
                key
            }
            (true, true) => read_integrity_key(&integrity_path)?,
            _ => return Err(ProvenanceError::Corrupt),
        };

        let ledger = Self {
            root,
            ledger_path,
            registry_lock_path,
            operation_locks_root,
            integrity_key,
        };
        if ledger_exists {
            ledger.load_entries_locked()?;
        } else {
            ledger.write_entries_locked(&BTreeMap::new())?;
        }
        drop(initialization_lock);
        Ok(ledger)
    }

    /// Serialize a complete read/effect/record operation for this identity.
    ///
    /// The stable shard lock is held for the callback lifetime across processes. Colliding keys
    /// may serialize unnecessarily, but the bounded 256-file lock set prevents attacker-driven
    /// lock-file growth while guaranteeing that the same key never races itself.
    pub(super) fn with_serialized_operation<T, F>(
        &self,
        key: &ProvenanceKey,
        operation: F,
    ) -> Result<T, ProvenanceError>
    where
        F: FnOnce(&ProvenanceOperation<'_>) -> T,
    {
        let lock_path = self
            .operation_locks_root
            .join(format!("operation-{:02x}.lock", key.0[0]));
        let operation_lock = acquire_lock(&lock_path)?;
        let result = operation(&ProvenanceOperation { ledger: self, key });
        drop(operation_lock);
        Ok(result)
    }

    fn state(&self, key: &ProvenanceKey) -> Result<ProvenanceState, ProvenanceError> {
        let registry_lock = acquire_lock(&self.registry_lock_path)?;
        let entries = self.load_entries_locked()?;
        let state = entries
            .get(&key.hex())
            .map(PersistedState::to_state)
            .transpose()?
            .unwrap_or(ProvenanceState::Untainted);
        drop(registry_lock);
        Ok(state)
    }

    fn record_read(
        &self,
        key: &ProvenanceKey,
        origin: &NormalizedOrigin,
    ) -> Result<ProvenanceState, ProvenanceError> {
        let registry_lock = acquire_lock(&self.registry_lock_path)?;
        let mut entries = self.load_entries_locked()?;
        let key_hex = key.hex();
        let origin = OriginFingerprint::new(origin);
        let next = match entries.get(&key_hex) {
            None => {
                if entries.len() >= MAX_ENTRIES {
                    return Err(ProvenanceError::Full);
                }
                PersistedState::SingleOrigin {
                    origin_sha256: origin.hex(),
                }
            }
            Some(PersistedState::SingleOrigin { origin_sha256 })
                if OriginFingerprint::from_hex(origin_sha256)? == origin =>
            {
                return Ok(ProvenanceState::SingleOrigin(origin));
            }
            Some(PersistedState::SingleOrigin { .. }) => PersistedState::Mixed,
            Some(PersistedState::Mixed) => return Ok(ProvenanceState::Mixed),
        };
        entries.insert(key_hex, next.clone());
        self.write_entries_locked(&entries)?;
        drop(registry_lock);
        next.to_state()
    }

    fn load_entries_locked(&self) -> Result<BTreeMap<String, PersistedState>, ProvenanceError> {
        let bytes = read_bounded_regular_file(&self.ledger_path, MAX_LEDGER_BYTES)?;
        let envelope: PersistedLedger =
            serde_json::from_slice(&bytes).map_err(|_| ProvenanceError::Corrupt)?;
        validate_entries(envelope.schema_version, &envelope.entries)?;
        if !is_sha256(&envelope.integrity_sha256) {
            return Err(ProvenanceError::Corrupt);
        }
        let payload = serialize_payload(envelope.schema_version, &envelope.entries)?;
        let expected = hmac_sha256(&self.integrity_key, &payload);
        let actual =
            hex::decode(&envelope.integrity_sha256).map_err(|_| ProvenanceError::Corrupt)?;
        if !constant_time_equal(&expected, &actual) {
            return Err(ProvenanceError::Corrupt);
        }
        Ok(envelope.entries)
    }

    fn write_entries_locked(
        &self,
        entries: &BTreeMap<String, PersistedState>,
    ) -> Result<(), ProvenanceError> {
        validate_entries(SCHEMA_VERSION, entries)?;
        let payload = serialize_payload(SCHEMA_VERSION, entries)?;
        let envelope = PersistedLedger {
            schema_version: SCHEMA_VERSION,
            entries: entries.clone(),
            integrity_sha256: hex::encode(hmac_sha256(&self.integrity_key, &payload)),
        };
        let bytes = serde_json::to_vec(&envelope).map_err(|_| ProvenanceError::Corrupt)?;
        if bytes.len() as u64 > MAX_LEDGER_BYTES {
            return Err(ProvenanceError::Full);
        }
        write_private_atomic(&self.root, &self.ledger_path, &bytes)
    }
}

pub(super) struct ProvenanceOperation<'a> {
    ledger: &'a ProvenanceLedger,
    key: &'a ProvenanceKey,
}

impl ProvenanceOperation<'_> {
    pub(super) fn state(&self) -> Result<ProvenanceState, ProvenanceError> {
        self.ledger.state(self.key)
    }

    pub(super) fn write_state(
        &self,
        target: &NormalizedOrigin,
    ) -> Result<ProvenanceWriteState, ProvenanceError> {
        Ok(match self.state()? {
            ProvenanceState::Untainted => ProvenanceWriteState::Untainted,
            ProvenanceState::SingleOrigin(origin) if origin.matches(target) => {
                ProvenanceWriteState::SingleOriginSame
            }
            ProvenanceState::SingleOrigin(_) => ProvenanceWriteState::SingleOriginDifferent,
            ProvenanceState::Mixed => ProvenanceWriteState::Mixed,
        })
    }

    /// Call only after a page-derived read has completed successfully.
    pub(super) fn record_successful_page_read(
        &self,
        origin: &NormalizedOrigin,
    ) -> Result<ProvenanceState, ProvenanceError> {
        self.ledger.record_read(self.key, origin)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedLedger {
    schema_version: u32,
    entries: BTreeMap<String, PersistedState>,
    integrity_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
enum PersistedState {
    SingleOrigin { origin_sha256: String },
    Mixed,
}

impl PersistedState {
    fn to_state(&self) -> Result<ProvenanceState, ProvenanceError> {
        match self {
            Self::SingleOrigin { origin_sha256 } => Ok(ProvenanceState::SingleOrigin(
                OriginFingerprint::from_hex(origin_sha256)?,
            )),
            Self::Mixed => Ok(ProvenanceState::Mixed),
        }
    }
}

#[derive(Serialize)]
struct PersistedPayload<'a> {
    schema_version: u32,
    entries: &'a BTreeMap<String, PersistedState>,
}

fn serialize_payload(
    schema_version: u32,
    entries: &BTreeMap<String, PersistedState>,
) -> Result<Vec<u8>, ProvenanceError> {
    serde_json::to_vec(&PersistedPayload {
        schema_version,
        entries,
    })
    .map_err(|_| ProvenanceError::Corrupt)
}

fn validate_entries(
    schema_version: u32,
    entries: &BTreeMap<String, PersistedState>,
) -> Result<(), ProvenanceError> {
    if schema_version != SCHEMA_VERSION || entries.len() > MAX_ENTRIES {
        return Err(ProvenanceError::Corrupt);
    }
    for (key, state) in entries {
        if !is_sha256(key)
            || matches!(
                state,
                PersistedState::SingleOrigin { origin_sha256 } if !is_sha256(origin_sha256)
            )
        {
            return Err(ProvenanceError::Corrupt);
        }
    }
    Ok(())
}

fn length_prefixed_digest(domain: &[u8], components: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update((domain.len() as u64).to_be_bytes());
    hasher.update(domain);
    for component in components {
        hasher.update((component.len() as u64).to_be_bytes());
        hasher.update(component);
    }
    hasher.finalize().into()
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

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn regular_file_presence(path: &Path) -> Result<bool, ProvenanceError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() && !metadata.file_type().is_symlink() => {
            Ok(true)
        }
        Ok(_) => Err(ProvenanceError::UnsafePath),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(ProvenanceError::Io),
    }
}

fn ensure_private_directory(path: &Path) -> Result<(), ProvenanceError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(ProvenanceError::UnsafePath)
        }
        Ok(metadata) if !metadata.file_type().is_dir() => return Err(ProvenanceError::UnsafePath),
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(|_| ProvenanceError::Io)?;
        }
        Err(_) => return Err(ProvenanceError::Io),
    }
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|_| ProvenanceError::Io)?;
    Ok(())
}

struct FileLock(File);

impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

fn acquire_lock(path: &Path) -> Result<FileLock, ProvenanceError> {
    if regular_file_presence(path)? {
        // Presence validation is repeated by O_NOFOLLOW at open time on Unix.
    }
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true).truncate(false);
    #[cfg(unix)]
    {
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(|_| ProvenanceError::Io)?;
    set_private_file_permissions(path)?;
    file.lock_exclusive().map_err(|_| ProvenanceError::Io)?;
    Ok(FileLock(file))
}

fn read_integrity_key(path: &Path) -> Result<[u8; INTEGRITY_KEY_BYTES], ProvenanceError> {
    let bytes = read_bounded_regular_file(path, INTEGRITY_KEY_BYTES as u64)?;
    if bytes.len() != INTEGRITY_KEY_BYTES {
        return Err(ProvenanceError::Corrupt);
    }
    let mut key = [0_u8; INTEGRITY_KEY_BYTES];
    key.copy_from_slice(&bytes);
    Ok(key)
}

fn read_bounded_regular_file(path: &Path, max: u64) -> Result<Vec<u8>, ProvenanceError> {
    if !regular_file_presence(path)? {
        return Err(ProvenanceError::Corrupt);
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    let mut file = options.open(path).map_err(|_| ProvenanceError::Io)?;
    let metadata = file.metadata().map_err(|_| ProvenanceError::Io)?;
    if !metadata.is_file() || metadata.len() > max {
        return Err(ProvenanceError::Corrupt);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|_| ProvenanceError::Io)?;
    if bytes.len() as u64 != metadata.len() || bytes.len() as u64 > max {
        return Err(ProvenanceError::Corrupt);
    }
    Ok(bytes)
}

fn write_new_private_file(path: &Path, bytes: &[u8]) -> Result<(), ProvenanceError> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(path).map_err(|_| ProvenanceError::Io)?;
    file.write_all(bytes).map_err(|_| ProvenanceError::Io)?;
    file.sync_all().map_err(|_| ProvenanceError::Io)?;
    set_private_file_permissions(path)
}

fn write_private_atomic(root: &Path, target: &Path, bytes: &[u8]) -> Result<(), ProvenanceError> {
    let mut nonce = [0_u8; 8];
    OsRng.fill_bytes(&mut nonce);
    let temporary = root.join(format!(
        ".provenance.{}.{}.tmp",
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
fn set_private_file_permissions(path: &Path) -> Result<(), ProvenanceError> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|_| ProvenanceError::Io)
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) -> Result<(), ProvenanceError> {
    Ok(())
}

#[cfg(unix)]
fn atomic_replace(source: &Path, target: &Path) -> Result<(), ProvenanceError> {
    fs::rename(source, target).map_err(|_| ProvenanceError::Io)
}

#[cfg(windows)]
fn atomic_replace(source: &Path, target: &Path) -> Result<(), ProvenanceError> {
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
    // SAFETY: both buffers are valid NUL-terminated UTF-16 for the duration of this call.
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(ProvenanceError::Io)
    } else {
        Ok(())
    }
}

#[cfg(all(not(unix), not(windows)))]
fn atomic_replace(source: &Path, target: &Path) -> Result<(), ProvenanceError> {
    fs::rename(source, target).map_err(|_| ProvenanceError::Io)
}

fn sync_directory(path: &Path) -> Result<(), ProvenanceError> {
    #[cfg(unix)]
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| ProvenanceError::Io)?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::login::policy::NormalizedOrigin;
    use crate::browser::login::profile::TrustedWorkspaceIdentity;

    fn workspace(value: &str) -> TrustedWorkspaceIdentity {
        TrustedWorkspaceIdentity::from_trusted_store(value).unwrap()
    }

    fn origin(value: &str) -> NormalizedOrigin {
        NormalizedOrigin::parse(value).unwrap()
    }

    #[test]
    fn page_reads_are_monotonic_across_reopened_ledgers() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("provenance");
        let key = ProvenanceKey::new_trusted(&workspace("workspace-one"), "actor-one").unwrap();
        let first = ProvenanceLedger::new(root.clone()).unwrap();
        first
            .with_serialized_operation(&key, |operation| {
                assert_eq!(operation.state()?, ProvenanceState::Untainted);
                assert!(matches!(
                    operation.record_successful_page_read(&origin("https://a.example/path"))?,
                    ProvenanceState::SingleOrigin(_)
                ));
                assert!(matches!(
                    operation.record_successful_page_read(&origin("https://a.example/other"))?,
                    ProvenanceState::SingleOrigin(_)
                ));
                assert_eq!(
                    operation.record_successful_page_read(&origin("https://b.example"))?,
                    ProvenanceState::Mixed
                );
                Ok::<(), ProvenanceError>(())
            })
            .unwrap()
            .unwrap();

        let reopened = ProvenanceLedger::new(root).unwrap();
        reopened
            .with_serialized_operation(&key, |operation| {
                assert_eq!(operation.state()?, ProvenanceState::Mixed);
                assert_eq!(
                    operation.write_state(&origin("https://a.example"))?,
                    ProvenanceWriteState::Mixed
                );
                Ok::<(), ProvenanceError>(())
            })
            .unwrap()
            .unwrap();
    }

    #[test]
    fn keys_are_length_prefixed_and_raw_identity_never_reaches_disk() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("provenance");
        let left = ProvenanceKey::new_trusted(&workspace("ab"), "c").unwrap();
        let right = ProvenanceKey::new_trusted(&workspace("a"), "bc").unwrap();
        assert_ne!(
            left.0, right.0,
            "component boundaries must affect the digest"
        );
        assert!(matches!(
            ProvenanceKey::new_trusted(&workspace("workspace"), " actor"),
            Err(ProvenanceError::InvalidActorId)
        ));
        assert!(matches!(
            ProvenanceKey::new_trusted(&workspace("workspace"), &"a".repeat(257)),
            Err(ProvenanceError::InvalidActorId)
        ));

        let raw_workspace = "workspace-raw-marker-7f3d5f5e";
        let raw_actor = "actor-raw-marker-8a2c4e6b";
        let disk_key = ProvenanceKey::new_trusted(&workspace(raw_workspace), raw_actor).unwrap();
        let ledger = ProvenanceLedger::new(root.clone()).unwrap();
        ledger
            .with_serialized_operation(&disk_key, |operation| {
                operation.record_successful_page_read(&origin("https://secret.example/path"))
            })
            .unwrap()
            .unwrap();
        let persisted = fs::read(root.join("provenance.json")).unwrap();
        let persisted = String::from_utf8(persisted).unwrap();
        assert!(!persisted.contains(raw_workspace));
        assert!(!persisted.contains(raw_actor));
        assert!(!persisted.contains("secret.example"));
        assert!(!persisted.contains("https://"));
        assert!(persisted.contains(&disk_key.hex()));
    }

    #[test]
    fn write_view_distinguishes_same_origin_from_cross_origin() {
        let temp = tempfile::tempdir().unwrap();
        let ledger = ProvenanceLedger::new(temp.path().join("provenance")).unwrap();
        let key = ProvenanceKey::new_trusted(&workspace("workspace"), "actor").unwrap();
        ledger
            .with_serialized_operation(&key, |operation| {
                assert_eq!(
                    operation.write_state(&origin("https://a.example"))?,
                    ProvenanceWriteState::Untainted
                );
                operation.record_successful_page_read(&origin("https://a.example/read"))?;
                assert_eq!(
                    operation.write_state(&origin("https://a.example/write"))?,
                    ProvenanceWriteState::SingleOriginSame
                );
                assert_eq!(
                    operation.write_state(&origin("https://b.example"))?,
                    ProvenanceWriteState::SingleOriginDifferent
                );
                Ok::<(), ProvenanceError>(())
            })
            .unwrap()
            .unwrap();
    }

    #[test]
    fn cross_instance_operation_seam_prevents_lost_taint() {
        use std::sync::mpsc;
        use std::time::Duration;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("provenance");
        let first = ProvenanceLedger::new(root.clone()).unwrap();
        let second = ProvenanceLedger::new(root).unwrap();
        let key = ProvenanceKey::new_trusted(&workspace("workspace"), "actor").unwrap();
        let first_key = key.clone();
        let second_key = key.clone();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (second_entered_tx, second_entered_rx) = mpsc::channel();

        let first_thread = std::thread::spawn(move || {
            first
                .with_serialized_operation(&first_key, |operation| {
                    assert_eq!(operation.state().unwrap(), ProvenanceState::Untainted);
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    operation
                        .record_successful_page_read(&origin("https://a.example"))
                        .unwrap();
                })
                .unwrap();
        });
        entered_rx.recv().unwrap();
        let second_thread = std::thread::spawn(move || {
            second
                .with_serialized_operation(&second_key, |operation| {
                    second_entered_tx.send(()).unwrap();
                    assert!(matches!(
                        operation.state().unwrap(),
                        ProvenanceState::SingleOrigin(_)
                    ));
                    operation
                        .record_successful_page_read(&origin("https://b.example"))
                        .unwrap();
                })
                .unwrap();
        });
        assert!(second_entered_rx
            .recv_timeout(Duration::from_millis(100))
            .is_err());
        release_tx.send(()).unwrap();
        first_thread.join().unwrap();
        second_entered_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        second_thread.join().unwrap();

        let ledger = ProvenanceLedger::new(temp.path().join("provenance")).unwrap();
        assert_eq!(
            ledger
                .with_serialized_operation(&key, |operation| operation.state())
                .unwrap()
                .unwrap(),
            ProvenanceState::Mixed
        );
    }

    #[test]
    fn capacity_failure_preserves_existing_taint() {
        let temp = tempfile::tempdir().unwrap();
        let ledger = ProvenanceLedger::new(temp.path().join("provenance")).unwrap();
        let existing =
            ProvenanceKey::new_trusted(&workspace("workspace"), "existing-actor").unwrap();
        ledger
            .with_serialized_operation(&existing, |operation| {
                operation.record_successful_page_read(&origin("https://a.example"))
            })
            .unwrap()
            .unwrap();

        let registry_lock = acquire_lock(&ledger.registry_lock_path).unwrap();
        let mut entries = ledger.load_entries_locked().unwrap();
        for value in 0_u64.. {
            if entries.len() == MAX_ENTRIES {
                break;
            }
            entries.insert(format!("{value:064x}"), PersistedState::Mixed);
        }
        ledger.write_entries_locked(&entries).unwrap();
        drop(registry_lock);

        let newcomer = ProvenanceKey::new_trusted(&workspace("workspace"), "new-actor").unwrap();
        assert_eq!(
            ledger
                .with_serialized_operation(&newcomer, |operation| {
                    operation.record_successful_page_read(&origin("https://new.example"))
                })
                .unwrap(),
            Err(ProvenanceError::Full)
        );
        assert!(matches!(
            ledger
                .with_serialized_operation(&existing, |operation| operation.state())
                .unwrap()
                .unwrap(),
            ProvenanceState::SingleOrigin(_)
        ));
    }

    #[test]
    fn authenticated_state_tampering_and_deletion_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("provenance");
        let ledger = ProvenanceLedger::new(root.clone()).unwrap();
        let key = ProvenanceKey::new_trusted(&workspace("workspace"), "actor").unwrap();
        ledger
            .with_serialized_operation(&key, |operation| {
                operation.record_successful_page_read(&origin("https://a.example"))
            })
            .unwrap()
            .unwrap();

        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join("provenance.json")).unwrap()).unwrap();
        value["entries"][key.hex()]["origin_sha256"] = serde_json::Value::String("0".repeat(64));
        fs::write(
            root.join("provenance.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
        assert_eq!(
            ledger
                .with_serialized_operation(&key, |operation| operation.state())
                .unwrap(),
            Err(ProvenanceError::Corrupt)
        );

        fs::remove_file(root.join("provenance.json")).unwrap();
        assert!(matches!(
            ProvenanceLedger::new(root),
            Err(ProvenanceError::Corrupt)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn private_permissions_and_symlink_replacement_are_enforced() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("provenance");
        ProvenanceLedger::new(root.clone()).unwrap();
        assert_eq!(
            fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(root.join("provenance.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(root.join("integrity.key"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );

        let real = root.join("real-provenance.json");
        fs::rename(root.join("provenance.json"), &real).unwrap();
        symlink(&real, root.join("provenance.json")).unwrap();
        assert!(matches!(
            ProvenanceLedger::new(root),
            Err(ProvenanceError::UnsafePath)
        ));
    }
}
