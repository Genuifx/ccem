use super::*;

fn lease_identity(outcome: &BrowserSurfaceAcquireOutcome) -> (String, u64) {
    (
        outcome.current.lease.lease_id.clone(),
        outcome.current.lease.generation,
    )
}

#[test]
fn acquire_is_last_wins_with_opaque_lease_and_monotonic_generation() {
    let mut coordinator = BrowserSurfaceCoordinator::new();

    let first = coordinator
        .acquire(BrowserSurfaceBackend::Preview, 4)
        .expect("first lease");
    assert!(first.superseded.is_none());
    assert!(first.current.lease.lease_id.starts_with("surface-"));
    assert_eq!(first.current.lease.generation, 1);
    assert_eq!(first.current.lifecycle, BrowserSurfaceLifecycle::Acquiring);
    assert_eq!(first.current.last_applied_revision, 4);
    assert!(first.current.lease_active);

    let (first_id, first_generation) = lease_identity(&first);
    coordinator
        .mark_ready(&first_id, first_generation)
        .expect("ready transition");

    let second = coordinator
        .acquire(BrowserSurfaceBackend::Login, 11)
        .expect("replacement lease");
    assert_ne!(second.current.lease.lease_id, first_id);
    assert!(second.current.lease.generation > first_generation);
    assert_eq!(second.current.backend, BrowserSurfaceBackend::Login);
    assert_eq!(second.current.lifecycle, BrowserSurfaceLifecycle::Acquiring);
    let superseded = second
        .superseded
        .as_ref()
        .expect("previous owner is reported");
    assert_eq!(superseded.lifecycle, BrowserSurfaceLifecycle::Ready);
    assert!(!superseded.lease_active);

    assert_eq!(
        coordinator.sync(&first_id, first_generation, 100),
        BrowserSurfaceApplyOutcome::Noop
    );
    assert_eq!(coordinator.snapshot(), Some(second.current));
}

#[test]
fn sync_requires_both_current_identity_and_strictly_newer_revision() {
    let mut coordinator = BrowserSurfaceCoordinator::new();
    let acquired = coordinator
        .acquire(BrowserSurfaceBackend::Preview, 7)
        .expect("lease");
    let (lease_id, generation) = lease_identity(&acquired);

    assert_eq!(
        coordinator.sync(&lease_id, generation, 7),
        BrowserSurfaceApplyOutcome::Noop
    );
    assert_eq!(
        coordinator.sync(&lease_id, generation, 6),
        BrowserSurfaceApplyOutcome::Noop
    );
    assert_eq!(
        coordinator.sync("foreign-lease", generation, 8),
        BrowserSurfaceApplyOutcome::Noop
    );
    assert_eq!(
        coordinator.sync(&lease_id, generation + 1, 8),
        BrowserSurfaceApplyOutcome::Noop
    );

    let BrowserSurfaceApplyOutcome::Applied(applied) = coordinator.sync(&lease_id, generation, 8)
    else {
        panic!("strictly newer current revision should apply");
    };
    assert_eq!(applied.last_applied_revision, 8);

    assert_eq!(
        coordinator.sync(&lease_id, generation, 8),
        BrowserSurfaceApplyOutcome::Noop
    );
    let BrowserSurfaceApplyOutcome::Applied(applied) = coordinator.sync(&lease_id, generation, 10)
    else {
        panic!("revision may advance by more than one");
    };
    assert_eq!(applied.last_applied_revision, 10);
}

