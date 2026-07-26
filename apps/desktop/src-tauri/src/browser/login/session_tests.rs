use super::*;
use crate::browser::login::backend::{
    ActionResult, BackendFailure, NavigationResult, SemanticBrowserBackend, SemanticBrowserCommand,
    SemanticBrowserResult,
};
#[cfg(target_os = "macos")]
use crate::browser::login::cef::recovery::{EmbeddedHostProcessIdentity, EmbeddedOwnerRecordStore};
use crate::browser::login::control::{ControlErrorCode, HandoffControl};
use crate::browser::login::profile::{OwnershipDomainGone, ProfileCleanupState};
use crate::browser::login::session_backend::{
    SessionBackendProjection, SessionBackendStartSpec, SessionLaunchRuntime, SessionOwnedBackend,
};
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
    force_attempt_count: usize,
    emergency_count: usize,
    fail_close: bool,
    fail_next_force_shutdown: bool,
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
            force_attempt_count: 0,
            emergency_count: 0,
            fail_close: false,
            fail_next_force_shutdown: false,
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
        if force {
            let mut state = runtime.state.lock().unwrap();
            state.force_attempt_count += 1;
            if state.fail_next_force_shutdown {
                state.fail_next_force_shutdown = false;
                return Err(SessionManagerError::RuntimeUnavailable);
            }
        }
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
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().expect("session fixture");
        let session_root = temp.path().join("login-browser");
        let workspace_a = temp.path().join("workspace-a");
        let workspace_b = temp.path().join("workspace-b");
        fs::create_dir_all(&workspace_a).expect("workspace a");
        fs::create_dir_all(&workspace_b).expect("workspace b");
        let state = Arc::new(Mutex::new(FakeSupervisorState::default()));
        let manager = Arc::new(manager(&session_root, Arc::clone(&state)));
        Self {
            _temp: temp,
            manager,
            state,
            workspace_a,
            workspace_b,
            session_root,
        }
    }

    fn trusted(path: &Path) -> TrustedWorkspacePath {
        TrustedWorkspacePath::from_trusted_app(path.to_path_buf()).expect("trusted workspace")
    }
}

