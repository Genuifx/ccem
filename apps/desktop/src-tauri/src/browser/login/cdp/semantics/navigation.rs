use super::*;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct NavigationIdentity {
    frame_id: String,
    loader_id: String,
}

impl NavigationIdentity {
    fn from_navigation_response(result: &Value) -> Result<Option<Self>, BackendFailure> {
        let frame_id = bounded_string_field(result, "frameId").ok_or_else(protocol_failure)?;
        let Some(loader_id) = bounded_string_field(result, "loaderId") else {
            return Ok(None);
        };
        Ok(Some(Self {
            frame_id,
            loader_id,
        }))
    }

    fn from_frame(frame: &Value) -> Result<Self, BackendFailure> {
        Ok(Self {
            frame_id: bounded_string_field(frame, "id").ok_or_else(protocol_failure)?,
            loader_id: bounded_string_field(frame, "loaderId").ok_or_else(protocol_failure)?,
        })
    }

    fn from_lifecycle(params: &Value) -> Result<Self, BackendFailure> {
        Ok(Self {
            frame_id: bounded_string_field(params, "frameId").ok_or_else(protocol_failure)?,
            loader_id: bounded_string_field(params, "loaderId").ok_or_else(protocol_failure)?,
        })
    }
}

impl SemanticEngine {
    pub(super) fn close_non_primary_pages(
        &mut self,
        client: &mut CdpClient<'_>,
        deadline: Instant,
        cancellation: &dyn super::super::transport::CancellationProbe,
    ) -> Result<(), BackendFailure> {
        let primary = self.primary_target.clone().ok_or_else(runtime_failure)?;
        let result = client.call(
            CdpMethod::TargetGetTargets,
            serde_json::json!({}),
            None,
            deadline,
            cancellation,
            self,
        )?;
        let targets = result
            .get("targetInfos")
            .and_then(Value::as_array)
            .ok_or_else(protocol_failure)?;
        if targets.len() > 128 {
            return Err(protocol_failure());
        }
        let mut close = Vec::new();
        for target in targets {
            if bounded_string_field(target, "type").as_deref() != Some("page") {
                continue;
            }
            let target_id =
                bounded_string_field(target, "targetId").ok_or_else(protocol_failure)?;
            if target_id != primary {
                close.push(target_id);
            }
        }
        for target_id in close {
            let result = client.call(
                CdpMethod::TargetCloseTarget,
                serde_json::json!({"targetId": target_id}),
                None,
                deadline,
                cancellation,
                self,
            )?;
            if result.get("success").and_then(Value::as_bool) != Some(true) {
                return Err(protocol_failure());
            }
        }
        Ok(())
    }

    pub(super) fn navigate(
        &mut self,
        client: &mut CdpClient<'_>,
        url: &str,
        cancellation: &OperationCancellation,
        deadline: Instant,
    ) -> Result<SemanticBrowserResult, BackendFailure> {
        let decision = self.guard.authorize(TrustedNavigationRequest::new(
            url,
            TrustedNavigationSurface::AgentNavigation,
        ));
        if decision.terminal() {
            return Err(security_audit_failure());
        }
        if !decision.allowed() {
            return Err(navigation_failure());
        }
        ensure_not_cancelled(cancellation)?;
        self.invalidate_document();
        let session = self.primary_session()?;
        let result = client.call(
            CdpMethod::PageNavigate,
            serde_json::json!({"url": url}),
            Some(&session),
            deadline,
            cancellation,
            self,
        )?;
        ensure_not_cancelled(cancellation)?;
        if result.get("errorText").and_then(Value::as_str).is_some()
            || result.get("isDownload").and_then(Value::as_bool) == Some(true)
        {
            return Err(navigation_failure());
        }

        match NavigationIdentity::from_navigation_response(&result)? {
            Some(expected) => {
                self.wait_for_navigation_commit(client, &expected, cancellation, deadline)?;
            }
            None => {
                // Same-document navigations intentionally omit loaderId. The command response is
                // the commit barrier; refresh history instead of inventing a loader identity.
                self.refresh_navigation_info(client, deadline, cancellation)?;
            }
        }
        self.current_title = None;
        Ok(SemanticBrowserResult::Navigation(NavigationResult {
            url: self.current_url.clone(),
            title: self.current_title.clone(),
        }))
    }

    pub(super) fn get_url(
        &mut self,
        client: &mut CdpClient<'_>,
        cancellation: &OperationCancellation,
        deadline: Instant,
    ) -> Result<SemanticBrowserResult, BackendFailure> {
        self.guarded_document_barrier(client, cancellation, deadline)?;
        Ok(SemanticBrowserResult::Navigation(NavigationResult {
            url: self.current_url.clone(),
            title: self.current_title.clone(),
        }))
    }

