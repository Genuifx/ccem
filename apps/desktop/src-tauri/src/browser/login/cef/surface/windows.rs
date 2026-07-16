use super::{
    diagnostic_url, run_cancellable_on_main, should_retire_surface_without_browser,
    validate_surface_id, CefSurfaceConnection, CefSurfaceLifecycle, CefSurfaceOpenSpec,
    HostShortcutKeyboardHandler, NativeChildBounds, SharedSurfaceState,
};
use crate::browser::login::cef::{
    devtools_bridge::{CefDevToolsBridge, CefDevToolsObserver},
    pump::CefExternalPump,
};
use cef::*;
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use windows::Win32::{
    Foundation::HWND,
    UI::WindowsAndMessaging::{GetParent, IsWindow, WS_VISIBLE},
};

mod mutation;
mod popup;
mod util;

pub(crate) use mutation::{native_window_observation, set_bounds, set_visible};

pub(super) use util::{
    cef_hwnd, destroy_cef_child, inspect_child_window, position_window, prepare_profile_path,
    set_window_visible, win32_hwnd,
};

const DEVTOOLS_DISPATCH_TIMEOUT: Duration = Duration::from_secs(5);
const SURFACE_CLOSE_TIMEOUT: Duration = Duration::from_secs(8);

thread_local! {
    static SURFACES: RefCell<HashMap<String, NativeCefSurface>> = RefCell::new(HashMap::new());
    static CEF_UI_THREAD: Cell<bool> = const { Cell::new(false) };
}

struct NativeCefSurface {
    context: Option<RequestContext>,
    browser: Option<Browser>,
    registration: Option<Registration>,
    shared: Arc<SharedSurfaceState>,
    parent: HWND,
    bounds: NativeChildBounds,
    visible: bool,
    close_requested: bool,
    primary_closed: bool,
    popup: Option<popup::NativeCefPopup>,
}

pub(crate) fn mark_owner_thread() -> Result<(), String> {
    CEF_UI_THREAD.with(|owner| {
        if owner.replace(true) {
            return Err("CEF Windows UI thread is already registered".to_string());
        }
        Ok(())
    })
}

pub(crate) fn clear_owner_thread() {
    CEF_UI_THREAD.with(|owner| owner.set(false));
}

pub(crate) fn is_owner_thread() -> bool {
    CEF_UI_THREAD.with(Cell::get)
}

fn record_error(shared: &Arc<SharedSurfaceState>, message: impl Into<String>) {
    let message = message.into();
    eprintln!("CEF Windows surface failure: {message}");
    shared.record_error(message);
}

fn record_creation_failure(shared: &Arc<SharedSurfaceState>, message: impl Into<String>) {
    let message = message.into();
    eprintln!("CEF Windows surface creation failure: {message}");
    shared.fail_creation(message);
}

fn record_recoverable_load_error(shared: &Arc<SharedSurfaceState>, current_url: String, code: i32) {
    let message = format!(
        "CEF main-frame load failed ({code}) at {}",
        diagnostic_url(&current_url),
    );
    eprintln!("CEF surface failure: {message}");
    shared.record_recoverable_load_error(current_url, message);
}

fn defer_surface_close(app: &AppHandle, surface_id: &str, shared: &Arc<SharedSurfaceState>) {
    let surface_id = surface_id.to_string();
    let shared_for_close = Arc::clone(shared);
    if let Err(error) = app.run_on_main_thread(move || {
        if let Err(error) = close(&surface_id) {
            record_error(
                &shared_for_close,
                format!("deferred CEF Windows surface close failed: {error}"),
            );
        }
    }) {
        record_error(
            shared,
            format!("schedule deferred CEF Windows surface close: {error}"),
        );
    }
}

fn finalize_surface_if_terminal(surface_id: &str, shared: &Arc<SharedSurfaceState>) {
    let removed = SURFACES.with(|surfaces| {
        let mut surfaces = surfaces.borrow_mut();
        let terminal = surfaces
            .get(surface_id)
            .is_some_and(|surface| surface.primary_closed && surface.popup.is_none());
        terminal.then(|| surfaces.remove(surface_id)).flatten()
    });
    let Some(mut surface) = removed else {
        return;
    };
    surface.registration.take();
    surface.browser.take();
    surface.context.take();
    drop(surface);
    shared.update(|state| {
        state.lifecycle = CefSurfaceLifecycle::Closed;
        state.devtools_attached = false;
        state.visible = false;
        state.popup = None;
        state.user_popups_allowed = false;
    });
}

