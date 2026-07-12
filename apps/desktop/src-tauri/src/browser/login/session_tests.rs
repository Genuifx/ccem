use super::*;
use crate::browser::login::backend::{
    ActionResult, BackendFailure, NavigationResult, SemanticBrowserBackend, SemanticBrowserCommand,
    SemanticBrowserResult,
};
use crate::browser::login::control::{ControlErrorCode, HandoffControl};
use crate::browser::login::profile::{OwnershipDomainGone, ProfileCleanupState};
use crate::browser::login::session_backend::{
    SessionBackendProjection, SessionBackendStartSpec, SessionLaunchRuntime, SessionOwnedBackend,
};
use crate::browser::runtime::paths::RuntimePaths;
use std::fs;
use std::sync::{mpsc, Barrier, Mutex};
use std::thread;
use std::time::Instant;

#[path = "session_activity_tests.rs"]
mod activity_tests;
#[path = "session_handoff_tests.rs"]
mod handoff_tests;
#[path = "session_permission_tests.rs"]
mod permission_tests;

struct FakeSupervisorState {
    reap_count: usize,
    launch_count: usize,
    close_count: usize,
    force_count: usize,
    emergency_count: usize,
    fail_close: bool,
    fail_diagnostic_begin: bool,
    preflight_count: usize,
    preflight_barriers: Option<(Arc<Barrier>, Arc<Barrier>)>,
    current_url: String,
    semantic_effect_count: usize,
}

impl Default for FakeSupervisorState {
    fn default() -> Self {
        Self {
            reap_count: 0,
            launch_count: 0,
            close_count: 0,
            force_count: 0,
            emergency_count: 0,
            fail_close: false,
            fail_diagnostic_begin: false,
            preflight_count: 0,
            preflight_barriers: None,
            current_url: "https://example.com/account?token=secret".to_string(),
            semantic_effect_count: 0,
        }
    }
}

#[derive(Clone)]
struct FakeSupervisor {
    state: Arc<Mutex<FakeSupervisorState>>,
}

impl SessionSupervisor for FakeSupervisor {
    fn reap_stale(&self, _profiles: &BrowserProfileManager) -> Result<(), SessionManagerError> {
        self.state.lock().unwrap().reap_count += 1;
        Ok(())
    }

    fn launch_active(
        &self,
        mut profile_lease: BrowserProfileLease,
        _activation_store: &ActivationStore,
    ) -> Result<LaunchedSessionRuntime, SessionManagerError> {
        let launch_number = {
            let mut state = self.state.lock().unwrap();
            state.launch_count += 1;
            state.launch_count
        };
        profile_lease
            .mark_runtime_owned(
                &format!("runtime-test-{launch_number}"),
                "150.0.7871.115",
                LOGIN_PROTOCOL_VERSION,
            )
            .map_err(map_profile_error)?;
        Ok(LaunchedSessionRuntime {
            runtime: Box::new(FakeRuntime {
                profile_lease: Some(profile_lease),
                state: Arc::clone(&self.state),
            }),
            runtime_version: "150.0.7871.115".to_string(),
        })
    }
}

struct FakeRuntime {
    profile_lease: Option<BrowserProfileLease>,
    state: Arc<Mutex<FakeSupervisorState>>,
}

impl FakeRuntime {
    fn release_profile(&mut self) -> Result<(), SessionManagerError> {
        let Some(profile_lease) = self.profile_lease.take() else {
            return Ok(());
        };
        let proof = OwnershipDomainGone::from_supervisor(profile_lease.ownership_id().to_string())
            .map_err(map_profile_error)?;
        profile_lease
            .release_after_ownership_domain_gone(proof)
            .map(|_| ())
            .map_err(map_profile_error)
    }
}

impl SessionLaunchRuntime for FakeRuntime {
    fn start_backend(
        self: Box<Self>,
        _spec: SessionBackendStartSpec,
    ) -> Result<Arc<dyn SessionOwnedBackend>, SessionManagerError> {
        Ok(Arc::new(FakeBackend {
            runtime: Mutex::new(Some(*self)),
        }))
    }
}

impl Drop for FakeRuntime {
    fn drop(&mut self) {
        let _ = self.release_profile();
    }
}

