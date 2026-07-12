use super::super::backend::{
    BackendFailure, BackendFailureCode, SemanticBrowserBackend, SemanticBrowserCommand,
    SemanticBrowserResult,
};
use super::super::control::OperationCancellation;
use super::super::policy::NormalizedOrigin;
use super::super::supervisor::{ManagedLoginRuntime, VerifiedRuntimeTerminationHandle};
use super::artifacts::CdpArtifactStore;
use super::console_events::ConsoleEventRecorder;
use super::guard::TrustedNavigationGuard;
use super::network_events::NetworkEventRecorder;
pub(in crate::browser::login) use super::owner_config::ChromiumLoginBackendConfig;
use super::owner_protocol::run_protocol_owner;
use super::owner_transition::{
    owner_transition_channel, OwnerTransitionClient, OwnerTransitionInbox,
};
use super::semantics::SemanticEngine;
use super::transport::OWNER_POLL_INTERVAL;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, RwLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const OWNER_REQUEST_CAPACITY: usize = 32;
pub(super) const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(12);
const GRACEFUL_OWNER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);
pub(super) const TRUSTED_BARRIER_TIMEOUT: Duration = Duration::from_secs(5);

pub(super) enum OwnerRequest {
    Execute {
        command: SemanticBrowserCommand,
        cancellation: OperationCancellation,
        deadline: Instant,
        response: SyncSender<Result<SemanticBrowserResult, BackendFailure>>,
    },
    ValidateCurrentOrigin {
        expected: NormalizedOrigin,
        response: SyncSender<Result<ChromiumOwnerProjection, BackendFailure>>,
    },
    PreflightHandoff {
        expected: NormalizedOrigin,
        response: SyncSender<Result<(), BackendFailure>>,
    },
    BeginDiagnosticSegment {
        handoff_epoch: u64,
        response: SyncSender<Result<(), BackendFailure>>,
    },
    StopDiagnosticSegment {
        response: SyncSender<Result<(), BackendFailure>>,
    },
    Shutdown,
}

/// External semantic backend handle. It owns no CDP target/session/pipe handle; every operation is
/// serialized through the bounded owner queue.
pub(in crate::browser::login) struct ChromiumLoginBackend {
    pub(super) requests: SyncSender<OwnerRequest>,
    transitions: OwnerTransitionClient,
    pub(super) shutdown: Arc<AtomicBool>,
    join: Mutex<Option<JoinHandle<Result<(), BackendFailure>>>>,
    done: Mutex<Receiver<Result<(), BackendFailure>>>,
    command_timeout: Duration,
    projection: Arc<RwLock<ChromiumOwnerProjection>>,
    pub(super) termination: Arc<VerifiedRuntimeTerminationHandle>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::browser::login) struct ChromiumOwnerProjection {
    pub(in crate::browser::login) current_url: String,
    pub(in crate::browser::login) current_title: Option<String>,
    pub(in crate::browser::login) generation: u64,
    pub(in crate::browser::login) blocked_download_count: u64,
    pub(in crate::browser::login) canceled_download_count: u64,
    pub(in crate::browser::login) ready: bool,
    pub(in crate::browser::login) terminated: bool,
}

impl Default for ChromiumOwnerProjection {
    fn default() -> Self {
        Self {
            current_url: "about:blank".to_string(),
            current_title: None,
            generation: 0,
            blocked_download_count: 0,
            canceled_download_count: 0,
            ready: false,
            terminated: false,
        }
    }
}