wrap_dev_tools_message_observer! {
    struct SurfaceDevToolsObserver {
        shared: Arc<SharedSurfaceState>,
        observer: Arc<CefDevToolsObserver>,
    }

    impl DevToolsMessageObserver {
        fn on_dev_tools_message(
            &self,
            _browser: Option<&mut Browser>,
            message: Option<&[u8]>,
        ) -> i32 {
            let Some(message) = message else {
                record_error(&self.shared, "CEF DevTools observer received an empty callback");
                return 1;
            };
            if let Err(error) = self.observer.on_message(message) {
                record_error(
                    &self.shared,
                    format!("CEF DevTools bridge rejected a frame: {}", error.code()),
                );
            }
            1
        }
    }
}

wrap_display_handler! {
    struct SurfaceDisplayHandler {
        shared: Arc<SharedSurfaceState>,
    }

    impl DisplayHandler {
        fn on_title_change(&self, _browser: Option<&mut Browser>, title: Option<&CefString>) {
            let title = title.map(CefString::to_string).filter(|title| !title.is_empty());
            self.shared.update(|state| state.title = title);
        }
    }
}

wrap_load_handler! {
    struct SurfaceLoadHandler {
        shared: Arc<SharedSurfaceState>,
        initial_url: String,
    }

    impl LoadHandler {
        fn on_load_start(
            &self,
            _browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            _transition_type: TransitionType,
        ) {
            let Some(frame) = frame else { return };
            if frame.is_main() != 1 {
                return;
            }
            let url = CefString::from(&frame.url()).to_string();
            self.shared.update(|state| {
                if !matches!(
                    state.lifecycle,
                    CefSurfaceLifecycle::Closing | CefSurfaceLifecycle::Closed
                ) {
                    state.lifecycle = CefSurfaceLifecycle::Loading;
                    state.current_url = url;
                    state.error = None;
                }
            });
        }

        fn on_load_end(
            &self,
            _browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            _http_status_code: i32,
        ) {
            let Some(frame) = frame else { return };
            if frame.is_main() != 1 {
                return;
            }
            let url = CefString::from(&frame.url()).to_string();
            if url == "about:blank" && self.initial_url != "about:blank" {
                return;
            }
            self.shared.update(|state| {
                state.current_url = url;
                if !matches!(
                    state.lifecycle,
                    CefSurfaceLifecycle::Closing | CefSurfaceLifecycle::Closed
                ) {
                    state.lifecycle = CefSurfaceLifecycle::Ready;
                    state.error = None;
                }
            });
        }

        fn on_load_error(
            &self,
            _browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            error_code: Errorcode,
            error_text: Option<&CefString>,
            failed_url: Option<&CefString>,
        ) {
            if !frame.is_some_and(|frame| frame.is_main() == 1) {
                return;
            }
            let code = sys::cef_errorcode_t::from(error_code) as i32;
            if code == sys::cef_errorcode_t::ERR_ABORTED as i32 {
                return;
            }
            let _ = error_text;
            record_recoverable_load_error(
                &self.shared,
                failed_url.map(CefString::to_string).unwrap_or_default(),
                code,
            );
        }
    }
}

