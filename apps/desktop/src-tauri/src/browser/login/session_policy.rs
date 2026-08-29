use super::capability::JsonlSemanticAuditSink;
use super::cdp::guard::{
    TrustedNavigationDecision, TrustedNavigationGuard, TrustedNavigationRequest,
    TrustedNavigationSurface,
};
use super::policy::{
    authorize_browser_request, BrowserGrantBinding, BrowserPolicyRequest, BrowserPolicySurface,
    TrustedOriginGrant,
};
use std::sync::{Arc, Mutex};

#[derive(Debug)]
pub(super) enum SessionNavigationPolicyError {
    Unavailable,
}

/// Owner-thread navigation guard shared with trusted session state.
///
/// Manual user control intentionally has no Agent browser grant installed. Once the trusted UI
/// hands control to an Agent, every top-level request, redirect, popup, and iframe document passes
/// through the immutable handoff-bound browser grant. A transition retains that binding in a
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

    pub(super) fn activate(
        &self,
        binding: BrowserGrantBinding,
    ) -> Result<TrustedOriginGrant, SessionNavigationPolicyError> {
        let grant = TrustedOriginGrant::new_trusted(binding);
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
        if !paused
            && request.surface() == TrustedNavigationSurface::AgentEffect
            && request.target_url() == "about:blank"
        {
            return TrustedNavigationDecision::allow("agent_blank_effect");
        }
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
                target_url: Some(request.target_url()),
                paused,
            },
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

    fn binding(epoch: u64) -> BrowserGrantBinding {
        BrowserGrantBinding::new_trusted("w", "p", "s", epoch).unwrap()
    }

    #[test]
    fn manual_control_is_open_and_agent_handoff_is_browser_instance_scoped() {
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

        policy.activate(binding(1)).unwrap();
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
            assert!(policy
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
    fn active_agent_browser_can_cross_sites_for_search_and_oauth() {
        let policy = SessionNavigationPolicy::new();
        policy.activate(binding(2)).unwrap();

        for (surface, target) in [
            (
                TrustedNavigationSurface::AgentNavigation,
                "https://search.example/results?q=ccem",
            ),
            (
                TrustedNavigationSurface::Redirect,
                "https://identity.example/oauth/authorize",
            ),
            (
                TrustedNavigationSurface::Popup,
                "https://accounts.example/sign-in",
            ),
            (
                TrustedNavigationSurface::Iframe,
                "https://identity.example/session-check",
            ),
        ] {
            let decision = policy.authorize(TrustedNavigationRequest::new(target, surface));
            assert!(
                decision.allowed(),
                "active browser ownership should allow {surface:?}: {}",
                decision.code()
            );
        }
    }

    #[test]
    fn active_agent_can_inspect_exact_blank_page_without_relaxing_navigation() {
        let policy = SessionNavigationPolicy::new();
        policy.activate(binding(3)).unwrap();

        let blank_effect = policy.authorize(TrustedNavigationRequest::new(
            "about:blank",
            TrustedNavigationSurface::AgentEffect,
        ));
        assert!(blank_effect.allowed());
        assert_eq!(blank_effect.code(), "agent_blank_effect");

        for (surface, target) in [
            (
                TrustedNavigationSurface::AgentEffect,
                "about:blank#fragment",
            ),
            (TrustedNavigationSurface::AgentNavigation, "about:blank"),
            (TrustedNavigationSurface::Redirect, "about:blank"),
            (TrustedNavigationSurface::Popup, "about:blank"),
            (TrustedNavigationSurface::Iframe, "about:blank"),
        ] {
            assert!(!policy
                .authorize(TrustedNavigationRequest::new(target, surface))
                .allowed());
        }

        policy.pause_agent().unwrap();
        assert!(!policy
            .authorize(TrustedNavigationRequest::new(
                "about:blank",
                TrustedNavigationSurface::AgentEffect,
            ))
            .allowed());

        policy.resume_user_control();
        assert!(!policy
            .authorize(TrustedNavigationRequest::new(
                "about:blank",
                TrustedNavigationSurface::AgentEffect,
            ))
            .allowed());
    }

    #[test]
    fn invalid_scheme_redirect_popup_and_iframe_are_durably_audited() {
        let temp = tempfile::tempdir().unwrap();
        let audit_path = temp.path().join("audit").join("actions.jsonl");
        let audit = Arc::new(JsonlSemanticAuditSink::new(audit_path.clone()));
        let policy = SessionNavigationPolicy::with_audit(audit);
        policy.activate(binding(7)).unwrap();

        for surface in [
            TrustedNavigationSurface::Redirect,
            TrustedNavigationSurface::Popup,
            TrustedNavigationSurface::Iframe,
        ] {
            let decision = policy.authorize(TrustedNavigationRequest::new(
                "file:///private/DO_NOT_LOG_FULL_URL",
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
            assert_eq!(record["record"]["cause_code"], "unsupported_origin_scheme");
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
        policy.activate(binding(11)).unwrap();
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
        policy.activate(binding(19)).unwrap();

        let decision = policy.authorize(TrustedNavigationRequest::new(
            "file:///private/redirect",
            TrustedNavigationSurface::Redirect,
        ));

        assert!(!decision.allowed());
        assert!(decision.terminal());
        assert_eq!(decision.code(), "navigation_audit_unavailable");
        assert_eq!(std::fs::read(&outside).unwrap(), b"sentinel");
    }
}
