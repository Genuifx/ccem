//! React owns overlay layout; AppKit owns which native view receives input.
//! This protocol never grants browser/CDP authority and is fenced to the current
//! trusted main document, just like the browser surface protocol.
use serde::Deserialize;
use tauri::{AppHandle, WebviewWindow};

#[cfg(all(target_os = "macos", debug_assertions))]
pub(crate) mod debug;
#[cfg(target_os = "macos")]
pub(crate) mod macos;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct OverlayRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl OverlayRect {
    fn valid(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .into_iter()
            .all(f64::is_finite)
            && self.width > 0.0
            && self.height > 0.0
            && self.x.abs() <= 100_000.0
            && self.y.abs() <= 100_000.0
            && self.width <= 100_000.0
            && self.height <= 100_000.0
    }

    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.width && y < self.y + self.height
    }
}

#[derive(Default, Debug)]
pub(crate) struct OverlayPolicy {
    revision: u64,
    modal: bool,
    regions: Vec<OverlayRect>,
}

impl OverlayPolicy {
    fn update(
        &mut self,
        revision: u64,
        modal: bool,
        regions: Vec<OverlayRect>,
    ) -> Result<(), String> {
        if revision == 0
            || revision > 9_007_199_254_740_991
            || regions.len() > 256
            || regions.iter().any(|rect| !rect.valid())
        {
            return Err("Invalid native browser overlay geometry".into());
        }
        // An IPC already queued before a newer React commit must not reopen a
        // modal's native click region or reintroduce an unmounted menu.
        if revision <= self.revision {
            return Ok(());
        }
        self.revision = revision;
        self.modal = modal;
        self.regions = regions;
        Ok(())
    }

    fn blocks(&self, x: f64, y: f64) -> bool {
        self.modal || self.regions.iter().any(|region| region.contains(x, y))
    }
}

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Browser overlay access is restricted to the trusted main window".into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn browser_overlay_initialize(
    app: AppHandle,
    window: WebviewWindow,
    frontend_document_id: String,
    frontend_generation: u64,
) -> Result<bool, String> {
    require_main(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::webcontent_recovery::with_frontend_browser_document(
            &app,
            &frontend_document_id,
            frontend_generation,
            || {
                #[cfg(target_os = "macos")]
                {
                    macos::initialize(&window)
                }
                #[cfg(not(target_os = "macos"))]
                {
                    Ok(false)
                }
            },
        )
    })
    .await
    .map_err(|error| format!("Initialize browser overlays: {error}"))?
}

#[tauri::command]
pub(crate) async fn browser_overlay_sync(
    app: AppHandle,
    window: WebviewWindow,
    frontend_document_id: String,
    frontend_generation: u64,
    revision: u64,
    modal: bool,
    regions: Vec<OverlayRect>,
) -> Result<(), String> {
    require_main(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::webcontent_recovery::with_frontend_browser_document(
            &app,
            &frontend_document_id,
            frontend_generation,
            || {
                #[cfg(target_os = "macos")]
                {
                    macos::sync(&app, revision, modal, regions)
                }
                #[cfg(not(target_os = "macos"))]
                {
                    let _ = (revision, modal, regions);
                    Ok(())
                }
            },
        )
    })
    .await
    .map_err(|error| format!("Sync browser overlays: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn menu() -> OverlayRect {
        OverlayRect {
            x: 420.0,
            y: 180.0,
            width: 120.0,
            height: 160.0,
        }
    }

    #[test]
    fn partial_overlay_only_intercepts_its_own_bounds() {
        let mut policy = OverlayPolicy::default();
        policy.update(1, false, vec![menu()]).unwrap();
        assert!(policy.blocks(420.0, 180.0));
        assert!(policy.blocks(530.0, 330.0));
        assert!(!policy.blocks(419.0, 180.0));
        assert!(!policy.blocks(540.0, 340.0));
        policy.update(2, false, vec![]).unwrap();
        assert!(!policy.blocks(420.0, 180.0));
    }

    #[test]
    fn modal_blocks_every_point_and_old_updates_cannot_unlock_it() {
        let mut policy = OverlayPolicy::default();
        policy.update(2, true, vec![]).unwrap();
        policy.update(1, false, vec![]).unwrap();
        policy.update(2, false, vec![]).unwrap();
        assert!(policy.blocks(0.0, 0.0));
        assert!(policy.blocks(3000.0, 3000.0));
        policy.update(3, false, vec![]).unwrap();
        assert!(!policy.blocks(0.0, 0.0));
    }

    #[test]
    fn invalid_regions_leave_the_previous_input_barrier_intact() {
        let mut policy = OverlayPolicy::default();
        policy.update(1, true, vec![]).unwrap();
        for invalid in [
            OverlayRect {
                width: f64::NAN,
                ..menu()
            },
            OverlayRect {
                width: -1.0,
                ..menu()
            },
        ] {
            assert!(policy.update(2, false, vec![invalid]).is_err());
            assert!(policy.blocks(0.0, 0.0));
        }
        assert!(policy.update(2, false, vec![menu(); 257]).is_err());
        assert!(policy.update(0, false, vec![]).is_err());
    }
}
