use super::super::backend::{
    BackendFailure, BackendFailureCode, SemanticBrowserBackend, SemanticBrowserCommand,
    SemanticBrowserResult,
};
use super::super::control::OperationCancellation;
use super::super::policy::NormalizedOrigin;
use super::super::supervisor::ManagedLoginRuntime;
use super::artifacts::CdpArtifactStore;
use super::console_events::ConsoleEventRecorder;
use super::guard::TrustedNavigationGuard;
use super::network_events::NetworkEventRecorder;
pub(in crate::browser::login) use super::owner_config::ChromiumLoginBackendConfig;
use super::owner_protocol::{
    run_embedded_protocol_owner, run_protocol_owner, OwnerTerminalTermination,
};
use super::owner_transition::{
    owner_transition_channel, OwnerTransitionClient, OwnerTransitionInbox,
};
use super::semantics::SemanticEngine;
use super::transport::OWNER_POLL_INTERVAL;
use std::io::{Read, Write};
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
    pub(super) termination: Arc<dyn OwnerTerminalTermination>,
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
        let termination: Arc<dyn OwnerTerminalTermination> =
            Arc::new(runtime.verified_termination_handle());
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
                let _ = termination.request_terminal_shutdown();
                drop(join);
                Err(error)
            }
            Err(_) => {
                shutdown.store(true, Ordering::Release);
                // A stuck startup may be blocked in pipe I/O. Closing the exact verified process
                // domain wakes it; the detached owner still finalizes metadata/profile ownership.
                let _ = termination.request_terminal_shutdown();
                drop(join);
                Err(BackendFailure::new(
                    BackendFailureCode::TimedOut,
                    "Browser CDP owner startup reached its fixed deadline.",
                ))
            }
        }
    }

    /// Attach the semantic owner to the page already hosted by an embedded CEF surface.
    ///
    /// The reader/writer are the surface's private DevTools bridge. Terminal shutdown is delegated
    /// to the host lifecycle so this path never sends `Browser.close`, which would terminate the
    /// shared in-process CEF runtime instead of only the owned child surface.
    pub(in crate::browser::login) fn spawn_embedded(
        reader: Box<dyn Read + Send>,
        writer: Box<dyn Write + Send>,
        config: ChromiumLoginBackendConfig,
        guard: Arc<dyn TrustedNavigationGuard>,
        termination: Arc<dyn OwnerTerminalTermination>,
    ) -> Result<Self, BackendFailure> {
        let command_timeout = config.command_timeout;
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
            .name("ccem-login-cef-cdp-owner".to_string())
            .spawn(move || {
                let result = run_embedded_owner(
                    reader,
                    writer,
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
            .map_err(|_| {
                let _ = termination.request_terminal_shutdown();
                runtime_failure()
            })?;
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
                let _ = termination.request_terminal_shutdown();
                drop(join);
                Err(error)
            }
            Err(_) => {
                shutdown.store(true, Ordering::Release);
                let _ = termination.request_terminal_shutdown();
                drop(join);
                Err(BackendFailure::new(
                    BackendFailureCode::TimedOut,
                    "Embedded browser CDP owner startup reached its fixed deadline.",
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
            self.termination.request_terminal_shutdown()?;
            recv_shutdown_result(&done, SHUTDOWN_TIMEOUT)?
        } else {
            match done.recv_timeout(GRACEFUL_OWNER_SHUTDOWN_TIMEOUT) {
                Ok(outcome) => outcome,
                Err(RecvTimeoutError::Disconnected) => return Err(runtime_failure()),
                Err(RecvTimeoutError::Timeout) => {
                    // Browser.close is cooperative. A hung renderer or blocked pipe must not keep
                    // the owner, profile lease, or cleanup metadata alive indefinitely.
                    self.termination.request_terminal_shutdown()?;
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
                let _ = termination.request_terminal_shutdown();
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
    termination: Arc<dyn OwnerTerminalTermination>,
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

#[allow(clippy::too_many_arguments)]
fn run_embedded_owner(
    mut reader: Box<dyn Read + Send>,
    mut writer: Box<dyn Write + Send>,
    config: ChromiumLoginBackendConfig,
    guard: Arc<dyn TrustedNavigationGuard>,
    requests: Receiver<OwnerRequest>,
    transitions: OwnerTransitionInbox,
    shutdown: Arc<AtomicBool>,
    termination: Arc<dyn OwnerTerminalTermination>,
    ready: SyncSender<Result<(), BackendFailure>>,
    projection: Arc<RwLock<ChromiumOwnerProjection>>,
) -> Result<(), BackendFailure> {
    let artifacts = match CdpArtifactStore::new(config.artifact_root) {
        Ok(store) => store,
        Err(error) => {
            let _ = ready.send(Err(error.clone()));
            let _ = termination.request_terminal_shutdown();
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
            let _ = termination.request_terminal_shutdown();
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
            let _ = termination.request_terminal_shutdown();
            return Err(error);
        }
    };
    let mut engine = Some(SemanticEngine::new_for_existing_target(
        guard, artifacts, network, console,
    ));
    let mut ready = Some(ready);
    let protocol_result = run_embedded_protocol_owner(
        reader.as_mut(),
        writer.as_mut(),
        &mut engine,
        &requests,
        &transitions,
        &shutdown,
        termination.as_ref(),
        &mut ready,
        &projection,
    );
    let result = reconcile_embedded_terminal_result(protocol_result, termination.as_ref());
    if let Some(ready) = ready.take() {
        let _ = ready.send(Err(result
            .as_ref()
            .err()
            .cloned()
            .unwrap_or_else(runtime_failure)));
    }
    if let Ok(mut state) = projection.write() {
        state.terminated = true;
    }
    result
}

pub(super) fn reconcile_embedded_terminal_result(
    protocol_result: Result<(), BackendFailure>,
    termination: &dyn OwnerTerminalTermination,
) -> Result<(), BackendFailure> {
    match protocol_result {
        Ok(()) => Ok(()),
        Err(protocol_error) => match termination.request_terminal_shutdown() {
            Ok(()) => {
                // The protocol error was already delivered to the active command (or startup
                // waiter). Once the exact surface, profile lease, and owner record have reached
                // their verified terminal state, shutdown callers must observe that cleanup truth
                // instead of a stale transport/protocol result.
                eprintln!(
                    "Embedded browser protocol ended before verified terminal cleanup: {}",
                    protocol_error
                );
                Ok(())
            }
            Err(termination_error) => Err(termination_error),
        },
    }
}

pub(super) fn runtime_failure() -> BackendFailure {
    BackendFailure::new(
        BackendFailureCode::RuntimeUnavailable,
        "Browser CDP owner is unavailable.",
    )
}

#[cfg(all(test, unix))]
#[path = "owner_tests.rs"]
mod tests;
