use super::types::{
    RouterAuthCapability, RouterConfig, RouterModelPins, RouterServiceError, SessionRouterPatch,
    SessionRouterRecord, SessionRouterState, DEFAULT_ONLY_ROUTER_PROFILE_ID as DEFAULT_ONLY_ID,
    MY_DEFAULT_ROUTER_PROFILE_ID as MY_DEFAULT_ID,
};
use crate::config::{self, EnvConfig, OFFICIAL_BASE_URL, OFFICIAL_ENV_NAME};
use serde_json::Value;
use std::collections::HashMap;
use std::fmt;

pub const MAX_ROUTER_JSON_BODY_BYTES: usize = 32 * 1024 * 1024;
/// Keep false until a logged-in Desktop probe verifies OAuth through the loopback URL.
pub const OAUTH_ROUTING_VERIFIED: bool = false;
const ROUTE_TAG_CLOSE: &str = "</CCEM-ROUTE>";
const BACKGROUND_MODEL_ALIAS: &str = "ccem-route:background";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouterError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
}

impl RouterError {
    pub fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for RouterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

#[derive(Clone)]
enum EnvironmentAuth {
    Token(String),
    RequiresOauth,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouterEnvironmentAuthKind {
    Token,
    RequiresOauth,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouterEnvironmentDescriptor {
    pub name: String,
    pub auth_kind: RouterEnvironmentAuthKind,
    pub pins: RouterModelPins,
}

#[derive(Clone)]
struct RouterEnvironment {
    name: String,
    base_url: String,
    auth: EnvironmentAuth,
    pins: RouterModelPins,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RouteIdentity {
    Logical(String),
    Environment(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteDecision {
    pub logical_key: Option<String>,
    pub target_env: String,
    pub explicit_override: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedRouterRequest {
    pub upstream_url: String,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
    pub runtime_id: String,
    pub target_env: String,
    pub logical_key: Option<String>,
    /// True when the request carries a SUB-ROUTE identity (background alias,
    /// subagent:<type> marker, or an explicit authenticated route override).
    /// False only for the main agent thread. Identity-based: a subagent that
    /// FOLLOWS the default environment is still a sub-route; the main agent
    /// passing through the router listener is never one.
    pub sub_route: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ModelTier {
    Background,
    Opus,
    Sonnet,
    Haiku,
    Unknown,
}

pub fn is_valid_binding_key(value: &str) -> bool {
    value == "background"
        || value == "subagent:*"
        || value
            .strip_prefix("subagent:")
            .is_some_and(is_safe_agent_name)
}

pub fn is_safe_agent_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

pub fn is_valid_router_environment_alias(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

pub fn validate_session_router_record(record: &SessionRouterRecord) -> Result<(), RouterError> {
    let session_key_valid = !record.session_key.is_empty()
        && record.session_key.len() <= 256
        && record
            .session_key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'));
    let nonce_valid = !record.route_tag_nonce.is_empty()
        && record.route_tag_nonce.len() <= 256
        && record
            .route_tag_nonce
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._~-".contains(&byte));
    if !session_key_valid || !nonce_valid {
        return Err(RouterError::new(
            500,
            "ROUTER_INVALID_SESSION",
            "Router session secrets are missing or malformed.",
        ));
    }
    if record.default_env.trim().is_empty() {
        return Err(RouterError::new(
            502,
            "ROUTER_DEFAULT_ENV_MISSING",
            "Router default environment is missing.",
        ));
    }
    if !record
        .allowed_envs
        .iter()
        .any(|name| name == &record.default_env)
    {
        return Err(RouterError::new(
            403,
            "ROUTER_ENV_NOT_ALLOWED",
            "Router default environment is not in the session allowlist.",
        ));
    }
    for (key, env_name) in &record.bindings {
        if !is_valid_binding_key(key) {
            return Err(RouterError::new(
                400,
                "ROUTER_INVALID_BINDING",
                format!("Invalid router binding key '{key}'."),
            ));
        }
        if !record
            .allowed_envs
            .iter()
            .any(|allowed| allowed == env_name)
        {
            return Err(RouterError::new(
                403,
                "ROUTER_ENV_NOT_ALLOWED",
                format!("Binding '{key}' targets an environment outside the allowlist."),
            ));
        }
    }
    Ok(())
}

pub fn describe_router_environment(name: &str) -> Result<RouterEnvironmentDescriptor, RouterError> {
    let environment = load_router_environment(name)?;
    Ok(RouterEnvironmentDescriptor {
        name: environment.name,
        auth_kind: match environment.auth {
            EnvironmentAuth::Token(_) => RouterEnvironmentAuthKind::Token,
            EnvironmentAuth::RequiresOauth => RouterEnvironmentAuthKind::RequiresOauth,
        },
        pins: environment.pins,
    })
}

pub fn validate_session_router_targets(
    record: &SessionRouterRecord,
    oauth_routing_enabled: bool,
) -> Result<(), RouterError> {
    validate_session_router_record(record)?;
    let mut targets = record.allowed_envs.clone();
    targets.push(record.default_env.clone());
    targets.extend(record.bindings.values().cloned());
    targets.sort();
    targets.dedup();
    for target in targets {
        let environment = load_router_environment(&target)?;
        enforce_auth_boundary(record, &environment, oauth_routing_enabled)?;
    }
    Ok(())
}

pub fn validate_router_config(config: &RouterConfig) -> Result<(), RouterServiceError> {
    if config.port == 0 {
        return Err(RouterServiceError::new(
            "ROUTER_PORT_INVALID",
            "Router port must be between 1 and 65535.",
        ));
    }
    validate_binding_map(&config.bindings)?;
    validate_environment_refs(&config.default_allowed_envs)?;

    let mut profile_ids = std::collections::HashSet::new();
    for profile in &config.profiles {
        if profile.id.trim().is_empty() || profile.name.trim().is_empty() {
            return Err(RouterServiceError::new(
                "ROUTER_PROFILE_INVALID",
                "Router profile id and name must not be empty.",
            ));
        }
        if !profile_ids.insert(profile.id.as_str()) {
            return Err(RouterServiceError::new(
                "ROUTER_PROFILE_INVALID",
                format!("Duplicate router profile id '{}'.", profile.id),
            ));
        }
        if matches!(profile.id.as_str(), DEFAULT_ONLY_ID | MY_DEFAULT_ID) {
            let message = format!("Router profile id '{}' is reserved.", profile.id);
            return Err(RouterServiceError::new("ROUTER_PROFILE_INVALID", message));
        }
        validate_binding_map(&profile.bindings)?;
        validate_environment_refs(&profile.allowed_envs)?;
        if let Some((key, _)) = profile.bindings.iter().find(|(_, target)| {
            !profile
                .allowed_envs
                .iter()
                .any(|allowed| allowed == *target)
        }) {
            return Err(RouterServiceError::new(
                "ROUTER_PROFILE_INVALID",
                format!("Profile binding '{key}' targets an environment outside its allowlist."),
            ));
        }
    }
    Ok(())
}

pub fn apply_session_router_patch(
    current: &SessionRouterRecord,
    expected_revision: u64,
    patch: &SessionRouterPatch,
    oauth_routing_enabled: bool,
) -> Result<SessionRouterRecord, RouterServiceError> {
    if current.revision != expected_revision {
        return Err(RouterServiceError::conflict(SessionRouterState::from(
            current,
        )));
    }

    let mut candidate = current.clone();
    if let Some(default_env) = &patch.default_env {
        candidate.default_env = default_env.clone();
    }
    if let Some(bindings) = &patch.bindings {
        candidate.bindings = bindings.clone();
    }
    if let Some(allowed_envs) = &patch.allowed_envs {
        candidate.allowed_envs = allowed_envs.clone();
    }
    if let Some(source_profile_id) = &patch.source_profile_id {
        candidate.source_profile_id = source_profile_id.clone();
    }
    if let Some(profile_revision) = patch.profile_revision {
        candidate.profile_revision = profile_revision;
    }
    if let Some(dynamic_routing) = patch.dynamic_routing {
        candidate.dynamic_routing = dynamic_routing;
    }

    validate_environment_refs(&candidate.allowed_envs)?;
    validate_binding_map(&candidate.bindings)?;
    validate_session_router_targets(&candidate, oauth_routing_enabled)
        .map_err(|error| RouterServiceError::new(error.code, error.message))?;
    candidate.revision = current.revision.checked_add(1).ok_or_else(|| {
        RouterServiceError::new(
            "ROUTER_REVISION_EXHAUSTED",
            "Router revision cannot be incremented.",
        )
    })?;
    Ok(candidate)
}

fn validate_binding_map(bindings: &HashMap<String, String>) -> Result<(), RouterServiceError> {
    for (key, target) in bindings {
        if !is_valid_binding_key(key) {
            return Err(RouterServiceError::new(
                "ROUTER_INVALID_BINDING",
                format!("Invalid router binding key '{key}'."),
            ));
        }
        if target.trim().is_empty() {
            return Err(RouterServiceError::new(
                "ROUTER_ENV_MISSING",
                format!("Router binding '{key}' has an empty environment target."),
            ));
        }
    }
    Ok(())
}

fn validate_environment_refs(values: &[String]) -> Result<(), RouterServiceError> {
    if values.iter().any(|value| value.trim().is_empty()) {
        return Err(RouterServiceError::new(
            "ROUTER_ENV_MISSING",
            "Router environment references must not be empty.",
        ));
    }
    let mut unique = std::collections::HashSet::new();
    if values.iter().any(|value| !unique.insert(value)) {
        return Err(RouterServiceError::new(
            "ROUTER_ENV_DUPLICATE",
            "Router allowlists must not contain duplicate environments.",
        ));
    }
    Ok(())
}

pub fn prepare_router_request(
    runtime_id: &str,
    record: &SessionRouterRecord,
    method: &str,
    upstream_path: &str,
    query: Option<&str>,
    headers: &HashMap<String, String>,
    body: &[u8],
    oauth_routing_enabled: bool,
) -> Result<PreparedRouterRequest, RouterError> {
    validate_session_router_record(record)?;
    validate_anthropic_request(method, upstream_path)?;
    validate_request_encoding(headers)?;
    if body.len() > MAX_ROUTER_JSON_BODY_BYTES {
        return Err(RouterError::new(
            413,
            "ROUTER_BODY_TOO_LARGE",
            format!(
                "Router JSON request exceeds the {} byte limit.",
                MAX_ROUTER_JSON_BODY_BYTES
            ),
        ));
    }

    let mut json_body = serde_json::from_slice::<Value>(body).map_err(|error| {
        RouterError::new(
            400,
            "ROUTER_INVALID_JSON",
            format!("Invalid Anthropic JSON request: {error}"),
        )
    })?;
    let marker_identity = take_authenticated_marker(&mut json_body, &record.route_tag_nonce)?;
    let original_model = json_body
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string);
    let model_alias = match original_model
        .as_deref()
        .and_then(|model| model.strip_prefix("ccem:"))
    {
        Some(name) if is_valid_router_environment_alias(name) => Some(name.to_string()),
        Some(_) => {
            return Err(RouterError::new(
                400,
                "ROUTER_ENV_ALIAS_INVALID",
                "Dynamic environment aliases must match [A-Za-z0-9._-]{1,64}.",
            ))
        }
        None => None,
    };

    let decision = resolve_route_decision(
        record,
        model_alias,
        marker_identity,
        original_model.as_deref(),
    )?;
    let target = load_router_environment(&decision.target_env)?;
    enforce_auth_boundary(record, &target, oauth_routing_enabled)?;

    if let Some(original_model) = original_model.as_deref() {
        let resolved_model = resolve_target_model(
            original_model,
            &record.launch_default_env,
            &record.launch_model_pins,
            &target,
            decision.explicit_override && original_model.starts_with("ccem:"),
        )?;
        json_body["model"] = Value::String(resolved_model);
    }

    let output_body = serde_json::to_vec(&json_body).map_err(|error| {
        RouterError::new(
            500,
            "ROUTER_JSON_SERIALIZE_FAILED",
            format!("Failed to encode routed request: {error}"),
        )
    })?;
    let output_headers = rewrite_request_headers(headers, &target.auth)?;
    let upstream_url = compose_upstream_url(&target.base_url, upstream_path, query)?;

    Ok(PreparedRouterRequest {
        upstream_url,
        headers: output_headers,
        body: output_body,
        runtime_id: runtime_id.to_string(),
        target_env: target.name,
        sub_route: decision.logical_key.as_deref() != Some("main"),
        logical_key: decision.logical_key,
    })
}

fn validate_anthropic_request(method: &str, path: &str) -> Result<(), RouterError> {
    if method != "POST" {
        return Err(RouterError::new(
            405,
            "ROUTER_METHOD_NOT_ALLOWED",
            "Router requests must use POST.",
        ));
    }
    if !matches!(
        path.trim_end_matches('/'),
        "/v1/messages" | "/v1/messages/count_tokens"
    ) {
        return Err(RouterError::new(
            404,
            "ROUTER_ENDPOINT_NOT_ALLOWED",
            "Router endpoint is not allowed.",
        ));
    }
    Ok(())
}

fn validate_request_encoding(headers: &HashMap<String, String>) -> Result<(), RouterError> {
    let encoding = header_value(headers, "content-encoding")
        .map(str::trim)
        .unwrap_or_default();
    if encoding.is_empty() || encoding.eq_ignore_ascii_case("identity") {
        return Ok(());
    }
    Err(RouterError::new(
        415,
        "ROUTER_UNSUPPORTED_CONTENT_ENCODING",
        "Compressed router request bodies are not supported.",
    ))
}

fn take_authenticated_marker(
    body: &mut Value,
    nonce: &str,
) -> Result<Option<RouteIdentity>, RouterError> {
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return Ok(None);
    };
    let prefix = format!("<CCEM-ROUTE nonce=\"{nonce}\">");
    let mut selected_identity = None;

    for message in messages {
        if message.get("role").and_then(Value::as_str) != Some("user") {
            continue;
        }
        let Some(content) = message.get_mut("content") else {
            continue;
        };
        if let Some(text) = content.as_str() {
            if let Some(rest) = strip_authenticated_markers(text, &prefix, &mut selected_identity)?
            {
                *content = Value::String(rest);
            }
            continue;
        }
        let Some(blocks) = content.as_array_mut() else {
            continue;
        };
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("text") {
                continue;
            }
            let Some(text) = block.get("text").and_then(Value::as_str) else {
                continue;
            };
            if let Some(rest) = strip_authenticated_markers(text, &prefix, &mut selected_identity)?
            {
                block["text"] = Value::String(rest);
            }
        }
    }
    Ok(selected_identity)
}

fn strip_authenticated_markers(
    text: &str,
    expected_prefix: &str,
    selected: &mut Option<RouteIdentity>,
) -> Result<Option<String>, RouterError> {
    let mut remaining = text.to_string();
    let mut stripped = false;
    while let Some((identity, rest)) = split_marker(&remaining, expected_prefix)? {
        stripped = true;
        remaining = rest;
        select_authenticated_identity(selected, identity)?;
    }
    Ok(stripped.then_some(remaining))
}

fn select_authenticated_identity(
    selected: &mut Option<RouteIdentity>,
    candidate: RouteIdentity,
) -> Result<(), RouterError> {
    match selected {
        None => {
            *selected = Some(candidate);
            Ok(())
        }
        Some(current) if current == &candidate => Ok(()),
        Some(_) => Err(RouterError::new(
            400,
            "ROUTER_INVALID_MARKER",
            "Authenticated route markers select conflicting targets.",
        )),
    }
}

fn split_marker(
    text: &str,
    expected_prefix: &str,
) -> Result<Option<(RouteIdentity, String)>, RouterError> {
    let Some(after_prefix) = text.strip_prefix(expected_prefix) else {
        return Ok(None);
    };
    let Some(close_at) = after_prefix.find(ROUTE_TAG_CLOSE) else {
        return Err(RouterError::new(
            400,
            "ROUTER_INVALID_MARKER",
            "Authenticated route marker is not closed.",
        ));
    };
    let raw_identity = &after_prefix[..close_at];
    let identity = if let Some(name) = raw_identity.strip_prefix("subagent:") {
        if !is_safe_agent_name(name) {
            return Err(RouterError::new(
                400,
                "ROUTER_INVALID_MARKER",
                "Authenticated subagent identity is invalid.",
            ));
        }
        RouteIdentity::Logical(format!("subagent:{name}"))
    } else if let Some(name) = raw_identity.strip_prefix("ccem:") {
        if !is_valid_router_environment_alias(name) {
            return Err(RouterError::new(
                400,
                "ROUTER_INVALID_MARKER",
                "Authenticated environment override is invalid.",
            ));
        }
        RouteIdentity::Environment(name.to_string())
    } else {
        return Err(RouterError::new(
            400,
            "ROUTER_INVALID_MARKER",
            "Authenticated route marker has an unsupported identity.",
        ));
    };

    let rest = &after_prefix[close_at + ROUTE_TAG_CLOSE.len()..];
    let rest = rest.strip_prefix('\n').unwrap_or(rest).to_string();
    Ok(Some((identity, rest)))
}

fn resolve_route_decision(
    record: &SessionRouterRecord,
    model_alias: Option<String>,
    marker: Option<RouteIdentity>,
    original_model: Option<&str>,
) -> Result<RouteDecision, RouterError> {
    if let Some(env_name) = model_alias {
        return explicit_environment_decision(record, env_name);
    }
    if let Some(RouteIdentity::Environment(env_name)) = marker {
        return explicit_environment_decision(record, env_name);
    }

    let logical_key = match marker {
        Some(RouteIdentity::Logical(key)) => key,
        _ if original_model == Some(BACKGROUND_MODEL_ALIAS) => "background".to_string(),
        _ => "main".to_string(),
    };
    let target_env = record
        .bindings
        .get(&logical_key)
        .or_else(|| {
            logical_key
                .starts_with("subagent:")
                .then(|| record.bindings.get("subagent:*"))
                .flatten()
        })
        .cloned()
        .unwrap_or_else(|| record.default_env.clone());
    ensure_allowed(record, &target_env)?;

    Ok(RouteDecision {
        logical_key: Some(logical_key),
        target_env,
        explicit_override: false,
    })
}

fn explicit_environment_decision(
    record: &SessionRouterRecord,
    env_name: String,
) -> Result<RouteDecision, RouterError> {
    if !record.dynamic_routing {
        return Err(RouterError::new(
            403,
            "ROUTER_DYNAMIC_DISABLED",
            "Dynamic environment overrides are disabled for this session.",
        ));
    }
    ensure_allowed(record, &env_name)?;
    Ok(RouteDecision {
        logical_key: None,
        target_env: env_name,
        explicit_override: true,
    })
}

fn ensure_allowed(record: &SessionRouterRecord, env_name: &str) -> Result<(), RouterError> {
    if record
        .allowed_envs
        .iter()
        .any(|allowed| allowed == env_name)
    {
        return Ok(());
    }
    Err(RouterError::new(
        403,
        "ROUTER_ENV_NOT_ALLOWED",
        format!("Environment '{env_name}' is not allowed for this session."),
    ))
}

fn load_router_environment(name: &str) -> Result<RouterEnvironment, RouterError> {
    #[cfg(test)]
    if let Some(environment) = super::test_support::router_environment(name) {
        return environment_from_config(name, &environment);
    }

    let config = config::read_config().map_err(|error| {
        RouterError::new(
            502,
            "ROUTER_CONFIG_UNAVAILABLE",
            format!("Failed to read CCEM environments: {error}"),
        )
    })?;
    let encrypted = config.registries.get(name).ok_or_else(|| {
        RouterError::new(
            502,
            "ROUTER_ENV_MISSING",
            format!("Environment '{name}' does not exist."),
        )
    })?;
    let decrypted = config::get_env_with_decrypted_key(encrypted).map_err(|error| {
        RouterError::new(
            502,
            "ROUTER_TOKEN_DECRYPT_FAILED",
            format!("Failed to decrypt environment '{name}': {error}"),
        )
    })?;
    let resolved = config::resolve_env_config_for_runtime(name, decrypted);
    environment_from_config(name, &resolved)
}

fn environment_from_config(name: &str, env: &EnvConfig) -> Result<RouterEnvironment, RouterError> {
    let base_url = env
        .base_url
        .as_deref()
        .unwrap_or(OFFICIAL_BASE_URL)
        .trim()
        .to_string();
    validate_base_url(&base_url)?;

    let token = env.auth_token.as_deref().map(str::trim).unwrap_or_default();
    let auth = if !token.is_empty() {
        EnvironmentAuth::Token(token.to_string())
    } else if name == OFFICIAL_ENV_NAME && is_exact_official_origin(&base_url) {
        EnvironmentAuth::RequiresOauth
    } else {
        return Err(RouterError::new(
            502,
            "ROUTER_AUTH_INVALID",
            format!("Environment '{name}' has no usable token and is not trusted OAuth official."),
        ));
    };

    Ok(RouterEnvironment {
        name: name.to_string(),
        base_url,
        auth,
        pins: RouterModelPins {
            default_opus_model: env.default_opus_model.clone(),
            default_sonnet_model: env.default_sonnet_model.clone(),
            default_haiku_model: env.default_haiku_model.clone(),
            model: env.model.clone(),
        },
    })
}

fn validate_base_url(raw: &str) -> Result<(), RouterError> {
    let parsed = reqwest::Url::parse(raw).map_err(|error| {
        RouterError::new(
            502,
            "ROUTER_UPSTREAM_URL_INVALID",
            format!("Invalid upstream base URL: {error}"),
        )
    })?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(RouterError::new(
            502,
            "ROUTER_UPSTREAM_URL_INVALID",
            "Upstream base URL must use http or https and include a host.",
        ));
    }
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(RouterError::new(
            502,
            "ROUTER_UPSTREAM_URL_INVALID",
            "Upstream base URL must not contain credentials, query, or fragment.",
        ));
    }
    Ok(())
}

fn is_exact_official_origin(raw: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(raw) else {
        return false;
    };
    parsed.scheme() == "https"
        && parsed.host_str() == Some("api.anthropic.com")
        && parsed.port_or_known_default() == Some(443)
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && matches!(parsed.path(), "" | "/")
        && parsed.query().is_none()
        && parsed.fragment().is_none()
}

fn enforce_auth_boundary(
    record: &SessionRouterRecord,
    target: &RouterEnvironment,
    oauth_routing_enabled: bool,
) -> Result<(), RouterError> {
    if !matches!(target.auth, EnvironmentAuth::RequiresOauth) {
        return Ok(());
    }
    if record.router_auth_capability != RouterAuthCapability::Oauth {
        return Err(RouterError::new(
            403,
            "ROUTER_OAUTH_FORBIDDEN",
            "This token session cannot route to the trusted OAuth environment.",
        ));
    }
    if !oauth_routing_enabled {
        return Err(RouterError::new(
            503,
            "ROUTER_OAUTH_NOT_VERIFIED",
            "OAuth routing is disabled until the real Desktop header probe succeeds.",
        ));
    }
    Ok(())
}

fn resolve_target_model(
    original: &str,
    launch_default_env: &str,
    launch_pins: &RouterModelPins,
    target: &RouterEnvironment,
    model_was_alias: bool,
) -> Result<String, RouterError> {
    let tier = infer_model_tier(original, launch_pins);
    if tier == ModelTier::Background {
        return usable_model(target.pins.default_haiku_model.as_deref())
            .or_else(|| primary_model(&target.pins))
            .map(str::to_string)
            .ok_or_else(|| unresolved_model_error(&target.name, tier));
    }
    if target.name == launch_default_env && !model_was_alias {
        return Ok(original.to_string());
    }

    let mapped = match tier {
        ModelTier::Opus => usable_model(target.pins.default_opus_model.as_deref()),
        ModelTier::Sonnet => usable_model(target.pins.default_sonnet_model.as_deref()),
        ModelTier::Haiku => usable_model(target.pins.default_haiku_model.as_deref()),
        ModelTier::Unknown => primary_model(&target.pins),
        ModelTier::Background => unreachable!(),
    };
    mapped
        .map(str::to_string)
        .ok_or_else(|| unresolved_model_error(&target.name, tier))
}

fn unresolved_model_error(target: &str, tier: ModelTier) -> RouterError {
    RouterError::new(
        502,
        "ROUTER_MODEL_UNRESOLVED",
        format!("No compatible {tier:?} model pin is configured for environment '{target}'."),
    )
}

fn infer_model_tier(model: &str, pins: &RouterModelPins) -> ModelTier {
    if model == BACKGROUND_MODEL_ALIAS {
        return ModelTier::Background;
    }
    let keyword = tier_keyword(model);
    let mut matches = Vec::new();
    if usable_model(pins.default_opus_model.as_deref()) == Some(model) {
        matches.push(ModelTier::Opus);
    }
    if usable_model(pins.default_sonnet_model.as_deref()) == Some(model) {
        matches.push(ModelTier::Sonnet);
    }
    if usable_model(pins.default_haiku_model.as_deref()) == Some(model) {
        matches.push(ModelTier::Haiku);
    }
    if matches.contains(&keyword) {
        return keyword;
    }
    for preferred in [ModelTier::Sonnet, ModelTier::Opus, ModelTier::Haiku] {
        if matches.contains(&preferred) {
            return preferred;
        }
    }
    keyword
}

fn tier_keyword(model: &str) -> ModelTier {
    let mut found = ModelTier::Unknown;
    for part in model
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
    {
        found = match part.to_ascii_lowercase().as_str() {
            "opus" => ModelTier::Opus,
            "sonnet" => ModelTier::Sonnet,
            "haiku" => ModelTier::Haiku,
            _ => continue,
        };
        break;
    }
    found
}

fn usable_model(value: Option<&str>) -> Option<&str> {
    let value = value?.trim();
    if value.is_empty()
        || matches!(
            value.to_ascii_lowercase().as_str(),
            "opus" | "sonnet" | "haiku" | "default"
        )
    {
        None
    } else {
        Some(value)
    }
}

fn primary_model(pins: &RouterModelPins) -> Option<&str> {
    usable_model(pins.default_sonnet_model.as_deref())
        .or_else(|| usable_model(pins.default_opus_model.as_deref()))
        .or_else(|| usable_model(pins.default_haiku_model.as_deref()))
        .or_else(|| usable_model(pins.model.as_deref()))
}

fn rewrite_request_headers(
    headers: &HashMap<String, String>,
    auth: &EnvironmentAuth,
) -> Result<HashMap<String, String>, RouterError> {
    let mut rewritten = headers.clone();
    rewritten.retain(|name, _| {
        !matches!(
            name.to_ascii_lowercase().as_str(),
            "authorization"
                | "proxy-authorization"
                | "x-api-key"
                | "anthropic-api-key"
                | "cookie"
                | "host"
                | "content-length"
                | "content-encoding"
                | "transfer-encoding"
                | "connection"
                | "proxy-connection"
                | "keep-alive"
                | "te"
                | "trailer"
                | "upgrade"
        )
    });

    match auth {
        EnvironmentAuth::Token(token) => {
            rewritten.insert("authorization".into(), format!("Bearer {token}"));
        }
        EnvironmentAuth::RequiresOauth => {
            let authorization = header_value(headers, "authorization")
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    RouterError::new(
                        401,
                        "ROUTER_OAUTH_HEADER_MISSING",
                        "The routed OAuth request did not include Authorization.",
                    )
                })?;
            rewritten.insert("authorization".into(), authorization.to_string());
        }
    }
    Ok(rewritten)
}

fn header_value<'a>(headers: &'a HashMap<String, String>, wanted: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(wanted))
        .map(|(_, value)| value.as_str())
}

