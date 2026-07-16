use super::logs::BROWSER_CONSOLE_INIT_SCRIPT;
use super::registry::{BrowserNavigationToken, BrowserSessionRegistry};
use super::{
    emit_browser_state, is_allowed_browser_navigation, parse_browser_url, BrowserBounds,
    BrowserHistoryDirection, BrowserHistoryState, BrowserPageMetadata, SAFARI_DESKTOP_UA,
};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};

#[cfg(target_os = "macos")]
pub(super) fn ensure_browser_webview(
    app: &AppHandle,
    registry: Arc<BrowserSessionRegistry>,
    session_id: &str,
    label: &str,
    generation: u64,
    url: &str,
    initially_visible: bool,
) -> Result<tauri::Webview, String> {
    if let Some(webview) = app.get_webview(label) {
        if !initially_visible {
            webview
                .hide()
                .map_err(|error| format!("hide existing browser webview before open: {error}"))?;
        }
        return Ok(webview);
    }

    let parsed = parse_browser_url(url)?;
    let window = app
        .get_window("main")
        .ok_or_else(|| "Main window is not available".to_string())?;
    let navigation_registry = Arc::clone(&registry);
    let navigation_app = app.clone();
    let navigation_session_id = session_id.to_string();
    let navigation_label = label.to_string();
    let title_registry = Arc::clone(&registry);
    let title_app = app.clone();
    let title_session_id = session_id.to_string();
    let builder = tauri::WebviewBuilder::new(label, tauri::WebviewUrl::External(parsed))
        .user_agent(SAFARI_DESKTOP_UA)
        .incognito(true)
        .initialization_script(BROWSER_CONSOLE_INIT_SCRIPT)
        .on_navigation(move |url| {
            let allowed = is_allowed_browser_navigation(url);
            if allowed {
                if let Ok((state, token)) = navigation_registry
                    .mark_navigation(&navigation_session_id, url.as_str().to_string())
                {
                    emit_browser_state(&navigation_app, &state, "navigation_event");
                    schedule_browser_metadata_refresh(
                        navigation_app.clone(),
                        Arc::clone(&navigation_registry),
                        navigation_label.clone(),
                        token,
                    );
                }
            }
            allowed
        })
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_document_title_changed(move |_webview, title| {
            if let Ok(Some(state)) =
                title_registry.apply_title(&title_session_id, generation, title)
            {
                emit_browser_state(&title_app, &state, "title_changed");
            }
        });

    let webview = window
        .add_child(
            builder,
            tauri::LogicalPosition::new(0.0, 0.0),
            tauri::LogicalSize::new(1.0, 1.0),
        )
        .map_err(|error| format!("add browser webview: {error}"))?;

    if !initially_visible {
        if let Err(error) = webview.hide() {
            // A child that cannot acknowledge its initial hidden state must not
            // survive long enough to paint above an already-open overlay.
            let _ = webview.close();
            return Err(format!("hide new browser webview before open: {error}"));
        }
    }

    Ok(webview)
}

#[cfg(not(target_os = "macos"))]
pub(super) fn ensure_browser_webview(
    _app: &AppHandle,
    _registry: Arc<BrowserSessionRegistry>,
    _session_id: &str,
    _label: &str,
    _generation: u64,
    _url: &str,
    _initially_visible: bool,
) -> Result<tauri::Webview, String> {
    Err("Embedded browser is only supported on macOS in this version.".to_string())
}

pub(super) fn require_browser_webview(
    app: &AppHandle,
    label: &str,
) -> Result<tauri::Webview, String> {
    app.get_webview(label)
        .ok_or_else(|| "Browser panel is not open.".to_string())
}

pub(super) fn apply_browser_bounds(
    webview: &tauri::Webview,
    bounds: BrowserBounds,
) -> Result<(), String> {
    webview
        .set_bounds(tauri::Rect {
            position: tauri::Position::Logical(tauri::LogicalPosition::new(bounds.x, bounds.y)),
            size: tauri::Size::Logical(tauri::LogicalSize::new(bounds.width, bounds.height)),
        })
        .map_err(|error| format!("set browser bounds: {error}"))
}