struct FakeBackend {
    runtime: Mutex<Option<FakeRuntime>>,
}

impl SemanticBrowserBackend for FakeBackend {
    fn execute(
        &self,
        command: &SemanticBrowserCommand,
        cancellation: &crate::browser::login::control::OperationCancellation,
    ) -> Result<SemanticBrowserResult, BackendFailure> {
        if cancellation.is_cancelled() {
            return Err(BackendFailure::cancelled());
        }
        let runtime = self.runtime.lock().map_err(|_| {
            BackendFailure::new(
                crate::browser::login::backend::BackendFailureCode::RuntimeUnavailable,
                "fake semantic backend",
            )
        })?;
        let runtime = runtime.as_ref().ok_or_else(|| {
            BackendFailure::new(
                crate::browser::login::backend::BackendFailureCode::RuntimeUnavailable,
                "fake semantic backend",
            )
        })?;
        let mut state = runtime.state.lock().map_err(|_| {
            BackendFailure::new(
                crate::browser::login::backend::BackendFailureCode::RuntimeUnavailable,
                "fake semantic backend",
            )
        })?;
        state.semantic_effect_count += 1;
        match command {
            SemanticBrowserCommand::GetUrl | SemanticBrowserCommand::Navigate { .. } => {
                Ok(SemanticBrowserResult::Navigation(NavigationResult {
                    url: state.current_url.clone(),
                    title: Some("Fixture".to_string()),
                }))
            }
            SemanticBrowserCommand::Click { .. } | SemanticBrowserCommand::Type { .. } => {
                Ok(SemanticBrowserResult::Action(ActionResult {
                    completed: true,
                }))
            }
            _ => Err(BackendFailure::new(
                crate::browser::login::backend::BackendFailureCode::RuntimeUnavailable,
                "unsupported fake semantic command",
            )),
        }
    }
}

impl SessionOwnedBackend for FakeBackend {
    fn projection(&self) -> Result<SessionBackendProjection, SessionManagerError> {
        let runtime = self
            .runtime
            .lock()
            .map_err(|_| SessionManagerError::StateUnavailable)?;
        let runtime = runtime
            .as_ref()
            .ok_or(SessionManagerError::RuntimeUnavailable)?;
        let current_url = runtime.state.lock().unwrap().current_url.clone();
        Ok(SessionBackendProjection {
            current_url,
            current_title: Some("Fixture".to_string()),
            generation: 1,
            ready: true,
            terminated: false,
        })
    }

    fn validate_current_origin(
        &self,
        expected: &NormalizedOrigin,
    ) -> Result<SessionBackendProjection, SessionManagerError> {
        let projection = self.projection()?;
        let actual = NormalizedOrigin::parse(&projection.current_url)
            .map_err(|_| SessionManagerError::OriginUnavailable)?;
        if &actual != expected {
            return Err(SessionManagerError::OriginUnavailable);
        }
        Ok(projection)
    }
    fn preflight_handoff(&self, expected: &NormalizedOrigin) -> Result<(), SessionManagerError> {
        let state = Arc::clone(&self.runtime.lock().unwrap().as_ref().unwrap().state);
        let barriers = {
            let mut state = state.lock().unwrap();
            state.preflight_count += 1;
            if state.fail_close {
                return Err(SessionManagerError::OriginUnavailable);
            }
            state.preflight_barriers.clone()
        };
        if let Some((entered, release)) = barriers {
            entered.wait();
            release.wait();
        }
        self.validate_current_origin(expected).map(|_| ())
    }

    fn begin_diagnostic_segment(&self, _handoff_epoch: u64) -> Result<(), SessionManagerError> {
        if self
            .runtime
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .state
            .lock()
            .unwrap()
            .fail_diagnostic_begin
        {
            Err(SessionManagerError::ControlUnavailable)
        } else {
            Ok(())
        }
    }
    fn with_navigation_policy_quiesced(
        &self,
        transition: &mut dyn FnMut(),
    ) -> Result<(), SessionManagerError> {
        transition();
        Ok(())
    }

