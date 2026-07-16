use super::*;

#[test]
fn trusted_occlusion_pause_is_idempotent_and_cancels_only_agent_control() {
    let fixture = Fixture::new();
    let opened = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("open");

    let user = fixture
        .manager
        .pause_agent_if_active(
            TrustedUiControlAuthorization::from_trusted_ui(
                &opened.handle,
                TrustedUiControlAction::PauseAgent,
                Duration::from_secs(30),
            )
            .unwrap(),
        )
        .expect("user-owned session is already safe");
    assert_eq!(user.control, SessionControlOwner::User);
    assert_eq!(user.handoff_epoch, 0);

    fixture
        .manager
        .handoff_to_agent(
            TrustedUiControlAuthorization::from_trusted_ui(
                &opened.handle,
                TrustedUiControlAction::HandoffToAgent,
                Duration::from_secs(30),
            )
            .unwrap(),
        )
        .expect("handoff");
    let paused = fixture
        .manager
        .pause_agent_if_active(
            TrustedUiControlAuthorization::from_trusted_ui(
                &opened.handle,
                TrustedUiControlAction::PauseAgent,
                Duration::from_secs(30),
            )
            .unwrap(),
        )
        .expect("occlusion pause");
    assert_eq!(paused.control, SessionControlOwner::Paused);
    assert_eq!(paused.handoff_epoch, 2);

    let still_paused = fixture
        .manager
        .pause_agent_if_active(
            TrustedUiControlAuthorization::from_trusted_ui(
                &opened.handle,
                TrustedUiControlAction::PauseAgent,
                Duration::from_secs(30),
            )
            .unwrap(),
        )
        .expect("already-paused session stays safe");
    assert_eq!(still_paused.control, SessionControlOwner::Paused);
    assert_eq!(still_paused.handoff_epoch, paused.handoff_epoch);
}

#[test]
fn trusted_handoff_pause_and_takeover_advance_epoch_and_invalidate_old_grants() {
    let fixture = Fixture::new();
    let opened = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("open");
    fixture.state.lock().unwrap().fail_close = true;
    let rejected = fixture.manager.handoff_to_agent(
        TrustedUiControlAuthorization::from_trusted_ui(
            &opened.handle,
            TrustedUiControlAction::HandoffToAgent,
            Duration::from_secs(30),
        )
        .unwrap(),
    );
    assert_eq!(rejected.err(), Some(SessionManagerError::OriginUnavailable));
    assert_eq!(
        fixture.manager.snapshot(&opened.handle).unwrap().control,
        SessionControlOwner::User
    );
    fixture.state.lock().unwrap().fail_close = false;
    let grant_one = fixture
        .manager
        .handoff_to_agent(
            TrustedUiControlAuthorization::from_trusted_ui(
                &opened.handle,
                TrustedUiControlAction::HandoffToAgent,
                Duration::from_secs(30),
            )
            .unwrap(),
        )
        .expect("first handoff");
    assert_eq!(
        fixture
            .manager
            .snapshot(&opened.handle)
            .unwrap()
            .handoff_epoch,
        1
    );
    assert!(grant_one
        .control()
        .validate_grant(grant_one.binding())
        .is_ok());

    let paused = fixture
        .manager
        .pause_agent(
            TrustedUiControlAuthorization::from_trusted_ui(
                &opened.handle,
                TrustedUiControlAction::PauseAgent,
                Duration::from_secs(30),
            )
            .unwrap(),
        )
        .expect("pause");
    assert_eq!(paused.control, SessionControlOwner::Paused);
    assert_eq!(paused.handoff_epoch, 2);
    assert_eq!(
        grant_one
            .control()
            .validate_grant(grant_one.binding())
            .unwrap_err()
            .code,
        ControlErrorCode::NoActiveHandoff
    );

    let grant_two = fixture
        .manager
        .handoff_to_agent(
            TrustedUiControlAuthorization::from_trusted_ui(
                &opened.handle,
                TrustedUiControlAction::HandoffToAgent,
                Duration::from_secs(30),
            )
            .unwrap(),
        )
        .expect("second handoff");
    assert_eq!(grant_two.binding().handoff_epoch(), 3);
    let user = fixture
        .manager
        .takeover_by_user(
            TrustedUiControlAuthorization::from_trusted_ui(
                &opened.handle,
                TrustedUiControlAction::TakeoverByUser,
                Duration::from_secs(30),
            )
            .unwrap(),
        )
        .expect("takeover");
    assert_eq!(user.control, SessionControlOwner::User);
    assert_eq!(user.handoff_epoch, 4);
    assert!(grant_two
        .control()
        .validate_grant(grant_two.binding())
        .is_err());

    let wrong_action = TrustedUiControlAuthorization::from_trusted_ui(
        &opened.handle,
        TrustedUiControlAction::PauseAgent,
        Duration::from_secs(30),
    )
    .unwrap();
    assert_eq!(
        fixture.manager.takeover_by_user(wrong_action).unwrap_err(),
        SessionManagerError::TrustedUiActionMismatch
    );
    let close_grant = fixture
        .manager
        .handoff_to_agent(
            TrustedUiControlAuthorization::from_trusted_ui(
                &opened.handle,
                TrustedUiControlAction::HandoffToAgent,
                Duration::from_secs(30),
            )
            .unwrap(),
        )
        .expect("handoff before close");
    fixture.manager.close(&opened.handle).unwrap();
    assert!(close_grant
        .control()
        .validate_grant(close_grant.binding())
        .is_err());
}

