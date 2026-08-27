use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static PRIVATE_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn ensure_private_dir(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

pub fn harden_private_file(path: &Path) -> io::Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "Private storage path is not a regular file: {}",
                path.display()
            ),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

pub fn open_private_lock_file(path: &Path) -> io::Result<File> {
    if let Some(parent) = path.parent() {
        create_private_parent_if_missing(parent)?;
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    harden_private_file(path)?;
    Ok(file)
}

pub fn write_private_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        create_private_parent_if_missing(parent)?;
    }
    let temp_path = private_temp_path(path);
    let result = (|| {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp_path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        harden_private_file(&temp_path)?;
        fs::rename(&temp_path, path)?;
        harden_private_file(path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn create_private_parent_if_missing(path: &Path) -> io::Result<()> {
    if path.exists() {
        return Ok(());
    }
    ensure_private_dir(path)
}

fn private_temp_path(path: &Path) -> PathBuf {
    let counter = PRIVATE_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("private-state");
    path.with_file_name(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        counter
    ))
}

pub fn harden_ccem_storage(root: &Path) -> io::Result<()> {
    ensure_private_dir(root)?;
    // Explicit allowlist only: do not recurse into runtime tools or user data.
    for file_name in [
        ".install-key",
        "config.lock",
        "config.json",
        "native-runtime-state.json",
        "runtime-state.json",
        "control.json",
        "telegram.json",
        "wecom.json",
        "weixin.json",
        "weixin-state.json",
    ] {
        harden_private_file(&root.join(file_name))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn private_directory_and_atomic_file_start_restricted() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".ccem");
        ensure_private_dir(&root).unwrap();
        assert_eq!(
            fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o700
        );

        let state = root.join("native-runtime-state.json");
        write_private_atomic(&state, b"{}").unwrap();
        assert_eq!(
            fs::metadata(&state).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(fs::read(&state).unwrap(), b"{}");
    }

    #[cfg(unix)]
    #[test]
    fn migration_hardens_only_known_regular_files() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".ccem");
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        let sensitive = root.join("config.json");
        fs::write(&sensitive, "{}").unwrap();
        fs::set_permissions(&sensitive, fs::Permissions::from_mode(0o644)).unwrap();
        let unrelated = root.join("runtime-tools");
        fs::create_dir(&unrelated).unwrap();
        fs::set_permissions(&unrelated, fs::Permissions::from_mode(0o755)).unwrap();

        harden_ccem_storage(&root).unwrap();

        assert_eq!(
            fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&sensitive).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&unrelated).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }
}
