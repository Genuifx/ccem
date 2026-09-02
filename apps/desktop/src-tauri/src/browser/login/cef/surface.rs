use super::devtools_bridge::{CefDevToolsReader, CefDevToolsWriter};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Condvar, Mutex,
};
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
pub(crate) mod macos;
#[cfg(windows)]
pub(crate) mod windows;

mod dispatch;
mod focus_restore;
mod geometry;
mod host_shortcut;
mod recovery_state;
#[cfg(any(target_os = "macos", windows))]
mod renderer_recovery;
#[cfg(any(target_os = "macos", windows))]
use cef::*;
use dispatch::run_cancellable_on_main;
#[cfg(target_os = "macos")]
pub(crate) use geometry::macos_child_bounds;
pub(crate) use geometry::{
    profile_cache_path, LogicalViewport, NativeChildBounds, WindowsNativeWindowObservation,
};
#[cfg(any(windows, test))]
pub(crate) use geometry::{validate_windows_native_window_observation, windows_child_bounds};
#[cfg(any(target_os = "macos", windows))]
use host_shortcut::HostShortcutKeyboardHandler;
#[cfg(any(target_os = "macos", windows))]
use renderer_recovery::SurfaceRequestHandler;

#[cfg(any(target_os = "macos", windows))]
wrap_download_handler! {
    pub(super) struct SurfaceDownloadHandler;

    impl DownloadHandler {
        fn can_download(
            &self,
            _browser: Option<&mut Browser>,
            _url: Option<&CefString>,
            _request_method: Option<&CefString>,
        ) -> i32 {
            1
        }

        fn on_before_download(
            &self,
            _browser: Option<&mut Browser>,
            _download_item: Option<&mut DownloadItem>,
            _suggested_name: Option<&CefString>,
            callback: Option<&mut BeforeDownloadCallback>,
        ) -> i32 {
            let Some(callback) = callback else {
                return 0;
            };
            callback.cont(None, 1);
            1
        }
    }
}

fn should_retire_surface_without_browser(browser_ready: bool, popup_active: bool) -> bool {
    !browser_ready && !popup_active
}

