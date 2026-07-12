use super::super::capability::{BrowserPermissionAuthorityTicket, PermissionAuthorityBinding};
use super::super::control::ControlErrorCode;
use super::*;

struct PermissionUpdateTarget {
    session_id: SessionId,
    permission: Arc<CcemPermissionGate>,
    control: Arc<LoginBrowserControl>,
    backend: Arc<dyn SessionOwnedBackend>,
}

impl LoginBrowserSessionManager {
    pub(crate) fn update_permission_for_workspace(
        &self,
        workspace: TrustedWorkspacePath,
        authority: BrowserPermissionAuthorityTicket,
    ) -> Result<(), SessionManagerError> {
        let workspace_identity = self
            .workspace_identities
            .resolve(workspace.as_path())
            .map_err(map_workspace_error)?;
        let targets = {
            let sessions = self.lock_sessions()?;
            sessions
                .iter()
                .filter(|(_, record)| {
                    record.snapshot.workspace_id == workspace_identity.as_str()
                        && record.snapshot.status == LoginBrowserSessionStatus::Running
                })
                .map(|(session_id, record)| PermissionUpdateTarget {
                    session_id: session_id.clone(),
                    permission: Arc::clone(&record.permission),
                    control: Arc::clone(&record.control),
                    backend: Arc::clone(&record.backend),
                })
                .collect::<Vec<_>>()
        };
        let mut first_error = None;
        for target in targets {
            if let Err(error) = self.apply_permission_update(&target, authority.clone()) {
                first_error.get_or_insert(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    pub(in crate::browser::login) fn update_permission_for_agent_lease(
        &self,
        lease: &AgentExecutionLease,
        authority: BrowserPermissionAuthorityTicket,
    ) -> Result<PermissionAuthorityBinding, SessionManagerError> {
        let target = PermissionUpdateTarget {
            session_id: SessionId(lease.binding.session_id().to_string()),
            permission: Arc::clone(&lease.permission),
            control: Arc::clone(&lease.control),
            backend: Arc::clone(&lease.backend),
        };
        self.apply_permission_update(&target, authority)
    }

    fn apply_permission_update(
        &self,
        target: &PermissionUpdateTarget,
        authority: BrowserPermissionAuthorityTicket,
    ) -> Result<PermissionAuthorityBinding, SessionManagerError> {
        let mut acknowledgement = Ok(());
        let binding = target
            .permission
            .synchronize_authority_and_invalidate(authority, || {
                acknowledgement = target.control.cancel_active_and_wait();
            })
            .map_err(|_| SessionManagerError::ControlUnavailable)?;
        let Err(control_error) = acknowledgement else {
            return Ok(binding);
        };

        // The retired fence already rejects every later old-epoch write. Remove discoverable
        // authority and project cleanup before signalling the exact verified ownership domain.
        let _ = target.control.revoke_handoff();
        let state_result = self.mark_permission_cleanup_required(&target.session_id);
        let stop_result = target.backend.emergency_stop_verified_domain();
        if stop_result.is_err() {
            return Err(SessionManagerError::RuntimeUnavailable);
        }
        state_result?;
        if control_error.code == ControlErrorCode::OwnerQuiescenceTimedOut {
            Err(SessionManagerError::OwnerQuiescenceTimedOut)
        } else {
            Err(SessionManagerError::ControlUnavailable)
        }
    }

    fn mark_permission_cleanup_required(
        &self,
        session_id: &SessionId,
    ) -> Result<(), SessionManagerError> {
        let mut sessions = self.lock_sessions()?;
        let record = self.record_mut(&mut sessions, session_id)?;
        let _ = record.navigation_policy.pause_agent();
        record.handoff_candidate = None;
        record.active_binding = None;
        record.origin_gate = None;
        record.snapshot.handoff_epoch = record.snapshot.handoff_epoch.saturating_add(1);
        record.snapshot.control = SessionControlOwner::Paused;
        record.snapshot.status = LoginBrowserSessionStatus::CleanupRequired;
        Ok(())
    }
}
