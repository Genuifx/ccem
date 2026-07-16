use super::download::DownloadControl;
use super::maintenance::{RuntimeDeleteOutcome, RuntimeDiskUsage, RuntimeMaintenanceError};
use super::paths::RuntimePaths;
use super::preparation::{
    InstallationSmokeRunner, ProductionRuntimeInstaller, RuntimePreparationFailure,
    RuntimePreparationObserver, RuntimePreparationOutcome, RuntimePreparationStop,
};
use super::state::{
    BrowserRuntimeReadiness, RuntimeCandidateSummary, RuntimeErrorCode, RuntimeFailure,
    RuntimePhase, RuntimeProgress, RuntimeStateMachine, RuntimeVersionSummary,
};
use serde::Serialize;
use std::fmt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use std::thread;
use tauri::{AppHandle, Emitter};

pub(crate) const RUNTIME_READINESS_EVENT: &str = "browser_runtime_readiness_changed";

trait RuntimeInstaller: Send + Sync {
    fn recover_active(&self) -> Result<Option<RuntimeVersionSummary>, RuntimePreparationFailure>;
    fn prepare(
        &self,
        control: &DownloadControl,
        observer: &dyn RuntimePreparationObserver,
        force_reinstall: bool,
    ) -> Result<RuntimePreparationOutcome, RuntimePreparationStop>;

    fn disk_usage(&self) -> Result<RuntimeDiskUsage, RuntimeMaintenanceError> {
        Err(RuntimeMaintenanceError::StateCorrupt)
    }

    fn delete_runtime(&self) -> Result<RuntimeDeleteOutcome, RuntimeMaintenanceError> {
        Err(RuntimeMaintenanceError::StateCorrupt)
    }
}

impl RuntimeInstaller for ProductionRuntimeInstaller {
    fn recover_active(&self) -> Result<Option<RuntimeVersionSummary>, RuntimePreparationFailure> {
        ProductionRuntimeInstaller::recover_active(self)
    }

    fn prepare(
        &self,
        control: &DownloadControl,
        observer: &dyn RuntimePreparationObserver,
        force_reinstall: bool,
    ) -> Result<RuntimePreparationOutcome, RuntimePreparationStop> {
        ProductionRuntimeInstaller::prepare(self, control, observer, force_reinstall)
    }

    fn disk_usage(&self) -> Result<RuntimeDiskUsage, RuntimeMaintenanceError> {
        ProductionRuntimeInstaller::disk_usage(self)
    }

    fn delete_runtime(&self) -> Result<RuntimeDeleteOutcome, RuntimeMaintenanceError> {
        ProductionRuntimeInstaller::delete_runtime(self)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RuntimeManagerErrorCode {
    OperationInProgress,
    InvalidState,
    WorkerUnavailable,
    StateUnavailable,
    RuntimeInUse,
    MaintenanceFailed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RuntimeManagerError {
    pub(crate) code: RuntimeManagerErrorCode,
}

impl RuntimeManagerError {
    fn new(code: RuntimeManagerErrorCode) -> Self {
        Self { code }
    }
}

impl fmt::Display for RuntimeManagerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self.code {
            RuntimeManagerErrorCode::OperationInProgress => {
                "Browser runtime preparation is already running."
            }
            RuntimeManagerErrorCode::InvalidState => {
                "Browser runtime operation is not available in the current state."
            }
            RuntimeManagerErrorCode::WorkerUnavailable => {
                "Browser runtime preparation worker could not start."
            }
            RuntimeManagerErrorCode::StateUnavailable => {
                "Browser runtime readiness state is unavailable."
            }
            RuntimeManagerErrorCode::RuntimeInUse => {
                "Browser runtime is in use by an active browser session."
            }
            RuntimeManagerErrorCode::MaintenanceFailed => {
                "Browser runtime maintenance could not be completed safely."
            }
        })
    }
}

impl std::error::Error for RuntimeManagerError {}

#[derive(Debug)]
struct RuntimeOperation {
    running: bool,
    control: DownloadControl,
}

impl Default for RuntimeOperation {
    fn default() -> Self {
        Self {
            running: false,
            control: DownloadControl::default(),
        }
    }
}

