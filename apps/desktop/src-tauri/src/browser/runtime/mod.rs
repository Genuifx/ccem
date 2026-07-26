//! Trusted managed-Chromium runtime preparation primitives.
//!
//! This module deliberately stops at the M2.0a trust, readiness, and activation boundary. Network
//! download, archive extraction, platform identity, and Chromium smoke adapters are injected by
//! later slices; none of those paths can manufacture an active runtime without a verified receipt.

pub(crate) mod activation;
pub(crate) mod download;
pub(crate) mod extract;
pub(crate) mod identity;
pub(crate) mod maintenance;
pub(crate) mod manager;
pub(crate) mod manifest;
pub(crate) mod paths;
pub(crate) mod preparation;
pub(crate) mod smoke;
pub(crate) mod state;
