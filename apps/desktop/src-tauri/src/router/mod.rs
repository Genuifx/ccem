mod core;
mod manager;
#[cfg(test)]
mod test_support;
mod types;

pub use core::{
    apply_session_router_patch, describe_router_environment, is_valid_router_environment_alias,
    validate_router_config, validate_session_router_targets, RouterEnvironmentAuthKind,
    OAUTH_ROUTING_VERIFIED,
};
pub use manager::RouterManager;
#[cfg(test)]
pub(crate) use test_support::register_test_router_environment;
pub use types::{
    rename_router_config_environment, router_config_environment_references, LaunchAuthKind,
    LaunchTransport, RouterAuthCapability, RouterConfig, RouterServiceError, RouterStatus,
    SessionRouterPatch, SessionRouterRecord, SessionRouterState, SessionRouterUpdatedEvent,
    UpdateSessionRouterRequest, MY_DEFAULT_ROUTER_PROFILE_ID, ROUTER_PORT_SCAN_END,
};

#[cfg(test)]
pub use types::{RouterModelPins, RouterProfile};
