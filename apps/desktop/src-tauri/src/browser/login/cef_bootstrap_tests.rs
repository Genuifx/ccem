use super::cef::bootstrap::{
    credential_store_policy, distribution_code_requirement, ensure_credential_store_marker,
    expected_credential_store_marker, resolve_runtime_layout, should_append_mock_keychain_switch,
    verify_safe_storage_branding, CefCredentialStorePolicy, VerifiedMacCodeSignature,
    VerifiedMacSafeStorageBranding,
};
use std::fs;
use std::os::unix::fs::symlink;

#[test]
fn cef_bootstrap_resolves_bundled_framework_without_dev_overrides() {
    let root = tempfile::tempdir().expect("temporary app bundle");
    let executable = root
        .path()
        .join("CCEM Desktop.app/Contents/MacOS/ccem-desktop");
    let framework = root.path().join(
        "CCEM Desktop.app/Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework",
    );
    fs::create_dir_all(executable.parent().unwrap()).expect("create MacOS folder");
    fs::create_dir_all(framework.parent().unwrap()).expect("create Framework folder");
    fs::write(&executable, b"main").expect("create executable marker");
    fs::write(&framework, b"cef").expect("create framework marker");

    let layout = resolve_runtime_layout(&executable, None).expect("bundled CEF layout");
    assert!(layout.bundled);
    assert_eq!(
        layout.framework_path,
        framework.canonicalize().expect("canonical framework")
    );
    assert_eq!(layout.browser_subprocess_path, None);
    assert!(layout.sandbox_enabled);
}

#[test]
fn cef_bootstrap_uses_explicit_framework_and_sibling_helper_only_for_dev() {
    let root = tempfile::tempdir().expect("temporary dev tree");
    let executable = root.path().join("target/debug/ccem-desktop");
    let helper = root.path().join("target/debug/ccem-cef-helper");
    let framework = root
        .path()
        .join("cef/Chromium Embedded Framework.framework/Chromium Embedded Framework");
    fs::create_dir_all(executable.parent().unwrap()).expect("create target folder");
    fs::create_dir_all(framework.parent().unwrap()).expect("create Framework folder");
    fs::write(&executable, b"main").expect("create executable marker");
    fs::write(&helper, b"helper").expect("create helper marker");
    fs::write(&framework, b"cef").expect("create framework marker");

    let layout = resolve_runtime_layout(&executable, Some(&framework)).expect("dev CEF layout");
    assert!(!layout.bundled);
    assert_eq!(
        layout.framework_path,
        framework.canonicalize().expect("canonical framework")
    );
    assert_eq!(
        layout.browser_subprocess_path,
        Some(helper.canonicalize().expect("canonical helper"))
    );
    assert!(!layout.sandbox_enabled);
}

#[test]
fn cef_bootstrap_never_uses_the_system_keychain_for_development_runtimes() {
    let layout = super::cef::bootstrap::CefRuntimeLayout {
        framework_path: "/tmp/cef.framework".into(),
        browser_subprocess_path: Some("/tmp/ccem-cef-helper".into()),
        bundled: false,
        sandbox_enabled: false,
        network_service_sandbox_requested: false,
        network_service_lpac_requested: false,
    };

    assert_eq!(
        credential_store_policy(&layout, false, None, None).unwrap_err(),
        "Mode 2 is disabled for unbundled release runtimes"
    );
    assert_eq!(
        credential_store_policy(&layout, true, None, None).unwrap(),
        CefCredentialStorePolicy::MockKeychain
    );
}

#[test]
fn cef_bootstrap_appends_mock_keychain_only_to_the_debug_browser_process() {
    assert!(should_append_mock_keychain_switch(
        CefCredentialStorePolicy::MockKeychain,
        None
    ));
    assert!(should_append_mock_keychain_switch(
        CefCredentialStorePolicy::MockKeychain,
        Some("")
    ));
    assert!(!should_append_mock_keychain_switch(
        CefCredentialStorePolicy::MockKeychain,
        Some("renderer")
    ));
    assert!(!should_append_mock_keychain_switch(
        CefCredentialStorePolicy::SystemKeychain,
        None
    ));
}

