use super::SharedSurfaceState;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum FocusRestoreTarget {
    Primary,
    Popup(i32),
}

#[derive(Debug, Default)]
pub(super) struct FocusRestoreIntent {
    target: Option<FocusRestoreTarget>,
    revision: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FocusRestoreAttempt {
    target: FocusRestoreTarget,
    revision: u64,
}

impl FocusRestoreIntent {
    fn advance_revision(&mut self) {
        self.revision = self
            .revision
            .checked_add(1)
            .expect("focus restore revision exhausted");
    }

    fn capture(&mut self, target: Option<FocusRestoreTarget>) {
        self.advance_revision();
        self.target = target;
    }

    fn clear(&mut self) {
        self.advance_revision();
        self.target = None;
    }

    fn peek_for_current_popup(
        &mut self,
        current_popup: Option<i32>,
    ) -> Option<FocusRestoreAttempt> {
        let target = self.target?;
        match target {
            FocusRestoreTarget::Primary if current_popup.is_none() => Some(FocusRestoreAttempt {
                target,
                revision: self.revision,
            }),
            FocusRestoreTarget::Popup(popup_id) if current_popup == Some(popup_id) => {
                Some(FocusRestoreAttempt {
                    target,
                    revision: self.revision,
                })
            }
            _ => {
                // A popup identity change (including a closed popup represented
                // by `None`) makes the old target unsafe to retry.
                self.clear();
                None
            }
        }
    }

    fn commit_if_unchanged(&mut self, restored: FocusRestoreAttempt) -> bool {
        if self.target == Some(restored.target) && self.revision == restored.revision {
            self.clear();
            true
        } else {
            // A newer capture won the race while native focus was being
            // restored. Never let the older completion consume it.
            false
        }
    }
}

impl SharedSurfaceState {
    pub(super) fn capture_focus_restore_intent(&self, target: Option<FocusRestoreTarget>) {
        self.focus_restore
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .capture(target);
    }

    pub(super) fn clear_focus_restore_intent(&self) {
        self.focus_restore
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
    }

    pub(super) fn try_restore_focus_intent<E>(
        &self,
        current_popup: Option<i32>,
        restore: impl FnOnce(FocusRestoreTarget) -> Result<bool, E>,
    ) -> Result<bool, E> {
        let attempt = {
            self.focus_restore
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .peek_for_current_popup(current_popup)
        };
        let Some(attempt) = attempt else {
            return Ok(false);
        };

        // Do not hold the intent mutex across AppKit/Win32 calls. A failed or
        // incomplete native restore leaves the same intent pending for the next
        // visibility sync.
        if !restore(attempt.target)? {
            return Ok(false);
        }

        Ok(self
            .focus_restore
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .commit_if_unchanged(attempt))
    }
}

#[cfg(test)]
mod tests {
    use super::{FocusRestoreIntent, FocusRestoreTarget};
    use crate::browser::login::cef::surface::{
        CefSurfaceOpenSpec, NativeChildBounds, SharedSurfaceState,
    };
    use std::sync::mpsc;

    fn shared_surface() -> std::sync::Arc<SharedSurfaceState> {
        SharedSurfaceState::new(&CefSurfaceOpenSpec {
            surface_id: "focus-restore-test".to_string(),
            profile_id: "profile-0123456789abcdef0123456789abcdef".to_string(),
            initial_url: "https://example.com".to_string(),
            parent_view: 1,
            bounds: NativeChildBounds {
                x: 0,
                y: 0,
                width: 640,
                height: 480,
            },
            visible: false,
            persistent_profile_storage: true,
        })
    }

    #[test]
    fn no_focus_never_creates_restore_intent() {
        let mut intent = FocusRestoreIntent::default();
        intent.capture(Some(FocusRestoreTarget::Primary));
        intent.capture(None);
        assert_eq!(intent.peek_for_current_popup(None), None);
    }

    #[test]
    fn primary_restore_failure_retries_then_consumes_once_on_success() {
        let shared = shared_surface();
        shared.capture_focus_restore_intent(Some(FocusRestoreTarget::Primary));

        assert_eq!(
            shared.try_restore_focus_intent(None, |target| {
                assert_eq!(target, FocusRestoreTarget::Primary);
                Err::<bool, _>("transient AppKit or Win32 focus failure")
            }),
            Err("transient AppKit or Win32 focus failure")
        );
        assert_eq!(
            shared.try_restore_focus_intent(None, |target| {
                assert_eq!(target, FocusRestoreTarget::Primary);
                Ok::<_, &str>(true)
            }),
            Ok(true)
        );
        assert_eq!(
            shared.try_restore_focus_intent(None, |_| {
                panic!("a committed focus restore must be one-shot")
            }),
            Ok::<_, &str>(false)
        );
    }

    #[test]
    fn popup_restore_failure_retries_then_consumes_once_on_success() {
        let shared = shared_surface();
        shared.capture_focus_restore_intent(Some(FocusRestoreTarget::Popup(42)));

        assert_eq!(
            shared.try_restore_focus_intent(Some(42), |target| {
                assert_eq!(target, FocusRestoreTarget::Popup(42));
                Ok::<_, &str>(false)
            }),
            Ok(false)
        );
        assert_eq!(
            shared.try_restore_focus_intent(Some(42), |target| {
                assert_eq!(target, FocusRestoreTarget::Popup(42));
                Ok::<_, &str>(true)
            }),
            Ok(true)
        );
        assert_eq!(
            shared.try_restore_focus_intent(Some(42), |_| {
                panic!("a committed popup focus restore must be one-shot")
            }),
            Ok::<_, &str>(false)
        );
    }

