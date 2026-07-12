use super::*;

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
