use super::*;

#[test]
fn retiring_one_actor_pauses_only_its_browser_and_preserves_both_instances() {
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

    let grant_a = fixture
        .manager
        .handoff_to_agent_for_actor(
            TrustedUiControlAuthorization::from_trusted_ui(
                &browser_a.handle,
                TrustedUiControlAction::HandoffToAgent,
                Duration::from_secs(30),
            )
            .unwrap(),
            actor_a,
        )
        .expect("handoff browser A");
    let grant_b = fixture
        .manager
        .handoff_to_agent_for_actor(
            TrustedUiControlAuthorization::from_trusted_ui(
                &browser_b.handle,
                TrustedUiControlAction::HandoffToAgent,
                Duration::from_secs(30),
            )
            .unwrap(),
            actor_b,
        )
        .expect("handoff browser B");
    let operation_a = grant_a
        .control()
        .begin_operation(grant_a.binding(), false)
        .expect("begin actor A operation");
    let operation_b = grant_b
        .control()
        .begin_operation(grant_b.binding(), false)
        .expect("begin actor B operation");

    let retired = fixture
        .manager
        .retire_agent_for_actor(Fixture::trusted(&fixture.workspace_a), actor_a)
        .expect("retire actor A")
        .expect("actor A browser was bound");

    assert_eq!(retired.session_id, browser_a.snapshot.session_id);
    assert_eq!(retired.control, SessionControlOwner::Paused);
    assert_eq!(retired.status, LoginBrowserSessionStatus::Running);
    assert!(
        grant_a.control().validate_grant(grant_a.binding()).is_err(),
        "retired actor A grant must be revoked"
    );
    assert!(
        operation_a.enter_effect_write().is_err(),
        "retired actor A operation must be cancelled"
    );
    assert!(
        grant_b.control().validate_grant(grant_b.binding()).is_ok(),
        "peer actor B grant must remain current"
    );
    assert!(
        operation_b.enter_effect_write().is_ok(),
        "peer actor B operation must remain writable"
    );

    let snapshot_b = fixture.manager.snapshot(&browser_b.handle).unwrap();
    assert_eq!(snapshot_b.control, SessionControlOwner::Agent);
    assert_eq!(snapshot_b.status, LoginBrowserSessionStatus::Running);
    assert_eq!(fixture.state.lock().unwrap().close_count, 0);
    assert_eq!(fixture.state.lock().unwrap().force_count, 0);
    assert!(
        fixture
            .manager
            .retire_agent_for_actor(Fixture::trusted(&fixture.workspace_a), actor_a)
            .expect("repeat retirement is idempotent")
            .is_none(),
        "a retired actor must no longer resolve to a Browser instance"
    );

    fixture.manager.force_stop(&browser_b.handle).unwrap();
    fixture.manager.force_stop(&browser_a.handle).unwrap();
}

#[test]
fn permission_sync_linearizes_actor_binding_with_session_transitions() {
    let fixture = Fixture::new();
    let opened = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("open browser");
    let actor_a = "browser-actor-11111111111111111111111111111111";
    let actor_b = "browser-actor-22222222222222222222222222222222";
    let grant_a = fixture
        .manager
        .handoff_to_agent_for_actor(
            TrustedUiControlAuthorization::from_trusted_ui(
                &opened.handle,
                TrustedUiControlAction::HandoffToAgent,
                Duration::from_secs(30),
            )
            .unwrap(),
            actor_a,
        )
        .expect("handoff browser to actor A");
    let cancellation = grant_a
        .control()
        .begin_operation(grant_a.binding(), true)
        .expect("begin actor A operation");
    let owner = cancellation
        .enter_owner_execution()
        .expect("hold actor A owner acknowledgement");

    let update_manager = Arc::clone(&fixture.manager);
    let workspace = fixture.workspace_a.clone();
    let authority = crate::browser::login::capability::BrowserPermissionAuthority::new("readonly");
    let update = thread::spawn(move || {
        update_manager.update_permission_for_actor(
            Fixture::trusted(&workspace),
            actor_a,
            authority.current_ticket().unwrap(),
        )
    });
    assert!(
        cancellation.wait_cancelled(Duration::from_secs(1)),
        "permission sync must enter the owner retirement fence"
    );

    let snapshot_manager = Arc::clone(&fixture.manager);
    let snapshot_handle = opened.handle.clone();
    let (snapshot_tx, snapshot_rx) = mpsc::sync_channel(1);
    let snapshot = thread::spawn(move || {
        let result = snapshot_manager.snapshot(&snapshot_handle);
        let _ = snapshot_tx.send(result);
    });
    assert!(
        snapshot_rx.recv_timeout(Duration::from_millis(50)).is_err(),
        "session transitions must not observe an actor binding between selection and permission commit"
    );

    drop(owner);
    update.join().unwrap().expect("permission sync");
    snapshot_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("snapshot unblocked")
        .expect("snapshot remains available");
    snapshot.join().unwrap();

    fixture
        .manager
        .pause_agent(
            TrustedUiControlAuthorization::from_trusted_ui(
                &opened.handle,
                TrustedUiControlAction::PauseAgent,
                Duration::from_secs(30),
            )
            .unwrap(),
        )
        .expect("pause actor A after permission commit");
    let grant_b = fixture
        .manager
        .handoff_to_agent_for_actor(
            TrustedUiControlAuthorization::from_trusted_ui(
                &opened.handle,
                TrustedUiControlAction::HandoffToAgent,
                Duration::from_secs(30),
            )
            .unwrap(),
            actor_b,
        )
        .expect("handoff same browser to actor B");
    assert!(grant_b.control().validate_grant(grant_b.binding()).is_ok());
    assert_eq!(fixture.state.lock().unwrap().emergency_count, 0);

    fixture.manager.force_stop(&opened.handle).unwrap();
}

