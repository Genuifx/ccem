pub(super) mod artifacts;
mod console_events;
mod diagnostic_segment;
pub(super) mod guard;
mod handoff_preflight;
mod network_events;
pub(super) mod owner;
mod owner_config;
mod owner_handoff;
mod owner_protocol;
pub(in crate::browser::login) use owner_protocol::OwnerTerminalTermination;
mod owner_transition;
mod protocol;
mod semantics;
mod transport;

#[cfg(test)]
mod effect_fence_tests;
#[cfg(all(test, unix))]
mod owner_protocol_tests;
