use super::{
    availability::{self, CefAvailability},
    pump::CefExternalPump,
    surface,
};
use cef::*;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

const CONTEXT_INITIALIZATION_TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) const NETWORK_SERVICE_SANDBOX_FEATURE: &str = "NetworkServiceSandbox";
pub(crate) const NETWORK_SERVICE_LPAC_FEATURE: &str = "WinSboxNetworkServiceSandboxIsLPAC";

fn feature_list_contains(current: &str, expected: &str) -> bool {
    current.split(',').any(|value| {
        value
            .trim()
            .split(['<', ':'])
            .next()
            .is_some_and(|name| name == expected)
    })
}

fn enable_network_service_sandbox(current: &str) -> String {
    let mut features = current
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    if !feature_list_contains(current, NETWORK_SERVICE_SANDBOX_FEATURE) {
        features.push(NETWORK_SERVICE_SANDBOX_FEATURE.to_string());
    }
    if !feature_list_contains(current, NETWORK_SERVICE_LPAC_FEATURE) {
        features.push(NETWORK_SERVICE_LPAC_FEATURE.to_string());
    }
    features.join(",")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CefRuntimeLayout {
    /// On Windows this is the resolved libcef.dll path. The field name stays
    /// platform-neutral at the host boundary shared with release diagnostics.
    pub(crate) framework_path: PathBuf,
    pub(crate) browser_subprocess_path: Option<PathBuf>,
    pub(crate) bundled: bool,
    pub(crate) sandbox_enabled: bool,
    pub(crate) network_service_sandbox_requested: bool,
    pub(crate) network_service_lpac_requested: bool,
}

pub(crate) fn resolve_runtime_layout(
    executable: &Path,
    runtime_override: Option<&Path>,
    sandbox_enabled: bool,
) -> Result<CefRuntimeLayout, String> {
    let executable_dir = executable
        .parent()
        .ok_or_else(|| "CCEM executable has no parent directory".to_string())?;
    let (runtime_root, bundled) = match runtime_override {
        Some(path) => (require_directory(path, "CEF runtime override")?, false),
        None => (executable_dir.to_path_buf(), true),
    };

    // The cef-dll-sys build copies the standard CEF distribution beside the
    // target binary. The production installer must preserve this flat layout.
    let framework_path = require_file(&runtime_root.join("libcef.dll"), "CEF libcef.dll")?;
    require_file(&runtime_root.join("icudtl.dat"), "CEF ICU data")?;
    require_file(&runtime_root.join("resources.pak"), "CEF resources")?;
    let locales = require_directory(&runtime_root.join("locales"), "CEF locales")?;
    if !locales.join("en-US.pak").is_file() {
        return Err(format!(
            "CEF en-US locale is missing at {}",
            locales.join("en-US.pak").display()
        ));
    }

    let browser_subprocess_path = if sandbox_enabled {
        require_file(
            &executable_dir.join("ccem-desktop.dll"),
            "CEF sandbox client DLL",
        )?;
        None
    } else {
        let helper_name = format!("ccem-cef-helper{}", std::env::consts::EXE_SUFFIX);
        Some(require_file(
            &executable_dir.join(helper_name),
            "CEF development subprocess helper",
        )?)
    };
    Ok(CefRuntimeLayout {
        framework_path,
        browser_subprocess_path,
        bundled,
        sandbox_enabled,
        network_service_sandbox_requested: false,
        network_service_lpac_requested: false,
    })
}

fn require_file(path: &Path, label: &str) -> Result<PathBuf, String> {
    if !path.is_file() {
        return Err(format!("{label} is missing at {}", path.display()));
    }
    path.canonicalize()
        .map_err(|error| format!("resolve {label} {}: {error}", path.display()))
}

fn require_directory(path: &Path, label: &str) -> Result<PathBuf, String> {
    if !path.is_dir() {
        return Err(format!("{label} is missing at {}", path.display()));
    }
    path.canonicalize()
        .map_err(|error| format!("resolve {label} {}: {error}", path.display()))
}

cef::wrap_browser_process_handler! {
    struct CcemBrowserProcessHandler {
        pump: CefExternalPump,
        context_initialized: Arc<AtomicBool>,
    }

    impl BrowserProcessHandler {
        fn on_context_initialized(&self) {
            self.context_initialized.store(true, Ordering::SeqCst);
        }

        fn on_schedule_message_pump_work(&self, delay_ms: i64) {
            self.pump.schedule_message_pump_work(delay_ms);
        }
    }
}

cef::wrap_app! {
    struct CcemCefApp {
        pump: CefExternalPump,
        context_initialized: Arc<AtomicBool>,
        network_service_sandbox_requested: Arc<AtomicBool>,
        network_service_lpac_requested: Arc<AtomicBool>,
    }

    impl App {
        fn on_before_command_line_processing(
            &self,
            process_type: Option<&CefString>,
            command_line: Option<&mut CommandLine>,
        ) {
            if process_type
                .map(CefString::to_string)
                .is_some_and(|value| !value.is_empty())
            {
                return;
            }
            let Some(command_line) = command_line else {
                return;
            };
            let name = CefString::from("enable-features");
            let current = CefString::from(&command_line.switch_value(Some(&name))).to_string();
            let features = enable_network_service_sandbox(&current);
            let features = CefString::from(features.as_str());
            // CEF 150 leaves NetworkServiceSandbox disabled by default. Mode 2 explicitly
            // enables it in the broker without discarding any feature switches supplied by CEF.
            command_line.append_switch_with_value(Some(&name), Some(&features));
            let applied = CefString::from(&command_line.switch_value(Some(&name))).to_string();
            self.network_service_sandbox_requested.store(
                feature_list_contains(&applied, NETWORK_SERVICE_SANDBOX_FEATURE),
                Ordering::SeqCst,
            );
            self.network_service_lpac_requested.store(
                feature_list_contains(&applied, NETWORK_SERVICE_LPAC_FEATURE),
                Ordering::SeqCst,
            );
        }

        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> {
            Some(CcemBrowserProcessHandler::new(
                self.pump.clone(),
                self.context_initialized.clone(),
            ))
        }
    }
}

pub(crate) struct CefProcess {
    pump: CefExternalPump,
    app: Option<App>,
    initialized: bool,
    shutdown_prepared: bool,
    layout: CefRuntimeLayout,
}

impl CefProcess {
    pub(crate) fn initialize(
        executable: &Path,
        runtime_override: Option<&Path>,
        cache_root: &Path,
    ) -> Result<Self, String> {
        match availability::detect() {
            CefAvailability::Available => {}
            CefAvailability::UnsupportedPlatform => {
                return Err("embedded CEF is unavailable on this platform".to_string());
            }
            CefAvailability::UnsupportedMacOs { .. } => {
                return Err("unexpected macOS availability result on Windows".to_string());
            }
        }
        if !cfg!(target_arch = "x86_64") {
            return Err("Mode 2 currently supports only Windows x86_64".to_string());
        }
        let sandbox_context = crate::windows_bootstrap::sandbox_context();
        require_release_sandbox_policy(sandbox_context.is_some())?;
        if !cache_root.is_absolute() {
            return Err("CEF cache root must be absolute".to_string());
        }
        fs::create_dir_all(cache_root)
            .map_err(|error| format!("create CEF cache root {}: {error}", cache_root.display()))?;
        let cache_root = cache_root
            .canonicalize()
            .map_err(|error| format!("resolve CEF cache root {}: {error}", cache_root.display()))?;
        let layout =
            resolve_runtime_layout(executable, runtime_override, sandbox_context.is_some())?;

        surface::windows::mark_owner_thread()?;
        let initialized = Self::initialize_on_owner(layout, cache_root, sandbox_context);
        if initialized.is_err() {
            surface::windows::clear_owner_thread();
        }
        initialized
    }

    fn initialize_on_owner(
        mut layout: CefRuntimeLayout,
        cache_root: PathBuf,
        sandbox_context: Option<crate::windows_bootstrap::WindowsSandboxContext>,
    ) -> Result<Self, String> {
        // libcef.dll is a normal delayed runtime dependency on Windows. Calling
        // cef_api_hash first both validates the imported API table and prevents
        // construction of CEF-owned wrappers against a mismatched distribution.
        let api_hash = cef::api_hash(cef::sys::CEF_API_VERSION_LAST, 0);
        if api_hash.is_null() {
            return Err("CEF API table initialization returned no hash".to_string());
        }

        let main_args = sandbox_context.map_or_else(
            || cef::args::Args::new().as_main_args().clone(),
            |context| context.main_args(),
        );
        let pump = CefExternalPump::new();
        let context_initialized = Arc::new(AtomicBool::new(false));
        let network_service_sandbox_requested = Arc::new(AtomicBool::new(false));
        let network_service_lpac_requested = Arc::new(AtomicBool::new(false));
        let mut app = CcemCefApp::new(
            pump.clone(),
            context_initialized.clone(),
            network_service_sandbox_requested.clone(),
            network_service_lpac_requested.clone(),
        );
        if sandbox_context.is_none() {
            let execute_result =
                cef::execute_process(Some(&main_args), Some(&mut app), std::ptr::null_mut());
            if execute_result != -1 {
                pump.stop();
                return Err(format!(
                    "CEF browser process unexpectedly exited with code {execute_result}"
                ));
            }
        }

        let runtime_root = layout
            .framework_path
            .parent()
            .ok_or_else(|| "CEF libcef.dll has no runtime directory".to_string())?;
        let (no_sandbox, browser_subprocess_path, sandbox_info) = match sandbox_context {
            Some(context) => (0, CefString::default(), context.sandbox_info()),
            None => {
                let browser_subprocess_path = layout
                    .browser_subprocess_path
                    .as_ref()
                    .map(|path| CefString::from(path.to_string_lossy().as_ref()))
                    .ok_or_else(|| {
                        "CEF development subprocess helper is unavailable".to_string()
                    })?;
                (1, browser_subprocess_path, std::ptr::null_mut())
            }
        };
        let settings = Settings {
            no_sandbox,
            browser_subprocess_path,
            resources_dir_path: CefString::from(runtime_root.to_string_lossy().as_ref()),
            locales_dir_path: CefString::from(
                runtime_root.join("locales").to_string_lossy().as_ref(),
            ),
            multi_threaded_message_loop: 0,
            external_message_pump: 1,
            root_cache_path: CefString::from(cache_root.to_string_lossy().as_ref()),
            cache_path: CefString::default(),
            ..Default::default()
        };
        let initialized = cef::initialize(
            Some(&main_args),
            Some(&settings),
            Some(&mut app),
            sandbox_info,
        ) == 1;
        if !initialized {
            pump.stop();
            return Err("CEF initialization returned false".to_string());
        }
        if !network_service_sandbox_requested.load(Ordering::SeqCst)
            || !network_service_lpac_requested.load(Ordering::SeqCst)
        {
            pump.stop();
            cef::shutdown();
            return Err(
                "CEF broker did not retain the requested NetworkServiceSandbox LPAC features"
                    .to_string(),
            );
        }
        layout.network_service_sandbox_requested = true;
        layout.network_service_lpac_requested = true;

        let deadline = Instant::now() + CONTEXT_INITIALIZATION_TIMEOUT;
        while !context_initialized.load(Ordering::SeqCst) {
            if Instant::now() >= deadline {
                pump.stop();
                cef::shutdown();
                return Err("CEF context initialization timed out".to_string());
            }
            pump.do_message_loop_work();
            std::thread::sleep(Duration::from_millis(1));
        }

        Ok(Self {
            pump,
            app: Some(app),
            initialized,
            shutdown_prepared: false,
            layout,
        })
    }

    pub(crate) fn layout(&self) -> &CefRuntimeLayout {
        &self.layout
    }

    pub(crate) fn prepare_shutdown(&mut self) -> Result<(), String> {
        if !self.initialized || self.shutdown_prepared {
            return Ok(());
        }
        surface::windows::shutdown_all(&self.pump)?;
        self.shutdown_prepared = true;
        Ok(())
    }

    pub(crate) fn finish_shutdown(mut self) -> Result<(), String> {
        if self.initialized {
            if !self.shutdown_prepared {
                std::mem::forget(self);
                return Err(
                    "CEF shutdown reached finalization without a completed close drain".to_string(),
                );
            }
            if let Err(error) = self.pump.drain_after_app_loop() {
                std::mem::forget(self);
                return Err(error);
            }
            self.pump.stop();
            cef::shutdown();
            self.initialized = false;
        }
        drop(self.app.take());
        surface::windows::clear_owner_thread();
        Ok(())
    }
}

#[cfg(debug_assertions)]
fn require_release_sandbox_policy(_sandbox_context_present: bool) -> Result<(), String> {
    Ok(())
}

#[cfg(not(debug_assertions))]
fn require_release_sandbox_policy(sandbox_context_present: bool) -> Result<(), String> {
    if sandbox_context_present {
        Ok(())
    } else {
        Err(
            "Windows Mode 2 release requires the official CEF bootstrap sandbox context"
                .to_string(),
        )
    }
}
