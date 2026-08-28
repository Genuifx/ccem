use super::{
    diagnostic_url, profile_cache_path, run_cancellable_on_main,
    should_retire_surface_without_browser, validate_surface_id, CefSurfaceConnection,
    CefSurfaceLifecycle, CefSurfaceOpenSpec, HostShortcutKeyboardHandler, NativeChildBounds,
    SharedSurfaceState, SurfaceRequestHandler,
};
use crate::browser::login::cef::{
    devtools_bridge::{CefDevToolsBridge, CefDevToolsObserver},
    pump::CefExternalPump,
};
use cef::*;
use cef_objc2::MainThreadMarker;
use cef_objc2_app_kit::NSView;
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

mod mutation;
mod popup;

pub(crate) use mutation::{occlude, set_bounds, set_visible};

const DEVTOOLS_DISPATCH_TIMEOUT: Duration = Duration::from_secs(5);
const SURFACE_CLOSE_TIMEOUT: Duration = Duration::from_secs(8);

thread_local! {
    static SURFACES: RefCell<HashMap<String, NativeCefSurface>> = RefCell::new(HashMap::new());
    static PROFILE_CONTEXTS: RefCell<HashMap<String, ProfileRequestContextGroup>> = RefCell::new(HashMap::new());
}

/// CEF requires an anchor RequestContext for each Profile. Additional Browser instances get
/// distinct sibling contexts created with `create_context_shared`, so their browser runtimes
/// remain independent while cookies/local storage/cache are intentionally shared. Interactive
/// debug and release anchors use the Profile's persistent cache path; isolated debug smoke tests
/// opt into an ephemeral host before reaching this layer.
struct ProfileRequestContextGroup {
    anchor: RequestContext,
    members: HashSet<String>,
}

struct NativeCefSurface {
    profile_id: String,
    context: Option<RequestContext>,
    browser: Option<Browser>,
    registration: Option<Registration>,
    shared: Arc<SharedSurfaceState>,
    bounds: NativeChildBounds,
    visible: bool,
    close_requested: bool,
    primary_closed: bool,
    popup: Option<popup::NativeCefPopup>,
}

fn release_profile_context_member(profile_id: &str, surface_id: &str) {
    let removed = PROFILE_CONTEXTS.with(|contexts| {
        let mut contexts = contexts.borrow_mut();
        let empty = match contexts.get_mut(profile_id) {
            Some(group) => {
                group.members.remove(surface_id);
                group.members.is_empty()
            }
            None => false,
        };
        empty.then(|| contexts.remove(profile_id)).flatten()
    });
    drop(removed);
}

fn retire_surface(mut surface: NativeCefSurface) {
    let profile_id = surface.profile_id.clone();
    let surface_id = surface.shared.snapshot().surface_id;
    surface.registration.take();
    surface.browser.take();
    surface.context.take();
    drop(surface);
    release_profile_context_member(&profile_id, &surface_id);
}

fn record_error(shared: &Arc<SharedSurfaceState>, message: impl Into<String>) {
    let message = message.into();
    eprintln!("CEF surface failure: {message}");
    shared.record_error(message);
}

