use super::*;
use crate::browser::login::backend::{
    ActionResult, BackendFailureCode, SemanticOperation, WaitResult,
};
use crate::browser::login::control::{
    ControlError, HandoffGrant, LoginBrowserControl, OperationCancellation,
};
use crate::browser::login::policy::BrowserPolicyCode;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::{mpsc, Barrier};
use std::time::{Duration, Instant};

type Order = Arc<Mutex<Vec<&'static str>>>;

fn binding(session: &str, epoch: u64) -> BrowserGrantBinding {
    BrowserGrantBinding::new_trusted("workspace-a", "profile-a", session, epoch)
        .expect("trusted binding")
}

fn push(order: &Order, step: &'static str) {
    order.lock().expect("order lock").push(step);
}

struct RecordingControl {
    inner: LoginBrowserControl,
    order: Order,
}

impl RecordingControl {
    fn active(binding: BrowserGrantBinding, order: Order) -> Self {
        let inner = LoginBrowserControl::new();
        inner
            .activate_handoff(HandoffGrant::new_trusted(binding))
            .expect("activate");
        Self { inner, order }
    }
}

impl HandoffControl for RecordingControl {
    fn validate_grant(&self, binding: &BrowserGrantBinding) -> Result<(), ControlError> {
        push(&self.order, "grant");
        self.inner.validate_grant(binding)
    }

    fn begin_operation(
        &self,
        binding: &BrowserGrantBinding,
        write_capability: bool,
    ) -> Result<OperationCancellation, ControlError> {
        push(&self.order, "control");
        self.inner.begin_operation(binding, write_capability)
    }

    fn mark_audit_degraded(&self) {
        self.inner.mark_audit_degraded();
    }
}

struct BlockingBeginControl {
    inner: LoginBrowserControl,
    begin_entered: Mutex<Option<mpsc::Sender<()>>>,
    resume_begin: Mutex<mpsc::Receiver<()>>,
}

impl BlockingBeginControl {
    fn active(
        binding: BrowserGrantBinding,
        begin_entered: mpsc::Sender<()>,
        resume_begin: mpsc::Receiver<()>,
    ) -> Self {
        let inner = LoginBrowserControl::new();
        inner
            .activate_handoff(HandoffGrant::new_trusted(binding))
            .expect("activate");
        Self {
            inner,
            begin_entered: Mutex::new(Some(begin_entered)),
            resume_begin: Mutex::new(resume_begin),
        }
    }
}

impl HandoffControl for BlockingBeginControl {
    fn validate_grant(&self, binding: &BrowserGrantBinding) -> Result<(), ControlError> {
        self.inner.validate_grant(binding)
    }

    fn begin_operation(
        &self,
        binding: &BrowserGrantBinding,
        write_capability: bool,
    ) -> Result<OperationCancellation, ControlError> {
        if let Some(sender) = self.begin_entered.lock().expect("begin entered").take() {
            sender.send(()).expect("begin entered signal");
        }
        self.resume_begin
            .lock()
            .expect("resume begin")
            .recv()
            .expect("resume begin signal");
        self.inner.begin_operation(binding, write_capability)
    }

    fn mark_audit_degraded(&self) {
        self.inner.mark_audit_degraded();
    }
}

struct FakePermission {
    order: Order,
    deny: AtomicBool,
    epoch: AtomicU64,
}

impl SemanticPermissionGate for FakePermission {
    fn authorize(
        &self,
        _context: &SemanticExecutionContext<'_>,
        command: &SemanticBrowserCommand,
    ) -> Result<PermissionAuthorization, PermissionFailure> {
        push(&self.order, "permission");
        if self.deny.load(Ordering::Acquire) {
            Err(PermissionFailure::denied())
        } else {
            Ok(PermissionAuthorization {
                epoch: self.epoch.load(Ordering::Acquire),
                permission_tool: command.permission_tool(),
            })
        }
    }

    fn revalidate(
        &self,
        _context: &SemanticExecutionContext<'_>,
        command: &SemanticBrowserCommand,
        authorization: PermissionAuthorization,
    ) -> Result<(), PermissionFailure> {
        push(&self.order, "permission_recheck");
        if self.deny.load(Ordering::Acquire) {
            return Err(PermissionFailure::denied());
        }
        if authorization.epoch != self.epoch.load(Ordering::Acquire)
            || authorization.permission_tool != command.permission_tool()
        {
            return Err(PermissionFailure::changed());
        }
        Ok(())
    }
}

