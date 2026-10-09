//! The managed runtime receives only its scoped capability, over an inherited pipe.
use super::store::random_id;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

const FRAME_LIMIT: usize = 64 * 1024;
type Replies = Arc<Mutex<HashMap<String, mpsc::SyncSender<Result<Value, String>>>>>;
pub struct GatewayProcess {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    replies: Replies,
    snapshot: Arc<Mutex<Value>>,
    stopping: AtomicBool,
    stop_lock: Mutex<()>,
}
impl GatewayProcess {
    pub fn spawn(
        python: &Path,
        host: &Path,
        source: &Path,
        profile: &Path,
        boot: Value,
    ) -> Result<Self, String> {
        std::fs::create_dir_all(profile).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(profile, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        let mut command = Command::new(python);
        command
            .args(["-I", "-B", "-u"])
            .arg(host)
            .arg("--source")
            .arg(source)
            .arg("--profile")
            .arg(profile)
            .current_dir(profile)
            .env_clear()
            .env("HOME", profile)
            .env("HERMES_HOME", profile)
            .env("PATH", python.parent().unwrap_or(Path::new("/usr/bin")))
            .env("PYTHONNOUSERSITE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if boot["toolsMode"] == "native" {
            // Full Hermes is an explicit local, trusted-owner capability. Keep
            // its profile private, but let normal CLI tools find the real user
            // home and executable PATH without inheriting model/channel secrets.
            let home = dirs::home_dir().ok_or("user_home_unavailable")?;
            let mut paths = vec![python.parent().unwrap_or(Path::new("/usr/bin")).to_path_buf()];
            paths.extend(std::env::split_paths(&crate::terminal::get_user_path()));
            let path = std::env::join_paths(paths).map_err(|_| "user_path_unavailable")?;
            command.env("HOME", &home).env("HERMES_REAL_HOME", &home)
                .env("PATH", path).env("LANG", "en_US.UTF-8");
        }
        // No model credentials, user Python paths or shared Hermes profile are inherited.
        let mut child = command
            .spawn()
            .map_err(|e| format!("gateway_spawn_failed: {e}"))?;
        let mut stdin = child.stdin.take().ok_or("gateway_stdin_missing")?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let fd = stdin.as_raw_fd();
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
            {
                let _ = child.kill();
                let _ = child.wait();
                return Err("gateway_pipe_setup_failed".into());
            }
        }
        let stdout = child.stdout.take().ok_or("gateway_stdout_missing")?;
        let stderr = child.stderr.take().ok_or("gateway_stderr_missing")?;
        let frame = serde_json::to_vec(&boot).map_err(|e| e.to_string())?;
        if frame.len() > FRAME_LIMIT {
            let _ = child.kill();
            let _ = child.wait();
            return Err("gateway_boot_too_large".into());
        }
        if write_frame(&mut stdin, &frame).is_err() {
            let _ = child.kill();
            let _ = child.wait();
            return Err("gateway_boot_failed".into());
        }
        let snapshot = Arc::new(Mutex::new(
            json!({"state":"starting","platforms":[],"pending":[]}),
        ));
        let replies: Replies = Arc::new(Mutex::new(HashMap::new()));
        let state = snapshot.clone();
        let pending = replies.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let frame = match read_frame(&mut reader) {
                    Ok(Some(v)) => v,
                    Ok(None) => break,
                    Err(_) => {
                        state.lock().unwrap()["error"] = json!("gateway_protocol_error");
                        break;
                    }
                };
                let value: Value = match serde_json::from_slice(&frame) {
                    Ok(v) => v,
                    Err(_) => {
                        state.lock().unwrap()["error"] = json!("gateway_protocol_error");
                        break;
                    }
                };
                if let Some(id) = value["id"].as_str() {
                    if let Some(reply) = pending.lock().unwrap().remove(id) {
                        let result = if let Some(e) = value["error"].as_str() {
                            Err(e.to_string())
                        } else {
                            Ok(value["result"].clone())
                        };
                        let _ = reply.send(result);
                    }
                } else if value["event"] == "status" {
                    *state.lock().unwrap() = value["payload"].clone();
                }
            }
            let mut s = state.lock().unwrap();
            s["state"] = json!("stopped");
            for (_, reply) in pending.lock().unwrap().drain() {
                let _ = reply.send(Err("gateway_disconnected".into()));
            }
        });
        // Drain diagnostics so a verbose SDK cannot block the protocol. They can contain
        // platform secrets: retain only the structured, sanitized host error in the UI.
        thread::spawn(move || {
            let _ = std::io::copy(&mut BufReader::new(stderr), &mut std::io::sink());
        });
        Ok(Self {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            replies,
            snapshot,
            stopping: AtomicBool::new(false),
            stop_lock: Mutex::new(()),
        })
    }
    pub fn snapshot(&self) -> Value {
        self.snapshot.lock().unwrap().clone()
    }
    pub fn alive(&self) -> bool {
        !self.stopping.load(Ordering::Acquire)
            && matches!(self.child.lock().unwrap().try_wait(), Ok(None))
            && self.snapshot.lock().unwrap()["state"] != "stopped"
    }
    pub fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        if !self.alive() {
            return Err("gateway_not_running".into());
        }
        let id = random_id();
        let (tx, rx) = mpsc::sync_channel(1);
        let bytes = serde_json::to_vec(&json!({"id":id,"method":method,"params":params}))
            .map_err(|e| e.to_string())?;
        if bytes.len() > FRAME_LIMIT {
            return Err("gateway_request_too_large".into());
        }
        self.replies.lock().unwrap().insert(id.clone(), tx);
        let mut pipe = self.stdin.lock().unwrap();
        let write = write_frame(&mut *pipe, &bytes);
        drop(pipe);
        if write.is_err() {
            self.replies.lock().unwrap().remove(&id);
            self.snapshot.lock().unwrap()["state"] = json!("stopped");
            return Err("gateway_disconnected".into());
        }
        let reply = rx
            .recv_timeout(Duration::from_secs(40))
            .map_err(|_| "gateway_response_unknown".to_string());
        self.replies.lock().unwrap().remove(&id);
        reply?
    }
    pub fn stop(&self) {
        let _guard = self.stop_lock.lock().unwrap();
        if self.stopping.swap(true, Ordering::AcqRel) {
            return;
        }
        self.snapshot.lock().unwrap()["state"] = json!("stopped");
        for (_, reply) in self.replies.lock().unwrap().drain() {
            let _ = reply.send(Err("gateway_response_unknown".into()));
        }
        // Request shutdown without waiting for a reply, then bound the owned child's exit.
        if let Ok(mut pipe) = self.stdin.lock() {
            let _ = write_frame(
                &mut *pipe,
                b"{\"id\":\"shutdown\",\"method\":\"stop\",\"params\":{}}",
            );
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut child = self.child.lock().unwrap();
        while Instant::now() < deadline {
            if child.try_wait().ok().flatten().is_some() {
                return;
            }
            thread::sleep(Duration::from_millis(25));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}
impl Drop for GatewayProcess {
    fn drop(&mut self) {
        self.stop()
    }
}
fn write_frame(writer: &mut impl Write, bytes: &[u8]) -> Result<(), std::io::Error> {
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut frame = bytes.to_vec();
    frame.push(b'\n');
    let mut offset = 0;
    while offset < frame.len() {
        match writer.write(&frame[offset..]) {
            Ok(0) => return Err(std::io::ErrorKind::WriteZero.into()),
            Ok(n) => offset += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(5))
            }
            Err(e) => return Err(e),
        }
    }
    Ok(())
}
fn read_frame(reader: &mut impl BufRead) -> Result<Option<Vec<u8>>, String> {
    let mut frame = Vec::new();
    loop {
        let chunk = reader.fill_buf().map_err(|_| "read_error")?;
        if chunk.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                Err("truncated_frame".into())
            };
        }
        let n = chunk
            .iter()
            .position(|b| *b == b'\n')
            .map_or(chunk.len(), |i| i + 1);
        if frame.len() + n > FRAME_LIMIT {
            return Err("frame_too_large".into());
        }
        frame.extend_from_slice(&chunk[..n]);
        reader.consume(n);
        if frame.last() == Some(&b'\n') {
            return Ok(Some(frame));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(unix)]
    fn slow_host_reply_does_not_block_snapshot_and_stop_interrupts_owned_request() {
        let python = crate::hermes_bridge::test_support::python();
        let root = std::env::temp_dir().join(format!("ccem-hermes-slow-host-{}", random_id()));
        std::fs::create_dir_all(&root).unwrap();
        let host = root.join("host.py");
        std::fs::write(
            &host,
            r#"import json, sys
from pathlib import Path
boot = json.loads(sys.stdin.readline())
print(json.dumps({'event':'status','payload':{'state':'running','platforms':[]}}), flush=True)
for line in sys.stdin:
    message = json.loads(line)
    if message['method'] == 'slow':
        Path('request-started').write_text('started')
    if message['method'] == 'stop':
        break
"#,
        )
        .unwrap();
        let process =
            Arc::new(GatewayProcess::spawn(python, &host, &root, &root, json!({})).unwrap());
        let pending = process.clone();
        let (done_tx, done_rx) = mpsc::sync_channel(1);
        let worker =
            thread::spawn(move || done_tx.send(pending.request("slow", json!({}))).unwrap());
        let deadline = Instant::now() + Duration::from_secs(3);
        while !root.join("request-started").exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            root.join("request-started").exists(),
            "the real host must receive slow: python={}, alive={}, snapshot={}",
            python.display(),
            process.alive(),
            process.snapshot()
        );
        let read_started = Instant::now();
        assert_eq!(process.snapshot()["state"], "running");
        assert!(read_started.elapsed() < Duration::from_millis(250));
        let stop_started = Instant::now();
        process.stop();
        assert!(stop_started.elapsed() < Duration::from_secs(2));
        assert!(done_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .is_err());
        assert!(!process.alive());
        worker.join().unwrap();
        drop(process);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn frames_are_bounded_and_require_delimiters() {
        assert!(read_frame(&mut &b"{\"ok\":true}\n"[..]).unwrap().is_some());
        assert!(read_frame(&mut &b"{}"[..]).is_err());
        assert!(read_frame(&mut vec![b'x'; FRAME_LIMIT + 1].as_slice()).is_err());
    }
}