pub(crate) fn diagnostic_url(value: &str) -> String {
    let Ok(mut url) = tauri::Url::parse(value) else {
        return "<redacted-url>".to_string();
    };
    if url.host_str().is_none() {
        return if url.scheme() == "about" && url.path() == "blank" {
            "about:blank".to_string()
        } else {
            format!("{}:<redacted>", url.scheme())
        };
    }
    if url.set_username("").is_err() || url.set_password(None).is_err() {
        return format!("{}:<redacted>", url.scheme());
    }
    url.set_query(None);
    url.set_fragment(None);
    url.to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CefSurfaceLifecycle {
    Creating,
    Loading,
    Ready,
    Closing,
    Closed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CefSurfaceRecoveryState {
    RendererProcessTerminated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CefSurfaceNavigationAction {
    Back,
    Forward,
    Reload,
    Stop,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CefPopupSnapshot {
    pub(crate) popup_id: i32,
    pub(crate) lifecycle: CefSurfaceLifecycle,
    pub(crate) current_url: String,
    pub(crate) title: Option<String>,
    pub(crate) error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CefPopupAgentLockError {
    PopupActive,
    SurfaceUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CefSurfaceSnapshot {
    /// Monotonic native-state version. It advances only when a field in this
    /// snapshot materially changes, so observers can sleep without polling CEF.
    pub(crate) revision: u64,
    pub(crate) surface_id: String,
    pub(crate) profile_id: String,
    pub(crate) lifecycle: CefSurfaceLifecycle,
    pub(crate) devtools_attached: bool,
    pub(crate) current_url: String,
    pub(crate) can_go_back: bool,
    pub(crate) can_go_forward: bool,
    pub(crate) title: Option<String>,
    pub(crate) visible: bool,
    pub(crate) error: Option<String>,
    pub(crate) recovery_state: Option<CefSurfaceRecoveryState>,
    pub(crate) popup: Option<CefPopupSnapshot>,
    pub(crate) user_popups_allowed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CefSurfaceStateChange {
    Changed(CefSurfaceSnapshot),
    Closed(CefSurfaceSnapshot),
    TimedOut,
}

pub(crate) struct CefSurfaceOpenSpec {
    pub(crate) surface_id: String,
    pub(crate) profile_id: String,
    pub(crate) initial_url: String,
    pub(crate) parent_view: usize,
    pub(crate) bounds: NativeChildBounds,
    pub(crate) visible: bool,
    pub(crate) persistent_profile_storage: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct CefSurfaceRequest {
    pub(crate) surface_id: String,
    pub(crate) profile_id: String,
    pub(crate) initial_url: String,
    pub(crate) viewport: LogicalViewport,
    pub(crate) visible: bool,
}

pub(crate) struct CefSurfaceConnection {
    pub(crate) reader: CefDevToolsReader,
    pub(crate) writer: CefDevToolsWriter,
    shared: Arc<SharedSurfaceState>,
}

#[derive(Clone)]
pub(crate) struct CefSurfaceStateHandle {
    shared: Arc<SharedSurfaceState>,
}

impl CefSurfaceConnection {
    pub(crate) fn snapshot(&self) -> CefSurfaceSnapshot {
        self.shared.snapshot()
    }

    pub(crate) fn wait_until_ready(&self, timeout: Duration) -> Result<CefSurfaceSnapshot, String> {
        self.shared.wait_until_ready(timeout)
    }

    pub(crate) fn wait_until_attached(
        &self,
        timeout: Duration,
    ) -> Result<CefSurfaceSnapshot, String> {
        self.shared.wait_until_attached(timeout)
    }

    pub(crate) fn wait_until_closed(
        &self,
        timeout: Duration,
    ) -> Result<CefSurfaceSnapshot, String> {
        self.shared.wait_until_closed(timeout)
    }

    pub(crate) fn state_handle(&self) -> CefSurfaceStateHandle {
        CefSurfaceStateHandle {
            shared: Arc::clone(&self.shared),
        }
    }

    pub(crate) fn into_devtools_transport(self) -> (CefDevToolsReader, CefDevToolsWriter) {
        (self.reader, self.writer)
    }
}

impl CefSurfaceStateHandle {
    pub(crate) fn snapshot(&self) -> CefSurfaceSnapshot {
        self.shared.snapshot()
    }

    pub(crate) fn wait_until_ready(&self, timeout: Duration) -> Result<CefSurfaceSnapshot, String> {
        self.shared.wait_until_ready(timeout)
    }

    pub(crate) fn wait_until_attached(
        &self,
        timeout: Duration,
    ) -> Result<CefSurfaceSnapshot, String> {
        self.shared.wait_until_attached(timeout)
    }

    pub(crate) fn wait_until_closed(
        &self,
        timeout: Duration,
    ) -> Result<CefSurfaceSnapshot, String> {
        self.shared.wait_until_closed(timeout)
    }

    pub(crate) fn wait_for_change(
        &self,
        after_revision: u64,
        timeout: Duration,
    ) -> Result<CefSurfaceStateChange, String> {
        self.shared.wait_for_change(after_revision, timeout)
    }

    pub(crate) fn popup_active(&self) -> bool {
        self.shared.snapshot().popup.is_some()
    }

    pub(crate) fn allow_agent_popups(&self) -> Result<(), CefPopupAgentLockError> {
        self.shared.allow_agent_popups()
    }

    pub(crate) fn deny_popups(&self) {
        self.shared.deny_popups();
    }

    pub(crate) fn allow_user_popups(&self) -> Result<(), CefPopupAgentLockError> {
        self.shared.allow_user_popups()
    }
}

pub(super) struct SharedSurfaceState {
    state: Mutex<CefSurfaceSnapshot>,
    focus_restore: Mutex<focus_restore::FocusRestoreIntent>,
    initial_url: String,
    initial_document_started: AtomicBool,
    changed: Condvar,
}

impl SharedSurfaceState {
    pub(super) fn new(spec: &CefSurfaceOpenSpec) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(CefSurfaceSnapshot {
                revision: 0,
                surface_id: spec.surface_id.clone(),
                profile_id: spec.profile_id.clone(),
                lifecycle: CefSurfaceLifecycle::Creating,
                devtools_attached: false,
                // Do not report the requested URL as current until CEF confirms a
                // main-frame load. Consumers use this snapshot as runtime evidence.
                current_url: String::new(),
                can_go_back: false,
                can_go_forward: false,
                title: None,
                visible: spec.visible,
                error: None,
                recovery_state: None,
                popup: None,
                // Admission opens only after the owning Session is registered in User control.
                // Creating/loading surfaces, Agent control, Paused, and Closing all fail closed.
                user_popups_allowed: false,
            }),
            focus_restore: Mutex::new(focus_restore::FocusRestoreIntent::default()),
            initial_url: spec.initial_url.clone(),
            initial_document_started: AtomicBool::new(spec.initial_url == "about:blank"),
            changed: Condvar::new(),
        })
    }

    pub(super) fn mark_main_document_started(&self, current_url: &str) {
        if current_url != "about:blank" || self.initial_url == "about:blank" {
            self.initial_document_started.store(true, Ordering::Release);
        }
    }

    pub(super) fn snapshot(&self) -> CefSurfaceSnapshot {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub(super) fn update(&self, update: impl FnOnce(&mut CefSurfaceSnapshot)) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let before = state.clone();
        update(&mut state);
        if matches!(
            state.lifecycle,
            CefSurfaceLifecycle::Closing
                | CefSurfaceLifecycle::Closed
                | CefSurfaceLifecycle::Failed
        ) {
            state.can_go_back = false;
            state.can_go_forward = false;
        }
        // Revisions are owned by SharedSurfaceState, never by individual CEF
        // callbacks. Reset an accidental callback mutation before comparison.
        state.revision = before.revision;
        if *state == before {
            return false;
        }
        state.revision = before
            .revision
            .checked_add(1)
            .expect("CEF surface state revision exhausted");
        self.changed.notify_all();
        true
    }

    pub(super) fn record_error(&self, error: impl Into<String>) {
        let error = error.into();
        self.update(|state| {
            state.error = Some(error);
        });
    }

    pub(super) fn update_loading_state(
        &self,
        is_loading: bool,
        can_go_back: bool,
        can_go_forward: bool,
        current_url: Option<String>,
    ) {
        if !is_loading
            && self.initial_url != "about:blank"
            && !self.initial_document_started.load(Ordering::Acquire)
        {
            return;
        }
        self.update(|state| {
            if matches!(
                state.lifecycle,
                CefSurfaceLifecycle::Closing
                    | CefSurfaceLifecycle::Closed
                    | CefSurfaceLifecycle::Failed
            ) {
                return;
            }
            state.can_go_back = can_go_back;
            state.can_go_forward = can_go_forward;
            if let Some(current_url) = current_url.filter(|url| !url.is_empty()) {
                state.current_url = current_url;
            }
            state.lifecycle = if is_loading {
                CefSurfaceLifecycle::Loading
            } else {
                CefSurfaceLifecycle::Ready
            };
        });
    }

    pub(super) fn record_recoverable_load_error(
        &self,
        current_url: String,
        error: impl Into<String>,
    ) {
        let error = error.into();
        self.update(|state| {
            if matches!(
                state.lifecycle,
                CefSurfaceLifecycle::Closing
                    | CefSurfaceLifecycle::Closed
                    | CefSurfaceLifecycle::Failed
            ) {
                return;
            }
            if !current_url.is_empty() {
                state.current_url = current_url;
            }
            // The native browser remains usable after a navigation failure. Keep
            // the surface non-terminal so the address bar can retry immediately.
            state.lifecycle = CefSurfaceLifecycle::Ready;
            state.error = Some(error);
        });
    }

    pub(super) fn fail_creation(&self, error: impl Into<String>) {
        let error = error.into();
        self.clear_focus_restore_intent();
        self.update(|state| {
            if !matches!(
                state.lifecycle,
                CefSurfaceLifecycle::Closing | CefSurfaceLifecycle::Closed
            ) {
                state.lifecycle = CefSurfaceLifecycle::Failed;
            }
            state.error = Some(error);
        });
    }

    pub(super) fn reserve_user_popup(
        &self,
        popup_id: i32,
        target_url: String,
    ) -> Result<(), &'static str> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !state.user_popups_allowed {
            return Err("popup admission is not owned by the user");
        }
        if state.popup.is_some() {
            return Err("a popup is already active");
        }
        if matches!(
            state.lifecycle,
            CefSurfaceLifecycle::Closing
                | CefSurfaceLifecycle::Closed
                | CefSurfaceLifecycle::Failed
        ) {
            return Err("the browser surface is not accepting popups");
        }
        state.popup = Some(CefPopupSnapshot {
            popup_id,
            lifecycle: CefSurfaceLifecycle::Creating,
            current_url: target_url,
            title: None,
            error: None,
        });
        state.revision = state
            .revision
            .checked_add(1)
            .expect("CEF surface state revision exhausted");
        self.changed.notify_all();
        drop(state);
        self.clear_focus_restore_intent();
        Ok(())
    }

    pub(super) fn update_popup(
        &self,
        popup_id: i32,
        update: impl FnOnce(&mut CefPopupSnapshot),
    ) -> bool {
        self.update(|state| {
            if let Some(popup) = state
                .popup
                .as_mut()
                .filter(|popup| popup.popup_id == popup_id)
            {
                update(popup);
            }
        })
    }

    pub(super) fn update_popup_from_load(
        &self,
        popup_id: i32,
        update: impl FnOnce(&mut CefPopupSnapshot),
    ) -> bool {
        self.update_popup(popup_id, |popup| {
            if matches!(
                popup.lifecycle,
                CefSurfaceLifecycle::Closing
                    | CefSurfaceLifecycle::Closed
                    | CefSurfaceLifecycle::Failed
            ) {
                return;
            }
            update(popup);
        })
    }

    pub(super) fn mark_popup_policy_closed(&self, popup_id: i32) -> bool {
        self.update_popup(popup_id, |popup| {
            popup.lifecycle = CefSurfaceLifecycle::Closing;
            popup.error = Some(
                "Login popup returned to an unsupported callback scheme and was closed."
                    .to_string(),
            );
        })
    }

    pub(super) fn finish_popup(&self, popup_id: i32) -> bool {
        let finished = self.update(|state| {
            if state
                .popup
                .as_ref()
                .is_some_and(|popup| popup.popup_id == popup_id)
            {
                state.popup = None;
            }
        });
        if finished {
            self.clear_focus_restore_intent();
        }
        finished
    }

    fn allow_agent_popups(&self) -> Result<(), CefPopupAgentLockError> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.popup.is_some() {
            return Err(CefPopupAgentLockError::PopupActive);
        }
        if matches!(
            state.lifecycle,
            CefSurfaceLifecycle::Closing
                | CefSurfaceLifecycle::Closed
                | CefSurfaceLifecycle::Failed
        ) {
            return Err(CefPopupAgentLockError::SurfaceUnavailable);
        }
        if !state.user_popups_allowed {
            state.user_popups_allowed = true;
            state.revision = state
                .revision
                .checked_add(1)
                .expect("CEF surface state revision exhausted");
            self.changed.notify_all();
        }
        Ok(())
    }

    fn deny_popups(&self) {
        self.update(|state| state.user_popups_allowed = false);
    }

    fn allow_user_popups(&self) -> Result<(), CefPopupAgentLockError> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if matches!(
            state.lifecycle,
            CefSurfaceLifecycle::Closing
                | CefSurfaceLifecycle::Closed
                | CefSurfaceLifecycle::Failed
        ) {
            return Err(CefPopupAgentLockError::SurfaceUnavailable);
        }
        if !state.user_popups_allowed {
            state.user_popups_allowed = true;
            state.revision = state
                .revision
                .checked_add(1)
                .expect("CEF surface state revision exhausted");
            self.changed.notify_all();
        }
        Ok(())
    }

    fn wait_until_ready(&self, timeout: Duration) -> Result<CefSurfaceSnapshot, String> {
        let deadline = Instant::now() + timeout;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "CEF surface state is unavailable".to_string())?;
        loop {
            match state.lifecycle {
                CefSurfaceLifecycle::Ready if state.error.is_none() => return Ok(state.clone()),
                CefSurfaceLifecycle::Ready => {
                    return Err(state
                        .error
                        .clone()
                        .unwrap_or_else(|| "CEF surface load failed".to_string()))
                }
                CefSurfaceLifecycle::Failed => {
                    return Err(state
                        .error
                        .clone()
                        .unwrap_or_else(|| "CEF surface creation failed".to_string()))
                }
                CefSurfaceLifecycle::Closing | CefSurfaceLifecycle::Closed => {
                    return Err(state
                        .error
                        .clone()
                        .unwrap_or_else(|| "CEF surface closed before becoming ready".to_string()))
                }
                CefSurfaceLifecycle::Creating | CefSurfaceLifecycle::Loading => {
                    if let Some(error) = state.error.clone() {
                        return Err(error);
                    }
                }
            }
            let now = Instant::now();
            if now >= deadline {
                return Err("CEF surface creation timed out".to_string());
            }
            let (next, wait) = self
                .changed
                .wait_timeout(state, deadline.saturating_duration_since(now))
                .map_err(|_| "CEF surface state is unavailable".to_string())?;
            state = next;
            if wait.timed_out()
                && matches!(
                    state.lifecycle,
                    CefSurfaceLifecycle::Creating | CefSurfaceLifecycle::Loading
                )
            {
                return Err("CEF surface creation timed out".to_string());
            }
        }
    }

    fn wait_until_attached(&self, timeout: Duration) -> Result<CefSurfaceSnapshot, String> {
        let deadline = Instant::now() + timeout;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "CEF surface state is unavailable".to_string())?;
        loop {
            if state.devtools_attached
                && !matches!(
                    state.lifecycle,
                    CefSurfaceLifecycle::Closing | CefSurfaceLifecycle::Closed
                )
            {
                return Ok(state.clone());
            }
            if matches!(
                state.lifecycle,
                CefSurfaceLifecycle::Failed
                    | CefSurfaceLifecycle::Closing
                    | CefSurfaceLifecycle::Closed
            ) || state.error.is_some()
            {
                return Err(state
                    .error
                    .clone()
                    .unwrap_or_else(|| "CEF surface closed before DevTools attached".to_string()));
            }
            let now = Instant::now();
            if now >= deadline {
                return Err("CEF DevTools attachment timed out".to_string());
            }
            let (next, wait) = self
                .changed
                .wait_timeout(state, deadline.saturating_duration_since(now))
                .map_err(|_| "CEF surface state is unavailable".to_string())?;
            state = next;
            if wait.timed_out() && !state.devtools_attached {
                return Err("CEF DevTools attachment timed out".to_string());
            }
        }
    }

    fn wait_until_closed(&self, timeout: Duration) -> Result<CefSurfaceSnapshot, String> {
        let deadline = Instant::now() + timeout;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "CEF surface state is unavailable".to_string())?;
        loop {
            if state.lifecycle == CefSurfaceLifecycle::Closed {
                return Ok(state.clone());
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(format!(
                    "CEF surface close timed out in state {:?}",
                    state.lifecycle
                ));
            }
            let (next, wait) = self
                .changed
                .wait_timeout(state, deadline.saturating_duration_since(now))
                .map_err(|_| "CEF surface state is unavailable".to_string())?;
            state = next;
            if wait.timed_out() && state.lifecycle != CefSurfaceLifecycle::Closed {
                return Err(format!(
                    "CEF surface close timed out in state {:?}",
                    state.lifecycle
                ));
            }
        }
    }

    fn wait_for_change(
        &self,
        after_revision: u64,
        timeout: Duration,
    ) -> Result<CefSurfaceStateChange, String> {
        let deadline = Instant::now() + timeout;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "CEF surface state is unavailable".to_string())?;
        loop {
            if state.lifecycle == CefSurfaceLifecycle::Closed {
                return Ok(CefSurfaceStateChange::Closed(state.clone()));
            }
            if state.revision > after_revision {
                return Ok(CefSurfaceStateChange::Changed(state.clone()));
            }
            let now = Instant::now();
            if now >= deadline {
                return Ok(CefSurfaceStateChange::TimedOut);
            }
            let (next, wait) = self
                .changed
                .wait_timeout(state, deadline.saturating_duration_since(now))
                .map_err(|_| "CEF surface state is unavailable".to_string())?;
            state = next;
            if wait.timed_out()
                && state.revision <= after_revision
                && state.lifecycle != CefSurfaceLifecycle::Closed
            {
                return Ok(CefSurfaceStateChange::TimedOut);
            }
        }
    }
}

