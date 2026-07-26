use super::artifacts::{
    redact_browser_url, set_private_file_permissions, BrowserArtifactStore, BrowserStorageArea,
};
use super::{BrowserManager, BrowserToolRequest};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

const MAX_CONSOLE_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_AUDIT_FILE_BYTES: u64 = 4 * 1024 * 1024;
const CONSOLE_BACKUPS: usize = 3;
const AUDIT_BACKUPS: usize = 5;
const MAX_CONSOLE_DRAIN_EVENTS: usize = 200;
const MAX_RECENT_CONSOLE_EVENTS: usize = 20;
const MAX_AUDIT_REQUEST_ID_CHARS: usize = 256;
const MAX_AUDIT_TOOL_CHARS: usize = 64;

#[derive(Debug, Clone, Serialize)]
pub struct BrowserRecentArtifact {
    pub kind: String,
    pub path: String,
    pub file_name: String,
    pub byte_size: u64,
    pub modified_at: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct BrowserRecentActivity {
    pub artifacts: Vec<BrowserRecentArtifact>,
    pub console_log_path: Option<String>,
    pub audit_log_path: Option<String>,
}

pub(super) struct BrowserLogStore {
    write_lock: Mutex<()>,
}

impl Default for BrowserLogStore {
    fn default() -> Self {
        Self {
            write_lock: Mutex::new(()),
        }
    }
}

impl BrowserLogStore {
    fn append_console_events(
        &self,
        artifacts: &BrowserArtifactStore,
        workspace_dir: &str,
        session_id: &str,
        events: &[Value],
        dropped: u64,
    ) -> Result<Value, String> {
        let location = artifacts.location(workspace_dir, session_id, BrowserStorageArea::Logs)?;
        let path = location.directory.join("console.jsonl");
        let captured_at = Utc::now().to_rfc3339();
        let mut normalized = events
            .iter()
            .take(MAX_CONSOLE_DRAIN_EVENTS)
            .map(|event| normalize_console_event(event, &captured_at))
            .collect::<Vec<_>>();
        if dropped > 0 {
            normalized.push(json!({
                "schema_version": 1,
                "kind": "console_dropped",
                "captured_at": captured_at,
                "dropped": dropped,
                "untrusted": true,
            }));
        }
        self.append_jsonl(&path, &normalized, MAX_CONSOLE_FILE_BYTES, CONSOLE_BACKUPS)?;
        self.console_summary(&path, normalized.len(), dropped)
    }

    fn console_summary(
        &self,
        path: &Path,
        captured_count: usize,
        dropped: u64,
    ) -> Result<Value, String> {
        self.ensure_private_file(path)?;
        let content = fs::read_to_string(path).map_err(|error| {
            format!(
                "Failed to read browser console log {}: {error}",
                path.display()
            )
        })?;
        let mut parsed = Vec::new();
        let mut invalid_line_count = 0_u64;
        for line in content.lines().filter(|line| !line.trim().is_empty()) {
            match serde_json::from_str::<Value>(line) {
                Ok(value) => parsed.push(value),
                Err(_) => invalid_line_count = invalid_line_count.saturating_add(1),
            }
        }
        let recent_start = parsed.len().saturating_sub(MAX_RECENT_CONSOLE_EVENTS);
        Ok(json!({
            "path": canonical_path_string(path)?,
            "event_count": parsed.len(),
            "captured_count": captured_count,
            "dropped": dropped,
            "invalid_line_count": invalid_line_count,
            "recent": parsed.split_off(recent_start),
            "untrusted": true,
        }))
    }

    fn append_audit_event(
        &self,
        artifacts: &BrowserArtifactStore,
        workspace_dir: &str,
        session_id: &str,
        event: Value,
    ) -> Result<String, String> {
        let location = artifacts.location(workspace_dir, session_id, BrowserStorageArea::Audit)?;
        let path = location.directory.join("actions.jsonl");
        self.append_jsonl(&path, &[event], MAX_AUDIT_FILE_BYTES, AUDIT_BACKUPS)?;
        canonical_path_string(&path)
    }

