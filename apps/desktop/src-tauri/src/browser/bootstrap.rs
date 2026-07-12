use super::login;
use super::runtime;
use super::runtime::manager::BrowserRuntimeManager;
use std::path::PathBuf;
use std::sync::Arc;

pub(crate) fn create_browser_runtime_manager() -> Result<Arc<BrowserRuntimeManager>, String> {
    let browser_root = browser_data_root()?;
    let smoke_runner = login::install_smoke::production_installation_smoke_runner(
        browser_root.join("installation-smoke"),
    );
    BrowserRuntimeManager::production(browser_root.join("runtime"), smoke_runner)
        .map_err(|error| error.to_string())
}

pub(crate) fn create_login_browser_session_manager(
) -> Result<Arc<login::session::LoginBrowserSessionManager>, String> {
    let browser_root = browser_data_root()?;
    let runtime_paths = runtime::paths::RuntimePaths::under(browser_root.join("runtime"))
        .map_err(|_| "failed to initialize Login Browser runtime paths".to_string())?;
    login::session::LoginBrowserSessionManager::production(
        browser_root.join("login"),
        runtime::activation::ActivationStore::new(runtime_paths),
    )
    .map(Arc::new)
    .map_err(|error| error.to_string())
}

fn browser_data_root() -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    if let Some(root) = std::env::var_os("CCEM_BROWSER_DATA_ROOT").map(PathBuf::from) {
        if !root.is_absolute() {
            return Err("CCEM_BROWSER_DATA_ROOT must be absolute.".to_string());
        }
        return Ok(root);
    }
    Ok(crate::config::get_ccem_dir().join("browser"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_root_is_app_owned_and_debug_override_must_be_absolute() {
        let root = browser_data_root().expect("valid browser data root");
        assert!(root.is_absolute());
    }
}
