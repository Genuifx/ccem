use super::*;
use crate::browser::login::capability::BrowserPermissionAuthority;
use crate::browser::BrowserToolRequest;

#[test]
fn terminated_exact_actor_route_retires_the_dead_handoff() {
    let fixture = Fixture::new();
    let opened = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("open browser");
    let actor = "browser-actor-11111111111111111111111111111111";
    let grant = fixture
        .manager
        .handoff_to_agent_for_actor(
            TrustedUiControlAuthorization::from_trusted_ui(
                &opened.handle,
                TrustedUiControlAction::HandoffToAgent,
                Duration::from_secs(30),
            )
            .unwrap(),
            actor,
        )
        .expect("handoff browser");
    fixture.state.lock().unwrap().terminated = true;
    let authority = BrowserPermissionAuthority::new("readonly");
    let request = BrowserToolRequest {
        request_id: "terminated-route".to_string(),
        tool: "get_url".to_string(),
        args: serde_json::json!({}),
    };

    let error = match fixture.manager.prepare_agent_tool_if_handed_off(
        &fixture.workspace_a.to_string_lossy(),
        actor,
        authority.current_ticket().unwrap(),
        &request,
    ) {
        Err(error) => error,
        Ok(_) => panic!("terminated exact actor route must fail explicitly"),
    };

    assert!(error.contains("runtime is unavailable"));
    let snapshot = fixture.manager.snapshot(&opened.handle).unwrap();
    assert_eq!(snapshot.status, LoginBrowserSessionStatus::CleanupRequired);
    assert_eq!(snapshot.control, SessionControlOwner::Paused);
    assert!(grant.control().validate_grant(grant.binding()).is_err());

    fixture.manager.force_stop(&opened.handle).unwrap();
}

#[test]
fn same_workspace_agent_handoffs_route_to_their_bound_browser_actor() {
    let fixture = Fixture::new();
    let browser_a = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("open browser A");
    let browser_b = fixture
        .manager
        .open_new_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("open browser B");
    let actor_a = "browser-actor-11111111111111111111111111111111";
    let actor_b = "browser-actor-22222222222222222222222222222222";

    for (opened, actor) in [(&browser_a, actor_a), (&browser_b, actor_b)] {
        fixture
            .manager
            .handoff_to_agent_for_actor(
                TrustedUiControlAuthorization::from_trusted_ui(
                    &opened.handle,
                    TrustedUiControlAction::HandoffToAgent,
                    Duration::from_secs(30),
                )
                .expect("trusted handoff authorization"),
                actor,
            )
            .expect("independent same-workspace handoff");
    }

    let workspace = fixture.workspace_a.to_string_lossy();
    let authority = BrowserPermissionAuthority::new("yolo");
    for (actor, request_id) in [(actor_a, "actor-a-url"), (actor_b, "actor-b-url")] {
        let request = BrowserToolRequest {
            request_id: request_id.to_string(),
            tool: "get_url".to_string(),
            args: serde_json::json!({}),
        };
        let prepared = fixture
            .manager
            .prepare_agent_tool_if_handed_off(
                &workspace,
                actor,
                authority.current_ticket().expect("permission ticket"),
                &request,
            )
            .expect("prepare exact browser route")
            .expect("bound Login Browser selected");
        fixture
            .manager
            .execute_prepared_agent_tool(&request, prepared)
            .expect("execute exact browser route");
    }

    let audit_a = fs::read_to_string(
        fixture
            .session_root
            .join("sessions")
            .join(&browser_a.snapshot.session_id)
            .join("audit/actions.jsonl"),
    )
    .expect("browser A audit");
    let audit_b = fs::read_to_string(
        fixture
            .session_root
            .join("sessions")
            .join(&browser_b.snapshot.session_id)
            .join("audit/actions.jsonl"),
    )
    .expect("browser B audit");
    assert!(audit_a.contains("actor-a-url"));
    assert!(!audit_a.contains("actor-b-url"));
    assert!(audit_b.contains("actor-b-url"));
    assert!(!audit_b.contains("actor-a-url"));

    fixture.manager.close(&browser_b.handle).unwrap();
    fixture.manager.close(&browser_a.handle).unwrap();
}