wrap_life_span_handler! {
    struct SurfaceLifeSpanHandler {
        surface_id: String,
        parent: HWND,
        app: AppHandle,
        shared: Arc<SharedSurfaceState>,
        observer: Arc<CefDevToolsObserver>,
    }

    impl LifeSpanHandler {
        fn on_before_popup(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            popup_id: i32,
            target_url: Option<&CefString>,
            _target_frame_name: Option<&CefString>,
            target_disposition: WindowOpenDisposition,
            user_gesture: i32,
            _popup_features: Option<&PopupFeatures>,
            window_info: Option<&mut WindowInfo>,
            client: Option<&mut Option<Client>>,
            _settings: Option<&mut BrowserSettings>,
            _extra_info: Option<&mut Option<DictionaryValue>>,
            no_javascript_access: Option<&mut i32>,
        ) -> i32 {
            popup::configure_user_popup(
                &self.surface_id,
                self.parent,
                &self.app,
                &self.shared,
                popup_id,
                target_url,
                target_disposition,
                user_gesture,
                window_info,
                client,
                no_javascript_access,
            )
        }

        fn on_before_popup_aborted(&self, _browser: Option<&mut Browser>, popup_id: i32) {
            popup::abort_pending_popup(&self.surface_id, popup_id, &self.shared);
        }

        fn on_after_created(&self, browser: Option<&mut Browser>) {
            let Some(browser) = browser.cloned() else {
                record_creation_failure(&self.shared, "CEF created callback contained no browser");
                return;
            };
            let Some(host) = browser.host() else {
                record_creation_failure(&self.shared, "CEF created browser has no BrowserHost");
                return;
            };

            let (stored, close_now, visible, bounds) = SURFACES.with(|surfaces| {
                let mut surfaces = surfaces.borrow_mut();
                let Some(surface) = surfaces.get_mut(&self.surface_id) else {
                    return (false, false, false, NativeChildBounds { x: 0, y: 0, width: 0, height: 0 });
                };
                surface.browser = Some(browser.clone());
                (true, surface.close_requested, surface.visible, surface.bounds)
            });
            if !stored {
                if !matches!(
                    self.shared.snapshot().lifecycle,
                    CefSurfaceLifecycle::Closing | CefSurfaceLifecycle::Closed
                ) {
                    record_error(&self.shared, "CEF surface registry disappeared during create");
                }
                host.close_browser(1);
                return;
            }
            if close_now {
                self.shared.update(|state| {
                    state.lifecycle = CefSurfaceLifecycle::Closing;
                    state.visible = false;
                });
                defer_surface_close(&self.app, &self.surface_id, &self.shared);
                return;
            }

            let mut observer = SurfaceDevToolsObserver::new(
                Arc::clone(&self.shared),
                Arc::clone(&self.observer),
            );
            let registration = host.add_dev_tools_message_observer(Some(&mut observer));
            if registration.is_none() {
                record_error(&self.shared, "CEF rejected the DevTools observer");
                defer_surface_close(&self.app, &self.surface_id, &self.shared);
                return;
            }

            let child = win32_hwnd(host.window_handle());
            let valid = unsafe { IsWindow(Some(child)).as_bool() };
            let parent_matches = valid
                && unsafe { GetParent(child) }
                    .is_ok_and(|actual| actual == self.parent);
            if !valid || !parent_matches {
                record_error(
                    &self.shared,
                    "CEF child HWND is not attached to the CCEM main client window",
                );
                defer_surface_close(&self.app, &self.surface_id, &self.shared);
                return;
            }
            if let Err(error) = position_window(child, self.parent, bounds) {
                record_error(&self.shared, error);
                defer_surface_close(&self.app, &self.surface_id, &self.shared);
                return;
            }

            let stored = SURFACES.with(|surfaces| {
                let mut surfaces = surfaces.borrow_mut();
                let Some(surface) = surfaces.get_mut(&self.surface_id) else {
                    return false;
                };
                surface.registration = registration;
                true
            });
            if !stored {
                record_error(&self.shared, "CEF registry disappeared while attaching DevTools");
                defer_surface_close(&self.app, &self.surface_id, &self.shared);
                return;
            }
            if let Err(error) = set_window_visible(child, self.parent, bounds, visible) {
                record_error(&self.shared, error);
                defer_surface_close(&self.app, &self.surface_id, &self.shared);
                return;
            }
            self.shared.update(|state| {
                state.lifecycle = CefSurfaceLifecycle::Loading;
                state.devtools_attached = true;
                state.visible = visible;
                state.error = None;
            });
        }

        fn do_close(&self, browser: Option<&mut Browser>) -> i32 {
            if let Some(child) = browser
                .and_then(|browser| browser.host())
                .map(|host| win32_hwnd(host.window_handle()))
                .filter(|child| unsafe { IsWindow(Some(*child)).as_bool() })
            {
                // Returning false would propagate WM_CLOSE to the Tauri top-level HWND.
                // Destroy only CEF's child after Chromium has completed unload handling.
                if let Err(error) = destroy_cef_child(child) {
                    record_error(&self.shared, error);
                }
            }
            1
        }

        fn on_before_close(&self, _browser: Option<&mut Browser>) {
            let retired = SURFACES.with(|surfaces| {
                let mut surfaces = surfaces.borrow_mut();
                let Some(surface) = surfaces.get_mut(&self.surface_id) else {
                    return (None, None, None);
                };
                surface.primary_closed = true;
                surface.close_requested = true;
                let registration = surface.registration.take();
                let primary_browser = surface.browser.take();
                let popup_browser = surface.popup.as_mut().and_then(|popup| {
                    popup.close_requested = true;
                    popup.browser.clone()
                });
                (registration, primary_browser, popup_browser)
            });
            let (registration, primary_browser, popup_browser) = retired;
            drop(registration);
            drop(primary_browser);
            self.shared.deny_popups();
            self.shared.update(|state| {
                state.lifecycle = CefSurfaceLifecycle::Closing;
                state.devtools_attached = false;
                state.visible = false;
            });
            if let Some(browser) = popup_browser {
                if let Some(host) = browser.host() {
                    host.close_browser(1);
                }
            }
            finalize_surface_if_terminal(&self.surface_id, &self.shared);
        }
    }
}

