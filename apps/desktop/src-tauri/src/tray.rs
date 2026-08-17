use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent, TrayIconId},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Rect, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::config;
use crate::cron::{self, CronTask};
use crate::session::{Session, SessionManager};
use crate::terminal;

/// Event payload for environment changes
#[derive(Clone, Serialize)]
pub struct EnvChangedPayload {
    pub env: String,
}

/// Event payload for permission changes
#[derive(Clone, Serialize)]
pub struct PermChangedPayload {
    pub perm: String,
}

/// Event payload for session focus
#[derive(Clone, Serialize)]
pub struct SessionFocusPayload {
    pub session_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayRuntimeSnapshot {
    pub current_env: String,
    pub permission_mode: String,
    pub theme: String,
    pub sessions: Vec<Session>,
    pub cron_tasks: Vec<CronTask>,
}

/// Read environments and current permission mode from config
fn read_config_state() -> (String, Vec<String>, String) {
    let cfg = match config::read_config() {
        Ok(c) => c,
        Err(_) => {
            return (
                "official".to_string(),
                vec!["official".to_string()],
                "dev".to_string(),
            )
        }
    };

    let current_env = cfg.current.unwrap_or_else(|| "official".to_string());
    let current_perm = cfg.default_mode.unwrap_or_else(|| "dev".to_string());

    // Build environment list, always include "official" first
    let mut envs: Vec<String> = vec!["official".to_string()];
    for name in cfg.registries.keys() {
        if name != "official" {
            envs.push(name.clone());
        }
    }
    envs.sort_by(|a, b| {
        if a == "official" {
            std::cmp::Ordering::Less
        } else if b == "official" {
            std::cmp::Ordering::Greater
        } else {
            a.cmp(b)
        }
    });

    (current_env, envs, current_perm)
}

/// Build the environment submenu dynamically
fn build_env_menu(
    app: &AppHandle,
    current: &str,
    envs: Vec<String>,
) -> Result<Submenu<tauri::Wry>, tauri::Error> {
    let mut items: Vec<MenuItem<tauri::Wry>> = Vec::new();

    for env_name in &envs {
        let marker = if env_name == current { "●" } else { "○" };
        let label = format!("{} {}", marker, env_name);
        let id = format!("env:{}", env_name);
        items.push(MenuItem::with_id(app, &id, &label, true, None::<&str>)?);
    }

    let title = format!("Environment: {}", current);

    // Convert Vec<MenuItem> to Vec<&dyn IsMenuItem>
    let item_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = items
        .iter()
        .map(|i| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>)
        .collect();

    Submenu::with_items(app, &title, true, &item_refs)
}

/// Build the permission mode submenu dynamically
fn build_perm_menu(app: &AppHandle, current: &str) -> Result<Submenu<tauri::Wry>, tauri::Error> {
    let modes = vec!["yolo", "dev", "readonly", "safe", "ci", "audit"];
    let mut items: Vec<MenuItem<tauri::Wry>> = Vec::new();

    for mode in &modes {
        let marker = if mode == &current { "●" } else { "○" };
        let label = format!("{} {}", marker, mode);
        let id = format!("perm:{}", mode);
        items.push(MenuItem::with_id(app, &id, &label, true, None::<&str>)?);
    }

    let title = format!("Permission: {}", current);

    // Convert Vec<MenuItem> to Vec<&dyn IsMenuItem>
    let item_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = items
        .iter()
        .map(|i| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>)
        .collect();

    Submenu::with_items(app, &title, true, &item_refs)
}

/// Build the active sessions submenu dynamically
fn build_sessions_menu(app: &AppHandle) -> Result<Submenu<tauri::Wry>, tauri::Error> {
    // Get the SessionManager from app state
    let manager = match app.try_state::<Arc<SessionManager>>() {
        Some(m) => m,
        None => {
            // Return empty submenu if no manager
            let title = "Sessions (0)";
            let no_sessions = MenuItem::with_id(
                app,
                "no_sessions",
                "No active sessions",
                false,
                None::<&str>,
            )?;
            return Submenu::with_items(app, title, true, &[&no_sessions]);
        }
    };

    let sessions = manager.list_sessions();
    let running_count = sessions.iter().filter(|s| s.status == "running").count();

    let title = format!("Sessions ({})", running_count);

    if sessions.is_empty() {
        let no_sessions = MenuItem::with_id(
            app,
            "no_sessions",
            "No active sessions",
            false,
            None::<&str>,
        )?;
        return Submenu::with_items(app, &title, true, &[&no_sessions]);
    }

    let mut items: Vec<MenuItem<tauri::Wry>> = Vec::new();

    // Show up to 5 most recent sessions
    for session in sessions.iter().take(5) {
        // Extract project name from working directory
        let project_name = session
            .working_dir
            .split('/')
            .next_back()
            .unwrap_or(&session.working_dir);

        let label = format!(
            "{} ({} + {})",
            project_name, session.env_name, session.perm_mode
        );
        let id = format!("session:{}", session.id);
        items.push(MenuItem::with_id(app, &id, &label, true, None::<&str>)?);
    }

    // Convert Vec<MenuItem> to Vec<&dyn IsMenuItem>
    let item_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = items
        .iter()
        .map(|i| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>)
        .collect();

    Submenu::with_items(app, &title, true, &item_refs)
}

/// Build the full tray menu
fn build_tray_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, tauri::Error> {
    // Read configuration state
    let (current_env, envs, current_perm) = read_config_state();

    // Status header (non-clickable)
    let status_header = MenuItem::with_id(
        app,
        "status",
        format!("CCEM · {} · {}", current_env, current_perm),
        false,
        None::<&str>,
    )?;

    // Environment submenu (dynamic)
    let env_submenu = build_env_menu(app, &current_env, envs)?;

    // Permission mode submenu (dynamic)
    let perm_submenu = build_perm_menu(app, &current_perm)?;

    // Active sessions submenu (dynamic)
    let sessions_submenu = build_sessions_menu(app)?;

    // Today's stats (non-clickable, placeholder for now)
    // TODO: Wire to real analytics data via update_tray_stats() when usage tracking is implemented
    let stats_item = MenuItem::with_id(
        app,
        "stats",
        "📊 今日: -- tokens · $--.--",
        false,
        None::<&str>,
    )?;

    // Main action items
    let launch_item = MenuItem::with_id(app, "launch", "🚀 启动 Claude Code", true, None::<&str>)?;
    let open_window_item =
        MenuItem::with_id(app, "open_window", "🏠 打开主窗口", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "⚙️ 设置", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "❌ 退出", true, None::<&str>)?;

    // Build complete menu
    Menu::with_items(
        app,
        &[
            &status_header,
            &PredefinedMenuItem::separator(app)?,
            &env_submenu,
            &perm_submenu,
            &sessions_submenu,
            &PredefinedMenuItem::separator(app)?,
            &stats_item,
            &PredefinedMenuItem::separator(app)?,
            &launch_item,
            &open_window_item,
            &settings_item,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )
}

/// Tray icon ID constant for rebuilding
const TRAY_ID: &str = "main_tray";
pub const TRAY_COCKPIT_LABEL: &str = "tray-cockpit";
static TRAY_COCKPIT_BUILDING: AtomicBool = AtomicBool::new(false);

struct TrayCockpitBuildGuard;

impl Drop for TrayCockpitBuildGuard {
    fn drop(&mut self) {
        TRAY_COCKPIT_BUILDING.store(false, Ordering::SeqCst);
    }
}

const TRAY_COCKPIT_PANEL_WIDTH: f64 = 390.0;
const TRAY_COCKPIT_PANEL_HEIGHT: f64 = 700.0;
const TRAY_COCKPIT_SHADOW_MARGIN_X: f64 = 32.0;
const TRAY_COCKPIT_SHADOW_MARGIN_TOP: f64 = 8.0;
const TRAY_COCKPIT_SHADOW_MARGIN_BOTTOM: f64 = 48.0;
const TRAY_COCKPIT_WIDTH: f64 = TRAY_COCKPIT_PANEL_WIDTH + TRAY_COCKPIT_SHADOW_MARGIN_X * 2.0;
const TRAY_COCKPIT_HEIGHT: f64 =
    TRAY_COCKPIT_PANEL_HEIGHT + TRAY_COCKPIT_SHADOW_MARGIN_TOP + TRAY_COCKPIT_SHADOW_MARGIN_BOTTOM;
const TRAY_COCKPIT_MARGIN: f64 = 10.0;

#[derive(Clone, Copy)]
struct TrayCockpitAnchor {
    position: PhysicalPosition<f64>,
    rect: Option<Rect>,
}

impl TrayCockpitAnchor {
    fn point(position: PhysicalPosition<f64>) -> Self {
        Self {
            position,
            rect: None,
        }
    }

    fn icon_rect(position: PhysicalPosition<f64>, rect: Rect) -> Self {
        Self {
            position,
            rect: Some(rect),
        }
    }
}

pub fn create_tray(app: &AppHandle) -> Result<TrayIcon, tauri::Error> {
    let menu = build_tray_menu(app)?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                position,
                rect,
                ..
            } = event
            {
                let anchor = TrayCockpitAnchor::icon_rect(position, rect);
                if let Err(error) = toggle_tray_cockpit(tray.app_handle(), anchor) {
                    eprintln!("Failed to toggle tray cockpit: {}", error);
                }
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "launch" => {
                println!("Launch Claude from tray");
                // Emit event to frontend to show launch dialog
                let _ = app.emit("tray-launch-claude", ());
            }
            "open_window" => {
                if let Some(window) = app.get_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            "settings" => {
                if let Some(window) = app.get_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                    // Emit event to navigate to settings
                    let _ = app.emit("navigate-to-settings", ());
                }
            }
            "quit" => {
                let can_exit = app
                    .try_state::<std::sync::Arc<crate::native_runtime::NativeRuntimeManager>>()
                    .is_some_and(|manager| manager.prepare_app_termination(false).is_ok());
                if can_exit {
                    crate::FORCE_QUIT.store(true, Ordering::SeqCst);
                    app.exit(0);
                } else {
                    if let Some(window) = app.get_window("main") {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                    let _ = app.emit("native-background-task-app-action", "quit");
                }
            }
            id if id.starts_with("session:") => {
                let session_id = id.strip_prefix("session:").unwrap();
                handle_session_focus(app, session_id);
            }
            id if id.starts_with("env:") => {
                let env_name = id.strip_prefix("env:").unwrap();
                handle_env_switch(app, env_name);
            }
            id if id.starts_with("perm:") => {
                let perm_mode = id.strip_prefix("perm:").unwrap();
                handle_perm_switch(app, perm_mode);
            }
            _ => {}
        })
        .build(app)
}

pub fn hide_tray_cockpit(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(TRAY_COCKPIT_LABEL) {
        window
            .hide()
            .map_err(|e| format!("hide tray cockpit: {e}"))?;
    }
    Ok(())
}

pub fn prepare_tray_cockpit(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(TRAY_COCKPIT_LABEL).is_none() {
        let _ = build_tray_cockpit_window(app)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_tray_runtime_snapshot(
    manager: tauri::State<'_, Arc<SessionManager>>,
) -> Result<TrayRuntimeSnapshot, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = config::read_config().unwrap_or_default();
        let settings = config::read_settings().unwrap_or_default();
        let current_env = cfg.current.unwrap_or_else(|| "official".to_string());
        let permission_mode = cfg
            .default_mode
            .or(settings.default_mode)
            .unwrap_or_else(|| "dev".to_string());

        Ok(TrayRuntimeSnapshot {
            current_env,
            permission_mode,
            theme: settings.theme,
            sessions: manager.list_sessions(),
            cron_tasks: cron::list_cron_tasks().unwrap_or_default(),
        })
    })
    .await
    .map_err(|error| format!("Failed to join tray snapshot task: {error}"))?
}

