//! Opt-in native regression fixture. Uses one fixed local test page and profile;
//! never exposes arbitrary CDP or browser access to remote web content.
use crate::browser::login::cef::{
    host::CefHostController,
    surface::{run_cancellable_on_main, CefSurfaceConnection, CefSurfaceRequest, LogicalViewport},
};
use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, WebviewWindow};

const SURFACE: &str = "react-overlay-smoke";
#[derive(Default)]
pub(crate) struct SmokeState(Arc<Mutex<Option<CefSurfaceConnection>>>);

#[tauri::command]
pub(crate) async fn browser_overlay_debug(
    app: AppHandle,
    window: WebviewWindow,
    host: tauri::State<'_, Arc<CefHostController>>,
    state: tauri::State<'_, SmokeState>,
    frontend_document_id: String,
    frontend_generation: u64,
    action: String,
    bounds: Option<super::OverlayRect>,
    point: Option<[f64; 2]>,
) -> Result<Value, String> {
    super::require_main(&window)?;
    if std::env::var("CCEM_REACT_OVERLAY_SMOKE").as_deref() != Ok("1") {
        return Err("React overlay smoke is disabled".into());
    }
    let host = Arc::clone(&host);
    let connection = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || {
        crate::webcontent_recovery::with_frontend_browser_document(&app, &frontend_document_id, frontend_generation, || {
            let viewport = || {
                let bounds = bounds.filter(|bounds| bounds.valid()).ok_or("Invalid smoke bounds")?;
                Ok::<_, String>(LogicalViewport { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height })
            };
            match action.as_str() {
                "start" => {
                    let mut connection = connection.lock().map_err(|error| error.to_string())?;
                    if connection.is_some() { return Err("Smoke surface already exists".into()); }
                    let url = app.config().build.dev_url.as_ref().ok_or("Smoke requires dev URL")?
                        .join("/test/fixtures/native-overlay-probe.html").map_err(|error| error.to_string())?;
                    let opened = host.open_surface(&app, CefSurfaceRequest {
                        surface_id: SURFACE.into(), profile_id: "profile-00000000000000000000000000000002".into(),
                        initial_url: url.into(), viewport: viewport()?, visible: true,
                    })?;
                    opened.wait_until_ready(Duration::from_secs(25))?;
                    opened.state_handle().allow_user_popups().map_err(|error| format!("Enable fixture popups: {error:?}"))?;
                    *connection = Some(opened);
                }
                "resize" => host.set_surface_viewport(&app, SURFACE.into(), viewport()?)?,
                "occlude" => host.occlude_surface(&app, SURFACE.into())?,
                "show" => host.set_surface_visible(&app, SURFACE.into(), true)?,
                "hide" => host.set_surface_visible(&app, SURFACE.into(), false)?,
                "close_popup" => host.close_popup(&app, SURFACE.into())?,
                "focus" => run_cancellable_on_main(&app, false, Duration::from_secs(5), "focus smoke browser", || {
                    crate::browser::login::cef::surface::macos::debug_focus(SURFACE)
                })?,
                "probe" => {
                    let [x, y] = point.filter(|point| point.iter().all(|v| v.is_finite())).ok_or("Invalid probe point")?;
                    return run_cancellable_on_main(&app, false, Duration::from_secs(5), "probe native overlay hit test", move || super::macos::probe_point(x, y));
                }
                "close" => {
                    host.close_surface(&app, SURFACE.into())?;
                    connection.lock().map_err(|error| error.to_string())?.take();
                    return Ok(json!({"closed": true}));
                }
                "status" => {}
                _ => return Err("Unknown smoke action".into()),
            }
            let snapshot = host.surface_snapshot(&app, SURFACE.into())?;
            Ok(json!({"surfaceId": snapshot.surface_id, "visible": snapshot.visible,
                "title": snapshot.title, "lifecycle": format!("{:?}", snapshot.lifecycle), "error": snapshot.error,
                "popup": snapshot.popup.map(|popup| json!({"id": popup.popup_id, "title": popup.title, "lifecycle": format!("{:?}", popup.lifecycle)}))}))
        })
    }).await.map_err(|error| error.to_string())?
}
