use super::super::capability::{BrowserPermissionAuthorityTicket, PermissionAuthorityBinding};
use super::super::control::ControlErrorCode;
use super::*;

pub(super) struct PermissionSyncFailure {
    error: SessionManagerError,
    backend: Arc<dyn SessionOwnedBackend>,
}

impl LoginBrowserSessionManager {
    /// Retires the Login Browser handoff owned by one native conversation lineage.
    ///
    /// Native runtime stop/quarantine is a trusted host transition, so it cannot rely on a
    /// short-lived UI authorization. Workspace plus opaque actor lineage is the authority key:
    /// peer Browser instances in the same workspace remain untouched.
    pub(crate) fn retire_agent_for_actor(
        &self,
        workspace: TrustedWorkspacePath,
        agent_actor_id: &str,
    ) -> Result<Option<LoginBrowserSessionSnapshot>, SessionManagerError> {
        if !self.is_available() {
            return Ok(None);
        }
        let workspace_identity = self
            .available()?
            .workspace_identities
            .resolve(workspace.as_path())
            .map_err(map_workspace_error)?;
        let mut sessions = self.lock_sessions()?;
        let matching = sessions
            .iter()
            .filter(|(_, record)| {
                record.snapshot.workspace_id == workspace_identity.as_str()
                    && record.snapshot.status == LoginBrowserSessionStatus::Running
                    && record.snapshot.control == SessionControlOwner::Agent
                    && record.agent_actor_id.as_deref() == Some(agent_actor_id)
            })
            .map(|(session_id, _)| session_id.clone())
            .collect::<Vec<_>>();
        if matching.len() > 1 {
            return Err(SessionManagerError::AgentSessionConflict);
        }
        let Some(session_id) = matching.first() else {
            return Ok(None);
        };
        let record = self.record_mut(&mut sessions, session_id)?;
        let epoch = next_epoch(record.snapshot.handoff_epoch)?;

        // Always retire the capability even if policy or backend acknowledgement fails. In that
        // case the live Browser record remains registered as CleanupRequired instead of being
        // destroyed or accidentally handed to a peer.
        let policy_error = record
            .navigation_policy
            .pause_agent()
            .err()
            .map(|_| SessionManagerError::ControlUnavailable);
        let owner_result = revoke_and_acknowledge_owner(record.backend.as_ref(), &record.control)
            .and_then(|()| acknowledge_paused_owner(record.backend.as_ref()));
        record.handoff_candidate = None;
        record.agent_actor_id = None;
        record.active_binding = None;
        record.origin_gate = None;
        record.snapshot.handoff_epoch = epoch;
        record.snapshot.control = SessionControlOwner::Paused;

        if let Some(error) = policy_error {
            record.snapshot.status = LoginBrowserSessionStatus::CleanupRequired;
            return Err(error);
        }
        if let Err(error) = owner_result {
            record.snapshot.status = LoginBrowserSessionStatus::CleanupRequired;
            return Err(error);
        }
        Ok(Some(record.snapshot.clone()))
    }

    pub(crate) fn update_permission_for_actor(
        &self,
        workspace: TrustedWorkspacePath,
        agent_actor_id: &str,
        authority: BrowserPermissionAuthorityTicket,
    ) -> Result<(), SessionManagerError> {
        if !self.is_available() {
            return Ok(());
        }
        let workspace_identity = self
            .available()?
            .workspace_identities
            .resolve(workspace.as_path())
            .map_err(map_workspace_error)?;
        let outcome = {
            let mut sessions = self.lock_sessions()?;
            let matching = sessions
                .iter()
                .filter(|(_, record)| {
                    record.snapshot.workspace_id == workspace_identity.as_str()
                        && record.snapshot.status == LoginBrowserSessionStatus::Running
                        && record.snapshot.control == SessionControlOwner::Agent
                        && record.agent_actor_id.as_deref() == Some(agent_actor_id)
                })
                .map(|(session_id, _)| session_id.clone())
                .collect::<Vec<_>>();
            if matching.len() > 1 {
                return Err(SessionManagerError::AgentSessionConflict);
            }
            let Some(session_id) = matching.first() else {
                return Ok(());
            };
            let record = self.record_mut(&mut sessions, session_id)?;
            synchronize_record_permission(record, authority)
        };
        match outcome {
            Ok(_) => Ok(()),
            Err(failure) => Err(complete_permission_failure(failure)),
        }
    }

