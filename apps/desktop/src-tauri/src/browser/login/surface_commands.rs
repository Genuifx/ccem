use super::session::{
    LoginBrowserSessionHandle, LoginBrowserSessionManager, LoginBrowserSessionSnapshot,
    SessionControlOwner, SessionManagerError, TrustedUiControlAction,
    TrustedUiControlAuthorization, TrustedWorkspacePath,
};
use crate::browser::surface_coordinator::{
    BrowserSurfaceApplyOutcome, BrowserSurfaceBackend, BrowserSurfaceCoordinator,
};
use crate::browser::BrowserManager;
use std::collections::HashMap;
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
    session_runtime::{prepare_launched_runtime_with_profile_group, EmbeddedProfileGroup},
    surface::{
        CefSurfaceRequest, CefSurfaceSnapshot, CefSurfaceStateChange, CefSurfaceStateHandle,
    },
};

const DEFAULT_LOGIN_URL: &str = "about:blank";
#[cfg(any(target_os = "macos", windows))]
const SURFACE_WATCH_INTERVAL: Duration = Duration::from_millis(400);
#[cfg(any(target_os = "macos", windows))]
const SURFACE_CONTROL_AUTHORIZATION_TTL: Duration = Duration::from_secs(30);

#[cfg(any(
    not(debug_assertions),
    test,
    all(target_os = "macos", debug_assertions)
))]
mod production_smoke;
mod protocol;
#[cfg(any(target_os = "macos", windows))]
mod recovery_projection;
mod request;
#[cfg(any(
    not(debug_assertions),
    test,
    all(target_os = "macos", debug_assertions)
))]
#[allow(unused_imports)]
pub(in crate::browser::login) use production_smoke::ProductionSmokeScreenshotProof;
#[cfg(any(not(debug_assertions), all(target_os = "macos", debug_assertions)))]
#[allow(unused_imports)]
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
    // Fixed nesting order for paths that need every layer:
    // lifecycle -> operation -> manager state -> CEF host operation -> native registry.
    // Operation-only paths must never acquire lifecycle.
    /// Serializes ownership-changing work: acquire, exact close, terminal convergence,
    /// shutdown, and persistent-profile group membership.
    lifecycle_gate: Mutex<()>,
    /// Serializes short per-surface mutations and the cross-backend presentation epoch.
    /// A new CEF runtime must not hold this gate while waiting for native attachment.
    operation_gate: Mutex<()>,
    event_sequence: Mutex<u64>,
    state: Mutex<LoginBrowserSurfaceState>,
    #[cfg(any(target_os = "macos", windows))]
    owner_records: Option<EmbeddedOwnerRecordStore>,
}

#[derive(Default)]
struct LoginBrowserSurfaceState {
    instances: BrowserSurfaceInstanceRegistry<ActiveLoginSurface>,
    presentation_epoch: PresentationEpoch,
    #[cfg(any(target_os = "macos", windows))]
    profile_groups: HashMap<String, Arc<EmbeddedProfileGroup>>,
    shutting_down: bool,
    unavailable_reason: Option<String>,
    #[cfg(any(target_os = "macos", windows))]
    recovery: EmbeddedRecoveryRegistry,
}

/// The one native browser panel is shared across concurrently mounted React panels. Per-panel
/// request revisions fence a panel's own queue, while this epoch fences visibility mutations
/// across backends. Equal epochs deliberately admit the old-owner hide and new-owner show pair.
#[derive(Default)]
struct PresentationEpoch {
    last_applied: u64,
    owner: Option<PresentationOwner>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum PresentationOwner {
    Login(String),
    Preview(String),
}

impl PresentationEpoch {
    fn accepts_login_visibility(
        &mut self,
        epoch: u64,
        panel_session_id: &str,
        visible: bool,
    ) -> bool {
        if epoch < self.last_applied {
            return false;
        }
        if epoch > self.last_applied {
            self.last_applied = epoch;
            self.owner = visible.then(|| PresentationOwner::Login(panel_session_id.to_string()));
        } else if visible {
            self.owner = Some(PresentationOwner::Login(panel_session_id.to_string()));
        }
        true
    }

    fn accepts_preview_visibility(&mut self, epoch: u64, session_id: &str, visible: bool) -> bool {
        if epoch < self.last_applied {
            return false;
        }
        if epoch > self.last_applied {
            self.last_applied = epoch;
            self.owner = visible.then(|| PresentationOwner::Preview(session_id.to_string()));
        } else if visible {
            self.owner = Some(PresentationOwner::Preview(session_id.to_string()));
        }
        true
    }

