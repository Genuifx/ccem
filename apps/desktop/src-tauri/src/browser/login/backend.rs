use super::control::OperationCancellation;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

const MAX_URL_CHARS: usize = 8_192;
const MAX_ELEMENT_REF_CHARS: usize = 256;
const MAX_INPUT_CHARS: usize = 65_536;
const MAX_WAIT_TEXT_CHARS: usize = 4_096;
const MAX_WAIT_MILLIS: u64 = 60_000;
const MAX_RESULT_TITLE_CHARS: usize = 4_096;
const MAX_RESULT_TEXT_CHARS: usize = 2_000_000;
const MAX_RESULT_ELEMENTS: usize = 5_000;
const MAX_ELEMENT_TEXT_CHARS: usize = 16_384;
const MAX_ARTIFACT_ID_CHARS: usize = 256;

/// The complete public command vocabulary for Login Browser automation.
///
/// This is deliberately a closed semantic enum. There is no escape hatch for JavaScript,
/// Runtime.evaluate, a CDP method name, or arbitrary protocol parameters.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum SemanticBrowserCommand {
    Navigate {
        url: String,
    },
    GetUrl,
    Click {
        element_ref: String,
    },
    Type {
        element_ref: String,
        text: String,
        #[serde(default)]
        replace: bool,
    },
    ReadPage,
    Screenshot,
    ReadConsoleLog,
    ReadNetworkLog,
    WaitFor {
        condition: SemanticWaitCondition,
        timeout_millis: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum SemanticWaitCondition {
    LoadComplete,
    ElementPresent { element_ref: String },
    TextPresent { text: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum SemanticOperation {
    Navigate,
    GetUrl,
    Click,
    Type,
    ReadPage,
    Screenshot,
    ReadConsoleLog,
    ReadNetworkLog,
    WaitFor,
}

impl SemanticOperation {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Navigate => "navigate",
            Self::GetUrl => "get_url",
            Self::Click => "click",
            Self::Type => "type",
            Self::ReadPage => "read_page",
            Self::Screenshot => "screenshot",
            Self::ReadConsoleLog => "read_console_log",
            Self::ReadNetworkLog => "read_network_log",
            Self::WaitFor => "wait_for",
        }
    }
}

impl SemanticBrowserCommand {
    pub(super) fn operation(&self) -> SemanticOperation {
        match self {
            Self::Navigate { .. } => SemanticOperation::Navigate,
            Self::GetUrl => SemanticOperation::GetUrl,
            Self::Click { .. } => SemanticOperation::Click,
            Self::Type { .. } => SemanticOperation::Type,
            Self::ReadPage => SemanticOperation::ReadPage,
            Self::Screenshot => SemanticOperation::Screenshot,
            Self::ReadConsoleLog => SemanticOperation::ReadConsoleLog,
            Self::ReadNetworkLog => SemanticOperation::ReadNetworkLog,
            Self::WaitFor { .. } => SemanticOperation::WaitFor,
        }
    }

    /// A write capability changes page or browser state and must stop when audit is degraded.
    pub(super) fn is_write_capability(&self) -> bool {
        matches!(
            self,
            Self::Navigate { .. } | Self::Click { .. } | Self::Type { .. }
        )
    }

    pub(super) fn permission_tool(&self) -> &'static str {
        match self {
            Self::Navigate { .. } => "navigate",
            Self::GetUrl => "get_url",
            Self::Click { .. } => "click",
            Self::Type { .. } => "type",
            Self::ReadPage => "snapshot",
            Self::Screenshot => "screenshot",
            Self::ReadConsoleLog => "read_console_log",
            Self::ReadNetworkLog => "read_network_log",
            Self::WaitFor { .. } => "wait_for",
        }
    }

    pub(super) fn navigation_url(&self) -> Option<&str> {
        match self {
            Self::Navigate { url } => Some(url),
            _ => None,
        }
    }

    pub(super) fn validate(&self) -> Result<(), SemanticCommandError> {
        match self {
            Self::Navigate { url } => validate_bounded(url, MAX_URL_CHARS, "url"),
            Self::Click { element_ref } => validate_element_ref(element_ref),
            Self::Type {
                element_ref, text, ..
            } => {
                validate_element_ref(element_ref)?;
                if text.chars().count() > MAX_INPUT_CHARS || text.chars().any(|value| value == '\0')
                {
                    return Err(SemanticCommandError::new(
                        SemanticCommandErrorCode::InvalidInput,
                        "Typed text exceeds the semantic command limit.",
                    ));
                }
                Ok(())
            }
            Self::GetUrl
            | Self::ReadPage
            | Self::Screenshot
            | Self::ReadConsoleLog
            | Self::ReadNetworkLog => Ok(()),
            Self::WaitFor {
                condition,
                timeout_millis,
            } => {
                if *timeout_millis == 0 || *timeout_millis > MAX_WAIT_MILLIS {
                    return Err(SemanticCommandError::new(
                        SemanticCommandErrorCode::InvalidTimeout,
                        "Wait timeout must be between 1 and 60000 milliseconds.",
                    ));
                }
                match condition {
                    SemanticWaitCondition::LoadComplete => Ok(()),
                    SemanticWaitCondition::ElementPresent { element_ref } => {
                        validate_element_ref(element_ref)
                    }
                    SemanticWaitCondition::TextPresent { text } => {
                        validate_bounded(text, MAX_WAIT_TEXT_CHARS, "wait text")
                    }
                }
            }
        }
    }

    /// A bounded, redacted description suitable for the pre-effect audit record.
    pub(super) fn audit_summary(&self) -> SemanticCommandAuditSummary {
        match self {
            Self::Navigate { .. } => SemanticCommandAuditSummary {
                operation: self.operation(),
                // The separately authorized origin is recorded by the service. Omitting the full
                // URL avoids persisting query-string credentials or user data.
                target: None,
                input_char_count: None,
                replace: None,
                timeout_millis: None,
            },
            Self::GetUrl => SemanticCommandAuditSummary {
                operation: self.operation(),
                target: None,
                input_char_count: None,
                replace: None,
                timeout_millis: None,
            },
            Self::Click { element_ref } => SemanticCommandAuditSummary {
                operation: self.operation(),
                target: Some(element_ref.clone()),
                input_char_count: None,
                replace: None,
                timeout_millis: None,
            },
            Self::Type {
                element_ref,
                text,
                replace,
            } => SemanticCommandAuditSummary {
                operation: self.operation(),
                target: Some(element_ref.clone()),
                input_char_count: Some(text.chars().count()),
                replace: Some(*replace),
                timeout_millis: None,
            },
            Self::ReadPage | Self::Screenshot | Self::ReadConsoleLog | Self::ReadNetworkLog => {
                SemanticCommandAuditSummary {
                    operation: self.operation(),
                    target: None,
                    input_char_count: None,
                    replace: None,
                    timeout_millis: None,
                }
            }
            Self::WaitFor { timeout_millis, .. } => SemanticCommandAuditSummary {
                operation: self.operation(),
                target: None,
                input_char_count: None,
                replace: None,
                timeout_millis: Some(*timeout_millis),
            },
        }
    }
}

