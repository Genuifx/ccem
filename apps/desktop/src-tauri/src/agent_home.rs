//! CCEM-owned agent state. Official homes are read only for snapshots and imports.

#[path = "agent_plugins.rs"]
mod plugins;

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};

const MIGRATION_MARKER: &str = ".ccem-migration-v1.json";
const MIGRATION_LOCK: &str = ".ccem-migration.lock";
const CLAUDE_SNAPSHOT_PATHS: &[&str] = &[
    "projects",
    "history.jsonl",
    "plans",
    "file-history",
    "CLAUDE.md",
];
const CODEX_SNAPSHOT_PATHS: &[&str] = &[
    "sessions",
    "archived_sessions",
    "history.jsonl",
    "session_index.jsonl",
    "memories",
    "memories_v2",
    "AGENTS.md",
    "AGENTS.override.md",
];
static PREPARATION_LOCK: Mutex<()> = Mutex::new(());
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn agent_base() -> PathBuf {
    std::env::var("CCEM_AGENT_HOME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::config::get_ccem_dir().join("agents"))
}

pub fn claude_home() -> PathBuf {
    agent_base().join("claude")
}
pub fn codex_home() -> PathBuf {
    codex_home_for_mode(codex_isolated())
}
pub fn isolated_codex_home() -> PathBuf {
    agent_base().join("codex")
}
pub fn codex_home_for_mode(isolated: bool) -> PathBuf {
    if isolated {
        return isolated_codex_home();
    }
    resolve_shared_codex_home(
        &dirs::home_dir().unwrap_or_default(),
        std::env::var("CODEX_HOME").ok().as_deref(),
        &std::env::current_dir().unwrap_or_default(),
    )
}

fn resolve_shared_codex_home(home: &Path, configured: Option<&str>, cwd: &Path) -> PathBuf {
    match configured.map(str::trim).filter(|value| !value.is_empty()) {
        None => home.join(".codex"),
        Some("~") => home.to_path_buf(),
        Some(value) if value.starts_with("~/") => home.join(&value[2..]),
        Some(value) => {
            let path = PathBuf::from(value);
            if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            }
        }
    }
}

fn read_profile_preferences(base: &Path) -> Result<serde_json::Value, String> {
    let path = base.join("profiles.json");
    validate_no_symlinks(&path)?;
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(serde_json::json!({})),
        Err(error) => {
            return Err(format!(
                "Could not read CCEM agent profile preferences: {error}"
            ))
        }
    };
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Invalid CCEM agent profile preferences".to_string())?;
    if !value.is_object()
        || value
            .get("codexIsolation")
            .is_some_and(|value| !value.is_boolean())
    {
        return Err("Invalid Codex isolation preference".into());
    }
    Ok(value)
}

pub fn codex_isolation_preference() -> Result<bool, String> {
    read_codex_isolation_preference(&agent_base())
}

fn read_codex_isolation_preference(base: &Path) -> Result<bool, String> {
    Ok(read_profile_preferences(base)?
        .get("codexIsolation")
        .and_then(|value| value.as_bool())
        .unwrap_or(false))
}

fn codex_isolation_from(pin: Option<&str>, base: &Path) -> Result<bool, String> {
    match pin {
        Some("1") => Ok(true),
        Some("0") => Ok(false),
        _ => read_codex_isolation_preference(base),
    }
}

fn configured_codex_isolation() -> Result<bool, String> {
    codex_isolation_from(
        std::env::var("CCEM_CODEX_ISOLATED").ok().as_deref(),
        &agent_base(),
    )
}

pub fn codex_isolated() -> bool {
    // A broken preference must never silently reconnect an isolated profile
    // to shared state. Launch preparation returns the underlying error.
    configured_codex_isolation().unwrap_or(true)
}

pub fn claude_config_path() -> PathBuf {
    claude_home().join(".claude.json")
}

/// Claude is always isolated. Codex keeps its official home unless the user
/// selected isolation or this process carries a pinned session mode.
pub fn ensure_agent_homes() -> Result<(), String> {
    prepare_agent_homes_for_mode(configured_codex_isolation()?)
}

