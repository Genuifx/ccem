//! DSH History adapter — read-only integration with DeepSeek Harness sessions.
//!
//! Invokes the bundled `dsh-history-helper.mjs` via `ccem-node` as a short-lived
//! one-shot subprocess. The helper reads DSH session logs and returns structured
//! JSON; this module validates the response schema, enforces timeouts and size
//! limits, and maps errors into typed variants.
//!
//! **Phase 1**: No Tauri commands exposed. History/Analytics will call this
//! adapter internally in Phase 2/3.
//!
//! Subprocess execution and platform I/O helpers live in `dsh_history_process`.

#[path = "dsh_history_lifecycle.rs"]
pub(crate) mod lifecycle;

#[path = "dsh_history_process.rs"]
pub(crate) mod process;
use process::invoke_helper_core;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;
#[cfg(test)]
use std::time::Instant;
use tauri::AppHandle;
use tauri::Manager;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// Maximum time the helper is allowed to run (30 seconds).
const DSH_HELPER_TIMEOUT: Duration = Duration::from_secs(30);
/// Maximum stdout the helper is allowed to produce (64 MiB).
const DSH_HELPER_MAX_STDOUT_BYTES: usize = 64 * 1024 * 1024;
/// Maximum stderr the helper is allowed to produce (1 MiB).
const DSH_HELPER_MAX_STDERR_BYTES: usize = 1024 * 1024;
const DSH_HELPER_FILENAME: &str = "dsh-history-helper.mjs";
/// Relative path within the dsh-history directory resource.
const DSH_HELPER_RELATIVE: &str = "lib/dsh-history-helper.mjs";
/// Expected DSH protocol version for envelope validation.
pub(crate) const DSH_EXPECTED_VERSION: &str = "0.1.1-rc.2";

