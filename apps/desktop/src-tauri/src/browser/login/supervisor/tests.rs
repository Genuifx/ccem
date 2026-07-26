use super::model::{
    LaunchedRuntime, OwnershipDomain, OwnershipGuard, PlatformLaunchRequest, PrivateCdpTransport,
    ProcessIdentity, ProcessInspector, RuntimeLauncher, RuntimeMetadata, TransportKind,
    SUPERVISOR_SCHEMA_VERSION,
};
use super::*;
use crate::browser::login::profile::{
    BrowserProfileDescriptor, BrowserProfileManager, ProfileCleanupState,
};
use crate::browser::runtime::identity::{PlatformIdentityEvidence, VerifiedRuntimeIdentity};
use crate::browser::runtime::manifest::{
    RuntimeArchitecture, RuntimeArchiveFormat, RuntimeArchiveIdentity, RuntimeArtifact,
    RuntimeExecutableIdentity, RuntimeLayout, RuntimeManifest, RuntimePlatform,
    RuntimeProductIdentity, VerifiedRuntimeManifest,
};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::io::{Cursor, Write};
use std::sync::{Arc, Mutex};

struct FakeState {
    processes: HashMap<u32, ProcessIdentity>,
    domain_alive: bool,
    disappear_on_terminate: bool,
    domain_gone_after_reap: bool,
    terminate_count: usize,
    leader_reap_count: usize,
    launched_arguments: Vec<OsString>,
    browser_pid: u32,
    browser_birth_token: String,
}

impl FakeState {
    fn new(controller: ProcessIdentity) -> Self {
        Self {
            processes: HashMap::from([(controller.pid, controller)]),
            domain_alive: false,
            disappear_on_terminate: true,
            domain_gone_after_reap: false,
            terminate_count: 0,
            leader_reap_count: 0,
            launched_arguments: Vec::new(),
            browser_pid: 42_424,
            browser_birth_token: "fake-browser:1".to_string(),
        }
    }
}

#[derive(Clone)]
struct FakeInspector {
    state: Arc<Mutex<FakeState>>,
}

impl ProcessInspector for FakeInspector {
    fn inspect_process(&self, pid: u32) -> Result<Option<ProcessIdentity>, SupervisorError> {
        Ok(self.state.lock().unwrap().processes.get(&pid).cloned())
    }

    fn ownership_domain_alive(
        &self,
        _ownership_domain: &OwnershipDomain,
    ) -> Result<bool, SupervisorError> {
        Ok(self.state.lock().unwrap().domain_alive)
    }

    fn terminate_ownership_domain(
        &self,
        _ownership_domain: &OwnershipDomain,
    ) -> Result<(), SupervisorError> {
        let mut state = self.state.lock().unwrap();
        state.terminate_count += 1;
        if state.disappear_on_terminate {
            state.domain_alive = false;
        }
        Ok(())
    }
}

#[derive(Clone)]
struct FakeLauncher {
    state: Arc<Mutex<FakeState>>,
}

impl RuntimeLauncher for FakeLauncher {
    fn launch(&self, request: PlatformLaunchRequest) -> Result<LaunchedRuntime, SupervisorError> {
        let mut state = self.state.lock().unwrap();
        let identity = ProcessIdentity {
            pid: state.browser_pid,
            birth_token: state.browser_birth_token.clone(),
            executable: request.executable.executable().to_path_buf(),
        };
        state.processes.insert(identity.pid, identity.clone());
        state.domain_alive = true;
        state.launched_arguments = request.arguments;
        Ok(LaunchedRuntime {
            identity: identity.clone(),
            ownership_domain: OwnershipDomain::UnixProcessGroup {
                pgid: identity.pid as i32,
            },
            transport_kind: TransportKind::UnixPrivateFd3Fd4,
            transport: PrivateCdpTransport::new(
                Cursor::new(Vec::<u8>::new()),
                Cursor::new(Vec::<u8>::new()),
            ),
            guard: Box::new(FakeGuard {
                state: Arc::clone(&self.state),
            }),
        })
    }
}

struct FakeGuard {
    state: Arc<Mutex<FakeState>>,
}