struct FakeOrigin {
    order: Order,
    deny: AtomicBool,
}

impl SemanticOriginGate for FakeOrigin {
    fn authorize(
        &self,
        _context: &SemanticExecutionContext<'_>,
        _command: &SemanticBrowserCommand,
    ) -> Result<OriginAuthorization, OriginFailure> {
        push(&self.order, "origin");
        if self.deny.load(Ordering::Acquire) {
            Err(OriginFailure::new("origin_not_granted"))
        } else {
            Ok(OriginAuthorization {
                policy_code: BrowserPolicyCode::Allowed.as_str().to_string(),
                target_origin: Some("https://allowed.example:443".to_string()),
            })
        }
    }
}

struct FakeAudit {
    order: Order,
    fail_pre: AtomicBool,
    fail_result: AtomicBool,
    pre_records: Mutex<Vec<AuditPreRecord>>,
}

impl SemanticAuditSink for FakeAudit {
    fn write_pre(&self, record: &AuditPreRecord) -> Result<(), AuditFailure> {
        push(&self.order, "audit_pre");
        if self.fail_pre.load(Ordering::Acquire) {
            Err(AuditFailure)
        } else {
            self.pre_records
                .lock()
                .expect("pre records")
                .push(record.clone());
            Ok(())
        }
    }

    fn write_result(&self, _record: &AuditResultRecord) -> Result<(), AuditFailure> {
        push(&self.order, "audit_result");
        if self.fail_result.load(Ordering::Acquire) {
            Err(AuditFailure)
        } else {
            Ok(())
        }
    }
}

struct FakeBackend {
    order: Order,
    effects: AtomicUsize,
}

impl SemanticBrowserBackend for FakeBackend {
    fn execute(
        &self,
        command: &SemanticBrowserCommand,
        cancellation: &OperationCancellation,
    ) -> Result<SemanticBrowserResult, BackendFailure> {
        push(&self.order, "backend");
        if cancellation.is_cancelled() {
            return Err(BackendFailure::cancelled());
        }
        self.effects.fetch_add(1, Ordering::AcqRel);
        Ok(match command.operation() {
            SemanticOperation::WaitFor => {
                SemanticBrowserResult::Wait(WaitResult { satisfied: true })
            }
            _ => SemanticBrowserResult::Action(ActionResult { completed: true }),
        })
    }
}

struct Harness {
    service: SemanticCapabilityService<
        RecordingControl,
        FakePermission,
        FakeOrigin,
        FakeAudit,
        FakeBackend,
    >,
    control: Arc<RecordingControl>,
    permission: Arc<FakePermission>,
    origin: Arc<FakeOrigin>,
    audit: Arc<FakeAudit>,
    backend: Arc<FakeBackend>,
    order: Order,
}

fn harness(active: BrowserGrantBinding) -> Harness {
    let order = Arc::new(Mutex::new(Vec::new()));
    let control = Arc::new(RecordingControl::active(active, Arc::clone(&order)));
    let permission = Arc::new(FakePermission {
        order: Arc::clone(&order),
        deny: AtomicBool::new(false),
        epoch: AtomicU64::new(1),
    });
    let origin = Arc::new(FakeOrigin {
        order: Arc::clone(&order),
        deny: AtomicBool::new(false),
    });
    let audit = Arc::new(FakeAudit {
        order: Arc::clone(&order),
        fail_pre: AtomicBool::new(false),
        fail_result: AtomicBool::new(false),
        pre_records: Mutex::new(Vec::new()),
    });
    let backend = Arc::new(FakeBackend {
        order: Arc::clone(&order),
        effects: AtomicUsize::new(0),
    });
    let service = SemanticCapabilityService::new(
        Arc::clone(&control),
        Arc::clone(&permission),
        Arc::clone(&origin),
        Arc::clone(&audit),
        Arc::clone(&backend),
    );
    Harness {
        service,
        control,
        permission,
        origin,
        audit,
        backend,
        order,
    }
}

fn write_command() -> SemanticBrowserCommand {
    SemanticBrowserCommand::Click {
        element_ref: "button-submit".to_string(),
    }
}

