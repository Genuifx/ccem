use super::backend::{
    DiagnosticLogResult, SemanticBrowserCommand, SemanticBrowserResult, SemanticOperation,
    SemanticWaitCondition,
};
#[cfg(test)]
use super::capability::BrowserPermissionAuthority;
use super::capability::{
    BrowserPermissionAuthorityTicket, PermissionAuthorityBinding, SemanticCapabilityService,
    SemanticExecutionContext,
};
use super::console_log::{ConsoleLogArtifact, ConsoleLogStore};
use super::network_log::{NetworkLogArtifact, NetworkLogStore};
use super::policy::{BrowserDataProvenance, NormalizedOrigin};
use super::provenance::{ProvenanceKey, ProvenanceOperation, ProvenanceWriteState};
use super::session::{LoginBrowserSessionManager, TrustedWorkspacePath};
use super::session_backend::SessionOwnedBackend;
use crate::browser::BrowserToolRequest;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

mod artifacts;

#[cfg(any(
    not(debug_assertions),
    test,
    all(target_os = "macos", debug_assertions)
))]
pub(in crate::browser::login) use artifacts::read_snapshot_artifact_contract;
#[cfg(test)]
use artifacts::resolve_snapshot_artifact;
use artifacts::{insert_artifact_path, resolve_screenshot_artifact, serialize_snapshot_artifact};

pub(crate) struct PreparedAgentToolExecution {
    actor_id: String,
    lease: super::session::AgentExecutionLease,
    command: SemanticBrowserCommand,
    permission: PermissionAuthorityBinding,
}

impl PreparedAgentToolExecution {
    pub(in crate::browser::login) fn artifact_root(&self) -> &Path {
        &self.lease.artifact_root
    }
}

impl LoginBrowserSessionManager {
    /// Route an existing native Agent browser request to the exact embedded browser handed to the
    /// same opaque conversation lineage. `None` means there is no eligible Mode 2 handoff.
    /// Agent arguments never select a profile/session/backend directly.
    pub(crate) fn prepare_agent_tool_if_handed_off(
        &self,
        workspace_dir: &str,
        agent_actor_id: &str,
        authority: BrowserPermissionAuthorityTicket,
        request: &BrowserToolRequest,
    ) -> Result<Option<PreparedAgentToolExecution>, String> {
        if !self.is_available() {
            // The native runtime converts this missing route into a fail-closed error. Never
            // silently fall back to the legacy Preview implementation.
            return Ok(None);
        }
        let workspace = TrustedWorkspacePath::from_trusted_app(PathBuf::from(workspace_dir))
            .map_err(|error| error.to_string())?;
        let Some((lease, permission)) = self
            .agent_execution_for_actor_with_permission(&workspace, agent_actor_id, authority)
            .map_err(|error| error.to_string())?
        else {
            return Ok(None);
        };
        // Resolve the exact native conversation before interpreting its request. A non-owner
        // cannot turn an unsupported or malformed tool into an oracle for Mode 2 capabilities.
        let command = parse_command(request)?;
        Ok(Some(PreparedAgentToolExecution {
            actor_id: agent_actor_id.to_string(),
            lease,
            command,
            permission,
        }))
    }

