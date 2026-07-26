use super::runtime::maintenance::{RuntimeDeleteOutcome, RuntimeDiskUsage};
use super::runtime::manager::BrowserRuntimeManager;
use super::runtime::state::BrowserRuntimeReadiness;
use std::sync::Arc;
use tauri::AppHandle;

#[tauri::command]
pub(crate) fn browser_runtime_readiness(
    state: tauri::State<'_, Arc<BrowserRuntimeManager>>,
) -> Result<BrowserRuntimeReadiness, String> {
    state.readiness().map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn browser_runtime_prepare(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserRuntimeManager>>,
) -> Result<BrowserRuntimeReadiness, String> {
    state
        .inner()
        .prepare(Some(app))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn browser_runtime_pause_download(
    state: tauri::State<'_, Arc<BrowserRuntimeManager>>,
) -> Result<BrowserRuntimeReadiness, String> {
    state.pause_download().map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn browser_runtime_resume_download(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserRuntimeManager>>,
) -> Result<BrowserRuntimeReadiness, String> {
    state
        .inner()
        .resume_download(Some(app))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn browser_runtime_retry(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserRuntimeManager>>,
) -> Result<BrowserRuntimeReadiness, String> {
    state
        .inner()
        .retry(Some(app))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn browser_runtime_reinstall(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserRuntimeManager>>,
) -> Result<BrowserRuntimeReadiness, String> {
    state
        .inner()
        .reinstall(Some(app))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn browser_runtime_cancel(
    state: tauri::State<'_, Arc<BrowserRuntimeManager>>,
) -> Result<BrowserRuntimeReadiness, String> {
    state.cancel().map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn browser_runtime_disk_usage(
    state: tauri::State<'_, Arc<BrowserRuntimeManager>>,
) -> Result<RuntimeDiskUsage, String> {
    state.disk_usage().map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn browser_runtime_delete(
    app: AppHandle,
    confirmed: bool,
    state: tauri::State<'_, Arc<BrowserRuntimeManager>>,
) -> Result<RuntimeDeleteOutcome, String> {
    if !confirmed {
        return Err("Browser runtime deletion requires explicit user confirmation.".to_string());
    }
    state
        .inner()
        .delete_runtime(Some(app))
        .map_err(|error| error.to_string())
}