pub(crate) struct BrowserRuntimeManager {
    installer: Option<Arc<dyn RuntimeInstaller>>,
    state: Arc<Mutex<RuntimeStateMachine>>,
    operation: Mutex<RuntimeOperation>,
}

impl BrowserRuntimeManager {
    pub(crate) fn production(
        root: PathBuf,
        smoke_runner: Arc<dyn InstallationSmokeRunner>,
    ) -> Result<Arc<Self>, RuntimeManagerError> {
        let paths = RuntimePaths::under(root)
            .map_err(|_| RuntimeManagerError::new(RuntimeManagerErrorCode::StateUnavailable))?;
        let installer = Arc::new(ProductionRuntimeInstaller::new(paths, smoke_runner));
        Self::from_installer(installer)
    }

    fn from_installer(
        installer: Arc<dyn RuntimeInstaller>,
    ) -> Result<Arc<Self>, RuntimeManagerError> {
        let (active, recovery_failure) = match installer.recover_active() {
            Ok(active) => (active, None),
            Err(failure) => (None, Some(failure)),
        };
        let mut state = RuntimeStateMachine::new(active);
        if let Some(failure) = recovery_failure {
            state
                .fail_without_candidate(RuntimeFailure {
                    code: failure.code,
                    retryable: failure.retryable,
                })
                .map_err(|_| RuntimeManagerError::new(RuntimeManagerErrorCode::StateUnavailable))?;
        }
        Ok(Arc::new(Self {
            installer: Some(installer),
            state: Arc::new(Mutex::new(state)),
            operation: Mutex::new(RuntimeOperation::default()),
        }))
    }

    /// Infallible placeholder used when the app-owned runtime root cannot be initialized.
    ///
    /// Read-only readiness remains available to the shell as a bounded `StateCorrupt` failure,
    /// while every runtime mutation fails before starting a worker or touching installation state.
    pub(crate) fn unavailable() -> Arc<Self> {
        let mut state = RuntimeStateMachine::new(None);
        let transition = state.fail_without_candidate(RuntimeFailure {
            code: RuntimeErrorCode::StateCorrupt,
            retryable: false,
        });
        debug_assert!(transition.is_ok());
        Arc::new(Self {
            installer: None,
            state: Arc::new(Mutex::new(state)),
            operation: Mutex::new(RuntimeOperation::default()),
        })
    }

    fn installer(&self) -> Result<&Arc<dyn RuntimeInstaller>, RuntimeManagerError> {
        self.installer
            .as_ref()
            .ok_or_else(|| RuntimeManagerError::new(RuntimeManagerErrorCode::StateUnavailable))
    }

    pub(crate) fn readiness(&self) -> Result<BrowserRuntimeReadiness, RuntimeManagerError> {
        self.state
            .lock()
            .map(|state| state.readiness())
            .map_err(|_| RuntimeManagerError::new(RuntimeManagerErrorCode::StateUnavailable))
    }

    pub(crate) fn disk_usage(&self) -> Result<RuntimeDiskUsage, RuntimeManagerError> {
        self.installer()?
            .disk_usage()
            .map_err(map_maintenance_error)
    }

    pub(crate) fn delete_runtime(
        &self,
        app: Option<AppHandle>,
    ) -> Result<RuntimeDeleteOutcome, RuntimeManagerError> {
        let installer = self.installer()?;
        let operation = self
            .operation
            .lock()
            .map_err(|_| RuntimeManagerError::new(RuntimeManagerErrorCode::StateUnavailable))?;
        if operation.running {
            return Err(RuntimeManagerError::new(
                RuntimeManagerErrorCode::OperationInProgress,
            ));
        }

        let result = installer.delete_runtime();
        match result {
            Ok(outcome) => {
                if let Ok(mut state) = self.state.lock() {
                    state.clear_failed_candidate();
                    state.clear_active();
                }
                drop(operation);
                self.emit(&app);
                Ok(outcome)
            }
            Err(error) => {
                if !matches!(installer.recover_active(), Ok(Some(_))) {
                    if let Ok(mut state) = self.state.lock() {
                        state.clear_failed_candidate();
                        state.clear_active();
                    }
                }
                drop(operation);
                self.emit(&app);
                Err(map_maintenance_error(error))
            }
        }
    }

