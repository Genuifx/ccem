use super::{CefSurfaceLifecycle, CefSurfaceRecoveryState, SharedSurfaceState};

impl SharedSurfaceState {
    pub(super) fn begin_main_frame_load(&self, current_url: String) {
        self.update(|state| {
            if surface_is_terminal(state.lifecycle) {
                return;
            }
            state.lifecycle = CefSurfaceLifecycle::Loading;
            state.current_url = current_url;
            state.error = None;
        });
    }

    pub(super) fn finish_main_frame_load(&self, current_url: String) {
        self.update(|state| {
            if surface_is_terminal(state.lifecycle) {
                return;
            }
            state.lifecycle = CefSurfaceLifecycle::Ready;
            state.current_url = current_url;
            state.error = None;
        });
    }

    pub(super) fn begin_navigation(&self) -> Result<(), String> {
        let mut blocked = None;
        self.update(|state| match state.lifecycle {
            CefSurfaceLifecycle::Closing | CefSurfaceLifecycle::Closed => {
                blocked = Some("CEF surface is closing".to_string());
            }
            CefSurfaceLifecycle::Failed => {
                blocked = Some(
                    "CEF surface requires an explicit close and reopen before navigation"
                        .to_string(),
                );
            }
            _ => {
                state.lifecycle = CefSurfaceLifecycle::Loading;
                state.error = None;
            }
        });
        blocked.map_or(Ok(()), Err)
    }

    pub(super) fn record_renderer_termination(&self) {
        self.clear_focus_restore_intent();
        self.update(|state| {
            if surface_is_terminal(state.lifecycle) {
                return;
            }
            state.lifecycle = CefSurfaceLifecycle::Failed;
            state.devtools_attached = false;
            state.user_popups_allowed = false;
            state.recovery_state = Some(CefSurfaceRecoveryState::RendererProcessTerminated);
            state.error = Some(
                "CEF renderer process terminated. Close and reopen this browser workspace to recover."
                    .to_string(),
            );
        });
    }

    pub(super) fn record_popup_renderer_termination(&self, popup_id: i32) {
        let failed = self.update_popup(popup_id, |popup| {
            if surface_is_terminal(popup.lifecycle) {
                return;
            }
            popup.lifecycle = CefSurfaceLifecycle::Failed;
            popup.error = Some(
                "CEF popup renderer process terminated. Close this popup and retry the sign-in flow."
                    .to_string(),
            );
        });
        if failed {
            self.clear_focus_restore_intent();
        }
    }
}

fn surface_is_terminal(lifecycle: CefSurfaceLifecycle) -> bool {
    matches!(
        lifecycle,
        CefSurfaceLifecycle::Closing | CefSurfaceLifecycle::Closed | CefSurfaceLifecycle::Failed
    )
}
