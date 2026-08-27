use crate::diagnostic_log;
use fs2::FileExt;
use serde_json::json;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;

#[derive(Debug)]
pub struct DesktopInstanceLock {
    _file: File,
}

fn lock_path() -> PathBuf {
    #[cfg(debug_assertions)]
    if let Some(root) = std::env::var_os("CCEM_BROWSER_DATA_ROOT").map(PathBuf::from) {
        if root.is_absolute() {
            return root.join("desktop-app-dev.lock");
        }
    }
    let instance_id = std::env::var("CCEM_DESKTOP_DEV_INSTANCE_ID").ok();
    lock_path_for_instance(instance_id.as_deref(), cfg!(debug_assertions))
}

fn lock_path_for_instance(instance_id: Option<&str>, debug_assertions: bool) -> PathBuf {
    let lock_name = if debug_assertions {
        instance_id
            .and_then(sanitize_instance_id)
            .map(|instance_id| format!("desktop-app-dev-{}.lock", instance_id))
            .unwrap_or_else(|| "desktop-app-dev.lock".to_string())
    } else {
        "desktop-app.lock".to_string()
    };
    dirs::home_dir()
        .map(|home| home.join(".ccem").join(&lock_name))
        .unwrap_or_else(|| PathBuf::from(".ccem").join(&lock_name))
}

fn sanitize_instance_id(value: &str) -> Option<String> {
    let mut sanitized = String::with_capacity(value.len().min(64));
    let mut pending_separator = false;

    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            if pending_separator && !sanitized.is_empty() {
                sanitized.push('-');
            }
            sanitized.push(character.to_ascii_lowercase());
            pending_separator = false;
        } else if !sanitized.is_empty() {
            pending_separator = true;
        }

        if sanitized.len() >= 64 {
            break;
        }
    }

    (!sanitized.is_empty()).then_some(sanitized)
}

pub fn acquire_desktop_instance_lock() -> Result<DesktopInstanceLock, String> {
    acquire_desktop_instance_lock_at(lock_path())
}

fn acquire_desktop_instance_lock_at(path: PathBuf) -> Result<DesktopInstanceLock, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create desktop lock dir: {}", error))?;
    }

    let mut file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(&path)
        .map_err(|error| format!("Failed to open desktop instance lock: {}", error))?;

    match file.try_lock_exclusive() {
        Ok(()) => {
            file.set_len(0)
                .map_err(|error| format!("Failed to clear desktop instance lock: {}", error))?;
            file.seek(SeekFrom::Start(0))
                .map_err(|error| format!("Failed to seek desktop instance lock: {}", error))?;
            writeln!(file, "{}", std::process::id())
                .map_err(|error| format!("Failed to write desktop instance lock: {}", error))?;
            diagnostic_log::append_session_launch_event(
                "desktop_instance_lock.acquired",
                json!({
                    "pid": std::process::id(),
                    "path": &path,
                }),
            );
            Ok(DesktopInstanceLock { _file: file })
        }
        Err(error) => {
            let mut owner = String::new();
            let _ = file.seek(SeekFrom::Start(0));
            let _ = file.read_to_string(&mut owner);
            diagnostic_log::append_session_launch_event(
                "desktop_instance_lock.busy",
                json!({
                    "pid": std::process::id(),
                    "owner_pid": owner.trim(),
                    "path": &path,
                    "error": error.to_string(),
                }),
            );
            Err(format!(
                "Another CCEM Desktop process is already running{}",
                if owner.trim().is_empty() {
                    ".".to_string()
                } else {
                    format!(" (pid {}).", owner.trim())
                }
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{acquire_desktop_instance_lock_at, lock_path_for_instance};

    #[test]
    fn desktop_instance_lock_rejects_second_holder() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let lock_path = temp_dir.path().join("desktop-app.lock");
        let first = acquire_desktop_instance_lock_at(lock_path.clone()).expect("first lock");

        let second = acquire_desktop_instance_lock_at(lock_path).expect_err("second lock rejected");
        assert!(
            second.contains("already running"),
            "unexpected error: {}",
            second
        );

        drop(first);
    }

    #[test]
    fn desktop_instance_lock_path_is_scoped_to_the_dev_instance() {
        let alpha = lock_path_for_instance(Some("worktree-alpha"), true);
        let beta = lock_path_for_instance(Some("worktree-beta"), true);

        assert_ne!(alpha, beta, "different worktrees must not share a dev lock");
        assert!(alpha.ends_with("desktop-app-dev-worktree-alpha.lock"));
        assert!(beta.ends_with("desktop-app-dev-worktree-beta.lock"));
    }

    #[test]
    fn desktop_instance_lock_path_sanitizes_untrusted_instance_ids() {
        let path = lock_path_for_instance(Some("../../Feature One! 🚀"), true);

        assert!(path.ends_with("desktop-app-dev-feature-one.lock"));
        assert_eq!(
            path.parent(),
            dirs::home_dir().map(|home| home.join(".ccem")).as_deref()
        );
    }
}
