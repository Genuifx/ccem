use super::super::backend::{
    ActionResult, BackendFailure, BackendFailureCode, DiagnosticLogResult, NavigationResult,
    SemanticBrowserCommand, SemanticBrowserResult, SemanticWaitCondition, StructuredPageResult,
    WaitResult,
};
use super::super::control::OperationCancellation;
use super::super::policy::NormalizedOrigin;
use super::artifacts::CdpArtifactStore;
use super::console_events::ConsoleEventRecorder;
use super::guard::{
    TrustedHandoffPreflightDenial, TrustedHandoffPreflightDenialKind, TrustedNavigationDecision,
    TrustedNavigationGuard, TrustedNavigationRequest, TrustedNavigationSurface,
    TrustedSecurityEvent,
};
use super::network_events::NetworkEventRecorder;
use super::protocol::{CdpEvent, CdpEventKind, CdpMethod};
use super::transport::{CdpClient, NeverCancelled, ProtocolEventHandler, OWNER_POLL_INTERVAL};
use helpers::{
    bounded, bounded_content_field, bounded_string_field, box_center, classify_document_surface,
    ensure_not_cancelled, invalid_reference, navigation_failure, protocol_failure, runtime_failure,
    string_from_map, target_setup_failure,
};
use rand::{rngs::OsRng, RngCore};
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
const INPUT_CLEANUP_TIMEOUT: Duration = Duration::from_secs(1);
const SECONDARY_TARGET_CLOSE_TIMEOUT: Duration = Duration::from_millis(300);
const FETCH_DISPOSITION_TIMEOUT: Duration = Duration::from_millis(300);

fn managed_auto_attach_filter() -> Value {
    // Chrome exposes internal targets such as `browser_ui` alongside page and worker targets.
    // Auto-attaching every target would pause an unsupported internal surface and then force a
    // terminal protocol failure. Keep the supported set closed and exclude everything else; an
    // unexpected attached type still remains terminal in the event handler.
    serde_json::json!([
        {"type": "page", "exclude": false},
        {"type": "iframe", "exclude": false},
        {"type": "worker", "exclude": false},
        {"type": "service_worker", "exclude": false},
        {"type": "shared_worker", "exclude": false},
        {"type": "worklet", "exclude": false},
        {"exclude": true}
    ])
}

#[derive(Debug, Clone, Copy)]
struct NodeBinding {
    backend_node_id: u64,
    generation: u64,
}

#[derive(Debug)]
struct ElementRegistry {
    generation: u64,
    nodes: BTreeMap<String, NodeBinding>,
}

impl ElementRegistry {
    fn new() -> Self {
        Self {
            generation: 1,
            nodes: BTreeMap::new(),
        }
    }

    fn invalidate(&mut self) {
        self.generation = self.generation.saturating_add(1);
        self.nodes.clear();
    }

    fn rebuild(&mut self) {
        self.invalidate();
    }

    fn insert(&mut self, backend_node_id: u64) -> Result<String, BackendFailure> {
        if self.nodes.len() == MAX_AX_NODES {
            return Err(protocol_failure());
        }
        let mut random = [0_u8; 12];
        OsRng.fill_bytes(&mut random);
        let element_ref = format!("el-{:x}-{}", self.generation, hex::encode(random));
        self.nodes.insert(
            element_ref.clone(),
            NodeBinding {
                backend_node_id,
                generation: self.generation,
            },
        );
        Ok(element_ref)
    }

    fn resolve(&self, element_ref: &str) -> Result<u64, BackendFailure> {
        let binding = self.nodes.get(element_ref).ok_or_else(invalid_reference)?;
        if binding.generation != self.generation {
            return Err(invalid_reference());
        }
        Ok(binding.backend_node_id)
    }
}

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
    blocked_file_chooser_count: u64,
    blocked_download_count: u64,
    canceled_download_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SemanticEngineProjection {
    pub(super) current_url: String,
    pub(super) current_title: Option<String>,
    pub(super) generation: u64,
    pub(super) blocked_file_chooser_count: u64,
    pub(super) blocked_download_count: u64,
    pub(super) canceled_download_count: u64,
}

