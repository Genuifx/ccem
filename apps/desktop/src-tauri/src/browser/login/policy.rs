use serde::Serialize;
use std::fmt;

const MAX_BINDING_COMPONENT_CHARS: usize = 256;

/// An origin reduced to the only components that participate in browser authorization.
///
/// The URL parser performs IDNA conversion and host canonicalization. We additionally remove a
/// terminal DNS root dot and materialize the scheme's default port so equivalent URL spellings
/// compare equal. Paths, queries, fragments, and page-provided display strings never participate
/// in authorization.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
pub(super) struct NormalizedOrigin {
    scheme: OriginScheme,
    host: String,
    port: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
enum OriginScheme {
    Http,
    Https,
}

impl NormalizedOrigin {
    pub(super) fn parse(raw: &str) -> Result<Self, BrowserPolicyError> {
        let parsed = tauri::Url::parse(raw.trim()).map_err(|_| {
            BrowserPolicyError::new(
                BrowserPolicyCode::InvalidOrigin,
                "Browser origin is not a valid URL.",
            )
        })?;
        if !parsed.username().is_empty() || parsed.password().is_some() {
            return Err(BrowserPolicyError::new(
                BrowserPolicyCode::OriginCredentialsForbidden,
                "Browser origins containing URL credentials are forbidden.",
            ));
        }

        let scheme = match parsed.scheme() {
            "http" => OriginScheme::Http,
            "https" => OriginScheme::Https,
            _ => {
                return Err(BrowserPolicyError::new(
                    BrowserPolicyCode::UnsupportedOriginScheme,
                    "Browser origin must use HTTP or HTTPS.",
                ))
            }
        };
        let raw_host = parsed.host_str().ok_or_else(|| {
            BrowserPolicyError::new(
                BrowserPolicyCode::InvalidOrigin,
                "Browser origin must contain a host.",
            )
        })?;
        if raw_host.ends_with("..") {
            return Err(BrowserPolicyError::new(
                BrowserPolicyCode::InvalidOrigin,
                "Browser origin host contains an invalid terminal dot.",
            ));
        }
        let host = raw_host
            .strip_suffix('.')
            .unwrap_or(raw_host)
            .to_ascii_lowercase();
        let host = (!host.is_empty())
            .then_some(host)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                BrowserPolicyError::new(
                    BrowserPolicyCode::InvalidOrigin,
                    "Browser origin must contain a host.",
                )
            })?;
        let port = parsed.port_or_known_default().ok_or_else(|| {
            BrowserPolicyError::new(
                BrowserPolicyCode::InvalidOrigin,
                "Browser origin must contain a valid effective port.",
            )
        })?;

        Ok(Self { scheme, host, port })
    }

    pub(super) fn scheme(&self) -> &'static str {
        match self.scheme {
            OriginScheme::Http => "http",
            OriginScheme::Https => "https",
        }
    }

    pub(super) fn host(&self) -> &str {
        &self.host
    }

    pub(super) fn port(&self) -> u16 {
        self.port
    }

    pub(super) fn as_serialized_origin(&self) -> String {
        let host = if self.host.contains(':') && !self.host.starts_with('[') {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        };
        format!("{}://{}:{}", self.scheme(), host, self.port)
    }
}

impl fmt::Display for NormalizedOrigin {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.as_serialized_origin())
    }
}

/// Immutable identity attached by the trusted Login Browser service.
///
/// This type deliberately does not implement `Deserialize`. Agent or page payloads may describe a
/// desired URL or semantic action, but they cannot manufacture the authority used by this policy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct BrowserGrantBinding {
    workspace_identity: String,
    profile_id: String,
    session_id: String,
    handoff_epoch: u64,
}

impl BrowserGrantBinding {
    pub(super) fn new_trusted(
        workspace_identity: impl Into<String>,
        profile_id: impl Into<String>,
        session_id: impl Into<String>,
        handoff_epoch: u64,
    ) -> Result<Self, BrowserPolicyError> {
        Ok(Self {
            workspace_identity: bounded_binding_component(
                workspace_identity.into(),
                "Workspace identity is invalid.",
            )?,
            profile_id: bounded_binding_component(profile_id.into(), "Profile id is invalid.")?,
            session_id: bounded_binding_component(session_id.into(), "Session id is invalid.")?,
            handoff_epoch,
        })
    }

