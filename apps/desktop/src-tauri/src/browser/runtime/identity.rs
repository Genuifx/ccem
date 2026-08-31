use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use super::manifest::{RuntimeArchitecture, RuntimeArtifact, RuntimePlatform};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityErrorCode {
    InvalidRoot,
    LayoutMismatch,
    ExecutableMissing,
    ExecutableSizeMismatch,
    ExecutableHashMismatch,
    PlatformMismatch,
    ArchitectureMismatch,
    ProductNameMismatch,
    ProductVersionMismatch,
    BundleIdentifierMismatch,
    PublisherMismatch,
    AuthenticodeInvalid,
    MalformedPlatformIdentity,
    PlatformVerificationUnsupported,
    Io,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityError {
    pub code: IdentityErrorCode,
}

impl IdentityError {
    fn new(code: IdentityErrorCode) -> Self {
        Self { code }
    }
}

impl fmt::Display for IdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "runtime identity verification failed: {:?}",
            self.code
        )
    }
}

impl std::error::Error for IdentityError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformIdentityEvidence {
    pub platform: RuntimePlatform,
    pub architectures: Vec<RuntimeArchitecture>,
    pub product_name: String,
    pub product_version: String,
    pub bundle_identifier: Option<String>,
    pub publisher: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedRuntimeIdentity {
    pub executable_path: PathBuf,
    pub executable_size: u64,
    pub executable_sha256: String,
    pub platform_identity: PlatformIdentityEvidence,
}

pub trait PlatformIdentityVerifier: Send + Sync {
    fn inspect(
        &self,
        candidate_root: &Path,
        executable_path: &Path,
        artifact: &RuntimeArtifact,
    ) -> Result<PlatformIdentityEvidence, IdentityError>;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SystemPlatformIdentityVerifier;

pub fn verify_runtime_identity(
    candidate_root: &Path,
    artifact: &RuntimeArtifact,
) -> Result<VerifiedRuntimeIdentity, IdentityError> {
    verify_runtime_identity_with(candidate_root, artifact, &SystemPlatformIdentityVerifier)
}

pub fn verify_runtime_identity_with(
    candidate_root: &Path,
    artifact: &RuntimeArtifact,
    platform_verifier: &dyn PlatformIdentityVerifier,
) -> Result<VerifiedRuntimeIdentity, IdentityError> {
    let canonical_root = validate_candidate_layout(candidate_root, artifact)?;
    let executable_path = candidate_root.join(&artifact.layout.executable.relative_path);
    let executable_metadata = fs::symlink_metadata(&executable_path)
        .map_err(|_| IdentityError::new(IdentityErrorCode::ExecutableMissing))?;
    if !executable_metadata.file_type().is_file() || executable_metadata.file_type().is_symlink() {
        return Err(IdentityError::new(IdentityErrorCode::ExecutableMissing));
    }
    let canonical_executable = fs::canonicalize(&executable_path)
        .map_err(|_| IdentityError::new(IdentityErrorCode::ExecutableMissing))?;
    if !canonical_executable.starts_with(&canonical_root) {
        return Err(IdentityError::new(IdentityErrorCode::LayoutMismatch));
    }
    if executable_metadata.len() != artifact.layout.executable.byte_size {
        return Err(IdentityError::new(
            IdentityErrorCode::ExecutableSizeMismatch,
        ));
    }
    let executable_sha256 = hash_file(&executable_path, artifact.layout.executable.byte_size)?;
    if executable_sha256 != artifact.layout.executable.sha256 {
        return Err(IdentityError::new(
            IdentityErrorCode::ExecutableHashMismatch,
        ));
    }
    let platform_identity =
        platform_verifier.inspect(candidate_root, &executable_path, artifact)?;
    validate_platform_evidence(&platform_identity, artifact)?;
    Ok(VerifiedRuntimeIdentity {
        executable_path,
        executable_size: executable_metadata.len(),
        executable_sha256,
        platform_identity,
    })
}

fn validate_candidate_layout(
    candidate_root: &Path,
    artifact: &RuntimeArtifact,
) -> Result<PathBuf, IdentityError> {
    let metadata = fs::symlink_metadata(candidate_root)
        .map_err(|_| IdentityError::new(IdentityErrorCode::InvalidRoot))?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err(IdentityError::new(IdentityErrorCode::InvalidRoot));
    }
    let canonical_root = fs::canonicalize(candidate_root)
        .map_err(|_| IdentityError::new(IdentityErrorCode::InvalidRoot))?;
    let mut observed_symlinks = BTreeMap::new();
    inspect_layout_tree(candidate_root, candidate_root, &mut observed_symlinks)?;
    let declared = artifact
        .layout
        .symlinks
        .iter()
        .map(|link| (link.path.clone(), link.target.clone()))
        .collect::<BTreeMap<_, _>>();
    if observed_symlinks != declared {
        return Err(IdentityError::new(IdentityErrorCode::LayoutMismatch));
    }
    for (relative, target) in observed_symlinks {
        let link = candidate_root.join(relative);
        if fs::read_link(&link)
            .ok()
            .and_then(|path| path.to_str().map(ToOwned::to_owned))
            != Some(target)
        {
            return Err(IdentityError::new(IdentityErrorCode::LayoutMismatch));
        }
        let resolved = fs::canonicalize(&link)
            .map_err(|_| IdentityError::new(IdentityErrorCode::LayoutMismatch))?;
        if !resolved.starts_with(&canonical_root) {
            return Err(IdentityError::new(IdentityErrorCode::LayoutMismatch));
        }
    }
    Ok(canonical_root)
}

fn inspect_layout_tree(
    root: &Path,
    directory: &Path,
    symlinks: &mut BTreeMap<String, String>,
) -> Result<(), IdentityError> {
    for item in fs::read_dir(directory).map_err(|_| io_error())? {
        let item = item.map_err(|_| io_error())?;
        let path = item.path();
        let metadata = fs::symlink_metadata(&path).map_err(|_| io_error())?;
        let relative = path
            .strip_prefix(root)
            .map_err(|_| IdentityError::new(IdentityErrorCode::LayoutMismatch))?;
        let portable = portable_relative_path(relative)?;
        if metadata.file_type().is_symlink() {
            let target = fs::read_link(&path).map_err(|_| io_error())?;
            let target = target
                .to_str()
                .ok_or_else(|| IdentityError::new(IdentityErrorCode::LayoutMismatch))?
                .to_string();
            symlinks.insert(portable, target);
        } else if metadata.file_type().is_dir() {
            inspect_layout_tree(root, &path, symlinks)?;
        } else if metadata.file_type().is_file() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if metadata.nlink() != 1 {
                    return Err(IdentityError::new(IdentityErrorCode::LayoutMismatch));
                }
            }
        } else {
            return Err(IdentityError::new(IdentityErrorCode::LayoutMismatch));
        }
    }
    Ok(())
}