    fn wait_for_navigation_commit(
        &mut self,
        client: &mut CdpClient<'_>,
        expected: &NavigationIdentity,
        cancellation: &OperationCancellation,
        deadline: Instant,
    ) -> Result<(), BackendFailure> {
        loop {
            ensure_not_cancelled(cancellation)?;
            if self.current_navigation.as_ref() == Some(expected) {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(BackendFailure::new(
                    BackendFailureCode::TimedOut,
                    "Browser navigation commit reached its fixed deadline.",
                ));
            }
            // Observe one frame at a time so a matching commit is a precise barrier. Draining a
            // burst could consume a later, unrelated navigation before the expected loader is
            // checked and would make the returned URL stale by construction.
            if client.poll_available(self, 1)? == 0 {
                let delay = deadline
                    .saturating_duration_since(Instant::now())
                    .min(OWNER_POLL_INTERVAL);
                if cancellation.wait_cancelled(delay) {
                    return Err(BackendFailure::cancelled());
                }
            }
        }
    }

    pub(super) fn observe_frame_navigated(
        &mut self,
        event: &CdpEvent,
    ) -> Result<(), BackendFailure> {
        let frame = event.params.get("frame").ok_or_else(protocol_failure)?;
        if frame.get("parentId").is_some()
            || event.session_id.as_deref() != self.primary_session.as_deref()
        {
            return Ok(());
        }
        let identity = NavigationIdentity::from_frame(frame)?;
        let url = bounded_content_field(frame, "url", 8_192).ok_or_else(protocol_failure)?;
        let changed_document = self.current_navigation.as_ref() != Some(&identity);
        self.main_frame = Some(identity.frame_id.clone());
        if changed_document {
            self.current_navigation = Some(identity);
            self.loaded_navigation = None;
        }
        let changed_url = url != self.current_url;
        if changed_url {
            self.current_url = bounded(&url, 8_192);
        }
        if changed_document || changed_url {
            self.invalidate_document();
        }
        Ok(())
    }

    pub(super) fn observe_lifecycle_event(
        &mut self,
        event: &CdpEvent,
    ) -> Result<(), BackendFailure> {
        if event.session_id.as_deref() != self.primary_session.as_deref()
            || event.params.get("name").and_then(Value::as_str) != Some("load")
        {
            return Ok(());
        }
        let identity = NavigationIdentity::from_lifecycle(&event.params)?;
        if self.current_navigation.as_ref() == Some(&identity)
            && self.loaded_navigation.as_ref() != Some(&identity)
        {
            self.loaded_navigation = Some(identity);
            self.load_generation = self.load_generation.saturating_add(1);
        }
        Ok(())
    }

    pub(super) fn guarded_document_barrier(
        &mut self,
        client: &mut CdpClient<'_>,
        cancellation: &dyn super::super::transport::CancellationProbe,
        deadline: Instant,
    ) -> Result<u64, BackendFailure> {
        self.refresh_navigation_info(client, deadline, cancellation)?;
        self.ensure_guarded_document(self.document_generation)?;
        Ok(self.document_generation)
    }

    pub(super) fn revalidate_guarded_document(
        &mut self,
        client: &mut CdpClient<'_>,
        cancellation: &dyn super::super::transport::CancellationProbe,
        deadline: Instant,
        expected_generation: u64,
    ) -> Result<(), BackendFailure> {
        self.refresh_navigation_info(client, deadline, cancellation)?;
        self.ensure_guarded_document(expected_generation)
    }

    pub(super) fn ensure_guarded_document(
        &self,
        expected_generation: u64,
    ) -> Result<(), BackendFailure> {
        if self.document_generation != expected_generation {
            return Err(BackendFailure::new(
                BackendFailureCode::InvalidSemanticReference,
                "Browser document changed before the semantic effect could run.",
            ));
        }
        let decision = self.guard.authorize(TrustedNavigationRequest::new(
            &self.current_url,
            TrustedNavigationSurface::AgentEffect,
        ));
        if decision.terminal() {
            return Err(security_audit_failure());
        }
        if !decision.allowed() {
            return Err(BackendFailure::new(
                BackendFailureCode::NavigationFailed,
                "Browser document origin is not authorized for this semantic effect.",
            ));
        }
        Ok(())
    }

    pub(super) fn invalidate_document(&mut self) {
        self.document_generation = self.document_generation.saturating_add(1);
        self.elements.invalidate();
    }

    pub(super) fn refresh_navigation_info(
        &mut self,
        client: &mut CdpClient<'_>,
        deadline: Instant,
        cancellation: &dyn super::super::transport::CancellationProbe,
    ) -> Result<(), BackendFailure> {
        let session = self.primary_session()?;
        let result = client.call(
            CdpMethod::PageGetNavigationHistory,
            serde_json::json!({}),
            Some(&session),
            deadline,
            cancellation,
            self,
        )?;
        let index = result.get("currentIndex").and_then(Value::as_u64);
        let entry = index.and_then(|index| {
            result
                .get("entries")
                .and_then(Value::as_array)
                .and_then(|entries| entries.get(index as usize))
        });
        if let Some(entry) = entry {
            if let Some(url) = bounded_content_field(entry, "url", 8_192) {
                let url = bounded(&url, 8_192);
                if url != self.current_url {
                    self.current_url = url;
                    self.invalidate_document();
                }
            }
            self.current_title = bounded_content_field(entry, "title", 4_096);
        }
        Ok(())
    }
}
