use chrono::Utc;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserRuntimeReadinessStatus {
    Unavailable,
    Preparing,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimePhase {
    Idle,
    ManifestVerifying,
    Downloading,
    Paused,
    ArchiveVerifying,
    Extracting,
    IdentityVerifying,
    SmokeTesting,
    Activating,
    Cleanup,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeProgress {
    pub completed_bytes: u64,
    pub total_bytes: u64,
}

impl RuntimeProgress {
    pub fn new(completed_bytes: u64, total_bytes: u64) -> Result<Self, RuntimeStateError> {
        if total_bytes == 0 || completed_bytes > total_bytes {
            return Err(RuntimeStateError::InvalidProgress);
        }
        Ok(Self {
            completed_bytes,
            total_bytes,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeVersionSummary {
    pub version: String,
    pub sequence: u64,
    pub manifest_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeCandidateSummary {
    pub version: String,
    pub sequence: u64,
    pub manifest_sha256: String,
}

impl From<RuntimeVersionSummary> for RuntimeCandidateSummary {
    fn from(value: RuntimeVersionSummary) -> Self {
        Self {
            version: value.version,
            sequence: value.sequence,
            manifest_sha256: value.manifest_sha256,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeErrorCode {
    ManifestSignatureInvalid,
    ManifestInvalid,
    ManifestRollbackRejected,
    UnsupportedPlatform,
    UnsupportedArchitecture,
    UnsupportedOsVersion,
    ProtocolTooOld,
    DownloadFailed,
    DownloadInterrupted,
    ArchiveSizeMismatch,
    ArchiveHashMismatch,
    ExtractionRejected,
    ExecutableIdentityMismatch,
    SmokeFailed,
    LockUnavailable,
    StateCorrupt,
    ActivationFailed,
    Io,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeFailure {
    pub code: RuntimeErrorCode,
    pub retryable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserRuntimeReadiness {
    pub status: BrowserRuntimeReadinessStatus,
    pub phase: RuntimePhase,
    pub progress: Option<RuntimeProgress>,
    pub active: Option<RuntimeVersionSummary>,
    pub candidate: Option<RuntimeCandidateSummary>,
    pub error: Option<RuntimeFailure>,
    pub checked_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeStateError {
    InvalidProgress,
    InvalidTransition,
}

#[derive(Debug, Clone)]
pub struct RuntimeStateMachine {
    active: Option<RuntimeVersionSummary>,
    candidate: Option<RuntimeCandidateSummary>,
    phase: RuntimePhase,
    progress: Option<RuntimeProgress>,
    failure: Option<RuntimeFailure>,
    checked_at: String,
}

impl RuntimeStateMachine {
    pub fn new(active: Option<RuntimeVersionSummary>) -> Self {
        Self {
            active,
            candidate: None,
            phase: RuntimePhase::Idle,
            progress: None,
            failure: None,
            checked_at: Utc::now().to_rfc3339(),
        }
    }

    pub fn begin_candidate(
        &mut self,
        candidate: RuntimeCandidateSummary,
    ) -> Result<(), RuntimeStateError> {
        if !matches!(
            self.phase,
            RuntimePhase::Idle | RuntimePhase::ManifestVerifying
        ) || self.candidate.is_some()
        {
            return Err(RuntimeStateError::InvalidTransition);
        }
        self.candidate = Some(candidate);
        self.phase = RuntimePhase::ManifestVerifying;
        self.progress = None;
        self.failure = None;
        self.touch();
        Ok(())
    }

    pub fn begin_manifest_verification(&mut self) -> Result<(), RuntimeStateError> {
        if self.phase != RuntimePhase::Idle || self.candidate.is_some() {
            return Err(RuntimeStateError::InvalidTransition);
        }
        self.phase = RuntimePhase::ManifestVerifying;
        self.progress = None;
        self.failure = None;
        self.touch();
        Ok(())
    }

    pub fn finish_without_candidate(&mut self) -> Result<(), RuntimeStateError> {
        if self.phase != RuntimePhase::ManifestVerifying || self.candidate.is_some() {
            return Err(RuntimeStateError::InvalidTransition);
        }
        self.phase = RuntimePhase::Idle;
        self.progress = None;
        self.failure = None;
        self.touch();
        Ok(())
    }

    pub fn set_phase(&mut self, phase: RuntimePhase) -> Result<(), RuntimeStateError> {
        if self.candidate.is_none()
            || phase == RuntimePhase::Idle
            || !valid_phase_transition(self.phase, phase)
        {
            return Err(RuntimeStateError::InvalidTransition);
        }
        self.phase = phase;
        if !matches!(phase, RuntimePhase::Downloading | RuntimePhase::Paused) {
            self.progress = None;
        }
        self.touch();
        Ok(())
    }

    pub fn set_progress(&mut self, progress: RuntimeProgress) -> Result<(), RuntimeStateError> {
        if self.candidate.is_none()
            || !matches!(self.phase, RuntimePhase::Downloading | RuntimePhase::Paused)
        {
            return Err(RuntimeStateError::InvalidTransition);
        }
        self.progress = Some(progress);
        self.touch();
        Ok(())
    }

    pub fn fail_candidate(&mut self, failure: RuntimeFailure) -> Result<(), RuntimeStateError> {
        if self.candidate.is_none() {
            return Err(RuntimeStateError::InvalidTransition);
        }
        self.phase = RuntimePhase::Idle;
        self.progress = None;
        self.failure = Some(failure);
        self.touch();
        Ok(())
    }

    pub fn fail_without_candidate(
        &mut self,
        failure: RuntimeFailure,
    ) -> Result<(), RuntimeStateError> {
        if self.candidate.is_some()
            || !matches!(
                self.phase,
                RuntimePhase::Idle | RuntimePhase::ManifestVerifying
            )
        {
            return Err(RuntimeStateError::InvalidTransition);
        }
        self.phase = RuntimePhase::Idle;
        self.progress = None;
        self.failure = Some(failure);
        self.touch();
        Ok(())
    }

    pub fn activate(&mut self, active: RuntimeVersionSummary) -> Result<(), RuntimeStateError> {
        if self.phase != RuntimePhase::Activating {
            return Err(RuntimeStateError::InvalidTransition);
        }
        let candidate = self
            .candidate
            .as_ref()
            .ok_or(RuntimeStateError::InvalidTransition)?;
        if candidate.version != active.version
            || candidate.sequence != active.sequence
            || candidate.manifest_sha256 != active.manifest_sha256
        {
            return Err(RuntimeStateError::InvalidTransition);
        }
        self.active = Some(active);
        self.candidate = None;
        self.phase = RuntimePhase::Idle;
        self.progress = None;
        self.failure = None;
        self.touch();
        Ok(())
    }

    pub fn clear_failed_candidate(&mut self) {
        self.candidate = None;
        self.failure = None;
        self.phase = RuntimePhase::Idle;
        self.progress = None;
        self.touch();
    }

    pub fn clear_active(&mut self) {
        self.active = None;
        self.touch();
    }

    pub fn readiness(&self) -> BrowserRuntimeReadiness {
        let status = if self.active.is_some() {
            // A candidate update is independent from the currently activated, verified runtime.
            BrowserRuntimeReadinessStatus::Ready
        } else if self.phase != RuntimePhase::Idle {
            BrowserRuntimeReadinessStatus::Preparing
        } else if self.failure.is_some() {
            BrowserRuntimeReadinessStatus::Failed
        } else {
            BrowserRuntimeReadinessStatus::Unavailable
        };
        BrowserRuntimeReadiness {
            status,
            phase: self.phase,
            progress: self.progress.clone(),
            active: self.active.clone(),
            candidate: self.candidate.clone(),
            error: self.failure.clone(),
            checked_at: self.checked_at.clone(),
        }
    }

    fn touch(&mut self) {
        self.checked_at = Utc::now().to_rfc3339();
    }
}

fn valid_phase_transition(from: RuntimePhase, to: RuntimePhase) -> bool {
    matches!(
        (from, to),
        (
            RuntimePhase::ManifestVerifying,
            RuntimePhase::Downloading | RuntimePhase::ArchiveVerifying
        ) | (RuntimePhase::Downloading, RuntimePhase::Paused)
            | (RuntimePhase::Downloading, RuntimePhase::ArchiveVerifying)
            | (RuntimePhase::Paused, RuntimePhase::Downloading)
            | (RuntimePhase::ArchiveVerifying, RuntimePhase::Extracting)
            | (RuntimePhase::Extracting, RuntimePhase::IdentityVerifying)
            | (RuntimePhase::IdentityVerifying, RuntimePhase::SmokeTesting)
            | (RuntimePhase::SmokeTesting, RuntimePhase::Activating)
            | (RuntimePhase::Activating, RuntimePhase::Cleanup)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(name: &str, sequence: u64, hash_byte: char) -> RuntimeVersionSummary {
        RuntimeVersionSummary {
            version: name.to_string(),
            sequence,
            manifest_sha256: hash_byte.to_string().repeat(64),
        }
    }

    fn advance_to_activation(state: &mut RuntimeStateMachine) {
        for phase in [
            RuntimePhase::Downloading,
            RuntimePhase::ArchiveVerifying,
            RuntimePhase::Extracting,
            RuntimePhase::IdentityVerifying,
            RuntimePhase::SmokeTesting,
            RuntimePhase::Activating,
        ] {
            state.set_phase(phase).unwrap();
        }
    }

    #[test]
    fn top_level_states_preserve_wire_contract() {
        for (status, expected) in [
            (BrowserRuntimeReadinessStatus::Unavailable, "unavailable"),
            (BrowserRuntimeReadinessStatus::Preparing, "preparing"),
            (BrowserRuntimeReadinessStatus::Ready, "ready"),
            (BrowserRuntimeReadinessStatus::Failed, "failed"),
        ] {
            assert_eq!(serde_json::to_value(status).unwrap(), expected);
        }
    }

    #[test]
    fn initial_failure_is_failed_but_candidate_failure_keeps_existing_active_ready() {
        let candidate = RuntimeCandidateSummary::from(version("150.0.1", 1, 'a'));
        let failure = RuntimeFailure {
            code: RuntimeErrorCode::ArchiveHashMismatch,
            retryable: true,
        };

        let mut first_install = RuntimeStateMachine::new(None);
        first_install.begin_candidate(candidate.clone()).unwrap();
        first_install.fail_candidate(failure.clone()).unwrap();
        assert_eq!(
            first_install.readiness().status,
            BrowserRuntimeReadinessStatus::Failed
        );

        let active = version("149.0.1", 1, 'b');
        let mut update = RuntimeStateMachine::new(Some(active.clone()));
        update.begin_candidate(candidate).unwrap();
        update.fail_candidate(failure.clone()).unwrap();
        let readiness = update.readiness();
        assert_eq!(readiness.status, BrowserRuntimeReadinessStatus::Ready);
        assert_eq!(readiness.active, Some(active));
        assert_eq!(readiness.error, Some(failure));
        assert_eq!(readiness.candidate.unwrap().version, "150.0.1");
    }

    #[test]
    fn active_runtime_stays_ready_while_candidate_is_preparing() {
        let active = version("149.0.1", 1, 'a');
        let mut state = RuntimeStateMachine::new(Some(active.clone()));
        state
            .begin_candidate(RuntimeCandidateSummary::from(version("150.0.1", 2, 'b')))
            .unwrap();
        state.set_phase(RuntimePhase::Downloading).unwrap();
        state
            .set_progress(RuntimeProgress::new(5, 10).unwrap())
            .unwrap();
        let readiness = state.readiness();
        assert_eq!(readiness.status, BrowserRuntimeReadinessStatus::Ready);
        assert_eq!(readiness.phase, RuntimePhase::Downloading);
        assert_eq!(readiness.active, Some(active));
        assert_eq!(readiness.progress.unwrap().completed_bytes, 5);
    }

    #[test]
    fn only_matching_candidate_can_be_activated() {
        let mut state = RuntimeStateMachine::new(None);
        state
            .begin_candidate(RuntimeCandidateSummary::from(version("150.0.1", 2, 'a')))
            .unwrap();
        advance_to_activation(&mut state);
        assert_eq!(
            state.activate(version("150.0.2", 2, 'a')),
            Err(RuntimeStateError::InvalidTransition)
        );
        state.activate(version("150.0.1", 2, 'a')).unwrap();
        assert_eq!(
            state.readiness().status,
            BrowserRuntimeReadinessStatus::Ready
        );
        assert!(state.readiness().candidate.is_none());
    }

    #[test]
    fn progress_is_bounded_and_phase_scoped() {
        assert_eq!(
            RuntimeProgress::new(11, 10),
            Err(RuntimeStateError::InvalidProgress)
        );
        let mut state = RuntimeStateMachine::new(None);
        state
            .begin_candidate(RuntimeCandidateSummary::from(version("150.0.1", 2, 'a')))
            .unwrap();
        assert_eq!(
            state.set_progress(RuntimeProgress::new(1, 10).unwrap()),
            Err(RuntimeStateError::InvalidTransition)
        );
        assert_eq!(
            state.set_phase(RuntimePhase::SmokeTesting),
            Err(RuntimeStateError::InvalidTransition)
        );
    }
}
