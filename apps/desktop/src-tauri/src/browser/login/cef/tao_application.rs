//! Makes stable Tao's existing `TaoApp` singleton satisfy CEF's macOS
//! application protocol contract without replacing the Tauri/Wry runtime.

use cef_objc2::{
    ffi,
    runtime::{AnyClass, AnyObject, AnyProtocol, Bool, Imp, NSObjectProtocol, Sel},
    sel, ClassType, MainThreadMarker,
};
use cef_objc2_app_kit::{NSApp, NSApplication, NSEvent};
use std::{cell::Cell, ffi::CStr, sync::OnceLock};

thread_local! {
    static HANDLING_SEND_EVENT: Cell<bool> = const { Cell::new(false) };
}

static ORIGINAL_SEND_EVENT: OnceLock<Imp> = OnceLock::new();

#[derive(Clone, Debug)]
pub(crate) struct ProtocolAudit {
    pub(crate) class_name: String,
    pub(crate) is_ns_application: bool,
    pub(crate) is_tao_application: bool,
    pub(crate) cef_registered: bool,
    pub(crate) cr_control_registered: bool,
    pub(crate) cr_registered: bool,
    pub(crate) cef_protocol: bool,
    pub(crate) cr_control_protocol: bool,
    pub(crate) cr_protocol: bool,
    pub(crate) send_event: bool,
    pub(crate) get_handling: bool,
    pub(crate) set_handling: bool,
}

impl ProtocolAudit {
    pub(crate) fn ready(&self) -> bool {
        self.is_ns_application
            && self.is_tao_application
            && self.cef_registered
            && self.cr_control_registered
            && self.cr_registered
            && self.cef_protocol
            && self.cr_control_protocol
            && self.cr_protocol
            && self.send_event
            && self.get_handling
            && self.set_handling
    }
}

fn cstr(bytes: &'static [u8]) -> &'static CStr {
    CStr::from_bytes_with_nul(bytes).expect("static Objective-C name is NUL terminated")
}

fn protocol(bytes: &'static [u8]) -> Option<&'static AnyProtocol> {
    AnyProtocol::get(cstr(bytes))
}

pub(crate) fn audit() -> Result<ProtocolAudit, String> {
    let mtm = MainThreadMarker::new()
        .ok_or_else(|| "CEF TaoApp audit must run on the main thread".to_string())?;
    let ns_app = NSApp(mtm);
    let class = ns_app.class();
    let cef = protocol(b"CefAppProtocol\0");
    let cr_control = protocol(b"CrAppControlProtocol\0");
    let cr = protocol(b"CrAppProtocol\0");
    let tao_class = AnyClass::get(cstr(b"TaoApp\0"));

    Ok(ProtocolAudit {
        class_name: class.name().to_string_lossy().into_owned(),
        is_ns_application: ns_app.isKindOfClass(NSApplication::class()),
        is_tao_application: tao_class.is_some_and(|value| ns_app.isKindOfClass(value)),
        cef_registered: cef.is_some(),
        cr_control_registered: cr_control.is_some(),
        cr_registered: cr.is_some(),
        cef_protocol: cef.is_some_and(|value| class.conforms_to(value)),
        cr_control_protocol: cr_control.is_some_and(|value| class.conforms_to(value)),
        cr_protocol: cr.is_some_and(|value| class.conforms_to(value)),
        send_event: class.responds_to(sel!(sendEvent:)),
        get_handling: class.responds_to(sel!(isHandlingSendEvent)),
        set_handling: class.responds_to(sel!(setHandlingSendEvent:)),
    })
}

unsafe fn allocate_protocol(name: &'static [u8]) -> Result<*mut AnyProtocol, String> {
    let value = unsafe { ffi::objc_allocateProtocol(cstr(name).as_ptr()) };
    if value.is_null() {
        Err(format!(
            "failed to allocate Objective-C protocol {}",
            cstr(name).to_string_lossy()
        ))
    } else {
        Ok(value)
    }
}

unsafe fn ensure_protocols() -> Result<
    (
        &'static AnyProtocol,
        &'static AnyProtocol,
        &'static AnyProtocol,
    ),
    String,
> {
    let cr = match protocol(b"CrAppProtocol\0") {
        Some(value) => value,
        None => {
            let value = unsafe { allocate_protocol(b"CrAppProtocol\0")? };
            unsafe {
                ffi::protocol_addMethodDescription(
                    value,
                    sel!(isHandlingSendEvent),
                    cstr(b"B@:\0").as_ptr(),
                    Bool::YES,
                    Bool::YES,
                );
                ffi::objc_registerProtocol(value);
            }
            protocol(b"CrAppProtocol\0")
                .ok_or_else(|| "CrAppProtocol did not register".to_string())?
        }
    };

    let cr_control = match protocol(b"CrAppControlProtocol\0") {
        Some(value) => value,
        None => {
            let value = unsafe { allocate_protocol(b"CrAppControlProtocol\0")? };
            unsafe {
                ffi::protocol_addProtocol(value, cr);
                ffi::protocol_addMethodDescription(
                    value,
                    sel!(setHandlingSendEvent:),
                    cstr(b"v@:B\0").as_ptr(),
                    Bool::YES,
                    Bool::YES,
                );
                ffi::objc_registerProtocol(value);
            }
            protocol(b"CrAppControlProtocol\0")
                .ok_or_else(|| "CrAppControlProtocol did not register".to_string())?
        }
    };

    let cef = match protocol(b"CefAppProtocol\0") {
        Some(value) => value,
        None => {
            let value = unsafe { allocate_protocol(b"CefAppProtocol\0")? };
            unsafe {
                ffi::protocol_addProtocol(value, cr_control);
                ffi::objc_registerProtocol(value);
            }
            protocol(b"CefAppProtocol\0")
                .ok_or_else(|| "CefAppProtocol did not register".to_string())?
        }
    };

    Ok((cef, cr_control, cr))
}

unsafe extern "C-unwind" fn is_handling_send_event(_this: *mut AnyObject, _command: Sel) -> Bool {
    HANDLING_SEND_EVENT.with(|handling| Bool::new(handling.get()))
}

unsafe extern "C-unwind" fn set_handling_send_event(
    _this: *mut AnyObject,
    _command: Sel,
    handling: Bool,
) {
    HANDLING_SEND_EVENT.with(|state| state.set(handling.as_bool()));
}

struct RestoreHandling(bool);

impl Drop for RestoreHandling {
    fn drop(&mut self) {
        HANDLING_SEND_EVENT.with(|state| state.set(self.0));
    }
}

unsafe extern "C-unwind" fn cef_aware_send_event(
    this: *mut AnyObject,
    command: Sel,
    event: *mut NSEvent,
) {
    let previous = HANDLING_SEND_EVENT.with(|state| state.replace(true));
    let _restore = RestoreHandling(previous);
    type SendEvent = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut NSEvent);
    let original: SendEvent = unsafe {
        std::mem::transmute(
            *ORIGINAL_SEND_EVENT
                .get()
                .expect("original TaoApp sendEvent implementation is installed"),
        )
    };
    unsafe { original(this, command, event) };
}

fn getter_implementation() -> Imp {
    unsafe {
        std::mem::transmute::<unsafe extern "C-unwind" fn(*mut AnyObject, Sel) -> Bool, Imp>(
            is_handling_send_event,
        )
    }
}

fn setter_implementation() -> Imp {
    unsafe {
        std::mem::transmute::<unsafe extern "C-unwind" fn(*mut AnyObject, Sel, Bool), Imp>(
            set_handling_send_event,
        )
    }
}

fn send_event_implementation() -> Imp {
    unsafe {
        std::mem::transmute::<unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut NSEvent), Imp>(
            cef_aware_send_event,
        )
    }
}

