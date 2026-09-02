//! Production installation-smoke protocol for a pre-launched managed Chromium process.
//!
//! This adapter owns only the private `remote-debugging-pipe` byte protocol. Process creation,
//! descriptor inheritance, supervision, and cleanup stay outside this module. The smoke sequence is
//! deliberately incapable of evaluating JavaScript or exposing CDP target/session handles.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, VecDeque};
use std::io::{ErrorKind, Read, Write};
use std::time::{Duration, Instant};

const DEFAULT_MAX_FRAME_BYTES: usize = 32 * 1024 * 1024;
const MAX_PENDING_MESSAGES: usize = 4_096;
const PIPE_READ_CHUNK_BYTES: usize = 64 * 1024;
const SMOKE_MARKER: &str = "CCEM_MANAGED_CHROMIUM_INSTALLATION_SMOKE";
const TRANSPORT_EVIDENCE: &str = "remote_debugging_pipe_nul_json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SmokeErrorCode {
    WriteFailed,
    ReadFailed,
    TimedOut,
    PipeEof,
    TruncatedFrame,
    FrameTooLarge,
    InvalidJson,
    InvalidMessage,
    PendingQueueOverflow,
    CdpRejected,
    MissingResult,
    VersionMismatch,
    NavigationFailed,
    InvalidPng,
    TargetCloseFailed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SmokeError {
    pub code: SmokeErrorCode,
}

impl SmokeError {
    fn new(code: SmokeErrorCode) -> Self {
        Self { code }
    }
}

impl std::fmt::Display for SmokeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "managed Chromium installation smoke: {:?}",
            self.code
        )
    }
}

impl std::error::Error for SmokeError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InstallationSmokeEvidence {
    pub schema_version: u32,
    pub browser_product: String,
    pub browser_version: String,
    pub screenshot_bytes: u64,
    pub screenshot_sha256: String,
    pub transport: String,
    pub cdp_request_count: u64,
    pub observed_event_count: u64,
    pub target_closed: bool,
}

struct NulFrameReader<R> {
    reader: R,
    buffer: Vec<u8>,
    max_frame_bytes: usize,
}

impl<R: Read> NulFrameReader<R> {
    fn new(reader: R, max_frame_bytes: usize) -> Self {
        Self {
            reader,
            buffer: Vec::new(),
            max_frame_bytes: max_frame_bytes.max(1),
        }
    }

    fn read_frame(&mut self, deadline: Instant) -> Result<Vec<u8>, SmokeError> {
        loop {
            if Instant::now() >= deadline {
                return Err(SmokeError::new(SmokeErrorCode::TimedOut));
            }
            if let Some(delimiter) = self.buffer.iter().position(|byte| *byte == 0) {
                if delimiter > self.max_frame_bytes {
                    return Err(SmokeError::new(SmokeErrorCode::FrameTooLarge));
                }
                let mut frame = self.buffer.drain(..=delimiter).collect::<Vec<_>>();
                frame.pop();
                return Ok(frame);
            }
            if self.buffer.len() > self.max_frame_bytes {
                return Err(SmokeError::new(SmokeErrorCode::FrameTooLarge));
            }

            let mut chunk = [0_u8; PIPE_READ_CHUNK_BYTES];
            match self.reader.read(&mut chunk) {
                Ok(0) if self.buffer.is_empty() => {
                    return Err(SmokeError::new(SmokeErrorCode::PipeEof))
                }
                Ok(0) => return Err(SmokeError::new(SmokeErrorCode::TruncatedFrame)),
                Ok(read) => {
                    self.buffer.extend_from_slice(&chunk[..read]);
                    if let Some(delimiter) = self.buffer.iter().position(|byte| *byte == 0) {
                        if delimiter > self.max_frame_bytes {
                            return Err(SmokeError::new(SmokeErrorCode::FrameTooLarge));
                        }
                    } else if self.buffer.len() > self.max_frame_bytes {
                        return Err(SmokeError::new(SmokeErrorCode::FrameTooLarge));
                    }
                }
                Err(error)
                    if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
                {
                    if Instant::now() >= deadline {
                        return Err(SmokeError::new(SmokeErrorCode::TimedOut));
                    }
                }
                Err(_) => return Err(SmokeError::new(SmokeErrorCode::ReadFailed)),
            }
        }
    }
}

