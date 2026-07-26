use super::{
    bootstrap::{CefProcess, CefRuntimeLayout},
    lifecycle::{CefHostStateMachine, CefHostStatus},
    surface::{
        macos_child_bounds, CefSurfaceConnection, CefSurfaceOpenSpec, CefSurfaceRequest,
        CefSurfaceSnapshot, LogicalViewport,
    },
};
use cef_objc2::MainThreadMarker;
use cef_objc2_app_kit::NSView;
use std::{
    cell::RefCell,
    path::PathBuf,
    sync::{
        atomic::{AtomicU8, Ordering},
        mpsc, Arc, Mutex, MutexGuard,
    },
    time::Duration,
};
use tauri::{AppHandle, Manager};

const MAIN_THREAD_OPERATION_TIMEOUT: Duration = Duration::from_secs(20);
const MAIN_THREAD_PENDING: u8 = 0;
const MAIN_THREAD_RUNNING: u8 = 1;
const MAIN_THREAD_CANCELLED: u8 = 2;
const MAIN_THREAD_COMPLETED: u8 = 3;

thread_local! {
    static CEF_PROCESS: RefCell<Option<CefProcess>> = const { RefCell::new(None) };
}

pub(crate) struct CefHostController {
    cache_root: PathBuf,
    startup_error: Option<String>,
    operation_gate: Mutex<()>,
    lifecycle: Mutex<CefHostStateMachine>,
    last_error: Mutex<Option<String>>,
}

impl CefHostController {
    pub(crate) fn new(cache_root: PathBuf) -> Result<Self, String> {
        if !cache_root.is_absolute() {
            return Err("CEF cache root must be absolute".to_string());
        }
        Ok(Self {
            cache_root,
            startup_error: None,
            operation_gate: Mutex::new(()),
            lifecycle: Mutex::new(CefHostStateMachine::new()),
            last_error: Mutex::new(None),
        })
    }

    pub(crate) fn unavailable(error: impl Into<String>) -> Self {
        let error = error.into();
        Self {
            cache_root: PathBuf::new(),
            startup_error: Some(error.clone()),
            operation_gate: Mutex::new(()),
            lifecycle: Mutex::new(CefHostStateMachine::new()),
            last_error: Mutex::new(Some(error)),
        }
    }

    pub(crate) fn status(&self) -> CefHostStatus {
        self.lifecycle
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .status()
    }