#[test]
fn authority_order_is_exact_and_effect_runs_only_after_pre_audit() {
    let current = binding("session-a", 3);
    let harness = harness(current.clone());
    let context = SemanticExecutionContext::new_trusted(&current, "https://allowed.example/form");
    harness
        .service
        .execute(&context, write_command())
        .expect("semantic effect");
    assert_eq!(
        *harness.order.lock().expect("order"),
        vec![
            "grant",
            "permission",
            "control",
            "permission_recheck",
            "origin",
            "audit_pre",
            "backend",
            "audit_result"
        ]
    );
    assert_eq!(harness.backend.effects.load(Ordering::Acquire), 1);
}

#[test]
fn permission_change_between_authorize_and_begin_rejects_the_stale_request() {
    let current = binding("session-a", 3);
    let order = Arc::new(Mutex::new(Vec::new()));
    let (begin_entered_tx, begin_entered_rx) = mpsc::channel();
    let (resume_begin_tx, resume_begin_rx) = mpsc::channel();
    let control = Arc::new(BlockingBeginControl::active(
        current.clone(),
        begin_entered_tx,
        resume_begin_rx,
    ));
    let permission = Arc::new(CcemPermissionGate::new("dev"));
    let origin = Arc::new(FakeOrigin {
        order: Arc::clone(&order),
        deny: AtomicBool::new(false),
    });
    let audit = Arc::new(FakeAudit {
        order: Arc::clone(&order),
        fail_pre: AtomicBool::new(false),
        fail_result: AtomicBool::new(false),
        pre_records: Mutex::new(Vec::new()),
    });
    let backend = Arc::new(FakeBackend {
        order: Arc::clone(&order),
        effects: AtomicUsize::new(0),
    });
    let service = Arc::new(SemanticCapabilityService::new(
        Arc::clone(&control),
        Arc::clone(&permission),
        origin,
        audit,
        Arc::clone(&backend),
    ));
    let (done_tx, done_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let context =
            SemanticExecutionContext::new_trusted(&current, "https://allowed.example/form");
        done_tx
            .send(service.execute(&context, write_command()))
            .expect("request result");
    });

    begin_entered_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("request reached begin after permission authorization");
    permission
        .set_permission_mode_and_invalidate("readonly", || control.inner.cancel_active())
        .expect("permission mode update");
    resume_begin_tx.send(()).expect("resume begin");

    let error = done_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("request completed")
        .expect_err("stale permission authorization must fail closed");
    assert_eq!(error.code, CapabilityErrorCode::PermissionDenied);
    assert_eq!(backend.effects.load(Ordering::Acquire), 0);
    assert_eq!(*order.lock().expect("order"), vec!["audit_pre"]);
}

#[test]
fn permission_mode_updates_invalidate_only_real_authority_changes() {
    let permission = CcemPermissionGate::new("dev");
    let invalidations = AtomicUsize::new(0);

    assert!(!permission
        .set_permission_mode_and_invalidate("dev", || {
            invalidations.fetch_add(1, Ordering::AcqRel);
        })
        .expect("same permission mode"));
    assert_eq!(invalidations.load(Ordering::Acquire), 0);
    assert!(permission
        .set_permission_mode_and_invalidate("readonly", || {
            invalidations.fetch_add(1, Ordering::AcqRel);
        })
        .expect("changed permission mode"));
    assert_eq!(invalidations.load(Ordering::Acquire), 1);
    assert!(!permission
        .set_permission_mode_and_invalidate("readonly", || {
            invalidations.fetch_add(1, Ordering::AcqRel);
        })
        .expect("same changed mode"));
    assert_eq!(invalidations.load(Ordering::Acquire), 1);
}

#[test]
fn stale_native_authority_cannot_restore_permission_after_downgrade() {
    let authority = BrowserPermissionAuthority::new("yolo");
    let stale = authority
        .current_ticket()
        .expect("initial authority ticket");
    let permission = CcemPermissionGate::new("safe");
    permission
        .synchronize_authority_and_invalidate(stale.clone(), || {})
        .expect("initial authority sync");

    let downgraded = authority
        .update("readonly")
        .expect("downgraded authority ticket");
    let current = permission
        .synchronize_authority_and_invalidate(downgraded, || {})
        .expect("downgraded authority sync");

    assert!(permission
        .synchronize_authority_and_invalidate(stale, || {})
        .is_err());
    let current_binding = binding("session-a", 1);
    let context =
        SemanticExecutionContext::new_trusted(&current_binding, "https://allowed.example/form")
            .with_permission_epoch(current.epoch());
    assert!(permission.authorize(&context, &write_command()).is_err());
}

