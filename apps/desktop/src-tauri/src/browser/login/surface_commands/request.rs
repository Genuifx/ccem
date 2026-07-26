#[cfg(any(target_os = "macos", windows))]
use super::super::cef::surface::LogicalViewport;
use super::super::session::ProfileSelection;
use serde::Deserialize;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BrowserSurfaceBackendArg {
    Preview,
    Login,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BrowserSurfaceProfileModeArg {
    Default,
    New,
    Saved,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BrowserSurfaceReleaseArg {
    Hide,
    Close,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BrowserSurfaceControlActionArg {
    Handoff,
    Pause,
    Takeover,
    Occlude,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub(crate) struct BrowserSurfaceViewportArg {
    pub(super) x: f64,
    pub(super) y: f64,
    pub(super) width: f64,
    pub(super) height: f64,
}

impl BrowserSurfaceViewportArg {
    #[cfg(any(target_os = "macos", windows))]
    pub(super) fn validate(self) -> Result<LogicalViewport, String> {
        if ![self.x, self.y, self.width, self.height]
            .into_iter()
            .all(f64::is_finite)
            || self.x < 0.0
            || self.y < 0.0
            || self.width <= 0.0
            || self.height <= 0.0
        {
            return Err("Browser surface viewport is invalid.".to_string());
        }
        Ok(LogicalViewport {
            x: self.x,
            y: self.y,
            width: self.width,
            height: self.height,
        })
    }
}

pub(super) fn parse_profile_selection(
    mode: Option<BrowserSurfaceProfileModeArg>,
    profile_id: Option<String>,
) -> Result<ProfileSelection, String> {
    match (mode, profile_id.filter(|value| !value.trim().is_empty())) {
        (Some(BrowserSurfaceProfileModeArg::Default), None) => Ok(ProfileSelection::Default),
        (Some(BrowserSurfaceProfileModeArg::New), None) => Ok(ProfileSelection::ExplicitNew),
        (Some(BrowserSurfaceProfileModeArg::Saved), Some(profile_id)) => {
            super::super::profile::ProfileId::parse(profile_id.trim())
                .map(ProfileSelection::Existing)
                .map_err(|error| error.to_string())
        }
        _ => Err("Login Browser profile selection is invalid.".to_string()),
    }
}

pub(super) fn validate_panel_session_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err("Browser panel session id is invalid.".to_string());
    }
    Ok(())
}