fn portable_relative_path(path: &Path) -> Result<String, IdentityError> {
    let mut parts = Vec::new();
    for component in path.components() {
        let Component::Normal(component) = component else {
            return Err(IdentityError::new(IdentityErrorCode::LayoutMismatch));
        };
        let part = component
            .to_str()
            .ok_or_else(|| IdentityError::new(IdentityErrorCode::LayoutMismatch))?;
        if part.is_empty() || part.contains(['\0', '/', '\\']) {
            return Err(IdentityError::new(IdentityErrorCode::LayoutMismatch));
        }
        parts.push(part);
    }
    Ok(parts.join("/"))
}

fn validate_platform_evidence(
    evidence: &PlatformIdentityEvidence,
    artifact: &RuntimeArtifact,
) -> Result<(), IdentityError> {
    if evidence.platform != artifact.platform {
        return Err(IdentityError::new(IdentityErrorCode::PlatformMismatch));
    }
    if !evidence.architectures.contains(&artifact.architecture) {
        return Err(IdentityError::new(IdentityErrorCode::ArchitectureMismatch));
    }
    if evidence.product_name != artifact.product_identity.product_name {
        return Err(IdentityError::new(IdentityErrorCode::ProductNameMismatch));
    }
    if evidence.product_version != artifact.product_identity.product_version {
        return Err(IdentityError::new(
            IdentityErrorCode::ProductVersionMismatch,
        ));
    }
    if evidence.bundle_identifier != artifact.product_identity.bundle_identifier {
        return Err(IdentityError::new(
            IdentityErrorCode::BundleIdentifierMismatch,
        ));
    }
    if evidence.publisher != artifact.product_identity.publisher {
        return Err(IdentityError::new(IdentityErrorCode::PublisherMismatch));
    }
    Ok(())
}

