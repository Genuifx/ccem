use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::Instant,
};

#[cfg(not(debug_assertions))]
use super::host::CefHostController;
#[cfg(not(debug_assertions))]
use crate::browser::login::{
    session::LoginBrowserSessionManager, surface_commands::LoginBrowserSurfaceManager,
};
#[cfg(all(windows, not(debug_assertions)))]
use crate::browser::BrowserManager;
#[cfg(all(windows, not(debug_assertions)))]
use std::sync::mpsc;
#[cfg(not(debug_assertions))]
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};
#[cfg(all(windows, not(debug_assertions)))]
use tauri::AppHandle;

pub(crate) const EXIT_GATE_REJECTED: i32 = 82;
pub(crate) const EXIT_SMOKE_FAILED: i32 = 83;
#[cfg(all(windows, not(debug_assertions)))]
const EXIT_SMOKE_TIMEOUT: i32 = 84;

const SCHEMA_VERSION: u32 = 6;
const NETWORK_SERVICE_SANDBOX_FEATURE: &str = "NetworkServiceSandbox";
const NETWORK_SERVICE_LPAC_FEATURE: &str = "WinSboxNetworkServiceSandboxIsLPAC";
const SMOKE_DIRECTORY: &str = "ccem-mode2-production-smoke";
const INSTALL_DIRECTORY: &str = "app";
const EVIDENCE_DIRECTORY: &str = "evidence";
const EXECUTABLE_FILE: &str = "ccem-desktop.exe";
const READY_FILE: &str = "observation-ready.json";
const ACK_FILE: &str = "observation-ack.json";
const RECEIPT_FILE: &str = "runtime-receipt.json";
static TEMPORARY_FILE_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

const ENV_ALLOW: &str = "CCEM_WINDOWS_MODE2_SMOKE_ALLOW";
const ENV_NONCE: &str = "CCEM_WINDOWS_MODE2_SMOKE_NONCE";
const ENV_EVIDENCE_ROOT: &str = "CCEM_WINDOWS_MODE2_SMOKE_EVIDENCE_ROOT";
const ENV_OBSERVATION_PATH: &str = "CCEM_WINDOWS_MODE2_SMOKE_OBSERVATION_PATH";
const ENV_ACK_PATH: &str = "CCEM_WINDOWS_MODE2_SMOKE_ACK_PATH";
const ENV_RECEIPT_PATH: &str = "CCEM_WINDOWS_MODE2_SMOKE_RECEIPT_PATH";
const ENV_EXPECTED_EXE: &str = "CCEM_WINDOWS_MODE2_SMOKE_EXPECTED_EXE";

const EXPLICIT_SMOKE_ENVIRONMENT: [&str; 7] = [
    ENV_ALLOW,
    ENV_NONCE,
    ENV_EVIDENCE_ROOT,
    ENV_OBSERVATION_PATH,
    ENV_ACK_PATH,
    ENV_RECEIPT_PATH,
    ENV_EXPECTED_EXE,
];

const PROCESS_ENVIRONMENT: [&str; 13] = [
    ENV_ALLOW,
    ENV_NONCE,
    ENV_EVIDENCE_ROOT,
    ENV_OBSERVATION_PATH,
    ENV_ACK_PATH,
    ENV_RECEIPT_PATH,
    ENV_EXPECTED_EXE,
    "GITHUB_ACTIONS",
    "RUNNER_OS",
    "RUNNER_TEMP",
    "GITHUB_SHA",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
];

#[cfg(not(debug_assertions))]
const SMOKE_URL: &str = concat!(
    "data:text/html,%3Cmeta%20charset%3Dutf-8%3E%3Ctitle%3ECCEM_WINDOWS_MODE2_SMOKE_READY%3C%2Ftitle%3E",
    "%3Cstyle%3Ehtml%2Cbody%7Bheight%3A100%25%3Bmargin%3A0%7Dbody%7Bdisplay%3Agrid%3Bplace-items%3Acenter%3B",
    "background%3A%230b1220%3Bcolor%3A%23e7f7ff%3Bfont%3A700%2030px%20system-ui%7D%3C%2Fstyle%3E",
    "%3Cmain%20id%3Dccem-mode2-smoke%3EMODE%202%20WINDOWS%20SIGNED%20RELEASE%3C%2Fmain%3E"
);

