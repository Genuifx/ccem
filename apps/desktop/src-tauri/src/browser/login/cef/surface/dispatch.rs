use std::{
    sync::{
        atomic::{AtomicU8, Ordering},
        mpsc, Arc,
    },
    time::Duration,
};
use tauri::AppHandle;

const DISPATCH_PENDING: u8 = 0;
const DISPATCH_RUNNING: u8 = 1;
const DISPATCH_CANCELLED: u8 = 2;
const DISPATCH_COMPLETED: u8 = 3;

pub(super) fn run_cancellable_on_main<T, F>(
    app: &AppHandle,
    already_on_main: bool,
    timeout: Duration,
    label: &'static str,
    operation: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    if already_on_main {
        return operation();
    }

    run_cancellable_dispatch(timeout, label, operation, |task| {
        app.run_on_main_thread(task)
            .map_err(|error| error.to_string())
    })
}

fn run_cancellable_dispatch<T, F, S>(
    timeout: Duration,
    label: &'static str,
    operation: F,
    schedule: S,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
    S: FnOnce(Box<dyn FnOnce() + Send + 'static>) -> Result<(), String>,
{
    let (sender, receiver) = mpsc::sync_channel(1);
    let phase = Arc::new(AtomicU8::new(DISPATCH_PENDING));
    let phase_for_main = Arc::clone(&phase);
    schedule(Box::new(move || {
        if phase_for_main
            .compare_exchange(
                DISPATCH_PENDING,
                DISPATCH_RUNNING,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_err()
        {
            return;
        }
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation))
            .map_err(|_| format!("{label} panicked"))
            .and_then(|result| result);
        phase_for_main.store(DISPATCH_COMPLETED, Ordering::SeqCst);
        let _ = sender.send(result);
    }))
    .map_err(|error| format!("schedule {label}: {error}"))?;

    match receiver.recv_timeout(timeout) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(format!("{label} disconnected")),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            if phase
                .compare_exchange(
                    DISPATCH_PENDING,
                    DISPATCH_CANCELLED,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                )
                .is_ok()
            {
                return Err(format!("{label} timed out before execution"));
            }
            // Once a mutation starts, returning a timeout would let callers report failure while
            // the native operation can still take effect later.
            receiver
                .recv()
                .map_err(|_| format!("{label} disconnected while running"))?
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{atomic::AtomicBool, Barrier, Mutex},
        thread,
    };

    #[test]
    fn pending_dispatch_is_cancelled_before_a_late_scheduler_can_run_it() {
        let ran = Arc::new(AtomicBool::new(false));
        let ran_for_operation = Arc::clone(&ran);
        let scheduled = Arc::new(Mutex::new(None));
        let scheduled_for_dispatch = Arc::clone(&scheduled);
        let result = run_cancellable_dispatch(
            Duration::ZERO,
            "test dispatch",
            move || {
                ran_for_operation.store(true, Ordering::SeqCst);
                Ok(())
            },
            move |task| {
                *scheduled_for_dispatch.lock().expect("scheduled task lock") = Some(task);
                Ok(())
            },
        );

        assert_eq!(
            result.unwrap_err(),
            "test dispatch timed out before execution"
        );
        scheduled
            .lock()
            .expect("scheduled task lock")
            .take()
            .expect("queued task")();
        assert!(!ran.load(Ordering::SeqCst));
    }

    #[test]
    fn running_dispatch_waits_for_the_native_mutation_to_finish() {
        let started = Arc::new(Barrier::new(2));
        let started_for_operation = Arc::clone(&started);
        let started_for_scheduler = Arc::clone(&started);
        let (release_sender, release_receiver) = mpsc::sync_channel(1);
        let (result_sender, result_receiver) = mpsc::sync_channel(1);
        let caller = thread::spawn(move || {
            let result = run_cancellable_dispatch(
                Duration::from_millis(2),
                "test dispatch",
                move || {
                    started_for_operation.wait();
                    release_receiver.recv().expect("release running dispatch");
                    Ok("finished")
                },
                move |task| {
                    thread::spawn(move || task());
                    started_for_scheduler.wait();
                    Ok(())
                },
            );
            result_sender.send(result).expect("send dispatch result");
        });

        thread::sleep(Duration::from_millis(20));
        assert!(matches!(
            result_receiver.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        release_sender.send(()).expect("finish running dispatch");
        assert_eq!(
            result_receiver
                .recv_timeout(Duration::from_secs(1))
                .expect("dispatch result")
                .expect("running dispatch succeeds"),
            "finished"
        );
        caller.join().expect("caller thread");
    }

    #[test]
    fn dispatch_panic_is_reported_without_disconnect_ambiguity() {
        let result = run_cancellable_dispatch(
            Duration::from_secs(1),
            "test dispatch",
            || -> Result<(), String> { panic!("fixture panic") },
            |task| {
                task();
                Ok(())
            },
        );

        assert_eq!(result.unwrap_err(), "test dispatch panicked");
    }
}
