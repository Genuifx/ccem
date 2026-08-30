//! In-memory foreground ownership and lifecycle fencing for native Claude sessions.

use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

mod control_ops;
mod projection_ops;

pub const MSG_LIFECYCLE_CAPABILITY: &str = "msg_lifecycle_v1";
pub const GENERIC_READY_STATUS: &str = "ready";
pub const SETTINGS_ACK_WAIT: Duration = Duration::from_secs(4);
pub const COMMAND_ADMISSION_ACK_WAIT: Duration = Duration::from_secs(4);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdapterKind {
    Negotiating,
    FullLifecycle,
    LegacySerial,
    Poisoned,
}

impl AdapterKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Negotiating => "negotiating",
            Self::FullLifecycle => "full_lifecycle",
            Self::LegacySerial => "legacy_serial",
            Self::Poisoned => "poisoned",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandPhase {
    Dispatching,
    Uncertain,
    HelperAdmitted,
    SdkQueued,
    SdkStarted,
    ResultObserved,
    ResetObserved,
    ProtocolError,
}

impl CommandPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dispatching => "dispatching",
            Self::Uncertain => "uncertain",
            Self::HelperAdmitted => "helper_admitted",
            Self::SdkQueued => "sdk_queued",
            Self::SdkStarted => "sdk_started",
            Self::ResultObserved => "result_observed",
            Self::ResetObserved => "reset_observed",
            Self::ProtocolError => "protocol_error",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdmissionError {
    Busy { active_command_id: String },
    SettingsPending { state: String },
    InteractivePending { control_request_id: String },
    ProtocolPoisoned { detail: String },
    DeliveryUncertain { pending_command_id: String },
    StaleIncarnation { expected: u64, received: u64 },
}