#[test]
fn hide_release_is_revision_fenced_idempotent_and_invalidates_the_lease() {
    let mut coordinator = BrowserSurfaceCoordinator::new();
    let acquired = coordinator
        .acquire(BrowserSurfaceBackend::Preview, 1)
        .expect("lease");
    let (lease_id, generation) = lease_identity(&acquired);
    coordinator.sync(&lease_id, generation, 3);

    assert_eq!(
        coordinator.release(
            &lease_id,
            generation,
            2,
            BrowserSurfaceReleaseDisposition::Hide,
        ),
        BrowserSurfaceApplyOutcome::Noop
    );
    assert_eq!(
        coordinator.snapshot().expect("current snapshot").lifecycle,
        BrowserSurfaceLifecycle::Acquiring
    );

    let BrowserSurfaceApplyOutcome::Applied(hidden) = coordinator.release(
        &lease_id,
        generation,
        4,
        BrowserSurfaceReleaseDisposition::Hide,
    ) else {
        panic!("newer release should apply");
    };
    assert_eq!(hidden.lifecycle, BrowserSurfaceLifecycle::Hidden);
    assert_eq!(hidden.last_applied_revision, 4);
    assert!(!hidden.lease_active);

    assert_eq!(
        coordinator.release(
            &lease_id,
            generation,
            5,
            BrowserSurfaceReleaseDisposition::Close,
        ),
        BrowserSurfaceApplyOutcome::Noop
    );
    assert_eq!(
        coordinator.sync(&lease_id, generation, 6),
        BrowserSurfaceApplyOutcome::Noop
    );
    assert_eq!(
        coordinator.snapshot().expect("hidden snapshot").lifecycle,
        BrowserSurfaceLifecycle::Hidden
    );
}

#[test]
fn close_release_waits_for_the_matching_close_acknowledgement() {
    let mut coordinator = BrowserSurfaceCoordinator::new();
    let acquired = coordinator
        .acquire(BrowserSurfaceBackend::Login, 20)
        .expect("lease");
    let (lease_id, generation) = lease_identity(&acquired);

    let BrowserSurfaceApplyOutcome::Applied(closing) = coordinator.release(
        &lease_id,
        generation,
        21,
        BrowserSurfaceReleaseDisposition::Close,
    ) else {
        panic!("close release should apply");
    };
    assert_eq!(closing.lifecycle, BrowserSurfaceLifecycle::Closing);
    assert!(!closing.lease_active);

    assert_eq!(
        coordinator
            .mark_closed("foreign-lease", generation)
            .expect("stale close is harmless"),
        BrowserSurfaceApplyOutcome::Noop
    );
    assert_eq!(
        coordinator
            .mark_closed(&lease_id, generation + 1)
            .expect("stale generation is harmless"),
        BrowserSurfaceApplyOutcome::Noop
    );

    let BrowserSurfaceApplyOutcome::Applied(closed) = coordinator
        .mark_closed(&lease_id, generation)
        .expect("matching close acknowledgement")
    else {
        panic!("matching close acknowledgement should apply");
    };
    assert_eq!(closed.lifecycle, BrowserSurfaceLifecycle::Closed);
    assert_eq!(
        coordinator
            .mark_closed(&lease_id, generation)
            .expect("duplicate close acknowledgement"),
        BrowserSurfaceApplyOutcome::Noop
    );
}

#[test]
fn validated_close_keeps_retry_authority_until_native_cleanup_succeeds() {
    let mut coordinator = BrowserSurfaceCoordinator::new();
    let acquired = coordinator
        .acquire(BrowserSurfaceBackend::Login, 1)
        .expect("lease");
    let (lease_id, generation) = lease_identity(&acquired);
    coordinator
        .mark_ready(&lease_id, generation)
        .expect("ready transition");

    let BrowserSurfaceApplyOutcome::Applied(validated) = coordinator.sync(&lease_id, generation, 2)
    else {
        panic!("close request revision should validate");
    };
    assert_eq!(validated.lifecycle, BrowserSurfaceLifecycle::Ready);
    assert!(validated.lease_active);

    // This is the state after a native close failure: only the request revision
    // was consumed, so the same exact owner can retry with a newer revision.
    let BrowserSurfaceApplyOutcome::Applied(retry) = coordinator.sync(&lease_id, generation, 3)
    else {
        panic!("failed native close must remain retryable");
    };
    assert!(retry.lease_active);

    let BrowserSurfaceApplyOutcome::Applied(closing) = coordinator
        .begin_close(&lease_id, generation)
        .expect("commit close after native cleanup")
    else {
        panic!("verified close should commit");
    };
    assert_eq!(closing.lifecycle, BrowserSurfaceLifecycle::Closing);
    assert!(!closing.lease_active);

    let BrowserSurfaceApplyOutcome::Applied(closed) = coordinator
        .mark_closed(&lease_id, generation)
        .expect("terminal acknowledgement")
    else {
        panic!("verified close should become terminal");
    };
    assert_eq!(closed.lifecycle, BrowserSurfaceLifecycle::Closed);
}

