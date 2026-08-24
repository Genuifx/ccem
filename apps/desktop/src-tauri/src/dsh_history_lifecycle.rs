//! Production lifecycle seam for subprocess cleanup.
//!
//! Provides the `ChildLifecycle` trait and a single generic `kill_and_reap_with_deadline`
//! implementation used by ALL production callsites and directly by tests. No algorithm
//! duplication — tests call the exact same function with mock implementations.

use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------
// Trait: the minimal lifecycle surface needed for exact-child cleanup
// ---------------------------------------------------------------------------

/// Minimal lifecycle operations for exact-child cleanup.
/// Production implements this for `std::process::Child`; tests use mocks.
pub(crate) trait ChildLifecycle {
    /// Non-blocking reap check. Returns Ok(true) if already exited/reaped.
    fn try_reap(&mut self) -> std::io::Result<bool>;
    /// Send SIGKILL (unix) / TerminateProcess (windows) to the exact child.
    fn kill_exact(&mut self) -> std::io::Result<()>;
    /// The child's PID for error context.
    fn pid(&self) -> u32;
}

// ---------------------------------------------------------------------------
// std::process::Child implementation
// ---------------------------------------------------------------------------

impl ChildLifecycle for std::process::Child {
    fn try_reap(&mut self) -> std::io::Result<bool> {
        self.try_wait().map(|opt| opt.is_some())
    }
    fn kill_exact(&mut self) -> std::io::Result<()> {
        self.kill()
    }
    fn pid(&self) -> u32 {
        self.id()
    }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// Default deadline for bounded reap after kill in production.
pub(crate) const KILL_REAP_DEADLINE: Duration = Duration::from_secs(5);

/// Poll interval when waiting for a known-killed child to become reaped.
const KILL_REAP_POLL_INTERVAL: Duration = Duration::from_millis(5);

// ---------------------------------------------------------------------------
// Core algorithm — SINGLE implementation used by production and tests
// ---------------------------------------------------------------------------

/// Kill and reap a child with bounded waiting. This is the ONE algorithm:
///
/// 1. First try_reap: if already exited → Ok.
/// 2. kill_exact: send kill signal.
/// 3. Kill fails → immediate second try_reap:
///    - true: race proven, Ok.
///    - false: still live, return kill error (no blocking).
///    - Err: combine both errors.
/// 4. Kill succeeds → bounded polling try_reap until reaped or deadline.
///    - Reaped: Ok.
///    - Deadline exceeded: TimedOut error.
///    - try_reap error during poll: propagated.
///
/// No unbounded wait(). No process-group kill. No signal guessing.
pub(crate) fn kill_and_reap_with_deadline<C: ChildLifecycle>(
    child: &mut C,
    deadline: Duration,
    poll_interval: Duration,
) -> Result<(), std::io::Error> {
    // 1. Check if already exited
    match child.try_reap() {
        Ok(true) => return Ok(()),
        Ok(false) => {}
        Err(e) => return Err(e),
    }
    // 2. Send kill signal
    match child.kill_exact() {
        Ok(()) => {
            // 3. Bounded reap polling
            let start = Instant::now();
            loop {
                match child.try_reap() {
                    Ok(true) => return Ok(()),
                    Ok(false) => {
                        if start.elapsed() >= deadline {
                            return Err(std::io::Error::new(
                                std::io::ErrorKind::TimedOut,
                                format!(
                                    "child pid {} not reaped within {:?} after kill",
                                    child.pid(),
                                    deadline,
                                ),
                            ));
                        }
                        std::thread::sleep(poll_interval);
                    }
                    Err(e) => return Err(e),
                }
            }
        }
        Err(kill_err) => {
            // 4. Kill failed: second try_reap to detect race
            match child.try_reap() {
                Ok(true) => Ok(()),
                Ok(false) => Err(kill_err),
                Err(tw_err) => Err(std::io::Error::new(
                    tw_err.kind(),
                    format!(
                        "kill failed ({}), then try_reap also failed ({})",
                        kill_err, tw_err
                    ),
                )),
            }
        }
    }
}

/// Production convenience: kill_and_reap with default deadline.
pub(crate) fn kill_and_reap<C: ChildLifecycle>(child: &mut C) -> Result<(), std::io::Error> {
    kill_and_reap_with_deadline(child, KILL_REAP_DEADLINE, KILL_REAP_POLL_INTERVAL)
}

// ---------------------------------------------------------------------------
// Cleanup context — production-used error formatting
// ---------------------------------------------------------------------------

/// Attempt cleanup and return formatted error context string.
/// Empty string on success; contains PID + error details on failure.
/// All production callsites use this to compose cleanup info into HelperFailed.
pub(crate) fn cleanup_with_context<C: ChildLifecycle>(child: &mut C) -> String {
    match kill_and_reap(child) {
        Ok(()) => String::new(),
        Err(ce) => format!(" (cleanup of pid {} also failed: {})", child.pid(), ce),
    }
}