    pub(crate) fn execute_prepared_agent_tool(
        &self,
        request: &BrowserToolRequest,
        prepared: PreparedAgentToolExecution,
    ) -> Result<Value, String> {
        let PreparedAgentToolExecution {
            actor_id,
            lease,
            command,
            permission,
        } = prepared;
        let service = SemanticCapabilityService::new_with_counter(
            Arc::clone(&lease.control),
            Arc::clone(&lease.permission),
            Arc::clone(&lease.origin),
            Arc::clone(&lease.audit),
            Arc::clone(&lease.backend),
            Arc::clone(&lease.operation_ids),
        );
        let key = ProvenanceKey::new_trusted(&lease.workspace_identity, &actor_id)
            .map_err(|_| provenance_unavailable())?;
        let result = lease
            .provenance
            .with_serialized_operation(&key, |provenance| {
                let data_provenance =
                    command_data_provenance(&command, &lease.current_url, provenance)?;
                let operation = command.operation();
                let context =
                    SemanticExecutionContext::new_trusted(&lease.binding, &lease.current_url)
                        .with_data_provenance(data_provenance)
                        .with_request_id(&request.request_id)
                        .with_actor_id(&actor_id)
                        .with_permission_epoch(permission.epoch());
                let result = service.execute(&context, command).map_err(|error| {
                    format!(
                        "Login Browser capability denied ({}:{}).",
                        error.code.as_str(),
                        error.cause_code
                    )
                })?;
                if let Some(origin) =
                    successful_page_read_origin(operation, &result, lease.backend.as_ref())?
                {
                    provenance
                        .record_successful_page_read(&origin)
                        .map_err(|_| provenance_unavailable())?;
                }
                serialize_agent_result(result, &lease.artifact_root)
            })
            .map_err(|_| provenance_unavailable())??;
        Ok(result)
    }

    #[cfg(test)]
    pub(crate) fn run_agent_tool_if_handed_off(
        &self,
        workspace_dir: &str,
        actor_id: &str,
        permission_mode: &str,
        request: &BrowserToolRequest,
    ) -> Result<Option<Value>, String> {
        let authority = BrowserPermissionAuthority::new(permission_mode);
        let prepared = self.prepare_agent_tool_if_handed_off(
            workspace_dir,
            actor_id,
            authority
                .current_ticket()
                .map_err(|_| "Native browser permission authority is unavailable".to_string())?,
            request,
        )?;
        prepared
            .map(|prepared| self.execute_prepared_agent_tool(request, prepared))
            .transpose()
    }
}

fn command_data_provenance(
    command: &SemanticBrowserCommand,
    current_url: &str,
    provenance: &ProvenanceOperation<'_>,
) -> Result<BrowserDataProvenance, String> {
    if !command.is_write_capability() {
        return Ok(BrowserDataProvenance::UntrackedOrSameOrigin);
    }
    let target_url = command.navigation_url().unwrap_or(current_url);
    let Ok(target) = NormalizedOrigin::parse(target_url) else {
        // Invalid or ungranted targets must reach the capability policy so their denial is
        // durably audited. There is no backend effect before that decision.
        return Ok(BrowserDataProvenance::UntrackedOrSameOrigin);
    };
    provenance
        .write_state(&target)
        .map(|state| match state {
            ProvenanceWriteState::Untainted | ProvenanceWriteState::SingleOriginSame => {
                BrowserDataProvenance::UntrackedOrSameOrigin
            }
            ProvenanceWriteState::SingleOriginDifferent => BrowserDataProvenance::CrossOrigin,
            ProvenanceWriteState::Mixed => BrowserDataProvenance::Mixed,
        })
        .map_err(|_| provenance_unavailable())
}

fn successful_page_read_origin(
    operation: SemanticOperation,
    result: &SemanticBrowserResult,
    backend: &dyn SessionOwnedBackend,
) -> Result<Option<NormalizedOrigin>, String> {
    let url = match (operation, result) {
        (
            SemanticOperation::Navigate | SemanticOperation::GetUrl,
            SemanticBrowserResult::Navigation(result),
        ) => Some(result.url.clone()),
        (SemanticOperation::ReadPage, SemanticBrowserResult::StructuredPage(result)) => {
            Some(result.url.clone())
        }
        (
            SemanticOperation::Screenshot
            | SemanticOperation::ReadConsoleLog
            | SemanticOperation::ReadNetworkLog
            | SemanticOperation::WaitFor,
            _,
        ) => Some(
            backend
                .projection()
                .map_err(|_| provenance_unavailable())?
                .current_url,
        ),
        (SemanticOperation::Click | SemanticOperation::Type, _) => None,
        _ => return Err(provenance_unavailable()),
    };
    url.map(|url| NormalizedOrigin::parse(&url).map_err(|_| provenance_unavailable()))
        .transpose()
}

fn provenance_unavailable() -> String {
    "Login Browser provenance state is unavailable.".to_string()
}