#[test]
fn superseded_release_cannot_hide_the_new_owner() {
    let mut coordinator = BrowserSurfaceCoordinator::new();
    let first = coordinator
        .acquire(BrowserSurfaceBackend::Preview, 1)
        .expect("first lease");
    let (first_id, first_generation) = lease_identity(&first);
    let second = coordinator
        .acquire(BrowserSurfaceBackend::Login, 1)
        .expect("second lease");

    assert_eq!(
        coordinator.release(
            &first_id,
            first_generation,
            u64::MAX,
            BrowserSurfaceReleaseDisposition::Hide,
        ),
        BrowserSurfaceApplyOutcome::Noop
    );
    assert_eq!(coordinator.snapshot(), Some(second.current));
}

#[test]
fn superseded_close_acknowledgement_cannot_close_the_new_owner() {
    let mut coordinator = BrowserSurfaceCoordinator::new();
    let first = coordinator
        .acquire(BrowserSurfaceBackend::Login, 1)
        .expect("first lease");
    let (first_id, first_generation) = lease_identity(&first);
    coordinator.release(
        &first_id,
        first_generation,
        2,
        BrowserSurfaceReleaseDisposition::Close,
    );

    let second = coordinator
        .acquire(BrowserSurfaceBackend::Preview, 1)
        .expect("replacement lease");
    assert_eq!(
        coordinator
            .mark_closed(&first_id, first_generation)
            .expect("superseded close acknowledgement is harmless"),
        BrowserSurfaceApplyOutcome::Noop
    );
    assert_eq!(coordinator.snapshot(), Some(second.current));
}

#[test]
fn failure_invalidates_one_lease_and_a_new_acquire_recovers() {
    let mut coordinator = BrowserSurfaceCoordinator::new();
    let failed_lease = coordinator
        .acquire(BrowserSurfaceBackend::Login, 3)
        .expect("login lease");
    let (failed_id, failed_generation) = lease_identity(&failed_lease);

    let BrowserSurfaceApplyOutcome::Applied(failed) = coordinator
        .mark_failed(&failed_id, failed_generation, "renderer terminated")
        .expect("failure transition")
    else {
        panic!("current failure should apply");
    };
    assert_eq!(failed.lifecycle, BrowserSurfaceLifecycle::Failed);
    assert_eq!(failed.failure.as_deref(), Some("renderer terminated"));
    assert!(!failed.lease_active);
    assert_eq!(
        coordinator.sync(&failed_id, failed_generation, 4),
        BrowserSurfaceApplyOutcome::Noop
    );

    let recovered = coordinator
        .acquire(BrowserSurfaceBackend::Preview, 1)
        .expect("replacement preview lease");
    assert!(recovered.current.lease.generation > failed_generation);
    assert_eq!(
        recovered.current.lifecycle,
        BrowserSurfaceLifecycle::Acquiring
    );
    assert_eq!(recovered.current.failure, None);
    assert!(recovered.current.lease_active);
}

#[test]
fn lifecycle_callbacks_are_idempotent_or_reject_invalid_current_transitions() {
    let mut coordinator = BrowserSurfaceCoordinator::new();
    let acquired = coordinator
        .acquire(BrowserSurfaceBackend::Login, 0)
        .expect("lease");
    let (lease_id, generation) = lease_identity(&acquired);

    let BrowserSurfaceApplyOutcome::Applied(ready) = coordinator
        .mark_ready(&lease_id, generation)
        .expect("ready transition")
    else {
        panic!("first ready callback should apply");
    };
    assert_eq!(ready.lifecycle, BrowserSurfaceLifecycle::Ready);
    assert_eq!(
        coordinator
            .mark_ready(&lease_id, generation)
            .expect("duplicate ready callback"),
        BrowserSurfaceApplyOutcome::Noop
    );

    assert_eq!(
        coordinator.mark_closed(&lease_id, generation),
        Err(BrowserSurfaceCoordinatorError::InvalidTransition {
            from: BrowserSurfaceLifecycle::Ready,
            to: BrowserSurfaceLifecycle::Closed,
        })
    );
    assert_eq!(
        coordinator
            .snapshot()
            .expect("state remains ready after rejected transition")
            .lifecycle,
        BrowserSurfaceLifecycle::Ready
    );
}
