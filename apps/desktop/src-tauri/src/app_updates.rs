use std::sync::Arc;
use std::time::Duration;

use semver::Version;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::UpdaterExt;

use crate::app_update_engine::{
    check_and_store, download_verified_and_install, PendingAppUpdate, UpdateProgress,
};

const RELEASE_URL_PREFIX: &str =
    "https://github.com/Genuifx/claude-code-env-manager/releases/tag/v";

pub type PendingUpdate = PendingAppUpdate;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateMetadata {
    pub(crate) version: String,
    current_version: String,
    channel: String,
    release_tag: String,
    release_url: String,
    date: Option<String>,
    body: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateProgressEvent {
    phase: String,
    version: String,
    downloaded: u64,
    total: Option<u64>,
}

#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub async fn check_app_update(
    app: AppHandle,
    pending_update: State<'_, PendingUpdate>,
) -> Result<Option<AppUpdateMetadata>, String> {
    let builder = app.updater_builder().timeout(Duration::from_secs(30));
    #[cfg(feature = "updater-replacement-smoke-harness")]
    let builder = crate::updater_replacement_smoke::configure_updater_builder(&app, builder)?;
    let metadata = check_and_store(builder, &pending_update).await?.map(
        |(version, current_version, date, body)| AppUpdateMetadata {
            channel: version_channel(&version),
            release_tag: release_tag(&version),
            release_url: release_url(&version),
            version,
            current_version,
            date,
            body,
        },
    );
    Ok(metadata)
}

#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    pending_update: State<'_, PendingUpdate>,
) -> Result<(), String> {
    let update = pending_update.take()?;
    let version = update.version.clone();
    let progress = UpdateProgress::default();

    emit_app_update_progress(&app, "download-started", &version, 0, None);

    let chunk_app = app.clone();
    let chunk_version = version.clone();
    let chunk_progress = progress.clone();
    let finish_app = app.clone();
    let finish_version = version.clone();
    let finish_progress = progress.clone();
    download_verified_and_install(
        update,
        move |chunk_length, content_length| {
            let (downloaded, total) = chunk_progress.record(chunk_length as u64, content_length);
            emit_app_update_progress(
                &chunk_app,
                "download-progress",
                &chunk_version,
                downloaded,
                total,
            );
        },
        move || {
            let (downloaded, total) = finish_progress.snapshot();
            emit_app_update_progress(
                &finish_app,
                "download-finished",
                &finish_version,
                downloaded,
                total,
            );
        },
        |bytes| {
            #[cfg(feature = "updater-replacement-smoke-harness")]
            crate::updater_replacement_smoke::record_verified_download(bytes)?;
            #[cfg(not(feature = "updater-replacement-smoke-harness"))]
            let _ = bytes;
            Ok(())
        },
    )
    .await?;

    let (downloaded, total) = progress.snapshot();
    emit_app_update_progress(&app, "installed", &version, downloaded, total);
    Ok(())
}

#[cfg(any(target_os = "macos", windows))]
#[tauri::command]
pub async fn restart_app(
    app: AppHandle,
    sessions: State<'_, Arc<crate::browser::login::session::LoginBrowserSessionManager>>,
    surfaces: State<'_, Arc<crate::browser::login::surface_commands::LoginBrowserSurfaceManager>>,
    cef_host: State<'_, Arc<crate::browser::login::cef::host::CefHostController>>,
) -> Result<(), String> {
    surfaces.begin_shutdown()?;
    let sessions = Arc::clone(sessions.inner());
    let cef_host = Arc::clone(cef_host.inner());
    let app_for_shutdown = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let report = sessions.shutdown_all().map_err(|error| error.to_string())?;
        if !report.failures.is_empty() {
            return Err(format!(
                "{} Login Browser session(s) did not reach terminal state before restart.",
                report.failures.len()
            ));
        }
        cef_host.prepare_shutdown(&app_for_shutdown)
    })
    .await
    .map_err(|error| format!("join graceful app restart: {error}"))??;
    app.request_restart();
    Ok(())
}

#[cfg(not(any(target_os = "macos", windows)))]
#[tauri::command]
pub fn restart_app(app: AppHandle) -> Result<(), String> {
    app.request_restart();
    Ok(())
}

fn parse_version(raw: &str) -> Result<Version, String> {
    Version::parse(raw.trim_start_matches('v'))
        .map_err(|error| format!("Invalid app version {raw}: {error}"))
}

fn release_tag(version: &str) -> String {
    format!("v{}", version.trim_start_matches('v'))
}

fn release_url(version: &str) -> String {
    format!("{RELEASE_URL_PREFIX}{}", version.trim_start_matches('v'))
}

fn version_channel(version: &str) -> String {
    parse_version(version)
        .map(|version| {
            if version.pre.is_empty() {
                "stable"
            } else {
                "beta"
            }
        })
        .unwrap_or("stable")
        .to_string()
}

fn emit_app_update_progress(
    app: &AppHandle,
    phase: &str,
    version: &str,
    downloaded: u64,
    total: Option<u64>,
) {
    let payload = AppUpdateProgressEvent {
        phase: phase.to_string(),
        version: version.to_string(),
        downloaded,
        total,
    };
    let _ = app.emit("app-update-progress", payload);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_tag_adds_v_prefix_once() {
        assert_eq!(release_tag("2.1.0"), "v2.1.0");
        assert_eq!(release_tag("v2.1.0"), "v2.1.0");
    }

    #[test]
    fn release_url_points_to_matching_tag() {
        assert_eq!(
            release_url("2.1.0"),
            "https://github.com/Genuifx/claude-code-env-manager/releases/tag/v2.1.0"
        );
    }

    #[test]
    fn version_channel_detects_prereleases() {
        assert_eq!(version_channel("2.1.0"), "stable");
        assert_eq!(version_channel("2.1.0-beta.1"), "beta");
    }

    #[test]
    fn parse_version_accepts_optional_v_prefix() {
        assert_eq!(
            parse_version("v2.1.0").unwrap(),
            Version::parse("2.1.0").unwrap()
        );
    }
}