fn toggle_tray_cockpit(app: &AppHandle, anchor: TrayCockpitAnchor) -> Result<(), String> {
    if TRAY_COCKPIT_BUILDING.load(Ordering::SeqCst) {
        return Ok(());
    }

    let window = match app.get_webview_window(TRAY_COCKPIT_LABEL) {
        Some(window) => window,
        None => return schedule_tray_cockpit_build(app, anchor),
    };

    if window.is_visible().unwrap_or(false) {
        window
            .hide()
            .map_err(|e| format!("hide tray cockpit: {e}"))?;
        return Ok(());
    }

    show_tray_cockpit_window(&window, anchor)
}

#[tauri::command]
pub fn open_tray_cockpit(app: AppHandle, x: Option<f64>, y: Option<f64>) -> Result<(), String> {
    if TRAY_COCKPIT_BUILDING.load(Ordering::SeqCst) {
        return Ok(());
    }

    let position = match (x, y) {
        (Some(x), Some(y)) => PhysicalPosition { x, y },
        _ => app
            .cursor_position()
            .unwrap_or(PhysicalPosition { x: 0.0, y: 0.0 }),
    };
    let anchor = TrayCockpitAnchor::point(position);
    let window = match app.get_webview_window(TRAY_COCKPIT_LABEL) {
        Some(window) => window,
        None => {
            schedule_tray_cockpit_build(&app, anchor)?;
            return Ok(());
        }
    };

    show_tray_cockpit_window(&window, anchor)
}

