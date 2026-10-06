use super::{require_main_thread, SURFACES};
use crate::browser::login::cef::surface::{
    focus_restore::FocusRestoreTarget, NativeChildBounds, SharedSurfaceState,
};
use cef::*;
use cef_objc2_app_kit::NSView;
use cef_objc2_foundation::{NSPoint, NSRect, NSSize};
use std::sync::Arc;

pub(crate) fn set_bounds(surface_id: &str, bounds: NativeChildBounds) -> Result<(), String> {
    require_main_thread()?;
    let browsers = SURFACES.with(|surfaces| {
        let mut surfaces = surfaces.borrow_mut();
        let surface = surfaces
            .get_mut(surface_id)
            .ok_or_else(|| format!("CEF surface {surface_id} does not exist"))?;
        surface.bounds = bounds;
        Ok::<_, String>((
            surface.browser.clone(),
            surface
                .popup
                .as_ref()
                .and_then(|popup| popup.browser.clone()),
            surface.wrapper.clone(),
            surface.child_bounds(),
        ))
    })?;
    if let Some(wrapper) = &browsers.2 { wrapper.resize(bounds); }
    let bounds = browsers.3;
    for browser in [browsers.0, browsers.1].into_iter().flatten() {
        let host = browser
            .host()
            .ok_or_else(|| "CEF BrowserHost is unavailable".to_string())?;
        let child = host.window_handle().cast::<NSView>();
        let child = unsafe { child.as_ref() }
            .ok_or_else(|| "CEF child NSView is unavailable".to_string())?;
        child.setFrame(NSRect::new(
            NSPoint::new(bounds.x.into(), bounds.y.into()),
            NSSize::new(bounds.width.into(), bounds.height.into()),
        ));
        host.notify_move_or_resize_started();
    }
    Ok(())
}

pub(crate) fn occlude(surface_id: &str) -> Result<(), String> {
    require_main_thread()?;
    if crate::browser_overlay::macos::enabled() && has_wrapper(surface_id) {
        return suspend_input(surface_id);
    }
    let (visible, shared, primary, popup) = surface_focus_children(surface_id)?;
    if visible {
        let target = current_focus_target(primary.as_ref(), popup.as_ref())?;
        shared.capture_focus_restore_intent(target);
    }
    set_visible(surface_id, false)
}

pub(crate) fn set_visible(surface_id: &str, visible: bool) -> Result<(), String> {
    require_main_thread()?;
    let (_, shared, primary, popup) = surface_focus_children(surface_id)?;
    let popup_browser = popup.as_ref().and_then(|(_, browser)| browser.as_ref());

    let apply_visibility = || -> Result<(), String> {
        let wrapper = SURFACES.with(|surfaces| surfaces.borrow().get(surface_id).and_then(|surface| surface.wrapper.clone()));
        if let Some(wrapper) = wrapper { wrapper.setHidden(!visible); }
        if let Some(browser) = primary.as_ref() {
            browser_child(browser, "primary")?.setHidden(!visible || popup_browser.is_some());
        }
        if let Some(browser) = popup_browser {
            browser_child(browser, "popup")?.setHidden(!visible);
        }
        SURFACES.with(|surfaces| {
            let mut surfaces = surfaces.borrow_mut();
            let surface = surfaces.get_mut(surface_id).ok_or_else(|| {
                format!("CEF surface {surface_id} disappeared after visibility change")
            })?;
            surface.visible = visible;
            surface.shared.update(|state| state.visible = visible);
            Ok::<_, String>(())
        })
    };
    if let Err(error) = apply_visibility() {
        shared.clear_focus_restore_intent();
        return Err(error);
    }

    if visible && !input_suspended(surface_id) {
        // Only a live popup browser counts as the current focus target. A
        // captured popup whose browser has closed is stale and must be dropped.
        let current_popup = popup
            .as_ref()
            .and_then(|(popup_id, browser)| browser.as_ref().map(|_| *popup_id));
        shared.try_restore_focus_intent(current_popup, |target| match target {
            FocusRestoreTarget::Primary => match primary.as_ref() {
                Some(browser) => {
                    focus_browser(browser, "primary")?;
                    Ok::<bool, String>(true)
                }
                None => Ok::<bool, String>(false),
            },
            FocusRestoreTarget::Popup(popup_id) => match popup
                .as_ref()
                .filter(|(current_id, _)| *current_id == popup_id)
                .and_then(|(_, browser)| browser.as_ref())
            {
                Some(browser) => {
                    focus_browser(browser, "popup")?;
                    Ok::<bool, String>(true)
                }
                None => Ok::<bool, String>(false),
            },
        })?;
    }
    Ok(())
}

fn has_wrapper(surface_id: &str) -> bool {
    SURFACES.with(|surfaces| surfaces.borrow().get(surface_id).is_some_and(|surface| surface.wrapper.is_some()))
}

pub(super) fn input_suspended(surface_id: &str) -> bool {
    SURFACES.with(|surfaces| surfaces.borrow().get(surface_id).is_some_and(|surface| {
        surface.wrapper.as_ref().is_some_and(|wrapper| wrapper.input_suspended())
    }))
}