    pub(super) fn workspace_identity(&self) -> &str {
        &self.workspace_identity
    }

    pub(super) fn profile_id(&self) -> &str {
        &self.profile_id
    }

    pub(super) fn session_id(&self) -> &str {
        &self.session_id
    }

    pub(super) fn handoff_epoch(&self) -> u64 {
        self.handoff_epoch
    }

    fn same_identity(&self, other: &Self) -> bool {
        self.workspace_identity == other.workspace_identity
            && self.profile_id == other.profile_id
            && self.session_id == other.session_id
    }
}

fn bounded_binding_component(
    value: String,
    message: &'static str,
) -> Result<String, BrowserPolicyError> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().count() > MAX_BINDING_COMPONENT_CHARS
        || value.chars().any(char::is_control)
    {
        return Err(BrowserPolicyError::new(
            BrowserPolicyCode::InvalidGrantBinding,
            message,
        ));
    }
    Ok(value.to_string())
}

/// Browser-instance authority minted by trusted CCEM UI/service code for one handoff epoch.
///
/// The legacy type name is retained locally to keep the handoff/capability seam small. Authority
/// is intentionally bound to the exact browser instance identity, not to the origin visible when
/// the user handed it off.
#[derive(Debug, Clone)]
pub(super) struct TrustedOriginGrant {
    binding: BrowserGrantBinding,
}

impl TrustedOriginGrant {
    pub(super) fn new_trusted(binding: BrowserGrantBinding) -> Self {
        Self { binding }
    }

