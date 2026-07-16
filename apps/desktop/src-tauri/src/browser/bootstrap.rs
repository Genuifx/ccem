use super::login;
use std::path::PathBuf;
#[cfg(debug_assertions)]
use std::path::{Component, Path};
use std::sync::Arc;

#[cfg(test)]
use super::runtime::manager::BrowserRuntimeManager;

#[cfg(any(target_os = "macos", windows))]
use super::login::cef::host::CefHostController;

#[cfg(test)]
pub(crate) fn create_browser_runtime_manager() -> Arc<BrowserRuntimeManager> {
    let result = browser_data_root().and_then(|browser_root| {
        let smoke_runner = login::install_smoke::production_installation_smoke_runner(
            browser_root.join("installation-smoke"),
        );
        BrowserRuntimeManager::production(browser_root.join("runtime"), smoke_runner)
            .map_err(|error| error.to_string())
    });
    match result {
        Ok(manager) => manager,
        Err(error) => {
            eprintln!("Browser runtime state is unavailable: {error}");
            BrowserRuntimeManager::unavailable()
        }
    }
}

pub(crate) fn create_login_browser_session_manager(
) -> Arc<login::session::LoginBrowserSessionManager> {
    let result = browser_data_root().and_then(|browser_root| {
        login::session::LoginBrowserSessionManager::production(browser_root.join("login"))
            .map(Arc::new)
            .map_err(|error| error.to_string())
    });
    match result {
        Ok(manager) => manager,
        Err(error) => {
            eprintln!("Login Browser session state is unavailable: {error}");
            Arc::new(login::session::LoginBrowserSessionManager::unavailable())
        }
    }
}

pub(crate) fn create_login_browser_surface_manager(
    sessions: &Arc<login::session::LoginBrowserSessionManager>,
) -> Arc<login::surface_commands::LoginBrowserSurfaceManager> {
    if !sessions.is_available() {
        return Arc::new(
            login::surface_commands::LoginBrowserSurfaceManager::unavailable(
                "Login Browser session state is unavailable. Preview Browser remains available.",
            ),
        );
    }
    let result = browser_data_root().and_then(|browser_root| {
        login::surface_commands::LoginBrowserSurfaceManager::production(
            browser_root.join("login").join("embedded-owners"),
            sessions,
        )
    });
    match result {
        Ok(manager) => Arc::new(manager),
        Err(error) => {
            eprintln!("Embedded Login Browser recovery is unavailable: {error}");
            Arc::new(login::surface_commands::LoginBrowserSurfaceManager::unavailable(
                "Login Browser recovery state requires attention. Preview Browser remains available.",
            ))
        }
    }
}

#[cfg(any(target_os = "macos", windows))]
pub(crate) fn create_cef_host_controller() -> Arc<CefHostController> {
    match browser_data_root()
        .and_then(|root| CefHostController::new(root.join("login").join("cef")))
    {
        Ok(controller) => Arc::new(controller),
        Err(error) => {
            eprintln!("Embedded CEF host is unavailable: {error}");
            Arc::new(CefHostController::unavailable(
                "Embedded Login Browser is unavailable. Preview Browser remains available.",
            ))
        }
    }
}

fn browser_data_root() -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let release_root = crate::config::get_ccem_dir().join("browser");
        if let Some(root) = std::env::var_os("CCEM_BROWSER_DATA_ROOT").map(PathBuf::from) {
            if !root.is_absolute() {
                return Err("CCEM_BROWSER_DATA_ROOT must be absolute.".to_string());
            }
            if path_overlaps_release_root(&root, &release_root) {
                return Err(
                    "Debug browser data must not reuse the release browser profile root."
                        .to_string(),
                );
            }
            return Ok(root);
        }
        return Ok(crate::config::get_ccem_dir().join("browser-dev"));
    }

    #[cfg(not(debug_assertions))]
    Ok(crate::config::get_ccem_dir().join("browser"))
}

#[cfg(debug_assertions)]
fn path_overlaps_release_root(candidate: &Path, release_root: &Path) -> bool {
    if candidate.starts_with(release_root) || release_root.starts_with(candidate) {
        return true;
    }

    // Reject parent traversal rather than trying to reason about a debug profile
    // root whose final location depends on which ancestors already exist.
    if candidate
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return true;
    }

    match (
        canonicalize_with_missing_tail(candidate),
        canonicalize_with_missing_tail(release_root),
    ) {
        (Ok(candidate), Ok(release_root)) => {
            candidate.starts_with(&release_root) || release_root.starts_with(&candidate)
        }
        // A path that cannot be resolved from an existing ancestor is not a
        // safe debug override. Keep release credentials isolated by failing
        // closed instead of allowing an ambiguous root.
        _ => true,
    }
}

#[cfg(debug_assertions)]
fn canonicalize_with_missing_tail(path: &Path) -> std::io::Result<PathBuf> {
    let mut cursor = path;
    let mut missing = Vec::new();

    loop {
        match cursor.canonicalize() {
            Ok(mut canonical) => {
                while let Some(component) = missing.pop() {
                    canonical.push(component);
                }
                return Ok(canonical);
            }
            Err(error) => {
                let Some(file_name) = cursor.file_name() else {
                    return Err(error);
                };
                missing.push(file_name.to_os_string());
                let Some(parent) = cursor.parent() else {
                    return Err(error);
                };
                cursor = parent;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_root_is_app_owned_and_debug_override_must_be_absolute() {
        let root = browser_data_root().expect("valid browser data root");
        assert!(root.is_absolute());
        #[cfg(debug_assertions)]
        assert!(root.ends_with("browser-dev"));
    }

    #[cfg(debug_assertions)]
    #[test]
    fn debug_browser_root_rejects_release_root_and_its_descendants() {
        let release_root = crate::config::get_ccem_dir().join("browser");
        assert!(path_overlaps_release_root(&release_root, &release_root));
        assert!(path_overlaps_release_root(
            &release_root.join("login/cef"),
            &release_root
        ));
        assert!(!path_overlaps_release_root(
            &crate::config::get_ccem_dir().join("browser-dev"),
            &release_root
        ));
    }

    #[cfg(all(debug_assertions, unix))]
    #[test]
    fn debug_browser_root_rejects_missing_child_beneath_release_symlink() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().expect("temporary browser roots");
        let release_root = root.path().join("release/browser");
        std::fs::create_dir_all(&release_root).expect("create release browser root");
        let debug_alias = root.path().join("debug-browser-alias");
        symlink(&release_root, &debug_alias).expect("link debug alias to release root");

        assert!(path_overlaps_release_root(
            &debug_alias.join("new-profile"),
            &release_root
        ));
        assert!(!path_overlaps_release_root(
            &root.path().join("separate-debug-root/new-profile"),
            &release_root
        ));
    }
}
