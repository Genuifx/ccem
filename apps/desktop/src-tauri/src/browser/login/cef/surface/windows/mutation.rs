use super::{
    inspect_child_window, position_window, require_main_thread, set_window_visible, win32_hwnd,
    SURFACES,
};
use crate::browser::login::cef::surface::{
    focus_restore::FocusRestoreTarget, validate_windows_native_window_observation,
    NativeChildBounds, SharedSurfaceState, WindowsNativeWindowObservation,
};
use cef::*;
use std::sync::Arc;
use windows::Win32::UI::{
    Input::KeyboardAndMouse::{GetFocus, SetFocus},
    WindowsAndMessaging::{IsChild, IsWindow},
};

pub(crate) fn set_bounds(surface_id: &str, bounds: NativeChildBounds) -> Result<(), String> {
    require_main_thread()?;
    let (parent, previous_bounds, browsers) = SURFACES.with(|surfaces| {
        let surfaces = surfaces.borrow();
        let surface = surfaces
            .get(surface_id)
            .ok_or_else(|| format!("CEF surface {surface_id} does not exist"))?;
        Ok::<_, String>((
            surface.parent,
            surface.bounds,
            [
                surface.browser.clone(),
                surface
                    .popup
                    .as_ref()
                    .and_then(|popup| popup.browser.clone()),
            ],
        ))
    })?;
    let mut moved = Vec::new();
    for browser in browsers.into_iter().flatten() {
        let host = browser
            .host()
            .ok_or_else(|| "CEF BrowserHost is unavailable".to_string())?;
        let hwnd = win32_hwnd(host.window_handle());
        if let Err(error) = position_window(hwnd, parent, bounds) {
            let rollback_errors = moved
                .into_iter()
                .filter_map(|moved_hwnd| {
                    position_window(moved_hwnd, parent, previous_bounds)
                        .err()
                        .map(|rollback| format!("{rollback}"))
                })
                .collect::<Vec<_>>();
            return if rollback_errors.is_empty() {
                Err(error)
            } else {
                Err(format!(
                    "{error}; rollback CEF child bounds failed: {}",
                    rollback_errors.join("; ")
                ))
            };
        }
        moved.push(hwnd);
        host.notify_move_or_resize_started();
    }
    SURFACES.with(|surfaces| {
        let mut surfaces = surfaces.borrow_mut();
        let surface = surfaces
            .get_mut(surface_id)
            .ok_or_else(|| format!("CEF surface {surface_id} disappeared after resize"))?;
        surface.bounds = bounds;
        Ok::<_, String>(())
    })?;
    Ok(())
}

pub(crate) fn set_visible(surface_id: &str, visible: bool) -> Result<(), String> {
    require_main_thread()?;
    let (parent, bounds, previous_visible, shared, primary, popup) =
        surface_focus_children(surface_id)?;
    let popup_browser = popup
        .as_ref()
        .and_then(|(_, browser)| browser.as_ref())
        .cloned();
    let popup_active = popup_browser.is_some();
    let targets = [
        (
            primary.and_then(|browser| browser.host()),
            visible && !popup_active,
            previous_visible && !popup_active,
        ),
        (
            popup_browser.and_then(|browser| browser.host()),
            visible,
            previous_visible,
        ),
    ];
    let mut changed = Vec::new();
    for (host, target_visible, rollback_visible) in targets {
        let Some(host) = host else { continue };
        let hwnd = win32_hwnd(host.window_handle());
        if let Err(error) = set_window_visible(hwnd, parent, bounds, target_visible) {
            shared.clear_focus_restore_intent();
            let rollback_errors = changed
                .into_iter()
                .filter_map(|(changed_hwnd, changed_visible)| {
                    set_window_visible(changed_hwnd, parent, bounds, changed_visible)
                        .err()
                        .map(|rollback| format!("{rollback}"))
                })
                .collect::<Vec<_>>();
            return if rollback_errors.is_empty() {
                Err(error)
            } else {
                Err(format!(
                    "{error}; rollback CEF child visibility failed: {}",
                    rollback_errors.join("; ")
                ))
            };
        }
        changed.push((hwnd, rollback_visible));
    }
    let committed = SURFACES.with(|surfaces| {
        let mut surfaces = surfaces.borrow_mut();
        let surface = surfaces.get_mut(surface_id).ok_or_else(|| {
            format!("CEF surface {surface_id} disappeared after visibility change")
        })?;
        surface.visible = visible;
        surface.shared.update(|state| state.visible = visible);
        Ok::<_, String>(())
    });
    if let Err(error) = committed {
        shared.clear_focus_restore_intent();
        return Err(error);
    }
    if visible {
        restore_focus_if_requested(surface_id, &shared)?;
    }
    Ok(())
}

pub(crate) fn occlude(surface_id: &str) -> Result<(), String> {
    require_main_thread()?;
    let (_, _, visible, shared, primary, popup) = surface_focus_children(surface_id)?;
    if visible {
        let focused = unsafe { GetFocus() };
        let target = current_focus_target(focused, primary.as_ref(), popup.as_ref())?;
        shared.capture_focus_restore_intent(target);
    }
    set_visible(surface_id, false)
}

