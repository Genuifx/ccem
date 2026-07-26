mod metadata;
mod model;
#[cfg(test)]
mod tests;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[allow(unused_imports)]
pub(crate) use model::VerifiedRuntimeExecutable;
pub(crate) use model::{LoginRuntimeSpec, PrivateCdpTransport, SupervisorError};

use self::metadata::MetadataStore;
use self::model::{
    headed_arguments, random_id, CleanupState, OwnershipDomain, OwnershipGuard,
    PlatformLaunchRequest, ProcessIdentity, ProcessInspector, RuntimeLauncher, RuntimeMetadata,
    SUPERVISOR_SCHEMA_VERSION,
};
use super::profile::{
    BrowserProfileLease, BrowserProfileManager, OwnershipDomainGone, ProfileCleanupState,
    ProfileId, TrustedWorkspaceIdentity,
};
use crate::browser::runtime::activation::ActiveRuntimeLease;
use chrono::Utc;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

const DEFAULT_GRACEFUL_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_FORCE_STOP_TIMEOUT: Duration = Duration::from_secs(10);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(25);

pub(crate) struct LoginSupervisor {
    metadata_store: MetadataStore,
    inspector: Arc<dyn ProcessInspector>,
    launcher: Arc<dyn RuntimeLauncher>,
    controller: ProcessIdentity,
    controller_instance_id: String,
    graceful_close_timeout: Duration,
    force_stop_timeout: Duration,
}

impl LoginSupervisor {
    pub(crate) fn production(metadata_root: PathBuf) -> Result<Self, SupervisorError> {
        #[cfg(unix)]
        let (inspector, launcher): (Arc<dyn ProcessInspector>, Arc<dyn RuntimeLauncher>) = (
            Arc::new(unix::UnixProcessInspector),
            Arc::new(unix::UnixRuntimeLauncher),
        );
        #[cfg(windows)]
        let (inspector, launcher): (Arc<dyn ProcessInspector>, Arc<dyn RuntimeLauncher>) = (
            Arc::new(windows::WindowsProcessInspector),
            Arc::new(windows::WindowsRuntimeLauncher),
        );
        #[cfg(not(any(unix, windows)))]
        return Err(SupervisorError::UnsupportedPlatform);

        Self::from_parts(
            metadata_root,
            inspector,
            launcher,
            DEFAULT_GRACEFUL_CLOSE_TIMEOUT,
            DEFAULT_FORCE_STOP_TIMEOUT,
        )
    }

    fn from_parts(
        metadata_root: PathBuf,
        inspector: Arc<dyn ProcessInspector>,
        launcher: Arc<dyn RuntimeLauncher>,
        graceful_close_timeout: Duration,
        force_stop_timeout: Duration,
    ) -> Result<Self, SupervisorError> {
        let metadata_store = MetadataStore::new(metadata_root)?;
        let controller = inspector
            .inspect_process(std::process::id())?
            .ok_or(SupervisorError::InspectionFailed)?;
        Ok(Self {
            metadata_store,
            inspector,
            launcher,
            controller,
            controller_instance_id: random_id("controller"),
            graceful_close_timeout,
            force_stop_timeout,
        })
    }

    pub(crate) fn launch(
        &self,
        profile_lease: BrowserProfileLease,
        runtime_spec: LoginRuntimeSpec,
    ) -> Result<ManagedLoginRuntime, SupervisorError> {
        self.launch_with_optional_runtime_lease(profile_lease, runtime_spec, None)
    }

    pub(crate) fn launch_with_runtime_lease(
        &self,
        profile_lease: BrowserProfileLease,
        runtime_spec: LoginRuntimeSpec,
        runtime_lease: ActiveRuntimeLease,
    ) -> Result<ManagedLoginRuntime, SupervisorError> {
        self.launch_with_optional_runtime_lease(profile_lease, runtime_spec, Some(runtime_lease))
    }