pub fn prepare_codex_isolation() -> Result<(), String> {
    prepare_agent_homes_for_mode(true)
}

pub fn codex_isolation_needs_preparation() -> Result<bool, String> {
    Ok(!migration_complete(&isolated_codex_home())?)
}

pub fn prepare_agent_homes_for_mode(isolated: bool) -> Result<(), String> {
    // Existing command tests use production entry points. A test must opt into
    // a fixture base before preparation may touch disk; migration tests below
    // call the explicit-home seam and never inspect a developer's real home.
    #[cfg(test)]
    let home = match std::env::var_os("CCEM_AGENT_TEST_SOURCE_HOME") {
        Some(home) if std::env::var_os("CCEM_AGENT_HOME").is_some() => PathBuf::from(home),
        _ => return Ok(()),
    };
    #[cfg(not(test))]
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    #[cfg(test)]
    return ensure_agent_homes_for_mode_with_guard(
        &home,
        &agent_base(),
        &home.join(".codex"),
        isolated,
        |_, _, _, _| Ok(()),
    );
    #[cfg(not(test))]
    ensure_agent_homes_for_mode_with_guard(
        &home,
        &agent_base(),
        &codex_home_for_mode(false),
        isolated,
        ensure_no_legacy_writers,
    )
}

#[cfg(test)]
pub(crate) fn ensure_agent_homes_at(home: &Path, base: &Path) -> Result<(), String> {
    ensure_agent_homes_with_guard(home, base, |_, _, _| Ok(()))
}

fn ensure_agent_homes_with_guard(
    home: &Path,
    base: &Path,
    guard: impl FnOnce(&Path, &Path, &[&str]) -> Result<(), String>,
) -> Result<(), String> {
    ensure_agent_homes_for_mode_with_guard(
        home,
        base,
        &home.join(".codex"),
        true,
        |home, base, _, pending| guard(home, base, pending),
    )
}

