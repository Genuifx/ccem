use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::{Component, Path};

const RUNTIME_MANIFEST_SCHEMA_VERSION: u32 = 1;
const MAX_MANIFEST_BYTES: usize = 1024 * 1024;
const MAX_SIGNATURE_BYTES: usize = 16 * 1024;
const MAX_IDENTIFIER_BYTES: usize = 128;
const MAX_VERSION_BYTES: usize = 128;
const MAX_URL_BYTES: usize = 4096;
const MAX_PATH_BYTES: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimePlatform {
    Macos,
    Windows,
    Linux,
}

impl RuntimePlatform {
    pub fn current() -> Option<Self> {
        if cfg!(target_os = "macos") {
            Some(Self::Macos)
        } else if cfg!(target_os = "windows") {
            Some(Self::Windows)
        } else if cfg!(target_os = "linux") {
            Some(Self::Linux)
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeArchitecture {
    Aarch64,
    X86_64,
}

impl RuntimeArchitecture {
    pub fn current() -> Option<Self> {
        if cfg!(target_arch = "aarch64") {
            Some(Self::Aarch64)
        } else if cfg!(target_arch = "x86_64") {
            Some(Self::X86_64)
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeManifest {
    pub schema_version: u32,
    pub signing_key_id: String,
    pub sequence: u64,
    pub minimum_protocol_version: u32,
    pub artifact: RuntimeArtifact,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeArtifact {
    pub platform: RuntimePlatform,
    pub architecture: RuntimeArchitecture,
    pub version: String,
    pub minimum_os_version: String,
    pub source_url: String,
    pub archive: RuntimeArchiveIdentity,
    pub layout: RuntimeLayout,
    pub product_identity: RuntimeProductIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeArchiveIdentity {
    pub format: RuntimeArchiveFormat,
    pub byte_size: u64,
    pub sha256: String,
    pub max_entries: u64,
    pub max_unpacked_bytes: u64,
    pub max_file_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeArchiveFormat {
    Zip,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeLayout {
    pub root_directory: String,
    pub executable: RuntimeExecutableIdentity,
    #[serde(default)]
    pub symlinks: Vec<RuntimeDeclaredSymlink>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeExecutableIdentity {
    pub relative_path: String,
    pub byte_size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeDeclaredSymlink {
    pub path: String,
    pub target: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeProductIdentity {
    pub product_name: String,
    pub product_version: String,
    pub bundle_identifier: Option<String>,
    pub publisher: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestEnvironment {
    pub platform: RuntimePlatform,
    pub architecture: RuntimeArchitecture,
    pub os_version: String,
    pub protocol_version: u32,
    pub minimum_sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedRuntimeManifest {
    pub manifest: RuntimeManifest,
    pub exact_bytes_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManifestErrorCode {
    UnknownKey,
    InvalidKey,
    InvalidSignature,
    InvalidEncoding,
    InvalidSchema,
    InvalidField,
    RollbackRejected,
    UnsupportedPlatform,
    UnsupportedArchitecture,
    UnsupportedOs,
    ProtocolTooOld,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestError {
    pub code: ManifestErrorCode,
}

impl ManifestError {
    fn new(code: ManifestErrorCode) -> Self {
        Self { code }
    }
}

impl fmt::Display for ManifestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "runtime manifest rejected: {:?}", self.code)
    }
}

impl std::error::Error for ManifestError {}

#[derive(Debug, Clone, Default)]
pub struct ManifestTrustStore {
    keys: BTreeMap<String, PublicKey>,
}

impl ManifestTrustStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_minisign_key(
        &mut self,
        key_id: impl Into<String>,
        encoded_public_key: &str,
    ) -> Result<(), ManifestError> {
        let key_id = key_id.into();
        validate_identifier(&key_id)?;
        let key = PublicKey::decode(encoded_public_key)
            .or_else(|_| PublicKey::from_base64(encoded_public_key))
            .map_err(|_| ManifestError::new(ManifestErrorCode::InvalidKey))?;
        self.keys.insert(key_id, key);
        Ok(())
    }

    pub fn verify_exact_bytes(
        &self,
        expected_key_id: &str,
        manifest_bytes: &[u8],
        encoded_signature: &str,
        environment: &ManifestEnvironment,
    ) -> Result<VerifiedRuntimeManifest, ManifestError> {
        if manifest_bytes.is_empty() || manifest_bytes.len() > MAX_MANIFEST_BYTES {
            return Err(ManifestError::new(ManifestErrorCode::InvalidEncoding));
        }
        if encoded_signature.is_empty() || encoded_signature.len() > MAX_SIGNATURE_BYTES {
            return Err(ManifestError::new(ManifestErrorCode::InvalidSignature));
        }
        let key = self
            .keys
            .get(expected_key_id)
            .ok_or_else(|| ManifestError::new(ManifestErrorCode::UnknownKey))?;
        let signature = decode_signature(encoded_signature)?;
        key.verify(manifest_bytes, &signature, false)
            .map_err(|_| ManifestError::new(ManifestErrorCode::InvalidSignature))?;

        // Parsing happens only after the exact byte sequence has authenticated successfully.
        let manifest: RuntimeManifest = serde_json::from_slice(manifest_bytes)
            .map_err(|_| ManifestError::new(ManifestErrorCode::InvalidEncoding))?;
        validate_manifest(&manifest, expected_key_id, environment)?;
        Ok(VerifiedRuntimeManifest {
            manifest,
            exact_bytes_sha256: hex::encode(Sha256::digest(manifest_bytes)),
        })
    }
}

fn decode_signature(encoded: &str) -> Result<Signature, ManifestError> {
    let trimmed = encoded.trim();
    if let Ok(signature) = Signature::decode(trimmed) {
        return Ok(signature);
    }
    if !trimmed.is_ascii() {
        return Err(ManifestError::new(ManifestErrorCode::InvalidSignature));
    }
    let decoded = STANDARD
        .decode(trimmed)
        .map_err(|_| ManifestError::new(ManifestErrorCode::InvalidSignature))?;
    let decoded = std::str::from_utf8(&decoded)
        .map_err(|_| ManifestError::new(ManifestErrorCode::InvalidSignature))?;
    Signature::decode(decoded).map_err(|_| ManifestError::new(ManifestErrorCode::InvalidSignature))
}

fn validate_manifest(
    manifest: &RuntimeManifest,
    expected_key_id: &str,
    environment: &ManifestEnvironment,
) -> Result<(), ManifestError> {
    if manifest.schema_version != RUNTIME_MANIFEST_SCHEMA_VERSION {
        return Err(ManifestError::new(ManifestErrorCode::InvalidSchema));
    }
    validate_identifier(&manifest.signing_key_id)?;
    if manifest.signing_key_id != expected_key_id {
        return Err(ManifestError::new(ManifestErrorCode::InvalidKey));
    }
    if manifest.sequence < environment.minimum_sequence {
        return Err(ManifestError::new(ManifestErrorCode::RollbackRejected));
    }
    if manifest.minimum_protocol_version > environment.protocol_version {
        return Err(ManifestError::new(ManifestErrorCode::ProtocolTooOld));
    }
    if manifest.artifact.platform != environment.platform {
        return Err(ManifestError::new(ManifestErrorCode::UnsupportedPlatform));
    }
    if manifest.artifact.architecture != environment.architecture {
        return Err(ManifestError::new(
            ManifestErrorCode::UnsupportedArchitecture,
        ));
    }
    if compare_dotted_versions(
        &environment.os_version,
        &manifest.artifact.minimum_os_version,
    )? == std::cmp::Ordering::Less
    {
        return Err(ManifestError::new(ManifestErrorCode::UnsupportedOs));
    }
    validate_artifact(&manifest.artifact)
}

fn validate_artifact(artifact: &RuntimeArtifact) -> Result<(), ManifestError> {
    validate_short_text(&artifact.version, MAX_VERSION_BYTES)?;
    validate_dotted_version(&artifact.version)?;
    validate_dotted_version(&artifact.minimum_os_version)?;
    if artifact.product_identity.product_version != artifact.version {
        return Err(ManifestError::new(ManifestErrorCode::InvalidField));
    }
    validate_short_text(
        &artifact.product_identity.product_name,
        MAX_IDENTIFIER_BYTES,
    )?;
    for optional in [
        artifact.product_identity.bundle_identifier.as_deref(),
        artifact.product_identity.publisher.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        validate_short_text(optional, MAX_IDENTIFIER_BYTES)?;
    }

    let url = Url::parse(&artifact.source_url)
        .map_err(|_| ManifestError::new(ManifestErrorCode::InvalidField))?;
    if artifact.source_url.len() > MAX_URL_BYTES
        || url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url
            .path_segments()
            .is_some_and(|segments| segments.into_iter().any(|part| part == artifact.version))
    {
        return Err(ManifestError::new(ManifestErrorCode::InvalidField));
    }

    let archive = &artifact.archive;
    if archive.byte_size == 0
        || archive.max_entries == 0
        || archive.max_unpacked_bytes < archive.byte_size
        || archive.max_file_bytes == 0
        || archive.max_file_bytes > archive.max_unpacked_bytes
        || !is_sha256(&archive.sha256)
    {
        return Err(ManifestError::new(ManifestErrorCode::InvalidField));
    }
    validate_relative_path(&artifact.layout.root_directory, false)?;
    validate_relative_path(&artifact.layout.executable.relative_path, false)?;
    if artifact.layout.executable.byte_size == 0
        || artifact.layout.executable.byte_size > archive.max_file_bytes
        || !is_sha256(&artifact.layout.executable.sha256)
    {
        return Err(ManifestError::new(ManifestErrorCode::InvalidField));
    }
    validate_symlinks(&artifact.layout.symlinks)
}

fn validate_symlinks(symlinks: &[RuntimeDeclaredSymlink]) -> Result<(), ManifestError> {
    let mut paths = BTreeSet::new();
    for link in symlinks {
        validate_relative_path(&link.path, false)?;
        validate_relative_path(&link.target, true)?;
        let normalized = normalize_link_target(&link.path, &link.target)?;
        if normalized.as_os_str().is_empty() || !paths.insert(link.path.clone()) {
            return Err(ManifestError::new(ManifestErrorCode::InvalidField));
        }
    }
    Ok(())
}

fn normalize_link_target(
    link_path: &str,
    target: &str,
) -> Result<std::path::PathBuf, ManifestError> {
    let mut components = Vec::new();
    let parent = Path::new(link_path)
        .parent()
        .unwrap_or_else(|| Path::new(""));
    for component in parent.components().chain(Path::new(target).components()) {
        match component {
            Component::Normal(value) => components.push(value.to_os_string()),
            Component::CurDir => {}
            Component::ParentDir => {
                if components.pop().is_none() {
                    return Err(ManifestError::new(ManifestErrorCode::InvalidField));
                }
            }
            Component::Prefix(_) | Component::RootDir => {
                return Err(ManifestError::new(ManifestErrorCode::InvalidField))
            }
        }
    }
    Ok(components.into_iter().collect())
}

fn validate_relative_path(value: &str, allow_parent: bool) -> Result<(), ManifestError> {
    if value.is_empty()
        || value.len() > MAX_PATH_BYTES
        || value.contains(['\0', '\\'])
        || value.split('/').any(|part| part.is_empty())
    {
        return Err(ManifestError::new(ManifestErrorCode::InvalidField));
    }
    for component in Path::new(value).components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir if allow_parent => {}
            Component::ParentDir | Component::Prefix(_) | Component::RootDir => {
                return Err(ManifestError::new(ManifestErrorCode::InvalidField))
            }
        }
    }
    Ok(())
}

fn validate_identifier(value: &str) -> Result<(), ManifestError> {
    validate_short_text(value, MAX_IDENTIFIER_BYTES)?;
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(ManifestError::new(ManifestErrorCode::InvalidField));
    }
    Ok(())
}

fn validate_short_text(value: &str, maximum: usize) -> Result<(), ManifestError> {
    if value.trim() != value
        || value.is_empty()
        || value.len() > maximum
        || value.chars().any(char::is_control)
    {
        return Err(ManifestError::new(ManifestErrorCode::InvalidField));
    }
    Ok(())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_dotted_version(value: &str) -> Result<(), ManifestError> {
    dotted_version_parts(value).map(|_| ())
}

fn compare_dotted_versions(left: &str, right: &str) -> Result<std::cmp::Ordering, ManifestError> {
    let mut left = dotted_version_parts(left)?;
    let mut right = dotted_version_parts(right)?;
    let length = left.len().max(right.len());
    left.resize(length, 0);
    right.resize(length, 0);
    Ok(left.cmp(&right))
}

fn dotted_version_parts(value: &str) -> Result<Vec<u64>, ManifestError> {
    validate_short_text(value, MAX_VERSION_BYTES)?;
    let parts = value
        .split('.')
        .map(|part| {
            if part.is_empty() || (part.len() > 1 && part.starts_with('0')) {
                return Err(ManifestError::new(ManifestErrorCode::InvalidField));
            }
            part.parse::<u64>()
                .map_err(|_| ManifestError::new(ManifestErrorCode::InvalidField))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if !(2..=4).contains(&parts.len()) {
        return Err(ManifestError::new(ManifestErrorCode::InvalidField));
    }
    Ok(parts)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE_KEY_ID: &str = "ccem-browser-runtime-2026-01";
    const FIXTURE_PUBLIC_KEY: &str = include_str!("../../../runtime-manifests/public-key.pub");
    const FIXTURE_SIGNATURE: &str =
        include_str!("../../../runtime-manifests/macos-aarch64.json.sig");
    const FIXTURE_MANIFEST: &[u8] = include_bytes!("../../../runtime-manifests/macos-aarch64.json");

    fn environment() -> ManifestEnvironment {
        ManifestEnvironment {
            platform: RuntimePlatform::Macos,
            architecture: RuntimeArchitecture::Aarch64,
            os_version: "14.6".to_string(),
            protocol_version: 1,
            minimum_sequence: 1,
        }
    }

    fn trust_store() -> ManifestTrustStore {
        let mut store = ManifestTrustStore::new();
        store
            .add_minisign_key(FIXTURE_KEY_ID, FIXTURE_PUBLIC_KEY)
            .expect("fixture public key");
        store
    }

    #[test]
    fn verifies_exact_signed_bytes_before_parsing() {
        let verified = trust_store()
            .verify_exact_bytes(
                FIXTURE_KEY_ID,
                FIXTURE_MANIFEST,
                FIXTURE_SIGNATURE,
                &environment(),
            )
            .expect("valid signed runtime manifest");
        assert_eq!(verified.manifest.sequence, 1);
        assert_eq!(verified.manifest.artifact.minimum_os_version, "12.0");
        assert_eq!(verified.manifest.artifact.layout.symlinks.len(), 5);
        assert_eq!(verified.exact_bytes_sha256.len(), 64);

        let mut tampered = FIXTURE_MANIFEST.to_vec();
        let signed_version = verified.manifest.artifact.version.as_bytes();
        let position = tampered
            .windows(signed_version.len())
            .position(|part| part == signed_version)
            .expect("version in fixture");
        tampered[position] = b'9';
        assert_eq!(
            trust_store()
                .verify_exact_bytes(FIXTURE_KEY_ID, &tampered, FIXTURE_SIGNATURE, &environment(),)
                .expect_err("tampering must fail")
                .code,
            ManifestErrorCode::InvalidSignature
        );
    }

    #[test]
    fn accepts_raw_and_tauri_wrapped_signature_but_rejects_malformed_wrapper() {
        let decoded = STANDARD.decode(FIXTURE_SIGNATURE.trim()).unwrap();
        let raw_signature = std::str::from_utf8(&decoded).unwrap();
        assert!(trust_store()
            .verify_exact_bytes(
                FIXTURE_KEY_ID,
                FIXTURE_MANIFEST,
                raw_signature,
                &environment(),
            )
            .is_ok());
        assert_eq!(
            trust_store()
                .verify_exact_bytes(
                    FIXTURE_KEY_ID,
                    FIXTURE_MANIFEST,
                    "dGhpcy1pcy1ub3QtYS1taW5pc2lnbi1zaWduYXR1cmU=",
                    &environment(),
                )
                .expect_err("malformed wrapped signature must fail")
                .code,
            ManifestErrorCode::InvalidSignature
        );
    }

    #[test]
    fn rejects_wrong_key_sequence_platform_os_and_protocol() {
        let store = trust_store();
        let mut cases = Vec::new();
        let mut sequence = environment();
        sequence.minimum_sequence = 2;
        cases.push((sequence, ManifestErrorCode::RollbackRejected));
        let mut platform = environment();
        platform.platform = RuntimePlatform::Windows;
        cases.push((platform, ManifestErrorCode::UnsupportedPlatform));
        let mut architecture = environment();
        architecture.architecture = RuntimeArchitecture::X86_64;
        cases.push((architecture, ManifestErrorCode::UnsupportedArchitecture));
        let mut os = environment();
        os.os_version = "11.7".to_string();
        cases.push((os, ManifestErrorCode::UnsupportedOs));
        let mut protocol = environment();
        protocol.protocol_version = 0;
        cases.push((protocol, ManifestErrorCode::ProtocolTooOld));

        for (environment, expected) in cases {
            assert_eq!(
                store
                    .verify_exact_bytes(
                        FIXTURE_KEY_ID,
                        FIXTURE_MANIFEST,
                        FIXTURE_SIGNATURE,
                        &environment,
                    )
                    .expect_err("environment mismatch must fail")
                    .code,
                expected
            );
        }
        assert_eq!(
            store
                .verify_exact_bytes(
                    "unknown-runtime-key",
                    FIXTURE_MANIFEST,
                    FIXTURE_SIGNATURE,
                    &environment(),
                )
                .expect_err("unknown key must fail")
                .code,
            ManifestErrorCode::UnknownKey
        );
    }

    #[test]
    fn declared_symlink_must_remain_inside_candidate_root() {
        assert!(validate_symlinks(&[RuntimeDeclaredSymlink {
            path: "App/Framework.framework/Versions/Current".to_string(),
            target: "150.0.1".to_string(),
        }])
        .is_ok());
        assert_eq!(
            validate_symlinks(&[RuntimeDeclaredSymlink {
                path: "App/Framework.framework/Versions/Current".to_string(),
                target: "../../../../../../tmp/escape".to_string(),
            }])
            .expect_err("escaping link must fail")
            .code,
            ManifestErrorCode::InvalidField
        );
    }

    #[test]
    fn dotted_versions_compare_without_lexical_ordering_bugs() {
        assert_eq!(
            compare_dotted_versions("14.10", "14.9").unwrap(),
            std::cmp::Ordering::Greater
        );
        assert_eq!(
            compare_dotted_versions("12.0", "12.0.0").unwrap(),
            std::cmp::Ordering::Equal
        );
        assert!(compare_dotted_versions("12.beta", "12.0").is_err());
    }
}
