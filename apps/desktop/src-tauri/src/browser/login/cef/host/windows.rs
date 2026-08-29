use super::{
    bootstrap::{CefProcess, CefRuntimeLayout},
    lifecycle::{CefHostStateMachine, CefHostStatus},
    surface::{
        windows_child_bounds, CefSurfaceConnection, CefSurfaceNavigationAction, CefSurfaceOpenSpec,
        CefSurfaceRequest, CefSurfaceSnapshot, LogicalViewport,
    },
};
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
use windows::Win32::{
    Foundation::{HWND, RECT},
    UI::WindowsAndMessaging::{GetClientRect, IsWindow},
};

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
                }));
            }
            CefHostStatus::ShuttingDown | CefHostStatus::Shutdown => {
                return Err(
                    "CEF host is shutting down and cannot create Mode 2 surfaces.".to_string(),
                );
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
            let parent = main_window
                .hwnd()
                .map_err(|error| format!("resolve CCEM main HWND: {error}"))?;
            validate_parent(parent)?;
            let bounds = viewport_bounds(&main_window, parent, request.viewport)?;
            super::surface::windows::create_surface(
                &app_handle,
                &profile_root,
                CefSurfaceOpenSpec {
                    surface_id: request.surface_id,
                    profile_id: request.profile_id,
                    initial_url: request.initial_url,
                    parent_view: parent.0 as usize,
                    bounds,
                    visible: request.visible,
                    // Windows Chromium encrypts profile credentials with per-user DPAPI and does
                    // not require macOS Safe Storage authorization. Debug data is already rooted
                    // under browser-dev, so the same profile lifecycle can be exercised safely.
                    persistent_profile_storage: true,
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
            let parent = main_window
                .hwnd()
                .map_err(|error| format!("resolve CCEM main HWND: {error}"))?;
            validate_parent(parent)?;
            let bounds = viewport_bounds(&main_window, parent, viewport)?;
            super::surface::windows::set_bounds(&surface_id, bounds)
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
            super::surface::windows::set_visible(&surface_id, visible)
        })
    }

    pub(crate) fn occlude_surface(
        &self,
        app: &AppHandle,
        surface_id: String,
    ) -> Result<(), String> {
        let _operation = self.lock_ready_operation()?;
        run_on_main(app, move || super::surface::windows::occlude(&surface_id))
    }

    pub(crate) fn navigate_surface(
        &self,
        app: &AppHandle,
        surface_id: String,
        url: String,
    ) -> Result<(), String> {
        let _operation = self.lock_ready_operation()?;
        run_on_main(app, move || {
            super::surface::windows::navigate(&surface_id, &url)
        })
    }

    pub(crate) fn navigation_action_surface(
        &self,
        app: &AppHandle,
        surface_id: String,
        action: CefSurfaceNavigationAction,
    ) -> Result<(), String> {
        let _operation = self.lock_ready_operation()?;
        run_on_main(app, move || {
            super::surface::windows::navigation_action(&surface_id, action)
        })
    }

    pub(crate) fn surface_snapshot(
        &self,
        app: &AppHandle,
        surface_id: String,
    ) -> Result<CefSurfaceSnapshot, String> {
        let _operation = self.lock_ready_operation()?;
        run_on_main(app, move || super::surface::windows::snapshot(&surface_id))
    }

    pub(crate) fn native_window_observation(
        &self,
        app: &AppHandle,
        surface_id: String,
    ) -> Result<super::surface::WindowsNativeWindowObservation, String> {
        let _operation = self.lock_ready_operation()?;
        run_on_main(app, move || {
            super::surface::windows::native_window_observation(&surface_id)
        })
    }

    pub(crate) fn close_surface(&self, app: &AppHandle, surface_id: String) -> Result<(), String> {
        let _operation = self.lock_ready_operation()?;
        run_on_main(app, move || super::surface::windows::close(&surface_id))
    }

    pub(crate) fn close_popup(&self, app: &AppHandle, surface_id: String) -> Result<(), String> {
        let _operation = self.lock_ready_operation()?;
        run_on_main(app, move || {
            super::surface::windows::close_popup(&surface_id)
        })
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
        let runtime_override = std::env::var_os("CCEM_CEF_RUNTIME_PATH").map(PathBuf::from);
        #[cfg(not(debug_assertions))]
        let runtime_override: Option<PathBuf> = None;
        let cache_root = self.cache_root.clone();
        run_on_main(app, move || {
            CEF_PROCESS.with(|slot| {
                if slot.borrow().is_some() {
                    return Err("CEF process is already initialized".to_string());
                }
                let process =
                    CefProcess::initialize(&executable, runtime_override.as_deref(), &cache_root)?;
                let layout = process.layout().clone();
                *slot.borrow_mut() = Some(process);
                Ok(layout)
            })
        })
    }

    fn layout(&self, app: &AppHandle) -> Result<CefRuntimeLayout, String> {
        run_on_main(app, || {
            CEF_PROCESS.with(|slot| {
                slot.borrow()
                    .as_ref()
                    .map(|process| process.layout().clone())
                    .ok_or_else(|| "CEF lifecycle is ready but the process is absent".to_string())
            })
        })
    }

    pub(crate) fn prepare_shutdown_current_thread(&self) -> Result<(), String> {
        let _operation = self
            .operation_gate
            .lock()
            .map_err(|_| "CEF host operation gate is unavailable".to_string())?;
        if self.status() == CefHostStatus::Ready && !super::surface::windows::is_owner_thread() {
            return Err("CEF shutdown must run on the Windows UI thread".to_string());
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
        if self.status() == CefHostStatus::ShuttingDown
            && CEF_PROCESS.with(|slot| slot.borrow().is_some())
            && !super::surface::windows::is_owner_thread()
        {
            return Err("CEF shutdown must finish on the Windows UI thread".to_string());
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

fn validate_parent(parent: HWND) -> Result<(), String> {
    if unsafe { IsWindow(Some(parent)).as_bool() } {
        Ok(())
    } else {
        Err("CCEM main HWND is invalid".to_string())
    }
}

fn viewport_bounds(
    window: &tauri::WebviewWindow,
    parent: HWND,
    viewport: LogicalViewport,
) -> Result<super::surface::NativeChildBounds, String> {
    let mut client = RECT::default();
    unsafe { GetClientRect(parent, &mut client) }
        .map_err(|error| format!("measure CCEM main client HWND: {error}"))?;
    let scale_factor = window
        .scale_factor()
        .map_err(|error| format!("resolve CCEM window scale factor: {error}"))?;
    windows_child_bounds(
        viewport,
        scale_factor,
        client.right - client.left,
        client.bottom - client.top,
    )
}

fn run_on_main<T, F>(app: &AppHandle, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    if super::surface::windows::is_owner_thread() {
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
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("CEF main-thread operation channel disconnected".to_string())
        }
    }
}
