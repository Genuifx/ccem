use super::login::session::{
    LoginBrowserProfileSummary, LoginBrowserRecentActivity, LoginBrowserSessionHandle,
    LoginBrowserSessionManager, LoginBrowserSessionSnapshot, OpenedLoginBrowserSession,
    TrustedUiControlAction, TrustedUiControlAuthorization, TrustedWorkspacePath,
};
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub(crate) const LOGIN_BROWSER_CONTROL_LABEL: &str = "login-browser-control";
pub(crate) const LOGIN_BROWSER_CONTROL_EVENT: &str = "browser-login-control-changed";
const CONTROL_WIDTH: f64 = 380.0;
const CONTROL_HEIGHT: f64 = 458.0;
const CONTROL_AUTHORIZATION_TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LoginBrowserProfileMode {
    Default,
    New,
}

#[derive(Default)]
pub(crate) struct LoginBrowserController {
    session: Mutex<Option<LoginBrowserSessionHandle>>,
}

impl LoginBrowserController {
    fn bind(&self, handle: LoginBrowserSessionHandle) -> Result<(), String> {
        let mut session = self
            .session
            .lock()
            .map_err(|_| "Login Browser control binding is unavailable.".to_string())?;
        if session.is_some() {
            return Err("A Login Browser control window is already active.".to_string());
        }
        *session = Some(handle);
        Ok(())
    }

    fn handle_for(&self, window: &WebviewWindow) -> Result<LoginBrowserSessionHandle, String> {
        if window.label() != LOGIN_BROWSER_CONTROL_LABEL {
            return Err(
                "Login Browser control authority is restricted to its trusted window.".into(),
            );
        }
        self.session
            .lock()
            .map_err(|_| "Login Browser control binding is unavailable.".to_string())?
            .clone()
            .ok_or_else(|| "No Login Browser session is bound to this control window.".to_string())
    }

    fn clear_if_matches(&self, handle: &LoginBrowserSessionHandle) {
        let mut session = self
            .session
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if session.as_ref() == Some(handle) {
            *session = None;
        }
    }
}

#[tauri::command]
pub(crate) fn browser_login_open(
    app: tauri::AppHandle,
    window: WebviewWindow,
    working_dir: String,
    profile_mode: Option<LoginBrowserProfileMode>,
    sessions: tauri::State<'_, Arc<LoginBrowserSessionManager>>,
    controller: tauri::State<'_, Arc<LoginBrowserController>>,
) -> Result<LoginBrowserSessionSnapshot, String> {
    ensure_trusted_main_window(&window)?;
    if app
        .get_webview_window(LOGIN_BROWSER_CONTROL_LABEL)
        .is_some()
    {
        return Err("A Login Browser control window is already active.".to_string());
    }
    let workspace = TrustedWorkspacePath::from_trusted_app(PathBuf::from(working_dir))
        .map_err(|error| error.to_string())?;
    let opened = match profile_mode.unwrap_or(LoginBrowserProfileMode::Default) {
        LoginBrowserProfileMode::Default => sessions.open_default_profile(workspace),
        LoginBrowserProfileMode::New => sessions.open_new_profile(workspace),
    }
    .map_err(|error| error.to_string())?;
    present_opened_session(&app, sessions.inner(), controller.inner(), opened)
}

#[tauri::command]
pub(crate) fn browser_login_open_profile(
    app: tauri::AppHandle,
    window: WebviewWindow,
    working_dir: String,
    profile_id: String,
    sessions: tauri::State<'_, Arc<LoginBrowserSessionManager>>,
    controller: tauri::State<'_, Arc<LoginBrowserController>>,
) -> Result<LoginBrowserSessionSnapshot, String> {
    ensure_trusted_main_window(&window)?;
    if app
        .get_webview_window(LOGIN_BROWSER_CONTROL_LABEL)
        .is_some()
    {
        return Err("A Login Browser control window is already active.".to_string());
    }
    let opened = sessions
        .open_existing_profile(trusted_workspace(working_dir)?, &profile_id)
        .map_err(|error| error.to_string())?;
    present_opened_session(&app, sessions.inner(), controller.inner(), opened)
}