#[test]
fn cef_bootstrap_uses_the_system_keychain_only_for_verified_release_bundles() {
    let layout = super::cef::bootstrap::CefRuntimeLayout {
        framework_path: "/Applications/CCEM Desktop.app/Contents/Frameworks/cef.framework".into(),
        browser_subprocess_path: None,
        bundled: true,
        sandbox_enabled: true,
        network_service_sandbox_requested: false,
        network_service_lpac_requested: false,
    };
    let signature = VerifiedMacCodeSignature { _private: () };
    let branding = VerifiedMacSafeStorageBranding { _private: () };

    assert_eq!(
        credential_store_policy(&layout, true, None, None).unwrap(),
        CefCredentialStorePolicy::MockKeychain
    );
    assert_eq!(
        credential_store_policy(&layout, false, Some(&signature), Some(&branding)).unwrap(),
        CefCredentialStorePolicy::SystemKeychain
    );
    assert_eq!(
        credential_store_policy(&layout, false, Some(&signature), None).unwrap_err(),
        "Mode 2 is disabled because the bundled CEF runtime is not branded for CCEM Safe Storage"
    );
}

#[test]
fn cef_bootstrap_disables_unsigned_or_wrong_team_release_bundles() {
    let layout = super::cef::bootstrap::CefRuntimeLayout {
        framework_path: "/Applications/CCEM Desktop.app/Contents/Frameworks/cef.framework".into(),
        browser_subprocess_path: None,
        bundled: true,
        sandbox_enabled: true,
        network_service_sandbox_requested: false,
        network_service_lpac_requested: false,
    };
    assert!(credential_store_policy(&layout, false, None, None).is_err());
}

#[test]
fn cef_bootstrap_requires_one_exact_ccem_safe_storage_service_slot() {
    let root = tempfile::tempdir().expect("temporary Safe Storage framework");
    let framework = root.path().join("Chromium Embedded Framework");
    fs::write(&framework, b"prefix\0CCEM Safe Storage\0\0\0\0\0suffix")
        .expect("write branded framework fixture");
    verify_safe_storage_branding(&framework).expect("one exact CCEM service slot");

    fs::write(&framework, b"prefix\0Chromium Safe Storage\0suffix")
        .expect("write unbranded framework fixture");
    assert!(verify_safe_storage_branding(&framework)
        .unwrap_err()
        .contains("Chromium=1, CCEM=0"));

    fs::write(
        &framework,
        b"CCEM Safe Storage\0\0\0\0CCEM Safe Storage\0\0\0\0",
    )
    .expect("write duplicate branded framework fixture");
    assert!(verify_safe_storage_branding(&framework)
        .unwrap_err()
        .contains("Chromium=0, CCEM=2"));
}

#[test]
fn cef_bootstrap_finds_safe_storage_branding_across_streaming_chunk_boundaries() {
    const CHUNK_SIZE: usize = 1024 * 1024;
    let root = tempfile::tempdir().expect("temporary boundary-spanning framework");
    let framework = root.path().join("Chromium Embedded Framework");
    let mut bytes = vec![b'x'; CHUNK_SIZE - 10];
    bytes.extend_from_slice(b"CCEM Safe Storage\0\0\0\0");
    bytes.extend_from_slice(b"suffix");
    fs::write(&framework, bytes).expect("write boundary-spanning framework fixture");

    verify_safe_storage_branding(&framework)
        .expect("one exact CCEM service slot spanning two read chunks");
}

#[test]
fn cef_bootstrap_builds_an_apple_anchored_exact_release_requirement() {
    let requirement = distribution_code_requirement(
        "TEAM123456",
        "Developer ID Application: CCEM Inc. (TEAM123456)",
    )
    .expect("trusted release requirement");
    assert!(requirement.contains("anchor apple generic"));
    assert!(requirement.contains("identifier \"com.ccem.desktop\""));
    assert!(requirement.contains("certificate leaf[subject.OU] = \"TEAM123456\""));
    assert!(requirement.contains(
        "certificate leaf[subject.CN] = \"Developer ID Application: CCEM Inc. (TEAM123456)\""
    ));

    assert!(distribution_code_requirement(
        "TEAM123456",
        "Apple Development: CCEM Inc. (TEAM123456)"
    )
    .is_err());
    assert!(distribution_code_requirement(
        "WRONGTEAM1",
        "Developer ID Application: CCEM Inc. (TEAM123456)"
    )
    .is_err());
}