fn ensure_agent_homes_for_mode_with_guard(
    home: &Path,
    base: &Path,
    codex_source: &Path,
    isolated: bool,
    guard: impl FnOnce(&Path, &Path, &Path, &[&str]) -> Result<(), String>,
) -> Result<(), String> {
    let _guard = PREPARATION_LOCK
        .lock()
        .map_err(|_| "Agent home preparation lock poisoned")?;
    validate_agent_base(home, base)?;
    let history_complete = migration_complete(&base.join("claude"))?
        && (!isolated || migration_complete(&base.join("codex"))?);
    let plugin_pending = match plugins::import_pending(&home.join(".claude"), &base.join("claude"))
    {
        Ok(pending) => pending,
        Err(error) => {
            eprintln!("Claude plugin import warning: {error}");
            false
        }
    };
    if isolated && !migration_complete(&base.join("codex"))? {
        let source = resolve_existing_parent(codex_source)?;
        let target = resolve_existing_parent(base)?;
        if source.starts_with(&target) || target.starts_with(&source) {
            return Err("Shared Codex home must not overlap the CCEM isolated profile".into());
        }
    }
    let providers = if isolated {
        &["claude", "codex"][..]
    } else {
        &["claude"][..]
    };
    for provider in providers {
        let root = base.join(provider);
        validate_no_symlinks(&root)?;
        let paths = if *provider == "claude" {
            CLAUDE_SNAPSHOT_PATHS
        } else {
            CODEX_SNAPSHOT_PATHS
        };
        for name in paths {
            validate_no_symlinks(&root.join(name))?;
        }
        validate_no_symlinks(&root.join(if *provider == "claude" {
            ".claude.json"
        } else {
            "config.toml"
        }))?;
    }
    if history_complete && !plugin_pending {
        return Ok(());
    }
    create_private_dir(base)?;
    for provider in providers {
        create_private_dir(&base.join(provider))?;
    }
    let _process_lock = match MigrationLock::acquire(base) {
        Ok(lock) => lock,
        Err(error) if history_complete => {
            eprintln!("Claude plugin import warning: {error}");
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    let pending = providers
        .iter()
        .copied()
        .filter_map(|provider| match migration_complete(&base.join(provider)) {
            Ok(false) => Some(Ok(provider)),
            Ok(true) => None,
            Err(error) => Some(Err(error)),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if !pending.is_empty() {
        guard(home, base, codex_source, &pending)?;
    }
    snapshot_provider(
        &home.join(".claude"),
        &base.join("claude"),
        CLAUDE_SNAPSHOT_PATHS,
        true,
    )?;
    if isolated {
        snapshot_provider(
            codex_source,
            &base.join("codex"),
            CODEX_SNAPSHOT_PATHS,
            false,
        )?;
    }
    if plugin_pending {
        if let Err(error) = plugins::import_plugins(&home.join(".claude"), &base.join("claude")) {
            eprintln!("Claude plugin import warning: {error}");
        }
    }
    Ok(())
}

pub fn set_codex_isolation(isolated: bool) -> Result<(), String> {
    #[cfg(test)]
    let home = std::env::var_os("CCEM_AGENT_TEST_SOURCE_HOME")
        .filter(|_| std::env::var_os("CCEM_AGENT_HOME").is_some())
        .map(PathBuf::from)
        .ok_or("Profile tests require an explicit fixture home")?;
    #[cfg(not(test))]
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    set_codex_isolation_with_prepare(&home, &agent_base(), isolated, prepare_codex_isolation)
}

fn set_codex_isolation_with_prepare(
    home: &Path,
    base: &Path,
    isolated: bool,
    prepare: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if isolated {
        prepare()?;
    }
    write_codex_isolation_preference(home, base, isolated)
}

fn write_codex_isolation_preference(
    home: &Path,
    base: &Path,
    isolated: bool,
) -> Result<(), String> {
    let _guard = PREPARATION_LOCK
        .lock()
        .map_err(|_| "Agent home preparation lock poisoned")?;
    validate_agent_base(home, base)?;
    create_private_dir(base)?;
    let _process_lock = MigrationLock::acquire(base)?;
    let mut preferences = read_profile_preferences(base)?;
    preferences["codexIsolation"] = serde_json::Value::Bool(isolated);
    let bytes = serde_json::to_vec_pretty(&preferences).map_err(|error| error.to_string())?;
    let path = base.join("profiles.json");
    let temp = base.join(format!(
        ".ccem-profile-{}-{}.tmp",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temp, &path)
    })();
    let _ = fs::remove_file(temp);
    result.map_err(|error| format!("Could not save Codex isolation preference: {error}"))?;
    sync_directory(base)
}

fn process_provider(executable: &str, command: &str) -> Option<&'static str> {
    let name = Path::new(executable)
        .file_name()?
        .to_str()?
        .to_ascii_lowercase();
    let command = command.replace('\\', "/");
    match name.as_str() {
        "claude" | "claude.exe" => Some("claude"),
        "codex" | "codex.exe" => Some("codex"),
        "node" | "node.exe" | "bun" | "bun.exe" => {
            if command.contains("native-runtime-helper.mjs") {
                Some("native")
            } else if command.contains("@anthropic-ai/claude-code/cli.js") {
                Some("claude")
            } else if command.contains("@openai/codex/bin/codex.js") {
                Some("codex")
            } else {
                None
            }
        }
        _ if (name == "ccem-node" || name == "ccem-node.exe" || name.starts_with("ccem-node-"))
            && command.contains("native-runtime-helper.mjs") =>
        {
            Some("native")
        }
        _ => None,
    }
}

fn potential_agent_executable(executable: &str) -> bool {
    let name = Path::new(executable)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        name.as_str(),
        "claude"
            | "claude.exe"
            | "codex"
            | "codex.exe"
            | "node"
            | "node.exe"
            | "bun"
            | "bun.exe"
            | "ccem-node"
            | "ccem-node.exe"
    ) || name.starts_with("ccem-node-")
}

fn path_matches(left: &Path, right: &Path) -> bool {
    left == right || matches!((left.canonicalize(), right.canonicalize()), (Ok(a), Ok(b)) if a == b)
}

/// Inspect only ownership and home keys. Never persist or print process env,
/// which may also contain API credentials.
fn legacy_writer_provider(
    pid: u32,
    own_pid: u32,
    provider: &str,
    env: &HashMap<String, String>,
    source_home: &Path,
    codex_source: &Path,
    base: &Path,
    pending: &[&str],
) -> Option<&'static str> {
    if pid == own_pid
        || !["CCEM_RUNTIME_ID", "CCEM_SESSION_ID"]
            .iter()
            .any(|key| env.get(*key).is_some_and(|value| !value.trim().is_empty()))
    {
        return None;
    }
    let process_home = env
        .get("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| source_home.to_path_buf());
    for (candidate, key, default) in [
        ("claude", "CLAUDE_CONFIG_DIR", ".claude"),
        ("codex", "CODEX_HOME", ".codex"),
    ] {
        if (provider != candidate && provider != "native") || !pending.contains(&candidate) {
            continue;
        }
        let effective = env
            .get(key)
            .filter(|value| !value.trim().is_empty())
            .map(|value| {
                value
                    .strip_prefix("~/")
                    .map(|tail| process_home.join(tail))
                    .unwrap_or_else(|| PathBuf::from(value))
            })
            .unwrap_or_else(|| process_home.join(default));
        let source = if candidate == "codex" {
            codex_source.to_path_buf()
        } else {
            source_home.join(default)
        };
        if !path_matches(&effective, &base.join(candidate)) && path_matches(&effective, &source) {
            return Some(candidate);
        }
    }
    None
}

fn parse_ps_environment(command: &str, expanded: &str) -> Option<HashMap<String, String>> {
    let raw = expanded.trim().strip_prefix(command.trim())?;
    if raw.trim().is_empty() {
        return None;
    }
    let bytes = raw.as_bytes();
    let mut assignments = Vec::new();
    for start in 0..bytes.len() {
        if (start > 0 && !bytes[start - 1].is_ascii_whitespace())
            || !(bytes[start].is_ascii_alphabetic() || bytes[start] == b'_')
        {
            continue;
        }
        let mut end = start + 1;
        while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_') {
            end += 1;
        }
        if bytes.get(end) == Some(&b'=') {
            assignments.push((start, end));
        }
    }
    let mut env = HashMap::new();
    for (index, (start, end)) in assignments.iter().enumerate() {
        let key = &raw[*start..*end];
        if !matches!(
            key,
            "HOME" | "CCEM_RUNTIME_ID" | "CCEM_SESSION_ID" | "CLAUDE_CONFIG_DIR" | "CODEX_HOME"
        ) {
            continue;
        }
        let value_end = assignments
            .get(index + 1)
            .map(|next| next.0)
            .unwrap_or(raw.len());
        env.insert(key.to_string(), raw[end + 1..value_end].trim().to_string());
    }
    Some(env)
}

