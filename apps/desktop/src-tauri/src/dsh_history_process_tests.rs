//! Process lifecycle and envelope tests for dsh_history.
//! Split from dsh_history_tests.rs to stay under the 1000-line gate.
//! Included via `#[path = "dsh_history_process_tests.rs"] mod process_tests;`.

use super::*;

// =============================================================================
// Envelope validation and error mapping tests (cross-platform via subprocess)
// =============================================================================

#[cfg(unix)]
mod envelope_validation {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn test_limits() -> InvocationLimits {
        InvocationLimits {
            timeout: Duration::from_secs(5),
            max_stdout_bytes: 64 * 1024 * 1024,
            max_stderr_bytes: 1024 * 1024,
        }
    }

    fn write_json_helper(dir: &std::path::Path, name: &str, json: &str) -> PathBuf {
        let script = format!(
            "#!/bin/sh\ncat > /dev/null\ncat << 'ENDJSON'\n{}\nENDJSON\n",
            json
        );
        let p = dir.join(name);
        std::fs::write(&p, script).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    fn invoke_json<T: for<'de> serde::Deserialize<'de>>(
        json: &str,
        label: &str,
    ) -> Result<(T, Vec<String>), DshHistoryError> {
        let tmp = tempfile::TempDir::new().unwrap();
        let helper = write_json_helper(tmp.path(), &format!("{}.sh", label), json);
        process::invoke_helper_core::<T>(
            helper,
            PathBuf::from("/bin/sh"),
            "{}".into(),
            "[]".into(),
            &test_limits(),
        )
    }

    #[test]
    fn rejects_ok_false_in_success_variant() {
        let json =
            r#"{"ok":false,"schemaVersion":1,"dshVersion":"0.1.1-rc.2","data":[],"warnings":[]}"#;
        let result = invoke_json::<Vec<serde_json::Value>>(json, "ok-false-succ");
        match result {
            Err(DshHistoryError::HelperFailed(msg)) => {
                assert!(msg.contains("ok=false in success variant"), "got: {}", msg);
            }
            other => panic!(
                "expected HelperFailed with 'ok=false in success variant', got: {:?}",
                other
            ),
        }
    }

    #[test]
    fn rejects_ok_true_in_error_variant() {
        let json = r#"{"ok":true,"schemaVersion":1,"code":"SOME_ERROR","message":"bad"}"#;
        let result = invoke_json::<Vec<serde_json::Value>>(json, "ok-true-err");
        match result {
            Err(DshHistoryError::HelperFailed(msg)) => {
                assert!(msg.contains("ok=true in error variant"), "got: {}", msg);
            }
            other => panic!(
                "expected HelperFailed with 'ok=true in error variant', got: {:?}",
                other
            ),
        }
    }

    #[test]
    fn rejects_wrong_schema_version_on_success() {
        let json =
            r#"{"ok":true,"schemaVersion":2,"dshVersion":"0.1.1-rc.2","data":[],"warnings":[]}"#;
        let result = invoke_json::<Vec<serde_json::Value>>(json, "schema-v2-succ");
        match result {
            Err(DshHistoryError::HelperFailed(msg)) => {
                assert!(msg.contains("schemaVersion"), "got: {}", msg);
            }
            other => panic!("expected HelperFailed for wrong schema, got: {:?}", other),
        }
    }

    #[test]
    fn rejects_wrong_schema_version_on_error() {
        let json = r#"{"ok":false,"schemaVersion":99,"code":"FOO","message":"bar"}"#;
        let result = invoke_json::<Vec<serde_json::Value>>(json, "schema-v99-err");
        match result {
            Err(DshHistoryError::HelperFailed(msg)) => {
                assert!(msg.contains("schemaVersion"), "got: {}", msg);
            }
            other => panic!(
                "expected HelperFailed for wrong error schema, got: {:?}",
                other
            ),
        }
    }

    #[test]
    fn rejects_wrong_dsh_version() {
        let json = r#"{"ok":true,"schemaVersion":1,"dshVersion":"0.2.0","data":[],"warnings":[]}"#;
        let result = invoke_json::<Vec<serde_json::Value>>(json, "dsh-v020");
        match result {
            Err(DshHistoryError::HelperFailed(msg)) => {
                assert!(msg.contains("dshVersion"), "got: {}", msg);
                assert!(msg.contains("0.2.0"), "got: {}", msg);
            }
            other => panic!(
                "expected HelperFailed for wrong dshVersion, got: {:?}",
                other
            ),
        }
    }

    #[test]
    fn maps_unsupported_format_code_to_typed_error() {
        let json = r#"{"ok":false,"schemaVersion":1,"code":"UNSUPPORTED_FORMAT","message":"session v99 not supported"}"#;
        let result = invoke_json::<Vec<serde_json::Value>>(json, "unsup-fmt");
        match result {
            Err(DshHistoryError::UnsupportedFormat(msg)) => {
                assert_eq!(msg, "session v99 not supported");
            }
            other => panic!("expected UnsupportedFormat, got: {:?}", other),
        }
    }

    #[test]
    fn maps_busy_corrupt_code_to_typed_error() {
        let json = r#"{"ok":false,"schemaVersion":1,"code":"BUSY_CORRUPT","message":"lockfile held by pid 12345"}"#;
        let result = invoke_json::<Vec<serde_json::Value>>(json, "busy-corrupt");
        match result {
            Err(DshHistoryError::BusyCorrupt(msg)) => {
                assert_eq!(msg, "lockfile held by pid 12345");
            }
            other => panic!("expected BusyCorrupt, got: {:?}", other),
        }
    }

    #[test]
    fn maps_unknown_error_code_to_source_error() {
        let json = r#"{"ok":false,"schemaVersion":1,"code":"SESSION_NOT_FOUND","message":"no such session"}"#;
        let result = invoke_json::<Vec<serde_json::Value>>(json, "sess-not-found");
        match result {
            Err(DshHistoryError::SourceError { code, message }) => {
                assert_eq!(code, "SESSION_NOT_FOUND");
                assert_eq!(message, "no such session");
            }
            other => panic!("expected SourceError, got: {:?}", other),
        }
    }

    #[test]
    fn valid_envelope_succeeds() {
        let json = r#"{"ok":true,"schemaVersion":1,"dshVersion":"0.1.1-rc.2","data":[],"warnings":["w1"]}"#;
        let result = invoke_json::<Vec<serde_json::Value>>(json, "valid-env");
        let (data, warnings) = result.expect("valid envelope must succeed");
        assert!(data.is_empty());
        assert_eq!(warnings, vec!["w1"]);
    }

    #[test]
    fn envelope_mismatch_returns_exact_helper_failed() {
        let tmp = tempfile::TempDir::new().unwrap();
        let helper = write_json_helper(tmp.path(), "garbage.sh", "not json");
        let result = process::invoke_helper_core::<Vec<serde_json::Value>>(
            helper,
            PathBuf::from("/bin/sh"),
            "{}".into(),
            "[]".into(),
            &test_limits(),
        );
        match result {
            Err(DshHistoryError::HelperFailed(msg)) => {
                assert!(
                    msg.contains("invalid JSON"),
                    "expected 'invalid JSON', got: {}",
                    msg
                );
            }
            other => panic!("expected HelperFailed for garbage JSON, got: {:?}", other),
        }
    }
}

// =============================================================================
// Production PeekResult classifier (cross-platform, no subprocess)
// =============================================================================

mod peek_classifier_host {
    use super::super::process::{
        classify_peek_result, PeekResult, WIN_ERROR_BROKEN_PIPE, WIN_ERROR_NO_DATA,
        WIN_ERROR_PIPE_NOT_CONNECTED,
    };

