//! Disposable Mode 1.5 proof for a CCEM-owned Chromium runtime.
//!
//! This module is deliberately excluded from normal builds. It proves the riskiest transport and
//! lifecycle assumptions without selecting a production Chromium distribution or exposing CDP to
//! Agent tools.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::Utc;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const CDP_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
const CDP_READ_SLICE: Duration = Duration::from_millis(500);
const MAX_CDP_FRAME_BYTES: usize = 32 * 1024 * 1024;
const PROCESS_EXIT_TIMEOUT: Duration = Duration::from_secs(10);
const PROCESS_GROUP_SETTLE_TIMEOUT: Duration = Duration::from_secs(5);
const METADATA_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct ChromiumRuntimeMetadata {
    schema_version: u32,
    runtime_id: String,
    owner_pid: u32,
    browser_pid: u32,
    process_group_id: i32,
    executable: String,
    user_data_dir: String,
    transport: String,
    created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum StaleReapOutcome {
    AlreadyExited,
    OwnerStillRunning,
    RefusedProcessMismatch,
    SignaledVerifiedRuntime,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct ChromiumPageSmoke {
    pub browser_version: String,
    pub target_id: String,
    pub session_id: String,
    pub final_url: String,
    pub marker_text: String,
    pub screenshot_path: String,
    pub screenshot_bytes: u64,
    pub screenshot_sha256: String,
}

struct CdpPipeClient {
    writer: UnixStream,
    reader: UnixStream,
    read_buffer: Vec<u8>,
    next_id: u64,
}

impl CdpPipeClient {
    fn new(writer: UnixStream, reader: UnixStream) -> Result<Self, String> {
        writer
            .set_write_timeout(Some(CDP_RESPONSE_TIMEOUT))
            .map_err(|error| format!("configure Chromium pipe writer: {error}"))?;
        reader
            .set_read_timeout(Some(CDP_READ_SLICE))
            .map_err(|error| format!("configure Chromium pipe reader: {error}"))?;
        Ok(Self {
            writer,
            reader,
            read_buffer: Vec::new(),
            next_id: 0,
        })
    }

    fn call(
        &mut self,
        method: &str,
        params: Value,
        session_id: Option<&str>,
    ) -> Result<Value, String> {
        let id = self.send(method, params, session_id)?;
        let deadline = Instant::now() + CDP_RESPONSE_TIMEOUT;
        loop {
            let message = self
                .read_message(deadline)
                .map_err(|error| format!("CDP {method} response: {error}"))?;
            if message.get("id").and_then(Value::as_u64) != Some(id) {
                if Instant::now() >= deadline {
                    return Err(format!(
                        "CDP {method} response timed out while processing unrelated events"
                    ));
                }
                continue;
            }
            if let Some(error) = message.get("error") {
                return Err(format!("CDP {method} failed: {error}"));
            }
            return Ok(message.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    fn send(
        &mut self,
        method: &str,
        params: Value,
        session_id: Option<&str>,
    ) -> Result<u64, String> {
        self.next_id = self.next_id.saturating_add(1);
        let id = self.next_id;
        let mut message = json!({
            "id": id,
            "method": method,
            "params": params,
        });
        if let Some(session_id) = session_id {
            message["sessionId"] = Value::String(session_id.to_string());
        }
        let mut encoded = serde_json::to_vec(&message)
            .map_err(|error| format!("encode CDP {method} request: {error}"))?;
        // Chrome's remote-debugging-pipe transport uses NUL-delimited JSON, not stdin/stdout.
        encoded.push(0);
        self.writer
            .write_all(&encoded)
            .map_err(|error| format!("write CDP {method} request: {error}"))?;
        self.writer
            .flush()
            .map_err(|error| format!("flush CDP {method} request: {error}"))?;
        Ok(id)
    }

    fn read_message(&mut self, deadline: Instant) -> Result<Value, String> {
        loop {
            if let Some(frame) = take_next_cdp_frame(&mut self.read_buffer, MAX_CDP_FRAME_BYTES)? {
                return serde_json::from_slice(&frame)
                    .map_err(|error| format!("decode Chromium CDP pipe frame: {error}"));
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "read Chromium CDP pipe timed out with {} buffered bytes",
                    self.read_buffer.len()
                ));
            }
            let mut chunk = [0_u8; 64 * 1024];
            match self.reader.read(&mut chunk) {
                Ok(0) => {
                    return Err("Chromium CDP pipe closed before a response arrived.".to_string())
                }
                Ok(read) => self.read_buffer.extend_from_slice(&chunk[..read]),
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    if Instant::now() >= deadline {
                        return Err(format!(
                            "read Chromium CDP pipe timed out with {} buffered bytes",
                            self.read_buffer.len()
                        ));
                    }
                }
                Err(error) => return Err(format!("read Chromium CDP pipe: {error}")),
            }
        }
    }
}

fn take_next_cdp_frame(buffer: &mut Vec<u8>, max_bytes: usize) -> Result<Option<Vec<u8>>, String> {
    if let Some(delimiter) = buffer.iter().position(|byte| *byte == 0) {
        if delimiter > max_bytes {
            return Err(format!("Chromium CDP frame exceeded {max_bytes} bytes."));
        }
        let mut frame = buffer.drain(..=delimiter).collect::<Vec<_>>();
        frame.pop();
        return Ok(Some(frame));
    }
    if buffer.len() > max_bytes {
        return Err(format!("Chromium CDP frame exceeded {max_bytes} bytes."));
    }
    Ok(None)
}

pub(super) struct ManagedChromiumSpike {
    child: Option<Child>,
    cdp: Option<CdpPipeClient>,
    metadata: ChromiumRuntimeMetadata,
    metadata_path: PathBuf,
}

impl ManagedChromiumSpike {
    pub(super) fn launch(executable: &Path, runtime_root: &Path) -> Result<Self, String> {
        let executable = executable.canonicalize().map_err(|error| {
            format!(
                "resolve managed Chromium executable {}: {error}",
                executable.display()
            )
        })?;
        if !executable.is_file() {
            return Err(format!(
                "Managed Chromium executable is not a file: {}",
                executable.display()
            ));
        }

        ensure_private_directory(runtime_root)?;
        let runtime_id = random_runtime_id();
        let runtime_dir = runtime_root.join(&runtime_id);
        let user_data_dir = runtime_dir.join("profile");
        ensure_private_directory(&runtime_dir)?;
        ensure_private_directory(&user_data_dir)?;

        // On POSIX Chromium reads CDP commands from FD 3 and writes responses/events to FD 4.
        let (parent_command, child_command) =
            UnixStream::pair().map_err(|error| format!("create Chromium command pipe: {error}"))?;
        let (child_response, parent_response) = UnixStream::pair()
            .map_err(|error| format!("create Chromium response pipe: {error}"))?;
        let child_command_fd = duplicate_fd_above_stdio(child_command.as_raw_fd())?;
        let child_response_fd = duplicate_fd_above_stdio(child_response.as_raw_fd())?;

        let stderr_path = runtime_dir.join("chromium-stderr.log");
        let stderr = private_output_file(&stderr_path)?;
        let runtime_switch = format!("--ccem-managed-runtime-id={runtime_id}");
        let profile_switch = format!("--user-data-dir={}", user_data_dir.to_string_lossy());
        let mut command = Command::new(&executable);
        command
            .args([
                "--headless=new",
                "--remote-debugging-pipe",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-background-networking",
                "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows",
                "--disable-component-update",
                "--disable-domain-reliability",
                "--disable-sync",
                "--disable-extensions",
                "--disable-breakpad",
                "--disable-crash-reporter",
                "--disable-hang-monitor",
                "--disable-ipc-flooding-protection",
                "--disable-renderer-backgrounding",
                "--enable-automation",
                "--enable-features=CDPScreenshotNewSurface",
                "--force-color-profile=srgb",
                "--hide-scrollbars",
                "--metrics-recording-only",
                "--mute-audio",
                "--no-startup-window",
                "--password-store=basic",
                "--use-mock-keychain",
            ])
            .arg(&runtime_switch)
            .arg(&profile_switch)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(stderr));

        let command_fd = child_command_fd.as_raw_fd();
        let response_fd = child_response_fd.as_raw_fd();
        // SAFETY: pre_exec only invokes async-signal-safe libc calls before exec. Both source FDs
        // were duplicated above the stdio/CDP range so dup2 cannot clobber the other source.
        unsafe {
            command.pre_exec(move || {
                if libc::setpgid(0, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::dup2(command_fd, 3) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::dup2(response_fd, 4) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                libc::close(command_fd);
                libc::close(response_fd);
                Ok(())
            });
        }

        let mut child = command
            .spawn()
            .map_err(|error| format!("launch managed Chromium spike: {error}"))?;
        drop(command);
        drop(child_command);
        drop(child_response);

        let browser_pid = child.id();
        let process_group_id = browser_pid as i32;
        let metadata = ChromiumRuntimeMetadata {
            schema_version: METADATA_SCHEMA_VERSION,
            runtime_id,
            owner_pid: std::process::id(),
            browser_pid,
            process_group_id,
            executable: executable.to_string_lossy().into_owned(),
            user_data_dir: user_data_dir.to_string_lossy().into_owned(),
            transport: "remote-debugging-pipe-fd3-fd4".to_string(),
            created_at: Utc::now().to_rfc3339(),
        };
        let metadata_path = runtime_dir.join("runtime.json");
        if let Err(error) = write_private_json(&metadata_path, &metadata) {
            let _ = signal_process_group(process_group_id, libc::SIGKILL);
            let _ = child.wait();
            return Err(error);
        }
        let cdp = match CdpPipeClient::new(parent_command, parent_response) {
            Ok(cdp) => cdp,
            Err(error) => {
                let _ = signal_process_group(process_group_id, libc::SIGKILL);
                let _ = child.wait();
                let _ = remove_file_if_present(&metadata_path);
                return Err(error);
            }
        };

        Ok(Self {
            child: Some(child),
            cdp: Some(cdp),
            metadata,
            metadata_path,
        })
    }

    pub(super) fn pid(&self) -> u32 {
        self.metadata.browser_pid
    }

    pub(super) fn process_group_id(&self) -> i32 {
        self.metadata.process_group_id
    }

    pub(super) fn metadata_path(&self) -> &Path {
        &self.metadata_path
    }

    pub(super) fn browser_version(&mut self) -> Result<String, String> {
        let result = self
            .cdp
            .as_mut()
            .ok_or_else(|| "Chromium CDP pipe is not available.".to_string())?
            .call("Browser.getVersion", json!({}), None)?;
        required_string(&result, "product", "Browser.getVersion")
    }

    pub(super) fn run_page_smoke(
        &mut self,
        url: &str,
        marker_text: &str,
        screenshot_path: &Path,
    ) -> Result<ChromiumPageSmoke, String> {
        let browser_version = self.browser_version()?;
        let cdp = self
            .cdp
            .as_mut()
            .ok_or_else(|| "Chromium CDP pipe is not available.".to_string())?;
        let created = cdp.call("Target.createTarget", json!({ "url": "about:blank" }), None)?;
        let target_id = required_string(&created, "targetId", "Target.createTarget")?;
        let attached = cdp.call(
            "Target.attachToTarget",
            json!({ "targetId": target_id, "flatten": true }),
            None,
        )?;
        let session_id = required_string(&attached, "sessionId", "Target.attachToTarget")?;
        cdp.call("Page.enable", json!({}), Some(&session_id))?;
        cdp.call("Runtime.enable", json!({}), Some(&session_id))?;
        cdp.call("Page.bringToFront", json!({}), Some(&session_id))?;
        cdp.call(
            "Emulation.setDeviceMetricsOverride",
            json!({
                "width": 1280,
                "height": 720,
                "deviceScaleFactor": 1,
                "mobile": false,
            }),
            Some(&session_id),
        )?;
        cdp.call("Page.navigate", json!({ "url": url }), Some(&session_id))?;

        wait_for_page_marker(cdp, &session_id, marker_text)?;
        let location = cdp.call(
            "Runtime.evaluate",
            json!({
                "expression": "location.href",
                "returnByValue": true,
            }),
            Some(&session_id),
        )?;
        let final_url = location
            .pointer("/result/value")
            .and_then(Value::as_str)
            .unwrap_or(url)
            .to_string();
        let screenshot = cdp.call(
            "Page.captureScreenshot",
            json!({
                "format": "png",
                "fromSurface": true,
                "captureBeyondViewport": false,
            }),
            Some(&session_id),
        )?;
        let encoded = required_string(&screenshot, "data", "Page.captureScreenshot")?;
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|error| format!("decode Chromium screenshot: {error}"))?;
        if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err("Chromium screenshot did not contain a PNG signature.".to_string());
        }
        write_private_bytes(screenshot_path, &bytes)?;
        cdp.call("Target.closeTarget", json!({ "targetId": target_id }), None)?;

        Ok(ChromiumPageSmoke {
            browser_version,
            target_id,
            session_id,
            final_url,
            marker_text: marker_text.to_string(),
            screenshot_path: screenshot_path.to_string_lossy().into_owned(),
            screenshot_bytes: bytes.len() as u64,
            screenshot_sha256: hex::encode(Sha256::digest(&bytes)),
        })
    }

    pub(super) fn close_cleanly(&mut self) -> Result<ExitStatus, String> {
        if let Some(cdp) = self.cdp.as_mut() {
            // Browser.close often tears down the pipe before sending a response, so send the
            // command and prove success through the process exit rather than waiting for JSON.
            let _ = cdp.send("Browser.close", json!({}), None);
        }
        self.cdp.take();
        let status = self.wait_for_exit(PROCESS_EXIT_TIMEOUT)?.ok_or_else(|| {
            "Managed Chromium did not exit after Browser.close within the timeout.".to_string()
        })?;
        self.finish_cleanup()?;
        Ok(status)
    }

    pub(super) fn force_kill(&mut self) -> Result<ExitStatus, String> {
        signal_process_group(self.metadata.process_group_id, libc::SIGKILL)?;
        self.cdp.take();
        let status = self.wait_for_exit(PROCESS_EXIT_TIMEOUT)?.ok_or_else(|| {
            "Managed Chromium did not exit after SIGKILL within the timeout.".to_string()
        })?;
        self.finish_cleanup()?;
        Ok(status)
    }

    pub(super) fn wait_after_external_reap(&mut self) -> Result<ExitStatus, String> {
        self.cdp.take();
        let status = self.wait_for_exit(PROCESS_EXIT_TIMEOUT)?.ok_or_else(|| {
            "Managed Chromium did not exit after stale-runtime reaping.".to_string()
        })?;
        self.finish_cleanup()?;
        Ok(status)
    }

    #[cfg(test)]
    pub(super) fn mark_metadata_owner_stale_for_test(&mut self) -> Result<(), String> {
        self.metadata.owner_pid = u32::MAX - 1;
        write_private_json(&self.metadata_path, &self.metadata)
    }

    fn wait_for_exit(&mut self, timeout: Duration) -> Result<Option<ExitStatus>, String> {
        let child = self
            .child
            .as_mut()
            .ok_or_else(|| "Managed Chromium child handle is unavailable.".to_string())?;
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = child
                .try_wait()
                .map_err(|error| format!("wait for managed Chromium: {error}"))?
            {
                self.child.take();
                return Ok(Some(status));
            }
            if Instant::now() >= deadline {
                return Ok(None);
            }
            thread::sleep(Duration::from_millis(40));
        }
    }

    fn finish_cleanup(&self) -> Result<(), String> {
        wait_for_process_group_exit(self.metadata.process_group_id, PROCESS_GROUP_SETTLE_TIMEOUT)?;
        remove_file_if_present(&self.metadata_path)
    }
}

