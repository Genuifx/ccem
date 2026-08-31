//! CEF subprocess entry point bundled beside the CCEM desktop executable.
//!
//! On macOS the CEF API table is populated dynamically. No CEF-owned value may
//! be constructed before the framework has been loaded and `api_hash` has
//! initialized that table; violating this ordering can jump through a null
//! function pointer before `cef_execute_process` is reached.

#[cfg(target_os = "macos")]
enum FrameworkLoader {
    Bundled(cef::library_loader::LibraryLoader),
    #[cfg(debug_assertions)]
    Explicit(std::ffi::CString),
}

#[cfg(target_os = "macos")]
impl FrameworkLoader {
    fn new(executable: &std::path::Path) -> Self {
        #[cfg(debug_assertions)]
        if let Some(path) = std::env::var_os("CCEM_CEF_FRAMEWORK_PATH") {
            use std::os::unix::ffi::OsStrExt;
            let path = std::path::PathBuf::from(path);
            assert!(path.is_file(), "CEF framework override must be a file");
            return Self::Explicit(
                std::ffi::CString::new(path.as_os_str().as_bytes())
                    .expect("CEF framework override contains no NUL"),
            );
        }

        Self::Bundled(cef::library_loader::LibraryLoader::new(executable, true))
    }

    fn load(&self) -> bool {
        match self {
            Self::Bundled(loader) => loader.load(),
            #[cfg(debug_assertions)]
            Self::Explicit(path) => unsafe { cef::load_library(Some(&*path.as_ptr())) == 1 },
        }
    }

    fn is_bundled(&self) -> bool {
        matches!(self, Self::Bundled(_))
    }
}

#[cfg(target_os = "macos")]
impl Drop for FrameworkLoader {
    fn drop(&mut self) {
        #[cfg(debug_assertions)]
        if matches!(self, Self::Explicit(_)) && cef::unload_library() != 1 {
            eprintln!("CEF framework override did not unload cleanly in helper");
        }
    }
}

#[cfg(target_os = "macos")]
fn main() {
    let executable = std::env::current_exe().expect("resolve bundled CEF helper executable");
    let loader = FrameworkLoader::new(&executable);
    assert!(loader.load(), "load the bundled CEF framework");

    initialize_cef_api();
    run_subprocess(loader.is_bundled());

    // Keep the framework loaded until all CEF-owned values have been dropped.
    drop(loader);
}

#[cfg(all(target_os = "windows", debug_assertions))]
fn main() {
    initialize_cef_api();
    run_subprocess(false);
}

#[cfg(all(target_os = "windows", not(debug_assertions)))]
fn main() {
    eprintln!(
        "ccem-cef-helper is disabled in Windows release builds; use the official CEF bootstrap"
    );
    std::process::exit(78);
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn main() {
    eprintln!("ccem-cef-helper is supported only on macOS and Windows");
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn initialize_cef_api() {
    let hash = cef::api_hash(cef::sys::CEF_API_VERSION_LAST, 0);
    assert!(!hash.is_null(), "initialize the CEF API table");
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn run_subprocess(sandbox_enabled: bool) {
    use cef::{args::Args, execute_process, App};

    // Args owns CEF strings internally, so it must be constructed only after
    // the CEF API table is live.
    let args = Args::new();

    #[cfg(target_os = "macos")]
    let _sandbox = sandbox_enabled.then(|| {
        let mut sandbox = cef::sandbox::Sandbox::new();
        sandbox.initialize(args.as_main_args());
        sandbox
    });

    let exit_code = execute_process(
        Some(args.as_main_args()),
        None::<&mut App>,
        std::ptr::null_mut(),
    );

    if exit_code >= 0 {
        std::process::exit(exit_code);
    }
}
