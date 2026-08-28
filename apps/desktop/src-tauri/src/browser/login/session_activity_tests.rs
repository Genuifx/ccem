use super::super::activity::LoginBrowserRecentArtifactKind;
use super::*;
use std::collections::BTreeSet;

#[cfg(unix)]
fn set_private(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

#[cfg(not(unix))]
fn set_private(_path: &Path, _mode: u32) {}

fn write_private(path: &Path, bytes: &[u8]) {
    fs::write(path, bytes).unwrap();
    set_private(path, 0o600);
}

#[test]
fn recent_activity_projects_only_bounded_opaque_metadata_for_trusted_artifacts() {
    let fixture = Fixture::new();
    let opened = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .unwrap();
    let artifact_root = {
        let sessions = fixture.manager.lock_sessions().unwrap();
        fixture
            .manager
            .record(&sessions, &opened.handle.session_id)
            .unwrap()
            .artifact_root
            .clone()
    };
    let session_root = artifact_root.parent().unwrap();
    let logs = session_root.join("logs");
    let audit = session_root.join("audit");
    for directory in [&artifact_root, &logs, &audit] {
        fs::create_dir_all(directory).unwrap();
        set_private(directory, 0o700);
    }
    let hex = "0123456789abcdef0123456789abcdef";
    write_private(&artifact_root.join(format!("shot-{hex}.png")), b"png");
    write_private(
        &artifact_root.join(format!("snapshot-{hex}.json")),
        b"UNTRUSTED_PAGE_SECRET",
    );
    write_private(
        &logs.join(format!("console-snapshot-{hex}.jsonl")),
        b"CONSOLE_SECRET",
    );
    write_private(
        &logs.join(format!("network-snapshot-{hex}.jsonl")),
        b"NETWORK_SECRET",
    );
    write_private(&audit.join("actions.jsonl"), b"AUDIT_PRIVATE_RECORD\n");
    write_private(&artifact_root.join("ignore-me.txt"), b"IGNORED_SECRET");

    let activity = fixture.manager.recent_activity(&opened.handle).unwrap();
    let kinds = activity
        .artifacts
        .iter()
        .map(|artifact| artifact.kind)
        .collect::<BTreeSet<_>>();
    assert_eq!(activity.artifacts.len(), 5);
    assert_eq!(
        kinds,
        BTreeSet::from([
            LoginBrowserRecentArtifactKind::Screenshot,
            LoginBrowserRecentArtifactKind::InteractionSnapshot,
            LoginBrowserRecentArtifactKind::ConsoleLog,
            LoginBrowserRecentArtifactKind::NetworkLog,
            LoginBrowserRecentArtifactKind::AuditLog,
        ])
    );
    let projected = serde_json::to_value(&activity).unwrap();
    for artifact in projected["artifacts"].as_array().unwrap() {
        let mut keys = artifact
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "artifact_id",
                "byte_size",
                "immutable",
                "kind",
                "modified_at",
                "untrusted",
            ]
        );
    }
    let serialized = projected.to_string();
    assert!(!serialized.contains(fixture._temp.path().to_string_lossy().as_ref()));
    for secret in [
        "UNTRUSTED_PAGE_SECRET",
        "CONSOLE_SECRET",
        "NETWORK_SECRET",
        "AUDIT_PRIVATE_RECORD",
        "IGNORED_SECRET",
    ] {
        assert!(!serialized.contains(secret));
    }
    fixture.manager.force_stop(&opened.handle).unwrap();
}