impl Drop for ManagedChromiumSpike {
    fn drop(&mut self) {
        if self.child.is_some() {
            let _ = signal_process_group(self.metadata.process_group_id, libc::SIGTERM);
            self.cdp.take();
            if self
                .wait_for_exit(Duration::from_secs(1))
                .ok()
                .flatten()
                .is_none()
            {
                let _ = signal_process_group(self.metadata.process_group_id, libc::SIGKILL);
                let _ = self.wait_for_exit(Duration::from_secs(3));
            }
        }
        // Keep metadata when cleanup did not finish so a later startup reaper still has the exact
        // executable/profile/runtime marker needed to identify the process safely.
        if !process_group_exists(self.metadata.process_group_id) {
            let _ = remove_file_if_present(&self.metadata_path);
        }
    }
}

pub(super) fn reap_stale_runtime(metadata_path: &Path) -> Result<StaleReapOutcome, String> {
    let content = fs::read(metadata_path).map_err(|error| {
        format!(
            "read stale Chromium metadata {}: {error}",
            metadata_path.display()
        )
    })?;
    let metadata: ChromiumRuntimeMetadata = serde_json::from_slice(&content)
        .map_err(|error| format!("decode stale Chromium metadata: {error}"))?;
    if metadata.schema_version != METADATA_SCHEMA_VERSION
        || metadata.transport != "remote-debugging-pipe-fd3-fd4"
    {
        return Ok(StaleReapOutcome::RefusedProcessMismatch);
    }
    if process_exists(metadata.owner_pid as i32) {
        return Ok(StaleReapOutcome::OwnerStillRunning);
    }
    if !process_exists(metadata.browser_pid as i32)
        && !process_group_exists(metadata.process_group_id)
    {
        remove_file_if_present(metadata_path)?;
        return Ok(StaleReapOutcome::AlreadyExited);
    }
    if !process_exists(metadata.browser_pid as i32) {
        // The browser leader can exit before its renderer descendants. Without a live leader we
        // cannot re-run the full executable/profile identity check safely, so retain the metadata
        // for the production ownership-domain reaper instead of losing the only cleanup evidence.
        return Ok(StaleReapOutcome::RefusedProcessMismatch);
    }
    if !process_matches_metadata(&metadata)? {
        return Ok(StaleReapOutcome::RefusedProcessMismatch);
    }

    if signal_process_group(metadata.process_group_id, libc::SIGTERM).is_err() {
        // macOS can transiently reject a negative PGID after PID-space wrap. The command line was
        // matched against the canonical executable, unique profile, pipe flag, and runtime marker
        // above, so signaling the verified browser PID is a safe fallback; pipe closure then tears
        // down its renderer children.
        signal_process(metadata.browser_pid as i32, libc::SIGTERM)?;
    }
    thread::sleep(Duration::from_millis(300));
    if process_group_exists(metadata.process_group_id) {
        if signal_process_group(metadata.process_group_id, libc::SIGKILL).is_err() {
            signal_process(metadata.browser_pid as i32, libc::SIGKILL)?;
        }
    }
    // A stale owner has no Child handle with which to reap a transient zombie. Retain the private
    // metadata until the process group is observably gone; a later pass can then return
    // AlreadyExited and remove it. Never discard the only safe process identity on a signal alone.
    if !process_group_exists(metadata.process_group_id) {
        remove_file_if_present(metadata_path)?;
    }
    Ok(StaleReapOutcome::SignaledVerifiedRuntime)
}

