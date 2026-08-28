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
fn profile_transactions_use_the_cfg_aware_directory_sync_contract() {
    let profile_source = include_str!("profile.rs");
    let default_source = include_str!("profile_default.rs");
    let storage_source = include_str!("profile_storage.rs");
    assert!(!profile_source.contains("File::open(&maintenance.profile_dir)"));
    assert!(!profile_source.contains("File::open(&self.cef_cache_root)"));
    assert!(!profile_source.contains("File::open(&self.profiles_root)"));
    assert!(!default_source.contains("std::fs::File::open(&self.default_profile_root)"));
    assert!(!default_source.contains("std::fs::File::open(&self.profiles_root)"));
    assert!(storage_source.contains("#[cfg(unix)]\npub(super) fn sync_directory"));
    assert!(storage_source.contains("#[cfg(not(unix))]\npub(super) fn sync_directory"));
}

fn write_pending_default_binding(
    manager: &BrowserProfileManager,
    revision: u64,
    profile_id: &ProfileId,
    owner: &TrustedWorkspaceIdentity,
) {
    let path = manager
        .default_profile_root
        .join(format!("default-{revision:020}.json"));
    let bytes = serde_json::to_vec_pretty(&serde_json::json!({
        "schema_version": 1,
        "revision": revision,
        "profile_id": profile_id,
        "pending_owner_identity": owner.as_str(),
    }))
    .expect("serialize pending default binding");
    write_private_new_file(&path, &bytes).expect("persist pending default binding fixture");
}

fn pending_default_staging_dir(manager: &BrowserProfileManager, profile_id: &ProfileId) -> PathBuf {
    manager
        .profiles_root
        .join(format!(".default-pending-{}", profile_id.as_str()))
}

#[cfg(unix)]
#[test]
fn failed_default_intent_write_never_leaves_an_unbound_legacy_candidate() {
    use std::os::unix::fs::PermissionsExt;

    let (_temp, manager) = manager();
    let owner = workspace("workspace-default-intent-write-failure");
    fs::set_permissions(
        &manager.default_profile_root,
        fs::Permissions::from_mode(0o500),
    )
    .expect("make default binding directory read-only");

    let result = manager.global_default_profile(&owner, true);
    fs::set_permissions(
        &manager.default_profile_root,
        fs::Permissions::from_mode(0o700),
    )
    .expect("restore default binding directory permissions");

    assert!(matches!(result, Err(ProfileError::Io(_))));
    assert!(
        manager.list_all_profiles().unwrap().is_empty(),
        "a failed pending-intent write must happen before any profile record exists"
    );
    assert!(manager
        .global_default_profile(&owner, false)
        .expect("inspect default after failed intent")
        .is_none());
}

#[test]
fn pending_default_recovers_the_exact_id_from_every_creation_crash_window() {
    for stage in 0..3 {
        let temp = tempfile::tempdir().expect("pending default crash fixture");
        let profile_state_root = temp.path().join("login/profile-state");
        let cef_cache_root = temp.path().join("login/cef");
        let manager =
            BrowserProfileManager::new(profile_state_root.clone(), cef_cache_root.clone())
                .expect("create browser profile manager");
        let owner = workspace(&format!("workspace-pending-default-owner-{stage}"));
        let sibling_owner = workspace(&format!("workspace-pending-default-sibling-{stage}"));
        let sibling = manager
            .create_profile_record(&sibling_owner)
            .expect("create isolated sibling fixture");
        let pending_id = if stage >= 2 {
            manager
                .create_profile_record(&owner)
                .expect("finish exact profile before bound generation")
                .profile_id()
                .clone()
        } else {
            ProfileId::generate()
        };
        write_pending_default_binding(&manager, 1, &pending_id, &owner);

        if stage >= 1 {
            let staging = pending_default_staging_dir(&manager, &pending_id);
            fs::create_dir(&staging).expect("create partial pending staging directory");
            fs::write(staging.join("partial-secret"), b"must not survive recovery")
                .expect("write partial pending staging marker");
        }
        drop(manager);

        let restarted = BrowserProfileManager::new(profile_state_root, cef_cache_root)
            .expect("restart browser profile manager");
        let recovered = restarted
            .global_default_profile(&workspace("workspace-pending-default-reader"), false)
            .expect("recover pending global default")
            .expect("pending global default descriptor");
        assert_eq!(recovered.profile_id(), &pending_id);
        assert_eq!(recovered.workspace_identity(), owner.as_str());
        assert_ne!(recovered.profile_id(), sibling.profile_id());
        assert!(matches!(
            recovered.cleanup_state(),
            ProfileCleanupState::Stopped
        ));
        assert!(!pending_default_staging_dir(&restarted, &pending_id).exists());
        assert_eq!(restarted.list_all_profiles().unwrap().len(), 2);
        assert!(restarted.is_global_default(&pending_id).unwrap());

        let mut generations = fs::read_dir(&restarted.default_profile_root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.starts_with("default-") && name.ends_with(".json"))
            })
            .collect::<Vec<_>>();
        generations.sort_by_key(|entry| entry.file_name());
        assert_eq!(generations.len(), 2, "binding recovery must append");
        let pending: serde_json::Value =
            serde_json::from_slice(&fs::read(generations[0].path()).unwrap()).unwrap();
        let bound: serde_json::Value =
            serde_json::from_slice(&fs::read(generations[1].path()).unwrap()).unwrap();
        assert_eq!(
            pending["pending_owner_identity"],
            serde_json::Value::String(owner.as_str().to_string())
        );
        assert_eq!(
            bound["profile_id"],
            serde_json::Value::String(pending_id.as_str().to_string())
        );
        assert!(bound.get("pending_owner_identity").is_none());
    }
}