fn record_creation_failure(shared: &Arc<SharedSurfaceState>, message: impl Into<String>) {
    let message = message.into();
    eprintln!("CEF surface creation failure: {message}");
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
                format!("deferred CEF surface close failed: {error}"),
            );
        }
    }) {
        record_error(
            shared,
            format!("schedule deferred CEF surface close: {error}"),
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
    let Some(surface) = removed else {
        return;
    };
    // Drop CEF values only after releasing the thread-local registry borrow.
    retire_surface(surface);
    shared.clear_focus_restore_intent();
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
            self.shared.begin_main_frame_load(url);
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
            // browser_host_create_browser_sync starts from about:blank and the target
            // navigation is issued explicitly once the BrowserHost exists. Never publish
            // that bootstrap document as the requested page being ready.
            if url == "about:blank" && self.initial_url != "about:blank" {
                return;
            }
            self.shared.finish_main_frame_load(url);
        }

        fn on_load_error(
            &self,
            _browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            error_code: Errorcode,
            error_text: Option<&CefString>,
            failed_url: Option<&CefString>,
        ) {
            if frame.is_none_or(|frame| frame.is_main() != 1) {
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
        parent_view: usize,
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
                self.parent_view,
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
                record_creation_failure(
                    &self.shared,
                    "CEF created callback did not contain a browser",
                );
                return;
            };
            let Some(host) = browser.host() else {
                record_creation_failure(&self.shared, "CEF created browser has no BrowserHost");
                return;
            };

            // Register the real browser before any validation that may need to close it.
            // The RefCell borrow is released before calling any CEF method because
            // close_browser may synchronously enter DoClose/OnBeforeClose.
            let (stored, close_now, visible) = SURFACES.with(|surfaces| {
                let mut surfaces = surfaces.borrow_mut();
                let Some(surface) = surfaces.get_mut(&self.surface_id) else {
                    return (false, false, false);
                };
                surface.browser = Some(browser.clone());
                (true, surface.close_requested, surface.visible)
            });
            if !stored {
                if !matches!(
                    self.shared.snapshot().lifecycle,
                    CefSurfaceLifecycle::Closing | CefSurfaceLifecycle::Closed
                ) {
                    record_error(
                        &self.shared,
                        "CEF surface registry entry disappeared during create",
                    );
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

            let child = host.window_handle().cast::<NSView>();
            let Some(child) = (unsafe { child.as_ref() }) else {
                record_error(&self.shared, "CEF BrowserHost did not expose its child NSView");
                defer_surface_close(&self.app, &self.surface_id, &self.shared);
                return;
            };
            let Some(parent) = (unsafe { (self.parent_view as *mut NSView).as_ref() }) else {
                record_error(&self.shared, "CCEM main content NSView is unavailable");
                defer_surface_close(&self.app, &self.surface_id, &self.shared);
                return;
            };
            let parent_matches = unsafe { child.superview() }
                .as_deref()
                .is_some_and(|actual| std::ptr::eq(actual, parent));
            if !parent_matches {
                record_error(&self.shared, "CEF child NSView is not attached to CCEM contentView");
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
                record_error(
                    &self.shared,
                    "CEF surface registry entry disappeared while registering DevTools",
                );
                defer_surface_close(&self.app, &self.surface_id, &self.shared);
                return;
            }
            child.setHidden(!visible);
            self.shared.update(|state| {
                state.lifecycle = CefSurfaceLifecycle::Loading;
                state.devtools_attached = true;
                state.visible = visible;
                state.error = None;
            });
        }

        fn do_close(&self, browser: Option<&mut Browser>) -> i32 {
            let child = browser
                .and_then(|browser| browser.host())
                .map(|host| host.window_handle().cast::<NSView>())
                .and_then(|child| unsafe { child.as_ref() });
            if let Some(child) = child {
                // This is a windowed child. Returning false would make CEF send
                // performClose: to the top-level Tauri window. Tear down only the
                // CEF child and report the close notification as handled.
                child.removeFromSuperview();
                1
            } else {
                record_error(&self.shared, "CEF child NSView was missing during close");
                // Never propagate performClose: to the top-level Tauri window.
                1
            }
        }

        fn on_before_close(&self, _browser: Option<&mut Browser>) {
            // A shared RequestContext may retain its handler after this Browser closes.
            // Explicitly end only this surface's reader instead of waiting for every
            // sender reference in the shared Profile to be destroyed.
            self.observer.close();
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
            // CEF reference-counted values may run callbacks while dropping.
            // Never destroy them while the SURFACES RefCell is borrowed.
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
        parent_view: usize,
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
                self.parent_view,
                self.app.clone(),
                Arc::clone(&self.shared),
                Arc::clone(&self.observer),
            ))
        }

        fn keyboard_handler(&self) -> Option<KeyboardHandler> {
            Some(HostShortcutKeyboardHandler::new(self.app.clone(), self.surface_id.clone()))
        }

        fn request_handler(&self) -> Option<RequestHandler> {
            Some(SurfaceRequestHandler::new(Arc::clone(&self.shared)))
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
        expected_cache_path: Option<PathBuf>,
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
            let actual = PathBuf::from(CefString::from(&request_context.cache_path()).to_string());
            let cache_path_matches = match self.expected_cache_path.as_ref() {
                Some(expected) => actual == *expected && actual.parent() == expected.parent(),
                None => actual.as_os_str().is_empty(),
            };
            if !cache_path_matches {
                record_creation_failure(
                    &self.shared,
                    format!(
                        "CEF RequestContext escaped its profile path: expected={} actual={}",
                        self.expected_cache_path
                            .as_ref()
                            .map(|path| path.display().to_string())
                            .unwrap_or_else(|| "<in-memory>".to_string()),
                        actual.display(),
                    ),
                );
                return;
            }

            let Some(main_window) = self.app.get_webview_window("main") else {
                record_creation_failure(&self.shared, "CCEM main window disappeared before CEF attach");
                return;
            };
            let parent_view = match main_window.ns_view() {
                Ok(parent_view) => parent_view,
                Err(error) => {
                    record_creation_failure(
                        &self.shared,
                        format!("resolve CCEM content NSView during CEF attach: {error}"),
                    );
                    return;
                }
            };
            let Some(parent) = (unsafe { parent_view.cast::<NSView>().as_ref() }) else {
                record_creation_failure(&self.shared, "CCEM content NSView is null during CEF attach");
                return;
            };
            // CEF requires externally supplied macOS parent views to be
            // layer-backed so its child view and WKWebView keep deterministic
            // sibling ordering during resize, hide/show, and popup swaps.
            parent.setWantsLayer(true);
            let surface_intent = SURFACES.with(|surfaces| {
                surfaces
                    .borrow()
                    .get(&self.surface_id)
                    .map(|surface| (surface.bounds, surface.close_requested))
            });
            let Some((bounds, close_requested)) = surface_intent else {
                if matches!(
                    self.shared.snapshot().lifecycle,
                    CefSurfaceLifecycle::Closing | CefSurfaceLifecycle::Closed
                ) {
                    return;
                }
                record_creation_failure(
                    &self.shared,
                    "CEF surface registry entry disappeared before BrowserHost creation",
                );
                return;
            };
            if close_requested {
                let removed = SURFACES.with(|surfaces| {
                    surfaces.borrow_mut().remove(&self.surface_id)
                });
                if let Some(surface) = removed {
                    retire_surface(surface);
                }
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
            let window_info = WindowInfo {
                runtime_style: RuntimeStyle::ALLOY,
                ..Default::default()
            }
            .set_as_child(parent_view, &rect);
            let mut client = SurfaceClient::new(
                self.surface_id.clone(),
                parent_view as usize,
                self.initial_url.clone(),
                self.app.clone(),
                Arc::clone(&self.shared),
                Arc::clone(&self.observer),
            );
            let url = CefString::from(self.initial_url.as_str());
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
                record_creation_failure(
                    &self.shared,
                    "CEF failed to create a windowed child BrowserHost",
                );
                return;
            };
            let Some(frame) = browser.main_frame() else {
                record_error(&self.shared, "CEF child browser has no main frame");
                defer_surface_close(&self.app, &self.surface_id, &self.shared);
                return;
            };
            // An explicit navigation after synchronous creation removes an intermittent initial
            // navigation stall observed in the RequestContext + DevTools production spike.
            frame.load_url(Some(&url));
        }
    }
}