    fn shutdown(&self, force: bool) -> Result<(), SessionManagerError> {
        let mut slot = self
            .runtime
            .lock()
            .map_err(|_| SessionManagerError::StateUnavailable)?;
        let runtime = slot
            .as_mut()
            .ok_or(SessionManagerError::RuntimeUnavailable)?;
        if !force && runtime.state.lock().unwrap().fail_close {
            return Err(SessionManagerError::RuntimeUnavailable);
        }
        runtime.release_profile()?;
        let state = Arc::clone(&runtime.state);
        let _ = slot.take();
        if force {
            state.lock().unwrap().force_count += 1;
        } else {
            state.lock().unwrap().close_count += 1;
        }
        Ok(())
    }

    fn emergency_stop_verified_domain(&self) -> Result<(), SessionManagerError> {
        let state = Arc::clone(
            &self
                .runtime
                .lock()
                .map_err(|_| SessionManagerError::StateUnavailable)?
                .as_ref()
                .ok_or(SessionManagerError::RuntimeUnavailable)?
                .state,
        );
        state.lock().unwrap().emergency_count += 1;
        Ok(())
    }
}

struct Fixture {
    _temp: tempfile::TempDir,
    manager: Arc<LoginBrowserSessionManager>,
    state: Arc<Mutex<FakeSupervisorState>>,
    workspace_a: PathBuf,
    workspace_b: PathBuf,
    session_root: PathBuf,
    runtime_root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().expect("session fixture");
        let session_root = temp.path().join("login-browser");
        let runtime_root = temp.path().join("runtime");
        let workspace_a = temp.path().join("workspace-a");
        let workspace_b = temp.path().join("workspace-b");
        fs::create_dir_all(&workspace_a).expect("workspace a");
        fs::create_dir_all(&workspace_b).expect("workspace b");
        let state = Arc::new(Mutex::new(FakeSupervisorState::default()));
        let manager = Arc::new(manager(&session_root, &runtime_root, Arc::clone(&state)));
        Self {
            _temp: temp,
            manager,
            state,
            workspace_a,
            workspace_b,
            session_root,
            runtime_root,
        }
    }

    fn trusted(path: &Path) -> TrustedWorkspacePath {
        TrustedWorkspacePath::from_trusted_app(path.to_path_buf()).expect("trusted workspace")
    }
}

fn manager(
    session_root: &Path,
    runtime_root: &Path,
    state: Arc<Mutex<FakeSupervisorState>>,
) -> LoginBrowserSessionManager {
    let workspace_identities =
        WorkspaceIdentityStore::new(session_root.join("workspaces")).expect("workspace store");
    let profiles =
        BrowserProfileManager::new(session_root.join("profile-state")).expect("profiles");
    let runtime_paths = RuntimePaths::under(runtime_root.to_path_buf()).expect("runtime paths");
    LoginBrowserSessionManager::from_parts(
        session_root.to_path_buf(),
        workspace_identities,
        profiles,
        ActivationStore::new(runtime_paths),
        Arc::new(FakeSupervisor { state }),
    )
    .expect("session manager")
}

#[test]
fn two_workspaces_are_isolated_and_explicit_new_profile_does_not_reuse_default() {
    let fixture = Fixture::new();
    assert_eq!(fixture.state.lock().unwrap().reap_count, 1);
    let first = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("workspace a default");
    let second = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_b))
        .expect("workspace b default");
    let explicit = fixture
        .manager
        .open_new_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("workspace a explicit profile");

    assert_ne!(first.snapshot.workspace_id, second.snapshot.workspace_id);
    assert_ne!(first.snapshot.profile_id, second.snapshot.profile_id);
    assert_eq!(first.snapshot.workspace_id, explicit.snapshot.workspace_id);
    assert_ne!(first.snapshot.profile_id, explicit.snapshot.profile_id);

    fixture.manager.close(&explicit.handle).unwrap();
    fixture.manager.close(&second.handle).unwrap();
    fixture.manager.close(&first.handle).unwrap();
    let reopened = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("reopen established default");
    assert_eq!(reopened.snapshot.profile_id, first.snapshot.profile_id);
    fixture.manager.close(&reopened.handle).unwrap();
}