    fn recent_activity(
        &self,
        artifacts: &BrowserArtifactStore,
        workspace_dir: &str,
        session_id: &str,
    ) -> Result<BrowserRecentActivity, String> {
        let artifact_location =
            artifacts.location(workspace_dir, session_id, BrowserStorageArea::Artifacts)?;
        let mut recent = Vec::new();
        for entry in fs::read_dir(&artifact_location.directory).map_err(|error| {
            format!(
                "Failed to list browser artifacts {}: {error}",
                artifact_location.directory.display()
            )
        })? {
            let entry =
                entry.map_err(|error| format!("Failed to inspect browser artifact: {error}"))?;
            if !entry
                .file_type()
                .map_err(|error| format!("Failed to inspect browser artifact type: {error}"))?
                .is_file()
            {
                continue;
            }
            let metadata = entry
                .metadata()
                .map_err(|error| format!("Failed to read browser artifact metadata: {error}"))?;
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let kind = if file_name.starts_with("screenshot-") {
                "screenshot"
            } else if file_name.starts_with("snapshot-") {
                "interaction_snapshot"
            } else {
                continue;
            };
            let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            recent.push((
                modified,
                BrowserRecentArtifact {
                    kind: kind.to_string(),
                    path: canonical_path_string(&entry.path())?,
                    file_name,
                    byte_size: metadata.len(),
                    modified_at: DateTime::<Utc>::from(modified).to_rfc3339(),
                },
            ));
        }
        recent.sort_by_key(|entry| std::cmp::Reverse(entry.0));
        let logs = artifacts.location(workspace_dir, session_id, BrowserStorageArea::Logs)?;
        let audit = artifacts.location(workspace_dir, session_id, BrowserStorageArea::Audit)?;
        Ok(BrowserRecentActivity {
            artifacts: recent
                .into_iter()
                .take(8)
                .map(|(_, artifact)| artifact)
                .collect(),
            console_log_path: existing_canonical_path(&logs.directory.join("console.jsonl"))?,
            audit_log_path: existing_canonical_path(&audit.directory.join("actions.jsonl"))?,
        })
    }

    fn append_jsonl(
        &self,
        path: &Path,
        values: &[Value],
        max_bytes: u64,
        backup_count: usize,
    ) -> Result<(), String> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| "Browser log store is unavailable.".to_string())?;
        let mut encoded = Vec::new();
        for value in values {
            serde_json::to_writer(&mut encoded, value)
                .map_err(|error| format!("Failed to encode browser log event: {error}"))?;
            encoded.push(b'\n');
        }
        let current_size = fs::metadata(path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if current_size > 0 && current_size.saturating_add(encoded.len() as u64) > max_bytes {
            rotate_log(path, backup_count)?;
        }
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(path)
            .map_err(|error| format!("Failed to open browser log {}: {error}", path.display()))?;
        file.write_all(&encoded)
            .map_err(|error| format!("Failed to append browser log {}: {error}", path.display()))?;
        file.flush()
            .map_err(|error| format!("Failed to flush browser log {}: {error}", path.display()))?;
        set_private_file_permissions(path)
    }

    fn ensure_private_file(&self, path: &Path) -> Result<(), String> {
        if !path.exists() {
            self.append_jsonl(path, &[], MAX_CONSOLE_FILE_BYTES, CONSOLE_BACKUPS)?;
        }
        set_private_file_permissions(path)
    }
}

impl BrowserManager {
    pub(super) fn drain_console_log(
        &self,
        app: &tauri::AppHandle,
        session_id: &str,
        workspace_dir: &str,
    ) -> Result<Value, String> {
        let drained = self.eval_json(app, Some(session_id), CONSOLE_DRAIN_SCRIPT)?;
        let events = drained
            .get("events")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let dropped = drained.get("dropped").and_then(Value::as_u64).unwrap_or(0);
        self.logs.append_console_events(
            &self.artifacts,
            workspace_dir,
            session_id,
            &events,
            dropped,
        )
    }

    pub(super) fn read_console_log(
        &self,
        app: &tauri::AppHandle,
        session_id: &str,
        workspace_dir: &str,
    ) -> Result<Value, String> {
        self.drain_console_log(app, session_id, workspace_dir)
    }

    pub(crate) fn audit_policy_decision(
        &self,
        workspace_dir: &str,
        session_id: &str,
        permission_mode: &str,
        request: &BrowserToolRequest,
        allowed: bool,
        reason: Option<&str>,
    ) -> Result<String, String> {
        let event = json!({
            "schema_version": 1,
            "event": "policy_decision",
            "timestamp": Utc::now().to_rfc3339(),
            "request_id": bounded_audit_field(&request.request_id, MAX_AUDIT_REQUEST_ID_CHARS),
            "tool": bounded_audit_field(&request.tool, MAX_AUDIT_TOOL_CHARS),
            "permission_mode": permission_mode,
            "allowed": allowed,
            "reason": reason.map(redact_console_text),
            "args": summarize_tool_args(request),
        });
        self.logs
            .append_audit_event(&self.artifacts, workspace_dir, session_id, event)
    }