pub(crate) fn create_surface(
    app: &AppHandle,
    profile_root: &Path,
    spec: CefSurfaceOpenSpec,
) -> Result<CefSurfaceConnection, String> {
    if MainThreadMarker::new().is_none() {
        return Err("CEF surface creation must run on the AppKit main thread".to_string());
    }
    validate_surface_id(&spec.surface_id)?;
    if spec.initial_url.trim().is_empty() {
        return Err("CEF surface initial URL is empty".to_string());
    }
    if spec.parent_view == 0 || spec.bounds.width <= 0 || spec.bounds.height <= 0 {
        return Err("CEF surface parent or bounds are invalid".to_string());
    }
    let profile_path = spec
        .persistent_profile_storage
        .then(|| prepare_profile_path(profile_root, &spec.profile_id))
        .transpose()?;
    let exists = SURFACES.with(|surfaces| surfaces.borrow().contains_key(&spec.surface_id));
    if exists {
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
                profile_id: spec.profile_id.clone(),
                context: None,
                browser: None,
                registration: None,
                shared: Arc::clone(&shared),
                bounds: spec.bounds,
                visible: spec.visible,
                close_requested: false,
                primary_closed: false,
                popup: None,
            },
        );
    });

    let context_settings = RequestContextSettings {
        cache_path: profile_path
            .as_ref()
            .map(|path| CefString::from(path.to_string_lossy().as_ref()))
            .unwrap_or_default(),
        persist_session_cookies: i32::from(spec.persistent_profile_storage),
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
    let context = PROFILE_CONTEXTS.with(|contexts| -> Result<RequestContext, String> {
        let mut contexts = contexts.borrow_mut();
        if let Some(group) = contexts.get_mut(&spec.profile_id) {
            let Some(sibling) = request_context_cef_create_context_shared(
                Some(&mut group.anchor),
                Some(&mut handler),
            ) else {
                return Err("CEF failed to allocate a shared RequestContext".to_string());
            };
            // CEF 150 reports this initialized sibling as IsSame because both wrappers point
            // at the same BrowserContext. IsSharingWith is the storage contract; separate
            // Browser/page state is verified by the real multi-surface smoke.
            if sibling.is_sharing_with(Some(&mut group.anchor)) != 1 {
                return Err("CEF shared RequestContext contract was not satisfied".to_string());
            }
            group.members.insert(spec.surface_id.clone());
            return Ok(sibling);
        }
        let Some(anchor) =
            request_context_create_context(Some(&context_settings), Some(&mut handler))
        else {
            return Err("CEF failed to allocate a Profile anchor RequestContext".to_string());
        };
        let surface_context = anchor.clone();
        let mut members = HashSet::new();
        members.insert(spec.surface_id.clone());
        contexts.insert(
            spec.profile_id.clone(),
            ProfileRequestContextGroup { anchor, members },
        );
        Ok(surface_context)
    });
    let context = match context {
        Ok(context) => context,
        Err(error) => {
            let removed = SURFACES.with(|surfaces| surfaces.borrow_mut().remove(&spec.surface_id));
            if let Some(surface) = removed {
                retire_surface(surface);
            }
            shared.fail_creation(error.clone());
            return Err(error);
        }
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
        surface.shared.begin_navigation()?;
        let url = CefString::from(url);
        frame.load_url(Some(&url));
        Ok(())
    })
}