#[test]
fn same_workspace_reuses_stable_identity_and_default_profile_after_restart() {
    let fixture = Fixture::new();
    let first = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("first open");
    let expected_workspace = first.snapshot.workspace_id.clone();
    let expected_profile = first.snapshot.profile_id.clone();
    fixture.manager.close(&first.handle).expect("first close");

    let state = Arc::new(Mutex::new(FakeSupervisorState::default()));
    let restarted = manager(&fixture.session_root, &fixture.runtime_root, state);
    let second = restarted
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("open after restart");
    assert_eq!(second.snapshot.workspace_id, expected_workspace);
    assert_eq!(second.snapshot.profile_id, expected_profile);
    restarted.close(&second.handle).expect("second close");
}

#[test]
fn concurrent_default_open_allows_one_lease_and_rejects_the_same_profile_twice() {
    let fixture = Fixture::new();
    let barrier = Arc::new(Barrier::new(3));
    let mut workers = Vec::new();
    for _ in 0..2 {
        let manager = Arc::clone(&fixture.manager);
        let workspace = fixture.workspace_a.clone();
        let barrier = Arc::clone(&barrier);
        workers.push(thread::spawn(move || {
            barrier.wait();
            manager.open_default_profile(Fixture::trusted(&workspace))
        }));
    }
    barrier.wait();
    let results = workers
        .into_iter()
        .map(|worker| worker.join().expect("open worker"))
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(SessionManagerError::ProfileInUse)))
            .count(),
        1
    );
    let opened = results.into_iter().find_map(Result::ok).unwrap();
    fixture.manager.close(&opened.handle).expect("close winner");
}

#[test]
fn close_and_force_stop_remove_only_after_cleanup_and_release_the_profile() {
    let fixture = Fixture::new();
    let first = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("open for close");
    let profile = ProfileId::parse(&first.snapshot.profile_id).unwrap();
    let workspace =
        TrustedWorkspaceIdentity::from_trusted_store(first.snapshot.workspace_id.clone()).unwrap();
    fixture.manager.close(&first.handle).expect("close");
    assert!(matches!(
        fixture.manager.snapshot(&first.handle),
        Err(SessionManagerError::SessionNotFound)
    ));
    assert!(matches!(
        fixture
            .manager
            .profiles
            .descriptor(&profile, &workspace)
            .unwrap()
            .cleanup_state(),
        ProfileCleanupState::Stopped
    ));

    let second = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("open for force");
    fixture
        .manager
        .force_stop(&second.handle)
        .expect("force stop");
    let state = fixture.state.lock().unwrap();
    assert_eq!(state.close_count, 1);
    assert_eq!(state.force_count, 1);
}

#[test]
fn failed_close_keeps_a_truthful_cleanup_required_session() {
    let fixture = Fixture::new();
    let opened = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("open");
    fixture.state.lock().unwrap().fail_close = true;
    assert_eq!(
        fixture.manager.close(&opened.handle).unwrap_err(),
        SessionManagerError::RuntimeUnavailable
    );
    let snapshot = fixture.manager.snapshot(&opened.handle).unwrap();
    assert_eq!(snapshot.status, LoginBrowserSessionStatus::CleanupRequired);
    assert_eq!(snapshot.control, SessionControlOwner::Paused);
    fixture
        .manager
        .force_stop(&opened.handle)
        .expect("cleanup-required session remains force-stoppable");
    assert!(matches!(
        fixture.manager.snapshot(&opened.handle),
        Err(SessionManagerError::SessionNotFound)
    ));
}

#[test]
fn snapshot_is_an_exact_opaque_projection_without_paths_pids_or_handles() {
    let fixture = Fixture::new();
    let opened = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("open");
    let origin = NormalizedOrigin::parse("https://Example.com/account?token=secret").unwrap();
    fixture
        .manager
        .update_current_origin(&opened.handle, Some(&origin))
        .unwrap();
    let snapshot = fixture.manager.snapshot(&opened.handle).unwrap();
    let value = serde_json::to_value(&snapshot).unwrap();
    let object = value.as_object().unwrap();
    let mut keys = object.keys().cloned().collect::<Vec<_>>();
    keys.sort();
    assert_eq!(
        keys,
        vec![
            "control",
            "current_origin",
            "handoff_epoch",
            "profile_id",
            "runtime_version",
            "session_id",
            "status",
            "workspace_id",
        ]
    );
    let serialized = serde_json::to_string(&snapshot).unwrap();
    assert!(!serialized.contains(fixture._temp.path().to_string_lossy().as_ref()));
    for forbidden in ["pid", "cdp", "handle", "pipe", "user-data", "secret"] {
        assert!(!serialized.to_ascii_lowercase().contains(forbidden));
    }
    assert_eq!(
        snapshot.current_origin.as_deref(),
        Some("https://example.com:443")
    );
    fixture.manager.close(&opened.handle).unwrap();
}

