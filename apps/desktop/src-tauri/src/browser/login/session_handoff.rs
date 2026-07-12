use super::super::policy::TrustedOriginGrant;
use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct HandoffCandidateId([u8; 16]);

impl HandoffCandidateId {
    fn generate() -> Result<Self, SessionManagerError> {
        let mut random = [0_u8; 16];
        OsRng
            .try_fill_bytes(&mut random)
            .map_err(|_| SessionManagerError::StateUnavailable)?;
        Ok(Self(random))
    }
}

struct PreparedHandoff {
    candidate_id: HandoffCandidateId,
    expected_control: SessionControlOwner,
    epoch: u64,
    binding: BrowserGrantBinding,
    origin_grant: TrustedOriginGrant,
    expected_origin: NormalizedOrigin,
    backend: Arc<dyn SessionOwnedBackend>,
    control: Arc<LoginBrowserControl>,
    navigation_policy: Arc<SessionNavigationPolicy>,
}

impl LoginBrowserSessionManager {
    pub(crate) fn handoff_to_agent(
        &self,
        authorization: TrustedUiControlAuthorization,
    ) -> Result<SessionAgentGrant, SessionManagerError> {
        let prepared = self.prepare_handoff_candidate(&authorization)?;

        // The real browser preflight can take seconds. The candidate nonce keeps this session
        // undiscoverable and prevents a competing handoff without serializing pause/takeover for
        // every other session behind the global registry mutex.
        if prepared
            .backend
            .preflight_handoff(&prepared.expected_origin)
            .is_err()
        {
            return Err(self.rollback_preflight_candidate(
                &authorization.session_id,
                &prepared,
                SessionManagerError::OriginUnavailable,
            ));
        }

        let mut sessions = match self.lock_sessions() {
            Ok(sessions) => sessions,
            Err(error) => {
                fail_closed_detached_candidate(&prepared);
                return Err(error);
            }
        };
        let record = match sessions.get_mut(&authorization.session_id) {
            Some(record) => record,
            None => return Err(SessionManagerError::SessionNotFound),
        };
        if record.handoff_candidate != Some(prepared.candidate_id) {
            return Err(SessionManagerError::InvalidControlTransition);
        }
        if record.snapshot.status != LoginBrowserSessionStatus::Running
            || record.snapshot.control != prepared.expected_control
        {
            let error = rollback_candidate(
                record,
                prepared.epoch,
                false,
                SessionManagerError::InvalidControlTransition,
            );
            record.handoff_candidate = None;
            return Err(error);
        }
        if record
            .control
            .activate_handoff(HandoffGrant::new_trusted(prepared.binding.clone()))
            .is_err()
        {
            let error = rollback_candidate(
                record,
                prepared.epoch,
                false,
                SessionManagerError::ControlUnavailable,
            );
            record.handoff_candidate = None;
            return Err(error);
        }
        if record
            .backend
            .begin_diagnostic_segment(prepared.epoch)
            .is_err()
        {
            let error = rollback_candidate(
                record,
                prepared.epoch,
                true,
                SessionManagerError::ControlUnavailable,
            );
            record.handoff_candidate = None;
            return Err(error);
        }

        // These fields are the single Agent-discoverability point. The preflight and diagnostic
        // barrier both completed while the record still projected its prior trusted UI owner.
        record.snapshot.handoff_epoch = prepared.epoch;
        record.snapshot.control = SessionControlOwner::Agent;
        record.active_binding = Some(prepared.binding.clone());
        record.origin_gate = Some(Arc::new(TrustedOriginPolicyGate::new(
            prepared.origin_grant,
        )));
        record.handoff_candidate = None;
        Ok(SessionAgentGrant {
            binding: prepared.binding,
            control: Arc::clone(&record.control),
        })
    }

