use super::super::backend::{BackendFailure, BackendFailureCode};
use super::super::console::{project_console_event, ConsoleEventInput};
use super::super::console_log::{ConsoleLogArtifact, ConsoleLogStore};
use super::super::network::NetworkRedactionConfig;
use super::diagnostic_segment::DiagnosticSegmentGate;
use super::protocol::{CdpEvent, CdpEventKind};
use serde_json::Value;
use std::path::PathBuf;

const MAX_CONSOLE_ARGS: usize = 32;
const MAX_PRIMITIVE_CHARS: usize = 1_024;
const MAX_MESSAGE_CHARS: usize = 8_192;
const MAX_SOURCE_URL_CHARS: usize = 8_192;

pub(super) struct ConsoleEventRecorder {
    store: ConsoleLogStore,
    segment: DiagnosticSegmentGate,
    redaction: NetworkRedactionConfig,
}

impl ConsoleEventRecorder {
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
            return Err(console_failure());
        }
        Ok(Self {
            store: ConsoleLogStore::new(root).map_err(|_| console_failure())?,
            segment: DiagnosticSegmentGate::disabled(),
            redaction,
        })
    }

    pub(super) fn begin_segment(
        &mut self,
        handoff_epoch: u64,
        primary_cdp_session: &str,
    ) -> Result<(), BackendFailure> {
        self.segment
            .begin(handoff_epoch, primary_cdp_session)
            .map_err(|_| console_failure())
    }

    pub(super) fn stop_segment(&mut self) {
        self.segment.stop();
    }

    pub(super) fn record(&mut self, event: &CdpEvent) -> Result<(), BackendFailure> {
        if event.kind != CdpEventKind::ConsoleApiCalled {
            return Ok(());
        }
        let Some(live_id) = self
            .segment
            .live_id_for(event.session_id.as_deref())
            .map(str::to_string)
        else {
            return Ok(());
        };
        let object = event.params.as_object().ok_or_else(console_failure)?;
        let level = object.get("type").and_then(Value::as_str).unwrap_or("log");
        let message = console_message(object.get("args"), &self.redaction);
        let source = console_source(object.get("stackTrace"));
        let projected = project_console_event(
            ConsoleEventInput {
                level,
                message: &message,
                source_url: source.as_ref().map(|source| source.url.as_str()),
                line_number: source.as_ref().and_then(|source| source.line_number),
                column_number: source.as_ref().and_then(|source| source.column_number),
            },
            &self.redaction,
        );
        self.store
            .append(&live_id, &projected)
            .map(|_| ())
            .map_err(|_| console_failure())
    }

    pub(super) fn read(&self) -> Result<ConsoleLogArtifact, BackendFailure> {
        let live_id = self.segment.active_live_id().ok_or_else(console_failure)?;
        self.store
            .read_artifact(&format!("console-{live_id}"))
            .map_err(|_| console_failure())
    }
}

struct ConsoleSource {
    url: String,
    line_number: Option<u64>,
    column_number: Option<u64>,
}

fn console_message(args: Option<&Value>, redaction: &NetworkRedactionConfig) -> String {
    let values = args
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(MAX_CONSOLE_ARGS)
        .filter_map(|value| console_primitive(value, redaction))
        .collect::<Vec<_>>();
    values.join(" ").chars().take(MAX_MESSAGE_CHARS).collect()
}

fn console_primitive(value: &Value, redaction: &NetworkRedactionConfig) -> Option<String> {
    let object = value.as_object()?;
    let projected = match object.get("type").and_then(Value::as_str)? {
        "string" => {
            redaction.redact_configured_prefix(object.get("value")?.as_str()?, MAX_PRIMITIVE_CHARS)
        }
        "number" => redaction.redact_configured_prefix(
            &object.get("value")?.as_number()?.to_string(),
            MAX_PRIMITIVE_CHARS,
        ),
        "boolean" => redaction.redact_configured_prefix(
            &object.get("value")?.as_bool()?.to_string(),
            MAX_PRIMITIVE_CHARS,
        ),
        "undefined" => "undefined".to_string(),
        "object" if object.get("subtype").and_then(Value::as_str) == Some("null") => {
            "null".to_string()
        }
        _ => return None,
    };
    Some(
        projected
            .chars()
            .filter(|character| *character != '\0')
            .collect(),
    )
}

