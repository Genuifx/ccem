use super::*;
use std::collections::HashSet;

const HIDE_RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(100), Duration::from_millis(400)];

/// Native hide acknowledgement is independent of the presentation lease. A
/// re-acquire does not prove the old native view was hidden or has fresh bounds.
#[derive(Default)]
pub(super) struct PendingFrontendHides {
    epoch: u64,
    surfaces: HashSet<String>,
}

impl PendingFrontendHides {
    fn begin(&mut self, surfaces: impl IntoIterator<Item = String>) -> u64 {
        self.epoch = self.epoch.saturating_add(1);
        self.surfaces = surfaces.into_iter().collect();
        self.epoch
    }

    fn pending(&self, epoch: Option<u64>) -> Vec<String> {
        if epoch.is_some_and(|epoch| epoch != self.epoch) {
            return Vec::new();
        }
        self.surfaces.iter().cloned().collect()
    }

    pub(super) fn confirmed_visibility(&mut self, surface_id: &str) {
        self.surfaces.remove(surface_id);
    }
}

impl LoginBrowserSurfaceManager {
    /// Called under the host's exclusive document gate, on a blocking worker.
    /// Acquires lifecycle before operation so a new native runtime cannot commit
    /// across reset. Neither the runtime nor its Agent authority is touched.
    pub(crate) fn reset_for_frontend_boot(
        self: &Arc<Self>,
        app: &AppHandle,
        cef_host: &Arc<CefHostController>,
    ) -> Result<(), String> {
        let (epoch, superseded) = {
            let _destructive = self.destructive_operation()?;
            let mut state = self.state()?;
            let mut superseded = Vec::new();
            let mut surfaces = Vec::new();
            for panel_session_id in state.instances.panel_session_ids() {
                if let Some(instance) = state.instances.get_mut(&panel_session_id) {
                    surfaces.push(instance.surface_id.clone());
                    if let Some(snapshot) = instance.coordinator.invalidate_lease() {
                        superseded.push(snapshot);
                    }
                }
                state.instances.deactivate(&panel_session_id);
            }
            state.presentation_epoch.reset();
            (state.frontend_hides.begin(surfaces), superseded)
        };
        for snapshot in superseded {
            self.emit_surface_state(app, &snapshot, "frontend_boot_reset", None);
        }
        if self
            .hide_pending_frontend_surfaces(app, cef_host, epoch)
            .is_ok()
        {
            return Ok(());
        }
        // One initial attempt plus two retries; persistent failures remain
        // pending for a future boot or explicit visibility sync to retry.
        let manager = Arc::clone(self);
        let app = app.clone();
        let cef_host = Arc::clone(cef_host);
        tauri::async_runtime::spawn_blocking(move || {
            for delay in HIDE_RETRY_DELAYS {
                thread::sleep(delay);
                if manager
                    .hide_pending_frontend_surfaces(&app, &cef_host, epoch)
                    .is_ok()
                {
                    return;
                }
            }
            eprintln!("CCEM frontend recovery native hide still pending after bounded retries");
        });
        Ok(())
    }

    fn hide_pending_frontend_surfaces(
        &self,
        app: &AppHandle,
        cef_host: &CefHostController,
        epoch: u64,
    ) -> Result<(), String> {
        let _operation = self.mutation_operation()?;
        self.hide_pending_frontend_surfaces_locked(app, cef_host, Some(epoch))
    }

    /// The operation gate spans both the pending check and native hide. A new
    /// document's successful show clears pending under that same gate, so an old
    /// retry can never hide it afterward, even when its lease was re-acquired.
    pub(super) fn hide_pending_frontend_surfaces_locked(
        &self,
        app: &AppHandle,
        cef_host: &CefHostController,
        epoch: Option<u64>,
    ) -> Result<(), String> {
        self.apply_pending_frontend_hides_locked(epoch, |surface_id| {
            cef_host.set_surface_visible(app, surface_id.to_owned(), false)
        })
    }

    fn apply_pending_frontend_hides_locked(
        &self,
        epoch: Option<u64>,
        mut hide: impl FnMut(&str) -> Result<(), String>,
    ) -> Result<(), String> {
        let pending = self.state()?.frontend_hides.pending(epoch);
        let mut first_error = None;
        for surface_id in pending {
            match hide(&surface_id) {
                Ok(()) => self
                    .state()?
                    .frontend_hides
                    .confirmed_visibility(&surface_id),
                Err(error) => {
                    first_error.get_or_insert(error);
                }
            }
        }
        first_error.map_or(Ok(()), Err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_hide_remains_pending_and_later_boot_retries_without_an_active_lease() {
        let manager = LoginBrowserSurfaceManager::default();
        let epoch = manager
            .state()
            .unwrap()
            .frontend_hides
            .begin(["retained".into()]);
        let mut attempts = 0;
        for _ in 0..=HIDE_RETRY_DELAYS.len() {
            assert!(manager
                .apply_pending_frontend_hides_locked(Some(epoch), |_| {
                    attempts += 1;
                    Err("native dispatch unavailable".into())
                })
                .is_err());
        }
        assert_eq!(attempts, 3);
        assert_eq!(
            manager.state().unwrap().frontend_hides.pending(Some(epoch)),
            ["retained"]
        );
        let next = manager
            .state()
            .unwrap()
            .frontend_hides
            .begin(["retained".into()]);
        manager
            .apply_pending_frontend_hides_locked(Some(next), |_| {
                attempts += 1;
                Ok(())
            })
            .unwrap();
        assert_eq!(attempts, 4);
        assert!(manager
            .state()
            .unwrap()
            .frontend_hides
            .pending(Some(next))
            .is_empty());
    }

    #[test]
    fn old_retry_cannot_hide_a_newly_presented_surface() {
        let manager = LoginBrowserSurfaceManager::default();
        let old_epoch = manager
            .state()
            .unwrap()
            .frontend_hides
            .begin(["retained".into()]);
        let next = manager
            .state()
            .unwrap()
            .frontend_hides
            .begin(["retained".into()]);
        manager
            .apply_pending_frontend_hides_locked(Some(old_epoch), |_| {
                panic!("an old document retry must not run in the new epoch")
            })
            .unwrap();
        manager
            .state()
            .unwrap()
            .frontend_hides
            .confirmed_visibility("retained");
        manager
            .apply_pending_frontend_hides_locked(Some(next), |_| {
                panic!("successful new visibility must cancel a pending hide")
            })
            .unwrap();
    }
}
