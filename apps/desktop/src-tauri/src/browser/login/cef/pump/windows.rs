// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::sync::Weak;

use windows::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM},
        System::LibraryLoader::GetModuleHandleW,
        UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, GetWindowLongPtrW, KillTimer,
            PostMessageW, RegisterClassExW, SetTimer, SetWindowLongPtrW, GWLP_USERDATA,
            HWND_MESSAGE, WINDOW_EX_STYLE, WM_TIMER, WM_USER, WNDCLASSEXW, WS_OVERLAPPEDWINDOW,
        },
    },
};

use super::{timer_registration_succeeded, PumpState};

const WINDOW_CLASS: PCWSTR = w!("CcemCefExternalMessagePump");
const WM_HAVE_WORK: u32 = WM_USER + 1;
const TIMER_ID: usize = 1;

pub(super) struct PlatformPump {
    hwnd: HWND,
    timer_pending: bool,
}

unsafe impl Send for PlatformPump {}

impl PlatformPump {
    pub(super) fn new(state: Weak<PumpState>) -> Self {
        let hinstance: HINSTANCE = unsafe { GetModuleHandleW(None) }
            .map(|module| HINSTANCE(module.0))
            .unwrap_or_default();
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(wndproc),
            hInstance: hinstance,
            lpszClassName: WINDOW_CLASS,
            ..Default::default()
        };
        unsafe { RegisterClassExW(&class) };
        let hwnd = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                WINDOW_CLASS,
                PCWSTR::null(),
                WS_OVERLAPPEDWINDOW,
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                Some(hinstance),
                None,
            )
        }
        .expect("create the CCEM CEF message-pump window");
        let state = Box::into_raw(Box::new(state));
        unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, state as isize) };
        Self {
            hwnd,
            timer_pending: false,
        }
    }

    pub(super) fn post_schedule_work(&mut self, delay_ms: i64) {
        let _ = unsafe {
            PostMessageW(
                Some(self.hwnd),
                WM_HAVE_WORK,
                WPARAM(0),
                LPARAM(delay_ms as isize),
            )
        };
    }

    pub(super) fn set_timer(&mut self, delay_ms: i64) -> bool {
        let timer_id = unsafe { SetTimer(Some(self.hwnd), TIMER_ID, delay_ms as u32, None) };
        self.timer_pending = timer_registration_succeeded(timer_id);
        self.timer_pending
    }

    pub(super) fn kill_timer(&mut self) {
        if self.timer_pending {
            let _ = unsafe { KillTimer(Some(self.hwnd), TIMER_ID) };
            self.timer_pending = false;
        }
    }

    pub(super) fn is_timer_pending(&self) -> bool {
        self.timer_pending
    }

    pub(super) fn pump_post_run_loop_slice(&self) {
        // The additional native run-loop slice is a macOS requirement. Keep the shared shutdown
        // state machine portable while the Windows message queue is owned by Tauri.
    }
}

impl Drop for PlatformPump {
    fn drop(&mut self) {
        unsafe {
            if self.timer_pending {
                let _ = KillTimer(Some(self.hwnd), TIMER_ID);
            }
            let state = SetWindowLongPtrW(self.hwnd, GWLP_USERDATA, 0) as *mut Weak<PumpState>;
            if !state.is_null() {
                drop(Box::from_raw(state));
            }
            let _ = DestroyWindow(self.hwnd);
        }
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_TIMER || msg == WM_HAVE_WORK {
        let state = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *const Weak<PumpState>;
        if !state.is_null() {
            if let Some(state) = unsafe { &*state }.upgrade() {
                if msg == WM_HAVE_WORK {
                    state.on_schedule_work(lparam.0 as i64);
                } else {
                    state.on_timer_timeout();
                }
            }
        }
    }
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}