    pub(crate) fn prepare(
        self: &Arc<Self>,
        app: Option<AppHandle>,
    ) -> Result<BrowserRuntimeReadiness, RuntimeManagerError> {
        self.start_worker(app, false)
    }

    pub(crate) fn reinstall(
        self: &Arc<Self>,
        app: Option<AppHandle>,
    ) -> Result<BrowserRuntimeReadiness, RuntimeManagerError> {
        self.start_worker(app, true)
    }

    pub(crate) fn retry(
        self: &Arc<Self>,
        app: Option<AppHandle>,
    ) -> Result<BrowserRuntimeReadiness, RuntimeManagerError> {
        self.installer()?;
        let readiness = self.readiness()?;
        if readiness.phase != RuntimePhase::Idle || readiness.error.is_none() {
            return Err(RuntimeManagerError::new(
                RuntimeManagerErrorCode::InvalidState,
            ));
        }
        self.start_worker(app, false)
    }

    pub(crate) fn pause_download(&self) -> Result<BrowserRuntimeReadiness, RuntimeManagerError> {
        self.installer()?;
        let operation = self
            .operation
            .lock()
            .map_err(|_| RuntimeManagerError::new(RuntimeManagerErrorCode::StateUnavailable))?;
        let readiness = self.readiness()?;
        if !operation.running || readiness.phase != RuntimePhase::Downloading {
            return Err(RuntimeManagerError::new(
                RuntimeManagerErrorCode::InvalidState,
            ));
        }
        operation.control.pause();
        Ok(readiness)
    }

    pub(crate) fn resume_download(
        self: &Arc<Self>,
        app: Option<AppHandle>,
    ) -> Result<BrowserRuntimeReadiness, RuntimeManagerError> {
        self.installer()?;
        let readiness = self.readiness()?;
        if readiness.phase != RuntimePhase::Paused {
            return Err(RuntimeManagerError::new(
                RuntimeManagerErrorCode::InvalidState,
            ));
        }
        self.start_worker(app, false)
    }

    pub(crate) fn cancel(&self) -> Result<BrowserRuntimeReadiness, RuntimeManagerError> {
        self.installer()?;
        let operation = self
            .operation
            .lock()
            .map_err(|_| RuntimeManagerError::new(RuntimeManagerErrorCode::StateUnavailable))?;
        if !operation.running {
            return Err(RuntimeManagerError::new(
                RuntimeManagerErrorCode::InvalidState,
            ));
        }
        operation.control.cancel();
        self.readiness()
    }

