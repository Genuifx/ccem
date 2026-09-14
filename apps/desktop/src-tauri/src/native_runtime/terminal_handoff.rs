use super::*;

/// A reservation replaces holding the reconnect coordinator across helper waits.
/// It belongs to one request and one helper incarnation, including while that
/// helper is frozen or being retired by the output pump.
#[derive(Clone)]
pub(super) struct TerminalHandoffPreparation {
    pub(super) request_id: String,
    pub(super) helper: Option<Arc<NativeSessionHandle>>,
    pub(super) finalization_claimed: bool,
}

impl NativeRuntimeManager {
    pub(super) fn append_terminal_handoff_event(
        &self,
        runtime_id: &str,
        payload: SessionEventPayload,
    ) -> Result<(), String> {
        // The output pump has already retired the source from `handles` after
        // Stop. Keep its ordered event store through the reservation so the
        // final handoff receipt is still persisted after that retirement.
        let helper = self
            .terminal_handoff_preparations
            .lock()
            .map_err(|_| "Failed to lock native terminal handoff state".to_string())?
            .get(runtime_id)
            .and_then(|preparation| preparation.helper.clone());
        if let Some(handle) = helper {
            let mut events = handle
                .events
                .lock()
                .map_err(|_| "Failed to lock native session store".to_string())?;
            let event = events.append(payload);
            self.event_log.append(&event)
        } else {
            self.append_event(runtime_id, payload)
        }
    }

    pub(super) fn prepare_terminal_handoff_child(
        &self,
        runtime_id: &str,
        request_id: &str,
        allow_background_tasks: bool,
        finalize: bool,
    ) -> Result<(), String> {
        let coordinator = self
            .reconnect_lock
            .lock()
            .map_err(|_| "Failed to lock native runtime reconnect coordinator".to_string())?;
        self.validate_terminal_handoff(runtime_id, request_id, false)?;
        let requested = self.request_child_prepare_stop(
            runtime_id,
            request_id,
            true,
            allow_background_tasks,
            finalize,
        );
        // The stdout pump needs this coordinator for both ordinary output and ACKs.
        drop(coordinator);
        let result = match requested {
            Ok(Some(handle)) => self.await_child_prepare_stop(
                runtime_id, request_id, &handle, allow_background_tasks,
            ),
            Ok(None) => self.current_record(runtime_id).and_then(|record| {
                if record.is_active && !native_status_allows_file_rewind(&record.status) {
                    Err("Finish the current foreground turn before continuing this session in Terminal.".to_string())
                } else { Ok(()) }
            }),
            Err(error) => Err(error),
        };
        let _coordinator = self
            .reconnect_lock
            .lock()
            .map_err(|_| "Failed to lock native runtime reconnect coordinator".to_string())?;
        let result = result.and_then(|_| {
            self.validate_terminal_handoff(runtime_id, request_id, false)
                .map(|_| ())
        });
        if result.is_err() {
            self.cancel_terminal_handoff_preparation(runtime_id, Some(request_id));
        }
        result
    }

