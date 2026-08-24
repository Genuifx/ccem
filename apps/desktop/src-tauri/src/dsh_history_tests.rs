//! Tests for dsh_history — split out to keep dsh_history.rs under 1000 lines.
//! This file is included via `#[path = "dsh_history_tests.rs"] mod tests;`.

use super::*;
use std::sync::Mutex;

/// Global mutex for tests that mutate environment variables (DSH_HOME etc).
/// Prevents parallel test interference and ensures RAII restoration on panic.
static ENV_MUTEX: Mutex<()> = Mutex::new(());

/// RAII guard that restores an environment variable on Drop (panic-safe).
struct EnvGuard {
    key: &'static str,
    original: Option<std::ffi::OsString>,
}

impl EnvGuard {
    fn set(key: &'static str, val: &str) -> Self {
        let original = std::env::var_os(key);
        std::env::set_var(key, val);
        Self { key, original }
    }
    fn set_os(key: &'static str, val: &std::ffi::OsStr) -> Self {
        let original = std::env::var_os(key);
        std::env::set_var(key, val);
        Self { key, original }
    }
    fn remove(key: &'static str) -> Self {
        let original = std::env::var_os(key);
        std::env::remove_var(key);
        Self { key, original }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        match &self.original {
            Some(val) => std::env::set_var(self.key, val),
            None => std::env::remove_var(self.key),
        }
    }
}

// =============================================================================
// DTO / path / allowlist tests (cross-platform, no subprocess)
// =============================================================================

#[test]
fn dsh_helper_source_path_points_to_resources() {
    let path = source_dsh_helper_path();
    assert!(path.ends_with("resources/dsh-history/lib/dsh-history-helper.mjs"));
    assert!(path
        .to_string_lossy()
        .contains("apps/desktop/src-tauri/resources"));
}
#[test]
fn resolve_dsh_home_respects_env() {
    let _lock = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = tempfile::TempDir::new().unwrap();
    let tmp_path = tmp.path().to_path_buf();

    {
        let _g = EnvGuard::set("DSH_HOME", tmp_path.to_str().unwrap());
        let source = resolve_dsh_source().unwrap();
        assert_eq!(source.home, tmp_path);
        assert_eq!(source.sessions_root, tmp_path.join("sessions"));
        assert_eq!(source.provenance, "env");
    }

    {
        let _g = EnvGuard::set("DSH_HOME", "/nonexistent/dsh/home");
        let result = resolve_dsh_source();
        assert!(result.is_err());
        match result.unwrap_err() {
            DshHistoryError::InvalidHome(_) => {}
            other => panic!("expected InvalidHome, got: {:?}", other),
        }
    }

    {
        let _g = EnvGuard::remove("DSH_HOME");
        // After removal, falls back to ~/.dsh which may or may not exist
        let _ = resolve_dsh_source(); // just verify no panic
    }
}

/// Non-UTF8 DSH_HOME must fail closed (InvalidHome), NOT fall back to ~/.dsh.
#[cfg(unix)]
#[test]
fn resolve_dsh_home_non_utf8_fails_closed() {
    use std::os::unix::ffi::OsStrExt;
    let _lock = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
    // Invalid UTF-8 byte sequence
    let non_utf8 = std::ffi::OsStr::from_bytes(b"/tmp/dsh-\xff\xfe-invalid");
    let _g = EnvGuard::set_os("DSH_HOME", non_utf8);
    let result = resolve_dsh_source();
    match result {
        Err(DshHistoryError::InvalidHome(msg)) => {
            assert!(
                msg.contains("non-UTF8"),
                "expected non-UTF8 message, got: {}",
                msg
            );
        }
        other => panic!("expected InvalidHome for non-UTF8, got: {:?}", other),
    }
}