pub fn compose_upstream_url(
    base_url: &str,
    upstream_path: &str,
    query: Option<&str>,
) -> Result<String, RouterError> {
    validate_base_url(base_url)?;
    if !upstream_path.starts_with('/') {
        return Err(RouterError::new(
            400,
            "ROUTER_PATH_INVALID",
            "Router upstream path must start with '/'.",
        ));
    }
    for segment in upstream_path.split('/') {
        let decoded = urlencoding::decode(segment).map_err(|_| {
            RouterError::new(
                400,
                "ROUTER_PATH_INVALID",
                "Router path encoding is invalid.",
            )
        })?;
        if decoded == ".." || decoded == "." {
            return Err(RouterError::new(
                400,
                "ROUTER_PATH_INVALID",
                "Router path traversal is not allowed.",
            ));
        }
    }

    let mut parsed = reqwest::Url::parse(base_url).map_err(|error| {
        RouterError::new(
            502,
            "ROUTER_UPSTREAM_URL_INVALID",
            format!("Invalid upstream base URL: {error}"),
        )
    })?;
    let base_path = parsed.path().trim_end_matches('/');
    let suffix = upstream_path.trim_start_matches('/');
    let joined = match (base_path.is_empty() || base_path == "/", suffix.is_empty()) {
        (true, true) => "/".to_string(),
        (true, false) => format!("/{suffix}"),
        (false, true) => base_path.to_string(),
        (false, false) => format!("{base_path}/{suffix}"),
    };
    parsed.set_path(&joined);
    parsed.set_query(query.filter(|value| !value.is_empty()));
    Ok(parsed.to_string())
}

#[cfg(test)]
#[path = "core_tests.rs"]
mod tests;
