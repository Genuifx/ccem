use super::{
    consume_one_shot_ticket, MacosSafeStorageSmokeConfig, EXIT_SMOKE_FAILED, EXIT_SMOKE_TIMEOUT,
    SCHEMA_VERSION, SMOKE_NAME,
};
use crate::browser::login::cef::{
    bootstrap::{
        expected_credential_store_marker, validate_credential_store_marker,
        CefCredentialStorePolicy,
    },
    host::CefHostController,
    surface::{CefSurfaceConnection, CefSurfaceLifecycle, CefSurfaceRequest, LogicalViewport},
};
use serde::Serialize;
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, RunEvent};

const READY_TIMEOUT: Duration = Duration::from_secs(15);
const CDP_TIMEOUT: Duration = Duration::from_secs(15);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(12);
const WATCHDOG_TIMEOUT: Duration = Duration::from_secs(90);
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
    sandbox_enabled: bool,
    distribution_signature_verified: bool,
    safe_storage_branding_verified: bool,
    system_keychain_marker_verified: bool,
    persistent_cookie_verified: bool,
    production_path: Option<super::production_runtime::MacosProductionPathProof>,
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
    source_commit: &'a str,
    run_id: &'a str,
    run_attempt: &'a str,
    target: &'a str,
    repository: &'a str,
    workflow_ref: &'a str,
    producer_workflow_ref: &'a str,
    job: &'a str,
    scenario: &'a str,
    phase: &'a str,
    app_version: &'static str,
    main_pid: u32,
    executable_path: String,
    smoke_root: String,
    cef_cache_root: String,
    profile_id: String,
    surface_id: String,
    credential_store: &'static str,
    safe_storage_service: &'static str,
    distribution_signature_verified: bool,
    safe_storage_branding_verified: bool,
    system_keychain_marker_verified: bool,
    persistent_cookie_verified: bool,
    persistent_profile_storage: bool,
    normal_startup_bypassed: bool,
    sandbox_enabled: bool,
    production_path: Option<&'a super::production_runtime::MacosProductionPathProof>,
    stages: &'a [SmokeStage],
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
        const ORDER: [&str; 8] = [
            "ready",
            "cookie_verified",
            "hidden",
            "shown",
            "closed",
            "reopened",
            "reopened_cookie_verified",
            "reclosed",
        ];
        let mut stages = self
            .stages
            .lock()
            .map_err(|_| "macOS Safe Storage smoke stage state is unavailable".to_string())?;
        let next = ORDER
            .get(stages.len())
            .ok_or_else(|| "macOS Safe Storage smoke recorded too many stages".to_string())?;
        if *next != expected {
            return Err(format!(
                "macOS Safe Storage smoke stage {expected} is out of order; expected {next}"
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

pub(crate) fn run(
    config: MacosSafeStorageSmokeConfig,
    mut context: tauri::Context<tauri::Wry>,
) -> i32 {
    if let Err(error) = consume_one_shot_ticket(&config) {
        return finish_before_event_loop(&config, &error);
    }
    if let Err(error) = verify_system_keychain_marker_preflight(&config.cef_cache_root) {
        return finish_before_event_loop(&config, &error);
    }
    let controller = match CefHostController::new(config.cef_cache_root.clone()) {
        Ok(controller) => Arc::new(controller),
        Err(error) => return finish_before_event_loop(&config, &error),
    };

    let mut found_main = false;
    for window in &mut context.config_mut().app.windows {
        if window.label == "main" {
            found_main = true;
            window.create = true;
            window.url = tauri::WebviewUrl::External(
                tauri::Url::parse("about:blank").expect("about:blank is valid"),
            );
            window.incognito = true;
            window.data_directory = None;
            window.data_store_identifier = None;
            window.visible = false;
            window.title = "CCEM Mode 2 Safe Storage CI Smoke".to_string();
        } else {
            window.create = false;
        }
    }
    if !found_main {
        return finish_before_event_loop(&config, "configured main Tauri window is missing");
    }
    let app = match tauri::Builder::default().build(context) {
        Ok(app) => app,
        Err(error) => {
            return finish_before_event_loop(
                &config,
                &format!("build isolated Safe Storage smoke host: {error}"),
            )
        }
    };

    let started = Arc::new(AtomicBool::new(false));
    let cancelled = Arc::new(AtomicBool::new(false));
    let timed_out = Arc::new(AtomicBool::new(false));
    let exit_prepare_attempted = Arc::new(AtomicBool::new(false));
    let outcome = Arc::new(Mutex::new(None::<SmokeOutcome>));
    let stages = Arc::new(Mutex::new(Vec::<SmokeStage>::new()));
    let facts = Arc::new(Mutex::new(RuntimeFacts::default()));

    let event_loop_code = app.run_return({
        let started = Arc::clone(&started);
        let cancelled = Arc::clone(&cancelled);
        let timed_out_for_run = Arc::clone(&timed_out);
        let exit_prepare_attempted = Arc::clone(&exit_prepare_attempted);
        let outcome_for_run = Arc::clone(&outcome);
        let stages_for_run = Arc::clone(&stages);
        let facts_for_run = Arc::clone(&facts);
        let controller_for_run = Arc::clone(&controller);
        let config_for_run = config.clone();
        move |app_handle, event| match event {
            RunEvent::Ready => {
                if started.swap(true, Ordering::SeqCst) {
                    return;
                }
                let window_result = app_handle
                    .get_webview_window("main")
                    .ok_or_else(|| "Safe Storage smoke host window is absent".to_string())
                    .and_then(|window| {
                        window
                            .show()
                            .map_err(|error| format!("show smoke host: {error}"))?;
                        window
                            .set_focus()
                            .map_err(|error| format!("focus smoke host: {error}"))
                    });
                if let Err(error) = window_result {
                    set_outcome(&outcome_for_run, SmokeOutcome::failed(error), false);
                    app_handle.exit(EXIT_SMOKE_FAILED);
                    return;
                }
                if let Err(error) = spawn_smoke(
                    app_handle.clone(),
                    Arc::clone(&controller_for_run),
                    config_for_run.clone(),
                    Arc::clone(&cancelled),
                    Arc::clone(&timed_out_for_run),
                    Arc::clone(&outcome_for_run),
                    Arc::clone(&stages_for_run),
                    Arc::clone(&facts_for_run),
                ) {
                    set_outcome(&outcome_for_run, SmokeOutcome::failed(error), false);
                    app_handle.exit(EXIT_SMOKE_FAILED);
                }
            }
            RunEvent::ExitRequested { code, api, .. } => {
                if exit_prepare_attempted.swap(true, Ordering::SeqCst) {
                    return;
                }
                api.prevent_exit();
                let mut requested_code = code.unwrap_or(EXIT_SMOKE_FAILED);
                if code.is_none() {
                    cancelled.store(true, Ordering::SeqCst);
                    set_outcome(
                        &outcome_for_run,
                        SmokeOutcome::failed("Safe Storage smoke host closed early".to_string()),
                        false,
                    );
                }
                if !timed_out_for_run.load(Ordering::SeqCst) {
                    if let Err(error) = controller_for_run.prepare_shutdown_current_thread() {
                        requested_code = EXIT_SMOKE_FAILED;
                        set_outcome(
                            &outcome_for_run,
                            SmokeOutcome::failed(format!("prepare CEF shutdown: {error}")),
                            true,
                        );
                    }
                }
                app_handle.exit(requested_code);
            }
            _ => {}
        }
    });

    if !timed_out.load(Ordering::SeqCst) {
        if let Err(error) = controller.finish_shutdown_current_thread() {
            set_outcome(
                &outcome,
                SmokeOutcome::failed(format!("finish CEF shutdown: {error}")),
                true,
            );
        }
    }
    let mut final_outcome = outcome
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
        .unwrap_or_else(|| {
            SmokeOutcome::failed(format!(
                "Safe Storage smoke event loop exited without result ({event_loop_code})"
            ))
        });
    if final_outcome.status == "passed" && event_loop_code != 0 {
        final_outcome = SmokeOutcome::failed(format!(
            "Safe Storage smoke event loop returned {event_loop_code}"
        ));
    }
    let stages = stages.lock().map(|guard| guard.clone()).unwrap_or_default();
    let facts = facts.lock().map(|guard| guard.clone()).unwrap_or_default();
    if let Err(error) = write_terminal_receipt(&config, &final_outcome, &stages, &facts) {
        final_outcome = SmokeOutcome::failed(format!("write runtime receipt: {error}"));
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

    fn failed(error: String) -> Self {
        Self {
            status: "failed",
            exit_code: EXIT_SMOKE_FAILED,
            error: Some(error),
        }
    }

    fn timed_out() -> Self {
        Self {
            status: "timed_out",
            exit_code: EXIT_SMOKE_TIMEOUT,
            error: Some(
                "Safe Storage smoke timed out; an authorization prompt may be blocking CEF"
                    .to_string(),
            ),
        }
    }
}

fn set_outcome(outcome: &Mutex<Option<SmokeOutcome>>, next: SmokeOutcome, replace: bool) {
    if let Ok(mut outcome) = outcome.lock() {
        if replace || outcome.is_none() {
            *outcome = Some(next);
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_smoke(
    app: tauri::AppHandle,
    controller: Arc<CefHostController>,
    config: MacosSafeStorageSmokeConfig,
    cancelled: Arc<AtomicBool>,
    timed_out: Arc<AtomicBool>,
    outcome: Arc<Mutex<Option<SmokeOutcome>>>,
    stages: Arc<Mutex<Vec<SmokeStage>>>,
    facts: Arc<Mutex<RuntimeFacts>>,
) -> Result<(), String> {
    thread::Builder::new()
        .name("ccem-safe-storage-smoke-watchdog".to_string())
        .spawn(move || {
            let (sender, receiver) = mpsc::sync_channel(1);
            let worker_app = app.clone();
            let worker_controller = Arc::clone(&controller);
            let worker_cancelled = Arc::clone(&cancelled);
            if let Err(error) = thread::Builder::new()
                .name("ccem-safe-storage-smoke-worker".to_string())
                .spawn(move || {
                    let result = execute_smoke(
                        worker_app,
                        worker_controller,
                        config,
                        worker_cancelled,
                        stages,
                        facts,
                    );
                    let _ = sender.send(result);
                })
            {
                set_outcome(
                    &outcome,
                    SmokeOutcome::failed(format!("spawn Safe Storage smoke worker: {error}")),
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
                    set_outcome(&outcome, SmokeOutcome::failed(error), false);
                    app.exit(EXIT_SMOKE_FAILED);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    cancelled.store(true, Ordering::SeqCst);
                    timed_out.store(true, Ordering::SeqCst);
                    set_outcome(&outcome, SmokeOutcome::timed_out(), true);
                    app.exit(EXIT_SMOKE_TIMEOUT);
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    set_outcome(
                        &outcome,
                        SmokeOutcome::failed("Safe Storage smoke worker disconnected".to_string()),
                        false,
                    );
                    app.exit(EXIT_SMOKE_FAILED);
                }
            }
        })
        .map(|_| ())
        .map_err(|error| format!("spawn Safe Storage smoke watchdog: {error}"))
}

fn execute_smoke(
    app: tauri::AppHandle,
    controller: Arc<CefHostController>,
    config: MacosSafeStorageSmokeConfig,
    cancelled: Arc<AtomicBool>,
    stages: Arc<Mutex<Vec<SmokeStage>>>,
    facts: Arc<Mutex<RuntimeFacts>>,
) -> Result<(), String> {
    let server = LocalCookieServer::start(&config)?;
    let layout = controller.ensure_ready(&app)?;
    if !layout.bundled || !layout.sandbox_enabled {
        return Err("Safe Storage smoke requires bundled sandboxed CEF".to_string());
    }
    verify_system_keychain_marker(&config.cef_cache_root)?;
    if let Ok(mut facts) = facts.lock() {
        facts.sandbox_enabled = true;
        facts.distribution_signature_verified = true;
        facts.safe_storage_branding_verified = true;
        facts.system_keychain_marker_verified = true;
    }
    check_cancelled(&cancelled)?;

    let surface_id = config.surface_id();
    let mut cleanup = SurfaceCleanup {
        app: app.clone(),
        controller: Arc::clone(&controller),
        surface_id: surface_id.clone(),
        surface_open: false,
    };
    let recorder = StageRecorder::new(stages);
    let mut connection = controller.open_surface(&app, config.surface_request(server.url()))?;
    cleanup.surface_open = true;
    require_ready(&mut connection, &surface_id, server.url())?;
    recorder.record("ready")?;
    require_persistent_cookie(&mut connection, &config.nonce, CDP_TIMEOUT)?;
    recorder.record("cookie_verified")?;
    check_cancelled(&cancelled)?;

    controller.set_surface_visible(&app, surface_id.clone(), false)?;
    if controller
        .surface_snapshot(&app, surface_id.clone())?
        .visible
    {
        return Err("Safe Storage smoke native child did not hide".to_string());
    }
    recorder.record("hidden")?;
    controller.set_surface_visible(&app, surface_id.clone(), true)?;
    if !controller
        .surface_snapshot(&app, surface_id.clone())?
        .visible
    {
        return Err("Safe Storage smoke native child did not show".to_string());
    }
    recorder.record("shown")?;
    controller.close_surface(&app, surface_id.clone())?;
    require_closed(connection.wait_until_closed(CLOSE_TIMEOUT)?)?;
    cleanup.surface_open = false;
    recorder.record("closed")?;
    drop(connection);
    check_cancelled(&cancelled)?;

    let mut reopened = controller.open_surface(&app, config.surface_request(server.url()))?;
    cleanup.surface_open = true;
    require_ready(&mut reopened, &surface_id, server.url())?;
    recorder.record("reopened")?;
    require_persistent_cookie(&mut reopened, &config.nonce, CDP_TIMEOUT)?;
    recorder.record("reopened_cookie_verified")?;
    controller.close_surface(&app, surface_id)?;
    require_closed(reopened.wait_until_closed(CLOSE_TIMEOUT)?)?;
    cleanup.surface_open = false;
    recorder.record("reclosed")?;
    drop(reopened);
    check_cancelled(&cancelled)?;
    let production_path = super::production_runtime::run(&app, Arc::clone(&controller), &config)?;
    let mut facts = facts
        .lock()
        .map_err(|_| "macOS Mode 2 runtime facts are unavailable".to_string())?;
    facts.persistent_cookie_verified = true;
    facts.production_path = Some(production_path);
    drop(facts);
    drop(server);
    Ok(())
}

fn require_ready(
    connection: &mut CefSurfaceConnection,
    surface_id: &str,
    expected_url: &str,
) -> Result<(), String> {
    let snapshot = connection.wait_until_ready(READY_TIMEOUT)?;
    if snapshot.surface_id != surface_id
        || snapshot.lifecycle != CefSurfaceLifecycle::Ready
        || !snapshot.visible
        || !snapshot.current_url.starts_with(expected_url)
    {
        return Err("Safe Storage smoke ready snapshot is inconsistent".to_string());
    }
    Ok(())
}

fn require_closed(
    snapshot: crate::browser::login::cef::surface::CefSurfaceSnapshot,
) -> Result<(), String> {
    if snapshot.lifecycle != CefSurfaceLifecycle::Closed || snapshot.visible {
        Err("Safe Storage smoke surface did not close".to_string())
    } else {
        Ok(())
    }
}

fn require_persistent_cookie(
    connection: &mut CefSurfaceConnection,
    nonce: &str,
    timeout: Duration,
) -> Result<(), String> {
    const COMMAND_ID: i64 = 94_001;
    let mut command = br#"{"id":94001,"method":"Runtime.evaluate","params":{"expression":"({title:document.title,href:location.href,marker:document.querySelector('#ccem-safe-storage-smoke')?.textContent,cookie:document.cookie})","returnByValue":true}}"#.to_vec();
    command.push(0);
    connection
        .writer
        .write_all(&command)
        .map_err(|error| format!("write Safe Storage smoke CDP command: {error}"))?;
    let deadline = Instant::now() + timeout;
    let mut buffered = Vec::new();
    while Instant::now() < deadline {
        let mut chunk = [0_u8; 4096];
        match connection.reader.read(&mut chunk) {
            Ok(0) => return Err("Safe Storage smoke CDP bridge closed".to_string()),
            Ok(count) => {
                buffered.extend_from_slice(&chunk[..count]);
                if buffered.len() > 1024 * 1024 {
                    return Err("Safe Storage smoke CDP response exceeded 1 MiB".to_string());
                }
                while let Some(end) = buffered.iter().position(|byte| *byte == 0) {
                    let frame = buffered.drain(..=end).collect::<Vec<_>>();
                    let value: serde_json::Value =
                        serde_json::from_slice(&frame[..frame.len() - 1])
                            .map_err(|error| format!("parse Safe Storage CDP response: {error}"))?;
                    if value.get("id").and_then(serde_json::Value::as_i64) != Some(COMMAND_ID) {
                        continue;
                    }
                    let title = value
                        .pointer("/result/result/value/title")
                        .and_then(|v| v.as_str());
                    let marker = value
                        .pointer("/result/result/value/marker")
                        .and_then(|v| v.as_str());
                    let cookie = value
                        .pointer("/result/result/value/cookie")
                        .and_then(|v| v.as_str());
                    if title == Some("CCEM_SAFE_STORAGE_READY")
                        && marker == Some("CCEM MODE 2 SAFE STORAGE")
                        && cookie.is_some_and(|cookie| {
                            cookie
                                .split(';')
                                .map(str::trim)
                                .any(|item| item == format!("ccem_mode2_safe_storage={nonce}"))
                        })
                    {
                        return Ok(());
                    }
                    return Err("persistent Safe Storage cookie was not readable".to_string());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {}
            Err(error) => return Err(format!("read Safe Storage CDP response: {error}")),
        }
    }
    Err("Safe Storage cookie verification timed out".to_string())
}

impl MacosSafeStorageSmokeConfig {
    fn profile_id(&self) -> String {
        format!("safe-storage-{}-{}", self.scenario, &self.nonce[..24])
    }

    fn surface_id(&self) -> String {
        format!(
            "mode2-safe-storage-{}-{}-{}",
            self.scenario,
            self.phase,
            &self.nonce[..12]
        )
    }

    fn surface_request(&self, url: &str) -> CefSurfaceRequest {
        CefSurfaceRequest {
            surface_id: self.surface_id(),
            profile_id: self.profile_id(),
            initial_url: url.to_string(),
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
        Err("Safe Storage smoke was cancelled".to_string())
    } else {
        Ok(())
    }
}

fn verify_system_keychain_marker_preflight(cache_root: &Path) -> Result<(), String> {
    fs::create_dir_all(cache_root)
        .map_err(|error| format!("create Safe Storage CEF cache root: {error}"))?;
    let marker = cache_root.join(".ccem-credential-store");
    let expected = expected_system_keychain_marker()?;
    match fs::symlink_metadata(&marker) {
        Ok(_) => validate_credential_store_marker(&marker, &expected),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if fs::read_dir(cache_root)
                .map_err(|error| format!("inspect unmarked Safe Storage cache root: {error}"))?
                .next()
                .is_some()
            {
                return Err(
                    "Safe Storage smoke refuses a non-empty cache without a credential marker"
                        .to_string(),
                );
            }
            Ok(())
        }
        Err(error) => Err(format!("inspect Safe Storage credential marker: {error}")),
    }
}

fn verify_system_keychain_marker(cache_root: &Path) -> Result<(), String> {
    let marker = cache_root.join(".ccem-credential-store");
    validate_credential_store_marker(&marker, &expected_system_keychain_marker()?)
}

fn expected_system_keychain_marker() -> Result<Vec<u8>, String> {
    let team_identifier = option_env!("CCEM_OFFICIAL_APPLE_TEAM_ID").ok_or_else(|| {
        "Safe Storage smoke release has no embedded official Apple Team ID".to_string()
    })?;
    expected_credential_store_marker(
        CefCredentialStorePolicy::SystemKeychain,
        Some(team_identifier),
    )
}

struct LocalCookieServer {
    address: String,
    cancelled: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl LocalCookieServer {
    fn start(config: &MacosSafeStorageSmokeConfig) -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|error| format!("bind Safe Storage loopback server: {error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("configure Safe Storage loopback server: {error}"))?;
        let address = listener
            .local_addr()
            .map_err(|error| format!("resolve Safe Storage loopback server: {error}"))?;
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_cancelled = Arc::clone(&cancelled);
        let nonce = config.nonce.clone();
        let prime = config.phase == "prime";
        let worker = thread::Builder::new()
            .name("ccem-safe-storage-loopback".to_string())
            .spawn(move || {
                while !worker_cancelled.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((stream, _)) => serve_cookie_page(stream, &nonce, prime),
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(10));
                        }
                        Err(_) => break,
                    }
                }
            })
            .map_err(|error| format!("spawn Safe Storage loopback server: {error}"))?;
        Ok(Self {
            address: format!("http://{address}"),
            cancelled,
            worker: Some(worker),
        })
    }

    fn url(&self) -> &str {
        &self.address
    }
}

fn serve_cookie_page(mut stream: TcpStream, nonce: &str, prime: bool) {
    let mut request = [0_u8; 4096];
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.read(&mut request);
    let body = "<!doctype html><meta charset=utf-8><title>CCEM_SAFE_STORAGE_READY</title><main id=ccem-safe-storage-smoke>CCEM MODE 2 SAFE STORAGE</main>";
    let cookie = if prime {
        format!(
            "Set-Cookie: ccem_mode2_safe_storage={nonce}; Max-Age=3600; Path=/; SameSite=Lax\r\n"
        )
    } else {
        String::new()
    };
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\n{cookie}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

impl Drop for LocalCookieServer {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn finish_before_event_loop(config: &MacosSafeStorageSmokeConfig, error: &str) -> i32 {
    let outcome = SmokeOutcome::failed(error.to_string());
    if config.receipt_path.parent().is_some_and(Path::is_dir) {
        let _ = write_terminal_receipt(config, &outcome, &[], &RuntimeFacts::default());
    }
    emit_process_result(config, &outcome);
    EXIT_SMOKE_FAILED
}

fn write_terminal_receipt(
    config: &MacosSafeStorageSmokeConfig,
    outcome: &SmokeOutcome,
    stages: &[SmokeStage],
    facts: &RuntimeFacts,
) -> Result<(), String> {
    let receipt = RuntimeReceipt {
        schema_version: SCHEMA_VERSION,
        smoke: SMOKE_NAME,
        status: outcome.status,
        exit_code: outcome.exit_code,
        error: outcome.error.as_deref(),
        nonce: &config.nonce,
        source_commit: &config.source_commit,
        run_id: &config.run_id,
        run_attempt: &config.run_attempt,
        target: &config.target,
        repository: &config.repository,
        workflow_ref: &config.workflow_ref,
        producer_workflow_ref: &config.producer_workflow_ref,
        job: &config.job,
        scenario: &config.scenario,
        phase: &config.phase,
        app_version: env!("CARGO_PKG_VERSION"),
        main_pid: std::process::id(),
        executable_path: config.expected_executable.to_string_lossy().into_owned(),
        smoke_root: config.smoke_root.to_string_lossy().into_owned(),
        cef_cache_root: config.cef_cache_root.to_string_lossy().into_owned(),
        profile_id: config.profile_id(),
        surface_id: config.surface_id(),
        credential_store: "macos-system-keychain-v2",
        safe_storage_service: "CCEM Safe Storage",
        distribution_signature_verified: facts.distribution_signature_verified,
        safe_storage_branding_verified: facts.safe_storage_branding_verified,
        system_keychain_marker_verified: facts.system_keychain_marker_verified,
        persistent_cookie_verified: facts.persistent_cookie_verified,
        persistent_profile_storage: true,
        normal_startup_bypassed: true,
        sandbox_enabled: facts.sandbox_enabled,
        production_path: facts.production_path.as_ref(),
        stages,
    };
    write_json_atomic_create(&config.receipt_path, &receipt)
}

fn write_json_atomic_create<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if fs::symlink_metadata(path).is_ok() {
        return Err(format!(
            "Safe Storage smoke refuses existing receipt {}",
            path.display()
        ));
    }
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Safe Storage receipt name is invalid".to_string())?;
    let temporary = path.with_file_name(format!(
        ".{file_name}.{}-{}.tmp",
        std::process::id(),
        TEMPORARY_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let bytes = serde_json::to_vec(value)
            .map_err(|error| format!("serialize Safe Storage receipt: {error}"))?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("create Safe Storage temporary receipt: {error}"))?;
        file.write_all(&bytes)
            .and_then(|()| file.write_all(b"\n"))
            .and_then(|()| file.sync_all())
            .map_err(|error| format!("write Safe Storage receipt: {error}"))?;
        drop(file);
        fs::hard_link(&temporary, path)
            .map_err(|error| format!("publish Safe Storage receipt atomically: {error}"))?;
        fs::remove_file(&temporary)
            .map_err(|error| format!("remove Safe Storage temporary receipt: {error}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn emit_process_result(config: &MacosSafeStorageSmokeConfig, outcome: &SmokeOutcome) {
    let value = serde_json::json!({
        "schemaVersion": SCHEMA_VERSION,
        "smoke": SMOKE_NAME,
        "status": outcome.status,
        "exitCode": outcome.exit_code,
        "receiptPath": config.receipt_path,
        "error": outcome.error,
    });
    eprintln!("{value}");
}