fn hash_file(path: &Path, maximum: u64) -> Result<String, IdentityError> {
    let mut file = File::open(path).map_err(|_| io_error())?;
    let mut digest = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|_| io_error())?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .ok_or_else(|| IdentityError::new(IdentityErrorCode::ExecutableSizeMismatch))?;
        if total > maximum {
            return Err(IdentityError::new(
                IdentityErrorCode::ExecutableSizeMismatch,
            ));
        }
        digest.update(&buffer[..count]);
    }
    Ok(hex::encode(digest.finalize()))
}

#[cfg(target_os = "macos")]
impl PlatformIdentityVerifier for SystemPlatformIdentityVerifier {
    fn inspect(
        &self,
        candidate_root: &Path,
        executable_path: &Path,
        artifact: &RuntimeArtifact,
    ) -> Result<PlatformIdentityEvidence, IdentityError> {
        if artifact.platform != RuntimePlatform::Macos {
            return Err(IdentityError::new(IdentityErrorCode::PlatformMismatch));
        }
        let app_bundle = find_app_bundle(candidate_root, executable_path)?;
        let info_path = app_bundle.join("Contents/Info.plist");
        let info_metadata = fs::symlink_metadata(&info_path).map_err(|_| malformed_identity())?;
        if !info_metadata.file_type().is_file()
            || info_metadata.file_type().is_symlink()
            || info_metadata.len() > 4 * 1024 * 1024
        {
            return Err(malformed_identity());
        }
        let info = plist::Value::from_file(&info_path).map_err(|_| malformed_identity())?;
        let dictionary = info.as_dictionary().ok_or_else(malformed_identity)?;
        let product_name = plist_string(dictionary, "CFBundleName")
            .or_else(|| plist_string(dictionary, "CFBundleDisplayName"))
            .ok_or_else(malformed_identity)?;
        let product_version = plist_string(dictionary, "CFBundleShortVersionString")
            .ok_or_else(malformed_identity)?;
        let bundle_identifier =
            plist_string(dictionary, "CFBundleIdentifier").ok_or_else(malformed_identity)?;
        let architectures = inspect_mach_architectures(executable_path)?;
        Ok(PlatformIdentityEvidence {
            platform: RuntimePlatform::Macos,
            architectures,
            product_name,
            product_version,
            bundle_identifier: Some(bundle_identifier),
            publisher: None,
        })
    }
}

#[cfg(target_os = "windows")]
impl PlatformIdentityVerifier for SystemPlatformIdentityVerifier {
    fn inspect(
        &self,
        _candidate_root: &Path,
        executable_path: &Path,
        artifact: &RuntimeArtifact,
    ) -> Result<PlatformIdentityEvidence, IdentityError> {
        if artifact.platform != RuntimePlatform::Windows
            || artifact.architecture != RuntimeArchitecture::X86_64
        {
            return Err(IdentityError::new(IdentityErrorCode::PlatformMismatch));
        }
        let architectures = vec![inspect_pe_architecture(executable_path)?];
        let signer_publisher = verify_windows_authenticode(executable_path)?;
        let (file_version, product_name, product_version, company_name) =
            read_windows_version_identity(executable_path)?;
        if file_version != artifact.version {
            return Err(IdentityError::new(
                IdentityErrorCode::ProductVersionMismatch,
            ));
        }
        if product_name != artifact.product_identity.product_name {
            return Err(IdentityError::new(IdentityErrorCode::ProductNameMismatch));
        }
        if product_version != artifact.product_identity.product_version {
            return Err(IdentityError::new(
                IdentityErrorCode::ProductVersionMismatch,
            ));
        }
        if company_name != signer_publisher {
            return Err(IdentityError::new(IdentityErrorCode::PublisherMismatch));
        }
        Ok(PlatformIdentityEvidence {
            platform: RuntimePlatform::Windows,
            architectures,
            product_name,
            product_version,
            bundle_identifier: None,
            publisher: Some(signer_publisher),
        })
    }
}

