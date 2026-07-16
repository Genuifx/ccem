use super::*;

fn ensure_trusted_main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Browser surface access is restricted to the trusted main window.".to_string());
    }
    Ok(())
}

#[cfg(any(target_os = "macos", windows))]
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(crate) async fn browser_surface_acquire(
    app: AppHandle,
    window: WebviewWindow,
    panel_session_id: String,
    backend: BrowserSurfaceBackendArg,
    working_dir: Option<String>,
    profile_mode: Option<BrowserSurfaceProfileModeArg>,
    profile_id: Option<String>,
    initial_url: Option<String>,
    viewport: BrowserSurfaceViewportArg,
    client_revision: u64,
    manager: tauri::State<'_, Arc<LoginBrowserSurfaceManager>>,
    sessions: tauri::State<'_, Arc<LoginBrowserSessionManager>>,
    cef_host: tauri::State<'_, Arc<CefHostController>>,
    preview: tauri::State<'_, Arc<BrowserManager>>,
) -> Result<BrowserSurfaceLeaseResponse, String> {
    ensure_trusted_main_window(&window)?;
    let manager = Arc::clone(manager.inner());
    let sessions = Arc::clone(sessions.inner());
    let cef_host = Arc::clone(cef_host.inner());
    let preview = Arc::clone(preview.inner());
    tauri::async_runtime::spawn_blocking(move || {
        manager.acquire_login(
            &app,
            &sessions,
            &cef_host,
            &preview,
            panel_session_id,
            backend,
            working_dir,
            profile_mode,
            profile_id,
            initial_url,
            viewport,
            client_revision,
        )
    })
    .await
    .map_err(|error| format!("join browser surface acquire: {error}"))?
}

#[cfg(not(any(target_os = "macos", windows)))]
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(crate) async fn browser_surface_acquire(
    window: WebviewWindow,
    _panel_session_id: String,
    _backend: BrowserSurfaceBackendArg,
    _working_dir: Option<String>,
    _profile_mode: Option<BrowserSurfaceProfileModeArg>,
    _profile_id: Option<String>,
    _initial_url: Option<String>,
    _viewport: BrowserSurfaceViewportArg,
    _client_revision: u64,
) -> Result<BrowserSurfaceLeaseResponse, String> {
    ensure_trusted_main_window(&window)?;
    Err("Embedded Login Browser is not available on this platform.".to_string())
}

#[cfg(any(target_os = "macos", windows))]
#[tauri::command]
pub(crate) async fn browser_surface_sync(
    app: AppHandle,
    window: WebviewWindow,
    lease_id: String,
    generation: u64,
    client_revision: u64,
    viewport: Option<BrowserSurfaceViewportArg>,
    visible: Option<bool>,
    manager: tauri::State<'_, Arc<LoginBrowserSurfaceManager>>,
    cef_host: tauri::State<'_, Arc<CefHostController>>,
    preview: tauri::State<'_, Arc<BrowserManager>>,
) -> Result<(), String> {
    ensure_trusted_main_window(&window)?;
    let manager = Arc::clone(manager.inner());
    let cef_host = Arc::clone(cef_host.inner());
    let preview = Arc::clone(preview.inner());
    tauri::async_runtime::spawn_blocking(move || {
        manager.sync(
            &app,
            &cef_host,
            &preview,
            lease_id,
            generation,
            client_revision,
            viewport,
            visible,
        )
    })
    .await
    .map_err(|error| format!("join browser surface sync: {error}"))?
}

#[cfg(not(any(target_os = "macos", windows)))]
#[tauri::command]
pub(crate) async fn browser_surface_sync(window: WebviewWindow) -> Result<(), String> {
    ensure_trusted_main_window(&window)?;
    Err("Embedded Login Browser is not available on this platform.".to_string())
}

#[cfg(any(target_os = "macos", windows))]
#[tauri::command]
pub(crate) async fn browser_surface_release(
    app: AppHandle,
    window: WebviewWindow,
    lease_id: String,
    generation: u64,
    client_revision: u64,
    disposition: BrowserSurfaceReleaseArg,
    manager: tauri::State<'_, Arc<LoginBrowserSurfaceManager>>,
    sessions: tauri::State<'_, Arc<LoginBrowserSessionManager>>,
    cef_host: tauri::State<'_, Arc<CefHostController>>,
) -> Result<(), String> {
    ensure_trusted_main_window(&window)?;
    let manager = Arc::clone(manager.inner());
    let sessions = Arc::clone(sessions.inner());
    let cef_host = Arc::clone(cef_host.inner());
    tauri::async_runtime::spawn_blocking(move || {
        manager.release(
            &app,
            &sessions,
            &cef_host,
            lease_id,
            generation,
            client_revision,
            disposition,
        )
    })
    .await
    .map_err(|error| format!("join browser surface release: {error}"))?
}