#[test]
fn pending_default_exact_record_must_match_owner_and_be_stopped() {
    let (_temp, manager) = manager();
    let intended_owner = workspace("workspace-pending-default-intended-owner");
    let wrong_owner = workspace("workspace-pending-default-wrong-owner");
    let wrong_descriptor = manager
        .create_profile_record(&wrong_owner)
        .expect("create wrong-owner exact record");
    write_pending_default_binding(&manager, 1, wrong_descriptor.profile_id(), &intended_owner);
    assert!(matches!(
        manager.global_default_profile(&intended_owner, true),
        Err(ProfileError::CorruptMetadata(_))
    ));
    assert!(!manager
        .is_global_default(wrong_descriptor.profile_id())
        .unwrap_or(false));

    let temp = tempfile::tempdir().expect("pending non-stopped fixture");
    let second = BrowserProfileManager::new(
        temp.path().join("login/profile-state"),
        temp.path().join("login/cef"),
    )
    .expect("create second browser profile manager");
    let owner = workspace("workspace-pending-default-non-stopped");
    let descriptor = second
        .create_profile_record(&owner)
        .expect("create exact pending profile");
    let lease = second
        .acquire_launch_lease(descriptor.profile_id(), &owner)
        .expect("mark exact pending profile non-stopped");
    write_pending_default_binding(&second, 1, descriptor.profile_id(), &owner);
    assert!(matches!(
        second.global_default_profile(&owner, true),
        Err(ProfileError::CorruptMetadata(_))
    ));
    drop(lease);
}

#[cfg(unix)]
#[test]
fn pending_default_recovery_rejects_a_symlinked_staging_directory() {
    use std::os::unix::fs::symlink;

    let (temp, manager) = manager();
    let owner = workspace("workspace-pending-default-staging-symlink");
    let pending_id = ProfileId::generate();
    write_pending_default_binding(&manager, 1, &pending_id, &owner);
    let outside = temp.path().join("outside-pending-default");
    fs::create_dir(&outside).expect("create outside staging target");
    let outside_marker = outside.join("must-survive");
    fs::write(&outside_marker, b"outside").expect("write outside marker");
    symlink(&outside, pending_default_staging_dir(&manager, &pending_id))
        .expect("replace pending staging with symlink");

    assert!(matches!(
        manager.global_default_profile(&owner, true),
        Err(ProfileError::UnsafePath(_))
    ));
    assert!(outside_marker.exists());
    assert!(matches!(
        manager.global_default_profile(&owner, false),
        Err(ProfileError::UnsafePath(_))
    ));
}

