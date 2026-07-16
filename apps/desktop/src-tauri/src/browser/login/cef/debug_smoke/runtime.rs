use super::{
    MacosDebugMode2SmokeConfig, ProcessResult, EXIT_SMOKE_FAILED, EXIT_SMOKE_TIMEOUT,
    SCHEMA_VERSION,
};
use crate::browser::login::cef::{
    bootstrap::{
        credential_store_policy, ensure_credential_store_marker, expected_credential_store_marker,
        CefCredentialStorePolicy, CefRuntimeLayout,
    },
    host::CefHostController,
    surface::{CefSurfaceConnection, CefSurfaceLifecycle, CefSurfaceRequest, LogicalViewport},
};
use fs2::FileExt;
use serde::Serialize;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, RunEvent};

use cef_objc2_app_kit::NSRunningApplication;
use cef_objc2_foundation::NSString;

const SMOKE_URL: &str = concat!(
        "data:text/html,%3Cmeta%20charset%3Dutf-8%3E%3Ctitle%3ECCEM_MACOS_MODE2_SMOKE_READY%3C%2Ftitle%3E",
        "%3Cstyle%3Ehtml%2Cbody%7Bheight%3A100%25%3Bmargin%3A0%7Dbody%7Bdisplay%3Agrid%3Bplace-items%3Acenter%3B",
        "background%3A%230b1220%3Bcolor%3A%23e7f7ff%3Bfont%3A700%2030px%20system-ui%7D%3C%2Fstyle%3E",
        "%3Cmain%20id%3Dccem-mode2-smoke%3EMODE%202%20MACOS%20DEBUG%20ISOLATED%3C%2Fmain%3E"
    );
const READY_TIMEOUT: Duration = Duration::from_secs(12);
const CDP_TIMEOUT: Duration = Duration::from_secs(10);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(10);
const WATCHDOG_TIMEOUT: Duration = Duration::from_secs(75);
static TEMPORARY_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SmokeStage {
    name: String,
    monotonic_ms: u64,
}

#[derive(Clone, Debug)]
struct SmokeOutcome {
    status: &'static str,
    exit_code: i32,
    error: Option<String>,
}

#[derive(Clone, Debug, Default)]
struct RuntimeFacts {
    sandbox_enabled: Option<bool>,
    mock_keychain_marker_verified: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeReceipt<'a> {
    schema_version: u32,
    smoke: &'static str,
    status: &'static str,
    exit_code: i32,
    error: Option<&'a str>,
    nonce: &'a str,
    app_version: &'static str,
    main_pid: u32,
    executable_path: String,
    smoke_root: String,
    data_root: String,
    evidence_root: String,
    instance_lock_path: String,
    cef_cache_root: String,
    profile_id: String,
    surface_id: String,
    credential_store: &'static str,
    mock_keychain_marker_verified: bool,
    persistent_profile_storage: bool,
    wry_incognito: bool,
    normal_startup_bypassed: bool,
    skipped_subsystems: [&'static str; 9],
    sandbox_enabled: Option<bool>,
    stages: &'a [SmokeStage],
}

#[derive(Debug)]
struct SmokeInstanceLock {
    _file: File,
}

struct StageRecorder {
    started: Instant,
    stages: Arc<Mutex<Vec<SmokeStage>>>,
}

impl StageRecorder {
    fn new(stages: Arc<Mutex<Vec<SmokeStage>>>) -> Self {
        Self {
            started: Instant::now(),
            stages,
        }
    }

