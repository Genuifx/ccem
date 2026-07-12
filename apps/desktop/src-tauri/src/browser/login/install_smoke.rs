use super::profile::{
    BrowserProfileManager, DestructiveProfileAction, DestructiveProfileAuthorization,
    TrustedWorkspaceIdentity,
};
use super::supervisor::{
    LoginRuntimeSpec, LoginSupervisor, SupervisorError, VerifiedRuntimeExecutable,
};
use crate::browser::runtime::identity::VerifiedRuntimeIdentity;
use crate::browser::runtime::manifest::VerifiedRuntimeManifest;
use crate::browser::runtime::preparation::{InstallationSmokeRunner, RuntimePreparationFailure};
use crate::browser::runtime::smoke::{InstallationSmokeEvidence, PrivatePipeAdapter};
use crate::browser::runtime::state::RuntimeErrorCode;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

const INSTALL_SMOKE_WORKSPACE_ID: &str = "ccem:runtime-verification";
const LOGIN_PROTOCOL_VERSION: &str = "1";
const SMOKE_REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const DESTRUCTIVE_AUTHORIZATION_TTL: Duration = Duration::from_secs(2 * 60);

/// Uses the exact production headed supervisor for pre-activation installation smoke.
///
/// A fresh CCEM-owned profile is created and deleted for every attempt. The candidate path never
/// becomes a launch capability on its own: `VerifiedRuntimeExecutable::from_verified_candidate`
/// rebinds the non-deserializable manifest and identity evidence and rehashes the executable.
pub(crate) struct ManagedInstallationSmokeRunner {
    profiles: Arc<BrowserProfileManager>,
    supervisor: Arc<LoginSupervisor>,
    workspace: TrustedWorkspaceIdentity,
}

pub(crate) fn production_installation_smoke_runner(
    root: PathBuf,
) -> Arc<dyn InstallationSmokeRunner> {
    match ManagedInstallationSmokeRunner::production(root) {
        Ok(runner) => runner,
        Err(failure) => Arc::new(UnavailableInstallationSmokeRunner { failure }),
    }
}

struct UnavailableInstallationSmokeRunner {
    failure: RuntimePreparationFailure,
}

impl InstallationSmokeRunner for UnavailableInstallationSmokeRunner {
    fn run(
        &self,
        _manifest: &VerifiedRuntimeManifest,
        _identity: &VerifiedRuntimeIdentity,
        _candidate_root: &Path,
    ) -> Result<InstallationSmokeEvidence, RuntimePreparationFailure> {
        Err(self.failure.clone())
    }
}

impl ManagedInstallationSmokeRunner {
    pub(crate) fn production(root: PathBuf) -> Result<Arc<Self>, RuntimePreparationFailure> {
        let profiles = Arc::new(
            BrowserProfileManager::new(root.join("profiles")).map_err(|_| smoke_failure(true))?,
        );
        let supervisor = Arc::new(
            LoginSupervisor::production(root.join("supervisor"))
                .map_err(|_| smoke_failure(true))?,
        );
        let workspace =
            TrustedWorkspaceIdentity::from_trusted_store(INSTALL_SMOKE_WORKSPACE_ID.to_string())
                .map_err(|_| smoke_failure(false))?;
        // A prior controller crash must be recovered before a new profile lease can be trusted.
        supervisor
            .reap_stale(&profiles)
            .map_err(|_| smoke_failure(true))?;
        Ok(Arc::new(Self {
            profiles,
            supervisor,
            workspace,
        }))
    }

    fn delete_smoke_profile(
        &self,
        profile_id: super::profile::ProfileId,
    ) -> Result<(), RuntimePreparationFailure> {
        let authorization = DestructiveProfileAuthorization::from_trusted_ui(
            DestructiveProfileAction::Delete,
            profile_id,
            self.workspace.clone(),
            DESTRUCTIVE_AUTHORIZATION_TTL,
        )
        .map_err(|_| smoke_failure(false))?;
        self.profiles
            .delete_profile(authorization)
            .map_err(|_| smoke_failure(true))
    }
}

