use super::super::backend::{BackendFailure, BackendFailureCode};
use super::super::network::{
    project_network_event, NetworkEventInput, NetworkHeaderRef, NetworkRedactionConfig,
    SafeNetworkEventKind, SafeNetworkFailureCode,
};
use super::super::network_log::{NetworkLogArtifact, NetworkLogStore};
use super::diagnostic_segment::DiagnosticSegmentGate;
use super::protocol::{CdpEvent, CdpEventKind};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::fmt::Write as _;
use std::path::PathBuf;
use std::time::Instant;

const MAX_TRACKED_REQUESTS: usize = 2_048;
const MAX_HEADERS_PER_EVENT: usize = 128;
const MAX_HEADER_NAME_CHARS: usize = 128;
const MAX_RAW_FIELD_CHARS: usize = 16_384;
const MAX_RAW_SESSION_ID_CHARS: usize = 256;
const OVERSIZED_URL_SENTINEL: &str = "[OVERSIZED URL]";
#[cfg(test)]
const LEGACY_MAX_RAW_HEADER_CHARS: usize = 8_192;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct RequestKey {
    cdp_session_id: Option<String>,
    request_id: String,
}

impl RequestKey {
    fn from_event(event: &CdpEvent, request_id: String) -> Result<Self, BackendFailure> {
        if event.session_id.as_ref().is_some_and(|session_id| {
            session_id.is_empty() || session_id.len() > MAX_RAW_SESSION_ID_CHARS
        }) {
            return Err(network_failure());
        }
        Ok(Self {
            cdp_session_id: event.session_id.clone(),
            request_id,
        })
    }
}

#[derive(Debug, Clone)]
struct RequestState {
    url: String,
    method: Option<String>,
    resource_type: Option<String>,
    started: Instant,
}

pub(super) struct NetworkEventRecorder {
    store: NetworkLogStore,
    segment: DiagnosticSegmentGate,
    redaction: NetworkRedactionConfig,
    requests: HashMap<RequestKey, RequestState>,
    order: VecDeque<RequestKey>,
}

