use super::capability::JsonlSemanticAuditSink;
use super::cdp::guard::{
    TrustedHandoffPreflightDenial, TrustedNavigationDecision, TrustedNavigationGuard,
    TrustedNavigationRequest, TrustedNavigationSurface, TrustedSecurityAuditDisposition,
    TrustedSecurityAuditFailure, TrustedSecurityEvent,
};
use super::policy::{
    authorize_browser_request, BrowserDataProvenance, BrowserGrantBinding, BrowserPolicyEffect,
    BrowserPolicyError, BrowserPolicyRequest, BrowserPolicySurface, NormalizedOrigin,
    TrustedOriginGrant,
};
use std::sync::{Arc, Mutex};

#[derive(Debug)]
pub(super) enum SessionNavigationPolicyError {
    InvalidGrant(BrowserPolicyError),
    Unavailable,
}

/// Owner-thread navigation guard shared with trusted session state.
///
/// Manual user control intentionally has no Agent origin grant installed. Once the trusted UI
/// hands control to an Agent, every top-level request, redirect, popup, and iframe document passes
/// through the immutable handoff-bound origin grant. A transition retains that binding in a
/// paused fail-closed state until the owner acknowledges the user-control boundary.
pub(super) struct SessionNavigationPolicy {
    authority: Mutex<NavigationAuthority>,
    audit: Option<Arc<JsonlSemanticAuditSink>>,
}

enum NavigationAuthority {
    User,
    Agent(TrustedOriginGrant),
    Paused(TrustedOriginGrant),
}

impl SessionNavigationPolicy {
    #[cfg(test)]
    pub(super) fn new() -> Self {
        Self {
            authority: Mutex::new(NavigationAuthority::User),
            audit: None,
        }
    }

    pub(super) fn with_audit(audit: Arc<JsonlSemanticAuditSink>) -> Self {
        Self {
            authority: Mutex::new(NavigationAuthority::User),
            audit: Some(audit),
        }
    }

    pub(super) fn activate<I, S>(
        &self,
        binding: BrowserGrantBinding,
        origins: I,
    ) -> Result<TrustedOriginGrant, SessionNavigationPolicyError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let grant = TrustedOriginGrant::new_trusted(binding, origins)
            .map_err(SessionNavigationPolicyError::InvalidGrant)?;
        let mut authority = self
            .authority
            .lock()
            .map_err(|_| SessionNavigationPolicyError::Unavailable)?;
        *authority = NavigationAuthority::Agent(grant.clone());
        Ok(grant)
    }

    pub(super) fn pause_agent(&self) -> Result<(), SessionNavigationPolicyError> {
        let mut authority = self
            .authority
            .lock()
            .map_err(|_| SessionNavigationPolicyError::Unavailable)?;
        if let NavigationAuthority::Agent(grant) = &*authority {
            *authority = NavigationAuthority::Paused(grant.clone());
        }
        Ok(())
    }

    pub(super) fn resume_user_control(&self) {
        let mut authority = self
            .authority
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *authority = NavigationAuthority::User;
    }
}

