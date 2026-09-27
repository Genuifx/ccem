use super::*;
use std::{collections::VecDeque, sync::Condvar};

#[derive(Clone, PartialEq, Eq, Hash)]
enum Target {
    Discovery,
    Connection(String),
}

struct Job {
    target: Target,
    generation: u64,
    connection: Option<ConnectionRecord>,
}

#[derive(Default)]
struct QueueState {
    generation: u64,
    current: HashMap<Target, u64>,
    jobs: VecDeque<Job>,
    worker_active: bool,
}

/// At most one verifier and one queued request per connection (plus discovery).
/// The lifecycle lock protects publication, never package inventory verification.
#[derive(Default)]
pub(super) struct StartupQueue {
    state: Mutex<QueueState>,
    idle: Condvar,
}

impl StartupQueue {
    fn enqueue(&self, connection: Option<ConnectionRecord>) -> bool {
        let target = connection
            .as_ref()
            .map(|c| Target::Connection(c.account_ref.clone()))
            .unwrap_or(Target::Discovery);
        let mut state = self.state.lock().unwrap();
        state.generation += 1;
        let generation = state.generation;
        state.jobs.retain(|job| job.target != target);
        state.current.insert(target.clone(), generation);
        state.jobs.push_back(Job {
            target,
            generation,
            connection,
        });
        let needs_worker = !state.worker_active;
        state.worker_active = true;
        needs_worker
    }

    fn next(&self) -> Option<Job> {
        let mut state = self.state.lock().unwrap();
        let job = state.jobs.pop_front();
        if job.is_none() {
            state.worker_active = false;
            self.idle.notify_all();
        }
        job
    }

    fn current(&self, job: &Job) -> bool {
        self.state.lock().unwrap().current.get(&job.target) == Some(&job.generation)
    }

    fn finish(&self, job: &Job) {
        let mut state = self.state.lock().unwrap();
        if state.current.get(&job.target) == Some(&job.generation) {
            state.current.remove(&job.target);
        }
    }

    pub(super) fn connection_pending(&self, account: &str) -> bool {
        self.state
            .lock()
            .unwrap()
            .current
            .contains_key(&Target::Connection(account.into()))
    }

    pub(super) fn discovery_pending(&self) -> bool {
        self.state
            .lock()
            .unwrap()
            .current
            .contains_key(&Target::Discovery)
    }

    pub(super) fn cancel_connection(&self, account: &str) {
        let target = Target::Connection(account.into());
        let mut state = self.state.lock().unwrap();
        state.current.remove(&target);
        state.jobs.retain(|job| job.target != target);
    }

    pub(super) fn cancel_all(&self) {
        let mut state = self.state.lock().unwrap();
        state.current.clear();
        state.jobs.clear();
    }

    pub(super) fn wake(&self) {
        // Synchronize with wait_idle's predicate to avoid a lost cancellation.
        let _state = self.state.lock().unwrap();
        self.idle.notify_all();
    }

    pub(super) fn wait_idle(&self, cancelled: impl Fn() -> bool) {
        let mut state = self.state.lock().unwrap();
        while state.worker_active && !cancelled() {
            state = self.idle.wait(state).unwrap();
        }
    }

    fn drain<T>(
        &self,
        lifecycle: &Mutex<()>,
        blocked: impl Fn() -> bool,
        verify: impl Fn() -> Result<T, String>,
        publish: impl Fn(&Job, Result<T, String>),
    ) {
        while let Some(job) = self.next() {
            if !self.current(&job) || blocked() {
                self.finish(&job);
                continue;
            }
            // This includes the complete signed manifest and file inventory
            // check. A stop/remove/update may invalidate this job meanwhile.
            let mut verified = Some(verify());
            {
                let _guard = lifecycle.lock().unwrap();
                if self.current(&job) && !blocked() {
                    publish(&job, verified.take().unwrap());
                }
                self.finish(&job);
            }
            // Release a stale runtime lease before reporting the worker idle,
            // so an update can then acquire its exclusive activation lease.
            drop(verified);
        }
    }
}

impl HermesBridgeManager {
    pub(super) fn start_discovery_locked(self: &Arc<Self>, app: &AppHandle) -> Result<(), String> {
        let old = self.discovery.lock().unwrap().take();
        drop(old);
        *self.last_error.lock().unwrap() = None;
        self.queue_start_locked(app, None);
        Ok(())
    }

    pub(super) fn start_connection_locked(
        self: &Arc<Self>,
        app: &AppHandle,
        account: &str,
    ) -> Result<(), String> {
        let connection = self.with_store(|s| s.connection(account))?;
        if !connection.enabled {
            return Err("connection_stopped".into());
        }
        self.stop_connection_locked(account);
        self.failures.lock().unwrap().remove(account);
        self.connection_errors.lock().unwrap().remove(account);
        self.queue_start_locked(app, Some(connection));
        Ok(())
    }

    fn queue_start_locked(self: &Arc<Self>, app: &AppHandle, connection: Option<ConnectionRecord>) {
        if !self.startup.enqueue(connection) {
            return;
        }
        let manager = self.clone();
        let app = app.clone();
        thread::spawn(move || {
            manager.startup.drain(
                &manager.lifecycle,
                || {
                    manager.shutdown.load(Ordering::Acquire)
                        || manager.install_requested.load(Ordering::Acquire)
                },
                || manager.installer.lease_runtime().map_err(|e| e.to_string()),
                |job, verified| manager.publish_start_locked(&app, job, verified),
            );
        });
    }

    fn publish_start_locked(
        &self,
        app: &AppHandle,
        job: &Job,
        verified: Result<HermesRuntimeLease, String>,
    ) {
        if let Some(expected) = &job.connection {
            if !self
                .with_store(|s| s.connection(&expected.account_ref))
                .is_ok_and(|current| {
                    current.enabled
                        && current.platform == expected.platform
                        && current.cipher == expected.cipher
                })
            {
                return;
            }
        }
        let result =
            verified.and_then(|lease| self.spawn_gateway(app, job.connection.as_ref(), lease));
        match (&job.target, result) {
            (Target::Discovery, Ok(gateway)) => {
                *self.discovery.lock().unwrap() = Some(gateway);
                *self.last_error.lock().unwrap() = None;
            }
            (Target::Discovery, Err(error)) => *self.last_error.lock().unwrap() = Some(error),
            (Target::Connection(account), Ok(gateway)) => {
                self.gateways
                    .lock()
                    .unwrap()
                    .insert(account.clone(), gateway);
                self.connection_errors.lock().unwrap().remove(account);
            }
            (Target::Connection(account), Err(error)) => {
                self.connection_errors
                    .lock()
                    .unwrap()
                    .insert(account.clone(), error);
            }
        }
    }
}

#[cfg(test)]
#[path = "startup_tests.rs"]
mod tests;
