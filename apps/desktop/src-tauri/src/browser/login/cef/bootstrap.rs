use super::{
    availability::{self, CefAvailability},
    pump::CefExternalPump,
    surface, tao_application,
};
use cef::*;
use rand::{rngs::OsRng, RngCore};
use serde::Serialize;
use std::{
    ffi::CString,
    fs::{self, OpenOptions},
    io::{BufReader, Read, Write},
    os::unix::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

const FRAMEWORK_RELATIVE_PATH: &str =
    "../Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework";
const CONTEXT_INITIALIZATION_TIMEOUT: Duration = Duration::from_secs(10);
const CCEM_BUNDLE_IDENTIFIER: &str = "com.ccem.desktop";
const CREDENTIAL_STORE_MARKER: &str = ".ccem-credential-store";
const CREDENTIAL_STORE_MARKER_SCHEMA_VERSION: u32 = 2;
const MAX_CREDENTIAL_STORE_MARKER_BYTES: u64 = 4096;
const CHROMIUM_SAFE_STORAGE_SERVICE: &[u8; 21] = b"Chromium Safe Storage";
const CCEM_SAFE_STORAGE_SERVICE_SLOT: &[u8; 21] = b"CCEM Safe Storage\0\0\0\0";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CefRuntimeLayout {
    pub(crate) framework_path: PathBuf,
    pub(crate) browser_subprocess_path: Option<PathBuf>,
    pub(crate) bundled: bool,
    pub(crate) sandbox_enabled: bool,
    /// Windows-only runtime proof. It remains false on macOS so the shared
    /// Windows CI-smoke types can compile without claiming the feature there.
    pub(crate) network_service_sandbox_requested: bool,
    pub(crate) network_service_lpac_requested: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CefCredentialStorePolicy {
    SystemKeychain,
    MockKeychain,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CefCredentialStoreMarker<'a> {
    schema_version: u32,
    credential_store: &'a str,
    application_identifier: &'a str,
    team_identifier: Option<&'a str>,
    safe_storage_service: Option<&'a str>,
    derivation: &'a str,
}

pub(crate) fn should_append_mock_keychain_switch(
    policy: CefCredentialStorePolicy,
    process_type: Option<&str>,
) -> bool {
    policy == CefCredentialStorePolicy::MockKeychain && process_type.is_none_or(str::is_empty)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VerifiedMacCodeSignature {
    pub(crate) _private: (),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VerifiedMacSafeStorageBranding {
    pub(crate) _private: (),
}

pub(crate) fn credential_store_policy(
    layout: &CefRuntimeLayout,
    debug_build: bool,
    signature: Option<&VerifiedMacCodeSignature>,
    safe_storage_branding: Option<&VerifiedMacSafeStorageBranding>,
) -> Result<CefCredentialStorePolicy, String> {
    // A development CEF binary has no stable signed identity. Letting Chromium use the
    // macOS Keychain from that process causes repeated "Safe Storage" authorization
    // prompts and can accidentally bind a profile to a throw-away debug executable.
    if debug_build {
        return Ok(CefCredentialStorePolicy::MockKeychain);
    }

    // Chromium's mock keychain uses a fixed testing key. It is acceptable only for an
    // explicitly non-production debug build. A release build must fail closed instead
    // of either prompting from an unsigned identity or persisting credentials with the
    // predictable mock key.
    if !layout.bundled {
        return Err("Mode 2 is disabled for unbundled release runtimes".to_string());
    }

    signature.ok_or_else(|| {
        "Mode 2 is disabled because the CCEM application signature could not be verified"
            .to_string()
    })?;
    safe_storage_branding.ok_or_else(|| {
        "Mode 2 is disabled because the bundled CEF runtime is not branded for CCEM Safe Storage"
            .to_string()
    })?;

    Ok(CefCredentialStorePolicy::SystemKeychain)
}

fn count_safe_storage_service_literals(mut reader: impl Read) -> Result<(usize, usize), String> {
    const CHUNK_SIZE: usize = 1024 * 1024;
    const OVERLAP: usize = CHROMIUM_SAFE_STORAGE_SERVICE.len() - 1;
    let mut chunk = vec![0_u8; CHUNK_SIZE];
    let mut carry = Vec::with_capacity(OVERLAP);
    let mut chromium_count = 0_usize;
    let mut ccem_count = 0_usize;
    loop {
        let count = reader
            .read(&mut chunk)
            .map_err(|error| format!("read bundled CEF Safe Storage identity: {error}"))?;
        if count == 0 {
            break;
        }
        let mut bytes = Vec::with_capacity(carry.len() + count);
        bytes.extend_from_slice(&carry);
        bytes.extend_from_slice(&chunk[..count]);
        for window in bytes.windows(CHROMIUM_SAFE_STORAGE_SERVICE.len()) {
            if window == CHROMIUM_SAFE_STORAGE_SERVICE {
                chromium_count = chromium_count.saturating_add(1);
            }
            if window == CCEM_SAFE_STORAGE_SERVICE_SLOT {
                ccem_count = ccem_count.saturating_add(1);
            }
        }
        carry.clear();
        carry.extend_from_slice(&bytes[bytes.len().saturating_sub(OVERLAP)..]);
    }
    Ok((chromium_count, ccem_count))
}

pub(crate) fn verify_safe_storage_branding(
    framework_executable: &Path,
) -> Result<VerifiedMacSafeStorageBranding, String> {
    let file = fs::File::open(framework_executable).map_err(|error| {
        format!(
            "open bundled CEF framework for Safe Storage verification {}: {error}",
            framework_executable.display()
        )
    })?;
    let (chromium_count, ccem_count) = count_safe_storage_service_literals(BufReader::new(file))?;
    if chromium_count != 0 || ccem_count != 1 {
        return Err(format!(
            "bundled CEF Safe Storage branding is invalid: Chromium={chromium_count}, CCEM={ccem_count}"
        ));
    }
    Ok(VerifiedMacSafeStorageBranding { _private: () })
}

fn app_bundle_for_executable(executable: &Path) -> Result<&Path, String> {
    let macos_dir = executable
        .parent()
        .ok_or_else(|| "CCEM executable has no parent directory".to_string())?;
    let contents_dir = macos_dir
        .parent()
        .ok_or_else(|| "CCEM executable is not inside an application bundle".to_string())?;
    let app_bundle = contents_dir
        .parent()
        .ok_or_else(|| "CCEM executable is not inside an application bundle".to_string())?;

    if macos_dir.file_name().and_then(|value| value.to_str()) != Some("MacOS")
        || contents_dir.file_name().and_then(|value| value.to_str()) != Some("Contents")
        || app_bundle.extension().and_then(|value| value.to_str()) != Some("app")
    {
        return Err("CCEM executable is not inside a macOS .app bundle".to_string());
    }

    Ok(app_bundle)
}

fn requirement_string_literal(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

pub(crate) fn distribution_code_requirement(
    team_identifier: &str,
    signing_identity: &str,
) -> Result<String, String> {
    let team_identifier = team_identifier.trim();
    if team_identifier.len() != 10
        || !team_identifier
            .bytes()
            .all(|value| value.is_ascii_uppercase() || value.is_ascii_digit())
    {
        return Err("release build has no valid Apple Team ID".to_string());
    }

    let signing_identity = signing_identity.trim();
    let required_prefix = "Developer ID Application: ";
    let required_suffix = format!(" ({team_identifier})");
    if !signing_identity.starts_with(required_prefix)
        || !signing_identity.ends_with(&required_suffix)
        || signing_identity.bytes().any(|value| value < b' ')
    {
        return Err("release build has no valid Developer ID Application identity".to_string());
    }

    Ok(format!(
        "anchor apple generic and identifier {} and certificate leaf[subject.OU] = {} and certificate leaf[subject.CN] = {}",
        requirement_string_literal(CCEM_BUNDLE_IDENTIFIER),
        requirement_string_literal(team_identifier),
        requirement_string_literal(signing_identity),
    ))
}

pub(crate) fn verify_distribution_signature(
    executable: &Path,
    team_identifier: &str,
    signing_identity: &str,
) -> Result<VerifiedMacCodeSignature, String> {
    let app_bundle = app_bundle_for_executable(executable)?;
    let requirement = distribution_code_requirement(team_identifier, signing_identity)?;
    let verification = Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict", "--verbose=4"])
        .arg(app_bundle)
        .output()
        .map_err(|error| format!("run macOS code-signature verification: {error}"))?;
    if !verification.status.success() {
        return Err(format!(
            "CCEM application signature verification failed: {}",
            String::from_utf8_lossy(&verification.stderr).trim()
        ));
    }

    // Validate the dynamic code object that is actually executing, not merely a path that could
    // be swapped after inspection. The explicit requirement supplies the policy that ordinary
    // `codesign --verify` intentionally does not: Apple trust anchor, CCEM identifier, official
    // Team ID, and the exact Developer ID Application certificate identity embedded at build time.
    verify_current_process_requirement(&requirement)?;

    Ok(VerifiedMacCodeSignature { _private: () })
}

pub(crate) fn verify_current_process_requirement(requirement: &str) -> Result<(), String> {
    let dynamic_target = format!("+{}", std::process::id());
    let dynamic_verification = Command::new("/usr/bin/codesign")
        .args(["--verify", "--verbose=4", "-R"])
        .arg(format!("={requirement}"))
        .arg(dynamic_target)
        .output()
        .map_err(|error| format!("run current-process code-requirement verification: {error}"))?;
    if !dynamic_verification.status.success() {
        return Err(format!(
            "CCEM application does not satisfy its trusted release requirement: {}",
            String::from_utf8_lossy(&dynamic_verification.stderr).trim()
        ));
    }
    Ok(())
}

pub(crate) fn expected_credential_store_marker(
    policy: CefCredentialStorePolicy,
    team_identifier: Option<&str>,
) -> Result<Vec<u8>, String> {
    let marker = match policy {
        CefCredentialStorePolicy::SystemKeychain => {
            let team_identifier = team_identifier.ok_or_else(|| {
                "system Keychain credential marker requires the verified Apple Team ID".to_string()
            })?;
            if team_identifier.len() != 10
                || !team_identifier
                    .bytes()
                    .all(|value| value.is_ascii_uppercase() || value.is_ascii_digit())
            {
                return Err(
                    "system Keychain credential marker has an invalid Apple Team ID".to_string(),
                );
            }
            CefCredentialStoreMarker {
                schema_version: CREDENTIAL_STORE_MARKER_SCHEMA_VERSION,
                credential_store: "macos-system-keychain",
                application_identifier: CCEM_BUNDLE_IDENTIFIER,
                team_identifier: Some(team_identifier),
                safe_storage_service: Some("CCEM Safe Storage"),
                derivation: "cef-binary-null-padded-service-v1",
            }
        }
        CefCredentialStorePolicy::MockKeychain => {
            if team_identifier.is_some() {
                return Err(
                    "mock Keychain credential marker must not carry an Apple Team ID".to_string(),
                );
            }
            CefCredentialStoreMarker {
                schema_version: CREDENTIAL_STORE_MARKER_SCHEMA_VERSION,
                credential_store: "chromium-mock-keychain",
                application_identifier: CCEM_BUNDLE_IDENTIFIER,
                team_identifier: None,
                safe_storage_service: None,
                derivation: "chromium-use-mock-keychain-switch-v1",
            }
        }
    };
    let mut contents = serde_json::to_vec(&marker)
        .map_err(|error| format!("serialize CEF credential-store marker: {error}"))?;
    contents.push(b'\n');
    Ok(contents)
}

fn secure_credential_store_root(cache_root: &Path) -> Result<(), String> {
    if !cache_root.is_absolute() {
        return Err("CEF credential-store root must be absolute".to_string());
    }
    match fs::symlink_metadata(cache_root) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => {
            return Err(format!(
                "CEF credential-store root is not a real directory: {}",
                cache_root.display()
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(cache_root).map_err(|error| {
                format!("create CEF cache root {}: {error}", cache_root.display())
            })?;
        }
        Err(error) => {
            return Err(format!(
                "inspect CEF credential-store root {}: {error}",
                cache_root.display()
            ));
        }
    }
    let metadata = fs::symlink_metadata(cache_root).map_err(|error| {
        format!(
            "inspect created CEF credential-store root {}: {error}",
            cache_root.display()
        )
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(format!(
            "CEF credential-store root is not a real directory: {}",
            cache_root.display()
        ));
    }
    if metadata.uid() != unsafe { libc::geteuid() } {
        return Err("CEF credential-store root is not owned by the current user".to_string());
    }
    fs::set_permissions(cache_root, fs::Permissions::from_mode(0o700)).map_err(|error| {
        format!(
            "secure CEF credential-store root {}: {error}",
            cache_root.display()
        )
    })
}

pub(crate) fn validate_credential_store_marker(
    marker: &Path,
    expected: &[u8],
) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let mut file = options.open(marker).map_err(|error| {
        format!(
            "open CEF credential-store marker {} without following links: {error}",
            marker.display()
        )
    })?;
    let metadata = file.metadata().map_err(|error| {
        format!(
            "inspect CEF credential-store marker {}: {error}",
            marker.display()
        )
    })?;
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o777 != 0o600
        || metadata.len() > MAX_CREDENTIAL_STORE_MARKER_BYTES
    {
        return Err(format!(
            "CEF credential-store marker has unsafe type, ownership, links, mode, or size: {}",
            marker.display()
        ));
    }
    let mut actual = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut actual).map_err(|error| {
        format!(
            "read CEF credential-store marker {}: {error}",
            marker.display()
        )
    })?;
    if actual != expected {
        return Err(format!(
            "CEF profile credential-store identity mismatch at {}",
            marker.display()
        ));
    }
    Ok(())
}

fn write_credential_store_marker_atomically(
    cache_root: &Path,
    marker: &Path,
    expected: &[u8],
) -> Result<(), String> {
    let mut nonce = [0_u8; 8];
    OsRng.fill_bytes(&mut nonce);
    let temporary = cache_root.join(format!(
        ".{CREDENTIAL_STORE_MARKER}.tmp-{}-{}",
        std::process::id(),
        u64::from_le_bytes(nonce)
    ));
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let mut file = options.open(&temporary).map_err(|error| {
        format!(
            "create private CEF credential-store marker temporary {}: {error}",
            temporary.display()
        )
    })?;
    let write_result = (|| {
        file.write_all(expected)
            .map_err(|error| format!("write CEF credential-store marker temporary: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("sync CEF credential-store marker temporary: {error}"))?;
        drop(file);
        match fs::hard_link(&temporary, marker) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                fs::remove_file(&temporary).map_err(|remove_error| {
                    format!("remove raced CEF credential-store marker temporary: {remove_error}")
                })?;
                return validate_credential_store_marker(marker, expected);
            }
            Err(error) => {
                return Err(format!(
                    "atomically publish CEF credential-store marker {}: {error}",
                    marker.display()
                ));
            }
        }
        fs::remove_file(&temporary)
            .map_err(|error| format!("remove CEF credential-store marker temporary: {error}"))?;
        fs::File::open(cache_root)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("sync CEF credential-store root: {error}"))?;
        validate_credential_store_marker(marker, expected)
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

pub(crate) fn ensure_credential_store_marker(
    cache_root: &Path,
    policy: CefCredentialStorePolicy,
    team_identifier: Option<&str>,
) -> Result<(), String> {
    secure_credential_store_root(cache_root)?;
    let marker = cache_root.join(CREDENTIAL_STORE_MARKER);
    let expected = expected_credential_store_marker(policy, team_identifier)?;
    match fs::symlink_metadata(&marker) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
            return validate_credential_store_marker(&marker, &expected);
        }
        Ok(_) => {
            return Err(format!(
                "CEF credential-store marker is not a regular file: {}",
                marker.display()
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "inspect CEF credential-store marker {}: {error}",
                marker.display()
            ));
        }
    }

    let has_existing_state = fs::read_dir(cache_root)
        .map_err(|error| {
            format!(
                "inspect unmarked CEF credential-store root {}: {error}",
                cache_root.display()
            )
        })?
        .next()
        .transpose()
        .map_err(|error| format!("inspect unmarked CEF credential-store entry: {error}"))?
        .is_some();
    if has_existing_state {
        // A concurrent legitimate initializer may have published the exact marker after the first
        // lstat. Anything else is an unmarked profile and must never be silently adopted.
        if fs::symlink_metadata(&marker)
            .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
        {
            return validate_credential_store_marker(&marker, &expected);
        }
        return Err(format!(
            "CEF credential-store root contains state but no trusted identity marker: {}",
            cache_root.display()
        ));
    }
    write_credential_store_marker_atomically(cache_root, &marker, &expected)
}

pub(crate) fn resolve_runtime_layout(
    executable: &Path,
    framework_override: Option<&Path>,
) -> Result<CefRuntimeLayout, String> {
    if let Some(framework_path) = framework_override {
        let framework_path = require_file(framework_path, "CEF framework override")?;
        let executable_dir = executable
            .parent()
            .ok_or_else(|| "CCEM executable has no parent directory".to_string())?;
        let helper_name = format!("ccem-cef-helper{}", std::env::consts::EXE_SUFFIX);
        let browser_subprocess_path =
            require_file(&executable_dir.join(helper_name), "CEF development helper")?;
        return Ok(CefRuntimeLayout {
            framework_path,
            browser_subprocess_path: Some(browser_subprocess_path),
            bundled: false,
            // The cef-rs sandbox loader requires the final Helper.app layout.
            sandbox_enabled: false,
            network_service_sandbox_requested: false,
            network_service_lpac_requested: false,
        });
    }

    let executable_dir = executable
        .parent()
        .ok_or_else(|| "CCEM executable has no parent directory".to_string())?;
    let framework_path = require_file(
        &executable_dir.join(FRAMEWORK_RELATIVE_PATH),
        "bundled CEF framework",
    )?;
    Ok(CefRuntimeLayout {
        framework_path,
        browser_subprocess_path: None,
        bundled: true,
        sandbox_enabled: true,
        network_service_sandbox_requested: false,
        network_service_lpac_requested: false,
    })
}

fn require_file(path: &Path, label: &str) -> Result<PathBuf, String> {
    if !path.is_file() {
        return Err(format!("{label} is missing at {}", path.display()));
    }
    path.canonicalize()
        .map_err(|error| format!("resolve {label} {}: {error}", path.display()))
}

enum FrameworkLoaderGuard {
    Bundled(cef::library_loader::LibraryLoader),
    Explicit,
}

impl FrameworkLoaderGuard {
    fn load(executable: &Path, layout: &CefRuntimeLayout) -> Result<Self, String> {
        if layout.bundled {
            let loader = cef::library_loader::LibraryLoader::new(executable, false);
            if !loader.load() {
                return Err("CEF rejected the bundled framework".to_string());
            }
            return Ok(Self::Bundled(loader));
        }

        let path = CString::new(layout.framework_path.as_os_str().as_bytes())
            .map_err(|_| "CEF framework path contains an embedded NUL".to_string())?;
        let loaded = unsafe { cef::load_library(Some(&*path.as_ptr())) };
        if loaded != 1 {
            return Err(format!(
                "CEF rejected framework override {}",
                layout.framework_path.display()
            ));
        }
        Ok(Self::Explicit)
    }
}

impl Drop for FrameworkLoaderGuard {
    fn drop(&mut self) {
        if matches!(self, Self::Explicit) && cef::unload_library() != 1 {
            eprintln!("CEF framework override did not unload cleanly");
        }
    }
}

cef::wrap_browser_process_handler! {
    struct CcemBrowserProcessHandler {
        pump: CefExternalPump,
        context_initialized: Arc<AtomicBool>,
    }

    impl BrowserProcessHandler {
        fn on_context_initialized(&self) {
            self.context_initialized.store(true, Ordering::SeqCst);
        }

        fn on_schedule_message_pump_work(&self, delay_ms: i64) {
            self.pump.schedule_message_pump_work(delay_ms);
        }
    }
}

cef::wrap_app! {
    struct CcemCefApp {
        pump: CefExternalPump,
        context_initialized: Arc<AtomicBool>,
        credential_store_policy: CefCredentialStorePolicy,
    }

    impl App {
        fn on_before_command_line_processing(
            &self,
            process_type: Option<&CefString>,
            command_line: Option<&mut CommandLine>,
        ) {
            let process_type = process_type.map(|value| value.to_string());
            if !should_append_mock_keychain_switch(
                self.credential_store_policy,
                process_type.as_deref(),
            ) {
                return;
            }

            let Some(command_line) = command_line else {
                return;
            };
            let mock_keychain = CefString::from("use-mock-keychain");
            command_line.append_switch(Some(&mock_keychain));
        }

        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> {
            Some(CcemBrowserProcessHandler::new(
                self.pump.clone(),
                self.context_initialized.clone(),
            ))
        }
    }
}

pub(crate) struct CefProcess {
    pump: CefExternalPump,
    app: Option<App>,
    loader: Option<FrameworkLoaderGuard>,
    initialized: bool,
    shutdown_prepared: bool,
    layout: CefRuntimeLayout,
}

impl CefProcess {
    pub(crate) fn initialize(
        executable: &Path,
        framework_override: Option<&Path>,
        cache_root: &Path,
    ) -> Result<Self, String> {
        match availability::detect() {
            CefAvailability::Available => {}
            CefAvailability::UnsupportedMacOs {
                required_major,
                actual_major,
                actual_minor,
                actual_patch,
            } => {
                return Err(format!(
                    "Mode 2 requires macOS {required_major} or newer; current version is {actual_major}.{actual_minor}.{actual_patch}"
                ));
            }
            CefAvailability::UnsupportedPlatform => {
                return Err("embedded CEF is unavailable on this platform".to_string());
            }
        }

        let layout = resolve_runtime_layout(executable, framework_override)?;
        let (signature, safe_storage_branding, team_identifier) = if cfg!(debug_assertions) {
            (None, None, None)
        } else {
            let team_identifier = option_env!("CCEM_OFFICIAL_APPLE_TEAM_ID").ok_or_else(|| {
                "Mode 2 is disabled because this release has no pinned official Apple Team ID"
                    .to_string()
            })?;
            let signing_identity = option_env!("CCEM_APPLE_SIGNING_IDENTITY").ok_or_else(|| {
                "Mode 2 is disabled because this release has no embedded signing identity"
                    .to_string()
            })?;
            let signature =
                verify_distribution_signature(executable, team_identifier, signing_identity)?;
            let branding = verify_safe_storage_branding(&layout.framework_path)?;
            (Some(signature), Some(branding), Some(team_identifier))
        };
        let credential_store_policy = credential_store_policy(
            &layout,
            cfg!(debug_assertions),
            signature.as_ref(),
            safe_storage_branding.as_ref(),
        )?;
        ensure_credential_store_marker(cache_root, credential_store_policy, team_identifier)?;
        let loader = FrameworkLoaderGuard::load(executable, &layout)?;

        // No CEF-owned value may be constructed before these two operations.
        let api_hash = cef::api_hash(cef::sys::CEF_API_VERSION_LAST, 0);
        if api_hash.is_null() {
            return Err("CEF API table initialization returned no hash".to_string());
        }
        let protocol_audit = tao_application::install()?;
        if !protocol_audit.ready() {
            return Err("TaoApp does not satisfy the CEF protocol contract".to_string());
        }

        let args = cef::args::Args::new();
        let pump = CefExternalPump::new();
        let context_initialized = Arc::new(AtomicBool::new(false));
        let mut app = CcemCefApp::new(
            pump.clone(),
            context_initialized.clone(),
            credential_store_policy,
        );
        let execute_result = cef::execute_process(
            Some(args.as_main_args()),
            Some(&mut app),
            std::ptr::null_mut(),
        );
        if execute_result != -1 {
            return Err(format!(
                "CEF browser process unexpectedly exited with code {execute_result}"
            ));
        }

        let cache = CefString::from(cache_root.to_string_lossy().as_ref());
        let browser_subprocess_path = layout
            .browser_subprocess_path
            .as_ref()
            .map(|path| CefString::from(path.to_string_lossy().as_ref()))
            .unwrap_or_default();
        let (framework_dir_path, resources_dir_path) = if layout.bundled {
            (CefString::default(), CefString::default())
        } else {
            let framework_dir = layout.framework_path.parent().ok_or_else(|| {
                "CEF framework override has no framework bundle parent".to_string()
            })?;
            let resources_dir = framework_dir.join("Resources");
            if !resources_dir.is_dir() {
                pump.stop();
                return Err(format!(
                    "CEF framework resources are missing at {}",
                    resources_dir.display()
                ));
            }
            (
                CefString::from(framework_dir.to_string_lossy().as_ref()),
                CefString::from(resources_dir.to_string_lossy().as_ref()),
            )
        };
        let settings = Settings {
            no_sandbox: if layout.sandbox_enabled { 0 } else { 1 },
            browser_subprocess_path,
            framework_dir_path,
            resources_dir_path,
            multi_threaded_message_loop: 0,
            external_message_pump: 1,
            root_cache_path: cache.clone(),
            // Persistent Login Browser state lives in per-profile RequestContexts. The global
            // context stays in-memory so every cache path remains a direct child of root_cache.
            cache_path: CefString::default(),
            ..Default::default()
        };
        let initialized = cef::initialize(
            Some(args.as_main_args()),
            Some(&settings),
            Some(&mut app),
            std::ptr::null_mut(),
        ) == 1;
        if !initialized {
            pump.stop();
            return Err("CEF initialization returned false".to_string());
        }

        let deadline = Instant::now() + CONTEXT_INITIALIZATION_TIMEOUT;
        while !context_initialized.load(Ordering::SeqCst) {
            if Instant::now() >= deadline {
                pump.stop();
                cef::shutdown();
                return Err("CEF context initialization timed out".to_string());
            }
            pump.do_message_loop_work();
            std::thread::sleep(Duration::from_millis(1));
        }

        Ok(Self {
            pump,
            app: Some(app),
            loader: Some(loader),
            initialized,
            shutdown_prepared: false,
            layout,
        })
    }

    pub(crate) fn layout(&self) -> &CefRuntimeLayout {
        &self.layout
    }

    pub(crate) fn pump_once(&self) {
        self.pump.do_message_loop_work();
    }

    pub(crate) fn prepare_shutdown(&mut self) -> Result<(), String> {
        if !self.initialized || self.shutdown_prepared {
            return Ok(());
        }
        surface::macos::shutdown_all(&self.pump)?;
        self.shutdown_prepared = true;
        Ok(())
    }

    pub(crate) fn finish_shutdown(mut self) -> Result<(), String> {
        if self.initialized {
            if !self.shutdown_prepared {
                // The AppKit event loop is already gone, so it is no longer safe to
                // close windowed browsers here. Retain all CEF state until the OS exits
                // instead of unloading live function tables.
                std::mem::forget(self);
                return Err(
                    "CEF shutdown reached finalization without a completed close drain".to_string(),
                );
            }
            if let Err(error) = self.pump.drain_after_app_loop() {
                // Never drop the App or framework loader while CEF may still own references into
                // them. A failed bounded drain is safer as a process-lifetime retention than an
                // attempted unload of live Chromium state.
                std::mem::forget(self);
                return Err(error);
            }
            self.pump.stop();
            cef::shutdown();
            self.initialized = false;
        }
        drop(self.app.take());
        drop(self.loader.take());
        Ok(())
    }
}
