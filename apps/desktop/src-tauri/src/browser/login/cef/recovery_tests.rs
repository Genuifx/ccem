use super::*;

#[derive(Clone)]
enum Inspection {
    Identity(Option<EmbeddedHostProcessIdentity>),
    Failed,
}

struct FakeInspector(Inspection);

impl EmbeddedHostInspector for FakeInspector {
    fn inspect(
        &self,
        _pid: u32,
    ) -> Result<Option<EmbeddedHostProcessIdentity>, EmbeddedOwnerRecoveryError> {
        match &self.0 {
            Inspection::Identity(identity) => Ok(identity.clone()),
            Inspection::Failed => Err(EmbeddedOwnerRecoveryError::InspectionFailed),
        }
    }
}

fn workspace() -> TrustedWorkspaceIdentity {
    TrustedWorkspaceIdentity::from_trusted_store("workspace-cef-recovery-001")
        .expect("trusted workspace")
}

fn host() -> EmbeddedHostProcessIdentity {
    EmbeddedHostProcessIdentity {
        pid: 4242,
        birth_token: "mac:100:200".to_string(),
        executable: PathBuf::from("/Applications/CCEM Desktop.app/Contents/MacOS/ccem-desktop"),
    }
}

fn fixture() -> (
    tempfile::TempDir,
    BrowserProfileManager,
    EmbeddedOwnerRecordStore,
) {
    let temp = tempfile::tempdir().expect("temporary recovery root");
    let manager = BrowserProfileManager::new(
        temp.path().join("login/profile-state"),
        temp.path().join("login/cef"),
    )
    .expect("profile manager");
    let store = EmbeddedOwnerRecordStore::from_identity(
        temp.path().join("login/embedded-owners"),
        "cef-host-11111111111111111111111111111111".to_string(),
        host(),
    )
    .expect("owner record store");
    (temp, manager, store)
}

fn stopped(manager: &BrowserProfileManager, profile_id: &ProfileId) -> bool {
    matches!(
        manager
            .descriptor(profile_id, &workspace())
            .expect("profile descriptor")
            .cleanup_state(),
        ProfileCleanupState::Stopped
    )
}

fn force_cleanup(manager: &BrowserProfileManager, profile_id: &ProfileId, ownership_id: &str) {
    let proof =
        OwnershipDomainGone::from_dead_cef_host(ownership_id.to_string()).expect("dead host proof");
    manager
        .recover_embedded_after_host_gone(profile_id, &workspace(), proof)
        .expect("force fixture cleanup");
}

#[test]
fn atomic_publish_replaces_an_existing_target_and_preserves_create_conflicts() {
    let temp = tempfile::tempdir().expect("temporary atomic publish root");
    let target = temp.path().join("owner.json");
    let replacement = temp.path().join("owner.replacement.json");
    fs::write(&target, b"revision-1").expect("write initial target");
    fs::write(&replacement, b"revision-2").expect("write replacement");

    atomic_publish(&replacement, &target, true).expect("atomically replace existing target");

    assert_eq!(
        fs::read(&target).expect("read replaced target"),
        b"revision-2"
    );
    assert!(!replacement.exists());

    let conflicting = temp.path().join("owner.conflicting.json");
    fs::write(&conflicting, b"revision-conflict").expect("write conflicting source");
    assert!(matches!(
        atomic_publish(&conflicting, &target, false),
        Err(EmbeddedOwnerRecoveryError::RecordConflict)
    ));
    assert_eq!(
        fs::read(&target).expect("read target after conflict"),
        b"revision-2"
    );
    assert!(conflicting.exists());
}

#[test]
fn windows_atomic_publish_contract_has_no_delete_then_rename_fallback() {
    let source = include_str!("recovery.rs");
    let windows_start = source
        .find("#[cfg(windows)]\nfn atomic_publish(")
        .expect("Windows atomic publish implementation");
    let fallback_start = source[windows_start..]
        .find("#[cfg(not(any(unix, windows)))]\nfn atomic_publish(")
        .map(|offset| windows_start + offset)
        .expect("non-Unix/non-Windows atomic publish fallback");
    let windows_implementation = &source[windows_start..fallback_start];

    assert!(windows_implementation.contains("MoveFileExW"));
    assert!(windows_implementation.contains("MOVEFILE_REPLACE_EXISTING"));
    assert!(windows_implementation.contains("MOVEFILE_WRITE_THROUGH"));
    assert!(windows_implementation.contains("GetLastError"));
    assert!(windows_implementation.contains("ERROR_ALREADY_EXISTS"));
    assert!(windows_implementation.contains("ERROR_FILE_EXISTS"));
    assert!(!windows_implementation.contains("target.exists()"));
    assert!(!windows_implementation.contains("remove_file"));
    assert!(!windows_implementation.contains("fs::rename"));
}