#[test]
fn pause_cancels_an_active_owner_operation_without_waiting_for_backend_io() {
    let fixture = Fixture::new();
    let opened = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("open");
    let grant = fixture
        .manager
        .handoff_to_agent(
            TrustedUiControlAuthorization::from_trusted_ui(
                &opened.handle,
                TrustedUiControlAction::HandoffToAgent,
                Duration::from_secs(30),
            )
            .unwrap(),
        )
        .expect("handoff");

    let (started_tx, started_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let cancellation = grant
        .control()
        .begin_operation(grant.binding(), true)
        .expect("active owner operation");
    let waiter = thread::spawn(move || {
        started_tx.send(()).unwrap();
        let started = Instant::now();
        let cancelled = cancellation.wait_cancelled(Duration::from_secs(2));
        done_tx.send((cancelled, started.elapsed())).unwrap();
    });
    started_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("owner operation started");
    let started = Instant::now();
    let paused = fixture
        .manager
        .pause_agent(
            TrustedUiControlAuthorization::from_trusted_ui(
                &opened.handle,
                TrustedUiControlAction::PauseAgent,
                Duration::from_secs(30),
            )
            .unwrap(),
        )
        .expect("pause during borrow");
    assert_eq!(paused.control, SessionControlOwner::Paused);
    assert!(started.elapsed() < Duration::from_millis(200));
    let (cancelled, elapsed) = done_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("operation cancellation");
    assert!(cancelled);
    assert!(elapsed < Duration::from_secs(1));
    waiter.join().unwrap();
    fixture.manager.close(&opened.handle).unwrap();
}

#[test]
fn diagnostic_start_failure_rolls_back_before_discovery_and_consumes_the_authority_epoch() {
    let fixture = Fixture::new();
    let opened = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .unwrap();
    fixture.state.lock().unwrap().fail_diagnostic_begin = true;

    let error = fixture
        .manager
        .handoff_to_agent(
            TrustedUiControlAuthorization::from_trusted_ui(
                &opened.handle,
                TrustedUiControlAction::HandoffToAgent,
                Duration::from_secs(30),
            )
            .unwrap(),
        )
        .err()
        .expect("diagnostic start must fail before publication");

    assert_eq!(error, SessionManagerError::ControlUnavailable);
    let rolled_back = fixture.manager.snapshot(&opened.handle).unwrap();
    assert_eq!(rolled_back.control, SessionControlOwner::User);
    assert_eq!(rolled_back.status, LoginBrowserSessionStatus::Running);
    assert_eq!(rolled_back.handoff_epoch, 1);

    fixture.state.lock().unwrap().fail_diagnostic_begin = false;
    let next = fixture
        .manager
        .handoff_to_agent(
            TrustedUiControlAuthorization::from_trusted_ui(
                &opened.handle,
                TrustedUiControlAction::HandoffToAgent,
                Duration::from_secs(30),
            )
            .unwrap(),
        )
        .unwrap();
    assert_eq!(next.binding().handoff_epoch(), 2);
    fixture.manager.force_stop(&opened.handle).unwrap();
}

#[test]
fn blocked_handoff_preflight_does_not_delay_pause_for_an_unrelated_session() {
    let fixture = Fixture::new();
    let active = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .unwrap();
    fixture
        .manager
        .handoff_to_agent(
            TrustedUiControlAuthorization::from_trusted_ui(
                &active.handle,
                TrustedUiControlAction::HandoffToAgent,
                Duration::from_secs(30),
            )
            .unwrap(),
        )
        .unwrap();
    let candidate = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_b))
        .unwrap();
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    fixture.state.lock().unwrap().preflight_barriers =
        Some((Arc::clone(&entered), Arc::clone(&release)));

    let manager = Arc::clone(&fixture.manager);
    let candidate_handle = candidate.handle.clone();
    let handoff = thread::spawn(move || {
        manager.handoff_to_agent(
            TrustedUiControlAuthorization::from_trusted_ui(
                &candidate_handle,
                TrustedUiControlAction::HandoffToAgent,
                Duration::from_secs(30),
            )
            .unwrap(),
        )
    });
    entered.wait();
    let delayed_release = Arc::clone(&release);
    let releaser = thread::spawn(move || {
        thread::sleep(Duration::from_millis(1_200));
        delayed_release.wait();
    });

    let started = Instant::now();
    let paused = fixture
        .manager
        .pause_agent(
            TrustedUiControlAuthorization::from_trusted_ui(
                &active.handle,
                TrustedUiControlAction::PauseAgent,
                Duration::from_secs(30),
            )
            .unwrap(),
        )
        .unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "unrelated pause waited behind candidate preflight: {:?}",
        started.elapsed()
    );
    assert_eq!(paused.control, SessionControlOwner::Paused);

    releaser.join().unwrap();
    handoff.join().unwrap().unwrap();
    fixture.state.lock().unwrap().preflight_barriers = None;
    fixture.manager.force_stop(&candidate.handle).unwrap();
    fixture.manager.force_stop(&active.handle).unwrap();
}