    #[test]
    fn success_zero_is_pending() {
        assert_eq!(
            classify_peek_result(true, 0, 0).unwrap(),
            PeekResult::Pending
        );
    }

    #[test]
    fn success_positive_is_available() {
        assert_eq!(
            classify_peek_result(true, 42, 0).unwrap(),
            PeekResult::Available(42)
        );
    }

    #[test]
    fn success_large_available() {
        assert_eq!(
            classify_peek_result(true, 1_000_000, 0).unwrap(),
            PeekResult::Available(1_000_000)
        );
    }

    #[test]
    fn broken_pipe_is_eof() {
        assert_eq!(WIN_ERROR_BROKEN_PIPE, 109);
        assert_eq!(
            classify_peek_result(false, 0, WIN_ERROR_BROKEN_PIPE).unwrap(),
            PeekResult::Eof
        );
    }

    #[test]
    fn no_data_is_eof() {
        assert_eq!(WIN_ERROR_NO_DATA, 232);
        assert_eq!(
            classify_peek_result(false, 0, WIN_ERROR_NO_DATA).unwrap(),
            PeekResult::Eof
        );
    }

    #[test]
    fn not_connected_is_eof() {
        assert_eq!(WIN_ERROR_PIPE_NOT_CONNECTED, 233);
        assert_eq!(
            classify_peek_result(false, 0, WIN_ERROR_PIPE_NOT_CONNECTED).unwrap(),
            PeekResult::Eof
        );
    }

