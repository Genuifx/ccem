//! Startup recovery runs on one worker, in the same order as the old setup
//! callback. The window/event loop stays available while recovery is pending.
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Condvar, Mutex,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StartupPhase {
    Preparing,
    CheckingSessions,
    RestoringSessions,
    StartingServices,
    Ready,
    Failed,
}

pub struct StartupState {
    phase: Mutex<StartupPhase>,
    finished: Condvar,
    cancelled: AtomicBool,
    exit_pending: AtomicBool,
}

impl Default for StartupState {
    fn default() -> Self {
        Self {
            phase: Mutex::new(StartupPhase::Preparing),
            finished: Condvar::new(),
            cancelled: AtomicBool::new(false),
            exit_pending: AtomicBool::new(false),
        }
    }
}

impl StartupState {
    pub fn phase(&self) -> StartupPhase {
        *self.phase.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn is_finished(&self) -> bool {
        matches!(self.phase(), StartupPhase::Ready | StartupPhase::Failed)
    }

    pub fn checkpoint(&self, phase: StartupPhase) -> Result<(), String> {
        if self.cancelled.load(Ordering::SeqCst) {
            return Err("Startup cancelled by app exit".into());
        }
        *self.phase.lock().unwrap_or_else(|e| e.into_inner()) = phase;
        Ok(())
    }

    fn finish(&self, phase: StartupPhase) {
        *self.phase.lock().unwrap_or_else(|e| e.into_inner()) = phase;
        self.finished.notify_all();
    }

    fn wait_until_finished(&self) {
        let guard = self.phase.lock().unwrap_or_else(|e| e.into_inner());
        drop(
            self.finished
                .wait_while(guard, |phase| {
                    !matches!(phase, StartupPhase::Ready | StartupPhase::Failed)
                })
                .unwrap_or_else(|e| e.into_inner()),
        );
    }
}

pub fn start(
    state: Arc<StartupState>,
    work: impl FnOnce(&StartupState) -> Result<(), String> + Send + 'static,
) {
    let worker_state = state.clone();
    let result = std::thread::Builder::new()
        .name("ccem-startup".into())
        .spawn(move || {
            let result =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| work(&worker_state)));
            let phase = match result {
                Ok(Ok(())) => StartupPhase::Ready,
                Ok(Err(error)) => {
                    eprintln!("CCEM startup failed: {error}");
                    StartupPhase::Failed
                }
                Err(_) => {
                    eprintln!("CCEM startup worker panicked");
                    StartupPhase::Failed
                }
            };
            worker_state.finish(phase);
        });
    if let Err(error) = result {
        eprintln!("Failed to start CCEM startup worker: {error}");
        state.finish(StartupPhase::Failed);
    }
}

// Prevent an early window close from racing recovery against normal app
// shutdown, or starting background services after the app has already exited.
pub fn finish_before_exit(state: Arc<StartupState>, app: tauri::AppHandle, code: i32) {
    if state.exit_pending.swap(true, Ordering::SeqCst) {
        return;
    }
    state.cancelled.store(true, Ordering::SeqCst);
    let retry_state = state.clone();
    if let Err(error) = std::thread::Builder::new()
        .name("ccem-startup-exit".into())
        .spawn(move || {
            state.wait_until_finished();
            app.exit(code);
        })
    {
        retry_state.exit_pending.store(false, Ordering::SeqCst);
        eprintln!("Failed to defer exit until startup finishes: {error}");
    }
}

#[tauri::command]
pub fn get_startup_status(state: tauri::State<'_, Arc<StartupState>>) -> StartupPhase {
    state.phase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, time::Duration};

    #[test]
    fn slow_recovery_does_not_block_caller_or_status_reads() {
        let state = Arc::new(StartupState::default());
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let caller = std::thread::current().id();
        start(state.clone(), move |state| {
            assert_ne!(caller, std::thread::current().id());
            state.checkpoint(StartupPhase::RestoringSessions)?;
            entered_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
            state.checkpoint(StartupPhase::StartingServices)?;
            Ok(())
        });
        entered_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(state.phase(), StartupPhase::RestoringSessions);
        assert!(!state.is_finished());
        release_tx.send(()).unwrap();
        state.wait_until_finished();
        assert_eq!(state.phase(), StartupPhase::Ready);
    }

    #[test]
    fn failure_and_panic_always_finish_startup() {
        for panic in [false, true] {
            let state = Arc::new(StartupState::default());
            start(state.clone(), move |_| {
                if panic {
                    panic!("fixture panic");
                }
                Err("fixture failure".into())
            });
            state.wait_until_finished();
            assert_eq!(state.phase(), StartupPhase::Failed);
        }
    }

    #[test]
    fn exit_cancellation_prevents_later_startup_stages() {
        let state = Arc::new(StartupState::default());
        state.cancelled.store(true, Ordering::SeqCst);
        start(state.clone(), |state| {
            state.checkpoint(StartupPhase::StartingServices)?;
            panic!("services must not start after cancellation");
        });
        state.wait_until_finished();
        assert_eq!(state.phase(), StartupPhase::Failed);
    }
}
