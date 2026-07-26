mod alias;
mod artifacts;
mod bootstrap;
#[cfg(all(unix, feature = "chromium-spike"))]
mod chromium_spike;
pub(crate) mod commands;
pub(crate) mod login;
pub(crate) mod login_commands;
mod logs;
mod policy;
mod registry;
mod runtime;
#[cfg(test)]
pub(crate) mod runtime_commands;
mod surface_coordinator;
#[cfg(test)]
mod tests;
mod tools;
mod url;
mod webview;

use alias::{BrowserSessionAliasRegistry, BrowserSessionAliasRoute};
use artifacts::BrowserArtifactStore;
use base64::{engine::general_purpose::STANDARD, Engine as _};
#[cfg(any(target_os = "macos", windows))]
pub(crate) use bootstrap::create_cef_host_controller;
pub(crate) use bootstrap::{
    create_login_browser_session_manager, create_login_browser_surface_manager,
};
use logs::BrowserLogStore;
pub use logs::BrowserRecentActivity;
pub(crate) use policy::authorize_browser_tool;
use registry::{BrowserSessionRegistry, BrowserSessionState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use url::{is_allowed_browser_navigation, parse_browser_url};
use webview::{
    apply_browser_bounds, ensure_browser_webview, eval_webview_js, navigate_browser_history,
    probe_webview_health, require_browser_webview, snapshot_webview_png,
};

pub use alias::BrowserSessionAliasLease;

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
    aliases: BrowserSessionAliasRegistry,
    alias_operation_gate: Mutex<()>,
    artifacts: Arc<BrowserArtifactStore>,
    logs: Arc<BrowserLogStore>,
}

impl Default for BrowserManager {
    fn default() -> Self {
        Self {
            registry: Arc::new(BrowserSessionRegistry::new(DEFAULT_BROWSER_SESSION_ID)),
            aliases: BrowserSessionAliasRegistry::default(),
            alias_operation_gate: Mutex::new(()),
            artifacts: Arc::new(BrowserArtifactStore::default()),
            logs: Arc::new(BrowserLogStore::default()),
        }
    }
}

impl BrowserManager {
    pub fn bind_preview_alias(
        &self,
        alias_session_id: &str,
        session_id: &str,
    ) -> Result<BrowserSessionAliasLease, String> {
        let _routing = self.alias_operation()?;
        self.bind_preview_alias_locked(alias_session_id, session_id)
    }

    fn bind_preview_alias_locked(
        &self,
        alias_session_id: &str,
        session_id: &str,
    ) -> Result<BrowserSessionAliasLease, String> {
        let session = self
            .registry
            .snapshot(session_id)?
            .ok_or_else(|| format!("Preview Browser session {session_id} is not registered"))?;
        let (lease, replaced) =
            self.aliases
                .bind(alias_session_id, &session.session_id, session.generation)?;
        if let Some(replaced) = replaced {
            self.registry
                .invalidate_alias_route(&replaced.session_id, replaced.generation)?;
        }
        Ok(lease)
    }

    pub fn unbind_preview_alias(
        &self,
        alias_session_id: &str,
        binding_id: u64,
    ) -> Result<(), String> {
        let _routing = self.alias_operation()?;
        if let Some(removed) = self.aliases.unbind(alias_session_id, binding_id)? {
            self.registry
                .invalidate_alias_route(&removed.session_id, removed.generation)?;
        }
        Ok(())
    }

    pub(crate) fn resolve_preview_session_id(&self, requested: &str) -> Result<String, String> {
        let _routing = self.alias_operation()?;
        self.resolve_preview_session_id_locked(requested)
    }

    fn resolve_preview_session_id_locked(&self, requested: &str) -> Result<String, String> {
        self.aliases
            .resolve(requested, |session_id| {
                self.registry
                    .snapshot(session_id)
                    .map(|session| session.map(|session| session.generation))
            })
            .map(|resolved| resolved.unwrap_or_else(|| requested.to_string()))
    }

    fn capture_preview_route_locked(
        &self,
        requested: &str,
    ) -> Result<BrowserSessionAliasRoute, String> {
        let snapshot = self.aliases.current(requested, |session_id| {
            self.registry
                .snapshot(session_id)
                .map(|session| session.map(|session| session.generation))
        })?;
        Ok(BrowserSessionAliasRoute::new(requested, snapshot))
    }