pub struct PrivatePipeAdapter<R, W> {
    frames: NulFrameReader<R>,
    writer: W,
    request_timeout: Duration,
    next_request_id: u64,
    pending_responses: BTreeMap<u64, Value>,
    pending_events: VecDeque<Value>,
    observed_event_count: u64,
}

impl<R: Read, W: Write> PrivatePipeAdapter<R, W> {
    pub fn new(reader: R, writer: W, request_timeout: Duration) -> Self {
        Self::with_frame_limit(reader, writer, request_timeout, DEFAULT_MAX_FRAME_BYTES)
    }

    fn with_frame_limit(
        reader: R,
        writer: W,
        request_timeout: Duration,
        max_frame_bytes: usize,
    ) -> Self {
        Self {
            frames: NulFrameReader::new(reader, max_frame_bytes),
            writer,
            request_timeout,
            next_request_id: 0,
            pending_responses: BTreeMap::new(),
            pending_events: VecDeque::new(),
            observed_event_count: 0,
        }
    }

    pub fn run_installation_smoke(
        &mut self,
        expected_version: &str,
    ) -> Result<InstallationSmokeEvidence, SmokeError> {
        let version_result = self.call("Browser.getVersion", json!({}), None)?;
        let browser_product = required_string(&version_result, "product")?;
        let browser_version = browser_product
            .rsplit_once('/')
            .map(|(_, version)| version)
            .ok_or_else(|| SmokeError::new(SmokeErrorCode::VersionMismatch))?
            .to_string();
        if browser_version != expected_version {
            return Err(SmokeError::new(SmokeErrorCode::VersionMismatch));
        }

        let smoke_url = smoke_data_url();
        let created = self.call("Target.createTarget", json!({ "url": "about:blank" }), None)?;
        let target_id = required_string(&created, "targetId")?;
        let result = self.run_attached_smoke(&target_id, &smoke_url);
        let close_result = self.call("Target.closeTarget", json!({ "targetId": target_id }), None);

        let screenshot = match result {
            Ok(screenshot) => screenshot,
            Err(error) => {
                let _ = close_result;
                return Err(error);
            }
        };
        let close_result = close_result?;
        if close_result.get("success").and_then(Value::as_bool) != Some(true) {
            return Err(SmokeError::new(SmokeErrorCode::TargetCloseFailed));
        }

        Ok(InstallationSmokeEvidence {
            schema_version: 1,
            browser_product,
            browser_version,
            screenshot_bytes: screenshot.len() as u64,
            screenshot_sha256: hex::encode(Sha256::digest(&screenshot)),
            transport: TRANSPORT_EVIDENCE.to_string(),
            cdp_request_count: self.next_request_id,
            observed_event_count: self.observed_event_count,
            target_closed: true,
        })
    }

    pub fn into_parts(self) -> (R, W) {
        (self.frames.reader, self.writer)
    }

