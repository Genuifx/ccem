use super::*;

#[test]
fn default_profile_maintenance_requires_confirmation_and_preserves_state_on_rejection() {
    let fixture = Fixture::new();
    assert_eq!(
        fixture
            .manager
            .default_profile_summary(Fixture::trusted(&fixture.workspace_a))
            .expect("empty default profile summary"),
        None
    );

    let opened = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("create default profile");
    fixture.manager.close(&opened.handle).expect("stop profile");
    let before = fixture
        .manager
        .default_profile_summary(Fixture::trusted(&fixture.workspace_a))
        .expect("default profile summary")
        .expect("default profile exists");
    assert_eq!(before.profile_id, opened.snapshot.profile_id);
    assert!(before.last_used_at.is_some());
    let projected = serde_json::to_value(&before).expect("serialize maintenance summary");
    let mut keys = projected
        .as_object()
        .expect("maintenance summary object")
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    keys.sort();
    assert_eq!(keys, vec!["is_default", "last_used_at", "profile_id"]);
    assert!(!projected
        .to_string()
        .contains(fixture._temp.path().to_string_lossy().as_ref()));

    assert_eq!(
        fixture
            .manager
            .reset_default_profile(
                Fixture::trusted(&fixture.workspace_a),
                &before.profile_id,
                false,
            )
            .unwrap_err(),
        SessionManagerError::DestructiveConfirmationRequired
    );
    assert_eq!(
        fixture
            .manager
            .delete_default_profile(
                Fixture::trusted(&fixture.workspace_a),
                &before.profile_id,
                false,
            )
            .unwrap_err(),
        SessionManagerError::DestructiveConfirmationRequired
    );
    assert_eq!(
        fixture
            .manager
            .default_profile_summary(Fixture::trusted(&fixture.workspace_a))
            .unwrap(),
        Some(before)
    );
}

#[test]
fn default_profile_reset_and_delete_are_bound_to_the_canonical_workspace_default() {
    let fixture = Fixture::new();
    let opened = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("create default profile");
    fixture.manager.close(&opened.handle).expect("stop profile");

    let profile_id = ProfileId::parse(&opened.snapshot.profile_id).expect("profile id");
    let profile_dir = fixture
        .manager
        .profiles_for_test()
        .root()
        .join("profiles")
        .join(profile_id.as_str());
    let marker = profile_dir.join("user-data").join("login-cookie-marker");
    fs::write(&marker, b"private login state").expect("write profile marker");

    let reset = fixture
        .manager
        .reset_default_profile(
            Fixture::trusted(&fixture.workspace_a),
            &opened.snapshot.profile_id,
            true,
        )
        .expect("reset default profile");
    assert_eq!(reset.profile_id, opened.snapshot.profile_id);
    assert_eq!(reset.last_used_at, None);
    assert!(!marker.exists());

    fixture
        .manager
        .delete_default_profile(
            Fixture::trusted(&fixture.workspace_a),
            &opened.snapshot.profile_id,
            true,
        )
        .expect("delete default profile");
    assert_eq!(
        fixture
            .manager
            .default_profile_summary(Fixture::trusted(&fixture.workspace_a))
            .unwrap(),
        None
    );
    assert!(!profile_dir.exists());
}