#[cfg(not(debug_assertions))]
const READY_TIMEOUT: Duration = Duration::from_secs(12);
#[cfg(not(debug_assertions))]
const CDP_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(not(debug_assertions))]
const CLOSE_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(not(debug_assertions))]
const ACK_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(all(windows, not(debug_assertions)))]
const WATCHDOG_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Clone)]
pub(crate) struct WindowsMode2SmokeConfig {
    nonce: String,
    source_commit: String,
    run_id: String,
    run_attempt: String,
    smoke_root: PathBuf,
    data_root: PathBuf,
    workspace_root: PathBuf,
    session_root: PathBuf,
    owner_record_root: PathBuf,
    profile_state_root: PathBuf,
    cef_cache_root: PathBuf,
    evidence_root: PathBuf,
    observation_path: PathBuf,
    ack_path: PathBuf,
    receipt_path: PathBuf,
    expected_executable: String,
}

pub(crate) enum WindowsMode2SmokeGate {
    Disabled,
    Enabled(WindowsMode2SmokeConfig),
    Rejected(String),
}

#[derive(Clone, Copy)]
struct BuildIdentity<'a> {
    windows: bool,
    release: bool,
    source_commit: Option<&'a str>,
    run_id: Option<&'a str>,
    run_attempt: Option<&'a str>,
}

impl BuildIdentity<'static> {
    fn current() -> Self {
        Self {
            windows: cfg!(windows),
            release: !cfg!(debug_assertions),
            source_commit: option_env!("GITHUB_SHA"),
            run_id: option_env!("GITHUB_RUN_ID"),
            run_attempt: option_env!("GITHUB_RUN_ATTEMPT"),
        }
    }
}

pub(crate) fn gate_from_process_environment() -> WindowsMode2SmokeGate {
    let environment = PROCESS_ENVIRONMENT
        .into_iter()
        .filter_map(|name| std::env::var(name).ok().map(|value| (name, value)))
        .collect::<BTreeMap<_, _>>();
    match evaluate_gate(BuildIdentity::current(), &environment) {
        WindowsMode2SmokeGate::Enabled(config) => match validate_process_filesystem(&config) {
            Ok(()) => WindowsMode2SmokeGate::Enabled(config),
            Err(error) => WindowsMode2SmokeGate::Rejected(error),
        },
        gate => gate,
    }
}

