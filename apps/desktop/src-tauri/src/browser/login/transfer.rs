use super::policy::BrowserGrantBinding;
use chrono::Utc;
use rand::{rngs::OsRng, RngCore};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const MAX_APPROVED_ROOTS: usize = 32;
const MAX_UPLOAD_BYTES: u64 = 512 * 1024 * 1024;
const MAX_DOWNLOAD_NAME_CHARS: usize = 160;
const MAX_ACTIVE_CAPABILITIES: usize = 256;
const DEFAULT_CAPABILITY_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum TransferPolicyCode {
    Allowed,
    InvalidRoot,
    PathOutsideApprovedRoots,
    UnsafePath,
    FileMissing,
    FileTooLarge,
    HandleUnknown,
    BindingMismatch,
    CapabilityExpired,
    CapabilityConsumed,
    DownloadBlocked,
    QuarantineUnavailable,
    Io,
}

impl TransferPolicyCode {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Allowed => "allowed",
            Self::InvalidRoot => "invalid_root",
            Self::PathOutsideApprovedRoots => "path_outside_approved_roots",
            Self::UnsafePath => "unsafe_path",
            Self::FileMissing => "file_missing",
            Self::FileTooLarge => "file_too_large",
            Self::HandleUnknown => "handle_unknown",
            Self::BindingMismatch => "binding_mismatch",
            Self::CapabilityExpired => "capability_expired",
            Self::CapabilityConsumed => "capability_consumed",
            Self::DownloadBlocked => "download_blocked",
            Self::QuarantineUnavailable => "quarantine_unavailable",
            Self::Io => "io",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct TransferPolicyError {
    pub(super) code: TransferPolicyCode,
}

impl TransferPolicyError {
    fn new(code: TransferPolicyCode) -> Self {
        Self { code }
    }
}

impl fmt::Display for TransferPolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "browser transfer denied: {}", self.code.as_str())
    }
}

impl std::error::Error for TransferPolicyError {}

/// The only upload reference exposed to the semantic Agent surface.
///
/// It contains no filesystem path and cannot be constructed through serde. The trusted desktop
/// picker mints it only after canonical-path and file-identity checks succeed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(super) struct OpaqueUploadHandle {
    handle: String,
    byte_size: u64,
    sha256: String,
}

impl OpaqueUploadHandle {
    pub(super) fn as_str(&self) -> &str {
        &self.handle
    }

    pub(super) fn byte_size(&self) -> u64 {
        self.byte_size
    }

    pub(super) fn sha256(&self) -> &str {
        &self.sha256
    }
}

#[derive(Debug)]
struct UploadCapability {
    binding: BrowserGrantBinding,
    canonical_path: PathBuf,
    byte_size: u64,
    sha256: String,
    expires_at: Instant,
    consumed: bool,
}

/// Internal resolution result. This type never crosses IPC or the semantic backend result.
#[derive(Debug)]
pub(super) struct ApprovedUploadFile {
    canonical_path: PathBuf,
    byte_size: u64,
    sha256: String,
}

impl ApprovedUploadFile {
    pub(super) fn path(&self) -> &Path {
        &self.canonical_path
    }

    pub(super) fn byte_size(&self) -> u64 {
        self.byte_size
    }

    pub(super) fn sha256(&self) -> &str {
        &self.sha256
    }
}

#[derive(Debug)]
pub(super) struct UploadApprovalStore {
    approved_roots: Vec<PathBuf>,
    capabilities: Mutex<BTreeMap<String, UploadCapability>>,
}

