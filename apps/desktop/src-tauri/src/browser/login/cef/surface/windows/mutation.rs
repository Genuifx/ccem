use super::{
    inspect_child_window, position_window, require_main_thread, set_window_visible, win32_hwnd,
    SURFACES,
};
use crate::browser::login::cef::surface::{
    validate_windows_native_window_observation, NativeChildBounds, WindowsNativeWindowObservation,
};
use cef::*;

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
    let (parent, bounds, previous_visible, primary, popup_browser) = SURFACES.with(|surfaces| {
        let surfaces = surfaces.borrow();
        let surface = surfaces
            .get(surface_id)
            .ok_or_else(|| format!("CEF surface {surface_id} does not exist"))?;
        Ok::<_, String>((
            surface.parent,
            surface.bounds,
            surface.visible,
            surface.browser.clone(),
            surface
                .popup
                .as_ref()
                .and_then(|popup| popup.browser.clone()),
        ))
    })?;
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
    SURFACES.with(|surfaces| {
        let mut surfaces = surfaces.borrow_mut();
        let surface = surfaces.get_mut(surface_id).ok_or_else(|| {
            format!("CEF surface {surface_id} disappeared after visibility change")
        })?;
        surface.visible = visible;
        surface.shared.update(|state| state.visible = visible);
        Ok::<_, String>(())
    })?;
    Ok(())
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
