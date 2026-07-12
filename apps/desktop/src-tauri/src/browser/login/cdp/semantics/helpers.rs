use super::super::super::backend::{BackendFailure, BackendFailureCode};
use super::super::super::control::OperationCancellation;
use super::super::guard::TrustedNavigationSurface;
use super::MAX_INTERNAL_ID_CHARS;
use serde_json::{Map, Value};

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