impl ChromiumLoginBackend {
    pub(in crate::browser::login) fn spawn(
        runtime: ManagedLoginRuntime,
        config: ChromiumLoginBackendConfig,
        guard: Arc<dyn TrustedNavigationGuard>,
    ) -> Result<Self, BackendFailure> {
        let command_timeout = config.command_timeout;
        let termination = Arc::new(runtime.verified_termination_handle());
        let (requests, receiver) = mpsc::sync_channel(OWNER_REQUEST_CAPACITY);
        let (transitions, transition_inbox) = owner_transition_channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let (done_tx, done_rx) = mpsc::sync_channel(1);
        let shutdown = Arc::new(AtomicBool::new(false));
        let owner_shutdown = Arc::clone(&shutdown);
        let owner_termination = Arc::clone(&termination);
        let projection = Arc::new(RwLock::new(ChromiumOwnerProjection::default()));
        let owner_projection = Arc::clone(&projection);
        let join = thread::Builder::new()
            .name("ccem-login-cdp-owner".to_string())
            .spawn(move || {
                let result = run_managed_owner(
                    runtime,
                    config,
                    guard,
                    receiver,
                    transition_inbox,
                    owner_shutdown,
                    owner_termination,
                    ready_tx,
                    owner_projection,
                );
                let _ = done_tx.send(result.clone());
                result
            })
            .map_err(|_| runtime_failure())?;
        match ready_rx.recv_timeout(STARTUP_TIMEOUT) {
            Ok(Ok(())) => Ok(Self {
                requests,
                transitions,
                shutdown,
                join: Mutex::new(Some(join)),
                done: Mutex::new(done_rx),
                command_timeout,
                projection,
                termination,
            }),
            Ok(Err(error)) => {
                shutdown.store(true, Ordering::Release);
                let _ = termination.force_verified_domain();
                drop(join);
                Err(error)
            }
            Err(_) => {
                shutdown.store(true, Ordering::Release);
                // A stuck startup may be blocked in pipe I/O. Closing the exact verified process
                // domain wakes it; the detached owner still finalizes metadata/profile ownership.
                let _ = termination.force_verified_domain();
                drop(join);
                Err(BackendFailure::new(
                    BackendFailureCode::TimedOut,
                    "Browser CDP owner startup reached its fixed deadline.",
                ))
            }
        }
    }

    pub(in crate::browser::login) fn projection(
        &self,
    ) -> Result<ChromiumOwnerProjection, BackendFailure> {
        self.projection
            .read()
            .map(|projection| projection.clone())
            .map_err(|_| runtime_failure())
    }

    pub(in crate::browser::login) fn validate_current_origin(
        &self,
        expected: NormalizedOrigin,
    ) -> Result<ChromiumOwnerProjection, BackendFailure> {
        if self.shutdown.load(Ordering::Acquire) {
            return Err(runtime_failure());
        }
        let (response, result) = mpsc::sync_channel(1);
        self.requests
            .try_send(OwnerRequest::ValidateCurrentOrigin { expected, response })
            .map_err(|_| runtime_failure())?;
        result
            .recv_timeout(TRUSTED_BARRIER_TIMEOUT)
            .map_err(|error| match error {
                RecvTimeoutError::Timeout => BackendFailure::new(
                    BackendFailureCode::TimedOut,
                    "Browser trusted origin barrier reached its fixed deadline.",
                ),
                RecvTimeoutError::Disconnected => runtime_failure(),
            })?
    }

    pub(in crate::browser::login) fn with_owner_quiesced(
        &self,
        transition: &mut dyn FnMut(),
    ) -> Result<(), BackendFailure> {
        self.transitions.with_quiesced_owner(transition)
    }

    /// Session-manager shutdown seam: revoke/cancel first, then call this bounded owner shutdown,
    /// then remove the session only after this returns and supervisor close proved domain gone.
    pub(in crate::browser::login) fn shutdown(&self, force: bool) -> Result<(), BackendFailure> {
        self.shutdown.store(true, Ordering::Release);
        let _ = self.requests.try_send(OwnerRequest::Shutdown);
        if self.join.lock().map_err(|_| runtime_failure())?.is_none() {
            return Ok(());
        }
        let done = self.done.lock().map_err(|_| runtime_failure())?;
        let outcome = if force {
            self.termination
                .force_verified_domain()
                .map_err(|_| runtime_failure())?;
            recv_shutdown_result(&done, SHUTDOWN_TIMEOUT)?
        } else {
            match done.recv_timeout(GRACEFUL_OWNER_SHUTDOWN_TIMEOUT) {
                Ok(outcome) => outcome,
                Err(RecvTimeoutError::Disconnected) => return Err(runtime_failure()),
                Err(RecvTimeoutError::Timeout) => {
                    // Browser.close is cooperative. A hung renderer or blocked pipe must not keep
                    // the owner, profile lease, or cleanup metadata alive indefinitely.
                    self.termination
                        .force_verified_domain()
                        .map_err(|_| runtime_failure())?;
                    recv_shutdown_result(&done, SHUTDOWN_TIMEOUT)?
                }
            }
        };
        drop(done);
        let join = self.join.lock().map_err(|_| runtime_failure())?.take();
        if let Some(join) = join {
            join.join().map_err(|_| runtime_failure())??;
        }
        outcome
    }
}

