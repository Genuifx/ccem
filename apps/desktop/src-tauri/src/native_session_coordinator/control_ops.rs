use super::*;

impl NativeSessionCoordinator {
    pub fn settings_request_is_current(&self, runtime_id: &str, control_request_id: &str) -> bool {
        self.lock_inner()
            .get(runtime_id)
            .is_some_and(|coordination| {
                coordination
                    .pending_settings
                    .as_ref()
                    .is_some_and(|op| op.control_request_id == control_request_id)
                    || coordination
                        .pending_permission_settings
                        .as_ref()
                        .is_some_and(|op| op.control_request_id == control_request_id)
            })
    }

    pub fn begin_settings_op(
        &self,
        runtime_id: &str,
        helper_incarnation: u64,
        control_request_id: &str,
    ) -> Result<(), AdmissionError> {
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
        if let Some(op) = coordination.pending_settings.as_ref() {
            if matches!(
                op.state,
                SettingsOpState::Pending | SettingsOpState::Deferred
            ) {
                return Err(AdmissionError::SettingsPending {
                    state: op.state.as_str().to_string(),
                });
            }
        }
        if let Some(op) = coordination.pending_permission_settings.as_ref() {
            if op.state.blocks_dispatch() {
                return Err(AdmissionError::SettingsPending {
                    state: op.state.as_str().to_string(),
                });
            }
        }
        coordination.pending_settings = Some(PendingSettingsOp {
            control_request_id: control_request_id.to_string(),
            state: SettingsOpState::Pending,
            helper_incarnation,
            query_generation: coordination.query_generation,
        });
        coordination.bump();
        Ok(())
    }

    /// Begin a permission-only settings operation. Claude can apply this lane
    /// to the live query while a prior environment/effort update remains
    /// deferred until the foreground turn settles. Other unresolved general
    /// states still fail closed.
    pub fn begin_permission_settings_op(
        &self,
        runtime_id: &str,
        helper_incarnation: u64,
        control_request_id: &str,
    ) -> Result<(), AdmissionError> {
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
        if let Some(op) = coordination.pending_settings.as_ref() {
            if matches!(
                op.state,
                SettingsOpState::Pending | SettingsOpState::ReconcileRequired
            ) {
                return Err(AdmissionError::SettingsPending {
                    state: op.state.as_str().to_string(),
                });
            }
        }
        if let Some(op) = coordination.pending_permission_settings.as_ref() {
            if matches!(
                op.state,
                SettingsOpState::Pending | SettingsOpState::Deferred
            ) {
                return Err(AdmissionError::SettingsPending {
                    state: op.state.as_str().to_string(),
                });
            }
        }
        coordination.pending_permission_settings = Some(PendingSettingsOp {
            control_request_id: control_request_id.to_string(),
            state: SettingsOpState::Pending,
            helper_incarnation,
            query_generation: coordination.query_generation,
        });
        coordination.bump();
        Ok(())
    }

    pub fn note_settings_failed(
        &self,
        runtime_id: &str,
        helper_incarnation: u64,
        control_request_id: &str,
    ) {
        let mut inner = self.lock_inner();
        let Some(coordination) = inner.get_mut(runtime_id) else {
            return;
        };
        let op = coordination
            .pending_settings
            .as_mut()
            .filter(|op| op.control_request_id == control_request_id)
            .or_else(|| {
                coordination
                    .pending_permission_settings
                    .as_mut()
                    .filter(|op| op.control_request_id == control_request_id)
            });
        if let Some(op) = op.filter(|op| op.helper_incarnation == helper_incarnation) {
            op.state = SettingsOpState::Failed;
            coordination.bump();
            self.settings_signal.notify_all();
        }
    }

    pub fn note_settings_uncertain(
        &self,
        runtime_id: &str,
        helper_incarnation: u64,
        control_request_id: &str,
    ) {
        let mut inner = self.lock_inner();
        let Some(coordination) = inner.get_mut(runtime_id) else {
            return;
        };
        let op = coordination
            .pending_settings
            .as_mut()
            .filter(|op| op.control_request_id == control_request_id)
            .or_else(|| {
                coordination
                    .pending_permission_settings
                    .as_mut()
                    .filter(|op| op.control_request_id == control_request_id)
            });
        if let Some(op) = op.filter(|op| op.helper_incarnation == helper_incarnation) {
            op.state = SettingsOpState::ReconcileRequired;
            coordination.bump();
            self.settings_signal.notify_all();
        }
    }