#[test]
fn active_and_cleanup_required_profiles_reject_maintenance_without_profile_effects() {
    let fixture = Fixture::new();
    let opened = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("open active profile");
    let active_summary = fixture
        .manager
        .default_profile_summary(Fixture::trusted(&fixture.workspace_a))
        .unwrap()
        .expect("active default profile");
    let profile_id = ProfileId::parse(&opened.snapshot.profile_id).expect("active profile id");
    let workspace_identity =
        TrustedWorkspaceIdentity::from_trusted_store(opened.snapshot.workspace_id.clone())
            .expect("active workspace identity");
    let active_descriptor = fixture
        .manager
        .profiles_for_test()
        .descriptor(&profile_id, &workspace_identity)
        .expect("active profile descriptor");

    assert_eq!(
        fixture
            .manager
            .reset_default_profile(
                Fixture::trusted(&fixture.workspace_a),
                &active_summary.profile_id,
                true,
            )
            .unwrap_err(),
        SessionManagerError::ProfileInUse
    );
    assert_eq!(
        fixture
            .manager
            .delete_default_profile(
                Fixture::trusted(&fixture.workspace_a),
                &active_summary.profile_id,
                true,
            )
            .unwrap_err(),
        SessionManagerError::ProfileInUse
    );
    assert_eq!(
        fixture
            .manager
            .default_profile_summary(Fixture::trusted(&fixture.workspace_a))
            .unwrap(),
        Some(active_summary.clone())
    );
    assert_eq!(
        fixture
            .manager
            .profiles_for_test()
            .descriptor(&profile_id, &workspace_identity)
            .unwrap(),
        active_descriptor
    );

    fixture.state.lock().unwrap().fail_close = true;
    assert_eq!(
        fixture.manager.close(&opened.handle).unwrap_err(),
        SessionManagerError::RuntimeUnavailable
    );
    assert_eq!(
        fixture.manager.snapshot(&opened.handle).unwrap().status,
        LoginBrowserSessionStatus::CleanupRequired
    );
    let cleanup_descriptor = fixture
        .manager
        .profiles_for_test()
        .descriptor(&profile_id, &workspace_identity)
        .expect("cleanup-required profile descriptor");
    assert_eq!(
        fixture
            .manager
            .reset_default_profile(
                Fixture::trusted(&fixture.workspace_a),
                &active_summary.profile_id,
                true,
            )
            .unwrap_err(),
        SessionManagerError::ProfileInUse
    );
    assert_eq!(
        fixture
            .manager
            .delete_default_profile(
                Fixture::trusted(&fixture.workspace_a),
                &active_summary.profile_id,
                true,
            )
            .unwrap_err(),
        SessionManagerError::ProfileInUse
    );
    assert_eq!(
        fixture
            .manager
            .default_profile_summary(Fixture::trusted(&fixture.workspace_a))
            .unwrap(),
        Some(active_summary)
    );
    assert_eq!(
        fixture
            .manager
            .profiles_for_test()
            .descriptor(&profile_id, &workspace_identity)
            .unwrap(),
        cleanup_descriptor
    );

    fixture.state.lock().unwrap().fail_close = false;
    fixture
        .manager
        .force_stop(&opened.handle)
        .expect("clean up fixture session");
}

#[cfg(unix)]
#[test]
fn workspace_aliases_resolve_to_the_same_default_profile_before_authorization_is_minted() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new();
    let workspace_alias = fixture._temp.path().join("workspace-alias");
    symlink(&fixture.workspace_a, &workspace_alias).expect("workspace alias");
    let opened = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("create canonical default");
    fixture.manager.close(&opened.handle).expect("stop profile");

    let reset = fixture
        .manager
        .reset_default_profile(
            Fixture::trusted(&workspace_alias),
            &opened.snapshot.profile_id,
            true,
        )
        .expect("reset through canonical alias");
    assert_eq!(reset.profile_id, opened.snapshot.profile_id);
}

