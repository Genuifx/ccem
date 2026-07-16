use std::time::Duration;

#[cfg(feature = "updater-replacement-smoke-harness")]
use std::sync::atomic::{AtomicU8, Ordering};
#[cfg(feature = "updater-replacement-smoke-harness")]
use std::sync::OnceLock;

#[cfg(feature = "updater-replacement-smoke-harness")]
use reqwest::{redirect::Policy, Certificate, Url};
use serde::Serialize;
#[cfg(any(test, feature = "updater-replacement-smoke-harness"))]
use sha2::{Digest, Sha256};
#[cfg(feature = "updater-replacement-smoke-harness")]
use tauri::{AppHandle, Manager};
#[cfg(feature = "updater-replacement-smoke-harness")]
use tauri_plugin_updater::UpdaterBuilder;

#[cfg(feature = "updater-replacement-smoke-harness")]
use super::contract::write_json_create_new;
use super::contract::{
    hash_json, read_stage, wait_for_identity, wait_for_json, write_stage, AppBootRecord,
    SmokeConfig,
};

#[cfg(feature = "updater-replacement-smoke-harness")]
static PREVIOUS_CONFIG: OnceLock<SmokeConfig> = OnceLock::new();
#[cfg(feature = "updater-replacement-smoke-harness")]
static PREVIOUS_BOOT: OnceLock<AppBootRecord> = OnceLock::new();
#[cfg(feature = "updater-replacement-smoke-harness")]
static UPDATE_PHASE: AtomicU8 = AtomicU8::new(0);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StageDetail<'a> {
    operation: &'a str,
    result: &'a str,
    artifact_sha256: &'a str,
}

#[cfg(any(test, feature = "updater-replacement-smoke-harness"))]
fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(feature = "updater-replacement-smoke-harness")]
fn signature_rejection(error: &str) -> bool {
    let normalized = error.to_lowercase();
    ["signature", "minisign", "base64"]
        .iter()
        .any(|needle| normalized.contains(needle))
}

#[cfg(feature = "updater-replacement-smoke-harness")]
fn verify_public_key(app: &AppHandle, config: &SmokeConfig) -> Result<(), String> {
    if sha256_bytes(config.updater.public_key.as_bytes()) != config.updater.public_key_sha256 {
        return Err("updater public key digest does not match config".into());
    }
    let embedded_public_key = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|value| value.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "previous app lacks an embedded updater public key".to_string())?;
    let embedded_sha256 = sha256_bytes(embedded_public_key.as_bytes());
    if embedded_sha256 != config.previous.embedded_updater_public_key_sha256
        || embedded_sha256 != config.updater.public_key_sha256
        || embedded_public_key != config.updater.public_key
    {
        return Err(
            "previous embedded updater public key differs from the current artifact verification key; key rotation requires a separate migration protocol"
                .into(),
        );
    }
    #[cfg(target_os = "windows")]
    if app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|value| value.get("windows"))
        .and_then(|value| value.get("installMode"))
        .and_then(serde_json::Value::as_str)
        != Some("quiet")
    {
        return Err(
            "Windows updater replacement smoke requires embedded quiet install mode".into(),
        );
    }
    Ok(())
}

#[cfg(feature = "updater-replacement-smoke-harness")]
pub fn set_previous_smoke_context(
    config: &SmokeConfig,
    boot: &AppBootRecord,
) -> Result<(), String> {
    PREVIOUS_CONFIG
        .set(config.clone())
        .map_err(|_| "previous updater smoke config was initialized twice".to_string())?;
    PREVIOUS_BOOT
        .set(boot.clone())
        .map_err(|_| "previous updater smoke boot record was initialized twice".to_string())?;
    UPDATE_PHASE.store(0, Ordering::SeqCst);
    Ok(())
}

#[cfg(feature = "updater-replacement-smoke-harness")]
pub fn configure_updater_builder(
    app: &AppHandle,
    builder: UpdaterBuilder,
) -> Result<UpdaterBuilder, String> {
    let config = PREVIOUS_CONFIG
        .get()
        .ok_or_else(|| "previous updater smoke config is not initialized".to_string())?;
    verify_public_key(app, config)?;
    let endpoint = if UPDATE_PHASE.load(Ordering::SeqCst) == 0 {
        &config.updater.negative_endpoint
    } else {
        &config.updater.positive_endpoint
    };
    let ca_pem = std::fs::read(&config.updater.ca_pem_path)
        .map_err(|error| format!("read updater test CA: {error}"))?;
    let certificate = Certificate::from_pem(&ca_pem)
        .map_err(|error| format!("parse updater test CA: {error}"))?;
    let endpoint =
        Url::parse(endpoint).map_err(|error| format!("parse updater endpoint: {error}"))?;
    builder
        .endpoints(vec![endpoint])
        .map_err(|error| format!("override updater endpoint: {error}"))?
        .header(
            config.updater.nonce_header_name.as_str(),
            config.run.challenge_nonce.as_str(),
        )
        .map_err(|error| format!("set updater challenge header: {error}"))
        .map(|builder| {
            builder
                .timeout(Duration::from_secs(30))
                .configure_client(move |client| {
                    client
                        .https_only(true)
                        .tls_built_in_root_certs(false)
                        .add_root_certificate(certificate.clone())
                        .redirect(Policy::none())
                })
        })
}