#[test]
fn error_display_formatting() {
    assert_eq!(
        DshHistoryError::Absent.to_string(),
        "DSH home not found or empty"
    );
    assert_eq!(DshHistoryError::Timeout.to_string(), "DSH helper timed out");
    assert_eq!(
        DshHistoryError::OutputTooLarge.to_string(),
        "DSH helper output exceeded size limit"
    );
    assert_eq!(
        DshHistoryError::InvalidHome("x".into()).to_string(),
        "DSH_HOME is set but invalid: x"
    );
    assert_eq!(
        DshHistoryError::UnsupportedFormat("v9".into()).to_string(),
        "DSH unsupported format: v9"
    );
    assert_eq!(
        DshHistoryError::BusyCorrupt("locked".into()).to_string(),
        "DSH busy or corrupt: locked"
    );
}

#[test]
fn request_serialization() {
    let req = DshHistoryRequest::List {
        roots: vec!["/tmp/dsh".to_string()],
        limit: Some(100),
    };
    let json = serde_json::to_string(&req).unwrap();
    assert!(json.contains(r#""op":"list""#));
    assert!(json.contains(r#""roots":["/tmp/dsh"]"#));
    assert!(json.contains(r#""limit":100"#));
}

#[test]
fn response_deserialization_success() {
    let json =
        r#"{"ok":true,"schemaVersion":1,"dshVersion":"0.1.1-rc.2","data":[],"warnings":["test"]}"#;
    let resp: DshHistoryResponse<Vec<DshSessionListItem>> = serde_json::from_str(json).unwrap();
    match resp {
        DshHistoryResponse::Ok { warnings, data, .. } => {
            assert_eq!(warnings, vec!["test"]);
            assert!(data.is_empty());
        }
        _ => panic!("expected Ok variant"),
    }
}

#[test]
fn response_deserialization_error() {
    let json = r#"{"ok":false,"schemaVersion":1,"code":"SESSION_NOT_FOUND","message":"not found"}"#;
    let resp: DshHistoryResponse<Vec<DshSessionListItem>> = serde_json::from_str(json).unwrap();
    match resp {
        DshHistoryResponse::Err { code, message, .. } => {
            assert_eq!(code, "SESSION_NOT_FOUND");
            assert_eq!(message, "not found");
        }
        _ => panic!("expected Err variant"),
    }
}

#[test]
fn usage_entry_includes_seed_length() {
    let json = r#"{"ok":true,"schemaVersion":1,"dshVersion":"0.1.1-rc.2","data":[{"sourceInstanceId":"abc","sessionId":"s1","seedLength":7,"revision":null,"steps":[]}],"warnings":[]}"#;
    let resp: DshHistoryResponse<Vec<DshUsageEntry>> = serde_json::from_str(json).unwrap();
    match resp {
        DshHistoryResponse::Ok { data, .. } => {
            assert_eq!(data[0].seed_length, 7);
        }
        _ => panic!("expected Ok"),
    }
}

// --- Strict DTO validation: role enum + content array (Fix #5) ---

#[test]
fn dto_rejects_invalid_role() {
    // role must be "user" or "assistant" — "system" should fail
    let json = r#"{"seq":0,"type":"user/message","time":null,"role":"system","content":null,"model":null,"provider":null}"#;
    let result: Result<DshSurfaceEvent, _> = serde_json::from_str(json);
    assert!(result.is_err(), "invalid role 'system' must be rejected");

    // empty role
    let json2 = r#"{"seq":0,"type":"user/message","time":null,"role":"","content":null,"model":null,"provider":null}"#;
    let result2: Result<DshSurfaceEvent, _> = serde_json::from_str(json2);
    assert!(result2.is_err(), "empty role must be rejected");
}

#[test]
fn dto_rejects_non_array_content() {
    // content must be array or absent/null — not a string
    let json = r#"{"seq":0,"type":"user/message","time":null,"role":"user","content":"plain text","model":null,"provider":null}"#;
    let result: Result<DshSurfaceEvent, _> = serde_json::from_str(json);
    assert!(result.is_err(), "content as string must be rejected");

    // content as object
    let json2 = r#"{"seq":0,"type":"user/message","time":null,"role":"user","content":{"type":"text"},"model":null,"provider":null}"#;
    let result2: Result<DshSurfaceEvent, _> = serde_json::from_str(json2);
    assert!(result2.is_err(), "content as object must be rejected");
}

#[test]
fn dto_accepts_valid_surface_event() {
    // Valid: role=user, content=array
    let json = r#"{"seq":1,"type":"user/message","time":1000,"role":"user","content":[{"type":"text","text":"hi"}],"model":null,"provider":null}"#;
    let ev: DshSurfaceEvent = serde_json::from_str(json).unwrap();
    assert_eq!(ev.role, DshEventRole::User);
    assert!(ev.content.is_some());
    assert_eq!(ev.content.unwrap().len(), 1);

    // Valid: role=assistant, content=null
    let json2 = r#"{"seq":2,"type":"assistant/message","time":null,"role":"assistant","content":null,"model":"claude","provider":"anthropic"}"#;
    let ev2: DshSurfaceEvent = serde_json::from_str(json2).unwrap();
    assert_eq!(ev2.role, DshEventRole::Assistant);
    assert!(ev2.content.is_none());
}

/// Unit-test the allowlist builder: only HOME, PATH, TMPDIR, and __DSH_HISTORY_ROOTS
/// are emitted — regardless of what else is in the parent process environment.
#[test]
fn allowlist_builder_emits_only_known_keys() {
    let list = build_env_allowlist(r#"["/tmp"]"#);
    let keys: Vec<&str> = list.iter().map(|(k, _)| *k).collect();
    for key in &keys {
        assert!(
            *key == "HOME" || *key == "PATH" || *key == "TMPDIR" || *key == "__DSH_HISTORY_ROOTS",
            "unexpected key in allowlist: {:?}",
            key
        );
    }
    let roots_entry = list.iter().find(|(k, _)| *k == "__DSH_HISTORY_ROOTS");
    assert!(roots_entry.is_some(), "missing __DSH_HISTORY_ROOTS");
    assert_eq!(roots_entry.unwrap().1, r#"["/tmp"]"#);
}

#[test]
fn resolve_ccem_node_finds_binary_next_to_exe() {
    let tmp = tempfile::TempDir::new().unwrap();
    let sidecar_name = if cfg!(windows) {
        "ccem-node.exe"
    } else {
        "ccem-node"
    };
    let sidecar_path = tmp.path().join(sidecar_name);
    std::fs::write(&sidecar_path, b"fake-sidecar").unwrap();
    let fake_exe = tmp.path().join(if cfg!(windows) {
        "ccem-desktop.exe"
    } else {
        "ccem-desktop"
    });
    std::fs::write(&fake_exe, b"fake-exe").unwrap();
    let result = resolve_ccem_node_path_from_exe(Some(fake_exe));
    assert!(result.is_ok(), "expected Ok, got: {:?}", result);
    assert_eq!(result.unwrap(), sidecar_path);
}

#[test]
fn resolve_ccem_node_returns_error_when_missing() {
    let tmp = tempfile::TempDir::new().unwrap();
    let fake_exe = tmp.path().join("ccem-desktop");
    std::fs::write(&fake_exe, b"fake-exe").unwrap();
    let result = resolve_ccem_node_path_from_exe(Some(fake_exe));
    assert!(result.is_err());
    match result.unwrap_err() {
        DshHistoryError::HelperUnavailable(msg) => {
            assert!(
                msg.contains("ccem-node"),
                "msg should mention ccem-node: {}",
                msg
            );
        }
        other => panic!("expected HelperUnavailable, got: {:?}", other),
    }
}

#[test]
fn resolve_ccem_node_returns_error_when_exe_unknown() {
    let result = resolve_ccem_node_path_from_exe(None);
    assert!(result.is_err());
    match result.unwrap_err() {
        DshHistoryError::HelperUnavailable(msg) => {
            assert!(msg.contains("executable directory"), "msg: {}", msg);
        }
        other => panic!("expected HelperUnavailable, got: {:?}", other),
    }
}

// =============================================================================
// Production core invocation tests (Unix only — fake helpers use /bin/sh)
// These call invoke_helper_core directly with test-sized limits, exercising
// the SAME code path that production invoke_dsh_helper_blocking uses.
// =============================================================================

#[cfg(unix)]
mod unix_invocation {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// Test limits: small caps, short timeout — exercises production core fast.
    fn test_limits(timeout_ms: u64, stdout_cap: usize, stderr_cap: usize) -> InvocationLimits {
        InvocationLimits {
            timeout: Duration::from_millis(timeout_ms),
            max_stdout_bytes: stdout_cap,
            max_stderr_bytes: stderr_cap,
        }
    }

    /// Write an executable shell script as a fake helper.
    fn write_fake_helper(dir: &std::path::Path, name: &str, script: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, script).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    /// Read the PID file written by a fake helper. Panics if file missing or malformed —
    /// this is intentional so a missing PID file fails the test loudly.
    fn read_pid_file(path: &std::path::Path) -> u32 {
        let content = std::fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("PID file {:?} must exist: {}", path, e));
        content.trim().parse::<u32>().unwrap_or_else(|e| {
            panic!(
                "PID file {:?} must contain valid u32: {:?} ({})",
                path,
                content.trim(),
                e
            )
        })
    }

    /// Assert a PID no longer exists (reaped). Uses kill(pid, 0) → ESRCH.
    fn assert_pid_reaped(pid: u32) {
        std::thread::sleep(Duration::from_millis(50));
        let ret = unsafe { libc::kill(pid as i32, 0) };
        assert_eq!(
            ret, -1,
            "kill(pid={}, 0) returned 0 — process still alive!",
            pid
        );
        let err = std::io::Error::last_os_error();
        assert_eq!(
            err.raw_os_error(),
            Some(libc::ESRCH),
            "expected ESRCH for pid {}, got: {} ({})",
            pid,
            err.raw_os_error().unwrap_or(-1),
            err
        );
    }

    /// Poll until a PID no longer exists (ESRCH), with a bounded timeout.
    /// The test NEVER sends any signal — it only observes natural death.
    /// Panics if the PID is still alive after `max_wait`.
    fn wait_for_natural_exit(pid: u32, max_wait: Duration) {
        let start = Instant::now();
        loop {
            let ret = unsafe { libc::kill(pid as i32, 0) };
            if ret == -1 {
                let err = std::io::Error::last_os_error();
                if err.raw_os_error() == Some(libc::ESRCH) {
                    return; // confirmed dead
                }
            }
            if start.elapsed() > max_wait {
                panic!(
                    "PID {} still alive after {:?} — self-terminating fixture failed",
                    pid, max_wait
                );
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn stdout_overflow_kills_and_reaps() {
        let tmp = tempfile::TempDir::new().unwrap();
        let pid_file = tmp.path().join("pid");
        // exec yes replaces shell — production Child IS the writer PID, no descendant.
        let helper = write_fake_helper(
            tmp.path(),
            "big_stdout.sh",
            &format!(
                "#!/bin/sh\necho $$ > {}\ncat /dev/null > /dev/null\nexec yes AAAAAAAAAA\n",
                pid_file.to_str().unwrap()
            ),
        );
        let limits = test_limits(5000, 1024, 1024 * 1024);
        let start = Instant::now();
        let result = invoke_helper_core::<Vec<DshSessionListItem>>(
            helper,
            PathBuf::from("/bin/sh"),
            "{}".into(),
            "[]".into(),
            &limits,
        );
        let elapsed = start.elapsed();
        assert!(
            matches!(result, Err(DshHistoryError::OutputTooLarge)),
            "expected OutputTooLarge, got: {:?}",
            result
        );
        assert!(
            elapsed < Duration::from_secs(2),
            "took {:?}, expected < 2s",
            elapsed
        );
        let pid = read_pid_file(&pid_file);
        assert_pid_reaped(pid);
    }

    #[test]
    fn stderr_overflow_kills_and_reaps() {
        let tmp = tempfile::TempDir::new().unwrap();
        let pid_file = tmp.path().join("pid");
        let helper = write_fake_helper(tmp.path(), "big_stderr.sh", &format!(
            "#!/bin/sh\necho $$ > {}\ncat /dev/null > /dev/null\nwhile true; do echo EEEE >&2; done\n",
            pid_file.to_str().unwrap()
        ));
        let limits = test_limits(5000, 64 * 1024 * 1024, 512);
        let start = Instant::now();
        let result = invoke_helper_core::<Vec<DshSessionListItem>>(
            helper,
            PathBuf::from("/bin/sh"),
            "{}".into(),
            "[]".into(),
            &limits,
        );
        let elapsed = start.elapsed();
        assert!(
            matches!(result, Err(DshHistoryError::OutputTooLarge)),
            "expected OutputTooLarge, got: {:?}",
            result
        );
        assert!(
            elapsed < Duration::from_secs(2),
            "took {:?}, expected < 2s",
            elapsed
        );
        let pid = read_pid_file(&pid_file);
        assert_pid_reaped(pid);
    }

    #[test]
    fn timeout_kills_and_reaps_with_pid_evidence() {
        let tmp = tempfile::TempDir::new().unwrap();
        let pid_file = tmp.path().join("pid");
        // exec replaces shell so only one PID; the 30s sleep gets killed at 200ms
        let helper = write_fake_helper(
            tmp.path(),
            "sleeper.sh",
            &format!(
                "#!/bin/sh\necho $$ > {}\ncat /dev/null > /dev/null\nexec sleep 30\n",
                pid_file.to_str().unwrap()
            ),
        );
        let limits = test_limits(200, 64 * 1024 * 1024, 1024 * 1024);
        let start = Instant::now();
        let result = invoke_helper_core::<Vec<DshSessionListItem>>(
            helper,
            PathBuf::from("/bin/sh"),
            "{}".into(),
            "[]".into(),
            &limits,
        );
        let elapsed = start.elapsed();
        assert!(
            matches!(result, Err(DshHistoryError::Timeout)),
            "expected Timeout, got: {:?}",
            result
        );
        assert!(
            elapsed < Duration::from_secs(1),
            "took {:?}, expected < 1s",
            elapsed
        );
        let pid = read_pid_file(&pid_file);
        assert_pid_reaped(pid);
    }

    #[test]
    fn timeout_nonreading_child_large_stdin() {
        let tmp = tempfile::TempDir::new().unwrap();
        let pid_file = tmp.path().join("pid");
        // Child: writes PID, then exec sleep 30 WITHOUT reading stdin
        let helper = write_fake_helper(
            tmp.path(),
            "noreader.sh",
            &format!(
                "#!/bin/sh\necho $$ > {}\nexec sleep 30\n",
                pid_file.to_str().unwrap()
            ),
        );
        let limits = test_limits(500, 64 * 1024 * 1024, 1024 * 1024);
        let big_stdin = "X".repeat(2 * 1024 * 1024);
        let start = Instant::now();
        let result = invoke_helper_core::<Vec<DshSessionListItem>>(
            helper,
            PathBuf::from("/bin/sh"),
            big_stdin,
            "[]".into(),
            &limits,
        );
        let elapsed = start.elapsed();
        assert!(
            matches!(result, Err(DshHistoryError::Timeout)),
            "expected Timeout, got: {:?}",
            result
        );
        assert!(
            elapsed < Duration::from_secs(2),
            "took {:?}, expected < 2s",
            elapsed
        );
        let pid = read_pid_file(&pid_file);
        assert_pid_reaped(pid);
    }

    /// Descendant inherits stdout/stderr FDs via pipe inheritance:
    /// production must return WITHOUT waiting for the descendant's EOF.
    /// Fixture: descendant is a short-TTL (~2s) `exec sleep 2` that self-terminates.
    /// Test NEVER signals the descendant — only polls kill(pid,0) for ESRCH.
    #[test]
    fn descendant_inherits_pipes_does_not_block() {
        let tmp = tempfile::TempDir::new().unwrap();
        let descendant_pid_file = tmp.path().join("descendant_pid");

        // Descendant: holds stdout/stderr open via inheritance, self-terminates in ~2s.
        // `exec sleep 2` replaces the subshell so only one PID is recorded.
        let helper = write_fake_helper(
            tmp.path(),
            "descendant.sh",
            &format!(
                r#"#!/bin/sh
# Descendant: holds inherited FDs open, self-terminates in 2s
(exec sleep 2) &
echo $! > {desc_pid}
# Read and discard stdin, then emit valid JSON
cat > /dev/null
printf '{{"ok":true,"schemaVersion":1,"dshVersion":"0.1.1-rc.2","data":[],"warnings":[]}}'
exit 0
"#,
                desc_pid = descendant_pid_file.to_str().unwrap(),
            ),
        );
        let limits = test_limits(3000, 64 * 1024 * 1024, 1024 * 1024);
        let start = Instant::now();
        let result = invoke_helper_core::<Vec<DshSessionListItem>>(
            helper,
            PathBuf::from("/bin/sh"),
            "{}".into(),
            "[]".into(),
            &limits,
        );
        let elapsed = start.elapsed();
        assert!(result.is_ok(), "expected Ok, got: {:?}", result);
        assert!(
            elapsed < Duration::from_secs(1),
            "took {:?} — production must not wait for descendant's sleep",
            elapsed
        );
        let desc_pid = read_pid_file(&descendant_pid_file);
        assert!(desc_pid > 0, "descendant PID must be > 0");
        // Wait for natural self-termination (TTL ~2s), never signal
        wait_for_natural_exit(desc_pid, Duration::from_secs(5));
    }

    /// Descendant continuously writes to inherited stderr FDs.
    /// Production core must return promptly without waiting for descendant EOF.
    /// Fixture: a self-terminating writer that does a bounded number of writes
    /// (~2s total via small sleeps), then exits naturally. No supervisor kill.
    /// Test NEVER signals any descendant — only polls kill(pid,0) for ESRCH.
    #[test]
    fn descendant_continuously_writes_returns_promptly() {
        let tmp = tempfile::TempDir::new().unwrap();
        let writer_pid_file = tmp.path().join("writer_pid");

        // Writer: does ~40 iterations of write+sleep(50ms) ≈ 2s total, then exits.
        // Self-terminating, no external kill needed. Holds stderr FD open via inheritance.
        let helper = write_fake_helper(
            tmp.path(),
            "desc_writer.sh",
            &format!(
                r#"#!/bin/sh
# Self-terminating writer: bounded iterations, natural exit after ~2s
(
  I=0
  while [ $I -lt 40 ]; do
    printf 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX\n' >&2
    sleep 0.05
    I=$((I + 1))
  done
) &
WRITER_PID=$!
echo $WRITER_PID > {wpid}
# Read stdin, emit valid JSON, exit
cat > /dev/null
printf '{{"ok":true,"schemaVersion":1,"dshVersion":"0.1.1-rc.2","data":[],"warnings":[]}}'
exit 0
"#,
                wpid = writer_pid_file.to_str().unwrap(),
            ),
        );
        let limits = test_limits(3000, 64 * 1024 * 1024, 1024 * 1024);
        let start = Instant::now();
        let result = invoke_helper_core::<Vec<DshSessionListItem>>(
            helper,
            PathBuf::from("/bin/sh"),
            "{}".into(),
            "[]".into(),
            &limits,
        );
        let elapsed = start.elapsed();
        assert!(result.is_ok(), "expected Ok, got: {:?}", result);
        assert!(
            elapsed < Duration::from_secs(1),
            "took {:?} — blocked on descendant writes",
            elapsed
        );
        let writer_pid = read_pid_file(&writer_pid_file);
        // Wait for writer natural death (self-terminates after ~2s)
        wait_for_natural_exit(writer_pid, Duration::from_secs(5));
    }

    #[test]
    fn child_closes_stdin_remains_live_gives_helper_failed() {
        let tmp = tempfile::TempDir::new().unwrap();
        let pid_file = tmp.path().join("pid");
        // exec replaces shell: close stdin, then become sleep — single process, no child.
        let helper = write_fake_helper(
            tmp.path(),
            "close_stdin_live.sh",
            &format!(
                "#!/bin/sh\necho $$ > {}\nexec 0<&-\nexec sleep 2\n",
                pid_file.to_str().unwrap()
            ),
        );
        let limits = test_limits(5000, 64 * 1024 * 1024, 1024 * 1024);
        let big_payload = "x".repeat(2 * 1024 * 1024);
        let start = Instant::now();
        let result = invoke_helper_core::<Vec<DshSessionListItem>>(
            helper,
            PathBuf::from("/bin/sh"),
            big_payload,
            "[]".into(),
            &limits,
        );
        let elapsed = start.elapsed();
        match &result {
            Err(DshHistoryError::HelperFailed(msg)) => {
                // Must specifically report stdin write failure (broken pipe to closed fd)
                assert!(
                    msg.contains("stdin write failed"),
                    "expected 'stdin write failed' in error message, got: {}",
                    msg
                );
            }
            other => panic!(
                "expected HelperFailed with stdin write failure, got: {:?}",
                other
            ),
        }
        assert!(
            elapsed < Duration::from_secs(3),
            "took {:?} — should fail fast, not timeout",
            elapsed
        );
        let pid = read_pid_file(&pid_file);
        assert_pid_reaped(pid);
    }

    #[test]
    fn stdin_write_failure_reports_specific_path_and_reaps() {
        let tmp = tempfile::TempDir::new().unwrap();
        let pid_file = tmp.path().join("pid");
        // exec replaces shell: close stdin, then become sleep — single process, no child.
        let helper = write_fake_helper(
            tmp.path(),
            "stdin_reject.sh",
            &format!(
                "#!/bin/sh\necho $$ > {}\nexec 0<&-\nexec sleep 2\n",
                pid_file.to_str().unwrap()
            ),
        );
        let limits = test_limits(5000, 64 * 1024 * 1024, 1024 * 1024);
        let big_payload = "x".repeat(2 * 1024 * 1024);
        let result = invoke_helper_core::<Vec<DshSessionListItem>>(
            helper,
            PathBuf::from("/bin/sh"),
            big_payload,
            "[]".into(),
            &limits,
        );
        match &result {
            Err(DshHistoryError::HelperFailed(msg)) => {
                // Must specifically report stdin write failure path
                assert!(
                    msg.contains("stdin write failed"),
                    "expected 'stdin write failed' in error, got: {}",
                    msg
                );
            }
            other => panic!(
                "expected HelperFailed with stdin write failure, got: {:?}",
                other
            ),
        }
        let pid = read_pid_file(&pid_file);
        assert_pid_reaped(pid);
    }

    #[test]
    fn fast_exit_valid_stdout_stderr_overflow_gives_output_too_large() {
        let tmp = tempfile::TempDir::new().unwrap();
        let helper = write_fake_helper(
            tmp.path(),
            "stderr_flood.sh",
            r#"#!/bin/sh
cat > /dev/null
printf '{"ok":true,"schemaVersion":1,"dshVersion":"0.1.1-rc.2","data":[],"warnings":[]}'
# Write >512 bytes to stderr
dd if=/dev/zero bs=1024 count=2 2>/dev/null | tr '\0' 'E' >&2
exit 0
"#,
        );
        let limits = test_limits(5000, 64 * 1024 * 1024, 512);
        let result = invoke_helper_core::<Vec<DshSessionListItem>>(
            helper,
            PathBuf::from("/bin/sh"),
            "{}".into(),
            "[]".into(),
            &limits,
        );
        assert!(
            matches!(result, Err(DshHistoryError::OutputTooLarge)),
            "expected OutputTooLarge, got: {:?}",
            result
        );
    }

    /// Env isolation test: uses a harmless, non-allowlisted marker variable.
    /// Verifies env_clear blocks it while allowlisted vars pass through.
    /// Uses static mutex + RAII for parallel/panic safety.
    #[test]
    fn env_clear_blocks_non_allowlisted_vars() {
        let _lock = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::TempDir::new().unwrap();
        let helper = write_fake_helper(
            tmp.path(),
            "env_dump.sh",
            r#"#!/bin/sh
cat > /dev/null
ENV_LINES=$(env | sort | sed 's/"/\\"/g' | awk '{printf "\"%s\",", $0}')
printf '{"ok":true,"schemaVersion":1,"dshVersion":"0.1.1-rc.2","data":[],"warnings":[%s"__END__"]}' "$ENV_LINES"
"#,
        );
        let limits = test_limits(5000, 64 * 1024 * 1024, 1024 * 1024);
        let marker = "__DSH_TEST_MARKER_7f3a2b";
        let marker_val = "SHOULD_NOT_APPEAR_IN_CHILD";
        let _g = EnvGuard::set(marker, marker_val);

        let result = invoke_helper_core::<Vec<serde_json::Value>>(
            helper,
            PathBuf::from("/bin/sh"),
            "{}".into(),
            r#"["test-root"]"#.into(),
            &limits,
        );
        let (_, warnings) = result.expect("env_clear test must return Ok");
        let all = warnings.join("\n");
        assert!(
            !all.contains(marker_val),
            "non-allowlisted marker leaked: found {:?} in child env",
            marker_val
        );
        assert!(
            !all.contains(marker),
            "non-allowlisted key leaked: found {:?} in child env",
            marker
        );
        assert!(
            all.contains("__DSH_HISTORY_ROOTS="),
            "allowlisted __DSH_HISTORY_ROOTS missing from child env"
        );
        assert!(
            all.contains("test-root"),
            "roots value missing from child env"
        );
        if std::env::var("HOME").is_ok() {
            assert!(
                all.contains("HOME="),
                "allowlisted HOME missing from child env"
            );
        }
    }

    #[test]
    fn valid_json_response_parses_through_production_core() {
        let tmp = tempfile::TempDir::new().unwrap();
        let helper = write_fake_helper(tmp.path(), "valid_response.sh",
            "#!/bin/sh\ncat > /dev/null\nprintf '{\"ok\":true,\"schemaVersion\":1,\"dshVersion\":\"0.1.1-rc.2\",\"data\":[],\"warnings\":[\"hello\"]}'\n"
        );
        let limits = test_limits(5000, 64 * 1024 * 1024, 1024 * 1024);
        let result = invoke_helper_core::<Vec<DshSessionListItem>>(
            helper,
            PathBuf::from("/bin/sh"),
            r#"{"op":"list","roots":[]}"#.into(),
            "[]".into(),
            &limits,
        );
        let (data, warnings) = result.expect("valid response must parse");
        assert!(data.is_empty());
        assert_eq!(warnings, vec!["hello"]);
    }

    #[test]
    fn production_wrapper_uses_production_constants() {
        let prod = InvocationLimits::production();
        assert_eq!(prod.timeout, DSH_HELPER_TIMEOUT);
        assert_eq!(prod.max_stdout_bytes, DSH_HELPER_MAX_STDOUT_BYTES);
        assert_eq!(prod.max_stderr_bytes, DSH_HELPER_MAX_STDERR_BYTES);
        assert_eq!(DSH_HELPER_TIMEOUT, Duration::from_secs(30));
        assert_eq!(DSH_HELPER_MAX_STDOUT_BYTES, 64 * 1024 * 1024);
        assert_eq!(DSH_HELPER_MAX_STDERR_BYTES, 1024 * 1024);
    }
}