fn schedule_tray_cockpit_build(app: &AppHandle, anchor: TrayCockpitAnchor) -> Result<(), String> {
    if TRAY_COCKPIT_BUILDING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Ok(());
    }

    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _build_guard = TrayCockpitBuildGuard;
        let result = build_tray_cockpit_window(&app)
            .and_then(|window| show_tray_cockpit_window(&window, anchor));
        if let Err(error) = result {
            eprintln!("Failed to asynchronously build tray cockpit: {error}");
        }
    });
    Ok(())
}

fn show_tray_cockpit_window(
    window: &WebviewWindow,
    anchor: TrayCockpitAnchor,
) -> Result<(), String> {
    configure_tray_cockpit_window(window)?;
    window
        .set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: TRAY_COCKPIT_WIDTH,
            height: TRAY_COCKPIT_HEIGHT,
        }))
        .map_err(|e| format!("resize tray cockpit: {e}"))?;
    position_tray_cockpit_window(window, anchor)?;
    window
        .show()
        .map_err(|e| format!("show tray cockpit: {e}"))?;
    let _ = window.unminimize();
    let _ = window.set_focus();
    let _ = window.emit("tray-cockpit-refresh", ());
    Ok(())
}

fn build_tray_cockpit_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    let builder = WebviewWindowBuilder::new(
        app,
        TRAY_COCKPIT_LABEL,
        WebviewUrl::App("index.html?window=tray-cockpit".into()),
    )
    .title("CCEM Tray")
    .decorations(cfg!(target_os = "macos"))
    .resizable(false)
    .shadow(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .inner_size(TRAY_COCKPIT_WIDTH, TRAY_COCKPIT_HEIGHT)
    .visible(false);

    #[cfg(not(target_os = "macos"))]
    let builder = builder.transparent(true);

    let window = builder
        .build()
        .map_err(|e| format!("build tray cockpit: {e}"))?;

    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_decorum::WebviewWindowExt;

        window
            .make_transparent()
            .map_err(|e| format!("make tray cockpit transparent: {e}"))?;
    }

    Ok(window)
}