impl UploadApprovalStore {
    /// `roots` must come from trusted workspace state, never page or Agent input.
    pub(super) fn from_trusted_workspace_roots<I>(roots: I) -> Result<Self, TransferPolicyError>
    where
        I: IntoIterator<Item = PathBuf>,
    {
        let mut approved_roots = Vec::new();
        for root in roots.into_iter().take(MAX_APPROVED_ROOTS + 1) {
            if approved_roots.len() == MAX_APPROVED_ROOTS {
                return Err(TransferPolicyError::new(TransferPolicyCode::InvalidRoot));
            }
            let metadata = fs::symlink_metadata(&root)
                .map_err(|_| TransferPolicyError::new(TransferPolicyCode::InvalidRoot))?;
            if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
                return Err(TransferPolicyError::new(TransferPolicyCode::InvalidRoot));
            }
            let canonical = root
                .canonicalize()
                .map_err(|_| TransferPolicyError::new(TransferPolicyCode::InvalidRoot))?;
            if !approved_roots.contains(&canonical) {
                approved_roots.push(canonical);
            }
        }
        if approved_roots.is_empty() {
            return Err(TransferPolicyError::new(TransferPolicyCode::InvalidRoot));
        }
        Ok(Self {
            approved_roots,
            capabilities: Mutex::new(BTreeMap::new()),
        })
    }

    /// Called only after a trusted native file picker returns a user-selected path.
    pub(super) fn approve_from_trusted_ui(
        &self,
        binding: BrowserGrantBinding,
        selected_path: &Path,
    ) -> Result<OpaqueUploadHandle, TransferPolicyError> {
        let metadata = fs::symlink_metadata(selected_path)
            .map_err(|_| TransferPolicyError::new(TransferPolicyCode::FileMissing))?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err(TransferPolicyError::new(TransferPolicyCode::UnsafePath));
        }
        if metadata.len() > MAX_UPLOAD_BYTES {
            return Err(TransferPolicyError::new(TransferPolicyCode::FileTooLarge));
        }
        let canonical_path = selected_path
            .canonicalize()
            .map_err(|_| TransferPolicyError::new(TransferPolicyCode::UnsafePath))?;
        if !self
            .approved_roots
            .iter()
            .any(|root| canonical_path.starts_with(root))
        {
            return Err(TransferPolicyError::new(
                TransferPolicyCode::PathOutsideApprovedRoots,
            ));
        }
        reject_symlink_ancestors(&canonical_path, &self.approved_roots)?;
        let (byte_size, sha256) = hash_regular_file(&canonical_path, MAX_UPLOAD_BYTES)?;
        if byte_size != metadata.len() {
            return Err(TransferPolicyError::new(TransferPolicyCode::UnsafePath));
        }

        let handle = random_opaque_id("upload");
        let public = OpaqueUploadHandle {
            handle: handle.clone(),
            byte_size,
            sha256: sha256.clone(),
        };
        let mut capabilities = self
            .capabilities
            .lock()
            .map_err(|_| TransferPolicyError::new(TransferPolicyCode::Io))?;
        capabilities.retain(|_, capability| capability.expires_at > Instant::now());
        if capabilities.len() >= MAX_ACTIVE_CAPABILITIES {
            return Err(TransferPolicyError::new(TransferPolicyCode::Io));
        }
        capabilities.insert(
            handle,
            UploadCapability {
                binding,
                canonical_path,
                byte_size,
                sha256,
                expires_at: Instant::now() + DEFAULT_CAPABILITY_TTL,
                consumed: false,
            },
        );
        Ok(public)
    }

    /// Resolves and consumes an upload capability immediately before the backend sets files.
    pub(super) fn resolve_once(
        &self,
        binding: &BrowserGrantBinding,
        opaque_handle: &str,
    ) -> Result<ApprovedUploadFile, TransferPolicyError> {
        let mut capabilities = self
            .capabilities
            .lock()
            .map_err(|_| TransferPolicyError::new(TransferPolicyCode::Io))?;
        let capability = capabilities
            .get_mut(opaque_handle)
            .ok_or_else(|| TransferPolicyError::new(TransferPolicyCode::HandleUnknown))?;
        if !bindings_match(&capability.binding, binding) {
            return Err(TransferPolicyError::new(
                TransferPolicyCode::BindingMismatch,
            ));
        }
        if capability.expires_at <= Instant::now() {
            return Err(TransferPolicyError::new(
                TransferPolicyCode::CapabilityExpired,
            ));
        }
        if capability.consumed {
            return Err(TransferPolicyError::new(
                TransferPolicyCode::CapabilityConsumed,
            ));
        }
        let (byte_size, sha256) = hash_regular_file(&capability.canonical_path, MAX_UPLOAD_BYTES)?;
        if byte_size != capability.byte_size || sha256 != capability.sha256 {
            return Err(TransferPolicyError::new(TransferPolicyCode::UnsafePath));
        }
        capability.consumed = true;
        Ok(ApprovedUploadFile {
            canonical_path: capability.canonical_path.clone(),
            byte_size,
            sha256,
        })
    }
}

/// Non-serializable one-shot permission minted by the trusted prompt UI.
pub(super) struct TrustedDownloadAuthorization {
    binding: BrowserGrantBinding,
    authorization_id: String,
    expires_at: Instant,
    consumed: bool,
}