    #[test]
    fn unknown_error_is_err_preserving_raw_code() {
        let result = classify_peek_result(false, 0, 9999);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().raw_os_error(), Some(9999i32));
    }

    #[test]
    fn another_unknown_error_code() {
        let result = classify_peek_result(false, 0, 5);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().raw_os_error(), Some(5i32));
    }
}

// =============================================================================
// Windows-only: real pipe I/O tests with strict assertions
// =============================================================================

#[cfg(windows)]
mod peek_result_windows_pipes {
    use super::super::lifecycle::kill_and_reap;
    use super::super::process::{win_peek, PeekResult};
    use super::*;
    use std::os::windows::io::AsRawHandle;
    use std::process::{Command, Stdio};

    /// Bounded try_wait poll — never calls unbounded wait().
    /// On timeout, calls production kill_and_reap and panics.
    fn bounded_wait_for_exit(child: &mut std::process::Child, max_wait: Duration) {
        let start = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => {
                    if start.elapsed() >= max_wait {
                        let cleanup = kill_and_reap(child);
                        panic!(
                            "child did not exit within {:?} (cleanup: {:?})",
                            max_wait, cleanup
                        );
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(e) => {
                    let cleanup = kill_and_reap(child);
                    panic!("try_wait error: {} (cleanup: {:?})", e, cleanup);
                }
            }
        }
    }

    #[test]
    fn open_empty_pipe_is_pending() {
        // cmd /Q /D /C "set /p X=" blocks on stdin read — stdout open but empty
        let mut child = Command::new("cmd")
            .args(&["/Q", "/D", "/C", "set /p X="])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdout = child.stdout.as_ref().unwrap();
        let handle = stdout.as_raw_handle();
        let result = win_peek(handle).unwrap();
        // Cleanup BEFORE assertion so child doesn't leak on failure
        let cleanup = kill_and_reap(&mut child);
        assert_eq!(
            result,
            PeekResult::Pending,
            "open pipe with no data must be Pending, got: {:?}",
            result
        );
        assert!(cleanup.is_ok(), "cleanup failed: {:?}", cleanup);
    }

