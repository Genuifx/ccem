use super::super::backend::{BackendFailure, BackendFailureCode};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::time::Duration;

const TRANSITION_TIMEOUT: Duration = Duration::from_millis(300);

struct TransitionRequest {
    entered: Sender<()>,
    resume: Receiver<()>,
    completed: Sender<Result<(), BackendFailure>>,
}

pub(super) struct OwnerTransitionClient {
    sender: Sender<TransitionRequest>,
}

pub(super) struct OwnerTransitionInbox {
    receiver: Receiver<TransitionRequest>,
}

pub(super) fn owner_transition_channel() -> (OwnerTransitionClient, OwnerTransitionInbox) {
    let (sender, receiver) = mpsc::channel();
    (
        OwnerTransitionClient { sender },
        OwnerTransitionInbox { receiver },
    )
}

impl OwnerTransitionClient {
    /// Run a trusted policy mutation while the protocol owner is acknowledged idle and blocked.
    pub(super) fn with_quiesced_owner(
        &self,
        transition: &mut dyn FnMut(),
    ) -> Result<(), BackendFailure> {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let (completed_tx, completed_rx) = mpsc::channel();
        self.sender
            .send(TransitionRequest {
                entered: entered_tx,
                resume: resume_rx,
                completed: completed_tx,
            })
            .map_err(|_| unavailable())?;
        entered_rx
            .recv_timeout(TRANSITION_TIMEOUT)
            .map_err(map_timeout)?;
        transition();
        resume_tx.send(()).map_err(|_| unavailable())?;
        completed_rx
            .recv_timeout(TRANSITION_TIMEOUT)
            .map_err(map_timeout)?
    }
}

impl OwnerTransitionInbox {
    /// Called after idle/event polling so acknowledgement proves no handler spans the transition.
    pub(super) fn run_pending(&self) -> Result<bool, BackendFailure> {
        let request = match self.receiver.try_recv() {
            Ok(request) => request,
            Err(TryRecvError::Empty) => return Ok(false),
            Err(TryRecvError::Disconnected) => return Ok(false),
        };
        request.entered.send(()).map_err(|_| unavailable())?;
        let result = request
            .resume
            .recv_timeout(TRANSITION_TIMEOUT)
            .map_err(map_timeout);
        let _ = request.completed.send(result.clone());
        result.map(|_| true)
    }
}

fn map_timeout(error: RecvTimeoutError) -> BackendFailure {
    match error {
        RecvTimeoutError::Timeout => BackendFailure::new(
            BackendFailureCode::TimedOut,
            "Browser owner policy transition reached its fixed deadline.",
        ),
        RecvTimeoutError::Disconnected => unavailable(),
    }
}

fn unavailable() -> BackendFailure {
    BackendFailure::new(
        BackendFailureCode::RuntimeUnavailable,
        "Browser owner policy transition is unavailable.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc};

    #[test]
    fn owner_emits_no_idle_event_effect_during_policy_transition() {
        let (client, inbox) = owner_transition_channel();
        let effects = Arc::new(AtomicUsize::new(0));
        let owner_effects = Arc::clone(&effects);
        let owner = std::thread::spawn(move || {
            while !inbox.run_pending().expect("transition handled") {
                std::thread::yield_now();
            }
            owner_effects.fetch_add(1, Ordering::AcqRel);
        });
        let (transition_entered_tx, transition_entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let transition = std::thread::spawn(move || {
            client
                .with_quiesced_owner(&mut || {
                    transition_entered_tx.send(()).expect("entered");
                    release_rx.recv().expect("release");
                })
                .expect("quiesced transition");
        });

        transition_entered_rx
            .recv_timeout(TRANSITION_TIMEOUT)
            .expect("callback entered after owner acknowledgement");
        assert_eq!(effects.load(Ordering::Acquire), 0);
        release_tx.send(()).expect("release transition");
        transition.join().expect("transition joined");
        owner.join().expect("owner joined");
        assert_eq!(effects.load(Ordering::Acquire), 1);
    }
}