type PopupFocusChild = Option<(i32, Option<Browser>)>;

fn surface_focus_children(
    surface_id: &str,
) -> Result<
    (
        windows::Win32::Foundation::HWND,
        NativeChildBounds,
        bool,
        Arc<SharedSurfaceState>,
        Option<Browser>,
        PopupFocusChild,
    ),
    String,
> {
    SURFACES.with(|surfaces| {
        let surfaces = surfaces.borrow();
        let surface = surfaces
            .get(surface_id)
            .ok_or_else(|| format!("CEF surface {surface_id} does not exist"))?;
        Ok((
            surface.parent,
            surface.bounds,
            surface.visible,
            Arc::clone(&surface.shared),
            surface.browser.clone(),
            surface
                .popup
                .as_ref()
                .map(|popup| (popup.popup_id, popup.browser.clone())),
        ))
    })
}

fn current_focus_target(
    focused: windows::Win32::Foundation::HWND,
    primary: Option<&Browser>,
    popup: Option<&(i32, Option<Browser>)>,
) -> Result<Option<FocusRestoreTarget>, String> {
    if focused.0.is_null() {
        return Ok(None);
    }
    if let Some((popup_id, Some(browser))) = popup {
        if browser_owns_focus(browser, focused, "popup")? {
            return Ok(Some(FocusRestoreTarget::Popup(*popup_id)));
        }
    }
    if let Some(browser) = primary {
        if browser_owns_focus(browser, focused, "primary")? {
            return Ok(Some(FocusRestoreTarget::Primary));
        }
    }
    Ok(None)
}

fn browser_owns_focus(
    browser: &Browser,
    focused: windows::Win32::Foundation::HWND,
    label: &str,
) -> Result<bool, String> {
    let host = browser
        .host()
        .ok_or_else(|| format!("CEF {label} BrowserHost is unavailable"))?;
    let root = win32_hwnd(host.window_handle());
    if !unsafe { IsWindow(Some(root)).as_bool() } {
        return Err(format!("CEF {label} child HWND is unavailable"));
    }
    Ok(hwnd_owns_focus(root, focused))
}

fn hwnd_owns_focus(
    root: windows::Win32::Foundation::HWND,
    focused: windows::Win32::Foundation::HWND,
) -> bool {
    root == focused || unsafe { IsChild(root, focused).as_bool() }
}

fn restore_focus_if_requested(
    surface_id: &str,
    shared: &Arc<SharedSurfaceState>,
) -> Result<(), String> {
    let (_, _, _, _, primary, popup) = surface_focus_children(surface_id)?;
    // A popup record without a live HWND-backed Browser is closed/pending and
    // cannot retain an old popup focus intent.
    let current_popup = popup
        .as_ref()
        .and_then(|(popup_id, browser)| browser.as_ref().map(|_| *popup_id));
    shared.try_restore_focus_intent(current_popup, |target| {
        let browser = match target {
            FocusRestoreTarget::Primary => primary.as_ref(),
            FocusRestoreTarget::Popup(popup_id) => popup
                .as_ref()
                .filter(|(current_id, _)| *current_id == popup_id)
                .and_then(|(_, browser)| browser.as_ref()),
        };
        let Some(browser) = browser else {
            return Ok::<bool, String>(false);
        };
        focus_browser(browser)?;
        Ok::<bool, String>(true)
    })?;
    Ok(())
}

fn focus_browser(browser: &Browser) -> Result<(), String> {
    let host = browser
        .host()
        .ok_or_else(|| "CEF focus restore BrowserHost is unavailable".to_string())?;
    let root = win32_hwnd(host.window_handle());
    if !unsafe { IsWindow(Some(root)).as_bool() } {
        return Err("CEF focus restore child HWND is unavailable".to_string());
    }
    let _ = unsafe { SetFocus(Some(root)) };
    host.set_focus(1);
    let focused = unsafe { GetFocus() };
    if !focused.0.is_null() && hwnd_owns_focus(root, focused) {
        Ok(())
    } else {
        Err("CEF child HWND rejected focus restore".to_string())
    }
}

pub(crate) fn native_window_observation(
    surface_id: &str,
) -> Result<WindowsNativeWindowObservation, String> {
    require_main_thread()?;
    super::with_surface(surface_id, |surface| {
        let browser = surface
            .popup
            .as_ref()
            .and_then(|popup| popup.browser.as_ref())
            .or(surface.browser.as_ref())
            .ok_or_else(|| "CEF surface has no live child HWND".to_string())?;
        let host = browser
            .host()
            .ok_or_else(|| "CEF BrowserHost is unavailable".to_string())?;
        let observation = inspect_child_window(win32_hwnd(host.window_handle()), surface.parent)?;
        validate_windows_native_window_observation(
            &observation,
            &observation.parent_hwnd,
            surface.bounds,
            Some(surface.visible),
        )?;
        Ok(observation)
    })
}
