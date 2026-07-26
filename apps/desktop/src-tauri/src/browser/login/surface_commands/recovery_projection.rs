use super::super::{
    cef::recovery::{EmbeddedOwnerRecoveryDisposition, EmbeddedOwnerRecoveryRecord},
    cef::surface::{CefSurfaceRecoveryState, CefSurfaceSnapshot},
    session::{
        EmbeddedProfileIdentity, LoginBrowserSessionHandle, LoginBrowserSessionManager,
        LoginBrowserSessionSnapshot, SessionManagerError, TrustedUiControlAction,
        TrustedUiControlAuthorization,
    },
};
use std::collections::HashMap;
use std::time::Duration;

#[derive(Default)]
pub(super) struct EmbeddedRecoveryRegistry {
    by_profile: HashMap<EmbeddedProfileIdentity, Vec<EmbeddedOwnerRecoveryDisposition>>,
}

impl EmbeddedRecoveryRegistry {
    pub(super) fn from_records(records: Vec<EmbeddedOwnerRecoveryRecord>) -> Self {
        let mut registry = Self::default();
        for record in records {
            registry
                .by_profile
                .entry(EmbeddedProfileIdentity::from_recovery_record(
                    record.profile_id,
                    record.workspace_identity,
                ))
                .or_default()
                .push(record.disposition);
        }
        for states in registry.by_profile.values_mut() {
            states.sort_by_key(|state| state.as_str());
            states.dedup();
        }
        registry
    }

    pub(super) fn states_for(
        &self,
        identity: &EmbeddedProfileIdentity,
    ) -> Vec<EmbeddedOwnerRecoveryDisposition> {
        self.by_profile.get(identity).cloned().unwrap_or_default()
    }

    pub(super) fn acknowledge_successful_acquire(&mut self, identity: &EmbeddedProfileIdentity) {
        let remove = if let Some(states) = self.by_profile.get_mut(identity) {
            // Recovered/removed records are one-shot notices. Retained records remain visible for
            // every related attempt because their unsafe ownership condition still persists.
            states.retain(|state| state.is_retained());
            states.is_empty()
        } else {
            false
        };
        if remove {
            self.by_profile.remove(identity);
        }
    }
}

pub(super) fn recovery_aware_error(
    error: &str,
    states: &[EmbeddedOwnerRecoveryDisposition],
) -> String {
    if states.is_empty() {
        return error.to_string();
    }
    let states = states
        .iter()
        .map(|state| state.as_str())
        .collect::<Vec<_>>()
        .join(",");
    format!("Login Browser startup recovery states: {states}. {error}")
}

pub(super) fn pause_for_renderer_recovery(
    sessions: &LoginBrowserSessionManager,
    session: &LoginBrowserSessionHandle,
    native: &CefSurfaceSnapshot,
    authorization_ttl: Duration,
) -> Result<Option<LoginBrowserSessionSnapshot>, SessionManagerError> {
    if native.recovery_state != Some(CefSurfaceRecoveryState::RendererProcessTerminated) {
        return Ok(None);
    }
    let authorization = TrustedUiControlAuthorization::from_trusted_ui(
        session,
        TrustedUiControlAction::PauseAgent,
        authorization_ttl,
    )?;
    sessions.pause_agent_if_active(authorization).map(Some)
}