    pub(crate) fn last_error(&self) -> Option<String> {
        self.last_error
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub(crate) fn ensure_ready(&self, app: &AppHandle) -> Result<CefRuntimeLayout, String> {
        let _operation = self
            .operation_gate
            .lock()
            .map_err(|_| "CEF host operation gate is unavailable".to_string())?;
        if let Some(error) = self.startup_error.as_ref() {
            return Err(error.clone());
        }
        match self.status() {
            CefHostStatus::Ready => return self.layout(app),
            CefHostStatus::Failed => {
                return Err(self.last_error().unwrap_or_else(|| {
                    "CEF initialization failed terminally; restart CCEM before retrying Mode 2."
                        .to_string()
                }))
            }
            CefHostStatus::ShuttingDown | CefHostStatus::Shutdown => {
                return Err(
                    "CEF host is shutting down and cannot create Mode 2 surfaces.".to_string(),
                )
            }
            CefHostStatus::Uninitialized | CefHostStatus::Initializing => {}
        }

        let generation = self
            .lifecycle
            .lock()
            .map_err(|_| "CEF host lifecycle is unavailable".to_string())?
            .begin_initialization()
            .map_err(str::to_string)?;
        let result = self.initialize_process(app);
        let mut lifecycle = self
            .lifecycle
            .lock()
            .map_err(|_| "CEF host lifecycle is unavailable".to_string())?;
        match &result {
            Ok(_) => {
                lifecycle.mark_ready(generation).map_err(str::to_string)?;
                *self
                    .last_error
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
            }
            Err(error) => {
                // A failure may happen after cef_initialize succeeded and cef_shutdown ran.
                // Chromium does not support another initialization in the same process, so all
                // failed attempts are terminal and require an app restart.
                lifecycle.mark_failed(generation).map_err(str::to_string)?;
                *self
                    .last_error
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(error.clone());
            }
        }
        result
    }

    pub(crate) fn open_surface(
        &self,
        app: &AppHandle,
        request: CefSurfaceRequest,
    ) -> Result<CefSurfaceConnection, String> {
        self.ensure_ready(app)?;
        let _operation = self.lock_ready_operation()?;
        let app_handle = app.clone();
        let profile_root = self.cache_root.clone();
        run_on_main(app, move || {
            let main_window = app_handle
                .get_webview_window("main")
                .ok_or_else(|| "CCEM main window is unavailable".to_string())?;
            let parent_view = main_window
                .ns_view()
                .map_err(|error| format!("resolve CCEM content NSView: {error}"))?;
            let parent = unsafe { parent_view.cast::<NSView>().as_ref() }
                .ok_or_else(|| "CCEM content NSView is null".to_string())?;
            let bounds = macos_child_bounds(request.viewport, parent.bounds().size.height)?;
            super::surface::macos::create_surface(
                &app_handle,
                &profile_root,
                CefSurfaceOpenSpec {
                    surface_id: request.surface_id,
                    profile_id: request.profile_id,
                    initial_url: request.initial_url,
                    parent_view: parent_view as usize,
                    bounds,
                    visible: request.visible,
                    // Debug CEF uses Chromium's fixed test key and must never persist cookies or
                    // OAuth credentials. A release process reaches this branch only after the
                    // trusted Developer ID requirement has succeeded.
                    persistent_profile_storage: !cfg!(debug_assertions),
                },
            )
        })
    }

    pub(crate) fn set_surface_viewport(
        &self,
        app: &AppHandle,
        surface_id: String,
        viewport: LogicalViewport,
    ) -> Result<(), String> {
        let _operation = self.lock_ready_operation()?;
        let app_handle = app.clone();
        run_on_main(app, move || {
            let main_window = app_handle
                .get_webview_window("main")
                .ok_or_else(|| "CCEM main window is unavailable".to_string())?;
            let parent_view = main_window
                .ns_view()
                .map_err(|error| format!("resolve CCEM content NSView: {error}"))?;
            let parent = unsafe { parent_view.cast::<NSView>().as_ref() }
                .ok_or_else(|| "CCEM content NSView is null".to_string())?;
            let bounds = macos_child_bounds(viewport, parent.bounds().size.height)?;
            super::surface::macos::set_bounds(&surface_id, bounds)
        })
    }

    pub(crate) fn set_surface_visible(
        &self,
        app: &AppHandle,
        surface_id: String,
        visible: bool,
    ) -> Result<(), String> {
        let _operation = self.lock_ready_operation()?;
        run_on_main(app, move || {
            super::surface::macos::set_visible(&surface_id, visible)
        })
    }

    pub(crate) fn occlude_surface(
        &self,
        app: &AppHandle,
        surface_id: String,
    ) -> Result<(), String> {
        let _operation = self.lock_ready_operation()?;
        run_on_main(app, move || super::surface::macos::occlude(&surface_id))
    }

    pub(crate) fn navigate_surface(
        &self,
        app: &AppHandle,
        surface_id: String,
        url: String,
    ) -> Result<(), String> {
        let _operation = self.lock_ready_operation()?;
        run_on_main(app, move || {
            super::surface::macos::navigate(&surface_id, &url)
        })
    }

    pub(crate) fn surface_snapshot(
        &self,
        app: &AppHandle,
        surface_id: String,
    ) -> Result<CefSurfaceSnapshot, String> {
        let _operation = self.lock_ready_operation()?;
        run_on_main(app, move || super::surface::macos::snapshot(&surface_id))
    }

    pub(crate) fn close_surface(&self, app: &AppHandle, surface_id: String) -> Result<(), String> {
        let _operation = self.lock_ready_operation()?;
        run_on_main(app, move || super::surface::macos::close(&surface_id))
    }

    pub(crate) fn close_popup(&self, app: &AppHandle, surface_id: String) -> Result<(), String> {
        let _operation = self.lock_ready_operation()?;
        run_on_main(app, move || super::surface::macos::close_popup(&surface_id))
    }

    fn lock_ready_operation(&self) -> Result<MutexGuard<'_, ()>, String> {
        let operation = self
            .operation_gate
            .lock()
            .map_err(|_| "CEF host operation gate is unavailable".to_string())?;
        if self.status() != CefHostStatus::Ready {
            return Err("CEF host is not accepting surface operations".to_string());
        }
        Ok(operation)
    }

