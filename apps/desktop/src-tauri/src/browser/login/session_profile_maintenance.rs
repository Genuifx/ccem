use super::{LoginBrowserSessionManager, SessionManagerError, TrustedWorkspacePath};
use crate::browser::login::profile::{
    BrowserProfileDescriptor, DestructiveProfileAction, DestructiveProfileAuthorization, ProfileId,
    TrustedWorkspaceIdentity,
};
use serde::Serialize;
use std::time::Duration;

const DESTRUCTIVE_PROFILE_AUTHORIZATION_TTL: Duration = Duration::from_secs(30);

/// Minimal trusted-main-window projection of an app-owned persistent profile.
///
/// Profile filesystem paths, cleanup ownership and runtime process details stay in Rust.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct LoginBrowserProfileSummary {
    pub profile_id: String,
    pub last_used_at: Option<String>,
    pub is_default: bool,
}

impl LoginBrowserProfileSummary {
    fn from_descriptor(descriptor: &BrowserProfileDescriptor, is_default: bool) -> Self {
        Self {
            profile_id: descriptor.profile_id().as_str().to_string(),
            last_used_at: descriptor.last_used_at().map(ToOwned::to_owned),
            is_default,
        }
    }
}

impl LoginBrowserSessionManager {
    pub(crate) fn profile_summaries(
        &self,
        workspace: TrustedWorkspacePath,
    ) -> Result<Vec<LoginBrowserProfileSummary>, SessionManagerError> {
        let _gate = self
            .open_gate
            .lock()
            .map_err(|_| SessionManagerError::StateUnavailable)?;
        let workspace_identity = self
            .workspace_identities
            .resolve(workspace.as_path())
            .map_err(super::map_workspace_error)?;
        self.profiles
            .list_profiles(&workspace_identity)
            .map_err(super::map_profile_error)
            .map(|profiles| {
                profiles
                    .iter()
                    .enumerate()
                    .map(|(index, descriptor)| {
                        LoginBrowserProfileSummary::from_descriptor(descriptor, index == 0)
                    })
                    .collect()
            })
    }

    pub(crate) fn reset_profile(
        &self,
        workspace: TrustedWorkspacePath,
        profile_id: &str,
        confirmed: bool,
    ) -> Result<LoginBrowserProfileSummary, SessionManagerError> {
        if !confirmed {
            return Err(SessionManagerError::DestructiveConfirmationRequired);
        }
        let _gate = self
            .open_gate
            .lock()
            .map_err(|_| SessionManagerError::StateUnavailable)?;
        let (workspace_identity, descriptor) = self.resolve_profile(workspace, profile_id)?;
        let is_default = self.is_default_profile(&workspace_identity, descriptor.profile_id())?;
        let authorization = DestructiveProfileAuthorization::from_trusted_ui(
            DestructiveProfileAction::Reset,
            descriptor.profile_id().clone(),
            workspace_identity,
            DESTRUCTIVE_PROFILE_AUTHORIZATION_TTL,
        )
        .map_err(super::map_profile_error)?;
        self.profiles
            .reset_profile(authorization)
            .map(|descriptor| LoginBrowserProfileSummary::from_descriptor(&descriptor, is_default))
            .map_err(super::map_profile_error)
    }

    pub(crate) fn delete_profile(
        &self,
        workspace: TrustedWorkspacePath,
        profile_id: &str,
        confirmed: bool,
    ) -> Result<(), SessionManagerError> {
        if !confirmed {
            return Err(SessionManagerError::DestructiveConfirmationRequired);
        }
        let _gate = self
            .open_gate
            .lock()
            .map_err(|_| SessionManagerError::StateUnavailable)?;
        let (workspace_identity, descriptor) = self.resolve_profile(workspace, profile_id)?;
        let authorization = DestructiveProfileAuthorization::from_trusted_ui(
            DestructiveProfileAction::Delete,
            descriptor.profile_id().clone(),
            workspace_identity,
            DESTRUCTIVE_PROFILE_AUTHORIZATION_TTL,
        )
        .map_err(super::map_profile_error)?;
        self.profiles
            .delete_profile(authorization)
            .map_err(super::map_profile_error)
    }

    fn resolve_profile(
        &self,
        workspace: TrustedWorkspacePath,
        profile_id: &str,
    ) -> Result<(TrustedWorkspaceIdentity, BrowserProfileDescriptor), SessionManagerError> {
        let workspace_identity = self
            .workspace_identities
            .resolve(workspace.as_path())
            .map_err(super::map_workspace_error)?;
        let profile_id = ProfileId::parse(profile_id).map_err(super::map_profile_error)?;
        let descriptor = self
            .profiles
            .descriptor(&profile_id, &workspace_identity)
            .map_err(super::map_profile_error)?;
        Ok((workspace_identity, descriptor))
    }

    fn is_default_profile(
        &self,
        workspace_identity: &TrustedWorkspaceIdentity,
        profile_id: &ProfileId,
    ) -> Result<bool, SessionManagerError> {
        self.profiles
            .list_profiles(workspace_identity)
            .map_err(super::map_profile_error)
            .map(|profiles| {
                profiles
                    .first()
                    .is_some_and(|descriptor| descriptor.profile_id() == profile_id)
            })
    }

    #[cfg(test)]
    pub(super) fn default_profile_summary(
        &self,
        workspace: TrustedWorkspacePath,
    ) -> Result<Option<LoginBrowserProfileSummary>, SessionManagerError> {
        self.profile_summaries(workspace)
            .map(|profiles| profiles.into_iter().next())
    }

    #[cfg(test)]
    pub(super) fn reset_default_profile(
        &self,
        workspace: TrustedWorkspacePath,
        expected_profile_id: &str,
        confirmed: bool,
    ) -> Result<LoginBrowserProfileSummary, SessionManagerError> {
        if !confirmed {
            return Err(SessionManagerError::DestructiveConfirmationRequired);
        }
        let profiles = self.profile_summaries(workspace.clone())?;
        ensure_expected_default(&profiles, expected_profile_id)?;
        self.reset_profile(workspace, expected_profile_id, true)
    }

    #[cfg(test)]
    pub(super) fn delete_default_profile(
        &self,
        workspace: TrustedWorkspacePath,
        expected_profile_id: &str,
        confirmed: bool,
    ) -> Result<(), SessionManagerError> {
        if !confirmed {
            return Err(SessionManagerError::DestructiveConfirmationRequired);
        }
        let profiles = self.profile_summaries(workspace.clone())?;
        ensure_expected_default(&profiles, expected_profile_id)?;
        self.delete_profile(workspace, expected_profile_id, true)
    }
}

#[cfg(test)]
fn ensure_expected_default(
    profiles: &[LoginBrowserProfileSummary],
    expected_profile_id: &str,
) -> Result<(), SessionManagerError> {
    match profiles.first() {
        Some(profile) if profile.profile_id == expected_profile_id => Ok(()),
        _ => Err(SessionManagerError::ProfileChanged),
    }
}
