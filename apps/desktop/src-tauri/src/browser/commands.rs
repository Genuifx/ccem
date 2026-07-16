use super::{
    normalize_browser_session_id, BrowserBounds, BrowserInfo, BrowserManager, BrowserRecentActivity,
};
use serde_json::Value;
use std::sync::Arc;
use tauri::AppHandle;

#[tauri::command]
pub async fn browser_set_active_session(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    session_id: Option<String>,
    visible: Option<bool>,
) -> Result<(), String> {
    run_blocking_browser_command(app, state.inner().clone(), move |state, app| {
        state.set_active_session(&app, session_id.as_deref(), visible.unwrap_or(false))
    })
    .await
}

#[tauri::command]
pub async fn browser_open(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    session_id: Option<String>,
    url: Option<String>,
    visible: Option<bool>,
) -> Result<BrowserInfo, String> {
    run_blocking_browser_command(app, state.inner().clone(), move |state, app| {
        state.open_with_visibility(
            &app,
            session_id.as_deref(),
            url.as_deref(),
            visible.unwrap_or(true),
        )
    })
    .await
}

#[tauri::command]
pub fn browser_set_bounds(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    session_id: Option<String>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    state.set_bounds(
        &app,
        session_id.as_deref(),
        BrowserBounds {
            x,
            y,
            width,
            height,
        },
    )
}

#[tauri::command]
pub async fn browser_set_visible(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    session_id: Option<String>,
    visible: bool,
) -> Result<(), String> {
    run_blocking_browser_command(app, state.inner().clone(), move |state, app| {
        state.set_visible(&app, session_id.as_deref(), visible)
    })
    .await
}

#[tauri::command]
pub fn browser_close(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    session_id: Option<String>,
) -> Result<(), String> {
    state.close(&app, session_id.as_deref())
}

#[tauri::command]
pub async fn browser_navigate(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    session_id: Option<String>,
    url: String,
) -> Result<BrowserInfo, String> {
    run_blocking_browser_command(app, state.inner().clone(), move |state, app| {
        state.navigate(&app, session_id.as_deref(), &url)
    })
    .await
}

#[tauri::command]
pub fn browser_reload(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    session_id: Option<String>,
) -> Result<BrowserInfo, String> {
    state.reload(&app, session_id.as_deref())
}

async fn run_blocking_browser_command<T, F>(
    app: AppHandle,
    state: Arc<BrowserManager>,
    command: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(Arc<BrowserManager>, AppHandle) -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || command(state, app))
        .await
        .map_err(|error| format!("join browser command: {error}"))?
}

#[tauri::command]
pub async fn browser_back(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    session_id: Option<String>,
) -> Result<BrowserInfo, String> {
    run_blocking_browser_command(app, state.inner().clone(), move |state, app| {
        state.back(&app, session_id.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn browser_forward(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    session_id: Option<String>,
) -> Result<BrowserInfo, String> {
    run_blocking_browser_command(app, state.inner().clone(), move |state, app| {
        state.forward(&app, session_id.as_deref())
    })
    .await
}

#[tauri::command]
pub fn browser_info(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    session_id: Option<String>,
) -> Result<BrowserInfo, String> {
    state.info(&app, session_id.as_deref())
}

#[tauri::command]
pub async fn browser_health_check(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    session_id: Option<String>,
) -> Result<BrowserInfo, String> {
    run_blocking_browser_command(app, state.inner().clone(), move |state, app| {
        state.health_check(&app, session_id.as_deref())
    })
    .await
}

#[tauri::command]
pub fn browser_set_paused(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    session_id: Option<String>,
    paused: bool,
) -> Result<BrowserInfo, String> {
    state.set_paused(&app, session_id.as_deref(), paused)
}

#[tauri::command]
pub fn browser_recent_activity(
    state: tauri::State<'_, Arc<BrowserManager>>,
    session_id: Option<String>,
) -> Result<BrowserRecentActivity, String> {
    state.recent_activity(&normalize_browser_session_id(session_id.as_deref()))
}

#[tauri::command]
pub async fn browser_snapshot(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    session_id: Option<String>,
) -> Result<Value, String> {
    run_blocking_browser_command(app, state.inner().clone(), move |state, app| {
        state.snapshot(&app, session_id.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn browser_screenshot(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    session_id: Option<String>,
) -> Result<String, String> {
    run_blocking_browser_command(app, state.inner().clone(), move |state, app| {
        state.screenshot_base64(&app, session_id.as_deref())
    })
    .await
}