#[test]
fn global_default_migrates_existing_profile_in_place_and_survives_manager_restart() {
    let (temp, manager) = manager();
    let workspace_a = workspace("workspace-global-migration-a");
    let workspace_b = workspace("workspace-global-migration-b");
    // Simulate profile directories written by the pre-global-default release, before any binding
    // generation existed.
    let legacy_a = manager
        .create_profile_record(&workspace_a)
        .expect("legacy workspace A profile");
    let legacy_b = manager
        .create_profile_record(&workspace_b)
        .expect("legacy workspace B profile");
    let expected = manager
        .list_profiles(&workspace_b)
        .expect("requesting workspace legacy profiles")
        .into_iter()
        .next()
        .expect("requesting workspace migration candidate");
    let expected_profile_dir = manager.profiles_root.join(expected.profile_id().as_str());
    let user_data_marker = expected_profile_dir.join("user-data/login-cookie-marker");
    fs::write(&user_data_marker, b"legacy login state").expect("legacy user-data marker");
    let cef_profile_dir = manager
        .checked_cef_profile_dir(expected.profile_id())
        .expect("legacy CEF profile path");
    fs::create_dir(&cef_profile_dir).expect("legacy CEF profile cache");
    let cef_marker = cef_profile_dir.join("Cookies");
    fs::write(&cef_marker, b"legacy CEF login state").expect("legacy CEF marker");

    let migrated = manager
        .global_default_profile(&workspace_b, false)
        .expect("migrate legacy default")
        .expect("existing profile becomes global default");
    assert_eq!(migrated.profile_id(), expected.profile_id());
    assert_eq!(
        migrated.owner_identity().unwrap(),
        expected.owner_identity().unwrap()
    );
    assert!(user_data_marker.exists());
    assert!(cef_marker.exists());
    assert!(manager
        .profiles_root
        .join(legacy_a.profile_id().as_str())
        .is_dir());
    assert!(manager
        .profiles_root
        .join(legacy_b.profile_id().as_str())
        .is_dir());

    let restarted = BrowserProfileManager::new(
        temp.path().join("login/profile-state"),
        temp.path().join("login/cef"),
    )
    .expect("restart profile manager");
    let reopened = restarted
        .global_default_profile(&workspace_a, true)
        .expect("reload global default")
        .expect("persisted global default");
    assert_eq!(reopened.profile_id(), expected.profile_id());
    let isolated = restarted
        .create_profile(&workspace_b)
        .expect("explicit isolated profile");
    assert_ne!(isolated.profile_id(), expected.profile_id());
    assert_eq!(
        restarted
            .global_default_profile(&workspace_b, true)
            .unwrap()
            .unwrap()
            .profile_id(),
        expected.profile_id(),
        "explicit profile creation must not replace the global default"
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let generation = fs::read_dir(&restarted.default_profile_root)
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.starts_with("default-") && name.ends_with(".json"))
            })
            .expect("private default binding generation");
        assert_eq!(
            generation.metadata().unwrap().permissions().mode() & 0o077,
            0
        );
    }
}

#[test]
fn clearing_global_default_never_promotes_an_explicit_profile() {
    let (_temp, manager) = manager();
    let workspace_a = workspace("workspace-global-clear-a");
    let workspace_b = workspace("workspace-global-clear-b");
    let default = manager
        .global_default_profile(&workspace_a, true)
        .unwrap()
        .expect("create global default");
    let isolated = manager
        .create_profile(&workspace_a)
        .expect("create explicit isolated profile");

    manager
        .delete_profile(authorization(
            DestructiveProfileAction::Delete,
            &default,
            &workspace_a,
        ))
        .expect("delete global default data");
    assert!(manager
        .clear_global_default(default.profile_id())
        .expect("publish empty global binding"));
    assert!(manager
        .global_default_profile(&workspace_b, false)
        .unwrap()
        .is_none());
    assert!(manager
        .descriptor(isolated.profile_id(), &workspace_a)
        .is_ok());

    let replacement = manager
        .global_default_profile(&workspace_b, true)
        .unwrap()
        .expect("create fresh global default");
    assert_ne!(replacement.profile_id(), isolated.profile_id());
    assert_eq!(replacement.workspace_identity(), workspace_b.as_str());
    assert!(manager.is_global_default(replacement.profile_id()).unwrap());
}

#[test]
fn first_explicit_profile_never_becomes_the_global_default() {
    let (_temp, manager) = manager();
    let workspace_a = workspace("workspace-explicit-first-a");
    let workspace_b = workspace("workspace-explicit-first-b");
    let isolated = manager
        .create_profile(&workspace_a)
        .expect("create first explicit profile");

    assert!(manager
        .global_default_profile(&workspace_b, false)
        .expect("inspect uninitialized global default")
        .is_none());
    let default = manager
        .global_default_profile(&workspace_b, true)
        .expect("create global default")
        .expect("global default descriptor");
    assert_ne!(default.profile_id(), isolated.profile_id());
    assert_eq!(default.workspace_identity(), workspace_b.as_str());
    assert!(manager
        .descriptor(isolated.profile_id(), &workspace_a)
        .is_ok());
}

