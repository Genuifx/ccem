use super::{
    check_cancelled, publish_observation_ready, wait_for_observation_ack, ProductionCleanupProof,
    ProductionPathCheckpoint, ProductionPathReceipt, ProductionProfileStorageProof,
    ProductionSemanticProof, RuntimeReceipt, StageRecorder, WindowsMode2SmokeConfig,
    WindowsMode2SmokeRuntime, ACK_TIMEOUT, CDP_TIMEOUT, CLOSE_TIMEOUT, READY_TIMEOUT,
    SCHEMA_VERSION, SMOKE_URL,
};
use crate::browser::login::{
    cef::surface::{CefSurfaceConnection, CefSurfaceLifecycle, CefSurfaceRequest, LogicalViewport},
    session::TrustedWorkspacePath,
    surface_commands::{
        BrowserSurfaceControlActionArg, ProductionSmokeLease, ProductionSmokeSemanticRun,
    },
};
use fs2::FileExt;
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::AppHandle;

pub(super) fn execute_smoke(
    app: AppHandle,
    runtime: WindowsMode2SmokeRuntime,
    preview: Arc<crate::browser::BrowserManager>,
    config: WindowsMode2SmokeConfig,
    cancelled: Arc<AtomicBool>,
) -> Result<RuntimeReceipt, String> {
    let layout = runtime.cef_host.ensure_ready(&app)?;
    if !layout.sandbox_enabled
        || !layout.network_service_sandbox_requested
        || !layout.network_service_lpac_requested
    {
        return Err(
            "Windows Mode 2 production smoke requires the CEF sandbox and its internal NetworkServiceSandbox request"
                .to_string(),
        );
    }
    check_cancelled(&cancelled)?;

    let mut stages = StageRecorder::new();
    run_direct_host_probe(&app, &runtime, &config, &cancelled, &mut stages)?;
    let server = LocalSmokeServer::start(&config.nonce)?;
    let mut cleanup =
        ProductionSurfaceCleanup::new(app.clone(), runtime.clone(), Arc::clone(&preview));

    let workspace = config.workspace_root.to_string_lossy().into_owned();
    let mut lease = runtime.surfaces.production_smoke_acquire_default(
        &app,
        &runtime.sessions,
        &runtime.cef_host,
        &preview,
        workspace.clone(),
        server.bootstrap_url().to_string(),
        1,
    )?;
    cleanup.lease = Some(lease.clone());
    stages.record("production_acquired_hidden_ready")?;
    check_cancelled(&cancelled)?;

    runtime.surfaces.production_smoke_sync(
        &app,
        &runtime.cef_host,
        &preview,
        &mut lease,
        2,
        true,
    )?;
    cleanup.lease = Some(lease.clone());
    stages.record("production_shown")?;
    runtime.surfaces.production_smoke_sync(
        &app,
        &runtime.cef_host,
        &preview,
        &mut lease,
        3,
        false,
    )?;
    cleanup.lease = Some(lease.clone());
    stages.record("production_hidden")?;
    runtime.surfaces.production_smoke_sync(
        &app,
        &runtime.cef_host,
        &preview,
        &mut lease,
        4,
        true,
    )?;
    cleanup.lease = Some(lease.clone());
    stages.record("production_reshown")?;
    let native_window =
        runtime
            .surfaces
            .production_smoke_native_window(&app, &runtime.cef_host, &lease)?;
    let checkpoint = config.production_checkpoint(lease.profile_id.clone(), native_window)?;
    publish_observation_ready(&config, &layout, checkpoint.clone(), &stages.stages)?;
    wait_for_observation_ack(&config, &cancelled, ACK_TIMEOUT)?;
    check_cancelled(&cancelled)?;

    runtime.surfaces.production_smoke_control(
        &app,
        &runtime.sessions,
        &runtime.cef_host,
        &mut lease,
        5,
        BrowserSurfaceControlActionArg::Handoff,
    )?;
    cleanup.lease = Some(lease.clone());
    stages.record("production_handoff")?;
    check_cancelled(&cancelled)?;

    let semantic_marker = format!("CCEM_MODE2_PRIMARY_{}", &config.nonce[..16]);
    let ProductionSmokeSemanticRun {
        proof: mut semantic,
        active_effect,
    } = runtime.sessions.production_smoke_run_semantic_chain(
        &workspace,
        server.semantic_url(),
        &semantic_marker,
    )?;
    stages.record("production_semantic_chain_started")?;
    server.wait_for_effect_entry(Duration::from_secs(5))?;
    semantic.active_effect_entered = true;
    stages.record("production_active_effect_entered")?;
    check_cancelled(&cancelled)?;

    let occlusion_started = Instant::now();
    runtime.surfaces.production_smoke_control(
        &app,
        &runtime.sessions,
        &runtime.cef_host,
        &mut lease,
        6,
        BrowserSurfaceControlActionArg::Occlude,
    )?;
    let occlusion_ack_millis =
        u64::try_from(occlusion_started.elapsed().as_millis()).unwrap_or(u64::MAX);
    if occlusion_ack_millis >= 1_000 {
        return Err(
            "Windows Mode 2 trusted occlusion acknowledgement exceeded one second".to_string(),
        );
    }
    semantic.occlusion_ack_millis = occlusion_ack_millis;
    semantic.occlusion_ack_under_one_second = true;
    cleanup.lease = Some(lease.clone());
    stages.record("production_occluded")?;
    check_cancelled(&cancelled)?;

    active_effect.require_cancelled(Duration::from_secs(2))?;
    semantic.active_effect_cancelled = true;
    stages.record("production_active_effect_cancelled")?;
    check_cancelled(&cancelled)?;

    runtime.surfaces.production_smoke_sync(
        &app,
        &runtime.cef_host,
        &preview,
        &mut lease,
        7,
        true,
    )?;
    cleanup.lease = Some(lease.clone());
    stages.record("production_restored")?;
    check_cancelled(&cancelled)?;

    runtime.surfaces.production_smoke_control(
        &app,
        &runtime.sessions,
        &runtime.cef_host,
        &mut lease,
        8,
        BrowserSurfaceControlActionArg::Handoff,
    )?;
    cleanup.lease = Some(lease.clone());
    stages.record("production_rehandoff")?;
    check_cancelled(&cancelled)?;

    runtime.sessions.production_smoke_verify_profile_storage(
        &workspace,
        server.semantic_url(),
        &semantic_marker,
        true,
    )?;
    semantic.post_pause_no_late_write = true;
    stages.record("production_post_pause_no_late_write")?;
    check_cancelled(&cancelled)?;

    runtime.surfaces.production_smoke_control(
        &app,
        &runtime.sessions,
        &runtime.cef_host,
        &mut lease,
        9,
        BrowserSurfaceControlActionArg::Pause,
    )?;
    cleanup.lease = Some(lease.clone());
    stages.record("production_paused")?;
    check_cancelled(&cancelled)?;

    runtime.surfaces.production_smoke_control(
        &app,
        &runtime.sessions,
        &runtime.cef_host,
        &mut lease,
        10,
        BrowserSurfaceControlActionArg::Takeover,
    )?;
    cleanup.lease = Some(lease.clone());
    stages.record("production_takeover")?;
    check_cancelled(&cancelled)?;

    runtime.surfaces.production_smoke_release(
        &app,
        &runtime.sessions,
        &runtime.cef_host,
        &mut lease,
        11,
    )?;
    cleanup.lease = None;
    stages.record("production_released")?;
    check_cancelled(&cancelled)?;

    let secondary_workspace = config
        .secondary_workspace_root
        .to_string_lossy()
        .into_owned();
    let mut cross_workspace_default = runtime.surfaces.production_smoke_acquire_default(
        &app,
        &runtime.sessions,
        &runtime.cef_host,
        &preview,
        secondary_workspace.clone(),
        server.semantic_url().to_string(),
        12,
    )?;
    if cross_workspace_default.profile_id != lease.profile_id {
        return Err(
            "Windows Mode 2 workspaces did not select the same app-global Default profile"
                .to_string(),
        );
    }
    if cross_workspace_default.session_id == lease.session_id {
        return Err(
            "Windows Mode 2 workspaces reused one browser session for the shared Default profile"
                .to_string(),
        );
    }
    cleanup.lease = Some(cross_workspace_default.clone());
    stages.record("production_cross_workspace_default_ready")?;
    runtime.surfaces.production_smoke_sync(
        &app,
        &runtime.cef_host,
        &preview,
        &mut cross_workspace_default,
        13,
        true,
    )?;
    cleanup.lease = Some(cross_workspace_default.clone());
    stages.record("production_cross_workspace_default_shown")?;
    check_cancelled(&cancelled)?;

    runtime.surfaces.production_smoke_control(
        &app,
        &runtime.sessions,
        &runtime.cef_host,
        &mut cross_workspace_default,
        14,
        BrowserSurfaceControlActionArg::Handoff,
    )?;
    cleanup.lease = Some(cross_workspace_default.clone());
    stages.record("production_cross_workspace_default_handoff")?;
    runtime.sessions.production_smoke_verify_profile_storage(
        &secondary_workspace,
        server.semantic_url(),
        &semantic_marker,
        false,
    )?;
    stages.record("production_cross_workspace_default_storage_shared_verified")?;

    runtime.surfaces.production_smoke_release(
        &app,
        &runtime.sessions,
        &runtime.cef_host,
        &mut cross_workspace_default,
        15,
    )?;
    cleanup.lease = None;
    stages.record("production_cross_workspace_default_released")?;

    let mut explicit = runtime.surfaces.production_smoke_acquire_explicit_new(
        &app,
        &runtime.sessions,
        &runtime.cef_host,
        &preview,
        secondary_workspace.clone(),
        server.semantic_url().to_string(),
        16,
    )?;
    if explicit.profile_id == lease.profile_id {
        return Err(
            "Windows Mode 2 Explicit New selected the app-global Default profile".to_string(),
        );
    }
    cleanup.lease = Some(explicit.clone());
    stages.record("production_explicit_new_acquired")?;
    runtime.surfaces.production_smoke_sync(
        &app,
        &runtime.cef_host,
        &preview,
        &mut explicit,
        17,
        true,
    )?;
    cleanup.lease = Some(explicit.clone());
    stages.record("production_explicit_new_shown")?;
    runtime.surfaces.production_smoke_control(
        &app,
        &runtime.sessions,
        &runtime.cef_host,
        &mut explicit,
        18,
        BrowserSurfaceControlActionArg::Handoff,
    )?;
    cleanup.lease = Some(explicit.clone());
    stages.record("production_explicit_new_handoff")?;
    let explicit_marker = format!("CCEM_MODE2_EXPLICIT_{}", &config.nonce[..16]);
    runtime.sessions.production_smoke_write_isolated_profile(
        &secondary_workspace,
        server.semantic_url(),
        &explicit_marker,
    )?;
    stages.record("production_explicit_new_isolation_verified")?;
    runtime.surfaces.production_smoke_release(
        &app,
        &runtime.sessions,
        &runtime.cef_host,
        &mut explicit,
        19,
    )?;
    cleanup.lease = None;
    stages.record("production_explicit_new_released")?;

    let mut reopened_explicit = runtime.surfaces.production_smoke_acquire_saved(
        &app,
        &runtime.sessions,
        &runtime.cef_host,
        &preview,
        secondary_workspace.clone(),
        explicit.profile_id.clone(),
        server.semantic_url().to_string(),
        20,
    )?;
    if reopened_explicit.profile_id != explicit.profile_id {
        return Err("Windows Mode 2 smoke reopened a different Explicit New profile".to_string());
    }
    if reopened_explicit.session_id == explicit.session_id {
        return Err(
            "Windows Mode 2 Explicit New reopen reused the prior browser session".to_string(),
        );
    }
    cleanup.lease = Some(reopened_explicit.clone());
    stages.record("production_explicit_reopened_ready")?;
    runtime.surfaces.production_smoke_sync(
        &app,
        &runtime.cef_host,
        &preview,
        &mut reopened_explicit,
        21,
        true,
    )?;
    cleanup.lease = Some(reopened_explicit.clone());
    stages.record("production_explicit_reopened_shown")?;
    runtime.surfaces.production_smoke_control(
        &app,
        &runtime.sessions,
        &runtime.cef_host,
        &mut reopened_explicit,
        22,
        BrowserSurfaceControlActionArg::Handoff,
    )?;
    cleanup.lease = Some(reopened_explicit.clone());
    stages.record("production_explicit_reopened_handoff")?;
    runtime.sessions.production_smoke_verify_profile_storage(
        &secondary_workspace,
        server.semantic_url(),
        &explicit_marker,
        false,
    )?;
    stages.record("production_explicit_persistence_verified")?;
    runtime.surfaces.production_smoke_release(
        &app,
        &runtime.sessions,
        &runtime.cef_host,
        &mut reopened_explicit,
        23,
    )?;
    cleanup.lease = None;
    stages.record("production_explicit_reclosed")?;

    let mut final_default = runtime.surfaces.production_smoke_acquire_default(
        &app,
        &runtime.sessions,
        &runtime.cef_host,
        &preview,
        workspace.clone(),
        server.semantic_url().to_string(),
        24,
    )?;
    if final_default.profile_id != lease.profile_id {
        return Err("Windows Mode 2 final Default reopen selected a different profile".to_string());
    }
    cleanup.lease = Some(final_default.clone());
    runtime.surfaces.production_smoke_sync(
        &app,
        &runtime.cef_host,
        &preview,
        &mut final_default,
        25,
        true,
    )?;
    cleanup.lease = Some(final_default.clone());
    stages.record("production_default_final_reopened")?;
    runtime.surfaces.production_smoke_control(
        &app,
        &runtime.sessions,
        &runtime.cef_host,
        &mut final_default,
        26,
        BrowserSurfaceControlActionArg::Handoff,
    )?;
    cleanup.lease = Some(final_default.clone());
    stages.record("production_default_final_handoff")?;
    runtime.sessions.production_smoke_verify_profile_storage(
        &workspace,
        server.semantic_url(),
        &semantic_marker,
        false,
    )?;
    stages.record("production_default_unchanged_verified")?;
    runtime.surfaces.production_smoke_release(
        &app,
        &runtime.sessions,
        &runtime.cef_host,
        &mut final_default,
        27,
    )?;
    cleanup.lease = None;
    stages.record("production_default_final_released")?;

    let cleanup_proof =
        verify_production_cleanup(&runtime, &config, &lease.profile_id, &explicit.profile_id)?;
    stages.record("production_cleanup_verified")?;
    drop(cleanup);
    drop(server);

    Ok(RuntimeReceipt {
        schema_version: SCHEMA_VERSION,
        nonce: config.nonce,
        source_commit: config.source_commit,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        main_pid: std::process::id(),
        executable_path: config.expected_executable,
        sandbox_enabled: true,
        network_service_sandbox_feature: super::NETWORK_SERVICE_SANDBOX_FEATURE,
        network_service_sandbox_requested: true,
        network_service_lpac_feature: super::NETWORK_SERVICE_LPAC_FEATURE,
        network_service_lpac_requested: true,
        production_path: ProductionPathReceipt {
            checkpoint,
            semantic: ProductionSemanticProof {
                navigated_via_capability: semantic.navigated_via_capability,
                ax_snapshot_via_capability: semantic.ax_snapshot_via_capability,
                click_via_element_ref: semantic.click_via_element_ref,
                type_via_element_ref: semantic.type_via_element_ref,
                screenshot: semantic.screenshot,
                storage_commit_via_element_ref: semantic.storage_commit_via_element_ref,
                active_effect_entered: semantic.active_effect_entered,
                active_effect_cancelled: semantic.active_effect_cancelled,
                occlusion_ack_under_one_second: semantic.occlusion_ack_under_one_second,
                occlusion_ack_millis: semantic.occlusion_ack_millis,
                post_pause_no_late_write: semantic.post_pause_no_late_write,
            },
            default_session_id: lease.session_id,
            cross_workspace_default_profile_id: cross_workspace_default.profile_id,
            cross_workspace_default_session_id: cross_workspace_default.session_id,
            explicit_profile_id: explicit.profile_id,
            explicit_session_id: explicit.session_id,
            reopened_explicit_profile_id: reopened_explicit.profile_id,
            reopened_explicit_session_id: reopened_explicit.session_id,
            final_default_profile_id: final_default.profile_id,
            final_default_session_id: final_default.session_id,
            profile_storage: ProductionProfileStorageProof {
                secondary_workspace_root: secondary_workspace,
                default_profile_shared_across_workspaces: true,
                default_cookie_shared: true,
                default_local_storage_shared: true,
                default_cookie_persisted: true,
                default_local_storage_persisted: true,
                explicit_profile_isolated: true,
                explicit_profile_initially_empty: true,
                explicit_cookie_isolated: true,
                explicit_local_storage_isolated: true,
                explicit_cookie_persisted: true,
                explicit_local_storage_persisted: true,
                default_unchanged_after_explicit: true,
            },
            cleanup: cleanup_proof,
        },
        stages: stages.stages,
    })
}