fn suspend_input(surface_id: &str) -> Result<(), String> {
    let wrapper = SURFACES.with(|surfaces| surfaces.borrow().get(surface_id).and_then(|surface| surface.wrapper.clone()));
    let Some(wrapper) = wrapper else { return Ok(()); };
    // Global React sync and the Agent pause barrier may both arrive. Capture
    // the original focus only once; a second capture would erase it after blur.
    if wrapper.suspend_input(true) { return Ok(()); }
    let (visible, shared, primary, popup) = surface_focus_children(surface_id)?;
    if !visible { return Ok(()); }
    let target = current_focus_target(primary.as_ref(), popup.as_ref())?;
    shared.capture_focus_restore_intent(target);
    if target.is_some() {
        for browser in [primary.as_ref(), popup.as_ref().and_then(|(_, browser)| browser.as_ref())].into_iter().flatten() {
            if let Some(host) = browser.host() { host.set_focus(0); }
        }
        crate::browser_overlay::macos::focus_main_view();
    }
    Ok(())
}

pub(crate) fn sync_overlay_input(modal: bool) -> Result<(), String> {
    require_main_thread()?;
    let surfaces = SURFACES.with(|surfaces| surfaces.borrow().iter().filter_map(|(id, surface)| {
        surface.wrapper.as_ref().map(|wrapper| (id.clone(), wrapper.clone(), surface.visible, Arc::clone(&surface.shared)))
    }).collect::<Vec<_>>());
    for (id, wrapper, visible, shared) in surfaces {
        if modal {
            suspend_input(&id)?;
        } else if wrapper.suspend_input(false) {
            if visible { set_visible(&id, true)?; }
            else { shared.clear_focus_restore_intent(); }
        }
    }
    Ok(())
}

pub(crate) fn configure_overlay_composition(enabled: bool) -> Result<(), String> {
    require_main_thread()?;
    let wrappers = SURFACES.with(|surfaces| {
        surfaces.borrow().iter().filter_map(|(id, surface)| {
            surface.wrapper.as_ref().map(|wrapper| (
                id.clone(), wrapper.clone(), surface.close_requested, Arc::clone(&surface.shared),
            ))
        }).collect::<Vec<_>>()
    });
    for (id, wrapper, closing, shared) in wrappers {
        if !enabled {
            wrapper.suspend_input(true);
            wrapper.setHidden(true);
            SURFACES.with(|surfaces| {
                if let Some(surface) = surfaces.borrow_mut().get_mut(&id) { surface.visible = false; }
            });
            shared.clear_focus_restore_intent();
            shared.update(|state| state.visible = false);
            wrapper.suspend_input(closing);
        }
    }
    Ok(())
}

wrap_focus_handler! {
    pub(super) struct SurfaceFocusHandler { surface_id: String }
    impl FocusHandler {
        fn on_set_focus(&self, _browser: Option<&mut Browser>, _source: FocusSource) -> i32 {
            i32::from(input_suspended(&self.surface_id))
        }
    }
}

type PopupFocusChild = Option<(i32, Option<Browser>)>;

fn surface_focus_children(
    surface_id: &str,
) -> Result<
    (
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
    primary: Option<&Browser>,
    popup: Option<&(i32, Option<Browser>)>,
) -> Result<Option<FocusRestoreTarget>, String> {
    if let Some((popup_id, Some(browser))) = popup {
        if browser_owns_focus(browser, "popup")? {
            return Ok(Some(FocusRestoreTarget::Popup(*popup_id)));
        }
    }
    if let Some(browser) = primary {
        if browser_owns_focus(browser, "primary")? {
            return Ok(Some(FocusRestoreTarget::Primary));
        }
    }
    Ok(None)
}

fn browser_child<'a>(browser: &'a Browser, label: &str) -> Result<&'a NSView, String> {
    let host = browser
        .host()
        .ok_or_else(|| format!("CEF {label} BrowserHost is unavailable"))?;
    unsafe { host.window_handle().cast::<NSView>().as_ref() }
        .ok_or_else(|| format!("CEF {label} child NSView is unavailable"))
}

fn browser_owns_focus(browser: &Browser, label: &str) -> Result<bool, String> {
    let child = browser_child(browser, label)?;
    let Some(window) = child.window() else {
        return Ok(false);
    };
    let Some(first_responder) = window.firstResponder() else {
        return Ok(false);
    };
    let Ok(first_view) = first_responder.downcast::<NSView>() else {
        return Ok(false);
    };
    Ok(std::ptr::eq(first_view.as_ref(), child) || first_view.isDescendantOf(child))
}

fn focus_browser(browser: &Browser, label: &str) -> Result<(), String> {
    let host = browser
        .host()
        .ok_or_else(|| format!("CEF {label} BrowserHost is unavailable"))?;
    let child = unsafe { host.window_handle().cast::<NSView>().as_ref() }
        .ok_or_else(|| format!("CEF {label} child NSView is unavailable"))?;
    let window = child
        .window()
        .ok_or_else(|| format!("CEF {label} child NSView has no NSWindow"))?;
    if !window.makeFirstResponder(Some(child)) {
        return Err(format!("CEF {label} child NSView rejected focus restore"));
    }
    host.set_focus(1);
    Ok(())
}

#[cfg(debug_assertions)]
pub(crate) fn debug_focus(surface_id: &str) -> Result<(), String> {
    require_main_thread()?;
    if input_suspended(surface_id) { return Err("Surface input is suspended".into()); }
    let (_, _, primary, popup) = surface_focus_children(surface_id)?;
    if let Some(browser) = popup.as_ref().and_then(|(_, browser)| browser.as_ref()) {
        focus_browser(browser, "popup")
    } else if let Some(browser) = primary.as_ref() {
        focus_browser(browser, "primary")
    } else { Err("Surface is not ready".into()) }
}