    fn record(&self, expected: &'static str) -> Result<(), String> {
        const ORDER: [&str; 7] = [
            "ready", "cdp", "hide", "show", "closed", "reopened", "reclosed",
        ];
        let mut stages = self
            .stages
            .lock()
            .map_err(|_| "macOS Mode 2 smoke stage state is unavailable".to_string())?;
        let next = ORDER
            .get(stages.len())
            .ok_or_else(|| "macOS Mode 2 smoke recorded too many stages".to_string())?;
        if *next != expected {
            return Err(format!(
                "macOS Mode 2 smoke stage {expected} is out of order; expected {next}"
            ));
        }
        let elapsed = u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let monotonic_ms = stages.last().map_or(elapsed, |previous| {
            elapsed.max(previous.monotonic_ms.saturating_add(1))
        });
        stages.push(SmokeStage {
            name: expected.to_string(),
            monotonic_ms,
        });
        Ok(())
    }
}

struct SurfaceCleanup {
    app: tauri::AppHandle,
    controller: Arc<CefHostController>,
    surface_id: String,
    surface_open: bool,
}

impl Drop for SurfaceCleanup {
    fn drop(&mut self) {
        if self.surface_open {
            let _ = self
                .controller
                .close_surface(&self.app, self.surface_id.clone());
        }
    }
}

pub(super) fn validate_process_filesystem(
    config: &MacosDebugMode2SmokeConfig,
) -> Result<(), String> {
    let metadata = fs::symlink_metadata(&config.smoke_root).map_err(|error| {
        format!(
            "inspect macOS Mode 2 smoke root {}: {error}",
            config.smoke_root.display()
        )
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("macOS Mode 2 smoke root must be an existing real directory".to_string());
    }
    if metadata.uid() != unsafe { libc::geteuid() } {
        return Err("macOS Mode 2 smoke root must be owned by the current user".to_string());
    }
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(
            "macOS Mode 2 smoke root permissions must exclude group and other users".to_string(),
        );
    }

    let canonical_root = fs::canonicalize(&config.smoke_root)
        .map_err(|error| format!("canonicalize macOS Mode 2 smoke root: {error}"))?;
    if canonical_root != config.smoke_root {
        return Err(
            "macOS Mode 2 smoke root must use its canonical path without symlinks".to_string(),
        );
    }
    let canonical_temp = fs::canonicalize(std::env::temp_dir())
        .map_err(|error| format!("canonicalize system temporary directory: {error}"))?;
    if canonical_root == canonical_temp || !canonical_root.starts_with(&canonical_temp) {
        return Err(
            "macOS Mode 2 smoke root must be a private child of the system temporary directory"
                .to_string(),
        );
    }
    if fs::read_dir(&canonical_root)
        .map_err(|error| format!("read macOS Mode 2 smoke root: {error}"))?
        .next()
        .is_some()
    {
        return Err("macOS Mode 2 smoke root must be fresh and empty".to_string());
    }
    Ok(())
}

pub(crate) fn run(config: MacosDebugMode2SmokeConfig) -> i32 {
    if let Err(error) = prepare_isolated_roots(&config) {
        return finish_before_event_loop(&config, EXIT_SMOKE_FAILED, &error);
    }
    let _instance_lock = match acquire_smoke_instance_lock(&config.instance_lock_path) {
        Ok(lock) => lock,
        Err(error) => return finish_before_event_loop(&config, EXIT_SMOKE_FAILED, &error),
    };
    if let Err(error) = reject_running_installed_ccem() {
        return finish_before_event_loop(&config, EXIT_SMOKE_FAILED, &error);
    }
    if let Err(error) = require_mock_keychain_preflight(&config) {
        return finish_before_event_loop(&config, EXIT_SMOKE_FAILED, &error);
    }
    let controller = match CefHostController::new(config.cef_cache_root.clone()) {
        Ok(controller) => Arc::new(controller),
        Err(error) => return finish_before_event_loop(&config, EXIT_SMOKE_FAILED, &error),
    };

    let mut context = tauri::generate_context!();
    let mut found_main = false;
    for window in &mut context.config_mut().app.windows {
        if window.label == "main" {
            found_main = true;
            window.create = true;
            window.url = tauri::WebviewUrl::External(
                tauri::Url::parse("about:blank").expect("about:blank is a valid URL"),
            );
            window.incognito = true;
            window.data_directory = None;
            window.data_store_identifier = None;
            window.visible = false;
            window.title = "CCEM Mode 2 Debug Smoke".to_string();
        } else {
            window.create = false;
        }
    }
    if !found_main {
        return finish_before_event_loop(
            &config,
            EXIT_SMOKE_FAILED,
            "macOS Mode 2 smoke requires the configured main Tauri window",
        );
    }

    let app = match tauri::Builder::default().build(context) {
        Ok(app) => app,
        Err(error) => {
            return finish_before_event_loop(
                &config,
                EXIT_SMOKE_FAILED,
                &format!("build isolated macOS Mode 2 smoke host: {error}"),
            )
        }
    };

    let started = Arc::new(AtomicBool::new(false));
    let cancelled = Arc::new(AtomicBool::new(false));
    let watchdog_timed_out = Arc::new(AtomicBool::new(false));
    let exit_prepare_attempted = Arc::new(AtomicBool::new(false));
    let outcome = Arc::new(Mutex::new(None::<SmokeOutcome>));
    let stages = Arc::new(Mutex::new(Vec::<SmokeStage>::new()));
    let facts = Arc::new(Mutex::new(RuntimeFacts::default()));

    let started_for_run = Arc::clone(&started);
    let cancelled_for_run = Arc::clone(&cancelled);
    let timeout_for_run = Arc::clone(&watchdog_timed_out);
    let prepare_for_run = Arc::clone(&exit_prepare_attempted);
    let outcome_for_run = Arc::clone(&outcome);
    let stages_for_run = Arc::clone(&stages);
    let facts_for_run = Arc::clone(&facts);
    let controller_for_run = Arc::clone(&controller);
    let config_for_run = config.clone();

    let event_loop_code = app.run_return(move |app_handle, event| match event {
        RunEvent::Ready => {
            if started_for_run.swap(true, Ordering::SeqCst) {
                return;
            }
            let prepare_window = app_handle
                .get_webview_window("main")
                .ok_or_else(|| "isolated macOS Mode 2 smoke host window is absent".to_string())
                .and_then(|window| {
                    window
                        .show()
                        .map_err(|error| format!("show macOS Mode 2 smoke host: {error}"))?;
                    window
                        .set_focus()
                        .map_err(|error| format!("focus macOS Mode 2 smoke host: {error}"))
                });
            if let Err(error) = prepare_window {
                set_outcome(
                    &outcome_for_run,
                    SmokeOutcome::failed(EXIT_SMOKE_FAILED, error),
                    false,
                );
                app_handle.exit(EXIT_SMOKE_FAILED);
                return;
            }
            if let Err(error) = spawn_smoke(
                app_handle.clone(),
                Arc::clone(&controller_for_run),
                config_for_run.clone(),
                Arc::clone(&cancelled_for_run),
                Arc::clone(&timeout_for_run),
                Arc::clone(&outcome_for_run),
                Arc::clone(&stages_for_run),
                Arc::clone(&facts_for_run),
            ) {
                set_outcome(
                    &outcome_for_run,
                    SmokeOutcome::failed(EXIT_SMOKE_FAILED, error),
                    false,
                );
                app_handle.exit(EXIT_SMOKE_FAILED);
            }
        }
        RunEvent::ExitRequested { code, api, .. } => {
            if prepare_for_run.swap(true, Ordering::SeqCst) {
                return;
            }
            api.prevent_exit();
            let mut requested_code = code.unwrap_or(EXIT_SMOKE_FAILED);
            if code.is_none() {
                cancelled_for_run.store(true, Ordering::SeqCst);
                set_outcome(
                    &outcome_for_run,
                    SmokeOutcome::failed(
                        EXIT_SMOKE_FAILED,
                        "macOS Mode 2 smoke host closed before completion".to_string(),
                    ),
                    false,
                );
            }
            if !timeout_for_run.load(Ordering::SeqCst) {
                if let Err(error) = controller_for_run.prepare_shutdown_current_thread() {
                    requested_code = EXIT_SMOKE_FAILED;
                    set_outcome(
                        &outcome_for_run,
                        SmokeOutcome::failed(
                            EXIT_SMOKE_FAILED,
                            format!("prepare isolated CEF shutdown: {error}"),
                        ),
                        true,
                    );
                }
            }
            app_handle.exit(requested_code);
        }
        _ => {}
    });

    if !watchdog_timed_out.load(Ordering::SeqCst) {
        if let Err(error) = controller.finish_shutdown_current_thread() {
            set_outcome(
                &outcome,
                SmokeOutcome::failed(
                    EXIT_SMOKE_FAILED,
                    format!("finish isolated CEF shutdown: {error}"),
                ),
                true,
            );
        }
    }
    let mut final_outcome = outcome
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
            .unwrap_or_else(|| {
                SmokeOutcome::failed(
                    EXIT_SMOKE_FAILED,
                    format!(
                        "macOS Mode 2 smoke event loop exited without a terminal result ({event_loop_code})"
                    ),
                )
            });
    if final_outcome.status == "passed" && event_loop_code != 0 {
        final_outcome = SmokeOutcome::failed(
            EXIT_SMOKE_FAILED,
            format!("macOS Mode 2 smoke event loop returned {event_loop_code}"),
        );
    }
    let stage_snapshot = stages.lock().map(|guard| guard.clone()).unwrap_or_default();
    let fact_snapshot = facts.lock().map(|guard| guard.clone()).unwrap_or_default();
    if let Err(error) =
        write_terminal_receipt(&config, &final_outcome, &stage_snapshot, &fact_snapshot)
    {
        final_outcome = SmokeOutcome::failed(
            EXIT_SMOKE_FAILED,
            format!("write macOS Mode 2 smoke receipt: {error}"),
        );
    }
    emit_process_result(&config, &final_outcome);
    final_outcome.exit_code
}

impl SmokeOutcome {
    fn passed() -> Self {
        Self {
            status: "passed",
            exit_code: 0,
            error: None,
        }
    }