impl SemanticEngine {
    pub(super) fn new(
        guard: Arc<dyn TrustedNavigationGuard>,
        artifacts: CdpArtifactStore,
        network: NetworkEventRecorder,
        console: ConsoleEventRecorder,
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
            blocked_file_chooser_count: 0,
            blocked_download_count: 0,
            canceled_download_count: 0,
        }
    }

    pub(super) fn projection(&self) -> SemanticEngineProjection {
        SemanticEngineProjection {
            current_url: self.current_url.clone(),
            current_title: self.current_title.clone(),
            generation: self.document_generation,
            blocked_file_chooser_count: self.blocked_file_chooser_count,
            blocked_download_count: self.blocked_download_count,
            canceled_download_count: self.canceled_download_count,
        }
    }

    pub(super) fn validate_current_origin(
        &mut self,
        client: &mut CdpClient<'_>,
        expected: &NormalizedOrigin,
        deadline: Instant,
    ) -> Result<SemanticEngineProjection, BackendFailure> {
        self.guarded_document_barrier(client, &NeverCancelled, deadline)?;
        let actual =
            NormalizedOrigin::parse(&self.current_url).map_err(|_| navigation_failure())?;
        if &actual != expected {
            return Err(navigation_failure());
        }
        Ok(self.projection())
    }

    pub(super) fn initialize(
        &mut self,
        client: &mut CdpClient<'_>,
        deadline: Instant,
    ) -> Result<(), BackendFailure> {
        let token = NeverCancelled;
        // Download behavior is browser-global and must fail closed before any target can navigate
        // or receive Agent input. M2 intentionally has no temporary `allow` window yet.
        client.call(
            CdpMethod::BrowserSetDownloadBehavior,
            serde_json::json!({"behavior": "deny", "eventsEnabled": true}),
            None,
            deadline,
            &token,
            self,
        )?;
        client.call(
            CdpMethod::TargetSetDiscoverTargets,
            serde_json::json!({"discover": true}),
            None,
            deadline,
            &token,
            self,
        )?;
        let created = client.call(
            CdpMethod::TargetCreateTarget,
            serde_json::json!({"url": "about:blank"}),
            None,
            deadline,
            &token,
            self,
        )?;
        let target_id = bounded_string_field(&created, "targetId").ok_or_else(protocol_failure)?;
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
        self.flush_pending_sessions(client, deadline, &token)?;
        self.close_non_primary_pages(client, deadline, &token)?;
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
        let mut press_may_be_down = false;
        let dispatch_result = (|| {
            ensure_not_cancelled(cancellation)?;
            self.revalidate_guarded_document(client, cancellation, deadline, expected_generation)?;
            press_may_be_down = true;
            client.call(
                CdpMethod::InputDispatchMouseEvent,
                serde_json::json!({
                    "type": "mousePressed",
                    "x": x,
                    "y": y,
                    "button": "left",
                    "clickCount": 1
                }),
                Some(&session),
                deadline,
                cancellation,
                self,
            )?;
            ensure_not_cancelled(cancellation)?;
            self.revalidate_guarded_document(client, cancellation, deadline, expected_generation)?;
            client.call(
                CdpMethod::InputDispatchMouseEvent,
                serde_json::json!({
                    "type": "mouseReleased",
                    "x": x,
                    "y": y,
                    "button": "left",
                    "clickCount": 1
                }),
                Some(&session),
                deadline,
                cancellation,
                self,
            )?;
            press_may_be_down = false;
            Ok::<(), BackendFailure>(())
        })();
        if let Err(error) = dispatch_result {
            if press_may_be_down {
                self.release_mouse_best_effort(client, &session, x, y);
            }
            return Err(error);
        }
        ensure_not_cancelled(cancellation)?;
        Ok(SemanticBrowserResult::Action(ActionResult {
            completed: true,
        }))
    }

    fn release_mouse_best_effort(
        &mut self,
        client: &mut CdpClient<'_>,
        session: &str,
        x: f64,
        y: f64,
    ) {
        let _ = client.call(
            CdpMethod::InputDispatchMouseEvent,
            serde_json::json!({
                "type": "mouseReleased",
                "x": x,
                "y": y,
                "button": "left",
                "buttons": 0,
                "clickCount": 0
            }),
            Some(session),
            Instant::now() + INPUT_CLEANUP_TIMEOUT,
            &NeverCancelled,
            self,
        );
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
            for (key_down, key_up) in [
                (
                    serde_json::json!({"type":"keyDown","key":"a","code":"KeyA","modifiers":modifier}),
                    serde_json::json!({"type":"keyUp","key":"a","code":"KeyA","modifiers":modifier}),
                ),
                (
                    serde_json::json!({"type":"keyDown","key":"Backspace","code":"Backspace"}),
                    serde_json::json!({"type":"keyUp","key":"Backspace","code":"Backspace"}),
                ),
            ] {
                self.dispatch_key_pair(
                    client,
                    &session,
                    key_down,
                    key_up,
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
        key_up: Value,
        cancellation: &OperationCancellation,
        deadline: Instant,
        expected_generation: u64,
    ) -> Result<(), BackendFailure> {
        ensure_not_cancelled(cancellation)?;
        self.revalidate_guarded_document(client, cancellation, deadline, expected_generation)?;
        let mut key_may_be_down = true;
        let dispatch_result = (|| {
            client.call(
                CdpMethod::InputDispatchKeyEvent,
                key_down,
                Some(session),
                deadline,
                cancellation,
                self,
            )?;
            ensure_not_cancelled(cancellation)?;
            self.revalidate_guarded_document(client, cancellation, deadline, expected_generation)?;
            client.call(
                CdpMethod::InputDispatchKeyEvent,
                key_up.clone(),
                Some(session),
                deadline,
                cancellation,
                self,
            )?;
            key_may_be_down = false;
            Ok::<(), BackendFailure>(())
        })();
        if let Err(error) = dispatch_result {
            if key_may_be_down {
                self.release_key_best_effort(client, session, key_up);
            }
            return Err(error);
        }
        Ok(())
    }

    fn release_key_best_effort(
        &mut self,
        client: &mut CdpClient<'_>,
        session: &str,
        key_up: Value,
    ) {
        let _ = client.call(
            CdpMethod::InputDispatchKeyEvent,
            key_up,
            Some(session),
            Instant::now() + INPUT_CLEANUP_TIMEOUT,
            &NeverCancelled,
            self,
        );
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
                (
                    CdpMethod::PageSetInterceptFileChooserDialog,
                    serde_json::json!({"enabled": true, "cancel": true}),
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
                client
                    .call(
                        method,
                        params,
                        Some(&session),
                        deadline,
                        &setup_cancellation,
                        self,
                    )
                    .map_err(|_| target_setup_failure())?;
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
            return Err(security_audit_failure());
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
        let decision = self
            .guard
            .authorize(TrustedNavigationRequest::new(&url, surface));
        if decision.terminal() {
            return Err(security_audit_failure());
        }
        let user_control = decision.allowed() && decision.code() == "user_control";
        let close = !decision.allowed() || (target_type == "page" && !user_control);
        if close {
            if decision.allowed() {
                self.guard
                    .record_handoff_preflight_denial(TrustedHandoffPreflightDenial {
                        kind: TrustedHandoffPreflightDenialKind::ExtraPage,
                        target_url: Some(&url),
                    })
                    .map_err(|_| security_audit_failure())?;
            }
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

    fn observe_blocked_file_chooser(&mut self, event: &CdpEvent) -> Result<(), BackendFailure> {
        let session = event.session_id.as_deref().ok_or_else(protocol_failure)?;
        if Some(session) != self.primary_session.as_deref()
            && !self.configured_sessions.contains(session)
            && !self
                .pending_sessions
                .iter()
                .any(|pending| pending == session)
        {
            return Err(protocol_failure());
        }
        let params = event.params.as_object().ok_or_else(protocol_failure)?;
        let mode = string_from_map(params, "mode").ok_or_else(protocol_failure)?;
        if !matches!(mode.as_str(), "selectSingle" | "selectMultiple") {
            return Err(protocol_failure());
        }
        // `cancel: true` already denied the browser effect. Retain only a monotonic signal that
        // the gate fired; never retain a DOM node, a renderer payload, or any local path-shaped
        // data in the owner projection.
        self.guard
            .record_security_event(TrustedSecurityEvent::UploadBlocked)
            .map_err(|_| security_audit_failure())?;
        self.blocked_file_chooser_count = self.blocked_file_chooser_count.saturating_add(1);
        Ok(())
    }
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
            CdpEventKind::FileChooserOpened => self.observe_blocked_file_chooser(&event)?,
            CdpEventKind::DownloadWillBegin => {
                self.guard
                    .record_security_event(TrustedSecurityEvent::DownloadBlocked)
                    .map_err(|_| security_audit_failure())?;
                self.blocked_download_count = self.blocked_download_count.saturating_add(1);
            }
            CdpEventKind::DownloadProgress => {
                if event.params.get("state").and_then(Value::as_str) == Some("canceled") {
                    self.guard
                        .record_security_event(TrustedSecurityEvent::DownloadCanceled)
                        .map_err(|_| security_audit_failure())?;
                    self.canceled_download_count = self.canceled_download_count.saturating_add(1);
                }
            }
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

fn security_audit_failure() -> BackendFailure {
    BackendFailure::new(
        BackendFailureCode::RuntimeUnavailable,
        "Browser transfer-denial audit is unavailable.",
    )
}

#[cfg(test)]
#[path = "semantics_tests.rs"]
pub(super) mod tests;

#[cfg(test)]
#[path = "semantics_security_audit_tests.rs"]
mod security_audit_tests;

#[cfg(test)]
#[path = "semantics_secondary_target_tests.rs"]
mod secondary_target_tests;
