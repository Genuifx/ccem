use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub(super) const OUTPUT_DRAIN_GRACE: Duration = Duration::from_secs(5);
const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const TRUNCATION_NOTICE: &str = "\n[CCEM: output truncated at 8 MiB]\n";

#[derive(Default)]
struct OutputBuffer {
    bytes: Vec<u8>,
    truncated: bool,
    stopped: bool,
}

impl OutputBuffer {
    fn append(&mut self, bytes: &[u8]) {
        if self.stopped {
            return;
        }
        let remaining = MAX_OUTPUT_BYTES.saturating_sub(self.bytes.len());
        let count = remaining.min(bytes.len());
        self.bytes.extend_from_slice(&bytes[..count]);
        self.truncated |= count != bytes.len();
    }

    fn text(&self) -> String {
        let mut text = String::from_utf8_lossy(&self.bytes).into_owned();
        if self.truncated {
            text.push_str(TRUNCATION_NOTICE);
        }
        text
    }
}

/// Drain concurrently so the child cannot block on a full pipe. An escaped
/// writer cannot delay completion indefinitely or grow retained memory without
/// limit. After finish, a blocked reader retains only the empty shared buffer.
pub(super) struct OutputCollector {
    handle: Option<thread::JoinHandle<()>>,
    buffer: Arc<Mutex<OutputBuffer>>,
    done: Arc<AtomicBool>,
}

impl OutputCollector {
    pub(super) fn spawn<T: Read + Send + 'static>(stream: Option<T>) -> Self {
        let buffer = Arc::new(Mutex::new(OutputBuffer::default()));
        let done = Arc::new(AtomicBool::new(false));
        let writer = Arc::clone(&buffer);
        let done_flag = Arc::clone(&done);
        let handle = thread::spawn(move || {
            if let Some(mut stream) = stream {
                let mut chunk = [0u8; 8192];
                loop {
                    match stream.read(&mut chunk) {
                        Ok(0) => break,
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                        Ok(read) => {
                            let Ok(mut buffer) = writer.lock() else {
                                break;
                            };
                            if buffer.stopped {
                                break;
                            }
                            buffer.append(&chunk[..read]);
                        }
                    }
                }
            }
            done_flag.store(true, Ordering::Release);
        });
        Self {
            handle: Some(handle),
            buffer,
            done,
        }
    }

    pub(super) fn snapshot(&self) -> String {
        self.buffer
            .lock()
            .map(|buffer| buffer.text())
            .unwrap_or_default()
    }

    pub(super) fn finish(mut self, grace: Duration) -> String {
        let deadline = Instant::now() + grace;
        while !self.done.load(Ordering::Acquire) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        if self.done.load(Ordering::Acquire) {
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
        let Ok(mut buffer) = self.buffer.lock() else {
            return String::new();
        };
        // Set stopped and release the allocation under the same lock the reader
        // uses, so it cannot repopulate the buffer after this final snapshot.
        buffer.stopped = true;
        let text = buffer.text();
        buffer.bytes = Vec::new();
        text
    }
}

