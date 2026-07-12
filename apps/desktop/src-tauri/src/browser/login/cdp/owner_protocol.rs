use super::super::backend::{BackendFailure, BackendFailureCode};
use super::super::supervisor::VerifiedRuntimeTerminationHandle;
use super::owner::{
    runtime_failure, ChromiumOwnerProjection, OwnerRequest, STARTUP_TIMEOUT,
    TRUSTED_BARRIER_TIMEOUT,
};
use super::owner_handoff::run_handoff_preflight;
use super::owner_transition::OwnerTransitionInbox;
use super::semantics::{SemanticEngine, SemanticEngineProjection};
use super::transport::{frame_channel, run_frame_reader, CdpClient};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, RwLock};
use std::thread;
use std::time::{Duration, Instant};

pub(super) trait OwnerTerminalTermination: Send + Sync {
    fn request_force_verified_domain(&self) -> Result<(), BackendFailure>;
}

impl OwnerTerminalTermination for VerifiedRuntimeTerminationHandle {
    fn request_force_verified_domain(&self) -> Result<(), BackendFailure> {
        VerifiedRuntimeTerminationHandle::request_force_verified_domain(self)
            .map_err(|_| runtime_failure())
    }
}

struct TerminalJoinGuard<'a> {
    termination: &'a dyn OwnerTerminalTermination,
    requested: bool,
    armed: bool,
}

impl<'a> TerminalJoinGuard<'a> {
    fn new(termination: &'a dyn OwnerTerminalTermination) -> Self {
        Self {
            termination,
            requested: false,
            armed: true,
        }
    }