impl SemanticBrowserBackend for ChromiumLoginBackend {
    fn execute(
        &self,
        command: &SemanticBrowserCommand,
        cancellation: &OperationCancellation,
    ) -> Result<SemanticBrowserResult, BackendFailure> {
        if self.shutdown.load(Ordering::Acquire) || cancellation.is_cancelled() {
            return Err(BackendFailure::cancelled());
        }
        let deadline = Instant::now() + self.command_timeout;
        let (response_tx, response_rx) = mpsc::sync_channel(1);
        match self.requests.try_send(OwnerRequest::Execute {
            command: command.clone(),
            cancellation: cancellation.clone(),
            deadline,
            response: response_tx,
        }) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                return Err(BackendFailure::new(
                    BackendFailureCode::RuntimeUnavailable,
                    "Browser semantic owner queue is full.",
                ))
            }
            Err(TrySendError::Disconnected(_)) => return Err(runtime_failure()),
        }
        loop {
            if cancellation.is_cancelled() {
                return Err(BackendFailure::cancelled());
            }
            if Instant::now() >= deadline {
                return Err(BackendFailure::new(
                    BackendFailureCode::TimedOut,
                    "Browser semantic command reached its fixed deadline.",
                ));
            }
            let wait = deadline
                .saturating_duration_since(Instant::now())
                .min(OWNER_POLL_INTERVAL);
            match response_rx.recv_timeout(wait) {
                Ok(result) => {
                    if cancellation.is_cancelled() {
                        return Err(BackendFailure::cancelled());
                    }
                    if Instant::now() >= deadline {
                        return Err(BackendFailure::new(
                            BackendFailureCode::TimedOut,
                            "Browser semantic command reached its fixed deadline.",
                        ));
                    }
                    return result;
                }
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => return Err(runtime_failure()),
            }
        }
    }
}

impl Drop for ChromiumLoginBackend {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        let _ = self.requests.try_send(OwnerRequest::Shutdown);
        let termination = Arc::clone(&self.termination);
        let _ = thread::Builder::new()
            .name("ccem-login-cdp-drop-cleanup".to_string())
            .spawn(move || {
                let _ = termination.force_verified_domain();
            });
        // Never block an arbitrary Drop caller. The detached owner still owns ManagedLoginRuntime
        // and therefore executes supervisor cleanup before it exits.
        if let Ok(mut join) = self.join.lock() {
            join.take();
        }
    }
}

fn recv_shutdown_result(
    done: &Receiver<Result<(), BackendFailure>>,
    timeout: Duration,
) -> Result<Result<(), BackendFailure>, BackendFailure> {
    done.recv_timeout(timeout).map_err(|error| match error {
        RecvTimeoutError::Timeout => BackendFailure::new(
            BackendFailureCode::TimedOut,
            "Browser CDP owner shutdown reached its fixed deadline.",
        ),
        RecvTimeoutError::Disconnected => runtime_failure(),
    })
}

