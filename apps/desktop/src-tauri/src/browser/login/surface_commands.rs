use super::session::{
    LoginBrowserSessionHandle, LoginBrowserSessionManager, LoginBrowserSessionSnapshot,
    SessionControlOwner, SessionManagerError, TrustedUiControlAction,
    TrustedUiControlAuthorization, TrustedWorkspacePath,
};
use crate::browser::surface_coordinator::{
    BrowserSurfaceApplyOutcome, BrowserSurfaceBackend, BrowserSurfaceCoordinator,
};
use crate::browser::BrowserManager;
use std::path::PathBuf;
#[cfg(any(target_os = "macos", windows))]
use std::sync::Barrier;
use std::sync::{Arc, Mutex, MutexGuard};
#[cfg(any(target_os = "macos", windows))]
use std::{thread, time::Duration};
use tauri::{AppHandle, WebviewWindow};

#[cfg(any(target_os = "macos", windows))]
use super::cef::{
    host::CefHostController,
    recovery::EmbeddedOwnerRecordStore,
    session_runtime::prepare_launched_runtime_with_owner_record,
    surface::{
        CefSurfaceRequest, CefSurfaceSnapshot, CefSurfaceStateChange, CefSurfaceStateHandle,
    },
};

const DEFAULT_LOGIN_URL: &str = "about:blank";
#[cfg(any(target_os = "macos", windows))]
const SURFACE_WATCH_INTERVAL: Duration = Duration::from_millis(400);
#[cfg(any(target_os = "macos", windows))]
const SURFACE_CONTROL_AUTHORIZATION_TTL: Duration = Duration::from_secs(30);

#[cfg(any(not(debug_assertions), test))]
mod production_smoke;
mod protocol;
#[cfg(any(target_os = "macos", windows))]
mod recovery_projection;
mod request;
#[cfg(any(not(debug_assertions), test))]
pub(in crate::browser::login) use production_smoke::ProductionSmokeScreenshotProof;
#[cfg(not(debug_assertions))]
pub(in crate::browser::login) use production_smoke::{
    ProductionSmokeLease, ProductionSmokeSemanticRun,
};
use protocol::{
    snapshot_mutation_response, snapshot_response, BrowserSurfaceLeaseResponse,
    BrowserSurfaceSnapshotMutationResponse, BrowserSurfaceSnapshotResponse,
};
#[cfg(any(target_os = "macos", windows))]
use recovery_projection::{
    pause_for_renderer_recovery, recovery_aware_error, EmbeddedRecoveryRegistry,
};
pub(in crate::browser::login) use request::BrowserSurfaceControlActionArg;
use request::{
    parse_profile_selection, validate_panel_session_id, BrowserSurfaceBackendArg,
    BrowserSurfaceProfileModeArg, BrowserSurfaceReleaseArg, BrowserSurfaceViewportArg,
};

#[derive(Default)]
pub(crate) struct LoginBrowserSurfaceManager {
    operation_gate: Mutex<()>,
    event_sequence: Mutex<u64>,
    state: Mutex<LoginBrowserSurfaceState>,
    #[cfg(any(target_os = "macos", windows))]
    owner_records: Option<EmbeddedOwnerRecordStore>,
}

#[derive(Default)]
struct LoginBrowserSurfaceState {
    coordinator: BrowserSurfaceCoordinator,
    active: Option<ActiveLoginSurface>,
    shutting_down: bool,
    unavailable_reason: Option<String>,
    #[cfg(any(target_os = "macos", windows))]
    recovery: EmbeddedRecoveryRegistry,
}

#[derive(Clone)]
struct ActiveLoginSurface {
    lease_id: String,
    generation: u64,
    panel_session_id: String,
    surface_id: String,
    profile_id: String,
    session: LoginBrowserSessionHandle,
}

pub(crate) mod ipc;

