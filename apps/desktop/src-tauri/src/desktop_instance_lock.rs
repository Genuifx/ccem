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
    let lock_name = if cfg!(debug_assertions) {
        "desktop-app-dev.lock"
    } else {
        "desktop-app.lock"
    };
    dirs::home_dir()
        .map(|home| home.join(format!(".ccem/{}", lock_name)))
        .unwrap_or_else(|| PathBuf::from(format!(".ccem/{}", lock_name)))
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
    use super::acquire_desktop_instance_lock_at;

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
}
