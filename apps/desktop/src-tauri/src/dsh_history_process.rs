//! Subprocess lifecycle and nonblocking I/O state machine for DSH history adapter.
//!
//! Split from `dsh_history.rs` to keep both modules under 1000 lines.
//! Contains: platform pipe helpers (Unix fcntl/Windows PIPE_NOWAIT+PeekNamedPipe),
//! Bounded drain, and the core
//! invoke_helper_core state machine.

use super::lifecycle::{cleanup_with_context, kill_and_reap};
use super::{DshHistoryError, DshHistoryResponse, InvocationLimits, DSH_EXPECTED_VERSION};
use serde::Deserialize;
use std::path::PathBuf;
use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// Maximum bytes to read/write per loop iteration per pipe.
const IO_CHUNK_SIZE: usize = 32 * 1024;

/// Maximum number of drain iterations after child exit (prevents infinite loop
/// when a descendant continuously writes to inherited pipe handles).
const POST_EXIT_DRAIN_MAX_CHUNKS: usize = 8;

// ---------------------------------------------------------------------------
// Windows pipe peek result — explicit enum (Fix A)
// Cross-platform enum + classifier so the host can test the pure logic.
// ---------------------------------------------------------------------------

/// Result of a Windows PeekNamedPipe call, distinguishing pending (no data yet,
/// pipe open) from available data from a closed pipe (EOF).
/// The enum is defined on all platforms so the pure classifier is host-testable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PeekResult {
    /// Pipe is open but no bytes currently available.
    Pending,
    /// `n` bytes are available to read right now.
    Available(u32),
    /// Pipe is closed (broken/no-data/not-connected) — true EOF.
    Eof,
}

// Stable Win32 error codes for pipe EOF classification.
// Defined as platform-independent constants so classify_peek_result is host-testable.
pub(crate) const WIN_ERROR_BROKEN_PIPE: u32 = 109;
pub(crate) const WIN_ERROR_NO_DATA: u32 = 232;
pub(crate) const WIN_ERROR_PIPE_NOT_CONNECTED: u32 = 233;

// ---------------------------------------------------------------------------
// Nonblocking I/O platform helpers
// ---------------------------------------------------------------------------

