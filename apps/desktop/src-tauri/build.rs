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
    tauri_build::build()
}
