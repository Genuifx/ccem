use super::backend::{
    BackendFailure, SemanticBrowserBackend, SemanticBrowserCommand, SemanticBrowserResult,
    SemanticCommandAuditSummary,
};
use super::control::{ControlErrorCode, HandoffControl};
use super::policy::{
    authorize_browser_request, BrowserDataProvenance, BrowserGrantBinding, BrowserPolicyEffect,
    BrowserPolicyRequest, BrowserPolicySurface, NormalizedOrigin, TrustedCrossOriginConfirmation,
    TrustedOriginGrant,
};
use serde::Serialize;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

#[path = "capability_audit_sink.rs"]
mod audit_sink;
pub(super) use audit_sink::JsonlSemanticAuditSink;

/// Trusted execution state supplied by the Login Browser session registry, never by the command.
/// This type deliberately does not implement `Deserialize`.
pub(super) struct SemanticExecutionContext<'a> {
    binding: &'a BrowserGrantBinding,
    current_url: &'a str,
    source_data_origin: Option<&'a NormalizedOrigin>,
    data_provenance: BrowserDataProvenance,
    request_id: Option<&'a str>,
    actor_id: Option<&'a str>,
    permission_epoch: Option<u64>,
}

impl<'a> SemanticExecutionContext<'a> {
    pub(super) fn new_trusted(binding: &'a BrowserGrantBinding, current_url: &'a str) -> Self {
        Self {
            binding,
            current_url,
            source_data_origin: None,
            data_provenance: BrowserDataProvenance::UntrackedOrSameOrigin,
            request_id: None,
            actor_id: None,
            permission_epoch: None,
        }
    }

    pub(super) fn with_source_data_origin(mut self, origin: &'a NormalizedOrigin) -> Self {
        self.source_data_origin = Some(origin);
        self
    }

    pub(super) fn with_data_provenance(mut self, provenance: BrowserDataProvenance) -> Self {
        self.data_provenance = provenance;
        self
    }

    pub(super) fn with_request_id(mut self, request_id: &'a str) -> Self {
        self.request_id = Some(request_id);
        self
    }

    pub(super) fn with_actor_id(mut self, actor_id: &'a str) -> Self {
        self.actor_id = Some(actor_id);
        self
    }

    pub(super) fn with_permission_epoch(mut self, permission_epoch: u64) -> Self {
        self.permission_epoch = Some(permission_epoch);
        self
    }

    pub(super) fn binding(&self) -> &BrowserGrantBinding {
        self.binding
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PermissionFailure {
    code: &'static str,
}

impl PermissionFailure {
    pub(super) fn denied() -> Self {
        Self {
            code: "permission_denied",
        }
    }

    fn changed() -> Self {
        Self {
            code: "permission_changed",
        }
    }
}

/// Opaque proof that one semantic command was authorized against one permission epoch.
///
/// The service must revalidate this ticket after `begin_operation`: a permission update may race
/// between the initial permission decision and the control boundary issuing a cancellation token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct PermissionAuthorization {
    epoch: u64,
    permission_tool: &'static str,
}

pub(super) trait SemanticPermissionGate: Send + Sync {
    fn authorize(
        &self,
        context: &SemanticExecutionContext<'_>,
        command: &SemanticBrowserCommand,
    ) -> Result<PermissionAuthorization, PermissionFailure>;

    fn revalidate(
        &self,
        context: &SemanticExecutionContext<'_>,
        command: &SemanticBrowserCommand,
        authorization: PermissionAuthorization,
    ) -> Result<(), PermissionFailure>;
}

#[derive(Debug)]
struct BrowserPermissionAuthorityState {
    revision: u64,
    mode: String,
}

/// Per-native-runtime permission authority. Tickets are opaque, in-process proofs and become
/// unusable as soon as the trusted runtime settings advance to a newer revision.
#[derive(Debug, Clone)]
pub(crate) struct BrowserPermissionAuthority {
    state: Arc<RwLock<BrowserPermissionAuthorityState>>,
}

impl BrowserPermissionAuthority {
    pub(crate) fn new(permission_mode: impl Into<String>) -> Self {
        Self {
            state: Arc::new(RwLock::new(BrowserPermissionAuthorityState {
                revision: 1,
                mode: permission_mode.into(),
            })),
        }
    }