fn configure_tray_cockpit_window(window: &WebviewWindow) -> Result<(), String> {
    window
        .set_decorations(false)
        .map_err(|e| format!("tray cockpit decorations: {e}"))?;
    window
        .set_always_on_top(true)
        .map_err(|e| format!("tray cockpit always on top: {e}"))?;
    window
        .set_visible_on_all_workspaces(true)
        .map_err(|e| format!("tray cockpit all workspaces: {e}"))?;
    Ok(())
}

fn position_tray_cockpit_window(
    window: &WebviewWindow,
    anchor: TrayCockpitAnchor,
) -> Result<(), String> {
    let monitor = window
        .monitor_from_point(anchor.position.x, anchor.position.y)
        .map_err(|e| format!("tray cockpit monitor: {e}"))?
        .or(window
            .primary_monitor()
            .map_err(|e| format!("tray cockpit primary monitor: {e}"))?);

    let Some(monitor) = monitor else {
        return Ok(());
    };

    let position = tray_cockpit_position(
        anchor,
        *monitor.position(),
        *monitor.size(),
        monitor.scale_factor(),
    );

    window
        .set_position(tauri::Position::Logical(position))
        .map_err(|e| format!("position tray cockpit: {e}"))?;
    Ok(())
}

fn tray_cockpit_position(
    anchor: TrayCockpitAnchor,
    monitor_position: PhysicalPosition<i32>,
    monitor_size: PhysicalSize<u32>,
    scale: f64,
) -> tauri::LogicalPosition<f64> {
    let safe_scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let monitor_x = monitor_position.x as f64 / safe_scale;
    let monitor_y = monitor_position.y as f64 / safe_scale;
    let monitor_width = monitor_size.width as f64 / safe_scale;
    let monitor_height = monitor_size.height as f64 / safe_scale;

    let fallback_position = anchor.position.to_logical::<f64>(safe_scale);
    let (anchor_left, anchor_top, anchor_width, anchor_height) = anchor
        .rect
        .map(|rect| {
            let rect_position = rect.position.to_logical::<f64>(safe_scale);
            let rect_size = rect.size.to_logical::<f64>(safe_scale);
            (
                rect_position.x,
                rect_position.y,
                rect_size.width,
                rect_size.height,
            )
        })
        .filter(|(_, _, width, height)| *width > 0.0 && *height > 0.0)
        .unwrap_or((fallback_position.x, fallback_position.y, 0.0, 0.0));

    let anchor_center_x = anchor_left + anchor_width / 2.0;
    let anchor_bottom = anchor_top + anchor_height;
    let panel_min_x = monitor_x + TRAY_COCKPIT_MARGIN;
    let panel_max_x = monitor_x + monitor_width - TRAY_COCKPIT_PANEL_WIDTH - TRAY_COCKPIT_MARGIN;
    let panel_min_y = monitor_y + TRAY_COCKPIT_MARGIN;
    let panel_max_y = monitor_y + monitor_height - TRAY_COCKPIT_PANEL_HEIGHT - TRAY_COCKPIT_MARGIN;

    let panel_x = (anchor_center_x - TRAY_COCKPIT_PANEL_WIDTH / 2.0)
        .clamp(panel_min_x, panel_max_x.max(panel_min_x));
    let opens_down = anchor_bottom < monitor_y + monitor_height / 2.0;
    let desired_panel_y = if opens_down {
        anchor_bottom + TRAY_COCKPIT_MARGIN
    } else {
        anchor_top - TRAY_COCKPIT_PANEL_HEIGHT - TRAY_COCKPIT_MARGIN
    };
    let panel_y = desired_panel_y.clamp(panel_min_y, panel_max_y.max(panel_min_y));

    let x = panel_x - TRAY_COCKPIT_SHADOW_MARGIN_X;
    let y = panel_y - TRAY_COCKPIT_SHADOW_MARGIN_TOP;

    tauri::LogicalPosition { x, y }
}

