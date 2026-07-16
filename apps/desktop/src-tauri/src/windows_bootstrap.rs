//! Windows CEF sandbox entry point loaded by the official CEF bootstrap EXE.
//!
//! CEF 150 requires the browser process and every child process to reuse the
//! same executable when the sandbox is enabled. The distributed
//! `bootstrap.exe` owns the broker state and loads this crate as
//! `ccem-desktop.dll`, then calls the exported five-argument `RunWinMain`.

use std::{
    cell::Cell,
    ffi::c_void,
    panic::{catch_unwind, AssertUnwindSafe},
};

const EXIT_INVALID_BOOTSTRAP: i32 = 70;
const EXIT_CEF_API_MISMATCH: i32 = 71;
const EXIT_NESTED_BOOTSTRAP: i32 = 72;
const EXIT_PANIC: i32 = 101;

#[derive(Clone, Copy, Debug)]
pub(crate) struct WindowsSandboxContext {
    instance: cef::sys::HINSTANCE,
    sandbox_info: *mut u8,
}

impl WindowsSandboxContext {
    pub(crate) fn main_args(self) -> cef::MainArgs {
        cef::MainArgs {
            instance: self.instance,
        }
    }

    pub(crate) fn sandbox_info(self) -> *mut u8 {
        self.sandbox_info
    }
}

thread_local! {
    static WINDOWS_SANDBOX_CONTEXT: Cell<Option<WindowsSandboxContext>> = const { Cell::new(None) };
}

pub(crate) fn sandbox_context() -> Option<WindowsSandboxContext> {
    WINDOWS_SANDBOX_CONTEXT.get()
}

struct SandboxContextGuard;

impl SandboxContextGuard {
    fn install(context: WindowsSandboxContext) -> Result<Self, i32> {
        WINDOWS_SANDBOX_CONTEXT.with(|slot| {
            if slot.get().is_some() {
                return Err(EXIT_NESTED_BOOTSTRAP);
            }
            slot.set(Some(context));
            Ok(Self)
        })
    }
}

impl Drop for SandboxContextGuard {
    fn drop(&mut self) {
        WINDOWS_SANDBOX_CONTEXT.set(None);
    }
}

unsafe fn run_bootstrapped(
    instance: cef::sys::HINSTANCE,
    sandbox_info: *mut u8,
    version_info: *mut c_void,
) -> i32 {
    if !cfg!(target_arch = "x86_64") || sandbox_info.is_null() || version_info.is_null() {
        return EXIT_INVALID_BOOTSTRAP;
    }

    // No CEF-owned value may be constructed until the API table is live.
    if cef::api_hash(cef::sys::CEF_API_VERSION_LAST, 0).is_null() {
        return EXIT_CEF_API_MISMATCH;
    }

    let context = WindowsSandboxContext {
        instance,
        sandbox_info,
    };
    let main_args = context.main_args();
    let child_exit = cef::execute_process(
        Some(&main_args),
        None::<&mut cef::App>,
        context.sandbox_info(),
    );
    if child_exit >= 0 {
        return child_exit;
    }

    // Keep the bootstrap-owned sandbox pointer alive on the UI thread for the
    // later, lazy CefInitialize call. Returning instead of process::exit lets
    // bootstrap.exe execute its broker cleanup handlers.
    let _guard = match SandboxContextGuard::install(context) {
        Ok(guard) => guard,
        Err(exit_code) => return exit_code,
    };
    crate::run_desktop_app()
}

/// Exact CEF 150 bootstrap ABI.
///
/// The fifth `cef_version_info_t*` argument is opaque here because cef-rs does
/// not expose that bootstrap-only type. CEF's official sample also accepts and
/// ignores it, but the pointer-sized ABI slot must still be present.
#[no_mangle]
#[allow(non_snake_case)]
pub unsafe extern "C" fn RunWinMain(
    instance: cef::sys::HINSTANCE,
    _command_line: *mut u16,
    _command_show: i32,
    sandbox_info: *mut u8,
    version_info: *mut c_void,
) -> i32 {
    match catch_unwind(AssertUnwindSafe(|| {
        run_bootstrapped(instance, sandbox_info, version_info)
    })) {
        Ok(exit_code) => exit_code,
        Err(_) => EXIT_PANIC,
    }
}