#[cfg(target_os = "linux")]
impl PlatformIdentityVerifier for SystemPlatformIdentityVerifier {
    fn inspect(
        &self,
        _candidate_root: &Path,
        _executable_path: &Path,
        _artifact: &RuntimeArtifact,
    ) -> Result<PlatformIdentityEvidence, IdentityError> {
        Err(IdentityError::new(
            IdentityErrorCode::PlatformVerificationUnsupported,
        ))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
impl PlatformIdentityVerifier for SystemPlatformIdentityVerifier {
    fn inspect(
        &self,
        _candidate_root: &Path,
        _executable_path: &Path,
        _artifact: &RuntimeArtifact,
    ) -> Result<PlatformIdentityEvidence, IdentityError> {
        Err(IdentityError::new(
            IdentityErrorCode::PlatformVerificationUnsupported,
        ))
    }
}

#[cfg(target_os = "macos")]
fn find_app_bundle(root: &Path, executable: &Path) -> Result<PathBuf, IdentityError> {
    let relative = executable
        .strip_prefix(root)
        .map_err(|_| IdentityError::new(IdentityErrorCode::LayoutMismatch))?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return Err(IdentityError::new(IdentityErrorCode::LayoutMismatch));
        };
        current.push(component);
        if component
            .to_str()
            .is_some_and(|value| value.ends_with(".app"))
        {
            return Ok(current);
        }
    }
    Err(malformed_identity())
}

#[cfg(target_os = "macos")]
fn plist_string(dictionary: &plist::Dictionary, key: &str) -> Option<String> {
    dictionary
        .get(key)
        .and_then(plist::Value::as_string)
        .map(ToOwned::to_owned)
        .filter(|value| !value.is_empty() && value.len() <= 1024)
}

#[cfg(target_os = "macos")]
fn inspect_mach_architectures(path: &Path) -> Result<Vec<RuntimeArchitecture>, IdentityError> {
    let mut file = File::open(path).map_err(|_| io_error())?;
    let mut header = vec![0_u8; 8 + 64 * 32];
    let count = file.read(&mut header).map_err(|_| io_error())?;
    header.truncate(count);
    if header.len() < 8 {
        return Err(malformed_identity());
    }
    let magic = &header[..4];
    if matches!(magic, [0xcf, 0xfa, 0xed, 0xfe] | [0xce, 0xfa, 0xed, 0xfe]) {
        return architecture_from_cpu(read_u32(&header[4..8], true)).map(|value| vec![value]);
    }
    if matches!(magic, [0xfe, 0xed, 0xfa, 0xcf] | [0xfe, 0xed, 0xfa, 0xce]) {
        return architecture_from_cpu(read_u32(&header[4..8], false)).map(|value| vec![value]);
    }
    let (little_endian, entry_size) = match magic {
        [0xca, 0xfe, 0xba, 0xbe] => (false, 20),
        [0xbe, 0xba, 0xfe, 0xca] => (true, 20),
        [0xca, 0xfe, 0xba, 0xbf] => (false, 32),
        [0xbf, 0xba, 0xfe, 0xca] => (true, 32),
        _ => return Err(malformed_identity()),
    };
    let architecture_count = read_u32(&header[4..8], little_endian) as usize;
    if architecture_count == 0 || architecture_count > 64 {
        return Err(malformed_identity());
    }
    let required = 8_usize
        .checked_add(architecture_count.saturating_mul(entry_size))
        .ok_or_else(malformed_identity)?;
    if header.len() < required {
        return Err(malformed_identity());
    }
    let mut architectures = Vec::new();
    for index in 0..architecture_count {
        let offset = 8 + index * entry_size;
        let architecture =
            architecture_from_cpu(read_u32(&header[offset..offset + 4], little_endian))?;
        if !architectures.contains(&architecture) {
            architectures.push(architecture);
        }
    }
    Ok(architectures)
}

#[cfg(target_os = "macos")]
fn read_u32(bytes: &[u8], little_endian: bool) -> u32 {
    let bytes = [bytes[0], bytes[1], bytes[2], bytes[3]];
    if little_endian {
        u32::from_le_bytes(bytes)
    } else {
        u32::from_be_bytes(bytes)
    }
}

#[cfg(target_os = "macos")]
fn architecture_from_cpu(value: u32) -> Result<RuntimeArchitecture, IdentityError> {
    match value {
        0x0100_000c => Ok(RuntimeArchitecture::Aarch64),
        0x0100_0007 => Ok(RuntimeArchitecture::X86_64),
        _ => Err(IdentityError::new(IdentityErrorCode::ArchitectureMismatch)),
    }
}