fn legacy_writer_error(pid: u32, provider: &str) -> String {
    format!("A legacy CCEM {provider} session is still running (PID {pid}). Finish or stop that session, then retry agent profile preparation so its final turns are preserved.")
}

fn parse_process_rows(output: &str) -> HashMap<u32, String> {
    output
        .lines()
        .filter_map(|line| {
            let (pid, value) = line.trim().split_once(char::is_whitespace)?;
            Some((pid.parse().ok()?, value.trim().to_string()))
        })
        .collect()
}

fn record_uses_migration_source(row: &serde_json::Value, home: &Path, codex_source: &Path) -> bool {
    let Some(path) = row.get("jsonl_path").and_then(|value| value.as_str()) else {
        return true;
    };
    [
        home.join(".claude/projects"),
        codex_source.join("sessions"),
        codex_source.join("archived_sessions"),
    ]
    .iter()
    .any(|root| Path::new(path).starts_with(root))
}

fn is_persisted_legacy_pid(
    home: &Path,
    codex_source: &Path,
    pid: u32,
    provider: &str,
    pending: &[&str],
) -> bool {
    ["sessions.json", "runtime-state.json"].iter().any(|name| {
        let Ok(bytes) = fs::read(home.join(".ccem").join(name)) else {
            return false;
        };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            return false;
        };
        value
            .as_array()
            .or_else(|| value.get("sessions").and_then(|rows| rows.as_array()))
            .is_some_and(|rows| {
                rows.iter().any(|row| {
                    let client = row
                        .get("client")
                        .and_then(|value| value.as_str())
                        .unwrap_or("claude");
                    row.get("pid").and_then(|value| value.as_u64()) == Some(u64::from(pid))
                        && pending.contains(&client)
                        && (provider == "native" || client == provider)
                        && record_uses_migration_source(row, home, codex_source)
                })
            })
    })
}