#[test]
fn concurrent_managers_atomically_create_one_global_default() {
    let temp = tempfile::tempdir().expect("profile root fixture");
    let root = temp.path().join("login/profile-state");
    let cef = temp.path().join("login/cef");
    let first = BrowserProfileManager::new(root.clone(), cef.clone()).unwrap();
    let second = BrowserProfileManager::new(root.clone(), cef.clone()).unwrap();
    let workspace_a = workspace("workspace-global-race-a");
    let workspace_b = workspace("workspace-global-race-b");
    let barrier = Arc::new(std::sync::Barrier::new(3));

    let first_barrier = Arc::clone(&barrier);
    let first_worker = std::thread::spawn(move || {
        first_barrier.wait();
        first
            .global_default_profile(&workspace_a, true)
            .unwrap()
            .unwrap()
    });
    let second_barrier = Arc::clone(&barrier);
    let second_worker = std::thread::spawn(move || {
        second_barrier.wait();
        second
            .global_default_profile(&workspace_b, true)
            .unwrap()
            .unwrap()
    });
    barrier.wait();

    let first_default = first_worker.join().unwrap();
    let second_default = second_worker.join().unwrap();
    assert_eq!(first_default.profile_id(), second_default.profile_id());
    let restarted = BrowserProfileManager::new(root, cef).unwrap();
    assert_eq!(restarted.list_all_profiles().unwrap().len(), 1);
    assert_eq!(
        restarted
            .global_default_profile(&workspace("workspace-global-race-reader"), false)
            .unwrap()
            .unwrap()
            .profile_id(),
        first_default.profile_id()
    );
}