#[test]
fn wrong_actor_falls_back_before_mode2_parses_an_unsupported_request() {
    let fixture = Fixture::new();
    let opened = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("open browser");
    let actor_a = "browser-actor-11111111111111111111111111111111";
    let actor_b = "browser-actor-22222222222222222222222222222222";
    fixture
        .manager
        .handoff_to_agent_for_actor(
            TrustedUiControlAuthorization::from_trusted_ui(
                &opened.handle,
                TrustedUiControlAction::HandoffToAgent,
                Duration::from_secs(30),
            )
            .expect("trusted handoff authorization"),
            actor_a,
        )
        .expect("handoff browser");
    let authority = BrowserPermissionAuthority::new("yolo");
    let unsupported = BrowserToolRequest {
        request_id: "wrong-actor-unsupported".to_string(),
        tool: "raw_cdp".to_string(),
        args: serde_json::json!({"method": "Runtime.evaluate"}),
    };

    assert!(fixture
        .manager
        .prepare_agent_tool_if_handed_off(
            &fixture.workspace_a.to_string_lossy(),
            actor_b,
            authority.current_ticket().unwrap(),
            &unsupported,
        )
        .expect("wrong actor is an optional route miss")
        .is_none());
    let exact_error = match fixture.manager.prepare_agent_tool_if_handed_off(
        &fixture.workspace_a.to_string_lossy(),
        actor_a,
        authority.current_ticket().unwrap(),
        &unsupported,
    ) {
        Err(error) => error,
        Ok(_) => panic!("exact actor still rejects unsupported Mode 2 tools"),
    };
    assert!(exact_error.contains("does not expose arbitrary JavaScript"));

    fixture.manager.close(&opened.handle).unwrap();
}

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
    assert_eq!(
        rejected.err(),
        Some(SessionManagerError::HandoffPreflightRejected)
    );
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
fn unconfirmed_input_release_forces_the_bound_backend_before_pause_or_user_ack() {
    for target in [SessionControlOwner::Paused, SessionControlOwner::User] {
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
        let cancellation = grant
            .control()
            .begin_operation(grant.binding(), true)
            .expect("operation");
        cancellation.effect_safety_fence().mark_unconfirmed();

        let authorization = TrustedUiControlAuthorization::from_trusted_ui(
            &opened.handle,
            match target {
                SessionControlOwner::Paused => TrustedUiControlAction::PauseAgent,
                SessionControlOwner::User => TrustedUiControlAction::TakeoverByUser,
                SessionControlOwner::Agent => unreachable!(),
            },
            Duration::from_secs(30),
        )
        .unwrap();
        let transition = match target {
            SessionControlOwner::Paused => fixture.manager.pause_agent(authorization),
            SessionControlOwner::User => fixture.manager.takeover_by_user(authorization),
            SessionControlOwner::Agent => unreachable!(),
        };

        assert_eq!(
            transition.unwrap_err(),
            SessionManagerError::ControlUnavailable
        );
        let failed = fixture.manager.snapshot(&opened.handle).unwrap();
        assert_eq!(failed.control, SessionControlOwner::Paused);
        assert_eq!(failed.status, LoginBrowserSessionStatus::CleanupRequired);
        assert_eq!(fixture.state.lock().unwrap().emergency_count, 1);

        let retry = fixture.manager.pause_agent_if_active(
            TrustedUiControlAuthorization::from_trusted_ui(
                &opened.handle,
                TrustedUiControlAction::PauseAgent,
                Duration::from_secs(30),
            )
            .unwrap(),
        );
        assert_eq!(retry.unwrap_err(), SessionManagerError::SessionNotRunning);
        assert_eq!(
            fixture.state.lock().unwrap().emergency_count,
            1,
            "cleanup-required state must not request a second emergency stop"
        );
        fixture.manager.force_stop(&opened.handle).unwrap();
    }
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
        .open_new_profile(Fixture::trusted(&fixture.workspace_b))
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