fn run_direct_host_probe(
    app: &AppHandle,
    runtime: &WindowsMode2SmokeRuntime,
    config: &WindowsMode2SmokeConfig,
    cancelled: &AtomicBool,
    stages: &mut StageRecorder,
) -> Result<(), String> {
    let surface_id = config.direct_surface_id();
    let mut cleanup = DirectSurfaceCleanup::new(
        app.clone(),
        Arc::clone(&runtime.cef_host),
        surface_id.clone(),
    );
    let mut connection = runtime
        .cef_host
        .open_surface(app, config.direct_surface_request())?;
    cleanup.surface_open = true;
    let ready = connection.wait_until_ready(READY_TIMEOUT)?;
    if ready.surface_id != surface_id
        || ready.lifecycle != CefSurfaceLifecycle::Ready
        || !ready.visible
        || !ready.current_url.starts_with("data:text/html,")
    {
        return Err("Windows Mode 2 direct-host probe ready snapshot is inconsistent".to_string());
    }
    stages.record("direct_ready")?;
    check_cancelled(cancelled)?;
    require_cdp_document(&mut connection, CDP_TIMEOUT)?;
    stages.record("direct_cdp")?;
    check_cancelled(cancelled)?;
    runtime.cef_host.close_surface(app, surface_id)?;
    let closed = connection.wait_until_closed(CLOSE_TIMEOUT)?;
    if closed.lifecycle != CefSurfaceLifecycle::Closed || closed.visible {
        return Err("Windows Mode 2 direct-host probe did not close".to_string());
    }
    cleanup.surface_open = false;
    stages.record("direct_closed")?;
    Ok(())
}