    #[test]
    fn child_writes_then_exits_available_then_eof() {
        // echo is a cmd builtin, no descendant spawned
        let mut child = Command::new("cmd")
            .args(&["/Q", "/D", "/C", "echo TESTDATA"])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        // Bounded wait for natural exit
        bounded_wait_for_exit(&mut child, Duration::from_secs(5));

        let stdout = child.stdout.as_ref().unwrap();
        let handle = stdout.as_raw_handle();

        // First peek: must be Available(n > 0)
        let first = win_peek(handle).unwrap();
        assert!(
            matches!(first, PeekResult::Available(n) if n > 0),
            "expected Available(n>0) after child wrote and exited, got: {:?}",
            first
        );

        // Read exact available bytes — do not ignore the read result
        if let PeekResult::Available(n) = first {
            use std::io::Read;
            let mut buf = vec![0u8; n as usize];
            let stdout_mut = child.stdout.as_mut().unwrap();
            let bytes_read = stdout_mut
                .read(&mut buf)
                .expect("read after Available must succeed");
            assert!(bytes_read > 0, "read returned 0 despite Available({})", n);
        }

        // Bounded poll for Eof
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let stdout = child.stdout.as_ref().unwrap();
            let handle = stdout.as_raw_handle();
            let result = win_peek(handle).unwrap();
            if result == PeekResult::Eof {
                break;
            }
            if let PeekResult::Available(n) = result {
                use std::io::Read;
                let mut buf = vec![0u8; n as usize];
                let stdout_mut = child.stdout.as_mut().unwrap();
                stdout_mut
                    .read(&mut buf)
                    .expect("draining Available must succeed");
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for Eof, stuck at: {:?}",
                result
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

// =============================================================================
// Production lifecycle seam tests — calls the SAME kill_and_reap_with_deadline
// from dsh_history_lifecycle.rs. No algorithm duplication.
// =============================================================================

mod lifecycle_seam {
    use super::super::lifecycle::{
        cleanup_with_context, kill_and_reap, kill_and_reap_with_deadline, ChildLifecycle,
    };
    use super::*;

    // --- Production kill_and_reap with real children (unix) ---

    #[cfg(unix)]
    #[test]
    fn kill_and_reap_already_exited_returns_ok() {
        use std::process::{Command, Stdio};
        let mut child = Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        // Bounded poll until exited (exit 0 is instant)
        let start = Instant::now();
        loop {
            match child.try_wait().unwrap() {
                Some(_) => break,
                None => {
                    assert!(start.elapsed() < Duration::from_secs(2), "exit 0 hung");
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
        }
        let result = kill_and_reap(&mut child);
        assert!(result.is_ok(), "already-exited: {:?}", result);
    }

    #[cfg(unix)]
    #[test]
    fn kill_and_reap_running_child_succeeds() {
        use std::process::{Command, Stdio};
        let mut child = Command::new("/bin/sh")
            .args(["-c", "exec sleep 60"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        let result = kill_and_reap(&mut child);
        assert!(result.is_ok(), "running child: {:?}", result);
        let ret = unsafe { libc::kill(pid as i32, 0) };
        assert_eq!(ret, -1, "PID {} still alive", pid);
    }

    #[cfg(unix)]
    #[test]
    fn kill_race_detected_by_second_try_reap() {
        use std::process::{Command, Stdio};
        let mut child = Command::new("/bin/sh")
            .args(["-c", "sleep 0.05"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(100));
        let result = kill_and_reap(&mut child);
        assert!(result.is_ok(), "kill-race: {:?}", result);
    }

    // --- Mock child calling the PRODUCTION generic seam directly ---

    struct MockChild {
        reap_responses: Vec<std::io::Result<bool>>,
        kill_responses: Vec<std::io::Result<()>>,
        reap_idx: usize,
        kill_idx: usize,
        mock_pid: u32,
    }

    impl MockChild {
        fn new(reaps: Vec<std::io::Result<bool>>, kills: Vec<std::io::Result<()>>) -> Self {
            Self {
                reap_responses: reaps,
                kill_responses: kills,
                reap_idx: 0,
                kill_idx: 0,
                mock_pid: 99999,
            }
        }
    }

    impl ChildLifecycle for MockChild {
        fn try_reap(&mut self) -> std::io::Result<bool> {
            let idx = self.reap_idx;
            self.reap_idx += 1;
            if idx < self.reap_responses.len() {
                match &self.reap_responses[idx] {
                    Ok(v) => Ok(*v),
                    Err(e) => Err(std::io::Error::new(e.kind(), e.to_string())),
                }
            } else {
                Ok(true) // default: reaped (prevents infinite loop)
            }
        }
        fn kill_exact(&mut self) -> std::io::Result<()> {
            let idx = self.kill_idx;
            self.kill_idx += 1;
            if idx < self.kill_responses.len() {
                match &self.kill_responses[idx] {
                    Ok(()) => Ok(()),
                    Err(e) => Err(std::io::Error::new(e.kind(), e.to_string())),
                }
            } else {
                Ok(())
            }
        }
        fn pid(&self) -> u32 {
            self.mock_pid
        }
    }

    #[test]
    fn seam_already_exited() {
        let mut mock = MockChild::new(vec![Ok(true)], vec![]);
        let r = kill_and_reap_with_deadline(
            &mut mock,
            Duration::from_millis(100),
            Duration::from_millis(1),
        );
        assert!(r.is_ok());
    }

    #[test]
    fn seam_kill_success_eventual_reap() {
        let mut mock = MockChild::new(vec![Ok(false), Ok(false), Ok(true)], vec![Ok(())]);
        let r = kill_and_reap_with_deadline(
            &mut mock,
            Duration::from_secs(1),
            Duration::from_millis(1),
        );
        assert!(r.is_ok());
    }

    #[test]
    fn seam_kill_success_never_reaps_timeout() {
        let many_false: Vec<std::io::Result<bool>> = (0..50).map(|_| Ok(false)).collect();
        let mut mock = MockChild::new(many_false, vec![Ok(())]);
        let r = kill_and_reap_with_deadline(
            &mut mock,
            Duration::from_millis(20),
            Duration::from_millis(1),
        );
        assert!(r.is_err());
        assert_eq!(r.unwrap_err().kind(), std::io::ErrorKind::TimedOut);
    }

    #[test]
    fn seam_kill_race_proven_by_second_try_reap() {
        let mut mock = MockChild::new(
            vec![Ok(false), Ok(true)],
            vec![Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "no such process",
            ))],
        );
        let r = kill_and_reap_with_deadline(
            &mut mock,
            Duration::from_millis(100),
            Duration::from_millis(1),
        );
        assert!(r.is_ok());
    }

    #[test]
    fn seam_kill_failed_still_live_returns_error() {
        let mut mock = MockChild::new(
            vec![Ok(false), Ok(false)],
            vec![Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "EPERM",
            ))],
        );
        let r = kill_and_reap_with_deadline(
            &mut mock,
            Duration::from_millis(100),
            Duration::from_millis(1),
        );
        assert!(r.is_err());
        let err = r.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
        assert!(err.to_string().contains("EPERM"));
    }

    #[test]
    fn seam_initial_try_reap_error_propagated() {
        let mut mock = MockChild::new(
            vec![Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                "waitpid EIO",
            ))],
            vec![],
        );
        let r = kill_and_reap_with_deadline(
            &mut mock,
            Duration::from_millis(100),
            Duration::from_millis(1),
        );
        assert!(r.is_err());
        assert!(r.unwrap_err().to_string().contains("waitpid EIO"));
    }

    #[test]
    fn seam_reap_error_during_poll_propagated() {
        let mut mock = MockChild::new(
            vec![
                Ok(false),
                Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "wait ECHILD",
                )),
            ],
            vec![Ok(())],
        );
        let r = kill_and_reap_with_deadline(
            &mut mock,
            Duration::from_secs(1),
            Duration::from_millis(1),
        );
        assert!(r.is_err());
        assert!(r.unwrap_err().to_string().contains("wait ECHILD"));
    }