impl TrustedNavigationGuard for SessionNavigationPolicy {
    fn authorize(&self, request: TrustedNavigationRequest<'_>) -> TrustedNavigationDecision {
        let authority = match self.authority.lock() {
            Ok(authority) => authority,
            Err(_) => return TrustedNavigationDecision::deny("origin_policy_unavailable"),
        };
        let (grant, paused) = match &*authority {
            NavigationAuthority::Agent(grant) => (grant, false),
            NavigationAuthority::Paused(grant) => (grant, true),
            NavigationAuthority::User => {
                return match request.surface() {
                    TrustedNavigationSurface::AgentNavigation
                    | TrustedNavigationSurface::AgentEffect => {
                        TrustedNavigationDecision::deny("no_active_handoff")
                    }
                    TrustedNavigationSurface::Redirect
                    | TrustedNavigationSurface::Popup
                    | TrustedNavigationSurface::Iframe => {
                        TrustedNavigationDecision::allow("user_control")
                    }
                };
            }
        };
        let trusted_surface = request.surface();
        let surface = match trusted_surface {
            TrustedNavigationSurface::AgentNavigation => BrowserPolicySurface::InitialNavigation,
            TrustedNavigationSurface::AgentEffect => BrowserPolicySurface::Mutation,
            TrustedNavigationSurface::Redirect => BrowserPolicySurface::Redirect,
            TrustedNavigationSurface::Popup => BrowserPolicySurface::Popup,
            TrustedNavigationSurface::Iframe => BrowserPolicySurface::IframeAction,
        };
        let decision = authorize_browser_request(
            grant,
            BrowserPolicyRequest {
                binding: grant.binding(),
                surface,
                effect: BrowserPolicyEffect::Navigate,
                target_url: request.target_url(),
                source_data_origin: None,
                data_provenance: BrowserDataProvenance::UntrackedOrSameOrigin,
                paused,
            },
            None,
        );
        if decision.allowed {
            TrustedNavigationDecision::allow(decision.code.as_str())
        } else {
            if let Some(audit) = self.audit.as_ref() {
                if audit
                    .write_navigation_denied(
                        grant.binding(),
                        navigation_surface_name(trusted_surface),
                        decision.code.as_str(),
                        decision.target_origin.as_deref(),
                    )
                    .is_err()
                {
                    return TrustedNavigationDecision::deny_terminal(
                        "navigation_audit_unavailable",
                    );
                }
            }
            TrustedNavigationDecision::deny(decision.code.as_str())
        }
    }

    fn record_security_event(
        &self,
        event: TrustedSecurityEvent,
    ) -> Result<TrustedSecurityAuditDisposition, TrustedSecurityAuditFailure> {
        let binding = {
            let authority = self
                .authority
                .lock()
                .map_err(|_| TrustedSecurityAuditFailure)?;
            match &*authority {
                NavigationAuthority::Agent(grant) | NavigationAuthority::Paused(grant) => {
                    grant.binding().clone()
                }
                NavigationAuthority::User => {
                    return Ok(TrustedSecurityAuditDisposition::UserControl)
                }
            }
        };
        let audit = self.audit.as_ref().ok_or(TrustedSecurityAuditFailure)?;
        audit
            .write_transfer_denied(&binding, event)
            .map_err(|_| TrustedSecurityAuditFailure)?;
        Ok(TrustedSecurityAuditDisposition::Recorded)
    }

    fn record_handoff_preflight_denial(
        &self,
        denial: TrustedHandoffPreflightDenial<'_>,
    ) -> Result<(), TrustedSecurityAuditFailure> {
        let binding = {
            let authority = self
                .authority
                .lock()
                .map_err(|_| TrustedSecurityAuditFailure)?;
            match &*authority {
                NavigationAuthority::Agent(grant) => grant.binding().clone(),
                NavigationAuthority::User | NavigationAuthority::Paused(_) => {
                    return Err(TrustedSecurityAuditFailure)
                }
            }
        };
        let target_origin = denial
            .target_url
            .and_then(|url| NormalizedOrigin::parse(url).ok())
            .map(|origin| origin.as_serialized_origin());
        self.audit
            .as_ref()
            .ok_or(TrustedSecurityAuditFailure)?
            .write_navigation_denied(
                &binding,
                denial.kind.surface(),
                denial.kind.cause_code(),
                target_origin.as_deref(),
            )
            .map_err(|_| TrustedSecurityAuditFailure)
    }
}