#[cfg(unix)]
fn ensure_no_legacy_writers(
    home: &Path,
    base: &Path,
    codex_source: &Path,
    pending: &[&str],
) -> Result<(), String> {
    use std::process::{Command, Stdio};
    let processes = Command::new("ps")
        .args(["-ax", "-o", "pid=,comm="])
        .stdin(Stdio::null())
        .output()
        .map_err(|_| "Could not check for active legacy CCEM sessions; retry preparation")?;
    if !processes.status.success() {
        return Err("Could not check for active legacy CCEM sessions; retry preparation".into());
    }
    let candidates = parse_process_rows(&String::from_utf8_lossy(&processes.stdout))
        .into_iter()
        .filter(|(pid, executable)| {
            *pid != std::process::id() && potential_agent_executable(executable)
        })
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return Ok(());
    }
    let pids = candidates
        .iter()
        .map(|(pid, _)| pid.to_string())
        .collect::<Vec<_>>()
        .join(",");
    // Machines can have many unrelated Node processes. Resolve their command
    // lines in one call, then query env only for actual agent processes.
    let commands = Command::new("ps")
        .args(["ww", "-p", &pids, "-o", "pid=,command="])
        .stdin(Stdio::null())
        .output()
        .map_err(|_| "Could not inspect active agent processes; retry preparation")?;
    if !commands.status.success()
        && !candidates
            .iter()
            .all(|(pid, _)| process_definitely_exited(*pid))
    {
        return Err("Could not inspect active agent processes; retry preparation".into());
    }
    let commands = parse_process_rows(&String::from_utf8_lossy(&commands.stdout));
    for (pid, executable) in candidates {
        let Some(command) = commands.get(&pid) else {
            continue;
        };
        let Some(provider) = process_provider(&executable, command) else {
            continue;
        };
        let pid_arg = pid.to_string();
        let expanded = Command::new("ps")
            .args(["eww", "-p", &pid_arg, "-o", "command="])
            .stdin(Stdio::null())
            .output();
        let environment = expanded
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| {
                parse_ps_environment(command, &String::from_utf8_lossy(&output.stdout))
            });
        let Some(environment) = environment else {
            if process_definitely_exited(pid)
                || !is_persisted_legacy_pid(home, codex_source, pid, provider, pending)
            {
                continue;
            }
            return Err(format!("Could not verify the home of a running {provider} process (PID {pid}); finish it and retry agent profile preparation."));
        };
        if let Some(provider) = legacy_writer_provider(
            pid,
            std::process::id(),
            provider,
            &environment,
            home,
            codex_source,
            base,
            pending,
        ) {
            return Err(legacy_writer_error(pid, provider));
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn ensure_no_legacy_writers(
    home: &Path,
    _base: &Path,
    codex_source: &Path,
    pending: &[&str],
) -> Result<(), String> {
    // Windows has no portable process-environment query. Do not infer ownership
    // from an arbitrary Claude/Codex PID; only persisted CCEM sessions qualify.
    for name in ["sessions.json", "runtime-state.json"] {
        let bytes = match fs::read(home.join(".ccem").join(name)) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(_) => {
                return Err(
                    "Could not verify legacy CCEM sessions; close them and retry preparation"
                        .into(),
                )
            }
        };
        let value: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|_| "Could not verify legacy CCEM session records; retry preparation")?;
        let Some(rows) = value
            .as_array()
            .or_else(|| value.get("sessions").and_then(|rows| rows.as_array()))
        else {
            continue;
        };
        for row in rows {
            let Some(pid) = row
                .get("pid")
                .and_then(|value| value.as_u64())
                .and_then(|value| u32::try_from(value).ok())
                .filter(|pid| *pid > 0)
            else {
                continue;
            };
            let provider = row
                .get("client")
                .and_then(|value| value.as_str())
                .unwrap_or("claude");
            if pid != std::process::id()
                && pending.contains(&provider)
                && !process_definitely_exited(pid)
            {
                if !record_uses_migration_source(row, home, codex_source) {
                    continue;
                }
                #[cfg(windows)]
                if !persisted_process_matches_provider(pid, provider)? {
                    continue;
                }
                return Err(format!("Cannot verify the agent home of persisted CCEM session PID {pid} on this platform. Finish that session, then retry preparation."));
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
fn persisted_process_matches_provider(pid: u32, provider: &str) -> Result<bool, String> {
    use std::process::{Command, Stdio};
    let query = format!("Get-CimInstance Win32_Process -Filter 'ProcessId = {pid}' | Select-Object Name,CommandLine | ConvertTo-Json -Compress");
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &query])
        .stdin(Stdio::null())
        .output()
        .map_err(|_| {
            format!(
                "Cannot verify persisted CCEM session PID {pid}; finish it and retry preparation"
            )
        })?;
    if !output.status.success() {
        return Err(format!(
            "Cannot verify persisted CCEM session PID {pid}; finish it and retry preparation"
        ));
    }
    if output.stdout.iter().all(|byte| byte.is_ascii_whitespace()) {
        return Ok(false);
    }
    let process: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|_| {
        format!("Cannot verify persisted CCEM session PID {pid}; retry preparation")
    })?;
    let name = process
        .get("Name")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let command = process
        .get("CommandLine")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    Ok(process_provider(name, command).is_some_and(|found| found == provider || found == "native"))
}