    pub(super) fn audit_tool_result(
        &self,
        workspace_dir: &str,
        session_id: &str,
        request: &BrowserToolRequest,
        duration_ms: u128,
        result: &Result<Value, String>,
    ) -> Result<String, String> {
        let event = json!({
            "schema_version": 1,
            "event": "action_result",
            "timestamp": Utc::now().to_rfc3339(),
            "request_id": bounded_audit_field(&request.request_id, MAX_AUDIT_REQUEST_ID_CHARS),
            "tool": bounded_audit_field(&request.tool, MAX_AUDIT_TOOL_CHARS),
            "ok": result.is_ok(),
            "duration_ms": duration_ms.min(u128::from(u64::MAX)) as u64,
            "error": result.as_ref().err().map(|error| redact_console_text(error)),
        });
        self.logs
            .append_audit_event(&self.artifacts, workspace_dir, session_id, event)
    }

    pub fn recent_activity(&self, session_id: &str) -> Result<BrowserRecentActivity, String> {
        let session = self.session_snapshot(session_id)?;
        let Some(workspace_dir) = session.workspace_dir.as_deref() else {
            return Ok(BrowserRecentActivity::default());
        };
        self.logs
            .recent_activity(&self.artifacts, workspace_dir, session_id)
    }
}

fn normalize_console_event(event: &Value, captured_at: &str) -> Value {
    let level = event
        .get("level")
        .and_then(Value::as_str)
        .filter(|level| matches!(*level, "debug" | "log" | "info" | "warn" | "error"))
        .unwrap_or("log");
    let message = event
        .get("message")
        .and_then(Value::as_str)
        .map(redact_console_text)
        .unwrap_or_default();
    let frame_url = event
        .get("frame_url")
        .and_then(Value::as_str)
        .map(redact_browser_url);
    json!({
        "schema_version": 1,
        "kind": "console",
        "captured_at": captured_at,
        "page_timestamp": event.get("page_timestamp").and_then(Value::as_f64),
        "level": level,
        "message": message,
        "frame_url": frame_url,
        "source": {
            "file": event.pointer("/source/file").and_then(Value::as_str).map(redact_browser_url),
            "line": event.pointer("/source/line").and_then(Value::as_u64),
            "column": event.pointer("/source/column").and_then(Value::as_u64),
        },
        "untrusted": true,
    })
}

fn summarize_tool_args(request: &BrowserToolRequest) -> Value {
    match request.tool.as_str() {
        "navigate" => json!({
            "url": request.args.get("url").and_then(Value::as_str).map(redact_browser_url),
        }),
        "click" => json!({
            "ref": request.args.get("ref").and_then(Value::as_u64),
            "snapshot_id_prefix": request.args.get("snapshotId").and_then(Value::as_str).map(|value| value.chars().take(12).collect::<String>()),
        }),
        "type" => json!({
            "ref": request.args.get("ref").and_then(Value::as_u64),
            "snapshot_id_prefix": request.args.get("snapshotId").and_then(Value::as_str).map(|value| value.chars().take(12).collect::<String>()),
            "text_chars": request.args.get("text").and_then(Value::as_str).map(|value| value.chars().count()),
        }),
        "evaluate" => {
            let script = request
                .args
                .get("script")
                .and_then(Value::as_str)
                .unwrap_or_default();
            json!({
                "script_chars": script.chars().count(),
                "script_sha256": hex::encode(Sha256::digest(script.as_bytes())),
            })
        }
        "wait_for" => {
            let text = request
                .args
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default();
            json!({
                "text_chars": text.chars().count(),
                "text_sha256": hex::encode(Sha256::digest(text.as_bytes())),
                "timeout_ms": request.args.get("timeoutMs").and_then(Value::as_u64),
            })
        }
        "scroll" => json!({
            "delta_y": request.args.get("deltaY").or_else(|| request.args.get("delta_y")).and_then(Value::as_f64),
        }),
        _ => Value::Object(Map::new()),
    }
}