fn evaluate_gate(
    build: BuildIdentity<'_>,
    environment: &BTreeMap<&str, String>,
) -> WindowsMode2SmokeGate {
    let requested = EXPLICIT_SMOKE_ENVIRONMENT
        .iter()
        .any(|name| environment.contains_key(name));
    if !requested {
        return WindowsMode2SmokeGate::Disabled;
    }
    let result = (|| {
        if !build.windows || !build.release {
            return Err(
                "Windows Mode 2 production smoke requires a Windows release build".to_string(),
            );
        }
        require_exact(environment, ENV_ALLOW, "1")?;
        require_exact(environment, "GITHUB_ACTIONS", "true")?;
        require_exact(environment, "RUNNER_OS", "Windows")?;

        let source_commit = require_lower_hex(environment, "GITHUB_SHA", 40)?;
        let nonce = require_lower_hex(environment, ENV_NONCE, 64)?;
        let run_id = require_run_number(environment, "GITHUB_RUN_ID")?;
        let run_attempt = require_run_number(environment, "GITHUB_RUN_ATTEMPT")?;
        require_built_identity("GITHUB_SHA", build.source_commit, &source_commit)?;
        require_built_identity("GITHUB_RUN_ID", build.run_id, &run_id)?;
        require_built_identity("GITHUB_RUN_ATTEMPT", build.run_attempt, &run_attempt)?;

        let runner_temp = require_windows_path(environment, "RUNNER_TEMP")?;
        let base = windows_join(
            &windows_join(&runner_temp, SMOKE_DIRECTORY),
            &format!("{run_id}-{run_attempt}"),
        );
        let expected_executable =
            windows_join(&windows_join(&base, INSTALL_DIRECTORY), EXECUTABLE_FILE);
        let data_root = windows_join(&base, "data");
        let workspace_root = windows_join(&base, "workspace");
        let session_root = windows_join(&data_root, "login");
        let owner_record_root = windows_join(&session_root, "embedded-owners");
        let profile_state_root = windows_join(&session_root, "profile-state");
        let cef_cache_root = windows_join(&session_root, "cef");
        let evidence_root = windows_join(&base, EVIDENCE_DIRECTORY);
        let observation_path = windows_join(&evidence_root, READY_FILE);
        let ack_path = windows_join(&evidence_root, ACK_FILE);
        let receipt_path = windows_join(&evidence_root, RECEIPT_FILE);

        require_same_windows_path(environment, ENV_EXPECTED_EXE, &expected_executable)?;
        require_same_windows_path(environment, ENV_EVIDENCE_ROOT, &evidence_root)?;
        require_same_windows_path(environment, ENV_OBSERVATION_PATH, &observation_path)?;
        require_same_windows_path(environment, ENV_ACK_PATH, &ack_path)?;
        require_same_windows_path(environment, ENV_RECEIPT_PATH, &receipt_path)?;

        Ok(WindowsMode2SmokeConfig {
            nonce,
            source_commit,
            run_id,
            run_attempt,
            smoke_root: PathBuf::from(base),
            data_root: PathBuf::from(data_root),
            workspace_root: PathBuf::from(workspace_root),
            session_root: PathBuf::from(session_root),
            owner_record_root: PathBuf::from(owner_record_root),
            profile_state_root: PathBuf::from(profile_state_root),
            cef_cache_root: PathBuf::from(cef_cache_root),
            evidence_root: PathBuf::from(evidence_root),
            observation_path: PathBuf::from(observation_path),
            ack_path: PathBuf::from(ack_path),
            receipt_path: PathBuf::from(receipt_path),
            expected_executable,
        })
    })();
    match result {
        Ok(config) => WindowsMode2SmokeGate::Enabled(config),
        Err(error) => WindowsMode2SmokeGate::Rejected(error),
    }
}

fn require_exact(
    environment: &BTreeMap<&str, String>,
    name: &str,
    expected: &str,
) -> Result<(), String> {
    let actual = environment
        .get(name)
        .ok_or_else(|| format!("Windows Mode 2 production smoke requires {name}"))?;
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "Windows Mode 2 production smoke requires {name}={expected}"
        ))
    }
}

fn require_lower_hex(
    environment: &BTreeMap<&str, String>,
    name: &str,
    length: usize,
) -> Result<String, String> {
    let value = environment
        .get(name)
        .ok_or_else(|| format!("Windows Mode 2 production smoke requires {name}"))?;
    if value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        Ok(value.clone())
    } else {
        Err(format!(
            "Windows Mode 2 production smoke requires {name} as {length} lowercase hex characters"
        ))
    }
}

fn require_run_number(environment: &BTreeMap<&str, String>, name: &str) -> Result<String, String> {
    let value = environment
        .get(name)
        .ok_or_else(|| format!("Windows Mode 2 production smoke requires {name}"))?;
    let valid = !value.is_empty()
        && value.len() <= 20
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && !value.starts_with('0')
        && value.parse::<u64>().is_ok_and(|number| number > 0);
    if valid {
        Ok(value.clone())
    } else {
        Err(format!(
            "Windows Mode 2 production smoke requires {name} as a positive canonical run number"
        ))
    }
}

fn require_built_identity(name: &str, built: Option<&str>, runtime: &str) -> Result<(), String> {
    match built {
        Some(value) if value == runtime => Ok(()),
        Some(_) => Err(format!(
            "Windows Mode 2 production smoke runtime {name} does not match the release build"
        )),
        None => Err(format!(
            "Windows Mode 2 production smoke release build is missing embedded {name}"
        )),
    }
}

fn require_windows_path(
    environment: &BTreeMap<&str, String>,
    name: &str,
) -> Result<String, String> {
    let value = environment
        .get(name)
        .ok_or_else(|| format!("Windows Mode 2 production smoke requires {name}"))?;
    validate_windows_path(value, name)?;
    Ok(value.clone())
}