    fn start_worker(
        self: &Arc<Self>,
        app: Option<AppHandle>,
        force_reinstall: bool,
    ) -> Result<BrowserRuntimeReadiness, RuntimeManagerError> {
        let installer = Arc::clone(self.installer()?);
        let control = {
            let mut operation = self
                .operation
                .lock()
                .map_err(|_| RuntimeManagerError::new(RuntimeManagerErrorCode::StateUnavailable))?;
            if operation.running {
                return Err(RuntimeManagerError::new(
                    RuntimeManagerErrorCode::OperationInProgress,
                ));
            }
            operation.control = DownloadControl::default();
            operation.running = true;
            operation.control.clone()
        };
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| RuntimeManagerError::new(RuntimeManagerErrorCode::StateUnavailable))?;
            state.clear_failed_candidate();
            state
                .begin_manifest_verification()
                .map_err(|_| RuntimeManagerError::new(RuntimeManagerErrorCode::InvalidState))?;
        }
        self.emit(&app);

        let manager = Arc::clone(self);
        let observer = ManagerObserver {
            manager: Arc::downgrade(self),
            app: app.clone(),
        };
        let worker_app = app.clone();
        let spawn = thread::Builder::new()
            .name("ccem-browser-runtime-prepare".to_string())
            .spawn(move || {
                let result = installer.prepare(&control, &observer, force_reinstall);
                manager.finish_worker(result, &worker_app);
            });
        if spawn.is_err() {
            if let Ok(mut operation) = self.operation.lock() {
                operation.running = false;
            }
            if let Ok(mut state) = self.state.lock() {
                let _ = state.fail_without_candidate(RuntimeFailure {
                    code: super::state::RuntimeErrorCode::Io,
                    retryable: true,
                });
            }
            self.emit(&app);
            return Err(RuntimeManagerError::new(
                RuntimeManagerErrorCode::WorkerUnavailable,
            ));
        }
        self.readiness()
    }

    fn finish_worker(
        &self,
        result: Result<RuntimePreparationOutcome, RuntimePreparationStop>,
        app: &Option<AppHandle>,
    ) {
        if let Ok(mut state) = self.state.lock() {
            match result {
                Ok(outcome) if outcome.activated => {
                    let _ = state.activate(outcome.active);
                }
                Ok(_) => {
                    let _ = state.finish_without_candidate();
                }
                Err(RuntimePreparationStop::Paused) => {
                    let _ = state.set_phase(RuntimePhase::Paused);
                }
                Err(RuntimePreparationStop::Failed(failure)) => {
                    let failure = RuntimeFailure {
                        code: failure.code,
                        retryable: failure.retryable,
                    };
                    if state.readiness().candidate.is_some() {
                        let _ = state.fail_candidate(failure);
                    } else {
                        let _ = state.fail_without_candidate(failure);
                    }
                }
            }
        }
        if let Ok(mut operation) = self.operation.lock() {
            operation.running = false;
        }
        self.emit(app);
    }

    fn apply_candidate(&self, candidate: RuntimeCandidateSummary, app: &Option<AppHandle>) {
        if let Ok(mut state) = self.state.lock() {
            let _ = state.begin_candidate(candidate);
        }
        self.emit(app);
    }

    fn apply_phase(&self, phase: RuntimePhase, app: &Option<AppHandle>) {
        if let Ok(mut state) = self.state.lock() {
            let _ = state.set_phase(phase);
        }
        self.emit(app);
    }

    fn apply_progress(&self, completed_bytes: u64, total_bytes: u64, app: &Option<AppHandle>) {
        if let Ok(progress) = RuntimeProgress::new(completed_bytes, total_bytes) {
            if let Ok(mut state) = self.state.lock() {
                let _ = state.set_progress(progress);
            }
        }
        self.emit(app);
    }

    fn emit(&self, app: &Option<AppHandle>) {
        if let (Some(app), Ok(readiness)) = (app, self.readiness()) {
            let _ = app.emit(RUNTIME_READINESS_EVENT, readiness);
        }
    }
}

fn map_maintenance_error(error: RuntimeMaintenanceError) -> RuntimeManagerError {
    let code = match error {
        RuntimeMaintenanceError::RuntimeInUse => RuntimeManagerErrorCode::RuntimeInUse,
        RuntimeMaintenanceError::OperationInProgress => {
            RuntimeManagerErrorCode::OperationInProgress
        }
        RuntimeMaintenanceError::StateCorrupt
        | RuntimeMaintenanceError::ScanLimitExceeded
        | RuntimeMaintenanceError::Io => RuntimeManagerErrorCode::MaintenanceFailed,
    };
    RuntimeManagerError::new(code)
}

struct ManagerObserver {
    manager: Weak<BrowserRuntimeManager>,
    app: Option<AppHandle>,
}

impl RuntimePreparationObserver for ManagerObserver {
    fn candidate_verified(&self, candidate: RuntimeCandidateSummary) {
        if let Some(manager) = self.manager.upgrade() {
            manager.apply_candidate(candidate, &self.app);
        }
    }

    fn phase_changed(&self, phase: RuntimePhase) {
        if let Some(manager) = self.manager.upgrade() {
            manager.apply_phase(phase, &self.app);
        }
    }