fn verify_production_cleanup(
    runtime: &WindowsMode2SmokeRuntime,
    config: &WindowsMode2SmokeConfig,
    primary_profile_id: &str,
    secondary_profile_id: &str,
) -> Result<ProductionCleanupProof, String> {
    runtime.surfaces.production_smoke_assert_inactive()?;
    let active_session_count = runtime
        .sessions
        .list_snapshots()
        .map_err(|error| error.to_string())?
        .len();
    if active_session_count != 0 {
        return Err("Windows Mode 2 smoke retained a production session".to_string());
    }
    let owner_record_count = count_directory_entries(&config.owner_record_root)?;
    if owner_record_count != 0 {
        return Err("Windows Mode 2 smoke retained an embedded owner record".to_string());
    }
    let primary_workspace = TrustedWorkspacePath::from_trusted_app(config.workspace_root.clone())
        .map_err(|error| error.to_string())?;
    let primary_profiles = runtime
        .sessions
        .profile_summaries(primary_workspace)
        .map_err(|error| error.to_string())?;
    if primary_profiles.len() != 1
        || primary_profiles[0].profile_id != primary_profile_id
        || !primary_profiles[0].is_default
    {
        return Err(
            "Windows Mode 2 primary workspace inventory did not contain only the app-global Default profile"
                .to_string(),
        );
    }
    let secondary_workspace =
        TrustedWorkspacePath::from_trusted_app(config.secondary_workspace_root.clone())
            .map_err(|error| error.to_string())?;
    let secondary_profiles = runtime
        .sessions
        .profile_summaries(secondary_workspace)
        .map_err(|error| error.to_string())?;
    if secondary_profiles.len() != 2
        || secondary_profiles[0].profile_id != primary_profile_id
        || !secondary_profiles[0].is_default
        || secondary_profiles[1].profile_id != secondary_profile_id
        || secondary_profiles[1].is_default
    {
        return Err(
            "Windows Mode 2 secondary workspace inventory did not contain Default plus Explicit New"
                .to_string(),
        );
    }
    for profile_id in [primary_profile_id, secondary_profile_id] {
        let lock_path = config
            .profile_state_root
            .join("profiles")
            .join(profile_id)
            .join("profile.lock");
        require_profile_lock_available(&lock_path)?;
    }
    Ok(ProductionCleanupProof {
        active_surface_count: 0,
        active_session_count: 0,
        owner_record_count: 0,
        persisted_profile_count: 2,
        workspace_count: 2,
        profile_locks_available: true,
    })
}