#[test]
fn emergency_authority_retirement_never_waits_behind_an_active_read_proof() {
    let authority = BrowserPermissionAuthority::new("yolo");
    let ticket = authority.current_ticket().expect("initial ticket");
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let reader_entered = Arc::clone(&entered);
    let reader_release = Arc::clone(&release);
    let reader = std::thread::spawn(move || {
        ticket
            .with_current_revision(ticket.revision(), || {
                reader_entered.wait();
                reader_release.wait();
            })
            .expect("active read proof");
    });
    entered.wait();
    let started = Instant::now();

    assert!(authority.try_update("readonly").is_err());
    assert!(started.elapsed() < Duration::from_millis(100));

    release.wait();
    reader.join().unwrap();
}

#[test]
fn stale_prepared_request_after_downgrade_cannot_reach_the_backend() {
    let current = binding("session-a", 1);
    let order = Arc::new(Mutex::new(Vec::new()));
    let control = Arc::new(RecordingControl::active(
        current.clone(),
        Arc::clone(&order),
    ));
    let permission = Arc::new(CcemPermissionGate::new("safe"));
    let authority = BrowserPermissionAuthority::new("yolo");
    let stale_ticket = authority.current_ticket().expect("initial ticket");
    let prepared = permission
        .synchronize_authority_and_invalidate(stale_ticket.clone(), || {})
        .expect("prepare yolo request");
    let origin = Arc::new(FakeOrigin {
        order: Arc::clone(&order),
        deny: AtomicBool::new(false),
    });
    let audit = Arc::new(FakeAudit {
        order: Arc::clone(&order),
        fail_pre: AtomicBool::new(false),
        fail_result: AtomicBool::new(false),
        pre_records: Mutex::new(Vec::new()),
    });
    let backend = Arc::new(FakeBackend {
        order: Arc::clone(&order),
        effects: AtomicUsize::new(0),
    });
    let service = SemanticCapabilityService::new(
        Arc::clone(&control),
        Arc::clone(&permission),
        origin,
        audit,
        Arc::clone(&backend),
    );

    let downgraded = authority.update("readonly").expect("downgrade authority");
    permission
        .synchronize_authority_and_invalidate(downgraded, || control.inner.cancel_active())
        .expect("install downgrade");
    assert!(permission
        .synchronize_authority_and_invalidate(stale_ticket, || {})
        .is_err());

    let context = SemanticExecutionContext::new_trusted(&current, "https://allowed.example/form")
        .with_permission_epoch(prepared.epoch());
    let error = service
        .execute(&context, write_command())
        .expect_err("stale prepared write must fail closed");
    assert_eq!(error.code, CapabilityErrorCode::PermissionDenied);
    assert_eq!(backend.effects.load(Ordering::Acquire), 0);
}

#[test]
fn prepared_permission_is_bound_to_the_actor_authority_epoch() {
    let actor_a = BrowserPermissionAuthority::new("yolo");
    let actor_b = BrowserPermissionAuthority::new("readonly");
    let permission = CcemPermissionGate::new("safe");
    let prepared_a = permission
        .synchronize_authority_and_invalidate(
            actor_a.current_ticket().expect("actor a ticket"),
            || {},
        )
        .expect("actor a sync");
    let prepared_b = permission
        .synchronize_authority_and_invalidate(
            actor_b.current_ticket().expect("actor b ticket"),
            || {},
        )
        .expect("actor b sync");

    let current = binding("session-a", 1);
    let stale_context =
        SemanticExecutionContext::new_trusted(&current, "https://allowed.example/form")
            .with_permission_epoch(prepared_a.epoch());
    assert!(permission
        .authorize(&stale_context, &write_command())
        .is_err());

    let readonly_context =
        SemanticExecutionContext::new_trusted(&current, "https://allowed.example/form")
            .with_permission_epoch(prepared_b.epoch());
    assert!(permission
        .authorize(&readonly_context, &write_command())
        .is_err());
}