#[test]
fn record_is_atomic_private_and_explicitly_finishes_after_profile_release() {
    let (_temp, manager, store) = fixture();
    let descriptor = manager.create_profile(&workspace()).expect("profile");
    let surface_id = "login-1-lease-a";
    let reservation = manager
        .reserve_embedded_launch(descriptor.profile_id(), &workspace())
        .expect("embedded reservation");
    let mut owner = store
        .begin_profile_reservation(&reservation, surface_id)
        .expect("persist owner before LaunchPending");
    let record_id = owner.record_id().to_string();

    let reserved = store
        .load(&record_id)
        .expect("load reserved record")
        .expect("reserved record exists");
    assert_eq!(reserved.revision, 1);
    assert!(matches!(
        reserved.phase,
        EmbeddedOwnerPhase::ProfileReserved
    ));

    #[cfg(unix)]
    {
        assert_eq!(
            fs::metadata(store.path_for(&record_id).expect("record path"))
                .expect("record metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    let (mut lease, launch_pending_proof) = reservation
        .commit_launch_pending()
        .expect("commit LaunchPending");
    owner
        .mark_launch_pending(&launch_pending_proof)
        .expect("advance durable owner intent");
    let pending = store
        .load(&record_id)
        .expect("load pending record")
        .expect("pending record exists");
    assert_eq!(pending.revision, 2);
    assert!(matches!(
        pending.phase,
        EmbeddedOwnerPhase::NativeOpenPending
    ));

    let (_runtime_descriptor, runtime_proof) = lease
        .mark_embedded_runtime_owned(surface_id, "cef-test", "1")
        .expect("profile runtime-owned");
    owner
        .mark_runtime_owned(&runtime_proof)
        .expect("owner runtime-owned");
    assert!(matches!(
        owner.retry_finish_after_profile_release(),
        Err(EmbeddedOwnerRecoveryError::InvalidRecord)
    ));
    let running = store
        .load(&record_id)
        .expect("load running record")
        .expect("running record exists");
    assert_eq!(running.revision, 3);
    assert!(matches!(
        running.phase,
        EmbeddedOwnerPhase::RuntimeOwned { ref runtime_id } if runtime_id == surface_id
    ));

    let proof = OwnershipDomainGone::from_closed_cef_surface(lease.ownership_id().to_string())
        .expect("closed surface proof");
    let (_stopped_descriptor, release_proof) = lease
        .release_embedded_after_ownership_domain_gone(proof)
        .expect("release profile after close");
    owner
        .finish_after_profile_release(release_proof)
        .expect("delete owner record last");
    owner
        .retry_finish_after_profile_release()
        .expect("finished record deletion is idempotent");
    assert!(store
        .load(&record_id)
        .expect("load removed record")
        .is_none());
    assert!(stopped(&manager, descriptor.profile_id()));
}

#[test]
fn classifier_fails_closed_and_covers_both_crash_windows() {
    let (_temp, manager, store) = fixture();
    let descriptor = manager.create_profile(&workspace()).expect("profile");
    let surface_id = "login-2-lease-b";
    let reservation = manager
        .reserve_embedded_launch(descriptor.profile_id(), &workspace())
        .expect("reservation");
    let owner = store
        .begin_profile_reservation(&reservation, surface_id)
        .expect("reserved owner");
    let record = store
        .load(owner.record_id())
        .expect("load record")
        .expect("record");
    let (mut lease, _launch_pending_proof) = reservation
        .commit_launch_pending()
        .expect("commit LaunchPending");
    let pending = lease.descriptor().cleanup_state().clone();

    assert_eq!(
        classify_recovery(
            &record,
            EmbeddedHostObservation::ExactHostAlive,
            ProfileLockObservation::Available,
            &pending,
        ),
        EmbeddedOwnerRecoveryDecision::RetainLiveHost
    );
    assert_eq!(
        classify_recovery(
            &record,
            EmbeddedHostObservation::InspectionUnknown,
            ProfileLockObservation::Available,
            &pending,
        ),
        EmbeddedOwnerRecoveryDecision::RetainInspectionUnknown
    );
    assert_eq!(
        classify_recovery(
            &record,
            EmbeddedHostObservation::ExactHostGone,
            ProfileLockObservation::Held,
            &pending,
        ),
        EmbeddedOwnerRecoveryDecision::RetainProfileLock
    );
    assert_eq!(
        classify_recovery(
            &record,
            EmbeddedHostObservation::ExactHostGone,
            ProfileLockObservation::Available,
            &pending,
        ),
        EmbeddedOwnerRecoveryDecision::RecoverLaunchPending
    );

    lease
        .mark_runtime_owned(surface_id, "cef-test", "1")
        .expect("runtime-owned profile");
    let runtime_owned = lease.descriptor().cleanup_state().clone();
    assert_eq!(
        classify_recovery(
            &record,
            EmbeddedHostObservation::ExactHostGone,
            ProfileLockObservation::Available,
            &runtime_owned,
        ),
        EmbeddedOwnerRecoveryDecision::RecoverRuntimeOwned,
        "a pending record must cover the crash after profile RuntimeOwned was persisted"
    );

    let external = ProfileCleanupState::RuntimeOwned {
        ownership_id: lease.ownership_id().to_string(),
        runtime_id: "runtime-external-browser".to_string(),
        since: Utc::now().to_rfc3339(),
    };
    assert_eq!(
        classify_recovery(
            &record,
            EmbeddedHostObservation::ExactHostGone,
            ProfileLockObservation::Available,
            &external,
        ),
        EmbeddedOwnerRecoveryDecision::RetainUnknownOrExternalOwner
    );
    let foreign = ProfileCleanupState::LaunchPending {
        ownership_id: "ownership-foreign".to_string(),
        since: Utc::now().to_rfc3339(),
    };
    assert_eq!(
        classify_recovery(
            &record,
            EmbeddedHostObservation::ExactHostGone,
            ProfileLockObservation::Available,
            &foreign,
        ),
        EmbeddedOwnerRecoveryDecision::RetainUnknownOrExternalOwner
    );

    let ownership_id = lease.ownership_id().to_string();
    drop(lease);
    force_cleanup(&manager, descriptor.profile_id(), &ownership_id);
    drop(owner);
}

#[test]
fn startup_removes_reserved_intent_when_crash_precedes_launch_pending() {
    let (_temp, manager, store) = fixture();
    let descriptor = manager.create_profile(&workspace()).expect("profile");
    let reservation = manager
        .reserve_embedded_launch(descriptor.profile_id(), &workspace())
        .expect("reservation");
    let owner = store
        .begin_profile_reservation(&reservation, "login-3-lease-c")
        .expect("record before LaunchPending");
    let record_id = owner.record_id().to_string();
    drop(reservation); // Crash before commit: profile remains Stopped and the lock disappears.

    let removed = store
        .reap_stale_with(&manager, &FakeInspector(Inspection::Identity(None)))
        .expect("dead-host sweep");
    assert_eq!(
        removed[0].disposition,
        EmbeddedOwnerRecoveryDisposition::RemovedFinishedRecord
    );
    assert_eq!(removed[0].profile_id, descriptor.profile_id().as_str());
    assert_eq!(removed[0].workspace_identity, workspace().as_str());
    assert!(stopped(&manager, descriptor.profile_id()));
    assert!(store
        .load(&record_id)
        .expect("load removed record")
        .is_none());
    drop(owner);
}

#[test]
fn startup_recovers_launch_pending_before_record_phase_update_only_after_host_is_gone() {
    let (_temp, manager, store) = fixture();
    let descriptor = manager.create_profile(&workspace()).expect("profile");
    let reservation = manager
        .reserve_embedded_launch(descriptor.profile_id(), &workspace())
        .expect("reservation");
    let owner = store
        .begin_profile_reservation(&reservation, "login-3b-lease-c")
        .expect("record before LaunchPending");
    let record_id = owner.record_id().to_string();
    let (lease, _launch_pending_proof) = reservation
        .commit_launch_pending()
        .expect("commit LaunchPending");
    drop(lease); // Crash before mark_launch_pending; record is still ProfileReserved.

    let live = store
        .reap_stale_with(&manager, &FakeInspector(Inspection::Identity(Some(host()))))
        .expect("live-host sweep");
    assert_eq!(
        live[0].disposition,
        EmbeddedOwnerRecoveryDisposition::RetainedLiveHost
    );
    assert!(!stopped(&manager, descriptor.profile_id()));

    let unknown = store
        .reap_stale_with(&manager, &FakeInspector(Inspection::Failed))
        .expect("unknown-host sweep");
    assert_eq!(
        unknown[0].disposition,
        EmbeddedOwnerRecoveryDisposition::RetainedInspectionUnknown
    );

    let recovered = store
        .reap_stale_with(&manager, &FakeInspector(Inspection::Identity(None)))
        .expect("dead-host sweep");
    assert_eq!(
        recovered[0].disposition,
        EmbeddedOwnerRecoveryDisposition::RecoveredLaunchPending
    );
    assert!(stopped(&manager, descriptor.profile_id()));
    assert!(store
        .load(&record_id)
        .expect("load removed record")
        .is_none());
    drop(owner); // Drop never removes a record; the reaper already removed it explicitly.
}

#[test]
fn startup_covers_runtime_owned_before_record_phase_update_and_pid_reuse() {
    let (_temp, manager, store) = fixture();
    let descriptor = manager.create_profile(&workspace()).expect("profile");
    let surface_id = "login-4-lease-d";
    let reservation = manager
        .reserve_embedded_launch(descriptor.profile_id(), &workspace())
        .expect("reservation");
    let owner = store
        .begin_profile_reservation(&reservation, surface_id)
        .expect("reserved record");
    let (mut lease, launch_pending_proof) = reservation
        .commit_launch_pending()
        .expect("commit LaunchPending");
    let mut owner = owner;
    owner
        .mark_launch_pending(&launch_pending_proof)
        .expect("record LaunchPending");
    lease
        .mark_runtime_owned(surface_id, "cef-test", "1")
        .expect("profile runtime-owned");
    drop(lease); // Crash before owner.mark_runtime_owned().

    let reused_pid = EmbeddedHostProcessIdentity {
        birth_token: "mac:999:999".to_string(),
        ..host()
    };
    let recovered = store
        .reap_stale_with(
            &manager,
            &FakeInspector(Inspection::Identity(Some(reused_pid))),
        )
        .expect("PID-reuse sweep");
    assert_eq!(
        recovered[0].disposition,
        EmbeddedOwnerRecoveryDisposition::RecoveredRuntimeOwned
    );
    assert!(stopped(&manager, descriptor.profile_id()));
    drop(owner);
}

#[test]
fn startup_never_recovers_while_profile_lock_is_held() {
    let (_temp, manager, store) = fixture();
    let descriptor = manager.create_profile(&workspace()).expect("profile");
    let reservation = manager
        .reserve_embedded_launch(descriptor.profile_id(), &workspace())
        .expect("reservation");
    let mut owner = store
        .begin_profile_reservation(&reservation, "login-5-lease-e")
        .expect("owner record");
    let (lease, launch_pending_proof) = reservation
        .commit_launch_pending()
        .expect("commit LaunchPending");
    owner
        .mark_launch_pending(&launch_pending_proof)
        .expect("record LaunchPending");
    let ownership_id = lease.ownership_id().to_string();

    let retained = store
        .reap_stale_with(&manager, &FakeInspector(Inspection::Identity(None)))
        .expect("locked sweep");
    assert_eq!(
        retained[0].disposition,
        EmbeddedOwnerRecoveryDisposition::RetainedProfileLock
    );
    assert!(!stopped(&manager, descriptor.profile_id()));

    drop(lease);
    force_cleanup(&manager, descriptor.profile_id(), &ownership_id);
    drop(owner);
}

#[test]
fn startup_retains_external_runtime_and_removes_only_finished_record() {
    let (_temp, manager, store) = fixture();
    let external_descriptor = manager.create_profile(&workspace()).expect("profile");
    let external_reservation = manager
        .reserve_embedded_launch(external_descriptor.profile_id(), &workspace())
        .expect("reservation");
    let mut external_owner = store
        .begin_profile_reservation(&external_reservation, "login-6-lease-f")
        .expect("owner record");
    let (mut external_lease, external_pending_proof) = external_reservation
        .commit_launch_pending()
        .expect("commit LaunchPending");
    external_owner
        .mark_launch_pending(&external_pending_proof)
        .expect("record LaunchPending");
    let external_ownership = external_lease.ownership_id().to_string();
    external_lease
        .mark_runtime_owned("runtime-external", "chrome-test", "1")
        .expect("external runtime state");
    drop(external_lease);

    let retained = store
        .reap_stale_with(&manager, &FakeInspector(Inspection::Identity(None)))
        .expect("external sweep");
    assert_eq!(
        retained[0].disposition,
        EmbeddedOwnerRecoveryDisposition::RetainedUnknownOrExternalOwner
    );
    assert!(!stopped(&manager, external_descriptor.profile_id()));
    force_cleanup(
        &manager,
        external_descriptor.profile_id(),
        &external_ownership,
    );
    let removed_external = store
        .reap_stale_with(&manager, &FakeInspector(Inspection::Identity(None)))
        .expect("remove externally finished record");
    assert_eq!(
        removed_external[0].disposition,
        EmbeddedOwnerRecoveryDisposition::RemovedFinishedRecord
    );
    drop(external_owner);

    let finished_descriptor = manager.create_profile(&workspace()).expect("profile");
    let finished_reservation = manager
        .reserve_embedded_launch(finished_descriptor.profile_id(), &workspace())
        .expect("reservation");
    let finished_owner = store
        .begin_profile_reservation(&finished_reservation, "login-7-lease-g")
        .expect("owner record");
    let (finished_lease, _finished_pending_proof) = finished_reservation
        .commit_launch_pending()
        .expect("commit LaunchPending");
    finished_lease
        .cancel_pending_launch()
        .expect("profile stopped before record deletion");

    let removed = store
        .reap_stale_with(&manager, &FakeInspector(Inspection::Identity(None)))
        .expect("finished-record sweep");
    assert_eq!(
        removed[0].disposition,
        EmbeddedOwnerRecoveryDisposition::RemovedFinishedRecord
    );
    assert!(stopped(&manager, finished_descriptor.profile_id()));
    drop(finished_owner);
}

#[cfg(unix)]
#[test]
fn symlink_record_is_rejected_without_following_it() {
    use std::os::unix::fs::symlink;

    let (temp, _manager, store) = fixture();
    let record_id = "embedded-owner-22222222222222222222222222222222";
    let target = temp.path().join("outside.json");
    fs::write(&target, b"{}").expect("outside file");
    symlink(&target, store.path_for(record_id).expect("record path")).expect("record symlink");

    assert!(matches!(
        store.load(record_id),
        Err(EmbeddedOwnerRecoveryError::UnsafeRecord)
    ));
}

#[cfg(unix)]
#[test]
fn replaced_record_root_is_rejected_before_launch_pending_is_published() {
    use std::os::unix::fs::symlink;

    let (temp, manager, store) = fixture();
    let descriptor = manager.create_profile(&workspace()).expect("profile");
    let reservation = manager
        .reserve_embedded_launch(descriptor.profile_id(), &workspace())
        .expect("reservation");
    let outside = temp.path().join("outside-owner-root");
    fs::create_dir(&outside).expect("outside directory");
    fs::remove_dir(&store.root).expect("remove empty owner root");
    symlink(&outside, &store.root).expect("replace owner root");

    assert!(matches!(
        store.begin_profile_reservation(&reservation, "login-root-symlink"),
        Err(EmbeddedOwnerRecoveryError::UnsafeRecord)
    ));
    drop(reservation);
    assert!(stopped(&manager, descriptor.profile_id()));
    let lease = manager
        .acquire_launch_lease(descriptor.profile_id(), &workspace())
        .expect("failed intent did not strand reservation");
    let ownership_id = lease.ownership_id().to_string();
    lease
        .release_after_ownership_domain_gone(
            OwnershipDomainGone::from_supervisor(ownership_id).expect("cleanup proof"),
        )
        .expect("release verification lease");
}
