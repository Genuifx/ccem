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
    let restarted = manager(&fixture.session_root, Arc::clone(&restarted_state));
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

    let shared_default = restarted
        .open_existing_profile(
            Fixture::trusted(&fixture.workspace_b),
            &default.snapshot.profile_id,
        )
        .expect("global default is selectable from another trusted workspace");
    assert_eq!(
        shared_default.snapshot.profile_id,
        default.snapshot.profile_id
    );
    assert_ne!(
        shared_default.snapshot.workspace_id,
        default.snapshot.workspace_id
    );
    restarted
        .close(&shared_default.handle)
        .expect("close cross-workspace default");

    assert!(matches!(
        restarted.open_existing_profile(
            Fixture::trusted(&fixture.workspace_b),
            &isolated.snapshot.profile_id,
        ),
        Err(SessionManagerError::ProfileUnavailable)
    ));
    assert_eq!(restarted_state.lock().unwrap().launch_count, 2);
}

#[test]
fn every_workspace_inventory_shows_the_same_default_and_only_its_own_isolated_profiles() {
    let fixture = Fixture::new();
    let default = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("create global default");
    fixture.manager.close(&default.handle).unwrap();
    let isolated_a = fixture
        .manager
        .open_new_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("workspace A isolated profile");
    fixture.manager.close(&isolated_a.handle).unwrap();
    let isolated_b = fixture
        .manager
        .open_new_profile(Fixture::trusted(&fixture.workspace_b))
        .expect("workspace B isolated profile");
    fixture.manager.close(&isolated_b.handle).unwrap();

    let inventory_a = fixture
        .manager
        .profile_summaries(Fixture::trusted(&fixture.workspace_a))
        .unwrap();
    let inventory_b = fixture
        .manager
        .profile_summaries(Fixture::trusted(&fixture.workspace_b))
        .unwrap();
    assert_eq!(
        inventory_a
            .iter()
            .map(|profile| (&profile.profile_id, profile.is_default))
            .collect::<Vec<_>>(),
        vec![
            (&default.snapshot.profile_id, true),
            (&isolated_a.snapshot.profile_id, false),
        ]
    );
    assert_eq!(
        inventory_b
            .iter()
            .map(|profile| (&profile.profile_id, profile.is_default))
            .collect::<Vec<_>>(),
        vec![
            (&default.snapshot.profile_id, true),
            (&isolated_b.snapshot.profile_id, false),
        ]
    );
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

    let profile_root = fixture.manager.profiles_for_test().root().join("profiles");
    let default_dir = profile_root.join(&default.snapshot.profile_id);
    let isolated_dir = profile_root.join(&isolated.snapshot.profile_id);
    let default_marker = default_dir.join("user-data").join("default-cookie");
    let isolated_marker = isolated_dir.join("user-data").join("isolated-cookie");
    let cef_root = fixture.session_root.join("cef");
    let default_cef_dir = cef_root.join(format!("Profile-{}", default.snapshot.profile_id));
    let isolated_cef_dir = cef_root.join(format!("Profile-{}", isolated.snapshot.profile_id));
    fs::create_dir(&default_cef_dir).expect("default CEF profile cache");
    fs::create_dir(&isolated_cef_dir).expect("isolated CEF profile cache");
    let default_cef_marker = default_cef_dir.join("Cookies");
    let isolated_cef_marker = isolated_cef_dir.join("Cookies");
    fs::write(&default_marker, b"keep").expect("default marker");
    fs::write(&isolated_marker, b"reset").expect("isolated marker");
    fs::write(&default_cef_marker, b"keep").expect("default CEF marker");
    fs::write(&isolated_cef_marker, b"reset").expect("isolated CEF marker");

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
    assert!(default_cef_marker.exists());
    assert!(isolated_cef_marker.exists());

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
    assert!(default_cef_marker.exists());
    assert!(!isolated_cef_marker.exists());
    assert!(isolated_cef_dir.is_dir());

    fs::write(&isolated_cef_marker, b"delete").expect("isolated CEF delete marker");

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
    assert!(default_cef_dir.exists());
    assert!(!isolated_cef_dir.exists());
    let remaining = fixture
        .manager
        .profile_summaries(Fixture::trusted(&fixture.workspace_a))
        .expect("remaining profiles");
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].profile_id, default.snapshot.profile_id);
    assert!(remaining[0].is_default);
}