#[test]
fn trusted_capabilities_are_not_deserializable_and_backend_handles_never_enter_snapshots() {
    trait AmbiguousIfDeserialize<Marker> {
        fn marker() {}
    }
    struct WouldBeDeserializable;
    impl<T: ?Sized> AmbiguousIfDeserialize<()> for T {}
    impl<T: ?Sized + serde::de::DeserializeOwned> AmbiguousIfDeserialize<WouldBeDeserializable> for T {}
    let _ = <TrustedUiControlAuthorization as AmbiguousIfDeserialize<_>>::marker;
    let _ = <SessionAgentGrant as AmbiguousIfDeserialize<_>>::marker;
    let _ = <TrustedWorkspacePath as AmbiguousIfDeserialize<_>>::marker;

    let fixture = Fixture::new();
    let opened = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("open");
    let serialized = serde_json::to_string(&fixture.manager.snapshot(&opened.handle).unwrap())
        .expect("serialize opaque projection");
    for forbidden in ["cdp", "pipe", "target", "process", "pid", "handle"] {
        assert!(!serialized.to_ascii_lowercase().contains(forbidden));
    }
    fixture.manager.close(&opened.handle).unwrap();
}

#[test]
fn production_missing_active_runtime_releases_the_unlaunched_profile_lease() {
    let temp = tempfile::tempdir().expect("production manager fixture");
    let workspace = temp.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let runtime_paths = RuntimePaths::under(temp.path().join("empty-runtime")).unwrap();
    let manager = LoginBrowserSessionManager::production(
        temp.path().join("login-browser"),
        ActivationStore::new(runtime_paths),
    )
    .expect("production session manager");

    for _ in 0..2 {
        assert!(matches!(
            manager.open_default_profile(Fixture::trusted(&workspace)),
            Err(SessionManagerError::NoActiveRuntime)
        ));
    }
}

#[test]
#[ignore = "requires an exact activated Mode 2 runtime and opens a headed browser"]
fn exact_activated_runtime_opens_and_closes_full_production_session() {
    let runtime_root = std::env::var_os("CCEM_MODE2_RUNTIME_TEST_ROOT")
        .map(std::path::PathBuf::from)
        .expect("CCEM_MODE2_RUNTIME_TEST_ROOT must point at an activated browser data root");
    let temp = tempfile::tempdir().expect("production Login Browser fixture");
    let workspace = temp.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let runtime_paths = RuntimePaths::under(runtime_root.join("runtime"))
        .expect("activated runtime paths");
    let activation_store = ActivationStore::new(runtime_paths);
    let expected_runtime_version = activation_store
        .load_pointer()
        .expect("valid activated runtime pointer")
        .expect("active runtime pointer")
        .active
        .version;
    let manager = LoginBrowserSessionManager::production(
        temp.path().join("login-browser"),
        activation_store,
    )
    .expect("production session manager");

    let opened = manager
        .open_default_profile(Fixture::trusted(&workspace))
        .expect("full production session opens");
    assert_eq!(opened.snapshot.runtime_version, expected_runtime_version);
    assert_eq!(opened.snapshot.status, LoginBrowserSessionStatus::Running);
    assert_eq!(opened.snapshot.control, SessionControlOwner::User);
    manager
        .close(&opened.handle)
        .expect("full production session closes with ownership proof");
    assert!(manager.list_snapshots().unwrap().is_empty());
}