impl InstallationSmokeRunner for ManagedInstallationSmokeRunner {
    fn run(
        &self,
        manifest: &VerifiedRuntimeManifest,
        identity: &VerifiedRuntimeIdentity,
        candidate_root: &Path,
    ) -> Result<InstallationSmokeEvidence, RuntimePreparationFailure> {
        let executable =
            VerifiedRuntimeExecutable::from_verified_candidate(candidate_root, manifest, identity)
                .map_err(map_supervisor_error)?;
        let descriptor = self
            .profiles
            .create_profile(&self.workspace)
            .map_err(|_| smoke_failure(true))?;
        let profile_id = descriptor.profile_id().clone();
        let lease = match self
            .profiles
            .acquire_launch_lease(&profile_id, &self.workspace)
        {
            Ok(lease) => lease,
            Err(_) => {
                let _ = self.delete_smoke_profile(profile_id);
                return Err(smoke_failure(true));
            }
        };
        let spec = LoginRuntimeSpec::new(executable, LOGIN_PROTOCOL_VERSION)
            .map_err(map_supervisor_error)?;
        let mut runtime = match self.supervisor.launch(lease, spec) {
            Ok(runtime) => runtime,
            Err(error) => {
                // The supervisor releases an unlaunched lease. A stopped smoke profile can now be
                // removed; if cleanup was not proven, deletion fails closed and leaves metadata.
                let _ = self.delete_smoke_profile(profile_id);
                return Err(map_supervisor_error(error));
            }
        };

        let smoke_result = runtime
            .with_private_cdp(|reader, writer| {
                let mut adapter = PrivatePipeAdapter::new(reader, writer, SMOKE_REQUEST_TIMEOUT);
                adapter.run_installation_smoke(&manifest.manifest.artifact.version)
            })
            .map_err(map_supervisor_error)
            .and_then(|result| {
                result.map_err(|error| {
                    eprintln!(
                        "Login Browser installation smoke protocol failed: {:?}",
                        error.code
                    );
                    smoke_failure(true)
                })
            });
        let close_result = runtime.close().map_err(map_supervisor_error);
        if close_result.is_ok() {
            self.delete_smoke_profile(profile_id)?;
        }
        close_result?;
        smoke_result
    }
}

fn map_supervisor_error(error: SupervisorError) -> RuntimePreparationFailure {
    eprintln!(
        "Login Browser installation smoke supervisor failed: {}",
        supervisor_error_code(&error)
    );
    let retryable = matches!(
        error,
        SupervisorError::LaunchFailed
            | SupervisorError::InspectionFailed
            | SupervisorError::TransportFailed
            | SupervisorError::CleanupTimedOut
            | SupervisorError::Io(_)
    );
    smoke_failure(retryable)
}

fn supervisor_error_code(error: &SupervisorError) -> &'static str {
    match error {
        SupervisorError::InvalidRoot => "invalid_root",
        SupervisorError::InvalidIdentifier(_) => "invalid_identifier",
        SupervisorError::RuntimeUnavailable => "runtime_unavailable",
        SupervisorError::RuntimeActivation(_) => "runtime_activation",
        SupervisorError::ExecutableIdentityMismatch => "executable_identity_mismatch",
        SupervisorError::ProcessIdentityMismatch => "process_identity_mismatch",
        SupervisorError::OwnershipDomainMismatch => "ownership_domain_mismatch",
        SupervisorError::UnsafeMetadata => "unsafe_metadata",
        SupervisorError::MetadataCorrupt => "metadata_corrupt",
        SupervisorError::MetadataConflict => "metadata_conflict",
        SupervisorError::LaunchFailed => "launch_failed",
        SupervisorError::InspectionFailed => "inspection_failed",
        SupervisorError::TransportFailed => "transport_failed",
        SupervisorError::CleanupTimedOut => "cleanup_timed_out",
        SupervisorError::Profile(_) => "profile",
        SupervisorError::Io(_) => "io",
        SupervisorError::UnsupportedPlatform => "unsupported_platform",
    }
}

