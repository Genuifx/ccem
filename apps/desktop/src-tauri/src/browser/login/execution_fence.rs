use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Default)]
struct ActivePermits {
    owners: BTreeMap<u64, usize>,
    unsafe_effects: BTreeSet<u64>,
}

impl ActivePermits {
    fn increment_owner(&mut self, generation: u64) {
        *self.owners.entry(generation).or_default() += 1;
    }

    fn decrement_owner(&mut self, generation: u64) {
        let remove = self.owners.get_mut(&generation).is_some_and(|count| {
            *count = count.saturating_sub(1);
            *count == 0
        });
        if remove {
            self.owners.remove(&generation);
        }
    }

    fn has_retired(&self, retired_generation: u64) -> bool {
        self.owners.range(..=retired_generation).next().is_some()
    }

    fn has_unsafe_effect(&self, retired_generation: u64) -> bool {
        self.unsafe_effects
            .range(..=retired_generation)
            .next()
            .is_some()
    }
}

/// One epoch fence shared by Agent cancellation, the protocol owner, and the CDP write boundary.
///
/// Retirement and permit admission use the same mutex. Therefore either a permit happens before
/// retirement and revoke waits for it, or retirement happens first and the stale permit is denied.
#[derive(Debug)]
pub(super) struct ExecutionFence {
    generation: AtomicU64,
    active: Mutex<ActivePermits>,
    quiesced: Condvar,
}

impl ExecutionFence {
    pub(super) fn new() -> Self {
        Self {
            generation: AtomicU64::new(1),
            active: Mutex::new(ActivePermits::default()),
            quiesced: Condvar::new(),
        }
    }

    pub(super) fn capture_generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    pub(super) fn is_current(&self, generation: u64) -> bool {
        let active = self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.generation.load(Ordering::Acquire) == generation && active.unsafe_effects.is_empty()
    }

    pub(super) fn is_safe(&self) -> bool {
        self.active
            .lock()
            .map(|active| active.unsafe_effects.is_empty())
            .unwrap_or(false)
    }

    /// Close the current epoch before waking its cooperative waits.
    pub(super) fn retire_current(&self) -> u64 {
        let _active = self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.generation.fetch_add(1, Ordering::AcqRel)
    }

