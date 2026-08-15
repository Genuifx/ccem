use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const DEFAULT_ROUTER_PORT: u16 = 17_820;
pub const ROUTER_PORT_SCAN_END: u16 = 17_920;
pub const DEFAULT_ONLY_ROUTER_PROFILE_ID: &str = "default-only";
pub const MY_DEFAULT_ROUTER_PROFILE_ID: &str = "my-default";

fn default_router_port() -> u16 {
    DEFAULT_ROUTER_PORT
}

fn default_dynamic_routing() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RouterProfile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub bindings: HashMap<String, String>,
    #[serde(default)]
    pub allowed_envs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RouterConfig {
    #[serde(default = "default_router_port")]
    pub port: u16,
    #[serde(default)]
    pub bindings: HashMap<String, String>,
    #[serde(default)]
    pub profiles: Vec<RouterProfile>,
    #[serde(default = "default_dynamic_routing")]
    pub dynamic_routing: bool,
    #[serde(default)]
    pub default_allowed_envs: Vec<String>,
}

impl Default for RouterConfig {
    fn default() -> Self {
        Self {
            port: DEFAULT_ROUTER_PORT,
            bindings: HashMap::new(),
            profiles: Vec::new(),
            dynamic_routing: true,
            default_allowed_envs: Vec::new(),
        }
    }
}

pub fn rename_router_config_environment(config: &mut RouterConfig, old_name: &str, new_name: &str) {
    for target in config.bindings.values_mut() {
        if target == old_name {
            *target = new_name.to_string();
        }
    }
    for allowed in &mut config.default_allowed_envs {
        if allowed == old_name {
            *allowed = new_name.to_string();
        }
    }
    config.default_allowed_envs.sort();
    config.default_allowed_envs.dedup();
    for profile in &mut config.profiles {
        let previous_bindings = profile.bindings.clone();
        let previous_allowed_envs = profile.allowed_envs.clone();
        for target in profile.bindings.values_mut() {
            if target == old_name {
                *target = new_name.to_string();
            }
        }
        for allowed in &mut profile.allowed_envs {
            if allowed == old_name {
                *allowed = new_name.to_string();
            }
        }
        profile.allowed_envs.sort();
        profile.allowed_envs.dedup();
        if profile.bindings != previous_bindings || profile.allowed_envs != previous_allowed_envs {
            profile.revision = profile.revision.saturating_add(1);
        }
    }
}