#[cfg(test)]
mod tray_cockpit_tests {
    use super::*;

    fn anchor_with_rect(
        position: PhysicalPosition<f64>,
        rect_position: PhysicalPosition<f64>,
        rect_size: PhysicalSize<u32>,
    ) -> TrayCockpitAnchor {
        TrayCockpitAnchor::icon_rect(
            position,
            Rect {
                position: rect_position.into(),
                size: rect_size.into(),
            },
        )
    }

    #[test]
    fn tray_cockpit_position_clamps_visible_panel_to_right_monitor_edge() {
        let position = tray_cockpit_position(
            anchor_with_rect(
                PhysicalPosition { x: 3008.0, y: 32.0 },
                PhysicalPosition { x: 2976.0, y: 0.0 },
                PhysicalSize {
                    width: 48,
                    height: 44,
                },
            ),
            PhysicalPosition { x: 0, y: 0 },
            PhysicalSize {
                width: 3024,
                height: 1964,
            },
            2.0,
        );

        assert_eq!(
            position.x + TRAY_COCKPIT_SHADOW_MARGIN_X + TRAY_COCKPIT_PANEL_WIDTH,
            1502.0
        );
        assert_eq!(position.y + TRAY_COCKPIT_SHADOW_MARGIN_TOP, 32.0);
    }

    #[test]
    fn tray_cockpit_position_opens_above_lower_anchor() {
        let position = tray_cockpit_position(
            TrayCockpitAnchor::point(PhysicalPosition {
                x: 900.0,
                y: 1720.0,
            }),
            PhysicalPosition { x: 0, y: 0 },
            PhysicalSize {
                width: 1800,
                height: 1800,
            },
            1.0,
        );

        assert_eq!(position.x + TRAY_COCKPIT_SHADOW_MARGIN_X, 705.0);
        assert_eq!(position.y + TRAY_COCKPIT_SHADOW_MARGIN_TOP, 1010.0);
    }
}

/// Rebuild the tray menu to reflect updated configuration
/// Call this after environments are added, deleted, or switched
pub fn rebuild_tray_menu(app: &AppHandle) -> Result<(), tauri::Error> {
    let tray_id = TrayIconId::new(TRAY_ID);

    if let Some(tray) = app.tray_by_id(&tray_id) {
        let menu = build_tray_menu(app)?;
        tray.set_menu(Some(menu))?;
    }

    Ok(())
}