    /// Synchronous owner acknowledgement for the retired epoch. Newer epochs do not delay it.
    #[cfg(test)]
    pub(super) fn wait_for_retired(&self, retired_generation: u64) {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        while active.has_retired(retired_generation) {
            active = self
                .quiesced
                .wait(active)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }

    /// Wait for owner acknowledgement without allowing spurious wakeups to extend the total
    /// deadline. Retiring the epoch already blocks every later effect write; a timeout therefore
    /// lets the session layer force-stop the verified browser domain without weakening the fence.
    pub(super) fn wait_for_retired_timeout(
        &self,
        retired_generation: u64,
        maximum_wait: Duration,
    ) -> Result<(), FenceQuiescenceFailure> {
        let deadline = Instant::now()
            .checked_add(maximum_wait)
            .unwrap_or_else(Instant::now);
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        loop {
            if active.has_unsafe_effect(retired_generation) {
                return Err(FenceQuiescenceFailure::EffectSafetyUnconfirmed);
            }
            if !active.has_retired(retired_generation) {
                return Ok(());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(FenceQuiescenceFailure::TimedOut);
            }
            let (next, timed) = self
                .quiesced
                .wait_timeout(active, remaining)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            active = next;
            if timed.timed_out() && active.has_retired(retired_generation) {
                return Err(FenceQuiescenceFailure::TimedOut);
            }
        }
    }

    pub(super) fn enter_owner(
        self: &Arc<Self>,
        generation: u64,
    ) -> Result<OwnerExecutionPermit, FenceUnavailable> {
        let mut active = self.active.lock().map_err(|_| FenceUnavailable)?;
        if self.generation.load(Ordering::Acquire) != generation
            || !active.unsafe_effects.is_empty()
        {
            return Err(FenceUnavailable);
        }
        active.increment_owner(generation);
        Ok(OwnerExecutionPermit(Permit {
            fence: Arc::clone(self),
            generation,
        }))
    }

    pub(super) fn enter_effect(
        self: &Arc<Self>,
        generation: u64,
    ) -> Result<EffectWritePermit, FenceUnavailable> {
        let active = self.active.lock().map_err(|_| FenceUnavailable)?;
        if self.generation.load(Ordering::Acquire) != generation
            || !active.unsafe_effects.is_empty()
        {
            return Err(FenceUnavailable);
        }
        // The owner permit is the quiescence acknowledgement. This permit only makes effect
        // admission atomic with retirement; tracking it separately would deadlock a synchronous
        // cancellation raised from inside the protocol writer.
        Ok(EffectWritePermit)
    }

    fn release_owner(&self, generation: u64) {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        active.decrement_owner(generation);
        self.quiesced.notify_all();
    }

    pub(super) fn mark_effect_unsafe(&self, generation: u64) {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        active.unsafe_effects.insert(generation);
        self.quiesced.notify_all();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct FenceUnavailable;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum FenceQuiescenceFailure {
    TimedOut,
    EffectSafetyUnconfirmed,
}

#[derive(Debug)]
struct Permit {
    fence: Arc<ExecutionFence>,
    generation: u64,
}

impl Drop for Permit {
    fn drop(&mut self) {
        self.fence.release_owner(self.generation);
    }
}

#[derive(Debug)]
pub(super) struct OwnerExecutionPermit(Permit);

#[derive(Debug)]
pub(super) struct EffectWritePermit;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc, Barrier};
    use std::time::Duration;

    #[test]
    fn revoke_at_pre_write_barrier_prevents_the_old_epoch_write() {
        let fence = Arc::new(ExecutionFence::new());
        let generation = fence.capture_generation();
        let owner = fence.enter_owner(generation).expect("owner permit");
        let pre_write = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let effects = Arc::new(AtomicUsize::new(0));
        let (worker_done_tx, worker_done_rx) = mpsc::channel();

        let worker_fence = Arc::clone(&fence);
        let worker_pre_write = Arc::clone(&pre_write);
        let worker_release = Arc::clone(&release);
        let worker_effects = Arc::clone(&effects);
        std::thread::spawn(move || {
            let _owner = owner;
            worker_pre_write.wait();
            worker_release.wait();
            if let Ok(_write) = worker_fence.enter_effect(generation) {
                worker_effects.fetch_add(1, Ordering::AcqRel);
            }
            worker_done_tx.send(()).expect("worker done");
        });

        pre_write.wait();
        let (retired_tx, retired_rx) = mpsc::channel();
        let (quiesced_tx, quiesced_rx) = mpsc::channel();
        let revoker_fence = Arc::clone(&fence);
        std::thread::spawn(move || {
            let retired = revoker_fence.retire_current();
            retired_tx.send(()).expect("retired");
            revoker_fence.wait_for_retired(retired);
            quiesced_tx.send(()).expect("quiesced");
        });
        retired_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("epoch retired");
        assert!(quiesced_rx.try_recv().is_err(), "owner is still active");

        release.wait();
        worker_done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("worker stopped");
        quiesced_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("owner quiesced");
        assert_eq!(effects.load(Ordering::Acquire), 0);
    }

    #[test]
    fn queued_old_epoch_command_cannot_start_or_emit_an_effect() {
        let fence = Arc::new(ExecutionFence::new());
        let queued_generation = fence.capture_generation();
        let retired = fence.retire_current();
        fence.wait_for_retired(retired);

        assert!(fence.enter_owner(queued_generation).is_err());
        assert!(fence.enter_effect(queued_generation).is_err());
    }

    #[test]
    fn retired_owner_wait_has_a_total_deadline() {
        let fence = Arc::new(ExecutionFence::new());
        let generation = fence.capture_generation();
        let owner = fence.enter_owner(generation).expect("owner permit");
        let retired = fence.retire_current();
        let started = std::time::Instant::now();

        assert_eq!(
            fence.wait_for_retired_timeout(retired, Duration::from_millis(25)),
            Err(FenceQuiescenceFailure::TimedOut)
        );
        assert!(
            started.elapsed() < Duration::from_millis(250),
            "retired owner wait exceeded its total deadline: {:?}",
            started.elapsed()
        );

        drop(owner);
        assert_eq!(
            fence.wait_for_retired_timeout(retired, Duration::from_millis(25)),
            Ok(())
        );
    }

    #[test]
    fn retired_epoch_with_unconfirmed_effect_never_acknowledges_quiescence() {
        let fence = Arc::new(ExecutionFence::new());
        let generation = fence.capture_generation();
        let retired = fence.retire_current();

        fence.mark_effect_unsafe(generation);

        assert_eq!(
            fence.wait_for_retired_timeout(retired, Duration::from_millis(25)),
            Err(FenceQuiescenceFailure::EffectSafetyUnconfirmed)
        );
        assert!(fence.enter_effect(generation).is_err());
        assert!(!fence.is_current(fence.capture_generation()));
        assert!(!fence.is_safe());
    }
}