pub fn router_config_environment_references(config: &RouterConfig, env_name: &str) -> Vec<String> {
    let mut references = Vec::new();
    for (key, target) in &config.bindings {
        if target == env_name {
            references.push(format!("router.bindings.{key}"));
        }
    }
    if config
        .default_allowed_envs
        .iter()
        .any(|allowed| allowed == env_name)
    {
        references.push("router.defaultAllowedEnvs".to_string());
    }
    for profile in &config.profiles {
        if profile.bindings.values().any(|target| target == env_name)
            || profile
                .allowed_envs
                .iter()
                .any(|allowed| allowed == env_name)
        {
            references.push(format!("router.profile:{}", profile.id));
        }
    }
    references
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RouterAuthCapability {
    Oauth,
    Token,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LaunchAuthKind {
    Oauth,
    Token,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LaunchTransport {
    Routed,
    Direct,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RouterModelPins {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_opus_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_sonnet_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_haiku_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionRouterRecord {
    pub session_key: String,
    pub route_tag_nonce: String,
    pub default_env: String,
    #[serde(default)]
    pub bindings: HashMap<String, String>,
    #[serde(default)]
    pub allowed_envs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_revision: Option<u64>,
    #[serde(default = "default_dynamic_routing")]
    pub dynamic_routing: bool,
    #[serde(default)]
    pub revision: u64,
    pub router_auth_capability: RouterAuthCapability,
    pub launch_transport: LaunchTransport,
    pub launch_auth_kind: LaunchAuthKind,
    pub launch_default_env: String,
    #[serde(default)]
    pub launch_model_pins: RouterModelPins,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionRouterState {
    pub launch_transport: LaunchTransport,
    pub default_env: String,
    pub bindings: HashMap<String, String>,
    pub allowed_envs: Vec<String>,
    pub source_profile_id: Option<String>,
    pub profile_revision: Option<u64>,
    pub dynamic_routing: bool,
    pub revision: u64,
    pub warnings: Vec<String>,
}

impl From<&SessionRouterRecord> for SessionRouterState {
    fn from(record: &SessionRouterRecord) -> Self {
        Self {
            launch_transport: record.launch_transport,
            default_env: record.default_env.clone(),
            bindings: record.bindings.clone(),
            allowed_envs: record.allowed_envs.clone(),
            source_profile_id: record.source_profile_id.clone(),
            profile_revision: record.profile_revision,
            dynamic_routing: record.dynamic_routing,
            revision: record.revision,
            warnings: record.warnings.clone(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionRouterPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_env: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bindings: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_envs: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_profile_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_revision: Option<Option<u64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dynamic_routing: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSessionRouterRequest {
    pub runtime_id: String,
    pub expected_revision: u64,
    pub patch: SessionRouterPatch,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RouterRunState {
    Disabled,
    Starting,
    Ready,
    Degraded,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RouterStatus {
    pub state: RouterRunState,
    pub requested_port: u16,
    pub actual_port: Option<u16>,
    pub error: Option<String>,
    pub oauth_routing_enabled: bool,
}

impl RouterStatus {
    pub fn disabled(config: &RouterConfig, oauth_routing_enabled: bool) -> Self {
        Self {
            state: RouterRunState::Disabled,
            requested_port: config.port,
            actual_port: None,
            error: None,
            oauth_routing_enabled,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionRouterUpdatedEvent {
    pub runtime_id: String,
    pub router: SessionRouterState,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RouterServiceError {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<SessionRouterState>,
}

impl RouterServiceError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            current: None,
        }
    }

    pub fn conflict(current: SessionRouterState) -> Self {
        Self {
            code: "ROUTER_REVISION_CONFLICT".to_string(),
            message: format!(
                "Router revision changed; retry from revision {}.",
                current.revision
            ),
            current: Some(current),
        }
    }
}

impl std::fmt::Display for RouterServiceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_state_never_serializes_route_secrets() {
        let record = SessionRouterRecord {
            session_key: "session-secret".into(),
            route_tag_nonce: "marker-secret".into(),
            default_env: "glm".into(),
            bindings: HashMap::new(),
            allowed_envs: vec!["glm".into()],
            source_profile_id: None,
            profile_revision: None,
            dynamic_routing: true,
            revision: 1,
            router_auth_capability: RouterAuthCapability::Token,
            launch_transport: LaunchTransport::Routed,
            launch_auth_kind: LaunchAuthKind::Token,
            launch_default_env: "glm".into(),
            launch_model_pins: RouterModelPins::default(),
            warnings: Vec::new(),
        };

        let serialized = serde_json::to_string(&SessionRouterState::from(&record)).unwrap();
        assert!(!serialized.contains("session-secret"));
        assert!(!serialized.contains("marker-secret"));
        assert!(!serialized.contains("sessionKey"));
        assert!(!serialized.contains("routeTagNonce"));
    }

    #[test]
    fn router_defaults_are_safe_and_stable() {
        let config = RouterConfig::default();
        assert_eq!(config.port, DEFAULT_ROUTER_PORT);
        assert!(config.dynamic_routing);
        assert!(config.profiles.is_empty());
    }

    #[test]
    fn legacy_enabled_field_is_ignored_and_not_serialized() {
        let config: RouterConfig = serde_json::from_value(serde_json::json!({
            "enabled": true,
            "port": 18_321,
            "dynamicRouting": false
        }))
        .expect("deserialize legacy router config");

        let value = serde_json::to_value(config).expect("serialize router config");
        assert_eq!(value.get("enabled"), None);
        assert_eq!(value["port"], 18_321);
        assert_eq!(value["dynamicRouting"], false);
    }

    #[test]
    fn environment_rename_helpers_cover_global_and_profile_references() {
        let mut config = RouterConfig {
            bindings: HashMap::from([("background".into(), "old env".into())]),
            default_allowed_envs: vec!["old env".into(), "new env".into()],
            profiles: vec![RouterProfile {
                id: "focused".into(),
                name: "Focused".into(),
                revision: 1,
                bindings: HashMap::from([("subagent:Explore".into(), "old env".into())]),
                allowed_envs: vec!["old env".into()],
            }],
            ..RouterConfig::default()
        };

        assert_eq!(
            router_config_environment_references(&config, "old env").len(),
            3
        );
        rename_router_config_environment(&mut config, "old env", "new env");

        assert!(router_config_environment_references(&config, "old env").is_empty());
        assert_eq!(
            config.bindings.get("background").map(String::as_str),
            Some("new env")
        );
        assert_eq!(config.default_allowed_envs, vec!["new env"]);
        assert_eq!(config.profiles[0].allowed_envs, vec!["new env"]);
        assert_eq!(config.profiles[0].revision, 2);
    }

    #[test]
    fn environment_rename_profile_revision_saturates_at_u64_max() {
        let mut config = RouterConfig {
            profiles: vec![RouterProfile {
                id: "maxed".into(),
                name: "Maxed".into(),
                revision: u64::MAX,
                bindings: HashMap::from([("background".into(), "old env".into())]),
                allowed_envs: vec!["old env".into()],
            }],
            ..RouterConfig::default()
        };

        rename_router_config_environment(&mut config, "old env", "new env");

        assert_eq!(config.profiles[0].revision, u64::MAX);
        assert_eq!(config.profiles[0].allowed_envs, vec!["new env"]);
    }
}
