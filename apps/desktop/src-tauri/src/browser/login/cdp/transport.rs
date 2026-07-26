use super::super::backend::{BackendFailure, BackendFailureCode};
use super::super::control::{EffectSafetyFence, OperationCancellation};
use super::super::execution_fence::EffectWritePermit;
use super::protocol::{classify_frame, CdpEvent, CdpMethod, IncomingFrame};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TryRecvError, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[path = "transport/input_sequence.rs"]
mod input_sequence;

pub(super) const MAX_CDP_FRAME_BYTES: usize = 32 * 1024 * 1024;
const MAX_QUEUED_FRAME_BYTES: usize = 64 * 1024 * 1024;
const FRAME_QUEUE_CAPACITY: usize = 128;
const MAX_PENDING_RESPONSES: usize = 64;
const MAX_PENDING_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
const MAX_IGNORED_RESPONSES: usize = 256;
const MAX_OUTGOING_FRAME_BYTES: usize = 1024 * 1024;
pub(super) const OWNER_POLL_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum TransportFaultCode {
    PipeEof,
    PartialFrameEof,
    InvalidJson,
    OversizedFrame,
    FrameQueueOverflow,
    PendingQueueOverflow,
    Io,
}

#[derive(Debug)]
pub(super) struct FrameEnvelope {
    pub(super) value: Value,
    pub(super) byte_len: usize,
}

#[derive(Debug)]
pub(super) struct ReaderState {
    fault: Mutex<Option<TransportFaultCode>>,
    finished: AtomicBool,
    queued_bytes: AtomicUsize,
}

impl ReaderState {
    fn new() -> Self {
        Self {
            fault: Mutex::new(None),
            finished: AtomicBool::new(false),
            queued_bytes: AtomicUsize::new(0),
        }
    }

    fn finish(&self, fault: TransportFaultCode) {
        if let Ok(mut slot) = self.fault.lock() {
            if slot.is_none() {
                *slot = Some(fault);
            }
        }
        self.finished.store(true, Ordering::Release);
    }

    fn fault(&self) -> Option<TransportFaultCode> {
        self.fault.lock().ok().and_then(|slot| *slot)
    }

    pub(super) fn reserve_bytes(&self, amount: usize, maximum: usize) -> bool {
        let mut current = self.queued_bytes.load(Ordering::Acquire);
        loop {
            let Some(next) = current.checked_add(amount) else {
                return false;
            };
            if next > maximum {
                return false;
            }
            match self.queued_bytes.compare_exchange_weak(
                current,
                next,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return true,
                Err(observed) => current = observed,
            }
        }
    }

    fn release_bytes(&self, amount: usize) {
        self.queued_bytes.fetch_sub(amount, Ordering::AcqRel);
    }
}

pub(super) struct FrameInbox {
    receiver: Receiver<FrameEnvelope>,
    state: Arc<ReaderState>,
}

impl FrameInbox {
    fn recv_timeout(&self, timeout: Duration) -> Result<Option<FrameEnvelope>, BackendFailure> {
        match self.receiver.recv_timeout(timeout) {
            Ok(frame) => {
                self.state.release_bytes(frame.byte_len);
                Ok(Some(frame))
            }
            Err(RecvTimeoutError::Timeout) => Ok(None),
            Err(RecvTimeoutError::Disconnected) => Err(self.reader_failure()),
        }
    }

    fn try_recv(&self) -> Result<Option<FrameEnvelope>, BackendFailure> {
        match self.receiver.try_recv() {
            Ok(frame) => {
                self.state.release_bytes(frame.byte_len);
                Ok(Some(frame))
            }
            Err(TryRecvError::Empty) => {
                if self.state.finished.load(Ordering::Acquire) {
                    Err(self.reader_failure())
                } else {
                    Ok(None)
                }
            }
            Err(TryRecvError::Disconnected) => Err(self.reader_failure()),
        }
    }

    fn reader_failure(&self) -> BackendFailure {
        transport_failure(self.state.fault().unwrap_or(TransportFaultCode::PipeEof))
    }
}