wrap_client! {
    struct SurfaceClient {
        surface_id: String,
        parent: HWND,
        initial_url: String,
        app: AppHandle,
        shared: Arc<SharedSurfaceState>,
        observer: Arc<CefDevToolsObserver>,
    }

    impl Client {
        fn display_handler(&self) -> Option<DisplayHandler> {
            Some(SurfaceDisplayHandler::new(Arc::clone(&self.shared)))
        }

        fn life_span_handler(&self) -> Option<LifeSpanHandler> {
            Some(SurfaceLifeSpanHandler::new(
                self.surface_id.clone(),
                self.parent,
                self.app.clone(),
                Arc::clone(&self.shared),
                Arc::clone(&self.observer),
            ))
        }

        fn keyboard_handler(&self) -> Option<KeyboardHandler> {
            Some(HostShortcutKeyboardHandler::new(self.app.clone(), self.surface_id.clone()))
        }

        fn load_handler(&self) -> Option<LoadHandler> {
            Some(SurfaceLoadHandler::new(
                Arc::clone(&self.shared),
                self.initial_url.clone(),
            ))
        }
    }
}

wrap_request_context_handler! {
    struct SurfaceRequestContextHandler {
        surface_id: String,
        expected_cache_path: PathBuf,
        initial_url: String,
        app: AppHandle,
        shared: Arc<SharedSurfaceState>,
        observer: Arc<CefDevToolsObserver>,
    }

    impl RequestContextHandler {
        fn on_request_context_initialized(&self, request_context: Option<&mut RequestContext>) {
            let Some(request_context) = request_context else {
                record_creation_failure(&self.shared, "CEF RequestContext callback was empty");
                return;
            };
            let actual_raw =
                PathBuf::from(CefString::from(&request_context.cache_path()).to_string());
            let actual = match actual_raw.canonicalize() {
                Ok(actual) => actual,
                Err(error) => {
                    record_creation_failure(
                        &self.shared,
                        format!(
                            "resolve CEF Windows RequestContext path {}: {error}",
                            actual_raw.display()
                        ),
                    );
                    return;
                }
            };
            if actual != self.expected_cache_path
                || actual.parent() != self.expected_cache_path.parent()
            {
                record_creation_failure(
                    &self.shared,
                    format!(
                        "CEF RequestContext escaped its Windows profile path: expected={} actual={}",
                        self.expected_cache_path.display(),
                        actual.display(),
                    ),
                );
                return;
            }

            let Some(main_window) = self.app.get_webview_window("main") else {
                record_creation_failure(&self.shared, "CCEM main window disappeared before CEF attach");
                return;
            };
            let parent = match main_window.hwnd() {
                Ok(parent) => parent,
                Err(error) => {
                    record_creation_failure(
                        &self.shared,
                        format!("resolve CCEM main HWND during CEF attach: {error}"),
                    );
                    return;
                }
            };
            if !unsafe { IsWindow(Some(parent)).as_bool() } {
                record_creation_failure(&self.shared, "CCEM main HWND is invalid during CEF attach");
                return;
            }
            let surface_intent = SURFACES.with(|surfaces| {
                surfaces.borrow().get(&self.surface_id).map(|surface| {
                    (
                        surface.parent,
                        surface.bounds,
                        surface.visible,
                        surface.close_requested,
                    )
                })
            });
            let Some((expected_parent, bounds, visible, close_requested)) = surface_intent else {
                if matches!(
                    self.shared.snapshot().lifecycle,
                    CefSurfaceLifecycle::Closing | CefSurfaceLifecycle::Closed
                ) {
                    return;
                }
                record_creation_failure(
                    &self.shared,
                    "CEF surface registry disappeared before BrowserHost creation",
                );
                return;
            };
            if parent != expected_parent {
                record_creation_failure(&self.shared, "CCEM main HWND changed during CEF attach");
                return;
            }
            if close_requested {
                let removed = SURFACES.with(|surfaces| surfaces.borrow_mut().remove(&self.surface_id));
                drop(removed);
                self.shared.update(|state| {
                    state.lifecycle = CefSurfaceLifecycle::Closed;
                    state.visible = false;
                });
                return;
            }

            let rect = Rect {
                x: bounds.x,
                y: bounds.y,
                width: bounds.width,
                height: bounds.height,
            };
            let mut window_info = WindowInfo {
                runtime_style: RuntimeStyle::ALLOY,
                ..Default::default()
            }
            .set_as_child(cef_hwnd(parent), &rect);
            if !visible {
                // cef-rs set_as_child adds WS_VISIBLE. Remove it before native
                // creation so the acquire phase cannot flash ahead of lease sync.
                window_info.style &= !WS_VISIBLE.0;
            }
            let mut client = SurfaceClient::new(
                self.surface_id.clone(),
                parent,
                self.initial_url.clone(),
                self.app.clone(),
                Arc::clone(&self.shared),
                Arc::clone(&self.observer),
            );
            let target_url = CefString::from(self.initial_url.as_str());
            let bootstrap_url = CefString::from("about:blank");
            let browser = browser_host_create_browser_sync(
                Some(&window_info),
                Some(&mut client),
                Some(&bootstrap_url),
                Some(&BrowserSettings::default()),
                None,
                Some(request_context),
            );
            let Some(browser) = browser else {
                record_creation_failure(&self.shared, "CEF failed to create a child HWND BrowserHost");
                return;
            };
            let Some(frame) = browser.main_frame() else {
                record_error(&self.shared, "CEF Windows child browser has no main frame");
                defer_surface_close(&self.app, &self.surface_id, &self.shared);
                return;
            };
            frame.load_url(Some(&target_url));
        }
    }
}