fn console_source(stack_trace: Option<&Value>) -> Option<ConsoleSource> {
    let frame = stack_trace
        .and_then(Value::as_object)?
        .get("callFrames")?
        .as_array()?
        .first()?
        .as_object()?;
    let raw_url = frame.get("url")?.as_str()?;
    let url = if raw_url.chars().take(MAX_SOURCE_URL_CHARS + 1).count() > MAX_SOURCE_URL_CHARS {
        "[OVERSIZED URL]".to_string()
    } else {
        raw_url.to_string()
    };
    Some(ConsoleSource {
        url,
        line_number: frame.get("lineNumber").and_then(Value::as_u64),
        column_number: frame.get("columnNumber").and_then(Value::as_u64),
    })
}

fn console_failure() -> BackendFailure {
    BackendFailure::new(
        BackendFailureCode::RuntimeUnavailable,
        "Browser redacted console log is unavailable.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::login::network::NetworkRedactionConfig;

    fn console_event(session_id: &str, message: &str) -> CdpEvent {
        CdpEvent {
            kind: CdpEventKind::ConsoleApiCalled,
            params: serde_json::json!({
                "type": "log",
                "args": [{"type":"string", "value":message}]
            }),
            session_id: Some(session_id.to_string()),
        }
    }

    #[test]
    fn handoff_segments_exclude_pre_handoff_secondary_and_prior_epoch_console_history() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("logs");
        let mut recorder = ConsoleEventRecorder::new(
            root.clone(),
            "session-1".to_string(),
            NetworkRedactionConfig::default(),
        )
        .unwrap();
        recorder
            .record(&console_event("primary", "manual-login-secret"))
            .unwrap();
        assert!(
            recorder.read().is_err(),
            "initial recorder must be disabled"
        );

        recorder.begin_segment(1, "primary").unwrap();
        recorder
            .record(&console_event("secondary", "secondary-secret"))
            .unwrap();
        recorder
            .record(&console_event("primary", "epoch-one"))
            .unwrap();
        let old = recorder.read().unwrap();
        assert_eq!(old.event_count, 1);
        assert_eq!(old.recent[0]["message"], "epoch-one");

        recorder.stop_segment();
        assert!(recorder.read().is_err());
        recorder.begin_segment(2, "primary").unwrap();
        let current = recorder.read().unwrap();
        assert_eq!(
            current.event_count, 0,
            "new epoch starts with a new live segment"
        );

        let old_again = ConsoleLogStore::new(root)
            .unwrap()
            .read_snapshot(&old.artifact_id)
            .unwrap();
        assert_eq!(old_again.sha256, old.sha256);
        assert_eq!(old_again.recent[0]["message"], "epoch-one");
        let encoded = serde_json::to_string(&old_again.recent).unwrap();
        assert!(!encoded.contains("manual-login-secret"));
        assert!(!encoded.contains("secondary-secret"));
    }

    #[test]
    fn raw_remote_objects_are_reduced_to_redacted_primitive_console_jsonl() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("logs");
        let configured_secret = "CONFIGURED_CONSOLE_SECRET_51";
        let object_only_secret = "OBJECT_PREVIEW_MUST_NEVER_PERSIST_92";
        let mut recorder = ConsoleEventRecorder::new(
            root.clone(),
            "session-1".to_string(),
            NetworkRedactionConfig::new_trusted([configured_secret]),
        )
        .unwrap();
        recorder.begin_segment(1, "primary-session").unwrap();

        recorder
            .record(&CdpEvent {
                kind: CdpEventKind::ConsoleApiCalled,
                params: serde_json::json!({
                    "type": "warning",
                    "args": [
                        {"type":"string","value":format!("token={configured_secret}")},
                        {"type":"number","value":42},
                        {"type":"boolean","value":true},
                        {
                            "type":"object",
                            "objectId":"raw-object-handle",
                            "description":object_only_secret,
                            "preview":{"properties":[{"name":"secret","value":object_only_secret}]}
                        }
                    ],
                    "stackTrace": {"callFrames":[{
                        "url":format!("https://user:pass@example.test/app.js?token={configured_secret}#private"),
                        "lineNumber":12,
                        "columnNumber":7
                    }]}
                }),
                session_id: Some("primary-session".to_string()),
            })
            .unwrap();

        let path = root.join(format!(
            "console-{}.jsonl",
            recorder.segment.active_live_id().unwrap()
        ));
        let persisted = std::fs::read_to_string(&path).unwrap();
        assert!(!persisted.contains(configured_secret));
        assert!(!persisted.contains(object_only_secret));
        assert!(!persisted.contains("raw-object-handle"));
        assert!(!persisted.contains("preview"));
        assert!(!persisted.contains("description"));
        assert!(persisted.contains("token=[REDACTED]"));
        assert!(persisted.contains("42 true"));
        assert!(persisted.contains("https://example.test/app.js"));

        let artifact = recorder.read().unwrap();
        assert!(artifact.artifact_id.starts_with("console-snapshot-"));
        assert_eq!(artifact.artifact_id.len(), "console-snapshot-".len() + 32);
        assert_ne!(artifact.path, path);
        assert_eq!(artifact.event_count, 1);
        assert_eq!(artifact.recent.len(), 1);
    }

    #[test]
    fn configured_secrets_are_redacted_before_primitive_and_message_bounds() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("logs");
        let primitive_secret = "PRIMEDGE_SECRET_MUST_NOT_LEAK";
        let message_secret = "MSGEDGE_SECRET_MUST_NOT_LEAK";
        let mut recorder = ConsoleEventRecorder::new(
            root.clone(),
            "session-1".to_string(),
            NetworkRedactionConfig::new_trusted([primitive_secret, message_secret]),
        )
        .unwrap();
        recorder.begin_segment(1, "primary-session").unwrap();

        recorder
            .record(&CdpEvent {
                kind: CdpEventKind::ConsoleApiCalled,
                params: serde_json::json!({
                    "type": "log",
                    "args": [
                        {"type":"string","value":format!("{}{}", "p".repeat(MAX_PRIMITIVE_CHARS - 8), primitive_secret)},
                        {"type":"object","objectId":"raw-object","description":"OBJECT_ONLY_MARKER"}
                    ]
                }),
                session_id: Some("primary-session".to_string()),
            })
            .unwrap();

        let mut args = (0..8)
            .map(|_| serde_json::json!({"type":"string","value":"m".repeat(900)}))
            .collect::<Vec<_>>();
        args.push(serde_json::json!({
            "type":"string",
            "value":format!("{}{}", "n".repeat(980), message_secret)
        }));
        recorder
            .record(&CdpEvent {
                kind: CdpEventKind::ConsoleApiCalled,
                params: serde_json::json!({"type":"log","args":args}),
                session_id: Some("primary-session".to_string()),
            })
            .unwrap();

        recorder
            .record(&CdpEvent {
                kind: CdpEventKind::ConsoleApiCalled,
                params: serde_json::json!({
                    "type":"log",
                    "args":[{"type":"string","value":"source bound"}],
                    "stackTrace":{"callFrames":[{
                        "url":format!("https://example.test/{}", "s".repeat(9_000)),
                        "lineNumber":1,
                        "columnNumber":2
                    }]}
                }),
                session_id: Some("primary-session".to_string()),
            })
            .unwrap();

        let unknown_bearer = "UNKNOWN_CROSS_ARG_BEARER_TOKEN";
        recorder
            .record(&CdpEvent {
                kind: CdpEventKind::ConsoleApiCalled,
                params: serde_json::json!({
                    "type":"log",
                    "args":[
                        {"type":"string","value":"Bearer"},
                        {"type":"string","value":unknown_bearer}
                    ]
                }),
                session_id: Some("primary-session".to_string()),
            })
            .unwrap();

        let persisted = std::fs::read_to_string(root.join(format!(
            "console-{}.jsonl",
            recorder.segment.active_live_id().unwrap()
        )))
        .unwrap();
        assert!(!persisted.contains(primitive_secret));
        assert!(!persisted.contains(&primitive_secret[..8]));
        assert!(!persisted.contains(message_secret));
        assert!(!persisted.contains(&message_secret[..8]));
        assert!(!persisted.contains("OBJECT_ONLY_MARKER"));
        assert!(!persisted.contains("raw-object"));
        assert!(!persisted.contains(unknown_bearer));
        assert!(persisted.contains("[INVALID URL]"));
        assert!(persisted.len() < 24_000);
    }
}