/// Only pass a child launched with process_group(0) on Unix. Never signal a
/// process group inferred from shared app state or another task's process.
pub(super) fn kill_cron_process_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        let group_id = i32::try_from(child.id()).unwrap_or(0);
        if group_id > 1 {
            // SAFETY: the caller created this dedicated process group at spawn.
            let result = unsafe { libc::kill(-group_id, libc::SIGKILL) };
            if result != 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ESRCH) {
                    eprintln!("[cron] failed to kill process group {group_id}: {error}");
                }
                let _ = child.kill();
            }
        } else {
            let _ = child.kill();
        }
    }
    #[cfg(not(unix))]
    let _ = child.kill();

    // A failed kill must not replace the old unbounded pipe wait with an
    // unbounded process wait before the terminal result is saved.
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Err(error) => {
                eprintln!("[cron] failed to reap child {}: {error}", child.id());
                return;
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                eprintln!("[cron] child {} did not exit within kill grace", child.id());
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collector_caps_output_and_marks_truncation() {
        let input = vec![b'x'; MAX_OUTPUT_BYTES + 1024];
        let collector = OutputCollector::spawn(Some(std::io::Cursor::new(input)));
        let text = collector.finish(Duration::from_secs(2));
        assert_eq!(text.len(), MAX_OUTPUT_BYTES + TRUNCATION_NOTICE.len());
        assert!(text.ends_with(TRUNCATION_NOTICE));
    }

    #[test]
    fn finish_stops_collection_and_releases_retained_bytes() {
        let collector = OutputCollector::spawn(Some(std::io::Cursor::new(b"report")));
        let buffer = Arc::clone(&collector.buffer);
        assert_eq!(collector.finish(Duration::from_secs(2)), "report");
        let mut retained = buffer.lock().unwrap();
        assert!(retained.stopped);
        assert_eq!(retained.bytes.capacity(), 0);
        retained.append(b"late output");
        assert!(retained.bytes.is_empty());
    }

    #[cfg(unix)]
    struct OwnedChild(std::process::Child);

    #[cfg(unix)]
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            kill_cron_process_tree(&mut self.0);
        }
    }

    #[cfg(unix)]
    fn spawn_fixture(script: &str) -> OwnedChild {
        use std::os::unix::process::CommandExt;
        OwnedChild(
            std::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(script)
                .process_group(0)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .spawn()
                .expect("spawn owned test process group"),
        )
    }

    #[cfg(unix)]
    fn wait_for_text(collector: &OutputCollector, needle: &str) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !collector.snapshot().contains(needle) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            collector.snapshot().contains(needle),
            "fixture did not become ready"
        );
    }

    #[cfg(unix)]
    #[test]
    fn output_collector_finish_returns_within_grace_despite_orphaned_writer() {
        // Explicitly fork a writer and handshake before its parent exits.
        // OwnedChild cleans the exact group even if an assertion panics.
        let mut child = spawn_fixture("sleep 600 & echo writer:$!; echo final-report; exit 0");
        let collector = OutputCollector::spawn(child.0.stdout.take());
        wait_for_text(&collector, "final-report");
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if child.0.try_wait().unwrap().is_some() {
                break;
            }
            assert!(Instant::now() < deadline, "fixture parent did not exit");
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            !collector.done.load(Ordering::Acquire),
            "writer did not hold pipe open"
        );
        let done = Arc::clone(&collector.done);
        let started = Instant::now();
        let output = collector.finish(Duration::from_millis(100));
        assert!(output.contains("final-report"));
        assert!(started.elapsed() < Duration::from_secs(2));
        drop(child);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !done.load(Ordering::Acquire) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            done.load(Ordering::Acquire),
            "fixture writer was not cleaned up"
        );
    }

    #[cfg(unix)]
    #[test]
    fn kill_cron_process_tree_kills_ready_descendants() {
        let mut child = spawn_fixture("sleep 600 & echo writer:$!; wait");
        let collector = OutputCollector::spawn(child.0.stdout.take());
        wait_for_text(&collector, "writer:");
        let pid: u32 = collector
            .snapshot()
            .trim()
            .strip_prefix("writer:")
            .unwrap()
            .parse()
            .unwrap();
        assert_ne!(pid, child.0.id(), "fixture must have a distinct descendant");
        assert!(!collector.done.load(Ordering::Acquire));
        kill_cron_process_tree(&mut child.0);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !collector.done.load(Ordering::Acquire) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        // EOF proves the descendant holding the write end also terminated;
        // killing only the parent would leave this pipe open for 600 seconds.
        assert!(
            collector.done.load(Ordering::Acquire),
            "descendant kept pipe open after group kill"
        );
        assert!(child.0.try_wait().unwrap().is_some());
        collector.finish(Duration::ZERO);
    }
}