pub(super) fn frame_channel() -> (SyncSender<FrameEnvelope>, FrameInbox, Arc<ReaderState>) {
    let (sender, receiver) = mpsc::sync_channel(FRAME_QUEUE_CAPACITY);
    let state = Arc::new(ReaderState::new());
    (
        sender,
        FrameInbox {
            receiver,
            state: Arc::clone(&state),
        },
        state,
    )
}

pub(super) fn run_frame_reader(
    reader: &mut dyn Read,
    sender: SyncSender<FrameEnvelope>,
    state: Arc<ReaderState>,
) {
    run_frame_reader_with_limits(
        reader,
        sender,
        state,
        MAX_CDP_FRAME_BYTES,
        MAX_QUEUED_FRAME_BYTES,
    );
}

fn run_frame_reader_with_limits(
    reader: &mut dyn Read,
    sender: SyncSender<FrameEnvelope>,
    state: Arc<ReaderState>,
    max_frame_bytes: usize,
    max_queue_bytes: usize,
) {
    let mut frame = Vec::with_capacity(8 * 1024);
    let mut chunk = [0_u8; 64 * 1024];
    loop {
        let read = match reader.read(&mut chunk) {
            Ok(0) => {
                state.finish(if frame.is_empty() {
                    TransportFaultCode::PipeEof
                } else {
                    TransportFaultCode::PartialFrameEof
                });
                return;
            }
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue
            }
            Err(_) => {
                state.finish(TransportFaultCode::Io);
                return;
            }
        };
        for byte in &chunk[..read] {
            if *byte != 0 {
                if frame.len() == max_frame_bytes {
                    state.finish(TransportFaultCode::OversizedFrame);
                    return;
                }
                frame.push(*byte);
                continue;
            }
            if frame.is_empty() {
                state.finish(TransportFaultCode::InvalidJson);
                return;
            }
            let byte_len = frame.len();
            let value = match serde_json::from_slice::<Value>(&frame) {
                Ok(value) => value,
                Err(_) => {
                    state.finish(TransportFaultCode::InvalidJson);
                    return;
                }
            };
            frame.clear();
            if !state.reserve_bytes(byte_len, max_queue_bytes) {
                state.finish(TransportFaultCode::FrameQueueOverflow);
                return;
            }
            match sender.try_send(FrameEnvelope { value, byte_len }) {
                Ok(()) => {}
                Err(TrySendError::Full(frame)) => {
                    state.release_bytes(frame.byte_len);
                    state.finish(TransportFaultCode::FrameQueueOverflow);
                    return;
                }
                Err(TrySendError::Disconnected(frame)) => {
                    state.release_bytes(frame.byte_len);
                    return;
                }
            }
        }
    }
}

pub(super) trait ProtocolEventHandler {
    fn on_event(
        &mut self,
        client: &mut CdpClient<'_>,
        event: CdpEvent,
    ) -> Result<(), BackendFailure>;
}

pub(super) trait CancellationProbe {
    fn is_cancelled(&self) -> bool;

    fn enter_effect_write(&self) -> Result<Option<EffectWritePermit>, ()> {
        Ok(None)
    }

    fn effect_safety_fence(&self) -> Option<EffectSafetyFence> {
        None
    }
}

impl CancellationProbe for OperationCancellation {
    fn is_cancelled(&self) -> bool {
        OperationCancellation::is_cancelled(self)
    }

    fn enter_effect_write(&self) -> Result<Option<EffectWritePermit>, ()> {
        OperationCancellation::enter_effect_write(self)
            .map(Some)
            .map_err(|_| ())
    }

    fn effect_safety_fence(&self) -> Option<EffectSafetyFence> {
        Some(OperationCancellation::effect_safety_fence(self))
    }
}

pub(super) struct NeverCancelled;

impl CancellationProbe for NeverCancelled {
    fn is_cancelled(&self) -> bool {
        false
    }
}

struct PendingResponse {
    result: Result<Value, super::protocol::CdpCommandFailure>,
    byte_len: usize,
}

pub(super) struct CdpClient<'a> {
    writer: &'a mut dyn Write,
    inbox: FrameInbox,
    next_id: u64,
    pending: BTreeMap<u64, PendingResponse>,
    pending_bytes: usize,
    ignored: BTreeSet<u64>,
}