    fn launch_with_optional_runtime_lease(
        &self,
        mut profile_lease: BrowserProfileLease,
        runtime_spec: LoginRuntimeSpec,
        runtime_lease: Option<ActiveRuntimeLease>,
    ) -> Result<ManagedLoginRuntime, SupervisorError> {
        runtime_spec.runtime().verify_unchanged()?;
        let runtime_id = random_id("runtime");
        let user_data_dir = profile_lease.user_data_dir();
        let arguments = headed_arguments(&user_data_dir, &runtime_id);
        let request = PlatformLaunchRequest {
            executable: runtime_spec.runtime().clone(),
            arguments,
            runtime_id: runtime_id.clone(),
        };
        let mut launched = match self.launcher.launch(request) {
            Ok(launched) => launched,
            Err(error) => {
                self.release_unlaunched_profile(profile_lease)?;
                return Err(error);
            }
        };
        if launched.identity.executable != runtime_spec.runtime().executable().to_path_buf()
            || !domain_matches_leader(&launched.ownership_domain, launched.identity.pid)
        {
            self.cleanup_failed_launch(profile_lease, &mut launched, None)?;
            return Err(SupervisorError::ProcessIdentityMismatch);
        }

        let now = Utc::now().to_rfc3339();
        let metadata = RuntimeMetadata {
            schema_version: SUPERVISOR_SCHEMA_VERSION,
            revision: 1,
            runtime_id: runtime_id.clone(),
            ownership_id: profile_lease.ownership_id().to_string(),
            controller_instance_id: self.controller_instance_id.clone(),
            controller: self.controller.clone(),
            browser: launched.identity.clone(),
            ownership_domain: launched.ownership_domain.clone(),
            executable_sha256: runtime_spec.runtime().executable_sha256().to_string(),
            manifest_sha256: runtime_spec.runtime().manifest_sha256().to_string(),
            runtime_version: runtime_spec.runtime().runtime_version().to_string(),
            protocol_version: runtime_spec.protocol_version().to_string(),
            profile_id: profile_lease.descriptor().profile_id().as_str().to_string(),
            workspace_identity: profile_lease.descriptor().workspace_identity().to_string(),
            user_data_dir,
            transport: launched.transport_kind,
            cleanup_state: CleanupState::Running,
            created_at: now.clone(),
            updated_at: now,
        };
        if let Err(error) = self.metadata_store.write_new(&metadata) {
            self.cleanup_failed_launch(profile_lease, &mut launched, None)?;
            return Err(error);
        }
        if let Err(error) = profile_lease.mark_runtime_owned(
            &runtime_id,
            runtime_spec.runtime().runtime_version(),
            runtime_spec.protocol_version(),
        ) {
            self.cleanup_failed_launch(profile_lease, &mut launched, Some(&metadata))?;
            return Err(SupervisorError::Profile(error.to_string()));
        }

        Ok(ManagedLoginRuntime {
            metadata_store: self.metadata_store.clone(),
            inspector: Arc::clone(&self.inspector),
            metadata,
            profile_lease: Some(profile_lease),
            transport: Some(launched.transport),
            ownership_guard: Some(launched.guard),
            graceful_close_timeout: self.graceful_close_timeout,
            force_stop_timeout: self.force_stop_timeout,
            _runtime_lease: runtime_lease,
        })
    }

    /// Reap runtime metadata whose controller process is gone or whose ownership domain already
    /// disappeared. PID reuse fails closed; an exact Unix process group remains owned after its
    /// leader exits and is terminated before profile recovery.
    pub(crate) fn reap_stale(
        &self,
        profiles: &BrowserProfileManager,
    ) -> Result<Vec<StaleReapRecord>, SupervisorError> {
        let mut records = Vec::new();
        for metadata in self.metadata_store.list()? {
            if !self
                .inspector
                .ownership_domain_alive(&metadata.ownership_domain)?
            {
                let disposition = self.recover_stale_profile(profiles, &metadata)?;
                records.push(StaleReapRecord {
                    runtime_id: metadata.runtime_id,
                    disposition,
                });
                continue;
            }

            if self.inspector.inspect_process(metadata.controller.pid)?
                == Some(metadata.controller.clone())
            {
                records.push(StaleReapRecord {
                    runtime_id: metadata.runtime_id,
                    disposition: StaleReapDisposition::RetainedLiveController,
                });
                continue;
            }

            match self.inspector.inspect_process(metadata.browser.pid)? {
                None if !can_terminate_without_live_leader(
                    &metadata.ownership_domain,
                    metadata.browser.pid,
                ) =>
                {
                    records.push(StaleReapRecord {
                        runtime_id: metadata.runtime_id,
                        disposition: StaleReapDisposition::RetainedLeaderGoneDomainAlive,
                    })
                }
                Some(identity) if identity != metadata.browser => records.push(StaleReapRecord {
                    runtime_id: metadata.runtime_id,
                    disposition: StaleReapDisposition::RetainedBrowserIdentityMismatch,
                }),
                None | Some(_) => {
                    self.inspector
                        .terminate_ownership_domain(&metadata.ownership_domain)?;
                    if !wait_for_domain_gone(
                        self.inspector.as_ref(),
                        &metadata.ownership_domain,
                        self.force_stop_timeout,
                        None,
                    )? {
                        records.push(StaleReapRecord {
                            runtime_id: metadata.runtime_id,
                            disposition: StaleReapDisposition::RetainedCleanupTimedOut,
                        });
                        continue;
                    }
                    let disposition = self.recover_stale_profile(profiles, &metadata)?;
                    records.push(StaleReapRecord {
                        runtime_id: metadata.runtime_id,
                        disposition: match disposition {
                            StaleReapDisposition::ReapedDomainGone => {
                                StaleReapDisposition::ReapedTerminatedDomain
                            }
                            other => other,
                        },
                    });
                }
            }
        }
        Ok(records)
    }

