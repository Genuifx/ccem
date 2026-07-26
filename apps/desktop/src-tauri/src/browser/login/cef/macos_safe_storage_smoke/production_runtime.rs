use super::MacosSafeStorageSmokeConfig;
use crate::browser::{
    login::{
        cef::host::CefHostController,
        session::{LoginBrowserSessionManager, TrustedWorkspacePath},
        surface_commands::{
            BrowserSurfaceControlActionArg, LoginBrowserSurfaceManager, ProductionSmokeLease,
            ProductionSmokeScreenshotProof, ProductionSmokeSemanticRun,
        },
    },
    BrowserManager,
};
use fs2::FileExt;
use serde::Serialize;
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

const PROOF_SCHEMA_VERSION: u32 = 2;
const EFFECT_ENTRY_TIMEOUT: Duration = Duration::from_secs(5);
const EFFECT_CANCEL_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MacosProductionSemanticProof {
    navigated_via_capability: bool,
    ax_snapshot_via_capability: bool,
    click_via_element_ref: bool,
    type_via_element_ref: bool,
    screenshot: ProductionSmokeScreenshotProof,
    storage_commit_via_element_ref: bool,
    active_effect_entered: bool,
    active_effect_cancelled: bool,
    occlusion_ack_under_one_second: bool,
    occlusion_ack_millis: u64,
    post_pause_no_late_write: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MacosProductionProfileIsolationProof {
    distinct_workspace_profiles: bool,
    primary_cookie_persisted: bool,
    primary_local_storage_persisted: bool,
    secondary_profile_initially_empty: bool,
    secondary_cookie_isolated: bool,
    secondary_local_storage_isolated: bool,
    primary_unchanged_after_secondary: bool,
    secondary_unchanged_after_primary: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MacosProductionCleanupProof {
    active_surface_count: u32,
    active_session_count: u32,
    owner_record_count: u32,
    persisted_profile_count: u32,
    workspace_count: u32,
    profile_locks_available: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MacosProductionPathProof {
    schema_version: u32,
    verified: bool,
    manager: &'static str,
    session_root: String,
    workspace_root: String,
    secondary_workspace_root: String,
    primary_profile_id: String,
    reopened_primary_profile_id: String,
    final_primary_profile_id: String,
    secondary_profile_id: String,
    final_secondary_profile_id: String,
    semantic: MacosProductionSemanticProof,
    profile_isolation: MacosProductionProfileIsolationProof,
    cleanup: MacosProductionCleanupProof,
}

struct ProductionRuntime {
    sessions: Arc<LoginBrowserSessionManager>,
    surfaces: Arc<LoginBrowserSurfaceManager>,
    cef_host: Arc<CefHostController>,
}

struct ProductionCleanup {
    app: AppHandle,
    runtime: ProductionRuntime,
    preview: Arc<BrowserManager>,
    lease: Option<ProductionSmokeLease>,
}

impl ProductionCleanup {
    fn new(app: AppHandle, runtime: ProductionRuntime, preview: Arc<BrowserManager>) -> Self {
        Self {
            app,
            runtime,
            preview,
            lease: None,
        }
    }
}

impl Drop for ProductionCleanup {
    fn drop(&mut self) {
        if let Some(mut lease) = self.lease.take() {
            let revision = lease.client_revision.saturating_add(1);
            let _ = self.runtime.surfaces.production_smoke_release(
                &self.app,
                &self.runtime.sessions,
                &self.runtime.cef_host,
                &mut lease,
                revision,
            );
        }
        let _ = self.runtime.sessions.shutdown_all();
        let _ = self.preview.hide_all(&self.app);
    }
}

pub(super) fn run(
    app: &AppHandle,
    cef_host: Arc<CefHostController>,
    config: &MacosSafeStorageSmokeConfig,
) -> Result<MacosProductionPathProof, String> {
    let session_root = config.smoke_root.join("data/login");
    let owner_record_root = session_root.join("embedded-owners");
    let profile_state_root = session_root.join("profile-state");
    let workspace_root = config
        .smoke_root
        .join(format!("workspace-{}", config.phase));
    let secondary_workspace_root = config
        .smoke_root
        .join(format!("workspace-{}-secondary", config.phase));
    create_private_workspace(&workspace_root)?;
    create_private_workspace(&secondary_workspace_root)?;

    let sessions = Arc::new(
        LoginBrowserSessionManager::production(session_root.clone())
            .map_err(|error| error.to_string())?,
    );
    let surfaces = Arc::new(LoginBrowserSurfaceManager::production(
        owner_record_root.clone(),
        &sessions,
    )?);
    let runtime = ProductionRuntime {
        sessions,
        surfaces,
        cef_host,
    };
    let preview = Arc::new(BrowserManager::default());
    let mut cleanup = ProductionCleanup::new(app.clone(), runtime, Arc::clone(&preview));
    let server = LocalSemanticServer::start(&config.nonce)?;
    let workspace = workspace_root.to_string_lossy().into_owned();
    let secondary_workspace = secondary_workspace_root.to_string_lossy().into_owned();

    let mut primary = cleanup.runtime.surfaces.production_smoke_acquire(
        app,
        &cleanup.runtime.sessions,
        &cleanup.runtime.cef_host,
        &preview,
        workspace.clone(),
        None,
        server.url().to_string(),
        1,
    )?;
    cleanup.lease = Some(primary.clone());
    cleanup.runtime.surfaces.production_smoke_sync(
        app,
        &cleanup.runtime.cef_host,
        &preview,
        &mut primary,
        2,
        true,
    )?;
    cleanup.lease = Some(primary.clone());
    cleanup.runtime.surfaces.production_smoke_control(
        app,
        &cleanup.runtime.sessions,
        &cleanup.runtime.cef_host,
        &mut primary,
        3,
        BrowserSurfaceControlActionArg::Handoff,
    )?;
    cleanup.lease = Some(primary.clone());

    let primary_marker = format!("CCEM_MODE2_MAC_PRIMARY_{}", &config.nonce[..16]);
    let ProductionSmokeSemanticRun {
        proof: semantic,
        active_effect,
    } = cleanup
        .runtime
        .sessions
        .production_smoke_run_semantic_chain(&workspace, server.url(), &primary_marker)?;
    server.wait_for_effect_entry(EFFECT_ENTRY_TIMEOUT)?;
    let occlusion_started = Instant::now();
    cleanup.runtime.surfaces.production_smoke_control(
        app,
        &cleanup.runtime.sessions,
        &cleanup.runtime.cef_host,
        &mut primary,
        4,
        BrowserSurfaceControlActionArg::Occlude,
    )?;
    let occlusion_ack_millis =
        u64::try_from(occlusion_started.elapsed().as_millis()).unwrap_or(u64::MAX);
    if occlusion_ack_millis >= 1_000 {
        return Err("macOS Mode 2 trusted occlusion acknowledgement exceeded one second".into());
    }
    cleanup.lease = Some(primary.clone());
    active_effect.require_cancelled(EFFECT_CANCEL_TIMEOUT)?;
    cleanup.runtime.surfaces.production_smoke_sync(
        app,
        &cleanup.runtime.cef_host,
        &preview,
        &mut primary,
        5,
        true,
    )?;
    cleanup.lease = Some(primary.clone());
    cleanup.runtime.surfaces.production_smoke_control(
        app,
        &cleanup.runtime.sessions,
        &cleanup.runtime.cef_host,
        &mut primary,
        6,
        BrowserSurfaceControlActionArg::Handoff,
    )?;
    cleanup.lease = Some(primary.clone());
    cleanup
        .runtime
        .sessions
        .production_smoke_verify_profile_storage(&workspace, server.url(), &primary_marker, true)?;
    let primary_profile_id = primary.profile_id.clone();
    release(&mut cleanup, &mut primary, 7)?;

    let mut reopened_primary = acquire_saved(
        &mut cleanup,
        &preview,
        &workspace,
        &primary_profile_id,
        server.url(),
        8,
    )?;
    cleanup
        .runtime
        .sessions
        .production_smoke_verify_profile_storage(
            &workspace,
            server.url(),
            &primary_marker,
            false,
        )?;
    let reopened_primary_profile_id = reopened_primary.profile_id.clone();
    release(&mut cleanup, &mut reopened_primary, 11)?;

    let mut secondary = cleanup.runtime.surfaces.production_smoke_acquire(
        app,
        &cleanup.runtime.sessions,
        &cleanup.runtime.cef_host,
        &preview,
        secondary_workspace.clone(),
        None,
        server.url().to_string(),
        12,
    )?;
    if secondary.profile_id == primary_profile_id {
        return Err("macOS Mode 2 isolated workspaces selected the same profile".into());
    }
    cleanup.lease = Some(secondary.clone());
    show_and_handoff(&mut cleanup, &preview, &mut secondary, 13, 14)?;
    let secondary_marker = format!("CCEM_MODE2_MAC_SECONDARY_{}", &config.nonce[..16]);
    cleanup
        .runtime
        .sessions
        .production_smoke_write_isolated_profile(
            &secondary_workspace,
            server.url(),
            &secondary_marker,
        )?;
    let secondary_profile_id = secondary.profile_id.clone();
    release(&mut cleanup, &mut secondary, 15)?;

    let mut final_primary = acquire_saved(
        &mut cleanup,
        &preview,
        &workspace,
        &primary_profile_id,
        server.url(),
        16,
    )?;
    cleanup
        .runtime
        .sessions
        .production_smoke_verify_profile_storage(
            &workspace,
            server.url(),
            &primary_marker,
            false,
        )?;
    let final_primary_profile_id = final_primary.profile_id.clone();
    release(&mut cleanup, &mut final_primary, 19)?;

    let mut final_secondary = acquire_saved(
        &mut cleanup,
        &preview,
        &secondary_workspace,
        &secondary_profile_id,
        server.url(),
        20,
    )?;
    cleanup
        .runtime
        .sessions
        .production_smoke_verify_profile_storage(
            &secondary_workspace,
            server.url(),
            &secondary_marker,
            false,
        )?;
    let final_secondary_profile_id = final_secondary.profile_id.clone();
    release(&mut cleanup, &mut final_secondary, 23)?;

    let cleanup_proof = verify_cleanup(
        &cleanup.runtime,
        &owner_record_root,
        &profile_state_root,
        [
            (&workspace_root, primary_profile_id.as_str()),
            (&secondary_workspace_root, secondary_profile_id.as_str()),
        ],
    )?;
    drop(server);

    Ok(MacosProductionPathProof {
        schema_version: PROOF_SCHEMA_VERSION,
        verified: true,
        manager: "LoginBrowserSurfaceManager/SessionManager",
        session_root: session_root.to_string_lossy().into_owned(),
        workspace_root: workspace,
        secondary_workspace_root: secondary_workspace,
        primary_profile_id,
        reopened_primary_profile_id,
        final_primary_profile_id,
        secondary_profile_id,
        final_secondary_profile_id,
        semantic: MacosProductionSemanticProof {
            navigated_via_capability: semantic.navigated_via_capability,
            ax_snapshot_via_capability: semantic.ax_snapshot_via_capability,
            click_via_element_ref: semantic.click_via_element_ref,
            type_via_element_ref: semantic.type_via_element_ref,
            screenshot: semantic.screenshot,
            storage_commit_via_element_ref: semantic.storage_commit_via_element_ref,
            active_effect_entered: true,
            active_effect_cancelled: true,
            occlusion_ack_under_one_second: true,
            occlusion_ack_millis,
            post_pause_no_late_write: true,
        },
        profile_isolation: MacosProductionProfileIsolationProof {
            distinct_workspace_profiles: true,
            primary_cookie_persisted: true,
            primary_local_storage_persisted: true,
            secondary_profile_initially_empty: true,
            secondary_cookie_isolated: true,
            secondary_local_storage_isolated: true,
            primary_unchanged_after_secondary: true,
            secondary_unchanged_after_primary: true,
        },
        cleanup: cleanup_proof,
    })
}

fn acquire_saved(
    cleanup: &mut ProductionCleanup,
    preview: &Arc<BrowserManager>,
    workspace: &str,
    profile_id: &str,
    url: &str,
    revision: u64,
) -> Result<ProductionSmokeLease, String> {
    let mut lease = cleanup.runtime.surfaces.production_smoke_acquire(
        &cleanup.app,
        &cleanup.runtime.sessions,
        &cleanup.runtime.cef_host,
        preview,
        workspace.to_string(),
        Some(profile_id.to_string()),
        url.to_string(),
        revision,
    )?;
    if lease.profile_id != profile_id {
        return Err("macOS Mode 2 saved profile reopen selected a different profile".into());
    }
    cleanup.lease = Some(lease.clone());
    show_and_handoff(cleanup, preview, &mut lease, revision + 1, revision + 2)?;
    Ok(lease)
}

fn show_and_handoff(
    cleanup: &mut ProductionCleanup,
    preview: &Arc<BrowserManager>,
    lease: &mut ProductionSmokeLease,
    show_revision: u64,
    handoff_revision: u64,
) -> Result<(), String> {
    cleanup.runtime.surfaces.production_smoke_sync(
        &cleanup.app,
        &cleanup.runtime.cef_host,
        preview,
        lease,
        show_revision,
        true,
    )?;
    cleanup.lease = Some(lease.clone());
    cleanup.runtime.surfaces.production_smoke_control(
        &cleanup.app,
        &cleanup.runtime.sessions,
        &cleanup.runtime.cef_host,
        lease,
        handoff_revision,
        BrowserSurfaceControlActionArg::Handoff,
    )?;
    cleanup.lease = Some(lease.clone());
    Ok(())
}

fn release(
    cleanup: &mut ProductionCleanup,
    lease: &mut ProductionSmokeLease,
    revision: u64,
) -> Result<(), String> {
    cleanup.runtime.surfaces.production_smoke_release(
        &cleanup.app,
        &cleanup.runtime.sessions,
        &cleanup.runtime.cef_host,
        lease,
        revision,
    )?;
    cleanup.lease = None;
    Ok(())
}

fn create_private_workspace(path: &Path) -> Result<(), String> {
    fs::create_dir(path)
        .map_err(|error| format!("create isolated macOS Mode 2 workspace: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("protect isolated macOS Mode 2 workspace: {error}"))?;
    }
    Ok(())
}

fn verify_cleanup(
    runtime: &ProductionRuntime,
    owner_record_root: &Path,
    profile_state_root: &Path,
    profiles: [(&Path, &str); 2],
) -> Result<MacosProductionCleanupProof, String> {
    runtime.surfaces.production_smoke_assert_inactive()?;
    let active_session_count = runtime
        .sessions
        .list_snapshots()
        .map_err(|error| error.to_string())?
        .len();
    if active_session_count != 0 {
        return Err("macOS Mode 2 smoke retained a production session".into());
    }
    let owner_record_count = fs::read_dir(owner_record_root)
        .map_err(|error| format!("read macOS Mode 2 owner records: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("inspect macOS Mode 2 owner records: {error}"))?
        .len();
    if owner_record_count != 0 {
        return Err("macOS Mode 2 smoke retained an embedded owner record".into());
    }
    for (workspace_root, profile_id) in profiles {
        let workspace = TrustedWorkspacePath::from_trusted_app(workspace_root.to_path_buf())
            .map_err(|error| error.to_string())?;
        let summaries = runtime
            .sessions
            .profile_summaries(workspace)
            .map_err(|error| error.to_string())?;
        if summaries.len() != 1 || summaries[0].profile_id != profile_id {
            return Err("macOS Mode 2 workspace profile inventory is inconsistent".into());
        }
        require_profile_lock_available(
            &profile_state_root
                .join("profiles")
                .join(profile_id)
                .join("profile.lock"),
        )?;
    }
    Ok(MacosProductionCleanupProof {
        active_surface_count: 0,
        active_session_count: 0,
        owner_record_count: 0,
        persisted_profile_count: 2,
        workspace_count: 2,
        profile_locks_available: true,
    })
}

fn require_profile_lock_available(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("inspect macOS Mode 2 profile lock: {error}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("macOS Mode 2 profile lock is not a regular file".into());
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|error| format!("open macOS Mode 2 profile lock: {error}"))?;
    file.try_lock_exclusive()
        .map_err(|error| format!("macOS Mode 2 profile lock remained held: {error}"))?;
    FileExt::unlock(&file)
        .map_err(|error| format!("release macOS Mode 2 profile lock probe: {error}"))
}

struct LocalSemanticServer {
    address: SocketAddr,
    url: String,
    effect_entries: Arc<AtomicUsize>,
    stopped: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl LocalSemanticServer {
    fn start(nonce: &str) -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|error| format!("bind macOS Mode 2 smoke origin: {error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("configure macOS Mode 2 smoke origin: {error}"))?;
        let address = listener
            .local_addr()
            .map_err(|error| format!("resolve macOS Mode 2 smoke origin: {error}"))?;
        let effect_path = format!("/effect-entered/{}", &nonce[..16]);
        let stopped = Arc::new(AtomicBool::new(false));
        let effect_entries = Arc::new(AtomicUsize::new(0));
        let worker_stopped = Arc::clone(&stopped);
        let worker_entries = Arc::clone(&effect_entries);
        let worker_effect_path = effect_path.clone();
        let body = semantic_body(&effect_path);
        let worker = thread::Builder::new()
            .name("ccem-macos-mode2-smoke-origin".into())
            .spawn(move || {
                serve_origin(
                    listener,
                    worker_stopped,
                    worker_entries,
                    worker_effect_path,
                    body,
                )
            })
            .map_err(|error| format!("start macOS Mode 2 smoke origin: {error}"))?;
        Ok(Self {
            address,
            url: format!(
                "http://{address}/mode2-production-smoke?run={}",
                &nonce[..16]
            ),
            effect_entries,
            stopped,
            worker: Some(worker),
        })
    }

    fn url(&self) -> &str {
        &self.url
    }

    fn wait_for_effect_entry(&self, timeout: Duration) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            match self.effect_entries.load(Ordering::Acquire) {
                0 => thread::sleep(Duration::from_millis(1)),
                1 => return Ok(()),
                _ => return Err("macOS Mode 2 active effect entered more than once".into()),
            }
        }
        Err("macOS Mode 2 active effect never reached the page barrier".into())
    }
}

impl Drop for LocalSemanticServer {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect_timeout(&self.address, Duration::from_millis(100));
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn serve_origin(
    listener: TcpListener,
    stopped: Arc<AtomicBool>,
    effect_entries: Arc<AtomicUsize>,
    effect_path: String,
    body: String,
) {
    while !stopped.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => respond(stream, &effect_entries, &effect_path, &body),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(_) => return,
        }
    }
}

fn respond(mut stream: TcpStream, effect_entries: &AtomicUsize, effect_path: &str, body: &str) {
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
        thread::sleep(Duration::from_millis(100));
        let _ = stream.write_all(
            b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",
        );
    } else {
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes());
    }
    let _ = stream.flush();
}

fn semantic_body(effect_path: &str) -> String {
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