    pub(super) fn binding(&self) -> &BrowserGrantBinding {
        &self.binding
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum BrowserPolicySurface {
    InitialNavigation,
    Redirect,
    Popup,
    IframeAction,
    Mutation,
}

/// Untrusted action attributes plus trusted service state. `paused` and `binding` must come from
/// the Rust session registry, never from the Agent request or page content.
pub(super) struct BrowserPolicyRequest<'a> {
    pub(super) binding: &'a BrowserGrantBinding,
    pub(super) surface: BrowserPolicySurface,
    pub(super) target_url: Option<&'a str>,
    pub(super) paused: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum BrowserPolicyCode {
    Allowed,
    InvalidGrantBinding,
    InvalidOrigin,
    OriginCredentialsForbidden,
    UnsupportedOriginScheme,
    GrantBindingMismatch,
    HandoffEpochMismatch,
    AgentControlPaused,
}

impl BrowserPolicyCode {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Allowed => "allowed",
            Self::InvalidGrantBinding => "invalid_grant_binding",
            Self::InvalidOrigin => "invalid_origin",
            Self::OriginCredentialsForbidden => "origin_credentials_forbidden",
            Self::UnsupportedOriginScheme => "unsupported_origin_scheme",
            Self::GrantBindingMismatch => "grant_binding_mismatch",
            Self::HandoffEpochMismatch => "handoff_epoch_mismatch",
            Self::AgentControlPaused => "agent_control_paused",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct BrowserPolicyDecision {
    pub(super) allowed: bool,
    pub(super) code: BrowserPolicyCode,
    pub(super) surface: BrowserPolicySurface,
    pub(super) target_origin: Option<String>,
    pub(super) handoff_epoch: u64,
}

impl BrowserPolicyDecision {
    fn allow(
        request: &BrowserPolicyRequest<'_>,
        target: Option<&NormalizedOrigin>,
        code: BrowserPolicyCode,
    ) -> Self {
        Self {
            allowed: true,
            code,
            surface: request.surface,
            target_origin: target.map(NormalizedOrigin::as_serialized_origin),
            handoff_epoch: request.binding.handoff_epoch,
        }
    }

    fn deny(
        request: &BrowserPolicyRequest<'_>,
        target: Option<&NormalizedOrigin>,
        code: BrowserPolicyCode,
    ) -> Self {
        Self {
            allowed: false,
            code,
            surface: request.surface,
            target_origin: target.map(NormalizedOrigin::as_serialized_origin),
            handoff_epoch: request.binding.handoff_epoch,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct BrowserPolicyError {
    pub(super) code: BrowserPolicyCode,
    message: &'static str,
}

impl BrowserPolicyError {
    fn new(code: BrowserPolicyCode, message: &'static str) -> Self {
        Self { code, message }
    }

    pub(super) fn message(&self) -> &'static str {
        self.message
    }
}

impl fmt::Display for BrowserPolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for BrowserPolicyError {}

/// The single decision path for browser-instance-owned HTTP(S) surfaces.
pub(super) fn authorize_browser_request(
    grant: &TrustedOriginGrant,
    request: BrowserPolicyRequest<'_>,
) -> BrowserPolicyDecision {
    if request.paused {
        return BrowserPolicyDecision::deny(&request, None, BrowserPolicyCode::AgentControlPaused);
    }
    if !grant.binding.same_identity(request.binding) {
        return BrowserPolicyDecision::deny(
            &request,
            None,
            BrowserPolicyCode::GrantBindingMismatch,
        );
    }
    if grant.binding.handoff_epoch != request.binding.handoff_epoch {
        return BrowserPolicyDecision::deny(
            &request,
            None,
            BrowserPolicyCode::HandoffEpochMismatch,
        );
    }

    let target = match request.target_url {
        Some(target_url) => match NormalizedOrigin::parse(target_url) {
            Ok(target) => Some(target),
            Err(error) => return BrowserPolicyDecision::deny(&request, None, error.code),
        },
        None => None,
    };
    BrowserPolicyDecision::allow(&request, target.as_ref(), BrowserPolicyCode::Allowed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(epoch: u64) -> BrowserGrantBinding {
        BrowserGrantBinding::new_trusted("workspace-1", "profile-1", "session-1", epoch)
            .expect("trusted binding")
    }

    fn grant(epoch: u64) -> TrustedOriginGrant {
        TrustedOriginGrant::new_trusted(binding(epoch))
    }

    fn request<'a>(
        binding: &'a BrowserGrantBinding,
        surface: BrowserPolicySurface,
        target_url: &'a str,
    ) -> BrowserPolicyRequest<'a> {
        BrowserPolicyRequest {
            binding,
            surface,
            target_url: Some(target_url),
            paused: false,
        }
    }

    #[test]
    fn origin_normalization_is_exact_and_canonical() {
        let mixed = NormalizedOrigin::parse("https://BÜCHER.Example./path?q=1")
            .expect("normalize IDNA host");
        assert_eq!(mixed.scheme(), "https");
        assert_eq!(mixed.host(), "xn--bcher-kva.example");
        assert_eq!(mixed.port(), 443);
        assert_eq!(mixed.to_string(), "https://xn--bcher-kva.example:443");

        assert_eq!(
            NormalizedOrigin::parse("https://example.test").expect("implicit HTTPS port"),
            NormalizedOrigin::parse("https://EXAMPLE.TEST:443/anything")
                .expect("explicit HTTPS port")
        );
        assert_eq!(
            NormalizedOrigin::parse("http://example.test")
                .expect("implicit HTTP port")
                .port(),
            80
        );
        assert_ne!(
            NormalizedOrigin::parse("https://example.test:8443").expect("custom port"),
            NormalizedOrigin::parse("https://example.test").expect("default port")
        );
        assert_eq!(
            NormalizedOrigin::parse("http://[0:0:0:0:0:0:0:1]:80/path")
                .expect("IPv6 origin")
                .to_string(),
            "http://[::1]:80"
        );
    }

    #[test]
    fn credentials_and_opaque_or_unsupported_urls_fail_closed() {
        assert_eq!(
            NormalizedOrigin::parse("https://user:pass@example.test")
                .expect_err("userinfo must be rejected")
                .code,
            BrowserPolicyCode::OriginCredentialsForbidden
        );
        for value in [
            "data:text/html,hello",
            "about:blank",
            "file:///tmp/secret",
            "javascript:alert(1)",
            "https://example.test../path",
        ] {
            assert!(
                NormalizedOrigin::parse(value).is_err(),
                "must reject {value}"
            );
        }
    }

    #[test]
    fn active_browser_grant_allows_normal_cross_site_http_workflows() {
        let grant = grant(7);
        let binding = binding(7);
        for (surface, target) in [
            (
                BrowserPolicySurface::InitialNavigation,
                "https://search.example/results?q=ccem",
            ),
            (
                BrowserPolicySurface::Redirect,
                "https://identity.example/oauth/authorize",
            ),
            (
                BrowserPolicySurface::Popup,
                "https://accounts.example/sign-in",
            ),
            (
                BrowserPolicySurface::IframeAction,
                "https://payments.example/confirm",
            ),
            (
                BrowserPolicySurface::Mutation,
                "https://destination.example/form",
            ),
        ] {
            let decision = authorize_browser_request(&grant, request(&binding, surface, target));
            assert!(
                decision.allowed,
                "active browser ownership should allow {surface:?}: {}",
                decision.code.as_str()
            );
        }
    }

    #[test]
    fn browser_instance_grant_still_rejects_non_http_schemes() {
        let grant = grant(10);
        let binding = binding(10);

        for target in [
            "about:blank",
            "data:text/html,hello",
            "file:///tmp/private",
            "javascript:alert(1)",
        ] {
            let decision = authorize_browser_request(
                &grant,
                request(&binding, BrowserPolicySurface::InitialNavigation, target),
            );
            assert!(!decision.allowed, "must reject {target}");
            assert!(matches!(
                decision.code,
                BrowserPolicyCode::InvalidOrigin | BrowserPolicyCode::UnsupportedOriginScheme
            ));
        }
    }

    #[test]
    fn grant_is_bound_to_workspace_profile_session_and_handoff_epoch() {
        let grant = grant(3);
        for mismatch in [
            BrowserGrantBinding::new_trusted("workspace-2", "profile-1", "session-1", 3)
                .expect("workspace mismatch"),
            BrowserGrantBinding::new_trusted("workspace-1", "profile-2", "session-1", 3)
                .expect("profile mismatch"),
            BrowserGrantBinding::new_trusted("workspace-1", "profile-1", "session-2", 3)
                .expect("session mismatch"),
        ] {
            let denied = authorize_browser_request(
                &grant,
                request(
                    &mismatch,
                    BrowserPolicySurface::Mutation,
                    "https://allowed.example",
                ),
            );
            assert_eq!(denied.code, BrowserPolicyCode::GrantBindingMismatch);
        }

        let stale_epoch = binding(4);
        let denied = authorize_browser_request(
            &grant,
            request(
                &stale_epoch,
                BrowserPolicySurface::Mutation,
                "https://allowed.example",
            ),
        );
        assert_eq!(denied.code, BrowserPolicyCode::HandoffEpochMismatch);
    }

    #[test]
    fn paused_state_cannot_be_overridden_by_page_or_action_data() {
        let grant = grant(9);
        let binding = binding(9);
        let mut paused_request = request(
            &binding,
            BrowserPolicySurface::Mutation,
            "https://allowed.example/?resume=true",
        );
        paused_request.paused = true;
        let denied = authorize_browser_request(&grant, paused_request);
        assert_eq!(denied.code, BrowserPolicyCode::AgentControlPaused);
    }

    #[test]
    fn policy_codes_are_stable_and_bounded() {
        for code in [
            BrowserPolicyCode::Allowed,
            BrowserPolicyCode::InvalidGrantBinding,
            BrowserPolicyCode::InvalidOrigin,
            BrowserPolicyCode::OriginCredentialsForbidden,
            BrowserPolicyCode::UnsupportedOriginScheme,
            BrowserPolicyCode::GrantBindingMismatch,
            BrowserPolicyCode::HandoffEpochMismatch,
            BrowserPolicyCode::AgentControlPaused,
        ] {
            let value = code.as_str();
            assert!(value.len() <= 64);
            assert!(value
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'_'));
        }
    }
}