    fn recover_stale_profile(
        &self,
        profiles: &BrowserProfileManager,
        metadata: &RuntimeMetadata,
    ) -> Result<StaleReapDisposition, SupervisorError> {
        let profile_id =
            ProfileId::parse(&metadata.profile_id).map_err(|_| SupervisorError::MetadataCorrupt)?;
        let workspace =
            TrustedWorkspaceIdentity::from_trusted_store(metadata.workspace_identity.clone())
                .map_err(|_| SupervisorError::MetadataCorrupt)?;
        let proof = OwnershipDomainGone::from_supervisor(metadata.ownership_id.clone())
            .map_err(|error| SupervisorError::Profile(error.to_string()))?;
        match profiles.recover_after_ownership_domain_gone(&profile_id, &workspace, proof) {
            Ok(_) => {
                self.metadata_store.remove(&metadata.runtime_id)?;
                Ok(StaleReapDisposition::ReapedDomainGone)
            }
            Err(_) => {
                // A crash can occur after the profile is marked Stopped but before metadata is
                // deleted. That state is already safe and cleanup can idempotently finish here.
                let already_stopped = profiles
                    .descriptor(&profile_id, &workspace)
                    .map(|descriptor| {
                        matches!(descriptor.cleanup_state(), ProfileCleanupState::Stopped)
                    })
                    .unwrap_or(false);
                if already_stopped {
                    self.metadata_store.remove(&metadata.runtime_id)?;
                    Ok(StaleReapDisposition::ReapedDomainGone)
                } else {
                    Ok(StaleReapDisposition::RetainedProfileRecoveryFailed)
                }
            }
        }
    }

    fn release_unlaunched_profile(
        &self,
        profile_lease: BrowserProfileLease,
    ) -> Result<(), SupervisorError> {
        let proof = OwnershipDomainGone::from_supervisor(profile_lease.ownership_id().to_string())
            .map_err(|error| SupervisorError::Profile(error.to_string()))?;
        profile_lease
            .release_after_ownership_domain_gone(proof)
            .map(|_| ())
            .map_err(|error| SupervisorError::Profile(error.to_string()))
    }

    fn cleanup_failed_launch(
        &self,
        profile_lease: BrowserProfileLease,
        launched: &mut model::LaunchedRuntime,
        metadata: Option<&RuntimeMetadata>,
    ) -> Result<(), SupervisorError> {
        if self
            .inspector
            .ownership_domain_alive(&launched.ownership_domain)?
        {
            self.inspector
                .terminate_ownership_domain(&launched.ownership_domain)?;
        }
        if !wait_for_domain_gone(
            self.inspector.as_ref(),
            &launched.ownership_domain,
            self.force_stop_timeout,
            Some(launched.guard.as_mut()),
        )? {
            return Err(SupervisorError::CleanupTimedOut);
        }
        self.release_unlaunched_profile(profile_lease)?;
        if let Some(metadata) = metadata {
            self.metadata_store.remove(&metadata.runtime_id)?;
        }
        Ok(())
    }
}

pub(crate) struct ManagedLoginRuntime {
    metadata_store: MetadataStore,
    inspector: Arc<dyn ProcessInspector>,
    metadata: RuntimeMetadata,
    profile_lease: Option<BrowserProfileLease>,
    transport: Option<PrivateCdpTransport>,
    // Unix keeps the leader Child for reaping. Windows keeps the process and Job Object handles;
    // closing the Job handle on controller failure enforces KILL_ON_JOB_CLOSE.
    ownership_guard: Option<Box<dyn OwnershipGuard>>,
    graceful_close_timeout: Duration,
    force_stop_timeout: Duration,
    _runtime_lease: Option<ActiveRuntimeLease>,
}