    fn resolve_preview_route_locked(
        &self,
        route: &mut BrowserSessionAliasRoute,
    ) -> Result<String, String> {
        if route.adopted.is_none() {
            if let Some((session_id, generation)) = route.provisional.as_ref() {
                let current_generation = self
                    .registry
                    .snapshot(session_id)?
                    .map(|session| session.generation);
                if current_generation != Some(*generation) {
                    return Err(stale_preview_route_error());
                }
            }
        }

        let current = self
            .aliases
            .current(&route.requested_session_id, |session_id| {
                self.registry
                    .snapshot(session_id)
                    .map(|session| session.map(|session| session.generation))
            })?;
        if let Some(adopted) = route.adopted.as_ref() {
            if current.lease.as_ref() != Some(adopted)
                || route.adopted_revision != Some(current.revision)
            {
                return Err(stale_preview_route_error());
            }
            return Ok(adopted.session_id.clone());
        }

        if current.revision == route.captured_revision {
            if current.lease.is_some() {
                return Err(stale_preview_route_error());
            }
        } else if Some(current.revision) == route.captured_revision.checked_add(1) {
            let Some(current_lease) = current.lease else {
                return Err(stale_preview_route_error());
            };
            let session_id = current_lease.session_id.clone();
            route.adopted = Some(current_lease);
            route.adopted_revision = Some(current.revision);
            return Ok(session_id);
        } else {
            return Err(stale_preview_route_error());
        }

        route
            .provisional
            .as_ref()
            .map(|(session_id, _)| session_id.clone())
            .ok_or_else(stale_preview_route_error)
    }

    fn preview_route_session_locked(
        &self,
        route: &mut BrowserSessionAliasRoute,
    ) -> Result<BrowserSessionState, String> {
        let session_id = self.resolve_preview_route_locked(route)?;
        let expected_generation = route
            .adopted
            .as_ref()
            .map(|lease| lease.generation)
            .or_else(|| {
                route
                    .provisional
                    .as_ref()
                    .filter(|(provisional_session_id, _)| provisional_session_id == &session_id)
                    .map(|(_, generation)| *generation)
            })
            .ok_or_else(stale_preview_route_error)?;
        self.registry
            .snapshot(&session_id)?
            .filter(|session| session.generation == expected_generation)
            .ok_or_else(stale_preview_route_error)
    }

    fn alias_operation(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.alias_operation_gate
            .lock()
            .map_err(|_| "Preview Browser alias operation gate is unavailable.".to_string())
    }

    pub fn open_with_visibility_and_alias(
        &self,
        app: &AppHandle,
        session_id: Option<&str>,
        url: Option<&str>,
        visible: bool,
        alias_session_id: Option<&str>,
    ) -> Result<(BrowserInfo, Option<BrowserSessionAliasLease>), String> {
        let _routing = self.alias_operation()?;
        let info = self.open_with_visibility(app, session_id, url, visible)?;
        let alias_lease = if let Some(alias_session_id) = alias_session_id
            .map(str::trim)
            .filter(|alias_session_id| !alias_session_id.is_empty())
        {
            Some(self.bind_preview_alias_locked(alias_session_id, &info.session_id)?)
        } else {
            None
        };
        Ok((info, alias_lease))
    }

    fn with_preview_surface_slot<T>(
        &self,
        app: &AppHandle,
        preview_session_id: &str,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        #[cfg(any(target_os = "macos", windows))]
        {
            let surface =
                app.try_state::<Arc<login::surface_commands::LoginBrowserSurfaceManager>>();
            let sessions = app.try_state::<Arc<login::session::LoginBrowserSessionManager>>();
            let cef_host = app.try_state::<Arc<login::cef::host::CefHostController>>();
            if let (Some(surface), Some(sessions), Some(cef_host)) = (surface, sessions, cef_host) {
                return surface.with_preview_surface_slot(
                    app,
                    sessions.inner().as_ref(),
                    cef_host.inner().as_ref(),
                    preview_session_id,
                    operation,
                );
            }
        }

        operation()
    }