fn validate_element_ref(value: &str) -> Result<(), SemanticCommandError> {
    validate_bounded(value, MAX_ELEMENT_REF_CHARS, "element reference")
}

fn validate_bounded(
    value: &str,
    maximum: usize,
    field: &'static str,
) -> Result<(), SemanticCommandError> {
    if value.trim().is_empty()
        || value.chars().count() > maximum
        || value.chars().any(char::is_control)
    {
        return Err(SemanticCommandError::new(
            SemanticCommandErrorCode::InvalidInput,
            match field {
                "url" => "Navigation URL is invalid.",
                "element reference" => "Element reference is invalid.",
                _ => "Wait text is invalid.",
            },
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(super) struct SemanticCommandAuditSummary {
    pub(super) operation: SemanticOperation,
    pub(super) target: Option<String>,
    pub(super) input_char_count: Option<usize>,
    pub(super) replace: Option<bool>,
    pub(super) timeout_millis: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SemanticCommandErrorCode {
    InvalidInput,
    InvalidTimeout,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SemanticCommandError {
    pub(super) code: SemanticCommandErrorCode,
    message: &'static str,
}

impl SemanticCommandError {
    fn new(code: SemanticCommandErrorCode, message: &'static str) -> Self {
        Self { code, message }
    }
}

impl fmt::Display for SemanticCommandError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for SemanticCommandError {}

/// Backend output is intentionally semantic and serializable. It cannot expose CDP target,
/// session, execution-context, transport, or backend object handles.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub(super) enum SemanticBrowserResult {
    Navigation(NavigationResult),
    Action(ActionResult),
    StructuredPage(StructuredPageResult),
    Screenshot(ScreenshotResult),
    ConsoleLog(DiagnosticLogResult),
    NetworkLog(DiagnosticLogResult),
    Wait(WaitResult),
}

impl SemanticBrowserResult {
    /// Treat the backend as a security boundary too: reject a mismatched or unbounded semantic
    /// response before it can reach Agent-visible serialization.
    pub(super) fn validate_for(
        &self,
        command: &SemanticBrowserCommand,
    ) -> Result<(), BackendFailure> {
        let shape_matches = matches!(
            (command, self),
            (
                SemanticBrowserCommand::Navigate { .. } | SemanticBrowserCommand::GetUrl,
                Self::Navigation(_)
            ) | (
                SemanticBrowserCommand::Click { .. } | SemanticBrowserCommand::Type { .. },
                Self::Action(_)
            ) | (SemanticBrowserCommand::ReadPage, Self::StructuredPage(_))
                | (SemanticBrowserCommand::Screenshot, Self::Screenshot(_))
                | (SemanticBrowserCommand::ReadConsoleLog, Self::ConsoleLog(_))
                | (SemanticBrowserCommand::ReadNetworkLog, Self::NetworkLog(_))
                | (SemanticBrowserCommand::WaitFor { .. }, Self::Wait(_))
        );
        if !shape_matches {
            return Err(protocol_violation());
        }
        match self {
            Self::Navigation(result) => {
                validate_result_string(&result.url, MAX_URL_CHARS, false)?;
                validate_optional_result_string(&result.title, MAX_RESULT_TITLE_CHARS)?;
            }
            Self::Action(result) if !result.completed => return Err(protocol_violation()),
            Self::Action(_) | Self::Wait(_) => {}
            Self::StructuredPage(result) => {
                validate_result_string(&result.url, MAX_URL_CHARS, false)?;
                validate_optional_result_string(&result.title, MAX_RESULT_TITLE_CHARS)?;
                if !result.untrusted
                    || result.text.chars().count() > MAX_RESULT_TEXT_CHARS
                    || result.elements.len() > MAX_RESULT_ELEMENTS
                {
                    return Err(protocol_violation());
                }
                for element in &result.elements {
                    validate_element_ref(&element.element_ref).map_err(|_| protocol_violation())?;
                    validate_result_string(&element.role, 128, false)?;
                    validate_optional_result_string(&element.name, MAX_ELEMENT_TEXT_CHARS)?;
                    validate_optional_result_string(&element.text, MAX_ELEMENT_TEXT_CHARS)?;
                }
            }
            Self::Screenshot(result) => {
                validate_opaque_artifact_id(&result.artifact_id)?;
                if result.sha256.len() != 64
                    || !result.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
                {
                    return Err(protocol_violation());
                }
            }
            Self::ConsoleLog(result) => {
                validate_diagnostic_log(result, "console-snapshot-", 2 * 1024 * 1024)?;
            }
            Self::NetworkLog(result) => {
                validate_diagnostic_log(result, "network-snapshot-", 8 * 1024 * 1024)?;
            }
        }
        Ok(())
    }
}

fn validate_diagnostic_log(
    result: &DiagnosticLogResult,
    prefix: &str,
    maximum_bytes: u64,
) -> Result<(), BackendFailure> {
    let Some(opaque_id) = result.artifact_id.strip_prefix(prefix) else {
        return Err(protocol_violation());
    };
    if opaque_id.len() != 32
        || !opaque_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || result.sha256.len() != 64
        || !result
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || result.byte_size > maximum_bytes
        || result.invalid_line_count != 0
        || result.recent.len() > 20
        || !result.untrusted
        || result.event_count < result.recent.len()
    {
        return Err(protocol_violation());
    }
    let recent_bytes = serde_json::to_vec(&result.recent).map_err(|_| protocol_violation())?;
    if recent_bytes.len() > 256 * 1024
        || result
            .recent
            .iter()
            .any(|event| !safe_diagnostic_value(event, 0))
    {
        return Err(protocol_violation());
    }
    Ok(())
}

fn safe_diagnostic_value(value: &Value, depth: usize) -> bool {
    if depth > 8 {
        return false;
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => true,
        Value::String(value) => value.chars().count() <= 16_384 && !value.contains('\0'),
        Value::Array(values) => {
            values.len() <= 128
                && values
                    .iter()
                    .all(|value| safe_diagnostic_value(value, depth + 1))
        }
        Value::Object(object) => {
            if object.len() > 64
                || object.keys().any(|key| {
                    matches!(
                        key.as_str(),
                        "objectId"
                            | "object_id"
                            | "preview"
                            | "description"
                            | "value"
                            | "webSocketDebuggerUrl"
                            | "postData"
                            | "request_body"
                            | "response_body"
                            | "body"
                            | "target_id"
                            | "session_id"
                            | "execution_context_id"
                    )
                })
            {
                return false;
            }
            if depth == 0 && object.get("untrusted").and_then(Value::as_bool) != Some(true) {
                return false;
            }
            object
                .values()
                .all(|value| safe_diagnostic_value(value, depth + 1))
        }
    }
}

fn validate_optional_result_string(
    value: &Option<String>,
    maximum: usize,
) -> Result<(), BackendFailure> {
    match value {
        Some(value) => validate_result_string(value, maximum, true),
        None => Ok(()),
    }
}

fn validate_opaque_artifact_id(value: &str) -> Result<(), BackendFailure> {
    if value.is_empty()
        || value.len() > MAX_ARTIFACT_ID_CHARS
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(protocol_violation());
    }
    Ok(())
}

fn validate_result_string(
    value: &str,
    maximum: usize,
    allow_empty: bool,
) -> Result<(), BackendFailure> {
    if (!allow_empty && value.trim().is_empty())
        || value.chars().count() > maximum
        || value.contains('\0')
    {
        return Err(protocol_violation());
    }
    Ok(())
}

fn protocol_violation() -> BackendFailure {
    BackendFailure::new(
        BackendFailureCode::ProtocolViolation,
        "Browser backend returned an invalid semantic result.",
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(super) struct NavigationResult {
    pub(super) url: String,
    pub(super) title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(super) struct ActionResult {
    pub(super) completed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(super) struct StructuredPageResult {
    pub(super) url: String,
    pub(super) title: Option<String>,
    /// Page-derived strings are untrusted data, never authority or instructions.
    pub(super) untrusted: bool,
    pub(super) text: String,
    pub(super) elements: Vec<SemanticElement>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(super) struct SemanticElement {
    /// A bounded service-minted semantic reference, not a browser/CDP node handle.
    pub(super) element_ref: String,
    pub(super) role: String,
    pub(super) name: Option<String>,
    pub(super) text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(super) struct ScreenshotResult {
    /// Opaque artifact-store identity; filesystem paths stay inside trusted Rust code.
    pub(super) artifact_id: String,
    pub(super) sha256: String,
    pub(super) byte_size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(super) struct DiagnosticLogResult {
    pub(super) artifact_id: String,
    pub(super) sha256: String,
    pub(super) byte_size: u64,
    pub(super) event_count: usize,
    pub(super) invalid_line_count: usize,
    pub(super) recent: Vec<Value>,
    pub(super) untrusted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(super) struct WaitResult {
    pub(super) satisfied: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum BackendFailureCode {
    Cancelled,
    NavigationFailed,
    ElementNotFound,
    InvalidSemanticReference,
    TimedOut,
    RuntimeUnavailable,
    ProtocolViolation,
}

impl BackendFailureCode {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::NavigationFailed => "navigation_failed",
            Self::ElementNotFound => "element_not_found",
            Self::InvalidSemanticReference => "invalid_semantic_reference",
            Self::TimedOut => "timed_out",
            Self::RuntimeUnavailable => "runtime_unavailable",
            Self::ProtocolViolation => "protocol_violation",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct BackendFailure {
    pub(super) code: BackendFailureCode,
    message: String,
}

impl BackendFailure {
    pub(super) fn new(code: BackendFailureCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub(super) fn cancelled() -> Self {
        Self::new(
            BackendFailureCode::Cancelled,
            "Browser operation was cancelled.",
        )
    }
}

impl fmt::Display for BackendFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for BackendFailure {}

/// The backend receives only semantic commands and a cooperative cancellation signal.
pub(super) trait SemanticBrowserBackend: Send + Sync {
    fn execute(
        &self,
        command: &SemanticBrowserCommand,
        cancellation: &OperationCancellation,
    ) -> Result<SemanticBrowserResult, BackendFailure>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_raw_cdp_and_runtime_evaluate_payloads() {
        for payload in [
            serde_json::json!({
                "operation": "raw_cdp",
                "method": "Runtime.evaluate",
                "params": {"expression": "globalThis.secret"}
            }),
            serde_json::json!({
                "operation": "evaluate",
                "script": "document.cookie"
            }),
            serde_json::json!({
                "operation": "click",
                "element_ref": "button-1",
                "method": "Runtime.evaluate"
            }),
        ] {
            assert!(serde_json::from_value::<SemanticBrowserCommand>(payload).is_err());
        }
    }

    #[test]
    fn typed_text_is_redacted_from_audit_summary() {
        let command = SemanticBrowserCommand::Type {
            element_ref: "field-email".to_string(),
            text: "private@example.test".to_string(),
            replace: true,
        };
        let json = serde_json::to_string(&command.audit_summary()).expect("serialize summary");
        assert!(!json.contains("private@example.test"));
        assert!(json.contains("input_char_count"));
    }

    #[test]
    fn serialized_results_do_not_leak_browser_backend_handles() {
        let results = [
            SemanticBrowserResult::Navigation(NavigationResult {
                url: "https://allowed.example/".to_string(),
                title: Some("Allowed".to_string()),
            }),
            SemanticBrowserResult::Action(ActionResult { completed: true }),
            SemanticBrowserResult::StructuredPage(StructuredPageResult {
                url: "https://allowed.example/".to_string(),
                title: Some("Allowed".to_string()),
                untrusted: true,
                text: "Page text".to_string(),
                elements: vec![SemanticElement {
                    element_ref: "button-submit".to_string(),
                    role: "button".to_string(),
                    name: Some("Submit".to_string()),
                    text: None,
                }],
            }),
            SemanticBrowserResult::Screenshot(ScreenshotResult {
                artifact_id: "artifact-screenshot-1".to_string(),
                sha256: "a".repeat(64),
                byte_size: 128,
            }),
            SemanticBrowserResult::Wait(WaitResult { satisfied: true }),
        ];
        for result in results {
            let value = serde_json::to_value(result).expect("serialize result");
            let object = value.as_object().expect("tagged result object");
            for forbidden in [
                "target_id",
                "session_id",
                "context_id",
                "execution_context_id",
                "backend_node_id",
                "object_id",
                "websocket_url",
                "artifact_path",
                "filesystem_path",
            ] {
                assert!(!object.contains_key(forbidden), "leaked key: {forbidden}");
                assert!(
                    !value.to_string().contains(forbidden),
                    "leaked key: {forbidden}"
                );
            }
        }
    }

    #[test]
    fn command_limits_fail_closed() {
        assert!(SemanticBrowserCommand::WaitFor {
            condition: SemanticWaitCondition::LoadComplete,
            timeout_millis: 60_001,
        }
        .validate()
        .is_err());
        assert!(SemanticBrowserCommand::Click {
            element_ref: "\n".to_string(),
        }
        .validate()
        .is_err());
    }

    #[test]
    fn mismatched_or_handle_shaped_backend_output_is_rejected() {
        let command = SemanticBrowserCommand::ReadPage;
        assert!(
            SemanticBrowserResult::Action(ActionResult { completed: true })
                .validate_for(&command)
                .is_err()
        );
        let invalid = SemanticBrowserResult::StructuredPage(StructuredPageResult {
            url: "https://allowed.example/".to_string(),
            title: None,
            untrusted: false,
            text: String::new(),
            elements: Vec::new(),
        });
        assert_eq!(
            invalid
                .validate_for(&command)
                .expect_err("must be marked untrusted")
                .code,
            BackendFailureCode::ProtocolViolation
        );
    }

    #[test]
    fn diagnostic_log_commands_are_closed_read_only_capabilities() {
        let console: SemanticBrowserCommand = serde_json::from_value(serde_json::json!({
            "operation": "read_console_log"
        }))
        .unwrap();
        let network: SemanticBrowserCommand = serde_json::from_value(serde_json::json!({
            "operation": "read_network_log"
        }))
        .unwrap();

        assert_eq!(console.permission_tool(), "read_console_log");
        assert_eq!(network.permission_tool(), "read_network_log");
        assert!(!console.is_write_capability());
        assert!(!network.is_write_capability());
        assert_eq!(
            console.audit_summary().operation.as_str(),
            "read_console_log"
        );
        assert_eq!(
            network.audit_summary().operation.as_str(),
            "read_network_log"
        );
    }

    #[test]
    fn diagnostic_results_reject_raw_handles_wrong_kind_and_unbounded_recent_data() {
        let result = DiagnosticLogResult {
            artifact_id: format!("console-snapshot-{}", "a".repeat(32)),
            sha256: "a".repeat(64),
            byte_size: 128,
            event_count: 1,
            invalid_line_count: 0,
            recent: vec![serde_json::json!({
                "schema_version": 1,
                "event": "console",
                "message": "safe",
                "untrusted": true
            })],
            untrusted: true,
        };
        assert!(SemanticBrowserResult::ConsoleLog(result.clone())
            .validate_for(&SemanticBrowserCommand::ReadConsoleLog)
            .is_ok());
        let mut live_identity = result.clone();
        live_identity.artifact_id = "console-session-1".to_string();
        assert!(SemanticBrowserResult::ConsoleLog(live_identity)
            .validate_for(&SemanticBrowserCommand::ReadConsoleLog)
            .is_err());
        assert!(SemanticBrowserResult::ConsoleLog(result.clone())
            .validate_for(&SemanticBrowserCommand::ReadNetworkLog)
            .is_err());

        let mut raw_handle = result.clone();
        raw_handle.recent = vec![serde_json::json!({
            "objectId": "raw-handle",
            "preview": {"secret": "private"},
            "untrusted": true
        })];
        assert!(SemanticBrowserResult::ConsoleLog(raw_handle)
            .validate_for(&SemanticBrowserCommand::ReadConsoleLog)
            .is_err());

        let mut oversized = result;
        oversized.recent = (0..20)
            .map(|_| serde_json::json!({"message":"x".repeat(16_000),"untrusted":true}))
            .collect();
        oversized.event_count = oversized.recent.len();
        assert!(SemanticBrowserResult::ConsoleLog(oversized)
            .validate_for(&SemanticBrowserCommand::ReadConsoleLog)
            .is_err());
    }
}