fn require_same_windows_path(
    environment: &BTreeMap<&str, String>,
    name: &str,
    expected: &str,
) -> Result<(), String> {
    let value = require_windows_path(environment, name)?;
    if same_windows_path(&value, expected) {
        Ok(())
    } else {
        Err(format!(
            "Windows Mode 2 production smoke {name} is outside its exact run evidence root"
        ))
    }
}

fn validate_windows_path(value: &str, label: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    let drive_absolute =
        bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\';
    if !drive_absolute
        || value.len() > 32_767
        || value.contains('\0')
        || value.contains('/')
        || (value.ends_with('\\') && value.len() > 3)
    {
        return Err(format!(
            "Windows Mode 2 production smoke {label} must be a normalized absolute Windows path"
        ));
    }
    let tail = &value[3..];
    if !tail.is_empty()
        && tail.split('\\').any(|component| {
            component.is_empty()
                || matches!(component, "." | "..")
                || component.contains(':')
                || component.ends_with([' ', '.'])
        })
    {
        return Err(format!(
            "Windows Mode 2 production smoke {label} must not contain traversal or ambiguous components"
        ));
    }
    Ok(())
}

fn windows_join(base: &str, child: &str) -> String {
    if base.ends_with('\\') {
        format!("{base}{child}")
    } else {
        format!("{base}\\{child}")
    }
}

fn same_windows_path(left: &str, right: &str) -> bool {
    left.eq_ignore_ascii_case(right)
}

fn validate_process_filesystem(config: &WindowsMode2SmokeConfig) -> Result<(), String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("resolve Windows Mode 2 smoke executable: {error}"))?;
    let executable = executable
        .to_str()
        .ok_or_else(|| "Windows Mode 2 smoke executable path is not Unicode".to_string())?;
    validate_windows_path(executable, "current executable")?;
    if !same_windows_path(executable, &config.expected_executable) {
        return Err(
            "Windows Mode 2 production smoke is not running the exact installed executable"
                .to_string(),
        );
    }
    for (path, label) in [
        (&config.smoke_root, "run root"),
        (&config.evidence_root, "evidence root"),
    ] {
        let metadata = fs::symlink_metadata(path).map_err(|error| {
            format!(
                "inspect Windows Mode 2 smoke {label} {}: {error}",
                path.display()
            )
        })?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(format!(
                "Windows Mode 2 production smoke {label} must be an existing real directory"
            ));
        }
    }
    if config.evidence_root.parent() != Some(config.smoke_root.as_path()) {
        return Err(
            "Windows Mode 2 production smoke evidence root escaped its current-run root"
                .to_string(),
        );
    }
    for (path, label) in [
        (&config.data_root, "data root"),
        (&config.workspace_root, "workspace root"),
    ] {
        if fs::symlink_metadata(path).is_ok() {
            return Err(format!(
                "Windows Mode 2 production smoke refuses a pre-existing isolated {label}"
            ));
        }
    }
    for path in [
        &config.observation_path,
        &config.ack_path,
        &config.receipt_path,
    ] {
        if fs::symlink_metadata(path).is_ok() {
            return Err(format!(
                "Windows Mode 2 production smoke refuses pre-existing evidence {}",
                path.display()
            ));
        }
    }
    Ok(())
}

#[derive(Clone)]
#[cfg(not(debug_assertions))]
pub(crate) struct WindowsMode2SmokeRuntime {
    pub(crate) sessions: Arc<LoginBrowserSessionManager>,
    pub(crate) surfaces: Arc<LoginBrowserSurfaceManager>,
    pub(crate) cef_host: Arc<CefHostController>,
}