pub(super) fn listening_tcp_entries(pid: u32) -> Result<Vec<String>, String> {
    let output = Command::new("lsof")
        .args(["-nP", "-a", "-p", &pid.to_string(), "-iTCP", "-sTCP:LISTEN"])
        .output()
        .map_err(|error| format!("run lsof for managed Chromium: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout
        .lines()
        .skip(1)
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect())
}

pub(super) fn process_group_exists(process_group_id: i32) -> bool {
    if process_group_id <= 0 {
        return false;
    }
    // SAFETY: signal 0 performs an existence/permission check and does not mutate the process.
    let result = unsafe { libc::kill(-process_group_id, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn wait_for_page_marker(
    cdp: &mut CdpPipeClient,
    session_id: &str,
    marker_text: &str,
) -> Result<(), String> {
    let marker = serde_json::to_string(marker_text)
        .map_err(|error| format!("encode Chromium marker text: {error}"))?;
    let expression = format!(
        "document.readyState === 'complete' && document.body && document.body.innerText.includes({marker})"
    );
    let deadline = Instant::now() + CDP_RESPONSE_TIMEOUT;
    loop {
        let result = cdp.call(
            "Runtime.evaluate",
            json!({ "expression": expression, "returnByValue": true }),
            Some(session_id),
        )?;
        if result.pointer("/result/value").and_then(Value::as_bool) == Some(true) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "Chromium page did not expose marker text before timeout: {marker_text}"
            ));
        }
        thread::sleep(Duration::from_millis(60));
    }
}

fn required_string(value: &Value, field: &str, operation: &str) -> Result<String, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("{operation} did not return {field}."))
}