/// Cloneable, identity-bound emergency stop capability retained by the CDP owner handle.
///
/// It contains no profile lease or pipe. Its only authority is to terminate the exact verified
/// ownership domain already recorded by the supervisor. The owner thread still performs metadata
/// and profile finalization after the forced domain closure wakes blocked pipe I/O.
pub(crate) struct VerifiedRuntimeTerminationHandle {
    inspector: Arc<dyn ProcessInspector>,
    browser: ProcessIdentity,
    ownership_domain: OwnershipDomain,
    force_stop_timeout: Duration,
}

impl VerifiedRuntimeTerminationHandle {
    /// Signal only the exact verified ownership domain, without waiting for process disappearance.
    /// The session pause path uses this emergency seam after an owner-ack deadline so the trusted
    /// UI remains bounded; ordinary owner shutdown still performs the full wait and finalization.
    pub(crate) fn request_force_verified_domain(&self) -> Result<(), SupervisorError> {
        if !self
            .inspector
            .ownership_domain_alive(&self.ownership_domain)?
        {
            return Ok(());
        }
        match self.inspector.inspect_process(self.browser.pid)? {
            Some(identity) if identity == self.browser => self
                .inspector
                .terminate_ownership_domain(&self.ownership_domain)?,
            Some(_) => return Err(SupervisorError::ProcessIdentityMismatch),
            None if can_terminate_without_live_leader(&self.ownership_domain, self.browser.pid) => {
                self.inspector
                    .terminate_ownership_domain(&self.ownership_domain)?
            }
            None => return Err(SupervisorError::OwnershipDomainMismatch),
        }
        Ok(())
    }

    pub(crate) fn force_verified_domain(&self) -> Result<(), SupervisorError> {
        self.request_force_verified_domain()?;
        if wait_for_domain_gone(
            self.inspector.as_ref(),
            &self.ownership_domain,
            self.force_stop_timeout,
            None,
        )? {
            Ok(())
        } else {
            Err(SupervisorError::CleanupTimedOut)
        }
    }
}

impl ManagedLoginRuntime {
    pub(crate) fn runtime_id(&self) -> &str {
        &self.metadata.runtime_id
    }

    pub(crate) fn verified_termination_handle(&self) -> VerifiedRuntimeTerminationHandle {
        VerifiedRuntimeTerminationHandle {
            inspector: Arc::clone(&self.inspector),
            browser: self.metadata.browser.clone(),
            ownership_domain: self.metadata.ownership_domain.clone(),
            force_stop_timeout: self.force_stop_timeout,
        }
    }

    /// Temporarily borrow both private pipe directions without transferring ownership. This lets
    /// the installation-smoke adapter run before activation while the supervisor retains the pipe
    /// needed for Browser.close and ownership-domain cleanup.
    pub(crate) fn with_private_cdp<T>(
        &mut self,
        callback: impl FnOnce(&mut dyn std::io::Read, &mut dyn std::io::Write) -> T,
    ) -> Result<T, SupervisorError> {
        self.transport
            .as_mut()
            .map(|transport| transport.with_io(callback))
            .ok_or(SupervisorError::TransportFailed)
    }

    pub(crate) fn close(mut self) -> Result<(), SupervisorError> {
        self.persist_cleanup_state(CleanupState::GracefulCloseRequested)?;
        if let Some(transport) = self.transport.as_mut() {
            let _ = transport.request_browser_close();
        }
        if !self.wait_owned_domain_gone(self.graceful_close_timeout)? {
            self.force_verified_domain()?;
        }
        self.finalize_if_gone()
    }

    pub(crate) fn force_stop(mut self) -> Result<(), SupervisorError> {
        self.persist_cleanup_state(CleanupState::ForceStopRequested)?;
        self.force_verified_domain()?;
        self.finalize_if_gone()
    }

    fn persist_cleanup_state(&mut self, state: CleanupState) -> Result<(), SupervisorError> {
        self.metadata.touch_cleanup(state);
        self.metadata_store.update(&self.metadata)
    }

