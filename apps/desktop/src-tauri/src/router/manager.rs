use super::core::{
    prepare_router_request, validate_router_config, validate_session_router_record,
    PreparedRouterRequest, RouterError, OAUTH_ROUTING_VERIFIED,
};
use super::types::{RouterConfig, RouterRunState, RouterStatus, SessionRouterRecord};
use std::collections::HashMap;
use std::sync::{Mutex, RwLock};

#[derive(Debug, Clone)]
struct RouteRegistration {
    runtime_id: String,
    helper_generation: u64,
    record: SessionRouterRecord,
}

pub struct RouterManager {
    config: RwLock<RouterConfig>,
    status: Mutex<RouterStatus>,
    routes_by_key: RwLock<HashMap<String, RouteRegistration>>,
    key_by_runtime: RwLock<HashMap<String, String>>,
}

impl RouterManager {
    pub fn new(config: RouterConfig) -> Self {
        let status = RouterStatus::disabled(&config, OAUTH_ROUTING_VERIFIED);
        Self {
            config: RwLock::new(config),
            status: Mutex::new(status),
            routes_by_key: RwLock::new(HashMap::new()),
            key_by_runtime: RwLock::new(HashMap::new()),
        }
    }

    pub fn config(&self) -> RouterConfig {
        self.config
            .read()
            .map(|config| config.clone())
            .unwrap_or_default()
    }

    pub fn update_config(&self, config: RouterConfig) -> Result<(), String> {
        validate_router_config(&config).map_err(|error| error.to_string())?;
        *self
            .config
            .write()
            .map_err(|_| "Router config lock is poisoned".to_string())? = config.clone();
        let mut status = self
            .status
            .lock()
            .map_err(|_| "Router status lock is poisoned".to_string())?;
        status.requested_port = config.port;
        status.oauth_routing_enabled = OAUTH_ROUTING_VERIFIED;
        Ok(())
    }

    pub fn status(&self) -> RouterStatus {
        self.status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_else(|_| {
                let config = self.config();
                RouterStatus {
                    state: RouterRunState::Failed,
                    requested_port: config.port,
                    actual_port: None,
                    error: Some("Router status lock is poisoned".to_string()),
                    oauth_routing_enabled: OAUTH_ROUTING_VERIFIED,
                }
            })
    }

    pub fn set_starting(&self) {
        if let Ok(mut status) = self.status.lock() {
            status.state = RouterRunState::Starting;
            status.actual_port = None;
            status.error = None;
        }
    }

    pub fn set_ready(&self, actual_port: u16) {
        if let Ok(mut status) = self.status.lock() {
            status.state = RouterRunState::Ready;
            status.actual_port = Some(actual_port);
            status.error = None;
        }
    }

    pub fn set_failed(&self, error: impl Into<String>, degraded: bool) {
        if let Ok(mut status) = self.status.lock() {
            status.state = if degraded {
                RouterRunState::Degraded
            } else {
                RouterRunState::Failed
            };
            status.actual_port = None;
            status.error = Some(error.into());
        }
    }

    pub fn set_stopped(&self) {
        if let Ok(mut status) = self.status.lock() {
            status.actual_port = None;
            status.error = None;
            status.state = RouterRunState::Failed;
        }
    }

    pub fn route_count(&self) -> usize {
        self.routes_by_key
            .read()
            .map(|routes| routes.len())
            .unwrap_or_default()
    }

    pub fn contains_session_key(&self, session_key: &str) -> bool {
        self.routes_by_key
            .read()
            .map(|routes| routes.contains_key(session_key))
            .unwrap_or(false)
    }

