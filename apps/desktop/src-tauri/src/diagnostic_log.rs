use chrono::Utc;
use serde_json::{json, Value};
use std::fs::OpenOptions;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const MAX_SESSION_LAUNCH_LOG_BYTES: u64 = 5 * 1024 * 1024;
static SESSION_LAUNCH_LOG_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
#[cfg(test)]
static SESSION_LAUNCH_TEST_LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

fn log_path() -> PathBuf {
    #[cfg(test)]
    {
        return SESSION_LAUNCH_TEST_LOG_PATH
            .get_or_init(|| {
                let nonce = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos();
                std::env::temp_dir().join(format!(
                    "ccem-test-session-launch-{}-{nonce:x}.log",
                    std::process::id()
                ))
            })
            .clone();
    }

    #[cfg(not(test))]
    {
        dirs::home_dir()
            .map(|home| home.join(".ccem/desktop-session-launch.log"))
            .unwrap_or_else(|| PathBuf::from(".ccem/desktop-session-launch.log"))
    }
}

pub fn append_session_launch_event(event: &str, details: Value) {
    let path = log_path();
    let record = json!({
        "ts": Utc::now().to_rfc3339(),
        "event": event,
        "details": details,
    });
    let line = match serde_json::to_string(&record) {
        Ok(line) => line,
        Err(error) => {
            eprintln!("Failed to serialize desktop session launch log: {}", error);
            return;
        }
    };
    let _guard = SESSION_LAUNCH_LOG_WRITE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    if let Err(error) = append_line_at(&path, &line, MAX_SESSION_LAUNCH_LOG_BYTES) {
        eprintln!(
            "Failed to append desktop session launch log {}: {}",
            path.display(),
            error
        );
    }
}

fn append_line_at(path: &Path, line: &str, max_bytes: u64) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create log directory: {}", error))?;
    }
    let incoming_bytes = line.len() as u64 + 1;
    if incoming_bytes > max_bytes {
        return Err(format!(
            "diagnostic record is {} bytes, above the {} byte log limit",
            incoming_bytes, max_bytes
        ));
    }
    rotate_if_needed(path, incoming_bytes, max_bytes)?;

    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    options.mode(0o600);

    match options.open(path) {
        Ok(mut file) => {
            #[cfg(unix)]
            file.set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|error| format!("failed to secure log: {}", error))?;
            writeln!(file, "{}", line).map_err(|error| format!("failed to write log: {}", error))
        }
        Err(error) => Err(format!("failed to open log: {}", error)),
    }
}

fn rotate_if_needed(
    path: &Path,
    incoming_bytes: u64,
    max_bytes: u64,
) -> Result<(), String> {
    let current_bytes = match std::fs::metadata(path) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("failed to inspect log size: {}", error)),
    };
    if current_bytes.saturating_add(incoming_bytes) <= max_bytes {
        return Ok(());
    }

    let rotated_path = rotated_log_path(path);
    if rotated_path.exists() {
        std::fs::remove_file(&rotated_path)
            .map_err(|error| format!("failed to replace rotated log: {}", error))?;
    }
    std::fs::rename(path, &rotated_path)
        .map_err(|error| format!("failed to rotate diagnostic log: {}", error))?;
    #[cfg(unix)]
    std::fs::set_permissions(
        &rotated_path,
        std::fs::Permissions::from_mode(0o600),
    )
    .map_err(|error| format!("failed to secure rotated log: {}", error))?;
    Ok(())
}

fn rotated_log_path(path: &Path) -> PathBuf {
    let mut rotated = path.as_os_str().to_os_string();
    rotated.push(".1");
    PathBuf::from(rotated)
}

pub fn launch_log_path() -> PathBuf {
    log_path()
}

#[cfg(test)]
mod tests {
    use super::{append_line_at, log_path, rotated_log_path};

    #[test]
    fn session_launch_test_log_isolated_from_user_state() {
        let path = log_path();
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .expect("test diagnostic log should have a UTF-8 file name");

        assert!(path.starts_with(std::env::temp_dir()));
        assert!(file_name.starts_with("ccem-test-session-launch-"));
        assert_ne!(file_name, "desktop-session-launch.log");
    }

    #[test]
    fn session_launch_log_rotates_before_exceeding_limit() {
        let temp = tempfile::tempdir().expect("create diagnostic log tempdir");
        let path = temp.path().join("desktop-session-launch.log");
        std::fs::write(&path, vec![b'x'; 120]).expect("seed diagnostic log");

        append_line_at(&path, "new diagnostic record", 128)
            .expect("append should rotate the oversized log");

        assert_eq!(
            std::fs::read_to_string(&path).expect("read current diagnostic log"),
            "new diagnostic record\n"
        );
        assert_eq!(
            std::fs::metadata(rotated_log_path(&path))
                .expect("rotated diagnostic log should exist")
                .len(),
            120
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path)
                    .expect("read current log metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            assert_eq!(
                std::fs::metadata(rotated_log_path(&path))
                    .expect("read rotated log metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
}