    /// Workspace visibility is globally ordered with Login CEF presentation. The value is
    /// supplied by the Workspace owner change and applies to both Preview hide/show mutations.
    /// A stale call intentionally performs no Preview registry or webview mutation.
    fn with_preview_presentation_epoch<T>(
        &self,
        app: &AppHandle,
        presentation_revision: Option<u64>,
        preview_session_id: &str,
        preview_will_be_visible: bool,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<Option<T>, String> {
        #[cfg(any(target_os = "macos", windows))]
        {
            let presentation_revision = presentation_revision
                .filter(|revision| *revision > 0)
                .ok_or_else(|| {
                    "Preview visibility requires a positive presentation revision.".to_string()
                })?;
            let surface =
                app.try_state::<Arc<login::surface_commands::LoginBrowserSurfaceManager>>();
            let sessions = app.try_state::<Arc<login::session::LoginBrowserSessionManager>>();
            let cef_host = app.try_state::<Arc<login::cef::host::CefHostController>>();
            if let (Some(surface), Some(sessions), Some(cef_host)) = (surface, sessions, cef_host) {
                return surface.with_preview_presentation_epoch(
                    app,
                    sessions.inner().as_ref(),
                    cef_host.inner().as_ref(),
                    presentation_revision,
                    preview_session_id,
                    preview_will_be_visible,
                    operation,
                );
            }
        }

        operation().map(Some)
    }

    pub(crate) fn hide_all(&self, app: &AppHandle) -> Result<(), String> {
        let sessions = self.registry.snapshots()?;
        for session in sessions {
            let state = self.registry.set_visible(&session.session_id, false)?;
            emit_browser_state(app, &state, "native_surface_superseded");
        }
        self.sync_webview_visibility(app)
    }

    pub fn set_active_session(
        &self,
        app: &AppHandle,
        session_id: Option<&str>,
        visible: bool,
        presentation_revision: Option<u64>,
    ) -> Result<(), String> {
        let session_id = normalize_browser_session_id(session_id);
        self.session_snapshot(&session_id)?;
        let apply = || {
            self.registry.set_active_session(&session_id)?;
            let state = self.registry.set_visible(&session_id, visible)?;
            self.sync_webview_visibility(app)?;
            emit_browser_state(app, &state, "active_session");
            Ok(())
        };
        self.with_preview_presentation_epoch(
            app,
            presentation_revision,
            &session_id,
            visible,
            apply,
        )
        .map(|_| ())
    }

    pub fn open(
        &self,
        app: &AppHandle,
        session_id: Option<&str>,
        url: Option<&str>,
    ) -> Result<BrowserInfo, String> {
        self.open_with_visibility(app, session_id, url, true)
    }

    pub fn open_with_visibility(
        &self,
        app: &AppHandle,
        session_id: Option<&str>,
        url: Option<&str>,
        visible: bool,
    ) -> Result<BrowserInfo, String> {
        let session_id = normalize_browser_session_id(session_id);
        let requested = url.map(str::trim).filter(|value| !value.is_empty());
        let parsed_requested = requested.map(parse_browser_url).transpose()?;
        let target_url = parsed_requested
            .as_ref()
            .map(|value| value.as_str())
            .unwrap_or(DEFAULT_BROWSER_URL)
            .to_string();
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
            let (state, _) = self
                .registry
                .mark_navigation(&session_id, target_url.clone())?;
            emit_browser_state(app, &state, "navigation_requested");
        }
        if !visible {
            let state = self.registry.set_visible(&session_id, false)?;
            self.sync_webview_visibility(app)?;
            if let Some(webview) = app.get_webview(&session.label) {
                webview.hide().map_err(|error| {
                    self.record_browser_error(
                        app,
                        &session_id,
                        format!("hide browser webview before hidden open: {error}"),
                    )
                })?;
                if let Some(parsed) = parsed_requested.as_ref() {
                    webview.navigate(parsed.clone()).map_err(|error| {
                        self.record_browser_error(
                            app,
                            &session_id,
                            format!("navigate hidden browser webview: {error}"),
                        )
                    })?;
                }
                apply_browser_bounds(&webview, session.bounds)?;
            }
            // Hidden open is an absolute no-create path. If the child is absent
            // or disappears at any point, only a later explicit reveal may
            // attach its replacement.
            emit_browser_state(app, &state, "opened_hidden");
            return self.info(app, Some(&session_id));
        }
        self.with_preview_surface_slot(app, &session_id, || {
            let webview = ensure_browser_webview(
                app,
                Arc::clone(&self.registry),
                &session.session_id,
                &session.label,
                session.generation,
                &target_url,
                true,
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
            Ok(())
        })?;
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
        presentation_revision: Option<u64>,
    ) -> Result<(), String> {
        let session_id = normalize_browser_session_id(session_id);
        let session = self.session_snapshot(&session_id)?;
        let apply = || {
            if visible && app.get_webview(&session.label).is_none() {
                let target = session
                    .current_url
                    .as_deref()
                    .unwrap_or(DEFAULT_BROWSER_URL);
                let webview = ensure_browser_webview(
                    app,
                    Arc::clone(&self.registry),
                    &session.session_id,
                    &session.label,
                    session.generation,
                    target,
                    true,
                )
                .map_err(|error| self.record_browser_error(app, &session_id, error))?;
                apply_browser_bounds(&webview, session.bounds)?;
            }
            let state = self.registry.set_visible(&session_id, visible)?;
            self.sync_webview_visibility(app)?;
            emit_browser_state(app, &state, if visible { "shown" } else { "hidden" });
            Ok(())
        };
        self.with_preview_presentation_epoch(
            app,
            presentation_revision,
            &session_id,
            visible,
            apply,
        )
        .map(|_| ())
    }

    pub fn close(&self, app: &AppHandle, session_id: Option<&str>) -> Result<(), String> {
        let requested_session_id = normalize_browser_session_id(session_id);
        let (session, actor) = {
            let _routing = self.alias_operation()?;
            let session_id = self.resolve_preview_session_id_locked(&requested_session_id)?;
            let Some(session) = self.registry.snapshot(&session_id)? else {
                return Ok(());
            };
            let actor = self.registry.actor(&session.session_id)?;
            (session, actor)
        };
        // Do not hold the alias gate while waiting for an already-entered Agent effect. Once the
        // physical actor is ours, revalidate the exact route/generation and keep only the short
        // webview-close/remove critical section under the gate.
        let _permit = actor.lock().map_err(|_| {
            format!(
                "Browser session {} actor is unavailable",
                session.session_id
            )
        })?;
        let _routing = self.alias_operation()?;
        let current_session_id = self.resolve_preview_session_id_locked(&requested_session_id)?;
        let current_generation = self
            .registry
            .snapshot(&current_session_id)?
            .map(|current| current.generation);
        if current_session_id != session.session_id
            || current_generation != Some(session.generation)
        {
            return Err(stale_preview_route_error());
        }
        if let Some(workspace_dir) = session.workspace_dir.as_deref() {
            let _ = self.drain_console_log(app, &session.session_id, workspace_dir);
        }
        if let Some(webview) = app.get_webview(&session.label) {
            webview
                .close()
                .map_err(|error| format!("close browser webview: {error}"))?;
        }
        if let Some(destroyed) = self.registry.remove(&session.session_id)? {
            emit_browser_state(app, &destroyed, "destroyed");
        }
        self.aliases
            .remove_session(&session.session_id, session.generation)?;
        Ok(())
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
        self.with_preview_surface_slot(app, &session_id, || {
            let webview = match app.get_webview(&session.label) {
                Some(webview) => Ok(webview),
                None => ensure_browser_webview(
                    app,
                    Arc::clone(&self.registry),
                    &session.session_id,
                    &session.label,
                    session.generation,
                    parsed.as_str(),
                    true,
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
            Ok(())
        })?;
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

    fn retire_agent_control_state(
        &self,
        session_id: &str,
    ) -> Result<Option<BrowserSessionState>, String> {
        let _routing = self.alias_operation()?;
        let session_id = self.resolve_preview_session_id_locked(session_id)?;
        if self.registry.snapshot(&session_id)?.is_none() {
            return Ok(None);
        }
        self.registry.set_paused(&session_id, true).map(Some)
    }

    pub fn retire_agent_control(&self, app: &AppHandle, session_id: &str) -> Result<bool, String> {
        let Some(state) = self.retire_agent_control_state(session_id)? else {
            return Ok(false);
        };
        emit_browser_state(app, &state, "runtime_agent_control_retired");
        Ok(true)
    }

    pub fn policy_changed(
        &self,
        app: &AppHandle,
        session_id: &str,
        permission_revision: u64,
    ) -> Result<(), String> {
        let _routing = self.alias_operation()?;
        let session_id = self.resolve_preview_session_id_locked(session_id)?;
        let Some(_) = self.registry.snapshot(&session_id)? else {
            return Ok(());
        };
        let state = self
            .registry
            .bump_permission_epoch(&session_id, permission_revision)?;
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

fn stale_preview_route_error() -> String {
    "Browser action was cancelled because its Preview Browser instance changed.".to_string()
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

fn emit_browser_opened_for_agent(
    app: &AppHandle,
    session_id: &str,
    agent_session_id: &str,
    label: &str,
) {
    let _ = app.emit(
        "browser_panel_requested",
        json!({
            "label": label,
            "sessionId": session_id,
            "agentSessionId": agent_session_id,
            "cause": "agent_reveal",
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