    pub(crate) fn current_ticket(
        &self,
    ) -> Result<BrowserPermissionAuthorityTicket, PermissionFailure> {
        let state = self.state.read().map_err(|_| PermissionFailure::denied())?;
        Ok(BrowserPermissionAuthorityTicket {
            source: Arc::clone(&self.state),
            revision: state.revision,
            mode: state.mode.clone(),
        })
    }

    pub(crate) fn update(
        &self,
        permission_mode: impl Into<String>,
    ) -> Result<BrowserPermissionAuthorityTicket, PermissionFailure> {
        self.update_with_invalidation(permission_mode, |_| true)
    }

    /// Emergency-only authority retirement. Unlike the normal linearized update, this never
    /// waits behind an in-flight read proof; callers must separately stop the verified runtime
    /// domain and clean up its browser session when the lock is busy.
    pub(crate) fn try_update(
        &self,
        permission_mode: impl Into<String>,
    ) -> Result<BrowserPermissionAuthorityTicket, PermissionFailure> {
        let permission_mode = permission_mode.into();
        let mut state = self
            .state
            .try_write()
            .map_err(|_| PermissionFailure::denied())?;
        if state.mode != permission_mode {
            state.revision = state
                .revision
                .checked_add(1)
                .ok_or_else(PermissionFailure::denied)?;
            state.mode = permission_mode;
        }
        Ok(BrowserPermissionAuthorityTicket {
            source: Arc::clone(&self.state),
            revision: state.revision,
            mode: state.mode.clone(),
        })
    }

    pub(crate) fn update_with_invalidation<F>(
        &self,
        permission_mode: impl Into<String>,
        invalidate_preview: F,
    ) -> Result<BrowserPermissionAuthorityTicket, PermissionFailure>
    where
        F: FnOnce(u64) -> bool,
    {
        let permission_mode = permission_mode.into();
        let mut state = self
            .state
            .write()
            .map_err(|_| PermissionFailure::denied())?;
        if state.mode != permission_mode {
            let next_revision = state
                .revision
                .checked_add(1)
                .ok_or_else(PermissionFailure::denied)?;
            // Keep the authority write lock held across Preview token invalidation. A bound
            // Preview begin/effect proof therefore linearizes entirely before or after this
            // revision change, never in the gap between the two states.
            if !invalidate_preview(next_revision) {
                return Err(PermissionFailure::denied());
            }
            state.revision = next_revision;
            state.mode = permission_mode;
        }
        Ok(BrowserPermissionAuthorityTicket {
            source: Arc::clone(&self.state),
            revision: state.revision,
            mode: state.mode.clone(),
        })
    }
}

#[derive(Debug, Clone)]
pub(crate) struct BrowserPermissionAuthorityTicket {
    source: Arc<RwLock<BrowserPermissionAuthorityState>>,
    revision: u64,
    mode: String,
}

impl BrowserPermissionAuthorityTicket {
    pub(crate) fn mode(&self) -> &str {
        &self.mode
    }

    pub(crate) fn validate_current(&self) -> Result<(), PermissionFailure> {
        if self.is_current()? {
            Ok(())
        } else {
            Err(PermissionFailure::changed())
        }
    }

    pub(crate) fn revision(&self) -> u64 {
        self.revision
    }

    pub(crate) fn with_current_revision<T>(
        &self,
        expected_revision: u64,
        operation: impl FnOnce() -> T,
    ) -> Result<T, PermissionFailure> {
        let state = self
            .source
            .read()
            .map_err(|_| PermissionFailure::denied())?;
        if expected_revision != self.revision
            || state.revision != self.revision
            || state.mode != self.mode
        {
            return Err(PermissionFailure::changed());
        }
        Ok(operation())
    }

    fn is_current(&self) -> Result<bool, PermissionFailure> {
        let state = self
            .source
            .read()
            .map_err(|_| PermissionFailure::denied())?;
        Ok(state.revision == self.revision && state.mode == self.mode)
    }

    fn same_authority(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.source, &other.source)
            && self.revision == other.revision
            && self.mode == other.mode
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PermissionAuthorityBinding {
    epoch: u64,
}

impl PermissionAuthorityBinding {
    pub(crate) fn epoch(self) -> u64 {
        self.epoch
    }
}

/// Production permission adapter. Command-to-tool mapping is closed inside Rust; no external tool
/// string reaches the existing browser permission policy.
#[derive(Debug)]
struct PermissionState {
    mode: String,
    epoch: u64,
    authority: Option<BrowserPermissionAuthorityTicket>,
}

pub(super) struct CcemPermissionGate {
    state: RwLock<PermissionState>,
}

impl CcemPermissionGate {
    pub(super) fn new(permission_mode: impl Into<String>) -> Self {
        Self {
            state: RwLock::new(PermissionState {
                mode: permission_mode.into(),
                epoch: 1,
                authority: None,
            }),
        }
    }