impl AdmissionError {
    pub fn to_message(&self) -> String {
        match self {
            Self::Busy { active_command_id } => format!(
                "NATIVE_SESSION_BUSY: command {active_command_id} still owns the foreground; the message was not sent"
            ),
            Self::SettingsPending { state } => format!(
                "SETTINGS_STALE: settings operation is {state}; the message was not sent and stays visible in the composer"
            ),
            Self::InteractivePending { control_request_id } => format!(
                "INTERACTIVE_RESPONSE_PENDING: response {control_request_id} is still awaiting an exact helper ACK; another response was not sent"
            ),
            Self::ProtocolPoisoned { detail } => format!(
                "LIFECYCLE_RECONCILE_REQUIRED: {detail}; the message was not sent"
            ),
            Self::DeliveryUncertain { pending_command_id } => format!(
                "DELIVERY_UNCERTAIN: command {pending_command_id} may have reached the helper; automatic retry is disabled"
            ),
            Self::StaleIncarnation { expected, received } => format!(
                "STALE_HELPER_INCARNATION: expected helper {expected}, received {received}; the message was not sent"
            ),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ActiveCommand {
    pub command_id: String,
    /// Queue claim revision; zero means the command did not come from that queue.
    pub admission_attempt: u64,
    pub phase: CommandPhase,
    pub helper_incarnation: u64,
    pub query_generation: Option<u64>,
    pub started_at: Instant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingsOpState {
    Pending,
    Deferred,
    Applied,
    Failed,
    ReconcileRequired,
}

impl SettingsOpState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Deferred => "deferred",
            Self::Applied => "applied",
            Self::Failed => "failed",
            Self::ReconcileRequired => "reconcile_required",
        }
    }
    fn from_wire(state: &str) -> Option<Self> {
        match state {
            "applied" => Some(Self::Applied),
            "deferred" => Some(Self::Deferred),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }

    fn blocks_dispatch(&self) -> bool {
        matches!(
            self,
            Self::Pending | Self::Deferred | Self::ReconcileRequired
        )
    }
}

#[derive(Debug, Clone)]
struct PendingSettingsOp {
    control_request_id: String,
    state: SettingsOpState,
    helper_incarnation: u64,
    query_generation: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum InteractiveOpState {
    Pending,
    Applied,
    Rejected,
    Failed,
}

impl InteractiveOpState {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Applied => "applied",
            Self::Rejected => "rejected",
            Self::Failed => "failed",
        }
    }

    fn from_wire(state: &str) -> Option<Self> {
        match state {
            "applied" => Some(Self::Applied),
            "rejected"
            | "stale_no_resolver"
            | "stale_generation"
            | "resolver_expired"
            | "generation_mismatch"
            | "prompt_type_mismatch" => Some(Self::Rejected),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
struct PendingInteractiveOp {
    control_request_id: String,
    tool_use_id: String,
    state: InteractiveOpState,
    helper_incarnation: u64,
    query_generation: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CommandFence {
    command_id: String,
    helper_incarnation: u64,
    query_generation: u64,
}

/// IPC snapshot using NativeSessionSummary's snake_case wire contract.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NativeLifecycleProjection {
    pub state_revision: u64,
    pub adapter: String,
    pub helper_incarnation: u64,
    pub active_command_id: Option<String>,
    pub active_phase: Option<String>,
    pub active_helper_incarnation: Option<u64>,
    pub settings_pending: bool,
    pub settings_state: Option<String>,
    pub queue_count: usize,
    pub delivery_uncertain_count: usize,
    pub query_generation: u64,
    pub conversation_epoch: u64,
    pub capabilities: Vec<String>,
    pub protocol_error: Option<String>,
}

#[derive(Debug)]
struct SessionCoordination {
    state_revision: u64,
    incarnation: Option<u64>,
    query_generation: Option<u64>,
    conversation_epoch: u64,
    provider_conversation_id: Option<String>,
    adapter: AdapterKind,
    capabilities: Vec<String>,
    active: Option<ActiveCommand>,
    last_terminal: Option<CommandFence>,
    last_reset: Option<CommandFence>,
    pending_settings: Option<PendingSettingsOp>,
    /// Permission changes use a separate lane from deferred environment/effort.
    pending_permission_settings: Option<PendingSettingsOp>,
    pending_interactive: Option<PendingInteractiveOp>,
    protocol_error: Option<String>,
}

impl SessionCoordination {
    fn new() -> Self {
        Self {
            state_revision: 0,
            incarnation: None,
            query_generation: None,
            conversation_epoch: 0,
            provider_conversation_id: None,
            adapter: AdapterKind::Negotiating,
            capabilities: Vec::new(),
            active: None,
            last_terminal: None,
            last_reset: None,
            pending_settings: None,
            pending_permission_settings: None,
            pending_interactive: None,
            protocol_error: None,
        }
    }

    fn bump(&mut self) {
        self.state_revision = self.state_revision.saturating_add(1);
    }

    fn release_active(&mut self) -> Option<ActiveCommand> {
        let released = self.active.take();
        if let Some(active) = &released {
            if let Some(query_generation) = active.query_generation {
                self.last_terminal = Some(CommandFence {
                    command_id: active.command_id.clone(),
                    helper_incarnation: active.helper_incarnation,
                    query_generation,
                });
            }
            self.bump();
        }
        released
    }

    fn poison(&mut self, detail: impl Into<String>) -> LifecycleDecision {
        let detail = detail.into();
        self.adapter = AdapterKind::Poisoned;
        self.protocol_error = Some(detail.clone());
        if let Some(active) = &mut self.active {
            active.phase = CommandPhase::ProtocolError;
        }
        self.bump();
        LifecycleDecision::ProtocolError { detail }
    }
}

#[derive(Debug, Default)]
pub struct NativeSessionCoordinator {
    inner: Mutex<HashMap<String, SessionCoordination>>,
    settings_signal: Condvar,
    interactive_signal: Condvar,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LifecycleDecision {
    Ignored,
    Updated,
    Released { command_id: String },
    ProtocolError { detail: String },
}

impl LifecycleDecision {
    pub fn released_command_id(&self) -> Option<&str> {
        match self {
            Self::Released { command_id } => Some(command_id),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingsWaitOutcome {
    Converged,
    Deferred,
    Failed,
    Timeout,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InteractiveWaitOutcome {
    Applied,
    Rejected,
    Failed,
    Timeout,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusDecision {
    Apply,
    Suppress,
}

fn uuid_v4() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

impl NativeSessionCoordinator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn ensure_session(&self, runtime_id: &str) {
        let mut inner = self.lock_inner();
        Self::coordination_mut(&mut inner, runtime_id);
    }

    pub fn note_queue_changed(&self, runtime_id: &str) {
        let mut inner = self.lock_inner();
        Self::coordination_mut(&mut inner, runtime_id).bump();
    }

    pub fn adapter_kind(&self, runtime_id: &str) -> Option<AdapterKind> {
        self.lock_inner()
            .get(runtime_id)
            .map(|coordination| coordination.adapter)
    }

    fn lock_inner(&self) -> std::sync::MutexGuard<'_, HashMap<String, SessionCoordination>> {
        match self.inner.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn coordination_mut<'a>(
        inner: &'a mut HashMap<String, SessionCoordination>,
        runtime_id: &str,
    ) -> &'a mut SessionCoordination {
        inner
            .entry(runtime_id.to_string())
            .or_insert_with(SessionCoordination::new)
    }

    fn admit_with_id(
        &self,
        runtime_id: &str,
        helper_incarnation: u64,
        command_id: String,
        admission_attempt: u64,
    ) -> Result<String, AdmissionError> {
        let mut inner = self.lock_inner();
        let coordination = Self::coordination_mut(&mut inner, runtime_id);
        match coordination.incarnation {
            Some(expected) if expected != helper_incarnation => {
                return Err(AdmissionError::StaleIncarnation {
                    expected,
                    received: helper_incarnation,
                });
            }
            None => coordination.incarnation = Some(helper_incarnation),
            _ => {}
        }
        if coordination.adapter == AdapterKind::Poisoned {
            return Err(AdmissionError::ProtocolPoisoned {
                detail: coordination
                    .protocol_error
                    .clone()
                    .unwrap_or_else(|| "native lifecycle is poisoned".to_string()),
            });
        }
        if let Some(active) = &coordination.active {
            return Err(
                if matches!(
                    active.phase,
                    CommandPhase::Uncertain | CommandPhase::ProtocolError
                ) {
                    AdmissionError::DeliveryUncertain {
                        pending_command_id: active.command_id.clone(),
                    }
                } else {
                    AdmissionError::Busy {
                        active_command_id: active.command_id.clone(),
                    }
                },
            );
        }
        if let Some(op) = &coordination.pending_settings {
            if op.state.blocks_dispatch() {
                return Err(AdmissionError::SettingsPending {
                    state: op.state.as_str().to_string(),
                });
            }
        }
        if let Some(op) = &coordination.pending_permission_settings {
            if op.state.blocks_dispatch() {
                return Err(AdmissionError::SettingsPending {
                    state: op.state.as_str().to_string(),
                });
            }
        }
        coordination.active = Some(ActiveCommand {
            command_id: command_id.clone(),
            admission_attempt,
            phase: CommandPhase::Dispatching,
            helper_incarnation,
            query_generation: None,
            started_at: Instant::now(),
        });
        coordination.bump();
        Ok(command_id)
    }

    pub fn register_initial_prompt(
        &self,
        runtime_id: &str,
        helper_incarnation: u64,
    ) -> Result<String, AdmissionError> {
        self.admit_with_id(runtime_id, helper_incarnation, uuid_v4(), 0)
    }

    pub fn admit_prompt(
        &self,
        runtime_id: &str,
        helper_incarnation: u64,
    ) -> Result<String, AdmissionError> {
        self.admit_with_id(runtime_id, helper_incarnation, uuid_v4(), 0)
    }

    pub fn admit_prompt_with_id(
        &self,
        runtime_id: &str,
        helper_incarnation: u64,
        client_message_id: &str,
    ) -> Result<String, AdmissionError> {
        self.admit_with_id(
            runtime_id,
            helper_incarnation,
            client_message_id.to_string(),
            0,
        )
    }

    pub fn admit_queued_prompt(
        &self,
        runtime_id: &str,
        helper_incarnation: u64,
        client_message_id: &str,
        admission_attempt: u64,
    ) -> Result<String, AdmissionError> {
        debug_assert!(admission_attempt > 0);
        self.admit_with_id(
            runtime_id,
            helper_incarnation,
            client_message_id.to_string(),
            admission_attempt,
        )
    }

    pub fn abandon_admission(
        &self,
        runtime_id: &str,
        helper_incarnation: u64,
        command_id: &str,
    ) -> bool {
        let mut inner = self.lock_inner();
        let Some(coordination) = inner.get_mut(runtime_id) else {
            return false;
        };
        let can_abandon = coordination.active.as_ref().is_some_and(|active| {
            active.command_id == command_id
                && active.helper_incarnation == helper_incarnation
                && active.query_generation.is_none()
                && active.phase == CommandPhase::Dispatching
        });
        if can_abandon {
            coordination.release_active();
        }
        can_abandon
    }

    /// Release a pre-write admission after the exact helper generation retired
    /// before the child write primitive was called. Generation retirement
    /// conservatively marks every active command uncertain; the caller's
    /// `NotStarted` evidence narrows this one command back to replay-safe.
    pub fn abandon_not_started_after_retirement(
        &self,
        runtime_id: &str,
        helper_incarnation: u64,
        command_id: &str,
    ) -> bool {
        let mut inner = self.lock_inner();
        let Some(coordination) = inner.get_mut(runtime_id) else {
            return false;
        };
        let can_abandon = coordination.active.as_ref().is_some_and(|active| {
            active.command_id == command_id
                && active.helper_incarnation == helper_incarnation
                && active.query_generation.is_none()
                && active.phase == CommandPhase::Uncertain
                && coordination.incarnation != Some(helper_incarnation)
        });
        if can_abandon {
            coordination.release_active();
            coordination.protocol_error = None;
        }
        can_abandon
    }

    pub fn mark_delivery_uncertain(
        &self,
        runtime_id: &str,
        helper_incarnation: u64,
        command_id: &str,
        detail: impl Into<String>,
    ) -> bool {
        let mut inner = self.lock_inner();
        let Some(coordination) = inner.get_mut(runtime_id) else {
            return false;
        };
        let matches = coordination.active.as_ref().is_some_and(|active| {
            active.command_id == command_id && active.helper_incarnation == helper_incarnation
        });
        if !matches {
            return false;
        }
        if let Some(active) = &mut coordination.active {
            active.phase = CommandPhase::Uncertain;
        }
        coordination.protocol_error = Some(detail.into());
        coordination.bump();
        true
    }

    pub fn expire_dispatching_admission(
        &self,
        runtime_id: &str,
        helper_incarnation: u64,
        command_id: &str,
        admission_attempt: u64,
        minimum_age: Duration,
        detail: impl Into<String>,
    ) -> bool {
        let mut inner = self.lock_inner();
        let Some(coordination) = inner.get_mut(runtime_id) else {
            return false;
        };
        let can_expire = coordination.active.as_ref().is_some_and(|active| {
            active.command_id == command_id
                && active.helper_incarnation == helper_incarnation
                && active.admission_attempt == admission_attempt
                && active.phase == CommandPhase::Dispatching
                && active.started_at.elapsed() >= minimum_age
        });
        if !can_expire {
            return false;
        }
        if let Some(active) = &mut coordination.active {
            active.phase = CommandPhase::Uncertain;
        }
        coordination.protocol_error = Some(detail.into());
        coordination.bump();
        true
    }

    fn bind_active_generation(
        coordination: &mut SessionCoordination,
        command_id: &str,
        helper_incarnation: u64,
        query_generation: u64,
    ) -> Result<bool, String> {
        let Some(active) = coordination.active.as_ref() else {
            return Ok(false);
        };
        if active.command_id != command_id || active.helper_incarnation != helper_incarnation {
            return Ok(false);
        }
        if let Some(active_generation) = active.query_generation {
            if query_generation < active_generation {
                return Ok(false);
            }
            if query_generation > active_generation {
                return Err(format!(
                    "query generation advanced from {active_generation} to {query_generation} while command {command_id} was active"
                ));
            }
            return Ok(true);
        }
        if let Some(current_generation) = coordination.query_generation {
            if query_generation < current_generation {
                return Ok(false);
            }
            if query_generation > current_generation {
                return Err(format!(
                    "command {command_id} was admitted before query generation changed from {current_generation} to {query_generation}"
                ));
            }
        } else {
            coordination.query_generation = Some(query_generation);
        }
        if let Some(active) = &mut coordination.active {
            active.query_generation = Some(query_generation);
        }
        Ok(true)
    }

    pub fn note_command_admitted(
        &self,
        runtime_id: &str,
        helper_incarnation: u64,
        command_id: &str,
        query_generation: u64,
    ) -> LifecycleDecision {
        let mut inner = self.lock_inner();
        let coordination = Self::coordination_mut(&mut inner, runtime_id);
        match Self::bind_active_generation(
            coordination,
            command_id,
            helper_incarnation,
            query_generation,
        ) {
            Ok(false) => LifecycleDecision::Ignored,
            Err(detail) => coordination.poison(detail),
            Ok(true) => {
                if let Some(active) = &mut coordination.active {
                    active.phase = CommandPhase::HelperAdmitted;
                    active.started_at = Instant::now();
                }
                coordination.bump();
                LifecycleDecision::Updated
            }
        }
    }

    pub fn note_command_rejected(
        &self,
        runtime_id: &str,
        helper_incarnation: u64,
        command_id: &str,
        query_generation: u64,
    ) -> LifecycleDecision {
        let mut inner = self.lock_inner();
        let coordination = Self::coordination_mut(&mut inner, runtime_id);
        match Self::bind_active_generation(
            coordination,
            command_id,
            helper_incarnation,
            query_generation,
        ) {
            Ok(false) => LifecycleDecision::Ignored,
            Err(detail) => coordination.poison(detail),
            Ok(true) => {
                let command_id = coordination
                    .release_active()
                    .map(|active| active.command_id)
                    .unwrap_or_default();
                LifecycleDecision::Released { command_id }
            }
        }
    }

    pub fn note_command_abandoned(
        &self,
        runtime_id: &str,
        helper_incarnation: u64,
        command_id: &str,
        query_generation: u64,
    ) -> LifecycleDecision {
        let mut inner = self.lock_inner();
        let coordination = Self::coordination_mut(&mut inner, runtime_id);
        match Self::bind_active_generation(
            coordination,
            command_id,
            helper_incarnation,
            query_generation,
        ) {
            Ok(false) => LifecycleDecision::Ignored,
            Err(detail) => coordination.poison(detail),
            Ok(true) => {
                let released = coordination.release_active();
                if released
                    .as_ref()
                    .is_some_and(|active| active.phase == CommandPhase::ProtocolError)
                    && coordination.adapter != AdapterKind::Poisoned
                {
                    coordination.protocol_error = None;
                    coordination.bump();
                }
                let command_id = released.map(|active| active.command_id).unwrap_or_default();
                LifecycleDecision::Released { command_id }
            }
        }
    }

    /// The renderer asked to interrupt command A while the helper reports a
    /// different live foreground B. This is a fail-closed ownership mismatch,
    /// but not malformed lifecycle transport: keep A owned and block new work
    /// until an exact `command_abandoned(A)` receipt (or helper retirement)
    /// reconciles it. Do not poison the negotiated adapter permanently.
    pub fn note_interrupt_target_mismatch(
        &self,
        runtime_id: &str,
        helper_incarnation: u64,
        command_id: &str,
        query_generation: u64,
        detail: impl Into<String>,
    ) -> LifecycleDecision {
        let mut inner = self.lock_inner();
        let coordination = Self::coordination_mut(&mut inner, runtime_id);
        match Self::bind_active_generation(
            coordination,
            command_id,
            helper_incarnation,
            query_generation,
        ) {
            Ok(false) => LifecycleDecision::Ignored,
            Err(detail) => coordination.poison(detail),
            Ok(true) => {
                if coordination.adapter == AdapterKind::Poisoned {
                    return LifecycleDecision::ProtocolError {
                        detail: coordination
                            .protocol_error
                            .clone()
                            .unwrap_or_else(|| "native lifecycle is poisoned".to_string()),
                    };
                }
                let detail = detail.into();
                if let Some(active) = &mut coordination.active {
                    active.phase = CommandPhase::ProtocolError;
                }
                coordination.protocol_error = Some(detail);
                coordination.bump();
                LifecycleDecision::Updated
            }
        }
    }

    /// User-confirmed abandon after the command's helper generation has been
    /// retired. This is deliberately separate from transport evidence: a new
    /// helper cannot prove what the old process executed, but an exact-ID stop
    /// action may choose to discard that uncertain receipt and continue.
    pub fn abandon_retired_command(&self, runtime_id: &str, command_id: &str) -> LifecycleDecision {
        let mut inner = self.lock_inner();
        let Some(coordination) = inner.get_mut(runtime_id) else {
            return LifecycleDecision::Ignored;
        };
        let can_abandon = coordination.active.as_ref().is_some_and(|active| {
            active.command_id == command_id
                && matches!(
                    active.phase,
                    CommandPhase::Uncertain | CommandPhase::ProtocolError
                )
                && coordination.incarnation != Some(active.helper_incarnation)
        });
        if !can_abandon {
            return LifecycleDecision::Ignored;
        }
        let command_id = coordination
            .release_active()
            .map(|active| active.command_id)
            .unwrap_or_default();
        coordination.protocol_error = None;
        LifecycleDecision::Released { command_id }
    }

    pub fn note_result_observed(
        &self,
        runtime_id: &str,
        helper_incarnation: u64,
        command_id: &str,
        query_generation: u64,
    ) -> LifecycleDecision {
        let mut inner = self.lock_inner();
        let coordination = Self::coordination_mut(&mut inner, runtime_id);
        match Self::bind_active_generation(
            coordination,
            command_id,
            helper_incarnation,
            query_generation,
        ) {
            Ok(false) => LifecycleDecision::Ignored,
            Err(detail) => coordination.poison(detail),
            Ok(true) => {
                if let Some(active) = &mut coordination.active {
                    if !matches!(
                        active.phase,
                        CommandPhase::Uncertain | CommandPhase::ProtocolError
                    ) {
                        active.phase = CommandPhase::ResultObserved;
                    }
                }
                coordination.bump();
                LifecycleDecision::Updated
            }
        }
    }

    pub fn note_legacy_terminal(
        &self,
        runtime_id: &str,
        helper_incarnation: u64,
        command_id: &str,
        query_generation: u64,
    ) -> LifecycleDecision {
        let mut inner = self.lock_inner();
        let coordination = Self::coordination_mut(&mut inner, runtime_id);
        match Self::bind_active_generation(
            coordination,
            command_id,
            helper_incarnation,
            query_generation,
        ) {
            Ok(false) => LifecycleDecision::Ignored,
            Err(detail) => coordination.poison(detail),
            Ok(true) if coordination.adapter != AdapterKind::LegacySerial => {
                coordination.poison(format!(
                    "legacy terminal received while adapter was {}",
                    coordination.adapter.as_str()
                ))
            }
            Ok(true) => {
                let command_id = coordination
                    .release_active()
                    .map(|active| active.command_id)
                    .unwrap_or_default();
                LifecycleDecision::Released { command_id }
            }
        }
    }

    pub fn note_sdk_command_state(
        &self,
        runtime_id: &str,
        helper_incarnation: u64,
        command_id: &str,
        state: &str,
        query_generation: u64,
    ) -> LifecycleDecision {
        let mut inner = self.lock_inner();
        let coordination = Self::coordination_mut(&mut inner, runtime_id);

        if state == "conversation_reset" {
            let fence = CommandFence {
                command_id: command_id.to_string(),
                helper_incarnation,
                query_generation,
            };
            let active_matches = coordination.active.as_ref().is_some_and(|active| {
                active.command_id == command_id
                    && active.helper_incarnation == helper_incarnation
                    && active
                        .query_generation
                        .is_none_or(|generation| generation == query_generation)
            });
            let terminal_matches = coordination.last_terminal.as_ref() == Some(&fence);
            if !active_matches && !terminal_matches {
                return LifecycleDecision::Ignored;
            }
            if coordination.last_reset.as_ref() != Some(&fence) {
                coordination.last_reset = Some(fence);
                coordination.conversation_epoch = coordination.conversation_epoch.saturating_add(1);
                if active_matches {
                    if let Some(active) = &mut coordination.active {
                        active.query_generation.get_or_insert(query_generation);
                        active.phase = CommandPhase::ResetObserved;
                    }
                }
                coordination.bump();
            }
            return LifecycleDecision::Updated;
        }

        let known = matches!(
            state,
            "queued" | "started" | "completed" | "cancelled" | "discarded" | "refused"
        );
        if !known {
            let matches_active = coordination.active.as_ref().is_some_and(|active| {
                active.command_id == command_id && active.helper_incarnation == helper_incarnation
            });
            return if matches_active {
                coordination.poison(format!(
                    "unknown SDK command lifecycle state {state:?} for command {command_id}"
                ))
            } else {
                LifecycleDecision::Ignored
            };
        }

        match Self::bind_active_generation(
            coordination,
            command_id,
            helper_incarnation,
            query_generation,
        ) {
            Ok(false) => LifecycleDecision::Ignored,
            Err(detail) => coordination.poison(detail),
            Ok(true) if matches!(state, "queued" | "started") => {
                if let Some(active) = &mut coordination.active {
                    active.phase = if state == "queued" {
                        CommandPhase::SdkQueued
                    } else {
                        CommandPhase::SdkStarted
                    };
                }
                coordination.bump();
                LifecycleDecision::Updated
            }
            Ok(true) if coordination.adapter != AdapterKind::FullLifecycle => {
                coordination.poison(format!(
                    "raw SDK terminal {state} received while adapter was {}",
                    coordination.adapter.as_str()
                ))
            }
            Ok(true) => {
                let command_id = coordination
                    .release_active()
                    .map(|active| active.command_id)
                    .unwrap_or_default();
                LifecycleDecision::Released { command_id }
            }
        }
    }

    pub fn note_protocol_error(
        &self,
        runtime_id: &str,
        helper_incarnation: u64,
        command_id: Option<&str>,
        detail: impl Into<String>,
    ) -> LifecycleDecision {
        let mut inner = self.lock_inner();
        let coordination = Self::coordination_mut(&mut inner, runtime_id);
        if coordination.incarnation != Some(helper_incarnation) {
            return LifecycleDecision::Ignored;
        }
        if let Some(command_id) = command_id {
            let matches = coordination
                .active
                .as_ref()
                .is_some_and(|active| active.command_id == command_id);
            if !matches {
                return LifecycleDecision::Ignored;
            }
        }
        coordination.poison(detail)
    }
}

#[cfg(test)]
#[path = "native_session_coordinator_tests.rs"]
mod tests;