#[cfg(not(any(target_os = "macos", windows)))]
#[tauri::command]
pub(crate) async fn browser_surface_release(window: WebviewWindow) -> Result<(), String> {
    ensure_trusted_main_window(&window)?;
    Err("Embedded Login Browser is not available on this platform.".to_string())
}

#[cfg(any(target_os = "macos", windows))]
#[tauri::command]
pub(crate) async fn browser_surface_navigate(
    app: AppHandle,
    window: WebviewWindow,
    lease_id: String,
    generation: u64,
    client_revision: u64,
    url: String,
    manager: tauri::State<'_, Arc<LoginBrowserSurfaceManager>>,
    cef_host: tauri::State<'_, Arc<CefHostController>>,
) -> Result<(), String> {
    ensure_trusted_main_window(&window)?;
    let parsed = crate::browser::url::parse_browser_url(&url)?;
    let manager = Arc::clone(manager.inner());
    let cef_host = Arc::clone(cef_host.inner());
    tauri::async_runtime::spawn_blocking(move || {
        manager.navigate(
            &app,
            &cef_host,
            lease_id,
            generation,
            client_revision,
            parsed.to_string(),
        )
    })
    .await
    .map_err(|error| format!("join browser surface navigate: {error}"))?
}

#[cfg(not(any(target_os = "macos", windows)))]
#[tauri::command]
pub(crate) async fn browser_surface_navigate(window: WebviewWindow) -> Result<(), String> {
    ensure_trusted_main_window(&window)?;
    Err("Embedded Login Browser is not available on this platform.".to_string())
}

#[cfg(any(target_os = "macos", windows))]
#[tauri::command]
pub(crate) async fn browser_surface_control(
    app: AppHandle,
    window: WebviewWindow,
    lease_id: String,
    generation: u64,
    client_revision: u64,
    action: BrowserSurfaceControlActionArg,
    manager: tauri::State<'_, Arc<LoginBrowserSurfaceManager>>,
    sessions: tauri::State<'_, Arc<LoginBrowserSessionManager>>,
    cef_host: tauri::State<'_, Arc<CefHostController>>,
) -> Result<BrowserSurfaceSnapshotMutationResponse, String> {
    ensure_trusted_main_window(&window)?;
    let manager = Arc::clone(manager.inner());
    let sessions = Arc::clone(sessions.inner());
    let cef_host = Arc::clone(cef_host.inner());
    tauri::async_runtime::spawn_blocking(move || {
        manager.transition_control(
            &app,
            &sessions,
            &cef_host,
            lease_id,
            generation,
            client_revision,
            action,
        )
    })
    .await
    .map_err(|error| format!("join browser surface control transition: {error}"))?
}

#[cfg(not(any(target_os = "macos", windows)))]
#[tauri::command]
pub(crate) async fn browser_surface_control(window: WebviewWindow) -> Result<(), String> {
    ensure_trusted_main_window(&window)?;
    Err("Embedded Login Browser is not available on this platform.".to_string())
}

#[cfg(any(target_os = "macos", windows))]
#[tauri::command]
pub(crate) async fn browser_surface_close_popup(
    app: AppHandle,
    window: WebviewWindow,
    lease_id: String,
    generation: u64,
    client_revision: u64,
    manager: tauri::State<'_, Arc<LoginBrowserSurfaceManager>>,
    sessions: tauri::State<'_, Arc<LoginBrowserSessionManager>>,
    cef_host: tauri::State<'_, Arc<CefHostController>>,
) -> Result<BrowserSurfaceSnapshotMutationResponse, String> {
    ensure_trusted_main_window(&window)?;
    let manager = Arc::clone(manager.inner());
    let sessions = Arc::clone(sessions.inner());
    let cef_host = Arc::clone(cef_host.inner());
    tauri::async_runtime::spawn_blocking(move || {
        manager.close_popup(
            &app,
            &sessions,
            &cef_host,
            lease_id,
            generation,
            client_revision,
        )
    })
    .await
    .map_err(|error| format!("join Login Browser popup close: {error}"))?
}

#[cfg(not(any(target_os = "macos", windows)))]
#[tauri::command]
pub(crate) async fn browser_surface_close_popup(window: WebviewWindow) -> Result<(), String> {
    ensure_trusted_main_window(&window)?;
    Err("Embedded Login Browser is not available on this platform.".to_string())
}