#[test]
fn profile_recent_activity_survives_close_and_rejects_a_tampered_app_owned_index() {
    let fixture = Fixture::new();
    let opened = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .unwrap();
    let artifact_root = {
        let sessions = fixture.manager.lock_sessions().unwrap();
        fixture
            .manager
            .record(&sessions, &opened.handle.session_id)
            .unwrap()
            .artifact_root
            .clone()
    };
    let session_root = artifact_root.parent().unwrap();
    let logs = session_root.join("logs");
    let audit = session_root.join("audit");
    for directory in [&artifact_root, &logs, &audit] {
        fs::create_dir_all(directory).unwrap();
        set_private(directory, 0o700);
    }
    let hex = "abcdef0123456789abcdef0123456789";
    write_private(
        &artifact_root.join(format!("shot-{hex}.png")),
        b"POST_CLOSE_SECRET",
    );
    write_private(&audit.join("actions.jsonl"), b"AUDIT_PRIVATE_RECORD\n");

    fixture.manager.close(&opened.handle).unwrap();
    assert_eq!(
        fixture.manager.recent_activity(&opened.handle).unwrap_err(),
        SessionManagerError::SessionNotFound,
        "active-control proof must remain bound to a live non-serializable handle"
    );

    let activity = fixture
        .manager
        .recent_activity_for_profile(
            Fixture::trusted(&fixture.workspace_a),
            &opened.snapshot.profile_id,
        )
        .expect("closed profile proof");
    let activity_from_other_workspace = fixture
        .manager
        .recent_activity_for_profile(
            Fixture::trusted(&fixture.workspace_b),
            &opened.snapshot.profile_id,
        )
        .expect("global default activity is shared across workspaces");
    assert_eq!(activity_from_other_workspace, activity);
    assert_eq!(activity.artifacts.len(), 2);
    let projection = serde_json::to_string(&activity).unwrap();
    assert!(!projection.contains("POST_CLOSE_SECRET"));
    assert!(!projection.contains("AUDIT_PRIVATE_RECORD"));
    assert!(!projection.contains(fixture._temp.path().to_string_lossy().as_ref()));

    let activity_root = fixture.session_root.join("profile-activity");
    let index_path = activity_root.join(format!("{}.json", opened.snapshot.profile_id));
    let index = fs::read_to_string(&index_path).expect("profile activity index");
    let index_value = serde_json::from_str::<serde_json::Value>(&index).unwrap();
    let mut index_keys = index_value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect::<Vec<_>>();
    index_keys.sort_unstable();
    assert_eq!(
        index_keys,
        vec!["integrity_sha256", "schema_version", "session_ids"]
    );
    assert!(index.contains(&opened.snapshot.session_id));
    assert!(!index.contains(fixture._temp.path().to_string_lossy().as_ref()));
    assert!(!index.contains("POST_CLOSE_SECRET"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&activity_root).unwrap().permissions().mode() & 0o077,
            0
        );
        for file in [
            index_path.clone(),
            activity_root.join("activity.lock"),
            activity_root.join("integrity.key"),
        ] {
            assert_eq!(fs::metadata(file).unwrap().permissions().mode() & 0o077, 0);
        }
    }

    let mut tampered = serde_json::from_str::<serde_json::Value>(&index).unwrap();
    tampered["session_ids"] = serde_json::json!([
        opened.snapshot.session_id,
        "login-session-00000000000000000000000000000000"
    ]);
    write_private(
        &index_path,
        &serde_json::to_vec(&tampered).expect("tampered index"),
    );
    assert_eq!(
        fixture
            .manager
            .recent_activity_for_profile(
                Fixture::trusted(&fixture.workspace_a),
                &opened.snapshot.profile_id,
            )
            .unwrap_err(),
        SessionManagerError::StateUnavailable
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        fs::remove_file(&index_path).unwrap();
        let outside_index = fixture._temp.path().join("outside-profile-activity.json");
        write_private(&outside_index, index.as_bytes());
        symlink(&outside_index, &index_path).unwrap();
        assert_eq!(
            fixture
                .manager
                .recent_activity_for_profile(
                    Fixture::trusted(&fixture.workspace_a),
                    &opened.snapshot.profile_id,
                )
                .unwrap_err(),
            SessionManagerError::StateUnavailable
        );
    }
}

#[test]
fn profile_activity_index_retains_only_the_latest_bounded_opaque_sessions() {
    let fixture = Fixture::new();
    let first = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .unwrap();
    let profile_id = first.snapshot.profile_id.clone();
    let first_session_id = first.snapshot.session_id.clone();
    fixture.manager.force_stop(&first.handle).unwrap();
    let mut latest_session_id = first_session_id.clone();
    for _ in 0..20 {
        let opened = fixture
            .manager
            .open_existing_profile(Fixture::trusted(&fixture.workspace_a), &profile_id)
            .unwrap();
        latest_session_id = opened.snapshot.session_id.clone();
        fixture.manager.force_stop(&opened.handle).unwrap();
    }

    let index_path = fixture
        .session_root
        .join("profile-activity")
        .join(format!("{profile_id}.json"));
    let bytes = fs::read(&index_path).unwrap();
    assert!(bytes.len() <= super::super::activity::MAX_PROFILE_ACTIVITY_BYTES as usize);
    let index = serde_json::from_slice::<serde_json::Value>(&bytes).unwrap();
    let session_ids = index["session_ids"].as_array().unwrap();
    assert_eq!(
        session_ids.len(),
        super::super::activity::MAX_PROFILE_ACTIVITY_SESSIONS
    );
    assert!(!session_ids
        .iter()
        .any(|value| value.as_str() == Some(first_session_id.as_str())));
    assert_eq!(
        session_ids.last().and_then(|value| value.as_str()),
        Some(latest_session_id.as_str())
    );
    assert!(session_ids.iter().all(|value| {
        value
            .as_str()
            .is_some_and(|session_id| session_id.starts_with("login-session-"))
    }));
}

#[cfg(unix)]
#[test]
fn recent_activity_rejects_a_symlink_in_the_trusted_store() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new();
    let opened = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .unwrap();
    let artifact_root = {
        let sessions = fixture.manager.lock_sessions().unwrap();
        fixture
            .manager
            .record(&sessions, &opened.handle.session_id)
            .unwrap()
            .artifact_root
            .clone()
    };
    let logs = artifact_root.parent().unwrap().join("logs");
    for directory in [&artifact_root, &logs] {
        fs::create_dir_all(directory).unwrap();
        set_private(directory, 0o700);
    }
    let outside = fixture._temp.path().join("outside");
    write_private(&outside, b"outside");
    symlink(&outside, artifact_root.join("untrusted-link")).unwrap();

    assert_eq!(
        fixture.manager.recent_activity(&opened.handle).unwrap_err(),
        SessionManagerError::StateUnavailable
    );
    fs::remove_file(artifact_root.join("untrusted-link")).unwrap();
    fixture.manager.force_stop(&opened.handle).unwrap();
}