    fn allows_preview_show(&self, session_id: &str) -> bool {
        matches!(self.owner.as_ref(), Some(PresentationOwner::Preview(owner)) if owner == session_id)
    }
}

#[derive(Clone)]
struct ActiveLoginSurface {
    coordinator: BrowserSurfaceCoordinator,
    lease_id: String,
    generation: u64,
    panel_session_id: String,
    surface_id: String,
    profile_id: String,
    session: LoginBrowserSessionHandle,
    #[cfg(any(target_os = "macos", windows))]
    native_state: CefSurfaceStateHandle,
}

/// Runtime instances outlive their presentation lease. The BrowserPanel has one visible native
/// slot, but every CCEM session keeps an independent CEF Browser/runtime record until it is
/// explicitly closed or reaches native terminal state.
struct BrowserSurfaceInstanceRegistry<T> {
    instances: HashMap<String, T>,
    active_panel_session_id: Option<String>,
}

impl<T> Default for BrowserSurfaceInstanceRegistry<T> {
    fn default() -> Self {
        Self {
            instances: HashMap::new(),
            active_panel_session_id: None,
        }
    }
}

impl<T> BrowserSurfaceInstanceRegistry<T> {
    fn get(&self, panel_session_id: &str) -> Option<&T> {
        self.instances.get(panel_session_id)
    }

    fn get_mut(&mut self, panel_session_id: &str) -> Option<&mut T> {
        self.instances.get_mut(panel_session_id)
    }

    fn insert(&mut self, panel_session_id: String, instance: T) -> Option<T> {
        self.instances.insert(panel_session_id, instance)
    }

    fn remove(&mut self, panel_session_id: &str) -> Option<T> {
        if self.active_panel_session_id.as_deref() == Some(panel_session_id) {
            self.active_panel_session_id = None;
        }
        self.instances.remove(panel_session_id)
    }

    fn activate(&mut self, panel_session_id: &str) -> Option<String> {
        if !self.instances.contains_key(panel_session_id) {
            return None;
        }
        self.active_panel_session_id
            .replace(panel_session_id.to_string())
            .filter(|previous| previous != panel_session_id)
    }

    fn deactivate(&mut self, panel_session_id: &str) -> bool {
        if self.active_panel_session_id.as_deref() != Some(panel_session_id) {
            return false;
        }
        self.active_panel_session_id = None;
        true
    }

    fn active_panel_session_id(&self) -> Option<&str> {
        self.active_panel_session_id.as_deref()
    }

    fn active(&self) -> Option<&T> {
        self.active_panel_session_id
            .as_deref()
            .and_then(|panel_session_id| self.instances.get(panel_session_id))
    }