/// Update tray icon based on session state
/// Call this when sessions are added/removed or when errors occur
pub fn update_tray_icon(app: &AppHandle, has_error: bool) -> Result<(), tauri::Error> {
    let tray_id = TrayIconId::new(TRAY_ID);

    if let Some(tray) = app.tray_by_id(&tray_id) {
        let manager = app.try_state::<Arc<SessionManager>>();
        let has_running_sessions = manager
            .map(|m| m.list_sessions().iter().any(|s| s.status == "running"))
            .unwrap_or(false);

        // Icon state logic:
        // - Red: has_error = true
        // - Green: has running sessions
        // - White/Default: no sessions

        // TODO: Implement icon switching when we have multiple icon assets
        // For now, use tooltip to indicate state
        let tooltip = if has_error {
            "CCEM - ⚠️ Error"
        } else if has_running_sessions {
            "CCEM - 🟢 Running"
        } else {
            "CCEM"
        };
        tray.set_tooltip(Some(tooltip))?;
    }

    Ok(())
}

/// Update tray stats display
/// Call this periodically or when usage data changes
pub fn update_tray_stats(app: &AppHandle, tokens: u64, cost: f64) -> Result<(), tauri::Error> {
    // TODO: Update the stats menu item text
    // This requires rebuilding the menu with updated stats
    // For now, just log the stats
    println!("Tray stats update: {} tokens, ${:.2}", tokens, cost);

    // We could rebuild the entire menu here, but that's expensive
    // A better approach would be to use a mutable menu item if Tauri supports it
    // For now, we'll rebuild on demand
    let _ = rebuild_tray_menu(app);

    Ok(())
}

/// Set the current environment and update config file
fn set_current_env_internal(env_name: &str) -> Result<(), String> {
    let mut cfg = config::read_config()?;
    cfg.current = Some(env_name.to_string());
    config::write_config(&cfg)
}

/// Set the current permission mode and update config file
fn set_current_perm_internal(perm_mode: &str) -> Result<(), String> {
    let mut cfg = config::read_config()?;
    cfg.default_mode = Some(perm_mode.to_string());
    config::write_config(&cfg)
}

/// Handle environment switch from tray menu
fn handle_env_switch(app: &AppHandle, env_name: &str) {
    // Update the config file
    match set_current_env_internal(env_name) {
        Ok(_) => {
            println!("Switched to environment: {}", env_name);

            // Emit event to frontend
            let _ = app.emit(
                "env-changed",
                EnvChangedPayload {
                    env: env_name.to_string(),
                },
            );

            // Rebuild tray menu to show updated selection
            if let Err(e) = rebuild_tray_menu(app) {
                eprintln!("Failed to rebuild tray menu: {}", e);
            }
        }
        Err(e) => {
            eprintln!("Failed to switch environment: {}", e);
        }
    }
}

/// Handle permission mode switch from tray menu
fn handle_perm_switch(app: &AppHandle, perm_mode: &str) {
    // Update the config file
    match set_current_perm_internal(perm_mode) {
        Ok(_) => {
            println!("Switched to permission mode: {}", perm_mode);

            // Emit event to frontend
            let _ = app.emit(
                "perm-changed",
                PermChangedPayload {
                    perm: perm_mode.to_string(),
                },
            );

            // Rebuild tray menu to show updated selection
            if let Err(e) = rebuild_tray_menu(app) {
                eprintln!("Failed to rebuild tray menu: {}", e);
            }
        }
        Err(e) => {
            eprintln!("Failed to switch permission mode: {}", e);
        }
    }
}

/// Handle session focus from tray menu
fn handle_session_focus(app: &AppHandle, session_id: &str) {
    // Get the SessionManager from app state
    let manager = match app.try_state::<Arc<SessionManager>>() {
        Some(m) => m,
        None => {
            eprintln!("SessionManager not found in app state");
            return;
        }
    };

    // Find the session
    let session = match manager.get_session(session_id) {
        Some(s) => s,
        None => {
            eprintln!("Session not found: {}", session_id);
            return;
        }
    };

    // Get terminal info from session
    let terminal_type = match session.terminal_type.as_ref() {
        Some(t) => match t.as_str() {
            "iterm2" => terminal::TerminalType::ITerm2,
            "terminalapp" => terminal::TerminalType::TerminalApp,
            _ => {
                eprintln!("Unknown terminal type: {}", t);
                return;
            }
        },
        None => {
            eprintln!("Session has no terminal type");
            return;
        }
    };

    let window_id = match session.window_id.as_ref() {
        Some(id) => id,
        None => {
            eprintln!("Session has no window ID");
            return;
        }
    };

    // Focus the terminal window
    if let Err(e) = terminal::focus_terminal_window(terminal_type, window_id) {
        eprintln!("Failed to focus terminal window: {}", e);
    } else {
        println!("Focused session: {}", session_id);
    }
}
