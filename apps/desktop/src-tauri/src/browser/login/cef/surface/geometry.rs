use super::super::super::profile::ProfileId;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy)]
pub(crate) struct LogicalViewport {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct NativeChildBounds {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: i32,
    pub(crate) height: i32,
}

/// A live Win32 observation of the CEF child HWND. The opaque handles are
/// strings because a 64-bit pointer is not necessarily an exact JSON number.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowsNativeWindowObservation {
    pub(crate) hwnd: String,
    pub(crate) parent_hwnd: String,
    pub(crate) owner_pid: u32,
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: i32,
    pub(crate) height: i32,
    pub(crate) parent_client_width: i32,
    pub(crate) parent_client_height: i32,
    pub(crate) visible: bool,
    pub(crate) dpi: u32,
}

pub(crate) fn validate_windows_native_window_observation(
    observation: &WindowsNativeWindowObservation,
    expected_parent_hwnd: &str,
    expected_bounds: NativeChildBounds,
    expected_visible: Option<bool>,
) -> Result<(), String> {
    let opaque_handle = |value: &str| {
        value
            .strip_prefix("0x")
            .is_some_and(|hex| !hex.is_empty() && hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
    };
    if !opaque_handle(&observation.hwnd) || !opaque_handle(&observation.parent_hwnd) {
        return Err("CEF native HWND observation contains an invalid opaque handle".to_string());
    }
    if observation.hwnd == observation.parent_hwnd
        || observation.parent_hwnd != expected_parent_hwnd
        || observation.owner_pid != std::process::id()
    {
        return Err("CEF child HWND identity is not bound to the CCEM parent process".to_string());
    }
    if observation.x != expected_bounds.x
        || observation.y != expected_bounds.y
        || observation.width != expected_bounds.width
        || observation.height != expected_bounds.height
    {
        return Err(
            "CEF child HWND client rectangle does not match BrowserPanel bounds".to_string(),
        );
    }
    if observation.parent_client_width <= 0
        || observation.parent_client_height <= 0
        || observation.x < 0
        || observation.y < 0
        || observation.width <= 0
        || observation.height <= 0
        || observation.x.saturating_add(observation.width) > observation.parent_client_width
        || observation.y.saturating_add(observation.height) > observation.parent_client_height
    {
        return Err("CEF child HWND rectangle escaped the CCEM parent client area".to_string());
    }
    if expected_visible.is_some_and(|expected| observation.visible != expected) {
        return Err(
            "CEF child HWND actual visibility does not match requested visibility".to_string(),
        );
    }
    if !(96..=960).contains(&observation.dpi) {
        return Err("CEF child HWND reported an invalid effective DPI".to_string());
    }
    Ok(())
}

/// CEF requires every persistent RequestContext cache to be an immediate child of the process
/// root cache path. Keeping the opaque profile id in the final component also prevents a page or
/// Agent payload from selecting an arbitrary filesystem path.
pub(crate) fn profile_cache_path(root: &Path, profile_id: &str) -> Result<PathBuf, String> {
    if !root.is_absolute() {
        return Err("CEF profile root must be absolute".to_string());
    }
    let profile_id = ProfileId::parse(profile_id).map_err(|error| error.to_string())?;
    let path = root.join(format!("Profile-{}", profile_id.as_str()));
    if path.parent() != Some(root) {
        return Err("CEF profile cache must be a direct child of its root".to_string());
    }
    Ok(path)
}

const NATIVE_EDGE_ROUNDOFF: f64 = 0.001;

// WebView zoom uses floating-point layout coordinates. A flush edge can arrive as
// 700.0000076 instead of 700; ceil would turn that noise into a whole extra pixel.
// Preserve actual fractional edges, snapping only within 1/1000 of a native unit.
fn snap_native_edge(value: f64) -> f64 {
    let rounded = value.round();
    if (value - rounded).abs() <= NATIVE_EDGE_ROUNDOFF {
        rounded
    } else {
        value
    }
}

/// Validate arithmetic before clipping: malformed/extreme requests must not become valid
/// merely because their intersection with the window is small.
fn clipped_child_bounds(
    viewport: LogicalViewport,
    scale_factor: f64,
    parent_width: f64,
    parent_height: f64,
) -> Result<NativeChildBounds, String> {
    let values = [
        viewport.x,
        viewport.y,
        viewport.width,
        viewport.height,
        scale_factor,
        parent_width,
        parent_height,
    ];
    if !values.into_iter().all(f64::is_finite) {
        return Err("CEF viewport geometry must be finite".to_string());
    }
    if viewport.x < 0.0
        || viewport.y < 0.0
        || viewport.width <= 0.0
        || viewport.height <= 0.0
        || scale_factor <= 0.0
        || parent_width < 0.0
        || parent_height < 0.0
    {
        return Err("CEF viewport geometry has invalid dimensions".to_string());
    }
    let edges = [
        viewport.x * scale_factor,
        viewport.y * scale_factor,
        (viewport.x + viewport.width) * scale_factor,
        (viewport.y + viewport.height) * scale_factor,
    ];
    if edges
        .into_iter()
        .chain([parent_width, parent_height])
        .any(|value| !value.is_finite() || value > i32::MAX as f64)
    {
        return Err("CEF viewport geometry exceeds native coordinate limits".to_string());
    }
    let [left, top, right, bottom] = edges.map(snap_native_edge);
    // The native parent can shrink after the frontend measures, even with a fresh
    // IPC request. Intersect on the main thread with its current client bounds.
    let left = left.floor();
    let top = top.floor();
    let right = right.ceil().min(parent_width.floor());
    let bottom = bottom.ceil().min(parent_height.floor());
    if right <= left || bottom <= top {
        return Err(
            "CEF_VIEWPORT_NOT_READY: no visible area in the current parent window".to_string(),
        );
    }
    Ok(NativeChildBounds {
        x: left as i32,
        y: top as i32,
        width: (right - left) as i32,
        height: (bottom - top) as i32,
    })
}

/// AppKit child views use a bottom-left origin. Both parent dimensions are read
/// on the main thread; only the part still inside the window may be displayed.
pub(crate) fn macos_child_bounds(
    viewport: LogicalViewport,
    parent_width: f64,
    parent_height: f64,
) -> Result<NativeChildBounds, String> {
    let mut bounds = clipped_child_bounds(viewport, 1.0, parent_width, parent_height)?;
    bounds.y = parent_height.floor() as i32 - bounds.y - bounds.height;
    Ok(bounds)
}

/// HWND client coordinates use a top-left origin and physical pixels. Apply only
/// monitor DPI here: the frontend already applied app zoom to its logical rect.
pub(crate) fn windows_child_bounds(
    viewport: LogicalViewport,
    scale_factor: f64,
    parent_width: i32,
    parent_height: i32,
) -> Result<NativeChildBounds, String> {
    clipped_child_bounds(
        viewport,
        scale_factor,
        f64::from(parent_width),
        f64::from(parent_height),
    )
}