pub(super) fn validate_surface_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err("CEF surface id is invalid".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod state_tests {
    use super::*;

    fn state() -> Arc<SharedSurfaceState> {
        state_with_initial_url("about:blank")
    }

    fn state_with_initial_url(initial_url: &str) -> Arc<SharedSurfaceState> {
        SharedSurfaceState::new(&CefSurfaceOpenSpec {
            surface_id: "surface-state-test".to_string(),
            profile_id: "profile-state-test".to_string(),
            initial_url: initial_url.to_string(),
            parent_view: 1,
            bounds: NativeChildBounds {
                x: 0,
                y: 0,
                width: 100,
                height: 100,
            },
            visible: false,
            persistent_profile_storage: false,
        })
    }

    #[test]
    fn bootstrap_about_blank_cannot_publish_ready_before_the_requested_document_starts() {
        let state = state_with_initial_url("https://example.test/target");

        state.begin_main_frame_load("about:blank".to_string());
        state.update_loading_state(false, false, false, Some("about:blank".to_string()));
        let bootstrap = state.snapshot();
        assert_eq!(bootstrap.lifecycle, CefSurfaceLifecycle::Loading);
        assert_eq!(bootstrap.current_url, "about:blank");

        state.begin_main_frame_load("https://example.test/target".to_string());
        state.update_loading_state(
            false,
            false,
            false,
            Some("https://example.test/target".to_string()),
        );
        let requested = state.snapshot();
        assert_eq!(requested.lifecycle, CefSurfaceLifecycle::Ready);
        assert_eq!(requested.current_url, "https://example.test/target");
    }

    #[test]
    fn closing_a_pending_surface_does_not_wait_for_a_browser_callback() {
        assert!(should_retire_surface_without_browser(false, false));
        assert!(!should_retire_surface_without_browser(true, false));
        assert!(!should_retire_surface_without_browser(false, true));
    }

    #[test]
    fn diagnostic_urls_remove_credentials_query_and_fragment() {
        let https = diagnostic_url(
            "https://user:pass@example.test/cb?code=SECRET_CODE&state=SECRET_STATE#SECRET_FRAGMENT",
        );
        assert!(https.starts_with("https://example.test/cb"), "{https}");
        for secret in [
            "user",
            "pass",
            "SECRET_CODE",
            "SECRET_STATE",
            "SECRET_FRAGMENT",
        ] {
            assert!(
                !https.contains(secret),
                "diagnostic URL leaked {secret}: {https}"
            );
        }

        let callback =
            diagnostic_url("ccem://callback?code=SECRET_CODE&state=SECRET_STATE#SECRET_FRAGMENT");
        assert!(callback.starts_with("ccem://callback"), "{callback}");
        assert!(!callback.contains("SECRET_"), "{callback}");
        assert_eq!(diagnostic_url("not a URL SECRET_CODE"), "<redacted-url>");
    }

    #[test]
    fn recoverable_load_failure_stops_loading_without_losing_retry_state() {
        let state = state();
        state.update(|snapshot| snapshot.lifecycle = CefSurfaceLifecycle::Loading);
        let failed_url = "https://example.test/cb?code=SECRET_CODE".to_string();
        state.record_recoverable_load_error(
            failed_url.clone(),
            format!("load failed at {}", diagnostic_url(&failed_url)),
        );

        let snapshot = state.snapshot();
        assert_eq!(snapshot.lifecycle, CefSurfaceLifecycle::Ready);
        assert_eq!(snapshot.current_url, failed_url);
        let error = snapshot.error.expect("recoverable error remains visible");
        assert!(!error.contains("SECRET_CODE"), "{error}");

        state.update(|snapshot| {
            snapshot.lifecycle = CefSurfaceLifecycle::Loading;
            snapshot.error = None;
        });
        assert_eq!(state.snapshot().lifecycle, CefSurfaceLifecycle::Loading);
        assert!(state.snapshot().error.is_none());
    }

    #[test]
    fn loading_state_closes_same_document_navigation_and_fails_closed_when_terminal() {
        let state = state();
        let initial = state.snapshot();
        assert!(!initial.can_go_back);
        assert!(!initial.can_go_forward);

        state
            .begin_navigation()
            .expect("begin same-document navigation");
        state.update_loading_state(
            false,
            true,
            false,
            Some("https://example.test/page#next".to_string()),
        );
        let navigated = state.snapshot();
        assert_eq!(navigated.lifecycle, CefSurfaceLifecycle::Ready);
        assert_eq!(navigated.current_url, "https://example.test/page#next");
        assert!(navigated.can_go_back);
        assert!(!navigated.can_go_forward);

        state.update(|snapshot| snapshot.lifecycle = CefSurfaceLifecycle::Closing);
        let closing = state.snapshot();
        assert!(!closing.can_go_back);
        assert!(!closing.can_go_forward);

        state.update_loading_state(
            false,
            true,
            true,
            Some("https://example.test/late".to_string()),
        );
        let late_callback = state.snapshot();
        assert_eq!(late_callback.lifecycle, CefSurfaceLifecycle::Closing);
        assert_eq!(late_callback.current_url, "https://example.test/page#next");
        assert!(!late_callback.can_go_back);
        assert!(!late_callback.can_go_forward);
    }

    #[test]
    fn renderer_termination_is_sticky_until_explicit_surface_reopen() {
        let state = state();
        state.update(|snapshot| {
            snapshot.lifecycle = CefSurfaceLifecycle::Ready;
            snapshot.devtools_attached = true;
            snapshot.user_popups_allowed = true;
        });

        state.record_renderer_termination();
        let failed = state.snapshot();
        assert_eq!(failed.lifecycle, CefSurfaceLifecycle::Failed);
        assert!(!failed.devtools_attached);
        assert!(!failed.user_popups_allowed);
        assert_eq!(
            failed.recovery_state,
            Some(CefSurfaceRecoveryState::RendererProcessTerminated)
        );
        assert!(failed
            .error
            .as_deref()
            .is_some_and(|error| error.contains("Close and reopen")));

        state.begin_main_frame_load("https://late.example/start".to_string());
        state.finish_main_frame_load("https://late.example/end".to_string());
        state.record_recoverable_load_error(
            "https://late.example/error".to_string(),
            "late load error",
        );
        assert!(state.begin_navigation().is_err());
        assert_eq!(state.snapshot(), failed);
    }

    #[test]
    fn popup_renderer_termination_stays_failed_until_user_closes_popup() {
        let state = state();
        state.update(|snapshot| {
            snapshot.lifecycle = CefSurfaceLifecycle::Ready;
            snapshot.user_popups_allowed = true;
        });
        state
            .reserve_user_popup(42, "https://id.example/login".to_string())
            .expect("user-owned popup");

        state.record_popup_renderer_termination(42);
        let failed = state
            .snapshot()
            .popup
            .expect("failed popup remains visible");
        assert_eq!(failed.lifecycle, CefSurfaceLifecycle::Failed);
        assert!(failed
            .error
            .as_deref()
            .is_some_and(|error| error.contains("Close this popup")));

        state.update_popup_from_load(42, |popup| {
            popup.lifecycle = CefSurfaceLifecycle::Ready;
            popup.error = None;
        });
        assert_eq!(
            state.snapshot().popup.expect("popup remains").lifecycle,
            CefSurfaceLifecycle::Failed
        );
    }

    #[test]
    fn revision_advances_only_for_material_snapshot_changes() {
        let state = state();
        assert_eq!(state.snapshot().revision, 0);

        assert!(!state.update(|snapshot| snapshot.visible = false));
        assert_eq!(state.snapshot().revision, 0);
        let handle = CefSurfaceStateHandle {
            shared: Arc::clone(&state),
        };
        assert_eq!(
            handle
                .wait_for_change(0, Duration::from_millis(5))
                .expect("a no-op remains a timeout"),
            CefSurfaceStateChange::TimedOut,
        );

        assert!(state.update(|snapshot| snapshot.visible = true));
        assert_eq!(state.snapshot().revision, 1);
        assert!(!state.update(|snapshot| snapshot.visible = true));
        assert_eq!(state.snapshot().revision, 1);

        assert!(state.update(|snapshot| snapshot.title = Some("CCEM".to_string())));
        assert_eq!(state.snapshot().revision, 2);
    }

    #[test]
    fn state_handle_reports_change_timeout_and_terminal_close() {
        let state = state();
        let handle = CefSurfaceStateHandle {
            shared: Arc::clone(&state),
        };

        assert_eq!(
            handle
                .wait_for_change(0, Duration::from_millis(5))
                .expect("timeout is not an error"),
            CefSurfaceStateChange::TimedOut,
        );

        state.update(|snapshot| snapshot.lifecycle = CefSurfaceLifecycle::Loading);
        let changed = handle
            .wait_for_change(0, Duration::from_millis(5))
            .expect("changed snapshot");
        assert!(matches!(
            changed,
            CefSurfaceStateChange::Changed(CefSurfaceSnapshot {
                revision: 1,
                lifecycle: CefSurfaceLifecycle::Loading,
                ..
            })
        ));

        state.update(|snapshot| snapshot.lifecycle = CefSurfaceLifecycle::Closed);
        let closed = handle
            .wait_for_change(1, Duration::from_millis(5))
            .expect("closed snapshot");
        assert!(matches!(
            closed,
            CefSurfaceStateChange::Closed(CefSurfaceSnapshot {
                revision: 2,
                lifecycle: CefSurfaceLifecycle::Closed,
                ..
            })
        ));
        assert!(matches!(
            handle
                .wait_for_change(2, Duration::from_millis(5))
                .expect("closed handles terminate immediately"),
            CefSurfaceStateChange::Closed(_)
        ));
    }

    #[test]
    fn popup_admission_follows_active_user_agent_and_paused_control() {
        let state = state();
        let handle = CefSurfaceStateHandle {
            shared: Arc::clone(&state),
        };

        assert!(state
            .reserve_user_popup(16, "https://id.example/early".to_string())
            .is_err());
        handle
            .allow_user_popups()
            .expect("registered User control opens popup admission");
        state
            .reserve_user_popup(17, "https://id.example/login".to_string())
            .expect("manual user popup");
        assert!(handle.popup_active());
        assert_eq!(
            handle.allow_agent_popups(),
            Err(CefPopupAgentLockError::PopupActive)
        );

        assert!(state.finish_popup(17));
        handle
            .allow_agent_popups()
            .expect("handoff keeps gesture-gated popup admission available to Agent clicks");
        state
            .reserve_user_popup(18, "https://id.example/again".to_string())
            .expect("Agent-owned browser may open one admitted popup");
        assert!(state.finish_popup(18));

        handle.deny_popups();
        assert!(state
            .reserve_user_popup(19, "https://id.example/paused".to_string())
            .is_err());
        handle
            .allow_user_popups()
            .expect("trusted user takeover restores popup admission");
        state
            .reserve_user_popup(20, "about:blank".to_string())
            .expect("manual popup after takeover");
    }

    #[test]
    fn policy_closed_popup_does_not_pollute_parent_or_accept_late_load_events() {
        let state = state();
        let handle = CefSurfaceStateHandle {
            shared: Arc::clone(&state),
        };
        state.update(|snapshot| snapshot.lifecycle = CefSurfaceLifecycle::Ready);
        handle
            .allow_user_popups()
            .expect("registered User control opens popup admission");
        state
            .reserve_user_popup(20, "about:blank".to_string())
            .expect("manual popup");

        assert!(state.mark_popup_policy_closed(20));
        let blocked = state.snapshot();
        assert!(
            blocked.error.is_none(),
            "popup policy must not poison opener"
        );
        let popup = blocked.popup.expect("popup remains until CEF closes it");
        assert_eq!(popup.lifecycle, CefSurfaceLifecycle::Closing);
        assert!(!popup.error.unwrap_or_default().contains("SECRET"));

        assert!(!state.update_popup_from_load(20, |popup| {
            popup.lifecycle = CefSurfaceLifecycle::Ready;
            popup.error = None;
        }));
        assert_eq!(
            state.snapshot().popup.expect("closing popup").lifecycle,
            CefSurfaceLifecycle::Closing,
        );
    }
}