fn navigation_surface_name(surface: TrustedNavigationSurface) -> &'static str {
    match surface {
        TrustedNavigationSurface::AgentNavigation => "agent_navigation",
        TrustedNavigationSurface::AgentEffect => "agent_effect",
        TrustedNavigationSurface::Redirect => "redirect",
        TrustedNavigationSurface::Popup => "popup",
        TrustedNavigationSurface::Iframe => "iframe",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::login::control::{HandoffControl, LoginBrowserControl};

    fn binding(epoch: u64) -> BrowserGrantBinding {
        BrowserGrantBinding::new_trusted("w", "p", "s", epoch).unwrap()
    }

    #[test]
    fn manual_control_is_open_but_agent_handoff_closes_every_navigation_surface() {
        let policy = SessionNavigationPolicy::new();
        assert!(!policy
            .authorize(TrustedNavigationRequest::new(
                "https://stale-agent.example",
                TrustedNavigationSurface::AgentNavigation,
            ))
            .allowed());
        assert!(policy
            .authorize(TrustedNavigationRequest::new(
                "https://manual.example",
                TrustedNavigationSurface::Redirect,
            ))
            .allowed());

        policy
            .activate(binding(1), ["https://allowed.example"])
            .unwrap();
        for surface in [
            TrustedNavigationSurface::AgentNavigation,
            TrustedNavigationSurface::AgentEffect,
            TrustedNavigationSurface::Redirect,
            TrustedNavigationSurface::Popup,
            TrustedNavigationSurface::Iframe,
        ] {
            assert!(policy
                .authorize(TrustedNavigationRequest::new(
                    "https://allowed.example/path",
                    surface,
                ))
                .allowed());
            assert!(!policy
                .authorize(TrustedNavigationRequest::new(
                    "https://denied.example/path",
                    surface,
                ))
                .allowed());
        }

        policy.pause_agent().unwrap();
        let paused = policy.authorize(TrustedNavigationRequest::new(
            "https://allowed.example/late",
            TrustedNavigationSurface::Redirect,
        ));
        assert!(!paused.allowed());
        assert_eq!(paused.code(), "agent_control_paused");
        policy.resume_user_control();
        assert!(!policy
            .authorize(TrustedNavigationRequest::new(
                "https://stale-agent.example",
                TrustedNavigationSurface::AgentEffect,
            ))
            .allowed());
        assert!(policy
            .authorize(TrustedNavigationRequest::new(
                "https://manual-again.example",
                TrustedNavigationSurface::Popup,
            ))
            .allowed());
    }

    #[test]
    fn denied_redirect_popup_and_iframe_are_durably_audited_for_the_active_handoff() {
        let temp = tempfile::tempdir().unwrap();
        let audit_path = temp.path().join("audit").join("actions.jsonl");
        let audit = Arc::new(JsonlSemanticAuditSink::new(audit_path.clone()));
        let policy = SessionNavigationPolicy::with_audit(audit);
        policy
            .activate(binding(7), ["https://allowed.example"])
            .unwrap();

        for surface in [
            TrustedNavigationSurface::Redirect,
            TrustedNavigationSurface::Popup,
            TrustedNavigationSurface::Iframe,
        ] {
            let decision = policy.authorize(TrustedNavigationRequest::new(
                "https://denied.example/private?token=DO_NOT_LOG_FULL_URL",
                surface,
            ));
            assert!(!decision.allowed());
        }

        let contents = std::fs::read_to_string(audit_path).expect("navigation audit");
        let records = contents
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).expect("audit json"))
            .collect::<Vec<_>>();
        assert_eq!(records.len(), 3);
        for record in records {
            assert_eq!(record["record"]["session_id"], "s");
            assert_eq!(record["record"]["handoff_epoch"], 7);
            assert_eq!(record["record"]["decision"], "denied");
            assert_eq!(record["record"]["cause_code"], "origin_not_granted");
            assert!(!record.to_string().contains("DO_NOT_LOG_FULL_URL"));
            assert!(!record.to_string().contains("/private"));
        }
    }

    #[test]
    fn paused_policy_retains_binding_and_audits_late_redirect_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        let audit_path = temp.path().join("audit").join("actions.jsonl");
        let audit = Arc::new(JsonlSemanticAuditSink::new(audit_path.clone()));
        let policy = SessionNavigationPolicy::with_audit(audit);
        policy
            .activate(binding(11), ["https://allowed.example"])
            .unwrap();
        policy.pause_agent().unwrap();

        let decision = policy.authorize(TrustedNavigationRequest::new(
            "https://allowed.example/late",
            TrustedNavigationSurface::Redirect,
        ));
        assert!(!decision.allowed());
        assert_eq!(decision.code(), "agent_control_paused");
        let record: serde_json::Value = serde_json::from_str(
            std::fs::read_to_string(audit_path)
                .unwrap()
                .lines()
                .next()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(record["record"]["handoff_epoch"], 11);
        assert_eq!(record["record"]["cause_code"], "agent_control_paused");
    }

    #[test]
    fn transfer_denials_are_audited_only_for_an_active_agent_grant() {
        let temp = tempfile::tempdir().unwrap();
        let audit_path = temp.path().join("audit").join("actions.jsonl");
        let audit = Arc::new(JsonlSemanticAuditSink::new(audit_path.clone()));
        let policy = SessionNavigationPolicy::with_audit(audit);

        assert_eq!(
            policy
                .record_security_event(TrustedSecurityEvent::UploadBlocked)
                .unwrap(),
            TrustedSecurityAuditDisposition::UserControl
        );
        assert!(!audit_path.exists());

        policy
            .activate(binding(9), ["https://allowed.example"])
            .unwrap();
        for event in [
            TrustedSecurityEvent::UploadBlocked,
            TrustedSecurityEvent::DownloadBlocked,
            TrustedSecurityEvent::DownloadCanceled,
        ] {
            assert_eq!(
                policy.record_security_event(event).unwrap(),
                TrustedSecurityAuditDisposition::Recorded
            );
        }

        let records = std::fs::read_to_string(audit_path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(records.len(), 3);
        assert_eq!(records[0]["phase"], "transfer_decision");
        assert_eq!(records[0]["record"]["session_id"], "s");
        assert_eq!(records[0]["record"]["handoff_epoch"], 9);
        assert_eq!(records[0]["record"]["decision"], "denied");
        assert_eq!(records[0]["record"]["event"], "upload_blocked");
        assert_eq!(records[1]["record"]["event"], "download_blocked");
        assert_eq!(records[2]["record"]["event"], "download_canceled");
    }

    #[test]
    fn preflight_denial_audit_contains_only_origin_fingerprint_scheme_and_port() {
        let temp = tempfile::tempdir().unwrap();
        let audit_path = temp.path().join("audit").join("actions.jsonl");
        let policy = SessionNavigationPolicy::with_audit(Arc::new(JsonlSemanticAuditSink::new(
            audit_path.clone(),
        )));
        policy
            .activate(binding(13), ["https://allowed.example"])
            .unwrap();
        policy
            .record_handoff_preflight_denial(TrustedHandoffPreflightDenial {
                kind: super::super::cdp::guard::TrustedHandoffPreflightDenialKind::ChildFrameOrigin,
                target_url: Some("https://raw-secret-host.example/private/path?token=raw-secret"),
            })
            .unwrap();

        let contents = std::fs::read_to_string(audit_path).unwrap();
        assert!(!contents.contains("raw-secret-host"));
        assert!(!contents.contains("private/path"));
        assert!(!contents.contains("raw-secret"));
        let record: serde_json::Value =
            serde_json::from_str(contents.lines().next().unwrap()).unwrap();
        assert_eq!(record["record"]["target_scheme"], "https");
        assert_eq!(record["record"]["target_port"], 443);
        assert_eq!(
            record["record"]["target_origin_sha256"]
                .as_str()
                .unwrap()
                .len(),
            64
        );

        policy.resume_user_control();
        let control = LoginBrowserControl::new();
        assert!(control.begin_operation(&binding(13), true).is_err());
        let decision = policy.authorize(TrustedNavigationRequest::new(
            "https://allowed.example/click",
            TrustedNavigationSurface::AgentEffect,
        ));
        assert!(!decision.allowed());
        assert_eq!(decision.code(), "no_active_handoff");
    }

    #[cfg(unix)]
    #[test]
    fn navigation_audit_storage_failure_is_a_terminal_policy_decision() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let audit_root = temp.path().join("audit");
        std::fs::create_dir(&audit_root).unwrap();
        let outside = temp.path().join("outside.jsonl");
        std::fs::write(&outside, b"sentinel").unwrap();
        let audit_path = audit_root.join("actions.jsonl");
        symlink(&outside, &audit_path).unwrap();
        let policy =
            SessionNavigationPolicy::with_audit(Arc::new(JsonlSemanticAuditSink::new(audit_path)));
        policy
            .activate(binding(19), ["https://allowed.example"])
            .unwrap();

        let decision = policy.authorize(TrustedNavigationRequest::new(
            "https://denied.example/redirect",
            TrustedNavigationSurface::Redirect,
        ));

        assert!(!decision.allowed());
        assert!(decision.terminal());
        assert_eq!(decision.code(), "navigation_audit_unavailable");
        assert_eq!(std::fs::read(&outside).unwrap(), b"sentinel");
    }
}