fn validate_agent_base(home: &Path, base: &Path) -> Result<(), String> {
    if !base.is_absolute()
        || base
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("CCEM_AGENT_HOME must be an absolute path without '..'".into());
    }
    validate_no_symlinks(base)?;
    // Resolve existing parents too: a nonexistent base below an alias must not
    // disguise an official home. System aliases (e.g. /var on macOS) are handled
    // by canonicalizing fixture/known home paths before comparing.
    let resolved_base = resolve_existing_parent(base)?;
    for official in [home.join(".claude"), home.join(".codex")] {
        let resolved_official = resolve_existing_parent(&official)?;
        if resolved_base.starts_with(&resolved_official)
            || resolved_official.starts_with(&resolved_base)
        {
            return Err(
                "CCEM agent state must not overlap an official Claude or Codex home".into(),
            );
        }
    }
    Ok(())
}

fn resolve_existing_parent(path: &Path) -> Result<PathBuf, String> {
    let mut current = path;
    let mut suffix = Vec::new();
    loop {
        match fs::canonicalize(current) {
            Ok(mut resolved) => {
                for name in suffix.iter().rev() {
                    resolved.push(name);
                }
                return Ok(resolved);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let name = current.file_name().ok_or("Invalid agent home path")?;
                suffix.push(name.to_os_string());
                current = current.parent().ok_or("Invalid agent home parent")?;
            }
            Err(error) => return Err(format!("Could not validate agent home: {error}")),
        }
    }
}