fn present_opened_session(
    app: &tauri::AppHandle,
    sessions: &Arc<LoginBrowserSessionManager>,
    controller: &Arc<LoginBrowserController>,
    opened: OpenedLoginBrowserSession,
) -> Result<LoginBrowserSessionSnapshot, String> {
    if let Err(error) = controller.bind(opened.handle.clone()) {
        let _ = sessions.force_stop(&opened.handle);
        return Err(error);
    }
    match build_control_window(app, &opened) {
        Ok(control_window) => {
            emit_snapshot(&control_window, &opened.snapshot);
            Ok(opened.snapshot)
        }
        Err(error) => {
            controller.clear_if_matches(&opened.handle);
            let _ = sessions.force_stop(&opened.handle);
            Err(error)
        }
    }
}

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

#[tauri::command]
pub(crate) fn browser_login_control_snapshot(
    window: WebviewWindow,
    sessions: tauri::State<'_, Arc<LoginBrowserSessionManager>>,
    controller: tauri::State<'_, Arc<LoginBrowserController>>,
) -> Result<Option<LoginBrowserSessionSnapshot>, String> {
    let handle = match controller.handle_for(&window) {
        Ok(handle) => handle,
        Err(_error) if window.label() == LOGIN_BROWSER_CONTROL_LABEL => return Ok(None),
        Err(error) => return Err(error),
    };
    match sessions.snapshot(&handle) {
        Ok(snapshot) => Ok(Some(snapshot)),
        Err(super::login::session::SessionManagerError::SessionNotFound) => {
            controller.clear_if_matches(&handle);
            Ok(None)
        }
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub(crate) fn browser_login_recent_activity(
    window: WebviewWindow,
    sessions: tauri::State<'_, Arc<LoginBrowserSessionManager>>,
    controller: tauri::State<'_, Arc<LoginBrowserController>>,
) -> Result<LoginBrowserRecentActivity, String> {
    let handle = controller.handle_for(&window)?;
    sessions
        .recent_activity(&handle)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn browser_login_handoff(
    window: WebviewWindow,
    sessions: tauri::State<'_, Arc<LoginBrowserSessionManager>>,
    controller: tauri::State<'_, Arc<LoginBrowserController>>,
) -> Result<LoginBrowserSessionSnapshot, String> {
    let handle = controller.handle_for(&window)?;
    let authorization = TrustedUiControlAuthorization::from_trusted_ui(
        &handle,
        TrustedUiControlAction::HandoffToAgent,
        CONTROL_AUTHORIZATION_TTL,
    )
    .map_err(|error| error.to_string())?;
    sessions
        .handoff_to_agent(authorization)
        .map_err(|error| error.to_string())?;
    let snapshot = sessions
        .snapshot(&handle)
        .map_err(|error| error.to_string())?;
    emit_snapshot(&window, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub(crate) fn browser_login_pause(
    window: WebviewWindow,
    sessions: tauri::State<'_, Arc<LoginBrowserSessionManager>>,
    controller: tauri::State<'_, Arc<LoginBrowserController>>,
) -> Result<LoginBrowserSessionSnapshot, String> {
    transition_control(
        &window,
        sessions.inner(),
        controller.inner(),
        TrustedUiControlAction::PauseAgent,
    )
}

#[tauri::command]
pub(crate) fn browser_login_takeover(
    window: WebviewWindow,
    sessions: tauri::State<'_, Arc<LoginBrowserSessionManager>>,
    controller: tauri::State<'_, Arc<LoginBrowserController>>,
) -> Result<LoginBrowserSessionSnapshot, String> {
    transition_control(
        &window,
        sessions.inner(),
        controller.inner(),
        TrustedUiControlAction::TakeoverByUser,
    )
}

#[tauri::command]
pub(crate) fn browser_login_close(
    window: WebviewWindow,
    sessions: tauri::State<'_, Arc<LoginBrowserSessionManager>>,
    controller: tauri::State<'_, Arc<LoginBrowserController>>,
) -> Result<(), String> {
    close_bound_session(&window, sessions.inner(), controller.inner(), false)
}

#[tauri::command]
pub(crate) fn browser_login_force_stop(
    window: WebviewWindow,
    sessions: tauri::State<'_, Arc<LoginBrowserSessionManager>>,
    controller: tauri::State<'_, Arc<LoginBrowserController>>,
) -> Result<(), String> {
    close_bound_session(&window, sessions.inner(), controller.inner(), true)
}

fn transition_control(
    window: &WebviewWindow,
    sessions: &Arc<LoginBrowserSessionManager>,
    controller: &Arc<LoginBrowserController>,
    action: TrustedUiControlAction,
) -> Result<LoginBrowserSessionSnapshot, String> {
    let handle = controller.handle_for(window)?;
    let authorization =
        TrustedUiControlAuthorization::from_trusted_ui(&handle, action, CONTROL_AUTHORIZATION_TTL)
            .map_err(|error| error.to_string())?;
    let snapshot = match action {
        TrustedUiControlAction::PauseAgent => sessions.pause_agent(authorization),
        TrustedUiControlAction::TakeoverByUser => sessions.takeover_by_user(authorization),
        TrustedUiControlAction::HandoffToAgent => unreachable!("handoff uses dedicated command"),
    }
    .map_err(|error| error.to_string())?;
    emit_snapshot(window, &snapshot);
    Ok(snapshot)
}

fn close_bound_session(
    window: &WebviewWindow,
    sessions: &Arc<LoginBrowserSessionManager>,
    controller: &Arc<LoginBrowserController>,
    force: bool,
) -> Result<(), String> {
    let handle = controller.handle_for(window)?;
    let result = if force {
        sessions.force_stop(&handle)
    } else {
        sessions.close(&handle)
    };
    match result {
        Ok(()) => {
            controller.clear_if_matches(&handle);
            let _ = window.emit(
                LOGIN_BROWSER_CONTROL_EVENT,
                Option::<LoginBrowserSessionSnapshot>::None,
            );
            window
                .destroy()
                .map_err(|error| format!("destroy Login Browser control window: {error}"))
        }
        Err(error) => {
            if let Ok(snapshot) = sessions.snapshot(&handle) {
                emit_snapshot(window, &snapshot);
            }
            Err(error.to_string())
        }
    }
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

fn build_control_window(
    app: &tauri::AppHandle,
    opened: &OpenedLoginBrowserSession,
) -> Result<WebviewWindow, String> {
    let window = WebviewWindowBuilder::new(
        app,
        LOGIN_BROWSER_CONTROL_LABEL,
        WebviewUrl::App("index.html?window=login-browser-control".into()),
    )
    .title("CCEM Login Browser Control")
    .decorations(false)
    .resizable(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .inner_size(CONTROL_WIDTH, CONTROL_HEIGHT)
    .visible(false)
    .build()
    .map_err(|error| format!("build Login Browser control window: {error}"))?;
    window
        .set_always_on_top(true)
        .map_err(|error| format!("set Login Browser control always on top: {error}"))?;
    window
        .set_visible_on_all_workspaces(true)
        .map_err(|error| format!("show Login Browser control on all workspaces: {error}"))?;
    if let Some(monitor) = window
        .primary_monitor()
        .map_err(|error| format!("read Login Browser control monitor: {error}"))?
    {
        let size = monitor.size();
        let scale = monitor.scale_factor();
        let width = (CONTROL_WIDTH * scale) as i32;
        let x = monitor.position().x + size.width as i32 - width - (20.0 * scale) as i32;
        let y = monitor.position().y + (54.0 * scale) as i32;
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
    let session_id = opened.snapshot.session_id.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            eprintln!(
                "Ignoring native close for active Login Browser control session {session_id}; use the explicit browser close action."
            );
            api.prevent_close();
        }
    });
    window
        .show()
        .map_err(|error| format!("show Login Browser control window: {error}"))?;
    let _ = window.set_focus();
    Ok(window)
}

fn emit_snapshot(window: &WebviewWindow, snapshot: &LoginBrowserSessionSnapshot) {
    let _ = window.emit(LOGIN_BROWSER_CONTROL_EVENT, snapshot);
}