    fn run_attached_smoke(
        &mut self,
        target_id: &str,
        smoke_url: &str,
    ) -> Result<Vec<u8>, SmokeError> {
        let attached = self.call(
            "Target.attachToTarget",
            json!({ "targetId": target_id, "flatten": true }),
            None,
        )?;
        let session_id = required_string(&attached, "sessionId")?;
        self.call("Page.enable", json!({}), Some(&session_id))?;
        self.call(
            "Page.setLifecycleEventsEnabled",
            json!({ "enabled": true }),
            Some(&session_id),
        )?;
        // A headed target created through Target.createTarget is not guaranteed to be the active
        // page. Chromium rejects captureScreenshot with -32000 until it is brought to front.
        self.call("Page.bringToFront", json!({}), Some(&session_id))?;
        if std::env::var_os("CCEM_RUNTIME_SMOKE_DIAGNOSTICS").is_some() {
            self.record_target_diagnostics(target_id, &session_id)?;
        }
        let navigation = self.call(
            "Page.navigate",
            json!({ "url": smoke_url }),
            Some(&session_id),
        )?;
        if navigation
            .get("errorText")
            .and_then(Value::as_str)
            .is_some()
        {
            return Err(SmokeError::new(SmokeErrorCode::NavigationFailed));
        }
        let loader_id = required_string(&navigation, "loaderId")?;
        self.wait_for_lifecycle_load(&loader_id, &session_id)?;
        let screenshot = self.call(
            "Page.captureScreenshot",
            json!({
                "format": "png",
                "fromSurface": true,
                "captureBeyondViewport": false,
            }),
            Some(&session_id),
        )?;
        let encoded = required_string(&screenshot, "data")?;
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| SmokeError::new(SmokeErrorCode::InvalidPng))?;
        if bytes.len() < 24 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || &bytes[12..16] != b"IHDR"
        {
            return Err(SmokeError::new(SmokeErrorCode::InvalidPng));
        }
        Ok(bytes)
    }

    fn wait_for_lifecycle_load(
        &mut self,
        loader_id: &str,
        session_id: &str,
    ) -> Result<Value, SmokeError> {
        let deadline = Instant::now() + self.request_timeout;
        loop {
            if let Some(index) = self.pending_events.iter().position(|event| {
                event.get("method").and_then(Value::as_str) == Some("Page.lifecycleEvent")
                    && session_matches(event, Some(session_id))
                    && event.pointer("/params/name").and_then(Value::as_str) == Some("load")
                    && event.pointer("/params/loaderId").and_then(Value::as_str) == Some(loader_id)
            }) {
                return self
                    .pending_events
                    .remove(index)
                    .ok_or_else(|| SmokeError::new(SmokeErrorCode::InvalidMessage));
            }
            let message = self.read_message(deadline)?;
            self.queue_message(message)?;
        }
    }

    fn record_target_diagnostics(
        &mut self,
        target_id: &str,
        session_id: &str,
    ) -> Result<(), SmokeError> {
        let target = self.call(
            "Target.getTargetInfo",
            json!({ "targetId": target_id }),
            None,
        )?;
        let info = target.get("targetInfo").unwrap_or(&Value::Null);
        let target_type = info
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let attached = info
            .get("attached")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let window = self.call(
            "Browser.getWindowForTarget",
            json!({ "targetId": target_id }),
            None,
        )?;
        let window_state = window
            .pointer("/bounds/windowState")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let frame_tree = self.call("Page.getFrameTree", json!({}), Some(session_id))?;
        let frame_url = frame_tree
            .pointer("/frameTree/frame/url")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let targets = self.call("Target.getTargets", json!({}), None)?;
        let mut page_count = 0_u64;
        let mut tab_count = 0_u64;
        let mut other_count = 0_u64;
        for target in targets
            .get("targetInfos")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            match target.get("type").and_then(Value::as_str) {
                Some("page") => page_count += 1,
                Some("tab") => tab_count += 1,
                _ => other_count += 1,
            }
        }
        eprintln!(
            "Managed Chromium headed target diagnostics: type={target_type} attached={attached} window_state={window_state} frame_url_scheme={} targets_page={page_count} targets_tab={tab_count} targets_other={other_count}",
            frame_url.split(':').next().unwrap_or("unknown"),
        );
        Ok(())
    }

    fn call(
        &mut self,
        method: &str,
        params: Value,
        session_id: Option<&str>,
    ) -> Result<Value, SmokeError> {
        self.next_request_id = self
            .next_request_id
            .checked_add(1)
            .ok_or_else(|| SmokeError::new(SmokeErrorCode::InvalidMessage))?;
        let request_id = self.next_request_id;
        let mut message = json!({
            "id": request_id,
            "method": method,
            "params": params,
        });
        if let Some(session_id) = session_id {
            message["sessionId"] = Value::String(session_id.to_string());
        }
        let mut encoded = serde_json::to_vec(&message)
            .map_err(|_| SmokeError::new(SmokeErrorCode::InvalidMessage))?;
        encoded.push(0);
        self.writer
            .write_all(&encoded)
            .and_then(|_| self.writer.flush())
            .map_err(|_| SmokeError::new(SmokeErrorCode::WriteFailed))?;

        let deadline = Instant::now() + self.request_timeout;
        loop {
            if let Some(response) = self.pending_responses.remove(&request_id) {
                if response.get("error").is_some() {
                    let protocol_code = response
                        .pointer("/error/code")
                        .and_then(Value::as_i64)
                        .unwrap_or_default();
                    let protocol_message = response
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .chars()
                        .filter(|character| !character.is_control())
                        .take(160)
                        .collect::<String>();
                    eprintln!(
                        "Managed Chromium installation smoke CDP rejection: method={method} code={protocol_code} message={protocol_message}"
                    );
                }
                return response_result(response);
            }
            let message = self.read_message(deadline)?;
            self.queue_message(message)?;
        }
    }

    fn wait_for_event(
        &mut self,
        method: &str,
        session_id: Option<&str>,
    ) -> Result<Value, SmokeError> {
        let deadline = Instant::now() + self.request_timeout;
        loop {
            if let Some(index) = self.pending_events.iter().position(|event| {
                event.get("method").and_then(Value::as_str) == Some(method)
                    && session_matches(event, session_id)
            }) {
                return self
                    .pending_events
                    .remove(index)
                    .ok_or_else(|| SmokeError::new(SmokeErrorCode::InvalidMessage));
            }
            let message = self.read_message(deadline)?;
            self.queue_message(message)?;
        }
    }

    fn read_message(&mut self, deadline: Instant) -> Result<Value, SmokeError> {
        let frame = self.frames.read_frame(deadline)?;
        if frame.is_empty() {
            return Err(SmokeError::new(SmokeErrorCode::InvalidJson));
        }
        serde_json::from_slice(&frame).map_err(|_| SmokeError::new(SmokeErrorCode::InvalidJson))
    }

    fn queue_message(&mut self, message: Value) -> Result<(), SmokeError> {
        if let Some(id) = message.get("id").and_then(Value::as_u64) {
            if self.pending_responses.len() >= MAX_PENDING_MESSAGES
                || self.pending_responses.insert(id, message).is_some()
            {
                return Err(SmokeError::new(SmokeErrorCode::PendingQueueOverflow));
            }
            return Ok(());
        }
        if message.get("method").and_then(Value::as_str).is_some() {
            if self.pending_events.len() >= MAX_PENDING_MESSAGES {
                return Err(SmokeError::new(SmokeErrorCode::PendingQueueOverflow));
            }
            self.observed_event_count = self.observed_event_count.saturating_add(1);
            self.pending_events.push_back(message);
            return Ok(());
        }
        Err(SmokeError::new(SmokeErrorCode::InvalidMessage))
    }
}