fn validate_no_symlinks(path: &Path) -> Result<(), String> {
    let mut current = PathBuf::new();
    for part in path.components() {
        current.push(part.as_os_str());
        // A Windows drive/verbatim prefix (C: or \\?\C:) is not the root
        // directory. Inspect it only after RootDir completes the path.
        if matches!(part, Component::Prefix(_)) {
            continue;
        }
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(format!(
                    "CCEM agent state cannot use a symlink: {}",
                    current.display()
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => break,
            Err(error) => {
                return Err(format!(
                    "Could not inspect agent home {}: {error}",
                    current.display()
                ))
            }
        }
    }
    Ok(())
}

fn create_private_dir(path: &Path) -> Result<(), String> {
    validate_no_symlinks(path)?;
    fs::create_dir_all(path)
        .map_err(|error| format!("Could not create CCEM agent directory: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Could not protect CCEM agent directory: {error}"))?;
    }
    Ok(())
}

fn migration_complete(root: &Path) -> Result<bool, String> {
    let path = root.join(MIGRATION_MARKER);
    validate_no_symlinks(&path)?;
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("Could not read agent migration marker: {error}")),
    };
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Invalid CCEM agent migration marker".to_string())?;
    if value.get("version").and_then(|version| version.as_u64()) != Some(1) {
        return Err("Unsupported CCEM agent migration marker".into());
    }
    Ok(true)
}

fn snapshot_provider(
    source: &Path,
    target: &Path,
    allowed: &[&str],
    claude: bool,
) -> Result<(), String> {
    if migration_complete(target)? {
        return Ok(());
    }
    // A legacy root symlink is not followed, just like symlinks within it.
    let source_is_directory = match fs::symlink_metadata(source) {
        Ok(meta) => meta.is_dir() && !meta.file_type().is_symlink(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => return Err(format!("Could not inspect legacy agent directory: {error}")),
    };
    if source_is_directory {
        for name in allowed {
            copy_snapshot_entry(&source.join(name), &target.join(name))?;
        }
    }
    if claude {
        publish_bytes(
            &target.join(".claude.json"),
            b"{\"hasCompletedOnboarding\":true}\n",
        )?;
    }
    publish_bytes(&target.join(MIGRATION_MARKER), b"{\"version\":1}\n")?;
    sync_directory(target)?;
    Ok(())
}

fn copy_snapshot_entry(source: &Path, target: &Path) -> Result<(), String> {
    let meta = match fs::symlink_metadata(source) {
        Ok(meta) => meta,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Could not inspect legacy agent history: {error}")),
    };
    if meta.file_type().is_symlink() {
        return Ok(());
    }
    if meta.is_file() && is_database_file(source) {
        return Ok(());
    }
    validate_no_symlinks(target)?;
    if meta.is_dir() {
        create_private_dir(target)?;
        for entry in fs::read_dir(source)
            .map_err(|error| format!("Could not list legacy agent history: {error}"))?
        {
            let entry = entry
                .map_err(|error| format!("Could not read legacy agent history entry: {error}"))?;
            copy_snapshot_entry(&entry.path(), &target.join(entry.file_name()))?;
        }
        sync_directory(target)?;
    } else if meta.is_file() {
        if target.exists() {
            if !target.is_file() {
                return Err(format!(
                    "Agent snapshot file conflicts with a directory: {}",
                    target.display()
                ));
            }
            return Ok(());
        }
        let mut source_file = open_source_without_symlink(source)?;
        let current_meta = source_file
            .metadata()
            .map_err(|error| format!("Could not inspect history file: {error}"))?;
        if !current_meta.is_file() {
            return Err("Legacy agent history changed during migration".into());
        }
        publish_file(target, |file| {
            // An official session can still be appending. Capture the size at
            // open rather than chasing future writes, and preserve list order.
            let copied = io::copy(
                &mut Read::by_ref(&mut source_file).take(current_meta.len()),
                file,
            )?;
            if copied != current_meta.len() {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "History changed during snapshot",
                ));
            }
            if let Ok(modified) = current_meta.modified() {
                file.set_times(fs::FileTimes::new().set_modified(modified))?;
            }
            Ok(())
        })?;
    }
    Ok(())
}

fn is_database_file(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let stem = name
        .strip_suffix("-wal")
        .or_else(|| name.strip_suffix("-shm"))
        .unwrap_or(&name);
    [".sqlite", ".sqlite3", ".db"]
        .iter()
        .any(|extension| stem.ends_with(extension))
}

