#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CefHostStatus {
    Uninitialized,
    Initializing,
    Ready,
    Failed,
    ShuttingDown,
    Shutdown,
}

pub(crate) struct CefHostStateMachine {
    status: CefHostStatus,
    generation: u64,
}

impl CefHostStateMachine {
    pub(crate) fn new() -> Self {
        Self {
            status: CefHostStatus::Uninitialized,
            generation: 0,
        }
    }

    pub(crate) fn status(&self) -> CefHostStatus {
        self.status
    }

    pub(crate) fn can_create_surface(&self) -> bool {
        self.status == CefHostStatus::Ready
    }

    pub(crate) fn begin_initialization(&mut self) -> Result<u64, &'static str> {
        if self.status != CefHostStatus::Uninitialized {
            return Err(
                if matches!(self.status, CefHostStatus::Failed | CefHostStatus::Shutdown) {
                    "terminal_state"
                } else {
                    "invalid_transition"
                },
            );
        }
        self.generation = self.generation.checked_add(1).ok_or("terminal_state")?;
        self.status = CefHostStatus::Initializing;
        Ok(self.generation)
    }

    pub(crate) fn mark_ready(&mut self, generation: u64) -> Result<(), &'static str> {
        self.require_current_initialization(generation)?;
        self.status = CefHostStatus::Ready;
        Ok(())
    }

    pub(crate) fn mark_failed(&mut self, generation: u64) -> Result<(), &'static str> {
        self.require_current_initialization(generation)?;
        self.status = CefHostStatus::Failed;
        Ok(())
    }

    pub(crate) fn begin_shutdown(&mut self) -> Result<(), &'static str> {
        match self.status {
            CefHostStatus::Uninitialized => self.status = CefHostStatus::Shutdown,
            CefHostStatus::Initializing | CefHostStatus::Ready | CefHostStatus::Failed => {
                self.status = CefHostStatus::ShuttingDown
            }
            CefHostStatus::ShuttingDown | CefHostStatus::Shutdown => {}
        }
        Ok(())
    }

    pub(crate) fn mark_shutdown(&mut self) -> Result<(), &'static str> {
        match self.status {
            CefHostStatus::ShuttingDown | CefHostStatus::Shutdown => {
                self.status = CefHostStatus::Shutdown;
                Ok(())
            }
            _ => Err("invalid_transition"),
        }
    }

    fn require_current_initialization(&self, generation: u64) -> Result<(), &'static str> {
        if self.status != CefHostStatus::Initializing {
            return Err("invalid_transition");
        }
        if generation != self.generation {
            return Err("stale_generation");
        }
        Ok(())
    }
}

impl Default for CefHostStateMachine {
    fn default() -> Self {
        Self::new()
    }
}