    #[cfg(test)]
    pub(crate) fn update_permission_for_workspace(
        &self,
        workspace: TrustedWorkspacePath,
        authority: BrowserPermissionAuthorityTicket,
    ) -> Result<(), SessionManagerError> {
        if !self.is_available() {
            // Permission synchronization discovers optional Mode 2 sessions. There cannot be an
            // active handoff in a placeholder manager, so preserve the caller's Mode 1 path.
            return Ok(());
        }
        let workspace_identity = self
            .available()?
            .workspace_identities
            .resolve(workspace.as_path())
            .map_err(map_workspace_error)?;
        let failures = {
            let mut sessions = self.lock_sessions()?;
            let targets = sessions
                .iter()
                .filter(|(_, record)| {
                    record.snapshot.workspace_id == workspace_identity.as_str()
                        && record.snapshot.status == LoginBrowserSessionStatus::Running
                })
                .map(|(session_id, _)| session_id.clone())
                .collect::<Vec<_>>();
            let mut failures = Vec::new();
            for session_id in targets {
                let record = self.record_mut(&mut sessions, &session_id)?;
                if let Err(failure) = synchronize_record_permission(record, authority.clone()) {
                    failures.push(failure);
                }
            }
            failures
        };
        let mut first_error = None;
        for failure in failures {
            let error = complete_permission_failure(failure);
            if first_error.is_none() {
                first_error = Some(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    pub(in crate::browser::login) fn agent_execution_for_actor_with_permission(
        &self,
        workspace: &TrustedWorkspacePath,
        agent_actor_id: &str,
        authority: BrowserPermissionAuthorityTicket,
    ) -> Result<Option<(AgentExecutionLease, PermissionAuthorityBinding)>, SessionManagerError>
    {
        let inner = self.available()?;
        let workspace_identity = inner
            .workspace_identities
            .resolve(workspace.as_path())
            .map_err(map_workspace_error)?;
        let outcome = {
            let mut sessions = self.lock_sessions()?;
            let matching = sessions
                .iter()
                .filter(|(_, record)| {
                    record.snapshot.workspace_id == workspace_identity.as_str()
                        && record.snapshot.status == LoginBrowserSessionStatus::Running
                        && record.snapshot.control == SessionControlOwner::Agent
                        && record.agent_actor_id.as_deref() == Some(agent_actor_id)
                })
                .map(|(session_id, _)| session_id.clone())
                .collect::<Vec<_>>();
            if matching.len() > 1 {
                return Err(SessionManagerError::AgentSessionConflict);
            }
            let Some(session_id) = matching.first() else {
                return Ok(None);
            };
            let record = self.record_mut(&mut sessions, session_id)?;
            let projection = record.backend.projection()?;
            apply_backend_projection(&mut record.snapshot, projection.clone())?;
            if record.snapshot.status != LoginBrowserSessionStatus::Running {
                retire_terminated_agent_record(record);
                return Err(SessionManagerError::RuntimeUnavailable);
            }
            match synchronize_record_permission(record, authority) {
                Ok(permission) => Ok(Some((
                    AgentExecutionLease {
                        binding: record
                            .active_binding
                            .clone()
                            .ok_or(SessionManagerError::ControlUnavailable)?,
                        workspace_identity,
                        current_url: projection.current_url,
                        control: Arc::clone(&record.control),
                        origin: record
                            .origin_gate
                            .as_ref()
                            .cloned()
                            .ok_or(SessionManagerError::OriginUnavailable)?,
                        audit: Arc::clone(&record.audit),
                        backend: Arc::clone(&record.backend),
                        permission: Arc::clone(&record.permission),
                        operation_ids: Arc::clone(&record.operation_ids),
                        artifact_root: record.artifact_root.clone(),
                        provenance: Arc::clone(&inner.provenance),
                    },
                    permission,
                ))),
                Err(failure) => Err(failure),
            }
        };
        match outcome {
            Ok(value) => Ok(value),
            Err(failure) => Err(complete_permission_failure(failure)),
        }
    }
}

fn synchronize_record_permission(
    record: &mut SessionRecord,
    authority: BrowserPermissionAuthorityTicket,
) -> Result<PermissionAuthorityBinding, PermissionSyncFailure> {
    let mut acknowledgement = Ok(());
    let binding = match record
        .permission
        .synchronize_authority_and_invalidate(authority, || {
            acknowledgement = record.control.cancel_active_and_wait();
        }) {
        Ok(binding) => binding,
        Err(_) => {
            let _ = record.control.revoke_handoff();
            mark_permission_cleanup_required(record);
            return Err(PermissionSyncFailure {
                error: SessionManagerError::ControlUnavailable,
                backend: Arc::clone(&record.backend),
            });
        }
    };
    let Err(control_error) = acknowledgement else {
        return Ok(binding);
    };

    // Keep selection, cancellation and registry cleanup in the same critical section. A pause or
    // newer handoff can only commit before this transaction begins or after it has fully ended.
    let _ = record.control.revoke_handoff();
    mark_permission_cleanup_required(record);
    Err(PermissionSyncFailure {
        error: if control_error.code == ControlErrorCode::OwnerQuiescenceTimedOut {
            SessionManagerError::OwnerQuiescenceTimedOut
        } else {
            SessionManagerError::ControlUnavailable
        },
        backend: Arc::clone(&record.backend),
    })
}

fn mark_permission_cleanup_required(record: &mut SessionRecord) {
    let _ = record.navigation_policy.pause_agent();
    record.handoff_candidate = None;
    record.agent_actor_id = None;
    record.active_binding = None;
    record.origin_gate = None;
    record.snapshot.handoff_epoch = record.snapshot.handoff_epoch.saturating_add(1);
    record.snapshot.control = SessionControlOwner::Paused;
    record.snapshot.status = LoginBrowserSessionStatus::CleanupRequired;
}

fn retire_terminated_agent_record(record: &mut SessionRecord) {
    let _ = record.navigation_policy.pause_agent();
    let _ = record.control.revoke_handoff();
    record.handoff_candidate = None;
    record.agent_actor_id = None;
    record.active_binding = None;
    record.origin_gate = None;
    record.snapshot.handoff_epoch = record.snapshot.handoff_epoch.saturating_add(1);
    record.snapshot.control = SessionControlOwner::Paused;
    record.snapshot.status = LoginBrowserSessionStatus::CleanupRequired;
}

fn complete_permission_failure(failure: PermissionSyncFailure) -> SessionManagerError {
    if failure.backend.emergency_stop_verified_domain().is_err() {
        SessionManagerError::RuntimeUnavailable
    } else {
        failure.error
    }
}