    fn failed(exit_code: i32, error: String) -> Self {
        Self {
            status: if exit_code == EXIT_SMOKE_TIMEOUT {
                "timed_out"
            } else {
                "failed"
            },
            exit_code,
            error: Some(error),
        }
    }
}

fn set_outcome(outcome: &Mutex<Option<SmokeOutcome>>, next: SmokeOutcome, replace_existing: bool) {
    if let Ok(mut outcome) = outcome.lock() {
        if replace_existing || outcome.is_none() {
            *outcome = Some(next);
        }
    }
}

fn prepare_isolated_roots(config: &MacosDebugMode2SmokeConfig) -> Result<(), String> {
    for path in [
        &config.evidence_root,
        &config.smoke_root.join("instance"),
        &config.data_root,
        &config.data_root.join("login"),
        &config.cef_cache_root,
    ] {
        fs::create_dir(path).map_err(|error| {
            format!(
                "create isolated macOS Mode 2 smoke directory {}: {error}",
                path.display()
            )
        })?;
    }
    Ok(())
}

fn acquire_smoke_instance_lock(path: &Path) -> Result<SmokeInstanceLock, String> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|error| {
            format!(
                "create isolated macOS Mode 2 smoke instance lock {}: {error}",
                path.display()
            )
        })?;
    file.try_lock_exclusive().map_err(|error| {
        format!(
            "lock isolated macOS Mode 2 smoke instance {}: {error}",
            path.display()
        )
    })?;
    writeln!(file, "{}", std::process::id())
        .map_err(|error| format!("write macOS Mode 2 smoke instance lock: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("sync macOS Mode 2 smoke instance lock: {error}"))?;
    Ok(SmokeInstanceLock { _file: file })
}

fn require_mock_keychain_preflight(config: &MacosDebugMode2SmokeConfig) -> Result<(), String> {
    let inert_layout = CefRuntimeLayout {
        framework_path: config.smoke_root.join("preflight-unused-framework"),
        browser_subprocess_path: None,
        bundled: false,
        sandbox_enabled: false,
        network_service_sandbox_requested: false,
        network_service_lpac_requested: false,
    };
    match credential_store_policy(&inert_layout, true, None, None)? {
        CefCredentialStorePolicy::MockKeychain => {
            ensure_credential_store_marker(
                &config.cef_cache_root,
                CefCredentialStorePolicy::MockKeychain,
                None,
            )?;
            verify_mock_keychain_marker(&config.cef_cache_root)
        }
        CefCredentialStorePolicy::SystemKeychain => {
            Err("macOS Mode 2 debug smoke refuses a system Keychain credential store".to_string())
        }
    }
}

fn reject_running_installed_ccem() -> Result<(), String> {
    let current_executable = fs::canonicalize(
        std::env::current_exe()
            .map_err(|error| format!("resolve macOS Mode 2 smoke executable: {error}"))?,
    )
    .map_err(|error| format!("canonicalize macOS Mode 2 smoke executable: {error}"))?;
    let bundle_identifier = NSString::from_str("com.ccem.desktop");
    let running = NSRunningApplication::runningApplicationsWithBundleIdentifier(&bundle_identifier);
    for application in running.iter() {
        let executable_url = application.executableURL().ok_or_else(|| {
            "macOS Mode 2 smoke found a running CCEM application whose executable cannot be verified"
                .to_string()
        })?;
        let executable_path = executable_url.path().ok_or_else(|| {
            "macOS Mode 2 smoke found a running CCEM application with no executable path"
                .to_string()
        })?;
        let executable_path = PathBuf::from(executable_path.to_string());
        let canonical_path = fs::canonicalize(&executable_path).map_err(|error| {
            format!(
                "verify running CCEM executable {}: {error}",
                executable_path.display()
            )
        })?;
        if canonical_path != current_executable {
            return Err(format!(
                "macOS Mode 2 smoke refuses to run while another installed CCEM is active at {}",
                canonical_path.display()
            ));
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn spawn_smoke(
    app: tauri::AppHandle,
    controller: Arc<CefHostController>,
    config: MacosDebugMode2SmokeConfig,
    cancelled: Arc<AtomicBool>,
    watchdog_timed_out: Arc<AtomicBool>,
    outcome: Arc<Mutex<Option<SmokeOutcome>>>,
    stages: Arc<Mutex<Vec<SmokeStage>>>,
    facts: Arc<Mutex<RuntimeFacts>>,
) -> Result<(), String> {
    thread::Builder::new()
        .name("ccem-macos-mode2-smoke-watchdog".to_string())
        .spawn(move || {
            supervise_smoke(
                app,
                controller,
                config,
                cancelled,
                watchdog_timed_out,
                outcome,
                stages,
                facts,
            )
        })
        .map(|_| ())
        .map_err(|error| format!("spawn macOS Mode 2 smoke watchdog: {error}"))
}

#[allow(clippy::too_many_arguments)]
fn supervise_smoke(
    app: tauri::AppHandle,
    controller: Arc<CefHostController>,
    config: MacosDebugMode2SmokeConfig,
    cancelled: Arc<AtomicBool>,
    watchdog_timed_out: Arc<AtomicBool>,
    outcome: Arc<Mutex<Option<SmokeOutcome>>>,
    stages: Arc<Mutex<Vec<SmokeStage>>>,
    facts: Arc<Mutex<RuntimeFacts>>,
) {
    let (sender, receiver) = mpsc::sync_channel(1);
    let worker_app = app.clone();
    let worker_controller = Arc::clone(&controller);
    let worker_config = config.clone();
    let worker_cancelled = Arc::clone(&cancelled);
    let worker_stages = Arc::clone(&stages);
    let worker_facts = Arc::clone(&facts);
    if let Err(error) = thread::Builder::new()
        .name("ccem-macos-mode2-smoke-worker".to_string())
        .spawn(move || {
            let result = execute_smoke(
                worker_app,
                worker_controller,
                worker_config,
                worker_cancelled,
                worker_stages,
                worker_facts,
            );
            let _ = sender.send(result);
        })
    {
        set_outcome(
            &outcome,
            SmokeOutcome::failed(
                EXIT_SMOKE_FAILED,
                format!("spawn macOS Mode 2 smoke worker: {error}"),
            ),
            false,
        );
        app.exit(EXIT_SMOKE_FAILED);
        return;
    }

    match receiver.recv_timeout(WATCHDOG_TIMEOUT) {
        Ok(Ok(())) => {
            set_outcome(&outcome, SmokeOutcome::passed(), false);
            app.exit(0);
        }
        Ok(Err(error)) => {
            set_outcome(
                &outcome,
                SmokeOutcome::failed(EXIT_SMOKE_FAILED, error),
                false,
            );
            app.exit(EXIT_SMOKE_FAILED);
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            cancelled.store(true, Ordering::SeqCst);
            watchdog_timed_out.store(true, Ordering::SeqCst);
            set_outcome(
                &outcome,
                SmokeOutcome::failed(
                    EXIT_SMOKE_TIMEOUT,
                    "macOS Mode 2 smoke watchdog timed out".to_string(),
                ),
                true,
            );
            app.exit(EXIT_SMOKE_TIMEOUT);
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            set_outcome(
                &outcome,
                SmokeOutcome::failed(
                    EXIT_SMOKE_FAILED,
                    "macOS Mode 2 smoke worker disconnected".to_string(),
                ),
                false,
            );
            app.exit(EXIT_SMOKE_FAILED);
        }
    }
}

fn execute_smoke(
    app: tauri::AppHandle,
    controller: Arc<CefHostController>,
    config: MacosDebugMode2SmokeConfig,
    cancelled: Arc<AtomicBool>,
    stages: Arc<Mutex<Vec<SmokeStage>>>,
    facts: Arc<Mutex<RuntimeFacts>>,
) -> Result<(), String> {
    let layout = controller.ensure_ready(&app)?;
    verify_mock_keychain_marker(&config.cef_cache_root)?;
    if let Ok(mut runtime_facts) = facts.lock() {
        runtime_facts.sandbox_enabled = Some(layout.sandbox_enabled);
        runtime_facts.mock_keychain_marker_verified = true;
    }
    check_cancelled(&cancelled)?;

    let surface_id = config.surface_id();
    let mut cleanup = SurfaceCleanup {
        app: app.clone(),
        controller: Arc::clone(&controller),
        surface_id: surface_id.clone(),
        surface_open: false,
    };
    let mut connection = controller.open_surface(&app, config.surface_request())?;
    cleanup.surface_open = true;
    let recorder = StageRecorder::new(stages);

    let ready = connection.wait_until_ready(READY_TIMEOUT)?;
    if ready.surface_id != surface_id
        || ready.lifecycle != CefSurfaceLifecycle::Ready
        || !ready.visible
        || !ready.current_url.starts_with("data:text/html,")
    {
        return Err("macOS Mode 2 smoke ready snapshot is inconsistent".to_string());
    }
    recorder.record("ready")?;
    check_cancelled(&cancelled)?;

    require_cdp_document(&mut connection, CDP_TIMEOUT)?;
    recorder.record("cdp")?;
    check_cancelled(&cancelled)?;

    controller.set_surface_visible(&app, surface_id.clone(), false)?;
    if controller
        .surface_snapshot(&app, surface_id.clone())?
        .visible
    {
        return Err("macOS Mode 2 smoke native child did not hide".to_string());
    }
    recorder.record("hide")?;

    controller.set_surface_visible(&app, surface_id.clone(), true)?;
    if !controller
        .surface_snapshot(&app, surface_id.clone())?
        .visible
    {
        return Err("macOS Mode 2 smoke native child did not show".to_string());
    }
    recorder.record("show")?;
    check_cancelled(&cancelled)?;

    controller.close_surface(&app, surface_id.clone())?;
    let closed = connection.wait_until_closed(CLOSE_TIMEOUT)?;
    if closed.lifecycle != CefSurfaceLifecycle::Closed || closed.visible {
        return Err("macOS Mode 2 smoke native child did not close".to_string());
    }
    cleanup.surface_open = false;
    recorder.record("closed")?;
    drop(connection);
    check_cancelled(&cancelled)?;

    let reopened = controller.open_surface(&app, config.surface_request())?;
    cleanup.surface_open = true;
    let reopened_ready = reopened.wait_until_ready(READY_TIMEOUT)?;
    if reopened_ready.lifecycle != CefSurfaceLifecycle::Ready
        || !reopened_ready.visible
        || !reopened_ready.current_url.starts_with("data:text/html,")
    {
        return Err("macOS Mode 2 smoke reopened snapshot is inconsistent".to_string());
    }
    recorder.record("reopened")?;
    check_cancelled(&cancelled)?;

    controller.close_surface(&app, surface_id)?;
    let reclosed = reopened.wait_until_closed(CLOSE_TIMEOUT)?;
    if reclosed.lifecycle != CefSurfaceLifecycle::Closed || reclosed.visible {
        return Err("macOS Mode 2 smoke reopened child did not close".to_string());
    }
    cleanup.surface_open = false;
    recorder.record("reclosed")?;
    Ok(())
}

impl MacosDebugMode2SmokeConfig {
    fn surface_id(&self) -> String {
        format!("mode2-macos-debug-smoke-{}", &self.nonce[..16])
    }

    fn profile_id(&self) -> String {
        format!("profile-{}", &self.nonce[..32])
    }

    fn surface_request(&self) -> CefSurfaceRequest {
        CefSurfaceRequest {
            surface_id: self.surface_id(),
            profile_id: self.profile_id(),
            initial_url: SMOKE_URL.to_string(),
            viewport: LogicalViewport {
                x: 120.0,
                y: 100.0,
                width: 720.0,
                height: 480.0,
            },
            visible: true,
        }
    }
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::SeqCst) {
        Err("macOS Mode 2 smoke was cancelled".to_string())
    } else {
        Ok(())
    }
}

fn verify_mock_keychain_marker(cache_root: &Path) -> Result<(), String> {
    let marker = cache_root.join(".ccem-credential-store");
    let metadata = fs::symlink_metadata(&marker).map_err(|error| {
        format!(
            "inspect macOS Mode 2 smoke credential-store marker {}: {error}",
            marker.display()
        )
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("macOS Mode 2 smoke credential-store marker is not a regular file".to_string());
    }
    let contents = fs::read(&marker).map_err(|error| {
        format!(
            "read macOS Mode 2 smoke credential-store marker {}: {error}",
            marker.display()
        )
    })?;
    if contents != expected_credential_store_marker(CefCredentialStorePolicy::MockKeychain, None)? {
        return Err(
            "macOS Mode 2 debug smoke refuses a non-mock credential-store marker".to_string(),
        );
    }
    Ok(())
}

fn require_cdp_document(
    connection: &mut CefSurfaceConnection,
    timeout: Duration,
) -> Result<(), String> {
    const COMMAND_ID: i64 = 92_001;
    let mut command = br#"{"id":92001,"method":"Runtime.evaluate","params":{"expression":"({title:document.title,href:location.href,marker:document.querySelector('#ccem-mode2-smoke')?.textContent})","returnByValue":true}}"#.to_vec();
    command.push(0);
    connection
        .writer
        .write_all(&command)
        .map_err(|error| format!("write macOS Mode 2 smoke CDP command: {error}"))?;

    let deadline = Instant::now() + timeout;
    let mut buffered = Vec::new();
    while Instant::now() < deadline {
        let mut chunk = [0_u8; 4096];
        match connection.reader.read(&mut chunk) {
            Ok(0) => return Err("macOS Mode 2 smoke CDP bridge closed".to_string()),
            Ok(count) => {
                buffered.extend_from_slice(&chunk[..count]);
                if buffered.len() > 1024 * 1024 {
                    return Err("macOS Mode 2 smoke CDP response exceeded 1 MiB".to_string());
                }
                while let Some(end) = buffered.iter().position(|byte| *byte == 0) {
                    let frame = buffered.drain(..=end).collect::<Vec<_>>();
                    let value =
                        serde_json::from_slice::<serde_json::Value>(&frame[..frame.len() - 1])
                            .map_err(|error| {
                                format!("parse macOS Mode 2 smoke CDP response: {error}")
                            })?;
                    if value.get("id").and_then(serde_json::Value::as_i64) != Some(COMMAND_ID) {
                        continue;
                    }
                    let title = value
                        .pointer("/result/result/value/title")
                        .and_then(serde_json::Value::as_str);
                    let href = value
                        .pointer("/result/result/value/href")
                        .and_then(serde_json::Value::as_str);
                    let marker = value
                        .pointer("/result/result/value/marker")
                        .and_then(serde_json::Value::as_str);
                    if title == Some("CCEM_MACOS_MODE2_SMOKE_READY")
                        && href.is_some_and(|href| href.starts_with("data:text/html,"))
                        && marker == Some("MODE 2 MACOS DEBUG ISOLATED")
                    {
                        return Ok(());
                    }
                    return Err(
                        "macOS Mode 2 smoke CDP response did not describe the expected document"
                            .to_string(),
                    );
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {}
            Err(error) => return Err(format!("read macOS Mode 2 smoke CDP response: {error}")),
        }
    }
    Err("macOS Mode 2 smoke CDP response timed out".to_string())
}

fn finish_before_event_loop(
    config: &MacosDebugMode2SmokeConfig,
    exit_code: i32,
    error: &str,
) -> i32 {
    let outcome = SmokeOutcome::failed(exit_code, error.to_string());
    if config.evidence_root.is_dir() {
        let _ = write_terminal_receipt(config, &outcome, &[], &RuntimeFacts::default());
    }
    emit_process_result(config, &outcome);
    exit_code
}

fn write_terminal_receipt(
    config: &MacosDebugMode2SmokeConfig,
    outcome: &SmokeOutcome,
    stages: &[SmokeStage],
    facts: &RuntimeFacts,
) -> Result<(), String> {
    let receipt = RuntimeReceipt {
        schema_version: SCHEMA_VERSION,
        smoke: "macos-mode2-debug",
        status: outcome.status,
        exit_code: outcome.exit_code,
        error: outcome.error.as_deref(),
        nonce: &config.nonce,
        app_version: env!("CARGO_PKG_VERSION"),
        main_pid: std::process::id(),
        executable_path: std::env::current_exe()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "<unavailable>".to_string()),
        smoke_root: config.smoke_root.to_string_lossy().into_owned(),
        data_root: config.data_root.to_string_lossy().into_owned(),
        evidence_root: config.evidence_root.to_string_lossy().into_owned(),
        instance_lock_path: config.instance_lock_path.to_string_lossy().into_owned(),
        cef_cache_root: config.cef_cache_root.to_string_lossy().into_owned(),
        profile_id: config.profile_id(),
        surface_id: config.surface_id(),
        credential_store: "chromium-mock-keychain-v2",
        mock_keychain_marker_verified: facts.mock_keychain_marker_verified,
        persistent_profile_storage: false,
        wry_incognito: true,
        normal_startup_bypassed: true,
        skipped_subsystems: [
            "persisted-session-managers",
            "tmux-runtime-cleanup",
            "autostart",
            "external-control",
            "tray",
            "cron",
            "bots",
            "proxy",
            "updater-and-desktop-plugins",
        ],
        sandbox_enabled: facts.sandbox_enabled,
        stages,
    };
    write_json_atomic_create(&config.receipt_path, &receipt)
}

fn write_json_atomic_create<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if fs::symlink_metadata(path).is_ok() {
        return Err(format!(
            "macOS Mode 2 smoke refuses pre-existing receipt {}",
            path.display()
        ));
    }
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "macOS Mode 2 smoke receipt file name is invalid".to_string())?;
    let temporary = path.with_file_name(format!(
        ".{file_name}.{}-{}.tmp",
        std::process::id(),
        TEMPORARY_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let bytes = serde_json::to_vec(value)
            .map_err(|error| format!("serialize macOS Mode 2 smoke receipt: {error}"))?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| {
                format!(
                    "create macOS Mode 2 smoke temporary receipt {}: {error}",
                    temporary.display()
                )
            })?;
        file.write_all(&bytes)
            .and_then(|()| file.write_all(b"\n"))
            .and_then(|()| file.sync_all())
            .map_err(|error| format!("write macOS Mode 2 smoke receipt: {error}"))?;
        drop(file);
        fs::hard_link(&temporary, path).map_err(|error| {
            format!(
                "publish macOS Mode 2 smoke receipt {} atomically: {error}",
                path.display()
            )
        })?;
        fs::remove_file(&temporary)
            .map_err(|error| format!("remove macOS Mode 2 temporary receipt: {error}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn emit_process_result(config: &MacosDebugMode2SmokeConfig, outcome: &SmokeOutcome) {
    let receipt_path = config.receipt_path.to_string_lossy();
    let result = ProcessResult {
        schema_version: SCHEMA_VERSION,
        smoke: "macos-mode2-debug",
        status: outcome.status,
        exit_code: outcome.exit_code,
        receipt_path: Some(receipt_path.as_ref()),
        error: outcome.error.as_deref(),
    };
    match serde_json::to_string(&result) {
            Ok(line) => eprintln!("{line}"),
            Err(error) => eprintln!(
                "{{\"schemaVersion\":{SCHEMA_VERSION},\"smoke\":\"macos-mode2-debug\",\"status\":\"failed\",\"exitCode\":{EXIT_SMOKE_FAILED},\"error\":\"serialize process result: {error}\"}}"
            ),
        }
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
