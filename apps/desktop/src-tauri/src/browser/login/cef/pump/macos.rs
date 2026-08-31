// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::sync::Weak;
use std::{ffi::c_void, time::Duration};

use cef_objc2::{define_class, msg_send, rc::Retained, sel, AnyThread, DefinedClass};
use cef_objc2_app_kit::NSEventTrackingRunLoopMode;
use cef_objc2_foundation::{
    NSNumber, NSObject, NSObjectNSThreadPerformAdditions, NSObjectProtocol, NSRunLoop,
    NSRunLoopCommonModes, NSThread, NSTimer,
};

use super::PumpState;

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    static kCFRunLoopDefaultMode: *const c_void;
    fn CFRunLoopRunInMode(
        mode: *const c_void,
        seconds: f64,
        return_after_source_handled: u8,
    ) -> i32;
}

const POST_RUN_LOOP_SLICE: Duration = Duration::from_millis(1);

define_class! {
    #[unsafe(super(NSObject))]
    #[ivars = Weak<PumpState>]
    struct EventHandler;

    impl EventHandler {
        #[unsafe(method(scheduleWork:))]
        fn schedule_work(&self, delay_ms: &NSNumber) {
            if let Some(state) = self.ivars().upgrade() {
                state.on_schedule_work(delay_ms.as_i64());
            }
        }

        #[unsafe(method(timerTimeout:))]
        fn timer_timeout(&self, _: &NSTimer) {
            if let Some(state) = self.ivars().upgrade() {
                state.on_timer_timeout();
            }
        }
    }

    unsafe impl NSObjectProtocol for EventHandler {}
}

impl EventHandler {
    fn new(state: Weak<PumpState>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(state);
        unsafe { msg_send![super(this), init] }
    }
}

pub(super) struct PlatformPump {
    owner_thread: Retained<NSThread>,
    event_handler: Retained<EventHandler>,
    timer: Option<Retained<NSTimer>>,
}

// Native objects are only touched on the owner AppKit thread. Cross-thread
// scheduling is marshalled with performSelector:onThread:.
unsafe impl Send for PlatformPump {}

impl PlatformPump {
    pub(super) fn new(state: Weak<PumpState>) -> Self {
        Self {
            owner_thread: NSThread::currentThread(),
            event_handler: EventHandler::new(state),
            timer: None,
        }
    }

    pub(super) fn post_schedule_work(&mut self, delay_ms: i64) {
        let delay_ms = isize::try_from(delay_ms).unwrap_or(isize::MAX);
        let delay_ms = NSNumber::new_isize(delay_ms);
        unsafe {
            self.event_handler
                .performSelector_onThread_withObject_waitUntilDone(
                    sel!(scheduleWork:),
                    &self.owner_thread,
                    Some(&delay_ms),
                    false,
                );
        }
    }

    pub(super) fn set_timer(&mut self, delay_ms: i64) -> bool {
        debug_assert!(delay_ms > 0);
        debug_assert!(self.timer.is_none());
        let timer = unsafe {
            NSTimer::timerWithTimeInterval_target_selector_userInfo_repeats(
                delay_ms as f64 / 1000.0,
                &self.event_handler,
                sel!(timerTimeout:),
                None,
                false,
            )
        };
        let run_loop = NSRunLoop::currentRunLoop();
        unsafe {
            run_loop.addTimer_forMode(&timer, NSRunLoopCommonModes);
            run_loop.addTimer_forMode(&timer, NSEventTrackingRunLoopMode);
        }
        self.timer = Some(timer);
        true
    }

    pub(super) fn kill_timer(&mut self) {
        if let Some(timer) = self.timer.take() {
            timer.invalidate();
        }
    }

    pub(super) fn is_timer_pending(&self) -> bool {
        self.timer.is_some()
    }

    pub(super) fn pump_post_run_loop_slice(&self) {
        // Mirrors MainMessageLoopExternalPumpMac::Run after [NSApp run] returns. CEF explicitly
        // requires default-run-loop observers to advance between final message-pump iterations.
        unsafe {
            CFRunLoopRunInMode(kCFRunLoopDefaultMode, POST_RUN_LOOP_SLICE.as_secs_f64(), 1);
        }
    }
}