#[test]
fn permission_update_for_one_actor_does_not_cancel_same_workspace_peer() {
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

    let grant_a = fixture
        .manager
        .handoff_to_agent_for_actor(
            TrustedUiControlAuthorization::from_trusted_ui(
                &browser_a.handle,
                TrustedUiControlAction::HandoffToAgent,
                Duration::from_secs(30),
            )
            .unwrap(),
            actor_a,
        )
        .expect("handoff browser A");
    let grant_b = fixture
        .manager
        .handoff_to_agent_for_actor(
            TrustedUiControlAuthorization::from_trusted_ui(
                &browser_b.handle,
                TrustedUiControlAction::HandoffToAgent,
                Duration::from_secs(30),
            )
            .unwrap(),
            actor_b,
        )
        .expect("handoff browser B");
    let peer_operation = grant_b
        .control()
        .begin_operation(grant_b.binding(), false)
        .expect("begin browser B operation");

    let authority = crate::browser::login::capability::BrowserPermissionAuthority::new("readonly");
    fixture
        .manager
        .update_permission_for_actor(
            Fixture::trusted(&fixture.workspace_a),
            actor_a,
            authority.current_ticket().unwrap(),
        )
        .expect("update browser A permission");

    assert!(
        peer_operation.enter_effect_write().is_ok(),
        "updating actor A must not cancel actor B's in-flight operation"
    );
    assert!(grant_a.control().validate_grant(grant_a.binding()).is_ok());
    assert!(grant_b.control().validate_grant(grant_b.binding()).is_ok());

    fixture.manager.force_stop(&browser_b.handle).unwrap();
    fixture.manager.force_stop(&browser_a.handle).unwrap();
}

#[test]
fn stuck_permission_downgrade_revokes_authority_and_requests_exact_emergency_stop() {
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
    let cancellation = grant
        .control()
        .begin_operation(grant.binding(), true)
        .unwrap();
    let owner = cancellation.enter_owner_execution().unwrap();
    let started = Instant::now();
    let authority = crate::browser::login::capability::BrowserPermissionAuthority::new("readonly");

    let error = fixture
        .manager
        .update_permission_for_workspace(
            Fixture::trusted(&fixture.workspace_a),
            authority.current_ticket().unwrap(),
        )
        .unwrap_err();

    assert_eq!(error, SessionManagerError::OwnerQuiescenceTimedOut);
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "permission downgrade exceeded its bounded emergency path: {:?}",
        started.elapsed()
    );
    let snapshot = fixture.manager.snapshot(&opened.handle).unwrap();
    assert_eq!(snapshot.status, LoginBrowserSessionStatus::CleanupRequired);
    assert_eq!(snapshot.control, SessionControlOwner::Paused);
    assert!(grant.control().validate_grant(grant.binding()).is_err());
    assert!(cancellation.enter_effect_write().is_err());
    assert_eq!(fixture.state.lock().unwrap().emergency_count, 1);
    assert_eq!(fixture.state.lock().unwrap().semantic_effect_count, 0);

    drop(owner);
    fixture.manager.force_stop(&opened.handle).unwrap();
}
