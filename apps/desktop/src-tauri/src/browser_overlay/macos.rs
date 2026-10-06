use super::{OverlayPolicy, OverlayRect};
use crate::browser::login::cef::surface::{run_cancellable_on_main, NativeChildBounds};
use cef_objc2::{
    class, define_class, msg_send, rc::Retained, runtime::AnyObject, DefinedClass,
    MainThreadMarker, MainThreadOnly,
};
use cef_objc2_app_kit::{NSApplication, NSEventType, NSView};
use cef_objc2_foundation::{ns_string, NSNumber, NSObjectProtocol, NSPoint, NSRect, NSSize};
use std::{
    cell::{Cell, RefCell},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

#[derive(Default)]
struct NativeOverlayState {
    enabled: bool,
    policy: OverlayPolicy,
    main_view: Option<Retained<NSView>>,
    app: Option<AppHandle>,
    last_pointer_event: Option<(isize, u64)>,
}

thread_local! {
    static STATE: RefCell<NativeOverlayState> = RefCell::new(NativeOverlayState::default());
}

pub(crate) fn enabled() -> bool {
    STATE.with(|state| state.borrow().enabled)
}
pub(crate) fn modal() -> bool {
    STATE.with(|state| state.borrow().policy.modal)
}

fn main_view(window: &WebviewWindow) -> Result<Retained<NSView>, String> {
    let pointer = window.ns_view().map_err(|error| error.to_string())?;
    let parent = unsafe { pointer.cast::<NSView>().as_ref() }
        .ok_or("Main content view is unavailable")?;
    parent.subviews().into_iter()
        .find(|view| unsafe { msg_send![view, isKindOfClass: class!(WKWebView)] })
        .ok_or_else(|| "Main WKWebView is unavailable".into())
}

fn set_main_layer_position(view: &NSView, position: f64) -> Result<(), String> {
    view.setWantsLayer(true);
    unsafe {
        let layer: *mut AnyObject = msg_send![view, layer];
        if layer.is_null() {
            return Err("Main WKWebView backing layer is unavailable".into());
        }
        let _: () = msg_send![layer, setZPosition: position];
    }
    Ok(())
}

/** A new document starts in legacy mode, including when its boot ACK is late. */
pub(crate) fn reset_for_frontend_boot(app: &AppHandle) -> Result<(), String> {
    let reset_app = app.clone();
    run_cancellable_on_main(app, MainThreadMarker::new().is_some(), Duration::from_secs(5),
        "reset React browser composition", move || {
            // Hide before releasing the old policy. Retained CEF stays under
            // the same wrapper across reload and either presentation mode.
            crate::browser::login::cef::surface::macos::configure_overlay_composition(false)?;
            let window = reset_app.get_webview_window("main").ok_or("Main window is unavailable")?;
            let view = main_view(&window)?;
            set_main_layer_position(&view, 0.0)?;
            unsafe {
                let _: () = msg_send![&*view, setValue: &*NSNumber::new_bool(true), forKey: ns_string!("drawsBackground")];
            }
            STATE.with(|state| *state.borrow_mut() = NativeOverlayState {
                main_view: Some(view), ..Default::default()
            });
            focus_main_view();
            Ok(())
        })
}

pub(crate) fn initialize(window: &WebviewWindow) -> Result<bool, String> {
    if std::env::var("CCEM_NATIVE_BROWSER_OVERLAY").as_deref() == Ok("0") {
        return Ok(false);
    }
    let window = window.clone();
    let app = window.app_handle().clone();
    run_cancellable_on_main(
        &app.clone(),
        MainThreadMarker::new().is_some(),
        Duration::from_secs(5),
        "initialize React browser composition",
        move || {
            let main_view = main_view(&window)?;
            let parent = unsafe { main_view.superview() }.ok_or("Main content view is unavailable")?;
            parent.setWantsLayer(true);
            crate::browser::login::cef::surface::macos::configure_overlay_composition(true)?;
            // Keep CEF at the parent's content plane. A negative wrapper z
            // puts Chromium behind the opaque parent backing in this Wry host.
            // Raise WK instead, without changing AppKit's input/subview order.
            set_main_layer_position(&main_view, 1.0)?;
            // The same KVC key is used by this checkout's Wry 0.55 transparency
            // implementation. Never change the view's position in the hierarchy.
            unsafe {
                let _: () = msg_send![&*main_view, setValue: &*NSNumber::new_bool(false), forKey: ns_string!("drawsBackground")];
            }
            STATE.with(|state| {
                *state.borrow_mut() = NativeOverlayState {
                    enabled: true,
                    main_view: Some(main_view),
                    app: Some(app),
                    ..Default::default()
                }
            });
            Ok(true)
        },
    )
}

pub(crate) fn sync(
    app: &AppHandle,
    revision: u64,
    modal: bool,
    regions: Vec<OverlayRect>,
) -> Result<(), String> {
    run_cancellable_on_main(
        app,
        MainThreadMarker::new().is_some(),
        Duration::from_secs(5),
        "sync React browser input regions",
        move || {
            let changed = STATE.with(|state| {
                let mut state = state.borrow_mut();
                if !state.enabled {
                    return Err("Native browser composition is unavailable".to_string());
                }
                let previous_revision = state.policy.revision;
                state.policy.update(revision, modal, regions)?;
                Ok(previous_revision != state.policy.revision)
            })?;
            if changed {
                crate::browser::login::cef::surface::macos::sync_overlay_input(modal)?;
            }
            Ok(())
        },
    )
}

pub(crate) fn focus_main_view() {
    let view = STATE.with(|state| state.borrow().main_view.clone());
    if let Some(view) = view {
        if let Some(window) = view.window() {
            let _ = window.makeFirstResponder(Some(&view));
        }
    }
}

#[derive(Default)]
pub(crate) struct BrowserHostViewIvars {
    suspended: Cell<bool>,
}

define_class! {
    // CEF is created directly inside our wrapper. It is never reparented while
    // Chromium is running; the wrapper outlives both the primary and its popup.
    #[unsafe(super = NSView)]
    #[thread_kind = MainThreadOnly]
    #[ivars = BrowserHostViewIvars]
    pub(crate) struct BrowserHostView;

    unsafe impl NSObjectProtocol for BrowserHostView {}

    impl BrowserHostView {
        #[unsafe(method(hitTest:))]
        fn hit_test(&self, point: NSPoint) -> *mut NSView {
            if self.ivars().suspended.get() { return std::ptr::null_mut(); }
            let converted = if enabled() {
                let main_view = STATE.with(|state| state.borrow().main_view.clone());
                let Some(main_view) = main_view else { return std::ptr::null_mut(); };
                let parent = unsafe { self.superview() };
                let converted = main_view.convertPoint_fromView(point, parent.as_deref());
                let x = converted.x;
                let y = if main_view.isFlipped() { converted.y } else { main_view.bounds().size.height - converted.y };
                if STATE.with(|state| state.borrow().policy.blocks(x, y)) { return std::ptr::null_mut(); }
                Some((x, y))
            } else { None };
            let target: *mut NSView = unsafe { msg_send![super(self), hitTest: point] };
            // During asynchronous CEF close/creation the wrapper may be empty.
            // Its own transparent background must never swallow React input.
            if std::ptr::eq(target, self as *const Self as *const NSView) {
                return std::ptr::null_mut();
            }
            if !target.is_null() {
                if let Some((x, y)) = converted { notify_pointer_down(self.mtm(), x, y); }
            }
            target
        }
    }
}

impl BrowserHostView {
    pub(crate) fn attach(
        parent: &NSView,
        bounds: NativeChildBounds,
    ) -> Result<Retained<Self>, String> {
        let mtm =
            MainThreadMarker::new().ok_or("Browser wrapper must be created on the main thread")?;
        let this = Self::alloc(mtm).set_ivars(BrowserHostViewIvars::default());
        let this: Retained<Self> = unsafe { msg_send![super(this), initWithFrame: frame(bounds)] };
        this.setWantsLayer(true);
        unsafe {
            let layer: *mut AnyObject = msg_send![&*this, layer];
            if layer.is_null() {
                return Err("CEF wrapper backing layer is unavailable".into());
            }
            let _: () = msg_send![layer, setZPosition: 0.0_f64];
            let _: () = msg_send![layer, setMasksToBounds: true];
            // Visual order comes from CALayer, input order from hitTest above.
            parent.addSubview(&this);
        }
        Ok(this)
    }

    pub(crate) fn suspend_input(&self, value: bool) -> bool {
        self.ivars().suspended.replace(value)
    }
    pub(crate) fn input_suspended(&self) -> bool {
        self.ivars().suspended.get() || modal()
    }
    pub(crate) fn resize(&self, bounds: NativeChildBounds) {
        self.setFrame(frame(bounds));
    }
}

fn frame(bounds: NativeChildBounds) -> NSRect {
    NSRect::new(
        NSPoint::new(bounds.x.into(), bounds.y.into()),
        NSSize::new(bounds.width.into(), bounds.height.into()),
    )
}

fn notify_pointer_down(mtm: MainThreadMarker, x: f64, y: f64) {
    let Some(event) = NSApplication::sharedApplication(mtm).currentEvent() else {
        return;
    };
    if !matches!(
        event.r#type(),
        NSEventType::LeftMouseDown | NSEventType::RightMouseDown | NSEventType::OtherMouseDown
    ) {
        return;
    }
    let key = (event.eventNumber(), event.timestamp().to_bits());
    let app = STATE.with(|state| {
        let mut state = state.borrow_mut();
        if state.last_pointer_event == Some(key) {
            return None;
        }
        state.last_pointer_event = Some(key);
        state.app.clone()
    });
    if let Some(app) = app {
        // Non-modal DOM popovers need the outside-pointer notification that
        // would normally bubble through their document. Native delivery to CEF
        // still happens normally and is never synthesized or cancelled here.
        let button = match event.buttonNumber() {
            1 => 2,
            2 => 1,
            _ => 0,
        };
        let _ = app.emit_to(
            "main",
            "browser_overlay_pointer_down",
            serde_json::json!({ "x": x, "y": y, "button": button }),
        );
    }
}

#[cfg(debug_assertions)]
pub(crate) fn probe_point(x: f64, y: f64) -> Result<serde_json::Value, String> {
    let main = STATE
        .with(|state| state.borrow().main_view.clone())
        .ok_or("Composition not initialized")?;
    let parent = unsafe { main.superview() }.ok_or("Main view has no parent")?;
    let point = NSPoint::new(
        x,
        if main.isFlipped() {
            y
        } else {
            main.bounds().size.height - y
        },
    );
    let superview = unsafe { parent.superview() };
    let point = match superview {
        Some(view) => view.convertPoint_fromView(point, Some(&main)),
        None => parent.convertPoint_fromView(point, Some(&main)),
    };
    let hit = parent.hitTest(point);
    let hit_main = hit.as_ref().is_some_and(|view| {
        std::ptr::eq::<NSView>(view.as_ref(), main.as_ref()) || view.isDescendantOf(&main)
    });
    let responder = main.window().and_then(|window| window.firstResponder());
    use cef_objc2::runtime::AnyClass;
    let name = |view: &NSView| {
        let class: &AnyClass = unsafe { msg_send![view, class] };
        class.name().to_string_lossy().into_owned()
    };
    Ok(serde_json::json!({
        "composition": enabled(),
        "hitMain": hit_main,
        "hitClass": hit.as_deref().map(name),
        "mainFrame": [main.frame().origin.x, main.frame().origin.y, main.frame().size.width, main.frame().size.height],
        "firstResponder": responder.map(|view| { let class: &AnyClass = unsafe { msg_send![&*view, class] }; class.name().to_string_lossy().into_owned() }),
        "policy": STATE.with(|state| { let state = state.borrow(); serde_json::json!({"revision":state.policy.revision, "modal":state.policy.modal,"regions":state.policy.regions.len()}) }),
    }))
}
