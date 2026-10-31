//! OS-held run leases distinguish dead runners from runners in other app instances.
use fs2::FileExt;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

static RUN_MUTATIONS: Mutex<()> = Mutex::new(());

pub(super) struct RunMutationGuard {
    _thread: MutexGuard<'static, ()>,
    _file: File,
}

pub(super) fn lock_run_mutations(root: &Path) -> Result<RunMutationGuard, String> {
    let thread = RUN_MUTATIONS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let file = crate::secure_fs::open_private_lock_file(&root.join("mutations.lock"))
        .map_err(|e| e.to_string())?;
    file.lock_exclusive().map_err(|e| e.to_string())?;
    Ok(RunMutationGuard {
        _thread: thread,
        _file: file,
    })
}

fn lease_path(root: &Path, id: &str) -> PathBuf {
    root.join("leases")
        .join(format!("{:x}.lock", Sha256::digest(id.as_bytes())))
}

pub(super) struct RunLease(File);

impl RunLease {
    pub(super) fn acquire(root: &Path, id: &str) -> Result<Self, String> {
        let file = crate::secure_fs::open_private_lock_file(&lease_path(root, id))
            .map_err(|e| e.to_string())?;
        file.try_lock_exclusive().map_err(|e| e.to_string())?;
        Ok(Self(file))
    }
}

impl Drop for RunLease {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

/// Unknown ownership is never evidence of death. Do not create a missing lease.
pub(super) fn runner_is_gone(root: &Path, id: &str) -> bool {
    let Ok(file) = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(lease_path(root, id))
    else {
        return false;
    };
    file.try_lock_exclusive().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn independent_reader_preserves_live_runner_and_recovers_dropped_lease() {
        let root = tempfile::tempdir().unwrap();
        assert!(!runner_is_gone(root.path(), "unknown"));
        let lease = RunLease::acquire(root.path(), "run-1").unwrap();
        assert!(!runner_is_gone(root.path(), "run-1"));
        assert!(RunLease::acquire(root.path(), "run-1").is_err());
        drop(lease);
        assert!(runner_is_gone(root.path(), "run-1"));
    }

    #[test]
    fn panic_releases_runner_lease() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().to_owned();
        let _ = std::thread::spawn(move || {
            let _lease = RunLease::acquire(&path, "panic-run").unwrap();
            panic!("simulate runner loss");
        })
        .join();
        assert!(runner_is_gone(root.path(), "panic-run"));
    }

    // This fixture is selected by exact test name in a separate test process.
    // Ordinary test runs do nothing here; no parent-process environment or
    // user's HOME is modified.
    #[test]
    fn lease_holder_subprocess() {
        let Some(root) = std::env::var_os("CCEM_CRON_LEASE_TEST_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        assert!(root.join("fixture-marker").is_file());
        let _lease = RunLease::acquire(&root, "cross-process-run").unwrap();
        std::fs::write(root.join("ready"), b"locked").unwrap();
        // The parent kills this exact process to exercise OS crash cleanup.
        // The deadline also prevents an abandoned fixture from living forever.
        std::thread::sleep(std::time::Duration::from_secs(30));
    }

    #[test]
    fn other_process_lease_is_live_until_its_owner_is_killed() {
        struct OwnedTestProcess(std::process::Child);
        impl Drop for OwnedTestProcess {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("fixture-marker"), b"cron-lease-test").unwrap();
        // libtest's thread name is the actual filter, without the crate prefix
        // included by module_path!(). This also works in a standalone harness.
        let current_thread = std::thread::current();
        let test_name = current_thread.name().expect("libtest thread has a name");
        let module = test_name
            .rsplit_once("::")
            .expect("module-qualified test")
            .0;
        let child_test = format!("{module}::lease_holder_subprocess");
        let mut child = OwnedTestProcess(
            std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", &child_test, "--nocapture"])
                .env("CCEM_CRON_LEASE_TEST_ROOT", root.path())
                .stdout(std::process::Stdio::null())
                .spawn()
                .expect("spawn lease fixture process"),
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !root.path().join("ready").is_file() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "lease fixture exited before readiness"
            );
            assert!(
                std::time::Instant::now() < deadline,
                "lease fixture did not become ready"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        assert!(!runner_is_gone(root.path(), "cross-process-run"));
        assert!(RunLease::acquire(root.path(), "cross-process-run").is_err());
        child.0.kill().expect("kill only this test's lease holder");
        child.0.wait().expect("reap owned lease holder");
        assert!(runner_is_gone(root.path(), "cross-process-run"));
        let _replacement = RunLease::acquire(root.path(), "cross-process-run")
            .expect("OS released lease after owner death");
    }
}