impl NetworkEventRecorder {
    pub(super) fn new(
        root: PathBuf,
        session_id: String,
        redaction: NetworkRedactionConfig,
    ) -> Result<Self, BackendFailure> {
        if session_id.is_empty()
            || session_id.len() > 160
            || !session_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(network_failure());
        }
        Ok(Self {
            store: NetworkLogStore::new(root).map_err(|_| network_failure())?,
            segment: DiagnosticSegmentGate::disabled(),
            redaction,
            requests: HashMap::new(),
            order: VecDeque::new(),
        })
    }

    pub(super) fn begin_segment(
        &mut self,
        handoff_epoch: u64,
        primary_cdp_session: &str,
    ) -> Result<(), BackendFailure> {
        self.segment
            .begin(handoff_epoch, primary_cdp_session)
            .map_err(|_| network_failure())?;
        self.requests.clear();
        self.order.clear();
        Ok(())
    }

    pub(super) fn stop_segment(&mut self) {
        self.segment.stop();
        self.requests.clear();
        self.order.clear();
    }

    pub(super) fn record(&mut self, event: &CdpEvent) -> Result<(), BackendFailure> {
        let Some(live_id) = self
            .segment
            .live_id_for(event.session_id.as_deref())
            .map(str::to_string)
        else {
            return Ok(());
        };
        match event.kind {
            CdpEventKind::RequestWillBeSent => self.request_will_be_sent(event, &live_id),
            CdpEventKind::ResponseReceived => self.response_received(event, &live_id),
            CdpEventKind::LoadingFinished => self.loading_finished(event, &live_id),
            CdpEventKind::LoadingFailed => self.loading_failed(event, &live_id),
            _ => Ok(()),
        }
    }

    pub(super) fn read(&self) -> Result<NetworkLogArtifact, BackendFailure> {
        let live_id = self.segment.active_live_id().ok_or_else(network_failure)?;
        self.store
            .read_artifact(&format!("network-{live_id}"))
            .map_err(|_| network_failure())
    }

    fn request_will_be_sent(
        &mut self,
        event: &CdpEvent,
        live_id: &str,
    ) -> Result<(), BackendFailure> {
        let object = event.params.as_object().ok_or_else(network_failure)?;
        let request_id = string_field(object, "requestId").ok_or_else(network_failure)?;
        let key = RequestKey::from_event(event, request_id)?;
        let correlation_id = correlation_id(live_id, &key);
        let request = object
            .get("request")
            .and_then(Value::as_object)
            .ok_or_else(network_failure)?;
        let url = url_field(request, "url").unwrap_or_default();
        let method = string_field(request, "method");
        let resource_type = string_field(object, "type");
        if let Some(redirect) = object.get("redirectResponse").and_then(Value::as_object) {
            let previous = self.requests.get(&key).cloned();
            let redirect_url = url_field(redirect, "url")
                .or_else(|| previous.as_ref().map(|request| request.url.clone()))
                .unwrap_or_default();
            let redirect_status = redirect
                .get("status")
                .and_then(Value::as_f64)
                .filter(|value| *value >= 0.0 && *value <= u16::MAX as f64)
                .map(|value| value as u16);
            let redirect_mime = string_field(redirect, "mimeType");
            let redirect_headers = header_refs(redirect.get("headers"));
            if previous.is_some() {
                self.append_projection(
                    live_id,
                    SafeNetworkEventKind::Response,
                    &correlation_id,
                    previous
                        .as_ref()
                        .and_then(|request| request.method.as_deref()),
                    &redirect_url,
                    redirect_status,
                    redirect_mime.as_deref(),
                    resource_type.as_deref(),
                    &redirect_headers,
                    previous
                        .as_ref()
                        .map(|request| elapsed_millis(request.started)),
                    None,
                    None,
                )?;
            }
        }
        let headers = header_refs(request.get("headers"));
        self.append_projection(
            live_id,
            SafeNetworkEventKind::Request,
            &correlation_id,
            method.as_deref(),
            &url,
            None,
            None,
            resource_type.as_deref(),
            &headers,
            None,
            None,
            None,
        )?;
        self.track(
            key,
            RequestState {
                url,
                method,
                resource_type,
                started: Instant::now(),
            },
        );
        Ok(())
    }

    fn response_received(&mut self, event: &CdpEvent, live_id: &str) -> Result<(), BackendFailure> {
        let object = event.params.as_object().ok_or_else(network_failure)?;
        let request_id = string_field(object, "requestId").ok_or_else(network_failure)?;
        let key = RequestKey::from_event(event, request_id)?;
        let correlation_id = correlation_id(live_id, &key);
        let response = object
            .get("response")
            .and_then(Value::as_object)
            .ok_or_else(network_failure)?;
        let Some(tracked) = self.requests.get(&key) else {
            return Ok(());
        };
        let url = url_field(response, "url")
            .or_else(|| Some(tracked.url.clone()))
            .unwrap_or_default();
        let method = tracked.method.as_deref();
        let resource_type = string_field(object, "type").or_else(|| tracked.resource_type.clone());
        let status = response
            .get("status")
            .and_then(Value::as_f64)
            .filter(|value| *value >= 0.0 && *value <= u16::MAX as f64)
            .map(|value| value as u16);
        let mime_type = string_field(response, "mimeType");
        let headers = header_refs(response.get("headers"));
        self.append_projection(
            live_id,
            SafeNetworkEventKind::Response,
            &correlation_id,
            method,
            &url,
            status,
            mime_type.as_deref(),
            resource_type.as_deref(),
            &headers,
            Some(elapsed_millis(tracked.started)),
            None,
            None,
        )
    }

    fn loading_finished(&mut self, event: &CdpEvent, live_id: &str) -> Result<(), BackendFailure> {
        let object = event.params.as_object().ok_or_else(network_failure)?;
        let request_id = string_field(object, "requestId").ok_or_else(network_failure)?;
        let key = RequestKey::from_event(event, request_id)?;
        let encoded = object
            .get("encodedDataLength")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && *value >= 0.0)
            .map(|value| value as u64);
        self.finish_request(
            live_id,
            SafeNetworkEventKind::LoadingFinished,
            &key,
            encoded,
            None,
        )
    }

    fn loading_failed(&mut self, event: &CdpEvent, live_id: &str) -> Result<(), BackendFailure> {
        let object = event.params.as_object().ok_or_else(network_failure)?;
        let request_id = string_field(object, "requestId").ok_or_else(network_failure)?;
        let key = RequestKey::from_event(event, request_id)?;
        let failure = object
            .get("errorText")
            .and_then(Value::as_str)
            .map(classify_failure)
            .unwrap_or(SafeNetworkFailureCode::Other);
        self.finish_request(
            live_id,
            SafeNetworkEventKind::LoadingFailed,
            &key,
            None,
            Some(failure),
        )
    }

    fn finish_request(
        &mut self,
        live_id: &str,
        kind: SafeNetworkEventKind,
        key: &RequestKey,
        encoded: Option<u64>,
        failure: Option<SafeNetworkFailureCode>,
    ) -> Result<(), BackendFailure> {
        let tracked = self.requests.remove(key);
        self.order.retain(|value| value != key);
        let Some(tracked) = tracked else {
            return Ok(());
        };
        let correlation_id = correlation_id(live_id, key);
        self.append_projection(
            live_id,
            kind,
            &correlation_id,
            tracked.method.as_deref(),
            &tracked.url,
            None,
            None,
            tracked.resource_type.as_deref(),
            &[],
            Some(elapsed_millis(tracked.started)),
            encoded,
            failure,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn append_projection(
        &self,
        live_id: &str,
        kind: SafeNetworkEventKind,
        correlation_id: &str,
        method: Option<&str>,
        url: &str,
        status: Option<u16>,
        mime_type: Option<&str>,
        resource_type: Option<&str>,
        headers: &[NetworkHeaderRef<'_>],
        duration_ms: Option<u64>,
        encoded_bytes: Option<u64>,
        failure_code: Option<SafeNetworkFailureCode>,
    ) -> Result<(), BackendFailure> {
        let safe = project_network_event(
            NetworkEventInput {
                kind,
                request_id: correlation_id,
                method,
                url,
                status,
                mime_type,
                resource_type,
                headers,
                duration_ms,
                encoded_bytes,
                failure_code,
            },
            &self.redaction,
        );
        self.store
            .append(live_id, &safe)
            .map(|_| ())
            .map_err(|_| network_failure())
    }

    fn track(&mut self, key: RequestKey, state: RequestState) {
        if !self.requests.contains_key(&key) {
            while self.requests.len() >= MAX_TRACKED_REQUESTS {
                let Some(oldest) = self.order.pop_front() else {
                    self.requests.clear();
                    break;
                };
                self.requests.remove(&oldest);
            }
            self.order.push_back(key.clone());
        }
        self.requests.insert(key, state);
    }
}

fn correlation_id(agent_session_id: &str, key: &RequestKey) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"ccem-login-browser-network-correlation-v1\0");
    hash_component(&mut hasher, agent_session_id.as_bytes());
    match key.cdp_session_id.as_deref() {
        Some(session_id) => {
            hasher.update([1_u8]);
            hash_component(&mut hasher, session_id.as_bytes());
        }
        None => hasher.update([0_u8]),
    }
    hash_component(&mut hasher, key.request_id.as_bytes());
    let digest = hasher.finalize();
    let mut value = String::with_capacity(36);
    value.push_str("net_");
    for byte in digest.iter().take(16) {
        let _ = write!(&mut value, "{byte:02x}");
    }
    value
}