impl OwnershipGuard for FakeGuard {
    fn reap_leader_if_exited(&mut self) {
        let mut state = self.state.lock().unwrap();
        state.leader_reap_count += 1;
        if state.domain_gone_after_reap {
            state.domain_alive = false;
        }
    }
}

struct Fixture {
    _temp: tempfile::TempDir,
    profiles: BrowserProfileManager,
    workspace: TrustedWorkspaceIdentity,
    profile: BrowserProfileDescriptor,
    runtime: VerifiedRuntimeExecutable,
    supervisor: LoginSupervisor,
    state: Arc<Mutex<FakeState>>,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().expect("temporary supervisor fixture");
        let profiles =
            BrowserProfileManager::new(temp.path().join("profiles-root"), temp.path().join("cef"))
                .expect("profile manager");
        let workspace = TrustedWorkspaceIdentity::from_trusted_store("workspace-supervisor-001")
            .expect("workspace identity");
        let profile = profiles.create_profile(&workspace).expect("profile");

        let executable = temp.path().join("verified-browser");
        fs::write(&executable, b"verified browser fixture").expect("runtime fixture");
        let executable = executable.canonicalize().expect("canonical runtime");
        let executable_sha256 = hex::encode(Sha256::digest(b"verified browser fixture"));
        let runtime =
            VerifiedRuntimeExecutable::for_test(executable, executable_sha256, "150.0.7871.115");

        let controller = ProcessIdentity {
            pid: std::process::id(),
            birth_token: "fake-controller:current".to_string(),
            executable: std::env::current_exe()
                .expect("test executable")
                .canonicalize()
                .expect("canonical test executable"),
        };
        let state = Arc::new(Mutex::new(FakeState::new(controller)));
        let inspector = Arc::new(FakeInspector {
            state: Arc::clone(&state),
        });
        let launcher = Arc::new(FakeLauncher {
            state: Arc::clone(&state),
        });
        let supervisor = LoginSupervisor::from_parts(
            temp.path().join("supervisor"),
            inspector,
            launcher,
            Duration::from_millis(1),
            Duration::from_millis(1),
        )
        .expect("supervisor");
        Self {
            _temp: temp,
            profiles,
            workspace,
            profile,
            runtime,
            supervisor,
            state,
        }
    }

    fn lease(&self) -> BrowserProfileLease {
        self.profiles
            .acquire_launch_lease(self.profile.profile_id(), &self.workspace)
            .expect("profile lease")
    }

    fn runtime_spec(&self) -> LoginRuntimeSpec {
        LoginRuntimeSpec::new(self.runtime.clone(), "1.3").expect("runtime spec")
    }

    fn assert_profile_stopped(&self) {
        let descriptor = self
            .profiles
            .descriptor(self.profile.profile_id(), &self.workspace)
            .expect("profile descriptor");
        assert!(matches!(
            descriptor.cleanup_state(),
            ProfileCleanupState::Stopped
        ));
    }

    fn seed_stale_metadata(
        &self,
        browser: ProcessIdentity,
        old_controller: ProcessIdentity,
    ) -> String {
        let mut lease = self.lease();
        let ownership_id = lease.ownership_id().to_string();
        let runtime_id = "runtime-stale-001".to_string();
        lease
            .mark_runtime_owned(&runtime_id, self.runtime.runtime_version(), "1.3")
            .expect("mark runtime owned");
        drop(lease);
        let now = Utc::now().to_rfc3339();
        self.supervisor
            .metadata_store
            .write_new(&RuntimeMetadata {
                schema_version: SUPERVISOR_SCHEMA_VERSION,
                revision: 1,
                runtime_id: runtime_id.clone(),
                ownership_id,
                controller_instance_id: "controller-stale-001".to_string(),
                controller: old_controller,
                browser: browser.clone(),
                ownership_domain: OwnershipDomain::UnixProcessGroup {
                    pgid: browser.pid as i32,
                },
                executable_sha256: self.runtime.executable_sha256().to_string(),
                manifest_sha256: self.runtime.manifest_sha256().to_string(),
                runtime_version: self.runtime.runtime_version().to_string(),
                protocol_version: "1.3".to_string(),
                profile_id: self.profile.profile_id().as_str().to_string(),
                workspace_identity: self.workspace.as_str().to_string(),
                user_data_dir: self
                    .profiles
                    .root()
                    .join("profiles")
                    .join(self.profile.profile_id().as_str())
                    .join("user-data"),
                transport: TransportKind::UnixPrivateFd3Fd4,
                cleanup_state: CleanupState::Running,
                created_at: now.clone(),
                updated_at: now,
            })
            .expect("stale metadata");
        runtime_id
    }
}