#[cfg(feature = "updater-replacement-smoke-harness")]
pub fn record_verified_download(bytes: &[u8]) -> Result<(), String> {
    let config = PREVIOUS_CONFIG
        .get()
        .ok_or_else(|| "previous updater smoke config is not initialized".to_string())?;
    let boot = PREVIOUS_BOOT
        .get()
        .ok_or_else(|| "previous updater smoke boot record is not initialized".to_string())?;
    if UPDATE_PHASE.load(Ordering::SeqCst) != 1 {
        return Err("bad-signature control unexpectedly reached verified download".into());
    }
    if sha256_bytes(bytes) != config.updater.artifact_sha256 {
        return Err("downloaded updater bytes do not match the exact release artifact".into());
    }
    let identity = wait_for_identity(config, boot)?;
    write_stage(
        config,
        &identity,
        3,
        "download",
        "previousApp",
        &StageDetail {
            operation: "previous-production.install_app_update.download",
            result: "signature-verified",
            artifact_sha256: &config.updater.artifact_sha256,
        },
    )?;
    write_stage(
        config,
        &identity,
        4,
        "installTransition",
        "previousApp",
        &StageDetail {
            operation: "previous-production.install_app_update.install",
            result: "entered",
            artifact_sha256: &config.updater.artifact_sha256,
        },
    )?;
    Ok(())
}

#[cfg(feature = "updater-replacement-smoke-harness")]
pub async fn run_previous_updater(
    app: &AppHandle,
    config: &SmokeConfig,
    boot: &AppBootRecord,
) -> Result<(), String> {
    let identity = wait_for_identity(config, boot)?;
    let negative = crate::app_updates::check_app_update(
        app.clone(),
        app.state::<crate::app_updates::PendingUpdate>(),
    )
    .await
    .map_err(|error| format!("previous production negative check: {error}"))?;
    if negative.is_none() {
        return Err("negative updater endpoint returned no newer update".into());
    }
    let negative_error = match crate::app_updates::install_app_update(
        app.clone(),
        app.state::<crate::app_updates::PendingUpdate>(),
    )
    .await
    {
        Ok(()) => return Err("bad-signature updater unexpectedly installed".into()),
        Err(error) => error,
    };
    if !signature_rejection(&negative_error) {
        return Err(format!(
            "negative updater failed for a non-signature reason: {negative_error}"
        ));
    }
    write_stage(
        config,
        &identity,
        1,
        "badSignatureRejected",
        "previousApp",
        &StageDetail {
            operation: "previous-production.install_app_update",
            result: "signature-rejected",
            artifact_sha256: &config.updater.artifact_sha256,
        },
    )?;
    let _: serde_json::Value = wait_for_json(
        &config.signal_path("negative-tree-verified"),
        Duration::from_secs(60),
    )?;

    UPDATE_PHASE.store(1, Ordering::SeqCst);
    let metadata = crate::app_updates::check_app_update(
        app.clone(),
        app.state::<crate::app_updates::PendingUpdate>(),
    )
    .await
    .map_err(|error| format!("previous production positive check: {error}"))?
    .ok_or_else(|| "positive updater endpoint returned no newer update".to_string())?;
    if metadata.version != config.current_version {
        return Err("positive updater metadata version does not match current release".into());
    }
    write_stage(
        config,
        &identity,
        2,
        "check",
        "previousApp",
        &StageDetail {
            operation: "previous-production.check_app_update",
            result: "update-found",
            artifact_sha256: &config.updater.artifact_sha256,
        },
    )?;
    crate::app_updates::install_app_update(
        app.clone(),
        app.state::<crate::app_updates::PendingUpdate>(),
    )
    .await
    .map_err(|error| format!("previous production positive install: {error}"))?;
    write_json_create_new(
        &config.signal_path("macos-install-returned"),
        &serde_json::json!({
            "installApiReturned": true,
            "atomicSwapClaimed": false,
        }),
    )?;
    Ok(())
}

pub fn run_current_observer(config: &SmokeConfig, boot: &AppBootRecord) -> Result<(), String> {
    let identity = wait_for_identity(config, boot)?;
    read_stage(config, 5, "oldExit")?;
    write_stage(
        config,
        &identity,
        6,
        "currentStart",
        "currentApp",
        &StageDetail {
            operation: "installed-current.start",
            result: "identity-verified",
            artifact_sha256: &config.updater.artifact_sha256,
        },
    )?;
    let _: serde_json::Value = wait_for_json(
        &config.signal_path("current-installation-verified"),
        Duration::from_secs(60),
    )?;
    write_stage(
        config,
        &identity,
        7,
        "currentFinalized",
        "currentApp",
        &serde_json::json!({
            "operation": "installed-current.finalize",
            "result": "installation-verified",
            "installationSha256": hash_json(&identity)?,
        }),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::sha256_bytes;

    #[test]
    fn byte_digest_is_exact_sha256() {
        assert_eq!(
            sha256_bytes(b"ccem"),
            "e2db917b69948fbf99d31920f71fe7df87a170311bf7b1f25cbd29370b0789c2"
        );
    }
}