#[test]
fn deleting_default_does_not_promote_an_isolated_profile_or_retarget_stale_confirmation() {
    let fixture = Fixture::new();
    let first = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("create first default");
    fixture.manager.close(&first.handle).expect("stop first");
    let second = fixture
        .manager
        .open_new_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("create next profile");
    fixture.manager.close(&second.handle).expect("stop second");

    fixture
        .manager
        .delete_default_profile(
            Fixture::trusted(&fixture.workspace_a),
            &first.snapshot.profile_id,
            true,
        )
        .expect("delete the profile that was actually confirmed");
    assert_eq!(
        fixture
            .manager
            .default_profile_summary(Fixture::trusted(&fixture.workspace_a))
            .unwrap(),
        None,
        "deleting the global default must not promote an explicitly isolated profile"
    );
    let inventory = fixture
        .manager
        .profile_summaries(Fixture::trusted(&fixture.workspace_a))
        .expect("isolated profile remains discoverable");
    assert_eq!(inventory.len(), 1);
    assert_eq!(inventory[0].profile_id, second.snapshot.profile_id);
    assert!(!inventory[0].is_default);

    let replacement = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("create a fresh global default after explicit deletion");
    fixture
        .manager
        .close(&replacement.handle)
        .expect("stop replacement default");
    assert_ne!(replacement.snapshot.profile_id, second.snapshot.profile_id);

    let isolated_id = ProfileId::parse(&second.snapshot.profile_id).unwrap();
    let replacement_id = ProfileId::parse(&replacement.snapshot.profile_id).unwrap();
    let workspace = TrustedWorkspaceIdentity::from_trusted_store(second.snapshot.workspace_id)
        .expect("workspace identity");
    let isolated_before = fixture
        .manager
        .profiles_for_test()
        .descriptor(&isolated_id, &workspace)
        .unwrap();
    let replacement_before = fixture
        .manager
        .profiles_for_test()
        .descriptor(&replacement_id, &workspace)
        .unwrap();

    for result in [
        fixture.manager.reset_default_profile(
            Fixture::trusted(&fixture.workspace_a),
            &first.snapshot.profile_id,
            true,
        ),
        fixture
            .manager
            .delete_default_profile(
                Fixture::trusted(&fixture.workspace_a),
                &first.snapshot.profile_id,
                true,
            )
            .map(|_| LoginBrowserProfileSummary {
                profile_id: first.snapshot.profile_id.clone(),
                last_used_at: None,
                is_default: true,
            }),
    ] {
        assert_eq!(result.unwrap_err(), SessionManagerError::ProfileChanged);
    }
    assert_eq!(
        fixture
            .manager
            .profiles_for_test()
            .descriptor(&isolated_id, &workspace)
            .unwrap(),
        isolated_before
    );
    assert_eq!(
        fixture
            .manager
            .profiles_for_test()
            .descriptor(&replacement_id, &workspace)
            .unwrap(),
        replacement_before
    );
}

#[test]
fn unavailable_manager_fails_mode2_ipc_but_preserves_optional_mode1_routing() {
    let manager = LoginBrowserSessionManager::unavailable();

    assert_eq!(
        manager.list_snapshots().unwrap_err(),
        SessionManagerError::StateUnavailable
    );
    #[cfg(windows)]
    let workspace_dir = r"C:\ccem-mode1";
    #[cfg(not(windows))]
    let workspace_dir = "/tmp/ccem-mode1";
    let workspace =
        TrustedWorkspacePath::from_trusted_app(PathBuf::from(workspace_dir)).expect("trusted path");
    assert!(matches!(
        manager.open_default_profile(workspace.clone()),
        Err(SessionManagerError::StateUnavailable)
    ));
    assert_eq!(
        manager.profile_summaries(workspace.clone()).unwrap_err(),
        SessionManagerError::StateUnavailable
    );
    let report = manager
        .shutdown_all()
        .expect("unavailable manager has no sessions");
    assert_eq!(report.attempted, 0);
    assert_eq!(report.closed, 0);
    assert!(report.failures.is_empty());

    let authority = crate::browser::login::capability::BrowserPermissionAuthority::new("safe")
        .current_ticket()
        .expect("permission ticket");
    let request = crate::browser::BrowserToolRequest {
        request_id: "degraded-mode2-routing".to_string(),
        tool: "browser_snapshot".to_string(),
        args: serde_json::json!({}),
    };
    assert!(manager
        .prepare_agent_tool_if_handed_off(
            workspace_dir,
            "browser-actor-11111111111111111111111111111111",
            authority.clone(),
            &request,
        )
        .expect("Mode 1 routing probe")
        .is_none());
    manager
        .update_permission_for_workspace(workspace, authority)
        .expect("no Mode 2 sessions to synchronize");
}