    fn initialize_process(&self, app: &AppHandle) -> Result<CefRuntimeLayout, String> {
        let executable = std::env::current_exe()
            .map_err(|error| format!("resolve CCEM executable for CEF: {error}"))?;
        #[cfg(debug_assertions)]
        let framework_override = std::env::var_os("CCEM_CEF_FRAMEWORK_PATH").map(PathBuf::from);
        #[cfg(not(debug_assertions))]
        let framework_override: Option<PathBuf> = None;
        let cache_root = self.cache_root.clone();
        let initialize = move || {
            CEF_PROCESS.with(|slot| {
                if slot.borrow().is_some() {
                    return Err("CEF process is already initialized".to_string());
                }
                let process = CefProcess::initialize(
                    &executable,
                    framework_override.as_deref(),
                    &cache_root,
                )?;
                let layout = process.layout().clone();
                *slot.borrow_mut() = Some(process);
                Ok(layout)
            })
        };

        run_on_main(app, initialize)
    }

    fn layout(&self, app: &AppHandle) -> Result<CefRuntimeLayout, String> {
        let read_layout = || {
            CEF_PROCESS.with(|slot| {
                slot.borrow()
                    .as_ref()
                    .map(|process| process.layout().clone())
                    .ok_or_else(|| "CEF lifecycle is ready but the process is absent".to_string())
            })
        };
        run_on_main(app, read_layout)
    }

    pub(crate) fn prepare_shutdown_current_thread(&self) -> Result<(), String> {
        let _operation = self
            .operation_gate
            .lock()
            .map_err(|_| "CEF host operation gate is unavailable".to_string())?;
        if MainThreadMarker::new().is_none() {
            return Err("CEF shutdown must run on the main thread".to_string());
        }
        self.lifecycle
            .lock()
            .map_err(|_| "CEF host lifecycle is unavailable".to_string())?
            .begin_shutdown()
            .map_err(str::to_string)?;
        CEF_PROCESS.with(|slot| {
            if let Some(process) = slot.borrow_mut().as_mut() {
                process.prepare_shutdown()?;
            }
            Ok::<_, String>(())
        })
    }

    pub(crate) fn prepare_shutdown(self: &Arc<Self>, app: &AppHandle) -> Result<(), String> {
        let host = Arc::clone(self);
        run_on_main(app, move || host.prepare_shutdown_current_thread())
    }

    pub(crate) fn finish_shutdown_current_thread(&self) -> Result<(), String> {
        let _operation = self
            .operation_gate
            .lock()
            .map_err(|_| "CEF host operation gate is unavailable".to_string())?;
        if MainThreadMarker::new().is_none() {
            return Err("CEF shutdown must finish on the main thread".to_string());
        }
        CEF_PROCESS.with(|slot| {
            if let Some(process) = slot.borrow_mut().take() {
                process.finish_shutdown()?;
            }
            Ok::<_, String>(())
        })?;
        self.lifecycle
            .lock()
            .map_err(|_| "CEF host lifecycle is unavailable".to_string())?
            .mark_shutdown()
            .map_err(str::to_string)
    }
}

fn run_on_main<T, F>(app: &AppHandle, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    if MainThreadMarker::new().is_some() {
        return operation();
    }
    let (sender, receiver) = mpsc::sync_channel(1);
    let phase = Arc::new(AtomicU8::new(MAIN_THREAD_PENDING));
    let phase_for_main = Arc::clone(&phase);
    app.run_on_main_thread(move || {
        if phase_for_main
            .compare_exchange(
                MAIN_THREAD_PENDING,
                MAIN_THREAD_RUNNING,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_err()
        {
            return;
        }
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation))
            .map_err(|_| "CEF main-thread operation panicked".to_string())
            .and_then(|result| result);
        phase_for_main.store(MAIN_THREAD_COMPLETED, Ordering::SeqCst);
        let _ = sender.send(result);
    })
    .map_err(|error| format!("schedule CEF main-thread operation: {error}"))?;
    match receiver.recv_timeout(MAIN_THREAD_OPERATION_TIMEOUT) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("CEF main-thread operation channel disconnected".to_string())
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            if phase
                .compare_exchange(
                    MAIN_THREAD_PENDING,
                    MAIN_THREAD_CANCELLED,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                )
                .is_ok()
            {
                return Err("CEF main-thread operation timed out before execution".to_string());
            }
            // Once a mutation starts, returning a timeout would let the caller
            // proceed while an orphan native operation is still changing state.
            receiver
                .recv()
                .map_err(|_| "CEF running main-thread operation disconnected".to_string())?
        }
    }
}
