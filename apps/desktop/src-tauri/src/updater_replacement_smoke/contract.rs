use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const EXIT_GATE_REJECTED: i32 = 86;
pub const EXIT_SMOKE_FAILED: i32 = 87;
const FIRST_RECEIPT_SHA256: &str =
    "0000000000000000000000000000000000000000000000000000000000000000";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SmokeRunIdentity {
    pub id: String,
    pub attempt: String,
    pub challenge_nonce: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviousIdentity {
    pub source_commit: String,
    pub version: String,
    pub executable_sha256: String,
    pub embedded_updater_public_key_sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdaterConfig {
    pub public_key: String,
    pub public_key_sha256: String,
    pub artifact_sha256: String,
    pub negative_endpoint: String,
    pub positive_endpoint: String,
    pub ca_pem_path: PathBuf,
    pub nonce_header_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SmokeConfig {
    pub schema_version: u32,
    pub proof_class: String,
    pub platform: String,
    pub target: String,
    pub run: SmokeRunIdentity,
    pub context_sha256: String,
    pub source_commit: String,
    pub previous: PreviousIdentity,
    pub current_version: String,
    pub current_executable_sha256: String,
    pub updater: UpdaterConfig,
    pub shared_root: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ActorRole {
    PreviousApp,
    CurrentApp,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppBootRecord {
    pub schema_version: u32,
    pub pid: u32,
    pub role: ActorRole,
    pub challenge_nonce: String,
    pub canonical_image_path: PathBuf,
    pub image_sha256: String,
    pub runtime_version: String,
    pub embedded_source_commit: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub os_start_token: String,
    pub canonical_image_path: PathBuf,
    pub image_sha256: String,
    pub runtime_version: String,
    pub embedded_source_commit: String,
    pub challenge_nonce: String,
    pub process_identity_sha256: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageReceipt {
    pub name: String,
    pub sequence: usize,
    pub actor: String,
    pub process_identity_sha256: String,
    pub clock: String,
    pub boot_monotonic_ms: u64,
    pub wall_clock_utc: String,
    pub evidence_sha256: String,
    pub context_sha256: String,
    pub previous_receipt_sha256: String,
    pub receipt_sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StageReceiptPayload<'a> {
    name: &'a str,
    sequence: usize,
    actor: &'a str,
    process_identity_sha256: &'a str,
    clock: &'static str,
    boot_monotonic_ms: u64,
    wall_clock_utc: &'a str,
    evidence_sha256: &'a str,
    context_sha256: &'a str,
    previous_receipt_sha256: &'a str,
}

fn exact_lower_hex(value: &str, length: usize, label: &str) -> Result<(), String> {
    if value.len() != length
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!("{label} must be exact lowercase hex"));
    }
    Ok(())
}

fn validate_regular_no_link(candidate: &Path, label: &str) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(candidate)
        .map_err(|error| format!("inspect {label} {}: {error}", candidate.display()))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(format!("{label} must be a regular non-link file"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(format!("{label} must not be a reparse point"));
        }
    }
    Ok(())
}

fn validate_directory_no_link(candidate: &Path, label: &str) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(candidate)
        .map_err(|error| format!("inspect {label} {}: {error}", candidate.display()))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(format!("{label} must be a regular non-link directory"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(format!("{label} must not be a reparse point"));
        }
    }
    Ok(())
}

fn strip_windows_verbatim_prefix(value: &str) -> String {
    let normalized = value.replace('/', "\\");
    let folded = normalized.to_ascii_lowercase();
    if folded.starts_with(r"\\?\unc\") {
        return format!(r"\\{}", &normalized[8..]);
    }
    if folded.starts_with(r"\\?\") || folded.starts_with(r"\??\") {
        return normalized[4..].to_string();
    }
    normalized
}

fn normalize_windows_path_identity_text(value: &str) -> String {
    strip_windows_verbatim_prefix(value).to_lowercase()
}

pub fn canonical_path_for_evidence(candidate: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(strip_windows_verbatim_prefix(&candidate.to_string_lossy()))
    }
    #[cfg(not(windows))]
    {
        candidate.to_path_buf()
    }
}

pub fn same_path_identity(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        normalize_windows_path_identity_text(&left.to_string_lossy())
            == normalize_windows_path_identity_text(&right.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn path_is_within_identity(candidate: &Path, root: &Path) -> bool {
    #[cfg(windows)]
    {
        let candidate = normalize_windows_path_identity_text(&candidate.to_string_lossy());
        let root = normalize_windows_path_identity_text(&root.to_string_lossy());
        if candidate == root {
            return true;
        }
        let prefix = if root.ends_with('\\') {
            root
        } else {
            format!("{root}\\")
        };
        candidate.starts_with(&prefix)
    }
    #[cfg(not(windows))]
    {
        candidate.starts_with(root)
    }
}

fn validate_smoke_endpoint(value: &str, challenge_nonce: &str, phase: &str) -> Result<Url, String> {
    let endpoint = Url::parse(value)
        .map_err(|error| format!("parse {phase} updater smoke endpoint: {error}"))?;
    let expected_path = format!("/{challenge_nonce}/{phase}/manifest");
    if endpoint.scheme() != "https"
        || endpoint.host_str() != Some("127.0.0.1")
        || endpoint.port().is_none()
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
        || endpoint.path() != expected_path
    {
        return Err(format!(
            "{phase} updater smoke endpoint must be exact loopback HTTPS with an explicit port and challenge-bound manifest path"
        ));
    }
    Ok(endpoint)
}

impl SmokeConfig {
    pub fn boot_path(&self, pid: u32) -> PathBuf {
        self.shared_root.join(format!("boot-{pid}.json"))
    }

    pub fn identity_path(&self, pid: u32) -> PathBuf {
        self.shared_root.join(format!("identity-{pid}.json"))
    }

    pub fn signal_path(&self, name: &str) -> PathBuf {
        self.shared_root.join(format!("signal-{name}.json"))
    }

    pub fn stage_path(&self, sequence: usize, name: &str) -> PathBuf {
        self.shared_root
            .join(format!("stage-{sequence:02}-{name}.json"))
    }

    pub fn stage_detail_path(&self, sequence: usize, name: &str) -> PathBuf {
        self.shared_root
            .join(format!("stage-{sequence:02}-{name}.detail.json"))
    }
}

pub fn load_config(candidate: &Path) -> Result<SmokeConfig, String> {
    validate_regular_no_link(candidate, "smoke config")?;
    let bytes = std::fs::read(candidate)
        .map_err(|error| format!("read smoke config {}: {error}", candidate.display()))?;
    let mut config: SmokeConfig =
        serde_json::from_slice(&bytes).map_err(|error| format!("parse smoke config: {error}"))?;
    if config.schema_version != 1 || config.proof_class != "instrumented-previous-source" {
        return Err("smoke config schema or proof class mismatch".into());
    }
    if !["macos", "windows"].contains(&config.platform.as_str()) {
        return Err("smoke config platform is unsupported".into());
    }
    for (value, length, label) in [
        (&config.run.challenge_nonce, 64, "challenge nonce"),
        (&config.context_sha256, 64, "context SHA-256"),
        (&config.source_commit, 40, "current source commit"),
        (&config.previous.source_commit, 40, "previous source commit"),
        (
            &config.previous.executable_sha256,
            64,
            "previous executable SHA-256",
        ),
        (
            &config.previous.embedded_updater_public_key_sha256,
            64,
            "previous embedded updater public key SHA-256",
        ),
        (
            &config.current_executable_sha256,
            64,
            "current executable SHA-256",
        ),
        (
            &config.updater.public_key_sha256,
            64,
            "updater public key SHA-256",
        ),
        (
            &config.updater.artifact_sha256,
            64,
            "updater artifact SHA-256",
        ),
    ] {
        exact_lower_hex(value, length, label)?;
    }
    if !config.run.id.bytes().all(|byte| byte.is_ascii_digit())
        || !config.run.attempt.bytes().all(|byte| byte.is_ascii_digit())
        || config.run.id.starts_with('0')
        || config.run.attempt.starts_with('0')
    {
        return Err("smoke run id and attempt must be positive decimal strings".into());
    }
    validate_directory_no_link(&config.shared_root, "smoke shared root")?;
    let root = config
        .shared_root
        .canonicalize()
        .map_err(|error| format!("canonicalize smoke shared root: {error}"))?;
    if !same_path_identity(&root, &config.shared_root) {
        return Err("smoke shared root must already be canonical".into());
    }
    let config_path = candidate
        .canonicalize()
        .map_err(|error| format!("canonicalize smoke config: {error}"))?;
    let ca_path = config
        .updater
        .ca_pem_path
        .canonicalize()
        .map_err(|error| format!("canonicalize updater test CA: {error}"))?;
    if !path_is_within_identity(&config_path, &root) || !path_is_within_identity(&ca_path, &root) {
        return Err("smoke config and test CA must stay inside the shared root".into());
    }
    validate_regular_no_link(&ca_path, "updater test CA")?;
    let negative = validate_smoke_endpoint(
        &config.updater.negative_endpoint,
        &config.run.challenge_nonce,
        "negative",
    )?;
    let positive = validate_smoke_endpoint(
        &config.updater.positive_endpoint,
        &config.run.challenge_nonce,
        "positive",
    )?;
    if negative.port() != positive.port()
        || config.updater.negative_endpoint == config.updater.positive_endpoint
        || !config.updater.nonce_header_name.starts_with("X-")
    {
        return Err("updater smoke endpoints or nonce header are invalid".into());
    }
    config.shared_root = canonical_path_for_evidence(&root);
    config.updater.ca_pem_path = canonical_path_for_evidence(&ca_path);
    Ok(config)
}

pub fn write_json_create_new<T: Serialize>(candidate: &Path, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("serialize {}: {error}", candidate.display()))?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    let mut file = options
        .open(candidate)
        .map_err(|error| format!("create {}: {error}", candidate.display()))?;
    file.write_all(&bytes)
        .and_then(|()| file.write_all(b"\n"))
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("seal {}: {error}", candidate.display()))
}

pub fn wait_for_json<T: for<'de> Deserialize<'de>>(
    candidate: &Path,
    timeout: Duration,
) -> Result<T, String> {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if candidate.exists() {
            validate_regular_no_link(candidate, "smoke handoff")?;
            let bytes = std::fs::read(candidate)
                .map_err(|error| format!("read {}: {error}", candidate.display()))?;
            return serde_json::from_slice(&bytes)
                .map_err(|error| format!("parse {}: {error}", candidate.display()));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    Err(format!("timed out waiting for {}", candidate.display()))
}

fn canonical_json(value: &serde_json::Value) -> Result<String, String> {
    match value {
        serde_json::Value::Null | serde_json::Value::Bool(_) | serde_json::Value::String(_) => {
            serde_json::to_string(value).map_err(|error| error.to_string())
        }
        serde_json::Value::Number(number) => Ok(number.to_string()),
        serde_json::Value::Array(values) => Ok(format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Result<Vec<_>, _>>()?
                .join(",")
        )),
        serde_json::Value::Object(values) => {
            let sorted = values.iter().collect::<BTreeMap<_, _>>();
            let fields = sorted
                .into_iter()
                .map(|(key, value)| {
                    Ok(format!(
                        "{}:{}",
                        serde_json::to_string(key).map_err(|error| error.to_string())?,
                        canonical_json(value)?
                    ))
                })
                .collect::<Result<Vec<_>, String>>()?;
            Ok(format!("{{{}}}", fields.join(",")))
        }
    }
}

pub fn hash_json<T: Serialize>(value: &T) -> Result<String, String> {
    let json = serde_json::to_value(value).map_err(|error| error.to_string())?;
    Ok(format!(
        "{:x}",
        Sha256::digest(canonical_json(&json)?.as_bytes())
    ))
}

fn boot_monotonic_ms() -> Result<u64, String> {
    #[cfg(target_os = "windows")]
    unsafe {
        return Ok(windows_sys::Win32::System::SystemInformation::GetTickCount64());
    }
    #[cfg(target_os = "macos")]
    unsafe {
        let mut value = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        if libc::clock_gettime(libc::CLOCK_UPTIME_RAW, &mut value) != 0 {
            return Err("clock_gettime(CLOCK_UPTIME_RAW) failed".into());
        }
        return Ok(value.tv_sec as u64 * 1_000 + value.tv_nsec as u64 / 1_000_000);
    }
    #[allow(unreachable_code)]
    Err("system-boot monotonic clock is unavailable on this platform".into())
}

fn wall_clock_utc(previous: Option<&StageReceipt>) -> (u64, String) {
    let mut milliseconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    if let Some(previous) = previous {
        let parsed = chrono::DateTime::parse_from_rfc3339(&previous.wall_clock_utc)
            .map(|value| value.timestamp_millis() as u64)
            .unwrap_or(0);
        milliseconds = milliseconds.max(parsed.saturating_add(1));
    }
    let timestamp = chrono::DateTime::from_timestamp_millis(milliseconds as i64)
        .expect("current wall clock is representable")
        .to_utc()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    (milliseconds, timestamp)
}

pub fn read_stage(
    config: &SmokeConfig,
    sequence: usize,
    name: &str,
) -> Result<StageReceipt, String> {
    wait_for_json(&config.stage_path(sequence, name), Duration::from_secs(60))
}

pub fn write_stage<T: Serialize>(
    config: &SmokeConfig,
    identity: &ProcessIdentity,
    sequence: usize,
    name: &str,
    actor: &str,
    detail: &T,
) -> Result<StageReceipt, String> {
    let previous = if sequence == 1 {
        None
    } else {
        let (previous_name, _) = [
            ("badSignatureRejected", "previousApp"),
            ("check", "previousApp"),
            ("download", "previousApp"),
            ("installTransition", "previousApp"),
            ("oldExit", "harness"),
            ("currentStart", "currentApp"),
            ("currentFinalized", "currentApp"),
            ("evidenceSealed", "harness"),
        ][sequence - 2];
        Some(read_stage(config, sequence - 1, previous_name)?)
    };
    let mut boot_ms = boot_monotonic_ms()?;
    if let Some(previous) = previous.as_ref() {
        boot_ms = boot_ms.max(previous.boot_monotonic_ms.saturating_add(1));
    }
    let (_, wall_clock_utc) = wall_clock_utc(previous.as_ref());
    let evidence_sha256 = hash_json(detail)?;
    let previous_receipt_sha256 = previous
        .as_ref()
        .map(|receipt| receipt.receipt_sha256.clone())
        .unwrap_or_else(|| FIRST_RECEIPT_SHA256.to_string());
    let payload = StageReceiptPayload {
        name,
        sequence,
        actor,
        process_identity_sha256: &identity.process_identity_sha256,
        clock: "system-boot-monotonic-ms",
        boot_monotonic_ms: boot_ms,
        wall_clock_utc: &wall_clock_utc,
        evidence_sha256: &evidence_sha256,
        context_sha256: &config.context_sha256,
        previous_receipt_sha256: &previous_receipt_sha256,
    };
    let receipt_sha256 = hash_json(&payload)?;
    let receipt = StageReceipt {
        name: name.to_string(),
        sequence,
        actor: actor.to_string(),
        process_identity_sha256: identity.process_identity_sha256.clone(),
        clock: "system-boot-monotonic-ms".to_string(),
        boot_monotonic_ms: boot_ms,
        wall_clock_utc,
        evidence_sha256,
        context_sha256: config.context_sha256.clone(),
        previous_receipt_sha256,
        receipt_sha256,
    };
    write_json_create_new(&config.stage_detail_path(sequence, name), detail)?;
    write_json_create_new(&config.stage_path(sequence, name), &receipt)?;
    Ok(receipt)
}

pub fn wait_for_identity(
    config: &SmokeConfig,
    boot: &AppBootRecord,
) -> Result<ProcessIdentity, String> {
    let identity: ProcessIdentity =
        wait_for_json(&config.identity_path(boot.pid), Duration::from_secs(60))?;
    if identity.pid != boot.pid
        || !same_path_identity(&identity.canonical_image_path, &boot.canonical_image_path)
        || identity.image_sha256 != boot.image_sha256
        || identity.runtime_version != boot.runtime_version
        || identity.embedded_source_commit != boot.embedded_source_commit
        || identity.challenge_nonce != boot.challenge_nonce
        || identity.process_identity_sha256
            != hash_json(&serde_json::json!({
                "pid": identity.pid,
                "osStartToken": identity.os_start_token,
                "canonicalImagePath": identity.canonical_image_path,
                "imageSha256": identity.image_sha256,
                "runtimeVersion": identity.runtime_version,
                "embeddedSourceCommit": identity.embedded_source_commit,
                "challengeNonce": identity.challenge_nonce,
            }))?
    {
        return Err("harness process identity does not bind the running app".into());
    }
    Ok(identity)
}

#[cfg(test)]
mod tests {
    use super::{
        hash_json, normalize_windows_path_identity_text, strip_windows_verbatim_prefix,
        validate_smoke_endpoint, ActorRole,
    };

    #[test]
    fn canonical_hash_sorts_object_keys() {
        assert_eq!(
            hash_json(&serde_json::json!({"z": 1, "a": [true, null]})).unwrap(),
            hash_json(&serde_json::json!({"a": [true, null], "z": 1})).unwrap(),
        );
    }

    #[test]
    fn actor_roles_use_contract_names() {
        assert_eq!(
            serde_json::to_string(&ActorRole::PreviousApp).unwrap(),
            "\"previousApp\""
        );
        assert_eq!(
            serde_json::to_string(&ActorRole::CurrentApp).unwrap(),
            "\"currentApp\""
        );
    }

    #[test]
    fn windows_verbatim_and_cim_paths_have_one_identity() {
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\D:\runner\fixture\ccem-desktop.exe"),
            r"D:\runner\fixture\ccem-desktop.exe"
        );
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\UNC\server\share\CCEM\ccem-desktop.exe"),
            r"\\server\share\CCEM\ccem-desktop.exe"
        );
        assert_eq!(
            normalize_windows_path_identity_text(r"\\?\D:\RUNNER\Fixture\ccem-desktop.exe"),
            normalize_windows_path_identity_text(r"d:\runner\fixture\ccem-desktop.exe")
        );
    }

    #[test]
    fn updater_endpoint_is_exact_loopback_https_and_challenge_bound() {
        let nonce = "ab".repeat(32);
        assert!(validate_smoke_endpoint(
            &format!("https://127.0.0.1:43123/{nonce}/negative/manifest"),
            &nonce,
            "negative",
        )
        .is_ok());
        for invalid in [
            format!("http://127.0.0.1:43123/{nonce}/negative/manifest"),
            format!("https://localhost:43123/{nonce}/negative/manifest"),
            format!("https://127.0.0.1/{nonce}/negative/manifest"),
            format!("https://127.0.0.1:43123/{nonce}/positive/manifest"),
            format!("https://127.0.0.1:43123/{nonce}/negative/manifest?next=1"),
        ] {
            assert!(validate_smoke_endpoint(&invalid, &nonce, "negative").is_err());
        }
    }
}