impl<'a> CdpClient<'a> {
    pub(super) fn new(writer: &'a mut dyn Write, inbox: FrameInbox) -> Self {
        Self {
            writer,
            inbox,
            next_id: 1,
            pending: BTreeMap::new(),
            pending_bytes: 0,
            ignored: BTreeSet::new(),
        }
    }

    pub(super) fn call<H: ProtocolEventHandler>(
        &mut self,
        method: CdpMethod,
        params: Value,
        session_id: Option<&str>,
        deadline: Instant,
        cancellation: &dyn CancellationProbe,
        handler: &mut H,
    ) -> Result<Value, BackendFailure> {
        let mut committed = false;
        self.call_with_rejection_tracking_commit(
            method,
            params,
            session_id,
            deadline,
            cancellation,
            handler,
            BackendFailureCode::ProtocolViolation,
            &mut committed,
        )
    }

    pub(super) fn call_for_node<H: ProtocolEventHandler>(
        &mut self,
        method: CdpMethod,
        params: Value,
        session_id: Option<&str>,
        deadline: Instant,
        cancellation: &dyn CancellationProbe,
        handler: &mut H,
    ) -> Result<Value, BackendFailure> {
        let mut committed = false;
        self.call_with_rejection_tracking_commit(
            method,
            params,
            session_id,
            deadline,
            cancellation,
            handler,
            BackendFailureCode::InvalidSemanticReference,
            &mut committed,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn call_with_rejection_tracking_commit<H: ProtocolEventHandler>(
        &mut self,
        method: CdpMethod,
        params: Value,
        session_id: Option<&str>,
        deadline: Instant,
        cancellation: &dyn CancellationProbe,
        handler: &mut H,
        rejection_code: BackendFailureCode,
        committed: &mut bool,
    ) -> Result<Value, BackendFailure> {
        *committed = false;
        check_time_and_cancel(deadline, cancellation)?;
        let id = self.allocate_id()?;
        self.write_command(id, method, params, session_id, Some(cancellation))?;
        *committed = true;
        loop {
            if let Err(error) = check_time_and_cancel(deadline, cancellation) {
                // Cleanup bookkeeping must not replace the authoritative cancellation/deadline.
                let _ = self.abandon_response(id);
                return Err(error);
            }
            if let Some(response) = self.take_pending(id) {
                return map_command_result(response.result, rejection_code);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            let timeout = remaining.min(OWNER_POLL_INTERVAL);
            let Some(frame) = self.inbox.recv_timeout(timeout)? else {
                continue;
            };
            match classify_frame(frame.value)? {
                IncomingFrame::Response {
                    id: response_id,
                    result,
                } if response_id == id => {
                    check_time_and_cancel(deadline, cancellation)?;
                    return map_command_result(result, rejection_code);
                }
                IncomingFrame::Response {
                    id: response_id,
                    result,
                } => self.store_response(response_id, result, frame.byte_len)?,
                IncomingFrame::Event(event) => {
                    if let Err(error) = handler.on_event(self, event) {
                        if matches!(
                            error.code,
                            BackendFailureCode::Cancelled | BackendFailureCode::TimedOut
                        ) {
                            let _ = self.abandon_response(id);
                        }
                        return Err(error);
                    }
                }
            }
        }
    }

    pub(super) fn send_no_wait(
        &mut self,
        method: CdpMethod,
        params: Value,
        session_id: Option<&str>,
    ) -> Result<(), BackendFailure> {
        let id = self.allocate_id()?;
        self.track_ignored_response(id)?;
        if let Err(error) = self.write_command(id, method, params, session_id, None) {
            self.ignored.remove(&id);
            return Err(error);
        }
        Ok(())
    }

    pub(super) fn send_browser_close(&mut self) -> Result<(), BackendFailure> {
        let id = self.allocate_id()?;
        let params = serde_json::json!({});
        self.write_command(id, CdpMethod::BrowserClose, params, None, None)
    }

    pub(super) fn poll_available<H: ProtocolEventHandler>(
        &mut self,
        handler: &mut H,
        maximum_frames: usize,
    ) -> Result<usize, BackendFailure> {
        let mut handled = 0;
        while handled < maximum_frames {
            let Some(frame) = self.inbox.try_recv()? else {
                break;
            };
            handled += 1;
            match classify_frame(frame.value)? {
                IncomingFrame::Response { id, result } => {
                    self.store_response(id, result, frame.byte_len)?
                }
                IncomingFrame::Event(event) => handler.on_event(self, event)?,
            }
        }
        Ok(handled)
    }

    fn allocate_id(&mut self) -> Result<u64, BackendFailure> {
        let id = self.next_id;
        self.next_id = self.next_id.checked_add(1).ok_or_else(|| {
            BackendFailure::new(
                BackendFailureCode::ProtocolViolation,
                "Browser CDP request id space was exhausted.",
            )
        })?;
        Ok(id)
    }

    fn write_command(
        &mut self,
        id: u64,
        method: CdpMethod,
        params: Value,
        session_id: Option<&str>,
        cancellation: Option<&dyn CancellationProbe>,
    ) -> Result<(), BackendFailure> {
        let mut command = Map::new();
        command.insert("id".to_string(), Value::from(id));
        command.insert("method".to_string(), Value::from(method.as_str()));
        command.insert("params".to_string(), params);
        if let Some(session_id) = session_id {
            command.insert("sessionId".to_string(), Value::from(session_id));
        }
        let mut bytes = serde_json::to_vec(&Value::Object(command)).map_err(|_| {
            BackendFailure::new(
                BackendFailureCode::ProtocolViolation,
                "Browser CDP command could not be encoded.",
            )
        })?;
        if bytes.len() > MAX_OUTGOING_FRAME_BYTES {
            return Err(BackendFailure::new(
                BackendFailureCode::ProtocolViolation,
                "Browser CDP command exceeded the semantic size limit.",
            ));
        }
        bytes.push(0);
        // This is the exact check/write boundary. Epoch retirement and permit admission share a
        // mutex, so a stale Agent command cannot cross this point after revoke begins.
        let _effect_write = cancellation
            .map(CancellationProbe::enter_effect_write)
            .transpose()
            .map_err(|_| BackendFailure::cancelled())?
            .flatten();
        self.writer
            .write_all(&bytes)
            .and_then(|_| self.writer.flush())
            .map_err(|_| transport_failure(TransportFaultCode::Io))
    }

    fn store_response(
        &mut self,
        id: u64,
        result: Result<Value, super::protocol::CdpCommandFailure>,
        byte_len: usize,
    ) -> Result<(), BackendFailure> {
        if self.ignored.remove(&id) {
            return Ok(());
        }
        if self.pending.contains_key(&id)
            || self.pending.len() == MAX_PENDING_RESPONSES
            || self.pending_bytes.saturating_add(byte_len) > MAX_PENDING_RESPONSE_BYTES
        {
            return Err(transport_failure(TransportFaultCode::PendingQueueOverflow));
        }
        self.pending_bytes += byte_len;
        self.pending
            .insert(id, PendingResponse { result, byte_len });
        Ok(())
    }

    fn abandon_response(&mut self, id: u64) -> Result<(), BackendFailure> {
        if self.take_pending(id).is_some() {
            return Ok(());
        }
        self.track_ignored_response(id)
    }

    fn track_ignored_response(&mut self, id: u64) -> Result<(), BackendFailure> {
        if self.ignored.len() >= MAX_IGNORED_RESPONSES || !self.ignored.insert(id) {
            return Err(transport_failure(TransportFaultCode::PendingQueueOverflow));
        }
        Ok(())
    }

    fn take_pending(&mut self, id: u64) -> Option<PendingResponse> {
        let response = self.pending.remove(&id)?;
        self.pending_bytes = self.pending_bytes.saturating_sub(response.byte_len);
        Some(response)
    }
}

fn map_command_result(
    result: Result<Value, super::protocol::CdpCommandFailure>,
    rejection_code: BackendFailureCode,
) -> Result<Value, BackendFailure> {
    result.map_err(|_| {
        BackendFailure::new(rejection_code, "Browser rejected a semantic CDP command.")
    })
}

fn check_time_and_cancel(
    deadline: Instant,
    cancellation: &dyn CancellationProbe,
) -> Result<(), BackendFailure> {
    if cancellation.is_cancelled() {
        return Err(BackendFailure::cancelled());
    }
    if Instant::now() >= deadline {
        return Err(BackendFailure::new(
            BackendFailureCode::TimedOut,
            "Browser semantic command reached its fixed deadline.",
        ));
    }
    Ok(())
}

fn transport_failure(code: TransportFaultCode) -> BackendFailure {
    let (failure_code, message) = match code {
        TransportFaultCode::OversizedFrame
        | TransportFaultCode::InvalidJson
        | TransportFaultCode::PartialFrameEof
        | TransportFaultCode::PendingQueueOverflow => (
            BackendFailureCode::ProtocolViolation,
            "Browser private pipe violated the bounded CDP protocol.",
        ),
        TransportFaultCode::FrameQueueOverflow => (
            BackendFailureCode::RuntimeUnavailable,
            "Browser private pipe event queue overflowed.",
        ),
        TransportFaultCode::PipeEof | TransportFaultCode::Io => (
            BackendFailureCode::RuntimeUnavailable,
            "Browser private pipe closed unexpectedly.",
        ),
    };
    BackendFailure::new(failure_code, message)
}

#[cfg(test)]
#[path = "transport_reader_tests.rs"]
mod reader_tests;

#[cfg(test)]
#[path = "transport_capacity_tests.rs"]
mod capacity_tests;

#[cfg(test)]
mod tests {
    use super::super::super::control::{HandoffControl, HandoffGrant, LoginBrowserControl};
    use super::super::super::policy::BrowserGrantBinding;
    use super::*;
    use std::cell::Cell;

    fn cancellable() -> (Arc<LoginBrowserControl>, OperationCancellation) {
        let binding = BrowserGrantBinding::new_trusted("w", "p", "s", 1).unwrap();
        let control = Arc::new(LoginBrowserControl::new());
        control
            .activate_handoff(HandoffGrant::new_trusted(binding.clone()))
            .unwrap();
        let token = control.begin_operation(&binding, false).unwrap();
        (control, token)
    }

    fn cancellation() -> OperationCancellation {
        cancellable().1
    }

    struct NoopHandler;

    impl ProtocolEventHandler for NoopHandler {
        fn on_event(
            &mut self,
            _client: &mut CdpClient<'_>,
            _event: CdpEvent,
        ) -> Result<(), BackendFailure> {
            Ok(())
        }
    }

    struct CancelAfterDispatch {
        checks: Cell<usize>,
    }

    impl CancelAfterDispatch {
        fn new() -> Self {
            Self {
                checks: Cell::new(0),
            }
        }
    }

    impl CancellationProbe for CancelAfterDispatch {
        fn is_cancelled(&self) -> bool {
            let checks = self.checks.get() + 1;
            self.checks.set(checks);
            checks > 1
        }
    }

    struct ExpireAfterDispatch {
        checks: Cell<usize>,
    }

    impl ExpireAfterDispatch {
        fn new() -> Self {
            Self {
                checks: Cell::new(0),
            }
        }
    }

    impl CancellationProbe for ExpireAfterDispatch {
        fn is_cancelled(&self) -> bool {
            let checks = self.checks.get() + 1;
            self.checks.set(checks);
            if checks > 1 {
                std::thread::sleep(Duration::from_millis(2));
            }
            false
        }
    }

    fn enqueue_response(
        sender: &SyncSender<FrameEnvelope>,
        state: &ReaderState,
        id: u64,
        order: u64,
    ) {
        let value = serde_json::json!({"id":id,"result":{"order":order}});
        let byte_len = serde_json::to_vec(&value).unwrap().len();
        assert!(state.reserve_bytes(byte_len, MAX_QUEUED_FRAME_BYTES));
        sender.try_send(FrameEnvelope { value, byte_len }).unwrap();
    }

    #[test]
    fn partial_invalid_and_oversized_frames_fail_before_unbounded_allocation() {
        for (bytes, maximum, expected) in [
            (
                br#"{"id":1"#.to_vec(),
                64,
                TransportFaultCode::PartialFrameEof,
            ),
            (b"not-json\0".to_vec(), 64, TransportFaultCode::InvalidJson),
            (b"123456789".to_vec(), 8, TransportFaultCode::OversizedFrame),
        ] {
            let (sender, _inbox, state) = frame_channel();
            let mut reader = std::io::Cursor::new(bytes);
            run_frame_reader_with_limits(&mut reader, sender, Arc::clone(&state), maximum, 128);
            assert_eq!(state.fault(), Some(expected));
        }
    }

    #[test]
    fn out_of_order_responses_are_bounded_and_correlated_by_id() {
        let (sender, inbox, state) = frame_channel();
        for bytes in [
            br#"{"id":2,"result":{"order":2}}"#,
            br#"{"id":1,"result":{"order":1}}"#,
        ] {
            assert!(state.reserve_bytes(bytes.len(), MAX_QUEUED_FRAME_BYTES));
            sender
                .try_send(FrameEnvelope {
                    value: serde_json::from_slice(bytes).unwrap(),
                    byte_len: bytes.len(),
                })
                .unwrap();
        }
        let mut output = Vec::new();
        let mut client = CdpClient::new(&mut output, inbox);
        let token = cancellation();
        let deadline = Instant::now() + Duration::from_secs(1);
        let first = client
            .call(
                CdpMethod::PageEnable,
                serde_json::json!({}),
                Some("session"),
                deadline,
                &token,
                &mut NoopHandler,
            )
            .unwrap();
        let second = client
            .call(
                CdpMethod::DomEnable,
                serde_json::json!({}),
                Some("session"),
                deadline,
                &token,
                &mut NoopHandler,
            )
            .unwrap();
        assert_eq!(first["order"], 1);
        assert_eq!(second["order"], 2);
        assert!(!String::from_utf8(output)
            .unwrap()
            .contains("Runtime.evaluate"));
    }

    #[test]
    fn event_flood_hits_bounded_queue_instead_of_growing_memory() {
        let (sender, _inbox, state) = frame_channel();
        let frame = b"{\"method\":\"Page.loadEventFired\",\"params\":{}}\0";
        let mut bytes = Vec::new();
        for _ in 0..=FRAME_QUEUE_CAPACITY {
            bytes.extend_from_slice(frame);
        }
        let mut reader = std::io::Cursor::new(bytes);
        run_frame_reader(&mut reader, sender, Arc::clone(&state));
        assert_eq!(state.fault(), Some(TransportFaultCode::FrameQueueOverflow));
        assert!(state.queued_bytes.load(Ordering::Acquire) <= MAX_QUEUED_FRAME_BYTES);
    }

    #[test]
    fn out_of_order_response_flood_hits_pending_limit() {
        let (sender, inbox, state) = frame_channel();
        for id in 2..=(MAX_PENDING_RESPONSES as u64 + 2) {
            let value = serde_json::json!({"id":id,"result":{}});
            let byte_len = 32;
            assert!(state.reserve_bytes(byte_len, MAX_QUEUED_FRAME_BYTES));
            sender.try_send(FrameEnvelope { value, byte_len }).unwrap();
        }
        let mut output = Vec::new();
        let mut client = CdpClient::new(&mut output, inbox);
        let error = client
            .call(
                CdpMethod::PageEnable,
                serde_json::json!({}),
                Some("session"),
                Instant::now() + Duration::from_secs(1),
                &cancellation(),
                &mut NoopHandler,
            )
            .unwrap_err();
        assert_eq!(error.code, BackendFailureCode::ProtocolViolation);
    }

    #[test]
    fn transport_faults_map_to_stable_bounded_backend_failures() {
        for fault in [
            TransportFaultCode::PipeEof,
            TransportFaultCode::PartialFrameEof,
            TransportFaultCode::InvalidJson,
            TransportFaultCode::OversizedFrame,
            TransportFaultCode::FrameQueueOverflow,
            TransportFaultCode::PendingQueueOverflow,
            TransportFaultCode::Io,
        ] {
            let error = transport_failure(fault);
            assert!(matches!(
                error.code,
                BackendFailureCode::RuntimeUnavailable | BackendFailureCode::ProtocolViolation
            ));
            assert!(error.to_string().len() <= 128);
        }
    }

    #[test]
    fn continuous_events_neither_extend_deadline_nor_mask_cancellation() {
        let (sender, inbox, state) = frame_channel();
        let producer_state = Arc::clone(&state);
        let producer = std::thread::spawn(move || {
            for _ in 0..100 {
                let value = serde_json::json!({"method":"Page.loadEventFired","params":{}});
                let byte_len = 48;
                if !producer_state.reserve_bytes(byte_len, MAX_QUEUED_FRAME_BYTES) {
                    break;
                }
                if sender.send(FrameEnvelope { value, byte_len }).is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(1));
            }
        });
        let mut output = Vec::new();
        let mut client = CdpClient::new(&mut output, inbox);
        let token = cancellation();
        let started = Instant::now();
        let error = client
            .call(
                CdpMethod::PageEnable,
                serde_json::json!({}),
                Some("session"),
                Instant::now() + Duration::from_millis(25),
                &token,
                &mut NoopHandler,
            )
            .unwrap_err();
        assert_eq!(error.code, BackendFailureCode::TimedOut);
        assert!(started.elapsed() < Duration::from_millis(250));
        drop(client);
        producer.join().unwrap();

        let (sender, inbox, state) = frame_channel();
        let (control, token) = cancellable();
        let producer_state = Arc::clone(&state);
        let producer = std::thread::spawn(move || {
            for _ in 0..100 {
                if !producer_state.reserve_bytes(48, MAX_QUEUED_FRAME_BYTES) {
                    return;
                }
                if sender
                    .send(FrameEnvelope {
                        value: serde_json::json!({"method":"Page.loadEventFired"}),
                        byte_len: 48,
                    })
                    .is_err()
                {
                    return;
                }
                std::thread::sleep(Duration::from_millis(1));
            }
        });
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            control.cancel_active();
        });
        let mut output = Vec::new();
        let mut client = CdpClient::new(&mut output, inbox);
        let started = Instant::now();
        let error = client
            .call(
                CdpMethod::PageEnable,
                serde_json::json!({}),
                Some("session"),
                Instant::now() + Duration::from_secs(2),
                &token,
                &mut NoopHandler,
            )
            .unwrap_err();
        assert_eq!(error.code, BackendFailureCode::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(1));
        drop(client);
        canceller.join().unwrap();
        producer.join().unwrap();
    }