/// Unix: set O_NONBLOCK on a raw fd. Returns Err on any fcntl failure.
#[cfg(unix)]
pub(crate) fn set_nonblock(fd: std::os::unix::io::RawFd) -> Result<(), std::io::Error> {
    use libc::{fcntl, F_GETFL, F_SETFL, O_NONBLOCK};
    let flags = unsafe { fcntl(fd, F_GETFL) };
    if flags == -1 {
        return Err(std::io::Error::last_os_error());
    }
    let ret = unsafe { fcntl(fd, F_SETFL, flags | O_NONBLOCK) };
    if ret == -1 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// Unix nonblocking read: reads up to `buf.len()` bytes from fd.
/// Returns Ok(0) for EOF, Err for WouldBlock/other.
#[cfg(unix)]
pub(crate) fn nb_read(fd: std::os::unix::io::RawFd, buf: &mut [u8]) -> std::io::Result<usize> {
    let n = unsafe { libc::read(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
    if n < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(n as usize)
    }
}

/// Unix nonblocking write: writes up to `buf.len()` bytes to fd.
/// Returns Ok(n) for bytes written, Err for WouldBlock/BrokenPipe/other.
#[cfg(unix)]
pub(crate) fn nb_write(fd: std::os::unix::io::RawFd, buf: &[u8]) -> std::io::Result<usize> {
    let n = unsafe { libc::write(fd, buf.as_ptr() as *const libc::c_void, buf.len()) };
    if n < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(n as usize)
    }
}

/// Windows: set PIPE_NOWAIT on a handle (for stdin write handle).
#[cfg(windows)]
pub(crate) fn win_set_pipe_nowait(
    handle: std::os::windows::io::RawHandle,
) -> Result<(), std::io::Error> {
    use windows_sys::Win32::System::Pipes::{SetNamedPipeHandleState, PIPE_NOWAIT};
    let mode: u32 = PIPE_NOWAIT;
    let ret = unsafe {
        SetNamedPipeHandleState(
            handle as windows_sys::Win32::Foundation::HANDLE,
            &mode,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ret == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Classify the result of a PeekNamedPipe call into a deterministic PeekResult.
/// This is a pure function defined on all platforms for host testing.
/// - `success`: whether PeekNamedPipe returned non-zero (success)
/// - `available`: the total_bytes_avail value from PeekNamedPipe (only meaningful if success)
/// - `raw_error`: the raw OS error code (only meaningful if !success)
pub(crate) fn classify_peek_result(
    success: bool,
    available: u32,
    raw_error: u32,
) -> std::io::Result<PeekResult> {
    if success {
        if available == 0 {
            Ok(PeekResult::Pending)
        } else {
            Ok(PeekResult::Available(available))
        }
    } else {
        if raw_error == WIN_ERROR_BROKEN_PIPE
            || raw_error == WIN_ERROR_NO_DATA
            || raw_error == WIN_ERROR_PIPE_NOT_CONNECTED
        {
            Ok(PeekResult::Eof)
        } else {
            Err(std::io::Error::from_raw_os_error(raw_error as i32))
        }
    }
}

/// Windows: peek a pipe handle, returning explicit Pending/Available/Eof.
/// Delegates classification to `classify_peek_result` (the same pure classifier
/// tested independently on all platforms).
#[cfg(windows)]
pub(crate) fn win_peek(handle: std::os::windows::io::RawHandle) -> std::io::Result<PeekResult> {
    use windows_sys::Win32::System::Pipes::PeekNamedPipe;
    let mut available: u32 = 0;
    let ret = unsafe {
        PeekNamedPipe(
            handle as windows_sys::Win32::Foundation::HANDLE,
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            &mut available,
            std::ptr::null_mut(),
        )
    };
    if ret == 0 {
        let err = std::io::Error::last_os_error();
        let code = err.raw_os_error().unwrap_or(0) as u32;
        classify_peek_result(false, 0, code)
    } else {
        classify_peek_result(true, available, 0)
    }
}

// ---------------------------------------------------------------------------
// Bounded drain functions — typed Result, strict caps (Fix D)
// ---------------------------------------------------------------------------

/// Drain currently available bytes from a stdout pipe into buf (bounded).
/// `max_chunks` limits the number of read iterations to prevent unbounded loops
/// when a descendant continuously writes to inherited pipe handles.
/// Returns Ok(()) on success/EOF, Err on non-EOF I/O error.
#[cfg(unix)]
pub(crate) fn drain_bounded(
    pipe: &mut Option<std::process::ChildStdout>,
    buf: &mut Vec<u8>,
    max_bytes: usize,
    max_chunks: usize,
) -> Result<(), std::io::Error> {
    use std::os::unix::io::AsRawFd;
    let Some(ref p) = pipe else { return Ok(()) };
    let fd = p.as_raw_fd();
    let mut chunk = [0u8; IO_CHUNK_SIZE];
    let mut iterations = 0;
    loop {
        if buf.len() > max_bytes || iterations >= max_chunks {
            break;
        }
        iterations += 1;
        match nb_read(fd, &mut chunk) {
            Ok(0) => break, // EOF
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// Drain currently available bytes from a stderr pipe into buf (bounded).
#[cfg(unix)]
pub(crate) fn drain_bounded_stderr(
    pipe: &mut Option<std::process::ChildStderr>,
    buf: &mut Vec<u8>,
    max_bytes: usize,
    max_chunks: usize,
) -> Result<(), std::io::Error> {
    use std::os::unix::io::AsRawFd;
    let Some(ref p) = pipe else { return Ok(()) };
    let fd = p.as_raw_fd();
    let mut chunk = [0u8; IO_CHUNK_SIZE];
    let mut iterations = 0;
    loop {
        if buf.len() > max_bytes || iterations >= max_chunks {
            break;
        }
        iterations += 1;
        match nb_read(fd, &mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn drain_bounded(
    pipe: &mut Option<std::process::ChildStdout>,
    buf: &mut Vec<u8>,
    max_bytes: usize,
    max_chunks: usize,
) -> Result<(), std::io::Error> {
    use std::io::Read;
    use std::os::windows::io::AsRawHandle;
    let Some(ref mut p) = pipe else { return Ok(()) };
    let handle = p.as_raw_handle();
    let mut chunk = [0u8; IO_CHUNK_SIZE];
    let mut iterations = 0;
    loop {
        if buf.len() > max_bytes || iterations >= max_chunks {
            break;
        }
        iterations += 1;
        match win_peek(handle)? {
            PeekResult::Eof => break,
            PeekResult::Pending => break,
            PeekResult::Available(avail) => {
                let to_read = (avail as usize).min(chunk.len());
                match p.read(&mut chunk[..to_read]) {
                    Ok(0) => break,
                    Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    Err(e) => return Err(e),
                }
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn drain_bounded_stderr(
    pipe: &mut Option<std::process::ChildStderr>,
    buf: &mut Vec<u8>,
    max_bytes: usize,
    max_chunks: usize,
) -> Result<(), std::io::Error> {
    use std::io::Read;
    use std::os::windows::io::AsRawHandle;
    let Some(ref mut p) = pipe else { return Ok(()) };
    let handle = p.as_raw_handle();
    let mut chunk = [0u8; IO_CHUNK_SIZE];
    let mut iterations = 0;
    loop {
        if buf.len() > max_bytes || iterations >= max_chunks {
            break;
        }
        iterations += 1;
        match win_peek(handle)? {
            PeekResult::Eof => break,
            PeekResult::Pending => break,
            PeekResult::Available(avail) => {
                let to_read = (avail as usize).min(chunk.len());
                match p.read(&mut chunk[..to_read]) {
                    Ok(0) => break,
                    Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    Err(e) => return Err(e),
                }
            }
        }
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn drain_bounded(
    _pipe: &mut Option<std::process::ChildStdout>,
    _buf: &mut Vec<u8>,
    _max_bytes: usize,
    _max_chunks: usize,
) -> Result<(), std::io::Error> {
    Ok(())
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn drain_bounded_stderr(
    _pipe: &mut Option<std::process::ChildStderr>,
    _buf: &mut Vec<u8>,
    _max_bytes: usize,
    _max_chunks: usize,
) -> Result<(), std::io::Error> {
    Ok(())
}

// ---------------------------------------------------------------------------
// Nonblocking state machine core
// ---------------------------------------------------------------------------

/// Core subprocess execution — the SINGLE implementation used by both production
/// and tests. Accepts `InvocationLimits` to allow tests to exercise the same code
/// with small caps/timeouts.
///
/// Uses `env_clear()` + minimal allowlist for security isolation.
/// Single-thread nonblocking state machine: no thread::spawn, no JoinHandle.
pub(crate) fn invoke_helper_core<T: for<'de> Deserialize<'de>>(
    helper_path: PathBuf,
    ccem_node: PathBuf,
    request_json: String,
    roots_json: String,
    limits: &InvocationLimits,
) -> Result<(T, Vec<String>), DshHistoryError> {
    use std::process::{Command, Stdio};

    let env_allowlist = super::build_env_allowlist(&roots_json);

    // started = Instant::now() BEFORE spawn; deadline includes spawn duration.
    let started = Instant::now();
    let deadline = started + limits.timeout;

    let mut child = Command::new(&ccem_node)
        .arg(&helper_path)
        .env_clear()
        .envs(env_allowlist.iter().map(|(k, v)| (*k, v.as_str())))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| DshHistoryError::HelperFailed(format!("spawn failed: {}", e)))?;

    let child_pid = child.id();

    // Take all three pipe handles
    let mut stdin_pipe = child.stdin.take();
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();

    // --- Platform-specific nonblocking setup ---
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        if let Some(ref p) = stdin_pipe {
            if let Err(e) = set_nonblock(p.as_raw_fd()) {
                drop(stdin_pipe.take());
                drop(stdout_pipe.take());
                drop(stderr_pipe.take());
                let cleanup_ctx = cleanup_with_context(&mut child);
                return Err(DshHistoryError::HelperFailed(format!(
                    "fcntl stdin O_NONBLOCK failed (pid {} killed): {}{}",
                    child_pid, e, cleanup_ctx
                )));
            }
        }
        if let Some(ref p) = stdout_pipe {
            if let Err(e) = set_nonblock(p.as_raw_fd()) {
                drop(stdin_pipe.take());
                drop(stdout_pipe.take());
                drop(stderr_pipe.take());
                let cleanup_ctx = cleanup_with_context(&mut child);
                return Err(DshHistoryError::HelperFailed(format!(
                    "fcntl stdout O_NONBLOCK failed (pid {} killed): {}{}",
                    child_pid, e, cleanup_ctx
                )));
            }
        }
        if let Some(ref p) = stderr_pipe {
            if let Err(e) = set_nonblock(p.as_raw_fd()) {
                drop(stdin_pipe.take());
                drop(stdout_pipe.take());
                drop(stderr_pipe.take());
                let cleanup_ctx = cleanup_with_context(&mut child);
                return Err(DshHistoryError::HelperFailed(format!(
                    "fcntl stderr O_NONBLOCK failed (pid {} killed): {}{}",
                    child_pid, e, cleanup_ctx
                )));
            }
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        if let Some(ref p) = stdin_pipe {
            if let Err(e) = win_set_pipe_nowait(p.as_raw_handle()) {
                drop(stdin_pipe.take());
                drop(stdout_pipe.take());
                drop(stderr_pipe.take());
                let cleanup_ctx = cleanup_with_context(&mut child);
                return Err(DshHistoryError::HelperFailed(format!(
                    "SetNamedPipeHandleState stdin failed (pid {} killed): {}{}",
                    child_pid, e, cleanup_ctx
                )));
            }
        }
    }

    // State machine buffers
    let input_bytes = request_json.into_bytes();
    let mut stdin_offset: usize = 0;
    let mut stdout_buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    let mut stderr_buf: Vec<u8> = Vec::with_capacity(4096);
    let mut stdout_eof = false;
    let mut stderr_eof = false;

    // --- Main nonblocking loop ---
    let exit_status = loop {
        let mut progress = false;

        // 1. Check deadline
        if Instant::now() >= deadline {
            drop(stdin_pipe.take());
            drop(stdout_pipe.take());
            drop(stderr_pipe.take());
            // Fix B: checked cleanup on timeout
            if let Err(ce) = kill_and_reap(&mut child) {
                return Err(DshHistoryError::HelperFailed(format!(
                    "helper (pid {}) timed out after {:?} and cleanup failed: {}",
                    child_pid, limits.timeout, ce
                )));
            }
            return Err(DshHistoryError::Timeout);
        }

        // 2. Stdin: write bounded chunk if still have data
        if stdin_pipe.is_some() && stdin_offset < input_bytes.len() {
            let end = (stdin_offset + IO_CHUNK_SIZE).min(input_bytes.len());
            let chunk = &input_bytes[stdin_offset..end];

            #[cfg(unix)]
            let write_result = {
                use std::os::unix::io::AsRawFd;
                let fd = stdin_pipe.as_ref().unwrap().as_raw_fd();
                nb_write(fd, chunk)
            };
            #[cfg(windows)]
            let write_result = {
                use std::io::Write;
                stdin_pipe.as_mut().unwrap().write(chunk)
            };
            #[cfg(not(any(unix, windows)))]
            let write_result = {
                use std::io::Write;
                stdin_pipe.as_mut().unwrap().write(chunk)
            };

            match write_result {
                Ok(n) if n > 0 => {
                    stdin_offset += n;
                    progress = true;
                }
                Ok(_) => {} // zero written, no progress
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => {
                    // BrokenPipe or other write error — cleanup child (Fix B+C)
                    drop(stdin_pipe.take());
                    drop(stdout_pipe.take());
                    drop(stderr_pipe.take());
                    let cleanup_ctx = cleanup_with_context(&mut child);
                    return Err(DshHistoryError::HelperFailed(format!(
                        "stdin write failed (pid {} killed): {}{}",
                        child_pid, e, cleanup_ctx
                    )));
                }
            }
        }

        // Drop stdin after all input written
        if stdin_pipe.is_some() && stdin_offset >= input_bytes.len() {
            drop(stdin_pipe.take());
        }

        // 3. Stdout: read bounded chunk (Fix A+C)
        if !stdout_eof && stdout_pipe.is_some() {
            let mut chunk = [0u8; IO_CHUNK_SIZE];

            #[cfg(unix)]
            let read_result = {
                use std::os::unix::io::AsRawFd;
                let fd = stdout_pipe.as_ref().unwrap().as_raw_fd();
                nb_read(fd, &mut chunk)
            };
            #[cfg(windows)]
            let read_result: std::io::Result<Option<usize>> = {
                use std::io::Read;
                use std::os::windows::io::AsRawHandle;
                let handle = stdout_pipe.as_ref().unwrap().as_raw_handle();
                match win_peek(handle) {
                    Err(e) => Err(e),
                    Ok(PeekResult::Eof) => Ok(None), // true EOF
                    Ok(PeekResult::Pending) => Ok(Some(0)), // no data, not EOF
                    Ok(PeekResult::Available(avail)) => {
                        let to_read = (avail as usize).min(chunk.len());
                        stdout_pipe
                            .as_mut()
                            .unwrap()
                            .read(&mut chunk[..to_read])
                            .map(Some)
                    }
                }
            };

            // Platform-uniform match (Unix: Ok(0)=EOF; Windows: Ok(None)=EOF)
            #[cfg(unix)]
            match read_result {
                Ok(0) => {
                    stdout_eof = true;
                    drop(stdout_pipe.take());
                }
                Ok(n) => {
                    stdout_buf.extend_from_slice(&chunk[..n]);
                    progress = true;
                    if stdout_buf.len() > limits.max_stdout_bytes {
                        drop(stdin_pipe.take());
                        drop(stdout_pipe.take());
                        drop(stderr_pipe.take());
                        let cleanup_ctx = cleanup_with_context(&mut child);
                        if !cleanup_ctx.is_empty() {
                            return Err(DshHistoryError::HelperFailed(format!(
                                "stdout exceeded cap{}",
                                cleanup_ctx
                            )));
                        }
                        return Err(DshHistoryError::OutputTooLarge);
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => {
                    // Non-EOF read error → HelperFailed after checked cleanup (Fix C)
                    drop(stdin_pipe.take());
                    drop(stdout_pipe.take());
                    drop(stderr_pipe.take());
                    let cleanup_ctx = cleanup_with_context(&mut child);
                    return Err(DshHistoryError::HelperFailed(format!(
                        "stdout read error (pid {} killed): {}{}",
                        child_pid, e, cleanup_ctx
                    )));
                }
            }

            #[cfg(windows)]
            match read_result {
                Ok(None) => {
                    // True EOF from PeekResult::Eof
                    stdout_eof = true;
                    drop(stdout_pipe.take());
                }
                Ok(Some(0)) => {} // Pending — no data, not EOF
                Ok(Some(n)) => {
                    stdout_buf.extend_from_slice(&chunk[..n]);
                    progress = true;
                    if stdout_buf.len() > limits.max_stdout_bytes {
                        drop(stdin_pipe.take());
                        drop(stdout_pipe.take());
                        drop(stderr_pipe.take());
                        let cleanup_ctx = cleanup_with_context(&mut child);
                        if !cleanup_ctx.is_empty() {
                            return Err(DshHistoryError::HelperFailed(format!(
                                "stdout exceeded cap{}",
                                cleanup_ctx
                            )));
                        }
                        return Err(DshHistoryError::OutputTooLarge);
                    }
                }
                Err(e) => {
                    drop(stdin_pipe.take());
                    drop(stdout_pipe.take());
                    drop(stderr_pipe.take());
                    let cleanup_ctx = cleanup_with_context(&mut child);
                    return Err(DshHistoryError::HelperFailed(format!(
                        "stdout read error (pid {} killed): {}{}",
                        child_pid, e, cleanup_ctx
                    )));
                }
            }

            #[cfg(not(any(unix, windows)))]
            {
                let _ = read_result;
            }
        }

        // 4. Stderr: read bounded chunk (Fix A+C)
        if !stderr_eof && stderr_pipe.is_some() {
            let mut chunk = [0u8; IO_CHUNK_SIZE];

            #[cfg(unix)]
            let read_result = {
                use std::os::unix::io::AsRawFd;
                let fd = stderr_pipe.as_ref().unwrap().as_raw_fd();
                nb_read(fd, &mut chunk)
            };
            #[cfg(windows)]
            let read_result: std::io::Result<Option<usize>> = {
                use std::io::Read;
                use std::os::windows::io::AsRawHandle;
                let handle = stderr_pipe.as_ref().unwrap().as_raw_handle();
                match win_peek(handle) {
                    Err(e) => Err(e),
                    Ok(PeekResult::Eof) => Ok(None),
                    Ok(PeekResult::Pending) => Ok(Some(0)),
                    Ok(PeekResult::Available(avail)) => {
                        let to_read = (avail as usize).min(chunk.len());
                        stderr_pipe
                            .as_mut()
                            .unwrap()
                            .read(&mut chunk[..to_read])
                            .map(Some)
                    }
                }
            };

            #[cfg(unix)]
            match read_result {
                Ok(0) => {
                    stderr_eof = true;
                    drop(stderr_pipe.take());
                }
                Ok(n) => {
                    stderr_buf.extend_from_slice(&chunk[..n]);
                    progress = true;
                    if stderr_buf.len() > limits.max_stderr_bytes {
                        drop(stdin_pipe.take());
                        drop(stdout_pipe.take());
                        drop(stderr_pipe.take());
                        let cleanup_ctx = cleanup_with_context(&mut child);
                        if !cleanup_ctx.is_empty() {
                            return Err(DshHistoryError::HelperFailed(format!(
                                "stderr exceeded cap{}",
                                cleanup_ctx
                            )));
                        }
                        return Err(DshHistoryError::OutputTooLarge);
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => {
                    drop(stdin_pipe.take());
                    drop(stdout_pipe.take());
                    drop(stderr_pipe.take());
                    let cleanup_ctx = cleanup_with_context(&mut child);
                    return Err(DshHistoryError::HelperFailed(format!(
                        "stderr read error (pid {} killed): {}{}",
                        child_pid, e, cleanup_ctx
                    )));
                }
            }

            #[cfg(windows)]
            match read_result {
                Ok(None) => {
                    stderr_eof = true;
                    drop(stderr_pipe.take());
                }
                Ok(Some(0)) => {}
                Ok(Some(n)) => {
                    stderr_buf.extend_from_slice(&chunk[..n]);
                    progress = true;
                    if stderr_buf.len() > limits.max_stderr_bytes {
                        drop(stdin_pipe.take());
                        drop(stdout_pipe.take());
                        drop(stderr_pipe.take());
                        let cleanup_ctx = cleanup_with_context(&mut child);
                        if !cleanup_ctx.is_empty() {
                            return Err(DshHistoryError::HelperFailed(format!(
                                "stderr exceeded cap{}",
                                cleanup_ctx
                            )));
                        }
                        return Err(DshHistoryError::OutputTooLarge);
                    }
                }
                Err(e) => {
                    drop(stdin_pipe.take());
                    drop(stdout_pipe.take());
                    drop(stderr_pipe.take());
                    let cleanup_ctx = cleanup_with_context(&mut child);
                    return Err(DshHistoryError::HelperFailed(format!(
                        "stderr read error (pid {} killed): {}{}",
                        child_pid, e, cleanup_ctx
                    )));
                }
            }

            #[cfg(not(any(unix, windows)))]
            {
                let _ = read_result;
            }
        }

        // 5. Check child exit status
        match child.try_wait() {
            Ok(Some(status)) => {
                // If child exits before complete stdin write → HelperFailed
                if stdin_pipe.is_some() || stdin_offset < input_bytes.len() {
                    drop(stdin_pipe.take());
                    // Bounded post-exit drain (Fix D): snapshot cap + strict chunk limit
                    let stdout_snap = stdout_buf.len();
                    let stderr_snap = stderr_buf.len();
                    let stdout_drain_cap = stdout_snap
                        .saturating_add(POST_EXIT_DRAIN_MAX_CHUNKS * IO_CHUNK_SIZE)
                        .min(limits.max_stdout_bytes);
                    let stderr_drain_cap = stderr_snap
                        .saturating_add(POST_EXIT_DRAIN_MAX_CHUNKS * IO_CHUNK_SIZE)
                        .min(limits.max_stderr_bytes);
                    // Drain errors checked (Fix C): propagate as HelperFailed
                    if let Err(de) = drain_bounded(
                        &mut stdout_pipe,
                        &mut stdout_buf,
                        stdout_drain_cap,
                        POST_EXIT_DRAIN_MAX_CHUNKS,
                    ) {
                        drop(stdout_pipe.take());
                        drop(stderr_pipe.take());
                        return Err(DshHistoryError::HelperFailed(format!(
                            "stdout drain after early exit failed (pid {}): {}",
                            child_pid, de
                        )));
                    }
                    if let Err(de) = drain_bounded_stderr(
                        &mut stderr_pipe,
                        &mut stderr_buf,
                        stderr_drain_cap,
                        POST_EXIT_DRAIN_MAX_CHUNKS,
                    ) {
                        drop(stdout_pipe.take());
                        drop(stderr_pipe.take());
                        return Err(DshHistoryError::HelperFailed(format!(
                            "stderr drain after early exit failed (pid {}): {}",
                            child_pid, de
                        )));
                    }
                    // Drop handles without waiting for EOF (Fix D)
                    drop(stdout_pipe.take());
                    drop(stderr_pipe.take());
                    return Err(DshHistoryError::HelperFailed(format!(
                        "child (pid {}) exited before reading all stdin ({}/{} bytes written)",
                        child_pid,
                        stdin_offset,
                        input_bytes.len()
                    )));
                }
                // Child exited normally: bounded post-exit drain (Fix D)
                let stdout_snap = stdout_buf.len();
                let stderr_snap = stderr_buf.len();
                let stdout_drain_cap = stdout_snap
                    .saturating_add(POST_EXIT_DRAIN_MAX_CHUNKS * IO_CHUNK_SIZE)
                    .min(limits.max_stdout_bytes);
                let stderr_drain_cap = stderr_snap
                    .saturating_add(POST_EXIT_DRAIN_MAX_CHUNKS * IO_CHUNK_SIZE)
                    .min(limits.max_stderr_bytes);
                // Drain errors checked (Fix C)
                if let Err(de) = drain_bounded(
                    &mut stdout_pipe,
                    &mut stdout_buf,
                    stdout_drain_cap,
                    POST_EXIT_DRAIN_MAX_CHUNKS,
                ) {
                    drop(stdout_pipe.take());
                    drop(stderr_pipe.take());
                    return Err(DshHistoryError::HelperFailed(format!(
                        "stdout drain after exit failed (pid {}): {}",
                        child_pid, de
                    )));
                }
                if let Err(de) = drain_bounded_stderr(
                    &mut stderr_pipe,
                    &mut stderr_buf,
                    stderr_drain_cap,
                    POST_EXIT_DRAIN_MAX_CHUNKS,
                ) {
                    drop(stdout_pipe.take());
                    drop(stderr_pipe.take());
                    return Err(DshHistoryError::HelperFailed(format!(
                        "stderr drain after exit failed (pid {}): {}",
                        child_pid, de
                    )));
                }
                // Drop pipe handles — never wait for EOF from descendants
                drop(stdout_pipe.take());
                drop(stderr_pipe.take());
                break status;
            }
            Ok(None) => {} // still running
            Err(e) => {
                drop(stdin_pipe.take());
                drop(stdout_pipe.take());
                drop(stderr_pipe.take());
                let cleanup_ctx = cleanup_with_context(&mut child);
                return Err(DshHistoryError::HelperFailed(format!(
                    "wait: {}{}",
                    e, cleanup_ctx
                )));
            }
        }

        // 6. Sleep if no progress (1-5ms adaptive)
        if !progress {
            std::thread::sleep(Duration::from_millis(2));
        }
    };

    // --- Post-loop: evaluate results ---
    let status = exit_status;

    // Check stdout/stderr caps one final time after drain
    if stdout_buf.len() > limits.max_stdout_bytes || stderr_buf.len() > limits.max_stderr_bytes {
        return Err(DshHistoryError::OutputTooLarge);
    }

    // Check exit code
    if !status.success() {
        let stderr_str = String::from_utf8_lossy(&stderr_buf);
        return Err(DshHistoryError::HelperFailed(format!(
            "exit code {}: {}",
            status.code().unwrap_or(-1),
            stderr_str.trim()
        )));
    }

    // Parse response
    let stdout = String::from_utf8_lossy(&stdout_buf);
    let response: DshHistoryResponse<T> = serde_json::from_str(stdout.trim()).map_err(|e| {
        DshHistoryError::HelperFailed(format!(
            "invalid JSON response: {} (first 200 bytes: {:?})",
            e,
            &stdout[..stdout.len().min(200)]
        ))
    })?;

    // Hardened envelope validation
    match response {
        DshHistoryResponse::Ok {
            ok,
            schema_version,
            dsh_version,
            data,
            warnings,
        } => {
            if !ok {
                return Err(DshHistoryError::HelperFailed(
                    "envelope: ok=false in success variant".to_string(),
                ));
            }
            if schema_version != 1 {
                return Err(DshHistoryError::HelperFailed(format!(
                    "envelope: unsupported schemaVersion {} (expected 1)",
                    schema_version
                )));
            }
            if dsh_version != DSH_EXPECTED_VERSION {
                return Err(DshHistoryError::HelperFailed(format!(
                    "envelope: unexpected dshVersion {:?} (expected {:?})",
                    dsh_version, DSH_EXPECTED_VERSION
                )));
            }
            Ok((data, warnings))
        }
        DshHistoryResponse::Err {
            ok,
            schema_version,
            code,
            message,
        } => {
            if ok {
                return Err(DshHistoryError::HelperFailed(
                    "envelope: ok=true in error variant".to_string(),
                ));
            }
            if schema_version != 1 {
                return Err(DshHistoryError::HelperFailed(format!(
                    "envelope: unsupported schemaVersion {} in error response (expected 1)",
                    schema_version
                )));
            }
            match code.as_str() {
                "UNSUPPORTED_FORMAT" => Err(DshHistoryError::UnsupportedFormat(message)),
                "BUSY_CORRUPT" => Err(DshHistoryError::BusyCorrupt(message)),
                _ => Err(DshHistoryError::SourceError { code, message }),
            }
        }
    }
}