fn smoke_failure(retryable: bool) -> RuntimePreparationFailure {
    RuntimePreparationFailure {
        code: RuntimeErrorCode::SmokeFailed,
        retryable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::runtime::download::DownloadControl;
    use crate::browser::runtime::manifest::RuntimeManifest;
    use crate::browser::runtime::paths::RuntimePaths;
    use crate::browser::runtime::preparation::{
        current_embedded_manifest, ProductionRuntimeInstaller, RuntimePreparationObserver,
    };
    use crate::browser::runtime::state::{RuntimeCandidateSummary, RuntimePhase};
    use std::fs;
    use std::sync::Mutex;

    #[test]
    fn smoke_workspace_and_protocol_are_bounded_internal_identifiers() {
        assert!(TrustedWorkspaceIdentity::from_trusted_store(
            INSTALL_SMOKE_WORKSPACE_ID.to_string()
        )
        .is_ok());
        assert_eq!(LOGIN_PROTOCOL_VERSION, "1");
    }

    #[test]
    fn supervisor_failures_map_to_bounded_smoke_failure() {
        assert!(map_supervisor_error(SupervisorError::LaunchFailed).retryable);
        assert!(!map_supervisor_error(SupervisorError::ExecutableIdentityMismatch).retryable);
        assert_eq!(
            map_supervisor_error(SupervisorError::TransportFailed).code,
            RuntimeErrorCode::SmokeFailed
        );
    }

    #[derive(Default)]
    struct RecordingObserver {
        phases: Mutex<Vec<RuntimePhase>>,
    }

    impl RuntimePreparationObserver for RecordingObserver {
        fn candidate_verified(&self, _candidate: RuntimeCandidateSummary) {
            self.phases
                .lock()
                .expect("phase lock")
                .push(RuntimePhase::ManifestVerifying);
        }

        fn phase_changed(&self, phase: RuntimePhase) {
            self.phases.lock().expect("phase lock").push(phase);
        }

        fn download_progress(&self, _completed_bytes: u64, _total_bytes: u64) {}
    }

    /// Full production-path proof. The archive may be pre-seeded through
    /// `CCEM_MODE2_RUNTIME_ARCHIVE`; the production downloader still rehashes and size-checks it.
    #[test]
    #[ignore = "downloads/extracts and visibly launches the exact pinned Chromium runtime"]
    fn exact_pinned_runtime_runs_headed_smoke_before_atomic_activation() {
        let root = std::env::var_os("CCEM_MODE2_RUNTIME_TEST_ROOT")
            .map(PathBuf::from)
            .expect("set CCEM_MODE2_RUNTIME_TEST_ROOT to an owned evidence directory");
        let paths = RuntimePaths::under(root.join("runtime")).expect("runtime paths");
        paths.prepare_private().expect("private runtime root");
        let embedded = current_embedded_manifest().expect("supported exact manifest");
        let manifest: RuntimeManifest =
            serde_json::from_slice(embedded.manifest_bytes).expect("embedded manifest schema");
        if let Some(source) = std::env::var_os("CCEM_MODE2_RUNTIME_ARCHIVE").map(PathBuf::from) {
            let destination = paths.downloads.join(format!(
                "runtime-{}-{}.zip",
                manifest.artifact.version,
                &manifest.artifact.archive.sha256[..16]
            ));
            if !destination.exists() {
                fs::copy(&source, &destination).expect("seed exact archive");
            }
        }
        let smoke = production_installation_smoke_runner(root.join("smoke"));
        let installer = ProductionRuntimeInstaller::new(paths.clone(), smoke);
        let observer = RecordingObserver::default();
        let outcome = installer
            .prepare(&DownloadControl::default(), &observer, true)
            .expect("production preparation succeeds");
        assert!(outcome.activated);
        assert_eq!(outcome.active.version, manifest.artifact.version);
        let smoke = outcome.smoke.expect("headed smoke evidence");
        assert_eq!(smoke.browser_version, manifest.artifact.version);
        assert!(smoke.target_closed);
        assert_eq!(smoke.transport, "remote_debugging_pipe_nul_json");
        let phases = observer.phases.lock().unwrap().clone();
        assert_eq!(
            phases,
            vec![
                RuntimePhase::ManifestVerifying,
                RuntimePhase::Downloading,
                RuntimePhase::ArchiveVerifying,
                RuntimePhase::Extracting,
                RuntimePhase::IdentityVerifying,
                RuntimePhase::SmokeTesting,
                RuntimePhase::Activating,
            ]
        );
        let pointer = crate::browser::runtime::activation::ActivationStore::new(paths)
            .load_pointer()
            .expect("load active pointer")
            .expect("active pointer exists");
        assert_eq!(pointer.active.version, manifest.artifact.version);
    }
}
