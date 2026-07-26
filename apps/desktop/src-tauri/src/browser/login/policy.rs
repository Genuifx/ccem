use serde::Serialize;
use std::collections::BTreeSet;
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

/// An origin allowlist minted by trusted CCEM UI/service code for one handoff epoch.
#[derive(Debug, Clone)]
pub(super) struct TrustedOriginGrant {
    binding: BrowserGrantBinding,
    origins: BTreeSet<NormalizedOrigin>,
}

impl TrustedOriginGrant {
    pub(super) fn new_trusted<I, S>(
        binding: BrowserGrantBinding,
        origins: I,
    ) -> Result<Self, BrowserPolicyError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let origins = origins
            .into_iter()
            .map(|origin| NormalizedOrigin::parse(origin.as_ref()))
            .collect::<Result<BTreeSet<_>, _>>()?;
        Ok(Self { binding, origins })
    }

    pub(super) fn binding(&self) -> &BrowserGrantBinding {
        &self.binding
    }

    pub(super) fn origins(&self) -> impl Iterator<Item = &NormalizedOrigin> {
        self.origins.iter()
    }
}

/// A one-use trusted confirmation for carrying data read at one origin into a mutating action at
/// another. It is intentionally separate from the ordinary origin allowlist: granting both sites
/// does not silently grant a cross-site data flow.
#[derive(Debug)]
pub(super) struct TrustedCrossOriginConfirmation {
    binding: BrowserGrantBinding,
    source: NormalizedOrigin,
    destination: NormalizedOrigin,
    consumed: bool,
}

impl TrustedCrossOriginConfirmation {
    pub(super) fn new_trusted(
        binding: BrowserGrantBinding,
        source: NormalizedOrigin,
        destination: NormalizedOrigin,
    ) -> Self {
        Self {
            binding,
            source,
            destination,
            consumed: false,
        }
    }