    pub fn register(
        &self,
        runtime_id: &str,
        helper_generation: u64,
        record: SessionRouterRecord,
    ) -> Result<(), RouterError> {
        validate_session_router_record(&record)?;
        let key = record.session_key.clone();
        let registration = RouteRegistration {
            runtime_id: runtime_id.to_string(),
            helper_generation,
            record,
        };

        let mut routes = self.routes_by_key.write().map_err(|_| {
            RouterError::new(
                500,
                "ROUTER_STATE_UNAVAILABLE",
                "Router route lock is poisoned.",
            )
        })?;
        let mut runtime_keys = self.key_by_runtime.write().map_err(|_| {
            RouterError::new(
                500,
                "ROUTER_STATE_UNAVAILABLE",
                "Router route lock is poisoned.",
            )
        })?;
        if let Some(old_key) = runtime_keys.insert(runtime_id.to_string(), key.clone()) {
            routes.remove(&old_key);
        }
        routes.insert(key, registration);
        Ok(())
    }

    pub fn unregister_generation(&self, runtime_id: &str, helper_generation: u64) {
        let (Ok(mut routes), Ok(mut keys)) =
            (self.routes_by_key.write(), self.key_by_runtime.write())
        else {
            return;
        };
        let Some(key) = keys.get(runtime_id).cloned() else {
            return;
        };
        if routes
            .get(&key)
            .is_some_and(|route| route.helper_generation == helper_generation)
        {
            routes.remove(&key);
            keys.remove(runtime_id);
        }
    }

    pub fn unregister_runtime(&self, runtime_id: &str) {
        let (Ok(mut routes), Ok(mut keys)) =
            (self.routes_by_key.write(), self.key_by_runtime.write())
        else {
            return;
        };
        if let Some(key) = keys.remove(runtime_id) {
            routes.remove(&key);
        }
    }

    pub fn prepare(
        &self,
        session_key: &str,
        method: &str,
        upstream_path: &str,
        query: Option<&str>,
        headers: &HashMap<String, String>,
        body: &[u8],
    ) -> Result<PreparedRouterRequest, RouterError> {
        let registration = self
            .routes_by_key
            .read()
            .map_err(|_| {
                RouterError::new(
                    500,
                    "ROUTER_STATE_UNAVAILABLE",
                    "Router route lock is poisoned.",
                )
            })?
            .get(session_key)
            .cloned()
            .ok_or_else(|| {
                RouterError::new(
                    404,
                    "ROUTER_SESSION_NOT_FOUND",
                    "Router session was not found.",
                )
            })?;
        prepare_router_request(
            &registration.runtime_id,
            &registration.record,
            method,
            upstream_path,
            query,
            headers,
            body,
            OAUTH_ROUTING_VERIFIED,
        )
    }

    #[cfg(test)]
    fn generation_for_runtime(&self, runtime_id: &str) -> Option<u64> {
        let key = self.key_by_runtime.read().ok()?.get(runtime_id)?.clone();
        self.routes_by_key
            .read()
            .ok()?
            .get(&key)
            .map(|route| route.helper_generation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::router::types::{
        LaunchAuthKind, LaunchTransport, RouterAuthCapability, RouterModelPins,
    };

    fn record(key: &str) -> SessionRouterRecord {
        SessionRouterRecord {
            session_key: key.into(),
            route_tag_nonce: "nonce".into(),
            default_env: "official".into(),
            bindings: HashMap::new(),
            allowed_envs: vec!["official".into()],
            source_profile_id: None,
            profile_revision: None,
            dynamic_routing: true,
            revision: 0,
            router_auth_capability: RouterAuthCapability::Oauth,
            launch_transport: LaunchTransport::Routed,
            launch_auth_kind: LaunchAuthKind::Oauth,
            launch_default_env: "official".into(),
            launch_model_pins: RouterModelPins::default(),
            warnings: Vec::new(),
        }
    }

    #[test]
    fn generation_replacement_cannot_be_unregistered_by_old_exit() {
        let manager = RouterManager::new(RouterConfig::default());
        manager.register("runtime", 1, record("old")).unwrap();
        manager.register("runtime", 2, record("new")).unwrap();
        manager.unregister_generation("runtime", 1);
        assert_eq!(manager.generation_for_runtime("runtime"), Some(2));
        assert_eq!(manager.route_count(), 1);
        manager.unregister_generation("runtime", 2);
        assert_eq!(manager.route_count(), 0);
    }
}