    fn force_verified_domain(&mut self) -> Result<(), SupervisorError> {
        if !self
            .inspector
            .ownership_domain_alive(&self.metadata.ownership_domain)?
        {
            return Ok(());
        }
        match self.inspector.inspect_process(self.metadata.browser.pid)? {
            Some(identity) if identity == self.metadata.browser => self
                .inspector
                .terminate_ownership_domain(&self.metadata.ownership_domain)?,
            Some(_) => return Err(SupervisorError::ProcessIdentityMismatch),
            None if can_terminate_without_live_leader(
                &self.metadata.ownership_domain,
                self.metadata.browser.pid,
            ) =>
            {
                self.inspector
                    .terminate_ownership_domain(&self.metadata.ownership_domain)?
            }
            None => return Err(SupervisorError::OwnershipDomainMismatch),
        }
        if self.wait_owned_domain_gone(self.force_stop_timeout)? {
            Ok(())
        } else {
            Err(SupervisorError::CleanupTimedOut)
        }
    }

    fn wait_owned_domain_gone(&mut self, timeout: Duration) -> Result<bool, SupervisorError> {
        let inspector = Arc::clone(&self.inspector);
        let domain = self.metadata.ownership_domain.clone();
        wait_for_domain_gone(
            inspector.as_ref(),
            &domain,
            timeout,
            self.ownership_guard.as_deref_mut(),
        )
    }

    fn finalize_if_gone(&mut self) -> Result<(), SupervisorError> {
        if self
            .inspector
            .ownership_domain_alive(&self.metadata.ownership_domain)?
        {
            return Err(SupervisorError::CleanupTimedOut);
        }
        if let Some(profile_lease) = self.profile_lease.take() {
            let proof =
                OwnershipDomainGone::from_supervisor(profile_lease.ownership_id().to_string())
                    .map_err(|error| SupervisorError::Profile(error.to_string()))?;
            profile_lease
                .release_after_ownership_domain_gone(proof)
                .map_err(|error| SupervisorError::Profile(error.to_string()))?;
        }
        self.metadata_store.remove(&self.metadata.runtime_id)?;
        self.transport.take();
        self.ownership_guard.take();
        Ok(())
    }
}

impl Drop for ManagedLoginRuntime {
    fn drop(&mut self) {
        if self.profile_lease.is_none() {
            return;
        }
        let _ = self.persist_cleanup_state(CleanupState::ForceStopRequested);
        if self.force_verified_domain().is_ok() {
            let _ = self.finalize_if_gone();
        }
        // On an identity mismatch or cleanup timeout, fail closed: metadata and the non-Stopped
        // profile state remain for explicit recovery, and no possibly reused live PID is signalled.
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StaleReapRecord {
    pub runtime_id: String,
    pub disposition: StaleReapDisposition,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StaleReapDisposition {
    RetainedLiveController,
    RetainedLeaderGoneDomainAlive,
    RetainedBrowserIdentityMismatch,
    RetainedCleanupTimedOut,
    RetainedProfileRecoveryFailed,
    ReapedDomainGone,
    ReapedTerminatedDomain,
}

fn domain_matches_leader(domain: &OwnershipDomain, leader_pid: u32) -> bool {
    match domain {
        OwnershipDomain::UnixProcessGroup { pgid } => *pgid > 0 && *pgid as u32 == leader_pid,
        OwnershipDomain::WindowsJob { name } => name.starts_with("CCEM.LoginBrowser."),
    }
}

fn can_terminate_without_live_leader(domain: &OwnershipDomain, leader_pid: u32) -> bool {
    #[cfg(unix)]
    {
        matches!(
            domain,
            OwnershipDomain::UnixProcessGroup { pgid }
                if *pgid > 0 && *pgid as u32 == leader_pid
        )
    }
    #[cfg(not(unix))]
    {
        let _ = (domain, leader_pid);
        false
    }
}

fn wait_for_domain_gone<'guard>(
    inspector: &dyn ProcessInspector,
    domain: &OwnershipDomain,
    timeout: Duration,
    mut ownership_guard: Option<&'guard mut (dyn OwnershipGuard + 'static)>,
) -> Result<bool, SupervisorError> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(guard) = ownership_guard.as_deref_mut() {
            guard.reap_leader_if_exited();
        }
        if !inspector.ownership_domain_alive(domain)? {
            return Ok(true);
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
        thread::sleep(PROCESS_POLL_INTERVAL.min(timeout));
    }
}