fn serialize_agent_result(
    result: SemanticBrowserResult,
    artifact_root: &Path,
) -> Result<Value, String> {
    match result {
        SemanticBrowserResult::StructuredPage(page) => {
            serialize_snapshot_artifact(page, artifact_root)
        }
        SemanticBrowserResult::Screenshot(screenshot) => {
            let path = resolve_screenshot_artifact(
                artifact_root,
                &screenshot.artifact_id,
                &screenshot.sha256,
                screenshot.byte_size,
            )?;
            let mut value = serde_json::to_value(SemanticBrowserResult::Screenshot(screenshot))
                .map_err(|_| "Login Browser result serialization failed.".to_string())?;
            insert_artifact_path(&mut value, path)?;
            Ok(value)
        }
        SemanticBrowserResult::ConsoleLog(result) => {
            serialize_console_log_result(result, artifact_root)
        }
        SemanticBrowserResult::NetworkLog(result) => {
            serialize_network_log_result(result, artifact_root)
        }
        result => serde_json::to_value(result)
            .map_err(|_| "Login Browser result serialization failed.".to_string()),
    }
}

fn serialize_console_log_result(
    result: DiagnosticLogResult,
    artifact_root: &Path,
) -> Result<Value, String> {
    let root = trusted_session_log_root(artifact_root)?;
    let artifact = ConsoleLogStore::new(root)
        .map_err(|_| "Login Browser console log store is unavailable.".to_string())?
        .read_snapshot(&result.artifact_id)
        .map_err(|_| "Login Browser console log could not be revalidated.".to_string())?;
    revalidate_console_snapshot(&result, &artifact)?;
    serialize_diagnostic_log(
        SemanticBrowserResult::ConsoleLog(console_contract(&artifact)),
        artifact.path,
    )
}

fn serialize_network_log_result(
    result: DiagnosticLogResult,
    artifact_root: &Path,
) -> Result<Value, String> {
    let root = trusted_session_log_root(artifact_root)?;
    let artifact = NetworkLogStore::new(root)
        .map_err(|_| "Login Browser network log store is unavailable.".to_string())?
        .read_snapshot(&result.artifact_id)
        .map_err(|_| "Login Browser network log could not be revalidated.".to_string())?;
    revalidate_network_snapshot(&result, &artifact)?;
    serialize_diagnostic_log(
        SemanticBrowserResult::NetworkLog(network_contract(&artifact)),
        artifact.path,
    )
}

fn trusted_session_log_root(artifact_root: &Path) -> Result<PathBuf, String> {
    if artifact_root.file_name().and_then(|name| name.to_str()) != Some("artifacts") {
        return Err("Login Browser artifact store identity is invalid.".to_string());
    }
    let session_root = artifact_root
        .parent()
        .ok_or_else(|| "Login Browser session store identity is invalid.".to_string())?;
    for path in [session_root, artifact_root] {
        let metadata = fs::symlink_metadata(path)
            .map_err(|_| "Login Browser session store is unavailable.".to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("Login Browser session store identity changed.".to_string());
        }
    }
    let root = session_root.join("logs");
    if root.parent() != Some(session_root) {
        return Err("Login Browser log store escaped its session.".to_string());
    }
    Ok(root)
}

fn console_contract(artifact: &ConsoleLogArtifact) -> DiagnosticLogResult {
    DiagnosticLogResult {
        artifact_id: artifact.artifact_id.clone(),
        sha256: artifact.sha256.clone(),
        byte_size: artifact.byte_size,
        event_count: artifact.event_count,
        invalid_line_count: artifact.invalid_line_count,
        recent: artifact.recent.clone(),
        untrusted: artifact.untrusted,
    }
}

fn network_contract(artifact: &NetworkLogArtifact) -> DiagnosticLogResult {
    DiagnosticLogResult {
        artifact_id: artifact.artifact_id.clone(),
        sha256: artifact.sha256.clone(),
        byte_size: artifact.byte_size,
        event_count: artifact.event_count,
        invalid_line_count: artifact.invalid_line_count,
        recent: artifact.recent.clone(),
        untrusted: artifact.untrusted,
    }
}

