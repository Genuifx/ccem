use super::*;

const AUTO_ATTACHED_WORKER_RESUME_TIMEOUT: Duration = Duration::from_millis(300);

impl SemanticEngine {
    pub(super) fn handle_target_event(
        &mut self,
        client: &mut CdpClient<'_>,
        event: &CdpEvent,
    ) -> Result<(), BackendFailure> {
        match event.kind {
            CdpEventKind::TargetCreated => {
                if let Some(info) = event.params.get("targetInfo") {
                    self.guard_secondary_target(client, info)?;
                }
            }
            CdpEventKind::TargetAttached => self.observe_target_attached(client, event)?,
            CdpEventKind::TargetInfoChanged => self.observe_target_info_changed(client, event)?,
            CdpEventKind::TargetDestroyed => self.observe_target_destroyed(event)?,
            CdpEventKind::TargetDetached => self.observe_target_detached(event)?,
            CdpEventKind::TargetCrashed => self.observe_target_crashed(event)?,
            _ => return Err(protocol_failure()),
        }
        Ok(())
    }

    fn observe_target_attached(
        &mut self,
        client: &mut CdpClient<'_>,
        event: &CdpEvent,
    ) -> Result<(), BackendFailure> {
        let session =
            bounded_string_field(&event.params, "sessionId").ok_or_else(protocol_failure)?;
        let info = event
            .params
            .get("targetInfo")
            .ok_or_else(protocol_failure)?;
        let target_type = bounded_string_field(info, "type").unwrap_or_default();
        let target = bounded_string_field(info, "targetId").ok_or_else(protocol_failure)?;
        match target_type.as_str() {
            "page" | "iframe" => {
                self.queue_session(session.clone())?;
                self.track_target_session(session, target)
            }
            "worker" | "service_worker" | "shared_worker" | "worklet" => client
                .call(
                    CdpMethod::RuntimeRunIfWaitingForDebugger,
                    serde_json::json!({}),
                    Some(&session),
                    Instant::now() + AUTO_ATTACHED_WORKER_RESUME_TIMEOUT,
                    &NeverCancelled,
                    self,
                )
                .map(|_| ())
                .map_err(|_| target_setup_failure()),
            _ => Err(protocol_failure()),
        }
    }

    fn observe_target_info_changed(
        &mut self,
        client: &mut CdpClient<'_>,
        event: &CdpEvent,
    ) -> Result<(), BackendFailure> {
        let info = event
            .params
            .get("targetInfo")
            .ok_or_else(protocol_failure)?;
        let target = bounded_string_field(info, "targetId");
        if target.as_deref() == self.primary_target.as_deref() {
            if let Some(url) = bounded_content_field(info, "url", 8_192) {
                if url != self.current_url {
                    self.current_url = bounded(&url, 8_192);
                    self.invalidate_document();
                }
            }
            self.current_title = bounded_content_field(info, "title", 4_096);
        } else {
            self.guard_secondary_target(client, info)?;
        }
        Ok(())
    }

    fn observe_target_destroyed(&mut self, event: &CdpEvent) -> Result<(), BackendFailure> {
        let target =
            bounded_string_field(&event.params, "targetId").ok_or_else(protocol_failure)?;
        if Some(target.as_str()) == self.primary_target.as_deref() {
            return Err(runtime_failure());
        }
        self.cleanup_target(&target);
        Ok(())
    }

    fn observe_target_detached(&mut self, event: &CdpEvent) -> Result<(), BackendFailure> {
        let session =
            bounded_string_field(&event.params, "sessionId").ok_or_else(protocol_failure)?;
        if Some(session.as_str()) == self.primary_session.as_deref() {
            return Err(runtime_failure());
        }
        self.cleanup_session(&session);
        Ok(())
    }

    fn observe_target_crashed(&mut self, event: &CdpEvent) -> Result<(), BackendFailure> {
        if let Some(target) = bounded_string_field(&event.params, "targetId") {
            if Some(target.as_str()) == self.primary_target.as_deref() {
                return Err(runtime_failure());
            }
            self.cleanup_target(&target);
            return Ok(());
        }

        let session = event.session_id.as_deref().ok_or_else(protocol_failure)?;
        // Before the explicit attach response arrives there is no secondary auto-attach surface;
        // an Inspector crash in that narrow window can only invalidate primary initialization.
        let primary_attach_pending =
            self.primary_target.is_some() && self.primary_session.is_none();
        let crashes_primary = primary_attach_pending
            || Some(session) == self.primary_session.as_deref()
            || self.session_targets.get(session).map(String::as_str)
                == self.primary_target.as_deref();
        if crashes_primary {
            return Err(runtime_failure());
        }
        self.cleanup_session(session);
        Ok(())
    }

    fn track_target_session(
        &mut self,
        session: String,
        target: String,
    ) -> Result<(), BackendFailure> {
        if let Some(existing) = self.session_targets.get(&session) {
            return if existing == &target {
                Ok(())
            } else {
                Err(protocol_failure())
            };
        }

        let maximum = MAX_SESSIONS.saturating_add(MAX_PENDING_SESSIONS);
        if self.session_targets.len() == maximum {
            return Err(protocol_failure());
        }
        self.session_targets.insert(session, target);
        Ok(())
    }

    fn cleanup_target(&mut self, target: &str) {
        let sessions = self
            .session_targets
            .iter()
            .filter(|(_, mapped_target)| *mapped_target == target)
            .map(|(session, _)| session.clone())
            .collect::<Vec<_>>();
        for session in sessions {
            self.cleanup_session(&session);
        }
    }

    fn cleanup_session(&mut self, session: &str) {
        self.configured_sessions.remove(session);
        self.pending_sessions.retain(|pending| pending != session);
        self.session_targets.remove(session);
    }
}
