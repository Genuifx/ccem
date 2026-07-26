use super::super::session::{
    LoginBrowserSessionSnapshot, LoginBrowserSessionStatus, SessionControlOwner,
};
use crate::browser::surface_coordinator::{
    BrowserSurfaceBackend, BrowserSurfaceSnapshot as CoordinatorSnapshot,
};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

#[cfg(any(target_os = "macos", windows))]
use super::super::cef::{
    recovery::EmbeddedOwnerRecoveryDisposition,
    surface::{CefSurfaceLifecycle, CefSurfaceRecoveryState, CefSurfaceSnapshot},
};

#[derive(Debug, Clone, Serialize)]
pub(crate) struct BrowserSurfaceLeaseResponse {
    pub(crate) lease_id: String,
    pub(crate) generation: u64,
    /// Stable native instance identity. This is intentionally distinct from a presentation
    /// lease: re-acquiring a retained panel rotates the lease without recreating CEF.
    pub(crate) surface_id: Option<String>,
    pub(crate) client_revision: u64,
    pub(crate) server_sequence: u64,
    pub(crate) backend: &'static str,
    pub(crate) profile_id: Option<String>,
    pub(crate) snapshot: Option<BrowserSurfaceSnapshotResponse>,
}

#[derive(Debug, Clone, Serialize)]
struct BrowserSurfaceStateChangedEvent {
    lease_id: String,
    generation: u64,
    client_revision: u64,
    server_sequence: u64,
    backend: &'static str,
    cause: &'static str,
    snapshot: Option<BrowserSurfaceSnapshotResponse>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct BrowserSurfaceSnapshotResponse {
    url: Option<String>,
    title: Option<String>,
    pub(super) visible: bool,
    loading: bool,
    pub(super) error: Option<String>,
    pub(super) lifecycle: &'static str,
    control: &'static str,
    paused: bool,
    profile_id: Option<String>,
    session_status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    recovery_states: Option<Vec<String>>,
    popup_active: bool,
    popup_url: Option<String>,
    popup_title: Option<String>,
    popup_loading: bool,
    popup_error: Option<String>,
}

#[cfg(any(target_os = "macos", windows))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum BrowserSurfaceRecoveryState {
    RendererProcessTerminated,
}

#[cfg(any(target_os = "macos", windows))]
impl BrowserSurfaceRecoveryState {
    const fn as_str(self) -> &'static str {
        match self {
            Self::RendererProcessTerminated => "renderer_process_terminated",
        }
    }
}

#[cfg(any(target_os = "macos", windows))]
impl BrowserSurfaceSnapshotResponse {
    pub(super) fn set_recovery_states(&mut self, states: &[EmbeddedOwnerRecoveryDisposition]) {
        if !states.is_empty() {
            let recovery_states = self.recovery_states.get_or_insert_with(Vec::new);
            recovery_states.extend(states.iter().map(|state| state.as_str().to_string()));
            recovery_states.sort();
            recovery_states.dedup();
        }
    }