#[cfg(target_os = "macos")]
pub(super) fn navigate_browser_history(
    webview: &tauri::Webview,
    direction: BrowserHistoryDirection,
) -> Result<bool, String> {
    use objc2_web_kit::WKWebView;
    use std::sync::mpsc;

    let (tx, rx) = mpsc::channel();
    webview
        .with_webview(move |platform| unsafe {
            let view: &WKWebView = &*platform.inner().cast();
            let can_navigate = match direction {
                BrowserHistoryDirection::Back => view.canGoBack(),
                BrowserHistoryDirection::Forward => view.canGoForward(),
            };
            if can_navigate {
                match direction {
                    BrowserHistoryDirection::Back => {
                        let _ = view.goBack();
                    }
                    BrowserHistoryDirection::Forward => {
                        let _ = view.goForward();
                    }
                }
            }
            let _ = tx.send(can_navigate);
        })
        .map_err(|error| format!("schedule browser history navigation: {error}"))?;

    rx.recv_timeout(Duration::from_secs(3))
        .map_err(|_| "Timed out waiting for browser history navigation.".to_string())
}

#[cfg(not(target_os = "macos"))]
pub(super) fn navigate_browser_history(
    _webview: &tauri::Webview,
    _direction: BrowserHistoryDirection,
) -> Result<bool, String> {
    Err(
        "Embedded browser history navigation is only supported on macOS in this version."
            .to_string(),
    )
}

#[cfg(target_os = "macos")]
fn browser_page_metadata(webview: &tauri::Webview) -> Result<BrowserPageMetadata, String> {
    use objc2_web_kit::WKWebView;
    use std::sync::mpsc;

    let (tx, rx) = mpsc::channel();
    webview
        .with_webview(move |platform| unsafe {
            let view: &WKWebView = &*platform.inner().cast();
            let url = view
                .URL()
                .and_then(|url| url.absoluteString())
                .map(|value| value.to_string())
                .filter(|value| !value.is_empty());
            let title = view
                .title()
                .map(|value| value.to_string())
                .filter(|value| !value.is_empty());
            let _ = tx.send(BrowserPageMetadata {
                url,
                title,
                history: BrowserHistoryState {
                    can_go_back: view.canGoBack(),
                    can_go_forward: view.canGoForward(),
                },
            });
        })
        .map_err(|error| format!("schedule browser metadata read: {error}"))?;

    rx.recv_timeout(Duration::from_secs(3))
        .map_err(|_| "Timed out waiting for browser metadata.".to_string())
}

#[cfg(not(target_os = "macos"))]
fn browser_page_metadata(_webview: &tauri::Webview) -> Result<BrowserPageMetadata, String> {
    Ok(BrowserPageMetadata::default())
}

fn schedule_browser_metadata_refresh(
    app: AppHandle,
    registry: Arc<BrowserSessionRegistry>,
    label: String,
    token: BrowserNavigationToken,
) {
    std::thread::spawn(move || {
        for attempt in 0..4 {
            std::thread::sleep(Duration::from_millis(160 + attempt * 120));
            let Some(webview) = app.get_webview(&label) else {
                return;
            };
            match browser_page_metadata(&webview) {
                Ok(metadata) => {
                    let observed_target = metadata
                        .url
                        .as_deref()
                        .is_some_and(|url| url != "about:blank");
                    if observed_target || attempt == 3 {
                        if let Ok(Some(state)) = registry.apply_navigation_metadata(
                            &token,
                            metadata.url,
                            metadata.title,
                            metadata.history.can_go_back,
                            metadata.history.can_go_forward,
                        ) {
                            emit_browser_state(&app, &state, "metadata_refreshed");
                        }
                        return;
                    }
                }
                Err(_) if attempt == 3 => {
                    if let Ok(Some(state)) =
                        registry.apply_navigation_metadata(&token, None, None, false, false)
                    {
                        emit_browser_state(&app, &state, "metadata_refresh_degraded");
                    }
                    return;
                }
                Err(_) => {}
            }
        }
    });
}