fn random_runtime_id() -> String {
    let mut bytes = [0_u8; 8];
    OsRng.fill_bytes(&mut bytes);
    format!("chromium-spike-{}", hex::encode(bytes))
}

fn duplicate_fd_above_stdio(fd: RawFd) -> Result<OwnedFd, String> {
    // SAFETY: fcntl duplicates a valid UnixStream FD. Ownership of the returned descriptor is
    // immediately transferred into OwnedFd.
    let duplicated = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 10) };
    if duplicated == -1 {
        return Err(format!(
            "duplicate Chromium pipe descriptor: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: `duplicated` is a new, uniquely owned descriptor from fcntl above.
    Ok(unsafe { OwnedFd::from_raw_fd(duplicated) })
}

fn signal_process_group(process_group_id: i32, signal: i32) -> Result<(), String> {
    if process_group_id <= 0 {
        return Err("Refusing to signal an invalid Chromium process group.".to_string());
    }
    // SAFETY: negative pid targets only the dedicated process group created before exec.
    let result = unsafe { libc::kill(-process_group_id, signal) };
    if result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(format!(
            "signal Chromium process group {process_group_id}: {}",
            std::io::Error::last_os_error()
        ))
    }
}

fn signal_process(pid: i32, signal: i32) -> Result<(), String> {
    if pid <= 0 {
        return Err("Refusing to signal an invalid Chromium pid.".to_string());
    }
    // SAFETY: the caller verified this exact PID against private runtime metadata and its command
    // line before using the fallback.
    let result = unsafe { libc::kill(pid, signal) };
    if result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(format!(
            "signal Chromium pid {pid}: {}",
            std::io::Error::last_os_error()
        ))
    }
}

