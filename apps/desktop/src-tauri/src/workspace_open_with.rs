//! "Open with" support for workspace files.
//!
//! The frontend never names an executable: it picks an `app_id` from a fixed
//! catalog and this module maps it to the launch command. Path resolution and
//! the workspace boundary stay with `resolve_workspace_path` in the caller.

use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOpenApp {
    pub id: &'static str,
    pub name: &'static str,
    /// `editor` | `browser` | `viewer` | `markdown`
    pub kind: &'static str,
    /// The application's own icon as a PNG data URL, when it can be read.
    pub icon: Option<String>,
}

/// (id, macOS application name, kind). The application name doubles as the
/// display name and the `open -a` argument.
#[cfg(target_os = "macos")]
const CATALOG: &[(&str, &str, &str)] = &[
    ("vscode", "Visual Studio Code", "editor"),
    ("cursor", "Cursor", "editor"),
    ("windsurf", "Windsurf", "editor"),
    ("zed", "Zed", "editor"),
    ("sublime", "Sublime Text", "editor"),
    ("xcode", "Xcode", "editor"),
    ("textedit", "TextEdit", "editor"),
    ("typora", "Typora", "markdown"),
    ("chrome", "Google Chrome", "browser"),
    ("safari", "Safari", "browser"),
    ("arc", "Arc", "browser"),
    ("edge", "Microsoft Edge", "browser"),
    ("firefox", "Firefox", "browser"),
    ("preview", "Preview", "viewer"),
];

#[cfg(target_os = "macos")]
fn installed_bundle(app_name: &str) -> Option<std::path::PathBuf> {
    let bundle = format!("{app_name}.app");
    let mut roots = vec![
        std::path::PathBuf::from("/Applications"),
        std::path::PathBuf::from("/System/Applications"),
        std::path::PathBuf::from("/System/Volumes/Preboot/Cryptexes/App/System/Applications"),
    ];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Applications"));
    }
    roots
        .into_iter()
        .map(|root| root.join(&bundle))
        .find(|path| path.exists())
}

/// Read the bundle's `CFBundleIconFile` and convert it to a small PNG data URL
/// with the system `sips`. Any failure just means no icon.
#[cfg(target_os = "macos")]
fn bundle_icon_data_url(bundle: &Path) -> Option<String> {
    use base64::Engine as _;
    let plist = bundle.join("Contents/Info.plist");
    let output = Command::new("plutil")
        .args(["-extract", "CFBundleIconFile", "raw"])
        .arg(&plist)
        .output()
        .ok()?;
    let mut icon_name = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if !output.status.success() || icon_name.is_empty() {
        return None;
    }
    if !icon_name.ends_with(".icns") {
        icon_name.push_str(".icns");
    }
    let icns = bundle.join("Contents/Resources").join(icon_name);
    let png = std::env::temp_dir().join(format!(
        "ccem-app-icon-{}-{:08x}.png",
        std::process::id(),
        rand::random::<u32>()
    ));
    let status = Command::new("sips")
        .args(["-s", "format", "png", "-Z", "64"])
        .arg(&icns)
        .arg("--out")
        .arg(&png)
        .output()
        .ok()
        .map(|output| output.status.success());
    let bytes = std::fs::read(&png).ok();
    let _ = std::fs::remove_file(&png);
    let bytes = bytes.filter(|_| status == Some(true))?;
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// Installed applications from the catalog, in catalog order. Icons cost a
/// `sips` call each, so the first result is kept for the process lifetime.
pub fn installed_apps() -> Vec<WorkspaceOpenApp> {
    #[cfg(target_os = "macos")]
    {
        static CACHE: std::sync::OnceLock<Vec<WorkspaceOpenApp>> = std::sync::OnceLock::new();
        CACHE
            .get_or_init(|| {
                CATALOG
                    .iter()
                    .filter_map(|&(id, name, kind)| {
                        let bundle = installed_bundle(name)?;
                        let icon = bundle_icon_data_url(&bundle);
                        Some(WorkspaceOpenApp { id, name, kind, icon })
                    })
                    .collect()
            })
            .clone()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}

/// Build the launch command for an already workspace-checked path.
/// `None`/`"default"` uses the OS handler and `"reveal"` shows the file in the
/// file manager; any other id must exist in the catalog.
pub fn open_command(resolved: &Path, app_id: Option<&str>) -> Result<Command, String> {
    match app_id.unwrap_or("default") {
        "default" => Ok(default_open_command(resolved)),
        "reveal" => Ok(reveal_command(resolved)),
        #[cfg(target_os = "macos")]
        id => {
            let (_, name, _) = CATALOG
                .iter()
                .find(|(candidate, _, _)| *candidate == id)
                .ok_or_else(|| format!("Unknown app id '{id}'"))?;
            let mut command = Command::new("open");
            command.arg("-a").arg(name).arg(resolved);
            Ok(command)
        }
        #[cfg(not(target_os = "macos"))]
        id => Err(format!("Unknown app id '{id}'")),
    }
}

fn default_open_command(resolved: &Path) -> Command {
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        command.arg(resolved);
        command
    }
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", ""]).arg(resolved);
        command
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let mut command = Command::new("xdg-open");
        command.arg(resolved);
        command
    }
}

fn reveal_command(resolved: &Path) -> Command {
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        command.arg("-R").arg(resolved);
        command
    }
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("explorer");
        command.arg(format!("/select,{}", resolved.display()));
        command
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let mut command = Command::new("xdg-open");
        command.arg(resolved.parent().unwrap_or(resolved));
        command
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(command: &Command) -> Vec<String> {
        command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn unknown_app_id_is_rejected() {
        let error = open_command(Path::new("/tmp/a.txt"), Some("/bin/sh")).unwrap_err();
        assert!(error.contains("Unknown app id"));
    }

    #[test]
    fn default_and_reveal_are_always_available() {
        assert!(open_command(Path::new("/tmp/a.txt"), None).is_ok());
        assert!(open_command(Path::new("/tmp/a.txt"), Some("default")).is_ok());
        assert!(open_command(Path::new("/tmp/a.txt"), Some("reveal")).is_ok());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn catalog_app_opens_by_application_name() {
        let command = open_command(Path::new("/tmp/a.html"), Some("chrome")).unwrap();
        assert_eq!(command.get_program(), "open");
        assert_eq!(args(&command), vec!["-a", "Google Chrome", "/tmp/a.html"]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn reveal_selects_the_file_in_finder() {
        let command = open_command(Path::new("/tmp/a.html"), Some("reveal")).unwrap();
        assert_eq!(args(&command), vec!["-R", "/tmp/a.html"]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn system_app_icon_converts_to_png_data_url() {
        let bundle = installed_bundle("Preview").expect("Preview ships with macOS");
        let icon = bundle_icon_data_url(&bundle).expect("Preview has an icns icon");
        assert!(icon.starts_with("data:image/png;base64,"));
        assert!(bundle_icon_data_url(Path::new("/nonexistent/Nope.app")).is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn catalog_ids_are_unique() {
        let mut ids: Vec<_> = CATALOG.iter().map(|(id, _, _)| *id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), CATALOG.len());
    }
}