fn revalidate_console_snapshot(
    expected: &DiagnosticLogResult,
    actual: &ConsoleLogArtifact,
) -> Result<(), String> {
    revalidate_diagnostic_contract(
        expected,
        &actual.artifact_id,
        &actual.sha256,
        actual.byte_size,
        actual.event_count,
        actual.invalid_line_count,
        &actual.recent,
        actual.untrusted,
    )
}

fn revalidate_network_snapshot(
    expected: &DiagnosticLogResult,
    actual: &NetworkLogArtifact,
) -> Result<(), String> {
    revalidate_diagnostic_contract(
        expected,
        &actual.artifact_id,
        &actual.sha256,
        actual.byte_size,
        actual.event_count,
        actual.invalid_line_count,
        &actual.recent,
        actual.untrusted,
    )
}

#[allow(clippy::too_many_arguments)]
fn revalidate_diagnostic_contract(
    expected: &DiagnosticLogResult,
    artifact_id: &str,
    sha256: &str,
    byte_size: u64,
    event_count: usize,
    invalid_line_count: usize,
    recent: &[Value],
    untrusted: bool,
) -> Result<(), String> {
    if expected.artifact_id != artifact_id
        || expected.sha256 != sha256
        || expected.byte_size != byte_size
        || expected.event_count != event_count
        || expected.invalid_line_count != invalid_line_count
        || expected.recent != recent
        || expected.untrusted != untrusted
    {
        return Err("Login Browser diagnostic snapshot identity changed.".to_string());
    }
    Ok(())
}

fn serialize_diagnostic_log(result: SemanticBrowserResult, path: PathBuf) -> Result<Value, String> {
    let mut value = serde_json::to_value(result)
        .map_err(|_| "Login Browser diagnostic log serialization failed.".to_string())?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| "Login Browser diagnostic log result shape is invalid.".to_string())?;
    object.insert("supported".to_string(), Value::Bool(true));
    object.insert(
        "mime_type".to_string(),
        Value::String("application/x-ndjson".to_string()),
    );
    object.insert(
        "path".to_string(),
        Value::String(path.to_string_lossy().into_owned()),
    );
    Ok(value)
}

fn parse_command(request: &BrowserToolRequest) -> Result<SemanticBrowserCommand, String> {
    let command = match request.tool.as_str() {
        "navigate" => SemanticBrowserCommand::Navigate {
            url: required_string(&request.args, "url")?,
        },
        "get_url" => SemanticBrowserCommand::GetUrl,
        "snapshot" => SemanticBrowserCommand::ReadPage,
        "click" => SemanticBrowserCommand::Click {
            element_ref: required_string(&request.args, "elementRef")?,
        },
        "type" => SemanticBrowserCommand::Type {
            element_ref: required_string(&request.args, "elementRef")?,
            text: required_string_allow_empty(&request.args, "text")?,
            replace: request
                .args
                .get("replace")
                .and_then(Value::as_bool)
                .unwrap_or(true),
        },
        "screenshot" => SemanticBrowserCommand::Screenshot,
        "read_console_log" => SemanticBrowserCommand::ReadConsoleLog,
        "read_network_log" => SemanticBrowserCommand::ReadNetworkLog,
        "wait_for" => {
            let timeout_millis = request
                .args
                .get("timeoutMs")
                .or_else(|| request.args.get("timeout_millis"))
                .and_then(Value::as_u64)
                .unwrap_or(5_000);
            let condition =
                if let Some(element_ref) = request.args.get("elementRef").and_then(Value::as_str) {
                    SemanticWaitCondition::ElementPresent {
                        element_ref: element_ref.to_string(),
                    }
                } else if request.args.get("loadComplete").and_then(Value::as_bool) == Some(true) {
                    SemanticWaitCondition::LoadComplete
                } else {
                    SemanticWaitCondition::TextPresent {
                        text: required_string(&request.args, "text")?,
                    }
                };
            SemanticBrowserCommand::WaitFor {
                condition,
                timeout_millis,
            }
        }
        "evaluate" | "raw_cdp" => {
            return Err(
                "Login Browser does not expose arbitrary JavaScript or raw CDP.".to_string(),
            )
        }
        other => {
            return Err(format!(
                "Login Browser semantic backend does not support tool {other}."
            ))
        }
    };
    command
        .validate()
        .map_err(|error| format!("Invalid Login Browser command: {error}"))?;
    Ok(command)
}

