use crate::config::EnvConfig;
use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};

static TEST_ROUTER_ENVIRONMENTS: OnceLock<RwLock<HashMap<String, EnvConfig>>> = OnceLock::new();

struct TestRouterEnvironmentOverride {
    name: String,
}

impl Drop for TestRouterEnvironmentOverride {
    fn drop(&mut self) {
        if let Some(environments) = TEST_ROUTER_ENVIRONMENTS.get() {
            environments
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&self.name);
        }
    }
}

pub(crate) fn register_test_router_environment(name: &str, env: EnvConfig) -> impl Drop {
    let environments = TEST_ROUTER_ENVIRONMENTS.get_or_init(|| RwLock::new(HashMap::new()));
    let mut environments = environments
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match environments.entry(name.to_string()) {
        std::collections::hash_map::Entry::Vacant(entry) => {
            entry.insert(env);
        }
        std::collections::hash_map::Entry::Occupied(_) => {
            panic!("test router environment names must be unique")
        }
    }
    drop(environments);
    TestRouterEnvironmentOverride {
        name: name.to_string(),
    }
}

pub(super) fn router_environment(name: &str) -> Option<EnvConfig> {
    TEST_ROUTER_ENVIRONMENTS
        .get()?
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(name)
        .cloned()
}