impl TrustedDownloadAuthorization {
    pub(super) fn from_trusted_ui(binding: BrowserGrantBinding) -> Self {
        Self {
            binding,
            authorization_id: random_opaque_id("download"),
            expires_at: Instant::now() + DEFAULT_CAPABILITY_TTL,
            consumed: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct QuarantinedDownload {
    pub(super) download_id: String,
    pub(super) display_name: String,
    pub(super) created_at: String,
    pub(super) auto_open: bool,
    #[serde(skip)]
    destination: PathBuf,
}

impl QuarantinedDownload {
    pub(super) fn destination_for_backend(&self) -> &Path {
        &self.destination
    }
}

#[derive(Debug, Clone)]
pub(super) struct DownloadQuarantine {
    root: PathBuf,
}

impl DownloadQuarantine {
    pub(super) fn new(root: PathBuf) -> Result<Self, TransferPolicyError> {
        ensure_private_directory(&root)?;
        Ok(Self { root })
    }

    /// No authorization means deny before any destination is allocated or browser effect occurs.
    pub(super) fn allocate_after_trusted_prompt(
        &self,
        binding: &BrowserGrantBinding,
        suggested_name: &str,
        authorization: Option<&mut TrustedDownloadAuthorization>,
    ) -> Result<QuarantinedDownload, TransferPolicyError> {
        let authorization = authorization
            .ok_or_else(|| TransferPolicyError::new(TransferPolicyCode::DownloadBlocked))?;
        if !bindings_match(&authorization.binding, binding) {
            return Err(TransferPolicyError::new(
                TransferPolicyCode::BindingMismatch,
            ));
        }
        if authorization.expires_at <= Instant::now() {
            return Err(TransferPolicyError::new(
                TransferPolicyCode::CapabilityExpired,
            ));
        }
        if authorization.consumed {
            return Err(TransferPolicyError::new(
                TransferPolicyCode::CapabilityConsumed,
            ));
        }
        ensure_private_directory(&self.root)?;
        let download_id = random_opaque_id("download");
        let display_name = sanitize_display_name(suggested_name);
        let destination = self.root.join(format!("{download_id}.quarantine"));
        if destination.exists() || destination.parent() != Some(self.root.as_path()) {
            return Err(TransferPolicyError::new(
                TransferPolicyCode::QuarantineUnavailable,
            ));
        }
        let provenance = DownloadProvenance {
            schema_version: 1,
            download_id: download_id.clone(),
            authorization_id: authorization.authorization_id.clone(),
            workspace_identity: binding.workspace_identity().to_string(),
            profile_id: binding.profile_id().to_string(),
            session_id: binding.session_id().to_string(),
            handoff_epoch: binding.handoff_epoch(),
            suggested_name: display_name.clone(),
            created_at: Utc::now().to_rfc3339(),
            state: "allocated",
            auto_open: false,
        };
        write_private_new_json(
            &self.root.join(format!("{download_id}.provenance.json")),
            &provenance,
        )?;
        authorization.consumed = true;
        Ok(QuarantinedDownload {
            download_id,
            display_name,
            created_at: provenance.created_at,
            auto_open: false,
            destination,
        })
    }
}

#[derive(Serialize)]
struct DownloadProvenance {
    schema_version: u32,
    download_id: String,
    authorization_id: String,
    workspace_identity: String,
    profile_id: String,
    session_id: String,
    handoff_epoch: u64,
    suggested_name: String,
    created_at: String,
    state: &'static str,
    auto_open: bool,
}

fn bindings_match(left: &BrowserGrantBinding, right: &BrowserGrantBinding) -> bool {
    left.workspace_identity() == right.workspace_identity()
        && left.profile_id() == right.profile_id()
        && left.session_id() == right.session_id()
        && left.handoff_epoch() == right.handoff_epoch()
}

fn reject_symlink_ancestors(
    canonical_path: &Path,
    roots: &[PathBuf],
) -> Result<(), TransferPolicyError> {
    let root = roots
        .iter()
        .filter(|root| canonical_path.starts_with(root))
        .max_by_key(|root| root.components().count())
        .ok_or_else(|| TransferPolicyError::new(TransferPolicyCode::PathOutsideApprovedRoots))?;
    let relative = canonical_path
        .strip_prefix(root)
        .map_err(|_| TransferPolicyError::new(TransferPolicyCode::UnsafePath))?;
    let mut cursor = root.clone();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return Err(TransferPolicyError::new(TransferPolicyCode::UnsafePath));
        };
        cursor.push(component);
        let metadata = fs::symlink_metadata(&cursor)
            .map_err(|_| TransferPolicyError::new(TransferPolicyCode::UnsafePath))?;
        if metadata.file_type().is_symlink() {
            return Err(TransferPolicyError::new(TransferPolicyCode::UnsafePath));
        }
    }
    Ok(())
}

fn hash_regular_file(path: &Path, maximum: u64) -> Result<(u64, String), TransferPolicyError> {
    let mut file =
        File::open(path).map_err(|_| TransferPolicyError::new(TransferPolicyCode::FileMissing))?;
    let metadata = file
        .metadata()
        .map_err(|_| TransferPolicyError::new(TransferPolicyCode::Io))?;
    if !metadata.is_file() {
        return Err(TransferPolicyError::new(TransferPolicyCode::UnsafePath));
    }
    if metadata.len() > maximum {
        return Err(TransferPolicyError::new(TransferPolicyCode::FileTooLarge));
    }
    let mut digest = Sha256::new();
    let mut copied = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| TransferPolicyError::new(TransferPolicyCode::Io))?;
        if read == 0 {
            break;
        }
        copied = copied.saturating_add(read as u64);
        if copied > maximum {
            return Err(TransferPolicyError::new(TransferPolicyCode::FileTooLarge));
        }
        digest.update(&buffer[..read]);
    }
    if copied > maximum || copied != metadata.len() {
        return Err(TransferPolicyError::new(TransferPolicyCode::UnsafePath));
    }
    Ok((copied, hex::encode(digest.finalize())))
}