fn open_source_without_symlink(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options
        .open(path)
        .map_err(|error| format!("Could not open legacy agent history: {error}"))
}

fn publish_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    validate_no_symlinks(path)?;
    if path.exists() {
        if !path.is_file() {
            return Err(format!(
                "Agent snapshot file conflicts with a directory: {}",
                path.display()
            ));
        }
        return Ok(());
    }
    publish_file(path, |file| file.write_all(bytes))
}

/// Publish a fully written private file atomically without replacing any data
/// another CCEM process or resumed session has already created.
fn publish_file(
    path: &Path,
    write: impl FnOnce(&mut File) -> io::Result<()>,
) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing CCEM history parent")?;
    create_private_dir(parent)?;
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp = parent.join(format!(
        ".ccem-snapshot-{}-{sequence}.tmp",
        std::process::id()
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        write(&mut file)?;
        file.sync_all()?;
        match fs::hard_link(&temp, path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
            Err(error) => Err(error),
        }
    })();
    let _ = fs::remove_file(&temp);
    result.map_err(|error| format!("Could not snapshot agent history: {error}"))?;
    validate_no_symlinks(path)?;
    sync_directory(parent)
}

fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|error| format!("Could not persist agent directory: {error}"))?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

struct MigrationLock {
    path: PathBuf,
    bytes: Vec<u8>,
}

impl MigrationLock {
    fn acquire(base: &Path) -> Result<Self, String> {
        let path = base.join(MIGRATION_LOCK);
        validate_no_symlinks(&path)?;
        let bytes = format!("{{\"pid\":{}}}", std::process::id()).into_bytes();
        for _ in 0..2 {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            match options.open(&path) {
                Ok(mut file) => {
                    let lock = Self { path, bytes };
                    if let Err(error) = file.write_all(&lock.bytes).and_then(|_| file.sync_all()) {
                        // We exclusively created this file. A partial JSON write
                        // must not leave an unrecoverable malformed lock behind.
                        let _ = fs::remove_file(&lock.path);
                        return Err(format!("Could not persist agent migration lock: {error}"));
                    }
                    return Ok(lock);
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    let old = fs::read(&path)
                        .map_err(|error| format!("Could not read agent migration lock: {error}"))?;
                    let pid = serde_json::from_slice::<serde_json::Value>(&old)
                        .ok()
                        .and_then(|value| value.get("pid").and_then(|value| value.as_u64()))
                        .and_then(|value| u32::try_from(value).ok())
                        .filter(|pid| *pid > 0)
                        .ok_or("Invalid agent migration lock; preparation was not started")?;
                    if !process_definitely_exited(pid) {
                        return Err(format!("CCEM agent migration is owned by process {pid}; retry after it finishes"));
                    }
                    if fs::read(&path).ok().as_ref() != Some(&old) {
                        return Err("Agent migration lock changed; retry preparation".into());
                    }
                    fs::remove_file(&path).map_err(|error| {
                        format!("Could not recover stale migration lock: {error}")
                    })?;
                }
                Err(error) => return Err(format!("Could not lock agent migration: {error}")),
            }
        }
        Err("Could not acquire agent migration lock; retry preparation".into())
    }
}

impl Drop for MigrationLock {
    fn drop(&mut self) {
        if fs::read(&self.path).ok().as_ref() == Some(&self.bytes) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(unix)]
fn process_definitely_exited(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    unsafe {
        libc::kill(pid, 0) == -1 && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }
}

#[cfg(windows)]
fn process_definitely_exited(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, STILL_ACTIVE,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return GetLastError() == ERROR_INVALID_PARAMETER;
        }
        let mut exit_code = 0;
        let exited =
            GetExitCodeProcess(handle, &mut exit_code) != 0 && exit_code != STILL_ACTIVE as u32;
        CloseHandle(handle);
        exited
    }
}

#[cfg(not(any(unix, windows)))]
fn process_definitely_exited(_: u32) -> bool {
    false
}

#[cfg(test)]
#[path = "agent_home_tests.rs"]
mod tests;
