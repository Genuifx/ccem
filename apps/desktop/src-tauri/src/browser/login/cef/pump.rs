// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! Native external-message-pump integration for the embedded CEF runtime.
//!
//! This follows cefclient's external pump semantics. Native timers keep CEF
//! responsive even while AppKit or Win32 is running a nested modal loop.

use std::sync::{
    atomic::{AtomicBool, AtomicU8, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "macos")]
use macos::PlatformPump;
#[cfg(windows)]
use windows::PlatformPump;

pub(crate) const TIMER_DELAY_PLACEHOLDER: i64 = i32::MAX as i64;
const MAX_TIMER_DELAY_MS: i64 = 1000 / 30;
// CEF's own macOS external-pump sample has no public "queue is idle" signal. After the native
// application loop returns it advances the default run loop and CEF work ten times, allowing
// 50 ms between iterations, before CefShutdown. Keep that upstream shutdown contract explicit
// instead of guessing with a pre-exit wall-clock delay.
const POST_RUN_LOOP_DRAIN_ITERATIONS: usize = 10;
const POST_RUN_LOOP_SETTLE: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
enum PumpPhase {
    Running = 0,
    Draining = 1,
    Stopped = 2,
}

impl PumpPhase {
    fn from_raw(value: u8) -> Self {
        match value {
            0 => Self::Running,
            1 => Self::Draining,
            _ => Self::Stopped,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ScheduleAction {
    KeepTimer,
    RunNow,
    ReplaceTimer(i64),
}

pub(crate) fn schedule_action(delay_ms: i64, timer_pending: bool) -> ScheduleAction {
    if delay_ms == TIMER_DELAY_PLACEHOLDER && timer_pending {
        return ScheduleAction::KeepTimer;
    }
    if delay_ms <= 0 {
        return ScheduleAction::RunNow;
    }
    ScheduleAction::ReplaceTimer(delay_ms.min(MAX_TIMER_DELAY_MS))
}

pub(crate) fn timer_registration_succeeded(timer_id: usize) -> bool {
    timer_id != 0
}

#[derive(Clone)]
pub(crate) struct CefExternalPump {
    state: Arc<PumpState>,
}

impl CefExternalPump {
    pub(crate) fn new() -> Self {
        let state = Arc::new_cyclic(|weak| PumpState {
            phase: AtomicU8::new(PumpPhase::Running as u8),
            is_active: AtomicBool::new(false),
            reentrancy_detected: AtomicBool::new(false),
            platform: Mutex::new(PlatformPump::new(weak.clone())),
        });
        Self { state }
    }

    /// CEF may invoke this callback from any thread.
    pub(crate) fn schedule_message_pump_work(&self, delay_ms: i64) {
        self.state.schedule_message_pump_work(delay_ms);
    }

    /// Startup/shutdown tick. Must run on the CEF owner thread.
    pub(crate) fn do_message_loop_work(&self) {
        self.state.do_manual_work();
    }

    /// Stop native timer scheduling while still allowing the owner thread to
    /// manually drain close callbacks before cef_shutdown.
    pub(crate) fn begin_draining(&self) {
        self.state
            .phase
            .store(PumpPhase::Draining as u8, Ordering::SeqCst);
        if let Ok(mut platform) = self.state.platform.lock() {
            platform.kill_timer();
        }
    }

    pub(crate) fn stop(&self) {
        self.state
            .phase
            .store(PumpPhase::Stopped as u8, Ordering::SeqCst);
        if let Ok(mut platform) = self.state.platform.lock() {
            platform.kill_timer();
        }
    }

    /// Complete the bounded drain used by CEF's macOS external-pump sample after the native
    /// application loop has returned and before `cef_shutdown`.
    pub(crate) fn drain_after_app_loop(&self) -> Result<(), String> {
        if self.state.phase() != PumpPhase::Draining {
            return Err("CEF post-run-loop drain requires the draining phase".to_string());
        }

        for _ in 0..POST_RUN_LOOP_DRAIN_ITERATIONS {
            self.state
                .platform
                .lock()
                .map_err(|_| "CEF platform pump is unavailable during shutdown".to_string())?
                .pump_post_run_loop_slice();
            self.state.do_manual_work();
            std::thread::sleep(POST_RUN_LOOP_SETTLE);
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn phase_name(&self) -> &'static str {
        match self.state.phase() {
            PumpPhase::Running => "running",
            PumpPhase::Draining => "draining",
            PumpPhase::Stopped => "stopped",
        }
    }
}

struct PumpState {
    phase: AtomicU8,
    is_active: AtomicBool,
    reentrancy_detected: AtomicBool,
    platform: Mutex<PlatformPump>,
}

impl PumpState {
    fn phase(&self) -> PumpPhase {
        PumpPhase::from_raw(self.phase.load(Ordering::SeqCst))
    }

    fn schedule_message_pump_work(&self, delay_ms: i64) {
        if self.phase() != PumpPhase::Running {
            return;
        }
        if let Ok(mut platform) = self.platform.lock() {
            platform.post_schedule_work(delay_ms);
        }
    }

    fn on_schedule_work(&self, delay_ms: i64) {
        if self.phase() != PumpPhase::Running {
            return;
        }
        let action = self
            .platform
            .lock()
            .map(|platform| schedule_action(delay_ms, platform.is_timer_pending()))
            .unwrap_or(ScheduleAction::KeepTimer);

        if action == ScheduleAction::KeepTimer {
            return;
        }

        if let Ok(mut platform) = self.platform.lock() {
            platform.kill_timer();
        }

        match action {
            ScheduleAction::KeepTimer => {}
            ScheduleAction::RunNow => self.do_scheduled_work(),
            ScheduleAction::ReplaceTimer(delay_ms) => {
                let timer_started = self
                    .platform
                    .lock()
                    .map(|mut platform| platform.set_timer(delay_ms))
                    .unwrap_or(false);
                if !timer_started {
                    // A failed native timer is not future work. Run a bounded
                    // tick now so CEF can reschedule instead of stalling forever.
                    self.do_scheduled_work();
                }
            }
        }
    }

    fn on_timer_timeout(&self) {
        if let Ok(mut platform) = self.platform.lock() {
            platform.kill_timer();
        }
        if self.phase() == PumpPhase::Running {
            self.do_scheduled_work();
        }
    }

    fn do_manual_work(&self) {
        if self.phase() == PumpPhase::Stopped {
            return;
        }
        let reentrant = self.perform_message_loop_work();
        if self.phase() == PumpPhase::Running {
            self.finish_running_tick(reentrant);
        }
    }

    fn do_scheduled_work(&self) {
        if self.phase() != PumpPhase::Running {
            return;
        }
        let reentrant = self.perform_message_loop_work();
        self.finish_running_tick(reentrant);
    }

    fn finish_running_tick(&self, reentrant: bool) {
        if self.phase() != PumpPhase::Running {
            return;
        }
        if reentrant {
            self.schedule_message_pump_work(0);
            return;
        }

        let timer_pending = self
            .platform
            .lock()
            .map(|platform| platform.is_timer_pending())
            .unwrap_or(true);
        if !timer_pending {
            self.schedule_message_pump_work(TIMER_DELAY_PLACEHOLDER);
        }
    }

    fn perform_message_loop_work(&self) -> bool {
        if self.phase() == PumpPhase::Stopped {
            return false;
        }
        if self.is_active.swap(true, Ordering::SeqCst) {
            self.reentrancy_detected.store(true, Ordering::SeqCst);
            return false;
        }

        self.reentrancy_detected.store(false, Ordering::SeqCst);
        cef::do_message_loop_work();
        self.is_active.store(false, Ordering::SeqCst);
        self.reentrancy_detected.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_native_timer_is_never_reported_as_pending_work() {
        assert!(!timer_registration_succeeded(0));
        assert!(timer_registration_succeeded(1));
        assert_eq!(
            schedule_action(TIMER_DELAY_PLACEHOLDER, false),
            ScheduleAction::ReplaceTimer(MAX_TIMER_DELAY_MS),
        );
        assert_eq!(
            schedule_action(TIMER_DELAY_PLACEHOLDER, true),
            ScheduleAction::KeepTimer,
        );
    }
}