// ---------------------------------------------------------------------------
// Request / Response types (mirror the helper JSON protocol)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "op")]
pub enum DshHistoryRequest {
    #[serde(rename = "list")]
    List { roots: Vec<String>, limit: Option<u32> },
    #[serde(rename = "detail")]
    Detail {
        #[serde(rename = "sourceInstanceId")]
        source_instance_id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    #[serde(rename = "usage")]
    Usage { roots: Vec<String> },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum DshHistoryResponse<T> {
    Ok {
        ok: bool, // always true
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        #[serde(rename = "dshVersion")]
        dsh_version: String,
        data: T,
        warnings: Vec<String>,
    },
    Err {
        ok: bool, // always false
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DshSessionListItem {
    #[serde(rename = "sourceInstanceId")]
    pub source_instance_id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub cwd: Option<String>,
    #[serde(rename = "projectName")]
    pub project_name: Option<String>,
    pub title: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "lastEventAt")]
    pub last_event_at: Option<i64>,
    pub model: Option<String>,
    pub provider: Option<String>,
    #[serde(rename = "parentSession")]
    pub parent_session: Option<String>,
    #[serde(rename = "seedLength")]
    pub seed_length: u32,
    #[serde(rename = "delegationDepth")]
    pub delegation_depth: u32,
    #[serde(rename = "eventCount")]
    pub event_count: u32,
    pub revision: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DshSessionDetail {
    #[serde(rename = "sourceInstanceId")]
    pub source_instance_id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub header: DshSessionHeader,
    pub events: Vec<DshSurfaceEvent>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DshSessionHeader {
    pub version: u32,
    pub id: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    pub cwd: Option<String>,
    #[serde(rename = "parentSession")]
    pub parent_session: Option<String>,
    #[serde(rename = "seedLength")]
    pub seed_length: u32,
    #[serde(rename = "delegationDepth")]
    pub delegation_depth: u32,
}

/// Role of a surface event: strictly 'user' or 'assistant'.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DshEventRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DshSurfaceEvent {
    pub seq: u32,
    #[serde(rename = "type")]
    pub event_type: String,
    pub time: Option<i64>,
    pub role: DshEventRole,
    pub content: Option<Vec<serde_json::Value>>,
    pub model: Option<String>,
    pub provider: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DshUsageEntry {
    #[serde(rename = "sourceInstanceId")]
    pub source_instance_id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "seedLength")]
    pub seed_length: u32,
    pub revision: Option<String>,
    pub steps: Vec<DshUsageStep>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DshUsageStep {
    pub seq: u32,
    pub turn: u32,
    pub step: u32,
    pub time: Option<i64>,
    pub provider: Option<String>,
    pub model: Option<String>,
    #[serde(rename = "inputTokens")]
    pub input_tokens: u64,
    #[serde(rename = "outputTokens")]
    pub output_tokens: u64,
    #[serde(rename = "cacheReadTokens")]
    pub cache_read_tokens: u64,
    #[serde(rename = "cacheWriteTokens")]
    pub cache_write_tokens: u64,
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum DshHistoryError {
    /// DSH home does not exist or has no sessions.
    Absent,
    /// DSH_HOME is set to a non-empty value but is invalid (not a dir, permissions, etc).
    InvalidHome(String),
    /// The helper script could not be found.
    HelperUnavailable(String),
    /// The helper timed out.
    Timeout,
    /// The helper produced oversized output.
    OutputTooLarge,
    /// The helper exited with a non-zero code or produced invalid JSON.
    HelperFailed(String),
    /// The helper returned an error response.
    SourceError { code: String, message: String },
    /// The DSH home uses an unsupported session format version.
    UnsupportedFormat(String),
    /// The DSH home is busy (locked by another writer) or corrupt.
    BusyCorrupt(String),
}

impl std::fmt::Display for DshHistoryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Absent => write!(f, "DSH home not found or empty"),
            Self::InvalidHome(msg) => write!(f, "DSH_HOME is set but invalid: {}", msg),
            Self::HelperUnavailable(msg) => write!(f, "DSH helper unavailable: {}", msg),
            Self::Timeout => write!(f, "DSH helper timed out"),
            Self::OutputTooLarge => write!(f, "DSH helper output exceeded size limit"),
            Self::HelperFailed(msg) => write!(f, "DSH helper failed: {}", msg),
            Self::SourceError { code, message } => {
                write!(f, "DSH source error [{}]: {}", code, message)
            }
            Self::UnsupportedFormat(msg) => write!(f, "DSH unsupported format: {}", msg),
            Self::BusyCorrupt(msg) => write!(f, "DSH busy or corrupt: {}", msg),
        }
    }
}

// ---------------------------------------------------------------------------
// Helper path resolution
// ---------------------------------------------------------------------------

const DSH_HELPER_RESOURCE_PATHS: [&str; 2] = [
    "resources/dsh-history/lib/dsh-history-helper.mjs",
    "dsh-history/lib/dsh-history-helper.mjs",
];

pub fn dsh_helper_script_path(app: &AppHandle) -> Result<PathBuf, DshHistoryError> {
    let source_path = source_dsh_helper_path();
    let mut resource_paths = Vec::new();

    for relative_path in DSH_HELPER_RESOURCE_PATHS {
        if let Ok(path) = app
            .path()
            .resolve(relative_path, tauri::path::BaseDirectory::Resource)
        {
            resource_paths.push(path);
        }
    }

    let include_source = cfg!(debug_assertions);
    let mut candidates = Vec::new();
    if include_source {
        candidates.push(source_path);
    }
    candidates.extend(resource_paths);

    candidates
        .iter()
        .find(|p| p.exists())
        .cloned()
        .ok_or_else(|| {
            DshHistoryError::HelperUnavailable(format!(
                "{} not found in: {}",
                DSH_HELPER_FILENAME,
                candidates
                    .iter()
                    .map(|p| p.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        })
}

fn source_dsh_helper_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("dsh-history")
        .join(DSH_HELPER_RELATIVE)
}

// ---------------------------------------------------------------------------
// Subprocess execution
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Active DSH source resolution
// ---------------------------------------------------------------------------

/// Represents a validated, active DSH source with known paths.
#[derive(Debug, Clone)]
pub struct ActiveDshSource {
    /// The DSH home directory (e.g. `~/.dsh`).
    pub home: PathBuf,
    /// The sessions root directory (home/sessions).
    pub sessions_root: PathBuf,
    /// How the source was discovered: "env" | "default".
    pub provenance: String,
}

/// Resolve the DSH home directory.
/// - If `DSH_HOME` env is set to a non-empty value: validate it as a directory.
///   If invalid → error (not silent fallback).
/// - If `DSH_HOME` is set but not valid UTF-8 → InvalidHome (fail closed, no fallback).
/// - If `DSH_HOME` is unset/empty: fallback to `~/.dsh`.
pub fn resolve_dsh_source() -> Result<ActiveDshSource, DshHistoryError> {
    use std::ffi::OsStr;

    match std::env::var_os("DSH_HOME") {
        None => {
            // Truly unset → fallback to ~/.dsh
            let home = dirs::home_dir().ok_or(DshHistoryError::Absent)?;
            let dsh_home = home.join(".dsh");
            if !dsh_home.is_dir() {
                return Err(DshHistoryError::Absent);
            }
            let sessions = dsh_home.join("sessions");
            Ok(ActiveDshSource {
                home: dsh_home,
                sessions_root: sessions,
                provenance: "default".to_string(),
            })
        }
        Some(ref val) if val.is_empty() || val == OsStr::new("") => {
            // Explicitly empty → treat as unset, fallback to ~/.dsh
            let home = dirs::home_dir().ok_or(DshHistoryError::Absent)?;
            let dsh_home = home.join(".dsh");
            if !dsh_home.is_dir() {
                return Err(DshHistoryError::Absent);
            }
            let sessions = dsh_home.join("sessions");
            Ok(ActiveDshSource {
                home: dsh_home,
                sessions_root: sessions,
                provenance: "default".to_string(),
            })
        }
        Some(val) => {
            // Non-empty OsString — check if it's valid UTF-8
            match val.to_str() {
                None => {
                    // Non-UTF8: fail closed, do NOT fall back to ~/.dsh
                    Err(DshHistoryError::InvalidHome(
                        "DSH_HOME contains non-UTF8 bytes".to_string(),
                    ))
                }
                Some(s) => {
                    let path = PathBuf::from(s);
                    if !path.is_dir() {
                        return Err(DshHistoryError::InvalidHome(format!(
                            "DSH_HOME={} is not a valid directory",
                            s
                        )));
                    }
                    let sessions = path.join("sessions");
                    Ok(ActiveDshSource {
                        home: path,
                        sessions_root: sessions,
                        provenance: "env".to_string(),
                    })
                }
            }
        }
    }
}

/// Legacy resolve that returns Option (for backward compat in tests).
pub fn resolve_dsh_home() -> Option<PathBuf> {
    resolve_dsh_source().ok().map(|s| s.home)
}

/// Sidecar binary name — matches externalBin in tauri.conf.json.
/// Tauri strips the target triple when bundling into Contents/MacOS/.
const CCEM_NODE_SIDECAR_NAME: &str = "ccem-node";

/// Resolve the bundled ccem-node sidecar binary path.
///
/// Uses the same anchor as `runtime.rs::native_sidecar_exe_anchor()`:
/// `current_exe().parent()` which is `Contents/MacOS/` in release and
/// `target/{debug,release}/` in dev — both hold the sidecar.
fn resolve_ccem_node_path(_app: &AppHandle) -> Result<PathBuf, DshHistoryError> {
    resolve_ccem_node_path_from_exe(std::env::current_exe().ok())
}

/// Factored core so tests can inject a fake exe path.
fn resolve_ccem_node_path_from_exe(exe: Option<PathBuf>) -> Result<PathBuf, DshHistoryError> {
    let exe_dir = exe
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .ok_or_else(|| DshHistoryError::HelperUnavailable(
            "cannot determine app executable directory".to_string(),
        ))?;

    // Primary: bare name (release macOS: Contents/MacOS/ccem-node, dev: target/debug/ccem-node)
    let bare = exe_dir.join(CCEM_NODE_SIDECAR_NAME);
    let primary = if cfg!(windows) { bare.with_extension("exe") } else { bare };
    if primary.exists() {
        return Ok(primary);
    }

    Err(DshHistoryError::HelperUnavailable(
        format!("ccem-node sidecar not found at {}", primary.display()),
    ))
}

// ---------------------------------------------------------------------------
// Invocation policy (pub(crate) so dsh_history_process can access)
// ---------------------------------------------------------------------------

/// Invocation policy: configurable limits for the subprocess lifecycle.
/// Production code uses `InvocationLimits::production()`; tests can override.
#[derive(Debug, Clone)]
pub(crate) struct InvocationLimits {
    pub(crate) timeout: Duration,
    pub(crate) max_stdout_bytes: usize,
    pub(crate) max_stderr_bytes: usize,
}

impl InvocationLimits {
    pub(crate) fn production() -> Self {
        Self {
            timeout: DSH_HELPER_TIMEOUT,
            max_stdout_bytes: DSH_HELPER_MAX_STDOUT_BYTES,
            max_stderr_bytes: DSH_HELPER_MAX_STDERR_BYTES,
        }
    }
}

/// Allowed env var names for the subprocess. Only HOME, PATH, TMPDIR pass through
/// from the parent; __DSH_HISTORY_ROOTS is injected. Everything else is blocked.
const ENV_ALLOWLIST_KEYS: &[&str] = &["HOME", "PATH", "TMPDIR"];

/// Build the environment allowlist for the subprocess.
/// Reads only HOME/PATH/TMPDIR from the current process and appends __DSH_HISTORY_ROOTS.
pub(crate) fn build_env_allowlist(roots_json: &str) -> Vec<(&'static str, String)> {
    let mut list = Vec::with_capacity(4);
    for &key in ENV_ALLOWLIST_KEYS {
        if let Ok(v) = std::env::var(key) {
            list.push((key, v));
        }
    }
    list.push(("__DSH_HISTORY_ROOTS", roots_json.to_string()));
    list
}

// ---------------------------------------------------------------------------
// Production wrapper and async API
// ---------------------------------------------------------------------------

/// Production wrapper — calls `invoke_helper_core` with production limits.
fn invoke_dsh_helper_blocking<T: for<'de> Deserialize<'de>>(
    helper_path: PathBuf,
    ccem_node: PathBuf,
    request_json: String,
    roots_json: String,
) -> Result<(T, Vec<String>), DshHistoryError> {
    invoke_helper_core(helper_path, ccem_node, request_json, roots_json, &InvocationLimits::production())
}

/// Execute the DSH history helper asynchronously via spawn_blocking.
pub async fn invoke_dsh_helper<T: for<'de> Deserialize<'de> + Send + 'static>(
    app: &AppHandle,
    request: &DshHistoryRequest,
    roots: &[String],
) -> Result<(T, Vec<String>), DshHistoryError> {
    let helper_path = dsh_helper_script_path(app)?;
    let ccem_node = resolve_ccem_node_path(app)?;

    let request_json =
        serde_json::to_string(request).map_err(|e| DshHistoryError::HelperFailed(e.to_string()))?;
    let roots_json =
        serde_json::to_string(roots).map_err(|e| DshHistoryError::HelperFailed(e.to_string()))?;

    tauri::async_runtime::spawn_blocking(move || {
        invoke_dsh_helper_blocking::<T>(helper_path, ccem_node, request_json, roots_json)
    })
    .await
    .map_err(|e| DshHistoryError::HelperFailed(format!("spawn_blocking join: {}", e)))?
}
#[cfg(test)]
#[path = "dsh_history_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "dsh_history_process_tests.rs"]
mod process_tests;