    #[test]
    fn cancelled_and_timed_out_calls_drain_more_than_pending_limit_of_late_responses() {
        let (sender, inbox, state) = frame_channel();
        let mut output = Vec::new();
        let mut client = CdpClient::new(&mut output, inbox);
        let abandoned = MAX_PENDING_RESPONSES + 8;
        let started = Instant::now();

        for index in 0..abandoned {
            let (probe, deadline, expected) = if index % 2 == 0 {
                (
                    Box::new(CancelAfterDispatch::new()) as Box<dyn CancellationProbe>,
                    Instant::now() + Duration::from_secs(1),
                    BackendFailureCode::Cancelled,
                )
            } else {
                (
                    Box::new(ExpireAfterDispatch::new()) as Box<dyn CancellationProbe>,
                    Instant::now() + Duration::from_millis(1),
                    BackendFailureCode::TimedOut,
                )
            };
            let error = client
                .call(
                    CdpMethod::PageEnable,
                    serde_json::json!({}),
                    Some("session"),
                    deadline,
                    probe.as_ref(),
                    &mut NoopHandler,
                )
                .unwrap_err();
            assert_eq!(error.code, expected);
        }
        assert!(started.elapsed() < Duration::from_secs(1));

        for id in (1..=abandoned as u64).rev() {
            enqueue_response(&sender, &state, id, id);
        }
        enqueue_response(&sender, &state, abandoned as u64 + 2, 2);
        enqueue_response(&sender, &state, abandoned as u64 + 1, 1);

        assert_eq!(
            client.poll_available(&mut NoopHandler, abandoned).unwrap(),
            abandoned
        );
        assert!(client.pending.is_empty());
        assert!(client.ignored.is_empty());

        let deadline = Instant::now() + Duration::from_secs(1);
        let first = client
            .call(
                CdpMethod::PageEnable,
                serde_json::json!({}),
                Some("session"),
                deadline,
                &NeverCancelled,
                &mut NoopHandler,
            )
            .unwrap();
        let second = client
            .call(
                CdpMethod::DomEnable,
                serde_json::json!({}),
                Some("session"),
                deadline,
                &NeverCancelled,
                &mut NoopHandler,
            )
            .unwrap();
        assert_eq!(first["order"], 1);
        assert_eq!(second["order"], 2);
    }
}
