use super::cef::surface::{
    macos_child_bounds, profile_cache_path, validate_windows_native_window_observation,
    windows_child_bounds, LogicalViewport, NativeChildBounds, WindowsNativeWindowObservation,
};
use std::path::Path;

#[test]
fn persistent_cef_profiles_are_direct_children_of_the_runtime_root() {
    let root = Path::new("/private/tmp/ccem-mode2-root");
    let cache = profile_cache_path(root, "profile-0123456789abcdef0123456789abcdef")
        .expect("valid opaque profile id");

    assert_eq!(
        cache,
        root.join("Profile-profile-0123456789abcdef0123456789abcdef")
    );
    assert_eq!(cache.parent(), Some(root));

    assert!(profile_cache_path(root, "../escape").is_err());
    assert!(profile_cache_path(
        Path::new("relative"),
        "profile-0123456789abcdef0123456789abcdef"
    )
    .is_err());
}

#[test]
fn browser_panel_top_left_coordinates_convert_to_outward_rounded_nsview_bounds() {
    let bounds = macos_child_bounds(
        LogicalViewport {
            x: 319.4,
            y: 81.2,
            width: 580.2,
            height: 618.3,
        },
        700.0,
    )
    .expect("valid BrowserPanel viewport");

    assert_eq!(
        bounds,
        NativeChildBounds {
            x: 319,
            y: 0,
            width: 581,
            height: 619,
        }
    );
}

#[test]
fn native_viewport_rejects_non_finite_empty_and_out_of_parent_geometry() {
    let valid = LogicalViewport {
        x: 10.0,
        y: 20.0,
        width: 400.0,
        height: 300.0,
    };
    assert!(macos_child_bounds(valid, 700.0).is_ok());
    assert!(macos_child_bounds(
        LogicalViewport {
            width: 0.0,
            ..valid
        },
        700.0
    )
    .is_err());
    assert!(macos_child_bounds(
        LogicalViewport {
            x: f64::NAN,
            ..valid
        },
        700.0
    )
    .is_err());
    assert!(macos_child_bounds(valid, f64::INFINITY).is_err());
    assert!(macos_child_bounds(
        LogicalViewport {
            y: 500.0,
            height: 300.0,
            ..valid
        },
        700.0,
    )
    .is_err());
}

#[test]
fn browser_panel_coordinates_scale_to_outward_rounded_windows_client_bounds() {
    let bounds = windows_child_bounds(
        LogicalViewport {
            x: 100.25,
            y: 50.5,
            width: 400.1,
            height: 300.2,
        },
        1.5,
        1200,
        800,
    )
    .expect("valid fractional-DPI BrowserPanel viewport");

    assert_eq!(
        bounds,
        NativeChildBounds {
            x: 150,
            y: 75,
            width: 601,
            height: 452,
        }
    );
    assert!(windows_child_bounds(
        LogicalViewport {
            x: 700.0,
            y: 20.0,
            width: 200.0,
            height: 200.0,
        },
        2.0,
        1200,
        800,
    )
    .is_err());
}

#[test]
fn host_logical_browser_bounds_scale_across_supported_windows_monitor_dpi() {
    let viewport = LogicalViewport {
        x: 80.0,
        y: 40.0,
        width: 640.0,
        height: 400.0,
    };
    for (scale_factor, expected) in [
        (
            1.0,
            NativeChildBounds {
                x: 80,
                y: 40,
                width: 640,
                height: 400,
            },
        ),
        (
            1.5,
            NativeChildBounds {
                x: 120,
                y: 60,
                width: 960,
                height: 600,
            },
        ),
        (
            2.0,
            NativeChildBounds {
                x: 160,
                y: 80,
                width: 1280,
                height: 800,
            },
        ),
    ] {
        assert_eq!(
            windows_child_bounds(viewport, scale_factor, 2_000, 1_200)
                .expect("viewport fits the physical client area"),
            expected
        );
    }
}