#[cfg(unix)]
#[test]
fn global_default_binding_rejects_a_symlink_generation() {
    use std::os::unix::fs::symlink;

    let (temp, manager) = manager();
    let outside = temp.path().join("outside-default.json");
    fs::write(
        &outside,
        br#"{"schema_version":1,"revision":1,"profile_id":null}"#,
    )
    .unwrap();
    symlink(
        &outside,
        manager
            .default_profile_root
            .join("default-00000000000000000001.json"),
    )
    .unwrap();

    assert!(matches!(
        manager.global_default_profile(&workspace("workspace-symlink-reader"), false),
        Err(ProfileError::UnsafePath(_))
    ));
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

#[test]
fn reset_restarts_safely_from_every_durable_cleanup_stage() {
    // Exercise every process-crash boundary after Resetting is durable: before either rename,
    // after each rename but before its replacement directory exists, after each replacement, and
    // after each tombstone deletion but before Stopped is committed.
    for stage in 0..7 {
        let temp = tempfile::tempdir().expect("profile reset crash-stage fixture");
        let profile_state_root = temp.path().join("login/profile-state");
        let cef_cache_root = temp.path().join("login/cef");
        let manager =
            BrowserProfileManager::new(profile_state_root.clone(), cef_cache_root.clone())
                .expect("create browser profile manager");
        let workspace = workspace(&format!("workspace-reset-crash-stage-{stage}"));
        let descriptor = manager.create_profile(&workspace).expect("create profile");
        let profile_dir = manager.profiles_root.join(descriptor.profile_id().as_str());
        let user_data = profile_dir.join("user-data");
        let cef_profile_dir = manager
            .checked_cef_profile_dir(descriptor.profile_id())
            .expect("CEF profile path");
        fs::create_dir(&cef_profile_dir).expect("create CEF profile cache");
        let user_marker = user_data.join("Cookies");
        let cef_marker = cef_profile_dir.join("Cookies");
        fs::write(&user_marker, b"stale user-data token").expect("write user-data token");
        fs::write(&cef_marker, b"stale CEF token").expect("write CEF token");

        let reset_id = format!("destructive-crash-stage-{stage}");
        let mut interrupted = manager
            .acquire_maintenance_lock(descriptor.profile_id(), &workspace)
            .expect("lock interrupted reset fixture");
        interrupted.descriptor.cleanup_state = ProfileCleanupState::Resetting {
            authorization_id: reset_id.clone(),
            since: Utc::now().to_rfc3339(),
        };
        interrupted.persist().expect("persist reset intent");
        drop(interrupted);

        let user_tombstone = profile_dir.join(format!("user-data.reset-{reset_id}"));
        let cef_tombstone = cef_cache_root.join(format!(
            "Profile-{}.reset-{reset_id}",
            descriptor.profile_id().as_str()
        ));
        if stage >= 1 {
            fs::rename(&user_data, &user_tombstone).expect("stage user-data reset");
        }
        if stage >= 2 {
            fs::create_dir(&user_data).expect("create replacement user-data");
        }
        if stage >= 3 {
            fs::rename(&cef_profile_dir, &cef_tombstone).expect("stage CEF reset");
        }
        if stage >= 4 {
            fs::create_dir(&cef_profile_dir).expect("create replacement CEF cache");
        }
        if stage >= 5 {
            fs::remove_dir_all(&user_tombstone).expect("delete user-data tombstone");
        }
        if stage >= 6 {
            fs::remove_dir_all(&cef_tombstone).expect("delete CEF tombstone");
        }
        drop(manager);

        let restarted = BrowserProfileManager::new(profile_state_root, cef_cache_root)
            .expect("restart browser profile manager");
        assert!(matches!(
            restarted
                .descriptor(descriptor.profile_id(), &workspace)
                .expect("reload interrupted descriptor")
                .cleanup_state(),
            ProfileCleanupState::Resetting { authorization_id, .. }
                if authorization_id == &reset_id
        ));
        assert!(matches!(
            restarted.acquire_launch_lease(descriptor.profile_id(), &workspace),
            Err(ProfileError::ProfileRequiresCleanup)
        ));

        let reset = authorization(DestructiveProfileAction::Reset, &descriptor, &workspace);
        let recovered = restarted
            .reset_profile(reset)
            .expect("resume reset after process restart");
        assert!(matches!(
            recovered.cleanup_state(),
            ProfileCleanupState::Stopped
        ));
        assert!(user_data.is_dir());
        assert!(cef_profile_dir.is_dir());
        assert!(!user_marker.exists());
        assert!(!cef_marker.exists());
        assert!(!user_tombstone.exists());
        assert!(!cef_tombstone.exists());
    }
}

#[cfg(unix)]
#[test]
fn reset_cleanup_failure_stays_retryable_until_both_tombstones_are_deleted() {
    use std::os::unix::fs::PermissionsExt;

    let (temp, manager) = manager();
    let workspace = workspace("workspace-reset-cleanup-retry-001");
    let descriptor = manager.create_profile(&workspace).expect("create profile");
    let profile_dir = manager.profiles_root.join(descriptor.profile_id().as_str());
    let user_data = profile_dir.join("user-data");
    fs::write(user_data.join("Cookies"), b"stale user-data token").expect("write user-data token");
    let cef_profile_dir = manager
        .checked_cef_profile_dir(descriptor.profile_id())
        .expect("CEF profile path");
    fs::create_dir(&cef_profile_dir).expect("create CEF profile cache");
    let protected = cef_profile_dir.join("protected");
    fs::create_dir(&protected).expect("create protected CEF child");
    fs::write(protected.join("token"), b"stale CEF token").expect("write protected CEF token");
    fs::set_permissions(&protected, fs::Permissions::from_mode(0o500))
        .expect("make tombstone cleanup fail");

    let error = manager
        .reset_profile(authorization(
            DestructiveProfileAction::Reset,
            &descriptor,
            &workspace,
        ))
        .expect_err("protected tombstone must reject reset completion");
    assert!(matches!(error, ProfileError::Io(_)));
    assert!(
        !error
            .to_string()
            .contains(&temp.path().display().to_string()),
        "reset errors must not expose the private profile path"
    );

    let interrupted = manager
        .descriptor(descriptor.profile_id(), &workspace)
        .expect("reload failed reset descriptor");
    let reset_id = match interrupted.cleanup_state() {
        ProfileCleanupState::Resetting {
            authorization_id, ..
        } => authorization_id.clone(),
        state => panic!("failed cleanup must remain Resetting, got {state:?}"),
    };
    assert!(matches!(
        manager.acquire_launch_lease(descriptor.profile_id(), &workspace),
        Err(ProfileError::ProfileRequiresCleanup)
    ));
    let cef_tombstone = manager.cef_cache_root.join(format!(
        "Profile-{}.reset-{reset_id}",
        descriptor.profile_id().as_str()
    ));
    assert!(cef_tombstone.is_dir());
    fs::set_permissions(
        cef_tombstone.join("protected"),
        fs::Permissions::from_mode(0o700),
    )
    .expect("restore tombstone permissions");
    let profile_state_root = manager.root().to_path_buf();
    let cef_cache_root = manager.cef_cache_root().to_path_buf();
    drop(manager);

    let restarted = BrowserProfileManager::new(profile_state_root, cef_cache_root)
        .expect("restart browser profile manager");
    let recovered = restarted
        .reset_profile(authorization(
            DestructiveProfileAction::Reset,
            &descriptor,
            &workspace,
        ))
        .expect("retry reset with fresh trusted authorization");
    assert!(matches!(
        recovered.cleanup_state(),
        ProfileCleanupState::Stopped
    ));
    assert!(!cef_tombstone.exists());
    assert!(restarted
        .cef_cache_root
        .join(format!("Profile-{}", descriptor.profile_id().as_str()))
        .is_dir());
}