pub(crate) fn install() -> Result<ProtocolAudit, String> {
    if ORIGINAL_SEND_EVENT.get().is_some() {
        let current = audit()?;
        return current
            .ready()
            .then_some(current)
            .ok_or_else(|| "previous CEF TaoApp patch is incomplete".to_string());
    }

    let before = audit()?;
    if !before.is_tao_application {
        return Err(format!(
            "refusing to patch NSApplication class {} because it does not inherit TaoApp",
            before.class_name
        ));
    }

    let mtm = MainThreadMarker::new()
        .ok_or_else(|| "CEF TaoApp patch must run on the main thread".to_string())?;
    let class = NSApp(mtm).class();
    let class_ptr = class as *const AnyClass as *mut AnyClass;
    let (cef, cr_control, cr) = unsafe { ensure_protocols()? };

    if !class.responds_to(sel!(isHandlingSendEvent)) {
        unsafe {
            ffi::class_addMethod(
                class_ptr,
                sel!(isHandlingSendEvent),
                getter_implementation(),
                cstr(b"B@:\0").as_ptr(),
            );
        }
    }
    if !class.responds_to(sel!(setHandlingSendEvent:)) {
        unsafe {
            ffi::class_addMethod(
                class_ptr,
                sel!(setHandlingSendEvent:),
                setter_implementation(),
                cstr(b"v@:B\0").as_ptr(),
            );
        }
    }

    let send_event = class
        .instance_method(sel!(sendEvent:))
        .ok_or_else(|| "TaoApp has no sendEvent: implementation".to_string())?;
    ORIGINAL_SEND_EVENT
        .set(send_event.implementation())
        .map_err(|_| "CEF TaoApp patch raced with another installation".to_string())?;
    let added_send_event = unsafe {
        ffi::class_addMethod(
            class_ptr,
            sel!(sendEvent:),
            send_event_implementation(),
            cstr(b"v@:@\0").as_ptr(),
        )
        .as_bool()
    };
    if !added_send_event {
        unsafe {
            send_event.set_implementation(send_event_implementation());
        }
    }

    unsafe {
        ffi::class_addProtocol(class_ptr, cr);
        ffi::class_addProtocol(class_ptr, cr_control);
        ffi::class_addProtocol(class_ptr, cef);
    }

    let after = audit()?;
    after
        .ready()
        .then_some(after)
        .ok_or_else(|| "TaoApp still does not satisfy the CEF protocol contract".to_string())
}