#[test]
fn unauthorized_binding_stops_before_permission_and_effect() {
    let active = binding("session-a", 3);
    let attempted = binding("session-b", 3);
    let harness = harness(active);
    let context = SemanticExecutionContext::new_trusted(&attempted, "https://allowed.example/form");
    let error = harness
        .service
        .execute(&context, write_command())
        .expect_err("unauthorized");
    assert_eq!(error.code, CapabilityErrorCode::GrantDenied);
    assert_eq!(
        *harness.order.lock().expect("order"),
        vec!["grant", "audit_pre"]
    );
    assert_eq!(harness.backend.effects.load(Ordering::Acquire), 0);
}

#[test]
fn permission_control_and_origin_denials_are_audited_without_backend_effect() {
    let current = binding("session-a", 1);
    let harness = harness(current.clone());
    let context = SemanticExecutionContext::new_trusted(
        &current,
        "https://allowed.example/private?credential=FULL_URL_SECRET",
    )
    .with_request_id("request-deny-1")
    .with_actor_id("runtime-deny-1");

    harness.permission.deny.store(true, Ordering::Release);
    assert_eq!(
        harness
            .service
            .execute(&context, write_command())
            .expect_err("permission denied")
            .code,
        CapabilityErrorCode::PermissionDenied
    );
    assert_eq!(harness.backend.effects.load(Ordering::Acquire), 0);
    assert_eq!(
        *harness.order.lock().expect("order"),
        vec!["grant", "permission", "audit_pre"]
    );

    harness.permission.deny.store(false, Ordering::Release);
    harness.origin.deny.store(true, Ordering::Release);
    harness.order.lock().expect("order").clear();
    assert_eq!(
        harness
            .service
            .execute(&context, write_command())
            .expect_err("origin denied")
            .code,
        CapabilityErrorCode::OriginDenied
    );
    assert_eq!(
        *harness.order.lock().expect("order"),
        vec![
            "grant",
            "permission",
            "control",
            "permission_recheck",
            "origin",
            "audit_pre"
        ]
    );
    assert_eq!(harness.backend.effects.load(Ordering::Acquire), 0);

    harness.origin.deny.store(false, Ordering::Release);
    harness.control.inner.mark_audit_degraded();
    harness.order.lock().expect("order").clear();
    assert_eq!(
        harness
            .service
            .execute(&context, write_command())
            .expect_err("control denied")
            .code,
        CapabilityErrorCode::ControlDenied
    );
    assert_eq!(
        *harness.order.lock().expect("order"),
        vec!["grant", "permission", "control", "audit_pre"]
    );
    assert_eq!(harness.backend.effects.load(Ordering::Acquire), 0);

    let records = harness.audit.pre_records.lock().expect("pre records");
    assert_eq!(records.len(), 3);
    for (record, cause) in records.iter().zip([
        "permission_denied",
        "origin_not_granted",
        ControlErrorCode::AuditDegraded.as_str(),
    ]) {
        let value = serde_json::to_value(record).expect("decision audit json");
        assert_eq!(value["request_id"], "request-deny-1");
        assert_eq!(value["actor_id"], "runtime-deny-1");
        assert_eq!(value["decision"], "denied");
        assert_eq!(value["cause_code"], cause);
        let serialized = value.to_string();
        assert!(!serialized.contains("FULL_URL_SECRET"));
        assert!(!serialized.contains("https://allowed.example/private"));
    }
}

#[test]
fn invalid_command_is_decision_audited_without_typed_text_or_backend_effect() {
    let current = binding("session-a", 1);
    let harness = harness(current.clone());
    let context = SemanticExecutionContext::new_trusted(&current, "https://allowed.example/")
        .with_request_id("request-invalid-1")
        .with_actor_id("runtime-invalid-1");
    let private_text = "TYPED_TEXT_SECRET_SENTINEL";
    let error = harness
        .service
        .execute(
            &context,
            SemanticBrowserCommand::Type {
                element_ref: "\n".to_string(),
                text: private_text.to_string(),
                replace: true,
            },
        )
        .expect_err("invalid command");
    assert_eq!(error.code, CapabilityErrorCode::InvalidCommand);
    assert_eq!(harness.backend.effects.load(Ordering::Acquire), 0);
    assert_eq!(*harness.order.lock().expect("order"), vec!["audit_pre"]);
    let records = harness.audit.pre_records.lock().expect("pre records");
    let value = serde_json::to_value(records.last().expect("decision record"))
        .expect("decision audit json");
    assert_eq!(value["decision"], "denied");
    assert_eq!(value["cause_code"], "invalid_input");
    assert_eq!(value["command"]["operation"], "type");
    assert!(!value.to_string().contains(private_text));
}

