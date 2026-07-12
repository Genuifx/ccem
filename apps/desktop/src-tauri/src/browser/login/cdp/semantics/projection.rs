use super::super::super::backend::{BackendFailure, SemanticElement};
use super::super::super::control::OperationCancellation;
use super::super::protocol::CdpMethod;
use super::super::transport::CdpClient;
use super::helpers::{bounded, protocol_failure};
use super::{SemanticEngine, MAX_AX_NODES, MAX_PAGE_TEXT_CHARS};
use serde_json::Value;
use std::time::Instant;

impl SemanticEngine {
    pub(super) fn ax_contains_text(
        &mut self,
        client: &mut CdpClient<'_>,
        needle: &str,
        cancellation: &OperationCancellation,
        deadline: Instant,
    ) -> Result<bool, BackendFailure> {
        let session = self.primary_session()?;
        let result = client.call(
            CdpMethod::AccessibilityGetFullAxTree,
            serde_json::json!({}),
            Some(&session),
            deadline,
            cancellation,
            self,
        )?;
        let found = result
            .get("nodes")
            .and_then(Value::as_array)
            .into_iter()
            .flat_map(|nodes| nodes.iter().take(MAX_AX_NODES))
            .flat_map(ax_text_values)
            .any(|value| value.contains(needle));
        Ok(found)
    }

    pub(super) fn project_ax_tree(
        &mut self,
        result: &Value,
    ) -> Result<(String, Vec<SemanticElement>), BackendFailure> {
        let nodes = result
            .get("nodes")
            .and_then(Value::as_array)
            .ok_or_else(protocol_failure)?;
        if nodes.len() > MAX_AX_NODES {
            return Err(protocol_failure());
        }
        let mut text = String::new();
        let mut elements = Vec::new();
        for node in nodes {
            if node.get("ignored").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let role = ax_value(node, "role").unwrap_or_else(|| "generic".to_string());
            let name = ax_value(node, "name");
            let value = ax_value(node, "value");
            for part in [name.as_deref(), value.as_deref()].into_iter().flatten() {
                append_bounded_text(&mut text, part, MAX_PAGE_TEXT_CHARS);
            }
            let Some(backend_node_id) = node.get("backendDOMNodeId").and_then(Value::as_u64) else {
                continue;
            };
            let element_ref = self.elements.insert(backend_node_id)?;
            elements.push(SemanticElement {
                element_ref,
                role: bounded(part_or_fallback(&role, "generic"), 128),
                name: name.map(|value| bounded(&value, 16_384)),
                text: value.map(|value| bounded(&value, 16_384)),
            });
        }
        Ok((text, elements))
    }
}

fn ax_value(node: &Value, name: &str) -> Option<String> {
    node.get(name)?
        .get("value")?
        .as_str()
        .map(|value| bounded(value, 16_384))
}

fn ax_text_values(node: &Value) -> impl Iterator<Item = &str> {
    ["name", "value", "description"]
        .into_iter()
        .filter_map(|name| node.get(name)?.get("value")?.as_str())
}

fn append_bounded_text(output: &mut String, value: &str, maximum: usize) {
    if output.chars().count() >= maximum {
        return;
    }
    if !output.is_empty() {
        output.push('\n');
    }
    let remaining = maximum.saturating_sub(output.chars().count());
    output.extend(value.chars().take(remaining));
}

fn part_or_fallback<'a>(value: &'a str, fallback: &'a str) -> &'a str {
    if value.trim().is_empty() {
        fallback
    } else {
        value
    }
}
