mod artifacts;
#[cfg(all(unix, any(test, feature = "chromium-spike")))]
mod chromium_spike;
mod logs;
mod policy;
mod registry;
mod runtime_readiness;
mod tools;
mod url;
mod webview;

use artifacts::BrowserArtifactStore;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use logs::BrowserLogStore;
pub use logs::BrowserRecentActivity;
pub(crate) use policy::authorize_browser_tool;
pub use runtime_readiness::BrowserRuntimeReadiness;
use registry::{BrowserSessionRegistry, BrowserSessionState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
#[cfg(target_os = "macos")]
use url::is_allowed_browser_navigation;
use url::parse_browser_url;
use webview::{
    apply_browser_bounds, ensure_browser_webview, eval_webview_js, navigate_browser_history,
    probe_webview_health, require_browser_webview, snapshot_webview_png,
};

pub const BROWSER_LABEL: &str = "ccem-browser";

const DEFAULT_BROWSER_SESSION_ID: &str = "workspace";
const DEFAULT_BROWSER_URL: &str = "https://www.google.com/search?q=ccem";
const SAFARI_DESKTOP_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct BrowserBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Default for BrowserBounds {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct BrowserInfo {
    pub label: String,
    pub session_id: String,
    pub url: Option<String>,
    pub title: Option<String>,
    pub visible: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub lifecycle: BrowserLifecycleState,
    pub loading: bool,
    pub error: Option<String>,
    pub control: BrowserControlState,
    pub paused: bool,
    pub generation: u64,
    pub last_agent_action: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BrowserLifecycleState {
    Creating,
    Ready,
    Navigating,
    Interactive,
    Crashed,
    Destroyed,
}

impl BrowserLifecycleState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Creating => "creating",
            Self::Ready => "ready",
            Self::Navigating => "navigating",
            Self::Interactive => "interactive",
            Self::Crashed => "crashed",
            Self::Destroyed => "destroyed",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BrowserControlState {
    User,
    Agent,
    Paused,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BrowserToolRequest {
    pub request_id: String,
    pub tool: String,
    #[serde(default)]
    pub args: Value,
}

#[derive(Debug, Clone, Copy)]
enum BrowserHistoryDirection {
    Back,
    Forward,
}

#[derive(Debug, Clone, Copy, Default)]
struct BrowserHistoryState {
    can_go_back: bool,
    can_go_forward: bool,
}

#[derive(Debug, Clone, Default)]
struct BrowserPageMetadata {
    url: Option<String>,
    title: Option<String>,
    history: BrowserHistoryState,
}

pub struct BrowserManager {
    registry: Arc<BrowserSessionRegistry>,
    artifacts: Arc<BrowserArtifactStore>,
    logs: Arc<BrowserLogStore>,
}

impl Default for BrowserManager {
    fn default() -> Self {
        Self {
            registry: Arc::new(BrowserSessionRegistry::new(DEFAULT_BROWSER_SESSION_ID)),
            artifacts: Arc::new(BrowserArtifactStore::default()),
            logs: Arc::new(BrowserLogStore::default()),
        }
    }
}

impl BrowserManager {
    pub fn set_active_session(
        &self,
        app: &AppHandle,
        session_id: Option<&str>,
        visible: bool,
    ) -> Result<(), String> {
        let session_id = normalize_browser_session_id(session_id);
        self.session_snapshot(&session_id)?;
        self.registry.set_active_session(&session_id)?;
        let state = self.registry.set_visible(&session_id, visible)?;
        self.sync_webview_visibility(app)?;
        emit_browser_state(app, &state, "active_session");
        Ok(())
    }

    pub fn open(
        &self,
        app: &AppHandle,
        session_id: Option<&str>,
        url: Option<&str>,
    ) -> Result<BrowserInfo, String> {
        let session_id = normalize_browser_session_id(session_id);
        let requested = url.map(str::trim).filter(|value| !value.is_empty());
        let parsed_requested = requested.map(parse_browser_url).transpose()?;
        let target = parsed_requested
            .as_ref()
            .map(|value| value.as_str())
            .unwrap_or(DEFAULT_BROWSER_URL);
        let target_url = target.to_string();
        let mut session = self.session_snapshot(&session_id)?;
        let mut existed = app.get_webview(&session.label).is_some();
        if session.lifecycle == BrowserLifecycleState::Crashed {
            if let Some(webview) = app.get_webview(&session.label) {
                let _ = webview.close();
            }
            if let Some(destroyed) = self.registry.remove(&session_id)? {
                emit_browser_state(app, &destroyed, "crashed_session_replaced");
            }
            session = self.session_snapshot(&session_id)?;
            existed = false;
        }
        if !existed || parsed_requested.is_some() {
            let (state, _) = self.registry.mark_navigation(&session_id, target_url)?;
            emit_browser_state(app, &state, "navigation_requested");
        }
        let webview = ensure_browser_webview(
            app,
            Arc::clone(&self.registry),
            &session.session_id,
            &session.label,
            session.generation,
            target,
        )
        .map_err(|error| self.record_browser_error(app, &session_id, error))?;
        if existed {
            if let Some(parsed) = parsed_requested {
                webview.navigate(parsed).map_err(|error| {
                    self.record_browser_error(
                        app,
                        &session_id,
                        format!("navigate browser webview: {error}"),
                    )
                })?;
            }
        }
        apply_browser_bounds(&webview, session.bounds)?;
        let state = self.registry.set_visible(&session_id, true)?;
        self.sync_webview_visibility(app)?;
        emit_browser_opened(
            app,
            &session_id,
            &session.label,
            if session.control == BrowserControlState::Agent {
                "agent_reveal"
            } else {
                "ui_open"
            },
        );
        emit_browser_state(app, &state, "opened");
        self.info(app, Some(&session_id))
    }

    pub fn set_bounds(
        &self,
        app: &AppHandle,
        session_id: Option<&str>,
        bounds: BrowserBounds,
    ) -> Result<(), String> {
        let session_id = normalize_browser_session_id(session_id);
        let sanitized = sanitize_bounds(bounds);
        self.session_snapshot(&session_id)?;
        let session = self.registry.set_bounds(&session_id, sanitized)?;
        if let Some(webview) = app.get_webview(&session.label) {
            apply_browser_bounds(&webview, sanitized)?;
        }
        Ok(())
    }

    pub fn set_visible(
        &self,
        app: &AppHandle,
        session_id: Option<&str>,
        visible: bool,
    ) -> Result<(), String> {
        let session_id = normalize_browser_session_id(session_id);
        self.session_snapshot(&session_id)?;
        let state = self.registry.set_visible(&session_id, visible)?;
        self.sync_webview_visibility(app)?;
        emit_browser_state(app, &state, if visible { "shown" } else { "hidden" });
        Ok(())
    }

    pub fn close(&self, app: &AppHandle, session_id: Option<&str>) -> Result<(), String> {
        let session_id = normalize_browser_session_id(session_id);
        let Some(session) = self.registry.snapshot(&session_id)? else {
            return Ok(());
        };
        if let Some(workspace_dir) = session.workspace_dir.as_deref() {
            let _ = self.drain_console_log(app, &session_id, workspace_dir);
        }
        let close_result = if let Some(webview) = app.get_webview(&session.label) {
            webview
                .close()
                .map_err(|error| format!("close browser webview: {error}"))
        } else {
            Ok(())
        };
        if let Some(destroyed) = self.registry.remove(&session_id)? {
            emit_browser_state(app, &destroyed, "destroyed");
        }
        close_result
    }

    pub fn navigate(
        &self,
        app: &AppHandle,
        session_id: Option<&str>,
        url: &str,
    ) -> Result<BrowserInfo, String> {
        let session_id = normalize_browser_session_id(session_id);
        let parsed = parse_browser_url(url)?;
        let next_url = parsed.as_str().to_string();
        let session = self.session_snapshot(&session_id)?;
        let (state, _) = self.registry.mark_navigation(&session_id, next_url)?;
        emit_browser_state(app, &state, "navigation_requested");
        let webview = match app.get_webview(&session.label) {
            Some(webview) => Ok(webview),
            None => ensure_browser_webview(
                app,
                Arc::clone(&self.registry),
                &session.session_id,
                &session.label,
                session.generation,
                parsed.as_str(),
            ),
        }
        .map_err(|error| self.record_browser_error(app, &session_id, error))?;
        webview.navigate(parsed).map_err(|error| {
            self.record_browser_error(
                app,
                &session_id,
                format!("navigate browser webview: {error}"),
            )
        })?;
        apply_browser_bounds(&webview, session.bounds)?;
        let state = self.registry.set_visible(&session_id, true)?;
        self.sync_webview_visibility(app)?;
        emit_browser_opened(
            app,
            &session_id,
            &session.label,
            if session.control == BrowserControlState::Agent {
                "agent_reveal"
            } else {
                "navigation"
            },
        );
        emit_browser_state(app, &state, "shown");
        self.info(app, Some(&session_id))
    }

    pub fn reload(&self, app: &AppHandle, session_id: Option<&str>) -> Result<BrowserInfo, String> {
        let session_id = normalize_browser_session_id(session_id);
        let session = self.session_snapshot(&session_id)?;
        let webview = require_browser_webview(app, &session.label)?;
        let current_url = session
            .current_url
            .clone()
            .unwrap_or_else(|| DEFAULT_BROWSER_URL.into());
        let (state, _) = self.registry.mark_navigation(&session_id, current_url)?;
        emit_browser_state(app, &state, "reload_requested");
        webview.reload().map_err(|error| {
            self.record_browser_error(app, &session_id, format!("reload browser webview: {error}"))
        })?;
        self.info(app, Some(&session.session_id))
    }

    pub fn back(&self, app: &AppHandle, session_id: Option<&str>) -> Result<BrowserInfo, String> {
        self.navigate_history(app, session_id, BrowserHistoryDirection::Back)
    }

    pub fn forward(
        &self,
        app: &AppHandle,
        session_id: Option<&str>,
    ) -> Result<BrowserInfo, String> {
        self.navigate_history(app, session_id, BrowserHistoryDirection::Forward)
    }

    fn navigate_history(
        &self,
        app: &AppHandle,
        session_id: Option<&str>,
        direction: BrowserHistoryDirection,
    ) -> Result<BrowserInfo, String> {
        let session_id = normalize_browser_session_id(session_id);
        let session = self.session_snapshot(&session_id)?;
        let webview = require_browser_webview(app, &session.label)?;
        let before_url = session.current_url.clone();
        let did_start = navigate_browser_history(&webview, direction)?;
        if !did_start {
            return self.info(app, Some(&session.session_id));
        }
        self.wait_for_history_navigation(app, &session.session_id, before_url, direction)
    }

    pub fn eval_js(
        &self,
        app: &AppHandle,
        session_id: Option<&str>,
        js: &str,
    ) -> Result<String, String> {
        let session_id = normalize_browser_session_id(session_id);
        let session = self.session_snapshot(&session_id)?;
        let webview = require_browser_webview(app, &session.label)?;
        let result = eval_webview_js(&webview, js);
        if result.is_err() {
            self.record_crash_if_unhealthy(app, &session, &webview);
        }
        result
    }

    pub fn screenshot_base64(
        &self,
        app: &AppHandle,
        session_id: Option<&str>,
    ) -> Result<String, String> {
        self.screenshot_png(app, session_id)
            .map(|bytes| STANDARD.encode(bytes))
    }

    pub(super) fn screenshot_png(
        &self,
        app: &AppHandle,
        session_id: Option<&str>,
    ) -> Result<Vec<u8>, String> {
        let session_id = normalize_browser_session_id(session_id);
        let session = self.session_snapshot(&session_id)?;
        let webview = require_browser_webview(app, &session.label)?;
        let result = snapshot_webview_png(&webview);
        if result.is_err() {
            self.record_crash_if_unhealthy(app, &session, &webview);
        }
        result
    }

    pub fn info(&self, app: &AppHandle, session_id: Option<&str>) -> Result<BrowserInfo, String> {
        let session_id = normalize_browser_session_id(session_id);
        let session = self.session_snapshot(&session_id)?;
        let webview_exists = app.get_webview(&session.label).is_some();
        self.info_from_state(session, webview_exists)
    }

    pub fn health_check(
        &self,
        app: &AppHandle,
        session_id: Option<&str>,
    ) -> Result<BrowserInfo, String> {
        let session_id = normalize_browser_session_id(session_id);
        let session = self
            .registry
            .snapshot(&session_id)?
            .ok_or_else(|| format!("Browser session {session_id} is not registered"))?;
        let Some(webview) = app.get_webview(&session.label) else {
            if let Some(crashed) = self
                .registry
                .mark_crashed(&session_id, "Preview browser renderer is unavailable.")?
            {
                emit_browser_state(app, &crashed, "health_check_failed");
                return self.info_from_state(crashed, false);
            }
            return Err("Preview browser renderer is unavailable.".to_string());
        };
        if let Err(error) = probe_webview_health(&webview) {
            let _ = webview.hide();
            if let Some(crashed) = self.registry.mark_crashed(&session_id, error)? {
                emit_browser_state(app, &crashed, "health_check_failed");
                return self.info_from_state(crashed, true);
            }
        }
        if let Some(workspace_dir) = session.workspace_dir.as_deref() {
            let _ = self.drain_console_log(app, &session_id, workspace_dir);
        }
        self.info(app, Some(&session_id))
    }

    pub fn set_paused(
        &self,
        app: &AppHandle,
        session_id: Option<&str>,
        paused: bool,
    ) -> Result<BrowserInfo, String> {
        let session_id = normalize_browser_session_id(session_id);
        self.session_snapshot(&session_id)?;
        let state = self.registry.set_paused(&session_id, paused)?;
        emit_browser_state(
            app,
            &state,
            if paused {
                "agent_control_paused"
            } else {
                "agent_control_resumed"
            },
        );
        let webview_exists = app.get_webview(&state.label).is_some();
        self.info_from_state(state, webview_exists)
    }

    pub fn policy_changed(&self, app: &AppHandle, session_id: &str) -> Result<(), String> {
        let Some(_) = self.registry.snapshot(session_id)? else {
            return Ok(());
        };
        let state = self.registry.bump_policy_epoch(session_id)?;
        emit_browser_state(app, &state, "permission_mode_changed");
        Ok(())
    }

    fn wait_for_history_navigation(
        &self,
        app: &AppHandle,
        session_id: &str,
        before_url: Option<String>,
        direction: BrowserHistoryDirection,
    ) -> Result<BrowserInfo, String> {
        let deadline = Instant::now() + Duration::from_millis(2_000);
        let mut changed_info: Option<BrowserInfo> = None;
        loop {
            let info = self.info(app, Some(session_id))?;
            if info.url != before_url {
                let history_settled = match direction {
                    BrowserHistoryDirection::Back => info.can_go_forward,
                    BrowserHistoryDirection::Forward => info.can_go_back,
                };
                if history_settled {
                    return Ok(info);
                }
                changed_info = Some(info.clone());
            }
            if Instant::now() >= deadline {
                return Ok(changed_info.unwrap_or(info));
            }
            std::thread::sleep(Duration::from_millis(80));
        }
    }

    fn session_snapshot(&self, session_id: &str) -> Result<BrowserSessionState, String> {
        self.registry.snapshot_or_create(session_id, |generation| {
            browser_label_for_session_id(session_id, generation)
        })
    }

    fn record_crash_if_unhealthy(
        &self,
        app: &AppHandle,
        session: &BrowserSessionState,
        webview: &tauri::Webview,
    ) {
        let Err(health_error) = probe_webview_health(webview) else {
            return;
        };
        let _ = webview.hide();
        if let Ok(Some(crashed)) = self
            .registry
            .mark_crashed(&session.session_id, health_error)
        {
            emit_browser_state(app, &crashed, "renderer_unresponsive");
        }
    }

    fn record_browser_error(&self, app: &AppHandle, session_id: &str, error: String) -> String {
        if let Ok(state) = self.registry.mark_error(session_id, error.clone()) {
            emit_browser_state(app, &state, "browser_action_failed");
        }
        error
    }

    fn info_from_state(
        &self,
        session: BrowserSessionState,
        webview_exists: bool,
    ) -> Result<BrowserInfo, String> {
        let active_session_id = self.registry.active_session_id()?;
        Ok(BrowserInfo {
            label: session.label,
            session_id: session.session_id.clone(),
            url: session.current_url,
            title: session.title,
            visible: webview_exists && session.visible && session.session_id == active_session_id,
            can_go_back: session.can_go_back,
            can_go_forward: session.can_go_forward,
            lifecycle: session.lifecycle,
            loading: session.loading,
            error: session.last_error,
            control: session.control,
            paused: session.paused,
            generation: session.generation,
            last_agent_action: session.last_agent_action,
            created_at: session.created_at,
            updated_at: session.updated_at,
        })
    }

    fn sync_webview_visibility(&self, app: &AppHandle) -> Result<(), String> {
        let active_session_id = self.registry.active_session_id()?;
        let sessions = self.registry.snapshots()?;

        for session in sessions {
            let Some(webview) = app.get_webview(&session.label) else {
                continue;
            };
            if session.session_id == active_session_id && session.visible {
                webview
                    .show()
                    .map_err(|error| format!("show browser webview: {error}"))?;
            } else {
                webview
                    .hide()
                    .map_err(|error| format!("hide browser webview: {error}"))?;
            }
        }
        Ok(())
    }
}

#[tauri::command]
pub fn browser_set_active_session(
    app: AppHandle,
    state: tauri::State<'_, std::sync::Arc<BrowserManager>>,
    session_id: Option<String>,
    visible: Option<bool>,
) -> Result<(), String> {
    state.set_active_session(&app, session_id.as_deref(), visible.unwrap_or(false))
}

#[tauri::command]
pub fn browser_open(
    app: AppHandle,
    state: tauri::State<'_, std::sync::Arc<BrowserManager>>,
    session_id: Option<String>,
    url: Option<String>,
) -> Result<BrowserInfo, String> {
    state.open(&app, session_id.as_deref(), url.as_deref())
}

#[tauri::command]
pub fn browser_set_bounds(
    app: AppHandle,
    state: tauri::State<'_, std::sync::Arc<BrowserManager>>,
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
pub fn browser_set_visible(
    app: AppHandle,
    state: tauri::State<'_, std::sync::Arc<BrowserManager>>,
    session_id: Option<String>,
    visible: bool,
) -> Result<(), String> {
    state.set_visible(&app, session_id.as_deref(), visible)
}

#[tauri::command]
pub fn browser_close(
    app: AppHandle,
    state: tauri::State<'_, std::sync::Arc<BrowserManager>>,
    session_id: Option<String>,
) -> Result<(), String> {
    state.close(&app, session_id.as_deref())
}

#[tauri::command]
pub fn browser_navigate(
    app: AppHandle,
    state: tauri::State<'_, std::sync::Arc<BrowserManager>>,
    session_id: Option<String>,
    url: String,
) -> Result<BrowserInfo, String> {
    state.navigate(&app, session_id.as_deref(), &url)
}

#[tauri::command]
pub fn browser_reload(
    app: AppHandle,
    state: tauri::State<'_, std::sync::Arc<BrowserManager>>,
    session_id: Option<String>,
) -> Result<BrowserInfo, String> {
    state.reload(&app, session_id.as_deref())
}

async fn run_blocking_browser_command<T, F>(
    app: AppHandle,
    state: std::sync::Arc<BrowserManager>,
    command: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(std::sync::Arc<BrowserManager>, AppHandle) -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || command(state, app))
        .await
        .map_err(|error| format!("join browser command: {error}"))?
}

#[tauri::command]
pub async fn browser_back(
    app: AppHandle,
    state: tauri::State<'_, std::sync::Arc<BrowserManager>>,
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
    state: tauri::State<'_, std::sync::Arc<BrowserManager>>,
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
    state: tauri::State<'_, std::sync::Arc<BrowserManager>>,
    session_id: Option<String>,
) -> Result<BrowserInfo, String> {
    state.info(&app, session_id.as_deref())
}

#[tauri::command]
pub async fn browser_health_check(
    app: AppHandle,
    state: tauri::State<'_, std::sync::Arc<BrowserManager>>,
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
    state: tauri::State<'_, std::sync::Arc<BrowserManager>>,
    session_id: Option<String>,
    paused: bool,
) -> Result<BrowserInfo, String> {
    state.set_paused(&app, session_id.as_deref(), paused)
}

#[tauri::command]
pub fn browser_recent_activity(
    state: tauri::State<'_, std::sync::Arc<BrowserManager>>,
    session_id: Option<String>,
) -> Result<BrowserRecentActivity, String> {
    state.recent_activity(&normalize_browser_session_id(session_id.as_deref()))
}

#[tauri::command]
pub fn browser_runtime_readiness() -> BrowserRuntimeReadiness {
    runtime_readiness::runtime_readiness()
}

#[tauri::command]
pub async fn browser_snapshot(
    app: AppHandle,
    state: tauri::State<'_, std::sync::Arc<BrowserManager>>,
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
    state: tauri::State<'_, std::sync::Arc<BrowserManager>>,
    session_id: Option<String>,
) -> Result<String, String> {
    run_blocking_browser_command(app, state.inner().clone(), move |state, app| {
        state.screenshot_base64(&app, session_id.as_deref())
    })
    .await
}

fn sanitize_bounds(bounds: BrowserBounds) -> BrowserBounds {
    BrowserBounds {
        x: bounds.x.max(0.0),
        y: bounds.y.max(0.0),
        width: bounds.width.max(1.0),
        height: bounds.height.max(1.0),
    }
}

fn normalize_browser_session_id(raw: Option<&str>) -> String {
    raw.map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_BROWSER_SESSION_ID)
        .to_string()
}

fn stable_hash64(seed: u64, value: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64 ^ seed;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn browser_label_for_session_id(session_id: &str, generation: u64) -> String {
    if session_id == DEFAULT_BROWSER_SESSION_ID {
        return format!("{BROWSER_LABEL}-g{generation}");
    }
    format!(
        "{BROWSER_LABEL}-{:016x}-g{generation}",
        stable_hash64(0, session_id)
    )
}

fn required_string_arg(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("Missing browser tool string arg: {key}"))
}

fn required_u32_arg(args: &Value, key: &str) -> Result<u32, String> {
    let value = args
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("Missing browser tool numeric arg: {key}"))?;
    u32::try_from(value).map_err(|_| format!("Browser tool arg out of range: {key}"))
}

fn decode_eval_value(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string()))
}

