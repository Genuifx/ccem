use super::network::NetworkRedactionConfig;
use chrono::Utc;
use serde::{Deserialize, Serialize};

const MAX_CONSOLE_MESSAGE_CHARS: usize = 8_192;
const MAX_CONSOLE_SOURCE_CHARS: usize = 2_048;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum SafeConsoleLevel {
    Debug,
    Log,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SafeConsoleEvent {
    schema_version: u32,
    event: String,
    captured_at: String,
    level: SafeConsoleLevel,
    message: String,
    source: Option<String>,
    line_number: Option<u64>,
    column_number: Option<u64>,
    untrusted: bool,
}

pub(super) struct ConsoleEventInput<'a> {
    pub(super) level: &'a str,
    pub(super) message: &'a str,
    pub(super) source_url: Option<&'a str>,
    pub(super) line_number: Option<u64>,
    pub(super) column_number: Option<u64>,
}

pub(super) fn project_console_event(
    input: ConsoleEventInput<'_>,
    redaction: &NetworkRedactionConfig,
) -> SafeConsoleEvent {
    SafeConsoleEvent {
        schema_version: 1,
        event: "console".to_string(),
        captured_at: Utc::now().to_rfc3339(),
        level: normalize_level(input.level),
        message: redaction.redact_diagnostic_text(input.message, MAX_CONSOLE_MESSAGE_CHARS),
        source: input
            .source_url
            .map(|source| sanitize_source_url(source, redaction)),
        line_number: input.line_number,
        column_number: input.column_number,
        untrusted: true,
    }
}

fn normalize_level(value: &str) -> SafeConsoleLevel {
    match value {
        "debug" => SafeConsoleLevel::Debug,
        "info" => SafeConsoleLevel::Info,
        "warning" | "warn" => SafeConsoleLevel::Warn,
        "error" | "assert" => SafeConsoleLevel::Error,
        _ => SafeConsoleLevel::Log,
    }
}

fn sanitize_source_url(value: &str, redaction: &NetworkRedactionConfig) -> String {
    let Ok(mut url) = tauri::Url::parse(value) else {
        return "[INVALID URL]".to_string();
    };
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return "[INVALID URL]".to_string();
    }
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_query(None);
    url.set_fragment(None);
    redaction.redact_diagnostic_text(url.as_str(), MAX_CONSOLE_SOURCE_CHARS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::login::network::NetworkRedactionConfig;

    #[test]
    fn console_projection_redacts_secrets_and_bounds_untrusted_text_and_source() {
        let secret = "CCEM_CONSOLE_SECRET_SENTINEL_73";
        let event = project_console_event(
            ConsoleEventInput {
                level: "warning",
                message: &format!("token={secret} configured {secret} {}", "x".repeat(20_000)),
                source_url: Some(&format!(
                    "https://user:pass@example.test/app.js?token={secret}#private"
                )),
                line_number: Some(42),
                column_number: Some(7),
            },
            &NetworkRedactionConfig::new_trusted([secret]),
        );

        let serialized = serde_json::to_string(&event).unwrap();
        assert!(!serialized.contains(secret));
        assert!(!serialized.contains("user"));
        assert!(!serialized.contains("pass"));
        assert!(!serialized.contains("#private"));
        assert!(serialized.contains("token=[REDACTED]"));
        assert!(serialized.contains("https://example.test/app.js"));
        assert!(serialized.len() < 12_000);
        assert!(serialized.contains("\"untrusted\":true"));
        assert!(serialized.contains("\"level\":\"warn\""));
    }

    #[test]
    fn unsupported_console_levels_and_opaque_sources_are_reduced_to_closed_values() {
        let event = project_console_event(
            ConsoleEventInput {
                level: "trace-with-raw-object-preview",
                message: "plain message",
                source_url: Some("data:text/html,private"),
                line_number: None,
                column_number: None,
            },
            &NetworkRedactionConfig::new_trusted(std::iter::empty::<&str>()),
        );
        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["level"], "log");
        assert_eq!(value["source"], "[INVALID URL]");
        assert!(value.get("objectId").is_none());
        assert!(value.get("preview").is_none());
    }
}