    // --- cleanup_with_context production seam tests ---

    #[test]
    fn cleanup_success_produces_empty_context() {
        let mut mock = MockChild::new(vec![Ok(true)], vec![]);
        let ctx = cleanup_with_context(&mut mock);
        assert!(ctx.is_empty());
    }

    #[test]
    fn cleanup_failure_contains_pid_and_error() {
        // kill fails + still live → error propagated into context string
        let mut mock = MockChild::new(
            vec![Ok(false), Ok(false)],
            vec![Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "EPERM",
            ))],
        );
        let ctx = cleanup_with_context(&mut mock);
        assert!(ctx.contains("99999"), "must contain PID, got: {}", ctx);
        assert!(ctx.contains("EPERM"), "must contain error, got: {}", ctx);
        assert!(
            ctx.contains("cleanup"),
            "must mention cleanup, got: {}",
            ctx
        );
    }

    #[test]
    fn cleanup_timeout_contains_pid() {
        // Use kill_and_reap_with_deadline directly with a very short deadline
        // to trigger timeout without needing thousands of mock entries.
        let many_false: Vec<std::io::Result<bool>> = (0..100).map(|_| Ok(false)).collect();
        let mut mock = MockChild::new(many_false, vec![Ok(())]);
        mock.mock_pid = 42;
        let result = kill_and_reap_with_deadline(
            &mut mock,
            Duration::from_millis(10),
            Duration::from_millis(1),
        );
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
        // Verify the error message contains the PID
        assert!(
            err.to_string().contains("42"),
            "must contain PID, got: {}",
            err
        );
    }
}