fn response_result(response: Value) -> Result<Value, SmokeError> {
    if response.get("error").is_some() {
        return Err(SmokeError::new(SmokeErrorCode::CdpRejected));
    }
    response
        .get("result")
        .cloned()
        .ok_or_else(|| SmokeError::new(SmokeErrorCode::MissingResult))
}

fn required_string(value: &Value, field: &str) -> Result<String, SmokeError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| SmokeError::new(SmokeErrorCode::MissingResult))
}

fn session_matches(event: &Value, expected: Option<&str>) -> bool {
    match expected {
        Some(expected) => event.get("sessionId").and_then(Value::as_str) == Some(expected),
        None => true,
    }
}

fn smoke_data_url() -> String {
    let html = format!(
        "<!doctype html><meta charset=utf-8><title>CCEM runtime smoke</title><main><h1>{SMOKE_MARKER}</h1></main>"
    );
    format!(
        "data:text/html;charset=utf-8,{}",
        urlencoding::encode(&html)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::thread;

    fn frame(value: Value) -> Vec<u8> {
        let mut bytes = serde_json::to_vec(&value).unwrap();
        bytes.push(0);
        bytes
    }

    #[derive(Default)]
    struct ChunkedReader {
        chunks: VecDeque<Vec<u8>>,
    }

    impl ChunkedReader {
        fn new(chunks: impl IntoIterator<Item = Vec<u8>>) -> Self {
            Self {
                chunks: chunks.into_iter().collect(),
            }
        }
    }

    impl Read for ChunkedReader {
        fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
            let Some(mut chunk) = self.chunks.pop_front() else {
                return Ok(0);
            };
            let read = chunk.len().min(output.len());
            output[..read].copy_from_slice(&chunk[..read]);
            if read < chunk.len() {
                chunk.drain(..read);
                self.chunks.push_front(chunk);
            }
            Ok(read)
        }
    }

    struct EventFloodReader {
        frame: Vec<u8>,
        offset: usize,
        reads: usize,
    }

    impl EventFloodReader {
        fn new() -> Self {
            Self {
                frame: frame(json!({ "method": "Page.frameNavigated", "params": {} })),
                offset: 0,
                reads: 0,
            }
        }
    }

    impl Read for EventFloodReader {
        fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
            if self.reads > 0 {
                thread::sleep(Duration::from_millis(1));
            }
            let remaining = &self.frame[self.offset..];
            let read = remaining.len().min(output.len());
            output[..read].copy_from_slice(&remaining[..read]);
            self.offset = (self.offset + read) % self.frame.len();
            self.reads += 1;
            Ok(read)
        }
    }

    #[test]
    fn parser_handles_fragmented_and_coalesced_frames() {
        let first = frame(json!({ "id": 1, "result": { "one": true } }));
        let second = frame(json!({ "id": 2, "result": { "two": true } }));
        let split = first.len() / 2;
        let reader = ChunkedReader::new([
            first[..split].to_vec(),
            [first[split..].to_vec(), second].concat(),
        ]);
        let mut frames = NulFrameReader::new(reader, 1024);
        let deadline = Instant::now() + Duration::from_secs(1);
        let first: Value = serde_json::from_slice(&frames.read_frame(deadline).unwrap()).unwrap();
        let second: Value = serde_json::from_slice(&frames.read_frame(deadline).unwrap()).unwrap();
        assert_eq!(first["id"], 1);
        assert_eq!(second["id"], 2);
    }

    #[test]
    fn adapter_preserves_out_of_order_response_and_event() {
        let input = [
            frame(json!({ "id": 2, "result": { "future": true } })),
            frame(json!({ "method": "Page.loadEventFired", "sessionId": "s-1", "params": {} })),
            frame(json!({ "id": 1, "result": { "current": true } })),
        ]
        .concat();
        let mut adapter =
            PrivatePipeAdapter::new(Cursor::new(input), Vec::<u8>::new(), Duration::from_secs(1));
        assert_eq!(
            adapter.call("One", json!({}), None).unwrap()["current"],
            true
        );
        assert_eq!(
            adapter.call("Two", json!({}), None).unwrap()["future"],
            true
        );
        assert_eq!(
            adapter
                .wait_for_event("Page.loadEventFired", Some("s-1"))
                .unwrap()["method"],
            "Page.loadEventFired"
        );
    }

    #[test]
    fn continuous_events_do_not_extend_request_deadline() {
        let mut adapter = PrivatePipeAdapter::new(
            EventFloodReader::new(),
            Vec::<u8>::new(),
            Duration::from_millis(250),
        );
        assert_eq!(
            adapter
                .call("NeverResponds", json!({}), None)
                .expect_err("event flood must time out")
                .code,
            SmokeErrorCode::TimedOut
        );
        assert!(adapter.observed_event_count > 0);
    }

    #[test]
    fn parser_rejects_limit_plus_one_even_when_nul_is_present() {
        let mut bytes = vec![b'a'; 9];
        bytes.push(0);
        let mut frames = NulFrameReader::new(Cursor::new(bytes), 8);
        assert_eq!(
            frames
                .read_frame(Instant::now() + Duration::from_secs(1))
                .unwrap_err()
                .code,
            SmokeErrorCode::FrameTooLarge
        );
    }

    #[test]
    fn parser_distinguishes_clean_eof_from_partial_frame() {
        let mut empty = NulFrameReader::new(Cursor::new(Vec::<u8>::new()), 32);
        assert_eq!(
            empty
                .read_frame(Instant::now() + Duration::from_secs(1))
                .unwrap_err()
                .code,
            SmokeErrorCode::PipeEof
        );
        let mut partial = NulFrameReader::new(Cursor::new(b"{\"id\":1".to_vec()), 32);
        assert_eq!(
            partial
                .read_frame(Instant::now() + Duration::from_secs(1))
                .unwrap_err()
                .code,
            SmokeErrorCode::TruncatedFrame
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_stream_delivers_fragmented_private_pipe_frame() {
        use std::os::unix::net::UnixStream;

        struct FragmentedUnixReader {
            consumer: UnixStream,
            producer: UnixStream,
            tail: Vec<u8>,
            injected: bool,
        }

        impl Read for FragmentedUnixReader {
            fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
                let read = self.consumer.read(output)?;
                if !self.injected {
                    self.producer.write_all(&self.tail)?;
                    self.injected = true;
                }
                Ok(read)
            }
        }

        let (mut producer, consumer) = UnixStream::pair().unwrap();
        consumer
            .set_read_timeout(Some(Duration::from_millis(20)))
            .unwrap();
        let encoded = frame(json!({ "id": 1, "result": { "ok": true } }));
        let split = encoded.len() / 2;
        producer.write_all(&encoded[..split]).unwrap();
        let reader = FragmentedUnixReader {
            consumer,
            producer,
            tail: encoded[split..].to_vec(),
            injected: false,
        };
        let mut frames = NulFrameReader::new(reader, 1024);
        let value: Value = serde_json::from_slice(
            &frames
                .read_frame(Instant::now() + Duration::from_secs(1))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(value["result"]["ok"], true);
    }

    #[test]
    fn installation_smoke_uses_bounded_semantic_sequence_without_exposing_handles() {
        let png = [
            b"\x89PNG\r\n\x1a\n".as_slice(),
            &[0, 0, 0, 13],
            b"IHDR".as_slice(),
            &[0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0],
        ]
        .concat();
        let input = [
            frame(json!({ "id": 1, "result": { "product": "Chrome/150.0.7871.115" } })),
            frame(json!({ "id": 2, "result": { "targetId": "private-target" } })),
            frame(json!({ "id": 3, "result": { "sessionId": "private-session" } })),
            frame(json!({ "id": 4, "result": {} })),
            frame(json!({ "id": 5, "result": {} })),
            frame(json!({ "id": 6, "result": {} })),
            frame(json!({ "method": "Page.lifecycleEvent", "sessionId": "private-session", "params": { "name": "load", "loaderId": "stale-loader" } })),
            frame(json!({ "id": 7, "result": { "frameId": "private-frame", "loaderId": "smoke-loader" } })),
            frame(json!({ "method": "Page.lifecycleEvent", "sessionId": "private-session", "params": { "name": "load", "loaderId": "smoke-loader" } })),
            frame(json!({ "id": 8, "result": { "data": STANDARD.encode(&png) } })),
            frame(json!({ "id": 9, "result": { "success": true } })),
        ]
        .concat();
        let mut adapter =
            PrivatePipeAdapter::new(Cursor::new(input), Vec::<u8>::new(), Duration::from_secs(1));
        let evidence = adapter
            .run_installation_smoke("150.0.7871.115")
            .expect("bounded installation smoke");
        assert_eq!(evidence.browser_version, "150.0.7871.115");
        assert_eq!(
            evidence.screenshot_sha256,
            hex::encode(Sha256::digest(&png))
        );
        assert_eq!(evidence.cdp_request_count, 9);
        assert!(evidence.target_closed);

        let serialized = serde_json::to_value(&evidence).unwrap();
        let serialized_text = serde_json::to_string(&serialized).unwrap();
        assert!(!serialized_text.contains("targetId"));
        assert!(!serialized_text.contains("sessionId"));
        assert!(!serialized_text.contains("private-target"));
        assert!(!serialized_text.contains("private-session"));

        let (_, written) = adapter.into_parts();
        let methods = written
            .split(|byte| *byte == 0)
            .filter(|frame| !frame.is_empty())
            .map(|frame| serde_json::from_slice::<Value>(frame).unwrap()["method"].clone())
            .collect::<Vec<_>>();
        assert_eq!(
            methods,
            [
                "Browser.getVersion",
                "Target.createTarget",
                "Target.attachToTarget",
                "Page.enable",
                "Page.setLifecycleEventsEnabled",
                "Page.bringToFront",
                "Page.navigate",
                "Page.captureScreenshot",
                "Target.closeTarget",
            ]
        );
        let requests = written
            .split(|byte| *byte == 0)
            .filter(|frame| !frame.is_empty())
            .map(|frame| serde_json::from_slice::<Value>(frame).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(requests[1]["params"]["url"], "about:blank");
        assert!(!written
            .windows(b"Runtime.evaluate".len())
            .any(|window| window == b"Runtime.evaluate"));
    }

    #[test]
    fn installation_smoke_rejects_nonexact_version_before_creating_target() {
        let input = frame(json!({
            "id": 1,
            "result": { "product": "Chrome/150.0.7871.114" }
        }));
        let mut adapter =
            PrivatePipeAdapter::new(Cursor::new(input), Vec::<u8>::new(), Duration::from_secs(1));
        assert_eq!(
            adapter
                .run_installation_smoke("150.0.7871.115")
                .expect_err("runtime version must match signed manifest exactly")
                .code,
            SmokeErrorCode::VersionMismatch
        );
        let (_, written) = adapter.into_parts();
        let requests = written
            .split(|byte| *byte == 0)
            .filter(|frame| !frame.is_empty())
            .collect::<Vec<_>>();
        assert_eq!(requests.len(), 1);
        assert_eq!(
            serde_json::from_slice::<Value>(requests[0]).unwrap()["method"],
            "Browser.getVersion"
        );
    }
}