fn redact_console_text(value: &str) -> String {
    let truncated = value.chars().take(8_000).collect::<String>();
    if let Ok(mut json) = serde_json::from_str::<Value>(&truncated) {
        redact_json_secrets(&mut json, None);
        return serde_json::to_string(&json).unwrap_or_else(|_| "[REDACTED]".to_string());
    }
    let mut output = Vec::new();
    let mut redact_next = false;
    for token in truncated.split_whitespace() {
        let lowercase = token.to_ascii_lowercase();
        let assignment_key = lowercase
            .split(['=', ':'])
            .next()
            .unwrap_or_default()
            .trim_matches(|character: char| !character.is_ascii_alphanumeric() && character != '_');
        if secret_key(assignment_key) && (token.contains('=') || token.contains(':')) {
            let separator = if token.contains('=') { '=' } else { ':' };
            output.push(format!("{assignment_key}{separator}[REDACTED]"));
            if secret_header_key(assignment_key) {
                break;
            }
            redact_next = false;
        } else if redact_next {
            output.push("[REDACTED]".to_string());
            redact_next = false;
        } else {
            output.push(token.to_string());
            redact_next = lowercase == "bearer" || secret_key(&lowercase);
        }
    }
    output.join(" ")
}

fn bounded_audit_field(value: &str, max_chars: usize) -> String {
    redact_console_text(&value.chars().take(max_chars).collect::<String>())
}

fn redact_json_secrets(value: &mut Value, key: Option<&str>) {
    if key.is_some_and(secret_key) {
        *value = Value::String("[REDACTED]".to_string());
        return;
    }
    match value {
        Value::Object(object) => {
            for (child_key, child) in object {
                redact_json_secrets(child, Some(child_key));
            }
        }
        Value::Array(values) => {
            for child in values {
                redact_json_secrets(child, None);
            }
        }
        _ => {}
    }
}

fn secret_key(value: &str) -> bool {
    let normalized = value
        .to_ascii_lowercase()
        .replace(['-', '.', '[', ']'], "_");
    matches!(
        normalized.as_str(),
        "authorization"
            | "auth"
            | "cookie"
            | "set_cookie"
            | "password"
            | "passwd"
            | "secret"
            | "token"
            | "access_token"
            | "refresh_token"
            | "api_key"
            | "apikey"
            | "otp"
            | "one_time_code"
    ) || normalized.contains("token")
        || normalized.contains("password")
        || normalized.contains("secret")
}

fn secret_header_key(value: &str) -> bool {
    matches!(
        value
            .to_ascii_lowercase()
            .replace(['-', '.', '[', ']'], "_")
            .as_str(),
        "authorization" | "cookie" | "set_cookie"
    )
}

fn rotate_log(path: &Path, backup_count: usize) -> Result<(), String> {
    if backup_count == 0 {
        fs::remove_file(path)
            .map_err(|error| format!("Failed to rotate browser log {}: {error}", path.display()))?;
        return Ok(());
    }
    for index in (1..=backup_count).rev() {
        let source = if index == 1 {
            path.to_path_buf()
        } else {
            backup_path(path, index - 1)
        };
        if !source.exists() {
            continue;
        }
        let target = backup_path(path, index);
        if target.exists() {
            fs::remove_file(&target).map_err(|error| {
                format!(
                    "Failed to replace browser log backup {}: {error}",
                    target.display()
                )
            })?;
        }
        fs::rename(&source, &target).map_err(|error| {
            format!(
                "Failed to rotate browser log {} to {}: {error}",
                source.display(),
                target.display()
            )
        })?;
    }
    Ok(())
}

fn backup_path(path: &Path, index: usize) -> PathBuf {
    let mut value: OsString = path.as_os_str().to_os_string();
    value.push(format!(".{index}"));
    PathBuf::from(value)
}

fn canonical_path_string(path: &Path) -> Result<String, String> {
    path.canonicalize()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| format!("Failed to resolve browser log {}: {error}", path.display()))
}

fn existing_canonical_path(path: &Path) -> Result<Option<String>, String> {
    if path.is_file() {
        canonical_path_string(path).map(Some)
    } else {
        Ok(None)
    }
}

