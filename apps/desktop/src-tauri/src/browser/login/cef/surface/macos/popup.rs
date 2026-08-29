use super::{finalize_surface_if_terminal, record_error, require_main_thread, SURFACES};
use crate::browser::login::cef::surface::{
    diagnostic_url, CefSurfaceLifecycle, HostShortcutKeyboardHandler, SharedSurfaceState,
    SurfaceDownloadHandler,
};
use cef::*;
use cef_objc2_app_kit::NSView;
use cef_objc2_foundation::{NSPoint, NSRect, NSSize};
use std::{net::IpAddr, sync::Arc};
use tauri::AppHandle;

pub(super) struct NativeCefPopup {
    pub(super) popup_id: i32,
    pub(super) browser: Option<Browser>,
    pub(super) close_requested: bool,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn configure_user_popup(
    surface_id: &str,
    parent_view: usize,
    app: &AppHandle,
    shared: &Arc<SharedSurfaceState>,
    popup_id: i32,
    target_url: Option<&CefString>,
    target_disposition: WindowOpenDisposition,
    user_gesture: i32,
    window_info: Option<&mut WindowInfo>,
    client: Option<&mut Option<Client>>,
    _no_javascript_access: Option<&mut i32>,
) -> i32 {
    let target_url = target_url.map(CefString::to_string).unwrap_or_default();
    let reject = |reason: &str| {
        eprintln!("CEF popup blocked surface={surface_id} popup_id={popup_id} reason={reason}");
        1
    };
    if user_gesture != 1 {
        return reject("no_user_gesture");
    }
    if !popup_disposition_allowed(target_disposition) {
        return reject("unsupported_disposition");
    }
    if !popup_url_allowed(&target_url) {
        return reject("unsupported_url");
    }
    let Some(window_info) = window_info else {
        return reject("missing_window_info");
    };
    let Some(client) = client else {
        return reject("missing_client_slot");
    };
    if shared
        .reserve_user_popup(popup_id, target_url.clone())
        .is_err()
    {
        return reject("admission_denied");
    }

    let reservation = SURFACES.with(|surfaces| {
        let mut surfaces = surfaces.borrow_mut();
        let surface = surfaces.get_mut(surface_id).ok_or("surface_missing")?;
        if surface.close_requested || surface.primary_closed || surface.popup.is_some() {
            return Err("surface_not_accepting_popup");
        }
        surface.popup = Some(NativeCefPopup {
            popup_id,
            browser: None,
            close_requested: false,
        });
        Ok(surface.bounds)
    });
    let bounds = match reservation {
        Ok(bounds) => bounds,
        Err(reason) => {
            shared.finish_popup(popup_id);
            return reject(reason);
        }
    };

    let rect = Rect {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
    };
    let parent = parent_view as *mut NSView;
    *window_info = WindowInfo {
        runtime_style: RuntimeStyle::ALLOY,
        ..Default::default()
    }
    .set_as_child(parent.cast(), &rect);
    *client = Some(PopupSurfaceClient::new(
        surface_id.to_string(),
        popup_id,
        parent_view,
        app.clone(),
        Arc::clone(shared),
    ));

    // Returning false lets CEF create the original popup in the opener's
    // RequestContext/renderer relationship. In particular, do not rewrite
    // no_javascript_access: opener/postMessage/window.closed semantics must be
    // those of the page's original window.open call.
    0
}

pub(super) fn abort_pending_popup(
    surface_id: &str,
    popup_id: i32,
    shared: &Arc<SharedSurfaceState>,
) {
    let removed = SURFACES.with(|surfaces| {
        let mut surfaces = surfaces.borrow_mut();
        let surface = surfaces.get_mut(surface_id)?;
        let pending = surface
            .popup
            .as_ref()
            .is_some_and(|popup| popup.popup_id == popup_id && popup.browser.is_none());
        pending.then(|| surface.popup.take()).flatten()
    });
    drop(removed);
    shared.finish_popup(popup_id);
    finalize_surface_if_terminal(surface_id, shared);
}

pub(super) fn close_popup(surface_id: &str) -> Result<(), String> {
    require_main_thread()?;
    let intent = SURFACES.with(|surfaces| {
        let mut surfaces = surfaces.borrow_mut();
        let surface = surfaces
            .get_mut(surface_id)
            .ok_or_else(|| format!("CEF surface {surface_id} does not exist"))?;
        let Some(popup) = surface.popup.as_mut() else {
            return Ok(None);
        };
        popup.close_requested = true;
        let browser = popup.browser.clone();
        let popup_id = popup.popup_id;
        let shared = Arc::clone(&surface.shared);
        Ok::<_, String>(Some((browser, popup_id, shared)))
    })?;
    let Some((browser, popup_id, shared)) = intent else {
        return Ok(());
    };
    shared.update_popup(popup_id, |popup| {
        popup.lifecycle = CefSurfaceLifecycle::Closing;
    });
    if let Some(browser) = browser {
        if let Some(host) = browser.host() {
            if let Some(child) = unsafe { host.window_handle().cast::<NSView>().as_ref() } {
                child.setHidden(true);
            }
            host.close_browser(1);
        }
    }
    Ok(())
}

fn popup_disposition_allowed(disposition: WindowOpenDisposition) -> bool {
    matches!(
        disposition,
        WindowOpenDisposition::NEW_POPUP
            | WindowOpenDisposition::NEW_WINDOW
            | WindowOpenDisposition::NEW_FOREGROUND_TAB
    )
}

fn popup_url_allowed(value: &str) -> bool {
    if value.is_empty() || value == "about:blank" || value.starts_with("about:blank#") {
        return true;
    }
    let Ok(url) = tauri::Url::parse(value) else {
        return false;
    };
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    match url.scheme() {
        "https" => true,
        "http" => url.host_str().is_some_and(loopback_host_allowed),
        _ => false,
    }
}

fn loopback_host_allowed(host: &str) -> bool {
    let host = host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host);
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

fn close_blocked_popup_navigation(
    browser: Option<&mut Browser>,
    popup_id: i32,
    shared: &Arc<SharedSurfaceState>,
    _url: &str,
) {
    shared.mark_popup_policy_closed(popup_id);
    if let Some(host) = browser.and_then(|browser| browser.host()) {
        host.close_browser(1);
    }
}

wrap_request_handler! {
    struct PopupRequestHandler {
        popup_id: i32,
        shared: Arc<SharedSurfaceState>,
    }

    impl RequestHandler {
        fn on_before_browse(
            &self,
            browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            request: Option<&mut Request>,
            _user_gesture: i32,
            _is_redirect: i32,
        ) -> i32 {
            if frame.is_none_or(|frame| frame.is_main() != 1) {
                return 0;
            }
            let url = request
                .map(|request| CefString::from(&request.url()).to_string())
                .unwrap_or_default();
            if popup_url_allowed(&url) {
                return 0;
            }
            close_blocked_popup_navigation(browser, self.popup_id, &self.shared, &url);
            1
        }

        fn on_open_urlfrom_tab(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _target_url: Option<&CefString>,
            _target_disposition: WindowOpenDisposition,
            _user_gesture: i32,
        ) -> i32 {
            // A second tab/window would escape the one-popup ownership model.
            1
        }

        fn on_render_process_terminated(
            &self,
            browser: Option<&mut Browser>,
            status: TerminationStatus,
            error_code: i32,
            error_string: Option<&CefString>,
        ) {
            let _ = (browser, status, error_code, error_string);
            self.shared.record_popup_renderer_termination(self.popup_id);
        }
    }
}

wrap_display_handler! {
    struct PopupDisplayHandler {
        popup_id: i32,
        shared: Arc<SharedSurfaceState>,
    }

    impl DisplayHandler {
        fn on_title_change(&self, _browser: Option<&mut Browser>, title: Option<&CefString>) {
            let title = title.map(CefString::to_string).filter(|title| !title.is_empty());
            self.shared.update_popup(self.popup_id, |popup| popup.title = title);
        }
    }
}

wrap_load_handler! {
    struct PopupLoadHandler {
        popup_id: i32,
        shared: Arc<SharedSurfaceState>,
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
            self.shared.update_popup_from_load(self.popup_id, |popup| {
                popup.lifecycle = CefSurfaceLifecycle::Loading;
                popup.current_url = url;
                popup.error = None;
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
            self.shared.update_popup_from_load(self.popup_id, |popup| {
                popup.lifecycle = CefSurfaceLifecycle::Ready;
                popup.current_url = url;
                popup.error = None;
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
            if frame.is_none_or(|frame| frame.is_main() != 1) {
                return;
            }
            let code = sys::cef_errorcode_t::from(error_code) as i32;
            if code == sys::cef_errorcode_t::ERR_ABORTED as i32 {
                return;
            }
            let _ = error_text;
            let failed_url = failed_url.map(CefString::to_string).unwrap_or_default();
            let message = format!(
                "CEF popup load failed ({code}) at {}",
                diagnostic_url(&failed_url),
            );
            let failed = self.shared.update_popup_from_load(self.popup_id, |popup| {
                popup.lifecycle = CefSurfaceLifecycle::Failed;
                popup.error = Some(message);
            });
            if failed {
                self.shared.clear_focus_restore_intent();
            }
        }
    }
}

wrap_life_span_handler! {
    struct PopupLifeSpanHandler {
        surface_id: String,
        popup_id: i32,
        parent_view: usize,
        app: AppHandle,
        shared: Arc<SharedSurfaceState>,
    }

    impl LifeSpanHandler {
        fn on_before_popup(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _popup_id: i32,
            _target_url: Option<&CefString>,
            _target_frame_name: Option<&CefString>,
            _target_disposition: WindowOpenDisposition,
            _user_gesture: i32,
            _popup_features: Option<&PopupFeatures>,
            _window_info: Option<&mut WindowInfo>,
            _client: Option<&mut Option<Client>>,
            _settings: Option<&mut BrowserSettings>,
            _extra_info: Option<&mut Option<DictionaryValue>>,
            _no_javascript_access: Option<&mut i32>,
        ) -> i32 {
            // First release deliberately owns one popup. Nested windows would
            // otherwise escape the single BrowserPanel focus/close contract.
            1
        }

        fn on_after_created(&self, browser: Option<&mut Browser>) {
            let Some(browser) = browser.cloned() else {
                abort_pending_popup(&self.surface_id, self.popup_id, &self.shared);
                return;
            };
            let Some(host) = browser.host() else {
                abort_pending_popup(&self.surface_id, self.popup_id, &self.shared);
                return;
            };
            if browser.is_popup() != 1 {
                record_error(&self.shared, "CEF popup callback produced a non-popup browser");
                host.close_browser(1);
                return;
            }

            let root = SURFACES.with(|surfaces| {
                let surfaces = surfaces.borrow();
                let surface = surfaces.get(&self.surface_id)?;
                let popup = surface.popup.as_ref()?;
                (popup.popup_id == self.popup_id).then(|| {
                    (
                        surface.context.clone(),
                        surface.browser.clone(),
                        surface.bounds,
                        surface.visible,
                        surface.close_requested || popup.close_requested || surface.primary_closed,
                    )
                })
            });
            let Some((expected_context, primary, bounds, visible, close_now)) = root else {
                record_error(&self.shared, "CEF popup reservation disappeared during create");
                host.close_browser(1);
                return;
            };
            let context_matches = match (expected_context, host.request_context()) {
                (Some(expected), Some(mut actual)) => expected.is_same(Some(&mut actual)) == 1,
                _ => false,
            };
            if !context_matches {
                record_error(&self.shared, "CEF popup escaped its profile RequestContext");
                host.close_browser(1);
                return;
            }

            let child = host.window_handle().cast::<NSView>();
            let Some(child) = (unsafe { child.as_ref() }) else {
                record_error(&self.shared, "CEF popup BrowserHost has no child NSView");
                host.close_browser(1);
                return;
            };
            let Some(parent) = (unsafe { (self.parent_view as *mut NSView).as_ref() }) else {
                record_error(&self.shared, "CEF popup parent NSView is unavailable");
                host.close_browser(1);
                return;
            };
            let parent_matches = unsafe { child.superview() }
                .as_deref()
                .is_some_and(|actual| std::ptr::eq(actual, parent));
            if !parent_matches {
                record_error(&self.shared, "CEF popup is not attached to the BrowserPanel parent");
                host.close_browser(1);
                return;
            }

            let stored = SURFACES.with(|surfaces| {
                let mut surfaces = surfaces.borrow_mut();
                let Some(surface) = surfaces.get_mut(&self.surface_id) else {
                    return false;
                };
                let Some(popup) = surface
                    .popup
                    .as_mut()
                    .filter(|popup| popup.popup_id == self.popup_id)
                else {
                    return false;
                };
                popup.browser = Some(browser.clone());
                true
            });
            if !stored {
                record_error(&self.shared, "CEF popup registry entry disappeared during create");
                host.close_browser(1);
                return;
            }

            child.setFrame(NSRect::new(
                NSPoint::new(bounds.x.into(), bounds.y.into()),
                NSSize::new(bounds.width.into(), bounds.height.into()),
            ));
            if let Some(primary) = primary.and_then(|browser| browser.host()) {
                if let Some(primary_child) = unsafe { primary.window_handle().cast::<NSView>().as_ref() } {
                    primary_child.setHidden(true);
                }
            }
            child.setHidden(!visible || close_now);
            self.shared.update_popup(self.popup_id, |popup| {
                popup.lifecycle = if close_now {
                    CefSurfaceLifecycle::Closing
                } else {
                    CefSurfaceLifecycle::Loading
                };
            });
            if close_now {
                host.close_browser(1);
            }
        }

        fn do_close(&self, browser: Option<&mut Browser>) -> i32 {
            if let Some(child) = browser
                .and_then(|browser| browser.host())
                .map(|host| host.window_handle().cast::<NSView>())
                .and_then(|child| unsafe { child.as_ref() })
            {
                child.removeFromSuperview();
            }
            1
        }

        fn on_before_close(&self, _browser: Option<&mut Browser>) {
            let removed = SURFACES.with(|surfaces| {
                let mut surfaces = surfaces.borrow_mut();
                let Some(surface) = surfaces.get_mut(&self.surface_id) else {
                    return (None, None);
                };
                let matches = surface
                    .popup
                    .as_ref()
                    .is_some_and(|popup| popup.popup_id == self.popup_id);
                if !matches {
                    return (None, None);
                }
                let removed = surface.popup.take();
                let primary = (!surface.close_requested
                    && !surface.primary_closed
                    && surface.visible)
                    .then(|| surface.browser.clone())
                    .flatten();
                (removed, primary)
            });
            let (removed_popup, primary) = removed;
            drop(removed_popup);
            self.shared.finish_popup(self.popup_id);

            if let Some(host) = primary.and_then(|browser| browser.host()) {
                let child = host.window_handle().cast::<NSView>();
                if let Some(child) = unsafe { child.as_ref() } {
                    child.setHidden(false);
                    if let Some(window) = child.window() {
                        let _ = window.makeFirstResponder(Some(child));
                    }
                    host.set_focus(1);
                }
            }
            finalize_surface_if_terminal(&self.surface_id, &self.shared);
        }
    }
}

wrap_client! {
    struct PopupSurfaceClient {
        surface_id: String,
        popup_id: i32,
        parent_view: usize,
        app: AppHandle,
        shared: Arc<SharedSurfaceState>,
    }

    impl Client {
        fn display_handler(&self) -> Option<DisplayHandler> {
            Some(PopupDisplayHandler::new(self.popup_id, Arc::clone(&self.shared)))
        }

        fn download_handler(&self) -> Option<DownloadHandler> {
            Some(SurfaceDownloadHandler::new())
        }

        fn life_span_handler(&self) -> Option<LifeSpanHandler> {
            Some(PopupLifeSpanHandler::new(
                self.surface_id.clone(),
                self.popup_id,
                self.parent_view,
                self.app.clone(),
                Arc::clone(&self.shared),
            ))
        }

        fn keyboard_handler(&self) -> Option<KeyboardHandler> {
            Some(HostShortcutKeyboardHandler::new(self.app.clone(), self.surface_id.clone()))
        }

        fn load_handler(&self) -> Option<LoadHandler> {
            Some(PopupLoadHandler::new(self.popup_id, Arc::clone(&self.shared)))
        }

        fn request_handler(&self) -> Option<RequestHandler> {
            Some(PopupRequestHandler::new(
                self.popup_id,
                Arc::clone(&self.shared),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oauth_popup_admission_is_user_gesture_foreground_and_web_only() {
        assert!(popup_disposition_allowed(WindowOpenDisposition::NEW_POPUP));
        assert!(popup_disposition_allowed(WindowOpenDisposition::NEW_WINDOW));
        assert!(popup_disposition_allowed(
            WindowOpenDisposition::NEW_FOREGROUND_TAB
        ));
        assert!(!popup_disposition_allowed(
            WindowOpenDisposition::NEW_BACKGROUND_TAB
        ));
        assert!(!popup_disposition_allowed(
            WindowOpenDisposition::SAVE_TO_DISK
        ));

        for url in [
            "",
            "about:blank",
            "about:blank#oauth",
            "https://id.example/login",
            "http://127.0.0.1/callback",
            "http://127.250.1.2:43129/callback",
            "http://[::1]:43129/callback",
            "http://localhost:43129/callback",
        ] {
            assert!(popup_url_allowed(url), "{url}");
        }
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hi",
            "ccem://callback",
            "http://id.example/login",
            "http://192.168.1.5/callback",
            "https://user:secret@id.example/login",
        ] {
            assert!(!popup_url_allowed(url), "{url}");
        }
    }
}