fn inspect_pe_architecture(path: &Path) -> Result<RuntimeArchitecture, IdentityError> {
    let mut file = File::open(path).map_err(|_| io_error())?;
    let file_size = file.metadata().map_err(|_| io_error())?.len();
    let mut dos_header = [0_u8; 64];
    file.read_exact(&mut dos_header)
        .map_err(|_| malformed_identity())?;
    if &dos_header[..2] != b"MZ" {
        return Err(malformed_identity());
    }
    let pe_offset = u32::from_le_bytes([
        dos_header[0x3c],
        dos_header[0x3d],
        dos_header[0x3e],
        dos_header[0x3f],
    ]) as u64;
    let offset_ok = (64..=16 * 1024 * 1024).contains(&pe_offset);
    if !offset_ok || pe_offset + 6 > file_size {
        return Err(malformed_identity());
    }
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(pe_offset))
        .map_err(|_| io_error())?;
    let mut pe_header = [0_u8; 6];
    file.read_exact(&mut pe_header)
        .map_err(|_| malformed_identity())?;
    if &pe_header[..4] != b"PE\0\0" {
        return Err(malformed_identity());
    }
    match u16::from_le_bytes([pe_header[4], pe_header[5]]) {
        0x8664 => Ok(RuntimeArchitecture::X86_64),
        _ => Err(IdentityError::new(IdentityErrorCode::ArchitectureMismatch)),
    }
}

#[cfg(target_os = "windows")]
type WindowsVersionIdentity = (String, String, String, String);

#[cfg(target_os = "windows")]
fn verify_windows_authenticode(path: &Path) -> Result<String, IdentityError> {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::ptr::null_mut;
    use windows_sys::Win32::Security::WinTrust::{
        WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_FILE_INFO,
        WTD_CHOICE_FILE, WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT, WTD_REVOKE_WHOLECHAIN,
        WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY, WTD_UICONTEXT_EXECUTE, WTD_UI_NONE,
    };

    let wide_path = windows_path(path)?;
    let mut file_info = WINTRUST_FILE_INFO {
        cbStruct: size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: wide_path.as_ptr(),
        hFile: null_mut(),
        pgKnownSubject: null_mut(),
    };
    let mut trust_data = WINTRUST_DATA::default();
    trust_data.cbStruct = size_of::<WINTRUST_DATA>() as u32;
    trust_data.dwUIChoice = WTD_UI_NONE;
    trust_data.fdwRevocationChecks = WTD_REVOKE_WHOLECHAIN;
    trust_data.dwUnionChoice = WTD_CHOICE_FILE;
    trust_data.Anonymous.pFile = &mut file_info;
    trust_data.dwStateAction = WTD_STATEACTION_VERIFY;
    trust_data.dwProvFlags = WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT;
    trust_data.dwUIContext = WTD_UICONTEXT_EXECUTE;
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    let verify_status = unsafe {
        WinVerifyTrust(
            null_mut(),
            &mut action,
            &mut trust_data as *mut WINTRUST_DATA as *mut c_void,
        )
    };
    let publisher = if verify_status == 0 {
        unsafe { signer_publisher_from_state(trust_data.hWVTStateData) }
    } else {
        Err(IdentityError::new(IdentityErrorCode::AuthenticodeInvalid))
    };
    trust_data.dwStateAction = WTD_STATEACTION_CLOSE;
    let close_status = unsafe {
        WinVerifyTrust(
            null_mut(),
            &mut action,
            &mut trust_data as *mut WINTRUST_DATA as *mut c_void,
        )
    };
    if close_status != 0 {
        return Err(malformed_identity());
    }
    publisher
}