#[cfg(target_os = "macos")]
fn eval_webview_js_with_timeout(
    webview: &tauri::Webview,
    js: &str,
    timeout: Duration,
) -> Result<String, String> {
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2::ClassType;
    use objc2_foundation::{
        NSError, NSJSONSerialization, NSJSONWritingOptions, NSString, NSUTF8StringEncoding,
    };
    use objc2_web_kit::WKWebView;
    use std::sync::mpsc;

    let (tx, rx) = mpsc::channel();
    let script = js.to_string();
    webview
        .with_webview(move |platform| unsafe {
            let view: &WKWebView = &*platform.inner().cast();
            let handler = RcBlock::new(move |value: *mut AnyObject, error: *mut NSError| {
                let result = if !error.is_null() {
                    Err("JavaScript evaluation failed in browser webview.".to_string())
                } else if value.is_null() {
                    Ok("null".to_string())
                } else {
                    NSJSONSerialization::dataWithJSONObject_options_error(
                        &*value,
                        NSJSONWritingOptions::NSJSONWritingFragmentsAllowed,
                    )
                    .ok()
                    .and_then(|data| {
                        NSString::initWithData_encoding(
                            NSString::alloc(),
                            &data,
                            NSUTF8StringEncoding,
                        )
                    })
                    .map(|string| string.to_string())
                    .ok_or_else(|| "Failed to serialize JavaScript result.".to_string())
                };
                let _ = tx.send(result);
            });
            view.evaluateJavaScript_completionHandler(&NSString::from_str(&script), Some(&handler));
        })
        .map_err(|error| format!("schedule browser eval: {error}"))?;

    rx.recv_timeout(timeout)
        .map_err(|_| "Timed out waiting for browser eval.".to_string())?
}

#[cfg(target_os = "macos")]
pub(super) fn eval_webview_js(webview: &tauri::Webview, js: &str) -> Result<String, String> {
    eval_webview_js_with_timeout(webview, js, Duration::from_secs(15))
}

#[cfg(target_os = "macos")]
pub(super) fn probe_webview_health(webview: &tauri::Webview) -> Result<(), String> {
    eval_webview_js_with_timeout(webview, "1", Duration::from_secs(2)).map(|_| ())
}

#[cfg(not(target_os = "macos"))]
pub(super) fn eval_webview_js(_webview: &tauri::Webview, _js: &str) -> Result<String, String> {
    Err("Embedded browser eval is only supported on macOS in this version.".to_string())
}

#[cfg(not(target_os = "macos"))]
pub(super) fn probe_webview_health(_webview: &tauri::Webview) -> Result<(), String> {
    Err("Embedded browser health checks are only supported on macOS in this version.".to_string())
}

#[cfg(target_os = "macos")]
pub(super) fn snapshot_webview_png(webview: &tauri::Webview) -> Result<Vec<u8>, String> {
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError};
    use objc2_web_kit::WKWebView;
    use std::sync::mpsc;

    let (tx, rx) = mpsc::channel();
    webview
        .with_webview(move |platform| unsafe {
            let view: &WKWebView = &*platform.inner().cast();
            let handler = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                let result = if !error.is_null() {
                    Err("Browser screenshot failed.".to_string())
                } else if image.is_null() {
                    Err("Browser screenshot returned no image.".to_string())
                } else {
                    let image = &*image;
                    image
                        .TIFFRepresentation()
                        .and_then(|tiff| NSBitmapImageRep::imageRepWithData(&tiff))
                        .and_then(|rep| {
                            let properties: objc2::rc::Retained<
                                NSDictionary<objc2_app_kit::NSBitmapImageRepPropertyKey, AnyObject>,
                            > = NSDictionary::new();
                            rep.representationUsingType_properties(
                                NSBitmapImageFileType::PNG,
                                &properties,
                            )
                        })
                        .map(|png| png.bytes().to_vec())
                        .ok_or_else(|| "Failed to convert browser screenshot to PNG.".to_string())
                };
                let _ = tx.send(result);
            });
            view.takeSnapshotWithConfiguration_completionHandler(None, &handler);
        })
        .map_err(|error| format!("schedule browser screenshot: {error}"))?;

    rx.recv_timeout(Duration::from_secs(15))
        .map_err(|_| "Timed out waiting for browser screenshot.".to_string())?
}

#[cfg(not(target_os = "macos"))]
pub(super) fn snapshot_webview_png(_webview: &tauri::Webview) -> Result<Vec<u8>, String> {
    Err("Embedded browser screenshot is only supported on macOS in this version.".to_string())
}