fn process_exists(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    // SAFETY: signal 0 performs an existence/permission check and does not mutate the process.
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn process_matches_metadata(metadata: &ChromiumRuntimeMetadata) -> Result<bool, String> {
    let output = Command::new("ps")
        .args(["-p", &metadata.browser_pid.to_string(), "-o", "command="])
        .output()
        .map_err(|error| format!("inspect stale Chromium process: {error}"))?;
    if !output.status.success() {
        return Ok(false);
    }
    let command = String::from_utf8_lossy(&output.stdout);
    Ok(command.contains(&metadata.executable)
        && command.contains("--remote-debugging-pipe")
        && command.contains(&format!("--user-data-dir={}", metadata.user_data_dir))
        && command.contains(&format!(
            "--ccem-managed-runtime-id={}",
            metadata.runtime_id
        )))
}

fn wait_for_process_group_exit(process_group_id: i32, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    while process_group_exists(process_group_id) {
        if Instant::now() >= deadline {
            return Err(format!(
                "Chromium process group {process_group_id} still exists after shutdown."
            ));
        }
        thread::sleep(Duration::from_millis(50));
    }
    Ok(())
}

fn ensure_private_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| {
        format!(
            "create Chromium runtime directory {}: {error}",
            path.display()
        )
    })?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| {
        format!(
            "secure Chromium runtime directory {}: {error}",
            path.display()
        )
    })
}

fn private_output_file(path: &Path) -> Result<File, String> {
    if let Some(parent) = path.parent() {
        ensure_private_directory(parent)?;
    }
    OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| format!("create private Chromium output {}: {error}", path.display()))
}

pub(super) fn write_private_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("encode Chromium spike JSON: {error}"))?;
    write_private_bytes(path, &bytes)
}

fn write_private_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = private_output_file(path)?;
    file.write_all(bytes)
        .map_err(|error| format!("write Chromium output {}: {error}", path.display()))?;
    file.flush()
        .map_err(|error| format!("flush Chromium output {}: {error}", path.display()))
}

fn remove_file_if_present(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "remove Chromium metadata {}: {error}",
            path.display()
        )),
    }
}

#[cfg(test)]
#[path = "chromium_spike_tests.rs"]
mod tests;
