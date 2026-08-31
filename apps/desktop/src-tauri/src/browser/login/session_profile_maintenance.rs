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
        let inner = self.available()?;
        let _gate = inner
            .open_gate
            .lock()
            .map_err(|_| SessionManagerError::StateUnavailable)?;
        let workspace_identity = inner
            .workspace_identities
            .resolve(workspace.as_path())
            .map_err(super::map_workspace_error)?;
        let global_default = inner
            .profiles
            .global_default_profile(&workspace_identity, false)
            .map_err(super::map_profile_error)?;
        let mut profiles = inner
            .profiles
            .list_profiles(&workspace_identity)
            .map_err(super::map_profile_error)?;
        let default_profile_id = global_default
            .as_ref()
            .map(|descriptor| descriptor.profile_id().clone());
        if let Some(default) = global_default {
            profiles.retain(|descriptor| descriptor.profile_id() != default.profile_id());
            profiles.insert(0, default);
        }
        Ok(profiles
            .iter()
            .map(|descriptor| {
                LoginBrowserProfileSummary::from_descriptor(
                    descriptor,
                    default_profile_id
                        .as_ref()
                        .is_some_and(|profile_id| descriptor.profile_id() == profile_id),
                )
            })
            .collect())
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
        let inner = self.available()?;
        let _gate = inner
            .open_gate
            .lock()
            .map_err(|_| SessionManagerError::StateUnavailable)?;
        let (profile_owner_identity, descriptor) = self.resolve_profile(workspace, profile_id)?;
        let is_default = inner
            .profiles
            .is_global_default(descriptor.profile_id())
            .map_err(super::map_profile_error)?;
        let authorization = DestructiveProfileAuthorization::from_trusted_ui(
            DestructiveProfileAction::Reset,
            descriptor.profile_id().clone(),
            profile_owner_identity,
            DESTRUCTIVE_PROFILE_AUTHORIZATION_TTL,
        )
        .map_err(super::map_profile_error)?;
        inner
            .profiles
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
        let inner = self.available()?;
        let _gate = inner
            .open_gate
            .lock()
            .map_err(|_| SessionManagerError::StateUnavailable)?;
        let (profile_owner_identity, descriptor) = self.resolve_profile(workspace, profile_id)?;
        let is_default = inner
            .profiles
            .is_global_default(descriptor.profile_id())
            .map_err(super::map_profile_error)?;
        let authorization = DestructiveProfileAuthorization::from_trusted_ui(
            DestructiveProfileAction::Delete,
            descriptor.profile_id().clone(),
            profile_owner_identity,
            DESTRUCTIVE_PROFILE_AUTHORIZATION_TTL,
        )
        .map_err(super::map_profile_error)?;
        inner
            .profiles
            .delete_profile(authorization)
            .map_err(super::map_profile_error)?;
        if is_default
            && !inner
                .profiles
                .clear_global_default(descriptor.profile_id())
                .map_err(super::map_profile_error)?
        {
            return Err(SessionManagerError::ProfileChanged);
        }
        Ok(())
    }

    fn resolve_profile(
        &self,
        workspace: TrustedWorkspacePath,
        profile_id: &str,
    ) -> Result<(TrustedWorkspaceIdentity, BrowserProfileDescriptor), SessionManagerError> {
        let inner = self.available()?;
        let workspace_identity = inner
            .workspace_identities
            .resolve(workspace.as_path())
            .map_err(super::map_workspace_error)?;
        let profile_id = ProfileId::parse(profile_id).map_err(super::map_profile_error)?;
        let global_default = inner
            .profiles
            .global_default_profile(&workspace_identity, false)
            .map_err(super::map_profile_error)?;
        let descriptor = if let Some(descriptor) =
            global_default.filter(|descriptor| descriptor.profile_id() == &profile_id)
        {
            descriptor
        } else {
            inner
                .profiles
                .descriptor(&profile_id, &workspace_identity)
                .map_err(super::map_profile_error)?
        };
        let profile_owner_identity = descriptor
            .owner_identity()
            .map_err(super::map_profile_error)?;
        Ok((profile_owner_identity, descriptor))
    }

    #[cfg(test)]
    pub(super) fn default_profile_summary(
        &self,
        workspace: TrustedWorkspacePath,
    ) -> Result<Option<LoginBrowserProfileSummary>, SessionManagerError> {
        self.profile_summaries(workspace)
            .map(|profiles| profiles.into_iter().find(|profile| profile.is_default))
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
    match profiles.iter().find(|profile| profile.is_default) {
        Some(profile) if profile.profile_id == expected_profile_id => Ok(()),
        _ => Err(SessionManagerError::ProfileChanged),
    }
}