    pub fn note_settings_ack(
        &self,
        runtime_id: &str,
        helper_incarnation: u64,
        control_request_id: Option<&str>,
        state: &str,
        query_generation: Option<u64>,
    ) -> LifecycleDecision {
        let Some(control_request_id) = control_request_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return LifecycleDecision::Ignored;
        };
        let Some(parsed) = SettingsOpState::from_wire(state) else {
            let mut inner = self.lock_inner();
            let coordination = Self::coordination_mut(&mut inner, runtime_id);
            return coordination.poison(format!("unknown settings ACK state {state:?}"));
        };
        let mut inner = self.lock_inner();
        let coordination = Self::coordination_mut(&mut inner, runtime_id);
        if coordination.incarnation != Some(helper_incarnation) {
            return LifecycleDecision::Ignored;
        }
        let is_permission_op = coordination
            .pending_permission_settings
            .as_ref()
            .is_some_and(|op| op.control_request_id == control_request_id);
        let op = coordination
            .pending_settings
            .as_mut()
            .filter(|op| op.control_request_id == control_request_id)
            .or_else(|| {
                coordination
                    .pending_permission_settings
                    .as_mut()
                    .filter(|op| op.control_request_id == control_request_id)
            });
        let Some(op) = op else {
            return LifecycleDecision::Ignored;
        };
        if op.helper_incarnation != helper_incarnation {
            return LifecycleDecision::Ignored;
        }
        match (op.query_generation, query_generation) {
            // The helper may rehydrate an idle query (for example for a usage
            // probe) after Rust writes this request but before Rust ingests the
            // preceding session_meta. The exact same-incarnation request ACK
            // may therefore advance, but never move backward, one generation.
            (Some(expected), Some(generation)) if generation >= expected => {
                op.query_generation = Some(generation);
            }
            (Some(_), _) => return LifecycleDecision::Ignored,
            (None, Some(generation)) => op.query_generation = Some(generation),
            (None, None) => {}
        }
        let parsed = if is_permission_op && parsed == SettingsOpState::Failed {
            // Permission delivery is a cross-authority transaction. A helper-side failure is
            // not dispatch-safe until the host finishes fail-closed quarantine, so retain a
            // blocking state instead of releasing queued prompts from the stdout thread.
            SettingsOpState::ReconcileRequired
        } else {
            parsed
        };
        if op.state == SettingsOpState::ReconcileRequired {
            // A definite late failure proves that no settings side effect was
            // committed, so the old local projection is authoritative and
            // queued prompts may proceed. Applied/deferred remain uncertain
            // and still require an explicit settings retry to reconcile.
            if parsed != SettingsOpState::Failed {
                return LifecycleDecision::Ignored;
            }
        }
        op.state = parsed;
        coordination.bump();
        self.settings_signal.notify_all();
        LifecycleDecision::Updated
    }

    pub fn wait_for_settings_convergence(
        &self,
        runtime_id: &str,
        budget: Duration,
    ) -> SettingsWaitOutcome {
        let deadline = Instant::now() + budget;
        let mut inner = self.lock_inner();
        loop {
            let outcome = match inner.get(runtime_id) {
                None => Some(SettingsWaitOutcome::Converged),
                Some(coordination) => {
                    let permission_outcome = coordination
                        .pending_permission_settings
                        .as_ref()
                        .and_then(|op| match op.state {
                            SettingsOpState::Applied => None,
                            SettingsOpState::Pending => Some(None),
                            SettingsOpState::Deferred | SettingsOpState::ReconcileRequired => {
                                Some(Some(SettingsWaitOutcome::Failed))
                            }
                            SettingsOpState::Failed => None,
                        });
                    match permission_outcome {
                        Some(outcome) => outcome,
                        None => match &coordination.pending_settings {
                            None => Some(SettingsWaitOutcome::Converged),
                            Some(op) => match op.state {
                                SettingsOpState::Applied => Some(SettingsWaitOutcome::Converged),
                                SettingsOpState::Deferred => Some(SettingsWaitOutcome::Deferred),
                                SettingsOpState::ReconcileRequired => {
                                    Some(SettingsWaitOutcome::Failed)
                                }
                                SettingsOpState::Failed => Some(SettingsWaitOutcome::Converged),
                                SettingsOpState::Pending => None,
                            },
                        },
                    }
                }
            };
            if let Some(outcome) = outcome {
                return outcome;
            }
            let now = Instant::now();
            if now >= deadline {
                if let Some(coordination) = inner.get_mut(runtime_id) {
                    if let Some(op) = &mut coordination.pending_settings {
                        if op.state == SettingsOpState::Pending {
                            op.state = SettingsOpState::ReconcileRequired;
                        }
                    }
                    if let Some(op) = &mut coordination.pending_permission_settings {
                        if op.state == SettingsOpState::Pending {
                            op.state = SettingsOpState::ReconcileRequired;
                        }
                    }
                    coordination.bump();
                    self.settings_signal.notify_all();
                }
                return SettingsWaitOutcome::Timeout;
            }
            let (guard, _) = self
                .settings_signal
                .wait_timeout(inner, Duration::from_millis(100))
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            inner = guard;
        }
    }

    pub fn wait_for_settings_ack(
        &self,
        runtime_id: &str,
        control_request_id: &str,
        budget: Duration,
    ) -> SettingsWaitOutcome {
        let deadline = Instant::now() + budget;
        let mut inner = self.lock_inner();
        loop {
            let outcome = match inner.get(runtime_id) {
                None => Some(SettingsWaitOutcome::Failed),
                Some(coordination) => {
                    let op = coordination
                        .pending_settings
                        .as_ref()
                        .filter(|op| op.control_request_id == control_request_id)
                        .or_else(|| {
                            coordination
                                .pending_permission_settings
                                .as_ref()
                                .filter(|op| op.control_request_id == control_request_id)
                        });
                    match op {
                        Some(op) => match op.state {
                            SettingsOpState::Applied => Some(SettingsWaitOutcome::Converged),
                            SettingsOpState::Deferred => Some(SettingsWaitOutcome::Deferred),
                            SettingsOpState::Failed | SettingsOpState::ReconcileRequired => {
                                Some(SettingsWaitOutcome::Failed)
                            }
                            SettingsOpState::Pending => None,
                        },
                        None => Some(SettingsWaitOutcome::Failed),
                    }
                }
            };
            if let Some(outcome) = outcome {
                return outcome;
            }
            let now = Instant::now();
            if now >= deadline {
                if let Some(coordination) = inner.get_mut(runtime_id) {
                    let op = coordination
                        .pending_settings
                        .as_mut()
                        .filter(|op| op.control_request_id == control_request_id)
                        .or_else(|| {
                            coordination
                                .pending_permission_settings
                                .as_mut()
                                .filter(|op| op.control_request_id == control_request_id)
                        });
                    if let Some(op) = op.filter(|op| op.state == SettingsOpState::Pending) {
                        op.state = SettingsOpState::ReconcileRequired;
                        coordination.bump();
                        self.settings_signal.notify_all();
                    }
                }
                return SettingsWaitOutcome::Timeout;
            }
            let (guard, _) = self
                .settings_signal
                .wait_timeout(inner, Duration::from_millis(100))
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            inner = guard;
        }
    }

    pub fn begin_interactive_op(
        &self,
        runtime_id: &str,
        helper_incarnation: u64,
        control_request_id: &str,
        tool_use_id: &str,
    ) -> Result<Option<u64>, AdmissionError> {
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
        if let Some(op) = coordination.pending_interactive.as_ref() {
            if op.state == InteractiveOpState::Pending {
                return Err(AdmissionError::InteractivePending {
                    control_request_id: op.control_request_id.clone(),
                });
            }
        }
        let query_generation = coordination.query_generation;
        coordination.pending_interactive = Some(PendingInteractiveOp {
            control_request_id: control_request_id.to_string(),
            tool_use_id: tool_use_id.to_string(),
            state: InteractiveOpState::Pending,
            helper_incarnation,
            query_generation,
        });
        coordination.bump();
        Ok(query_generation)
    }

    pub fn note_interactive_failed(
        &self,
        runtime_id: &str,
        helper_incarnation: u64,
        control_request_id: &str,
    ) {
        let mut inner = self.lock_inner();
        let Some(coordination) = inner.get_mut(runtime_id) else {
            return;
        };
        let matches = coordination.pending_interactive.as_ref().is_some_and(|op| {
            op.control_request_id == control_request_id
                && op.helper_incarnation == helper_incarnation
        });
        if matches {
            if let Some(op) = &mut coordination.pending_interactive {
                op.state = InteractiveOpState::Failed;
            }
            coordination.bump();
            self.interactive_signal.notify_all();
        }
    }

    pub fn note_interactive_ack(
        &self,
        runtime_id: &str,
        helper_incarnation: u64,
        control_request_id: Option<&str>,
        tool_use_id: &str,
        state: &str,
        query_generation: Option<u64>,
    ) -> LifecycleDecision {
        let Some(control_request_id) = control_request_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return LifecycleDecision::Ignored;
        };
        let Some(parsed) = InteractiveOpState::from_wire(state) else {
            let mut inner = self.lock_inner();
            let coordination = Self::coordination_mut(&mut inner, runtime_id);
            return coordination.poison(format!("unknown interactive ACK state {state:?}"));
        };
        let mut inner = self.lock_inner();
        let coordination = Self::coordination_mut(&mut inner, runtime_id);
        if coordination.incarnation != Some(helper_incarnation) {
            return LifecycleDecision::Ignored;
        }
        let Some(op) = &mut coordination.pending_interactive else {
            return LifecycleDecision::Ignored;
        };
        if op.control_request_id != control_request_id
            || op.tool_use_id != tool_use_id
            || op.helper_incarnation != helper_incarnation
        {
            return LifecycleDecision::Ignored;
        }
        if parsed == InteractiveOpState::Applied {
            match (op.query_generation, query_generation) {
                (Some(expected), Some(generation)) if generation == expected => {}
                (Some(_), _) => return LifecycleDecision::Ignored,
                (None, Some(generation)) => op.query_generation = Some(generation),
                (None, None) => {}
            }
        }
        op.state = parsed;
        coordination.bump();
        self.interactive_signal.notify_all();
        LifecycleDecision::Updated
    }

    pub fn wait_for_interactive_ack(
        &self,
        runtime_id: &str,
        control_request_id: &str,
        budget: Duration,
    ) -> InteractiveWaitOutcome {
        let deadline = Instant::now() + budget;
        let mut inner = self.lock_inner();
        loop {
            let outcome = match inner.get(runtime_id) {
                None => Some(InteractiveWaitOutcome::Failed),
                Some(coordination) => match &coordination.pending_interactive {
                    Some(op) if op.control_request_id == control_request_id => match op.state {
                        InteractiveOpState::Pending => None,
                        InteractiveOpState::Applied => Some(InteractiveWaitOutcome::Applied),
                        InteractiveOpState::Rejected => Some(InteractiveWaitOutcome::Rejected),
                        InteractiveOpState::Failed => Some(InteractiveWaitOutcome::Failed),
                    },
                    _ => Some(InteractiveWaitOutcome::Failed),
                },
            };
            if let Some(outcome) = outcome {
                return outcome;
            }
            let now = Instant::now();
            if now >= deadline {
                if let Some(coordination) = inner.get_mut(runtime_id) {
                    let matches = coordination.pending_interactive.as_ref().is_some_and(|op| {
                        op.control_request_id == control_request_id
                            && op.state == InteractiveOpState::Pending
                    });
                    if matches {
                        if let Some(op) = &mut coordination.pending_interactive {
                            // The helper resolver is single-consumer by tool_use_id,
                            // so a visible retry cannot apply the same reply twice.
                            // Mark this attempt terminal instead of leaving a ghost
                            // Pending operation that blocks Plan/Ask forever.
                            op.state = InteractiveOpState::Failed;
                        }
                        coordination.bump();
                        self.interactive_signal.notify_all();
                    }
                }
                return InteractiveWaitOutcome::Timeout;
            }
            let (guard, _) = self
                .interactive_signal
                .wait_timeout(inner, Duration::from_millis(100))
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            inner = guard;
        }
    }
}