    fn prepare_handoff_candidate(
        &self,
        authorization: &TrustedUiControlAuthorization,
    ) -> Result<PreparedHandoff, SessionManagerError> {
        let mut sessions = self.lock_sessions()?;
        let target = self.record(&sessions, &authorization.session_id)?;
        authorization.validate(
            &record_session_id(target)?,
            TrustedUiControlAction::HandoffToAgent,
        )?;
        ensure_running(target)?;
        if !matches!(
            target.snapshot.control,
            SessionControlOwner::User | SessionControlOwner::Paused
        ) {
            return Err(SessionManagerError::InvalidControlTransition);
        }
        let target_workspace = target.snapshot.workspace_id.clone();
        if sessions.iter().any(|(session_id, record)| {
            record.snapshot.workspace_id == target_workspace
                && record.snapshot.status == LoginBrowserSessionStatus::Running
                && (record.handoff_candidate.is_some()
                    || (session_id != &authorization.session_id
                        && record.snapshot.control == SessionControlOwner::Agent))
        }) {
            return Err(SessionManagerError::AgentSessionConflict);
        }

        let record = self.record_mut(&mut sessions, &authorization.session_id)?;
        refresh_record_projection(record)?;
        let origin = record
            .snapshot
            .current_origin
            .clone()
            .ok_or(SessionManagerError::OriginUnavailable)?;
        let expected_origin =
            NormalizedOrigin::parse(&origin).map_err(|_| SessionManagerError::OriginUnavailable)?;
        let epoch = next_epoch(record.snapshot.handoff_epoch)?;
        let binding = BrowserGrantBinding::new_trusted(
            record.snapshot.workspace_id.clone(),
            record.snapshot.profile_id.clone(),
            record.snapshot.session_id.clone(),
            epoch,
        )
        .map_err(|_| SessionManagerError::ControlUnavailable)?;
        let candidate_id = HandoffCandidateId::generate()?;
        let origin_grant = record
            .navigation_policy
            .activate(binding.clone(), [&origin])
            .map_err(|_| SessionManagerError::OriginUnavailable)?;
        record.handoff_candidate = Some(candidate_id);

        Ok(PreparedHandoff {
            candidate_id,
            expected_control: record.snapshot.control,
            epoch,
            binding,
            origin_grant,
            expected_origin,
            backend: Arc::clone(&record.backend),
            control: Arc::clone(&record.control),
            navigation_policy: Arc::clone(&record.navigation_policy),
        })
    }

    fn rollback_preflight_candidate(
        &self,
        session_id: &SessionId,
        prepared: &PreparedHandoff,
        reported_error: SessionManagerError,
    ) -> SessionManagerError {
        let mut sessions = match self.lock_sessions() {
            Ok(sessions) => sessions,
            Err(error) => {
                fail_closed_detached_candidate(prepared);
                return error;
            }
        };
        let Some(record) = sessions.get_mut(session_id) else {
            return SessionManagerError::SessionNotFound;
        };
        if record.handoff_candidate != Some(prepared.candidate_id) {
            return SessionManagerError::InvalidControlTransition;
        }
        let error = rollback_candidate(record, prepared.epoch, false, reported_error);
        record.handoff_candidate = None;
        error
    }
}

fn fail_closed_detached_candidate(prepared: &PreparedHandoff) {
    let _ = prepared.navigation_policy.pause_agent();
    if revoke_and_acknowledge_owner(prepared.backend.as_ref(), &prepared.control).is_ok() {
        let _ = enter_user_control(prepared.backend.as_ref(), &prepared.navigation_policy);
    }
}

fn rollback_candidate(
    record: &mut SessionRecord,
    candidate_epoch: u64,
    activated_control: bool,
    reported_error: SessionManagerError,
) -> SessionManagerError {
    let _ = record.navigation_policy.pause_agent();
    let revoke = revoke_and_acknowledge_owner(record.backend.as_ref(), &record.control);
    let user_control = revoke
        .and_then(|()| enter_user_control(record.backend.as_ref(), &record.navigation_policy));
    record.active_binding = None;
    record.origin_gate = None;

    if user_control.is_ok() {
        record.snapshot.control = SessionControlOwner::User;
        if activated_control {
            // An activated authority epoch is never reusable, even when capture startup failed.
            record.snapshot.handoff_epoch = candidate_epoch;
        }
        reported_error
    } else {
        record.snapshot.control = SessionControlOwner::Paused;
        record.snapshot.status = LoginBrowserSessionStatus::CleanupRequired;
        user_control.expect_err("failed rollback has an error")
    }
}