#[cfg(target_os = "windows")]
unsafe fn signer_publisher_from_state(
    state: windows_sys::Win32::Foundation::HANDLE,
) -> Result<String, IdentityError> {
    use std::ffi::c_void;
    use std::ptr::null_mut;
    use windows_sys::Win32::Security::Cryptography::{
        szOID_ORGANIZATION_NAME, CertGetNameStringW, CERT_NAME_ATTR_TYPE,
    };
    use windows_sys::Win32::Security::WinTrust::{
        WTHelperGetProvCertFromChain, WTHelperGetProvSignerFromChain, WTHelperProvDataFromStateData,
    };

    if state.is_null() {
        return Err(malformed_identity());
    }
    let provider = unsafe { WTHelperProvDataFromStateData(state) };
    if provider.is_null() {
        return Err(malformed_identity());
    }
    let signer = unsafe { WTHelperGetProvSignerFromChain(provider, 0, 0, 0) };
    if signer.is_null() {
        return Err(malformed_identity());
    }
    let certificate = unsafe { WTHelperGetProvCertFromChain(signer, 0) };
    if certificate.is_null() {
        return Err(malformed_identity());
    }
    let context = unsafe { (*certificate).pCert };
    if context.is_null() {
        return Err(malformed_identity());
    }
    let required = unsafe {
        CertGetNameStringW(
            context,
            CERT_NAME_ATTR_TYPE,
            0,
            szOID_ORGANIZATION_NAME as *const c_void,
            null_mut(),
            0,
        )
    };
    if !(2..=1024).contains(&required) {
        return Err(malformed_identity());
    }
    let mut buffer = vec![0_u16; required as usize];
    let written = unsafe {
        CertGetNameStringW(
            context,
            CERT_NAME_ATTR_TYPE,
            0,
            szOID_ORGANIZATION_NAME as *const c_void,
            buffer.as_mut_ptr(),
            required,
        )
    };
    if written != required || buffer.last() != Some(&0) {
        return Err(malformed_identity());
    }
    String::from_utf16(&buffer[..buffer.len() - 1])
        .ok()
        .filter(|value| !value.is_empty() && !value.chars().any(char::is_control))
        .ok_or_else(malformed_identity)
}

#[cfg(target_os = "windows")]
fn read_windows_version_identity(path: &Path) -> Result<WindowsVersionIdentity, IdentityError> {
    use std::ffi::c_void;
    use windows_sys::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW};

    let wide_path = windows_path(path)?;
    let mut ignored = 0_u32;
    let size = unsafe { GetFileVersionInfoSizeW(wide_path.as_ptr(), &mut ignored) };
    if size == 0 || size > 16 * 1024 * 1024 {
        return Err(malformed_identity());
    }
    let mut data = vec![0_u8; size as usize];
    if unsafe {
        GetFileVersionInfoW(
            wide_path.as_ptr(),
            0,
            size,
            data.as_mut_ptr() as *mut c_void,
        )
    } == 0
    {
        return Err(malformed_identity());
    }
    for (language, code_page) in windows_version_translations(&data)? {
        let prefix = format!("\\StringFileInfo\\{language:04x}{code_page:04x}");
        let mut values = Vec::new();
        for field in [
            "FileVersion",
            "ProductName",
            "ProductVersion",
            "CompanyName",
        ] {
            let Some(value) = query_windows_version_string(&data, &format!("{prefix}\\{field}"))?
            else {
                values.clear();
                break;
            };
            values.push(value);
        }
        if values.len() == 4 {
            return Ok((
                values.remove(0),
                values.remove(0),
                values.remove(0),
                values.remove(0),
            ));
        }
    }
    Err(malformed_identity())
}

#[cfg(target_os = "windows")]
fn windows_version_translations(data: &[u8]) -> Result<Vec<(u16, u16)>, IdentityError> {
    use std::ffi::c_void;
    use std::ptr::null_mut;
    use windows_sys::Win32::Storage::FileSystem::VerQueryValueW;

    let query = windows_string("\\VarFileInfo\\Translation")?;
    let mut pointer: *mut c_void = null_mut();
    let mut length = 0_u32;
    if unsafe {
        VerQueryValueW(
            data.as_ptr() as *const c_void,
            query.as_ptr(),
            &mut pointer,
            &mut length,
        )
    } == 0
        || length == 0
        || length % 4 != 0
    {
        return Err(malformed_identity());
    }
    let offset = version_pointer_offset(data, pointer as *const u8, length as usize)?;
    Ok(data[offset..offset + length as usize]
        .chunks_exact(4)
        .map(|pair| {
            (
                u16::from_le_bytes([pair[0], pair[1]]),
                u16::from_le_bytes([pair[2], pair[3]]),
            )
        })
        .collect())
}

