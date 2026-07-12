use super::*;
use std::fs;

fn workspace(id: &str) -> TrustedWorkspaceIdentity {
    TrustedWorkspaceIdentity::from_trusted_store(id).expect("trusted workspace identity")
}

fn manager() -> (tempfile::TempDir, BrowserProfileManager) {
    let temp = tempfile::tempdir().expect("temporary browser profile root");
    let manager = BrowserProfileManager::new(temp.path().join("login"))
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
    assert!(profile_dir.join("user-data").is_dir());
    assert!(profile_dir.join("profile.lock").is_file());
    assert!(profile_dir.join(metadata_file_name(1)).is_file());

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
fn independent_manager_cannot_take_the_same_profile_lock() {
    let (_temp, manager) = manager();
    let second = BrowserProfileManager::new(manager.root().to_path_buf())
        .expect("second manager over same root");
    let workspace = workspace("workspace-cross-manager-001");
    let descriptor = manager.create_profile(&workspace).expect("create profile");
    let lease = manager
        .acquire_launch_lease(descriptor.profile_id(), &workspace)
        .expect("first process-style lease");
    assert!(matches!(
        second.acquire_launch_lease(descriptor.profile_id(), &workspace),
        Err(ProfileError::ProfileInUse)
    ));
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
    let lease = manager
        .acquire_launch_lease(descriptor.profile_id(), &workspace)
        .expect("launch lease");
    let reset = authorization(DestructiveProfileAction::Reset, &descriptor, &workspace);
    assert!(matches!(
        manager.reset_profile(reset),
        Err(ProfileError::ProfileInUse)
    ));
    let ownership_id = lease.ownership_id().to_string();
    drop(lease);
    let reset = authorization(DestructiveProfileAction::Reset, &descriptor, &workspace);
    assert!(matches!(
        manager.reset_profile(reset),
        Err(ProfileError::ProfileNotStopped)
    ));
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
    assert!(matches!(
        reset_descriptor.cleanup_state(),
        ProfileCleanupState::Stopped
    ));

    let delete = authorization(
        DestructiveProfileAction::Delete,
        &reset_descriptor,
        &workspace,
    );
    manager
        .delete_profile(delete)
        .expect("delete stopped profile");
    assert!(!profile_dir.exists());
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

    let reset = authorization(DestructiveProfileAction::Reset, &descriptor, &workspace);
    let reset_descriptor = manager.reset_profile(reset).expect("resume trusted reset");
    assert!(matches!(
        reset_descriptor.cleanup_state(),
        ProfileCleanupState::Stopped
    ));

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
}