pub(crate) fn snapshot(surface_id: &str) -> Result<super::CefSurfaceSnapshot, String> {
    require_main_thread()?;
    with_surface(surface_id, |surface| Ok(surface.shared.snapshot()))
}

pub(crate) fn close(surface_id: &str) -> Result<(), String> {
    require_main_thread()?;
    let (browser, popup_browser, shared, remove_without_browser) = SURFACES.with(|surfaces| {
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
            Arc::clone(&surface.shared),
            remove_without_browser,
        ))
    })?;
    shared.clear_focus_restore_intent();
    shared.deny_popups();

    if remove_without_browser {
        // A pending or failed RequestContext has no BrowserHost and therefore can never emit
        // OnBeforeClose. Retire it now; a late callback observes the missing registry and exits.
        let removed = SURFACES.with(|surfaces| surfaces.borrow_mut().remove(surface_id));
        if let Some(surface) = removed {
            retire_surface(surface);
        }
        shared.update(|state| {
            state.lifecycle = CefSurfaceLifecycle::Closed;
            state.visible = false;
            state.popup = None;
            state.user_popups_allowed = false;
        });
        return Ok(());
    }

    if let Some(popup_browser) = popup_browser {
        if let Some(host) = popup_browser.host() {
            if let Some(child) = unsafe { host.window_handle().cast::<NSView>().as_ref() } {
                child.setHidden(true);
            }
            host.close_browser(1);
        }
    }

    let Some(browser) = browser else {
        return Ok(());
    };
    let host = browser
        .host()
        .ok_or_else(|| "CEF BrowserHost is unavailable".to_string())?;
    if let Some(child) = unsafe { host.window_handle().cast::<NSView>().as_ref() } {
        child.setHidden(true);
    }
    // The registry borrow is gone before this call; CEF may synchronously invoke
    // DoClose and OnBeforeClose.
    host.close_browser(1);
    Ok(())
}

pub(crate) fn close_popup(surface_id: &str) -> Result<(), String> {
    popup::close_popup(surface_id)
}

pub(crate) fn shutdown_all(pump: &CefExternalPump) -> Result<(), String> {
    require_main_thread()?;
    let ids = SURFACES.with(|surfaces| surfaces.borrow().keys().cloned().collect::<Vec<_>>());
    for id in &ids {
        close(id).map_err(|error| format!("close CEF surface {id}: {error}"))?;
    }
    pump.begin_draining();
    let deadline = Instant::now() + SURFACE_CLOSE_TIMEOUT;
    while !all_surfaces_closed() && Instant::now() < deadline {
        pump.do_message_loop_work();
        thread::sleep(Duration::from_millis(1));
    }
    if !all_surfaces_closed() {
        let remaining = SURFACES.with(|surfaces| {
            surfaces
                .borrow()
                .iter()
                .map(|(id, surface)| format!("{id}:{:?}", surface.shared.snapshot().lifecycle))
                .collect::<Vec<_>>()
                .join(",")
        });
        let remaining_contexts = remaining_profile_contexts();
        return Err(format!(
            "CEF surfaces or Profile contexts did not close before the shutdown deadline: surfaces={remaining}; contexts={remaining_contexts}"
        ));
    }
    debug_assert!(all_surfaces_closed());
    Ok(())
}