    fn download_progress(&self, completed_bytes: u64, total_bytes: u64) {
        if let Some(manager) = self.manager.upgrade() {
            manager.apply_progress(completed_bytes, total_bytes, &self.app);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::state::{BrowserRuntimeReadinessStatus, RuntimeErrorCode};
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    #[derive(Clone)]
    enum FakeResult {
        Ready,
        Failed,
    }

    struct FakeInstaller {
        active: Option<RuntimeVersionSummary>,
        result: FakeResult,
        calls: AtomicUsize,
        delay: Duration,
    }

    impl FakeInstaller {
        fn new(active: Option<RuntimeVersionSummary>, result: FakeResult) -> Self {
            Self {
                active,
                result,
                calls: AtomicUsize::new(0),
                delay: Duration::from_millis(20),
            }
        }
    }

    impl RuntimeInstaller for FakeInstaller {
        fn recover_active(
            &self,
        ) -> Result<Option<RuntimeVersionSummary>, RuntimePreparationFailure> {
            Ok(self.active.clone())
        }

        fn prepare(
            &self,
            _control: &DownloadControl,
            observer: &dyn RuntimePreparationObserver,
            _force_reinstall: bool,
        ) -> Result<RuntimePreparationOutcome, RuntimePreparationStop> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let candidate = version("150.0.1", 2, 'b');
            observer.candidate_verified(RuntimeCandidateSummary {
                version: candidate.version.clone(),
                sequence: candidate.sequence,
                manifest_sha256: candidate.manifest_sha256.clone(),
            });
            observer.phase_changed(RuntimePhase::Downloading);
            observer.download_progress(5, 10);
            thread::sleep(self.delay);
            match self.result {
                FakeResult::Ready => {
                    for phase in [
                        RuntimePhase::ArchiveVerifying,
                        RuntimePhase::Extracting,
                        RuntimePhase::IdentityVerifying,
                        RuntimePhase::SmokeTesting,
                        RuntimePhase::Activating,
                    ] {
                        observer.phase_changed(phase);
                    }
                    Ok(RuntimePreparationOutcome {
                        active: candidate,
                        activated: true,
                        smoke: None,
                    })
                }
                FakeResult::Failed => {
                    Err(RuntimePreparationStop::Failed(RuntimePreparationFailure {
                        code: RuntimeErrorCode::ArchiveHashMismatch,
                        retryable: true,
                    }))
                }
            }
        }
    }

    fn version(name: &str, sequence: u64, hash_byte: char) -> RuntimeVersionSummary {
        RuntimeVersionSummary {
            version: name.to_string(),
            sequence,
            manifest_sha256: hash_byte.to_string().repeat(64),
        }
    }

    fn wait_until_idle(manager: &BrowserRuntimeManager) -> BrowserRuntimeReadiness {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let readiness = manager.readiness().unwrap();
            let running = manager.operation.lock().unwrap().running;
            if !running {
                return readiness;
            }
            assert!(Instant::now() < deadline, "worker did not finish");
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn manager_reports_preparing_then_only_ready_after_activation() {
        let installer = Arc::new(FakeInstaller::new(None, FakeResult::Ready));
        let manager = BrowserRuntimeManager::from_installer(installer).unwrap();
        let initial = manager.prepare(None).unwrap();
        assert_eq!(initial.status, BrowserRuntimeReadinessStatus::Preparing);
        assert_eq!(initial.phase, RuntimePhase::ManifestVerifying);
        let final_state = wait_until_idle(&manager);
        assert_eq!(final_state.status, BrowserRuntimeReadinessStatus::Ready);
        assert_eq!(final_state.active.unwrap().version, "150.0.1");
        assert!(final_state.error.is_none());
    }

    #[test]
    fn failed_candidate_never_replaces_existing_active_runtime() {
        let active = version("149.0.1", 1, 'a');
        let installer = Arc::new(FakeInstaller::new(Some(active.clone()), FakeResult::Failed));
        let manager = BrowserRuntimeManager::from_installer(installer).unwrap();
        manager.prepare(None).unwrap();
        let final_state = wait_until_idle(&manager);
        assert_eq!(final_state.status, BrowserRuntimeReadinessStatus::Ready);
        assert_eq!(final_state.active, Some(active));
        assert_eq!(
            final_state.error.unwrap().code,
            RuntimeErrorCode::ArchiveHashMismatch
        );
    }

    #[test]
    fn concurrent_prepare_is_rejected_without_starting_a_second_worker() {
        let installer = Arc::new(FakeInstaller::new(None, FakeResult::Ready));
        let manager = BrowserRuntimeManager::from_installer(installer.clone()).unwrap();
        manager.prepare(None).unwrap();
        assert_eq!(
            manager.prepare(None).unwrap_err().code,
            RuntimeManagerErrorCode::OperationInProgress
        );
        wait_until_idle(&manager);
        assert_eq!(installer.calls.load(Ordering::SeqCst), 1);
    }

    struct FakeMaintenanceInstaller {
        active: RuntimeVersionSummary,
        deleted: AtomicBool,
    }

    impl RuntimeInstaller for FakeMaintenanceInstaller {
        fn recover_active(
            &self,
        ) -> Result<Option<RuntimeVersionSummary>, RuntimePreparationFailure> {
            Ok((!self.deleted.load(Ordering::SeqCst)).then(|| self.active.clone()))
        }

        fn prepare(
            &self,
            _control: &DownloadControl,
            _observer: &dyn RuntimePreparationObserver,
            _force_reinstall: bool,
        ) -> Result<RuntimePreparationOutcome, RuntimePreparationStop> {
            unreachable!("maintenance fixture never prepares")
        }

        fn disk_usage(&self) -> Result<RuntimeDiskUsage, RuntimeMaintenanceError> {
            Ok(RuntimeDiskUsage {
                downloads_bytes: 10,
                candidates_bytes: 20,
                versions_bytes: 30,
                state_bytes: 4,
                other_bytes: 0,
                total_bytes: 64,
                retained_versions: 1,
                calculated_at: "2026-07-11T00:00:00Z".to_string(),
            })
        }

        fn delete_runtime(&self) -> Result<RuntimeDeleteOutcome, RuntimeMaintenanceError> {
            self.deleted.store(true, Ordering::SeqCst);
            Ok(RuntimeDeleteOutcome {
                reclaimed_bytes: 60,
                remaining_bytes: 4,
                deleted_versions: 1,
            })
        }
    }

    #[test]
    fn manager_exposes_disk_usage_and_resets_readiness_after_delete() {
        let installer = Arc::new(FakeMaintenanceInstaller {
            active: version("150.0.1", 1, 'a'),
            deleted: AtomicBool::new(false),
        });
        let manager = BrowserRuntimeManager::from_installer(installer).unwrap();

        assert_eq!(manager.disk_usage().unwrap().total_bytes, 64);
        let deleted = manager.delete_runtime(None).unwrap();

        assert_eq!(deleted.deleted_versions, 1);
        assert_eq!(
            manager.readiness().unwrap().status,
            BrowserRuntimeReadinessStatus::Unavailable
        );
        assert!(manager.readiness().unwrap().active.is_none());
    }

    #[test]
    fn manager_rejects_delete_while_runtime_preparation_is_running() {
        let installer = Arc::new(FakeInstaller::new(None, FakeResult::Ready));
        let manager = BrowserRuntimeManager::from_installer(installer).unwrap();
        manager.prepare(None).unwrap();

        assert_eq!(
            manager.delete_runtime(None).unwrap_err().code,
            RuntimeManagerErrorCode::OperationInProgress
        );
        wait_until_idle(&manager);
    }

    #[test]
    fn unavailable_manager_keeps_bounded_failure_queryable_and_rejects_mutation() {
        let manager = BrowserRuntimeManager::unavailable();

        let readiness = manager.readiness().unwrap();
        assert_eq!(readiness.status, BrowserRuntimeReadinessStatus::Failed);
        assert_eq!(
            readiness.error,
            Some(RuntimeFailure {
                code: RuntimeErrorCode::StateCorrupt,
                retryable: false,
            })
        );
        assert_eq!(
            manager.prepare(None).unwrap_err().code,
            RuntimeManagerErrorCode::StateUnavailable
        );
        assert_eq!(
            manager.disk_usage().unwrap_err().code,
            RuntimeManagerErrorCode::StateUnavailable
        );
    }
}