pub(crate) fn create_surface(
    app: &AppHandle,
    profile_root: &Path,
    spec: CefSurfaceOpenSpec,
) -> Result<CefSurfaceConnection, String> {
    require_main_thread()?;
    validate_surface_id(&spec.surface_id)?;
    if spec.initial_url.trim().is_empty() {
        return Err("CEF surface initial URL is empty".to_string());
    }
    if spec.parent_view == 0 || spec.bounds.width <= 0 || spec.bounds.height <= 0 {
        return Err("CEF surface parent or bounds are invalid".to_string());
    }
    if !spec.persistent_profile_storage {
        return Err("Windows Mode 2 requires an isolated persistent profile".to_string());
    }
    let parent = HWND(spec.parent_view as *mut _);
    if !unsafe { IsWindow(Some(parent)).as_bool() } {
        return Err("CEF surface parent HWND is invalid".to_string());
    }
    let profile_path = prepare_profile_path(profile_root, &spec.profile_id)?;
    if SURFACES.with(|surfaces| surfaces.borrow().contains_key(&spec.surface_id)) {
        return Err(format!("CEF surface {} already exists", spec.surface_id));
    }

    let dispatch_app = app.clone();
    let dispatch_surface_id = spec.surface_id.clone();
    let bridge = CefDevToolsBridge::new(move |message| {
        send_devtools_message(&dispatch_app, dispatch_surface_id.clone(), message)
    });
    let (reader, writer, observer) = bridge.into_parts();
    let observer = Arc::new(observer);
    let shared = SharedSurfaceState::new(&spec);
    SURFACES.with(|surfaces| {
        surfaces.borrow_mut().insert(
            spec.surface_id.clone(),
            NativeCefSurface {
                context: None,
                browser: None,
                registration: None,
                shared: Arc::clone(&shared),
                parent,
                bounds: spec.bounds,
                visible: spec.visible,
                close_requested: false,
                primary_closed: false,
                popup: None,
            },
        );
    });

    let context_settings = RequestContextSettings {
        cache_path: CefString::from(profile_path.to_string_lossy().as_ref()),
        persist_session_cookies: 1,
        accept_language_list: CefString::from("zh-CN,zh,en-US,en"),
        ..Default::default()
    };
    let mut handler = SurfaceRequestContextHandler::new(
        spec.surface_id.clone(),
        profile_path,
        spec.initial_url,
        app.clone(),
        Arc::clone(&shared),
        observer,
    );
    let context = request_context_create_context(Some(&context_settings), Some(&mut handler));
    let Some(context) = context else {
        let removed = SURFACES.with(|surfaces| surfaces.borrow_mut().remove(&spec.surface_id));
        drop(removed);
        shared.fail_creation("CEF failed to allocate an isolated Windows RequestContext");
        return Err("CEF failed to allocate an isolated Windows RequestContext".to_string());
    };
    SURFACES.with(|surfaces| {
        if let Some(surface) = surfaces.borrow_mut().get_mut(&spec.surface_id) {
            surface.context = Some(context);
        }
    });
    Ok(CefSurfaceConnection {
        reader,
        writer,
        shared,
    })
}