#[test]
fn default_profile_maintenance_requires_confirmation_and_preserves_state_on_rejection() {
    let fixture = Fixture::new();
    assert_eq!(
        fixture
            .manager
            .default_profile_summary(Fixture::trusted(&fixture.workspace_a))
            .expect("empty default profile summary"),
        None
    );

    let opened = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("create default profile");
    fixture.manager.close(&opened.handle).expect("stop profile");
    let before = fixture
        .manager
        .default_profile_summary(Fixture::trusted(&fixture.workspace_a))
        .expect("default profile summary")
        .expect("default profile exists");
    assert_eq!(before.profile_id, opened.snapshot.profile_id);
    assert!(before.last_used_at.is_some());
    let projected = serde_json::to_value(&before).expect("serialize maintenance summary");
    let mut keys = projected
        .as_object()
        .expect("maintenance summary object")
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    keys.sort();
    assert_eq!(keys, vec!["is_default", "last_used_at", "profile_id"]);
    assert!(!projected
        .to_string()
        .contains(fixture._temp.path().to_string_lossy().as_ref()));

    assert_eq!(
        fixture
            .manager
            .reset_default_profile(
                Fixture::trusted(&fixture.workspace_a),
                &before.profile_id,
                false,
            )
            .unwrap_err(),
        SessionManagerError::DestructiveConfirmationRequired
    );
    assert_eq!(
        fixture
            .manager
            .delete_default_profile(
                Fixture::trusted(&fixture.workspace_a),
                &before.profile_id,
                false,
            )
            .unwrap_err(),
        SessionManagerError::DestructiveConfirmationRequired
    );
    assert_eq!(
        fixture
            .manager
            .default_profile_summary(Fixture::trusted(&fixture.workspace_a))
            .unwrap(),
        Some(before)
    );
}

#[test]
fn default_profile_reset_and_delete_are_bound_to_the_canonical_workspace_default() {
    let fixture = Fixture::new();
    let opened = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("create default profile");
    fixture.manager.close(&opened.handle).expect("stop profile");

    let profile_id = ProfileId::parse(&opened.snapshot.profile_id).expect("profile id");
    let profile_dir = fixture
        .manager
        .profiles
        .root()
        .join("profiles")
        .join(profile_id.as_str());
    let marker = profile_dir.join("user-data").join("login-cookie-marker");
    fs::write(&marker, b"private login state").expect("write profile marker");

    let reset = fixture
        .manager
        .reset_default_profile(
            Fixture::trusted(&fixture.workspace_a),
            &opened.snapshot.profile_id,
            true,
        )
        .expect("reset default profile");
    assert_eq!(reset.profile_id, opened.snapshot.profile_id);
    assert_eq!(reset.last_used_at, None);
    assert!(!marker.exists());

    fixture
        .manager
        .delete_default_profile(
            Fixture::trusted(&fixture.workspace_a),
            &opened.snapshot.profile_id,
            true,
        )
        .expect("delete default profile");
    assert_eq!(
        fixture
            .manager
            .default_profile_summary(Fixture::trusted(&fixture.workspace_a))
            .unwrap(),
        None
    );
    assert!(!profile_dir.exists());
}

