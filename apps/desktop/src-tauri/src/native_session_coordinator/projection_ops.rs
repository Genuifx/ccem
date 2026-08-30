use super::*;

impl NativeSessionCoordinator {
    pub fn note_status_line(&self, runtime_id: &str, status: &str) -> StatusDecision {
        let inner = self.lock_inner();
        if status == GENERIC_READY_STATUS
            && inner
                .get(runtime_id)
                .is_some_and(|coordination| coordination.active.is_some())
        {
            StatusDecision::Suppress
        } else {
            StatusDecision::Apply
        }
    }

    pub fn note_session_meta(
        &self,
        runtime_id: &str,
        helper_incarnation: u64,
        provider_session_id: Option<&str>,
        capabilities: Option<&[String]>,
        query_generation: Option<u64>,
    ) -> LifecycleDecision {
        let mut inner = self.lock_inner();
        let coordination = Self::coordination_mut(&mut inner, runtime_id);
        if coordination.incarnation != Some(helper_incarnation) {
            return LifecycleDecision::Ignored;
        }
        if let Some(generation) = query_generation {
            if let Some(current) = coordination.query_generation {
                if generation < current {
                    return LifecycleDecision::Ignored;
                }
                if generation > current {
                    if coordination.active.as_ref().is_some_and(|active| {
                        active
                            .query_generation
                            .is_some_and(|value| value != generation)
                    }) {
                        return coordination.poison(format!(
                            "query generation changed from {current} to {generation} while a command was active"
                        ));
                    }
                    coordination.adapter = AdapterKind::Negotiating;
                    coordination.capabilities.clear();
                }
            }
            coordination.query_generation = Some(generation);
        }

        if let Some(capabilities) = capabilities {
            let next_adapter = if capabilities
                .iter()
                .any(|capability| capability == MSG_LIFECYCLE_CAPABILITY)
            {
                AdapterKind::FullLifecycle
            } else {
                AdapterKind::LegacySerial
            };
            if !matches!(
                coordination.adapter,
                AdapterKind::Negotiating | AdapterKind::Poisoned
            ) && coordination.adapter != next_adapter
            {
                return coordination
                    .poison("capability negotiation changed within one query generation");
            }
            if coordination.adapter != AdapterKind::Poisoned {
                coordination.adapter = next_adapter;
                coordination.capabilities = capabilities.to_vec();
            }
        }

        let normalized = provider_session_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        if normalized.is_some() && normalized != coordination.provider_conversation_id {
            coordination.provider_conversation_id = normalized;
            coordination.conversation_epoch = coordination.conversation_epoch.saturating_add(1);
        }
        coordination.bump();
        LifecycleDecision::Updated
    }

    pub fn note_incarnation(&self, runtime_id: &str, incarnation: u64) {
        let mut inner = self.lock_inner();
        let coordination = Self::coordination_mut(&mut inner, runtime_id);
        if coordination.incarnation == Some(incarnation) {
            return;
        }
        if let Some(active) = &mut coordination.active {
            active.phase = CommandPhase::Uncertain;
            coordination.protocol_error = Some(format!(
                "helper incarnation changed while command {} was active",
                active.command_id
            ));
        }
        if let Some(op) = &mut coordination.pending_settings {
            if op.state.blocks_dispatch() {
                op.state = SettingsOpState::ReconcileRequired;
            }
        }
        if let Some(op) = &mut coordination.pending_permission_settings {
            if op.state.blocks_dispatch() {
                op.state = SettingsOpState::ReconcileRequired;
            }
        }
        if let Some(op) = &mut coordination.pending_interactive {
            if op.state == InteractiveOpState::Pending {
                op.state = InteractiveOpState::Failed;
            }
        }
        coordination.incarnation = Some(incarnation);
        coordination.query_generation = None;
        coordination.adapter = AdapterKind::Negotiating;
        coordination.capabilities.clear();
        coordination.bump();
        self.settings_signal.notify_all();
        self.interactive_signal.notify_all();
    }

    pub fn note_generation_retired(&self, runtime_id: &str, incarnation: u64) {
        let mut inner = self.lock_inner();
        let Some(coordination) = inner.get_mut(runtime_id) else {
            return;
        };
        if coordination.incarnation != Some(incarnation) {
            return;
        }
        if let Some(active) = &mut coordination.active {
            if active.helper_incarnation == incarnation {
                active.phase = CommandPhase::Uncertain;
                coordination.protocol_error = Some(format!(
                    "helper incarnation {incarnation} retired before command {} reached a terminal",
                    active.command_id
                ));
            }
        }
        if let Some(op) = &mut coordination.pending_settings {
            if op.helper_incarnation == incarnation && op.state.blocks_dispatch() {
                op.state = SettingsOpState::ReconcileRequired;
            }
        }
        if let Some(op) = &mut coordination.pending_permission_settings {
            if op.helper_incarnation == incarnation && op.state.blocks_dispatch() {
                op.state = SettingsOpState::ReconcileRequired;
            }
        }
        if let Some(op) = &mut coordination.pending_interactive {
            if op.helper_incarnation == incarnation && op.state == InteractiveOpState::Pending {
                op.state = InteractiveOpState::Failed;
            }
        }
        coordination.incarnation = None;
        coordination.query_generation = None;
        coordination.adapter = AdapterKind::Negotiating;
        coordination.capabilities.clear();
        coordination.bump();
        self.settings_signal.notify_all();
        self.interactive_signal.notify_all();
    }

    pub fn projection(&self, runtime_id: &str) -> Option<NativeLifecycleProjection> {
        let inner = self.lock_inner();
        let coordination = inner.get(runtime_id)?;
        let settings_pending = coordination
            .pending_settings
            .as_ref()
            .is_some_and(|op| op.state.blocks_dispatch())
            || coordination
                .pending_permission_settings
                .as_ref()
                .is_some_and(|op| op.state.blocks_dispatch());
        let settings_state = coordination
            .pending_permission_settings
            .as_ref()
            .filter(|op| op.state.blocks_dispatch())
            .or(coordination.pending_settings.as_ref())
            .map(|op| op.state.as_str().to_string());
        Some(NativeLifecycleProjection {
            state_revision: coordination.state_revision,
            adapter: coordination.adapter.as_str().to_string(),
            helper_incarnation: coordination.incarnation.unwrap_or_default(),
            active_command_id: coordination
                .active
                .as_ref()
                .map(|active| active.command_id.clone()),
            active_phase: coordination
                .active
                .as_ref()
                .map(|active| active.phase.as_str().to_string()),
            active_helper_incarnation: coordination
                .active
                .as_ref()
                .map(|active| active.helper_incarnation),
            settings_pending,
            settings_state,
            queue_count: 0,
            delivery_uncertain_count: coordination.active.as_ref().is_some_and(|active| {
                matches!(
                    active.phase,
                    CommandPhase::Uncertain | CommandPhase::ProtocolError
                )
            }) as usize,
            query_generation: coordination.query_generation.unwrap_or_default(),
            conversation_epoch: coordination.conversation_epoch,
            capabilities: coordination.capabilities.clone(),
            protocol_error: coordination.protocol_error.clone(),
        })
    }

    pub fn clear_session(&self, runtime_id: &str) {
        self.lock_inner().remove(runtime_id);
        self.settings_signal.notify_all();
        self.interactive_signal.notify_all();
    }
}