    #[test]
    fn popup_identity_mismatch_and_closed_popup_discard_stale_intent() {
        let shared = shared_surface();
        shared.capture_focus_restore_intent(Some(FocusRestoreTarget::Popup(42)));
        assert_eq!(
            shared.try_restore_focus_intent(Some(43), |_| {
                panic!("a stale popup target must not be focused")
            }),
            Ok::<_, &str>(false)
        );
        assert_eq!(
            shared.try_restore_focus_intent(Some(42), |_| {
                panic!("a mismatched popup target must be discarded")
            }),
            Ok::<_, &str>(false)
        );

        shared.capture_focus_restore_intent(Some(FocusRestoreTarget::Popup(42)));
        assert_eq!(
            shared.try_restore_focus_intent(None, |_| {
                panic!("a closed popup target must not be retried")
            }),
            Ok::<_, &str>(false)
        );

        shared.capture_focus_restore_intent(Some(FocusRestoreTarget::Primary));
        assert_eq!(
            shared.try_restore_focus_intent(Some(44), |_| {
                panic!("primary focus must not steal focus from a live popup")
            }),
            Ok::<_, &str>(false)
        );
    }

    #[test]
    fn clear_drops_pending_restore_intent() {
        let mut intent = FocusRestoreIntent::default();
        intent.capture(Some(FocusRestoreTarget::Primary));
        intent.clear();
        assert_eq!(intent.peek_for_current_popup(None), None);
    }

    #[test]
    fn late_success_does_not_consume_a_newer_concurrent_capture() {
        let shared = shared_surface();
        shared.capture_focus_restore_intent(Some(FocusRestoreTarget::Primary));
        let (attempt_started_tx, attempt_started_rx) = mpsc::channel();
        let (capture_done_tx, capture_done_rx) = mpsc::channel();

        std::thread::scope(|scope| {
            let restoring = std::sync::Arc::clone(&shared);
            scope.spawn(move || {
                assert_eq!(
                    restoring.try_restore_focus_intent(None, |target| {
                        assert_eq!(target, FocusRestoreTarget::Primary);
                        attempt_started_tx.send(()).unwrap();
                        capture_done_rx.recv().unwrap();
                        Ok::<_, &str>(true)
                    }),
                    // The native call succeeded, but its old target lost the
                    // compare-and-commit race to the newer capture.
                    Ok(false)
                );
            });

            attempt_started_rx.recv().unwrap();
            shared.capture_focus_restore_intent(Some(FocusRestoreTarget::Popup(7)));
            capture_done_tx.send(()).unwrap();
        });

        assert_eq!(
            shared.try_restore_focus_intent(Some(7), |target| {
                assert_eq!(target, FocusRestoreTarget::Popup(7));
                Ok::<_, &str>(true)
            }),
            Ok(true)
        );
        assert_eq!(
            shared.try_restore_focus_intent(Some(7), |_| {
                panic!("the newer capture must also remain one-shot")
            }),
            Ok::<_, &str>(false)
        );
    }

    fn assert_same_target_recapture_survives_late_success(
        target: FocusRestoreTarget,
        current_popup: Option<i32>,
    ) {
        let shared = shared_surface();
        shared.capture_focus_restore_intent(Some(target));
        let (attempt_started_tx, attempt_started_rx) = mpsc::channel();
        let (capture_done_tx, capture_done_rx) = mpsc::channel();

        std::thread::scope(|scope| {
            let restoring = std::sync::Arc::clone(&shared);
            scope.spawn(move || {
                assert_eq!(
                    restoring.try_restore_focus_intent(current_popup, |restoring_target| {
                        assert_eq!(restoring_target, target);
                        attempt_started_tx.send(()).unwrap();
                        capture_done_rx.recv().unwrap();
                        Ok::<_, &str>(true)
                    }),
                    Ok(false),
                    "an older success must not consume a same-target recapture"
                );
            });

            attempt_started_rx.recv().unwrap();
            shared.capture_focus_restore_intent(Some(target));
            capture_done_tx.send(()).unwrap();
        });

        assert_eq!(
            shared.try_restore_focus_intent(current_popup, |restoring_target| {
                assert_eq!(restoring_target, target);
                Ok::<_, &str>(true)
            }),
            Ok(true)
        );
        assert_eq!(
            shared.try_restore_focus_intent(current_popup, |_| {
                panic!("the newer same-target capture must remain one-shot")
            }),
            Ok::<_, &str>(false)
        );
    }

    #[test]
    fn late_primary_success_does_not_consume_a_new_primary_capture() {
        assert_same_target_recapture_survives_late_success(FocusRestoreTarget::Primary, None);
    }

    #[test]
    fn late_popup_success_does_not_consume_a_new_same_popup_capture() {
        assert_same_target_recapture_survives_late_success(FocusRestoreTarget::Popup(42), Some(42));
    }
}