fn send_devtools_message(
    app: &AppHandle,
    surface_id: String,
    message: Vec<u8>,
) -> Result<(), String> {
    run_cancellable_on_main(
        app,
        MainThreadMarker::new().is_some(),
        DEVTOOLS_DISPATCH_TIMEOUT,
        "CEF DevTools main-thread dispatch",
        move || send_devtools_message_on_main(&surface_id, &message),
    )
}

fn send_devtools_message_on_main(surface_id: &str, message: &[u8]) -> Result<(), String> {
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

fn prepare_profile_path(root: &Path, profile_id: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(root)
        .map_err(|error| format!("create CEF profile root {}: {error}", root.display()))?;
    secure_profile_directory(root, "CEF profile root")?;
    let root = root
        .canonicalize()
        .map_err(|error| format!("resolve CEF profile root {}: {error}", root.display()))?;
    let path = profile_cache_path(&root, profile_id)?;
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(format!(
                "CEF profile path is not a private directory: {}",
                path.display()
            ))
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&path)
                .map_err(|error| format!("create CEF profile {}: {error}", path.display()))?;
        }
        Err(error) => {
            return Err(format!("inspect CEF profile {}: {error}", path.display()));
        }
    }
    secure_profile_directory(&path, "CEF profile path")?;
    if path.parent() != Some(root.as_path()) {
        return Err("CEF profile cache is not a direct root child".to_string());
    }
    Ok(path)
}

fn secure_profile_directory(path: &Path, label: &str) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("inspect {label} {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "{label} is not a real directory: {}",
            path.display()
        ));
    }
    if metadata.uid() != unsafe { libc::geteuid() } {
        return Err(format!("{label} is not owned by the current user"));
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("secure {label} {}: {error}", path.display()))?;
    let hardened = fs::symlink_metadata(path)
        .map_err(|error| format!("reinspect {label} {}: {error}", path.display()))?;
    if hardened.file_type().is_symlink()
        || !hardened.is_dir()
        || hardened.uid() != unsafe { libc::geteuid() }
        || hardened.permissions().mode() & 0o777 != 0o700
    {
        return Err(format!(
            "{label} did not remain a private current-user directory"
        ));
    }
    Ok(())
}

fn all_surfaces_closed() -> bool {
    // Entries leave the registry only from OnBeforeClose (or a creation failure
    // that never produced a BrowserHost). Failed is not a close milestone.
    let surface_count = SURFACES.with(|surfaces| surfaces.borrow().len());
    let profile_context_count = PROFILE_CONTEXTS.with(|contexts| contexts.borrow().len());
    native_registries_are_drained(surface_count, profile_context_count)
}

#[cfg(test)]
mod profile_path_tests {
    use super::prepare_profile_path;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    const PROFILE_ID: &str = "profile-0123456789abcdef0123456789abcdef";

    #[test]
    fn persistent_profile_leaf_is_hardened_to_current_user_only() {
        let temp = tempfile::tempdir().expect("CEF profile root fixture");
        let root = temp.path().join("cef");
        fs::create_dir(&root).unwrap();
        let leaf = root.join(format!("Profile-{PROFILE_ID}"));
        fs::create_dir(&leaf).unwrap();
        fs::set_permissions(&leaf, fs::Permissions::from_mode(0o755)).unwrap();

        let prepared = prepare_profile_path(&root, PROFILE_ID).expect("prepare private profile");
        assert_eq!(
            prepared,
            root.canonicalize()
                .unwrap()
                .join(format!("Profile-{PROFILE_ID}"))
        );
        assert_eq!(
            fs::symlink_metadata(prepared).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
}

fn remaining_profile_contexts() -> String {
    PROFILE_CONTEXTS.with(|contexts| {
        contexts
            .borrow()
            .iter()
            .map(|(profile_id, group)| format!("{profile_id}:{}", group.members.len()))
            .collect::<Vec<_>>()
            .join(",")
    })
}

const fn native_registries_are_drained(surface_count: usize, profile_context_count: usize) -> bool {
    surface_count == 0 && profile_context_count == 0
}

#[cfg(test)]
mod profile_context_registry_tests {
    use super::native_registries_are_drained;

    #[test]
    fn first_surface_close_keeps_the_profile_context_anchor_until_the_final_member() {
        // A first close leaves one sibling/anchor group; only the final member can drain it.
        assert!(!native_registries_are_drained(1, 1));
        assert!(!native_registries_are_drained(0, 1));
        assert!(native_registries_are_drained(0, 0));
    }
}

fn require_main_thread() -> Result<(), String> {
    MainThreadMarker::new().map(|_| ()).ok_or_else(|| {
        "CEF native surface operation must run on the AppKit main thread".to_string()
    })
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
