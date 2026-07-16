use super::*;
use std::fs;

fn workspace(id: &str) -> TrustedWorkspaceIdentity {
    TrustedWorkspaceIdentity::from_trusted_store(id).expect("trusted workspace identity")
}

fn manager() -> (tempfile::TempDir, BrowserProfileManager) {
    let temp = tempfile::tempdir().expect("temporary browser profile root");
    let manager = BrowserProfileManager::new(
        temp.path().join("login/profile-state"),
        temp.path().join("login/cef"),
    )
    .expect("create browser profile manager");
    (temp, manager)
}

fn proof(ownership_id: &str) -> OwnershipDomainGone {
    OwnershipDomainGone::from_supervisor(ownership_id).expect("ownership proof")
}

fn authorization(
    action: DestructiveProfileAction,
    descriptor: &BrowserProfileDescriptor,
    workspace_identity: &TrustedWorkspaceIdentity,
) -> DestructiveProfileAuthorization {
    DestructiveProfileAuthorization::from_trusted_ui(
        action,
        descriptor.profile_id().clone(),
        workspace_identity.clone(),
        Duration::from_secs(30),
    )
    .expect("trusted destructive authorization")
}

#[test]
fn profile_ids_are_opaque_and_paths_are_private() {
    let (_temp, manager) = manager();
    let workspace = workspace("workspace-alpha-001");
    let descriptor = manager.create_profile(&workspace).expect("create profile");
    assert!(descriptor
        .profile_id()
        .as_str()
        .starts_with(PROFILE_ID_PREFIX));
    assert_eq!(descriptor.profile_id().as_str().len(), 40);
    assert_eq!(descriptor.workspace_identity(), workspace.as_str());
    assert!(matches!(
        descriptor.cleanup_state(),
        ProfileCleanupState::Stopped
    ));

    let profile_dir = manager.profiles_root.join(descriptor.profile_id().as_str());
    let cef_profile_dir = manager
        .checked_cef_profile_dir(descriptor.profile_id())
        .expect("CEF direct-child cache path");
    assert!(profile_dir.join("user-data").is_dir());
    assert!(profile_dir.join("profile.lock").is_file());
    assert!(profile_dir.join(metadata_file_name(1)).is_file());
    assert_eq!(cef_profile_dir.parent(), Some(manager.cef_cache_root()));
    let expected_cef_profile_name = format!("Profile-{}", descriptor.profile_id().as_str());
    assert_eq!(
        cef_profile_dir.file_name().and_then(|name| name.to_str()),
        Some(expected_cef_profile_name.as_str())
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        assert_eq!(
            fs::metadata(manager.root())
                .expect("root metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(profile_dir.join(metadata_file_name(1)))
                .expect("descriptor metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn concurrent_lease_is_rejected_and_drop_requires_recovery_proof() {
    let (_temp, manager) = manager();
    let workspace = workspace("workspace-lock-001");
    let descriptor = manager.create_profile(&workspace).expect("create profile");
    let lease = manager
        .acquire_launch_lease(descriptor.profile_id(), &workspace)
        .expect("first lease");

    assert!(matches!(
        manager.acquire_launch_lease(descriptor.profile_id(), &workspace),
        Err(ProfileError::ProfileInUse)
    ));
    let ownership_id = lease.ownership_id().to_string();
    drop(lease);
    assert!(matches!(
        manager.acquire_launch_lease(descriptor.profile_id(), &workspace),
        Err(ProfileError::ProfileRequiresCleanup)
    ));

    manager
        .recover_after_ownership_domain_gone(
            descriptor.profile_id(),
            &workspace,
            proof(&ownership_id),
        )
        .expect("recover after supervisor proof");
    let lease = manager
        .acquire_launch_lease(descriptor.profile_id(), &workspace)
        .expect("lease after recovery");
    let ownership_id = lease.ownership_id().to_string();
    lease
        .release_after_ownership_domain_gone(proof(&ownership_id))
        .expect("clean release");
}

#[test]
fn embedded_reservation_holds_the_lock_without_publishing_launch_pending() {
    let (temp, manager) = manager();
    let workspace = workspace("workspace-embedded-reservation-001");
    let descriptor = manager.create_profile(&workspace).expect("create profile");
    let reservation = manager
        .reserve_embedded_launch(descriptor.profile_id(), &workspace)
        .expect("reserve stopped profile");

    assert!(matches!(
        manager
            .descriptor(descriptor.profile_id(), &workspace)
            .expect("descriptor while reserved")
            .cleanup_state(),
        ProfileCleanupState::Stopped
    ));
    let independent = BrowserProfileManager::new(
        temp.path().join("login/profile-state"),
        temp.path().join("login/cef"),
    )
    .expect("independent manager");
    assert!(matches!(
        independent.reserve_embedded_launch(descriptor.profile_id(), &workspace),
        Err(ProfileError::ProfileInUse)
    ));

    drop(reservation);
    let lease = independent
        .acquire_launch_lease(descriptor.profile_id(), &workspace)
        .expect("reservation drop releases profile");
    let ownership_id = lease.ownership_id().to_string();
    lease
        .release_after_ownership_domain_gone(proof(&ownership_id))
        .expect("release verification lease");
}

#[test]
fn embedded_reservation_commits_the_pre_generated_ownership_id_once() {
    let (_temp, manager) = manager();
    let workspace = workspace("workspace-embedded-commit-001");
    let descriptor = manager.create_profile(&workspace).expect("create profile");
    let reservation = manager
        .reserve_embedded_launch(descriptor.profile_id(), &workspace)
        .expect("reserve stopped profile");
    let expected_ownership_id = reservation.ownership_id().to_string();
    let (lease, launch_proof) = reservation
        .commit_launch_pending()
        .expect("commit LaunchPending");

    assert_eq!(lease.ownership_id(), expected_ownership_id);
    assert_eq!(launch_proof.ownership_id(), expected_ownership_id);
    assert_eq!(launch_proof.profile_id(), descriptor.profile_id());
    assert_eq!(launch_proof.workspace_identity(), workspace.as_str());
    assert!(matches!(
        lease.descriptor().cleanup_state(),
        ProfileCleanupState::LaunchPending { ownership_id, .. }
            if ownership_id == &expected_ownership_id
    ));

    lease
        .release_after_ownership_domain_gone(proof(&expected_ownership_id))
        .expect("release committed lease");
}

#[cfg(unix)]
#[test]
fn embedded_terminal_release_retains_lease_after_persistence_failure_for_retry() {
    let (_temp, manager) = manager();
    let workspace = workspace("workspace-embedded-release-retry-001");
    let descriptor = manager.create_profile(&workspace).expect("create profile");
    let reservation = manager
        .reserve_embedded_launch(descriptor.profile_id(), &workspace)
        .expect("reserve stopped profile");
    let (mut lease, _launch_proof) = reservation
        .commit_launch_pending()
        .expect("commit LaunchPending");
    let ownership_id = lease.ownership_id().to_string();
    let profile_dir = lease.profile_dir.clone();
    let displaced = profile_dir.with_extension("release-retry-fixture");
    fs::rename(&profile_dir, &displaced).expect("temporarily displace profile directory");

    let first = lease.try_release_embedded_after_ownership_domain_gone(
        OwnershipDomainGone::from_closed_cef_surface(ownership_id.clone())
            .expect("closed surface proof"),
    );
    assert!(matches!(first, Err(ProfileError::Io(_))));
    assert!(
        lease.lock_file.is_some(),
        "failed release must retain the OS lease"
    );
    assert!(matches!(
        lease.descriptor.cleanup_state(),
        ProfileCleanupState::LaunchPending { ownership_id: current, .. }
            if current == &ownership_id
    ));

    fs::rename(&displaced, &profile_dir).expect("restore profile directory");
    lease
        .try_release_embedded_after_ownership_domain_gone(
            OwnershipDomainGone::from_closed_cef_surface(ownership_id)
                .expect("retry closed surface proof"),
        )
        .expect("retry terminal release");
    assert!(lease.lock_file.is_none());
    assert!(matches!(
        lease.descriptor.cleanup_state(),
        ProfileCleanupState::Stopped
    ));
}

#[test]
fn independent_manager_cannot_take_the_same_profile_lock() {
    let (_temp, manager) = manager();
    let second = BrowserProfileManager::new(
        manager.root().to_path_buf(),
        manager.cef_cache_root().to_path_buf(),
    )
    .expect("second manager over same root");
    let workspace = workspace("workspace-cross-manager-001");
    let descriptor = manager.create_profile(&workspace).expect("create profile");
    let cef_profile_dir = manager
        .checked_cef_profile_dir(descriptor.profile_id())
        .expect("CEF profile path");
    fs::create_dir(&cef_profile_dir).expect("create CEF profile cache");
    let cef_marker = cef_profile_dir.join("Cookies");
    fs::write(&cef_marker, b"locked").expect("write locked CEF marker");
    let lease = manager
        .acquire_launch_lease(descriptor.profile_id(), &workspace)
        .expect("first process-style lease");
    assert!(matches!(
        second.acquire_launch_lease(descriptor.profile_id(), &workspace),
        Err(ProfileError::ProfileInUse)
    ));
    let reset = authorization(DestructiveProfileAction::Reset, &descriptor, &workspace);
    assert!(matches!(
        second.reset_profile(reset),
        Err(ProfileError::ProfileInUse)
    ));
    let delete = authorization(DestructiveProfileAction::Delete, &descriptor, &workspace);
    assert!(matches!(
        second.delete_profile(delete),
        Err(ProfileError::ProfileInUse)
    ));
    assert!(cef_marker.exists());
    let ownership_id = lease.ownership_id().to_string();
    lease
        .release_after_ownership_domain_gone(proof(&ownership_id))
        .expect("release first lease");
}

#[test]
fn workspace_identity_mismatch_fails_closed() {
    let (_temp, manager) = manager();
    let owner = workspace("workspace-owner-001");
    let other = workspace("workspace-other-001");
    let descriptor = manager.create_profile(&owner).expect("create profile");

    assert!(matches!(
        manager.descriptor(descriptor.profile_id(), &other),
        Err(ProfileError::WorkspaceMismatch)
    ));
    assert!(matches!(
        manager.acquire_launch_lease(descriptor.profile_id(), &other),
        Err(ProfileError::WorkspaceMismatch)
    ));
    assert!(manager.descriptor(descriptor.profile_id(), &owner).is_ok());
}

#[cfg(unix)]
#[test]
fn profile_symlink_escape_is_rejected() {
    use std::os::unix::fs::symlink;

    let (temp, manager) = manager();
    let workspace = workspace("workspace-symlink-001");
    let descriptor = manager.create_profile(&workspace).expect("create profile");
    let profile_dir = manager.profiles_root.join(descriptor.profile_id().as_str());
    fs::remove_dir_all(&profile_dir).expect("remove owned profile for attack fixture");
    let outside = temp.path().join("outside");
    fs::create_dir(&outside).expect("outside directory");
    symlink(&outside, &profile_dir).expect("replace profile with symlink");

    assert!(matches!(
        manager.descriptor(descriptor.profile_id(), &workspace),
        Err(ProfileError::UnsafePath(_))
    ));
}

#[test]
fn metadata_roundtrip_tracks_runtime_compatibility_and_cleanup() {
    let (_temp, manager) = manager();
    let workspace = workspace("workspace-roundtrip-001");
    let descriptor = manager.create_profile(&workspace).expect("create profile");
    let mut lease = manager
        .acquire_launch_lease(descriptor.profile_id(), &workspace)
        .expect("launch lease");
    let ownership_id = lease.ownership_id().to_string();
    let owned = lease
        .mark_runtime_owned("runtime-001", "150.0.7871.115", "1.3")
        .expect("persist runtime ownership");
    assert!(owned.last_used_at().is_some());
    assert_eq!(
        owned
            .runtime_compatibility()
            .last_runtime_version
            .as_deref(),
        Some("150.0.7871.115")
    );
    assert!(matches!(
        owned.cleanup_state(),
        ProfileCleanupState::RuntimeOwned { runtime_id, .. } if runtime_id == "runtime-001"
    ));

    let stopped = lease
        .release_after_ownership_domain_gone(proof(&ownership_id))
        .expect("release owned runtime");
    assert!(matches!(
        stopped.cleanup_state(),
        ProfileCleanupState::Stopped
    ));
    let reloaded = manager
        .descriptor(descriptor.profile_id(), &workspace)
        .expect("reload descriptor");
    assert_eq!(reloaded, stopped);
}

#[test]
fn reset_and_delete_require_trusted_authorization_and_stopped_profile() {
    let (_temp, manager) = manager();
    let workspace = workspace("workspace-destructive-001");
    let descriptor = manager.create_profile(&workspace).expect("create profile");
    let cef_profile_dir = manager
        .checked_cef_profile_dir(descriptor.profile_id())
        .expect("CEF profile path");
    fs::create_dir(&cef_profile_dir).expect("create CEF profile cache");
    let cef_marker = cef_profile_dir.join("Cookies");
    fs::write(&cef_marker, b"private CEF session").expect("write CEF reset marker");
    let lease = manager
        .acquire_launch_lease(descriptor.profile_id(), &workspace)
        .expect("launch lease");
    let reset = authorization(DestructiveProfileAction::Reset, &descriptor, &workspace);
    assert!(matches!(
        manager.reset_profile(reset),
        Err(ProfileError::ProfileInUse)
    ));
    let delete = authorization(DestructiveProfileAction::Delete, &descriptor, &workspace);
    assert!(matches!(
        manager.delete_profile(delete),
        Err(ProfileError::ProfileInUse)
    ));
    assert!(cef_marker.exists());
    let ownership_id = lease.ownership_id().to_string();
    drop(lease);
    let reset = authorization(DestructiveProfileAction::Reset, &descriptor, &workspace);
    assert!(matches!(
        manager.reset_profile(reset),
        Err(ProfileError::ProfileNotStopped)
    ));
    let delete = authorization(DestructiveProfileAction::Delete, &descriptor, &workspace);
    assert!(matches!(
        manager.delete_profile(delete),
        Err(ProfileError::ProfileNotStopped)
    ));
    assert!(cef_marker.exists());
    manager
        .recover_after_ownership_domain_gone(
            descriptor.profile_id(),
            &workspace,
            proof(&ownership_id),
        )
        .expect("stop profile after supervisor proof");

    let profile_dir = manager.profiles_root.join(descriptor.profile_id().as_str());
    let marker = profile_dir.join("user-data").join("cookie-marker");
    fs::write(&marker, b"private session").expect("write reset marker");
    let wrong_action = authorization(DestructiveProfileAction::Delete, &descriptor, &workspace);
    assert!(matches!(
        manager.reset_profile(wrong_action),
        Err(ProfileError::DestructiveActionMismatch)
    ));
    let reset = authorization(DestructiveProfileAction::Reset, &descriptor, &workspace);
    let reset_descriptor = manager.reset_profile(reset).expect("reset stopped profile");
    assert!(!marker.exists());
    assert!(!cef_marker.exists());
    assert!(cef_profile_dir.is_dir());
    assert!(matches!(
        reset_descriptor.cleanup_state(),
        ProfileCleanupState::Stopped
    ));

    let delete = authorization(
        DestructiveProfileAction::Delete,
        &reset_descriptor,
        &workspace,
    );
    let cef_delete_marker = cef_profile_dir.join("Cookies");
    fs::write(&cef_delete_marker, b"delete CEF session").expect("write CEF delete marker");
    manager
        .delete_profile(delete)
        .expect("delete stopped profile");
    assert!(!profile_dir.exists());
    assert!(!cef_profile_dir.exists());
}

#[test]
fn manager_rejects_a_cef_root_outside_the_profile_state_sibling() {
    let temp = tempfile::tempdir().expect("profile root fixture");
    let result = BrowserProfileManager::new(
        temp.path().join("login/profile-state"),
        temp.path().join("outside/cef"),
    );
    assert!(matches!(result, Err(ProfileError::UnsafePath(_))));
    assert!(!temp.path().join("outside").exists());

    let shared = temp.path().join("login/cef");
    let result = BrowserProfileManager::new(shared.clone(), shared);
    assert!(matches!(result, Err(ProfileError::UnsafePath(_))));
}

#[cfg(unix)]
#[test]
fn destructive_operations_reject_a_cef_profile_symlink_without_touching_its_target() {
    use std::os::unix::fs::symlink;

    let (temp, manager) = manager();
    let workspace = workspace("workspace-cef-symlink-001");
    let descriptor = manager.create_profile(&workspace).expect("create profile");
    let profile_dir = manager.profiles_root.join(descriptor.profile_id().as_str());
    let cef_profile_dir = manager
        .checked_cef_profile_dir(descriptor.profile_id())
        .expect("CEF profile path");
    let outside = temp.path().join("outside-cef-profile");
    fs::create_dir(&outside).expect("outside CEF directory");
    let outside_marker = outside.join("Cookies");
    fs::write(&outside_marker, b"must survive").expect("outside marker");
    symlink(&outside, &cef_profile_dir).expect("CEF profile symlink fixture");

    let reset = authorization(DestructiveProfileAction::Reset, &descriptor, &workspace);
    assert!(matches!(
        manager.reset_profile(reset),
        Err(ProfileError::UnsafePath(_))
    ));
    assert!(outside_marker.exists());
    assert!(matches!(
        manager
            .descriptor(descriptor.profile_id(), &workspace)
            .expect("profile remains after rejected reset")
            .cleanup_state(),
        ProfileCleanupState::Stopped
    ));

    let delete = authorization(DestructiveProfileAction::Delete, &descriptor, &workspace);
    assert!(matches!(
        manager.delete_profile(delete),
        Err(ProfileError::UnsafePath(_))
    ));
    assert!(outside_marker.exists());
    assert!(profile_dir.is_dir());
}

#[cfg(unix)]
#[test]
fn destructive_operations_reject_a_replaced_cef_root_symlink() {
    use std::os::unix::fs::symlink;

    let (temp, manager) = manager();
    let workspace = workspace("workspace-cef-root-symlink-001");
    let descriptor = manager.create_profile(&workspace).expect("create profile");
    fs::remove_dir(manager.cef_cache_root()).expect("remove empty CEF root");
    let outside = temp.path().join("outside-cef-root");
    fs::create_dir(&outside).expect("outside CEF root");
    let outside_marker = outside.join("must-survive");
    fs::write(&outside_marker, b"outside").expect("outside root marker");
    symlink(&outside, manager.cef_cache_root()).expect("replace CEF root with symlink");

    let reset = authorization(DestructiveProfileAction::Reset, &descriptor, &workspace);
    assert!(matches!(
        manager.reset_profile(reset),
        Err(ProfileError::UnsafePath(_))
    ));
    let delete = authorization(DestructiveProfileAction::Delete, &descriptor, &workspace);
    assert!(matches!(
        manager.delete_profile(delete),
        Err(ProfileError::UnsafePath(_))
    ));
    assert!(outside_marker.exists());
}

#[test]
fn descriptor_generations_ignore_uncommitted_temp_files() {
    let (_temp, manager) = manager();
    let workspace = workspace("workspace-atomic-001");
    let descriptor = manager.create_profile(&workspace).expect("create profile");
    let profile_dir = manager.profiles_root.join(descriptor.profile_id().as_str());
    fs::write(profile_dir.join(".profile-uncommitted.tmp"), b"{")
        .expect("write interrupted temp generation");
    assert_eq!(
        manager
            .descriptor(descriptor.profile_id(), &workspace)
            .expect("load committed generation"),
        descriptor
    );
}

#[test]
fn destructive_cleanup_states_resume_only_with_fresh_trusted_authorization() {
    let (_temp, manager) = manager();
    let workspace = workspace("workspace-destructive-retry-001");
    let descriptor = manager.create_profile(&workspace).expect("create profile");
    let cef_profile_dir = manager
        .checked_cef_profile_dir(descriptor.profile_id())
        .expect("CEF profile path");
    fs::create_dir(&cef_profile_dir).expect("create interrupted CEF cache");
    let cef_marker = cef_profile_dir.join("Cookies");
    fs::write(&cef_marker, b"stale session").expect("write interrupted CEF marker");

    let mut reset_interrupted = manager
        .acquire_maintenance_lock(descriptor.profile_id(), &workspace)
        .expect("lock interrupted reset fixture");
    reset_interrupted.descriptor.cleanup_state = ProfileCleanupState::Resetting {
        authorization_id: "destructive-prior-reset".to_string(),
        since: Utc::now().to_rfc3339(),
    };
    reset_interrupted
        .persist()
        .expect("persist interrupted reset");
    drop(reset_interrupted);

    let cef_tombstone = manager.cef_cache_root.join(format!(
        "Profile-{}.reset-destructive-prior-reset",
        descriptor.profile_id().as_str()
    ));
    fs::rename(&cef_profile_dir, &cef_tombstone).expect("stage interrupted CEF reset");
    fs::create_dir(&cef_profile_dir).expect("create partial replacement CEF cache");
    let partial_cef_marker = cef_profile_dir.join("partial-Cookies");
    fs::write(&partial_cef_marker, b"partial reset").expect("write partial CEF marker");

    let reset = authorization(DestructiveProfileAction::Reset, &descriptor, &workspace);
    let reset_descriptor = manager.reset_profile(reset).expect("resume trusted reset");
    assert!(matches!(
        reset_descriptor.cleanup_state(),
        ProfileCleanupState::Stopped
    ));
    assert!(!cef_marker.exists());
    assert!(!partial_cef_marker.exists());
    assert!(!cef_tombstone.exists());
    assert!(cef_profile_dir.is_dir());

    let mut delete_interrupted = manager
        .acquire_maintenance_lock(descriptor.profile_id(), &workspace)
        .expect("lock interrupted delete fixture");
    delete_interrupted.descriptor.cleanup_state = ProfileCleanupState::Deleting {
        authorization_id: "destructive-prior-delete".to_string(),
        since: Utc::now().to_rfc3339(),
    };
    delete_interrupted
        .persist()
        .expect("persist interrupted delete");
    drop(delete_interrupted);

    let delete = authorization(
        DestructiveProfileAction::Delete,
        &reset_descriptor,
        &workspace,
    );
    manager
        .delete_profile(delete)
        .expect("resume trusted deletion");
    assert!(matches!(
        manager.descriptor(descriptor.profile_id(), &workspace),
        Err(ProfileError::ProfileNotFound(_))
    ));
    assert!(!cef_profile_dir.exists());
}