fn decode_eval_json_string(raw: &str) -> Result<String, String> {
    match serde_json::from_str::<Value>(raw)
        .map_err(|error| format!("decode browser eval: {error}"))?
    {
        Value::String(value) => Ok(value),
        other => Ok(other.to_string()),
    }
}

fn build_eval_json_script(expression: &str) -> Result<String, String> {
    Ok(format!(
        r#"
(() => {{
  try {{
    const value = (
{expression}
    );
    return JSON.stringify(value === undefined ? null : value);
  }} catch (error) {{
    return JSON.stringify({{ ok: false, error: String(error && error.message || error) }});
  }}
}})()
"#
    ))
}

fn emit_browser_opened(app: &AppHandle, session_id: &str, label: &str, cause: &str) {
    let _ = app.emit(
        "browser_panel_requested",
        json!({
            "label": label,
            "sessionId": session_id,
            "cause": cause,
        }),
    );
}

fn emit_browser_state(app: &AppHandle, state: &BrowserSessionState, cause: &str) {
    let _ = app.emit(
        "browser_session_state_changed",
        json!({
            "sessionId": state.session_id,
            "label": state.label,
            "url": state.current_url,
            "title": state.title,
            "visible": state.visible,
            "canGoBack": state.can_go_back,
            "canGoForward": state.can_go_forward,
            "lifecycle": state.lifecycle,
            "loading": state.loading,
            "error": state.last_error,
            "control": state.control,
            "paused": state.paused,
            "generation": state.generation,
            "lastAgentAction": state.last_agent_action,
            "createdAt": state.created_at,
            "updatedAt": state.updated_at,
            "cause": cause,
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::{
        browser_label_for_session_id, build_eval_json_script, normalize_browser_session_id,
        sanitize_bounds, BrowserBounds, BROWSER_LABEL, DEFAULT_BROWSER_SESSION_ID,
    };

    #[test]
    fn sanitize_bounds_keeps_browser_renderable() {
        let bounds = sanitize_bounds(BrowserBounds {
            x: -10.0,
            y: -4.0,
            width: 0.0,
            height: -1.0,
        });
        assert_eq!(bounds.x, 0.0);
        assert_eq!(bounds.y, 0.0);
        assert_eq!(bounds.width, 1.0);
        assert_eq!(bounds.height, 1.0);
    }

    #[test]
    fn build_eval_json_script_runs_without_page_eval() {
        let script = build_eval_json_script(
            r#"
            (() => {
              window.scrollBy(0, 100);
              return { ok: true };
            })()
            "#,
        )
        .expect("script");
        assert!(!script.contains("eval("));
        assert!(script.contains("window.scrollBy"));
        assert!(script.contains("JSON.stringify"));
    }

    #[test]
    fn browser_session_ids_default_to_workspace() {
        assert_eq!(
            normalize_browser_session_id(None),
            DEFAULT_BROWSER_SESSION_ID.to_string()
        );
        assert_eq!(
            normalize_browser_session_id(Some("  ")),
            DEFAULT_BROWSER_SESSION_ID.to_string()
        );
        assert_eq!(normalize_browser_session_id(Some("native-a")), "native-a");
    }

    #[test]
    fn browser_labels_are_scoped_per_session() {
        assert_eq!(
            browser_label_for_session_id(DEFAULT_BROWSER_SESSION_ID, 7),
            format!("{BROWSER_LABEL}-g7")
        );
        let first = browser_label_for_session_id("native-a", 1);
        let second = browser_label_for_session_id("native-b", 1);
        assert!(first.starts_with(&format!("{BROWSER_LABEL}-")));
        assert!(second.starts_with(&format!("{BROWSER_LABEL}-")));
        assert_ne!(first, second);
        assert_ne!(first, browser_label_for_session_id("native-a", 2));
    }
}
