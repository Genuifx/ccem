use super::{
    MacosDebugMode2SmokeConfig, ProcessResult, EXIT_GATE_REJECTED, EXIT_SMOKE_FAILED,
    EXIT_SMOKE_TIMEOUT, SCHEMA_VERSION,
};
use crate::browser::{
    login::{
        capability::BrowserPermissionAuthority,
        cdp::artifacts::redact_snapshot_url,
        cef::{
            bootstrap::{
                credential_store_policy, ensure_credential_store_marker,
                expected_credential_store_marker, CefCredentialStorePolicy, CefRuntimeLayout,
            },
            host::CefHostController,
            surface::{
                CefSurfaceConnection, CefSurfaceLifecycle, CefSurfaceRequest, LogicalViewport,
            },
        },
        session::LoginBrowserSessionManager,
        surface_commands::{
            BrowserSurfaceControlActionArg, LoginBrowserSurfaceManager, ProductionSmokeLease,
        },
    },
    BrowserManager, BrowserToolRequest,
};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, RunEvent};

use cef_objc2_app_kit::NSRunningApplication;
use cef_objc2_foundation::NSString;

const FIXTURE_TITLE: &str = "CCEM_MACOS_MODE2_CONCURRENT_READY";
const FIXTURE_MARKER: &str = "MODE 2 MACOS CONCURRENT PROFILE";
const READY_TIMEOUT: Duration = Duration::from_secs(12);
const CDP_TIMEOUT: Duration = Duration::from_secs(10);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(10);
// The direct CEF phase plus two production-managed semantic sessions each have bounded CDP
// operations. Keep the process watchdog above that complete valid envelope so it catches hangs
// without rejecting a slow debug machine.
const WATCHDOG_TIMEOUT: Duration = Duration::from_secs(480);
const LEGACY_DEV_PRODUCT_NAME: &str = "CCEM Desktop Dev";
const LEGACY_DEV_BUNDLE_IDENTIFIER: &str = "com.ccem.desktop.dev";
const DEV_PRODUCT_NAME_PREFIX: &str = "CCEM Desktop Dev ";
const DEV_BUNDLE_IDENTIFIER_PREFIX: &str = "com.ccem.desktop.dev.i";
const DEV_INSTANCE_ENV: &str = "CCEM_DESKTOP_DEV_INSTANCE_ID";
const INSTALLED_RELEASE_ROOT: &str = "/Applications/CCEM Desktop.app";
static TEMPORARY_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, PartialEq, Eq)]
struct SmokeHostIdentity {
    product_name: String,
    bundle_identifier: String,
}

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
    concurrent_release_instances: Vec<ConcurrentReleaseInstance>,
    same_profile_concurrent_storage_shared: bool,
    retained_page_boot_identity: bool,
    instance_state_isolated: bool,
    peer_survived_exact_close: bool,
    surface_a_boot_id: Option<String>,
    surface_b_boot_id: Option<String>,
    shared_storage_final_marker: Option<String>,
    observations: Option<ConcurrentProfileObservations>,
    manager_e2e: Option<ManagerE2eProof>,
    unclean_shutdown: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ConcurrentReleaseInstance {
    pid: i32,
    executable_path: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ConcurrentProfileObservations {
    initial_a: PageObservation,
    initial_b: PageObservation,
    b_after_a_shared_write: PageObservation,
    b_after_b_private_write: PageObservation,
    a_after_b_shared_write: PageObservation,
    b_after_a_exact_close: PageObservation,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ManagerE2eProof {
    panel_session_id_a: String,
    panel_session_id_b: String,
    actor_id_a: String,
    actor_id_b: String,
    surface_id_a: String,
    surface_id_b: String,
    session_id_a: String,
    session_id_b: String,
    profile_id: String,
    initial_a: ManagerPageObservation,
    initial_b: ManagerPageObservation,
    b_after_a_shared_write: ManagerPageObservation,
    a_after_b_shared_write: ManagerPageObservation,
    b_after_a_exact_close: ManagerPageObservation,
    wrong_actor_unresolved: bool,
    actor_a_unresolved_after_exact_close: bool,
    audit_routes_isolated: bool,
    final_surface_count: u32,
    final_session_count: u32,
    final_owner_record_count: u32,
    profile_lock_available: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ManagerPageObservation {
    url: String,
    boot_id: String,
    private_marker: String,
    cookie: String,
    local_storage: String,
    indexed_db: String,
}

struct ManagerSemanticPage {
    input_ref: String,
    commit_ref: String,
    refresh_ref: String,
    observation: ManagerPageObservation,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PageObservation {
    title: String,
    fixture_marker: String,
    boot_id: String,
    cookie: String,
    local_storage: String,
    indexed_db: String,
    session_storage: String,
    dom_marker: String,
    href: String,
    history_length: u64,
}

impl PageObservation {
    fn shared_values(&self) -> Option<&str> {
        (!self.cookie.is_empty()
            && self.cookie == self.local_storage
            && self.cookie == self.indexed_db)
            .then_some(self.cookie.as_str())
    }
}

#[allow(clippy::too_many_arguments)]
fn validate_concurrent_profile_contract(
    initial_a: &PageObservation,
    initial_b: &PageObservation,
    b_after_a: &PageObservation,
    b_after_b: &PageObservation,
    a_after_b: &PageObservation,
    shared_a: &str,
    shared_b: &str,
    private_a: &str,
    private_b: &str,
) -> Result<(), String> {
    if initial_a.boot_id.is_empty()
        || initial_b.boot_id.is_empty()
        || initial_a.boot_id == initial_b.boot_id
        || initial_a.title != FIXTURE_TITLE
        || initial_b.title != FIXTURE_TITLE
        || initial_a.fixture_marker != FIXTURE_MARKER
        || initial_b.fixture_marker != FIXTURE_MARKER
    {
        return Err(
            "macOS Mode 2 smoke Browser instances do not have distinct page boots".to_string(),
        );
    }
    for initial in [initial_a, initial_b] {
        if !initial.cookie.is_empty()
            || !initial.local_storage.is_empty()
            || !initial.indexed_db.is_empty()
            || !initial.session_storage.is_empty()
            || !initial.dom_marker.is_empty()
        {
            return Err(
                "macOS Mode 2 smoke fixture did not start from empty storage and page state"
                    .to_string(),
            );
        }
    }
    if b_after_a.boot_id != initial_b.boot_id
        || b_after_a.cookie != shared_a
        || b_after_a.local_storage != shared_a
        || b_after_a.indexed_db != shared_a
        || !b_after_a.session_storage.is_empty()
        || !b_after_a.dom_marker.is_empty()
        || b_after_a.href != initial_b.href
        || b_after_a.history_length != initial_b.history_length
    {
        return Err(
            "macOS Mode 2 smoke Browser B did not observe A's shared storage with private state isolated"
                .to_string(),
        );
    }
    if b_after_b.boot_id != initial_b.boot_id
        || b_after_b.cookie != shared_b
        || b_after_b.local_storage != shared_b
        || b_after_b.indexed_db != shared_b
        || b_after_b.session_storage != private_b
        || b_after_b.dom_marker != private_b
        || !b_after_b.href.ends_with("#b")
        || b_after_b.history_length != initial_b.history_length.saturating_add(1)
    {
        return Err("macOS Mode 2 smoke Browser B private state was not retained".to_string());
    }
    if a_after_b.boot_id != initial_a.boot_id
        || a_after_b.cookie != shared_b
        || a_after_b.local_storage != shared_b
        || a_after_b.indexed_db != shared_b
        || a_after_b.session_storage != private_a
        || a_after_b.dom_marker != private_a
        || !a_after_b.href.ends_with("#a")
        || a_after_b.history_length != initial_a.history_length.saturating_add(1)
    {
        return Err(
            "macOS Mode 2 smoke Browser A was recreated or lost private state during A-B-A switching"
                .to_string(),
        );
    }
    Ok(())
}

fn validate_peer_after_exact_close(
    initial_b: &PageObservation,
    b_after_a_close: &PageObservation,
    shared_b: &str,
    private_b: &str,
) -> Result<(), String> {
    if b_after_a_close.boot_id != initial_b.boot_id
        || b_after_a_close.shared_values() != Some(shared_b)
        || b_after_a_close.session_storage != private_b
        || b_after_a_close.dom_marker != private_b
        || b_after_a_close.href != format!("{}#b", initial_b.href)
        || b_after_a_close.history_length != initial_b.history_length.saturating_add(1)
    {
        return Err("macOS Mode 2 smoke closing Browser A damaged retained Browser B".to_string());
    }
    Ok(())
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
    host_product_name: String,
    host_bundle_identifier: String,
    contract_scope: &'static str,
    smoke_root: String,
    data_root: String,
    evidence_root: String,
    instance_lock_path: String,
    cef_cache_root: String,
    profile_id: String,
    surface_id: String,
    surface_id_b: String,
    credential_store: &'static str,
    mock_keychain_marker_verified: bool,
    concurrent_release_instances: &'a [ConcurrentReleaseInstance],
    same_profile_concurrent_storage_shared: bool,
    retained_page_boot_identity: bool,
    instance_state_isolated: bool,
    peer_survived_exact_close: bool,
    surface_a_boot_id: Option<&'a str>,
    surface_b_boot_id: Option<&'a str>,
    shared_storage_final_marker: Option<&'a str>,
    observations: Option<&'a ConcurrentProfileObservations>,
    manager_e2e: Option<&'a ManagerE2eProof>,
    persistent_profile_storage: bool,
    wry_incognito: bool,
    normal_startup_bypassed: bool,
    skipped_subsystems: [&'static str; 9],
    sandbox_enabled: Option<bool>,
    unclean_shutdown: bool,
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
        const ORDER: [&str; 14] = [
            "ready_a",
            "ready_b",
            "shared_a_to_b",
            "private_state_isolated",
            "switch_a_b_a",
            "shared_b_to_a",
            "closed_a_peer_live",
            "closed_b",
            "manager_ready_a",
            "manager_ready_b",
            "manager_exact_actor_routes",
            "manager_switch_a_b_a",
            "manager_closed_a_peer_live",
            "manager_closed_b_clean",
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

struct ManagerE2eCleanup {
    app: AppHandle,
    sessions: Arc<LoginBrowserSessionManager>,
    surfaces: Arc<LoginBrowserSurfaceManager>,
    cef_host: Arc<CefHostController>,
    preview: Arc<BrowserManager>,
    leases: Vec<ProductionSmokeLease>,
}

impl ManagerE2eCleanup {
    fn remember(&mut self, lease: &ProductionSmokeLease) {
        if let Some(current) = self
            .leases
            .iter_mut()
            .find(|current| current.panel_session_id == lease.panel_session_id)
        {
            *current = lease.clone();
        } else {
            self.leases.push(lease.clone());
        }
    }

    fn forget(&mut self, panel_session_id: &str) {
        self.leases
            .retain(|lease| lease.panel_session_id != panel_session_id);
    }
}

impl Drop for ManagerE2eCleanup {
    fn drop(&mut self) {
        for mut lease in self.leases.drain(..).rev() {
            // A failed sync/control may already have consumed the caller's revision before it
            // returned. Cleanup therefore uses the terminal revision instead of guessing from
            // the last successfully remembered projection.
            if let Err(error) = self.surfaces.production_smoke_release(
                &self.app,
                &self.sessions,
                &self.cef_host,
                &mut lease,
                u64::MAX,
            ) {
                eprintln!(
                    "macOS Mode 2 manager cleanup could not release {}: {error}",
                    lease.panel_session_id
                );
            }
        }
        if let Err(error) = self.sessions.shutdown_all() {
            eprintln!("macOS Mode 2 manager cleanup could not stop all sessions: {error}");
        }
        if let Err(error) = self.preview.hide_all(&self.app) {
            eprintln!("macOS Mode 2 manager cleanup could not hide Preview Browser: {error}");
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

pub(crate) fn run(
    config: MacosDebugMode2SmokeConfig,
    mut context: tauri::Context<tauri::Wry>,
) -> i32 {
    let executable = match std::env::current_exe() {
        Ok(executable) => executable,
        Err(error) => {
            return finish_before_event_loop(
                &config,
                None,
                EXIT_GATE_REJECTED,
                &format!("resolve macOS Mode 2 smoke executable: {error}"),
            )
        }
    };
    let dev_instance_id = std::env::var(DEV_INSTANCE_ENV).ok();
    let host_identity = match validate_smoke_host_identity(
        context.config().product_name.as_deref(),
        &context.config().identifier,
        &executable,
        dev_instance_id.as_deref(),
    ) {
        Ok(identity) => identity,
        Err(error) => return finish_before_event_loop(&config, None, EXIT_GATE_REJECTED, &error),
    };
    let finish = |exit_code, error: &str| {
        finish_before_event_loop(&config, Some(&host_identity), exit_code, error)
    };
    if let Err(error) = prepare_isolated_roots(&config) {
        return finish(EXIT_SMOKE_FAILED, &error);
    }
    let _instance_lock = match acquire_smoke_instance_lock(&config.instance_lock_path) {
        Ok(lock) => lock,
        Err(error) => return finish(EXIT_SMOKE_FAILED, &error),
    };
    if !config.allow_concurrent_release {
        return finish(
            EXIT_SMOKE_FAILED,
            "macOS Mode 2 smoke requires explicit concurrent-release isolation approval",
        );
    }
    let concurrent_release_instances =
        match inspect_separate_running_release() {
            Ok(instances) if !instances.is_empty() => instances,
            Ok(_) => return finish(
                EXIT_GATE_REJECTED,
                "macOS Mode 2 concurrent smoke requires the installed release app to be running",
            ),
            Err(error) => return finish(EXIT_SMOKE_FAILED, &error),
        };
    if let Err(error) = require_mock_keychain_preflight(&config) {
        return finish(EXIT_SMOKE_FAILED, &error);
    }
    let controller = match CefHostController::new_ephemeral(config.cef_cache_root.clone()) {
        Ok(controller) => Arc::new(controller),
        Err(error) => return finish(EXIT_SMOKE_FAILED, &error),
    };

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
        return finish(
            EXIT_SMOKE_FAILED,
            "macOS Mode 2 smoke requires the configured main Tauri window",
        );
    }

    let app = match tauri::Builder::default().build(context) {
        Ok(app) => app,
        Err(error) => {
            return finish(
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
    let facts = Arc::new(Mutex::new(RuntimeFacts {
        concurrent_release_instances,
        ..RuntimeFacts::default()
    }));

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
                    if let Ok(mut facts) = facts_for_run.lock() {
                        facts.unclean_shutdown = true;
                    }
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
            if let Ok(mut facts) = facts.lock() {
                facts.unclean_shutdown = true;
            }
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
    if let Err(error) = write_terminal_receipt(
        &config,
        Some(&host_identity),
        &final_outcome,
        &stage_snapshot,
        &fact_snapshot,
    ) {
        final_outcome = SmokeOutcome::failed(
            EXIT_SMOKE_FAILED,
            format!("write macOS Mode 2 smoke receipt: {error}"),
        );
    }
    emit_process_result(&config, &final_outcome);
    final_outcome.exit_code
}

fn validate_smoke_host_identity(
    product_name: Option<&str>,
    bundle_identifier: &str,
    executable: &Path,
    dev_instance_id: Option<&str>,
) -> Result<SmokeHostIdentity, String> {
    if executable.starts_with(Path::new(INSTALLED_RELEASE_ROOT)) {
        return Err("macOS Mode 2 smoke refuses the installed release executable".to_string());
    }

    let expected = match dev_instance_id {
        Some(instance_id) => expected_canonical_smoke_host_identity(instance_id)?,
        None
            if product_name == Some(LEGACY_DEV_PRODUCT_NAME)
                && bundle_identifier == LEGACY_DEV_BUNDLE_IDENTIFIER =>
        {
            SmokeHostIdentity {
                product_name: LEGACY_DEV_PRODUCT_NAME.to_string(),
                bundle_identifier: LEGACY_DEV_BUNDLE_IDENTIFIER.to_string(),
            }
        }
        None => {
            return Err(format!(
                "macOS Mode 2 smoke requires {LEGACY_DEV_PRODUCT_NAME} / {LEGACY_DEV_BUNDLE_IDENTIFIER}, or a canonical per-worktree host bound by {DEV_INSTANCE_ENV}"
            ))
        }
    };

    if product_name != Some(expected.product_name.as_str())
        || bundle_identifier != expected.bundle_identifier
    {
        return Err(format!(
            "macOS Mode 2 smoke host identity does not match {DEV_INSTANCE_ENV}; expected {} / {}",
            expected.product_name, expected.bundle_identifier
        ));
    }
    Ok(expected)
}

fn expected_canonical_smoke_host_identity(instance_id: &str) -> Result<SmokeHostIdentity, String> {
    let invalid = || {
        format!(
            "macOS Mode 2 smoke requires {DEV_INSTANCE_ENV} as <worktree-slug>-<8 lowercase hex>"
        )
    };
    let (slug, hash) = instance_id.rsplit_once('-').ok_or_else(&invalid)?;
    let slug_bytes = slug.as_bytes();
    let slug_is_valid = !slug_bytes.is_empty()
        && slug_bytes.len() <= 32
        && slug_bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && slug_bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        && !slug.contains("--");
    let hash_is_valid = hash.len() == 8
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'));
    if !slug_is_valid || !hash_is_valid {
        return Err(invalid());
    }

    Ok(SmokeHostIdentity {
        product_name: format!("{DEV_PRODUCT_NAME_PREFIX}{slug}"),
        bundle_identifier: format!("{DEV_BUNDLE_IDENTIFIER_PREFIX}{hash}"),
    })
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
            status: match exit_code {
                EXIT_GATE_REJECTED => "rejected",
                EXIT_SMOKE_TIMEOUT => "timed_out",
                _ => "failed",
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

fn inspect_separate_running_release() -> Result<Vec<ConcurrentReleaseInstance>, String> {
    let current_executable = fs::canonicalize(
        std::env::current_exe()
            .map_err(|error| format!("resolve macOS Mode 2 smoke executable: {error}"))?,
    )
    .map_err(|error| format!("canonicalize macOS Mode 2 smoke executable: {error}"))?;
    let expected_release =
        fs::canonicalize(Path::new(INSTALLED_RELEASE_ROOT).join("Contents/MacOS/ccem-desktop"))
            .map_err(|error| format!("resolve installed CCEM release executable: {error}"))?;
    let bundle_identifier = NSString::from_str("com.ccem.desktop");
    let running = NSRunningApplication::runningApplicationsWithBundleIdentifier(&bundle_identifier);
    let mut instances = Vec::new();
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
        if canonical_path == current_executable {
            return Err(
                "macOS Mode 2 debug smoke executable unexpectedly owns the release bundle identity"
                    .to_string(),
            );
        }
        if canonical_path != expected_release {
            return Err(format!(
                "macOS Mode 2 smoke found release identity outside the installed release path: {}",
                canonical_path.display()
            ));
        }
        instances.push(ConcurrentReleaseInstance {
            pid: application.processIdentifier(),
            executable_path: canonical_path.to_string_lossy().into_owned(),
        });
    }
    Ok(instances)
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
    let server = LocalConcurrentProfileServer::start()?;
    let layout = controller.ensure_ready(&app)?;
    verify_mock_keychain_marker(&config.cef_cache_root)?;
    if let Ok(mut runtime_facts) = facts.lock() {
        runtime_facts.sandbox_enabled = Some(layout.sandbox_enabled);
        runtime_facts.mock_keychain_marker_verified = true;
    }
    check_cancelled(&cancelled)?;

    let surface_a = config.surface_id("a");
    let surface_b = config.surface_id("b");
    let mut cleanup_a = SurfaceCleanup {
        app: app.clone(),
        controller: Arc::clone(&controller),
        surface_id: surface_a.clone(),
        surface_open: false,
    };
    let mut cleanup_b = SurfaceCleanup {
        app: app.clone(),
        controller: Arc::clone(&controller),
        surface_id: surface_b.clone(),
        surface_open: false,
    };
    let recorder = StageRecorder::new(stages);

    let mut connection_a =
        controller.open_surface(&app, config.surface_request("a", server.url(), true))?;
    cleanup_a.surface_open = true;
    require_ready(&mut connection_a, &surface_a, server.url(), true)?;
    recorder.record("ready_a")?;
    check_cancelled(&cancelled)?;

    let mut connection_b =
        controller.open_surface(&app, config.surface_request("b", server.url(), false))?;
    cleanup_b.surface_open = true;
    require_ready(&mut connection_b, &surface_b, server.url(), false)?;
    recorder.record("ready_b")?;
    check_cancelled(&cancelled)?;

    let initial_a = observe_page(&mut connection_a, 92_001, CDP_TIMEOUT)?;
    let initial_b = observe_page(&mut connection_b, 92_002, CDP_TIMEOUT)?;
    let shared_a = format!("shared-a-{}", &config.nonce[..16]);
    let shared_b = format!("shared-b-{}", &config.nonce[..16]);
    let private_a = format!("private-a-{}", &config.nonce[..16]);
    let private_b = format!("private-b-{}", &config.nonce[..16]);
    write_page_state(
        &mut connection_a,
        92_003,
        &shared_a,
        &private_a,
        "a",
        CDP_TIMEOUT,
    )?;
    let b_after_a = observe_page(&mut connection_b, 92_004, CDP_TIMEOUT)?;
    if b_after_a.cookie != shared_a
        || b_after_a.local_storage != shared_a
        || b_after_a.indexed_db != shared_a
    {
        return Err(
            "macOS Mode 2 smoke Browser B did not observe Browser A shared storage without reload"
                .to_string(),
        );
    }
    recorder.record("shared_a_to_b")?;

    write_page_state(
        &mut connection_b,
        92_005,
        &shared_b,
        &private_b,
        "b",
        CDP_TIMEOUT,
    )?;
    let b_after_b = observe_page(&mut connection_b, 92_006, CDP_TIMEOUT)?;
    if b_after_b.session_storage != private_b
        || b_after_b.dom_marker != private_b
        || b_after_b.boot_id != initial_b.boot_id
    {
        return Err("macOS Mode 2 smoke Browser B private state was not isolated".to_string());
    }
    recorder.record("private_state_isolated")?;

    controller.set_surface_visible(&app, surface_a.clone(), false)?;
    controller.set_surface_visible(&app, surface_b.clone(), true)?;
    if controller
        .surface_snapshot(&app, surface_a.clone())?
        .visible
        || !controller
            .surface_snapshot(&app, surface_b.clone())?
            .visible
    {
        return Err("macOS Mode 2 smoke A-to-B visibility switch was inconsistent".to_string());
    }
    controller.set_surface_visible(&app, surface_b.clone(), false)?;
    controller.set_surface_visible(&app, surface_a.clone(), true)?;
    if controller
        .surface_snapshot(&app, surface_b.clone())?
        .visible
        || !controller
            .surface_snapshot(&app, surface_a.clone())?
            .visible
    {
        return Err("macOS Mode 2 smoke B-to-A visibility switch was inconsistent".to_string());
    }
    recorder.record("switch_a_b_a")?;

    let a_after_b = observe_page(&mut connection_a, 92_007, CDP_TIMEOUT)?;
    validate_concurrent_profile_contract(
        &initial_a, &initial_b, &b_after_a, &b_after_b, &a_after_b, &shared_a, &shared_b,
        &private_a, &private_b,
    )?;
    recorder.record("shared_b_to_a")?;
    check_cancelled(&cancelled)?;

    controller.close_surface(&app, surface_a)?;
    require_closed(connection_a.wait_until_closed(CLOSE_TIMEOUT)?)?;
    cleanup_a.surface_open = false;
    drop(connection_a);
    controller.set_surface_visible(&app, surface_b.clone(), true)?;
    let b_after_a_close = observe_page(&mut connection_b, 92_008, CDP_TIMEOUT)?;
    validate_peer_after_exact_close(&initial_b, &b_after_a_close, &shared_b, &private_b)?;
    recorder.record("closed_a_peer_live")?;

    controller.close_surface(&app, surface_b)?;
    require_closed(connection_b.wait_until_closed(CLOSE_TIMEOUT)?)?;
    cleanup_b.surface_open = false;
    recorder.record("closed_b")?;

    let mut runtime_facts = facts
        .lock()
        .map_err(|_| "macOS Mode 2 runtime facts are unavailable".to_string())?;
    runtime_facts.same_profile_concurrent_storage_shared = true;
    runtime_facts.retained_page_boot_identity = true;
    runtime_facts.instance_state_isolated = true;
    runtime_facts.peer_survived_exact_close = true;
    runtime_facts.surface_a_boot_id = Some(initial_a.boot_id.clone());
    runtime_facts.surface_b_boot_id = Some(initial_b.boot_id.clone());
    runtime_facts.shared_storage_final_marker = Some(shared_b);
    runtime_facts.observations = Some(ConcurrentProfileObservations {
        initial_a,
        initial_b,
        b_after_a_shared_write: b_after_a,
        b_after_b_private_write: b_after_b,
        a_after_b_shared_write: a_after_b,
        b_after_a_exact_close: b_after_a_close,
    });
    drop(runtime_facts);

    check_cancelled(&cancelled)?;
    let manager_e2e = execute_manager_e2e(
        &app,
        Arc::clone(&controller),
        &config,
        &server,
        &recorder,
        &cancelled,
    )?;
    facts
        .lock()
        .map_err(|_| "macOS Mode 2 runtime facts are unavailable".to_string())?
        .manager_e2e = Some(manager_e2e);
    drop(server);
    Ok(())
}

fn execute_manager_e2e(
    app: &AppHandle,
    cef_host: Arc<CefHostController>,
    config: &MacosDebugMode2SmokeConfig,
    server: &LocalConcurrentProfileServer,
    recorder: &StageRecorder,
    cancelled: &AtomicBool,
) -> Result<ManagerE2eProof, String> {
    let session_root = config.data_root.join("login");
    let owner_record_root = session_root.join("embedded-owners");
    let profile_state_root = session_root.join("profile-state");
    let workspace_root = config.smoke_root.join("workspace-manager");
    create_manager_workspace(&workspace_root)?;
    let workspace = workspace_root.to_string_lossy().into_owned();

    let sessions = Arc::new(
        LoginBrowserSessionManager::production(session_root.clone())
            .map_err(|error| error.to_string())?,
    );
    let surfaces = Arc::new(LoginBrowserSurfaceManager::production(
        owner_record_root.clone(),
        &sessions,
    )?);
    let preview = Arc::new(BrowserManager::default());
    let mut cleanup = ManagerE2eCleanup {
        app: app.clone(),
        sessions: Arc::clone(&sessions),
        surfaces: Arc::clone(&surfaces),
        cef_host: Arc::clone(&cef_host),
        preview: Arc::clone(&preview),
        leases: Vec::new(),
    };

    let panel_session_id_a = format!("conversation-a-browser-{}", &config.nonce[..16]);
    let panel_session_id_b = format!("conversation-b-browser-{}", &config.nonce[..16]);
    let actor_id_a = format!("browser-actor-{}a", &config.nonce[..31]);
    let actor_id_b = format!("browser-actor-{}b", &config.nonce[..31]);
    let wrong_actor_id = format!("browser-actor-{}c", &config.nonce[..31]);
    let url_a = format!("{}?conversation=a", server.url());
    let url_b = format!("{}?conversation=b", server.url());
    let shared_a = format!("manager-shared-a-{}", &config.nonce[..16]);
    let shared_b = format!("manager-shared-b-{}", &config.nonce[..16]);
    let private_a = format!("manager-private-a-{}", &config.nonce[..16]);
    let private_b = format!("manager-private-b-{}", &config.nonce[..16]);
    let authority = BrowserPermissionAuthority::new("yolo");
    let mut sequence_a = 1_u64;
    let mut sequence_b = 1_u64;
    let mut sequence_wrong = 1_u64;

    let mut lease_a = surfaces.production_smoke_acquire_for_panel(
        app,
        &sessions,
        &cef_host,
        panel_session_id_a.clone(),
        workspace.clone(),
        None,
        url_a.clone(),
        1,
    )?;
    cleanup.remember(&lease_a);
    surfaces.production_smoke_sync(app, &cef_host, &mut lease_a, 2, true)?;
    cleanup.remember(&lease_a);
    surfaces.production_smoke_control_for_actor(
        app,
        &sessions,
        &cef_host,
        &mut lease_a,
        3,
        BrowserSurfaceControlActionArg::Handoff,
        Some(&actor_id_a),
    )?;
    cleanup.remember(&lease_a);

    let empty_a = manager_snapshot(
        &sessions,
        &workspace,
        &actor_id_a,
        &authority,
        "a",
        &mut sequence_a,
        &url_a,
    )?;
    require_manager_observation(&empty_a.observation, "", "", &url_a, None)?;
    manager_click(
        &sessions,
        &workspace,
        &actor_id_a,
        &authority,
        "a",
        &mut sequence_a,
        &empty_a.input_ref,
    )?;
    manager_type(
        &sessions,
        &workspace,
        &actor_id_a,
        &authority,
        "a",
        &mut sequence_a,
        &empty_a.input_ref,
        &shared_a,
    )?;
    let typed_a = manager_snapshot(
        &sessions,
        &workspace,
        &actor_id_a,
        &authority,
        "a",
        &mut sequence_a,
        &url_a,
    )?;
    manager_click(
        &sessions,
        &workspace,
        &actor_id_a,
        &authority,
        "a",
        &mut sequence_a,
        &typed_a.commit_ref,
    )?;
    let committed_a = manager_wait_for_observation(
        &sessions,
        &workspace,
        &actor_id_a,
        &authority,
        "a",
        &mut sequence_a,
        &url_a,
        |observation| manager_shared_values(observation) == Some(shared_a.as_str()),
    )?;
    manager_type(
        &sessions,
        &workspace,
        &actor_id_a,
        &authority,
        "a",
        &mut sequence_a,
        &committed_a.input_ref,
        &private_a,
    )?;
    let initial_a = manager_wait_for_observation(
        &sessions,
        &workspace,
        &actor_id_a,
        &authority,
        "a",
        &mut sequence_a,
        &url_a,
        |observation| {
            observation.private_marker == private_a
                && manager_shared_values(observation) == Some(shared_a.as_str())
        },
    )?
    .observation;
    require_manager_observation(
        &initial_a,
        &private_a,
        &shared_a,
        &url_a,
        Some(&empty_a.observation.boot_id),
    )?;
    recorder.record("manager_ready_a")?;
    check_cancelled(cancelled)?;

    let mut lease_b = surfaces.production_smoke_acquire_for_panel(
        app,
        &sessions,
        &cef_host,
        panel_session_id_b.clone(),
        workspace.clone(),
        Some(lease_a.profile_id.clone()),
        url_b.clone(),
        4,
    )?;
    cleanup.remember(&lease_b);
    surfaces.production_smoke_sync(app, &cef_host, &mut lease_b, 5, true)?;
    cleanup.remember(&lease_b);
    require_manager_pair_visibility(
        app,
        &cef_host,
        &lease_a.surface_id,
        false,
        &lease_b.surface_id,
        true,
    )?;
    surfaces.production_smoke_control_for_actor(
        app,
        &sessions,
        &cef_host,
        &mut lease_b,
        6,
        BrowserSurfaceControlActionArg::Handoff,
        Some(&actor_id_b),
    )?;
    cleanup.remember(&lease_b);
    let initial_b_page = manager_wait_for_observation(
        &sessions,
        &workspace,
        &actor_id_b,
        &authority,
        "b",
        &mut sequence_b,
        &url_b,
        |observation| manager_shared_values(observation) == Some(shared_a.as_str()),
    )?;
    let initial_b = initial_b_page.observation.clone();
    require_manager_observation(&initial_b, "", &shared_a, &url_b, None)?;
    if initial_b.boot_id == initial_a.boot_id {
        return Err(
            "macOS Mode 2 manager smoke created two conversations with one page boot".to_string(),
        );
    }
    recorder.record("manager_ready_b")?;

    let wrong_actor_unresolved = manager_request(
        &sessions,
        &workspace,
        &wrong_actor_id,
        &authority,
        "wrong",
        &mut sequence_wrong,
        "snapshot",
        serde_json::json!({}),
    )?
    .is_none();
    if !wrong_actor_unresolved {
        return Err("macOS Mode 2 manager smoke routed an unbound Agent actor".to_string());
    }
    let _routed_a = manager_snapshot(
        &sessions,
        &workspace,
        &actor_id_a,
        &authority,
        "a",
        &mut sequence_a,
        &url_a,
    )?;
    let routed_b = manager_snapshot(
        &sessions,
        &workspace,
        &actor_id_b,
        &authority,
        "b",
        &mut sequence_b,
        &url_b,
    )?;

    manager_click(
        &sessions,
        &workspace,
        &actor_id_b,
        &authority,
        "b",
        &mut sequence_b,
        &routed_b.input_ref,
    )?;
    manager_type(
        &sessions,
        &workspace,
        &actor_id_b,
        &authority,
        "b",
        &mut sequence_b,
        &routed_b.input_ref,
        &shared_b,
    )?;
    let typed_b = manager_snapshot(
        &sessions,
        &workspace,
        &actor_id_b,
        &authority,
        "b",
        &mut sequence_b,
        &url_b,
    )?;
    manager_click(
        &sessions,
        &workspace,
        &actor_id_b,
        &authority,
        "b",
        &mut sequence_b,
        &typed_b.commit_ref,
    )?;
    let committed_b = manager_wait_for_observation(
        &sessions,
        &workspace,
        &actor_id_b,
        &authority,
        "b",
        &mut sequence_b,
        &url_b,
        |observation| manager_shared_values(observation) == Some(shared_b.as_str()),
    )?;
    manager_type(
        &sessions,
        &workspace,
        &actor_id_b,
        &authority,
        "b",
        &mut sequence_b,
        &committed_b.input_ref,
        &private_b,
    )?;
    let retained_b = manager_wait_for_observation(
        &sessions,
        &workspace,
        &actor_id_b,
        &authority,
        "b",
        &mut sequence_b,
        &url_b,
        |observation| {
            observation.private_marker == private_b
                && manager_shared_values(observation) == Some(shared_b.as_str())
        },
    )?
    .observation;
    require_manager_observation(
        &retained_b,
        &private_b,
        &shared_b,
        &url_b,
        Some(&initial_b.boot_id),
    )?;
    recorder.record("manager_exact_actor_routes")?;
    check_cancelled(cancelled)?;

    surfaces.production_smoke_sync(app, &cef_host, &mut lease_a, 7, true)?;
    cleanup.remember(&lease_a);
    require_manager_pair_visibility(
        app,
        &cef_host,
        &lease_a.surface_id,
        true,
        &lease_b.surface_id,
        false,
    )?;
    surfaces.production_smoke_sync(app, &cef_host, &mut lease_b, 8, true)?;
    cleanup.remember(&lease_b);
    require_manager_pair_visibility(
        app,
        &cef_host,
        &lease_a.surface_id,
        false,
        &lease_b.surface_id,
        true,
    )?;
    surfaces.production_smoke_sync(app, &cef_host, &mut lease_a, 9, true)?;
    cleanup.remember(&lease_a);
    require_manager_pair_visibility(
        app,
        &cef_host,
        &lease_a.surface_id,
        true,
        &lease_b.surface_id,
        false,
    )?;
    let stale_a = manager_snapshot(
        &sessions,
        &workspace,
        &actor_id_a,
        &authority,
        "a",
        &mut sequence_a,
        &url_a,
    )?;
    manager_click(
        &sessions,
        &workspace,
        &actor_id_a,
        &authority,
        "a",
        &mut sequence_a,
        &stale_a.refresh_ref,
    )?;
    let a_after_b_shared_write = manager_wait_for_observation(
        &sessions,
        &workspace,
        &actor_id_a,
        &authority,
        "a",
        &mut sequence_a,
        &url_a,
        |observation| {
            observation.private_marker == private_a
                && manager_shared_values(observation) == Some(shared_b.as_str())
        },
    )?
    .observation;
    require_manager_observation(
        &a_after_b_shared_write,
        &private_a,
        &shared_b,
        &url_a,
        Some(&initial_a.boot_id),
    )?;
    recorder.record("manager_switch_a_b_a")?;

    let profile_id = lease_a.profile_id.clone();
    let surface_id_a = lease_a.surface_id.clone();
    let surface_id_b = lease_b.surface_id.clone();
    let session_id_a = lease_a.session_id.clone();
    let session_id_b = lease_b.session_id.clone();
    surfaces.production_smoke_release(app, &sessions, &cef_host, &mut lease_a, 10)?;
    cleanup.forget(&panel_session_id_a);
    require_manager_surface_absent(app, &cef_host, &surface_id_a)?;
    let actor_a_unresolved_after_exact_close = manager_request(
        &sessions,
        &workspace,
        &actor_id_a,
        &authority,
        "a",
        &mut sequence_a,
        "snapshot",
        serde_json::json!({}),
    )?
    .is_none();
    if !actor_a_unresolved_after_exact_close {
        return Err(
            "macOS Mode 2 manager smoke retained Browser A actor after exact close".to_string(),
        );
    }
    surfaces.production_smoke_sync(app, &cef_host, &mut lease_b, 11, true)?;
    cleanup.remember(&lease_b);
    let peer_b = manager_snapshot(
        &sessions,
        &workspace,
        &actor_id_b,
        &authority,
        "b",
        &mut sequence_b,
        &url_b,
    )?;
    manager_click(
        &sessions,
        &workspace,
        &actor_id_b,
        &authority,
        "b",
        &mut sequence_b,
        &peer_b.refresh_ref,
    )?;
    let b_after_a_exact_close = manager_wait_for_observation(
        &sessions,
        &workspace,
        &actor_id_b,
        &authority,
        "b",
        &mut sequence_b,
        &url_b,
        |observation| {
            observation.private_marker == private_b
                && manager_shared_values(observation) == Some(shared_b.as_str())
        },
    )?
    .observation;
    require_manager_observation(
        &b_after_a_exact_close,
        &private_b,
        &shared_b,
        &url_b,
        Some(&initial_b.boot_id),
    )?;
    recorder.record("manager_closed_a_peer_live")?;

    surfaces.production_smoke_release(app, &sessions, &cef_host, &mut lease_b, 12)?;
    cleanup.forget(&panel_session_id_b);
    require_manager_surface_absent(app, &cef_host, &surface_id_b)?;
    let registry_counts = surfaces.production_smoke_assert_empty(&sessions)?;
    let final_session_count = sessions
        .list_snapshots()
        .map_err(|error| error.to_string())?
        .len();
    let final_owner_record_count = count_directory_entries(&owner_record_root)?;
    if registry_counts.surface_count != 0
        || registry_counts.session_count != 0
        || final_session_count != 0
        || final_owner_record_count != 0
    {
        return Err(format!(
            "macOS Mode 2 manager cleanup retained {} surfaces, {final_session_count} sessions and {final_owner_record_count} owner records",
            registry_counts.surface_count
        ));
    }
    verify_manager_audit_routes(
        &session_root,
        &session_id_a,
        &session_id_b,
        "manager-a-",
        "manager-b-",
    )?;
    require_profile_lock_available(
        &profile_state_root
            .join("profiles")
            .join(&profile_id)
            .join("profile.lock"),
    )?;
    recorder.record("manager_closed_b_clean")?;

    Ok(ManagerE2eProof {
        panel_session_id_a,
        panel_session_id_b,
        actor_id_a,
        actor_id_b,
        surface_id_a,
        surface_id_b,
        session_id_a,
        session_id_b,
        profile_id,
        initial_a,
        initial_b: initial_b.clone(),
        b_after_a_shared_write: initial_b,
        a_after_b_shared_write,
        b_after_a_exact_close,
        wrong_actor_unresolved,
        actor_a_unresolved_after_exact_close,
        audit_routes_isolated: true,
        final_surface_count: registry_counts.surface_count,
        final_session_count: registry_counts.session_count,
        final_owner_record_count: u32::try_from(final_owner_record_count).unwrap_or(u32::MAX),
        profile_lock_available: true,
    })
}

fn create_manager_workspace(path: &Path) -> Result<(), String> {
    fs::create_dir(path).map_err(|error| {
        format!(
            "create macOS Mode 2 manager smoke workspace {}: {error}",
            path.display()
        )
    })?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| {
        format!(
            "protect macOS Mode 2 manager smoke workspace {}: {error}",
            path.display()
        )
    })
}

fn require_manager_pair_visibility(
    app: &AppHandle,
    cef_host: &CefHostController,
    surface_id_a: &str,
    visible_a: bool,
    surface_id_b: &str,
    visible_b: bool,
) -> Result<(), String> {
    for (surface_id, expected_visible) in [(surface_id_a, visible_a), (surface_id_b, visible_b)] {
        let snapshot = cef_host.surface_snapshot(app, surface_id.to_string())?;
        if snapshot.lifecycle != CefSurfaceLifecycle::Ready
            || snapshot.visible != expected_visible
            || snapshot.error.is_some()
        {
            return Err(format!(
                "macOS Mode 2 manager surface {surface_id} did not retain Ready visible={expected_visible}"
            ));
        }
    }
    Ok(())
}

fn require_manager_surface_absent(
    app: &AppHandle,
    cef_host: &CefHostController,
    surface_id: &str,
) -> Result<(), String> {
    match cef_host.surface_snapshot(app, surface_id.to_string()) {
        Err(error) if error == format!("CEF surface {surface_id} does not exist") => Ok(()),
        Err(error) => Err(format!(
            "macOS Mode 2 manager could not prove native surface {surface_id} removal: {error}"
        )),
        Ok(_) => Err(format!(
            "macOS Mode 2 manager retained native surface {surface_id} after exact close"
        )),
    }
}

#[allow(clippy::too_many_arguments)]
fn manager_request(
    sessions: &LoginBrowserSessionManager,
    workspace: &str,
    actor_id: &str,
    authority: &BrowserPermissionAuthority,
    slot: &str,
    sequence: &mut u64,
    tool: &str,
    args: serde_json::Value,
) -> Result<Option<serde_json::Value>, String> {
    let request_id = format!("manager-{slot}-{:03}", *sequence);
    *sequence = sequence.saturating_add(1);
    let ticket = authority
        .current_ticket()
        .map_err(|_| "macOS Mode 2 manager permission authority failed".to_string())?;
    sessions.production_smoke_try_agent_request_for_actor(
        workspace,
        actor_id,
        ticket,
        BrowserToolRequest {
            request_id,
            tool: tool.to_string(),
            args,
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn manager_required_request(
    sessions: &LoginBrowserSessionManager,
    workspace: &str,
    actor_id: &str,
    authority: &BrowserPermissionAuthority,
    slot: &str,
    sequence: &mut u64,
    tool: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    manager_request(
        sessions, workspace, actor_id, authority, slot, sequence, tool, args,
    )?
    .ok_or_else(|| {
        format!("macOS Mode 2 manager smoke lost exact Agent actor {actor_id} during {tool}")
    })
}

#[allow(clippy::too_many_arguments)]
fn manager_snapshot(
    sessions: &LoginBrowserSessionManager,
    workspace: &str,
    actor_id: &str,
    authority: &BrowserPermissionAuthority,
    slot: &str,
    sequence: &mut u64,
    expected_url: &str,
) -> Result<ManagerSemanticPage, String> {
    let snapshot = manager_required_request(
        sessions,
        workspace,
        actor_id,
        authority,
        slot,
        sequence,
        "snapshot",
        serde_json::json!({}),
    )?;
    manager_page_from_snapshot(&snapshot, expected_url)
}

#[allow(clippy::too_many_arguments)]
fn manager_wait_for_observation(
    sessions: &LoginBrowserSessionManager,
    workspace: &str,
    actor_id: &str,
    authority: &BrowserPermissionAuthority,
    slot: &str,
    sequence: &mut u64,
    expected_url: &str,
    predicate: impl Fn(&ManagerPageObservation) -> bool,
) -> Result<ManagerSemanticPage, String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let page = manager_snapshot(
            sessions,
            workspace,
            actor_id,
            authority,
            slot,
            sequence,
            expected_url,
        )?;
        if predicate(&page.observation) {
            return Ok(page);
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "macOS Mode 2 manager smoke timed out observing semantic state for {actor_id}"
            ));
        }
        thread::sleep(Duration::from_millis(20));
    }
}

#[allow(clippy::too_many_arguments)]
fn manager_click(
    sessions: &LoginBrowserSessionManager,
    workspace: &str,
    actor_id: &str,
    authority: &BrowserPermissionAuthority,
    slot: &str,
    sequence: &mut u64,
    element_ref: &str,
) -> Result<(), String> {
    let result = manager_required_request(
        sessions,
        workspace,
        actor_id,
        authority,
        slot,
        sequence,
        "click",
        serde_json::json!({"elementRef": element_ref}),
    )?;
    require_manager_action(&result)
}

#[allow(clippy::too_many_arguments)]
fn manager_type(
    sessions: &LoginBrowserSessionManager,
    workspace: &str,
    actor_id: &str,
    authority: &BrowserPermissionAuthority,
    slot: &str,
    sequence: &mut u64,
    element_ref: &str,
    text: &str,
) -> Result<(), String> {
    let result = manager_required_request(
        sessions,
        workspace,
        actor_id,
        authority,
        slot,
        sequence,
        "type",
        serde_json::json!({
            "elementRef": element_ref,
            "text": text,
            "replace": true,
        }),
    )?;
    require_manager_action(&result)
}

fn require_manager_action(result: &serde_json::Value) -> Result<(), String> {
    if result.get("result").and_then(serde_json::Value::as_str) == Some("action")
        && result.get("completed").and_then(serde_json::Value::as_bool) == Some(true)
    {
        Ok(())
    } else {
        Err("macOS Mode 2 manager semantic action was not acknowledged".to_string())
    }
}

fn manager_page_from_snapshot(
    snapshot: &serde_json::Value,
    expected_url: &str,
) -> Result<ManagerSemanticPage, String> {
    if snapshot
        .get("schema_version")
        .and_then(serde_json::Value::as_u64)
        != Some(1)
        || snapshot.get("kind").and_then(serde_json::Value::as_str) != Some("interaction_snapshot")
        || snapshot.get("backend").and_then(serde_json::Value::as_str)
            != Some("chromium_cdp_semantic")
        || snapshot
            .pointer("/provenance/untrusted")
            .and_then(serde_json::Value::as_bool)
            != Some(true)
    {
        return Err("macOS Mode 2 manager semantic snapshot envelope is invalid".to_string());
    }
    let page = snapshot
        .get("page")
        .ok_or_else(|| "macOS Mode 2 manager semantic snapshot omitted its page".to_string())?;
    let expected_snapshot_url = redact_snapshot_url(expected_url);
    if page.get("url").and_then(serde_json::Value::as_str) != Some(expected_snapshot_url.as_str())
        || page.get("title").and_then(serde_json::Value::as_str) != Some(FIXTURE_TITLE)
        || page.get("untrusted").and_then(serde_json::Value::as_bool) != Some(true)
    {
        return Err("macOS Mode 2 manager semantic page identity is invalid".to_string());
    }
    let elements = page
        .get("elements")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "macOS Mode 2 manager semantic snapshot omitted elements".to_string())?;
    let (input_ref, private_marker) =
        manager_named_element(elements, "textbox", "CCEM Mode 2 private input", true)?;
    let (commit_ref, _) = manager_named_element(
        elements,
        "button",
        "Commit CCEM Mode 2 shared storage",
        false,
    )?;
    let (refresh_ref, _) = manager_named_element(
        elements,
        "button",
        "Refresh CCEM Mode 2 shared storage",
        false,
    )?;
    let (_, cookie) =
        manager_named_element(elements, "textbox", "CCEM Mode 2 cookie marker", true)?;
    let (_, local_storage) = manager_named_element(
        elements,
        "textbox",
        "CCEM Mode 2 local storage marker",
        true,
    )?;
    let (_, indexed_db) =
        manager_named_element(elements, "textbox", "CCEM Mode 2 indexed db marker", true)?;
    let (_, boot_id) = manager_named_element(elements, "textbox", "CCEM Mode 2 boot marker", true)?;
    Ok(ManagerSemanticPage {
        input_ref,
        commit_ref,
        refresh_ref,
        observation: ManagerPageObservation {
            url: expected_url.to_string(),
            boot_id,
            private_marker,
            cookie,
            local_storage,
            indexed_db,
        },
    })
}

fn manager_named_element(
    elements: &[serde_json::Value],
    role: &str,
    name: &str,
    read_text: bool,
) -> Result<(String, String), String> {
    let matching = elements
        .iter()
        .filter(|element| {
            element.get("role").and_then(serde_json::Value::as_str) == Some(role)
                && element.get("name").and_then(serde_json::Value::as_str) == Some(name)
        })
        .collect::<Vec<_>>();
    if matching.len() != 1 {
        return Err(format!(
            "macOS Mode 2 manager semantic snapshot did not expose exactly one {name}"
        ));
    }
    let element_ref = matching[0]
        .get("element_ref")
        .and_then(serde_json::Value::as_str)
        .filter(|element_ref| element_ref.starts_with("el-"))
        .map(str::to_string)
        .ok_or_else(|| {
            format!("macOS Mode 2 manager semantic snapshot exposed an invalid ref for {name}")
        })?;
    let value = if read_text {
        // Chromium's accessibility tree represents an empty textbox as `text: null`. The
        // element's exact role/name/ref proves it exists; null therefore means an empty value,
        // not a missing semantic control.
        matching[0]
            .get("text")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string()
    } else {
        String::new()
    };
    Ok((element_ref, value))
}

fn manager_shared_values(observation: &ManagerPageObservation) -> Option<&str> {
    (!observation.cookie.is_empty()
        && observation.cookie == observation.local_storage
        && observation.cookie == observation.indexed_db)
        .then_some(observation.cookie.as_str())
}

fn require_manager_observation(
    observation: &ManagerPageObservation,
    expected_private: &str,
    expected_shared: &str,
    expected_url: &str,
    expected_boot_id: Option<&str>,
) -> Result<(), String> {
    let shared_matches = if expected_shared.is_empty() {
        observation.cookie.is_empty()
            && observation.local_storage.is_empty()
            && observation.indexed_db.is_empty()
    } else {
        manager_shared_values(observation) == Some(expected_shared)
    };
    if observation.url != expected_url
        || observation.boot_id.is_empty()
        || expected_boot_id.is_some_and(|boot_id| observation.boot_id != boot_id)
        || observation.private_marker != expected_private
        || !shared_matches
    {
        return Err("macOS Mode 2 manager semantic page state violated retention".to_string());
    }
    Ok(())
}

fn count_directory_entries(path: &Path) -> Result<usize, String> {
    fs::read_dir(path)
        .map_err(|error| {
            format!(
                "read macOS Mode 2 manager directory {}: {error}",
                path.display()
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map(|entries| entries.len())
        .map_err(|error| {
            format!(
                "inspect macOS Mode 2 manager directory {}: {error}",
                path.display()
            )
        })
}

fn verify_manager_audit_routes(
    session_root: &Path,
    session_id_a: &str,
    session_id_b: &str,
    request_prefix_a: &str,
    request_prefix_b: &str,
) -> Result<(), String> {
    let read = |session_id: &str| {
        let path = session_root
            .join("sessions")
            .join(session_id)
            .join("audit/actions.jsonl");
        fs::read_to_string(&path).map_err(|error| {
            format!(
                "read macOS Mode 2 manager audit {}: {error}",
                path.display()
            )
        })
    };
    let audit_a = read(session_id_a)?;
    let audit_b = read(session_id_b)?;
    if !audit_a.contains(request_prefix_a)
        || audit_a.contains(request_prefix_b)
        || !audit_b.contains(request_prefix_b)
        || audit_b.contains(request_prefix_a)
        || audit_a.contains("manager-wrong-")
        || audit_b.contains("manager-wrong-")
    {
        return Err("macOS Mode 2 manager semantic audit routes crossed actors".to_string());
    }
    Ok(())
}

fn require_profile_lock_available(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        format!(
            "inspect macOS Mode 2 manager profile lock {}: {error}",
            path.display()
        )
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("macOS Mode 2 manager profile lock is not a regular file".to_string());
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|error| {
            format!(
                "open macOS Mode 2 manager profile lock {}: {error}",
                path.display()
            )
        })?;
    file.try_lock_exclusive()
        .map_err(|error| format!("macOS Mode 2 manager profile lock remained held: {error}"))?;
    FileExt::unlock(&file)
        .map_err(|error| format!("release macOS Mode 2 manager profile lock probe: {error}"))
}

impl MacosDebugMode2SmokeConfig {
    fn surface_id(&self, slot: &str) -> String {
        format!("mode2-macos-debug-smoke-{slot}-{}", &self.nonce[..16])
    }

    fn profile_id(&self) -> String {
        format!("profile-{}", &self.nonce[..32])
    }

    fn surface_request(&self, slot: &str, url: &str, visible: bool) -> CefSurfaceRequest {
        CefSurfaceRequest {
            surface_id: self.surface_id(slot),
            profile_id: self.profile_id(),
            initial_url: url.to_string(),
            viewport: LogicalViewport {
                x: 120.0,
                y: 100.0,
                width: 720.0,
                height: 480.0,
            },
            visible,
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

fn require_ready(
    connection: &mut CefSurfaceConnection,
    surface_id: &str,
    expected_url: &str,
    expected_visible: bool,
) -> Result<(), String> {
    let snapshot = connection.wait_until_ready(READY_TIMEOUT)?;
    if snapshot.surface_id != surface_id
        || snapshot.lifecycle != CefSurfaceLifecycle::Ready
        || snapshot.visible != expected_visible
        || !snapshot.current_url.starts_with(expected_url)
    {
        return Err("macOS Mode 2 concurrent smoke ready snapshot is inconsistent".to_string());
    }
    Ok(())
}

fn require_closed(
    snapshot: crate::browser::login::cef::surface::CefSurfaceSnapshot,
) -> Result<(), String> {
    if snapshot.lifecycle != CefSurfaceLifecycle::Closed || snapshot.visible {
        Err("macOS Mode 2 concurrent smoke surface did not close".to_string())
    } else {
        Ok(())
    }
}

fn observe_page(
    connection: &mut CefSurfaceConnection,
    command_id: i64,
    timeout: Duration,
) -> Result<PageObservation, String> {
    const EXPRESSION: &str = r#"
(async () => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('ccem-mode2-concurrent-profile', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const indexedDb = await new Promise((resolve, reject) => {
    const transaction = db.transaction('state', 'readonly');
    const request = transaction.objectStore('state').get('shared');
    request.onsuccess = () => resolve(request.result ?? '');
    request.onerror = () => reject(request.error);
  });
  db.close();
  const cookie = document.cookie
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith('ccem_mode2_shared='))
    ?.slice('ccem_mode2_shared='.length) ?? '';
  return {
    title: document.title,
    fixtureMarker: document.querySelector('#ccem-mode2-smoke')?.textContent ?? '',
    bootId: globalThis.__ccemBootId ?? '',
    cookie: decodeURIComponent(cookie),
    localStorage: localStorage.getItem('ccem_mode2_shared') ?? '',
    indexedDb,
    sessionStorage: sessionStorage.getItem('ccem_mode2_private') ?? '',
    domMarker: document.body.dataset.ccemPrivate ?? '',
    href: location.href,
    historyLength: history.length,
  };
})()
"#;
    let value = runtime_evaluate(connection, command_id, EXPRESSION, timeout)?;
    serde_json::from_value(value)
        .map_err(|error| format!("decode macOS Mode 2 page observation: {error}"))
}

fn write_page_state(
    connection: &mut CefSurfaceConnection,
    command_id: i64,
    shared_marker: &str,
    private_marker: &str,
    hash: &str,
    timeout: Duration,
) -> Result<(), String> {
    let shared = serde_json::to_string(shared_marker)
        .map_err(|error| format!("encode shared smoke marker: {error}"))?;
    let private = serde_json::to_string(private_marker)
        .map_err(|error| format!("encode private smoke marker: {error}"))?;
    let hash =
        serde_json::to_string(hash).map_err(|error| format!("encode smoke hash: {error}"))?;
    let expression = format!(
        r#"
(async () => {{
  const shared = {shared};
  const privateMarker = {private};
  document.cookie = `ccem_mode2_shared=${{encodeURIComponent(shared)}}; Path=/; SameSite=Lax`;
  localStorage.setItem('ccem_mode2_shared', shared);
  sessionStorage.setItem('ccem_mode2_private', privateMarker);
  document.body.dataset.ccemPrivate = privateMarker;
  history.pushState({{ marker: privateMarker }}, '', `#${{{hash}}}`);
  const db = await new Promise((resolve, reject) => {{
    const request = indexedDB.open('ccem-mode2-concurrent-profile', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }});
  await new Promise((resolve, reject) => {{
    const transaction = db.transaction('state', 'readwrite');
    transaction.objectStore('state').put(shared, 'shared');
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  }});
  db.close();
  return true;
}})()
"#
    );
    let value = runtime_evaluate(connection, command_id, &expression, timeout)?;
    if value == serde_json::Value::Bool(true) {
        Ok(())
    } else {
        Err("macOS Mode 2 smoke page-state write did not complete".to_string())
    }
}

fn runtime_evaluate(
    connection: &mut CefSurfaceConnection,
    command_id: i64,
    expression: &str,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let mut command = serde_json::to_vec(&serde_json::json!({
        "id": command_id,
        "method": "Runtime.evaluate",
        "params": {
            "expression": expression,
            "returnByValue": true,
            "awaitPromise": true,
        }
    }))
    .map_err(|error| format!("encode macOS Mode 2 smoke CDP command: {error}"))?;
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
                    if value.get("id").and_then(serde_json::Value::as_i64) != Some(command_id) {
                        continue;
                    }
                    if let Some(exception) = value.pointer("/result/exceptionDetails") {
                        return Err(format!(
                            "macOS Mode 2 smoke CDP evaluation failed: {exception}"
                        ));
                    }
                    return value
                        .pointer("/result/result/value")
                        .cloned()
                        .ok_or_else(|| {
                            "macOS Mode 2 smoke CDP response had no by-value result".to_string()
                        });
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {}
            Err(error) => return Err(format!("read macOS Mode 2 smoke CDP response: {error}")),
        }
    }
    Err("macOS Mode 2 smoke CDP response timed out".to_string())
}

struct LocalConcurrentProfileServer {
    url: String,
    cancelled: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl LocalConcurrentProfileServer {
    fn start() -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|error| format!("bind macOS Mode 2 loopback fixture: {error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("configure macOS Mode 2 loopback fixture: {error}"))?;
        let address = listener
            .local_addr()
            .map_err(|error| format!("resolve macOS Mode 2 loopback fixture: {error}"))?;
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_cancelled = Arc::clone(&cancelled);
        let worker = thread::Builder::new()
            .name("ccem-mode2-concurrent-profile-fixture".to_string())
            .spawn(move || {
                while !worker_cancelled.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((stream, _)) => serve_concurrent_profile_fixture(stream),
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(10));
                        }
                        Err(_) => break,
                    }
                }
            })
            .map_err(|error| format!("spawn macOS Mode 2 loopback fixture: {error}"))?;
        Ok(Self {
            url: format!("http://{address}/fixture"),
            cancelled,
            worker: Some(worker),
        })
    }

    fn url(&self) -> &str {
        &self.url
    }
}

fn serve_concurrent_profile_fixture(mut stream: TcpStream) {
    let mut request = [0_u8; 4096];
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.read(&mut request);
    let body = format!(
        "<!doctype html><meta charset=utf-8><title>{FIXTURE_TITLE}</title>\
         <style>html,body{{height:100%;margin:0}}body{{display:grid;place-items:center;background:#0b1220;color:#e7f7ff;font:700 28px system-ui}}</style>\
         <main>\
         <h1 id=ccem-mode2-smoke>{FIXTURE_MARKER}</h1>\
         <label>CCEM Mode 2 private input<input id=semantic-input aria-label=\"CCEM Mode 2 private input\"></label>\
         <button id=semantic-commit>Commit CCEM Mode 2 shared storage</button>\
         <button id=semantic-refresh>Refresh CCEM Mode 2 shared storage</button>\
         <input id=semantic-cookie readonly aria-label=\"CCEM Mode 2 cookie marker\">\
         <input id=semantic-local readonly aria-label=\"CCEM Mode 2 local storage marker\">\
         <input id=semantic-indexed readonly aria-label=\"CCEM Mode 2 indexed db marker\">\
         <input id=semantic-boot readonly aria-label=\"CCEM Mode 2 boot marker\">\
         <output id=semantic-shared-summary></output>\
         </main>\
         <script>\
         globalThis.__ccemBootId=crypto.randomUUID();\
         const input=document.getElementById('semantic-input');\
         const cookie=document.getElementById('semantic-cookie');\
         const local=document.getElementById('semantic-local');\
         const indexed=document.getElementById('semantic-indexed');\
         const boot=document.getElementById('semantic-boot');\
         const summary=document.getElementById('semantic-shared-summary');\
         boot.value=globalThis.__ccemBootId;\
         input.value=sessionStorage.getItem('ccem_mode2_private')||'';\
         document.body.dataset.ccemPrivate=input.value;\
         input.addEventListener('input',()=>{{sessionStorage.setItem('ccem_mode2_private',input.value);document.body.dataset.ccemPrivate=input.value;}});\
         const readCookie=()=>{{const row=document.cookie.split(';').map(v=>v.trim()).find(v=>v.startsWith('ccem_mode2_shared='));return row?decodeURIComponent(row.slice('ccem_mode2_shared='.length)):'';}};\
         const openDb=()=>new Promise((resolve,reject)=>{{const request=indexedDB.open('ccem-mode2-concurrent-profile',1);request.onupgradeneeded=()=>request.result.createObjectStore('state');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);}});\
         const readIndexed=async()=>{{const db=await openDb();const value=await new Promise((resolve,reject)=>{{const request=db.transaction('state','readonly').objectStore('state').get('shared');request.onsuccess=()=>resolve(request.result||'');request.onerror=()=>reject(request.error);}});db.close();return value;}};\
         const writeIndexed=async value=>{{const db=await openDb();await new Promise((resolve,reject)=>{{const transaction=db.transaction('state','readwrite');transaction.objectStore('state').put(value,'shared');transaction.oncomplete=resolve;transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error);}});db.close();}};\
         const syncShared=async()=>{{cookie.value=readCookie();local.value=localStorage.getItem('ccem_mode2_shared')||'';indexed.value=await readIndexed();summary.textContent='shared '+cookie.value+' '+local.value+' '+indexed.value;}};\
         document.getElementById('semantic-commit').addEventListener('click',async()=>{{const value=input.value;document.cookie='ccem_mode2_shared='+encodeURIComponent(value)+'; Path=/; SameSite=Lax';localStorage.setItem('ccem_mode2_shared',value);await writeIndexed(value);await syncShared();}});\
         document.getElementById('semantic-refresh').addEventListener('click',()=>{{void syncShared();}});\
         void syncShared();\
         </script>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

impl Drop for LocalConcurrentProfileServer {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn finish_before_event_loop(
    config: &MacosDebugMode2SmokeConfig,
    host_identity: Option<&SmokeHostIdentity>,
    exit_code: i32,
    error: &str,
) -> i32 {
    let outcome = SmokeOutcome::failed(exit_code, error.to_string());
    if config.evidence_root.is_dir() {
        let _ = write_terminal_receipt(
            config,
            host_identity,
            &outcome,
            &[],
            &RuntimeFacts::default(),
        );
    }
    emit_process_result(config, &outcome);
    exit_code
}

fn write_terminal_receipt(
    config: &MacosDebugMode2SmokeConfig,
    host_identity: Option<&SmokeHostIdentity>,
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
        host_product_name: host_identity
            .map(|identity| identity.product_name.clone())
            .unwrap_or_else(|| "<unverified>".to_string()),
        host_bundle_identifier: host_identity
            .map(|identity| identity.bundle_identifier.clone())
            .unwrap_or_else(|| "<unverified>".to_string()),
        contract_scope: "cef-surface-profile+retained-session-actor",
        smoke_root: config.smoke_root.to_string_lossy().into_owned(),
        data_root: config.data_root.to_string_lossy().into_owned(),
        evidence_root: config.evidence_root.to_string_lossy().into_owned(),
        instance_lock_path: config.instance_lock_path.to_string_lossy().into_owned(),
        cef_cache_root: config.cef_cache_root.to_string_lossy().into_owned(),
        profile_id: config.profile_id(),
        surface_id: config.surface_id("a"),
        surface_id_b: config.surface_id("b"),
        credential_store: "chromium-mock-keychain-v2",
        mock_keychain_marker_verified: facts.mock_keychain_marker_verified,
        concurrent_release_instances: &facts.concurrent_release_instances,
        same_profile_concurrent_storage_shared: facts.same_profile_concurrent_storage_shared,
        retained_page_boot_identity: facts.retained_page_boot_identity,
        instance_state_isolated: facts.instance_state_isolated,
        peer_survived_exact_close: facts.peer_survived_exact_close,
        surface_a_boot_id: facts.surface_a_boot_id.as_deref(),
        surface_b_boot_id: facts.surface_b_boot_id.as_deref(),
        shared_storage_final_marker: facts.shared_storage_final_marker.as_deref(),
        observations: facts.observations.as_ref(),
        manager_e2e: facts.manager_e2e.as_ref(),
        persistent_profile_storage: false,
        wry_incognito: true,
        normal_startup_bypassed: true,
        skipped_subsystems: [
            "startup-restored-runtime-sessions",
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
        unclean_shutdown: facts.unclean_shutdown || outcome.exit_code == EXIT_SMOKE_TIMEOUT,
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
        receipt_path: config
            .receipt_path
            .is_file()
            .then_some(receipt_path.as_ref()),
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
