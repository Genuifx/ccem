use chrono::Utc;
use serde::Serialize;
use std::collections::BTreeMap;

const MAX_CONFIGURED_SECRETS: usize = 64;
const MAX_CONFIGURED_SECRET_CHARS: usize = 4_096;
const MIN_CONFIGURED_SECRET_CHARS: usize = 4;
const MAX_NETWORK_URL_CHARS: usize = 16_384;
const MAX_DIAGNOSTIC_TEXT_CHARS: usize = 16_384;
const MAX_REQUEST_ID_CHARS: usize = 128;
const MAX_METHOD_CHARS: usize = 16;
const MAX_MIME_CHARS: usize = 128;
const MAX_RESOURCE_TYPE_CHARS: usize = 64;
const MAX_HEADER_VALUE_CHARS: usize = 1_024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum SafeNetworkEventKind {
    Request,
    Response,
    LoadingFinished,
    LoadingFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum NetworkProjectionCode {
    Captured,
    InvalidUrlRedacted,
    RedactionUnavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum SafeNetworkFailureCode {
    BlockedByPolicy,
    Cancelled,
    Timeout,
    ConnectionFailed,
    TlsFailed,
    Other,
}

impl NetworkProjectionCode {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Captured => "captured",
            Self::InvalidUrlRedacted => "invalid_url_redacted",
            Self::RedactionUnavailable => "redaction_unavailable",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(super) struct NetworkHeaderRef<'a> {
    pub(super) name: &'a str,
    pub(super) value: &'a str,
}

/// A borrowed view over one CDP Network event.
///
/// There is intentionally no request body, response body, cookie collection, post data, or raw
/// header map in the safe output contract. The CDP owner task should construct this view and
/// immediately call `project_network_event`; it must not persist the raw event first.
pub(super) struct NetworkEventInput<'a> {
    pub(super) kind: SafeNetworkEventKind,
    pub(super) request_id: &'a str,
    pub(super) method: Option<&'a str>,
    pub(super) url: &'a str,
    pub(super) status: Option<u16>,
    pub(super) mime_type: Option<&'a str>,
    pub(super) resource_type: Option<&'a str>,
    pub(super) headers: &'a [NetworkHeaderRef<'a>],
    pub(super) duration_ms: Option<u64>,
    pub(super) encoded_bytes: Option<u64>,
    /// The CDP adapter classifies raw `errorText` into this closed enum before projection. Raw
    /// browser/server error strings must never be copied into the diagnostic schema.
    pub(super) failure_code: Option<SafeNetworkFailureCode>,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct SafeNetworkEvent {
    schema_version: u32,
    event: SafeNetworkEventKind,
    projection_code: NetworkProjectionCode,
    captured_at: String,
    request_id: String,
    method: Option<String>,
    url: String,
    status: Option<u16>,
    mime_type: Option<String>,
    resource_type: Option<String>,
    headers: BTreeMap<String, String>,
    redacted_header_count: usize,
    ignored_header_count: usize,
    duration_ms: Option<u64>,
    encoded_bytes: Option<u64>,
    failure_code: Option<SafeNetworkFailureCode>,
    body_captured: bool,
    untrusted: bool,
}

#[derive(Debug, Clone)]
pub(super) struct NetworkRedactionConfig {
    configured_secrets: Vec<String>,
    paranoid: bool,
}

impl NetworkRedactionConfig {
    /// Constructed only from trusted CCEM configuration. An oversized or over-capacity credential
    /// set fails closed into paranoid projection instead of silently leaving a configured secret
    /// unredacted.
    pub(super) fn new_trusted<I, S>(secrets: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut configured_secrets = Vec::new();
        for secret in secrets {
            let secret = secret.as_ref();
            let secret_chars = secret.chars().count();
            if !(MIN_CONFIGURED_SECRET_CHARS..=MAX_CONFIGURED_SECRET_CHARS).contains(&secret_chars)
            {
                return Self::paranoid();
            }
            if configured_secrets.iter().any(|known| known == secret) {
                continue;
            }
            if configured_secrets.len() == MAX_CONFIGURED_SECRETS {
                return Self::paranoid();
            }
            configured_secrets.push(secret.to_string());
        }
        Self {
            configured_secrets,
            paranoid: false,
        }
    }

    /// Fail-closed mode used whenever CCEM configuration cannot be read or every configured
    /// credential cannot be decrypted. Page-controlled diagnostic strings are not persisted.
    pub(super) fn paranoid() -> Self {
        Self {
            configured_secrets: Vec::new(),
            paranoid: true,
        }
    }

    /// The single bounded diagnostic-text projection shared by network and console recorders.
    pub(super) fn redact_diagnostic_text(&self, value: &str, limit: usize) -> String {
        let limit = limit.min(MAX_DIAGNOSTIC_TEXT_CHARS);
        if limit == 0 {
            return String::new();
        }
        if self.paranoid {
            return "[REDACTED]".chars().take(limit).collect();
        }
        redact_safe_text(value, limit, &self.configured_secrets)
    }

    /// Removes configured credentials before an adapter applies its own input bound. Inline
    /// assignment redaction remains in the final projector so split console arguments retain
    /// their context.
    pub(super) fn redact_configured_prefix(&self, value: &str, limit: usize) -> String {
        let limit = limit.min(MAX_DIAGNOSTIC_TEXT_CHARS);
        if limit == 0 {
            return String::new();
        }
        if self.paranoid {
            return "[REDACTED]".chars().take(limit).collect();
        }
        configured_prefix_with_overlap(value, limit, &self.configured_secrets)
            .chars()
            .take(limit)
            .collect()
    }
}

impl Default for NetworkRedactionConfig {
    fn default() -> Self {
        // Unit/fixture callers with no configured credential set use the precise projector.
        // Production must use `network_config::configured_network_redaction`, which selects
        // `paranoid` whenever trusted configuration collection fails.
        Self::new_trusted(std::iter::empty::<&'static str>())
    }
}

pub(super) fn project_network_event(
    input: NetworkEventInput<'_>,
    config: &NetworkRedactionConfig,
) -> SafeNetworkEvent {
    if config.paranoid {
        return SafeNetworkEvent {
            schema_version: 1,
            event: input.kind,
            projection_code: NetworkProjectionCode::RedactionUnavailable,
            captured_at: Utc::now().to_rfc3339(),
            request_id: "redacted_request".to_string(),
            method: None,
            url: "[REDACTED]".to_string(),
            status: input.status,
            mime_type: None,
            resource_type: None,
            headers: BTreeMap::new(),
            redacted_header_count: input.headers.len(),
            ignored_header_count: 0,
            duration_ms: input.duration_ms,
            encoded_bytes: input.encoded_bytes,
            failure_code: input.failure_code,
            body_captured: false,
            untrusted: true,
        };
    }
    let (url, projection_code) = redact_network_url(input.url, config);
    let mut headers = BTreeMap::new();
    let mut redacted_header_count = 0;
    let mut ignored_header_count = 0;
    for header in input.headers {
        let name = normalize_header_name(header.name);
        if header_is_sensitive(&name) {
            redacted_header_count += 1;
            continue;
        }
        let Some(kind) = allowed_header_kind(&name) else {
            ignored_header_count += 1;
            continue;
        };
        let value = match kind {
            AllowedHeaderKind::Url => redact_network_url(header.value, config).0,
            AllowedHeaderKind::Text => redact_safe_text(
                header.value,
                MAX_HEADER_VALUE_CHARS,
                &config.configured_secrets,
            ),
        };
        // Duplicate headers are joined only after every value has passed through the safe
        // projection. The bounded merge prevents a hostile page/server from growing a log frame.
        headers
            .entry(name)
            .and_modify(|existing: &mut String| {
                if existing.chars().count() < MAX_HEADER_VALUE_CHARS {
                    existing.push_str(", ");
                    existing.push_str(&value);
                    *existing = existing.chars().take(MAX_HEADER_VALUE_CHARS).collect();
                }
            })
            .or_insert(value);
    }

    SafeNetworkEvent {
        schema_version: 1,
        event: input.kind,
        projection_code,
        captured_at: Utc::now().to_rfc3339(),
        request_id: redact_bounded_token(
            input.request_id,
            MAX_REQUEST_ID_CHARS,
            "unknown_request",
            &config.configured_secrets,
        ),
        method: input.method.map(|method| {
            redact_bounded_token(
                method,
                MAX_METHOD_CHARS,
                "UNKNOWN",
                &config.configured_secrets,
            )
        }),
        url,
        status: input.status,
        mime_type: input
            .mime_type
            .map(|value| redact_safe_text(value, MAX_MIME_CHARS, &config.configured_secrets)),
        resource_type: input.resource_type.map(|value| {
            redact_bounded_token(
                value,
                MAX_RESOURCE_TYPE_CHARS,
                "unknown",
                &config.configured_secrets,
            )
        }),
        headers,
        redacted_header_count,
        ignored_header_count,
        duration_ms: input.duration_ms,
        encoded_bytes: input.encoded_bytes,
        failure_code: input.failure_code,
        body_captured: false,
        untrusted: true,
    }
}

fn redact_network_url(
    value: &str,
    config: &NetworkRedactionConfig,
) -> (String, NetworkProjectionCode) {
    if value.chars().take(MAX_NETWORK_URL_CHARS + 1).count() > MAX_NETWORK_URL_CHARS {
        return (
            "[INVALID URL]".to_string(),
            NetworkProjectionCode::InvalidUrlRedacted,
        );
    }
    let Ok(mut url) = tauri::Url::parse(value) else {
        return (
            "[INVALID URL]".to_string(),
            NetworkProjectionCode::InvalidUrlRedacted,
        );
    };
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return (
            "[INVALID URL]".to_string(),
            NetworkProjectionCode::InvalidUrlRedacted,
        );
    }
    let _ = url.set_username("");
    let _ = url.set_password(None);
    if contains_configured_secret_encoding(url.as_str(), &config.configured_secrets) {
        let host_contains_secret = url.host_str().is_some_and(|host| {
            contains_configured_secret_encoding(host, &config.configured_secrets)
        });
        if host_contains_secret {
            return (
                "[REDACTED URL]".to_string(),
                NetworkProjectionCode::Captured,
            );
        }
        url.set_path("/[REDACTED]");
        url.set_query(None);
        url.set_fragment(None);
        return (url.to_string(), NetworkProjectionCode::Captured);
    }
    let query = url
        .query_pairs()
        .map(|(key, value)| {
            let value = if query_key_is_sensitive(&key) {
                "[REDACTED]".to_string()
            } else {
                redact_configured_secrets(&value, &config.configured_secrets)
            };
            let key = redact_configured_secrets(&key, &config.configured_secrets);
            (key, value)
        })
        .collect::<Vec<_>>();
    if url.query().is_some() {
        url.query_pairs_mut().clear().extend_pairs(query);
    }
    // Fragments never participate in an HTTP request and add only disclosure risk to a network
    // diagnostic record.
    url.set_fragment(None);
    let redacted = redact_configured_secrets(url.as_str(), &config.configured_secrets)
        .chars()
        .take(MAX_NETWORK_URL_CHARS)
        .collect();
    (redacted, NetworkProjectionCode::Captured)
}

fn query_key_is_sensitive(value: &str) -> bool {
    let normalized = value
        .to_ascii_lowercase()
        .replace(['-', '.', '[', ']'], "_");
    matches!(
        normalized.as_str(),
        "key"
            | "api_key"
            | "apikey"
            | "password"
            | "passwd"
            | "pass"
            | "secret"
            | "token"
            | "access_token"
            | "refresh_token"
            | "authorization"
            | "auth"
            | "session"
            | "session_id"
            | "cookie"
            | "otp"
            | "code"
            | "one_time_code"
    ) || normalized.contains("token")
        || normalized.contains("secret")
        || normalized.contains("password")
        || normalized.contains("api_key")
}

fn normalize_header_name(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .take(64)
        .collect()
}

fn header_is_sensitive(name: &str) -> bool {
    let normalized = name.replace('-', "_");
    matches!(
        normalized.as_str(),
        "authorization"
            | "proxy_authorization"
            | "cookie"
            | "set_cookie"
            | "x_api_key"
            | "api_key"
            | "x_auth_token"
            | "x_csrf_token"
    ) || normalized.contains("token")
        || normalized.contains("secret")
        || normalized.contains("password")
        || normalized.contains("session")
        || normalized.contains("otp")
}

#[derive(Debug, Clone, Copy)]
enum AllowedHeaderKind {
    Url,
    Text,
}

fn allowed_header_kind(name: &str) -> Option<AllowedHeaderKind> {
    match name {
        "location" | "referer" | "origin" => Some(AllowedHeaderKind::Url),
        "content-type" | "content-length" | "content-encoding" | "cache-control" => {
            Some(AllowedHeaderKind::Text)
        }
        _ => None,
    }
}

fn redact_safe_text(value: &str, limit: usize, secrets: &[String]) -> String {
    let redacted = configured_prefix_with_overlap(value, limit, secrets);
    redact_inline_assignments(&redacted)
        .chars()
        .take(limit)
        .collect()
}

fn configured_prefix_with_overlap(value: &str, limit: usize, secrets: &[String]) -> String {
    let overlap = secrets
        .iter()
        .map(|secret| secret.chars().count())
        .max()
        .unwrap_or(0);
    let bounded = value
        .chars()
        .take(limit.saturating_add(overlap))
        .collect::<String>();
    redact_configured_secrets(&bounded, secrets)
}

fn redact_inline_assignments(value: &str) -> String {
    let tokens = value.split_whitespace().collect::<Vec<_>>();
    let mut output = Vec::with_capacity(tokens.len());
    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index];
        if token.eq_ignore_ascii_case("bearer") || token.eq_ignore_ascii_case("basic") {
            output.push("[REDACTED]".to_string());
            index = (index + 2).min(tokens.len());
            continue;
        }
        if let Some((key, _)) = token.split_once(['=', ':']) {
            if query_key_is_sensitive(key) {
                output.push(format!("{}=[REDACTED]", key.to_ascii_lowercase()));
                if token.ends_with('=') || token.ends_with(':') {
                    index = (index + 2).min(tokens.len());
                } else {
                    index += 1;
                }
                continue;
            }
        }
        if query_key_is_sensitive(token) && matches!(tokens.get(index + 1), Some(&"=") | Some(&":"))
        {
            output.push(format!("{}=[REDACTED]", token.to_ascii_lowercase()));
            index = (index + 3).min(tokens.len());
            continue;
        }
        output.push(token.to_string());
        index += 1;
    }
    output.join(" ")
}