#[test]
fn pre_audit_failure_blocks_effect_and_degrades_future_writes() {
    let current = binding("session-a", 1);
    let harness = harness(current.clone());
    harness.audit.fail_pre.store(true, Ordering::Release);
    let context = SemanticExecutionContext::new_trusted(&current, "https://allowed.example/");
    assert_eq!(
        harness
            .service
            .execute(&context, write_command())
            .expect_err("pre audit failed")
            .code,
        CapabilityErrorCode::PreAuditFailed
    );
    assert_eq!(harness.backend.effects.load(Ordering::Acquire), 0);
    assert!(harness.control.inner.is_audit_degraded());

    harness.audit.fail_pre.store(false, Ordering::Release);
    assert_eq!(
        harness
            .service
            .execute(&context, write_command())
            .expect_err("degraded write blocked")
            .cause_code,
        ControlErrorCode::AuditDegraded.as_str()
    );
    assert_eq!(harness.backend.effects.load(Ordering::Acquire), 0);
}

#[test]
fn result_audit_failure_marks_degraded_and_blocks_next_write() {
    let current = binding("session-a", 1);
    let harness = harness(current.clone());
    harness.audit.fail_result.store(true, Ordering::Release);
    let context = SemanticExecutionContext::new_trusted(&current, "https://allowed.example/");
    let uncertain = harness
        .service
        .execute(&context, write_command())
        .expect_err("result audit failed");
    assert_eq!(uncertain.code, CapabilityErrorCode::ResultAuditFailed);
    assert_eq!(
        uncertain.cause_code,
        "effect_outcome_uncertain_do_not_retry"
    );
    assert_eq!(harness.backend.effects.load(Ordering::Acquire), 1);
    assert!(harness.control.inner.is_audit_degraded());

    harness.audit.fail_result.store(false, Ordering::Release);
    assert_eq!(
        harness
            .service
            .execute(&context, write_command())
            .expect_err("next write blocked")
            .cause_code,
        ControlErrorCode::AuditDegraded.as_str()
    );
    assert_eq!(harness.backend.effects.load(Ordering::Acquire), 1);
}

struct BlockingBackend {
    order: Order,
    entered: Mutex<Option<mpsc::Sender<()>>>,
}

impl SemanticBrowserBackend for BlockingBackend {
    fn execute(
        &self,
        _command: &SemanticBrowserCommand,
        cancellation: &OperationCancellation,
    ) -> Result<SemanticBrowserResult, BackendFailure> {
        let _owner = cancellation
            .enter_owner_execution()
            .map_err(|_| BackendFailure::cancelled())?;
        push(&self.order, "backend");
        if let Some(sender) = self.entered.lock().expect("entered").take() {
            sender.send(()).expect("entered signal");
        }
        if cancellation.wait_cancelled(Duration::from_secs(5)) {
            return Err(BackendFailure::cancelled());
        }
        Ok(SemanticBrowserResult::Wait(WaitResult { satisfied: false }))
    }
}

