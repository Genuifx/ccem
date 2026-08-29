use super::super::backend::{
    ActionResult, BackendFailure, BackendFailureCode, DiagnosticLogResult, EvaluationResult,
    NavigationResult, SemanticBrowserCommand, SemanticBrowserResult, SemanticKey,
    SemanticWaitCondition, StructuredPageResult, WaitResult,
};
use super::super::control::OperationCancellation;
use super::artifacts::CdpArtifactStore;
use super::console_events::ConsoleEventRecorder;
use super::guard::{
    TrustedNavigationDecision, TrustedNavigationGuard, TrustedNavigationRequest,
    TrustedNavigationSurface,
};
use super::network_events::NetworkEventRecorder;
use super::protocol::{CdpEvent, CdpEventKind, CdpMethod};
use super::transport::{CdpClient, NeverCancelled, ProtocolEventHandler, OWNER_POLL_INTERVAL};
use helpers::{
    bounded, bounded_content_field, bounded_string_field, box_center, classify_document_surface,
    ensure_not_cancelled, invalid_reference, managed_auto_attach_filter, navigation_failure,
    protocol_failure, runtime_failure, string_from_map, target_setup_failure, ElementRegistry,
    PrimaryTargetBootstrap,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

mod helpers;
mod navigation;
mod projection;
mod target_events;

use navigation::NavigationIdentity;

const MAX_INTERNAL_ID_CHARS: usize = 256;
const MAX_AX_NODES: usize = 5_000;
const MAX_PAGE_TEXT_CHARS: usize = 2_000_000;
const MAX_PENDING_SESSIONS: usize = 32;
const MAX_SESSIONS: usize = 64;
const IDLE_EVENT_BURST: usize = 64;
const SECONDARY_TARGET_CLOSE_TIMEOUT: Duration = Duration::from_millis(300);
const FETCH_DISPOSITION_TIMEOUT: Duration = Duration::from_millis(300);
const EVALUATE_RENDERER_TIMEOUT_MAX: Duration = Duration::from_secs(10);
const EVALUATE_HOST_DEADLINE_MARGIN: Duration = Duration::from_millis(250);
const MAX_CSS_VIEWPORT_DIMENSION: f64 = 1_000_000.0;

pub(super) struct SemanticEngine {
    pub(super) guard: Arc<dyn TrustedNavigationGuard>,
    artifacts: CdpArtifactStore,
    pub(super) network: NetworkEventRecorder,
    pub(super) console: ConsoleEventRecorder,
    pub(super) primary_target: Option<String>,
    pub(super) primary_session: Option<String>,
    main_frame: Option<String>,
    configured_sessions: BTreeSet<String>,
    pub(super) pending_sessions: VecDeque<String>,
    session_targets: BTreeMap<String, String>,
    elements: ElementRegistry,
    current_url: String,
    current_title: Option<String>,
    current_navigation: Option<NavigationIdentity>,
    loaded_navigation: Option<NavigationIdentity>,
    load_generation: u64,
    document_generation: u64,
    primary_target_bootstrap: PrimaryTargetBootstrap,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SemanticEngineProjection {
    pub(super) current_url: String,
    pub(super) current_title: Option<String>,
    pub(super) generation: u64,
}

impl SemanticEngine {
    pub(super) fn new(
        guard: Arc<dyn TrustedNavigationGuard>,
        artifacts: CdpArtifactStore,
        network: NetworkEventRecorder,
        console: ConsoleEventRecorder,
    ) -> Self {
        Self::with_primary_target_bootstrap(
            guard,
            artifacts,
            network,
            console,
            PrimaryTargetBootstrap::CreateOwnedPage,
        )
    }

    pub(super) fn new_for_existing_target(
        guard: Arc<dyn TrustedNavigationGuard>,
        artifacts: CdpArtifactStore,
        network: NetworkEventRecorder,
        console: ConsoleEventRecorder,
    ) -> Self {
        Self::with_primary_target_bootstrap(
            guard,
            artifacts,
            network,
            console,
            PrimaryTargetBootstrap::AttachCurrentPage,
        )
    }

    fn with_primary_target_bootstrap(
        guard: Arc<dyn TrustedNavigationGuard>,
        artifacts: CdpArtifactStore,
        network: NetworkEventRecorder,
        console: ConsoleEventRecorder,
        primary_target_bootstrap: PrimaryTargetBootstrap,
    ) -> Self {
        Self {
            guard,
            artifacts,
            network,
            console,
            primary_target: None,
            primary_session: None,
            main_frame: None,
            configured_sessions: BTreeSet::new(),
            pending_sessions: VecDeque::new(),
            session_targets: BTreeMap::new(),
            elements: ElementRegistry::new(),
            current_url: "about:blank".to_string(),
            current_title: None,
            current_navigation: None,
            loaded_navigation: None,
            load_generation: 0,
            document_generation: 1,
            primary_target_bootstrap,
        }
    }

    pub(super) fn uses_exact_embedded_target_scope(&self) -> bool {
        self.primary_target_bootstrap == PrimaryTargetBootstrap::AttachCurrentPage
    }

    pub(super) fn projection(&self) -> SemanticEngineProjection {
        SemanticEngineProjection {
            current_url: self.current_url.clone(),
            current_title: self.current_title.clone(),
            generation: self.document_generation,
        }
    }

    pub(super) fn initialize(
        &mut self,
        client: &mut CdpClient<'_>,
        deadline: Instant,
    ) -> Result<(), BackendFailure> {
        let token = NeverCancelled;
        if self.primary_target_bootstrap == PrimaryTargetBootstrap::CreateOwnedPage {
            client.call(
                CdpMethod::TargetSetDiscoverTargets,
                serde_json::json!({"discover": true}),
                None,
                deadline,
                &token,
                self,
            )?;
        }
        let target_id = match self.primary_target_bootstrap {
            PrimaryTargetBootstrap::CreateOwnedPage => {
                let created = client.call(
                    CdpMethod::TargetCreateTarget,
                    serde_json::json!({"url": "about:blank"}),
                    None,
                    deadline,
                    &token,
                    self,
                )?;
                bounded_string_field(&created, "targetId").ok_or_else(protocol_failure)?
            }
            PrimaryTargetBootstrap::AttachCurrentPage => {
                let current = client.call(
                    CdpMethod::TargetGetTargetInfo,
                    serde_json::json!({}),
                    None,
                    deadline,
                    &token,
                    self,
                )?;
                let target_info = current.get("targetInfo").ok_or_else(protocol_failure)?;
                let target_type =
                    bounded_string_field(target_info, "type").ok_or_else(protocol_failure)?;
                if target_type != "page" {
                    return Err(protocol_failure());
                }
                bounded_string_field(target_info, "targetId").ok_or_else(protocol_failure)?
            }
        };
        // Claim the launch-owned target before waiting for the attach response. Target and
        // Inspector crash events can race that response and must already resolve as primary.
        self.primary_target = Some(target_id.clone());
        let attached = client.call(
            CdpMethod::TargetAttachToTarget,
            serde_json::json!({"targetId": target_id, "flatten": true}),
            None,
            deadline,
            &token,
            self,
        )?;
        let session_id =
            bounded_string_field(&attached, "sessionId").ok_or_else(protocol_failure)?;
        self.primary_session = Some(session_id.clone());
        self.queue_session(session_id)?;
        if self.primary_target_bootstrap == PrimaryTargetBootstrap::CreateOwnedPage {
            client.call(
                CdpMethod::TargetSetAutoAttach,
                serde_json::json!({
                    "autoAttach": true,
                    "waitForDebuggerOnStart": true,
                    "flatten": true,
                    "filter": managed_auto_attach_filter()
                }),
                None,
                deadline,
                &token,
                self,
            )?;
        }
        self.flush_pending_sessions(client, deadline, &token)?;
        if self.primary_target_bootstrap == PrimaryTargetBootstrap::CreateOwnedPage {
            self.close_non_primary_pages(client, deadline, &token)?;
        }
        self.refresh_navigation_info(client, deadline, &token)?;
        Ok(())
    }

    pub(super) fn execute(
        &mut self,
        client: &mut CdpClient<'_>,
        command: &SemanticBrowserCommand,
        cancellation: &OperationCancellation,
        deadline: Instant,
    ) -> Result<SemanticBrowserResult, BackendFailure> {
        self.flush_pending_sessions(client, deadline, cancellation)?;
        let result = match command {
            SemanticBrowserCommand::Navigate { url } => {
                self.navigate(client, url, cancellation, deadline)
            }
            SemanticBrowserCommand::GetUrl => self.get_url(client, cancellation, deadline),
            SemanticBrowserCommand::Click { element_ref } => {
                self.click(client, element_ref, cancellation, deadline)
            }
            SemanticBrowserCommand::Type {
                element_ref,
                text,
                replace,
            } => self.type_text(client, element_ref, text, *replace, cancellation, deadline),
            SemanticBrowserCommand::PressKey { key } => {
                self.press_key(client, *key, cancellation, deadline)
            }
            SemanticBrowserCommand::Scroll { delta_y } => {
                self.scroll(client, *delta_y, cancellation, deadline)
            }
            SemanticBrowserCommand::ReadPage => self.read_page(client, cancellation, deadline),
            SemanticBrowserCommand::Screenshot => self.screenshot(client, cancellation, deadline),
            SemanticBrowserCommand::ReadConsoleLog => {
                let artifact = self.console.read()?;
                Ok(SemanticBrowserResult::ConsoleLog(DiagnosticLogResult {
                    artifact_id: artifact.artifact_id,
                    sha256: artifact.sha256,
                    byte_size: artifact.byte_size,
                    event_count: artifact.event_count,
                    invalid_line_count: artifact.invalid_line_count,
                    recent: artifact.recent,
                    untrusted: artifact.untrusted,
                }))
            }
            SemanticBrowserCommand::ReadNetworkLog => {
                let artifact = self.network.read()?;
                Ok(SemanticBrowserResult::NetworkLog(DiagnosticLogResult {
                    artifact_id: artifact.artifact_id,
                    sha256: artifact.sha256,
                    byte_size: artifact.byte_size,
                    event_count: artifact.event_count,
                    invalid_line_count: artifact.invalid_line_count,
                    recent: artifact.recent,
                    untrusted: artifact.untrusted,
                }))
            }
            SemanticBrowserCommand::Evaluate { script } => {
                self.evaluate(client, script, cancellation, deadline)
            }
            SemanticBrowserCommand::WaitFor {
                condition,
                timeout_millis,
            } => self.wait_for(client, condition, *timeout_millis, cancellation, deadline),
        }?;
        self.flush_pending_sessions(client, deadline, cancellation)?;
        result.validate_for(command)?;
        Ok(result)
    }

    pub(super) fn poll_idle(&mut self, client: &mut CdpClient<'_>) -> Result<(), BackendFailure> {
        client.poll_available(self, IDLE_EVENT_BURST)?;
        if !self.pending_sessions.is_empty() {
            self.flush_pending_sessions(
                client,
                Instant::now() + Duration::from_secs(5),
                &NeverCancelled,
            )?;
        }
        Ok(())
    }

    fn click(
        &mut self,
        client: &mut CdpClient<'_>,
        element_ref: &str,
        cancellation: &OperationCancellation,
        deadline: Instant,
    ) -> Result<SemanticBrowserResult, BackendFailure> {
        let expected_generation = self.guarded_document_barrier(client, cancellation, deadline)?;
        let node = self.elements.resolve(element_ref)?;
        let session = self.primary_session()?;
        let model = client.call_for_node(
            CdpMethod::DomGetBoxModel,
            serde_json::json!({"backendNodeId": node}),
            Some(&session),
            deadline,
            cancellation,
            self,
        )?;
        let (x, y) = box_center(&model).ok_or_else(invalid_reference)?;
        ensure_not_cancelled(cancellation)?;
        self.revalidate_guarded_document(client, cancellation, deadline, expected_generation)?;
        client.call_for_node(
            CdpMethod::DomFocus,
            serde_json::json!({"backendNodeId": node}),
            Some(&session),
            deadline,
            cancellation,
            self,
        )?;
        ensure_not_cancelled(cancellation)?;
        self.revalidate_guarded_document(client, cancellation, deadline, expected_generation)?;
        let (_, sequence) = client.begin_input_sequence(
            CdpMethod::InputDispatchMouseEvent,
            serde_json::json!({
                "type": "mousePressed",
                "x": x,
                "y": y,
                "button": "left",
                "clickCount": 1
            }),
            &session,
            deadline,
            cancellation,
            self,
        )?;
        if let Err(error) = (|| {
            ensure_not_cancelled(cancellation)?;
            self.revalidate_guarded_document(client, cancellation, deadline, expected_generation)
        })() {
            return Err(client.abort_input_sequence_preserving_error(sequence, self, error));
        }
        client.finish_input_sequence(sequence, deadline, cancellation, self)?;
        ensure_not_cancelled(cancellation)?;
        Ok(SemanticBrowserResult::Action(ActionResult {
            completed: true,
        }))
    }

    #[allow(clippy::too_many_arguments)]
    fn type_text(
        &mut self,
        client: &mut CdpClient<'_>,
        element_ref: &str,
        text: &str,
        replace: bool,
        cancellation: &OperationCancellation,
        deadline: Instant,
    ) -> Result<SemanticBrowserResult, BackendFailure> {
        let expected_generation = self.guarded_document_barrier(client, cancellation, deadline)?;
        let node = self.elements.resolve(element_ref)?;
        let session = self.primary_session()?;
        ensure_not_cancelled(cancellation)?;
        self.revalidate_guarded_document(client, cancellation, deadline, expected_generation)?;
        client.call_for_node(
            CdpMethod::DomFocus,
            serde_json::json!({"backendNodeId": node}),
            Some(&session),
            deadline,
            cancellation,
            self,
        )?;
        if replace {
            let modifier = if cfg!(target_os = "macos") { 4 } else { 2 };
            for key_down in [
                serde_json::json!({
                    "type": "keyDown",
                    "key": "a",
                    "code": "KeyA",
                    "modifiers": modifier,
                    // Chromium requires the explicit editor command for synthetic Meta+A to
                    // select text reliably on macOS.
                    "commands": ["selectAll"]
                }),
                serde_json::json!({"type":"keyDown","key":"Backspace","code":"Backspace"}),
            ] {
                self.dispatch_key_pair(
                    client,
                    &session,
                    key_down,
                    cancellation,
                    deadline,
                    expected_generation,
                )?;
            }
        }
        ensure_not_cancelled(cancellation)?;
        self.revalidate_guarded_document(client, cancellation, deadline, expected_generation)?;
        client.call(
            CdpMethod::InputInsertText,
            serde_json::json!({"text": text}),
            Some(&session),
            deadline,
            cancellation,
            self,
        )?;
        ensure_not_cancelled(cancellation)?;
        Ok(SemanticBrowserResult::Action(ActionResult {
            completed: true,
        }))
    }

    #[allow(clippy::too_many_arguments)]
    fn dispatch_key_pair(
        &mut self,
        client: &mut CdpClient<'_>,
        session: &str,
        key_down: Value,
        cancellation: &OperationCancellation,
        deadline: Instant,
        expected_generation: u64,
    ) -> Result<(), BackendFailure> {
        ensure_not_cancelled(cancellation)?;
        self.revalidate_guarded_document(client, cancellation, deadline, expected_generation)?;
        let (_, sequence) = client.begin_input_sequence(
            CdpMethod::InputDispatchKeyEvent,
            key_down,
            session,
            deadline,
            cancellation,
            self,
        )?;
        let validation = (|| {
            ensure_not_cancelled(cancellation)?;
            self.revalidate_guarded_document(client, cancellation, deadline, expected_generation)
        })();
        if let Err(error) = validation {
            return Err(client.abort_input_sequence_preserving_error(sequence, self, error));
        }
        client.finish_input_sequence(sequence, deadline, cancellation, self)?;
        Ok(())
    }

    fn press_key(
        &mut self,
        client: &mut CdpClient<'_>,
        key: SemanticKey,
        cancellation: &OperationCancellation,
        deadline: Instant,
    ) -> Result<SemanticBrowserResult, BackendFailure> {
        let expected_generation = self.guarded_document_barrier(client, cancellation, deadline)?;
        let session = self.primary_session()?;
        ensure_not_cancelled(cancellation)?;
        self.revalidate_guarded_document(client, cancellation, deadline, expected_generation)?;
        let (_, sequence) = client.begin_input_sequence(
            CdpMethod::InputDispatchKeyEvent,
            key_down_params(key),
            &session,
            deadline,
            cancellation,
            self,
        )?;
        // Enter may submit and navigate on keyDown. That committed effect is success, not a stale
        // reference to report and retry. Cancellation still uses the sequence's fixed safety
        // release; only document-generation revalidation is intentionally omitted here.
        if let Err(error) = ensure_not_cancelled(cancellation) {
            return Err(client.abort_input_sequence_preserving_error(sequence, self, error));
        }
        client.finish_input_sequence(sequence, deadline, cancellation, self)?;
        ensure_not_cancelled(cancellation)?;
        Ok(SemanticBrowserResult::Action(ActionResult {
            completed: true,
        }))
    }

    fn scroll(
        &mut self,
        client: &mut CdpClient<'_>,
        delta_y: i64,
        cancellation: &OperationCancellation,
        deadline: Instant,
    ) -> Result<SemanticBrowserResult, BackendFailure> {
        let expected_generation = self.guarded_document_barrier(client, cancellation, deadline)?;
        let session = self.primary_session()?;
        ensure_not_cancelled(cancellation)?;
        let metrics = client.call(
            CdpMethod::PageGetLayoutMetrics,
            serde_json::json!({}),
            Some(&session),
            deadline,
            cancellation,
            self,
        )?;
        let (x, y) = css_visual_viewport_center(&metrics)?;
        ensure_not_cancelled(cancellation)?;
        self.revalidate_guarded_document(client, cancellation, deadline, expected_generation)?;
        client.call(
            CdpMethod::InputDispatchMouseEvent,
            serde_json::json!({
                "type": "mouseWheel",
                "x": x,
                "y": y,
                "deltaX": 0,
                "deltaY": delta_y,
                "buttons": 0,
                "pointerType": "mouse"
            }),
            Some(&session),
            deadline,
            cancellation,
            self,
        )?;
        ensure_not_cancelled(cancellation)?;
        // A wheel handler may navigate after the input is committed. Report that committed effect
        // as success instead of converting it into a stale-document failure that invites a retry.
        Ok(SemanticBrowserResult::Action(ActionResult {
            completed: true,
        }))
    }

    fn evaluate(
        &mut self,
        client: &mut CdpClient<'_>,
        script: &str,
        cancellation: &OperationCancellation,
        deadline: Instant,
    ) -> Result<SemanticBrowserResult, BackendFailure> {
        let expected_generation = self.guarded_document_barrier(client, cancellation, deadline)?;
        let session = self.primary_session()?;
        ensure_not_cancelled(cancellation)?;
        self.revalidate_guarded_document(client, cancellation, deadline, expected_generation)?;
        let remaining = deadline.saturating_duration_since(Instant::now());
        let Some(renderer_budget) = remaining.checked_sub(EVALUATE_HOST_DEADLINE_MARGIN) else {
            return Err(BackendFailure::new(
                BackendFailureCode::TimedOut,
                "Browser JavaScript evaluation has no bounded renderer budget remaining.",
            ));
        };
        let renderer_timeout = renderer_budget.min(EVALUATE_RENDERER_TIMEOUT_MAX);
        let renderer_timeout_millis = u64::try_from(renderer_timeout.as_millis())
            .unwrap_or(u64::MAX)
            .max(1);
        let response = client.call(
            CdpMethod::RuntimeEvaluate,
            serde_json::json!({
                "expression": script,
                "returnByValue": true,
                "awaitPromise": true,
                "generatePreview": false,
                "replMode": false,
                "timeout": renderer_timeout_millis
            }),
            Some(&session),
            deadline,
            cancellation,
            self,
        )?;
        ensure_not_cancelled(cancellation)?;
        // The script may intentionally navigate. Once Runtime.evaluate returned, do not turn its
        // committed effect into a stale-document failure that invites a duplicate evaluation.
        if response.get("exceptionDetails").is_some() {
            return Err(BackendFailure::new(
                BackendFailureCode::EvaluationFailed,
                "Browser JavaScript evaluation failed.",
            ));
        }
        let remote = response
            .get("result")
            .and_then(Value::as_object)
            .ok_or_else(protocol_failure)?;
        if remote.contains_key("objectId") {
            return Err(protocol_failure());
        }
        let value = if let Some(value) = remote.get("value") {
            value.clone()
        } else if remote.get("type").and_then(Value::as_str) == Some("undefined") {
            Value::Null
        } else if let Some(value) = remote.get("unserializableValue").and_then(Value::as_str) {
            if value.len() > 128 || value.contains('\0') {
                return Err(protocol_failure());
            }
            Value::String(value.to_string())
        } else {
            return Err(protocol_failure());
        };
        Ok(SemanticBrowserResult::Evaluation(EvaluationResult {
            value,
            untrusted: true,
        }))
    }

    fn read_page(
        &mut self,
        client: &mut CdpClient<'_>,
        cancellation: &OperationCancellation,
        deadline: Instant,
    ) -> Result<SemanticBrowserResult, BackendFailure> {
        let expected_generation = self.guarded_document_barrier(client, cancellation, deadline)?;
        let session = self.primary_session()?;
        let result = client.call(
            CdpMethod::AccessibilityGetFullAxTree,
            serde_json::json!({}),
            Some(&session),
            deadline,
            cancellation,
            self,
        )?;
        self.revalidate_guarded_document(client, cancellation, deadline, expected_generation)?;
        self.elements.rebuild();
        let (text, elements) = self.project_ax_tree(&result)?;
        Ok(SemanticBrowserResult::StructuredPage(
            StructuredPageResult {
                url: self.current_url.clone(),
                title: self.current_title.clone(),
                untrusted: true,
                text,
                elements,
            },
        ))
    }

    fn screenshot(
        &mut self,
        client: &mut CdpClient<'_>,
        cancellation: &OperationCancellation,
        deadline: Instant,
    ) -> Result<SemanticBrowserResult, BackendFailure> {
        let expected_generation = self.guarded_document_barrier(client, cancellation, deadline)?;
        let session = self.primary_session()?;
        ensure_not_cancelled(cancellation)?;
        let result = client.call(
            CdpMethod::PageCaptureScreenshot,
            serde_json::json!({
                "format": "png",
                "fromSurface": true,
                "captureBeyondViewport": false
            }),
            Some(&session),
            deadline,
            cancellation,
            self,
        )?;
        self.revalidate_guarded_document(client, cancellation, deadline, expected_generation)?;
        ensure_not_cancelled(cancellation)?;
        let data = result
            .get("data")
            .and_then(Value::as_str)
            .ok_or_else(protocol_failure)?;
        Ok(SemanticBrowserResult::Screenshot(
            self.artifacts.store_screenshot(data)?,
        ))
    }

    fn wait_for(
        &mut self,
        client: &mut CdpClient<'_>,
        condition: &SemanticWaitCondition,
        timeout_millis: u64,
        cancellation: &OperationCancellation,
        command_deadline: Instant,
    ) -> Result<SemanticBrowserResult, BackendFailure> {
        let expected_generation =
            self.guarded_document_barrier(client, cancellation, command_deadline)?;
        let wait_deadline =
            (Instant::now() + Duration::from_millis(timeout_millis)).min(command_deadline);
        let starting_load = self.load_generation;
        loop {
            ensure_not_cancelled(cancellation)?;
            if Instant::now() >= wait_deadline {
                return Err(BackendFailure::new(
                    BackendFailureCode::TimedOut,
                    "Browser semantic wait reached its fixed deadline.",
                ));
            }
            client.poll_available(self, IDLE_EVENT_BURST)?;
            self.ensure_guarded_document(expected_generation)?;
            let satisfied = match condition {
                SemanticWaitCondition::LoadComplete => self.load_generation > starting_load,
                SemanticWaitCondition::ElementPresent { element_ref } => {
                    self.elements.resolve(element_ref)?;
                    true
                }
                SemanticWaitCondition::TextPresent { text } => {
                    self.ax_contains_text(client, text, cancellation, wait_deadline)?
                }
            };
            // AX/text evaluation itself can receive navigation events while waiting for its CDP
            // response. Never return page-derived data from a document generation that changed
            // during that call.
            self.ensure_guarded_document(expected_generation)?;
            if satisfied {
                return Ok(SemanticBrowserResult::Wait(WaitResult { satisfied: true }));
            }
            let delay = wait_deadline
                .saturating_duration_since(Instant::now())
                .min(OWNER_POLL_INTERVAL);
            if cancellation.wait_cancelled(delay) {
                return Err(BackendFailure::cancelled());
            }
        }
    }

    pub(super) fn flush_pending_sessions(
        &mut self,
        client: &mut CdpClient<'_>,
        deadline: Instant,
        _cancellation: &dyn super::transport::CancellationProbe,
    ) -> Result<(), BackendFailure> {
        // Target setup is an authority operation, not an Agent operation. Auto-attached targets are
        // paused by Target.setAutoAttach and must either receive the complete Fetch-first setup or
        // make the owner terminal. Agent cancellation can stop its requested effect but cannot
        // strand a running target between security and observability domains.
        let setup_cancellation = NeverCancelled;
        while let Some(session) = self.pending_sessions.front().cloned() {
            if self.configured_sessions.contains(&session) {
                self.pending_sessions.pop_front();
                continue;
            }
            if self.configured_sessions.len() == MAX_SESSIONS {
                return Err(protocol_failure());
            }
            for (method, params) in [
                (
                    CdpMethod::FetchEnable,
                    serde_json::json!({
                        "patterns": [{"urlPattern": "*", "resourceType": "Document", "requestStage": "Request"}]
                    }),
                ),
                (
                    CdpMethod::TargetSetAutoAttach,
                    serde_json::json!({
                        "autoAttach": true,
                        "waitForDebuggerOnStart": true,
                        "flatten": true,
                        "filter": managed_auto_attach_filter()
                    }),
                ),
                (CdpMethod::PageEnable, serde_json::json!({})),
                (
                    CdpMethod::PageSetLifecycleEventsEnabled,
                    serde_json::json!({"enabled": true}),
                ),
                (CdpMethod::AccessibilityEnable, serde_json::json!({})),
                (CdpMethod::DomEnable, serde_json::json!({})),
                (CdpMethod::NetworkEnable, serde_json::json!({})),
                (CdpMethod::RuntimeEnable, serde_json::json!({})),
                (
                    CdpMethod::RuntimeRunIfWaitingForDebugger,
                    serde_json::json!({}),
                ),
            ] {
                if let Err(error) = client.call(
                    method,
                    params,
                    Some(&session),
                    deadline,
                    &setup_cancellation,
                    self,
                ) {
                    eprintln!(
                        "CEF target security setup failed at {}: {} ({})",
                        method.as_str(),
                        error,
                        error.code.as_str(),
                    );
                    return Err(target_setup_failure());
                }
            }
            // A detach observed while setup commands were in flight invalidates the setup. Never
            // reinsert that session as configured; terminate the owner so no target can escape its
            // paused security boundary.
            if self.pending_sessions.front() != Some(&session) {
                return Err(target_setup_failure());
            }
            self.pending_sessions.pop_front();
            self.configured_sessions.insert(session);
        }
        Ok(())
    }

    fn queue_session(&mut self, session: String) -> Result<(), BackendFailure> {
        if !self.configured_sessions.contains(&session) && !self.pending_sessions.contains(&session)
        {
            if self.pending_sessions.len() == MAX_PENDING_SESSIONS {
                return Err(protocol_failure());
            }
            self.pending_sessions.push_back(session);
        }
        Ok(())
    }

    pub(super) fn primary_session(&self) -> Result<String, BackendFailure> {
        self.primary_session.clone().ok_or_else(runtime_failure)
    }

    fn handle_fetch(
        &mut self,
        client: &mut CdpClient<'_>,
        event: &CdpEvent,
    ) -> Result<(), BackendFailure> {
        let object = event.params.as_object().ok_or_else(protocol_failure)?;
        let request_id = string_from_map(object, "requestId").ok_or_else(protocol_failure)?;
        let resource_type = string_from_map(object, "resourceType").unwrap_or_default();
        let request = object
            .get("request")
            .and_then(Value::as_object)
            .ok_or_else(protocol_failure)?;
        let url = string_from_map(request, "url").ok_or_else(protocol_failure)?;
        let frame_id = string_from_map(object, "frameId");
        let surface = classify_document_surface(
            event.session_id.as_deref(),
            self.primary_session.as_deref(),
            frame_id.as_deref(),
            self.main_frame.as_deref(),
        );
        let decision = (resource_type == "Document").then(|| {
            self.guard
                .authorize(TrustedNavigationRequest::new(&url, surface))
        });
        if decision.is_some_and(TrustedNavigationDecision::terminal) {
            return Err(navigation_policy_failure());
        }
        let allowed = decision.is_some_and(TrustedNavigationDecision::allowed);
        let (method, params) = if allowed {
            (
                CdpMethod::FetchContinueRequest,
                serde_json::json!({"requestId": request_id}),
            )
        } else {
            (
                CdpMethod::FetchFailRequest,
                serde_json::json!({"requestId": request_id, "errorReason": "Aborted"}),
            )
        };
        client
            .call(
                method,
                params,
                event.session_id.as_deref(),
                Instant::now() + FETCH_DISPOSITION_TIMEOUT,
                &NeverCancelled,
                self,
            )
            .map(|_| ())
            .map_err(|_| protocol_failure())
    }

    fn guard_secondary_target(
        &mut self,
        client: &mut CdpClient<'_>,
        info: &Value,
    ) -> Result<(), BackendFailure> {
        if self.primary_target.is_none() {
            return Ok(());
        }
        let target_id = bounded_string_field(info, "targetId").ok_or_else(protocol_failure)?;
        if Some(target_id.as_str()) == self.primary_target.as_deref() {
            return Ok(());
        }
        let url = bounded_content_field(info, "url", 8_192).unwrap_or_default();
        let target_type = bounded_string_field(info, "type").ok_or_else(protocol_failure)?;
        let surface = match target_type.as_str() {
            "iframe" => TrustedNavigationSurface::Iframe,
            "page" => TrustedNavigationSurface::Popup,
            _ => return Ok(()),
        };
        // CEF only creates this target after its native user-gesture gate admitted the popup.
        // Chromium commonly reports a provisional blank URL first; defer that decision until
        // Target.targetInfoChanged supplies the real destination, which is guarded below.
        if surface == TrustedNavigationSurface::Popup
            && (url.is_empty() || url == "about:blank" || url.starts_with("about:blank#"))
        {
            return Ok(());
        }
        let decision = self
            .guard
            .authorize(TrustedNavigationRequest::new(&url, surface));
        if decision.terminal() {
            return Err(navigation_policy_failure());
        }
        // Native CEF popup admission already requires a real user gesture. Once that fixed gate
        // admitted an HTTP(S) popup, keep it within this browser instance; OAuth must not be
        // destroyed merely because the same session is currently under Agent control.
        if !decision.allowed() {
            let result = client
                .call(
                    CdpMethod::TargetCloseTarget,
                    serde_json::json!({"targetId": target_id}),
                    None,
                    Instant::now() + SECONDARY_TARGET_CLOSE_TIMEOUT,
                    &NeverCancelled,
                    self,
                )
                .map_err(|_| protocol_failure())?;
            if result.get("success").and_then(Value::as_bool) != Some(true) {
                return Err(protocol_failure());
            }
        }
        Ok(())
    }
}

fn css_visual_viewport_center(metrics: &Value) -> Result<(f64, f64), BackendFailure> {
    let viewport = metrics
        .get("cssVisualViewport")
        .and_then(Value::as_object)
        .ok_or_else(viewport_metrics_failure)?;
    let width = viewport
        .get("clientWidth")
        .and_then(Value::as_f64)
        .ok_or_else(viewport_metrics_failure)?;
    let height = viewport
        .get("clientHeight")
        .and_then(Value::as_f64)
        .ok_or_else(viewport_metrics_failure)?;
    if !width.is_finite()
        || !height.is_finite()
        || width <= 0.0
        || height <= 0.0
        || width > MAX_CSS_VIEWPORT_DIMENSION
        || height > MAX_CSS_VIEWPORT_DIMENSION
    {
        return Err(viewport_metrics_failure());
    }
    let center = (width / 2.0, height / 2.0);
    if !center.0.is_finite() || !center.1.is_finite() || center.0 <= 0.0 || center.1 <= 0.0 {
        return Err(viewport_metrics_failure());
    }
    Ok(center)
}

fn viewport_metrics_failure() -> BackendFailure {
    BackendFailure::new(
        BackendFailureCode::ProtocolViolation,
        "Browser viewport metrics were unavailable for scrolling.",
    )
}

fn key_down_params(key: SemanticKey) -> Value {
    let text = matches!(key, SemanticKey::Enter).then_some("\r");
    let (key, code, virtual_key_code) = match key {
        SemanticKey::Enter => ("Enter", "Enter", 13),
        SemanticKey::Tab => ("Tab", "Tab", 9),
        SemanticKey::Escape => ("Escape", "Escape", 27),
        SemanticKey::Backspace => ("Backspace", "Backspace", 8),
        SemanticKey::Delete => ("Delete", "Delete", 46),
        SemanticKey::ArrowUp => ("ArrowUp", "ArrowUp", 38),
        SemanticKey::ArrowDown => ("ArrowDown", "ArrowDown", 40),
        SemanticKey::ArrowLeft => ("ArrowLeft", "ArrowLeft", 37),
        SemanticKey::ArrowRight => ("ArrowRight", "ArrowRight", 39),
        SemanticKey::Home => ("Home", "Home", 36),
        SemanticKey::End => ("End", "End", 35),
        SemanticKey::PageUp => ("PageUp", "PageUp", 33),
        SemanticKey::PageDown => ("PageDown", "PageDown", 34),
        SemanticKey::Space => (" ", "Space", 32),
    };
    let mut params = serde_json::json!({
        "type": "keyDown",
        "key": key,
        "code": code,
        "windowsVirtualKeyCode": virtual_key_code
    });
    if let Some(text) = text {
        params["text"] = Value::from(text);
        params["unmodifiedText"] = Value::from(text);
    }
    params
}

impl ProtocolEventHandler for SemanticEngine {
    fn on_event(
        &mut self,
        client: &mut CdpClient<'_>,
        event: CdpEvent,
    ) -> Result<(), BackendFailure> {
        match event.kind {
            CdpEventKind::TargetCreated
            | CdpEventKind::TargetAttached
            | CdpEventKind::TargetInfoChanged
            | CdpEventKind::TargetDestroyed
            | CdpEventKind::TargetDetached
            | CdpEventKind::TargetCrashed => self.handle_target_event(client, &event)?,
            CdpEventKind::FrameNavigated => self.observe_frame_navigated(&event)?,
            CdpEventKind::LifecycleEvent => self.observe_lifecycle_event(&event)?,
            // This event has no frame or loader identity, so it cannot complete an Agent wait.
            CdpEventKind::LoadEventFired => {}
            CdpEventKind::RequestWillBeSent
            | CdpEventKind::ResponseReceived
            | CdpEventKind::LoadingFinished
            | CdpEventKind::LoadingFailed => self.network.record(&event)?,
            CdpEventKind::ConsoleApiCalled => self.console.record(&event)?,
            CdpEventKind::RequestPaused => self.handle_fetch(client, &event)?,
            CdpEventKind::Other => {}
        }
        Ok(())
    }
}

fn navigation_policy_failure() -> BackendFailure {
    BackendFailure::new(
        BackendFailureCode::RuntimeUnavailable,
        "Browser navigation policy is unavailable.",
    )
}

#[cfg(test)]
#[path = "semantics_tests.rs"]
pub(super) mod tests;

#[cfg(test)]
#[path = "input_sequence_race_tests.rs"]
mod input_sequence_race_tests;

#[cfg(test)]
#[path = "semantics_secondary_target_tests.rs"]
mod secondary_target_tests;

#[cfg(test)]
#[path = "semantics_state_tests.rs"]
mod state_tests;