#[cfg(target_os = "windows")]
fn query_windows_version_string(data: &[u8], query: &str) -> Result<Option<String>, IdentityError> {
    use std::ffi::c_void;
    use std::ptr::null_mut;
    use windows_sys::Win32::Storage::FileSystem::VerQueryValueW;

    let query = windows_string(query)?;
    let mut pointer: *mut c_void = null_mut();
    let mut characters = 0_u32;
    if unsafe {
        VerQueryValueW(
            data.as_ptr() as *const c_void,
            query.as_ptr(),
            &mut pointer,
            &mut characters,
        )
    } == 0
    {
        return Ok(None);
    }
    if characters < 2 || characters > 4096 {
        return Err(malformed_identity());
    }
    let byte_length = (characters as usize)
        .checked_mul(2)
        .ok_or_else(malformed_identity)?;
    let offset = version_pointer_offset(data, pointer as *const u8, byte_length)?;
    let mut utf16 = data[offset..offset + byte_length]
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect::<Vec<_>>();
    if utf16.pop() != Some(0) || utf16.contains(&0) {
        return Err(malformed_identity());
    }
    String::from_utf16(&utf16)
        .ok()
        .filter(|value| !value.is_empty() && !value.chars().any(char::is_control))
        .map(Some)
        .ok_or_else(malformed_identity)
}

#[cfg(target_os = "windows")]
fn version_pointer_offset(
    data: &[u8],
    pointer: *const u8,
    byte_length: usize,
) -> Result<usize, IdentityError> {
    let offset = (pointer as usize)
        .checked_sub(data.as_ptr() as usize)
        .filter(|offset| {
            offset
                .checked_add(byte_length)
                .is_some_and(|end| end <= data.len())
        })
        .ok_or_else(malformed_identity)?;
    Ok(offset)
}

#[cfg(target_os = "windows")]
fn windows_path(path: &Path) -> Result<Vec<u16>, IdentityError> {
    use std::os::windows::ffi::OsStrExt;
    let mut value = path.as_os_str().encode_wide().collect::<Vec<_>>();
    if value.is_empty() || value.contains(&0) {
        return Err(IdentityError::new(IdentityErrorCode::InvalidRoot));
    }
    value.push(0);
    Ok(value)
}

#[cfg(target_os = "windows")]
fn windows_string(value: &str) -> Result<Vec<u16>, IdentityError> {
    let mut value = value.encode_utf16().collect::<Vec<_>>();
    if value.is_empty() || value.contains(&0) {
        return Err(malformed_identity());
    }
    value.push(0);
    Ok(value)
}

fn malformed_identity() -> IdentityError {
    IdentityError::new(IdentityErrorCode::MalformedPlatformIdentity)
}