fn run_managed_owner(
    mut runtime: ManagedLoginRuntime,
    config: ChromiumLoginBackendConfig,
    guard: Arc<dyn TrustedNavigationGuard>,
    requests: Receiver<OwnerRequest>,
    transitions: OwnerTransitionInbox,
    shutdown: Arc<AtomicBool>,
    termination: Arc<VerifiedRuntimeTerminationHandle>,
    ready: SyncSender<Result<(), BackendFailure>>,
    projection: Arc<RwLock<ChromiumOwnerProjection>>,
) -> Result<(), BackendFailure> {
    let artifacts = match CdpArtifactStore::new(config.artifact_root) {
        Ok(store) => store,
        Err(error) => {
            let _ = ready.send(Err(error.clone()));
            let _ = runtime.close();
            return Err(error);
        }
    };
    let network = match NetworkEventRecorder::new(
        config.network_log_root.clone(),
        config.network_session_id.clone(),
        config.redaction.clone(),
    ) {
        Ok(recorder) => recorder,
        Err(error) => {
            let _ = ready.send(Err(error.clone()));
            let _ = runtime.close();
            return Err(error);
        }
    };
    let console = match ConsoleEventRecorder::new(
        config.network_log_root,
        config.network_session_id,
        config.redaction,
    ) {
        Ok(recorder) => recorder,
        Err(error) => {
            let _ = ready.send(Err(error.clone()));
            let _ = runtime.close();
            return Err(error);
        }
    };
    let mut engine = Some(SemanticEngine::new(guard, artifacts, network, console));
    let mut ready = Some(ready);
    let protocol_result = match runtime.with_private_cdp(|reader, writer| {
        run_protocol_owner(
            reader,
            writer,
            &mut engine,
            &requests,
            &transitions,
            &shutdown,
            termination.as_ref(),
            &mut ready,
            &projection,
        )
    }) {
        Ok(result) => result,
        Err(_) => Err(runtime_failure()),
    };
    if let Some(ready) = ready.take() {
        let _ = ready.send(Err(protocol_result
            .as_ref()
            .err()
            .cloned()
            .unwrap_or_else(runtime_failure)));
    }
    // `shutdown()` reports the supervisor cleanup proof, not an earlier protocol error already
    // delivered to the active command. A successful runtime.close means the ownership domain is
    // gone and the profile lease/metadata were finalized.
    let close = runtime.close().map_err(|_| runtime_failure());
    if let Ok(mut state) = projection.write() {
        state.terminated = true;
    }
    close
}

pub(super) fn runtime_failure() -> BackendFailure {
    BackendFailure::new(
        BackendFailureCode::RuntimeUnavailable,
        "Browser CDP owner is unavailable.",
    )
}

#[cfg(all(test, unix))]
mod tests {
    use super::super::super::control::{HandoffControl, HandoffGrant, LoginBrowserControl};
    use super::super::super::network::NetworkRedactionConfig;
    use super::super::super::policy::BrowserGrantBinding;
    use super::super::guard::{
        TrustedNavigationDecision, TrustedNavigationRequest, TrustedNavigationSurface,
    };
    use super::super::owner_protocol::OwnerTerminalTermination;
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use serde_json::Value;
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;

    struct DenyRedirectGuard;

    struct NoopTermination;

    impl OwnerTerminalTermination for NoopTermination {
        fn request_force_verified_domain(&self) -> Result<(), BackendFailure> {
            Ok(())
        }
    }

    impl TrustedNavigationGuard for DenyRedirectGuard {
        fn authorize(&self, request: TrustedNavigationRequest<'_>) -> TrustedNavigationDecision {
            if request.surface() != TrustedNavigationSurface::AgentNavigation
                && request.target_url().contains("denied")
            {
                TrustedNavigationDecision::deny("origin_not_granted")
            } else {
                TrustedNavigationDecision::allow("allowed")
            }
        }
    }

    fn cancellation() -> (Arc<LoginBrowserControl>, OperationCancellation) {
        let binding = BrowserGrantBinding::new_trusted("w", "p", "s", 1).unwrap();
        let control = Arc::new(LoginBrowserControl::new());
        control
            .activate_handoff(HandoffGrant::new_trusted(binding.clone()))
            .unwrap();
        let token = control.begin_operation(&binding, true).unwrap();
        (control, token)
    }

    fn test_engine(temp: &tempfile::TempDir) -> SemanticEngine {
        SemanticEngine::new(
            Arc::new(DenyRedirectGuard),
            CdpArtifactStore::new(temp.path().join("artifacts")).unwrap(),
            NetworkEventRecorder::new(
                temp.path().join("network"),
                "session-1".to_string(),
                NetworkRedactionConfig::default(),
            )
            .unwrap(),
            ConsoleEventRecorder::new(
                temp.path().join("network"),
                "session-1".to_string(),
                NetworkRedactionConfig::default(),
            )
            .unwrap(),
        )
    }