#[cfg(any(target_os = "macos", windows))]
impl LoginBrowserSurfaceManager {
    pub(crate) fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            operation_gate: Mutex::new(()),
            event_sequence: Mutex::new(0),
            state: Mutex::new(LoginBrowserSurfaceState {
                unavailable_reason: Some(reason.into()),
                ..LoginBrowserSurfaceState::default()
            }),
            #[cfg(any(target_os = "macos", windows))]
            owner_records: None,
        }
    }

    pub(crate) fn production(
        owner_record_root: PathBuf,
        sessions: &LoginBrowserSessionManager,
    ) -> Result<Self, String> {
        let owner_records = EmbeddedOwnerRecordStore::production(owner_record_root)
            .map_err(|error| error.to_string())?;
        let recovery_records = sessions
            .reap_embedded_owner_records(&owner_records)
            .map_err(|error| error.to_string())?;
        Ok(Self {
            operation_gate: Mutex::new(()),
            event_sequence: Mutex::new(0),
            state: Mutex::new(LoginBrowserSurfaceState {
                recovery: EmbeddedRecoveryRegistry::from_records(recovery_records),
                ..LoginBrowserSurfaceState::default()
            }),
            owner_records: Some(owner_records),
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn acquire_login(
        self: &Arc<Self>,
        app: &AppHandle,
        sessions: &Arc<LoginBrowserSessionManager>,
        cef_host: &Arc<CefHostController>,
        preview: &Arc<BrowserManager>,
        panel_session_id: String,
        backend: BrowserSurfaceBackendArg,
        working_dir: Option<String>,
        profile_mode: Option<BrowserSurfaceProfileModeArg>,
        profile_id: Option<String>,
        initial_url: Option<String>,
        viewport: BrowserSurfaceViewportArg,
        client_revision: u64,
    ) -> Result<BrowserSurfaceLeaseResponse, String> {
        let _operation = self.operation()?;
        {
            let state = self.state()?;
            if let Some(reason) = state.unavailable_reason.as_ref() {
                return Err(reason.clone());
            }
            if state.shutting_down {
                return Err("Login Browser is shutting down.".to_string());
            }
        }
        validate_panel_session_id(&panel_session_id)?;
        if client_revision == 0 {
            return Err("Browser surface revision must be positive.".to_string());
        }
        if !matches!(backend, BrowserSurfaceBackendArg::Login) {
            return Err("Preview Browser keeps its existing browser_* command path.".to_string());
        }
        let working_dir = working_dir
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "Login Browser working directory is required.".to_string())?;
        let workspace = TrustedWorkspacePath::from_trusted_app(PathBuf::from(working_dir))
            .map_err(|error| error.to_string())?;
        let selection = parse_profile_selection(profile_mode, profile_id)?;
        let viewport = viewport.validate()?;
        let initial_url = crate::browser::url::parse_browser_url(
            initial_url.as_deref().unwrap_or(DEFAULT_LOGIN_URL),
        )?
        .to_string();

        // Retire the previous exact owner before minting a replacement lease.
        // If terminal cleanup fails, both its active record and coordinator
        // authority stay intact so the old panel can retry or force cleanup.
        let superseded = self.state()?.active.clone();
        if let Some(active) = superseded {
            sessions
                .close(&active.session)
                .map_err(|error| error.to_string())?;
            {
                let mut state = self.state()?;
                state.active = None;
                state
                    .coordinator
                    .begin_close(&active.lease_id, active.generation)
                    .map_err(|error| error.to_string())?;
                state
                    .coordinator
                    .mark_closed(&active.lease_id, active.generation)
                    .map_err(|error| error.to_string())?;
            }
        }
        let acquire = {
            let mut state = self.state()?;
            state
                .coordinator
                .acquire(BrowserSurfaceBackend::Login, client_revision)
                .map_err(|error| error.to_string())?
        };
        let lease = acquire.current.lease.clone();

        preview
            .hide_all(app)
            .map_err(|error| self.fail_current(&lease, error))?;

        let surface_id = format!("login-{}-{}", lease.generation, lease.lease_id);
        let owner_records = self
            .owner_records
            .as_ref()
            .ok_or_else(|| "Embedded browser recovery state is unavailable.".to_string())?;
        let prepared = match sessions.prepare_embedded_profile(
            workspace,
            selection,
            &surface_id,
            owner_records,
        ) {
            Ok(prepared) => prepared,
            Err(error) => {
                let recovery_states = if let Some(identity) = error.identity() {
                    self.state()?.recovery.states_for(identity)
                } else {
                    Vec::new()
                };
                let failure = recovery_aware_error(&error.to_string(), &recovery_states);
                return Err(self.fail_current(&lease, failure));
            }
        };
        let recovery_identity = prepared.recovery_identity();
        let recovery_states = self.state()?.recovery.states_for(&recovery_identity);
        let selected_profile_id = prepared.profile_id().as_str().to_string();
        let (registration, profile_lease, mut owner_record) = prepared.into_launch_parts();
        let connection = match cef_host.open_surface(
            app,
            CefSurfaceRequest {
                surface_id: surface_id.clone(),
                profile_id: selected_profile_id.clone(),
                initial_url,
                viewport,
                visible: false,
            },
        ) {
            Ok(connection) => connection,
            Err(error) => {
                let cleanup = profile_lease
                    .cancel_pending_embedded_launch()
                    .map_err(|cleanup_error| cleanup_error.to_string())
                    .and_then(|(_, proof)| {
                        owner_record
                            .finish_after_profile_release(proof)
                            .map_err(|cleanup_error| cleanup_error.to_string())
                    });
                let failure = cleanup.err().map_or(error.clone(), |cleanup_error| {
                    format!("{error}; cancel recorded profile launch: {cleanup_error}")
                });
                return Err(self.fail_current(&lease, failure));
            }
        };
        let native_state = connection.state_handle();
        let launched = prepare_launched_runtime_with_owner_record(
            app.clone(),
            Arc::clone(cef_host),
            surface_id.clone(),
            connection,
            profile_lease,
            owner_record,
        )
        .map_err(|error| self.fail_current(&lease, error.to_string()))?;
        let opened = sessions
            .register_prepared(registration, launched)
            .map_err(|error| self.fail_current(&lease, error.to_string()))?;
        if native_state.allow_user_popups().is_err() {
            let _ = sessions.force_stop(&opened.handle);
            return Err(self.fail_current(
                &lease,
                "Login Browser popup admission could not enter registered User control."
                    .to_string(),
            ));
        }

        {
            let mut state = self.state()?;
            state.active = Some(ActiveLoginSurface {
                lease_id: lease.lease_id.clone(),
                generation: lease.generation,
                panel_session_id,
                surface_id: surface_id.clone(),
                profile_id: selected_profile_id.clone(),
                session: opened.handle.clone(),
            });
        }

        // Acquisition is phase one: keep the native child hidden and unfocused while the
        // frontend may be navigating away or opening an overlay. Only a current lease's later
        // sync may make it visible; native clicks then own focus naturally.
        let current = match self
            .state()?
            .coordinator
            .mark_ready(&lease.lease_id, lease.generation)
        {
            Ok(BrowserSurfaceApplyOutcome::Applied(current)) => current,
            Ok(BrowserSurfaceApplyOutcome::Noop) => {
                let _ = sessions.force_stop(&opened.handle);
                return Err("Login Browser surface was superseded before display.".to_string());
            }
            Err(error) => {
                let _ = sessions.force_stop(&opened.handle);
                return Err(error.to_string());
            }
        };
        let native = native_state.snapshot();
        let initial_session = match pause_for_renderer_recovery(
            sessions,
            &opened.handle,
            &native,
            SURFACE_CONTROL_AUTHORIZATION_TTL,
        ) {
            Ok(Some(snapshot)) => snapshot,
            Ok(None) => opened.snapshot.clone(),
            Err(error) => {
                let cleanup = sessions.force_stop(&opened.handle);
                if cleanup.is_ok() {
                    self.state()?.active = None;
                }
                return Err(self.fail_current(
                    &lease,
                    format!("Login Browser renderer recovery fence failed: {error}"),
                ));
            }
        };
        let mut snapshot = snapshot_response(&native, &initial_session);
        snapshot.set_recovery_states(&recovery_states);
        let watcher_start = match self.start_state_watcher(
            app.clone(),
            Arc::clone(sessions),
            native_state,
            lease.lease_id.clone(),
            lease.generation,
            opened.handle.clone(),
            native,
            initial_session,
        ) {
            Ok(watcher_start) => watcher_start,
            Err(error) => {
                let cleanup = sessions.force_stop(&opened.handle);
                if cleanup.is_ok() {
                    self.state()?.active = None;
                }
                return Err(self.fail_current(&lease, error));
            }
        };
        let server_sequence =
            self.emit_surface_state(app, &current, "ready", Some(snapshot.clone()));
        match self.state() {
            Ok(mut state) => state
                .recovery
                .acknowledge_successful_acquire(&recovery_identity),
            Err(error) => eprintln!(
                "Login Browser could not acknowledge its startup recovery projection: {error}"
            ),
        }
        // The thread is already owned before Ready is published, but cannot
        // overtake the initial event.
        watcher_start.wait();
        Ok(BrowserSurfaceLeaseResponse {
            lease_id: lease.lease_id,
            generation: lease.generation,
            client_revision: current.last_applied_revision,
            server_sequence,
            backend: "login",
            profile_id: Some(selected_profile_id),
            snapshot: Some(snapshot),
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn start_state_watcher(
        self: &Arc<Self>,
        app: AppHandle,
        sessions: Arc<LoginBrowserSessionManager>,
        native_state: CefSurfaceStateHandle,
        lease_id: String,
        generation: u64,
        session: LoginBrowserSessionHandle,
        initial_native: CefSurfaceSnapshot,
        initial_session: LoginBrowserSessionSnapshot,
    ) -> Result<Arc<Barrier>, String> {
        let manager = Arc::clone(self);
        let start = Arc::new(Barrier::new(2));
        let worker_start = Arc::clone(&start);
        thread::Builder::new()
            .name(format!("ccem-cef-state-{generation}"))
            .spawn(move || {
                worker_start.wait();
                manager.run_state_watcher(
                    app,
                    sessions,
                    native_state,
                    lease_id,
                    generation,
                    session,
                    initial_native,
                    initial_session,
                );
            })
            .map(|_| start)
            .map_err(|error| format!("start CEF surface state watcher: {error}"))
    }

    #[allow(clippy::too_many_arguments)]
    fn run_state_watcher(
        &self,
        app: AppHandle,
        sessions: Arc<LoginBrowserSessionManager>,
        native_state: CefSurfaceStateHandle,
        lease_id: String,
        generation: u64,
        session: LoginBrowserSessionHandle,
        mut native: CefSurfaceSnapshot,
        mut session_snapshot: LoginBrowserSessionSnapshot,
    ) {
        let mut last_emitted = snapshot_response(&native, &session_snapshot);
        loop {
            let change = match native_state.wait_for_change(native.revision, SURFACE_WATCH_INTERVAL)
            {
                Ok(change) => change,
                Err(error) => {
                    eprintln!(
                        "CEF surface state watcher stopped lease={} generation={}: {error}",
                        lease_id, generation,
                    );
                    return;
                }
            };
            let (native_changed, terminal) = match change {
                CefSurfaceStateChange::Changed(snapshot) => {
                    native = snapshot;
                    (true, false)
                }
                CefSurfaceStateChange::Closed(snapshot) => {
                    native = snapshot;
                    (true, true)
                }
                CefSurfaceStateChange::TimedOut => (false, false),
            };

            // Fence before reading the semantic session projection. A superseded
            // watcher must not even touch the old backend, and this guard is
            // released before the in-memory session read below.
            if self
                .current_watcher_snapshot(&lease_id, generation)
                .is_none()
            {
                return;
            }

            if let Ok(current_session) = sessions.snapshot(&session) {
                session_snapshot = current_session;
            }
            if terminal {
                let _operation = match self.operation() {
                    Ok(operation) => operation,
                    Err(error) => {
                        eprintln!(
                            "CEF terminal watcher lost operation lane lease={} generation={}: {error}",
                            lease_id, generation,
                        );
                        return;
                    }
                };
                if self
                    .current_watcher_snapshot(&lease_id, generation)
                    .is_none()
                {
                    return;
                }
                native = native_state.snapshot();
                if let Ok(current_session) = sessions.snapshot(&session) {
                    session_snapshot = current_session;
                }
                let response = snapshot_response(&native, &session_snapshot);
                match self
                    .converge_terminal_watcher_locked(&sessions, &lease_id, generation, &session)
                {
                    Ok(Some(closed)) => {
                        self.emit_surface_state(&app, &closed, "native_closed", Some(response));
                    }
                    Ok(None) => {}
                    Err(error) => {
                        // Keep the exact lease/session authority live so a later explicit close
                        // can retry terminal cleanup instead of turning this into a fake success.
                        eprintln!(
                            "CEF surface terminal convergence failed lease={} generation={}: {error}",
                            lease_id, generation,
                        );
                        let Some(current) = self.current_watcher_snapshot(&lease_id, generation)
                        else {
                            return;
                        };
                        native = native_state.snapshot();
                        if let Ok(current_session) = sessions.snapshot(&session) {
                            session_snapshot = current_session;
                        }
                        self.emit_surface_state(
                            &app,
                            &current,
                            "native_close_cleanup_required",
                            Some(snapshot_response(&native, &session_snapshot)),
                        );
                    }
                }
                return;
            }
            let response = snapshot_response(&native, &session_snapshot);
            if response != last_emitted {
                // Publish through the same operation lane as UI commands, then
                // re-read both projections. Otherwise a watcher could compute an
                // old session snapshot, wait behind a control command, and emit
                // that old snapshot with a newer server sequence.
                let _operation = match self.operation() {
                    Ok(operation) => operation,
                    Err(error) => {
                        eprintln!(
                            "CEF surface state watcher lost operation lane lease={} generation={}: {error}",
                            lease_id, generation,
                        );
                        return;
                    }
                };
                let Some(current) = self.current_watcher_snapshot(&lease_id, generation) else {
                    return;
                };
                native = native_state.snapshot();
                match pause_for_renderer_recovery(
                    &sessions,
                    &session,
                    &native,
                    SURFACE_CONTROL_AUTHORIZATION_TTL,
                ) {
                    Ok(Some(current_session)) => session_snapshot = current_session,
                    Ok(None) => {
                        if let Ok(current_session) = sessions.snapshot(&session) {
                            session_snapshot = current_session;
                        }
                    }
                    Err(error) => {
                        eprintln!(
                            "CEF renderer recovery control fence failed lease={} generation={}: {error}",
                            lease_id, generation,
                        );
                        match sessions.snapshot(&session) {
                            Ok(current_session)
                                if current_session.control != SessionControlOwner::Agent =>
                            {
                                session_snapshot = current_session;
                            }
                            _ => continue,
                        }
                    }
                }
                let response = snapshot_response(&native, &session_snapshot);
                if response == last_emitted {
                    continue;
                }
                self.emit_surface_state(
                    &app,
                    &current,
                    if native_changed {
                        "native_state"
                    } else {
                        "session_state"
                    },
                    Some(response.clone()),
                );
                last_emitted = response;
            }
        }
    }

    fn converge_terminal_watcher_locked(
        &self,
        sessions: &LoginBrowserSessionManager,
        lease_id: &str,
        generation: u64,
        session: &LoginBrowserSessionHandle,
    ) -> Result<Option<crate::browser::surface_coordinator::BrowserSurfaceSnapshot>, String> {
        {
            let state = self.state()?;
            let Some(active) = state.active.as_ref() else {
                return Ok(None);
            };
            if active.lease_id != lease_id || active.generation != generation {
                return Ok(None);
            }
        }

        match sessions.force_stop(session) {
            Ok(()) | Err(SessionManagerError::SessionNotFound) => {}
            Err(error) => return Err(error.to_string()),
        }

        let mut state = self.state()?;
        let still_current = state
            .active
            .as_ref()
            .is_some_and(|active| active.lease_id == lease_id && active.generation == generation);
        if !still_current {
            return Ok(None);
        }
        state.active = None;
        state
            .coordinator
            .begin_close(lease_id, generation)
            .map_err(|error| error.to_string())?;
        match state
            .coordinator
            .mark_closed(lease_id, generation)
            .map_err(|error| error.to_string())?
        {
            BrowserSurfaceApplyOutcome::Applied(closed) => Ok(Some(closed)),
            BrowserSurfaceApplyOutcome::Noop => Ok(state.coordinator.snapshot()),
        }
    }

    fn current_watcher_snapshot(
        &self,
        lease_id: &str,
        generation: u64,
    ) -> Option<crate::browser::surface_coordinator::BrowserSurfaceSnapshot> {
        let state = self.state.lock().ok()?;
        if state.shutting_down {
            return None;
        }
        let active = state.active.as_ref()?;
        if active.lease_id != lease_id || active.generation != generation {
            return None;
        }
        current_watcher_lease(&state.coordinator, lease_id, generation)
    }

    #[allow(clippy::too_many_arguments)]
    fn sync(
        &self,
        app: &AppHandle,
        cef_host: &Arc<CefHostController>,
        preview: &Arc<BrowserManager>,
        lease_id: String,
        generation: u64,
        client_revision: u64,
        viewport: Option<BrowserSurfaceViewportArg>,
        visible: Option<bool>,
    ) -> Result<(), String> {
        let _operation = self.operation()?;
        let current = match self
            .state()?
            .coordinator
            .sync(&lease_id, generation, client_revision)
        {
            BrowserSurfaceApplyOutcome::Applied(current) => current,
            BrowserSurfaceApplyOutcome::Noop => return Ok(()),
        };
        let active = self.active_identity(&lease_id, generation)?;
        if visible == Some(true) {
            preview.hide_all(app)?;
        }
        if let Some(viewport) = viewport {
            cef_host.set_surface_viewport(app, active.surface_id.clone(), viewport.validate()?)?;
        }
        if let Some(visible) = visible {
            cef_host.set_surface_visible(app, active.surface_id.clone(), visible)?;
        }
        self.emit_surface_state(app, &current, "sync", None);
        Ok(())
    }

    fn release(
        &self,
        app: &AppHandle,
        sessions: &Arc<LoginBrowserSessionManager>,
        _cef_host: &Arc<CefHostController>,
        lease_id: String,
        generation: u64,
        client_revision: u64,
        disposition: BrowserSurfaceReleaseArg,
    ) -> Result<(), String> {
        let _operation = self.operation()?;
        match disposition {
            BrowserSurfaceReleaseArg::Close => {
                // Consume only the client revision before native cleanup. The
                // lease stays Ready/active until `sessions.close` has observed
                // OnBeforeClose and released the profile, so a failed close can
                // be retried instead of becoming an irreversible successful no-op.
                match self
                    .state()?
                    .coordinator
                    .sync(&lease_id, generation, client_revision)
                {
                    BrowserSurfaceApplyOutcome::Applied(_) => {}
                    BrowserSurfaceApplyOutcome::Noop => return Ok(()),
                }
                let active = self.active_identity(&lease_id, generation)?;
                // Session close revokes Agent authority before its embedded backend closes CEF.
                sessions
                    .close(&active.session)
                    .map_err(|error| error.to_string())?;
                self.state()?.active = None;
                self.state()?
                    .coordinator
                    .begin_close(&lease_id, generation)
                    .map_err(|error| error.to_string())?;
                if let BrowserSurfaceApplyOutcome::Applied(closed) = self
                    .state()?
                    .coordinator
                    .mark_closed(&lease_id, generation)
                    .map_err(|error| error.to_string())?
                {
                    self.emit_surface_state(app, &closed, "closed", None);
                }
            }
        }
        Ok(())
    }

    fn navigate(
        &self,
        app: &AppHandle,
        cef_host: &Arc<CefHostController>,
        lease_id: String,
        generation: u64,
        client_revision: u64,
        url: String,
    ) -> Result<(), String> {
        let _operation = self.operation()?;
        let current = match self
            .state()?
            .coordinator
            .sync(&lease_id, generation, client_revision)
        {
            BrowserSurfaceApplyOutcome::Applied(current) => current,
            BrowserSurfaceApplyOutcome::Noop => return Ok(()),
        };
        let active = self.active_identity(&lease_id, generation)?;
        cef_host.navigate_surface(app, active.surface_id, url)?;
        self.emit_surface_state(app, &current, "navigate", None);
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn transition_control(
        &self,
        app: &AppHandle,
        sessions: &Arc<LoginBrowserSessionManager>,
        cef_host: &Arc<CefHostController>,
        lease_id: String,
        generation: u64,
        client_revision: u64,
        action: BrowserSurfaceControlActionArg,
    ) -> Result<BrowserSurfaceSnapshotMutationResponse, String> {
        let _operation = self.operation()?;
        let current = match self
            .state()?
            .coordinator
            .sync(&lease_id, generation, client_revision)
        {
            BrowserSurfaceApplyOutcome::Applied(current) => current,
            BrowserSurfaceApplyOutcome::Noop => {
                return Err("Login Browser surface control lease is stale.".to_string())
            }
        };
        let active = self.active_identity(&lease_id, generation)?;
        let session = match action {
            BrowserSurfaceControlActionArg::Handoff => {
                let authorization = TrustedUiControlAuthorization::from_trusted_ui(
                    &active.session,
                    TrustedUiControlAction::HandoffToAgent,
                    SURFACE_CONTROL_AUTHORIZATION_TTL,
                )
                .map_err(|error| error.to_string())?;
                sessions
                    .handoff_to_agent(authorization)
                    .map_err(|error| error.to_string())?;
                sessions
                    .snapshot(&active.session)
                    .map_err(|error| error.to_string())?
            }
            BrowserSurfaceControlActionArg::Pause => {
                let authorization = TrustedUiControlAuthorization::from_trusted_ui(
                    &active.session,
                    TrustedUiControlAction::PauseAgent,
                    SURFACE_CONTROL_AUTHORIZATION_TTL,
                )
                .map_err(|error| error.to_string())?;
                sessions
                    .pause_agent(authorization)
                    .map_err(|error| error.to_string())?
            }
            BrowserSurfaceControlActionArg::Takeover => {
                let authorization = TrustedUiControlAuthorization::from_trusted_ui(
                    &active.session,
                    TrustedUiControlAction::TakeoverByUser,
                    SURFACE_CONTROL_AUTHORIZATION_TTL,
                )
                .map_err(|error| error.to_string())?;
                sessions
                    .takeover_by_user(authorization)
                    .map_err(|error| error.to_string())?
            }
            BrowserSurfaceControlActionArg::Occlude => {
                let authorization = TrustedUiControlAuthorization::from_trusted_ui(
                    &active.session,
                    TrustedUiControlAction::PauseAgent,
                    SURFACE_CONTROL_AUTHORIZATION_TTL,
                )
                .map_err(|error| error.to_string())?;
                let session = sessions
                    .pause_agent_if_active(authorization)
                    .map_err(|error| error.to_string())?;
                // This remains inside the surface operation lane. Once it returns,
                // an overlay owns proof that Agent effects were cancelled before
                // the native child acknowledged hide.
                cef_host.occlude_surface(app, active.surface_id.clone())?;
                session
            }
        };
        let native = cef_host.surface_snapshot(app, active.surface_id)?;
        let response = snapshot_response(&native, &session);
        let server_sequence =
            self.emit_surface_state(app, &current, "control", Some(response.clone()));
        Ok(snapshot_mutation_response(
            &current,
            server_sequence,
            response,
        ))
    }

    fn close_popup(
        &self,
        app: &AppHandle,
        sessions: &Arc<LoginBrowserSessionManager>,
        cef_host: &Arc<CefHostController>,
        lease_id: String,
        generation: u64,
        client_revision: u64,
    ) -> Result<BrowserSurfaceSnapshotMutationResponse, String> {
        let _operation = self.operation()?;
        let current = match self
            .state()?
            .coordinator
            .sync(&lease_id, generation, client_revision)
        {
            BrowserSurfaceApplyOutcome::Applied(current) => current,
            BrowserSurfaceApplyOutcome::Noop => {
                return Err("Login Browser popup lease is stale.".to_string())
            }
        };
        let active = self.active_identity(&lease_id, generation)?;
        cef_host.close_popup(app, active.surface_id.clone())?;
        let native = cef_host.surface_snapshot(app, active.surface_id)?;
        let session = sessions
            .snapshot(&active.session)
            .map_err(|error| error.to_string())?;
        let response = snapshot_response(&native, &session);
        let server_sequence =
            self.emit_surface_state(app, &current, "popup_close", Some(response.clone()));
        Ok(snapshot_mutation_response(
            &current,
            server_sequence,
            response,
        ))
    }

    fn active_identity(
        &self,
        lease_id: &str,
        generation: u64,
    ) -> Result<ActiveLoginSurface, String> {
        let state = self.state()?;
        let active = state
            .active
            .as_ref()
            .ok_or_else(|| "Login Browser surface runtime is unavailable.".to_string())?;
        if active.lease_id != lease_id || active.generation != generation {
            return Err("Login Browser surface lease is stale.".to_string());
        }
        Ok(active.clone())
    }

    fn fail_current(
        &self,
        lease: &crate::browser::surface_coordinator::BrowserSurfaceLease,
        failure: String,
    ) -> String {
        if let Ok(mut state) = self.state.lock() {
            let _ =
                state
                    .coordinator
                    .mark_failed(&lease.lease_id, lease.generation, failure.clone());
        }
        failure
    }
}

impl LoginBrowserSurfaceManager {
    pub(crate) fn begin_shutdown(&self) -> Result<(), String> {
        let _operation = self.operation()?;
        self.state()?.shutting_down = true;
        Ok(())
    }

    pub(crate) fn with_preview_surface_slot<T>(
        &self,
        app: &AppHandle,
        sessions: &LoginBrowserSessionManager,
        cef_host: &CefHostController,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let _operation = self.operation()?;
        let active = self.state()?.active.clone();
        if let Some(active) = active {
            cef_host.set_surface_visible(app, active.surface_id.clone(), false)?;
            let current = self.state()?.coordinator.snapshot();
            if let Some(current) = current.filter(|current| {
                current.lease.lease_id == active.lease_id
                    && current.lease.generation == active.generation
            }) {
                let snapshot = cef_host
                    .surface_snapshot(app, active.surface_id)
                    .ok()
                    .and_then(|native| {
                        sessions
                            .snapshot(&active.session)
                            .ok()
                            .map(|session| snapshot_response(&native, &session))
                    });
                self.emit_surface_state(app, &current, "native_surface_superseded", snapshot);
            }
        }
        operation()
    }

    fn emit_surface_state(
        &self,
        app: &AppHandle,
        current: &crate::browser::surface_coordinator::BrowserSurfaceSnapshot,
        cause: &'static str,
        snapshot: Option<BrowserSurfaceSnapshotResponse>,
    ) -> u64 {
        protocol::emit_surface_state(&self.event_sequence, app, current, cause, snapshot)
    }

    fn operation(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.operation_gate
            .lock()
            .map_err(|_| "Browser surface operation gate is unavailable.".to_string())
    }

    fn state(&self) -> Result<MutexGuard<'_, LoginBrowserSurfaceState>, String> {
        self.state
            .lock()
            .map_err(|_| "Browser surface state is unavailable.".to_string())
    }
}

fn current_watcher_lease(
    coordinator: &BrowserSurfaceCoordinator,
    lease_id: &str,
    generation: u64,
) -> Option<crate::browser::surface_coordinator::BrowserSurfaceSnapshot> {
    coordinator.snapshot().filter(|current| {
        current.lease_active
            && current.lease.lease_id == lease_id
            && current.lease.generation == generation
    })
}

#[cfg(test)]
#[path = "surface_commands/tests.rs"]
mod tests;