fn redact_configured_secrets(value: &str, secrets: &[String]) -> String {
    let mut output = value.to_string();
    for secret in secrets {
        if !secret.is_empty() && output.contains(secret) {
            output = output.replace(secret, "[REDACTED]");
        }
    }
    output
}

fn contains_configured_secret_encoding(value: &str, secrets: &[String]) -> bool {
    let mut candidate = value.to_string();
    for _ in 0..=2 {
        if secrets
            .iter()
            .any(|secret| !secret.is_empty() && candidate.contains(secret))
        {
            return true;
        }
        let Ok(decoded) = urlencoding::decode(&candidate) else {
            return false;
        };
        if decoded == candidate {
            return false;
        }
        candidate = decoded.into_owned();
    }
    false
}

fn bounded_token(value: &str, limit: usize, fallback: &str) -> String {
    let token = value
        .trim()
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(*character, '_' | '-' | '.' | ':')
        })
        .take(limit)
        .collect::<String>();
    if token.is_empty() {
        fallback.to_string()
    } else {
        token
    }
}

fn redact_bounded_token(value: &str, limit: usize, fallback: &str, secrets: &[String]) -> String {
    let overlap = secrets
        .iter()
        .map(|secret| secret.chars().count())
        .max()
        .unwrap_or(0);
    let bounded = value
        .chars()
        .take(limit.saturating_add(overlap))
        .collect::<String>();
    let redacted = redact_configured_secrets(&bounded, secrets);
    bounded_token(&redacted, limit, fallback)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SENTINEL: &str = "CCEM_NETWORK_SECRET_SENTINEL_42";

    #[test]
    fn network_projection_never_serializes_credentials_headers_cookies_or_bodies() {
        let config = NetworkRedactionConfig::new_trusted([SENTINEL]);
        let headers = [
            NetworkHeaderRef {
                name: "Authorization",
                value: "Bearer CCEM_NETWORK_SECRET_SENTINEL_42",
            },
            NetworkHeaderRef {
                name: "Cookie",
                value: "session=CCEM_NETWORK_SECRET_SENTINEL_42",
            },
            NetworkHeaderRef {
                name: "Set-Cookie",
                value: "session=CCEM_NETWORK_SECRET_SENTINEL_42",
            },
            NetworkHeaderRef {
                name: "X-API-Key",
                value: SENTINEL,
            },
            NetworkHeaderRef {
                name: "X-OTP",
                value: SENTINEL,
            },
            NetworkHeaderRef {
                name: "Content-Type",
                value: "application/json",
            },
            NetworkHeaderRef {
                name: "X-Ignored-Debug",
                value: SENTINEL,
            },
        ];
        let event = project_network_event(
            NetworkEventInput {
                kind: SafeNetworkEventKind::Request,
                request_id: "request-1",
                method: Some("POST"),
                url: "https://user:pass@example.test/api?access_token=raw&tab=CCEM_NETWORK_SECRET_SENTINEL_42#private",
                status: None,
                mime_type: None,
                resource_type: Some("Fetch"),
                headers: &headers,
                duration_ms: None,
                encoded_bytes: None,
                failure_code: None,
            },
            &config,
        );
        let serialized = serde_json::to_string(&event).expect("serialize safe network event");

        assert!(!serialized.contains(SENTINEL));
        assert!(!serialized.contains("raw"));
        assert!(!serialized.contains("user"));
        assert!(!serialized.contains("pass"));
        assert!(!serialized.to_ascii_lowercase().contains("authorization"));
        assert!(!serialized.to_ascii_lowercase().contains("set-cookie"));
        assert!(!serialized.to_ascii_lowercase().contains("cookie"));
        assert!(!serialized.contains("postData"));
        assert!(!serialized.contains("request_body"));
        assert!(!serialized.contains("response_body"));
        assert!(serialized.contains("content-type"));
        assert!(serialized.contains("REDACTED"));
        assert!(serialized.contains("\"body_captured\":false"));
        assert!(serialized.contains("\"untrusted\":true"));
    }

    #[test]
    fn url_headers_are_parsed_and_redacted_before_safe_projection() {
        let config = NetworkRedactionConfig::new_trusted([SENTINEL]);
        let headers = [
            NetworkHeaderRef {
                name: "Location",
                value:
                    "https://next.test/callback?code=secret&state=CCEM_NETWORK_SECRET_SENTINEL_42",
            },
            NetworkHeaderRef {
                name: "Referer",
                value: "https://source.test/?password=secret",
            },
            NetworkHeaderRef {
                name: "Cache-Control",
                value: "private, token=CCEM_NETWORK_SECRET_SENTINEL_42",
            },
        ];
        let event = project_network_event(
            NetworkEventInput {
                kind: SafeNetworkEventKind::Response,
                request_id: "request-2",
                method: None,
                url: "https://example.test/?safe=value",
                status: Some(302),
                mime_type: Some("text/html"),
                resource_type: Some("Document"),
                headers: &headers,
                duration_ms: Some(15),
                encoded_bytes: Some(128),
                failure_code: None,
            },
            &config,
        );
        let serialized = serde_json::to_string(&event).expect("serialize safe network event");
        assert!(!serialized.contains(SENTINEL));
        assert!(!serialized.contains("secret"));
        assert!(serialized.contains("location"));
        assert!(serialized.contains("referer"));
        assert!(serialized.contains("[REDACTED]"));
    }

    #[test]
    fn invalid_or_opaque_urls_never_echo_raw_input() {
        let config = NetworkRedactionConfig::new_trusted(std::iter::empty::<&str>());
        for value in [
            "not a URL SECRET",
            "data:text/html,raw-secret",
            "file:///tmp/raw-secret",
        ] {
            let event = project_network_event(
                NetworkEventInput {
                    kind: SafeNetworkEventKind::LoadingFailed,
                    request_id: "request-3",
                    method: None,
                    url: value,
                    status: None,
                    mime_type: None,
                    resource_type: None,
                    headers: &[],
                    duration_ms: None,
                    encoded_bytes: None,
                    failure_code: Some(SafeNetworkFailureCode::BlockedByPolicy),
                },
                &config,
            );
            let serialized = serde_json::to_string(&event).expect("serialize invalid event");
            assert!(serialized.contains("[INVALID URL]"));
            assert!(!serialized.contains("raw-secret"));
            assert!(serialized.contains("blocked_by_policy"));
        }
    }

    #[test]
    fn projection_codes_and_error_codes_are_stable_and_bounded() {
        for code in [
            NetworkProjectionCode::Captured,
            NetworkProjectionCode::InvalidUrlRedacted,
            NetworkProjectionCode::RedactionUnavailable,
        ] {
            assert!(code.as_str().len() <= 64);
            assert!(code
                .as_str()
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'_'));
        }
        for failure in [
            SafeNetworkFailureCode::BlockedByPolicy,
            SafeNetworkFailureCode::Cancelled,
            SafeNetworkFailureCode::Timeout,
            SafeNetworkFailureCode::ConnectionFailed,
            SafeNetworkFailureCode::TlsFailed,
            SafeNetworkFailureCode::Other,
        ] {
            let encoded = serde_json::to_string(&failure).expect("serialize failure code");
            assert!(encoded.len() <= 32);
        }
        let bounded = bounded_token(&"x".repeat(200), 96, "network_error");
        assert_eq!(bounded.len(), 96);
    }

    #[test]
    fn paranoid_redaction_never_echoes_an_unknown_configured_secret() {
        let secret = "UNKNOWN_CONFIG_SECRET_SENTINEL_84";
        let header_value = format!("text/plain note={secret}");
        let url = format!("https://example.test/{secret}?safe={secret}#{secret}");
        let headers = [NetworkHeaderRef {
            name: "Content-Type",
            value: &header_value,
        }];
        let event = project_network_event(
            NetworkEventInput {
                kind: SafeNetworkEventKind::Request,
                request_id: secret,
                method: Some("GET"),
                url: &url,
                status: None,
                mime_type: Some(secret),
                resource_type: Some("Fetch"),
                headers: &headers,
                duration_ms: None,
                encoded_bytes: None,
                failure_code: None,
            },
            &NetworkRedactionConfig::paranoid(),
        );
        let serialized = serde_json::to_string(&event).expect("serialize paranoid event");
        assert!(!serialized.contains(secret));
        assert!(serialized.contains("redaction_unavailable"));
    }

    #[test]
    fn diagnostic_text_uses_configured_and_inline_assignment_redaction() {
        let config = NetworkRedactionConfig::new_trusted([SENTINEL]);
        let redacted = config
            .redact_diagnostic_text(&format!("console token={SENTINEL} note {SENTINEL}"), 256);
        assert!(!redacted.contains(SENTINEL));
        assert!(redacted.contains("token=[REDACTED]"));

        let inline = config.redact_diagnostic_text(
            "authorization: unknown-auth password = unknown-password Bearer unknown-bearer",
            256,
        );
        assert!(!inline.contains("unknown-auth"));
        assert!(!inline.contains("unknown-password"));
        assert!(!inline.contains("unknown-bearer"));

        let paranoid = NetworkRedactionConfig::paranoid();
        assert_eq!(
            paranoid.redact_diagnostic_text("unknown private page diagnostic", 256),
            "[REDACTED]"
        );
    }

    #[test]
    fn configured_secrets_are_redacted_across_percent_encoding_and_output_boundaries() {
        let secret = "BOUNDARY SECRET/SENTINEL 73";
        let config = NetworkRedactionConfig::new_trusted([secret]);
        let encoded = urlencoding::encode(secret);
        let url = format!("https://example.test/public/{encoded}/tail");
        let event = project_network_event(
            NetworkEventInput {
                kind: SafeNetworkEventKind::Request,
                request_id: "request-1",
                method: Some("GET"),
                url: &url,
                status: None,
                mime_type: None,
                resource_type: Some("Fetch"),
                headers: &[],
                duration_ms: None,
                encoded_bytes: None,
                failure_code: None,
            },
            &config,
        );
        let serialized = serde_json::to_string(&event).unwrap();
        assert!(!serialized.contains(secret));
        assert!(!serialized.contains(encoded.as_ref()));
        assert!(!serialized.contains("BOUNDARY%20SECRET"));

        let diagnostic =
            config.redact_diagnostic_text(&format!("{}{}", "x".repeat(15), secret), 20);
        assert!(diagnostic.chars().count() <= 20);
        assert!(!diagnostic.contains("BOUND"));
    }

    #[test]
    fn short_configured_secrets_fail_closed_without_replacement_amplification() {
        for invalid_secret in ["", "a"] {
            let config = NetworkRedactionConfig::new_trusted([invalid_secret]);
            assert_eq!(
                config.redact_diagnostic_text("unknown private diagnostic", 32),
                "[REDACTED]"
            );
        }

        let config = NetworkRedactionConfig::new_trusted(["a"]);
        let diagnostic = config.redact_diagnostic_text(&"a".repeat(100_000), 32);
        assert_eq!(diagnostic, "[REDACTED]");
        assert!(diagnostic.len() <= 32);

        let request_id = "a".repeat(100_000);
        let url = format!("https://example.test/{}", "a".repeat(100_000));
        let event = project_network_event(
            NetworkEventInput {
                kind: SafeNetworkEventKind::Request,
                request_id: &request_id,
                method: Some("GET"),
                url: &url,
                status: None,
                mime_type: None,
                resource_type: Some("Fetch"),
                headers: &[],
                duration_ms: None,
                encoded_bytes: None,
                failure_code: None,
            },
            &config,
        );
        let serialized = serde_json::to_string(&event).expect("paranoid projection");
        assert!(serialized.len() < 1024);
        assert!(serialized.contains("redaction_unavailable"));
    }
}