#[cfg(not(debug_assertions))]
impl WindowsMode2SmokeConfig {
    pub(crate) fn create_isolated_runtime(&self) -> Result<WindowsMode2SmokeRuntime, String> {
        fs::create_dir(&self.data_root).map_err(|error| {
            format!(
                "create Windows Mode 2 isolated data root {}: {error}",
                self.data_root.display()
            )
        })?;
        fs::create_dir(&self.workspace_root).map_err(|error| {
            format!(
                "create Windows Mode 2 isolated workspace root {}: {error}",
                self.workspace_root.display()
            )
        })?;
        let sessions = Arc::new(
            LoginBrowserSessionManager::production(self.session_root.clone())
                .map_err(|error| error.to_string())?,
        );
        let surfaces = Arc::new(LoginBrowserSurfaceManager::production(
            self.owner_record_root.clone(),
            &sessions,
        )?);
        let cef_host = Arc::new(CefHostController::new(self.cef_cache_root.clone())?);
        Ok(WindowsMode2SmokeRuntime {
            sessions,
            surfaces,
            cef_host,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SmokeStage {
    name: String,
    monotonic_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProductionPathCheckpoint {
    verified: bool,
    manager: &'static str,
    data_root: String,
    workspace_root: String,
    owner_record_root: String,
    profile_state_root: String,
    cef_cache_root: String,
    profile_id: String,
    native_window: super::surface::WindowsNativeWindowObservation,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProductionCleanupProof {
    active_surface_count: u32,
    active_session_count: u32,
    owner_record_count: u32,
    persisted_profile_count: u32,
    profile_lock_available: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProductionSemanticProof {
    read_via_capability: bool,
    write_via_capability: bool,
    write_observed: bool,
    post_pause_write_denied: bool,
    post_pause_value_unchanged: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProductionPathReceipt {
    #[serde(flatten)]
    checkpoint: ProductionPathCheckpoint,
    semantic: ProductionSemanticProof,
    reopened_profile_id: String,
    cleanup: ProductionCleanupProof,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ObservationReady {
    schema_version: u32,
    nonce: String,
    source_commit: String,
    app_version: String,
    run_id: String,
    run_attempt: String,
    main_pid: u32,
    executable_path: String,
    sandbox_enabled: bool,
    network_service_sandbox_feature: &'static str,
    network_service_sandbox_requested: bool,
    network_service_lpac_feature: &'static str,
    network_service_lpac_requested: bool,
    production_path: ProductionPathCheckpoint,
    stages: Vec<SmokeStage>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ObservationAck {
    schema_version: u32,
    nonce: String,
    run_id: String,
    run_attempt: String,
    main_pid: u32,
    observed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeReceipt {
    schema_version: u32,
    nonce: String,
    source_commit: String,
    app_version: String,
    main_pid: u32,
    executable_path: String,
    sandbox_enabled: bool,
    network_service_sandbox_feature: &'static str,
    network_service_sandbox_requested: bool,
    network_service_lpac_feature: &'static str,
    network_service_lpac_requested: bool,
    production_path: ProductionPathReceipt,
    stages: Vec<SmokeStage>,
}

struct StageRecorder {
    started: Instant,
    stages: Vec<SmokeStage>,
}

impl StageRecorder {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            stages: Vec::new(),
        }
    }

    fn record(&mut self, expected: &'static str) -> Result<(), String> {
        const ORDER: [&str; 21] = [
            "direct_ready",
            "direct_cdp",
            "direct_closed",
            "production_acquired_hidden_ready",
            "production_shown",
            "production_hidden",
            "production_reshown",
            "production_handoff",
            "production_semantic_read_write",
            "production_occluded",
            "production_stale_write_denied",
            "production_restored",
            "production_rehandoff",
            "production_post_pause_verified",
            "production_paused",
            "production_takeover",
            "production_released",
            "production_reopened_ready",
            "production_reopened_shown",
            "production_reclosed",
            "production_cleanup_verified",
        ];
        let next = ORDER
            .get(self.stages.len())
            .ok_or_else(|| "Windows Mode 2 smoke recorded too many stages".to_string())?;
        if *next != expected {
            return Err(format!(
                "Windows Mode 2 smoke stage {expected} is out of order; expected {next}"
            ));
        }
        let elapsed = u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let monotonic_ms = self.stages.last().map_or(elapsed, |previous| {
            elapsed.max(previous.monotonic_ms.saturating_add(1))
        });
        self.stages.push(SmokeStage {
            name: expected.to_string(),
            monotonic_ms,
        });
        Ok(())
    }
}

fn write_json_atomic_create<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if path.parent().is_none() {
        return Err("Windows Mode 2 smoke evidence path has no parent".to_string());
    }
    if fs::symlink_metadata(path).is_ok() {
        return Err(format!(
            "Windows Mode 2 smoke evidence already exists at {}",
            path.display()
        ));
    }
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Windows Mode 2 smoke evidence file name is invalid".to_string())?;
    let temporary = path.with_file_name(format!(
        ".{file_name}.{}-{}.tmp",
        std::process::id(),
        TEMPORARY_FILE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let result = (|| {
        let bytes = serde_json::to_vec(value)
            .map_err(|error| format!("serialize Windows Mode 2 smoke evidence: {error}"))?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| {
                format!(
                    "create Windows Mode 2 smoke temporary evidence {}: {error}",
                    temporary.display()
                )
            })?;
        file.write_all(&bytes).map_err(|error| {
            format!(
                "write Windows Mode 2 smoke temporary evidence {}: {error}",
                temporary.display()
            )
        })?;
        file.write_all(b"\n").map_err(|error| {
            format!(
                "finish Windows Mode 2 smoke temporary evidence {}: {error}",
                temporary.display()
            )
        })?;
        file.sync_all().map_err(|error| {
            format!(
                "sync Windows Mode 2 smoke temporary evidence {}: {error}",
                temporary.display()
            )
        })?;
        drop(file);
        fs::hard_link(&temporary, path).map_err(|error| {
            format!(
                "publish Windows Mode 2 smoke evidence {} atomically: {error}",
                path.display()
            )
        })?;
        fs::remove_file(&temporary).map_err(|error| {
            format!(
                "remove Windows Mode 2 smoke temporary evidence {}: {error}",
                temporary.display()
            )
        })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(all(windows, not(debug_assertions)))]
pub(crate) fn spawn(
    app: AppHandle,
    runtime: WindowsMode2SmokeRuntime,
    preview: Arc<BrowserManager>,
    config: WindowsMode2SmokeConfig,
) -> Result<(), String> {
    thread::Builder::new()
        .name("ccem-mode2-smoke-watchdog".to_string())
        .spawn(move || supervise_smoke(app, runtime, preview, config))
        .map(|_| ())
        .map_err(|error| format!("spawn Windows Mode 2 smoke watchdog: {error}"))
}

#[cfg(all(windows, not(debug_assertions)))]
fn supervise_smoke(
    app: AppHandle,
    runtime: WindowsMode2SmokeRuntime,
    preview: Arc<BrowserManager>,
    config: WindowsMode2SmokeConfig,
) {
    let cancelled = Arc::new(AtomicBool::new(false));
    let (sender, receiver) = mpsc::sync_channel(1);
    let worker_app = app.clone();
    let worker_runtime = runtime.clone();
    let worker_preview = Arc::clone(&preview);
    let worker_config = config.clone();
    let worker_cancelled = Arc::clone(&cancelled);
    let worker = thread::Builder::new()
        .name("ccem-mode2-smoke-worker".to_string())
        .spawn(move || {
            let result = production_runtime::execute_smoke(
                worker_app,
                worker_runtime,
                worker_preview,
                worker_config,
                worker_cancelled,
            );
            let _ = sender.send(result);
        });
    if let Err(error) = worker {
        fail_smoke(
            &app,
            &runtime,
            &config,
            EXIT_SMOKE_FAILED,
            &format!("spawn Windows Mode 2 smoke worker: {error}"),
        );
        return;
    }

    match receiver.recv_timeout(WATCHDOG_TIMEOUT) {
        Ok(Ok(receipt)) => match write_json_atomic_create(&config.receipt_path, &receipt) {
            Ok(()) => app.exit(0),
            Err(error) => fail_smoke(&app, &runtime, &config, EXIT_SMOKE_FAILED, &error),
        },
        Ok(Err(error)) => fail_smoke(&app, &runtime, &config, EXIT_SMOKE_FAILED, &error),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            cancelled.store(true, Ordering::SeqCst);
            fail_smoke(
                &app,
                &runtime,
                &config,
                EXIT_SMOKE_TIMEOUT,
                "Windows Mode 2 production smoke watchdog timed out",
            );
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => fail_smoke(
            &app,
            &runtime,
            &config,
            EXIT_SMOKE_FAILED,
            "Windows Mode 2 production smoke worker disconnected",
        ),
    }
}

#[cfg(all(windows, not(debug_assertions)))]
fn fail_smoke(
    app: &AppHandle,
    runtime: &WindowsMode2SmokeRuntime,
    config: &WindowsMode2SmokeConfig,
    exit_code: i32,
    error: &str,
) {
    eprintln!("Windows Mode 2 production smoke failed: {error}");
    let _ = runtime.sessions.shutdown_all();
    let _ = runtime.cef_host.close_surface(
        app,
        format!("mode2-windows-direct-probe-{}", &config.nonce[..16]),
    );
    app.exit(exit_code);
}

#[cfg(not(debug_assertions))]
fn check_cancelled(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::SeqCst) {
        Err("Windows Mode 2 smoke was cancelled by its watchdog".to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(debug_assertions))]
fn publish_observation_ready(
    config: &WindowsMode2SmokeConfig,
    layout: &super::bootstrap::CefRuntimeLayout,
    production_path: ProductionPathCheckpoint,
    stages: &[SmokeStage],
) -> Result<(), String> {
    if !layout.sandbox_enabled
        || !layout.network_service_sandbox_requested
        || !layout.network_service_lpac_requested
    {
        return Err(
            "Windows Mode 2 observation cannot attest a disabled or unrequested sandbox"
                .to_string(),
        );
    }
    write_json_atomic_create(
        &config.observation_path,
        &ObservationReady {
            schema_version: SCHEMA_VERSION,
            nonce: config.nonce.clone(),
            source_commit: config.source_commit.clone(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            run_id: config.run_id.clone(),
            run_attempt: config.run_attempt.clone(),
            main_pid: std::process::id(),
            executable_path: config.expected_executable.clone(),
            sandbox_enabled: true,
            network_service_sandbox_feature: NETWORK_SERVICE_SANDBOX_FEATURE,
            network_service_sandbox_requested: true,
            network_service_lpac_feature: NETWORK_SERVICE_LPAC_FEATURE,
            network_service_lpac_requested: true,
            production_path,
            stages: stages.to_vec(),
        },
    )
}

#[cfg(not(debug_assertions))]
fn wait_for_observation_ack(
    config: &WindowsMode2SmokeConfig,
    cancelled: &AtomicBool,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        check_cancelled(cancelled)?;
        match fs::symlink_metadata(&config.ack_path) {
            Ok(metadata) => {
                if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4096
                {
                    return Err(
                        "Windows Mode 2 observation ACK must be a small regular file".to_string(),
                    );
                }
                let bytes = fs::read(&config.ack_path).map_err(|error| {
                    format!(
                        "read Windows Mode 2 observation ACK {}: {error}",
                        config.ack_path.display()
                    )
                })?;
                let ack: ObservationAck = serde_json::from_slice(&bytes)
                    .map_err(|error| format!("parse Windows Mode 2 observation ACK: {error}"))?;
                return validate_ack(config, &ack, std::process::id());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "inspect Windows Mode 2 observation ACK {}: {error}",
                    config.ack_path.display()
                ))
            }
        }
        if Instant::now() >= deadline {
            return Err("Windows Mode 2 observation ACK timed out".to_string());
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn validate_ack(
    config: &WindowsMode2SmokeConfig,
    ack: &ObservationAck,
    expected_pid: u32,
) -> Result<(), String> {
    if ack.schema_version != SCHEMA_VERSION
        || ack.nonce != config.nonce
        || ack.run_id != config.run_id
        || ack.run_attempt != config.run_attempt
        || ack.main_pid != expected_pid
        || !ack.observed
    {
        return Err(
            "Windows Mode 2 observation ACK does not match this run and process".to_string(),
        );
    }
    Ok(())
}

#[cfg(not(debug_assertions))]
mod production_runtime;

#[cfg(test)]
#[path = "ci_smoke_tests.rs"]
mod tests;
