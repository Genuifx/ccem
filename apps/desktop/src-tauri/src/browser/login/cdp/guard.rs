/// Closed navigation surfaces that require the trusted session policy before browser effect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::browser::login) enum TrustedNavigationSurface {
    AgentNavigation,
    AgentEffect,
    Redirect,
    Popup,
    Iframe,
}

/// Page/CDP data is carried only as an input to trusted Rust authority. This request deliberately
/// does not implement Deserialize and contains no grant, pause, profile, or handoff fields.
pub(in crate::browser::login) struct TrustedNavigationRequest<'a> {
    target_url: &'a str,
    surface: TrustedNavigationSurface,
}

impl<'a> TrustedNavigationRequest<'a> {
    pub(in crate::browser::login) fn new(
        target_url: &'a str,
        surface: TrustedNavigationSurface,
    ) -> Self {
        Self {
            target_url,
            surface,
        }
    }

    pub(in crate::browser::login) fn target_url(&self) -> &str {
        self.target_url
    }

    pub(in crate::browser::login) fn surface(&self) -> TrustedNavigationSurface {
        self.surface
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::browser::login) struct TrustedNavigationDecision {
    allowed: bool,
    terminal: bool,
    code: &'static str,
}

impl TrustedNavigationDecision {
    pub(in crate::browser::login) fn allow(code: &'static str) -> Self {
        Self::new(true, false, code)
    }

    pub(in crate::browser::login) fn deny(code: &'static str) -> Self {
        Self::new(false, false, code)
    }

    pub(in crate::browser::login) fn deny_terminal(code: &'static str) -> Self {
        Self::new(false, true, code)
    }

    fn new(allowed: bool, terminal: bool, code: &'static str) -> Self {
        let valid = !code.is_empty()
            && code.len() <= 64
            && code
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'_');
        if valid {
            Self {
                allowed,
                terminal,
                code,
            }
        } else {
            Self {
                allowed: false,
                terminal: true,
                code: "invalid_policy_decision",
            }
        }
    }

    pub(in crate::browser::login) fn allowed(self) -> bool {
        self.allowed
    }

    pub(in crate::browser::login) fn code(self) -> &'static str {
        self.code
    }

    pub(in crate::browser::login) fn terminal(self) -> bool {
        self.terminal
    }
}

/// Implemented by session-owned trusted state. CDP/page payloads can request a URL but can never
/// manufacture or mutate the grant and pause state consulted here.
pub(in crate::browser::login) trait TrustedNavigationGuard:
    Send + Sync
{
    fn authorize(&self, request: TrustedNavigationRequest<'_>) -> TrustedNavigationDecision;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_trusted_decision_fails_closed() {
        let decision = TrustedNavigationDecision::allow("NOT BOUNDED");
        assert!(!decision.allowed());
        assert!(decision.terminal());
        assert_eq!(decision.code(), "invalid_policy_decision");
    }
}