#[test]
fn headed_launch_rebuilds_the_exact_minimal_allowlist_and_closes_normally() {
    let fixture = Fixture::new();
    let runtime = fixture
        .supervisor
        .launch(fixture.lease(), fixture.runtime_spec())
        .expect("launch managed runtime");
    let runtime_id = runtime.runtime_id().to_string();
    let arguments = fixture
        .state
        .lock()
        .unwrap()
        .launched_arguments
        .iter()
        .map(|value| value.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(arguments.len(), 7);
    assert_eq!(arguments[0], "--remote-debugging-pipe");
    assert!(arguments[1].starts_with("--user-data-dir="));
    assert!(arguments[2].starts_with("--ccem-managed-runtime-id=runtime-"));
    assert_eq!(arguments[3], "--no-first-run");
    assert_eq!(arguments[4], "--no-default-browser-check");
    assert_eq!(arguments[5], "--disable-component-update");
    assert_eq!(arguments[6], "about:blank");
    for denied in [
        "headless",
        "no-startup-window",
        "use-mock-keychain",
        "password-store=basic",
        "disable-ipc-flooding",
    ] {
        assert!(!arguments.iter().any(|argument| argument.contains(denied)));
    }

    fixture.state.lock().unwrap().domain_alive = false;
    runtime.close().expect("normal close");
    fixture.assert_profile_stopped();
    assert!(fixture
        .supervisor
        .metadata_store
        .load(&runtime_id)
        .unwrap()
        .is_none());
}

#[test]
fn force_stop_targets_the_verified_domain_and_releases_the_profile_after_gone() {
    let fixture = Fixture::new();
    let runtime = fixture
        .supervisor
        .launch(fixture.lease(), fixture.runtime_spec())
        .expect("launch managed runtime");
    runtime.force_stop().expect("force stop");
    assert_eq!(fixture.state.lock().unwrap().terminate_count, 1);
    fixture.assert_profile_stopped();
}

#[test]
fn emergency_stop_requests_the_verified_domain_without_waiting_for_disappearance() {
    let fixture = Fixture::new();
    let runtime = fixture
        .supervisor
        .launch(fixture.lease(), fixture.runtime_spec())
        .expect("launch managed runtime");
    let termination = runtime.verified_termination_handle();
    {
        let mut state = fixture.state.lock().unwrap();
        state.disappear_on_terminate = false;
    }
    let started = std::time::Instant::now();

    termination
        .request_force_verified_domain()
        .expect("identity-bound termination request");

    assert!(started.elapsed() < Duration::from_millis(250));
    {
        let mut state = fixture.state.lock().unwrap();
        assert_eq!(state.terminate_count, 1);
        assert!(
            state.domain_alive,
            "this seam must not wait for disappearance"
        );
        state.domain_alive = false;
    }
    drop(runtime);
    fixture.assert_profile_stopped();
}

#[test]
fn force_stop_reaps_the_unix_leader_before_claiming_the_process_group_is_gone() {
    let fixture = Fixture::new();
    let runtime = fixture
        .supervisor
        .launch(fixture.lease(), fixture.runtime_spec())
        .expect("launch managed runtime");
    {
        let mut state = fixture.state.lock().unwrap();
        state.disappear_on_terminate = false;
        state.domain_gone_after_reap = true;
    }
    runtime.force_stop().expect("force stop and reap leader");
    let state = fixture.state.lock().unwrap();
    assert_eq!(state.terminate_count, 1);
    assert!(state.leader_reap_count > 0);
    drop(state);
    fixture.assert_profile_stopped();
}

#[cfg(unix)]
#[test]
fn stale_reaper_terminates_owned_children_when_the_unix_leader_is_dead() {
    let fixture = Fixture::new();
    let (browser, old_controller) = stale_identities(&fixture);
    let runtime_id = fixture.seed_stale_metadata(browser.clone(), old_controller);
    {
        let mut state = fixture.state.lock().unwrap();
        state.processes.remove(&browser.pid);
        state.domain_alive = true;
    }

    let result = fixture
        .supervisor
        .reap_stale(&fixture.profiles)
        .expect("stale reap");
    assert_eq!(
        result,
        vec![StaleReapRecord {
            runtime_id: runtime_id.clone(),
            disposition: StaleReapDisposition::ReapedTerminatedDomain,
        }]
    );
    assert_eq!(fixture.state.lock().unwrap().terminate_count, 1);
    fixture.assert_profile_stopped();
    assert!(fixture
        .supervisor
        .metadata_store
        .load(&runtime_id)
        .unwrap()
        .is_none());
}

#[cfg(unix)]
#[test]
fn force_stop_terminates_owned_children_after_the_unix_leader_exits() {
    let fixture = Fixture::new();
    let runtime = fixture
        .supervisor
        .launch(fixture.lease(), fixture.runtime_spec())
        .expect("launch managed runtime");
    {
        let mut state = fixture.state.lock().unwrap();
        let browser_pid = state.browser_pid;
        state.processes.remove(&browser_pid);
        state.domain_alive = true;
    }

    runtime
        .force_stop()
        .expect("terminate the exact orphaned Unix process group");

    assert_eq!(fixture.state.lock().unwrap().terminate_count, 1);
    fixture.assert_profile_stopped();
}

#[cfg(unix)]
#[test]
fn orphan_cleanup_timeout_retains_metadata_and_requires_profile_recovery() {
    let fixture = Fixture::new();
    let runtime = fixture
        .supervisor
        .launch(fixture.lease(), fixture.runtime_spec())
        .expect("launch managed runtime");
    let runtime_id = runtime.runtime_id().to_string();
    {
        let mut state = fixture.state.lock().unwrap();
        let browser_pid = state.browser_pid;
        state.processes.remove(&browser_pid);
        state.domain_alive = true;
        state.disappear_on_terminate = false;
    }

    let error = runtime.force_stop().unwrap_err();

    assert!(matches!(error, SupervisorError::CleanupTimedOut));
    assert!(fixture.state.lock().unwrap().terminate_count >= 1);
    assert!(fixture
        .supervisor
        .metadata_store
        .load(&runtime_id)
        .unwrap()
        .is_some());
    assert!(matches!(
        fixture
            .profiles
            .acquire_launch_lease(fixture.profile.profile_id(), &fixture.workspace),
        Err(crate::browser::login::profile::ProfileError::ProfileRequiresCleanup)
    ));
}

#[test]
fn pid_reuse_or_forged_identity_fails_closed_without_killing_the_sentinel() {
    let fixture = Fixture::new();
    let (browser, old_controller) = stale_identities(&fixture);
    let runtime_id = fixture.seed_stale_metadata(browser.clone(), old_controller);
    {
        let mut state = fixture.state.lock().unwrap();
        state.processes.insert(
            browser.pid,
            ProcessIdentity {
                pid: browser.pid,
                birth_token: "fake-browser:reused".to_string(),
                executable: browser.executable.clone(),
            },
        );
        state.domain_alive = true;
    }

    let result = fixture
        .supervisor
        .reap_stale(&fixture.profiles)
        .expect("stale reap");
    assert_eq!(
        result[0].disposition,
        StaleReapDisposition::RetainedBrowserIdentityMismatch
    );
    assert_eq!(fixture.state.lock().unwrap().terminate_count, 0);
    assert!(fixture
        .supervisor
        .metadata_store
        .load(&runtime_id)
        .unwrap()
        .is_some());
}

#[test]
fn controller_crash_reaps_an_exact_leader_and_recovers_the_profile() {
    let fixture = Fixture::new();
    let (browser, old_controller) = stale_identities(&fixture);
    let runtime_id = fixture.seed_stale_metadata(browser.clone(), old_controller);
    {
        let mut state = fixture.state.lock().unwrap();
        state.processes.insert(browser.pid, browser);
        state.domain_alive = true;
    }

    let result = fixture
        .supervisor
        .reap_stale(&fixture.profiles)
        .expect("stale reap");
    assert_eq!(
        result,
        vec![StaleReapRecord {
            runtime_id: runtime_id.clone(),
            disposition: StaleReapDisposition::ReapedTerminatedDomain,
        }]
    );
    assert_eq!(fixture.state.lock().unwrap().terminate_count, 1);
    fixture.assert_profile_stopped();
    assert!(fixture
        .supervisor
        .metadata_store
        .load(&runtime_id)
        .unwrap()
        .is_none());
}

#[test]
fn stale_reaper_recovers_without_signalling_when_the_domain_is_already_gone() {
    let fixture = Fixture::new();
    let (browser, old_controller) = stale_identities(&fixture);
    let runtime_id = fixture.seed_stale_metadata(browser, old_controller);
    fixture.state.lock().unwrap().domain_alive = false;

    let result = fixture
        .supervisor
        .reap_stale(&fixture.profiles)
        .expect("stale reap");
    assert_eq!(
        result[0].disposition,
        StaleReapDisposition::ReapedDomainGone
    );
    assert_eq!(fixture.state.lock().unwrap().terminate_count, 0);
    fixture.assert_profile_stopped();
    assert!(fixture
        .supervisor
        .metadata_store
        .load(&runtime_id)
        .unwrap()
        .is_none());
}

#[test]
fn verified_candidate_is_bound_to_manifest_identity_and_current_file_bytes() {
    let temp = tempfile::tempdir().expect("candidate root");
    let candidate = temp.path().join("candidate");
    fs::create_dir(&candidate).expect("candidate directory");
    let executable = candidate.join("browser");
    let original = b"candidate-runtime";
    fs::write(&executable, original).expect("candidate executable");
    let digest = hex::encode(Sha256::digest(original));
    let manifest = candidate_manifest(original.len() as u64, digest.clone());
    let identity = VerifiedRuntimeIdentity {
        executable_path: executable.clone(),
        executable_size: original.len() as u64,
        executable_sha256: digest,
        platform_identity: PlatformIdentityEvidence {
            platform: RuntimePlatform::Macos,
            architectures: vec![RuntimeArchitecture::Aarch64],
            product_name: "Chromium for Testing".to_string(),
            product_version: "150.0.7871.115".to_string(),
            bundle_identifier: Some("org.chromium.Chromium".to_string()),
            publisher: None,
        },
    };

    let capability =
        VerifiedRuntimeExecutable::from_verified_candidate(&candidate, &manifest, &identity)
            .expect("verified candidate capability");
    assert_eq!(capability.runtime_version(), "150.0.7871.115");

    // Evidence is stale as soon as candidate bytes change, even when the replacement has the same
    // length and occupies the same trusted candidate path.
    fs::write(&executable, b"candidate-runtimf").expect("mutate candidate");
    assert!(matches!(
        VerifiedRuntimeExecutable::from_verified_candidate(&candidate, &manifest, &identity),
        Err(SupervisorError::ExecutableIdentityMismatch)
    ));
}

#[test]
fn a_bare_candidate_path_with_fabricated_identity_does_not_create_a_launch_capability() {
    let temp = tempfile::tempdir().expect("candidate root");
    let candidate = temp.path().join("candidate");
    fs::create_dir(&candidate).expect("candidate directory");
    let executable = candidate.join("browser");
    fs::write(&executable, b"candidate-runtime").expect("candidate executable");
    let manifest = candidate_manifest(
        b"candidate-runtime".len() as u64,
        hex::encode(Sha256::digest(b"candidate-runtime")),
    );
    let fabricated = VerifiedRuntimeIdentity {
        executable_path: executable,
        executable_size: b"candidate-runtime".len() as u64,
        executable_sha256: "00".repeat(32),
        platform_identity: PlatformIdentityEvidence {
            platform: RuntimePlatform::Macos,
            architectures: vec![RuntimeArchitecture::Aarch64],
            product_name: "Chromium for Testing".to_string(),
            product_version: "150.0.7871.115".to_string(),
            bundle_identifier: Some("org.chromium.Chromium".to_string()),
            publisher: None,
        },
    };
    assert!(matches!(
        VerifiedRuntimeExecutable::from_verified_candidate(&candidate, &manifest, &fabricated),
        Err(SupervisorError::ExecutableIdentityMismatch)
    ));
}

#[test]
fn private_transport_is_borrowed_not_transferred_and_is_not_serializable() {
    trait AmbiguousIfSerialize<Marker> {
        fn marker() {}
    }
    struct WouldBeSerializable;
    impl<T: ?Sized> AmbiguousIfSerialize<()> for T {}
    impl<T: ?Sized + serde::Serialize> AmbiguousIfSerialize<WouldBeSerializable> for T {}
    // This inference is unambiguous only while PrivateCdpTransport does not implement Serialize.
    let _ = <PrivateCdpTransport as AmbiguousIfSerialize<_>>::marker;

    let writes = Arc::new(Mutex::new(Vec::new()));
    let mut transport = PrivateCdpTransport::new(
        Cursor::new(Vec::<u8>::new()),
        SharedWriter(Arc::clone(&writes)),
    );
    transport.with_io(|_reader, writer| {
        writer.write_all(b"smoke-request\0").unwrap();
    });
    transport
        .request_browser_close()
        .expect("supervisor retains close pipe");
    let bytes = writes.lock().unwrap().clone();
    assert!(bytes.starts_with(b"smoke-request\0"));
    assert!(bytes.ends_with(b"{\"id\":1,\"method\":\"Browser.close\"}\0"));
}

fn candidate_manifest(byte_size: u64, sha256: String) -> VerifiedRuntimeManifest {
    VerifiedRuntimeManifest {
        manifest: RuntimeManifest {
            schema_version: 1,
            signing_key_id: "runtime-key-001".to_string(),
            sequence: 1,
            minimum_protocol_version: 1,
            artifact: RuntimeArtifact {
                platform: RuntimePlatform::Macos,
                architecture: RuntimeArchitecture::Aarch64,
                version: "150.0.7871.115".to_string(),
                minimum_os_version: "13.0".to_string(),
                source_url: "https://example.invalid/runtime.zip".to_string(),
                archive: RuntimeArchiveIdentity {
                    format: RuntimeArchiveFormat::Zip,
                    byte_size: 1,
                    sha256: "22".repeat(32),
                    max_entries: 100,
                    max_unpacked_bytes: 1024,
                    max_file_bytes: 1024,
                },
                layout: RuntimeLayout {
                    root_directory: "runtime".to_string(),
                    executable: RuntimeExecutableIdentity {
                        relative_path: "browser".to_string(),
                        byte_size,
                        sha256,
                    },
                    symlinks: Vec::new(),
                },
                product_identity: RuntimeProductIdentity {
                    product_name: "Chromium for Testing".to_string(),
                    product_version: "150.0.7871.115".to_string(),
                    bundle_identifier: Some("org.chromium.Chromium".to_string()),
                    publisher: None,
                },
            },
        },
        exact_bytes_sha256: "33".repeat(32),
    }
}

struct SharedWriter(Arc<Mutex<Vec<u8>>>);

impl Write for SharedWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn stale_identities(fixture: &Fixture) -> (ProcessIdentity, ProcessIdentity) {
    let state = fixture.state.lock().unwrap();
    let current_controller = state
        .processes
        .get(&std::process::id())
        .expect("current controller")
        .clone();
    (
        ProcessIdentity {
            pid: state.browser_pid,
            birth_token: state.browser_birth_token.clone(),
            executable: fixture.runtime.executable().to_path_buf(),
        },
        ProcessIdentity {
            pid: current_controller.pid,
            birth_token: "fake-controller:old".to_string(),
            executable: current_controller.executable,
        },
    )
}