pub(crate) fn navigate(surface_id: &str, url: &str) -> Result<(), String> {
    require_main_thread()?;
    if url.trim().is_empty() {
        return Err("CEF navigation URL is empty".to_string());
    }
    with_surface(surface_id, |surface| {
        if surface.popup.is_some() {
            return Err("Close the Login Browser popup before navigating the opener.".to_string());
        }
        let browser = surface
            .browser
            .as_ref()
            .ok_or_else(|| "CEF surface is not ready".to_string())?;
        let frame = browser
            .main_frame()
            .ok_or_else(|| "CEF child browser has no main frame".to_string())?;
        surface.shared.update(|state| {
            if !matches!(
                state.lifecycle,
                CefSurfaceLifecycle::Closing | CefSurfaceLifecycle::Closed
            ) {
                state.lifecycle = CefSurfaceLifecycle::Loading;
                state.error = None;
            }
        });
        frame.load_url(Some(&CefString::from(url)));
        Ok(())
    })
}

pub(crate) fn snapshot(surface_id: &str) -> Result<super::CefSurfaceSnapshot, String> {
    require_main_thread()?;
    with_surface(surface_id, |surface| Ok(surface.shared.snapshot()))
}

pub(crate) fn close(surface_id: &str) -> Result<(), String> {
    require_main_thread()?;
    let (browser, popup_browser, parent, bounds, shared, remove_without_browser) =
        SURFACES.with(|surfaces| {
            let mut surfaces = surfaces.borrow_mut();
            let surface = surfaces
                .get_mut(surface_id)
                .ok_or_else(|| format!("CEF surface {surface_id} does not exist"))?;
            surface.close_requested = true;
            surface.visible = false;
            if let Some(popup) = surface.popup.as_mut() {
                popup.close_requested = true;
            }
            let remove_without_browser = should_retire_surface_without_browser(
                surface.browser.is_some(),
                surface.popup.is_some(),
            );
            surface.shared.update(|state| {
                if state.lifecycle != CefSurfaceLifecycle::Closed {
                    state.lifecycle = CefSurfaceLifecycle::Closing;
                }
                state.visible = false;
            });
            Ok::<_, String>((
                surface.browser.clone(),
                surface
                    .popup
                    .as_ref()
                    .and_then(|popup| popup.browser.clone()),
                surface.parent,
                surface.bounds,
                Arc::clone(&surface.shared),
                remove_without_browser,
            ))
        })?;
    shared.deny_popups();

    if remove_without_browser {
        let removed = SURFACES.with(|surfaces| surfaces.borrow_mut().remove(surface_id));
        drop(removed);
        shared.update(|state| {
            state.lifecycle = CefSurfaceLifecycle::Closed;
            state.visible = false;
            state.popup = None;
            state.user_popups_allowed = false;
        });
        return Ok(());
    }
    let mut visibility_errors = Vec::new();
    if let Some(host) = popup_browser.and_then(|browser| browser.host()) {
        if let Err(error) =
            set_window_visible(win32_hwnd(host.window_handle()), parent, bounds, false)
        {
            visibility_errors.push(error);
        }
        host.close_browser(1);
    }
    if let Some(browser) = browser {
        if let Some(host) = browser.host() {
            if let Err(error) =
                set_window_visible(win32_hwnd(host.window_handle()), parent, bounds, false)
            {
                visibility_errors.push(error);
            }
            host.close_browser(1);
        } else {
            visibility_errors.push("CEF BrowserHost is unavailable".to_string());
        }
    }
    if visibility_errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "CEF child HWND hide verification failed while closing: {}",
            visibility_errors.join("; ")
        ))
    }
}