fn hash_component(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

fn string_field(object: &Map<String, Value>, name: &str) -> Option<String> {
    let value = object.get(name).and_then(Value::as_str)?;
    (value.chars().take(MAX_RAW_FIELD_CHARS + 1).count() <= MAX_RAW_FIELD_CHARS)
        .then(|| value.to_string())
}

fn url_field(object: &Map<String, Value>, name: &str) -> Option<String> {
    let value = object.get(name).and_then(Value::as_str)?;
    if value.chars().take(MAX_RAW_FIELD_CHARS + 1).count() > MAX_RAW_FIELD_CHARS {
        Some(OVERSIZED_URL_SENTINEL.to_string())
    } else {
        Some(value.to_string())
    }
}

fn header_refs(value: Option<&Value>) -> Vec<NetworkHeaderRef<'_>> {
    value
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|headers| headers.iter())
        .take(MAX_HEADERS_PER_EVENT)
        .filter_map(|(name, value)| {
            let value = value.as_str()?;
            if name.chars().take(MAX_HEADER_NAME_CHARS + 1).count() > MAX_HEADER_NAME_CHARS {
                return None;
            }
            Some(NetworkHeaderRef { name, value })
        })
        .collect()
}

fn elapsed_millis(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

fn classify_failure(value: &str) -> SafeNetworkFailureCode {
    let normalized = value.to_ascii_lowercase();
    if normalized.contains("blocked") || normalized.contains("aborted") {
        SafeNetworkFailureCode::BlockedByPolicy
    } else if normalized.contains("cancel") {
        SafeNetworkFailureCode::Cancelled
    } else if normalized.contains("timed") {
        SafeNetworkFailureCode::Timeout
    } else if normalized.contains("ssl") || normalized.contains("tls") {
        SafeNetworkFailureCode::TlsFailed
    } else if normalized.contains("connection") || normalized.contains("internet_disconnected") {
        SafeNetworkFailureCode::ConnectionFailed
    } else {
        SafeNetworkFailureCode::Other
    }
}

fn network_failure() -> BackendFailure {
    BackendFailure::new(
        BackendFailureCode::RuntimeUnavailable,
        "Browser redacted network log is unavailable.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn event(kind: CdpEventKind, session_id: &str, params: Value) -> CdpEvent {
        CdpEvent {
            kind,
            session_id: Some(session_id.to_string()),
            params,
        }
    }

    fn persisted_events(root: &std::path::Path, recorder: &NetworkEventRecorder) -> Vec<Value> {
        let live_id = recorder.segment.active_live_id().unwrap();
        std::fs::read_to_string(root.join(format!("network-{live_id}.jsonl")))
            .expect("network log")
            .lines()
            .map(|line| serde_json::from_str(line).expect("network event json"))
            .collect()
    }

    #[test]
    fn handoff_segments_drop_pre_handoff_secondary_and_cross_epoch_network_tracking() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("network");
        let mut recorder = NetworkEventRecorder::new(
            root.clone(),
            "agent-session".to_string(),
            NetworkRedactionConfig::default(),
        )
        .unwrap();
        let request = |session: &str, id: &str, url: &str| {
            event(
                CdpEventKind::RequestWillBeSent,
                session,
                serde_json::json!({
                    "requestId":id,
                    "type":"Document",
                    "request":{"url":url,"method":"GET"}
                }),
            )
        };
        let response = |session: &str, id: &str, status: u16| {
            event(
                CdpEventKind::ResponseReceived,
                session,
                serde_json::json!({
                    "requestId":id,
                    "type":"Document",
                    "response":{"url":"https://primary.example/", "status":status}
                }),
            )
        };

        recorder
            .record(&request("primary", "manual", "https://manual.example/"))
            .unwrap();
        assert!(
            recorder.read().is_err(),
            "initial recorder must be disabled"
        );

        recorder.begin_segment(1, "primary").unwrap();
        recorder
            .record(&response("primary", "manual", 200))
            .unwrap();
        recorder
            .record(&request(
                "secondary",
                "secondary",
                "https://secondary.example/",
            ))
            .unwrap();
        recorder
            .record(&request(
                "primary",
                "epoch-one",
                "https://primary.example/one",
            ))
            .unwrap();
        recorder
            .record(&request(
                "primary",
                "cross-epoch",
                "https://primary.example/carry",
            ))
            .unwrap();
        let old = recorder.read().unwrap();
        assert_eq!(old.event_count, 2);

        recorder.stop_segment();
        recorder.begin_segment(2, "primary").unwrap();
        recorder
            .record(&response("primary", "cross-epoch", 204))
            .unwrap();
        let current = recorder.read().unwrap();
        assert_eq!(
            current.event_count, 0,
            "new epoch cannot finish old tracking"
        );

        let old_again = NetworkLogStore::new(root)
            .unwrap()
            .read_snapshot(&old.artifact_id)
            .unwrap();
        assert_eq!(old_again.sha256, old.sha256);
        let encoded = serde_json::to_string(&old_again.recent).unwrap();
        assert!(!encoded.contains("manual.example"));
        assert!(!encoded.contains("secondary.example"));
    }

    #[test]
    fn only_the_active_primary_session_can_enter_network_tracking() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("network");
        let mut recorder = NetworkEventRecorder::new(
            root.clone(),
            "agent-session".to_string(),
            NetworkRedactionConfig::default(),
        )
        .unwrap();
        recorder.begin_segment(1, "cdp-session-alpha").unwrap();

        recorder
            .record(&event(
                CdpEventKind::RequestWillBeSent,
                "cdp-session-alpha",
                serde_json::json!({
                    "requestId": "shared-request",
                    "type": "Document",
                    "request": {
                        "url": "https://alpha.example/a",
                        "method": "GET"
                    }
                }),
            ))
            .unwrap();
        std::thread::sleep(Duration::from_millis(20));
        recorder
            .record(&event(
                CdpEventKind::RequestWillBeSent,
                "cdp-session-beta",
                serde_json::json!({
                    "requestId": "shared-request",
                    "type": "XHR",
                    "request": {
                        "url": "https://beta.example/b",
                        "method": "POST"
                    }
                }),
            ))
            .unwrap();
        recorder
            .record(&event(
                CdpEventKind::ResponseReceived,
                "cdp-session-alpha",
                serde_json::json!({
                    "requestId": "shared-request",
                    "type": "Document",
                    "response": {"status": 201, "mimeType": "text/html"}
                }),
            ))
            .unwrap();
        recorder
            .record(&event(
                CdpEventKind::LoadingFinished,
                "cdp-session-alpha",
                serde_json::json!({
                    "requestId": "shared-request",
                    "encodedDataLength": 11
                }),
            ))
            .unwrap();
        recorder
            .record(&event(
                CdpEventKind::ResponseReceived,
                "cdp-session-beta",
                serde_json::json!({
                    "requestId": "shared-request",
                    "type": "XHR",
                    "response": {"status": 202, "mimeType": "application/json"}
                }),
            ))
            .unwrap();
        recorder
            .record(&event(
                CdpEventKind::LoadingFinished,
                "cdp-session-beta",
                serde_json::json!({
                    "requestId": "shared-request",
                    "encodedDataLength": 22
                }),
            ))
            .unwrap();

        let events = persisted_events(&root, &recorder);
        let response_alpha = events
            .iter()
            .find(|event| event["status"] == 201)
            .expect("alpha response");
        assert_eq!(response_alpha["method"], "GET");
        assert_eq!(response_alpha["url"], "https://alpha.example/a");
        assert!(response_alpha["duration_ms"].as_u64().unwrap_or(0) >= 10);

        let correlation_alpha = response_alpha["request_id"].as_str().unwrap();
        let finished_alpha = events
            .iter()
            .find(|event| event["encoded_bytes"] == 11)
            .expect("alpha finish");
        assert_eq!(finished_alpha["request_id"], correlation_alpha);
        assert_eq!(finished_alpha["method"], "GET");
        assert_eq!(finished_alpha["url"], "https://alpha.example/a");
        assert_eq!(events.len(), 3);
        assert!(!serde_json::to_string(&events)
            .unwrap()
            .contains("beta.example"));
    }

    #[test]
    fn agent_visible_correlation_is_bounded_opaque_and_scoped_by_segment_and_request() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("network");
        let mut recorder = NetworkEventRecorder::new(
            root.clone(),
            "agent-session".to_string(),
            NetworkRedactionConfig::default(),
        )
        .unwrap();
        recorder.begin_segment(1, "raw-cdp-session-alpha").unwrap();
        for (request_id, url) in [
            ("raw-request-alpha", "https://alpha.example/"),
            ("raw-request-beta", "https://beta.example/"),
        ] {
            recorder
                .record(&event(
                    CdpEventKind::RequestWillBeSent,
                    "raw-cdp-session-alpha",
                    serde_json::json!({
                        "requestId": request_id,
                        "request": {"url": url, "method": "GET"}
                    }),
                ))
                .unwrap();
        }

        let persisted = std::fs::read_to_string(root.join(format!(
            "network-{}.jsonl",
            recorder.segment.active_live_id().unwrap()
        )))
        .unwrap();
        assert!(!persisted.contains("raw-cdp-session-alpha"));
        assert!(!persisted.contains("raw-request-alpha"));
        assert!(!persisted.contains("raw-request-beta"));
        let events = persisted
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        let first = events[0]["request_id"].as_str().unwrap();
        let second = events[1]["request_id"].as_str().unwrap();
        assert_ne!(first, second);
        for correlation in [first, second] {
            assert!(correlation.starts_with("net_"));
            assert!(correlation.len() <= 36);
            assert!(correlation
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_'));
        }
    }

    #[test]
    fn raw_cdp_secret_is_projected_before_any_network_disk_write() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("network");
        let secret = "CDP_NETWORK_SECRET_SENTINEL";
        let raw_cdp_session = format!("internal-{secret}-session");
        let raw_request_id = format!("request-{secret}");
        let mut recorder = NetworkEventRecorder::new(
            root.clone(),
            "session-1".to_string(),
            NetworkRedactionConfig::new_trusted([secret]),
        )
        .unwrap();
        recorder.begin_segment(1, &raw_cdp_session).unwrap();
        recorder
            .record(&CdpEvent {
                kind: CdpEventKind::RequestWillBeSent,
                session_id: Some(raw_cdp_session.clone()),
                params: serde_json::json!({
                    "requestId": raw_request_id,
                    "type": "Document",
                    "request": {
                        "url": format!("https://example.test/?token={secret}"),
                        "method": "GET",
                        "headers": {
                            "Authorization": format!("Bearer {secret}"),
                            "Cookie": format!("session={secret}"),
                            "Content-Type": "text/html"
                        },
                        "postData": secret
                    }
                }),
            })
            .unwrap();
        let path = root.join(format!(
            "network-{}.jsonl",
            recorder.segment.active_live_id().unwrap()
        ));
        let persisted = std::fs::read_to_string(path).unwrap();
        assert!(!persisted.contains(secret));
        assert!(!persisted.to_ascii_lowercase().contains("authorization"));
        assert!(!persisted.to_ascii_lowercase().contains("cookie"));
        assert!(!persisted.contains("postData"));
        assert!(!persisted.contains(&raw_cdp_session));
        assert!(persisted.contains("REDACTED"));
    }

    #[test]
    fn adapter_never_turns_oversized_url_or_header_prefixes_into_safe_output() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("network");
        let boundary_secret = "URLHEADER_BOUNDARY_SECRET_MUST_NOT_LEAK";
        let encoded_secret = "PERCENT SECRET/PATH MUST NOT LEAK";
        let mut recorder = NetworkEventRecorder::new(
            root.clone(),
            "session-1".to_string(),
            NetworkRedactionConfig::new_trusted([boundary_secret, encoded_secret]),
        )
        .unwrap();
        recorder.begin_segment(1, "cdp-session").unwrap();

        let url_base = "https://example.test/";
        let oversized_url = format!(
            "{url_base}{}{}",
            "u".repeat(MAX_RAW_FIELD_CHARS - url_base.len() - 8),
            boundary_secret
        );
        assert!(oversized_url.chars().count() > MAX_RAW_FIELD_CHARS);
        recorder
            .record(&event(
                CdpEventKind::RequestWillBeSent,
                "cdp-session",
                serde_json::json!({
                    "requestId":"oversized-url",
                    "type":"Document",
                    "request":{"url":oversized_url,"method":"GET"}
                }),
            ))
            .unwrap();

        let encoded = urlencoding::encode(encoded_secret);
        recorder
            .record(&event(
                CdpEventKind::RequestWillBeSent,
                "cdp-session",
                serde_json::json!({
                    "requestId":"encoded-url",
                    "type":"Fetch",
                    "request":{
                        "url":format!("https://example.test/public/{encoded}/tail"),
                        "method":"GET",
                        "postData":boundary_secret,
                        "headers":{"Authorization":boundary_secret}
                    }
                }),
            ))
            .unwrap();

        let header_base = "https://redirect.test/";
        let oversized_header = format!(
            "{header_base}{}{}",
            "h".repeat(LEGACY_MAX_RAW_HEADER_CHARS - header_base.len() - 8),
            boundary_secret
        );
        recorder
            .record(&event(
                CdpEventKind::RequestWillBeSent,
                "cdp-session",
                serde_json::json!({
                    "requestId":"header-boundary",
                    "type":"Document",
                    "request":{
                        "url":"https://example.test/",
                        "method":"GET",
                        "headers":{"Location":oversized_header}
                    }
                }),
            ))
            .unwrap();

        let persisted = std::fs::read_to_string(root.join(format!(
            "network-{}.jsonl",
            recorder.segment.active_live_id().unwrap()
        )))
        .unwrap();
        let events = persisted
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(events[0]["url"], "[INVALID URL]");
        assert_eq!(events[0]["projection_code"], "invalid_url_redacted");
        assert!(!persisted.contains(boundary_secret));
        assert!(!persisted.contains(&boundary_secret[..8]));
        assert!(!persisted.contains(encoded.as_ref()));
        assert!(!persisted.contains("PERCENT%20SECRET"));
        assert!(!persisted.contains("postData"));
        assert!(!persisted.to_ascii_lowercase().contains("authorization"));
        assert_eq!(
            events[2]["headers"]["location"],
            "https://redirect.test/[REDACTED]"
        );
    }
}
