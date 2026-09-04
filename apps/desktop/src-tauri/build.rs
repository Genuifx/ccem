fn main() {
    println!("cargo:rerun-if-env-changed=CCEM_OFFICIAL_APPLE_TEAM_ID");
    println!("cargo:rerun-if-env-changed=APPLE_SIGNING_IDENTITY");
    if let Ok(team_identifier) = std::env::var("CCEM_OFFICIAL_APPLE_TEAM_ID") {
        let team_identifier = team_identifier.trim();
        if team_identifier.len() != 10
            || !team_identifier
                .bytes()
                .all(|value| value.is_ascii_uppercase() || value.is_ascii_digit())
        {
            panic!("CCEM_OFFICIAL_APPLE_TEAM_ID must be a 10-character Apple Team ID");
        }
        println!("cargo:rustc-env=CCEM_OFFICIAL_APPLE_TEAM_ID={team_identifier}");
    }
    if let Ok(signing_identity) = std::env::var("APPLE_SIGNING_IDENTITY") {
        let signing_identity = signing_identity.trim();
        if !signing_identity.starts_with("Developer ID Application: ")
            || signing_identity.bytes().any(|value| value < b' ')
        {
            panic!("APPLE_SIGNING_IDENTITY must be a Developer ID Application identity");
        }
        println!("cargo:rustc-env=CCEM_APPLE_SIGNING_IDENTITY={signing_identity}");
    }
    let windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    let tauri_attributes = if windows_msvc {
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest())
    } else {
        tauri_build::Attributes::new()
    };
    tauri_build::try_build(tauri_attributes).expect("failed to run Tauri build script");

    if windows_msvc {
        let manifest = std::path::Path::new(
            &std::env::var("CARGO_MANIFEST_DIR").expect("Cargo manifest directory"),
        )
        .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        // `rustc-link-arg-tests` skips the `[lib]` unit-test harness. Use one linker
        // manifest for every Windows MSVC executable, including that harness.
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
}