fn io_error() -> IdentityError {
    IdentityError::new(IdentityErrorCode::Io)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::runtime::manifest::{
        RuntimeArchiveFormat, RuntimeArchiveIdentity, RuntimeExecutableIdentity, RuntimeLayout,
        RuntimeProductIdentity,
    };
    use std::fs;

    struct FixtureVerifier {
        evidence: PlatformIdentityEvidence,
    }

    impl PlatformIdentityVerifier for FixtureVerifier {
        fn inspect(
            &self,
            _candidate_root: &Path,
            _executable_path: &Path,
            _artifact: &RuntimeArtifact,
        ) -> Result<PlatformIdentityEvidence, IdentityError> {
            Ok(self.evidence.clone())
        }
    }

    fn artifact(executable: &[u8]) -> RuntimeArtifact {
        RuntimeArtifact {
            platform: RuntimePlatform::Macos,
            architecture: RuntimeArchitecture::Aarch64,
            version: "150.0.1".to_string(),
            minimum_os_version: "12.0".to_string(),
            source_url: "https://example.invalid/150.0.1/runtime.zip".to_string(),
            archive: RuntimeArchiveIdentity {
                format: RuntimeArchiveFormat::Zip,
                byte_size: 1,
                sha256: "a".repeat(64),
                max_entries: 10,
                max_unpacked_bytes: 1024,
                max_file_bytes: 1024,
            },
            layout: RuntimeLayout {
                root_directory: "runtime-root".to_string(),
                executable: RuntimeExecutableIdentity {
                    relative_path: "Browser.app/Contents/MacOS/Browser".to_string(),
                    byte_size: executable.len() as u64,
                    sha256: hex::encode(Sha256::digest(executable)),
                },
                symlinks: Vec::new(),
            },
            product_identity: RuntimeProductIdentity {
                product_name: "Browser".to_string(),
                product_version: "150.0.1".to_string(),
                bundle_identifier: Some("org.example.browser".to_string()),
                publisher: None,
            },
        }
    }

    fn evidence() -> PlatformIdentityEvidence {
        PlatformIdentityEvidence {
            platform: RuntimePlatform::Macos,
            architectures: vec![RuntimeArchitecture::Aarch64],
            product_name: "Browser".to_string(),
            product_version: "150.0.1".to_string(),
            bundle_identifier: Some("org.example.browser".to_string()),
            publisher: None,
        }
    }

    fn candidate(executable: &[u8]) -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("candidate");
        let executable_path = root.join("Browser.app/Contents/MacOS/Browser");
        fs::create_dir_all(executable_path.parent().unwrap()).unwrap();
        fs::write(executable_path, executable).unwrap();
        (temp, root)
    }

    #[test]
    fn injected_verifier_is_gated_by_file_and_product_identity() {
        let executable = b"verified-executable";
        let (_temp, root) = candidate(executable);
        let artifact = artifact(executable);
        let verified = verify_runtime_identity_with(
            &root,
            &artifact,
            &FixtureVerifier {
                evidence: evidence(),
            },
        )
        .unwrap();
        assert_eq!(
            verified.executable_sha256,
            artifact.layout.executable.sha256
        );

        let mut wrong = evidence();
        wrong.product_version = "149.0.1".to_string();
        assert_eq!(
            verify_runtime_identity_with(&root, &artifact, &FixtureVerifier { evidence: wrong },)
                .unwrap_err()
                .code,
            IdentityErrorCode::ProductVersionMismatch
        );
        fs::write(
            root.join("Browser.app/Contents/MacOS/Browser"),
            b"tampered-executable",
        )
        .unwrap();
        assert!(matches!(
            verify_runtime_identity_with(
                &root,
                &artifact,
                &FixtureVerifier {
                    evidence: evidence()
                },
            )
            .unwrap_err()
            .code,
            IdentityErrorCode::ExecutableSizeMismatch | IdentityErrorCode::ExecutableHashMismatch
        ));
    }

    #[cfg(unix)]
    #[test]
    fn undeclared_or_escaping_symlinks_fail_layout_verification() {
        let executable = b"verified-executable";
        let (temp, root) = candidate(executable);
        std::os::unix::fs::symlink(temp.path(), root.join("escape")).unwrap();
        assert_eq!(
            verify_runtime_identity_with(
                &root,
                &artifact(executable),
                &FixtureVerifier {
                    evidence: evidence()
                },
            )
            .unwrap_err()
            .code,
            IdentityErrorCode::LayoutMismatch
        );
    }

    #[test]
    fn pe_machine_parser_accepts_only_x86_64_on_every_host() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("browser.exe");
        let mut pe = vec![0_u8; 70];
        pe[..2].copy_from_slice(b"MZ");
        pe[0x3c..0x40].copy_from_slice(&64_u32.to_le_bytes());
        pe[64..68].copy_from_slice(b"PE\0\0");
        pe[68..70].copy_from_slice(&0x8664_u16.to_le_bytes());
        fs::write(&path, &pe).unwrap();
        assert_eq!(
            inspect_pe_architecture(&path).unwrap(),
            RuntimeArchitecture::X86_64
        );
        pe[68..70].copy_from_slice(&0xaa64_u16.to_le_bytes());
        fs::write(&path, pe).unwrap();
        assert!(inspect_pe_architecture(&path).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_verifier_reads_plist_and_mach_o_architecture() {
        let mut executable = vec![0xcf, 0xfa, 0xed, 0xfe];
        executable.extend_from_slice(&0x0100_000c_u32.to_le_bytes());
        executable.extend_from_slice(&[0_u8; 24]);
        let (_temp, root) = candidate(&executable);
        let info_path = root.join("Browser.app/Contents/Info.plist");
        let mut dictionary = plist::Dictionary::new();
        dictionary.insert("CFBundleName".to_string(), "Browser".into());
        dictionary.insert("CFBundleShortVersionString".to_string(), "150.0.1".into());
        dictionary.insert(
            "CFBundleIdentifier".to_string(),
            "org.example.browser".into(),
        );
        plist::Value::Dictionary(dictionary)
            .to_file_xml(&info_path)
            .unwrap();
        let verified = verify_runtime_identity(&root, &artifact(&executable)).unwrap();
        assert_eq!(
            verified.platform_identity.architectures,
            vec![RuntimeArchitecture::Aarch64]
        );
        assert_eq!(
            verified.platform_identity.bundle_identifier.as_deref(),
            Some("org.example.browser")
        );
    }
}