    /// Persist a new permission epoch and tell the caller whether active operations must be
    /// cancelled. The caller owns the bounded cancellation and emergency-stop boundary, which
    /// keeps permission policy free of a dependency on Login Browser control/session types.
    pub(super) fn set_permission_mode(
        &self,
        permission_mode: impl Into<String>,
    ) -> Result<bool, PermissionFailure> {
        self.set_permission_mode_and_invalidate(permission_mode, || {})
    }

    /// Update permission authority and invalidate active operations before the new epoch becomes
    /// observable. The callback may perform a fixed-deadline owner acknowledgement; accepting a
    /// callback keeps this gate independent of session/control ownership types.
    pub(super) fn set_permission_mode_and_invalidate<F>(
        &self,
        permission_mode: impl Into<String>,
        invalidate_active: F,
    ) -> Result<bool, PermissionFailure>
    where
        F: FnOnce(),
    {
        let permission_mode = permission_mode.into();
        let mut state = self
            .state
            .write()
            .map_err(|_| PermissionFailure::denied())?;
        if state.mode == permission_mode {
            return Ok(false);
        }
        state.epoch = state
            .epoch
            .checked_add(1)
            .ok_or_else(PermissionFailure::denied)?;
        state.mode = permission_mode;
        state.authority = None;
        // Keep the permission write lock held so no authorization can observe the new epoch until
        // every token issued under the previous epoch has been invalidated.
        invalidate_active();
        Ok(true)
    }

    pub(crate) fn synchronize_authority_and_invalidate<F>(
        &self,
        authority: BrowserPermissionAuthorityTicket,
        invalidate_active: F,
    ) -> Result<PermissionAuthorityBinding, PermissionFailure>
    where
        F: FnOnce(),
    {
        if !authority.is_current()? {
            return Err(PermissionFailure::changed());
        }
        let mut state = self
            .state
            .write()
            .map_err(|_| PermissionFailure::denied())?;
        if !authority.is_current()? {
            return Err(PermissionFailure::changed());
        }
        if state
            .authority
            .as_ref()
            .is_some_and(|current| current.same_authority(&authority))
        {
            return Ok(PermissionAuthorityBinding { epoch: state.epoch });
        }
        state.epoch = state
            .epoch
            .checked_add(1)
            .ok_or_else(PermissionFailure::denied)?;
        state.mode = authority.mode.clone();
        state.authority = Some(authority);
        invalidate_active();
        Ok(PermissionAuthorityBinding { epoch: state.epoch })
    }
}

impl SemanticPermissionGate for CcemPermissionGate {
    fn authorize(
        &self,
        context: &SemanticExecutionContext<'_>,
        command: &SemanticBrowserCommand,
    ) -> Result<PermissionAuthorization, PermissionFailure> {
        let state = self.state.read().map_err(|_| PermissionFailure::denied())?;
        if context
            .permission_epoch
            .is_some_and(|expected| expected != state.epoch)
            || state
                .authority
                .as_ref()
                .is_some_and(|authority| authority.is_current() != Ok(true))
        {
            return Err(PermissionFailure::changed());
        }
        crate::browser::authorize_browser_tool(&state.mode, command.permission_tool())
            .map_err(|_| PermissionFailure::denied())?;
        Ok(PermissionAuthorization {
            epoch: state.epoch,
            permission_tool: command.permission_tool(),
        })
    }