#[test]
fn duplicate_handoff_from_agent_has_no_preflight_or_state_effect() {
    let fixture = Fixture::new();
    let opened = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .unwrap();
    let grant = fixture
        .manager
        .handoff_to_agent(
            TrustedUiControlAuthorization::from_trusted_ui(
                &opened.handle,
                TrustedUiControlAction::HandoffToAgent,
                Duration::from_secs(30),
            )
            .unwrap(),
        )
        .unwrap();
    let before_snapshot = fixture.manager.snapshot(&opened.handle).unwrap();
    let before_preflights = fixture.state.lock().unwrap().preflight_count;

    let error = fixture
        .manager
        .handoff_to_agent(
            TrustedUiControlAuthorization::from_trusted_ui(
                &opened.handle,
                TrustedUiControlAction::HandoffToAgent,
                Duration::from_secs(30),
            )
            .unwrap(),
        )
        .err()
        .expect("duplicate Agent handoff must be rejected");

    assert_eq!(error, SessionManagerError::InvalidControlTransition);
    assert_eq!(
        fixture.state.lock().unwrap().preflight_count,
        before_preflights
    );
    assert_eq!(
        fixture.manager.snapshot(&opened.handle).unwrap(),
        before_snapshot
    );
    assert!(grant.control().validate_grant(grant.binding()).is_ok());
    fixture.manager.force_stop(&opened.handle).unwrap();
}