fn sanitize_display_name(value: &str) -> String {
    let leaf = Path::new(value)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    let sanitized = leaf
        .chars()
        .filter(|character| {
            !character.is_control() && !matches!(*character, '/' | '\\' | ':' | '\0')
        })
        .take(MAX_DOWNLOAD_NAME_CHARS)
        .collect::<String>();
    if sanitized.trim().is_empty() || matches!(sanitized.as_str(), "." | "..") {
        "download".to_string()
    } else {
        sanitized
    }
}

fn random_opaque_id(prefix: &str) -> String {
    let mut bytes = [0_u8; 16];
    OsRng.fill_bytes(&mut bytes);
    format!("{prefix}-{}", hex::encode(bytes))
}

fn ensure_private_directory(path: &Path) -> Result<(), TransferPolicyError> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
            return Err(TransferPolicyError::new(
                TransferPolicyCode::QuarantineUnavailable,
            ));
        }
    }
    fs::create_dir_all(path).map_err(|_| TransferPolicyError::new(TransferPolicyCode::Io))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| TransferPolicyError::new(TransferPolicyCode::Io))?;
    }
    Ok(())
}

fn write_private_new_json<T: Serialize>(path: &Path, value: &T) -> Result<(), TransferPolicyError> {
    if path.exists() {
        return Err(TransferPolicyError::new(
            TransferPolicyCode::QuarantineUnavailable,
        ));
    }
    let bytes =
        serde_json::to_vec(value).map_err(|_| TransferPolicyError::new(TransferPolicyCode::Io))?;
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| TransferPolicyError::new(TransferPolicyCode::Io))?;
    file.write_all(&bytes)
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.sync_all())
        .map_err(|_| TransferPolicyError::new(TransferPolicyCode::Io))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(workspace: &str, epoch: u64) -> BrowserGrantBinding {
        BrowserGrantBinding::new_trusted(workspace, "profile-1", "session-1", epoch)
            .expect("trusted binding")
    }

    #[test]
    fn upload_exposes_only_opaque_single_use_handle_and_revalidates_file() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("workspace");
        fs::create_dir(&root).expect("workspace");
        let selected = root.join("invoice.txt");
        fs::write(&selected, b"safe bytes").expect("fixture");
        let store = UploadApprovalStore::from_trusted_workspace_roots([root.clone()])
            .expect("approval store");
        let binding = binding("workspace-1", 1);
        let handle = store
            .approve_from_trusted_ui(binding.clone(), &selected)
            .expect("trusted picker approval");
        let serialized = serde_json::to_string(&handle).expect("serialize public handle");
        assert!(!serialized.contains(selected.to_string_lossy().as_ref()));
        assert!(!serialized.contains("invoice.txt"));
        assert_eq!(handle.byte_size(), 10);
        assert_eq!(handle.sha256().len(), 64);

        let approved = store
            .resolve_once(&binding, handle.as_str())
            .expect("first use");
        assert_eq!(approved.path(), selected.canonicalize().unwrap());
        assert_eq!(approved.byte_size(), 10);
        assert_eq!(approved.sha256(), handle.sha256());
        assert_eq!(
            store
                .resolve_once(&binding, handle.as_str())
                .expect_err("single use")
                .code,
            TransferPolicyCode::CapabilityConsumed
        );
    }

    #[test]
    fn upload_rejects_outside_paths_symlinks_binding_mismatch_and_changed_content() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("workspace");
        fs::create_dir(&root).unwrap();
        let outside = temp.path().join("outside.txt");
        fs::write(&outside, b"outside").unwrap();
        let selected = root.join("selected.txt");
        fs::write(&selected, b"first").unwrap();
        let store = UploadApprovalStore::from_trusted_workspace_roots([root.clone()]).unwrap();
        assert_eq!(
            store
                .approve_from_trusted_ui(binding("workspace-1", 1), &outside)
                .unwrap_err()
                .code,
            TransferPolicyCode::PathOutsideApprovedRoots
        );

        let handle = store
            .approve_from_trusted_ui(binding("workspace-1", 1), &selected)
            .unwrap();
        assert_eq!(
            store
                .resolve_once(&binding("workspace-2", 1), handle.as_str())
                .unwrap_err()
                .code,
            TransferPolicyCode::BindingMismatch
        );
        fs::write(&selected, b"changed").unwrap();
        assert_eq!(
            store
                .resolve_once(&binding("workspace-1", 1), handle.as_str())
                .unwrap_err()
                .code,
            TransferPolicyCode::UnsafePath
        );

        #[cfg(unix)]
        {
            let link = root.join("linked.txt");
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            assert_eq!(
                store
                    .approve_from_trusted_ui(binding("workspace-1", 1), &link)
                    .unwrap_err()
                    .code,
                TransferPolicyCode::UnsafePath
            );
        }
    }

    #[test]
    fn downloads_are_blocked_by_default_and_trusted_prompt_is_exact_one_shot() {
        let temp = tempfile::tempdir().expect("tempdir");
        let quarantine = DownloadQuarantine::new(temp.path().join("quarantine")).unwrap();
        let active_binding = binding("workspace-1", 9);
        assert_eq!(
            quarantine
                .allocate_after_trusted_prompt(&active_binding, "payload.sh", None)
                .unwrap_err()
                .code,
            TransferPolicyCode::DownloadBlocked
        );

        let mut authorization =
            TrustedDownloadAuthorization::from_trusted_ui(active_binding.clone());
        assert_eq!(
            quarantine
                .allocate_after_trusted_prompt(
                    &binding("workspace-1", 10),
                    "payload.sh",
                    Some(&mut authorization),
                )
                .unwrap_err()
                .code,
            TransferPolicyCode::BindingMismatch
        );
        let allocated = quarantine
            .allocate_after_trusted_prompt(
                &active_binding,
                "../../payload.sh",
                Some(&mut authorization),
            )
            .unwrap();
        assert_eq!(allocated.display_name, "payload.sh");
        assert!(!allocated.auto_open);
        assert!(allocated
            .destination_for_backend()
            .starts_with(temp.path().join("quarantine")));
        assert_eq!(
            quarantine
                .allocate_after_trusted_prompt(
                    &active_binding,
                    "second.bin",
                    Some(&mut authorization),
                )
                .unwrap_err()
                .code,
            TransferPolicyCode::CapabilityConsumed
        );
        let provenance = fs::read_to_string(
            temp.path()
                .join("quarantine")
                .join(format!("{}.provenance.json", allocated.download_id)),
        )
        .unwrap();
        assert!(provenance.contains("\"auto_open\":false"));
        assert!(!provenance.contains("../"));
    }

    #[test]
    fn transfer_codes_are_stable_and_bounded() {
        for code in [
            TransferPolicyCode::Allowed,
            TransferPolicyCode::InvalidRoot,
            TransferPolicyCode::PathOutsideApprovedRoots,
            TransferPolicyCode::UnsafePath,
            TransferPolicyCode::FileMissing,
            TransferPolicyCode::FileTooLarge,
            TransferPolicyCode::HandleUnknown,
            TransferPolicyCode::BindingMismatch,
            TransferPolicyCode::CapabilityExpired,
            TransferPolicyCode::CapabilityConsumed,
            TransferPolicyCode::DownloadBlocked,
            TransferPolicyCode::QuarantineUnavailable,
            TransferPolicyCode::Io,
        ] {
            assert!(code.as_str().len() <= 64);
            assert!(code
                .as_str()
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'_'));
        }
    }
}
