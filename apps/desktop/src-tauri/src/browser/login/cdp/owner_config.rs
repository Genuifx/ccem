use super::super::backend::{BackendFailure, BackendFailureCode};
use super::super::network::NetworkRedactionConfig;
use std::path::PathBuf;
use std::time::Duration;

const MIN_COMMAND_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_COMMAND_TIMEOUT: Duration = Duration::from_secs(60);

pub(in crate::browser::login) struct ChromiumLoginBackendConfig {
    pub(super) artifact_root: PathBuf,
    pub(super) network_log_root: PathBuf,
    pub(super) network_session_id: String,
    pub(super) redaction: NetworkRedactionConfig,
    pub(super) command_timeout: Duration,
}

impl ChromiumLoginBackendConfig {
    pub(in crate::browser::login) fn new_trusted(
        artifact_root: PathBuf,
        network_log_root: PathBuf,
        network_session_id: String,
        redaction: NetworkRedactionConfig,
        command_timeout: Duration,
    ) -> Result<Self, BackendFailure> {
        if !artifact_root.is_absolute()
            || !network_log_root.is_absolute()
            || network_session_id.is_empty()
            || network_session_id.len() > 160
            || !network_session_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            || !(MIN_COMMAND_TIMEOUT..=MAX_COMMAND_TIMEOUT).contains(&command_timeout)
        {
            return Err(BackendFailure::new(
                BackendFailureCode::RuntimeUnavailable,
                "Browser CDP owner is unavailable.",
            ));
        }
        Ok(Self {
            artifact_root,
            network_log_root,
            network_session_id,
            redaction,
            command_timeout,
        })
    }
}