fn count_directory_entries(root: &Path) -> Result<usize, String> {
    fs::read_dir(root)
        .map_err(|error| format!("read Windows Mode 2 owner record root: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map(|entries| entries.len())
        .map_err(|error| format!("inspect Windows Mode 2 owner record root: {error}"))
}

fn require_profile_lock_available(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("inspect Windows Mode 2 profile lock: {error}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Windows Mode 2 profile lock is not a regular file".to_string());
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|error| format!("open Windows Mode 2 profile lock: {error}"))?;
    file.try_lock_exclusive()
        .map_err(|error| format!("production profile lock remained held: {error}"))?;
    FileExt::unlock(&file)
        .map_err(|error| format!("release Windows Mode 2 profile lock probe: {error}"))
}

impl WindowsMode2SmokeConfig {
    fn direct_surface_id(&self) -> String {
        format!("mode2-windows-direct-probe-{}", &self.nonce[..16])
    }

    fn direct_surface_request(&self) -> CefSurfaceRequest {
        CefSurfaceRequest {
            surface_id: self.direct_surface_id(),
            profile_id: format!("direct-profile-{}", &self.nonce[..32]),
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

    fn production_checkpoint(
        &self,
        profile_id: String,
        native_window: super::super::surface::WindowsNativeWindowObservation,
    ) -> Result<ProductionPathCheckpoint, String> {
        for (path, label) in [
            (&self.data_root, "data"),
            (&self.workspace_root, "workspace"),
            (&self.secondary_workspace_root, "secondary workspace"),
            (&self.owner_record_root, "owner record"),
            (&self.profile_state_root, "profile state"),
            (&self.cef_cache_root, "CEF cache"),
        ] {
            if !path.starts_with(&self.smoke_root) {
                return Err(format!(
                    "Windows Mode 2 production {label} root escaped the current run"
                ));
            }
        }
        Ok(ProductionPathCheckpoint {
            verified: true,
            manager: "LoginBrowserSurfaceManager",
            data_root: self.data_root.to_string_lossy().into_owned(),
            workspace_root: self.workspace_root.to_string_lossy().into_owned(),
            owner_record_root: self.owner_record_root.to_string_lossy().into_owned(),
            profile_state_root: self.profile_state_root.to_string_lossy().into_owned(),
            cef_cache_root: self.cef_cache_root.to_string_lossy().into_owned(),
            profile_id,
            native_window,
        })
    }
}

struct DirectSurfaceCleanup {
    app: AppHandle,
    controller: Arc<super::CefHostController>,
    surface_id: String,
    surface_open: bool,
}

impl DirectSurfaceCleanup {
    fn new(app: AppHandle, controller: Arc<super::CefHostController>, surface_id: String) -> Self {
        Self {
            app,
            controller,
            surface_id,
            surface_open: false,
        }
    }
}

impl Drop for DirectSurfaceCleanup {
    fn drop(&mut self) {
        if self.surface_open {
            let _ = self
                .controller
                .close_surface(&self.app, self.surface_id.clone());
        }
    }
}

struct ProductionSurfaceCleanup {
    app: AppHandle,
    runtime: WindowsMode2SmokeRuntime,
    preview: Arc<crate::browser::BrowserManager>,
    lease: Option<ProductionSmokeLease>,
}

impl ProductionSurfaceCleanup {
    fn new(
        app: AppHandle,
        runtime: WindowsMode2SmokeRuntime,
        preview: Arc<crate::browser::BrowserManager>,
    ) -> Self {
        Self {
            app,
            runtime,
            preview,
            lease: None,
        }
    }
}

impl Drop for ProductionSurfaceCleanup {
    fn drop(&mut self) {
        if let Some(mut lease) = self.lease.take() {
            let next_revision = lease.client_revision.saturating_add(1);
            let _ = self.runtime.surfaces.production_smoke_release(
                &self.app,
                &self.runtime.sessions,
                &self.runtime.cef_host,
                &mut lease,
                next_revision,
            );
        }
        let _ = self.runtime.sessions.shutdown_all();
        let _ = self.preview.hide_all(&self.app);
    }
}

struct LocalSmokeServer {
    address: SocketAddr,
    bootstrap_url: String,
    semantic_url: String,
    effect_entries: Arc<AtomicUsize>,
    stopped: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl LocalSmokeServer {
    fn start(nonce: &str) -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|error| format!("bind Windows Mode 2 local smoke origin: {error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("configure Windows Mode 2 local smoke origin: {error}"))?;
        let address = listener
            .local_addr()
            .map_err(|error| format!("resolve Windows Mode 2 local smoke origin: {error}"))?;
        let stopped = Arc::new(AtomicBool::new(false));
        let effect_entries = Arc::new(AtomicUsize::new(0));
        let worker_stopped = Arc::clone(&stopped);
        let worker_entries = Arc::clone(&effect_entries);
        let effect_path = format!("/effect-entered/{}", &nonce[..16]);
        let worker_effect_path = effect_path.clone();
        let body = local_smoke_body(&effect_path);
        let worker = thread::Builder::new()
            .name("ccem-mode2-smoke-origin".to_string())
            .spawn(move || {
                serve_local_origin(
                    listener,
                    worker_stopped,
                    worker_entries,
                    worker_effect_path,
                    body,
                )
            })
            .map_err(|error| format!("start Windows Mode 2 local smoke origin: {error}"))?;
        Ok(Self {
            address,
            bootstrap_url: format!("http://{address}/bootstrap"),
            semantic_url: format!(
                "http://{address}/mode2-production-smoke?run={}",
                &nonce[..16]
            ),
            effect_entries,
            stopped,
            worker: Some(worker),
        })
    }

    fn bootstrap_url(&self) -> &str {
        &self.bootstrap_url
    }

    fn semantic_url(&self) -> &str {
        &self.semantic_url
    }

    fn wait_for_effect_entry(&self, timeout: Duration) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            match self.effect_entries.load(Ordering::Acquire) {
                0 => thread::sleep(Duration::from_millis(1)),
                1 => return Ok(()),
                _ => {
                    return Err(
                        "Windows Mode 2 active effect entered the smoke barrier more than once"
                            .to_string(),
                    )
                }
            }
        }
        Err("Windows Mode 2 active effect never reached the page barrier".to_string())
    }
}

impl Drop for LocalSmokeServer {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect_timeout(&self.address, Duration::from_millis(100));
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn serve_local_origin(
    listener: TcpListener,
    stopped: Arc<AtomicBool>,
    effect_entries: Arc<AtomicUsize>,
    effect_path: String,
    body: String,
) {
    while !stopped.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => respond_local_origin(stream, &effect_entries, &effect_path, &body),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(_) => return,
        }
    }
}

fn respond_local_origin(
    mut stream: TcpStream,
    effect_entries: &AtomicUsize,
    effect_path: &str,
    body: &str,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
    let mut request = [0_u8; 4096];
    let count = stream.read(&mut request).unwrap_or(0);
    let request = String::from_utf8_lossy(&request[..count]);
    let path = request
        .lines()
        .next()
        .and_then(|line| line.split_ascii_whitespace().nth(1));
    if path == Some(effect_path) {
        effect_entries.fetch_add(1, Ordering::AcqRel);
        // Keep mousePressed in flight just long enough for the trusted host to
        // issue occlusion. The fixed delay is below the 200 ms owner-ack fence;
        // cancellation wakes transport polling and emits only the safety release.
        thread::sleep(Duration::from_millis(100));
        let _ = stream.write_all(
            b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",
        );
        let _ = stream.flush();
        return;
    }
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn local_smoke_body(effect_path: &str) -> String {
    format!(
        r#"<!doctype html><meta charset=utf-8><title>CCEM_WINDOWS_MODE2_PRODUCTION_READY</title>
<main id=ccem-mode2-production>
<label>CCEM Mode 2 semantic input<input id=input aria-label="CCEM Mode 2 semantic input"></label>
<button id=commit>Commit CCEM Mode 2 profile storage</button>
<button id=race>Start CCEM Mode 2 cancellable effect</button>
<input id=cookie readonly aria-label="CCEM Mode 2 cookie marker">
<input id=local readonly aria-label="CCEM Mode 2 local storage marker">
<input id=entered readonly aria-label="CCEM Mode 2 effect entered">
<input id=late readonly aria-label="CCEM Mode 2 late write">
</main><script>
const storageKey='ccem_mode2_profile_marker';
const readCookie=()=>{{const row=document.cookie.split('; ').find(v=>v.startsWith(storageKey+'='));return row?decodeURIComponent(row.slice(storageKey.length+1)):'';}};
const sync=()=>{{cookie.value=readCookie();local.value=localStorage.getItem(storageKey)||'';input.value=local.value||cookie.value;}};
commit.addEventListener('click',()=>{{document.cookie=storageKey+'='+encodeURIComponent(input.value)+'; Path=/; SameSite=Strict';localStorage.setItem(storageKey,input.value);sync();}});
race.addEventListener('mousedown',()=>{{entered.value='EFFECT_ENTERED';const request=new XMLHttpRequest();request.open('GET','{effect_path}',false);request.send();}});
race.addEventListener('click',()=>{{late.value='LATE_WRITE_MUST_NOT_APPEAR';}});
sync();
</script>"#
    )
}

fn require_cdp_document(
    connection: &mut CefSurfaceConnection,
    timeout: Duration,
) -> Result<(), String> {
    const COMMAND_ID: i64 = 91_001;
    let mut command = br#"{"id":91001,"method":"Runtime.evaluate","params":{"expression":"({title:document.title,href:location.href,marker:document.querySelector('#ccem-mode2-smoke')?.textContent})","returnByValue":true}}"#.to_vec();
    command.push(0);
    connection
        .writer
        .write_all(&command)
        .map_err(|error| format!("write Windows Mode 2 smoke CDP command: {error}"))?;

    let deadline = std::time::Instant::now() + timeout;
    let mut buffered = Vec::new();
    while std::time::Instant::now() < deadline {
        let mut chunk = [0_u8; 4096];
        match connection.reader.read(&mut chunk) {
            Ok(0) => return Err("Windows Mode 2 smoke CDP bridge closed".to_string()),
            Ok(count) => {
                buffered.extend_from_slice(&chunk[..count]);
                if buffered.len() > 1024 * 1024 {
                    return Err("Windows Mode 2 smoke CDP response exceeded 1 MiB".to_string());
                }
                while let Some(end) = buffered.iter().position(|byte| *byte == 0) {
                    let frame = buffered.drain(..=end).collect::<Vec<_>>();
                    let value =
                        serde_json::from_slice::<serde_json::Value>(&frame[..frame.len() - 1])
                            .map_err(|error| {
                                format!("parse Windows Mode 2 smoke CDP response: {error}")
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
                    if title == Some("CCEM_WINDOWS_MODE2_SMOKE_READY")
                        && href.is_some_and(|href| href.starts_with("data:text/html,"))
                        && marker == Some("MODE 2 WINDOWS SIGNED RELEASE")
                    {
                        return Ok(());
                    }
                    return Err(
                        "Windows Mode 2 smoke CDP response did not describe the expected document"
                            .to_string(),
                    );
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {}
            Err(error) => return Err(format!("read Windows Mode 2 smoke CDP response: {error}")),
        }
    }
    Err("Windows Mode 2 smoke CDP response timed out".to_string())
}