#[test]
fn cef_bootstrap_never_reuses_a_profile_root_across_credential_store_schemes() {
    let root = tempfile::tempdir().expect("credential-store root");
    ensure_credential_store_marker(root.path(), CefCredentialStorePolicy::MockKeychain, None)
        .expect("write mock marker");
    ensure_credential_store_marker(root.path(), CefCredentialStorePolicy::MockKeychain, None)
        .expect("same scheme is idempotent");
    assert!(ensure_credential_store_marker(
        root.path(),
        CefCredentialStorePolicy::SystemKeychain,
        Some("TEAM123456"),
    )
    .is_err());
}

#[test]
fn cef_bootstrap_marker_binds_the_release_team_and_safe_storage_service() {
    let root = tempfile::tempdir().expect("system credential-store root");
    ensure_credential_store_marker(
        root.path(),
        CefCredentialStorePolicy::SystemKeychain,
        Some("TEAM123456"),
    )
    .expect("write system marker");
    let marker = fs::read(root.path().join(".ccem-credential-store"))
        .expect("read system credential marker");
    assert_eq!(
        marker,
        expected_credential_store_marker(
            CefCredentialStorePolicy::SystemKeychain,
            Some("TEAM123456"),
        )
        .expect("expected system marker")
    );
    let parsed: serde_json::Value = serde_json::from_slice(&marker).expect("marker JSON");
    assert_eq!(parsed["schemaVersion"], 2);
    assert_eq!(parsed["credentialStore"], "macos-system-keychain");
    assert_eq!(parsed["applicationIdentifier"], "com.ccem.desktop");
    assert_eq!(parsed["teamIdentifier"], "TEAM123456");
    assert_eq!(parsed["safeStorageService"], "CCEM Safe Storage");

    assert!(ensure_credential_store_marker(
        root.path(),
        CefCredentialStorePolicy::SystemKeychain,
        Some("OTHER12345"),
    )
    .is_err());
    assert_eq!(
        fs::read(root.path().join(".ccem-credential-store")).expect("original marker remains"),
        marker
    );
}

#[test]
fn cef_bootstrap_refuses_to_adopt_nonempty_unmarked_profile_state() {
    let root = tempfile::tempdir().expect("unmarked credential-store root");
    fs::write(root.path().join("Cookies"), b"existing encrypted profile")
        .expect("write existing profile state");
    let error = ensure_credential_store_marker(
        root.path(),
        CefCredentialStorePolicy::SystemKeychain,
        Some("TEAM123456"),
    )
    .expect_err("nonempty profile must not be adopted");
    assert!(error.contains("contains state but no trusted identity marker"));
    assert!(!root.path().join(".ccem-credential-store").exists());
}

#[test]
fn cef_bootstrap_refuses_symlinked_or_hardlinked_credential_markers() {
    let container = tempfile::tempdir().expect("credential marker container");
    let cache = container.path().join("cache");
    fs::create_dir(&cache).expect("create cache root");
    let outside = container.path().join("outside-marker");
    fs::write(&outside, b"do not overwrite").expect("write outside marker");
    symlink(&outside, cache.join(".ccem-credential-store")).expect("symlink marker");
    assert!(
        ensure_credential_store_marker(&cache, CefCredentialStorePolicy::MockKeychain, None,)
            .is_err()
    );
    assert_eq!(
        fs::read(&outside).expect("outside marker"),
        b"do not overwrite"
    );

    fs::remove_file(cache.join(".ccem-credential-store")).expect("remove symlink fixture");
    ensure_credential_store_marker(&cache, CefCredentialStorePolicy::MockKeychain, None)
        .expect("write trusted marker");
    fs::hard_link(
        cache.join(".ccem-credential-store"),
        cache.join("credential-marker-alias"),
    )
    .expect("hardlink marker");
    assert!(
        ensure_credential_store_marker(&cache, CefCredentialStorePolicy::MockKeychain, None,)
            .is_err()
    );
}
