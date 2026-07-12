use super::*;

#[test]
fn every_persistent_profile_is_discoverable_and_reopenable_by_opaque_id_after_restart() {
    let fixture = Fixture::new();
    let default = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("create default profile");
    fixture
        .manager
        .close(&default.handle)
        .expect("close default");
    let isolated = fixture
        .manager
        .open_new_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("create isolated profile");
    fixture
        .manager
        .close(&isolated.handle)
        .expect("close isolated");

    let restarted_state = Arc::new(Mutex::new(FakeSupervisorState::default()));
    let restarted = manager(
        &fixture.session_root,
        &fixture.runtime_root,
        Arc::clone(&restarted_state),
    );
    let profiles = restarted
        .profile_summaries(Fixture::trusted(&fixture.workspace_a))
        .expect("list persistent profiles after restart");
    assert_eq!(profiles.len(), 2);
    assert_eq!(profiles[0].profile_id, default.snapshot.profile_id);
    assert!(profiles[0].is_default);
    assert_eq!(profiles[1].profile_id, isolated.snapshot.profile_id);
    assert!(!profiles[1].is_default);
    for profile in &profiles {
        let value = serde_json::to_value(profile).expect("serialize profile summary");
        let mut keys = value
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        keys.sort();
        assert_eq!(keys, vec!["is_default", "last_used_at", "profile_id"]);
        assert!(!value
            .to_string()
            .contains(fixture._temp.path().to_string_lossy().as_ref()));
    }

    let reopened = restarted
        .open_existing_profile(
            Fixture::trusted(&fixture.workspace_a),
            &isolated.snapshot.profile_id,
        )
        .expect("reopen isolated profile by opaque id");
    assert_eq!(reopened.snapshot.profile_id, isolated.snapshot.profile_id);
    assert_eq!(
        restarted
            .reset_profile(
                Fixture::trusted(&fixture.workspace_a),
                &isolated.snapshot.profile_id,
                true,
            )
            .unwrap_err(),
        SessionManagerError::ProfileInUse
    );
    restarted
        .close(&reopened.handle)
        .expect("close reopened profile");

    assert!(matches!(
        restarted.open_existing_profile(
            Fixture::trusted(&fixture.workspace_b),
            &isolated.snapshot.profile_id,
        ),
        Err(SessionManagerError::ProfileUnavailable)
    ));
    assert_eq!(restarted_state.lock().unwrap().launch_count, 1);
}

#[test]
fn selected_profile_reset_and_delete_preserve_sibling_profiles_and_confirmation_boundaries() {
    let fixture = Fixture::new();
    let default = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("create default profile");
    fixture
        .manager
        .close(&default.handle)
        .expect("close default");
    let isolated = fixture
        .manager
        .open_new_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("create isolated profile");
    fixture
        .manager
        .close(&isolated.handle)
        .expect("close isolated");

    let profile_root = fixture.manager.profiles.root().join("profiles");
    let default_dir = profile_root.join(&default.snapshot.profile_id);
    let isolated_dir = profile_root.join(&isolated.snapshot.profile_id);
    let default_marker = default_dir.join("user-data").join("default-cookie");
    let isolated_marker = isolated_dir.join("user-data").join("isolated-cookie");
    fs::write(&default_marker, b"keep").expect("default marker");
    fs::write(&isolated_marker, b"reset").expect("isolated marker");

    assert_eq!(
        fixture
            .manager
            .reset_profile(
                Fixture::trusted(&fixture.workspace_a),
                &isolated.snapshot.profile_id,
                false,
            )
            .unwrap_err(),
        SessionManagerError::DestructiveConfirmationRequired
    );
    assert!(default_marker.exists());
    assert!(isolated_marker.exists());

    let reset = fixture
        .manager
        .reset_profile(
            Fixture::trusted(&fixture.workspace_a),
            &isolated.snapshot.profile_id,
            true,
        )
        .expect("reset selected isolated profile");
    assert_eq!(reset.profile_id, isolated.snapshot.profile_id);
    assert!(default_marker.exists());
    assert!(!isolated_marker.exists());

    fixture
        .manager
        .delete_profile(
            Fixture::trusted(&fixture.workspace_a),
            &isolated.snapshot.profile_id,
            true,
        )
        .expect("delete selected isolated profile");
    assert!(default_dir.exists());
    assert!(!isolated_dir.exists());
    let remaining = fixture
        .manager
        .profile_summaries(Fixture::trusted(&fixture.workspace_a))
        .expect("remaining profiles");
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].profile_id, default.snapshot.profile_id);
    assert!(remaining[0].is_default);
}
