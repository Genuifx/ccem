use super::cef::surface::{
    macos_child_bounds, profile_cache_path, validate_windows_native_window_observation,
    windows_child_bounds, LogicalViewport, NativeChildBounds, WindowsNativeWindowObservation,
};
use std::path::Path;

#[test]
fn persistent_cef_profiles_are_direct_children_of_the_runtime_root() {
    #[cfg(windows)]
    let root = Path::new(r"C:\ccem-mode2-root");
    #[cfg(not(windows))]
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
fn macos_profiles_share_a_request_context_group_in_both_storage_modes() {
    let source = include_str!("cef/surface/macos.rs");
    let create_surface = source
        .split_once("pub(crate) fn create_surface(")
        .expect("macOS create_surface")
        .1
        .split_once("pub(crate) fn navigate(")
        .expect("macOS create_surface boundary")
        .0;

    // The explicit debug smoke keeps its profile in memory. Interactive development and release
    // use the same settings branch with persistent profile storage enabled.
    assert!(create_surface.contains(
        ".persistent_profile_storage\n        .then(|| prepare_profile_path(profile_root, &spec.profile_id))"
    ));
    assert!(create_surface.contains(
        "cache_path: profile_path\n            .as_ref()\n            .map(|path| CefString::from(path.to_string_lossy().as_ref()))\n            .unwrap_or_default()"
    ));
    assert!(create_surface
        .contains("persist_session_cookies: i32::from(spec.persistent_profile_storage)"));

    // Persistence controls only the backing store. Every mode must join the profile-keyed anchor
    // registry so Browser instances in one Profile share storage while retaining separate
    // RequestContext objects.
    assert!(!create_surface.contains("let context = if spec.persistent_profile_storage"));
    assert!(create_surface.contains(
        "let context = PROFILE_CONTEXTS.with(|contexts| -> Result<RequestContext, String>"
    ));
    assert!(create_surface.contains("contexts.get_mut(&spec.profile_id)"));
    assert!(create_surface.contains("request_context_cef_create_context_shared("));
    assert!(create_surface.contains("contexts.insert("));
    assert!(create_surface.contains("spec.profile_id.clone(),"));
    assert!(!create_surface.contains("isolated RequestContext"));
}

#[test]
fn macos_interactive_dev_uses_persistent_profiles_while_debug_smoke_opts_out() {
    let host = include_str!("cef/host.rs");
    let smoke = include_str!("cef/debug_smoke/runtime.rs");

    assert!(host.contains("profile_storage: CefProfileStorage::Persistent"));
    assert!(host.contains("let persistent_profile_storage = self.profile_storage.is_persistent();"));
    assert!(host.contains("persistent_profile_storage,"));
    assert!(smoke.contains("CefHostController::new_ephemeral("));
    assert!(!host.contains("persistent_profile_storage: !cfg!(debug_assertions)"));
}

#[test]
fn shared_request_context_contract_uses_storage_sharing_not_wrapper_identity() {
    for (platform, source, boundary) in [
        (
            "macOS",
            include_str!("cef/surface/macos.rs"),
            "pub(crate) fn navigate(",
        ),
        (
            "Windows",
            include_str!("cef/surface/windows.rs"),
            "pub(crate) fn navigate(",
        ),
    ] {
        let create_surface = source
            .split_once("pub(crate) fn create_surface(")
            .unwrap_or_else(|| panic!("{platform} create_surface"))
            .1
            .split_once(boundary)
            .unwrap_or_else(|| panic!("{platform} create_surface boundary"))
            .0;

        assert!(
            !create_surface.contains("sibling.is_same("),
            "{platform} must not reject a storage-sharing sibling merely because CEF reports \
             both wrappers reference the same initialized BrowserContext"
        );
        assert!(
            create_surface.contains("sibling.is_sharing_with(Some(&mut group.anchor)) != 1"),
            "{platform} must still enforce the shared-storage contract"
        );
    }
}

#[test]
fn embedded_cef_clients_use_native_upload_dialogs_and_user_chosen_download_paths() {
    let shared_surface = include_str!("cef/surface.rs");
    assert!(shared_surface.contains("struct SurfaceDownloadHandler"));
    assert!(shared_surface.contains("fn can_download("));
    assert!(shared_surface.contains("callback.cont(None, 1);"));

    for (platform, source) in [
        ("macOS", include_str!("cef/surface/macos.rs")),
        ("Windows", include_str!("cef/surface/windows.rs")),
    ] {
        let client = source
            .split_once("struct SurfaceClient {")
            .unwrap_or_else(|| panic!("{platform} SurfaceClient"))
            .1
            .split_once("wrap_request_context_handler!")
            .unwrap_or_else(|| panic!("{platform} SurfaceClient boundary"))
            .0;
        assert!(
            client.contains("fn download_handler(&self) -> Option<DownloadHandler>"),
            "{platform} must opt into CEF download handling"
        );
        assert!(
            client.contains("Some(SurfaceDownloadHandler::new())"),
            "{platform} downloads must reach the system save dialog"
        );
        assert!(
            !client.contains("fn dialog_handler("),
            "{platform} uploads must retain CEF's default system file chooser"
        );
    }

    for (platform, source) in [
        ("macOS popup", include_str!("cef/surface/macos/popup.rs")),
        (
            "Windows popup",
            include_str!("cef/surface/windows/popup.rs"),
        ),
    ] {
        let client = source
            .split_once("struct PopupSurfaceClient {")
            .unwrap_or_else(|| panic!("{platform} SurfaceClient"))
            .1;
        assert!(client.contains("Some(SurfaceDownloadHandler::new())"));
        assert!(!client.contains("fn dialog_handler("));
    }
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

#[test]
fn windows_cef_bindings_keep_private_util_imports_and_platform_callback_types() {
    let surface = include_str!("cef/surface/windows.rs");
    let host_shortcut = include_str!("cef/surface/host_shortcut.rs");
    let bootstrap = include_str!("cef/bootstrap/windows.rs");

    assert!(surface.contains("use util::{"));
    assert!(!surface.contains("pub(super) use util::{"));
    assert!(host_shortcut.contains("Option<&mut cef::sys::MSG>"));
    assert!(host_shortcut.contains("_os_event: cef_os_event_type!(),"));
    assert!(bootstrap.contains("let features = CefString::from(features.as_str());"));
    assert!(!bootstrap.contains("CefString::from(enable_network_service_sandbox(&current))"));
}

#[test]
fn mode2_navigation_actions_use_authoritative_cef_history_on_both_platforms() {
    for (platform, surface, host) in [
        (
            "macOS",
            include_str!("cef/surface/macos.rs"),
            include_str!("cef/host.rs"),
        ),
        (
            "Windows",
            include_str!("cef/surface/windows.rs"),
            include_str!("cef/host/windows.rs"),
        ),
    ] {
        assert!(
            surface.contains("fn on_loading_state_change("),
            "{platform} must project CEF history capabilities"
        );
        assert!(surface.contains("browser.main_frame()"));
        assert!(surface.contains("is_loading != 0"));
        assert!(surface.contains("update_loading_state("));
        assert!(surface.contains("browser.can_go_back()"));
        assert!(surface.contains("CefSurfaceNavigationAction::Back => browser.go_back()"));
        assert!(surface.contains("browser.can_go_forward()"));
        assert!(surface.contains("CefSurfaceNavigationAction::Forward => browser.go_forward()"));
        assert!(surface.contains("CefSurfaceNavigationAction::Reload => browser.reload()"));
        assert!(surface.contains("CefSurfaceNavigationAction::Stop => browser.stop_load()"));
        assert!(!surface.contains("reload_ignore_cache"));
        assert!(surface.contains("lifecycle != CefSurfaceLifecycle::Ready"));
        assert!(host.contains("navigation_action_surface"));
        assert!(host.contains("run_on_main(app"));
    }
}