    pub(super) fn push_recovery_state(&mut self, state: BrowserSurfaceRecoveryState) {
        self.recovery_states
            .get_or_insert_with(Vec::new)
            .push(state.as_str().to_string());
        if let Some(states) = self.recovery_states.as_mut() {
            states.sort();
            states.dedup();
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct BrowserSurfaceSnapshotMutationResponse {
    pub(crate) lease_id: String,
    pub(crate) generation: u64,
    pub(crate) server_sequence: u64,
    pub(crate) snapshot: BrowserSurfaceSnapshotResponse,
}

pub(super) fn snapshot_mutation_response(
    current: &CoordinatorSnapshot,
    server_sequence: u64,
    snapshot: BrowserSurfaceSnapshotResponse,
) -> BrowserSurfaceSnapshotMutationResponse {
    BrowserSurfaceSnapshotMutationResponse {
        lease_id: current.lease.lease_id.clone(),
        generation: current.lease.generation,
        server_sequence,
        snapshot,
    }
}

#[cfg(any(target_os = "macos", windows))]
pub(super) fn snapshot_response(
    native: &CefSurfaceSnapshot,
    session: &LoginBrowserSessionSnapshot,
) -> BrowserSurfaceSnapshotResponse {
    let popup = native.popup.as_ref();
    let mut response = BrowserSurfaceSnapshotResponse {
        url: (!native.current_url.is_empty()).then(|| native.current_url.clone()),
        title: native.title.clone(),
        visible: native.visible,
        loading: matches!(
            native.lifecycle,
            CefSurfaceLifecycle::Creating | CefSurfaceLifecycle::Loading
        ),
        error: native.error.clone(),
        lifecycle: match native.lifecycle {
            CefSurfaceLifecycle::Creating => "creating",
            CefSurfaceLifecycle::Loading => "loading",
            CefSurfaceLifecycle::Ready => "ready",
            CefSurfaceLifecycle::Closing => "closing",
            CefSurfaceLifecycle::Closed => "closed",
            CefSurfaceLifecycle::Failed => "failed",
        },
        control: match session.control {
            SessionControlOwner::User => "user",
            SessionControlOwner::Agent => "agent",
            SessionControlOwner::Paused => "paused",
        },
        paused: session.control == SessionControlOwner::Paused,
        profile_id: Some(native.profile_id.clone()),
        session_status: match session.status {
            LoginBrowserSessionStatus::Running => "running",
            LoginBrowserSessionStatus::Closing => "closing",
            LoginBrowserSessionStatus::CleanupRequired => "cleanup_required",
        },
        recovery_states: None,
        popup_active: popup.is_some(),
        popup_url: popup
            .filter(|popup| !popup.current_url.is_empty())
            .map(|popup| popup.current_url.clone()),
        popup_title: popup.and_then(|popup| popup.title.clone()),
        popup_loading: popup.is_some_and(|popup| {
            matches!(
                popup.lifecycle,
                CefSurfaceLifecycle::Creating | CefSurfaceLifecycle::Loading
            )
        }),
        popup_error: popup.and_then(|popup| popup.error.clone()),
    };
    if native.recovery_state == Some(CefSurfaceRecoveryState::RendererProcessTerminated) {
        response.push_recovery_state(BrowserSurfaceRecoveryState::RendererProcessTerminated);
    }
    response
}

pub(super) fn emit_surface_state(
    event_sequence: &Mutex<u64>,
    app: &AppHandle,
    current: &CoordinatorSnapshot,
    cause: &'static str,
    snapshot: Option<BrowserSurfaceSnapshotResponse>,
) -> u64 {
    // Keep sequence allocation and emit initiation in one server-owned lane.
    // Delivery may still cross threads, so clients fence by this sequence.
    let mut sequence = event_sequence
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let server_sequence = next_server_sequence(&mut sequence);
    let _ = app.emit(
        "browser_surface_state_changed",
        BrowserSurfaceStateChangedEvent {
            lease_id: current.lease.lease_id.clone(),
            generation: current.lease.generation,
            client_revision: current.last_applied_revision,
            server_sequence,
            backend: match current.backend {
                BrowserSurfaceBackend::Preview => "preview",
                BrowserSurfaceBackend::Login => "login",
            },
            cause,
            snapshot,
        },
    );
    server_sequence
}

fn next_server_sequence(current: &mut u64) -> u64 {
    *current = current
        .checked_add(1)
        .expect("browser surface server sequence exhausted");
    *current
}

#[cfg(test)]
mod tests {
    #[cfg(any(target_os = "macos", windows))]
    use super::BrowserSurfaceRecoveryState;
    use super::{next_server_sequence, snapshot_mutation_response, BrowserSurfaceSnapshotResponse};
    use crate::browser::surface_coordinator::{
        BrowserSurfaceBackend, BrowserSurfaceLease, BrowserSurfaceLifecycle,
        BrowserSurfaceSnapshot as CoordinatorSnapshot,
    };

    #[test]
    fn server_sequence_is_strictly_monotonic() {
        let mut current = 0;
        assert_eq!(next_server_sequence(&mut current), 1);
        assert_eq!(next_server_sequence(&mut current), 2);
        assert_eq!(current, 2);
    }

    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn renderer_termination_uses_a_stable_non_sensitive_recovery_state() {
        assert_eq!(
            BrowserSurfaceRecoveryState::RendererProcessTerminated.as_str(),
            "renderer_process_terminated"
        );
    }

    #[test]
    fn mutation_response_is_bound_to_the_exact_coordinator_lease() {
        let current = CoordinatorSnapshot {
            lease: BrowserSurfaceLease {
                lease_id: "lease-a".to_string(),
                generation: 8,
            },
            backend: BrowserSurfaceBackend::Login,
            lifecycle: BrowserSurfaceLifecycle::Ready,
            last_applied_revision: 4,
            lease_active: true,
            failure: None,
        };
        let response = snapshot_mutation_response(
            &current,
            17,
            BrowserSurfaceSnapshotResponse {
                url: None,
                title: Some("current".to_string()),
                visible: true,
                loading: false,
                error: None,
                lifecycle: "ready",
                control: "user",
                paused: false,
                profile_id: Some("profile-a".to_string()),
                session_status: "running",
                recovery_states: Some(vec!["recovered_runtime_owned".to_string()]),
                popup_active: false,
                popup_url: None,
                popup_title: None,
                popup_loading: false,
                popup_error: None,
            },
        );
        let json = serde_json::to_value(response).expect("serialize mutation response");
        assert_eq!(json["lease_id"], "lease-a");
        assert_eq!(json["generation"], 8);
        assert_eq!(json["server_sequence"], 17);
        assert_eq!(
            json["snapshot"]["recovery_states"][0],
            "recovered_runtime_owned"
        );
    }
}
