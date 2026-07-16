use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_LEASE_SERIAL: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BrowserSurfaceBackend {
    Preview,
    Login,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BrowserSurfaceLifecycle {
    Acquiring,
    Ready,
    Hidden,
    Closing,
    Closed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BrowserSurfaceReleaseDisposition {
    Hide,
    Close,
}

/// Identity minted by Rust for one BrowserPanel ownership generation.
///
/// The ID is deliberately opaque to clients, but it is a fencing token rather
/// than an authentication credential. Every mutation must also match the
/// monotonic generation and revision checks owned by the coordinator.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct BrowserSurfaceLease {
    pub(crate) lease_id: String,
    pub(crate) generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BrowserSurfaceSnapshot {
    pub(crate) lease: BrowserSurfaceLease,
    pub(crate) backend: BrowserSurfaceBackend,
    pub(crate) lifecycle: BrowserSurfaceLifecycle,
    pub(crate) last_applied_revision: u64,
    pub(crate) lease_active: bool,
    pub(crate) failure: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BrowserSurfaceAcquireOutcome {
    pub(crate) current: BrowserSurfaceSnapshot,
    pub(crate) superseded: Option<BrowserSurfaceSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BrowserSurfaceApplyOutcome {
    Applied(BrowserSurfaceSnapshot),
    Noop,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BrowserSurfaceCoordinatorError {
    GenerationExhausted,
    LeaseIdExhausted,
    InvalidTransition {
        from: BrowserSurfaceLifecycle,
        to: BrowserSurfaceLifecycle,
    },
}

impl fmt::Display for BrowserSurfaceCoordinatorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::GenerationExhausted => {
                formatter.write_str("browser surface generation exhausted")
            }
            Self::LeaseIdExhausted => formatter.write_str("browser surface lease id exhausted"),
            Self::InvalidTransition { from, to } => {
                write!(
                    formatter,
                    "invalid browser surface transition {from:?} -> {to:?}"
                )
            }
        }
    }
}

impl std::error::Error for BrowserSurfaceCoordinatorError {}

/// Pure ownership and ordering state for the single BrowserPanel native slot.
///
/// The caller is responsible for serializing access and for performing native
/// Preview/CEF I/O only after receiving `Applied`. Native callbacks must carry
/// the same lease ID and generation back into the lifecycle methods so a
/// superseded surface cannot mutate the current state.
pub(crate) struct BrowserSurfaceCoordinator {
    last_generation: u64,
    current: Option<BrowserSurfaceSnapshot>,
}

impl BrowserSurfaceCoordinator {
    pub(crate) fn new() -> Self {
        Self {
            last_generation: 0,
            current: None,
        }
    }

    pub(crate) fn snapshot(&self) -> Option<BrowserSurfaceSnapshot> {
        self.current.clone()
    }

    /// Acquires the BrowserPanel slot. The latest acquire always wins and
    /// immediately invalidates every mutation from the previous lease.
    pub(crate) fn acquire(
        &mut self,
        backend: BrowserSurfaceBackend,
        client_revision: u64,
    ) -> Result<BrowserSurfaceAcquireOutcome, BrowserSurfaceCoordinatorError> {
        let generation = self
            .last_generation
            .checked_add(1)
            .ok_or(BrowserSurfaceCoordinatorError::GenerationExhausted)?;
        let lease_id = mint_lease_id()?;
        let superseded = self.current.take().map(|mut previous| {
            previous.lease_active = false;
            previous
        });
        let current = BrowserSurfaceSnapshot {
            lease: BrowserSurfaceLease {
                lease_id,
                generation,
            },
            backend,
            lifecycle: BrowserSurfaceLifecycle::Acquiring,
            last_applied_revision: client_revision,
            lease_active: true,
            failure: None,
        };

        self.last_generation = generation;
        self.current = Some(current.clone());

        Ok(BrowserSurfaceAcquireOutcome {
            current,
            superseded,
        })
    }

    /// Applies a BrowserPanel report only when ownership is current and its
    /// client revision is strictly newer than the last applied report.
    pub(crate) fn sync(
        &mut self,
        lease_id: &str,
        generation: u64,
        client_revision: u64,
    ) -> BrowserSurfaceApplyOutcome {
        let Some(current) = self.current.as_mut() else {
            return BrowserSurfaceApplyOutcome::Noop;
        };
        if !matches_active_lease(current, lease_id, generation)
            || client_revision <= current.last_applied_revision
        {
            return BrowserSurfaceApplyOutcome::Noop;
        }

        current.last_applied_revision = client_revision;
        BrowserSurfaceApplyOutcome::Applied(current.clone())
    }

    /// Releases the current lease. Release shares the revision fence with
    /// sync, so a late unmount from an older render is a successful no-op.
    pub(crate) fn release(
        &mut self,
        lease_id: &str,
        generation: u64,
        client_revision: u64,
        disposition: BrowserSurfaceReleaseDisposition,
    ) -> BrowserSurfaceApplyOutcome {
        let Some(current) = self.current.as_mut() else {
            return BrowserSurfaceApplyOutcome::Noop;
        };
        if !matches_active_lease(current, lease_id, generation)
            || client_revision <= current.last_applied_revision
        {
            return BrowserSurfaceApplyOutcome::Noop;
        }

        current.last_applied_revision = client_revision;
        current.lease_active = false;
        current.lifecycle = match disposition {
            BrowserSurfaceReleaseDisposition::Hide => BrowserSurfaceLifecycle::Hidden,
            BrowserSurfaceReleaseDisposition::Close => BrowserSurfaceLifecycle::Closing,
        };
        BrowserSurfaceApplyOutcome::Applied(current.clone())
    }

    /// Commits the terminal close transition after the native/session owner has
    /// accepted and completed its bounded close operation.
    ///
    /// Callers may first use `sync` to consume the client's revision without
    /// invalidating the lease. If native cleanup fails, the lease therefore
    /// remains active and a later, newer client revision can retry safely.
    pub(crate) fn begin_close(
        &mut self,
        lease_id: &str,
        generation: u64,
    ) -> Result<BrowserSurfaceApplyOutcome, BrowserSurfaceCoordinatorError> {
        let Some(current) = self.current.as_mut() else {
            return Ok(BrowserSurfaceApplyOutcome::Noop);
        };
        if !matches_active_lease(current, lease_id, generation) {
            return Ok(BrowserSurfaceApplyOutcome::Noop);
        }

        match current.lifecycle {
            BrowserSurfaceLifecycle::Acquiring | BrowserSurfaceLifecycle::Ready => {
                current.lease_active = false;
                current.lifecycle = BrowserSurfaceLifecycle::Closing;
                Ok(BrowserSurfaceApplyOutcome::Applied(current.clone()))
            }
            BrowserSurfaceLifecycle::Closing | BrowserSurfaceLifecycle::Closed => {
                Ok(BrowserSurfaceApplyOutcome::Noop)
            }
            from => Err(BrowserSurfaceCoordinatorError::InvalidTransition {
                from,
                to: BrowserSurfaceLifecycle::Closing,
            }),
        }
    }

    pub(crate) fn mark_ready(
        &mut self,
        lease_id: &str,
        generation: u64,
    ) -> Result<BrowserSurfaceApplyOutcome, BrowserSurfaceCoordinatorError> {
        let Some(current) = self.current.as_mut() else {
            return Ok(BrowserSurfaceApplyOutcome::Noop);
        };
        if !matches_active_lease(current, lease_id, generation) {
            return Ok(BrowserSurfaceApplyOutcome::Noop);
        }

        match current.lifecycle {
            BrowserSurfaceLifecycle::Acquiring => {
                current.lifecycle = BrowserSurfaceLifecycle::Ready;
                Ok(BrowserSurfaceApplyOutcome::Applied(current.clone()))
            }
            BrowserSurfaceLifecycle::Ready => Ok(BrowserSurfaceApplyOutcome::Noop),
            from => Err(BrowserSurfaceCoordinatorError::InvalidTransition {
                from,
                to: BrowserSurfaceLifecycle::Ready,
            }),
        }
    }

    pub(crate) fn mark_failed(
        &mut self,
        lease_id: &str,
        generation: u64,
        failure: impl Into<String>,
    ) -> Result<BrowserSurfaceApplyOutcome, BrowserSurfaceCoordinatorError> {
        let Some(current) = self.current.as_mut() else {
            return Ok(BrowserSurfaceApplyOutcome::Noop);
        };
        if !matches_active_lease(current, lease_id, generation) {
            return Ok(BrowserSurfaceApplyOutcome::Noop);
        }

        match current.lifecycle {
            BrowserSurfaceLifecycle::Acquiring | BrowserSurfaceLifecycle::Ready => {
                current.lifecycle = BrowserSurfaceLifecycle::Failed;
                current.lease_active = false;
                current.failure = Some(failure.into());
                Ok(BrowserSurfaceApplyOutcome::Applied(current.clone()))
            }
            BrowserSurfaceLifecycle::Failed => Ok(BrowserSurfaceApplyOutcome::Noop),
            from => Err(BrowserSurfaceCoordinatorError::InvalidTransition {
                from,
                to: BrowserSurfaceLifecycle::Failed,
            }),
        }
    }

    /// Completes an asynchronous close. A close acknowledgement may arrive
    /// after release, so it matches the current identity without requiring an
    /// active lease. An acknowledgement from a superseded generation is a no-op.
    pub(crate) fn mark_closed(
        &mut self,
        lease_id: &str,
        generation: u64,
    ) -> Result<BrowserSurfaceApplyOutcome, BrowserSurfaceCoordinatorError> {
        let Some(current) = self.current.as_mut() else {
            return Ok(BrowserSurfaceApplyOutcome::Noop);
        };
        if !matches_lease(current, lease_id, generation) {
            return Ok(BrowserSurfaceApplyOutcome::Noop);
        }

        match current.lifecycle {
            BrowserSurfaceLifecycle::Closing => {
                current.lifecycle = BrowserSurfaceLifecycle::Closed;
                Ok(BrowserSurfaceApplyOutcome::Applied(current.clone()))
            }
            BrowserSurfaceLifecycle::Closed => Ok(BrowserSurfaceApplyOutcome::Noop),
            from => Err(BrowserSurfaceCoordinatorError::InvalidTransition {
                from,
                to: BrowserSurfaceLifecycle::Closed,
            }),
        }
    }
}

impl Default for BrowserSurfaceCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

fn matches_lease(current: &BrowserSurfaceSnapshot, lease_id: &str, generation: u64) -> bool {
    current.lease.lease_id == lease_id && current.lease.generation == generation
}

fn matches_active_lease(current: &BrowserSurfaceSnapshot, lease_id: &str, generation: u64) -> bool {
    current.lease_active && matches_lease(current, lease_id, generation)
}

fn mint_lease_id() -> Result<String, BrowserSurfaceCoordinatorError> {
    let serial = NEXT_LEASE_SERIAL
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
            current.checked_add(1)
        })
        .map_err(|_| BrowserSurfaceCoordinatorError::LeaseIdExhausted)?;

    // This reversible mix prevents clients from treating the process-local
    // serial as a meaningful API. It is intentionally not a security primitive.
    let opaque = serial.wrapping_mul(0x9e37_79b9_7f4a_7c15).rotate_left(17) ^ 0xd1b5_4a32_d192_ed03;
    Ok(format!("surface-{opaque:016x}"))
}

#[cfg(test)]
#[path = "surface_coordinator_tests.rs"]
mod tests;