#[test]
fn windows_native_window_evidence_binds_real_parent_rect_visibility_and_dpi() {
    let bounds = NativeChildBounds {
        x: 120,
        y: 100,
        width: 720,
        height: 480,
    };
    let observation = WindowsNativeWindowObservation {
        hwnd: "0x1234".to_string(),
        parent_hwnd: "0x4321".to_string(),
        owner_pid: std::process::id(),
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        parent_client_width: 1200,
        parent_client_height: 800,
        visible: true,
        dpi: 144,
    };
    validate_windows_native_window_observation(&observation, "0x4321", bounds, Some(true))
        .expect("live child evidence matches the BrowserPanel contract");

    let mut escaped = observation.clone();
    escaped.x = 700;
    assert!(validate_windows_native_window_observation(
        &escaped,
        "0x4321",
        NativeChildBounds { x: 700, ..bounds },
        Some(true),
    )
    .is_err());

    let mut stale = observation;
    stale.visible = false;
    assert!(
        validate_windows_native_window_observation(&stale, "0x4321", bounds, Some(true),).is_err()
    );
}

#[test]
fn windows_mode2_uses_real_cef_modules_and_production_ipc_not_unsupported_stubs() {
    let modules = include_str!("cef/mod.rs");
    let shared_surface = include_str!("cef/surface.rs");
    let surface = include_str!("cef/surface/windows.rs");
    let popup = include_str!("cef/surface/windows/popup.rs");
    let windows_util = include_str!("cef/surface/windows/util.rs");
    let windows_mutation = include_str!("cef/surface/windows/mutation.rs");
    let macos_mutation = include_str!("cef/surface/macos/mutation.rs");
    let focus_restore = include_str!("cef/surface/focus_restore.rs");
    let renderer_recovery = include_str!("cef/surface/renderer_recovery.rs");
    let recovery_state = include_str!("cef/surface/recovery_state.rs");
    let host_shortcut = include_str!("cef/surface/host_shortcut.rs");
    let macos_surface = include_str!("cef/surface/macos.rs");
    let macos_popup = include_str!("cef/surface/macos/popup.rs");
    let host = include_str!("cef/host/windows.rs");
    let bootstrap = include_str!("cef/bootstrap/windows.rs");
    let release_inventory = include_str!("../../../../scripts/verify-mode2-release-inventory.mjs");
    let ipc = include_str!("surface_commands/ipc.rs");

    assert!(modules.contains("#[cfg(windows)]\n#[path = \"bootstrap/windows.rs\"]"));
    assert!(modules.contains("#[cfg(windows)]\n#[path = \"host/windows.rs\"]"));
    assert!(surface.contains(".set_as_child(cef_hwnd(parent), &rect)"));
    assert!(surface.contains("host.add_dev_tools_message_observer"));
    assert!(surface.contains("destroy_cef_child(child)"));
    assert!(windows_util.contains("DestroyWindow(hwnd)"));
    assert!(surface.contains("surface.close_requested = true;"));
    assert!(surface.contains("surface.visible = false;"));
    let native_visibility = windows_mutation
        .find("set_window_visible(hwnd, parent, bounds, target_visible)")
        .expect("native visibility mutation must be verified");
    let shared_visibility = windows_mutation
        .find("surface.shared.update(|state| state.visible = visible)")
        .expect("shared visibility must be committed");
    assert!(native_visibility < shared_visibility);
    assert!(windows_mutation.contains("rollback CEF child visibility failed"));
    assert!(windows_util
        .contains("ShowWindow(hwnd, if visible { SW_SHOWNOACTIVATE } else { SW_HIDE });"));
    assert!(!windows_util.contains("if visible { SW_SHOW } else { SW_HIDE }"));
    assert!(windows_mutation.contains("GetFocus()"));
    assert!(windows_mutation.contains("IsChild(root, focused)"));
    assert!(windows_mutation.contains("SetFocus(Some(root))"));
    assert!(macos_mutation.contains("window.firstResponder()"));
    assert!(macos_mutation.contains("first_view.isDescendantOf(child)"));
    assert!(macos_mutation.contains("window.makeFirstResponder(Some(child))"));
    assert!(focus_restore.contains("peek_for_current_popup"));
    assert!(focus_restore.contains("commit_if_unchanged"));
    assert!(focus_restore.contains("current_popup == Some(popup_id)"));
    assert!(windows_mutation.contains("shared.try_restore_focus_intent(current_popup"));
    assert!(macos_mutation.contains("shared.try_restore_focus_intent(current_popup"));
    let windows_show = windows_mutation
        .split_once("pub(crate) fn set_visible(")
        .expect("Windows visibility mutation")
        .1
        .split_once("pub(crate) fn occlude(")
        .expect("Windows explicit occlusion")
        .0;
    let macos_show = macos_mutation
        .split_once("pub(crate) fn set_visible(")
        .expect("macOS visibility mutation")
        .1
        .split_once("type PopupFocusChild")
        .expect("macOS focus helpers")
        .0;
    assert!(!windows_show.contains("SetFocus("));
    assert!(!macos_show.contains("makeFirstResponder("));
    assert!(shared_surface.contains("self.clear_focus_restore_intent();"));
    assert!(recovery_state.contains("self.clear_focus_restore_intent();"));
    assert!(surface.contains("shared.clear_focus_restore_intent();"));
    assert!(macos_surface.contains("shared.clear_focus_restore_intent();"));
    assert!(popup.contains("self.shared.clear_focus_restore_intent();"));
    assert!(macos_popup.contains("self.shared.clear_focus_restore_intent();"));
    assert!(popup.contains("reserve_user_popup"));
    assert!(popup.contains("PopupRequestHandler"));
    assert!(popup.contains("!surface.close_requested"));
    assert!(macos_popup.contains("!surface.close_requested"));
    assert!(surface.contains("fn keyboard_handler(&self) -> Option<KeyboardHandler>"));
    assert!(popup.contains("fn keyboard_handler(&self) -> Option<KeyboardHandler>"));
    assert!(macos_surface.contains("fn keyboard_handler(&self) -> Option<KeyboardHandler>"));
    assert!(surface.contains("fn request_handler(&self) -> Option<RequestHandler>"));
    assert!(macos_surface.contains("fn request_handler(&self) -> Option<RequestHandler>"));
    assert!(renderer_recovery.contains("fn on_render_process_terminated("));
    assert!(renderer_recovery.contains("self.shared.record_renderer_termination();"));
    assert!(popup.contains("self.shared.record_popup_renderer_termination(self.popup_id);"));
    assert!(macos_popup.contains("self.shared.record_popup_renderer_termination(self.popup_id);"));
    assert!(macos_popup.contains("fn keyboard_handler(&self) -> Option<KeyboardHandler>"));
    assert!(host_shortcut.contains("fn on_pre_key_event("));
    assert!(host_shortcut.contains("browser_surface_host_shortcut"));
    assert!(host.contains("super::surface::windows::create_surface"));
    assert!(host.contains("std::panic::catch_unwind"));
    assert!(host.contains("CEF running main-thread operation disconnected"));
    assert!(bootstrap.contains("#[cfg(not(debug_assertions))]"));
    assert!(bootstrap.contains("require_release_sandbox_policy(sandbox_context.is_some())?;"));
    assert!(bootstrap.contains("if sandbox_context_present {\n        Ok(())\n    } else {"));
    assert!(bootstrap
        .contains("Windows Mode 2 release requires the official CEF bootstrap sandbox context"));
    assert!(
        bootstrap.contains("Some(context) => (0, CefString::default(), context.sandbox_info())")
    );
    assert!(release_inventory.contains("assertWindowsMode2ProductionSmokeAttested(attestation, {"));
    assert!(release_inventory.contains("same-executable CEF children, no --no-sandbox"));
    assert!(release_inventory.contains("final runtime directory LPAC ACL *S-1-15-2-2:(OI)(CI)(RX)"));
    assert!(ipc.contains("#[cfg(any(target_os = \"macos\", windows))]"));
    assert!(ipc.contains("#[cfg(not(any(target_os = \"macos\", windows)))]"));
}