#[test]
fn active_and_cleanup_required_profiles_reject_maintenance_without_profile_effects() {
    let fixture = Fixture::new();
    let opened = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("open active profile");
    let active_summary = fixture
        .manager
        .default_profile_summary(Fixture::trusted(&fixture.workspace_a))
        .unwrap()
        .expect("active default profile");
    let profile_id = ProfileId::parse(&opened.snapshot.profile_id).expect("active profile id");
    let workspace_identity =
        TrustedWorkspaceIdentity::from_trusted_store(opened.snapshot.workspace_id.clone())
            .expect("active workspace identity");
    let active_descriptor = fixture
        .manager
        .profiles
        .descriptor(&profile_id, &workspace_identity)
        .expect("active profile descriptor");

    assert_eq!(
        fixture
            .manager
            .reset_default_profile(
                Fixture::trusted(&fixture.workspace_a),
                &active_summary.profile_id,
                true,
            )
            .unwrap_err(),
        SessionManagerError::ProfileInUse
    );
    assert_eq!(
        fixture
            .manager
            .delete_default_profile(
                Fixture::trusted(&fixture.workspace_a),
                &active_summary.profile_id,
                true,
            )
            .unwrap_err(),
        SessionManagerError::ProfileInUse
    );
    assert_eq!(
        fixture
            .manager
            .default_profile_summary(Fixture::trusted(&fixture.workspace_a))
            .unwrap(),
        Some(active_summary.clone())
    );
    assert_eq!(
        fixture
            .manager
            .profiles
            .descriptor(&profile_id, &workspace_identity)
            .unwrap(),
        active_descriptor
    );

    fixture.state.lock().unwrap().fail_close = true;
    assert_eq!(
        fixture.manager.close(&opened.handle).unwrap_err(),
        SessionManagerError::RuntimeUnavailable
    );
    assert_eq!(
        fixture.manager.snapshot(&opened.handle).unwrap().status,
        LoginBrowserSessionStatus::CleanupRequired
    );
    let cleanup_descriptor = fixture
        .manager
        .profiles
        .descriptor(&profile_id, &workspace_identity)
        .expect("cleanup-required profile descriptor");
    assert_eq!(
        fixture
            .manager
            .reset_default_profile(
                Fixture::trusted(&fixture.workspace_a),
                &active_summary.profile_id,
                true,
            )
            .unwrap_err(),
        SessionManagerError::ProfileInUse
    );
    assert_eq!(
        fixture
            .manager
            .delete_default_profile(
                Fixture::trusted(&fixture.workspace_a),
                &active_summary.profile_id,
                true,
            )
            .unwrap_err(),
        SessionManagerError::ProfileInUse
    );
    assert_eq!(
        fixture
            .manager
            .default_profile_summary(Fixture::trusted(&fixture.workspace_a))
            .unwrap(),
        Some(active_summary)
    );
    assert_eq!(
        fixture
            .manager
            .profiles
            .descriptor(&profile_id, &workspace_identity)
            .unwrap(),
        cleanup_descriptor
    );

    fixture.state.lock().unwrap().fail_close = false;
    fixture
        .manager
        .force_stop(&opened.handle)
        .expect("clean up fixture session");
}

#[cfg(unix)]
#[test]
fn workspace_aliases_resolve_to_the_same_default_profile_before_authorization_is_minted() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new();
    let workspace_alias = fixture._temp.path().join("workspace-alias");
    symlink(&fixture.workspace_a, &workspace_alias).expect("workspace alias");
    let opened = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("create canonical default");
    fixture.manager.close(&opened.handle).expect("stop profile");

    let reset = fixture
        .manager
        .reset_default_profile(
            Fixture::trusted(&workspace_alias),
            &opened.snapshot.profile_id,
            true,
        )
        .expect("reset through canonical alias");
    assert_eq!(reset.profile_id, opened.snapshot.profile_id);
}

#[test]
fn stale_profile_confirmation_cannot_target_a_newly_promoted_default() {
    let fixture = Fixture::new();
    let first = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("create first default");
    fixture.manager.close(&first.handle).expect("stop first");
    let second = fixture
        .manager
        .open_new_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("create next profile");
    fixture.manager.close(&second.handle).expect("stop second");

    fixture
        .manager
        .delete_default_profile(
            Fixture::trusted(&fixture.workspace_a),
            &first.snapshot.profile_id,
            true,
        )
        .expect("delete the profile that was actually confirmed");
    let promoted = fixture
        .manager
        .default_profile_summary(Fixture::trusted(&fixture.workspace_a))
        .unwrap()
        .expect("second profile promoted");
    assert_eq!(promoted.profile_id, second.snapshot.profile_id);
    let promoted_id = ProfileId::parse(&promoted.profile_id).unwrap();
    let workspace = TrustedWorkspaceIdentity::from_trusted_store(second.snapshot.workspace_id)
        .expect("workspace identity");
    let before = fixture
        .manager
        .profiles
        .descriptor(&promoted_id, &workspace)
        .unwrap();

    for result in [
        fixture.manager.reset_default_profile(
            Fixture::trusted(&fixture.workspace_a),
            &first.snapshot.profile_id,
            true,
        ),
        fixture
            .manager
            .delete_default_profile(
                Fixture::trusted(&fixture.workspace_a),
                &first.snapshot.profile_id,
                true,
            )
            .map(|_| promoted.clone()),
    ] {
        assert_eq!(result.unwrap_err(), SessionManagerError::ProfileChanged);
    }
    assert_eq!(
        fixture
            .manager
            .profiles
            .descriptor(&promoted_id, &workspace)
            .unwrap(),
        before
    );
}

#[path = "session_profile_inventory_tests.rs"]
mod profile_inventory_tests;

#[path = "session_provenance_tests.rs"]
mod provenance_integration_tests;
