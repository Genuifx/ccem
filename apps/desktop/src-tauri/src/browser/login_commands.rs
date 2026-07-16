use super::login::session::{
    LoginBrowserProfileSummary, LoginBrowserRecentActivity, LoginBrowserSessionManager,
    TrustedWorkspacePath,
};
use std::{path::PathBuf, sync::Arc};
use tauri::WebviewWindow;

#[tauri::command]
pub(crate) fn browser_login_profiles(
    window: WebviewWindow,
    working_dir: String,
    sessions: tauri::State<'_, Arc<LoginBrowserSessionManager>>,
) -> Result<Vec<LoginBrowserProfileSummary>, String> {
    ensure_trusted_main_window(&window)?;
    sessions
        .profile_summaries(trusted_workspace(working_dir)?)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn browser_login_profile_recent_activity(
    window: WebviewWindow,
    working_dir: String,
    profile_id: String,
    sessions: tauri::State<'_, Arc<LoginBrowserSessionManager>>,
) -> Result<LoginBrowserRecentActivity, String> {
    ensure_trusted_main_window(&window)?;
    sessions
        .recent_activity_for_profile(trusted_workspace(working_dir)?, &profile_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn browser_login_reset_profile(
    window: WebviewWindow,
    working_dir: String,
    profile_id: String,
    confirmed: bool,
    sessions: tauri::State<'_, Arc<LoginBrowserSessionManager>>,
) -> Result<LoginBrowserProfileSummary, String> {
    ensure_trusted_main_window(&window)?;
    sessions
        .reset_profile(trusted_workspace(working_dir)?, &profile_id, confirmed)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn browser_login_delete_profile(
    window: WebviewWindow,
    working_dir: String,
    profile_id: String,
    confirmed: bool,
    sessions: tauri::State<'_, Arc<LoginBrowserSessionManager>>,
) -> Result<(), String> {
    ensure_trusted_main_window(&window)?;
    sessions
        .delete_profile(trusted_workspace(working_dir)?, &profile_id, confirmed)
        .map_err(|error| error.to_string())
}

fn ensure_trusted_main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err(
            "Login Browser profile access is restricted to the trusted main window.".into(),
        );
    }
    Ok(())
}

fn trusted_workspace(working_dir: String) -> Result<TrustedWorkspacePath, String> {
    TrustedWorkspacePath::from_trusted_app(PathBuf::from(working_dir))
        .map_err(|error| error.to_string())
}
