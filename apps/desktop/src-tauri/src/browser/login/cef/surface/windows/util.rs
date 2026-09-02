use crate::browser::login::cef::surface::{
    profile_cache_path, validate_windows_native_window_observation, NativeChildBounds,
    WindowsNativeWindowObservation,
};
use std::{
    fs,
    path::{Path, PathBuf},
};
use windows::Win32::{
    Foundation::{HWND, LPARAM, POINT, RECT, WPARAM},
    Graphics::Gdi::ScreenToClient,
    UI::HiDpi::GetDpiForWindow,
    UI::WindowsAndMessaging::{
        DestroyWindow, GetClientRect, GetParent, GetWindowRect, GetWindowThreadProcessId, IsWindow,
        IsWindowVisible, PostMessageW, SetWindowPos, ShowWindow, SWP_NOACTIVATE, SWP_NOOWNERZORDER,
        SWP_NOZORDER, SW_HIDE, SW_SHOWNOACTIVATE, WM_CLOSE,
    },
};

pub(super) fn cef_hwnd(hwnd: HWND) -> cef::sys::cef_window_handle_t {
    cef::sys::HWND(hwnd.0.cast())
}

pub(super) fn win32_hwnd(hwnd: cef::sys::cef_window_handle_t) -> HWND {
    HWND(hwnd.0.cast())
}

pub(super) fn prepare_profile_path(root: &Path, profile_id: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(root)
        .map_err(|error| format!("create CEF profile root {}: {error}", root.display()))?;
    let root = root
        .canonicalize()
        .map_err(|error| format!("resolve CEF profile root {}: {error}", root.display()))?;
    let path = profile_cache_path(&root, profile_id)?;
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(format!(
                "CEF profile path is not a private directory: {}",
                path.display()
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&path)
                .map_err(|error| format!("create CEF profile {}: {error}", path.display()))?;
        }
        Err(error) => return Err(format!("inspect CEF profile {}: {error}", path.display())),
    }
    let resolved = path
        .canonicalize()
        .map_err(|error| format!("resolve CEF profile {}: {error}", path.display()))?;
    if resolved.parent() != Some(root.as_path()) {
        return Err("CEF profile cache escaped its direct root child".to_string());
    }
    Ok(resolved)
}

fn opaque_hwnd(hwnd: HWND) -> String {
    format!("0x{:x}", hwnd.0 as usize)
}

pub(super) fn inspect_child_window(
    hwnd: HWND,
    expected_parent: HWND,
) -> Result<WindowsNativeWindowObservation, String> {
    if !unsafe { IsWindow(Some(expected_parent)).as_bool() } {
        return Err("CCEM parent HWND is unavailable".to_string());
    }
    if !unsafe { IsWindow(Some(hwnd)).as_bool() } {
        return Err("CEF child HWND is unavailable".to_string());
    }
    let parent = unsafe { GetParent(hwnd) }
        .map_err(|error| format!("resolve CEF child HWND parent: {error}"))?;
    if parent != expected_parent {
        return Err("CEF child HWND escaped the CCEM parent window".to_string());
    }

    let mut window_rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut window_rect) }
        .map_err(|error| format!("measure CEF child HWND: {error}"))?;
    let mut top_left = POINT {
        x: window_rect.left,
        y: window_rect.top,
    };
    let mut bottom_right = POINT {
        x: window_rect.right,
        y: window_rect.bottom,
    };
    if !unsafe { ScreenToClient(expected_parent, &mut top_left).as_bool() }
        || !unsafe { ScreenToClient(expected_parent, &mut bottom_right).as_bool() }
    {
        return Err("map CEF child HWND into the parent client area failed".to_string());
    }
    let mut parent_client = RECT::default();
    unsafe { GetClientRect(expected_parent, &mut parent_client) }
        .map_err(|error| format!("measure CCEM parent client HWND: {error}"))?;
    let mut owner_pid = 0_u32;
    if unsafe { GetWindowThreadProcessId(hwnd, Some(&mut owner_pid)) } == 0 {
        return Err("resolve CEF child HWND owner process failed".to_string());
    }

    Ok(WindowsNativeWindowObservation {
        hwnd: opaque_hwnd(hwnd),
        parent_hwnd: opaque_hwnd(parent),
        owner_pid,
        x: top_left.x,
        y: top_left.y,
        width: bottom_right.x - top_left.x,
        height: bottom_right.y - top_left.y,
        parent_client_width: parent_client.right - parent_client.left,
        parent_client_height: parent_client.bottom - parent_client.top,
        visible: unsafe { IsWindowVisible(hwnd).as_bool() },
        dpi: unsafe { GetDpiForWindow(hwnd) },
    })
}

pub(super) fn position_window(
    hwnd: HWND,
    parent: HWND,
    bounds: NativeChildBounds,
) -> Result<WindowsNativeWindowObservation, String> {
    inspect_child_window(hwnd, parent)?;
    unsafe {
        SetWindowPos(
            hwnd,
            None,
            bounds.x,
            bounds.y,
            bounds.width,
            bounds.height,
            SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOZORDER,
        )
    }
    .map_err(|error| format!("resize CEF child HWND: {error}"))?;
    let observation = inspect_child_window(hwnd, parent)?;
    validate_windows_native_window_observation(&observation, &opaque_hwnd(parent), bounds, None)?;
    Ok(observation)
}

pub(super) fn set_window_visible(
    hwnd: HWND,
    parent: HWND,
    bounds: NativeChildBounds,
    visible: bool,
) -> Result<WindowsNativeWindowObservation, String> {
    inspect_child_window(hwnd, parent)?;
    unsafe {
        let _ = ShowWindow(hwnd, if visible { SW_SHOWNOACTIVATE } else { SW_HIDE });
    }
    let observation = inspect_child_window(hwnd, parent)?;
    validate_windows_native_window_observation(
        &observation,
        &opaque_hwnd(parent),
        bounds,
        Some(visible),
    )?;
    Ok(observation)
}

pub(super) fn destroy_cef_child(hwnd: HWND) -> Result<(), String> {
    match unsafe { DestroyWindow(hwnd) } {
        Ok(()) => Ok(()),
        Err(destroy_error) => unsafe {
            // Returning false from CEF DoClose would send WM_CLOSE to CCEM's
            // top-level parent. Keep the fallback scoped to the CEF child.
            PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)).map_err(|post_error| {
                format!(
                    "destroy CEF child HWND: {destroy_error}; queue child close fallback: {post_error}"
                )
            })
        },
    }
}