fn manager(
    session_root: &Path,
    state: Arc<Mutex<FakeSupervisorState>>,
) -> LoginBrowserSessionManager {
    let workspace_identities =
        WorkspaceIdentityStore::new(session_root.join("workspaces")).expect("workspace store");
    let profiles =
        BrowserProfileManager::new(session_root.join("profile-state"), session_root.join("cef"))
            .expect("profiles");
    LoginBrowserSessionManager::from_parts(
        session_root.to_path_buf(),
        workspace_identities,
        profiles,
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
    let restarted = manager(&fixture.session_root, state);
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

#[cfg(target_os = "macos")]
#[test]
fn embedded_prepare_commits_recovery_intent_before_returning_launch_pending() {
    let fixture = Fixture::new();
    let store = EmbeddedOwnerRecordStore::for_test(
        fixture.session_root.join("embedded-owner-test"),
        "cef-host-33333333333333333333333333333333".to_string(),
        EmbeddedHostProcessIdentity {
            pid: 4242,
            birth_token: "mac:300:400".to_string(),
            executable: PathBuf::from("/Applications/CCEM Desktop.app/Contents/MacOS/ccem-desktop"),
        },
    )
    .expect("test embedded owner store");
    let prepared = fixture
        .manager
        .prepare_embedded_profile(
            Fixture::trusted(&fixture.workspace_a),
            ProfileSelection::Default,
            "login-session-contract",
            &store,
        )
        .expect("prepare embedded profile");
    let profile_id = prepared.profile_id().clone();
    let (registration, lease, mut owner_record) = prepared.into_launch_parts();

    assert_eq!(registration.profile_id, profile_id);
    assert!(matches!(
        lease.descriptor().cleanup_state(),
        ProfileCleanupState::LaunchPending { ownership_id, .. }
            if ownership_id == lease.ownership_id()
    ));
    let workspace = TrustedWorkspaceIdentity::from_trusted_store(
        lease.descriptor().workspace_identity().to_string(),
    )
    .expect("workspace identity");
    let (_, release_proof) = lease
        .cancel_pending_embedded_launch()
        .expect("cancel before native open");
    owner_record
        .finish_after_profile_release(release_proof)
        .expect("delete matching recovery intent");
    assert!(matches!(
        fixture
            .manager
            .profiles_for_test()
            .descriptor(&profile_id, &workspace)
            .expect("stopped descriptor")
            .cleanup_state(),
        ProfileCleanupState::Stopped
    ));
}

#[cfg(target_os = "macos")]
#[test]
fn embedded_prepare_failure_keeps_the_requested_profile_recovery_identity() {
    let fixture = Fixture::new();
    let profile_id = ProfileId::parse("profile-ffffffffffffffffffffffffffffffff")
        .expect("valid missing profile id");
    let workspace_identity = fixture
        .manager
        .available()
        .expect("session manager")
        .workspace_identities
        .resolve(&fixture.workspace_a)
        .expect("workspace identity");
    let store = EmbeddedOwnerRecordStore::for_test(
        fixture.session_root.join("embedded-owner-error-test"),
        "cef-host-44444444444444444444444444444444".to_string(),
        EmbeddedHostProcessIdentity {
            pid: 4343,
            birth_token: "mac:500:600".to_string(),
            executable: PathBuf::from("/Applications/CCEM Desktop.app/Contents/MacOS/ccem-desktop"),
        },
    )
    .expect("test embedded owner store");

    let error = match fixture.manager.prepare_embedded_profile(
        Fixture::trusted(&fixture.workspace_a),
        ProfileSelection::Existing(profile_id.clone()),
        "login-missing-profile",
        &store,
    ) {
        Ok(_) => panic!("missing selected profile must fail"),
        Err(error) => error,
    };
    assert_eq!(
        error.identity(),
        Some(&EmbeddedProfileIdentity::new(
            &profile_id,
            &workspace_identity
        ))
    );
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
            .profiles_for_test()
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
fn shutdown_all_force_closes_every_registered_session() {
    let fixture = Fixture::new();
    let first = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("open first session");
    let second = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_b))
        .expect("open second session");

    let report = fixture.manager.shutdown_all().expect("shutdown sweep");

    assert_eq!(report.attempted, 2);
    assert_eq!(report.closed, 2);
    assert!(report.failures.is_empty());
    assert!(matches!(
        fixture.manager.snapshot(&first.handle),
        Err(SessionManagerError::SessionNotFound)
    ));
    assert!(matches!(
        fixture.manager.snapshot(&second.handle),
        Err(SessionManagerError::SessionNotFound)
    ));
    let state = fixture.state.lock().unwrap();
    assert_eq!(state.force_attempt_count, 2);
    assert_eq!(state.force_count, 2);
}

#[test]
fn shutdown_all_continues_after_a_force_shutdown_failure() {
    let fixture = Fixture::new();
    let first = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("open first session");
    let second = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_b))
        .expect("open second session");
    fixture.state.lock().unwrap().fail_next_force_shutdown = true;

    let report = fixture.manager.shutdown_all().expect("shutdown sweep");

    assert_eq!(report.attempted, 2);
    assert_eq!(report.closed, 1);
    assert_eq!(report.failures.len(), 1);
    assert_eq!(
        report.failures[0].error,
        SessionManagerError::RuntimeUnavailable
    );
    assert_eq!(fixture.state.lock().unwrap().force_attempt_count, 2);

    let failed_handle = [&first.handle, &second.handle]
        .into_iter()
        .find(|handle| handle.as_str() == report.failures[0].session_id)
        .expect("failed session remains addressable");
    let successful_handle = [&first.handle, &second.handle]
        .into_iter()
        .find(|handle| handle.as_str() != report.failures[0].session_id)
        .expect("successful session handle");
    let failed_snapshot = fixture
        .manager
        .snapshot(failed_handle)
        .expect("failed session retained");
    assert_eq!(
        failed_snapshot.status,
        LoginBrowserSessionStatus::CleanupRequired
    );
    assert_eq!(failed_snapshot.control, SessionControlOwner::Paused);
    assert!(matches!(
        fixture.manager.snapshot(successful_handle),
        Err(SessionManagerError::SessionNotFound)
    ));

    let retry = fixture.manager.shutdown_all().expect("cleanup retry");
    assert_eq!(retry.attempted, 1);
    assert_eq!(retry.closed, 1);
    assert!(retry.failures.is_empty());
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

#[path = "session_profile_maintenance_tests.rs"]
mod profile_maintenance_tests;

#[path = "session_profile_inventory_tests.rs"]
mod profile_inventory_tests;

#[path = "session_provenance_tests.rs"]
mod provenance_integration_tests;