#[test]
fn permission_change_cancels_active_wait_and_result_audits_in_under_one_second() {
    let current = binding("session-a", 1);
    let order = Arc::new(Mutex::new(Vec::new()));
    let control = Arc::new(RecordingControl::active(
        current.clone(),
        Arc::clone(&order),
    ));
    let permission = Arc::new(CcemPermissionGate::new("dev"));
    let origin = Arc::new(FakeOrigin {
        order: Arc::clone(&order),
        deny: AtomicBool::new(false),
    });
    let audit = Arc::new(FakeAudit {
        order: Arc::clone(&order),
        fail_pre: AtomicBool::new(false),
        fail_result: AtomicBool::new(false),
        pre_records: Mutex::new(Vec::new()),
    });
    let (entered_tx, entered_rx) = mpsc::channel();
    let backend = Arc::new(BlockingBackend {
        order: Arc::clone(&order),
        entered: Mutex::new(Some(entered_tx)),
    });
    let service = Arc::new(SemanticCapabilityService::new(
        Arc::clone(&control),
        Arc::clone(&permission),
        origin,
        audit,
        backend,
    ));
    let (done_tx, done_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let context = SemanticExecutionContext::new_trusted(&current, "https://allowed.example/");
        let result = service.execute(
            &context,
            SemanticBrowserCommand::WaitFor {
                condition: super::super::backend::SemanticWaitCondition::LoadComplete,
                timeout_millis: 30_000,
            },
        );
        done_tx.send(result).expect("done signal");
    });
    entered_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("backend entered");
    let started = Instant::now();
    let changed = permission
        .set_permission_mode_and_invalidate("readonly", || control.inner.cancel_active())
        .expect("permission update");
    assert!(changed);
    let error = done_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("cancel completed")
        .expect_err("cancelled result");
    assert!(started.elapsed() < Duration::from_secs(1));
    assert_eq!(error.code, CapabilityErrorCode::BackendFailed);
    assert_eq!(error.cause_code, BackendFailureCode::Cancelled.as_str());
    assert_eq!(order.lock().expect("order").last(), Some(&"audit_result"));
}

#[test]
fn production_origin_gate_rejects_ungranted_navigation() {
    let current = binding("session-a", 1);
    let grant = TrustedOriginGrant::new_trusted(current.clone(), ["https://allowed.example"])
        .expect("origin grant");
    let gate = TrustedOriginPolicyGate::new(grant);
    let context = SemanticExecutionContext::new_trusted(&current, "https://allowed.example/");
    let error = gate
        .authorize(
            &context,
            &SemanticBrowserCommand::Navigate {
                url: "https://evil.example/".to_string(),
            },
        )
        .expect_err("ungranted origin");
    assert_eq!(error.code, BrowserPolicyCode::OriginNotGranted.as_str());
}

#[test]
fn persisted_provenance_denials_are_durably_audited_before_any_effect() {
    let current = binding("session-provenance", 1);
    let order = Arc::new(Mutex::new(Vec::new()));
    let control = Arc::new(RecordingControl::active(
        current.clone(),
        Arc::clone(&order),
    ));
    let permission = Arc::new(FakePermission {
        order: Arc::clone(&order),
        deny: AtomicBool::new(false),
        epoch: AtomicU64::new(1),
    });
    let origin = Arc::new(TrustedOriginPolicyGate::new(
        TrustedOriginGrant::new_trusted(current.clone(), ["https://allowed.example"])
            .expect("origin grant"),
    ));
    let audit = Arc::new(FakeAudit {
        order: Arc::clone(&order),
        fail_pre: AtomicBool::new(false),
        fail_result: AtomicBool::new(false),
        pre_records: Mutex::new(Vec::new()),
    });
    let backend = Arc::new(FakeBackend {
        order: Arc::clone(&order),
        effects: AtomicUsize::new(0),
    });
    let service = SemanticCapabilityService::new(
        control,
        permission,
        origin,
        Arc::clone(&audit),
        Arc::clone(&backend),
    );

    for (provenance, expected) in [
        (
            BrowserDataProvenance::CrossOrigin,
            "cross_origin_write_blocked",
        ),
        (
            BrowserDataProvenance::Mixed,
            "mixed_provenance_write_blocked",
        ),
    ] {
        let context =
            SemanticExecutionContext::new_trusted(&current, "https://allowed.example/form")
                .with_data_provenance(provenance)
                .with_request_id("request-provenance")
                .with_actor_id("actor-provenance");
        let error = service
            .execute(&context, write_command())
            .expect_err("tainted write must fail closed");
        assert_eq!(error.code, CapabilityErrorCode::OriginDenied);
        assert_eq!(error.cause_code, expected);
    }

    assert_eq!(backend.effects.load(Ordering::Acquire), 0);
    let records = audit.pre_records.lock().expect("audit records");
    assert_eq!(records.len(), 2);
    for (record, expected) in records.iter().zip([
        "cross_origin_write_blocked",
        "mixed_provenance_write_blocked",
    ]) {
        let value = serde_json::to_value(record).expect("audit value");
        assert_eq!(value["decision"], "denied");
        assert_eq!(value["cause_code"], expected);
    }
}

#[path = "capability_audit_tests.rs"]
mod audit;