    fn write_frame(stream: &mut UnixStream, value: Value) {
        let mut bytes = serde_json::to_vec(&value).unwrap();
        bytes.push(0);
        stream.write_all(&bytes).unwrap();
        stream.flush().unwrap();
    }

    fn read_frame(reader: &mut BufReader<UnixStream>) -> Value {
        let mut bytes = Vec::new();
        reader.read_until(0, &mut bytes).unwrap();
        assert_eq!(bytes.pop(), Some(0));
        serde_json::from_slice(&bytes).unwrap()
    }

    #[test]
    fn real_duplex_fixture_conforms_for_ax_refs_input_and_redirect_guard() {
        let temp = tempfile::tempdir().unwrap();
        let (owner_stream, peer_stream) = UnixStream::pair().unwrap();
        let mut owner_reader = owner_stream.try_clone().unwrap();
        let mut owner_writer = owner_stream;
        let mut peer_reader = BufReader::new(peer_stream.try_clone().unwrap());
        let mut peer_writer = peer_stream;
        let (request_tx, request_rx) = mpsc::sync_channel(4);
        let (_transition, transition_inbox) = owner_transition_channel();
        let shutdown = Arc::new(AtomicBool::new(false));
        let owner_shutdown = Arc::clone(&shutdown);
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let owner_projection = Arc::new(RwLock::new(ChromiumOwnerProjection::default()));
        let owner = thread::spawn(move || {
            let mut engine = Some(test_engine(&temp));
            let mut ready = Some(ready_tx);
            run_protocol_owner(
                &mut owner_reader,
                &mut owner_writer,
                &mut engine,
                &request_rx,
                &transition_inbox,
                &owner_shutdown,
                &NoopTermination,
                &mut ready,
                &owner_projection,
            )
        });
        let peer = thread::spawn(move || {
            let mut saw_fail_before_continue = false;
            let mut saw_target_close = false;
            let mut sent_popup = false;
            let mut pending_navigation = None;
            let mut methods = Vec::new();
            loop {
                let command = read_frame(&mut peer_reader);
                let id = command["id"].as_u64().unwrap();
                let method = command["method"].as_str().unwrap();
                methods.push(method.to_string());
                let result = match method {
                    "Target.createTarget" => serde_json::json!({"targetId":"target-1"}),
                    "Target.getTargets" => serde_json::json!({
                        "targetInfos":[{"targetId":"target-1","type":"page","url":"about:blank"}]
                    }),
                    "Target.attachToTarget" => serde_json::json!({"sessionId":"session-1"}),
                    "Page.getNavigationHistory" => serde_json::json!({
                        "currentIndex":0,
                        "entries":[{"url":"about:blank","title":""}]
                    }),
                    "Accessibility.getFullAXTree" => serde_json::json!({
                        "nodes":[{
                            "nodeId":"ax-internal",
                            "ignored":false,
                            "role":{"value":"button"},
                            "name":{"value":"Continue"},
                            "backendDOMNodeId":4242
                        }]
                    }),
                    "DOM.getBoxModel" => serde_json::json!({
                        "model":{"content":[0,0,20,0,20,10,0,10]}
                    }),
                    "Page.captureScreenshot" => serde_json::json!({
                        "data": STANDARD.encode(b"\x89PNG\r\n\x1a\nfixture")
                    }),
                    "Page.navigate" => {
                        pending_navigation = Some(id);
                        write_frame(
                            &mut peer_writer,
                            serde_json::json!({
                                "method":"Fetch.requestPaused",
                                "sessionId":"session-1",
                                "params":{
                                    "requestId":"fetch-1",
                                    "resourceType":"Document",
                                    "frameId":"main-frame",
                                    "request":{"url":"https://denied.example/"}
                                }
                            }),
                        );
                        continue;
                    }
                    "Fetch.failRequest" => {
                        saw_fail_before_continue = true;
                        serde_json::json!({})
                    }
                    "Fetch.continueRequest" => panic!("denied redirect was continued"),
                    "Target.closeTarget" => {
                        saw_target_close = true;
                        serde_json::json!({"success":true})
                    }
                    "Browser.close" => {
                        write_frame(&mut peer_writer, serde_json::json!({"id":id,"result":{}}));
                        break;
                    }
                    _ => serde_json::json!({}),
                };
                write_frame(
                    &mut peer_writer,
                    serde_json::json!({"id":id,"result":result}),
                );
                if method == "Page.getNavigationHistory" && !sent_popup {
                    sent_popup = true;
                    write_frame(
                        &mut peer_writer,
                        serde_json::json!({
                            "method":"Target.targetCreated",
                            "params":{"targetInfo":{
                                "targetId":"popup-denied",
                                "type":"page",
                                "url":"https://denied.example/popup"
                            }}
                        }),
                    );
                }
                if method == "Fetch.failRequest" {
                    let navigation_id = pending_navigation.take().unwrap();
                    write_frame(
                        &mut peer_writer,
                        serde_json::json!({"id":navigation_id,"result":{"frameId":"main-frame"}}),
                    );
                }
            }
            (saw_fail_before_continue, saw_target_close, methods)
        });
        ready_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        let (_control, token) = cancellation();
        let (response_tx, response_rx) = mpsc::sync_channel(1);
        request_tx
            .send(OwnerRequest::Execute {
                command: SemanticBrowserCommand::ReadPage,
                cancellation: token.clone(),
                deadline: Instant::now() + Duration::from_secs(2),
                response: response_tx,
            })
            .unwrap();
        let page = response_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        let element_ref = match page {
            SemanticBrowserResult::StructuredPage(page) => {
                assert_eq!(page.elements.len(), 1);
                page.elements[0].element_ref.clone()
            }
            other => panic!("unexpected result: {other:?}"),
        };
        assert!(!element_ref.contains("4242"));
        let (response_tx, response_rx) = mpsc::sync_channel(1);
        request_tx
            .send(OwnerRequest::Execute {
                command: SemanticBrowserCommand::Click {
                    element_ref: element_ref.clone(),
                },
                cancellation: token.clone(),
                deadline: Instant::now() + Duration::from_secs(2),
                response: response_tx,
            })
            .unwrap();
        response_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        let (response_tx, response_rx) = mpsc::sync_channel(1);
        request_tx
            .send(OwnerRequest::Execute {
                command: SemanticBrowserCommand::Type {
                    element_ref: element_ref.clone(),
                    text: "typed without evaluate".to_string(),
                    replace: true,
                },
                cancellation: token.clone(),
                deadline: Instant::now() + Duration::from_secs(2),
                response: response_tx,
            })
            .unwrap();
        response_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        let (response_tx, response_rx) = mpsc::sync_channel(1);
        request_tx
            .send(OwnerRequest::Execute {
                command: SemanticBrowserCommand::Screenshot,
                cancellation: token.clone(),
                deadline: Instant::now() + Duration::from_secs(2),
                response: response_tx,
            })
            .unwrap();
        match response_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap()
        {
            SemanticBrowserResult::Screenshot(result) => {
                assert!(result.artifact_id.starts_with("shot-"));
                assert_eq!(result.sha256.len(), 64);
            }
            other => panic!("unexpected result: {other:?}"),
        }
        let (response_tx, response_rx) = mpsc::sync_channel(1);
        request_tx
            .send(OwnerRequest::Execute {
                command: SemanticBrowserCommand::Navigate {
                    url: "https://allowed.example/".to_string(),
                },
                cancellation: token.clone(),
                deadline: Instant::now() + Duration::from_secs(2),
                response: response_tx,
            })
            .unwrap();
        response_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        let (response_tx, response_rx) = mpsc::sync_channel(1);
        request_tx
            .send(OwnerRequest::Execute {
                command: SemanticBrowserCommand::Click { element_ref },
                cancellation: token,
                deadline: Instant::now() + Duration::from_secs(2),
                response: response_tx,
            })
            .unwrap();
        assert_eq!(
            response_rx
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .unwrap_err()
                .code,
            BackendFailureCode::InvalidSemanticReference
        );
        shutdown.store(true, Ordering::Release);
        request_tx.send(OwnerRequest::Shutdown).unwrap();
        owner.join().unwrap().unwrap();
        let (saw_fail, saw_target_close, methods) = peer.join().unwrap();
        assert!(saw_fail);
        assert!(saw_target_close);
        let runtime_methods = methods
            .iter()
            .filter(|method| method.starts_with("Runtime."))
            .map(String::as_str)
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            runtime_methods,
            std::collections::BTreeSet::from(
                ["Runtime.enable", "Runtime.runIfWaitingForDebugger",]
            )
        );
        assert!(!methods
            .iter()
            .any(|method| method.contains("evaluate") || method.contains("callFunction")));
    }

    #[test]
    fn active_wait_cancellation_reaches_owner_in_under_one_second() {
        let temp = tempfile::tempdir().unwrap();
        let (owner_stream, peer_stream) = UnixStream::pair().unwrap();
        let mut owner_reader = owner_stream.try_clone().unwrap();
        let mut owner_writer = owner_stream;
        let mut peer_reader = BufReader::new(peer_stream.try_clone().unwrap());
        let mut peer_writer = peer_stream;
        let (request_tx, request_rx) = mpsc::sync_channel(4);
        let (_transition, transition_inbox) = owner_transition_channel();
        let shutdown = Arc::new(AtomicBool::new(false));
        let owner_shutdown = Arc::clone(&shutdown);
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let owner_projection = Arc::new(RwLock::new(ChromiumOwnerProjection::default()));
        let owner = thread::spawn(move || {
            let mut engine = Some(test_engine(&temp));
            let mut ready = Some(ready_tx);
            run_protocol_owner(
                &mut owner_reader,
                &mut owner_writer,
                &mut engine,
                &request_rx,
                &transition_inbox,
                &owner_shutdown,
                &NoopTermination,
                &mut ready,
                &owner_projection,
            )
        });
        let peer = thread::spawn(move || loop {
            let command = read_frame(&mut peer_reader);
            let id = command["id"].as_u64().unwrap();
            let result = match command["method"].as_str().unwrap() {
                "Target.createTarget" => serde_json::json!({"targetId":"target-1"}),
                "Target.getTargets" => serde_json::json!({
                    "targetInfos":[{"targetId":"target-1","type":"page","url":"about:blank"}]
                }),
                "Target.attachToTarget" => serde_json::json!({"sessionId":"session-1"}),
                "Page.getNavigationHistory" => serde_json::json!({
                    "currentIndex":0,
                    "entries":[{"url":"about:blank","title":""}]
                }),
                "Browser.close" => {
                    write_frame(&mut peer_writer, serde_json::json!({"id":id,"result":{}}));
                    break;
                }
                _ => serde_json::json!({}),
            };
            write_frame(
                &mut peer_writer,
                serde_json::json!({"id":id,"result":result}),
            );
        });
        ready_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        let (control, token) = cancellation();
        let (response_tx, response_rx) = mpsc::sync_channel(1);
        request_tx
            .send(OwnerRequest::Execute {
                command: SemanticBrowserCommand::WaitFor {
                    condition: super::super::super::backend::SemanticWaitCondition::LoadComplete,
                    timeout_millis: 5_000,
                },
                cancellation: token,
                deadline: Instant::now() + Duration::from_secs(5),
                response: response_tx,
            })
            .unwrap();
        std::thread::sleep(Duration::from_millis(25));
        let started = Instant::now();
        control.cancel_active();
        assert_eq!(
            response_rx
                .recv_timeout(Duration::from_secs(1))
                .unwrap()
                .unwrap_err()
                .code,
            BackendFailureCode::Cancelled
        );
        assert!(started.elapsed() < Duration::from_secs(1));
        shutdown.store(true, Ordering::Release);
        request_tx.send(OwnerRequest::Shutdown).unwrap();
        owner.join().unwrap().unwrap();
        peer.join().unwrap();
    }

    #[test]
    fn screenshot_fixture_payload_is_bounded_png_base64() {
        let png = b"\x89PNG\r\n\x1a\nfixture";
        let encoded = STANDARD.encode(png);
        assert!(encoded.len() < 128);
    }
}