    fn revalidate(
        &self,
        context: &SemanticExecutionContext<'_>,
        command: &SemanticBrowserCommand,
        authorization: PermissionAuthorization,
    ) -> Result<(), PermissionFailure> {
        let state = self.state.read().map_err(|_| PermissionFailure::denied())?;
        if state.epoch != authorization.epoch
            || context
                .permission_epoch
                .is_some_and(|expected| expected != state.epoch)
            || command.permission_tool() != authorization.permission_tool
            || state
                .authority
                .as_ref()
                .is_some_and(|authority| authority.is_current() != Ok(true))
        {
            return Err(PermissionFailure::changed());
        }
        crate::browser::authorize_browser_tool(&state.mode, command.permission_tool())
            .map_err(|_| PermissionFailure::denied())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct OriginAuthorization {
    policy_code: String,
    target_origin: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct OriginFailure {
    code: String,
}

impl OriginFailure {
    pub(super) fn new(code: impl Into<String>) -> Self {
        Self { code: code.into() }
    }
}

pub(super) trait SemanticOriginGate: Send + Sync {
    fn authorize(
        &self,
        context: &SemanticExecutionContext<'_>,
        command: &SemanticBrowserCommand,
    ) -> Result<OriginAuthorization, OriginFailure>;
}

/// Production origin-policy adapter around the single Login Browser origin decision function.
pub(super) struct TrustedOriginPolicyGate {
    grant: TrustedOriginGrant,
    confirmation: Mutex<Option<TrustedCrossOriginConfirmation>>,
}

impl TrustedOriginPolicyGate {
    pub(super) fn new(grant: TrustedOriginGrant) -> Self {
        Self {
            grant,
            confirmation: Mutex::new(None),
        }
    }

    pub(super) fn install_confirmation(
        &self,
        confirmation: TrustedCrossOriginConfirmation,
    ) -> Result<(), OriginFailure> {
        let mut slot = self
            .confirmation
            .lock()
            .map_err(|_| OriginFailure::new("origin_policy_unavailable"))?;
        *slot = Some(confirmation);
        Ok(())
    }
}

impl SemanticOriginGate for TrustedOriginPolicyGate {
    fn authorize(
        &self,
        context: &SemanticExecutionContext<'_>,
        command: &SemanticBrowserCommand,
    ) -> Result<OriginAuthorization, OriginFailure> {
        let target_url = command.navigation_url().unwrap_or(context.current_url);
        let request = BrowserPolicyRequest {
            binding: context.binding,
            surface: if command.navigation_url().is_some() {
                BrowserPolicySurface::InitialNavigation
            } else {
                BrowserPolicySurface::Mutation
            },
            effect: if command.is_write_capability() {
                BrowserPolicyEffect::Mutate
            } else {
                BrowserPolicyEffect::Navigate
            },
            target_url,
            source_data_origin: context.source_data_origin,
            data_provenance: context.data_provenance,
            // Pause/cancel authority was already checked immediately before this policy step.
            paused: false,
        };
        let mut confirmation = self
            .confirmation
            .lock()
            .map_err(|_| OriginFailure::new("origin_policy_unavailable"))?;
        let decision = authorize_browser_request(&self.grant, request, confirmation.as_mut());
        if !decision.allowed {
            return Err(OriginFailure::new(decision.code.as_str()));
        }
        Ok(OriginAuthorization {
            policy_code: decision.code.as_str().to_string(),
            target_origin: decision.target_origin,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct AuditFailure;

#[derive(Debug, Clone, Serialize)]
pub(super) struct AuditPreRecord {
    operation_id: u64,
    request_id: String,
    actor_id: String,
    created_at: String,
    workspace_identity: String,
    profile_id: String,
    session_id: String,
    handoff_epoch: u64,
    decision: AuditDecision,
    cause_code: String,
    origin_policy_code: Option<String>,
    target_origin: Option<String>,
    command: SemanticCommandAuditSummary,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum AuditDecision {
    Allowed,
    Denied,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct AuditResultRecord {
    operation_id: u64,
    completed_at: String,
    success: bool,
    outcome_code: String,
}

pub(super) trait SemanticAuditSink: Send + Sync {
    /// This write must be durable before returning success; otherwise no backend effect may run.
    fn write_pre(&self, record: &AuditPreRecord) -> Result<(), AuditFailure>;

    fn write_result(&self, record: &AuditResultRecord) -> Result<(), AuditFailure>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CapabilityErrorCode {
    InvalidCommand,
    GrantDenied,
    PermissionDenied,
    ControlDenied,
    OriginDenied,
    PreAuditFailed,
    BackendFailed,
    ResultAuditFailed,
}

impl CapabilityErrorCode {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::InvalidCommand => "invalid_command",
            Self::GrantDenied => "grant_denied",
            Self::PermissionDenied => "permission_denied",
            Self::ControlDenied => "control_denied",
            Self::OriginDenied => "origin_denied",
            Self::PreAuditFailed => "pre_audit_failed",
            Self::BackendFailed => "backend_failed",
            Self::ResultAuditFailed => "result_audit_failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct CapabilityError {
    pub(super) code: CapabilityErrorCode,
    pub(super) cause_code: String,
}

impl CapabilityError {
    fn new(code: CapabilityErrorCode, cause_code: impl Into<String>) -> Self {
        Self {
            code,
            cause_code: cause_code.into(),
        }
    }
}

impl fmt::Display for CapabilityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code.as_str(), self.cause_code)
    }
}

impl std::error::Error for CapabilityError {}

/// One choke point for all Agent-driven Login Browser effects.
///
/// The call order is intentionally visible and fixed:
/// grant -> permission -> pause/cancel -> origin -> durable pre-audit -> backend -> result-audit.
pub(super) struct SemanticCapabilityService<C: ?Sized, P: ?Sized, O: ?Sized, A: ?Sized, B: ?Sized> {
    control: Arc<C>,
    permission: Arc<P>,
    origin: Arc<O>,
    audit: Arc<A>,
    backend: Arc<B>,
    next_operation_id: Arc<AtomicU64>,
}

impl<C, P, O, A, B> SemanticCapabilityService<C, P, O, A, B>
where
    C: HandoffControl + ?Sized,
    P: SemanticPermissionGate + ?Sized,
    O: SemanticOriginGate + ?Sized,
    A: SemanticAuditSink + ?Sized,
    B: SemanticBrowserBackend + ?Sized,
{
    pub(super) fn new(
        control: Arc<C>,
        permission: Arc<P>,
        origin: Arc<O>,
        audit: Arc<A>,
        backend: Arc<B>,
    ) -> Self {
        Self::new_with_counter(
            control,
            permission,
            origin,
            audit,
            backend,
            Arc::new(AtomicU64::new(1)),
        )
    }

    pub(super) fn new_with_counter(
        control: Arc<C>,
        permission: Arc<P>,
        origin: Arc<O>,
        audit: Arc<A>,
        backend: Arc<B>,
        next_operation_id: Arc<AtomicU64>,
    ) -> Self {
        Self {
            control,
            permission,
            origin,
            audit,
            backend,
            next_operation_id,
        }
    }

    pub(super) fn execute(
        &self,
        context: &SemanticExecutionContext<'_>,
        command: SemanticBrowserCommand,
    ) -> Result<SemanticBrowserResult, CapabilityError> {
        let operation_id = self.next_operation_id.fetch_add(1, Ordering::Relaxed);
        if let Err(error) = command.validate() {
            let error = CapabilityError::new(
                CapabilityErrorCode::InvalidCommand,
                match error.code {
                    super::backend::SemanticCommandErrorCode::InvalidInput => "invalid_input",
                    super::backend::SemanticCommandErrorCode::InvalidTimeout => "invalid_timeout",
                },
            );
            return self.reject_with_audit(context, &command, operation_id, error);
        }

        // Do not reorder these authority gates. Every denial is durably decision-audited before it
        // returns, but no denied request reaches the browser backend.
        if let Err(error) = self.control.validate_grant(context.binding) {
            return self.reject_with_audit(
                context,
                &command,
                operation_id,
                map_control_error(error.code, true),
            );
        }
        let permission_authorization = match self.permission.authorize(context, &command) {
            Ok(authorization) => authorization,
            Err(error) => {
                return self.reject_with_audit(
                    context,
                    &command,
                    operation_id,
                    CapabilityError::new(CapabilityErrorCode::PermissionDenied, error.code),
                )
            }
        };
        let cancellation = match self
            .control
            .begin_operation(context.binding, command.is_write_capability())
        {
            Ok(cancellation) => cancellation,
            Err(error) => {
                return self.reject_with_audit(
                    context,
                    &command,
                    operation_id,
                    map_control_error(error.code, false),
                )
            }
        };
        if let Err(error) = self
            .permission
            .revalidate(context, &command, permission_authorization)
        {
            return self.reject_with_audit(
                context,
                &command,
                operation_id,
                CapabilityError::new(CapabilityErrorCode::PermissionDenied, error.code),
            );
        }
        let origin = match self.origin.authorize(context, &command) {
            Ok(origin) => origin,
            Err(error) => {
                return self.reject_with_audit(
                    context,
                    &command,
                    operation_id,
                    CapabilityError::new(CapabilityErrorCode::OriginDenied, error.code),
                )
            }
        };

        let pre_record = build_decision_record(
            context,
            &command,
            operation_id,
            AuditDecision::Allowed,
            "authorized",
            Some(origin),
        );
        if self.audit.write_pre(&pre_record).is_err() {
            self.control.mark_audit_degraded();
            return Err(CapabilityError::new(
                CapabilityErrorCode::PreAuditFailed,
                "audit_unavailable",
            ));
        }

        // The backend must also check the token before each effect and use wait_cancelled for
        // waits. This service-side check closes cancellation that arrived before backend entry.
        let outcome = if cancellation.is_cancelled() {
            Err(BackendFailure::cancelled())
        } else {
            self.backend.execute(&command, &cancellation)
        }
        .and_then(|result| {
            result.validate_for(&command)?;
            Ok(result)
        });
        let (success, outcome_code) = match &outcome {
            Ok(_) => (true, "completed".to_string()),
            Err(error) => (false, error.code.as_str().to_string()),
        };
        let result_record = AuditResultRecord {
            operation_id,
            completed_at: chrono::Utc::now().to_rfc3339(),
            success,
            outcome_code,
        };
        if self.audit.write_result(&result_record).is_err() {
            self.control.mark_audit_degraded();
            return Err(CapabilityError::new(
                CapabilityErrorCode::ResultAuditFailed,
                "effect_outcome_uncertain_do_not_retry",
            ));
        }

        outcome.map_err(|error| {
            CapabilityError::new(CapabilityErrorCode::BackendFailed, error.code.as_str())
        })
    }

    fn reject_with_audit(
        &self,
        context: &SemanticExecutionContext<'_>,
        command: &SemanticBrowserCommand,
        operation_id: u64,
        error: CapabilityError,
    ) -> Result<SemanticBrowserResult, CapabilityError> {
        let record = build_decision_record(
            context,
            command,
            operation_id,
            AuditDecision::Denied,
            &error.cause_code,
            None,
        );
        if self.audit.write_pre(&record).is_err() {
            self.control.mark_audit_degraded();
            return Err(CapabilityError::new(
                CapabilityErrorCode::PreAuditFailed,
                "audit_unavailable",
            ));
        }
        Err(error)
    }
}

fn build_decision_record(
    context: &SemanticExecutionContext<'_>,
    command: &SemanticBrowserCommand,
    operation_id: u64,
    decision: AuditDecision,
    cause_code: &str,
    origin: Option<OriginAuthorization>,
) -> AuditPreRecord {
    let (origin_policy_code, target_origin) = origin
        .map(|origin| {
            (
                safe_policy_code(&origin.policy_code),
                origin
                    .target_origin
                    .filter(|value| value.chars().count() <= 512),
            )
        })
        .unwrap_or((None, None));
    let mut command = command.audit_summary();
    command.target = command.target.and_then(|target| safe_audit_target(&target));
    AuditPreRecord {
        operation_id,
        request_id: context
            .request_id
            .and_then(safe_request_id)
            .unwrap_or_else(|| "unknown_request".to_string()),
        actor_id: context
            .actor_id
            .and_then(safe_request_id)
            .unwrap_or_else(|| "unknown_actor".to_string()),
        created_at: chrono::Utc::now().to_rfc3339(),
        workspace_identity: context.binding.workspace_identity().to_string(),
        profile_id: context.binding.profile_id().to_string(),
        session_id: context.binding.session_id().to_string(),
        handoff_epoch: context.binding.handoff_epoch(),
        decision,
        cause_code: safe_policy_code(cause_code).unwrap_or_else(|| "policy_denied".to_string()),
        origin_policy_code,
        target_origin,
        command,
    }
}

fn safe_request_id(value: &str) -> Option<String> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        None
    } else {
        Some(value.to_string())
    }
}

fn safe_policy_code(value: &str) -> Option<String> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
    {
        None
    } else {
        Some(value.to_string())
    }
}

fn safe_audit_target(value: &str) -> Option<String> {
    if value.is_empty()
        || value.len() > 256
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        None
    } else {
        Some(value.to_string())
    }
}

fn map_control_error(code: ControlErrorCode, grant_stage: bool) -> CapabilityError {
    CapabilityError::new(
        if grant_stage {
            CapabilityErrorCode::GrantDenied
        } else {
            CapabilityErrorCode::ControlDenied
        },
        code.as_str(),
    )
}

#[cfg(test)]
#[path = "capability_tests.rs"]
mod tests;