pub(crate) fn close_popup(surface_id: &str) -> Result<(), String> {
    popup::close_popup(surface_id)
}

pub(crate) fn shutdown_all(pump: &CefExternalPump) -> Result<(), String> {
    require_main_thread()?;
    let ids = SURFACES.with(|surfaces| surfaces.borrow().keys().cloned().collect::<Vec<_>>());
    let mut close_errors = Vec::new();
    for id in &ids {
        if let Err(error) = close(id) {
            close_errors.push(format!("{id}: {error}"));
        }
    }
    pump.begin_draining();
    let deadline = Instant::now() + SURFACE_CLOSE_TIMEOUT;
    while !all_surfaces_closed() && Instant::now() < deadline {
        pump.do_message_loop_work();
        thread::sleep(Duration::from_millis(1));
    }
    if !all_surfaces_closed() {
        let close_context = if close_errors.is_empty() {
            String::new()
        } else {
            format!("; close errors: {}", close_errors.join("; "))
        };
        let remaining = SURFACES.with(|surfaces| {
            surfaces
                .borrow()
                .iter()
                .map(|(id, surface)| format!("{id}:{:?}", surface.shared.snapshot().lifecycle))
                .collect::<Vec<_>>()
                .join(",")
        });
        return Err(format!(
            "CEF Windows surfaces did not close before the shutdown deadline: {remaining}{close_context}"
        ));
    }
    if !close_errors.is_empty() {
        eprintln!(
            "CEF Windows shutdown drained after verified-hide errors: {}",
            close_errors.join("; ")
        );
    }
    Ok(())
}

fn send_devtools_message(
    app: &AppHandle,
    surface_id: String,
    message: Vec<u8>,
) -> Result<(), String> {
    run_cancellable_on_main(
        app,
        is_owner_thread(),
        DEVTOOLS_DISPATCH_TIMEOUT,
        "CEF DevTools main-thread dispatch",
        move || send_devtools_message_on_main(&surface_id, &message),
    )
}

fn send_devtools_message_on_main(surface_id: &str, message: &[u8]) -> Result<(), String> {
    require_main_thread()?;
    with_surface(surface_id, |surface| {
        let browser = surface
            .browser
            .as_ref()
            .ok_or_else(|| "CEF surface is not ready".to_string())?;
        let host = browser
            .host()
            .ok_or_else(|| "CEF BrowserHost is unavailable".to_string())?;
        if host.send_dev_tools_message(Some(message)) != 1 {
            return Err("CEF rejected a DevTools message".to_string());
        }
        Ok(())
    })
}

fn all_surfaces_closed() -> bool {
    SURFACES.with(|surfaces| surfaces.borrow().is_empty())
}

fn require_main_thread() -> Result<(), String> {
    is_owner_thread()
        .then_some(())
        .ok_or_else(|| "CEF native surface operation must run on the Windows UI thread".to_string())
}

fn with_surface<T>(
    surface_id: &str,
    operation: impl FnOnce(&NativeCefSurface) -> Result<T, String>,
) -> Result<T, String> {
    SURFACES.with(|surfaces| {
        let surfaces = surfaces.borrow();
        let surface = surfaces
            .get(surface_id)
            .ok_or_else(|| format!("CEF surface {surface_id} does not exist"))?;
        operation(surface)
    })
}
