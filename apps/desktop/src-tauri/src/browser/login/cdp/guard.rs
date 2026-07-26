/// Closed navigation surfaces that require the trusted session policy before browser effect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::browser::login) enum TrustedNavigationSurface {
    AgentNavigation,
    AgentEffect,
    Redirect,
    Popup,
    Iframe,
}

/// Closed security events emitted only after Chromium has denied or canceled the transfer.
/// Browser payload fields are deliberately absent, so URLs, GUIDs, filenames, and paths cannot
/// cross into the trusted audit hook.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::browser::login) enum TrustedSecurityEvent {
    UploadBlocked,
    DownloadBlocked,
    DownloadCanceled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::browser::login) enum TrustedHandoffPreflightDenialKind {
    ExtraPage,
    TopLevelOrigin,
    ChildFrameOrigin,
    InvalidInventory,
}

impl TrustedHandoffPreflightDenialKind {
    pub(in crate::browser::login) fn surface(self) -> &'static str {
        match self {
            Self::ExtraPage | Self::TopLevelOrigin => "handoff_preflight_page",
            Self::ChildFrameOrigin => "handoff_preflight_iframe",
            Self::InvalidInventory => "handoff_preflight_inventory",
        }
    }

    pub(in crate::browser::login) fn cause_code(self) -> &'static str {
        match self {
            Self::ExtraPage => "extra_page",
            Self::TopLevelOrigin => "top_level_origin",
            Self::ChildFrameOrigin => "child_frame_origin",
            Self::InvalidInventory => "invalid_inventory",
        }
    }
}

pub(in crate::browser::login) struct TrustedHandoffPreflightDenial<'a> {
    pub(in crate::browser::login) kind: TrustedHandoffPreflightDenialKind,
    pub(in crate::browser::login) target_url: Option<&'a str>,
}

impl TrustedSecurityEvent {
    pub(in crate::browser::login) fn as_str(self) -> &'static str {
        match self {
            Self::UploadBlocked => "upload_blocked",
            Self::DownloadBlocked => "download_blocked",
            Self::DownloadCanceled => "download_canceled",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::browser::login) enum TrustedSecurityAuditDisposition {
    Recorded,
    UserControl,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::browser::login) struct TrustedSecurityAuditFailure;

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

    fn record_handoff_preflight_denial(
        &self,
        _denial: TrustedHandoffPreflightDenial<'_>,
    ) -> Result<(), TrustedSecurityAuditFailure> {
        Err(TrustedSecurityAuditFailure)
    }

    /// The default is intentionally terminal. Production cannot silently add a new trusted guard
    /// that authorizes navigation but drops transfer-denial audit evidence.
    fn record_security_event(
        &self,
        _event: TrustedSecurityEvent,
    ) -> Result<TrustedSecurityAuditDisposition, TrustedSecurityAuditFailure> {
        Err(TrustedSecurityAuditFailure)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct AuthorizationOnly;

    impl TrustedNavigationGuard for AuthorizationOnly {
        fn authorize(&self, _request: TrustedNavigationRequest<'_>) -> TrustedNavigationDecision {
            TrustedNavigationDecision::allow("allowed")
        }
    }

    #[test]
    fn malformed_trusted_decision_fails_closed() {
        let decision = TrustedNavigationDecision::allow("NOT BOUNDED");
        assert!(!decision.allowed());
        assert!(decision.terminal());
        assert_eq!(decision.code(), "invalid_policy_decision");
    }

    #[test]
    fn security_events_are_closed_and_unimplemented_audit_hooks_fail_closed() {
        assert_eq!(
            TrustedSecurityEvent::UploadBlocked.as_str(),
            "upload_blocked"
        );
        assert_eq!(
            TrustedSecurityEvent::DownloadBlocked.as_str(),
            "download_blocked"
        );
        assert_eq!(
            TrustedSecurityEvent::DownloadCanceled.as_str(),
            "download_canceled"
        );
        assert!(AuthorizationOnly
            .record_security_event(TrustedSecurityEvent::UploadBlocked)
            .is_err());
    }
}