    fn active_panel_and_instance(&self) -> Option<(&str, &T)> {
        let panel_session_id = self.active_panel_session_id.as_deref()?;
        self.instances
            .get(panel_session_id)
            .map(|instance| (panel_session_id, instance))
    }
}

pub(crate) mod ipc;

#[cfg(any(target_os = "macos", windows))]
impl LoginBrowserSurfaceManager {
    pub(crate) fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            lifecycle_gate: Mutex::new(()),
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
            lifecycle_gate: Mutex::new(()),
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
        _preview: &Arc<BrowserManager>,
        panel_session_id: String,
        backend: BrowserSurfaceBackendArg,
        working_dir: Option<String>,
        profile_mode: Option<BrowserSurfaceProfileModeArg>,
        profile_id: Option<String>,
        initial_url: Option<String>,
        viewport: BrowserSurfaceViewportArg,
        client_revision: u64,
    ) -> Result<BrowserSurfaceLeaseResponse, String> {
        let _lifecycle = self.begin_acquire()?;
        validate_panel_session_id(&panel_session_id)?;
        if client_revision == 0 {
            return Err("Browser surface revision must be positive.".to_string());
        }
        if !matches!(backend, BrowserSurfaceBackendArg::Login) {
            return Err("Preview Browser keeps its existing browser_* command path.".to_string());
        }
        let viewport = viewport.validate()?;
        let initial_url = crate::browser::url::parse_browser_url(
            initial_url.as_deref().unwrap_or(DEFAULT_LOGIN_URL),
        )?
        .to_string();

        if let Some(existing) = self.state()?.instances.get(&panel_session_id).cloned() {
            // Native/session preflight does not own the presentation lane. The retained surface
            // carries a thread-safe state handle, so reacquire never waits on a main-thread CEF
            // snapshot while blocking another panel's hide/show.
            let native = existing.native_state.snapshot();
            let session = sessions
                .snapshot(&existing.session)
                .map_err(|error| error.to_string())?;
            let snapshot = snapshot_response(&native, &session);
            {
                // Retained-instance rotation is short and mutates the same coordinator revision as
                // sync/navigate/close. Lifecycle keeps the physical instance alive during
                // preflight; operation then revalidates it immediately before rotating the lease.
                let _operation = self.operation()?;
                // Acquiring a retained runtime only rotates its per-panel lease. Presentation is a
                // separate, globally epoch-fenced `sync(visible)` transaction; acquire must never
                // hide whichever panel a newer frontend epoch already selected.
                let (lease, current) = {
                    let mut state = self.state()?;
                    let instance = state
                        .instances
                        .get_mut(&panel_session_id)
                        .ok_or_else(|| "Login Browser session instance disappeared.".to_string())?;
                    if instance.surface_id != existing.surface_id
                        || instance.session != existing.session
                    {
                        return Err(
                            "Login Browser retained instance changed during reacquire.".to_string()
                        );
                    }
                    let acquire = instance
                        .coordinator
                        .acquire(BrowserSurfaceBackend::Login, client_revision)
                        .map_err(|error| error.to_string())?;
                    instance.lease_id = acquire.current.lease.lease_id.clone();
                    instance.generation = acquire.current.lease.generation;
                    let current = instance
                        .coordinator
                        .mark_ready(&instance.lease_id, instance.generation)
                        .map_err(|error| error.to_string())?;
                    let BrowserSurfaceApplyOutcome::Applied(current) = current else {
                        return Err("Login Browser instance lease was superseded before resume."
                            .to_string());
                    };
                    (acquire.current.lease, current)
                };
                let server_sequence =
                    self.emit_surface_state(app, &current, "resumed", Some(snapshot.clone()));
                return Ok(BrowserSurfaceLeaseResponse {
                    lease_id: lease.lease_id,
                    generation: lease.generation,
                    surface_id: Some(existing.surface_id),
                    client_revision: current.last_applied_revision,
                    server_sequence,
                    backend: "login",
                    profile_id: Some(existing.profile_id),
                    snapshot: Some(snapshot),
                });
            }
        }

        let mut coordinator = BrowserSurfaceCoordinator::new();
        let acquire = coordinator
            .acquire(BrowserSurfaceBackend::Login, client_revision)
            .map_err(|error| error.to_string())?;
        let lease = acquire.current.lease.clone();
        let working_dir = working_dir
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "Login Browser working directory is required.".to_string())?;
        let workspace = TrustedWorkspacePath::from_trusted_app(PathBuf::from(working_dir))
            .map_err(|error| error.to_string())?;
        let selection = parse_profile_selection(profile_mode, profile_id)?;
        let selected_registration = sessions
            .select_embedded_registration(workspace, selection)
            .map_err(|error| error.to_string())?;
        let selected_profile_id = selected_registration.profile_id().as_str().to_string();
        let recovery_identity = super::session::EmbeddedProfileIdentity::new(
            selected_registration.profile_id(),
            selected_registration.workspace_identity(),
        );
        let recovery_states = self.state()?.recovery.states_for(&recovery_identity);
        let surface_id = format!("login-{}-{}", lease.generation, lease.lease_id);
        let profile_group_runtime_id =
            format!("login-group-{}-{}", lease.generation, lease.lease_id);
        let existing_profile_group = self
            .state()?
            .profile_groups
            .get(&selected_profile_id)
            .cloned();
        let owner_records = self
            .owner_records
            .as_ref()
            .ok_or_else(|| "Embedded browser recovery state is unavailable.".to_string())?;
        let (registration, profile_group, created_profile_group) =
            if let Some(profile_group) = existing_profile_group {
                (selected_registration, profile_group, false)
            } else {
                let prepared = sessions
                    .prepare_embedded_profile_for_registration(
                        selected_registration,
                        &profile_group_runtime_id,
                        owner_records,
                    )
                    .map_err(|error| recovery_aware_error(&error.to_string(), &recovery_states))?;
                let (registration, profile_lease, owner_record) = prepared.into_launch_parts();
                (
                    registration,
                    EmbeddedProfileGroup::new(
                        profile_group_runtime_id,
                        surface_id.clone(),
                        profile_lease,
                        Some(owner_record),
                    ),
                    true,
                )
            };
        profile_group
            .attach_surface(&surface_id)
            .map_err(|error| error.to_string())?;
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
                let cleanup = profile_group.abort_surface_before_native_open(&surface_id);
                return Err(cleanup.err().map_or(error.clone(), |cleanup_error| {
                    format!("{error}; cancel profile-group member: {cleanup_error}")
                }));
            }
        };
        let native_state = connection.state_handle();
        let launched = prepare_launched_runtime_with_profile_group(
            app.clone(),
            Arc::clone(cef_host),
            surface_id.clone(),
            connection,
            Arc::clone(&profile_group),
        )
        .map_err(|error| error.to_string())?;
        let opened = sessions
            .register_prepared(registration, launched)
            .map_err(|error| error.to_string())?;
        if native_state.allow_user_popups().is_err() {
            let _ = sessions.force_stop(&opened.handle);
            return Err(
                "Login Browser popup admission could not enter registered User control."
                    .to_string(),
            );
        }
        {
            let mut state = self.state()?;
            if created_profile_group {
                state
                    .profile_groups
                    .insert(selected_profile_id.clone(), Arc::clone(&profile_group));
            }
            state.instances.insert(
                panel_session_id.clone(),
                ActiveLoginSurface {
                    coordinator,
                    lease_id: lease.lease_id.clone(),
                    generation: lease.generation,
                    panel_session_id: panel_session_id.clone(),
                    surface_id: surface_id.clone(),
                    profile_id: selected_profile_id.clone(),
                    session: opened.handle.clone(),
                    native_state: native_state.clone(),
                },
            );
        }
        let current = match self
            .state()?
            .instances
            .get_mut(&panel_session_id)
            .ok_or_else(|| "Login Browser session instance disappeared.".to_string())?
            .coordinator
            .mark_ready(&lease.lease_id, lease.generation)
        {
            Ok(BrowserSurfaceApplyOutcome::Applied(current)) => current,
            Ok(BrowserSurfaceApplyOutcome::Noop) => {
                let _ = sessions.force_stop(&opened.handle);
                self.remove_instance_and_empty_profile_group(
                    &panel_session_id,
                    &selected_profile_id,
                );
                return Err("Login Browser surface was superseded before display.".to_string());
            }
            Err(error) => {
                let _ = sessions.force_stop(&opened.handle);
                self.remove_instance_and_empty_profile_group(
                    &panel_session_id,
                    &selected_profile_id,
                );
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
                let _ = sessions.force_stop(&opened.handle);
                self.remove_instance_and_empty_profile_group(
                    &panel_session_id,
                    &selected_profile_id,
                );
                return Err(format!(
                    "Login Browser renderer recovery fence failed: {error}"
                ));
            }
        };
        let mut snapshot = snapshot_response(&native, &initial_session);
        snapshot.set_recovery_states(&recovery_states);
        let watcher_start = match self.start_state_watcher(
            app.clone(),
            Arc::clone(sessions),
            native_state,
            panel_session_id.clone(),
            surface_id.clone(),
            opened.handle.clone(),
            native,
            initial_session,
        ) {
            Ok(watcher_start) => watcher_start,
            Err(error) => {
                let _ = sessions.force_stop(&opened.handle);
                self.remove_instance_and_empty_profile_group(
                    &panel_session_id,
                    &selected_profile_id,
                );
                return Err(error);
            }
        };
        let server_sequence =
            self.emit_surface_state(app, &current, "ready", Some(snapshot.clone()));
        if let Ok(mut state) = self.state() {
            state
                .recovery
                .acknowledge_successful_acquire(&recovery_identity);
        }
        watcher_start.wait();
        Ok(BrowserSurfaceLeaseResponse {
            lease_id: lease.lease_id,
            generation: lease.generation,
            surface_id: Some(surface_id),
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
        panel_session_id: String,
        surface_id: String,
        session: LoginBrowserSessionHandle,
        initial_native: CefSurfaceSnapshot,
        initial_session: LoginBrowserSessionSnapshot,
    ) -> Result<Arc<Barrier>, String> {
        let manager = Arc::clone(self);
        let start = Arc::new(Barrier::new(2));
        let worker_start = Arc::clone(&start);
        thread::Builder::new()
            .name(format!("ccem-cef-state-{surface_id}"))
            .spawn(move || {
                worker_start.wait();
                manager.run_state_watcher(
                    app,
                    sessions,
                    native_state,
                    panel_session_id,
                    surface_id,
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
        panel_session_id: String,
        surface_id: String,
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
                        "CEF surface state watcher stopped panel={} surface={}: {error}",
                        panel_session_id, surface_id,
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
            if !self.watcher_instance_is_live(&panel_session_id, &surface_id, &session) {
                return;
            }

            if let Ok(current_session) = sessions.snapshot(&session) {
                session_snapshot = current_session;
            }
            if terminal {
                let _destructive = match self.destructive_operation() {
                    Ok(guards) => guards,
                    Err(error) => {
                        eprintln!(
                            "CEF terminal watcher lost destructive lane panel={} surface={}: {error}",
                            panel_session_id, surface_id,
                        );
                        return;
                    }
                };
                if !self.watcher_instance_is_live(&panel_session_id, &surface_id, &session) {
                    return;
                }
                native = native_state.snapshot();
                if let Ok(current_session) = sessions.snapshot(&session) {
                    session_snapshot = current_session;
                }
                let response = snapshot_response(&native, &session_snapshot);
                match self.converge_terminal_watcher_locked(
                    &sessions,
                    &panel_session_id,
                    &surface_id,
                    &session,
                ) {
                    Ok(Some(closed)) => {
                        self.emit_surface_state(&app, &closed, "native_closed", Some(response));
                    }
                    Ok(None) => {}
                    Err(error) => {
                        eprintln!(
                            "CEF surface terminal convergence failed panel={} surface={}: {error}",
                            panel_session_id, surface_id,
                        );
                        if let Some(current) =
                            self.current_watcher_snapshot(&panel_session_id, &surface_id)
                        {
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
                }
                return;
            }

            let response = snapshot_response(&native, &session_snapshot);
            if response == last_emitted {
                continue;
            }
            let _operation = match self.operation() {
                Ok(operation) => operation,
                Err(error) => {
                    eprintln!(
                        "CEF surface state watcher lost operation lane panel={} surface={}: {error}",
                        panel_session_id, surface_id,
                    );
                    return;
                }
            };
            if !self.watcher_instance_is_live(&panel_session_id, &surface_id, &session) {
                return;
            }
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
                        "CEF renderer recovery control fence failed panel={} surface={}: {error}",
                        panel_session_id, surface_id,
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
            if let Some(current) = self.current_watcher_snapshot(&panel_session_id, &surface_id) {
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
        panel_session_id: &str,
        surface_id: &str,
        session: &LoginBrowserSessionHandle,
    ) -> Result<Option<crate::browser::surface_coordinator::BrowserSurfaceSnapshot>, String> {
        {
            let state = self.state()?;
            let Some(instance) = state.instances.get(panel_session_id) else {
                return Ok(None);
            };
            if instance.surface_id != surface_id || instance.session != *session {
                return Ok(None);
            }
        }
        match sessions.force_stop(session) {
            Ok(()) | Err(SessionManagerError::SessionNotFound) => {}
            Err(error) => return Err(error.to_string()),
        }

        let mut state = self.state()?;
        let Some(instance) = state.instances.get(panel_session_id).cloned() else {
            return Ok(None);
        };
        if instance.surface_id != surface_id || instance.session != *session {
            return Ok(None);
        }
        let terminal_lease = current_watcher_lease(
            &instance.coordinator,
            &instance.lease_id,
            instance.generation,
        );
        let profile_id = instance.profile_id.clone();
        let closed = if terminal_lease.is_some() {
            let instance = state
                .instances
                .get_mut(panel_session_id)
                .ok_or_else(|| "Login Browser session instance disappeared.".to_string())?;
            instance
                .coordinator
                .begin_close(&instance.lease_id, instance.generation)
                .map_err(|error| error.to_string())?;
            match instance
                .coordinator
                .mark_closed(&instance.lease_id, instance.generation)
                .map_err(|error| error.to_string())?
            {
                BrowserSurfaceApplyOutcome::Applied(closed) => Some(closed),
                BrowserSurfaceApplyOutcome::Noop => instance.coordinator.snapshot(),
            }
        } else {
            None
        };
        state.instances.remove(panel_session_id);
        if state
            .profile_groups
            .get(&profile_id)
            .is_some_and(|group| group.is_empty())
        {
            state.profile_groups.remove(&profile_id);
        }
        Ok(closed)
    }

    fn watcher_instance_is_live(
        &self,
        panel_session_id: &str,
        surface_id: &str,
        session: &LoginBrowserSessionHandle,
    ) -> bool {
        let Ok(state) = self.state.lock() else {
            return false;
        };
        !state.shutting_down
            && state
                .instances
                .get(panel_session_id)
                .is_some_and(|instance| {
                    instance.surface_id == surface_id && instance.session == *session
                })
    }

    fn current_watcher_snapshot(
        &self,
        panel_session_id: &str,
        surface_id: &str,
    ) -> Option<crate::browser::surface_coordinator::BrowserSurfaceSnapshot> {
        let state = self.state.lock().ok()?;
        if state.shutting_down {
            return None;
        }
        let instance = state.instances.get(panel_session_id)?;
        if instance.surface_id != surface_id {
            return None;
        }
        current_watcher_lease(
            &instance.coordinator,
            &instance.lease_id,
            instance.generation,
        )
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
        presentation_revision: Option<u64>,
    ) -> Result<(), String> {
        let _operation = self.mutation_operation()?;
        let presentation_revision = match (visible, presentation_revision) {
            (Some(_), Some(revision)) if revision > 0 => Some(revision),
            (Some(_), _) => {
                return Err(
                    "Browser surface visibility requires a positive presentation revision."
                        .to_string(),
                );
            }
            (None, _) => None,
        };
        let Some((active, current)) =
            self.apply_instance_revision(&lease_id, generation, client_revision)?
        else {
            return Ok(());
        };
        if let (Some(presentation_revision), Some(visible)) = (presentation_revision, visible) {
            if !self.state()?.presentation_epoch.accepts_login_visibility(
                presentation_revision,
                &active.panel_session_id,
                visible,
            ) {
                return Ok(());
            }
        }
        if let Some(viewport) = viewport {
            cef_host.set_surface_viewport(app, active.surface_id.clone(), viewport.validate()?)?;
        }
        if visible == Some(true) {
            self.hide_active_before_activation(app, cef_host, &active.panel_session_id)?;
            preview.hide_all(app)?;
            if let Err(error) = cef_host.set_surface_visible(app, active.surface_id.clone(), true) {
                let _ = cef_host.set_surface_visible(app, active.surface_id.clone(), false);
                return Err(error);
            }
            self.state()?.instances.activate(&active.panel_session_id);
        } else if visible == Some(false) {
            cef_host.set_surface_visible(app, active.surface_id.clone(), false)?;
            self.state()?.instances.deactivate(&active.panel_session_id);
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
        let _destructive = self.release_operation()?;
        match disposition {
            BrowserSurfaceReleaseArg::Hide => {
                return Err(
                    "Browser surface release only closes a runtime; use epoch-fenced sync to hide it."
                        .to_string(),
                );
            }
            BrowserSurfaceReleaseArg::Close => {
                // Consume only the client revision before native cleanup. The
                // lease stays Ready/active until `sessions.close` has observed
                // OnBeforeClose and released the profile, so a failed close can
                // be retried instead of becoming an irreversible successful no-op.
                let Some((active, _current)) =
                    self.apply_instance_revision(&lease_id, generation, client_revision)?
                else {
                    return Ok(());
                };
                // Session close revokes Agent authority before its embedded backend closes CEF.
                sessions
                    .close(&active.session)
                    .map_err(|error| error.to_string())?;
                let closed = {
                    let mut state = self.state()?;
                    let instance = state
                        .instances
                        .get_mut(&active.panel_session_id)
                        .ok_or_else(|| "Login Browser session instance disappeared.".to_string())?;
                    instance
                        .coordinator
                        .begin_close(&lease_id, generation)
                        .map_err(|error| error.to_string())?;
                    match instance
                        .coordinator
                        .mark_closed(&lease_id, generation)
                        .map_err(|error| error.to_string())?
                    {
                        BrowserSurfaceApplyOutcome::Applied(closed) => Some(closed),
                        BrowserSurfaceApplyOutcome::Noop => None,
                    }
                };
                self.remove_instance_and_empty_profile_group(
                    &active.panel_session_id,
                    &active.profile_id,
                );
                if let Some(closed) = closed {
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
        let _operation = self.mutation_operation()?;
        let Some((active, current)) =
            self.apply_instance_revision(&lease_id, generation, client_revision)?
        else {
            return Ok(());
        };
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
        agent_actor_id: Option<String>,
        agent_actor_validator: Option<&dyn Fn(&str) -> Result<(), String>>,
    ) -> Result<BrowserSurfaceSnapshotMutationResponse, String> {
        let _operation = self.mutation_operation()?;
        let Some((active, current)) =
            self.apply_instance_revision(&lease_id, generation, client_revision)?
        else {
            return Err("Login Browser surface control lease is stale.".to_string());
        };
        let session = match action {
            BrowserSurfaceControlActionArg::Handoff => {
                let agent_actor_id = agent_actor_id.as_deref().ok_or_else(|| {
                    "Login Browser Agent handoff requires an active CCEM conversation.".to_string()
                })?;
                if let Some(validate_actor) = agent_actor_validator {
                    validate_actor(agent_actor_id)?;
                }
                let authorization = TrustedUiControlAuthorization::from_trusted_ui(
                    &active.session,
                    TrustedUiControlAction::HandoffToAgent,
                    SURFACE_CONTROL_AUTHORIZATION_TTL,
                )
                .map_err(|error| error.to_string())?;
                sessions
                    .handoff_to_agent_for_actor(authorization, agent_actor_id)
                    .map_err(|error| error.to_string())?;
                if let Some(validate_actor) = agent_actor_validator {
                    if let Err(validation_error) = validate_actor(agent_actor_id) {
                        let rollback_authorization =
                            TrustedUiControlAuthorization::from_trusted_ui(
                                &active.session,
                                TrustedUiControlAction::PauseAgent,
                                SURFACE_CONTROL_AUTHORIZATION_TTL,
                            )
                            .map_err(|error| error.to_string())?;
                        sessions
                            .pause_agent_if_active(rollback_authorization)
                            .map_err(|rollback_error| {
                                format!(
                                    "{validation_error} Login Browser failed to retire the stale Agent handoff: {rollback_error}"
                                )
                            })?;
                        return Err(validation_error);
                    }
                }
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
        let _operation = self.mutation_operation()?;
        let Some((active, current)) =
            self.apply_instance_revision(&lease_id, generation, client_revision)?
        else {
            return Err("Login Browser popup lease is stale.".to_string());
        };
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

    fn apply_instance_revision(
        &self,
        lease_id: &str,
        generation: u64,
        client_revision: u64,
    ) -> Result<
        Option<(
            ActiveLoginSurface,
            crate::browser::surface_coordinator::BrowserSurfaceSnapshot,
        )>,
        String,
    > {
        let mut state = self.state()?;
        let Some(panel_session_id) =
            state
                .instances
                .instances
                .iter()
                .find_map(|(panel, instance)| {
                    (instance.lease_id == lease_id && instance.generation == generation)
                        .then(|| panel.clone())
                })
        else {
            return Ok(None);
        };
        let (active, current) = {
            let instance = state
                .instances
                .get_mut(&panel_session_id)
                .ok_or_else(|| "Login Browser session instance disappeared.".to_string())?;
            match instance
                .coordinator
                .sync(lease_id, generation, client_revision)
            {
                BrowserSurfaceApplyOutcome::Applied(current) => (instance.clone(), current),
                BrowserSurfaceApplyOutcome::Noop => return Ok(None),
            }
        };
        Ok(Some((active, current)))
    }

    /// Resolves a physical runtime from its current presentation lease. Despite the historical
    /// name, this intentionally includes retained hidden surfaces so the signed smoke can inspect
    /// the acquire-before-visible state without treating it as a visible owner.
    fn active_identity(
        &self,
        lease_id: &str,
        generation: u64,
    ) -> Result<ActiveLoginSurface, String> {
        let state = self.state()?;
        state
            .instances
            .instances
            .values()
            .find(|instance| instance.lease_id == lease_id && instance.generation == generation)
            .cloned()
            .ok_or_else(|| "Login Browser surface lease is stale.".to_string())
    }

    fn hide_active_before_activation(
        &self,
        app: &AppHandle,
        cef_host: &CefHostController,
        target_panel_session_id: &str,
    ) -> Result<(), String> {
        let previous = self.state()?.instances.active().cloned();
        let Some(previous) =
            previous.filter(|previous| previous.panel_session_id != target_panel_session_id)
        else {
            return Ok(());
        };
        cef_host.set_surface_visible(app, previous.surface_id, false)?;
        self.state()?
            .instances
            .deactivate(&previous.panel_session_id);
        Ok(())
    }

    fn remove_instance_and_empty_profile_group(&self, panel_session_id: &str, profile_id: &str) {
        let Ok(mut state) = self.state() else {
            return;
        };
        state.instances.remove(panel_session_id);
        if state
            .profile_groups
            .get(profile_id)
            .is_some_and(|group| group.is_empty())
        {
            state.profile_groups.remove(profile_id);
        }
    }
}

impl LoginBrowserSurfaceManager {
    pub(crate) fn begin_shutdown(&self) -> Result<(), String> {
        let _destructive = self.destructive_operation()?;
        self.state()?.shutting_down = true;
        Ok(())
    }

    pub(crate) fn with_preview_surface_slot<T>(
        &self,
        app: &AppHandle,
        sessions: &LoginBrowserSessionManager,
        cef_host: &CefHostController,
        preview_session_id: &str,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let _operation = self.mutation_operation()?;
        if !self
            .state()?
            .presentation_epoch
            .allows_preview_show(preview_session_id)
        {
            return Err(
                "Preview Browser show is stale for the current presentation owner.".to_string(),
            );
        }
        self.hide_active_login_for_preview(app, sessions, cef_host)?;
        operation()
    }

    /// Applies a Preview Browser visibility mutation in the same global presentation epoch as
    /// Login Browser sync. A delayed Preview request is a successful no-op: it must not hide the
    /// Login surface selected by a later Workspace intent.
    pub(crate) fn with_preview_presentation_epoch<T>(
        &self,
        app: &AppHandle,
        sessions: &LoginBrowserSessionManager,
        cef_host: &CefHostController,
        presentation_revision: u64,
        preview_session_id: &str,
        preview_will_be_visible: bool,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<Option<T>, String> {
        if presentation_revision == 0 {
            return Err(
                "Preview visibility requires a positive presentation revision.".to_string(),
            );
        }
        let _operation = self.mutation_operation()?;
        if !self.state()?.presentation_epoch.accepts_preview_visibility(
            presentation_revision,
            preview_session_id,
            preview_will_be_visible,
        ) {
            return Ok(None);
        }
        if preview_will_be_visible {
            self.hide_active_login_for_preview(app, sessions, cef_host)?;
        }
        operation().map(Some)
    }

    fn hide_active_login_for_preview(
        &self,
        app: &AppHandle,
        sessions: &LoginBrowserSessionManager,
        cef_host: &CefHostController,
    ) -> Result<(), String> {
        let active = self.state()?.instances.active().cloned();
        if let Some(active) = active {
            cef_host.set_surface_visible(app, active.surface_id.clone(), false)?;
            self.state()?.instances.deactivate(&active.panel_session_id);
            let current = active.coordinator.snapshot();
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
        Ok(())
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

    /// Linearizes ordinary mutations with shutdown. Once shutdown commits while holding the
    /// operation gate, a queued Login or Preview show cannot start afterward.
    fn mutation_operation(&self) -> Result<MutexGuard<'_, ()>, String> {
        let operation = self.operation()?;
        if self.state()?.shutting_down {
            return Err("Login Browser is shutting down.".to_string());
        }
        Ok(operation)
    }

    fn lifecycle(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.lifecycle_gate
            .lock()
            .map_err(|_| "Browser surface lifecycle gate is unavailable.".to_string())
    }

    /// Acquire keeps this guard through profile selection, native creation, attachment, and
    /// registration. It deliberately does not hold `operation_gate`, so an existing browser can
    /// still hide or re-show while another runtime attaches.
    fn begin_acquire(&self) -> Result<MutexGuard<'_, ()>, String> {
        let lifecycle = self.lifecycle()?;
        {
            let state = self.state()?;
            if let Some(reason) = state.unavailable_reason.as_ref() {
                return Err(reason.clone());
            }
            if state.shutting_down {
                return Err("Login Browser is shutting down.".to_string());
            }
        }
        Ok(lifecycle)
    }

    /// Ownership-destroying paths always take lifecycle before operation. Operation-only
    /// presentation paths never acquire lifecycle, which prevents the reverse-order cycle.
    fn destructive_operation(&self) -> Result<(MutexGuard<'_, ()>, MutexGuard<'_, ()>), String> {
        let lifecycle = self.lifecycle()?;
        let operation = self.operation()?;
        Ok((lifecycle, operation))
    }

    /// Linearizes an explicit panel close with global shutdown. If release won the lifecycle
    /// gate, it finishes before `begin_shutdown`; if shutdown won, the queued release must not call
    /// `sessions.close` while `shutdown_all` owns the same backend.
    fn release_operation(&self) -> Result<(MutexGuard<'_, ()>, MutexGuard<'_, ()>), String> {
        let guards = self.destructive_operation()?;
        if self.state()?.shutting_down {
            return Err("Login Browser is shutting down.".to_string());
        }
        Ok(guards)
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
