use super::super::super::backend::{BackendFailure, BackendFailureCode};
use super::super::super::control::OperationCancellation;
use super::super::guard::TrustedNavigationSurface;
use super::{MAX_AX_NODES, MAX_INTERNAL_ID_CHARS};
use rand::{rngs::OsRng, RngCore};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PrimaryTargetBootstrap {
    CreateOwnedPage,
    AttachCurrentPage,
}

pub(super) fn managed_auto_attach_filter() -> Value {
    // Chrome exposes internal targets such as `browser_ui` alongside page and worker targets.
    // Auto-attaching every target would pause an unsupported internal surface and then force a
    // terminal protocol failure. Keep the supported set closed and exclude everything else; an
    // unexpected attached type still remains terminal in the event handler.
    serde_json::json!([
        {"type": "page", "exclude": false},
        {"type": "iframe", "exclude": false},
        {"type": "worker", "exclude": false},
        {"type": "service_worker", "exclude": false},
        {"type": "shared_worker", "exclude": false},
        {"type": "worklet", "exclude": false},
        {"exclude": true}
    ])
}

#[derive(Debug, Clone, Copy)]
struct NodeBinding {
    backend_node_id: u64,
    generation: u64,
}

#[derive(Debug)]
pub(super) struct ElementRegistry {
    generation: u64,
    nodes: BTreeMap<String, NodeBinding>,
}

impl ElementRegistry {
    pub(super) fn new() -> Self {
        Self {
            generation: 1,
            nodes: BTreeMap::new(),
        }
    }

    pub(super) fn invalidate(&mut self) {
        self.generation = self.generation.saturating_add(1);
        self.nodes.clear();
    }

    pub(super) fn rebuild(&mut self) {
        self.invalidate();
    }

    pub(super) fn insert(&mut self, backend_node_id: u64) -> Result<String, BackendFailure> {
        if self.nodes.len() == MAX_AX_NODES {
            return Err(protocol_failure());
        }
        let mut random = [0_u8; 12];
        OsRng.fill_bytes(&mut random);
        let element_ref = format!("el-{:x}-{}", self.generation, hex::encode(random));
        self.nodes.insert(
            element_ref.clone(),
            NodeBinding {
                backend_node_id,
                generation: self.generation,
            },
        );
        Ok(element_ref)
    }

    pub(super) fn resolve(&self, element_ref: &str) -> Result<u64, BackendFailure> {
        let binding = self.nodes.get(element_ref).ok_or_else(invalid_reference)?;
        if binding.generation != self.generation {
            return Err(invalid_reference());
        }
        Ok(binding.backend_node_id)
    }
}

pub(super) fn bounded_string_field(value: &Value, name: &str) -> Option<String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= MAX_INTERNAL_ID_CHARS)
        .map(ToOwned::to_owned)
}

pub(super) fn bounded_content_field(value: &Value, name: &str, maximum: usize) -> Option<String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= maximum && !value.contains('\0'))
        .map(ToOwned::to_owned)
}

pub(super) fn string_from_map(object: &Map<String, Value>, name: &str) -> Option<String> {
    object
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 16_384)
        .map(ToOwned::to_owned)
}

pub(super) fn box_center(result: &Value) -> Option<(f64, f64)> {
    let model = result.get("model")?;
    let quad = model
        .get("content")
        .or_else(|| model.get("border"))?
        .as_array()?;
    if quad.len() != 8 {
        return None;
    }
    let values = quad.iter().map(Value::as_f64).collect::<Option<Vec<_>>>()?;
    if values.iter().any(|value| !value.is_finite()) {
        return None;
    }
    let x = (values[0] + values[2] + values[4] + values[6]) / 4.0;
    let y = (values[1] + values[3] + values[5] + values[7]) / 4.0;
    Some((x, y))
}

pub(super) fn classify_document_surface(
    event_session: Option<&str>,
    primary_session: Option<&str>,
    frame_id: Option<&str>,
    main_frame: Option<&str>,
) -> TrustedNavigationSurface {
    if event_session != primary_session {
        TrustedNavigationSurface::Popup
    } else if main_frame.is_some() && frame_id != main_frame {
        TrustedNavigationSurface::Iframe
    } else {
        TrustedNavigationSurface::Redirect
    }
}

pub(super) fn bounded(value: &str, maximum: usize) -> String {
    value
        .chars()
        .filter(|character| *character != '\0')
        .take(maximum)
        .collect()
}

pub(super) fn ensure_not_cancelled(
    cancellation: &OperationCancellation,
) -> Result<(), BackendFailure> {
    if cancellation.is_cancelled() {
        Err(BackendFailure::cancelled())
    } else {
        Ok(())
    }
}

pub(super) fn invalid_reference() -> BackendFailure {
    BackendFailure::new(
        BackendFailureCode::InvalidSemanticReference,
        "Browser semantic element reference is stale or invalid.",
    )
}

pub(super) fn navigation_failure() -> BackendFailure {
    BackendFailure::new(
        BackendFailureCode::NavigationFailed,
        "Browser navigation was denied or failed.",
    )
}

pub(super) fn runtime_failure() -> BackendFailure {
    BackendFailure::new(
        BackendFailureCode::RuntimeUnavailable,
        "Browser renderer or target is unavailable.",
    )
}

pub(super) fn protocol_failure() -> BackendFailure {
    BackendFailure::new(
        BackendFailureCode::ProtocolViolation,
        "Browser returned an invalid semantic CDP payload.",
    )
}

pub(super) fn target_setup_failure() -> BackendFailure {
    BackendFailure::new(
        BackendFailureCode::ProtocolViolation,
        "Browser target could not complete its paused security setup.",
    )
}