fn required_string(value: &Value, name: &str) -> Result<String, String> {
    let value = required_string_allow_empty(value, name)?;
    if value.trim().is_empty() {
        return Err(format!("Missing Login Browser argument: {name}."));
    }
    Ok(value)
}

fn required_string_allow_empty(value: &Value, name: &str) -> Result<String, String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("Missing Login Browser argument: {name}."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::login::backend::{
        DiagnosticLogResult, ScreenshotResult, SemanticElement, StructuredPageResult,
    };
    use crate::browser::login::network::{
        project_network_event, NetworkEventInput, NetworkRedactionConfig, SafeNetworkEventKind,
    };
    use crate::browser::login::network_log::NetworkLogStore;
    use crate::browser::login::profile::TrustedWorkspaceIdentity;
    use crate::browser::login::provenance::ProvenanceLedger;
    use sha2::{Digest, Sha256};

    fn request(tool: &str, args: Value) -> BrowserToolRequest {
        BrowserToolRequest {
            request_id: "request-1".to_string(),
            tool: tool.to_string(),
            args,
        }
    }

    #[test]
    fn persisted_ledger_state_is_projected_into_capability_policy_context() {
        let temp = tempfile::tempdir().unwrap();
        let ledger = ProvenanceLedger::new(temp.path().join("provenance")).unwrap();
        let workspace =
            TrustedWorkspaceIdentity::from_trusted_store("workspace-provenance").unwrap();
        let key = ProvenanceKey::new_trusted(&workspace, "actor-provenance").unwrap();
        let current = "https://a.example/form";
        ledger
            .with_serialized_operation(&key, |operation| {
                assert_eq!(
                    command_data_provenance(&SemanticBrowserCommand::GetUrl, current, operation)?,
                    BrowserDataProvenance::UntrackedOrSameOrigin
                );
                assert_eq!(
                    command_data_provenance(
                        &SemanticBrowserCommand::Click {
                            element_ref: "el-submit".to_string(),
                        },
                        current,
                        operation,
                    )?,
                    BrowserDataProvenance::UntrackedOrSameOrigin
                );
                operation
                    .record_successful_page_read(&NormalizedOrigin::parse(current).unwrap())
                    .map_err(|_| provenance_unavailable())?;
                assert_eq!(
                    command_data_provenance(
                        &SemanticBrowserCommand::Navigate {
                            url: "https://b.example/next".to_string(),
                        },
                        current,
                        operation,
                    )?,
                    BrowserDataProvenance::CrossOrigin
                );
                operation
                    .record_successful_page_read(
                        &NormalizedOrigin::parse("https://b.example/next").unwrap(),
                    )
                    .map_err(|_| provenance_unavailable())?;
                assert_eq!(
                    command_data_provenance(
                        &SemanticBrowserCommand::Click {
                            element_ref: "el-submit".to_string(),
                        },
                        current,
                        operation,
                    )?,
                    BrowserDataProvenance::Mixed
                );
                Ok::<(), String>(())
            })
            .unwrap()
            .unwrap();
    }

    #[test]
    fn parser_accepts_only_closed_semantic_vocabulary_and_opaque_element_refs() {
        assert_eq!(
            parse_command(&request(
                "click",
                serde_json::json!({"elementRef":"el-2-opaque"}),
            ))
            .unwrap(),
            SemanticBrowserCommand::Click {
                element_ref: "el-2-opaque".to_string(),
            }
        );
        assert!(parse_command(&request(
            "evaluate",
            serde_json::json!({"script":"document.cookie"}),
        ))
        .is_err());
        assert!(parse_command(&request(
            "raw_cdp",
            serde_json::json!({"method":"Runtime.evaluate"}),
        ))
        .is_err());
        assert_eq!(
            parse_command(&request("read_console_log", serde_json::json!({}))).unwrap(),
            SemanticBrowserCommand::ReadConsoleLog
        );
        assert_eq!(
            parse_command(&request("read_network_log", serde_json::json!({}))).unwrap(),
            SemanticBrowserCommand::ReadNetworkLog
        );
    }

    #[test]
    fn screenshot_result_adds_only_a_revalidated_app_owned_artifact_path() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("artifacts");
        fs::create_dir(&root).unwrap();
        let bytes = b"\x89PNG\r\n\x1a\nfixture";
        let artifact_id = "shot-0123456789abcdef";
        let path = root.join(format!("{artifact_id}.png"));
        fs::write(&path, bytes).unwrap();
        let sha256 = hex::encode(Sha256::digest(bytes));
        let value = serialize_agent_result(
            SemanticBrowserResult::Screenshot(ScreenshotResult {
                artifact_id: artifact_id.to_string(),
                sha256: sha256.clone(),
                byte_size: bytes.len() as u64,
            }),
            &root,
        )
        .unwrap();
        let canonical_path = path.canonicalize().unwrap();
        assert_eq!(
            value.get("path").and_then(Value::as_str),
            Some(canonical_path.to_string_lossy().as_ref())
        );

        fs::write(&path, b"tampered").unwrap();
        assert!(
            resolve_screenshot_artifact(&root, artifact_id, &sha256, bytes.len() as u64).is_err()
        );
    }

    fn page_result(secret: &str) -> SemanticBrowserResult {
        SemanticBrowserResult::StructuredPage(StructuredPageResult {
            url: "https://user:password@example.test/private?token=query-secret&view=ok#otp"
                .to_string(),
            title: Some("Untrusted page title".to_string()),
            untrusted: true,
            text: secret.to_string(),
            elements: vec![SemanticElement {
                element_ref: "el-opaque-reference".to_string(),
                role: "button".to_string(),
                name: Some("Continue".to_string()),
                text: None,
            }],
        })
    }

    #[test]
    fn snapshot_result_returns_a_revalidated_artifact_contract_without_inline_page_content() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("artifacts");
        let secret = "raw-page-secret-that-must-not-be-inline";
        let value = serialize_agent_result(page_result(secret), &root).unwrap();
        let serialized = serde_json::to_string(&value).unwrap();

        assert_eq!(value["result"], "structured_page");
        assert_eq!(value["mime_type"], "application/json");
        assert!(value["artifact_id"]
            .as_str()
            .unwrap()
            .starts_with("snapshot-"));
        assert_eq!(value["sha256"].as_str().unwrap().len(), 64);
        assert!(value["byte_size"].as_u64().unwrap() > 0);
        assert_eq!(value["summary"]["untrusted"], true);
        assert_eq!(value["summary"]["element_count"], 1);
        assert_eq!(value["summary"]["text_char_count"], secret.chars().count());
        assert!(!serialized.contains(secret));
        assert!(!serialized.contains("el-opaque-reference"));
        assert!(!serialized.contains("password"));
        assert!(!serialized.contains("query-secret"));
        assert!(!serialized.contains("#otp"));

        let path = PathBuf::from(value["path"].as_str().unwrap());
        assert!(path.is_absolute());
        let bytes = fs::read(&path).unwrap();
        assert_eq!(bytes.len() as u64, value["byte_size"].as_u64().unwrap());
        assert_eq!(
            hex::encode(Sha256::digest(&bytes)),
            value["sha256"].as_str().unwrap()
        );
        let envelope: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(envelope["provenance"]["untrusted"], true);
        assert_eq!(envelope["page"]["untrusted"], true);
        assert_eq!(envelope["page"]["text"], secret);
        assert_eq!(
            envelope["page"]["elements"][0]["element_ref"],
            "el-opaque-reference"
        );

        let resolved = read_snapshot_artifact_contract(&root, &value).unwrap();
        assert_eq!(resolved, envelope);

        let mut wrong_summary = value.clone();
        wrong_summary["summary"]["element_count"] = serde_json::json!(2);
        assert!(read_snapshot_artifact_contract(&root, &wrong_summary).is_err());

        let mut wrong_path = value.clone();
        wrong_path["path"] = serde_json::json!(root.join("substitute.json"));
        assert!(read_snapshot_artifact_contract(&root, &wrong_path).is_err());

        let mut wrong_digest = value.clone();
        wrong_digest["sha256"] = serde_json::json!("0".repeat(64));
        assert!(read_snapshot_artifact_contract(&root, &wrong_digest).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn snapshot_artifact_resolution_rejects_symlink_and_identity_tampering() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("artifacts");
        let value = serialize_agent_result(page_result("private"), &root).unwrap();
        let artifact_id = value["artifact_id"].as_str().unwrap();
        let sha256 = value["sha256"].as_str().unwrap();
        let byte_size = value["byte_size"].as_u64().unwrap();
        let path = PathBuf::from(value["path"].as_str().unwrap());

        fs::write(&path, b"tampered").unwrap();
        assert!(resolve_snapshot_artifact(&root, artifact_id, sha256, byte_size).is_err());

        fs::remove_file(&path).unwrap();
        let outside = temp.path().join("outside.json");
        fs::write(&outside, b"outside").unwrap();
        std::os::unix::fs::symlink(&outside, &path).unwrap();
        assert!(resolve_snapshot_artifact(&root, artifact_id, sha256, byte_size).is_err());
        assert!(resolve_snapshot_artifact(&root, "../outside", sha256, byte_size).is_err());
    }

    #[test]
    fn diagnostic_log_result_revalidates_the_exact_immutable_snapshot_contract() {
        let temp = tempfile::tempdir().unwrap();
        let session_root = temp.path().join("session");
        let artifact_root = session_root.join("artifacts");
        fs::create_dir_all(&artifact_root).unwrap();
        let log_root = session_root.join("logs");
        let store = NetworkLogStore::new(log_root.clone()).unwrap();
        let event = project_network_event(
            NetworkEventInput {
                kind: SafeNetworkEventKind::Request,
                request_id: "request-1",
                method: Some("GET"),
                url: "https://example.test/path?token=secret",
                status: None,
                mime_type: None,
                resource_type: Some("Document"),
                headers: &[],
                duration_ms: None,
                encoded_bytes: None,
                failure_code: None,
            },
            &NetworkRedactionConfig::new_trusted(["secret"]),
        );
        store.append("session-1", &event).unwrap();
        let artifact = store.read_artifact("network-session-1").unwrap();
        let result = DiagnosticLogResult {
            artifact_id: artifact.artifact_id.clone(),
            sha256: artifact.sha256,
            byte_size: artifact.byte_size,
            event_count: artifact.event_count,
            invalid_line_count: artifact.invalid_line_count,
            recent: artifact.recent,
            untrusted: artifact.untrusted,
        };

        store.append("session-1", &event).unwrap();

        let value = serialize_agent_result(
            SemanticBrowserResult::NetworkLog(result.clone()),
            &artifact_root,
        )
        .unwrap();
        assert_eq!(value["result"], "network_log");
        assert_eq!(value["supported"], true);
        assert_eq!(value["mime_type"], "application/x-ndjson");
        assert_eq!(
            PathBuf::from(value["path"].as_str().unwrap()),
            artifact.path
        );
        assert_eq!(value["artifact_id"], result.artifact_id);
        assert_eq!(value["sha256"], result.sha256);
        assert_eq!(value["byte_size"], result.byte_size);
        assert_eq!(value["sha256"].as_str().unwrap().len(), 64);
        assert_eq!(value["recent"].as_array().unwrap().len(), 1);

        let mut wrong_hash = result.clone();
        wrong_hash.sha256 = "f".repeat(64);
        assert!(serialize_agent_result(
            SemanticBrowserResult::NetworkLog(wrong_hash),
            &artifact_root,
        )
        .is_err());

        fs::write(&artifact.path, b"{\"objectId\":\"raw-handle\"}\n").unwrap();
        assert!(
            serialize_agent_result(SemanticBrowserResult::NetworkLog(result), &artifact_root,)
                .is_err()
        );
    }
}