    pub(super) fn shutdown_terminal_handoff_child(
        &self,
        runtime_id: &str,
        request_id: &str,
        force_background_tasks: bool,
    ) -> Result<(), String> {
        let coordinator = self
            .reconnect_lock
            .lock()
            .map_err(|_| "Failed to lock native runtime reconnect coordinator".to_string())?;
        let preparation = self.validate_terminal_handoff(runtime_id, request_id, false)?;
        self.reject_background_task_termination(
            runtime_id,
            "close this native runtime",
            force_background_tasks,
        )?;
        let Some(handle) = self.request_child_stop(runtime_id, force_background_tasks)? else {
            if let Some(handle) = preparation.helper.as_ref() {
                self.retire_handle_if_current(runtime_id, handle)?;
            }
            return Ok(());
        };
        // mark_process_exit takes lifecycle -> reconnect. Neither may be held here.
        drop(coordinator);
        let deadline = Instant::now() + NATIVE_STOP_GRACE_PERIOD;
        while Instant::now() < deadline {
            if !self.is_current_handle(runtime_id, &handle)? {
                return Ok(());
            }
            if !force_background_tasks && !self.active_background_tasks(runtime_id)?.is_empty() {
                return Err(ACTIVE_BACKGROUND_TASK_SHUTDOWN_ERROR.to_string());
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let _coordinator = self
            .reconnect_lock
            .lock()
            .map_err(|_| "Failed to lock native runtime reconnect coordinator".to_string())?;
        self.validate_terminal_handoff(runtime_id, request_id, true)?;
        self.reject_background_task_termination(
            runtime_id,
            "close this native runtime",
            force_background_tasks,
        )?;
        self.retire_handle_if_current(runtime_id, &handle)
            .map(|_| ())
    }

    /// Caller owns the reconnect coordinator.
    pub(super) fn reserve_terminal_handoff(&self, runtime_id: &str) -> Result<String, String> {
        self.reject_query_mutation_during_transition(runtime_id, "continue in Terminal")?;
        let helper = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(runtime_id)
            .cloned();
        let request_id = format!(
            "terminal-handoff-{runtime_id}-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        self.terminal_handoff_preparations
            .lock()
            .map_err(|_| "Failed to lock native terminal handoff state".to_string())?
            .insert(
                runtime_id.to_owned(),
                TerminalHandoffPreparation {
                    request_id: request_id.clone(),
                    helper,
                    finalization_claimed: false,
                },
            );
        Ok(request_id)
    }

    /// Check again under the coordinator after every wait. A missing helper is
    /// acceptable only after shutdown; a replacement is never ours to mutate.
    pub(super) fn validate_terminal_handoff(
        &self,
        runtime_id: &str,
        request_id: &str,
        allow_retired: bool,
    ) -> Result<TerminalHandoffPreparation, String> {
        let preparation = self
            .terminal_handoff_preparations
            .lock()
            .map_err(|_| "Failed to lock native terminal handoff state".to_string())?
            .get(runtime_id)
            .filter(|entry| entry.request_id == request_id)
            .cloned()
            .ok_or_else(|| "Terminal handoff preparation is no longer current.".to_string())?;
        let handles = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?;
        let current = handles.get(runtime_id);
        let matches = match (preparation.helper.as_ref(), current) {
            (Some(expected), Some(current)) => Self::same_handle(expected, current),
            (Some(_), None) => allow_retired,
            (None, None) => true,
            (None, Some(_)) => false,
        };
        if !matches {
            return Err("Native helper changed during terminal handoff.".to_string());
        }
        Ok(preparation)
    }

    pub(super) fn reject_reconnect_during_handoff(&self, runtime_id: &str) -> Result<(), String> {
        if self
            .terminal_handoff_preparations
            .lock()
            .map_err(|_| "Failed to lock native terminal handoff state".to_string())?
            .contains_key(runtime_id)
        {
            return Err("This native session is preparing to continue in Terminal.".to_string());
        }
        Ok(())
    }

    pub(super) fn invalidate_handoff_for_retired_helper(
        &self,
        runtime_id: &str,
        handle: &Arc<NativeSessionHandle>,
    ) -> Result<(), String> {
        // Normal handoff shutdown retains its reservation through metadata commit.
        // Every other retirement (including a status:error before SessionMeta)
        // must release it even when no deferred worker has been scheduled yet.
        if self.current_record(runtime_id)?.status == "handoff_closing" {
            return Ok(());
        }
        let mut preparations = self
            .terminal_handoff_preparations
            .lock()
            .map_err(|_| "Failed to lock native terminal handoff state".to_string())?;
        if preparations.get(runtime_id).is_some_and(|preparation| {
            preparation
                .helper
                .as_ref()
                .is_some_and(|expected| Self::same_handle(expected, handle))
        }) {
            preparations.remove(runtime_id);
        }
        Ok(())
    }

    /// Called inside the output coordinator, before handing work to a separate
    /// worker. Duplicate SessionMeta/ACK messages must not open another terminal.
    pub(super) fn claim_pending_terminal_handoff(
        &self,
        runtime_id: &str,
    ) -> Result<Option<TerminalHandoffPreparation>, String> {
        let record = self.current_record(runtime_id)?;
        if record.status != "handoff_finalizing" || record.pending_handoff_terminal.is_none() {
            return Ok(None);
        }
        let mut preparations = self
            .terminal_handoff_preparations
            .lock()
            .map_err(|_| "Failed to lock native terminal handoff state".to_string())?;
        let Some(preparation) = preparations.get_mut(runtime_id) else {
            return Ok(None);
        };
        if preparation.finalization_claimed {
            return Ok(None);
        }
        preparation.finalization_claimed = true;
        Ok(Some(preparation.clone()))
    }

    pub(super) fn finish_pending_terminal_handoff(
        &self,
        app: Option<&AppHandle>,
        runtime_id: &str,
        preparation: TerminalHandoffPreparation,
    ) -> Result<(), String> {
        let _transition = self
            .app_termination_lock
            .lock()
            .map_err(|_| "Failed to lock native runtime transition".to_string())?;
        let _settings = self
            .settings_update_lock
            .lock()
            .map_err(|_| "Failed to lock native settings updates".to_string())?;
        let coordinator = self
            .reconnect_lock
            .lock()
            .map_err(|_| "Failed to lock native runtime reconnect coordinator".to_string())?;
        if let Err(error) =
            self.validate_terminal_handoff(runtime_id, &preparation.request_id, false)
        {
            self.cancel_terminal_handoff_preparation(runtime_id, Some(&preparation.request_id));
            return Err(error);
        }
        if self.app_termination_in_progress.load(Ordering::SeqCst) {
            return self.fail_pending_terminal_handoff(
                runtime_id,
                &preparation.request_id,
                "CCEM is already closing native runtimes.",
            );
        }
        let record = self.current_record(runtime_id)?;
        let terminal = record
            .pending_handoff_terminal
            .ok_or_else(|| "Pending terminal handoff was cancelled.".to_string())?;
        let allow_background_tasks = record.pending_handoff_allow_background_task_termination;
        let needs_ack = preparation
            .helper
            .as_ref()
            .map(|handle| {
                let has_child = handle
                    .child
                    .lock()
                    .map(|child| child.is_some())
                    .map_err(|_| "Failed to lock native sidecar child".to_string())?;
                let has_ack = handle
                    .teardown_preparations
                    .lock()
                    .map_err(|_| "Failed to lock native teardown preparation".to_string())?
                    .contains_key(&preparation.request_id);
                Ok::<_, String>(has_child || has_ack)
            })
            .transpose()?
            .unwrap_or(false);
        drop(coordinator);
        let prepared = if needs_ack {
            self.await_child_prepare_stop(
                runtime_id,
                &preparation.request_id,
                preparation.helper.as_ref().expect("helper with child"),
                allow_background_tasks,
            )
        } else {
            Ok(())
        };
        if let Err(error) = prepared {
            let _coordinator = self
                .reconnect_lock
                .lock()
                .map_err(|_| "Failed to lock native runtime reconnect coordinator".to_string())?;
            self.fail_pending_terminal_handoff(runtime_id, &preparation.request_id, &error)?;
            return Err(error);
        }
        let result = self.complete_terminal_handoff(
            record.clone(),
            terminal,
            allow_background_tasks,
            &preparation.request_id,
        );
        let _coordinator = self
            .reconnect_lock
            .lock()
            .map_err(|_| "Failed to lock native runtime reconnect coordinator".to_string())?;
        match result {
            Ok(()) => {
                self.terminal_handoff_preparations
                    .lock()
                    .map_err(|_| "Failed to lock native terminal handoff state".to_string())?
                    .remove(runtime_id);
                if let Some(app) = app {
                    retire_login_browser_agent_control(
                        app,
                        &record.project_dir,
                        &record.browser_actor_id,
                    )?;
                }
                Ok(())
            }
            Err(error) => {
                self.fail_pending_terminal_handoff(runtime_id, &preparation.request_id, &error)?;
                Err(error)
            }
        }
    }
}