    pub(super) fn is_consumed(&self) -> bool {
        self.consumed
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum BrowserPolicyEffect {
    Navigate,
    Mutate,
}

/// App-owned persisted provenance projected into the common origin-policy decision path.
///
/// The ledger stores only origin fingerprints, so a different prior origin cannot be recreated as
/// a raw `NormalizedOrigin`. This closed enum lets policy reject that case without weakening the
/// existing durable capability-decision audit boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum BrowserDataProvenance {
    UntrackedOrSameOrigin,
    CrossOrigin,
    Mixed,
}

/// Untrusted action attributes plus trusted service state. `paused` and `binding` must come from
/// the Rust session registry, never from the Agent request or page content.
pub(super) struct BrowserPolicyRequest<'a> {
    pub(super) binding: &'a BrowserGrantBinding,
    pub(super) surface: BrowserPolicySurface,
    pub(super) effect: BrowserPolicyEffect,
    pub(super) target_url: &'a str,
    pub(super) source_data_origin: Option<&'a NormalizedOrigin>,
    pub(super) data_provenance: BrowserDataProvenance,
    pub(super) paused: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum BrowserPolicyCode {
    Allowed,
    AllowedWithCrossOriginConfirmation,
    InvalidGrantBinding,
    InvalidOrigin,
    OriginCredentialsForbidden,
    UnsupportedOriginScheme,
    OriginNotGranted,
    SourceOriginNotGranted,
    GrantBindingMismatch,
    HandoffEpochMismatch,
    AgentControlPaused,
    CrossOriginWriteBlocked,
    MixedProvenanceWriteBlocked,
    CrossOriginConfirmationMismatch,
    CrossOriginConfirmationConsumed,
}

impl BrowserPolicyCode {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Allowed => "allowed",
            Self::AllowedWithCrossOriginConfirmation => "allowed_with_cross_origin_confirmation",
            Self::InvalidGrantBinding => "invalid_grant_binding",
            Self::InvalidOrigin => "invalid_origin",
            Self::OriginCredentialsForbidden => "origin_credentials_forbidden",
            Self::UnsupportedOriginScheme => "unsupported_origin_scheme",
            Self::OriginNotGranted => "origin_not_granted",
            Self::SourceOriginNotGranted => "source_origin_not_granted",
            Self::GrantBindingMismatch => "grant_binding_mismatch",
            Self::HandoffEpochMismatch => "handoff_epoch_mismatch",
            Self::AgentControlPaused => "agent_control_paused",
            Self::CrossOriginWriteBlocked => "cross_origin_write_blocked",
            Self::MixedProvenanceWriteBlocked => "mixed_provenance_write_blocked",
            Self::CrossOriginConfirmationMismatch => "cross_origin_confirmation_mismatch",
            Self::CrossOriginConfirmationConsumed => "cross_origin_confirmation_consumed",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct BrowserPolicyDecision {
    pub(super) allowed: bool,
    pub(super) code: BrowserPolicyCode,
    pub(super) surface: BrowserPolicySurface,
    pub(super) target_origin: Option<String>,
    pub(super) source_data_origin: Option<String>,
    pub(super) handoff_epoch: u64,
}

impl BrowserPolicyDecision {
    fn allow(
        request: &BrowserPolicyRequest<'_>,
        target: &NormalizedOrigin,
        code: BrowserPolicyCode,
    ) -> Self {
        Self {
            allowed: true,
            code,
            surface: request.surface,
            target_origin: Some(target.as_serialized_origin()),
            source_data_origin: request
                .source_data_origin
                .map(NormalizedOrigin::as_serialized_origin),
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
            source_data_origin: request
                .source_data_origin
                .map(NormalizedOrigin::as_serialized_origin),
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

/// The single fail-closed decision path for all origin-sensitive browser surfaces.
pub(super) fn authorize_browser_request(
    grant: &TrustedOriginGrant,
    request: BrowserPolicyRequest<'_>,
    confirmation: Option<&mut TrustedCrossOriginConfirmation>,
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

    let target = match NormalizedOrigin::parse(request.target_url) {
        Ok(target) => target,
        Err(error) => return BrowserPolicyDecision::deny(&request, None, error.code),
    };
    if !grant.origins.contains(&target) {
        return BrowserPolicyDecision::deny(
            &request,
            Some(&target),
            BrowserPolicyCode::OriginNotGranted,
        );
    }

    if let Some(source) = request.source_data_origin {
        if !grant.origins.contains(source) {
            return BrowserPolicyDecision::deny(
                &request,
                Some(&target),
                BrowserPolicyCode::SourceOriginNotGranted,
            );
        }
    }

    if request.effect == BrowserPolicyEffect::Mutate {
        match request.data_provenance {
            BrowserDataProvenance::UntrackedOrSameOrigin => {}
            BrowserDataProvenance::CrossOrigin => {
                return BrowserPolicyDecision::deny(
                    &request,
                    Some(&target),
                    BrowserPolicyCode::CrossOriginWriteBlocked,
                );
            }
            BrowserDataProvenance::Mixed => {
                return BrowserPolicyDecision::deny(
                    &request,
                    Some(&target),
                    BrowserPolicyCode::MixedProvenanceWriteBlocked,
                );
            }
        }
    }

    let cross_origin_source = request
        .source_data_origin
        .filter(|source| request.effect == BrowserPolicyEffect::Mutate && *source != &target);
    let Some(source) = cross_origin_source else {
        return BrowserPolicyDecision::allow(&request, &target, BrowserPolicyCode::Allowed);
    };
    let Some(confirmation) = confirmation else {
        return BrowserPolicyDecision::deny(
            &request,
            Some(&target),
            BrowserPolicyCode::CrossOriginWriteBlocked,
        );
    };
    if confirmation.consumed {
        return BrowserPolicyDecision::deny(
            &request,
            Some(&target),
            BrowserPolicyCode::CrossOriginConfirmationConsumed,
        );
    }
    if !confirmation.binding.same_identity(request.binding)
        || confirmation.binding.handoff_epoch != request.binding.handoff_epoch
        || confirmation.source != *source
        || confirmation.destination != target
    {
        return BrowserPolicyDecision::deny(
            &request,
            Some(&target),
            BrowserPolicyCode::CrossOriginConfirmationMismatch,
        );
    }

    confirmation.consumed = true;
    BrowserPolicyDecision::allow(
        &request,
        &target,
        BrowserPolicyCode::AllowedWithCrossOriginConfirmation,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(epoch: u64) -> BrowserGrantBinding {
        BrowserGrantBinding::new_trusted("workspace-1", "profile-1", "session-1", epoch)
            .expect("trusted binding")
    }

    fn grant(epoch: u64) -> TrustedOriginGrant {
        TrustedOriginGrant::new_trusted(
            binding(epoch),
            ["https://allowed.example", "https://write.example:443"],
        )
        .expect("trusted origin grant")
    }

    fn request<'a>(
        binding: &'a BrowserGrantBinding,
        surface: BrowserPolicySurface,
        effect: BrowserPolicyEffect,
        target_url: &'a str,
        source_data_origin: Option<&'a NormalizedOrigin>,
    ) -> BrowserPolicyRequest<'a> {
        BrowserPolicyRequest {
            binding,
            surface,
            effect,
            target_url,
            source_data_origin,
            data_provenance: BrowserDataProvenance::UntrackedOrSameOrigin,
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
    fn every_surface_uses_the_same_fail_closed_origin_gate() {
        let grant = grant(7);
        let binding = binding(7);
        for (surface, effect) in [
            (
                BrowserPolicySurface::InitialNavigation,
                BrowserPolicyEffect::Navigate,
            ),
            (
                BrowserPolicySurface::Redirect,
                BrowserPolicyEffect::Navigate,
            ),
            (BrowserPolicySurface::Popup, BrowserPolicyEffect::Navigate),
            (
                BrowserPolicySurface::IframeAction,
                BrowserPolicyEffect::Mutate,
            ),
            (BrowserPolicySurface::Mutation, BrowserPolicyEffect::Mutate),
        ] {
            let allowed = authorize_browser_request(
                &grant,
                request(
                    &binding,
                    surface,
                    effect,
                    "https://allowed.example/page",
                    None,
                ),
                None,
            );
            assert!(allowed.allowed, "{surface:?} should allow a granted origin");

            let denied = authorize_browser_request(
                &grant,
                request(
                    &binding,
                    surface,
                    effect,
                    "https://denied.example/page",
                    None,
                ),
                None,
            );
            assert_eq!(denied.code, BrowserPolicyCode::OriginNotGranted);
            assert!(!denied.allowed);
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
                    BrowserPolicyEffect::Mutate,
                    "https://allowed.example",
                    None,
                ),
                None,
            );
            assert_eq!(denied.code, BrowserPolicyCode::GrantBindingMismatch);
        }

        let stale_epoch = binding(4);
        let denied = authorize_browser_request(
            &grant,
            request(
                &stale_epoch,
                BrowserPolicySurface::Mutation,
                BrowserPolicyEffect::Mutate,
                "https://allowed.example",
                None,
            ),
            None,
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
            BrowserPolicyEffect::Mutate,
            "https://allowed.example/?resume=true",
            None,
        );
        paused_request.paused = true;
        let denied = authorize_browser_request(&grant, paused_request, None);
        assert_eq!(denied.code, BrowserPolicyCode::AgentControlPaused);
    }

    #[test]
    fn cross_origin_read_to_write_requires_matching_one_use_confirmation() {
        let grant = grant(11);
        let binding = binding(11);
        let source = NormalizedOrigin::parse("https://allowed.example").expect("source");
        let destination = NormalizedOrigin::parse("https://write.example").expect("destination");

        let denied = authorize_browser_request(
            &grant,
            request(
                &binding,
                BrowserPolicySurface::Mutation,
                BrowserPolicyEffect::Mutate,
                "https://write.example/form",
                Some(&source),
            ),
            None,
        );
        assert_eq!(denied.code, BrowserPolicyCode::CrossOriginWriteBlocked);

        let mut confirmation = TrustedCrossOriginConfirmation::new_trusted(
            binding.clone(),
            source.clone(),
            destination,
        );
        let allowed = authorize_browser_request(
            &grant,
            request(
                &binding,
                BrowserPolicySurface::Mutation,
                BrowserPolicyEffect::Mutate,
                "https://write.example/form",
                Some(&source),
            ),
            Some(&mut confirmation),
        );
        assert_eq!(
            allowed.code,
            BrowserPolicyCode::AllowedWithCrossOriginConfirmation
        );
        assert!(confirmation.is_consumed());

        let denied_reuse = authorize_browser_request(
            &grant,
            request(
                &binding,
                BrowserPolicySurface::Mutation,
                BrowserPolicyEffect::Mutate,
                "https://write.example/again",
                Some(&source),
            ),
            Some(&mut confirmation),
        );
        assert_eq!(
            denied_reuse.code,
            BrowserPolicyCode::CrossOriginConfirmationConsumed
        );
    }

    #[test]
    fn persisted_cross_origin_and_mixed_provenance_fail_closed_in_policy() {
        let grant = grant(15);
        let binding = binding(15);
        for (provenance, expected) in [
            (
                BrowserDataProvenance::CrossOrigin,
                BrowserPolicyCode::CrossOriginWriteBlocked,
            ),
            (
                BrowserDataProvenance::Mixed,
                BrowserPolicyCode::MixedProvenanceWriteBlocked,
            ),
        ] {
            let mut write = request(
                &binding,
                BrowserPolicySurface::Mutation,
                BrowserPolicyEffect::Mutate,
                "https://allowed.example/form",
                None,
            );
            write.data_provenance = provenance;
            let denied = authorize_browser_request(&grant, write, None);
            assert!(!denied.allowed);
            assert_eq!(denied.code, expected);
        }
    }

    #[test]
    fn mismatched_cross_origin_confirmation_fails_without_consuming_the_grant() {
        let grant = grant(13);
        let binding = binding(13);
        let source = NormalizedOrigin::parse("https://allowed.example").expect("source");
        let wrong_destination =
            NormalizedOrigin::parse("https://allowed.example").expect("wrong destination");
        let mut confirmation = TrustedCrossOriginConfirmation::new_trusted(
            binding.clone(),
            source.clone(),
            wrong_destination,
        );
        let denied = authorize_browser_request(
            &grant,
            request(
                &binding,
                BrowserPolicySurface::Mutation,
                BrowserPolicyEffect::Mutate,
                "https://write.example/form",
                Some(&source),
            ),
            Some(&mut confirmation),
        );
        assert_eq!(
            denied.code,
            BrowserPolicyCode::CrossOriginConfirmationMismatch
        );
        assert!(!confirmation.is_consumed());
    }

    #[test]
    fn data_from_an_ungranted_source_cannot_enter_even_a_granted_destination() {
        let grant = grant(12);
        let binding = binding(12);
        let ungranted_source =
            NormalizedOrigin::parse("https://source-not-granted.example").expect("source");
        let denied = authorize_browser_request(
            &grant,
            request(
                &binding,
                BrowserPolicySurface::Mutation,
                BrowserPolicyEffect::Mutate,
                "https://write.example/form",
                Some(&ungranted_source),
            ),
            None,
        );
        assert_eq!(denied.code, BrowserPolicyCode::SourceOriginNotGranted);
    }

    #[test]
    fn policy_codes_are_stable_and_bounded() {
        for code in [
            BrowserPolicyCode::Allowed,
            BrowserPolicyCode::AllowedWithCrossOriginConfirmation,
            BrowserPolicyCode::InvalidGrantBinding,
            BrowserPolicyCode::InvalidOrigin,
            BrowserPolicyCode::OriginCredentialsForbidden,
            BrowserPolicyCode::UnsupportedOriginScheme,
            BrowserPolicyCode::OriginNotGranted,
            BrowserPolicyCode::SourceOriginNotGranted,
            BrowserPolicyCode::GrantBindingMismatch,
            BrowserPolicyCode::HandoffEpochMismatch,
            BrowserPolicyCode::AgentControlPaused,
            BrowserPolicyCode::CrossOriginWriteBlocked,
            BrowserPolicyCode::MixedProvenanceWriteBlocked,
            BrowserPolicyCode::CrossOriginConfirmationMismatch,
            BrowserPolicyCode::CrossOriginConfirmationConsumed,
        ] {
            let value = code.as_str();
            assert!(value.len() <= 64);
            assert!(value
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'_'));
        }
    }
}