pub(super) const BROWSER_CONSOLE_INIT_SCRIPT: &str = r#"
(() => {
  if (window.__ccemConsoleBridge) return;
  const queue = [];
  let dropped = 0;
  const limit = 500;
  const safeValue = (value) => {
    try {
      if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack || ''}`.slice(0, 4000);
      if (typeof value === 'string') return value.slice(0, 4000);
      const encoded = JSON.stringify(value);
      return (encoded === undefined ? String(value) : encoded).slice(0, 4000);
    } catch (_) {
      try { return String(value).slice(0, 4000); } catch (_) { return '[unserializable]'; }
    }
  };
  const push = (level, values, source) => {
    if (queue.length >= limit) {
      queue.shift();
      dropped += 1;
    }
    queue.push({
      level,
      message: values.map(safeValue).join(' ').slice(0, 8000),
      page_timestamp: Date.now(),
      frame_url: location.href,
      source: source || null,
    });
  };
  for (const level of ['debug', 'log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...values) => {
      push(level, values, null);
      return original(...values);
    };
  }
  window.addEventListener('error', (event) => {
    push('error', [event.message || event.error || 'window error'], {
      file: event.filename || null,
      line: event.lineno || null,
      column: event.colno || null,
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    push('error', ['Unhandled promise rejection', event.reason], null);
  });
  const bridge = Object.freeze({
    drain(maxEvents = 200) {
      const count = Math.max(0, Math.min(Number(maxEvents) || 0, 200));
      const events = queue.splice(0, count);
      const droppedSinceLastDrain = dropped;
      dropped = 0;
      return { events, dropped: droppedSinceLastDrain };
    },
  });
  Object.defineProperty(window, '__ccemConsoleBridge', {
    value: bridge,
    configurable: false,
    enumerable: false,
    writable: false,
  });
})()
"#;

const CONSOLE_DRAIN_SCRIPT: &str = r#"
(() => {
  const bridge = window.__ccemConsoleBridge;
  if (!bridge || typeof bridge.drain !== 'function') return { events: [], dropped: 0 };
  return bridge.drain(200);
})()
"#;

#[cfg(test)]
mod tests {
    use super::{
        backup_path, bounded_audit_field, normalize_console_event, redact_console_text, rotate_log,
        summarize_tool_args, BrowserLogStore,
    };
    use crate::browser::BrowserToolRequest;
    use serde_json::json;
    use std::fs;

    #[test]
    fn console_events_are_bounded_redacted_and_marked_untrusted() {
        let event = normalize_console_event(
            &json!({
                "level": "error",
                "message": "{\"token\":\"raw-secret\",\"safe\":\"visible\"}",
                "frame_url": "https://example.test/?access_token=raw-secret",
            }),
            "2026-07-10T00:00:00Z",
        );

        assert_eq!(event["untrusted"], true);
        assert_eq!(
            event["message"],
            "{\"safe\":\"visible\",\"token\":\"[REDACTED]\"}"
        );
        assert!(!event["frame_url"]
            .as_str()
            .expect("frame url")
            .contains("raw-secret"));
        assert_eq!(
            redact_console_text("Authorization: Bearer abc123"),
            "authorization:[REDACTED]"
        );
        assert_eq!(
            redact_console_text("Cookie: session=abc123 retained=no"),
            "cookie:[REDACTED]"
        );
    }

    #[test]
    fn audit_argument_summary_never_persists_typed_text_or_scripts() {
        let typed = BrowserToolRequest {
            request_id: "type-1".to_string(),
            tool: "type".to_string(),
            args: json!({ "snapshotId": "snapshot-secret", "ref": 2, "text": "private value" }),
        };
        let typed_summary = summarize_tool_args(&typed);
        assert_eq!(typed_summary["text_chars"], 13);
        assert!(!typed_summary.to_string().contains("private value"));

        let evaluate = BrowserToolRequest {
            request_id: "eval-1".to_string(),
            tool: "evaluate".to_string(),
            args: json!({ "script": "window.secret = 'value'" }),
        };
        let evaluate_summary = summarize_tool_args(&evaluate);
        assert_eq!(evaluate_summary["script_chars"], 23);
        assert!(!evaluate_summary.to_string().contains("window.secret"));

        assert_eq!(bounded_audit_field(&"x".repeat(300), 256).len(), 256);
    }

    #[test]
    fn jsonl_rotation_keeps_bounded_private_backups() {
        let temp = tempfile::tempdir().expect("temp logs");
        let path = temp.path().join("console.jsonl");
        fs::write(&path, "old\n").expect("seed log");
        rotate_log(&path, 2).expect("rotate once");
        fs::write(&path, "new\n").expect("new log");
        rotate_log(&path, 2).expect("rotate twice");

        assert_eq!(
            fs::read_to_string(backup_path(&path, 1)).expect("first backup"),
            "new\n"
        );
        assert_eq!(
            fs::read_to_string(backup_path(&path, 2)).expect("second backup"),
            "old\n"
        );
        let _store = BrowserLogStore::default();
    }
}