    fn request_now(&mut self) {
        if !self.requested {
            self.requested = true;
            let _ = self.termination.request_force_verified_domain();
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for TerminalJoinGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.request_now();
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn run_protocol_owner(
    reader: &mut dyn Read,
    writer: &mut dyn Write,
    engine: &mut Option<SemanticEngine>,
    requests: &Receiver<OwnerRequest>,
    transitions: &OwnerTransitionInbox,
    shutdown: &Arc<AtomicBool>,
    termination: &dyn OwnerTerminalTermination,
    ready: &mut Option<SyncSender<Result<(), BackendFailure>>>,
    projection: &Arc<RwLock<ChromiumOwnerProjection>>,
) -> Result<(), BackendFailure> {
    let (frame_tx, inbox, reader_state) = frame_channel();
    thread::scope(|scope| {
        // SAFETY: ManagedLoginRuntime is the only production caller. Its PrivateCdpTransport stores
        // `Box<dyn Read + Send>`; `with_private_cdp` currently erases the Send marker from the
        // borrowed trait object. This wrapper restores that proven invariant for the scoped thread.
        let send_reader = SupervisorSendReader(reader);
        let reader_thread = scope.spawn(move || send_reader.run(frame_tx, reader_state));
        let mut terminal_join = TerminalJoinGuard::new(termination);
        let mut client = CdpClient::new(writer, inbox);
        let mut engine = engine.take().ok_or_else(runtime_failure)?;
        let initialized = engine.initialize(&mut client, Instant::now() + STARTUP_TIMEOUT);
        if initialized.is_ok() {
            publish_projection(projection, engine.projection(), true)?;
        }
        if let Some(ready) = ready.take() {
            let _ = ready.send(initialized.clone().map(|_| ()));
        }
        if let Err(error) = initialized {
            let _ = client.send_browser_close();
            terminal_join.request_now();
            drop(client);
            if reader_thread.join().is_ok() {
                terminal_join.disarm();
            }
            return Err(error);
        }
        let mut terminal_error = None;
        while !shutdown.load(Ordering::Acquire) {
            if let Err(error) = engine.poll_idle(&mut client) {
                terminal_error = Some(error);
                break;
            }
            publish_projection(projection, engine.projection(), true)?;
            match transitions.run_pending() {
                Ok(true) => continue,
                Ok(false) => {}
                Err(error) => {
                    terminal_error = Some(error);
                    break;
                }
            }
            match requests.recv_timeout(Duration::from_millis(10)) {
                Ok(OwnerRequest::Execute {
                    command,
                    cancellation,
                    deadline,
                    response,
                }) => {
                    let result = if cancellation.is_cancelled() {
                        Err(BackendFailure::cancelled())
                    } else if Instant::now() >= deadline {
                        Err(BackendFailure::new(
                            BackendFailureCode::TimedOut,
                            "Browser semantic command expired before owner execution.",
                        ))
                    } else {
                        match cancellation.enter_owner_execution() {
                            Ok(_owner_quiescence) => {
                                engine.execute(&mut client, &command, &cancellation, deadline)
                            }
                            Err(_) => Err(BackendFailure::cancelled()),
                        }
                    };
                    publish_projection(projection, engine.projection(), true)?;
                    let terminal = terminal_failure(&result);
                    let _ = response.send(result.clone());
                    if let Some(error) = terminal {
                        terminal_error = Some(error);
                        break;
                    }
                }
                Ok(OwnerRequest::ValidateCurrentOrigin { expected, response }) => {
                    let deadline = Instant::now() + TRUSTED_BARRIER_TIMEOUT;
                    let result = engine
                        .validate_current_origin(&mut client, &expected, deadline)
                        .map(|engine_projection| {
                            let projected = ChromiumOwnerProjection {
                                current_url: engine_projection.current_url.clone(),
                                current_title: engine_projection.current_title.clone(),
                                generation: engine_projection.generation,
                                blocked_download_count: engine_projection.blocked_download_count,
                                canceled_download_count: engine_projection.canceled_download_count,
                                ready: true,
                                terminated: false,
                            };
                            let _ = publish_projection(projection, engine_projection, true);
                            projected
                        });
                    let terminal = terminal_failure(&result);
                    let _ = response.send(result);
                    if let Some(error) = terminal {
                        terminal_error = Some(error);
                        break;
                    }
                }
                Ok(OwnerRequest::PreflightHandoff { expected, response }) => {
                    let result = run_handoff_preflight(&mut engine, &mut client, &expected);
                    let terminal = terminal_failure(&result);
                    let _ = response.send(result);
                    if let Some(error) = terminal {
                        terminal_error = Some(error);
                        break;
                    }
                }
                Ok(OwnerRequest::BeginDiagnosticSegment {
                    handoff_epoch,
                    response,
                }) => {
                    let result =
                        engine.begin_diagnostic_segment_after_barrier(&mut client, handoff_epoch);
                    let terminal = terminal_failure(&result);
                    let _ = response.send(result);
                    if let Some(error) = terminal {
                        terminal_error = Some(error);
                        break;
                    }
                }
                Ok(OwnerRequest::StopDiagnosticSegment { response }) => {
                    engine.stop_diagnostic_segment();
                    let _ = response.send(Ok(()));
                }
                Ok(OwnerRequest::Shutdown) => break,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        let close_write = client.send_browser_close();
        if terminal_error.is_some() || close_write.is_err() {
            terminal_join.request_now();
        }
        drop(client);
        reader_thread.join().map_err(|_| runtime_failure())?;
        terminal_join.disarm();
        if let Some(error) = terminal_error {
            Err(error)
        } else {
            close_write
        }
    })
}

fn terminal_failure<T>(result: &Result<T, BackendFailure>) -> Option<BackendFailure> {
    result
        .as_ref()
        .err()
        .filter(|error| {
            matches!(
                error.code,
                BackendFailureCode::RuntimeUnavailable | BackendFailureCode::ProtocolViolation
            )
        })
        .cloned()
}

fn publish_projection(
    target: &Arc<RwLock<ChromiumOwnerProjection>>,
    source: SemanticEngineProjection,
    ready: bool,
) -> Result<(), BackendFailure> {
    let mut projection = target.write().map_err(|_| runtime_failure())?;
    projection.current_url = source.current_url;
    projection.current_title = source.current_title;
    projection.generation = source.generation;
    projection.blocked_download_count = source.blocked_download_count;
    projection.canceled_download_count = source.canceled_download_count;
    projection.ready = ready;
    Ok(())
}

/// See the safety note at the only construction site in `run_protocol_owner`.
struct SupervisorSendReader<'a>(&'a mut dyn Read);

unsafe impl Send for SupervisorSendReader<'_> {}

impl SupervisorSendReader<'_> {
    fn run(
        self,
        sender: std::sync::mpsc::SyncSender<super::transport::FrameEnvelope>,
        state: Arc<super::transport::ReaderState>,
    ) {
        run_frame_reader(self.0, sender, state);
    }
}
