use crate::config;
use crate::session_provenance::{
    register_launch, spawn_claude_source_binding, SessionProvenanceUpsert, DEFAULT_CONFIG_SOURCE,
};
use crate::telegram;
use crate::terminal::resolve_claude_path;
use crate::unified_runtime::UnifiedSessionManager;
use crate::wecom::{read_wecom_settings, WecomBridgeManager, WecomTaskBindingTargetType};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

// ============================================================================
// Data Structures
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CronTask {
    pub id: String,
    pub name: String,
    #[serde(rename = "cronExpression")]
    pub cron_expression: String,
    pub prompt: String,
    #[serde(rename = "workingDir")]
    pub working_dir: String,
    #[serde(rename = "envName")]
    pub env_name: Option<String>,
    #[serde(rename = "executionProfile", default = "default_execution_profile")]
    pub execution_profile: String,
    #[serde(rename = "maxBudgetUsd", default)]
    pub max_budget_usd: Option<f64>,
    #[serde(rename = "allowedTools", default)]
    pub allowed_tools: Vec<String>,
    #[serde(rename = "disallowedTools", default)]
    pub disallowed_tools: Vec<String>,
    pub enabled: bool,
    #[serde(rename = "timeoutSecs")]
    pub timeout_secs: u64,
    #[serde(rename = "templateId")]
    pub template_id: Option<String>,
    #[serde(rename = "wecomNotification", alias = "wecom_notification", default)]
    pub wecom_notification: Option<CronWecomNotification>,
    #[serde(rename = "triggerType", default = "default_trigger_type")]
    pub trigger_type: String,
    #[serde(rename = "parentTaskId", default)]
    pub parent_task_id: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct CronWecomNotification {
    #[serde(rename = "botId", alias = "bot_id", default)]
    pub bot_id: Option<String>,
    #[serde(rename = "peerId", alias = "peer_id", default)]
    pub peer_id: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_trigger_type() -> String {
    "schedule".to_string()
}

fn default_execution_profile() -> String {
    "conservative".to_string()
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CronTaskRun {
    pub id: String,
    #[serde(rename = "taskId")]
    pub task_id: String,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    #[serde(rename = "finishedAt")]
    pub finished_at: Option<String>,
    #[serde(rename = "exitCode")]
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    #[serde(rename = "durationMs")]
    pub duration_ms: Option<u64>,
    pub status: String, // "running" | "success" | "failed" | "timeout"
    #[serde(rename = "runtimeId", default)]
    pub runtime_id: Option<String>,
    #[serde(rename = "runtimeKind", default)]
    pub runtime_kind: Option<String>,
    #[serde(rename = "providerSessionId", default)]
    pub provider_session_id: Option<String>,
    #[serde(rename = "workingDir", default)]
    pub working_dir: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CronTemplate {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(rename = "cronExpression")]
    pub cron_expression: String,
    pub prompt: String,
    pub icon: String,
}

// ============================================================================
// Persistence file wrappers
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Default)]
struct CronTasksFile {
    tasks: Vec<CronTask>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct CronRunsFile {
    runs: Vec<CronTaskRun>,
}

// ============================================================================
// File I/O helpers
// ============================================================================

fn get_tasks_path() -> std::path::PathBuf {
    config::get_ccem_dir().join("cron-tasks.json")
}

fn get_runs_dir() -> std::path::PathBuf {
    config::get_ccem_dir().join("cron-runs")
}

fn get_runs_path(task_id: &str) -> std::path::PathBuf {
    get_runs_dir().join(format!("{}.json", task_id))
}

fn read_tasks() -> Result<Vec<CronTask>, String> {
    let path = get_tasks_path();
    if !path.exists() {
        return Ok(vec![]);
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read cron tasks: {}", e))?;
    let file: CronTasksFile =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse cron tasks: {}", e))?;
    Ok(file.tasks)
}

fn write_tasks(tasks: &[CronTask]) -> Result<(), String> {
    config::ensure_ccem_dir().map_err(|e| format!("Failed to create ccem dir: {}", e))?;
    let file = CronTasksFile {
        tasks: tasks.to_vec(),
    };
    let content = serde_json::to_string_pretty(&file)
        .map_err(|e| format!("Failed to serialize cron tasks: {}", e))?;
    fs::write(get_tasks_path(), content).map_err(|e| format!("Failed to write cron tasks: {}", e))
}

fn read_runs(task_id: &str) -> Result<Vec<CronTaskRun>, String> {
    let path = get_runs_path(task_id);
    if !path.exists() {
        return Ok(vec![]);
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read cron runs: {}", e))?;
    let file: CronRunsFile =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse cron runs: {}", e))?;
    Ok(file.runs)
}

fn write_runs(task_id: &str, runs: &[CronTaskRun]) -> Result<(), String> {
    config::ensure_ccem_dir().map_err(|e| format!("Failed to create ccem dir: {}", e))?;
    let dir = get_runs_dir();
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create cron-runs dir: {}", e))?;
    }
    let file = CronRunsFile {
        runs: runs.to_vec(),
    };
    let content = serde_json::to_string_pretty(&file)
        .map_err(|e| format!("Failed to serialize cron runs: {}", e))?;
    fs::write(get_runs_path(task_id), content)
        .map_err(|e| format!("Failed to write cron runs: {}", e))
}

const MAX_RUNS_PER_TASK: usize = 50;

fn append_run(task_id: &str, run: CronTaskRun) -> Result<(), String> {
    let mut runs = read_runs(task_id)?;
    runs.push(run);
    // Keep only the most recent MAX_RUNS_PER_TASK entries
    if runs.len() > MAX_RUNS_PER_TASK {
        let drain_count = runs.len() - MAX_RUNS_PER_TASK;
        runs.drain(..drain_count);
    }
    write_runs(task_id, &runs)
}

fn update_run(
    task_id: &str,
    run_id: &str,
    updater: impl FnOnce(&mut CronTaskRun),
) -> Result<(), String> {
    let mut runs = read_runs(task_id)?;
    if let Some(r) = runs.iter_mut().find(|r| r.id == run_id) {
        updater(r);
    }
    write_runs(task_id, &runs)
}


fn normalize_optional_session_id(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn enrich_run_with_provenance(run: &mut CronTaskRun) {
    if run.provider_session_id.as_deref().map(str::trim).filter(|v| !v.is_empty()).is_some()
        && run.working_dir.as_deref().map(str::trim).filter(|v| !v.is_empty()).is_some()
    {
        return;
    }

    let Ok(Some(record)) =
        crate::session_provenance::find_record_by_ccem_session_id("claude", &run.id)
    else {
        return;
    };

    if run
        .provider_session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        run.provider_session_id = normalize_optional_session_id(Some(&record.source_session_id));
    }

    if run
        .working_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        run.working_dir = normalize_optional_session_id(Some(&record.working_dir));
    }
}

fn persist_run_session_binding(
    task_id: &str,
    run_id: &str,
    provider_session_id: &str,
    working_dir: Option<&str>,
) {
    let provider_session_id = provider_session_id.trim();
    if provider_session_id.is_empty() {
        return;
    }

    let _ = update_run(task_id, run_id, |run| {
        run.provider_session_id = Some(provider_session_id.to_string());
        if run
            .working_dir
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
        {
            if let Some(dir) = normalize_optional_session_id(working_dir) {
                run.working_dir = Some(dir);
            }
        }
    });
}

// ============================================================================
// ID generation
// ============================================================================

fn generate_id(prefix: &str) -> String {
    use rand::Rng;
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let rand_part: u32 = rand::thread_rng().gen_range(0..0xFFFF);
    format!("{}-{}-{:04x}", prefix, ts, rand_part)
}

// ============================================================================
// Cron expression parser
// ============================================================================

/// Parse a single cron field (e.g. "*/5", "1-3", "1,2,3", "*") into a sorted
/// list of matching values within [min, max].
///
/// Returns an error describing the first invalid token instead of silently
/// dropping it. This prevents bad expressions from passing validation only to
/// never fire at runtime.
fn parse_cron_field(field: &str, min: u32, max: u32) -> Result<Vec<u32>, String> {
    let mut result = Vec::new();
    for part in field.split(',') {
        let part = part.trim();
        if part.is_empty() {
            return Err(format!("empty value (allowed range {}-{})", min, max));
        }
        if part == "*" {
            result.extend(min..=max);
        } else if let Some(step_str) = part.strip_prefix("*/") {
            let step = step_str
                .parse::<u32>()
                .map_err(|_| format!("invalid step '{}'", step_str))?;
            if step == 0 {
                return Err("step cannot be zero".to_string());
            }
            let mut v = min;
            while v <= max {
                result.push(v);
                v += step;
            }
        } else if part.contains('-') {
            let bounds: Vec<&str> = part.split('-').collect();
            if bounds.len() != 2 {
                return Err(format!("invalid range '{}'", part));
            }
            let lo = bounds[0]
                .trim()
                .parse::<u32>()
                .map_err(|_| format!("invalid range start '{}' in '{}'", bounds[0], part))?;
            let hi = bounds[1]
                .trim()
                .parse::<u32>()
                .map_err(|_| format!("invalid range end '{}' in '{}'", bounds[1], part))?;
            if lo > hi {
                return Err(format!(
                    "inverted range '{}' (start {} > end {})",
                    part, lo, hi
                ));
            }
            if lo < min || hi > max {
                return Err(format!(
                    "range '{}' out of bounds (allowed {}-{})",
                    part, min, max
                ));
            }
            for v in lo..=hi {
                result.push(v);
            }
        } else {
            let v = part
                .parse::<u32>()
                .map_err(|_| format!("invalid value '{}'", part))?;
            if v < min || v > max {
                return Err(format!("value {} out of range (allowed {}-{})", v, min, max));
            }
            result.push(v);
        }
    }
    result.sort();
    result.dedup();
    Ok(result)
}

/// Parse and validate all 5 fields of a cron expression, returning the
/// resolved value sets. Used as the single shared validator across
/// create/update/preview/scheduler boundaries.
type CronFieldSets = (Vec<u32>, Vec<u32>, Vec<u32>, Vec<u32>, Vec<u32>);

fn parse_cron_expression(expression: &str) -> Result<CronFieldSets, String> {
    let fields: Vec<&str> = expression.split_whitespace().collect();
    if fields.len() != 5 {
        return Err(
            "cron expression must have exactly 5 fields (minute hour day month weekday)"
                .to_string(),
        );
    }
    let minutes = parse_cron_field(fields[0], 0, 59).map_err(|e| format!("minute field: {e}"))?;
    let hours = parse_cron_field(fields[1], 0, 23).map_err(|e| format!("hour field: {e}"))?;
    let days = parse_cron_field(fields[2], 1, 31).map_err(|e| format!("day-of-month field: {e}"))?;
    let months = parse_cron_field(fields[3], 1, 12).map_err(|e| format!("month field: {e}"))?;
    let weekdays = parse_cron_field(fields[4], 0, 6).map_err(|e| format!("day-of-week field: {e}"))?;
    Ok((minutes, hours, days, months, weekdays))
}

/// Validate a cron expression without retaining the parsed values.
fn validate_cron_expression(expression: &str) -> Result<(), String> {
    parse_cron_expression(expression).map(|_| ())
}

/// Check whether a given chrono::DateTime matches a 5-field cron expression
/// (minute hour day-of-month month day-of-week).
///
/// Returns an error if the expression is invalid so callers can distinguish
/// "does not match right now" from "will never match because the expression is
/// malformed".
fn cron_matches(expression: &str, dt: &chrono::DateTime<chrono::Local>) -> Result<bool, String> {
    use chrono::Datelike;
    use chrono::Timelike;

    let (minutes, hours, days, months, weekdays) = parse_cron_expression(expression)?;

    let m = dt.minute();
    let h = dt.hour();
    let d = dt.day();
    let mo = dt.month();
    // chrono: Mon=0 .. Sun=6 in weekday().num_days_from_monday()
    // cron convention: Sun=0, Mon=1 .. Sat=6
    let wd = dt.weekday().num_days_from_sunday();

    Ok(minutes.contains(&m)
        && hours.contains(&h)
        && days.contains(&d)
        && months.contains(&mo)
        && weekdays.contains(&wd))
}

/// Compute the next `count` run times for a cron expression, starting from now.
/// Returns ISO-8601 strings in local time. Rejects invalid expressions instead
/// of silently returning an empty/sparse schedule.
fn next_runs(expression: &str, count: usize) -> Result<Vec<String>, String> {
    use chrono::{Datelike, Duration, Local, Timelike};

    // Validate and parse once, then match against the resolved value sets.
    // This both rejects bad expressions up front and avoids re-parsing on every
    // iteration of the scan loop.
    let (minutes, hours, days, months, weekdays) = parse_cron_expression(expression)?;

    let mut results = Vec::new();
    // Start from the next whole minute
    let now = Local::now();
    let mut cursor = now
        .with_second(0)
        .and_then(|t| t.with_nanosecond(0))
        .unwrap_or(now)
        + Duration::minutes(1);

    // Safety: scan at most 366 days ahead
    let limit = 366 * 24 * 60;
    let mut iterations = 0;

    while results.len() < count && iterations < limit {
        let m = cursor.minute();
        let h = cursor.hour();
        let d = cursor.day();
        let mo = cursor.month();
        let wd = cursor.weekday().num_days_from_sunday();
        if minutes.contains(&m)
            && hours.contains(&h)
            && days.contains(&d)
            && months.contains(&mo)
            && weekdays.contains(&wd)
        {
            results.push(cursor.to_rfc3339());
        }
        cursor += Duration::minutes(1);
        iterations += 1;
    }

    Ok(results)
}

// ============================================================================
// Task execution
// ============================================================================

fn resolve_cron_env_name(env_name: &Option<String>) -> Option<String> {
    env_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            config::read_config()
                .ok()
                .and_then(|cfg| cfg.current)
                .map(|name| name.trim().to_string())
                .filter(|name| !name.is_empty())
        })
}

fn build_env_vars(env_name: &Option<String>) -> HashMap<String, String> {
    let resolved_name = resolve_cron_env_name(env_name);
    resolved_name
        .as_deref()
        .and_then(|name| config::resolve_claude_env(name).ok())
        .map(|resolved| resolved.env_vars)
        .unwrap_or_default()
}

fn build_cron_launch_provenance(
    task: &CronTask,
    run_id: &str,
    working_dir: &str,
) -> Option<SessionProvenanceUpsert> {
    let env_name = resolve_cron_env_name(&task.env_name)?;

    Some(SessionProvenanceUpsert {
        ccem_session_id: run_id.to_string(),
        client: "claude".to_string(),
        env_name,
        config_source: Some(DEFAULT_CONFIG_SOURCE.to_string()),
        working_dir: working_dir.to_string(),
        perm_mode: Some(resolve_task_tool_policy(task).permission_mode),
        launch_mode: "cron".to_string(),
        started_via: "cron".to_string(),
        source_session_id: None,
    })
}

fn register_cron_launch_provenance(
    task: &CronTask,
    run_id: &str,
    working_dir: &str,
    started_at: DateTime<Utc>,
) {
    let Some(provenance) = build_cron_launch_provenance(task, run_id, working_dir) else {
        return;
    };

    if let Err(error) = register_launch(provenance) {
        eprintln!(
            "Failed to register cron launch provenance for {}: {}",
            run_id, error
        );
        return;
    }

    let task_id = task.id.clone();
    let run_id_owned = run_id.to_string();
    let working_dir_owned = working_dir.to_string();
    spawn_claude_source_binding(
        run_id.to_string(),
        working_dir.to_string(),
        started_at,
        None,
    );

    // Best-effort: after provenance bind completes, mirror provider session id onto the run record
    // so the cron UI can deep-link into Workspace without an extra lookup race.
    let poll_run_id = run_id_owned.clone();
    let poll_task_id = task_id.clone();
    let poll_working_dir = working_dir_owned.clone();
    thread::spawn(move || {
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_secs(25) {
            if let Ok(Some(record)) =
                crate::session_provenance::find_record_by_ccem_session_id("claude", &poll_run_id)
            {
                let provider = record.source_session_id.trim();
                if !provider.is_empty() {
                    persist_run_session_binding(
                        &poll_task_id,
                        &poll_run_id,
                        provider,
                        Some(&poll_working_dir),
                    );
                    return;
                }
            }
            thread::sleep(Duration::from_millis(500));
        }
    });
}

fn format_cron_notification(task: &CronTask, run: &CronTaskRun) -> String {
    let execution_profile = resolve_execution_profile(&task.execution_profile);
    let mut lines = vec![format!(
        "{} Cron: {}",
        match run.status.as_str() {
            "success" => "✅",
            "running" => "⏳",
            "timeout" => "⏱",
            _ => "❌",
        },
        task.name
    )];
    lines.push(format!("Status: {}", run.status));

    if let Some(runtime_id) = &run.runtime_id {
        lines.push(format!("Runtime: {}", runtime_id));
    }
    lines.push(format!("Schedule: {}", task.cron_expression));
    lines.push(format!("Profile: {}", execution_profile.key));
    lines.push(format!("Working dir: {}", task.working_dir));

    if let Some(duration_ms) = run.duration_ms {
        lines.push(format!("Duration: {:.1}s", duration_ms as f64 / 1000.0));
    }

    if !run.stdout.trim().is_empty() {
        lines.push(String::new());
        lines.push("Output:".to_string());
        lines.push(run.stdout.chars().take(1200).collect());
    }

    if !run.stderr.trim().is_empty() {
        lines.push(String::new());
        lines.push("Errors:".to_string());
        lines.push(run.stderr.chars().take(1200).collect());
    }

    lines.join("\n")
}

fn normalize_wecom_peer_id(
    target_type: Option<&WecomTaskBindingTargetType>,
    peer_id: &str,
) -> String {
    let peer = peer_id.trim();
    if peer.starts_with("single:") || peer.starts_with("group:") {
        return peer.to_string();
    }

    match target_type {
        Some(WecomTaskBindingTargetType::Group) => format!("group:{peer}"),
        _ => format!("single:{peer}"),
    }
}

fn resolve_cron_wecom_notification_target(task: &CronTask) -> Option<(String, String)> {
    let notification = task.wecom_notification.as_ref()?;
    if !notification.enabled {
        return None;
    }

    let explicit_bot_id = notification
        .bot_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let explicit_peer_id = notification
        .peer_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if let (Some(bot_id), Some(peer_id)) = (explicit_bot_id, explicit_peer_id) {
        return Some((bot_id.to_string(), normalize_wecom_peer_id(None, peer_id)));
    }

    let settings = read_wecom_settings().ok()?;
    if !settings.enabled {
        return None;
    }

    settings
        .bots
        .iter()
        .filter(|bot| bot.enabled)
        .filter(|bot| explicit_bot_id.is_none_or(|id| id == bot.bot_id || id == bot.id))
        .find_map(|bot| {
            let peer_id = explicit_peer_id.or(bot.task_binding_default_peer_id.as_deref())?;
            Some((
                bot.bot_id.clone(),
                normalize_wecom_peer_id(bot.task_binding_default_target_type.as_ref(), peer_id),
            ))
        })
}

fn send_cron_wecom_notification(app: &AppHandle, task: &CronTask, run: &CronTaskRun) {
    let Some((bot_id, peer_id)) = resolve_cron_wecom_notification_target(task) else {
        return;
    };
    let Some(manager) = app.try_state::<Arc<WecomBridgeManager>>() else {
        eprintln!(
            "WeCom cron notification warning: WeCom bridge manager is not available for task {}",
            task.id
        );
        return;
    };

    let message = format_cron_notification(task, run);
    if let Err(error) = manager.send_markdown_message(Some(&bot_id), &peer_id, &message) {
        eprintln!(
            "WeCom cron notification warning for task {} run {}: {}",
            task.id, run.id, error
        );
    }
}

#[derive(Debug, Clone)]
struct ExecutionProfilePreset {
    key: &'static str,
    permission_mode: &'static str,
    max_budget_usd: f64,
    allowed_tools: Vec<String>,
}

#[derive(Debug, Clone)]
struct ResolvedToolPolicy {
    permission_mode: String,
    max_budget_usd: f64,
    allowed_tools: Vec<String>,
    disallowed_tools: Vec<String>,
}

fn normalize_execution_profile(value: &str) -> &'static str {
    match value {
        "standard" => "standard",
        "autonomous" => "autonomous",
        _ => "conservative",
    }
}

fn resolve_execution_profile(value: &str) -> ExecutionProfilePreset {
    match normalize_execution_profile(value) {
        "standard" => ExecutionProfilePreset {
            key: "standard",
            permission_mode: "default",
            max_budget_usd: 2.0,
            allowed_tools: vec![
                "Task".to_string(),
                "TaskOutput".to_string(),
                "Read".to_string(),
                "Glob".to_string(),
                "Grep".to_string(),
                "Edit".to_string(),
                "Write".to_string(),
                "TodoWrite".to_string(),
                "Skill".to_string(),
                "Bash".to_string(),
                "WebFetch".to_string(),
                "WebSearch".to_string(),
            ],
        },
        "autonomous" => ExecutionProfilePreset {
            key: "autonomous",
            permission_mode: "bypassPermissions",
            max_budget_usd: 5.0,
            allowed_tools: Vec::new(),
        },
        _ => ExecutionProfilePreset {
            key: "conservative",
            permission_mode: "default",
            max_budget_usd: 0.5,
            allowed_tools: vec![
                "Task".to_string(),
                "TaskOutput".to_string(),
                "Read".to_string(),
                "Glob".to_string(),
                "Grep".to_string(),
                "Edit".to_string(),
                "Write".to_string(),
                "TodoWrite".to_string(),
                "Skill".to_string(),
            ],
        },
    }
}

fn resolve_task_tool_policy(task: &CronTask) -> ResolvedToolPolicy {
    let preset = resolve_execution_profile(&task.execution_profile);
    ResolvedToolPolicy {
        permission_mode: preset.permission_mode.to_string(),
        max_budget_usd: task.max_budget_usd.unwrap_or(preset.max_budget_usd),
        allowed_tools: if task.allowed_tools.is_empty() {
            preset.allowed_tools
        } else {
            task.allowed_tools.clone()
        },
        disallowed_tools: task.disallowed_tools.clone(),
    }
}

fn official_permission_mode(mode_name: &str) -> &str {
    match mode_name {
        "yolo" => "bypassPermissions",
        "dev" => "acceptEdits",
        "readonly" | "audit" => "plan",
        "safe" | "ci" => "default",
        "acceptEdits" | "bypassPermissions" | "default" | "dontAsk" | "plan" | "auto" => mode_name,
        _ => "acceptEdits",
    }
}

fn build_cron_claude_command(
    task: &CronTask,
    working_dir: &str,
    env_vars: &HashMap<String, String>,
    expanded_path: &str,
    tool_policy: &ResolvedToolPolicy,
) -> Command {
    let claude_binary = resolve_claude_path().unwrap_or_else(|| "claude".to_string());
    let mut command = Command::new(&claude_binary);
    command.arg("-p").arg(&task.prompt);
    command.args([
        "--permission-mode",
        official_permission_mode(&tool_policy.permission_mode),
    ]);

    if tool_policy.max_budget_usd > 0.0 {
        command.args([
            "--max-budget-usd",
            &format!("{:.2}", tool_policy.max_budget_usd),
        ]);
    }

    if !tool_policy.allowed_tools.is_empty() {
        command.arg("--allowedTools");
        command.args(&tool_policy.allowed_tools);
    }

    if !tool_policy.disallowed_tools.is_empty() {
        command.arg("--disallowedTools");
        command.args(&tool_policy.disallowed_tools);
    }

    command
        .current_dir(working_dir)
        .env("PATH", expanded_path)
        .env_remove("CLAUDECODE")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    config::clear_managed_claude_env(&mut command);
    command.envs(env_vars);
    command
}

fn spawn_output_collector<T>(stream: Option<T>) -> thread::JoinHandle<String>
where
    T: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut buffer = String::new();
        let Some(mut stream) = stream else {
            return buffer;
        };
        let _ = stream.read_to_string(&mut buffer);
        buffer
    })
}

fn push_unique_path(paths: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>, path: PathBuf) {
    if !path.as_os_str().is_empty() && seen.insert(path.clone()) {
        paths.push(path);
    }
}

fn latest_node_version_bin(versions_dir: &Path, fnm_layout: bool) -> Option<PathBuf> {
    let Ok(entries) = fs::read_dir(versions_dir) else {
        return None;
    };

    let mut versions = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();
    versions.sort();
    versions.reverse();

    for version in versions {
        let bin = if fnm_layout {
            version.join("installation").join("bin")
        } else {
            version.join("bin")
        };
        if bin.exists() {
            return Some(bin);
        }
    }

    None
}

fn cron_path_candidates(home: Option<&Path>) -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Some(home) = home {
        paths.push(home.join(".volta").join("bin"));
        paths.push(home.join(".npm-global").join("bin"));
        paths.push(home.join(".local").join("bin"));
        paths.push(home.join(".cargo").join("bin"));

        if let Some(path) =
            latest_node_version_bin(&home.join(".nvm").join("versions").join("node"), false)
        {
            paths.insert(0, path);
        }
        if let Some(path) = latest_node_version_bin(&home.join(".fnm").join("node-versions"), true)
        {
            paths.insert(0, path);
        }
    }

    #[cfg(windows)]
    {
        if let Some(value) = std::env::var_os("APPDATA") {
            paths.push(PathBuf::from(value).join("npm"));
        }
        if let Some(value) = std::env::var_os("LOCALAPPDATA") {
            paths.push(PathBuf::from(value).join("pnpm"));
        }
        if let Some(value) = std::env::var_os("ProgramFiles") {
            paths.push(PathBuf::from(value).join("nodejs"));
        }
        if let Some(home) = home {
            paths.push(home.join("AppData").join("Roaming").join("npm"));
            paths.push(home.join("AppData").join("Local").join("pnpm"));
            paths.push(home.join("scoop").join("shims"));
        }
    }

    #[cfg(not(windows))]
    {
        paths.push(PathBuf::from("/usr/local/bin"));
        paths.push(PathBuf::from("/opt/homebrew/bin"));
        paths.push(PathBuf::from("/usr/bin"));
        paths.push(PathBuf::from("/bin"));
    }

    paths
}

fn build_cron_user_path(home: Option<&Path>, current_path: Option<OsString>) -> String {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();

    for path in cron_path_candidates(home) {
        push_unique_path(&mut paths, &mut seen, path);
    }

    if let Some(current_path) = current_path {
        for path in std::env::split_paths(&current_path) {
            push_unique_path(&mut paths, &mut seen, path);
        }
    }

    std::env::join_paths(paths)
        .ok()
        .and_then(|value| value.into_string().ok())
        .unwrap_or_default()
}

fn expand_cron_working_dir(working_dir: &str, home: Option<&Path>) -> String {
    let Some(home) = home else {
        return working_dir.to_string();
    };

    if working_dir == "~" {
        return home.to_string_lossy().to_string();
    }

    if let Some(relative) = working_dir
        .strip_prefix("~/")
        .or_else(|| working_dir.strip_prefix("~\\"))
    {
        return home.join(relative).to_string_lossy().to_string();
    }

    working_dir.to_string()
}

fn execute_task(
    app: AppHandle,
    _unified_runtime_manager: Arc<UnifiedSessionManager>,
    task: CronTask,
) {
    let run_id = generate_id("run");
    let started_at_instant = Utc::now();
    let started_at = started_at_instant.to_rfc3339();

    let run = CronTaskRun {
        id: run_id.clone(),
        task_id: task.id.clone(),
        started_at: started_at.clone(),
        finished_at: None,
        exit_code: None,
        stdout: String::new(),
        stderr: String::new(),
        duration_ms: None,
        status: "running".to_string(),
        runtime_id: None,
        runtime_kind: Some("headless".to_string()),
        provider_session_id: None,
        working_dir: None,
    };

    let _ = append_run(&task.id, run.clone());
    let _ = app.emit("cron-task-started", &run);

    let env_vars = build_env_vars(&task.env_name);
    let tool_policy = resolve_task_tool_policy(&task);
    let start = std::time::Instant::now();

    // Expand PATH to include common Node.js/nvm/fnm/volta install locations
    // since Tauri processes don't inherit the user's shell PATH
    let home = dirs::home_dir();
    let expanded_path = build_cron_user_path(home.as_deref(), std::env::var_os("PATH"));
    let working_dir = expand_cron_working_dir(&task.working_dir, home.as_deref());
    let _ = update_run(&task.id, &run_id, |r| {
        r.working_dir = Some(working_dir.clone());
    });
    register_cron_launch_provenance(&task, &run_id, &working_dir, started_at_instant);

    let mut cmd =
        build_cron_claude_command(&task, &working_dir, &env_vars, &expanded_path, &tool_policy);

    let (status_str, exit_code, stdout, stderr) = match cmd.spawn() {
        Ok(mut child) => {
            let stdout_reader = spawn_output_collector(child.stdout.take());
            let stderr_reader = spawn_output_collector(child.stderr.take());
            let timeout = Duration::from_secs(task.timeout_secs);
            let poll_interval = Duration::from_millis(500);

            let outcome = loop {
                match child.try_wait() {
                    Ok(Some(exit_status)) => break Ok(exit_status.code()),
                    Ok(None) => {
                        if start.elapsed() >= timeout {
                            let _ = child.kill();
                            let _ = child.wait();
                            break Err(format!(
                                "Task timed out after {} seconds",
                                task.timeout_secs
                            ));
                        }
                        thread::sleep(poll_interval);
                    }
                    Err(error) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        break Err(format!("Error waiting for process: {}", error));
                    }
                }
            };

            let stdout = stdout_reader.join().unwrap_or_default();
            let mut stderr = stderr_reader.join().unwrap_or_default();

            match outcome {
                Ok(code) => {
                    let status = if code == Some(0) {
                        "success".to_string()
                    } else {
                        "failed".to_string()
                    };
                    (status, code, stdout, stderr)
                }
                Err(message) if message.starts_with("Task timed out after ") => {
                    if !stderr.trim().is_empty() {
                        stderr.push('\n');
                    }
                    stderr.push_str(&message);
                    ("timeout".to_string(), None, stdout, stderr)
                }
                Err(message) => {
                    if !stderr.trim().is_empty() {
                        stderr.push('\n');
                    }
                    stderr.push_str(&message);
                    ("failed".to_string(), None, stdout, stderr)
                }
            }
        }
        Err(error) => (
            "failed".to_string(),
            None,
            String::new(),
            format!("Failed to spawn claude: {}", error),
        ),
    };

    let duration_ms = start.elapsed().as_millis() as u64;
    let finished_at = chrono::Utc::now().to_rfc3339();

    let _ = update_run(&task.id, &run_id, |r| {
        r.status = status_str.clone();
        r.exit_code = exit_code;
        r.stdout = stdout.clone();
        r.stderr = stderr.clone();
        r.duration_ms = Some(duration_ms);
        r.finished_at = Some(finished_at.clone());
        if r.runtime_kind.is_none() {
            r.runtime_kind = Some("headless".to_string());
        }
    });

    // Re-read so provider_session_id writebacks from provenance binding are preserved.
    let mut finished_run = read_runs(&task.id)
        .ok()
        .and_then(|runs| runs.into_iter().find(|r| r.id == run_id))
        .unwrap_or(CronTaskRun {
            id: run_id.clone(),
            task_id: task.id.clone(),
            started_at: started_at.clone(),
            finished_at: None,
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            duration_ms: None,
            status: "running".to_string(),
            runtime_id: None,
            runtime_kind: Some("headless".to_string()),
            provider_session_id: None,
            working_dir: Some(working_dir.clone()),
        });
    finished_run.started_at = started_at;
    finished_run.finished_at = Some(finished_at);
    finished_run.exit_code = exit_code;
    finished_run.stdout = stdout;
    finished_run.stderr = stderr;
    finished_run.duration_ms = Some(duration_ms);
    finished_run.status = status_str;
    if finished_run.runtime_kind.is_none() {
        finished_run.runtime_kind = Some("headless".to_string());
    }
    if finished_run.working_dir.is_none() {
        finished_run.working_dir = Some(working_dir.clone());
    }
    enrich_run_with_provenance(&mut finished_run);
    let _ = update_run(&task.id, &run_id, |r| {
        *r = finished_run.clone();
    });

    let event_name = if finished_run.status == "success" {
        "cron-task-completed"
    } else {
        "cron-task-failed"
    };
    let _ = app.emit(event_name, &finished_run);
    let _ = telegram::send_configured_message(&format_cron_notification(&task, &finished_run));
    send_cron_wecom_notification(&app, &task, &finished_run);
}

// ============================================================================
// Scheduler
// ============================================================================

pub struct CronScheduler {
    last_fired: Mutex<HashMap<String, i64>>,
}

impl Default for CronScheduler {
    fn default() -> Self {
        Self {
            last_fired: Mutex::new(HashMap::new()),
        }
    }
}

pub fn start_cron_scheduler(
    app: AppHandle,
    scheduler: Arc<CronScheduler>,
    unified_runtime_manager: Arc<UnifiedSessionManager>,
) {
    thread::spawn(move || {
        loop {
            thread::sleep(Duration::from_secs(30));

            let tasks = match read_tasks() {
                Ok(t) => t,
                Err(_) => continue,
            };

            let now = chrono::Local::now();
            // Minute-level timestamp for dedup
            let minute_ts = now.timestamp() / 60;

            for task in &tasks {
                if !task.enabled {
                    continue;
                }
                if task.trigger_type != "schedule" {
                    continue;
                }
                match cron_matches(&task.cron_expression, &now) {
                    Ok(true) => {}
                    Ok(false) => continue,
                    Err(e) => {
                        // Defense-in-depth: create/update validate up front, but
                        // persisted tasks may predate validation or be hand-edited.
                        // Log and skip instead of silently treating as "never fire".
                        eprintln!(
                            "[cron] skipping task {} ({}): invalid expression '{}': {}",
                            task.id, task.name, task.cron_expression, e
                        );
                        continue;
                    }
                }

                // Dedup: skip if already fired this minute
                {
                    let mut map = scheduler.last_fired.lock().unwrap();
                    if let Some(&last) = map.get(&task.id) {
                        if last == minute_ts {
                            continue;
                        }
                    }
                    map.insert(task.id.clone(), minute_ts);
                }

                // Execute in a separate thread
                let app_clone = app.clone();
                let task_clone = task.clone();
                let unified_runtime_manager_clone = unified_runtime_manager.clone();
                thread::spawn(move || {
                    execute_task(app_clone, unified_runtime_manager_clone, task_clone);
                });
            }
        }
    });
}

pub fn run_cron_task_now(
    app: AppHandle,
    unified_runtime_manager: Arc<UnifiedSessionManager>,
    id: &str,
) -> Result<CronTask, String> {
    let tasks = read_tasks()?;
    let task = tasks
        .iter()
        .find(|task| task.id == id)
        .ok_or_else(|| format!("Task not found: {}", id))?
        .clone();

    let app_clone = app.clone();
    let task_clone = task.clone();
    thread::spawn(move || {
        execute_task(app_clone, unified_runtime_manager, task_clone);
    });

    Ok(task)
}

// ============================================================================
// Built-in templates
// ============================================================================

fn get_builtin_templates() -> Vec<CronTemplate> {
    vec![
        CronTemplate {
            id: "code-review".to_string(),
            name: "Code Review".to_string(),
            description: "Review recent git changes and provide feedback".to_string(),
            cron_expression: "0 9 * * 1-5".to_string(),
            prompt: "Review the git diff of the last 24 hours. Summarize changes, highlight potential issues, and suggest improvements.".to_string(),
            icon: "GitPullRequest".to_string(),
        },
        CronTemplate {
            id: "test-runner".to_string(),
            name: "Test Runner".to_string(),
            description: "Run test suite and report results".to_string(),
            cron_expression: "0 */4 * * *".to_string(),
            prompt: "Run the project test suite. Report any failures with details and suggest fixes for broken tests.".to_string(),
            icon: "TestTube".to_string(),
        },
        CronTemplate {
            id: "doc-gen".to_string(),
            name: "Documentation Generator".to_string(),
            description: "Generate or update project documentation".to_string(),
            cron_expression: "0 18 * * 5".to_string(),
            prompt: "Scan the codebase for undocumented or poorly documented public APIs. Generate or update documentation for them.".to_string(),
            icon: "FileText".to_string(),
        },
        CronTemplate {
            id: "security-scan".to_string(),
            name: "Security Scan".to_string(),
            description: "Scan for security vulnerabilities".to_string(),
            cron_expression: "0 3 * * 1".to_string(),
            prompt: "Perform a security review of the codebase. Check for common vulnerabilities, outdated dependencies, and exposed secrets.".to_string(),
            icon: "Shield".to_string(),
        },
        CronTemplate {
            id: "changelog".to_string(),
            name: "Changelog Generator".to_string(),
            description: "Generate changelog from recent commits".to_string(),
            cron_expression: "0 17 * * 5".to_string(),
            prompt: "Analyze git commits since the last tag or the past week. Generate a well-formatted changelog grouped by category (features, fixes, chores).".to_string(),
            icon: "ScrollText".to_string(),
        },
    ]
}

// ============================================================================
// Tauri Commands
// ============================================================================

#[tauri::command]
pub fn list_cron_tasks() -> Result<Vec<CronTask>, String> {
    read_tasks()
}

#[tauri::command]
pub fn add_cron_task(
    name: String,
    cron_expression: String,
    prompt: String,
    working_dir: String,
    env_name: Option<String>,
    execution_profile: Option<String>,
    max_budget_usd: Option<f64>,
    allowed_tools: Option<Vec<String>>,
    disallowed_tools: Option<Vec<String>>,
    timeout_secs: Option<u64>,
    template_id: Option<String>,
    wecom_notification: Option<CronWecomNotification>,
) -> Result<CronTask, String> {
    // Validate cron expression (5 fields + per-field token/range checks)
    validate_cron_expression(&cron_expression)?;

    let now = chrono::Utc::now().to_rfc3339();
    let task = CronTask {
        id: generate_id("cron"),
        name,
        cron_expression,
        prompt,
        working_dir,
        env_name,
        execution_profile: normalize_execution_profile(
            execution_profile.as_deref().unwrap_or("conservative"),
        )
        .to_string(),
        max_budget_usd,
        allowed_tools: allowed_tools.unwrap_or_default(),
        disallowed_tools: disallowed_tools.unwrap_or_default(),
        enabled: true,
        timeout_secs: timeout_secs.unwrap_or(300),
        template_id,
        wecom_notification,
        trigger_type: "schedule".to_string(),
        parent_task_id: None,
        created_at: now.clone(),
        updated_at: now,
    };

    let mut tasks = read_tasks()?;
    tasks.push(task.clone());
    write_tasks(&tasks)?;

    Ok(task)
}

#[tauri::command]
pub fn update_cron_task(
    id: String,
    name: Option<String>,
    cron_expression: Option<String>,
    prompt: Option<String>,
    working_dir: Option<String>,
    env_name: Option<String>,
    execution_profile: Option<String>,
    max_budget_usd: Option<f64>,
    allowed_tools: Option<Vec<String>>,
    disallowed_tools: Option<Vec<String>>,
    timeout_secs: Option<u64>,
    wecom_notification: Option<CronWecomNotification>,
) -> Result<CronTask, String> {
    let mut tasks = read_tasks()?;
    let task = tasks
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("Task not found: {}", id))?;

    if let Some(v) = name {
        task.name = v;
    }
    if let Some(v) = cron_expression {
        validate_cron_expression(&v)?;
        task.cron_expression = v;
    }
    if let Some(v) = prompt {
        task.prompt = v;
    }
    if let Some(v) = working_dir {
        task.working_dir = v;
    }
    // env_name: always update (allows clearing by passing null from frontend)
    task.env_name = env_name;
    if let Some(v) = execution_profile {
        task.execution_profile = normalize_execution_profile(&v).to_string();
    }
    task.max_budget_usd = max_budget_usd;
    task.allowed_tools = allowed_tools.unwrap_or_default();
    task.disallowed_tools = disallowed_tools.unwrap_or_default();
    if let Some(v) = timeout_secs {
        task.timeout_secs = v;
    }
    task.wecom_notification = wecom_notification;
    task.updated_at = chrono::Utc::now().to_rfc3339();

    let updated = task.clone();
    write_tasks(&tasks)?;
    Ok(updated)
}

#[tauri::command]
pub fn delete_cron_task(id: String) -> Result<(), String> {
    let mut tasks = read_tasks()?;
    let before = tasks.len();
    tasks.retain(|t| t.id != id);
    if tasks.len() == before {
        return Err(format!("Task not found: {}", id));
    }
    write_tasks(&tasks)?;

    // Also clean up runs file
    let runs_path = get_runs_path(&id);
    if runs_path.exists() {
        let _ = fs::remove_file(runs_path);
    }

    Ok(())
}

#[tauri::command]
pub fn toggle_cron_task(id: String) -> Result<CronTask, String> {
    let mut tasks = read_tasks()?;
    let task = tasks
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("Task not found: {}", id))?;

    task.enabled = !task.enabled;
    task.updated_at = chrono::Utc::now().to_rfc3339();

    let toggled = task.clone();
    write_tasks(&tasks)?;
    Ok(toggled)
}

#[tauri::command]
pub fn get_cron_task_runs(task_id: String) -> Result<Vec<CronTaskRun>, String> {
    let mut runs = read_runs(&task_id)?;
    let mut dirty = false;
    for run in &mut runs {
        let before_provider = run.provider_session_id.clone();
        let before_dir = run.working_dir.clone();
        enrich_run_with_provenance(run);
        if run.provider_session_id != before_provider || run.working_dir != before_dir {
            dirty = true;
        }
    }
    if dirty {
        let _ = write_runs(&task_id, &runs);
    }
    Ok(runs)
}

#[tauri::command]
pub fn retry_cron_task(
    id: String,
    app: AppHandle,
    unified_runtime_manager: tauri::State<'_, Arc<UnifiedSessionManager>>,
) -> Result<(), String> {
    run_cron_task_now(app, unified_runtime_manager.inner().clone(), &id)?;
    Ok(())
}

#[tauri::command]
pub fn get_cron_run_detail(task_id: String, run_id: String) -> Result<CronTaskRun, String> {
    let mut runs = read_runs(&task_id)?;
    let Some(index) = runs.iter().position(|r| r.id == run_id) else {
        return Err(format!("Run not found: {}", run_id));
    };
    let before_provider = runs[index].provider_session_id.clone();
    let before_dir = runs[index].working_dir.clone();
    enrich_run_with_provenance(&mut runs[index]);
    if runs[index].provider_session_id != before_provider || runs[index].working_dir != before_dir {
        let _ = write_runs(&task_id, &runs);
    }
    Ok(runs[index].clone())
}

#[tauri::command]
pub fn list_cron_templates() -> Vec<CronTemplate> {
    get_builtin_templates()
}

#[tauri::command]
pub fn get_cron_next_runs(
    cron_expression: String,
    count: Option<usize>,
) -> Result<Vec<String>, String> {
    next_runs(&cron_expression, count.unwrap_or(5))
}

// ============================================================================
// AI-assisted cron task generation (streaming)
// ============================================================================

/// Resolve the user's full login-shell PATH so we can find the `claude` binary.
fn get_user_path() -> String {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let output = Command::new(&shell)
        .args(["-li", "-c", "echo $PATH"])
        .output();

    match output {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        _ => std::env::var("PATH").unwrap_or_default(),
    }
}

#[tauri::command]
pub fn generate_cron_task_stream(app: AppHandle, query: String) {
    thread::spawn(move || {
        let prompt = format!(
            "用户想创建一个定时任务: {}\n\n\
             请根据用户描述，生成一个 cron 任务配置。返回一个 JSON 对象（不要包含在 markdown 代码块中）：\n\
             {{\n\
               \"name\": \"简短的任务名称\",\n\
               \"cronExpression\": \"标准5字段cron表达式\",\n\
               \"prompt\": \"要发送给 Claude Code 执行的详细 prompt\",\n\
               \"workingDir\": \"建议的工作目录，如果用户没指定则用 ~\"\n\
             }}\n\n\
             注意：\n\
             - cronExpression 使用标准 5 字段: 分 时 日 月 周\n\
             - prompt 应该是详细的、可直接执行的指令\n\
             - 只返回 JSON，不要其他内容",
            query
        );

        let user_path = get_user_path();
        let mut cmd = Command::new("claude");
        cmd.args(["-p", &prompt, "--output-format", "stream-json", "--verbose"])
            .env("PATH", &user_path)
            .env_remove("CLAUDECODE")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        // Set working directory to avoid running in `/`
        if let Some(dir) = config::get_default_working_dir() {
            cmd.current_dir(&dir);
        } else if let Some(home) = dirs::home_dir() {
            cmd.current_dir(home);
        }

        // Inject AI environment's API config (respects ai_enhanced setting)
        config::inject_ai_env(&mut cmd);

        let child = cmd.spawn();
        match child {
            Ok(mut process) => {
                if let Some(stdout) = process.stdout.take() {
                    let reader = std::io::BufReader::new(stdout);
                    for line in reader.lines() {
                        match line {
                            Ok(l) if !l.trim().is_empty() => {
                                let _ = app.emit("cron-ai-stream", &l);
                            }
                            _ => {}
                        }
                    }
                }
                let _ = process.wait();
                let _ = app.emit("cron-ai-done", ());
            }
            Err(e) => {
                let _ = app.emit(
                    "cron-ai-stream",
                    &serde_json::json!({"type":"error","error":format!("Failed to start claude CLI: {}",e)}).to_string(),
                );
                let _ = app.emit("cron-ai-done", ());
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        build_cron_claude_command, build_cron_launch_provenance, build_cron_user_path,
        cron_matches, enrich_run_with_provenance, expand_cron_working_dir, next_runs,
        normalize_execution_profile, normalize_optional_session_id, normalize_wecom_peer_id,
        parse_cron_field, resolve_cron_env_name, resolve_cron_wecom_notification_target,
        resolve_execution_profile, resolve_task_tool_policy, validate_cron_expression, CronTask,
        CronTaskRun, CronWecomNotification, ResolvedToolPolicy,
    };
    use crate::wecom::WecomTaskBindingTargetType;
    use std::collections::HashMap;
    use std::ffi::OsStr;
    use std::path::PathBuf;

    // ---- cron parser validation tests ----

    #[test]
    fn parse_cron_field_accepts_valid_forms() {
        // wildcard
        let v = parse_cron_field("*", 0, 59).expect("wildcard");
        assert_eq!(v.len(), 60);
        assert_eq!(v[0], 0);
        assert_eq!(v[59], 59);

        // single value
        assert_eq!(parse_cron_field("5", 0, 59).unwrap(), vec![5]);

        // explicit range
        assert_eq!(parse_cron_field("1-3", 0, 59).unwrap(), vec![1, 2, 3]);

        // step from wildcard
        assert_eq!(parse_cron_field("*/15", 0, 59).unwrap(), vec![0, 15, 30, 45]);

        // list of values
        assert_eq!(parse_cron_field("1,3,5", 0, 59).unwrap(), vec![1, 3, 5]);

        // mixed list (value + range)
        assert_eq!(parse_cron_field("0,10-12", 0, 59).unwrap(), vec![0, 10, 11, 12]);

        // boundary values
        assert_eq!(parse_cron_field("0", 0, 6).unwrap(), vec![0]);
        assert_eq!(parse_cron_field("6", 0, 6).unwrap(), vec![6]);
    }

    #[test]
    fn parse_cron_field_rejects_invalid_tokens() {
        assert!(parse_cron_field("abc", 0, 59).is_err());
        assert!(parse_cron_field("x", 0, 59).is_err());
        assert!(parse_cron_field("1,x,3", 0, 59).is_err());
    }

    #[test]
    fn parse_cron_field_rejects_out_of_range_values() {
        // minute max is 59
        let err = parse_cron_field("60", 0, 59).unwrap_err();
        assert!(err.contains("out of range"), "{err}");

        // hour max is 23
        let err = parse_cron_field("24", 0, 23).unwrap_err();
        assert!(err.contains("out of range"), "{err}");

        // range exceeding bounds is rejected (no silent clamp)
        let err = parse_cron_field("0-99", 0, 59).unwrap_err();
        assert!(err.contains("out of bounds"), "{err}");
    }

    #[test]
    fn parse_cron_field_rejects_zero_step() {
        let err = parse_cron_field("*/0", 0, 59).unwrap_err();
        assert!(err.contains("zero"), "{err}");
    }

    #[test]
    fn parse_cron_field_rejects_invalid_step_token() {
        assert!(parse_cron_field("*/x", 0, 59).is_err());
        assert!(parse_cron_field("*/", 0, 59).is_err());
    }

    #[test]
    fn parse_cron_field_rejects_inverted_range() {
        let err = parse_cron_field("5-3", 0, 59).unwrap_err();
        assert!(err.contains("inverted"), "{err}");
    }

    #[test]
    fn parse_cron_field_rejects_malformed_range() {
        // too many dashes
        assert!(parse_cron_field("1-2-3", 0, 59).is_err());
        // lone dash
        assert!(parse_cron_field("-", 0, 59).is_err());
    }

    #[test]
    fn parse_cron_field_rejects_empty_field() {
        assert!(parse_cron_field("", 0, 59).is_err());
        assert!(parse_cron_field(",", 0, 59).is_err());
    }

    #[test]
    fn validate_cron_expression_accepts_template_expressions() {
        // Every expression used by built-in templates and visual-mode presets.
        assert!(validate_cron_expression("0 9 * * 1-5").is_ok());
        assert!(validate_cron_expression("0 */4 * * *").is_ok());
        assert!(validate_cron_expression("0 18 * * 5").is_ok());
        assert!(validate_cron_expression("0 3 * * 1").is_ok());
        assert!(validate_cron_expression("0 17 * * 5").is_ok());
        assert!(validate_cron_expression("0 9 * * *").is_ok());
        assert!(validate_cron_expression("* * * * *").is_ok());
    }

    #[test]
    fn validate_cron_expression_rejects_field_count() {
        assert!(validate_cron_expression("* * * *").is_err());
        assert!(validate_cron_expression("* * * * * *").is_err());
        assert!(validate_cron_expression("").is_err());
    }

    #[test]
    fn validate_cron_expression_error_names_the_field() {
        let err = validate_cron_expression("0 99 * * *").unwrap_err();
        assert!(err.contains("hour"), "should identify hour field: {err}");

        let err = validate_cron_expression("* * * * 7").unwrap_err();
        assert!(err.contains("day-of-week"), "should identify weekday field: {err}");

        let err = validate_cron_expression("* * 32 * *").unwrap_err();
        assert!(err.contains("day-of-month"), "should identify day field: {err}");

        let err = validate_cron_expression("* * * 13 *").unwrap_err();
        assert!(err.contains("month"), "should identify month field: {err}");

        let err = validate_cron_expression("60 * * * *").unwrap_err();
        assert!(err.contains("minute"), "should identify minute field: {err}");
    }

    #[test]
    fn cron_matches_rejects_invalid_expression() {
        use chrono::Local;
        let now = Local::now();
        // Invalid expression must surface as Err, not silently Ok(false).
        assert!(cron_matches("60 * * * *", &now).is_err());
        assert!(cron_matches("abc def ghi jkl mno", &now).is_err());
        assert!(cron_matches("* * * *", &now).is_err());
    }

    #[test]
    fn next_runs_rejects_invalid_expression() {
        assert!(next_runs("60 * * * *", 3).is_err());
        assert!(next_runs("*/0 * * * *", 3).is_err());
        assert!(next_runs("1-5-9 * * * *", 3).is_err());
        assert!(next_runs("0 99 * * *", 3).is_err());
    }

    #[test]
    fn next_runs_returns_results_for_valid_expression() {
        let runs = next_runs("0 9 * * *", 3).expect("valid expression");
        assert_eq!(runs.len(), 3);
    }

    #[test]
    fn normalize_execution_profile_defaults_unknown_values() {
        assert_eq!(normalize_execution_profile("standard"), "standard");
        assert_eq!(normalize_execution_profile("autonomous"), "autonomous");
        assert_eq!(normalize_execution_profile("unknown"), "conservative");
    }

    #[test]
    fn build_cron_user_path_uses_platform_separator_and_dedupes() {
        let home = PathBuf::from("/Users/test");
        let local_bin = home.join(".local").join("bin");
        let current_path = std::env::join_paths([PathBuf::from("/usr/bin"), local_bin.clone()])
            .expect("join current path");

        let user_path = build_cron_user_path(Some(&home), Some(current_path));
        let paths = std::env::split_paths(OsStr::new(&user_path)).collect::<Vec<_>>();

        assert!(user_path.contains(if cfg!(windows) { ';' } else { ':' }));
        assert!(paths.contains(&home.join(".volta").join("bin")));
        assert_eq!(paths.iter().filter(|path| **path == local_bin).count(), 1);
    }

    #[test]
    fn resolve_cron_env_name_prefers_task_environment_for_workspace_metadata() {
        assert_eq!(
            resolve_cron_env_name(&Some("glm5.2".to_string())).as_deref(),
            Some("glm5.2")
        );
    }

    #[test]
    fn build_cron_launch_provenance_uses_task_environment_for_workspace_history() {
        let task = CronTask {
            id: "cron-1".to_string(),
            name: "Example".to_string(),
            cron_expression: "0 9 * * 1-5".to_string(),
            prompt: "Do work".to_string(),
            working_dir: "/tmp/project".to_string(),
            env_name: Some("glm5.2".to_string()),
            execution_profile: "standard".to_string(),
            max_budget_usd: None,
            allowed_tools: Vec::new(),
            disallowed_tools: Vec::new(),
            enabled: true,
            timeout_secs: 300,
            template_id: None,
            wecom_notification: None,
            trigger_type: "schedule".to_string(),
            parent_task_id: None,
            created_at: "2026-03-08T00:00:00Z".to_string(),
            updated_at: "2026-03-08T00:00:00Z".to_string(),
        };

        let provenance = build_cron_launch_provenance(&task, "run-1", "/tmp/project")
            .expect("cron launch provenance");

        assert_eq!(provenance.ccem_session_id, "run-1");
        assert_eq!(provenance.client, "claude");
        assert_eq!(provenance.env_name, "glm5.2");
        assert_eq!(provenance.config_source.as_deref(), Some("ccem"));
        assert_eq!(provenance.working_dir, "/tmp/project");
        assert_eq!(provenance.perm_mode.as_deref(), Some("default"));
        assert_eq!(provenance.launch_mode, "cron");
        assert_eq!(provenance.started_via, "cron");
        assert_eq!(provenance.source_session_id, None);
    }

    #[test]
    fn expand_cron_working_dir_expands_home_only_for_home_prefix() {
        let home = PathBuf::from("/Users/test");

        assert_eq!(
            PathBuf::from(expand_cron_working_dir("~/repo", Some(&home))),
            home.join("repo")
        );
        assert_eq!(
            PathBuf::from(expand_cron_working_dir("~\\repo", Some(&home))),
            home.join("repo")
        );
        assert_eq!(
            expand_cron_working_dir("~other/repo", Some(&home)),
            "~other/repo"
        );
        assert_eq!(expand_cron_working_dir("~/repo", None), "~/repo");
    }

    #[test]
    fn enrich_run_with_provenance_is_noop_without_record() {
        let mut run = CronTaskRun {
            id: "run-missing".to_string(),
            task_id: "task-1".to_string(),
            started_at: "2026-03-08T00:00:00Z".to_string(),
            finished_at: None,
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            duration_ms: None,
            status: "success".to_string(),
            runtime_id: None,
            runtime_kind: Some("headless".to_string()),
            provider_session_id: None,
            working_dir: None,
        };
        enrich_run_with_provenance(&mut run);
        assert!(run.provider_session_id.is_none());
    }

    #[test]
    fn normalize_optional_session_id_trims_and_drops_empty() {
        assert_eq!(normalize_optional_session_id(Some("  abc  ")).as_deref(), Some("abc"));
        assert_eq!(normalize_optional_session_id(Some("   ")), None);
        assert_eq!(normalize_optional_session_id(None), None);
    }

    #[test]
    fn resolve_execution_profile_maps_budget_and_tools() {
        let conservative = resolve_execution_profile("conservative");
        assert_eq!(conservative.permission_mode, "default");
        assert_eq!(conservative.max_budget_usd, 0.5);
        assert!(conservative.allowed_tools.contains(&"Read".to_string()));
        assert!(!conservative.allowed_tools.contains(&"Bash".to_string()));

        let standard = resolve_execution_profile("standard");
        assert_eq!(standard.permission_mode, "default");
        assert_eq!(standard.max_budget_usd, 2.0);
        assert!(standard.allowed_tools.contains(&"Bash".to_string()));
        assert!(standard.allowed_tools.contains(&"WebSearch".to_string()));

        let autonomous = resolve_execution_profile("autonomous");
        assert_eq!(autonomous.permission_mode, "bypassPermissions");
        assert_eq!(autonomous.max_budget_usd, 5.0);
        assert!(autonomous.allowed_tools.is_empty());
    }

    #[test]
    fn resolve_task_tool_policy_prefers_task_overrides() {
        let task = CronTask {
            id: "cron-1".to_string(),
            name: "Example".to_string(),
            cron_expression: "0 9 * * 1-5".to_string(),
            prompt: "Do work".to_string(),
            working_dir: "/tmp".to_string(),
            env_name: Some("glm".to_string()),
            execution_profile: "standard".to_string(),
            max_budget_usd: Some(9.5),
            allowed_tools: vec!["Read".to_string(), "Bash".to_string()],
            disallowed_tools: vec!["WebSearch".to_string()],
            enabled: true,
            timeout_secs: 300,
            template_id: None,
            wecom_notification: None,
            trigger_type: "schedule".to_string(),
            parent_task_id: None,
            created_at: "2026-03-08T00:00:00Z".to_string(),
            updated_at: "2026-03-08T00:00:00Z".to_string(),
        };

        let resolved = resolve_task_tool_policy(&task);
        assert_eq!(resolved.permission_mode, "default");
        assert_eq!(resolved.max_budget_usd, 9.5);
        assert_eq!(
            resolved.allowed_tools,
            vec!["Read".to_string(), "Bash".to_string()]
        );
        assert_eq!(resolved.disallowed_tools, vec!["WebSearch".to_string()]);
    }

    #[test]
    fn build_cron_claude_command_uses_one_shot_cli_flags() {
        let task = CronTask {
            id: "cron-1".to_string(),
            name: "Example".to_string(),
            cron_expression: "0 9 * * 1-5".to_string(),
            prompt: "Search and save report".to_string(),
            working_dir: "/tmp/project".to_string(),
            env_name: Some("glm".to_string()),
            execution_profile: "autonomous".to_string(),
            max_budget_usd: Some(9.5),
            allowed_tools: vec!["Read".to_string(), "WebSearch".to_string()],
            disallowed_tools: vec!["Bash".to_string()],
            enabled: true,
            timeout_secs: 300,
            template_id: None,
            wecom_notification: None,
            trigger_type: "schedule".to_string(),
            parent_task_id: None,
            created_at: "2026-03-08T00:00:00Z".to_string(),
            updated_at: "2026-03-08T00:00:00Z".to_string(),
        };
        let tool_policy = ResolvedToolPolicy {
            permission_mode: "bypassPermissions".to_string(),
            max_budget_usd: 9.5,
            allowed_tools: vec!["Read".to_string(), "WebSearch".to_string()],
            disallowed_tools: vec!["Bash".to_string()],
        };
        let mut env_vars = HashMap::new();
        env_vars.insert("ANTHROPIC_AUTH_TOKEN".to_string(), "token".to_string());
        let command = build_cron_claude_command(
            &task,
            "/tmp/project",
            &env_vars,
            "/usr/local/bin:/opt/homebrew/bin",
            &tool_policy,
        );
        let args = command
            .get_args()
            .map(|value| value.to_string_lossy().to_string())
            .collect::<Vec<_>>();

        assert!(args.starts_with(&[
            "-p".to_string(),
            "Search and save report".to_string(),
            "--permission-mode".to_string(),
            "bypassPermissions".to_string(),
        ]));
        assert!(args.contains(&"--max-budget-usd".to_string()));
        assert!(args.contains(&"9.50".to_string()));
        assert!(args.contains(&"--allowedTools".to_string()));
        assert!(args.contains(&"Read".to_string()));
        assert!(args.contains(&"WebSearch".to_string()));
        assert!(args.contains(&"--disallowedTools".to_string()));
        assert!(args.contains(&"Bash".to_string()));
        assert!(!args.contains(&"--input-format".to_string()));
        assert!(!args.contains(&"--output-format".to_string()));
        assert_eq!(
            command
                .get_current_dir()
                .map(|value| value.to_string_lossy().to_string()),
            Some("/tmp/project".to_string())
        );

        let envs = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().to_string(),
                    value.map(|value| value.to_string_lossy().to_string()),
                )
            })
            .collect::<HashMap<_, _>>();
        assert_eq!(
            envs.get("PATH"),
            Some(&Some("/usr/local/bin:/opt/homebrew/bin".to_string()))
        );
        assert_eq!(
            envs.get("ANTHROPIC_AUTH_TOKEN"),
            Some(&Some("token".to_string()))
        );
    }

    #[test]
    fn cron_wecom_notification_loads_from_optional_task_field() {
        let task: CronTask = serde_json::from_str(
            r#"{
                "id": "cron-1",
                "name": "Report",
                "cronExpression": "0 9 * * *",
                "prompt": "Report status",
                "workingDir": "/tmp",
                "envName": null,
                "executionProfile": "standard",
                "maxBudgetUsd": null,
                "allowedTools": [],
                "disallowedTools": [],
                "enabled": true,
                "timeoutSecs": 300,
                "templateId": null,
                "triggerType": "schedule",
                "parentTaskId": null,
                "createdAt": "2026-03-08T00:00:00Z",
                "updatedAt": "2026-03-08T00:00:00Z"
            }"#,
        )
        .expect("legacy task should deserialize");
        assert_eq!(task.wecom_notification, None);

        let task: CronTask = serde_json::from_str(
            r#"{
                "id": "cron-1",
                "name": "Report",
                "cronExpression": "0 9 * * *",
                "prompt": "Report status",
                "workingDir": "/tmp",
                "envName": null,
                "executionProfile": "standard",
                "maxBudgetUsd": null,
                "allowedTools": [],
                "disallowedTools": [],
                "enabled": true,
                "timeoutSecs": 300,
                "templateId": null,
                "wecom_notification": {
                  "bot_id": "aibot-1",
                  "peer_id": "single:iveswen"
                },
                "triggerType": "schedule",
                "parentTaskId": null,
                "createdAt": "2026-03-08T00:00:00Z",
                "updatedAt": "2026-03-08T00:00:00Z"
            }"#,
        )
        .expect("task with WeCom notification should deserialize");

        assert_eq!(
            task.wecom_notification,
            Some(CronWecomNotification {
                bot_id: Some("aibot-1".to_string()),
                peer_id: Some("single:iveswen".to_string()),
                enabled: true,
            })
        );
    }

    #[test]
    fn cron_wecom_notification_resolves_explicit_target_and_normalizes_peer() {
        let task = CronTask {
            id: "cron-1".to_string(),
            name: "Example".to_string(),
            cron_expression: "0 9 * * *".to_string(),
            prompt: "Do work".to_string(),
            working_dir: "/tmp".to_string(),
            env_name: None,
            execution_profile: "standard".to_string(),
            max_budget_usd: None,
            allowed_tools: Vec::new(),
            disallowed_tools: Vec::new(),
            enabled: true,
            timeout_secs: 300,
            template_id: None,
            wecom_notification: Some(CronWecomNotification {
                bot_id: Some("aibot-1".to_string()),
                peer_id: Some("iveswen".to_string()),
                enabled: true,
            }),
            trigger_type: "schedule".to_string(),
            parent_task_id: None,
            created_at: "2026-03-08T00:00:00Z".to_string(),
            updated_at: "2026-03-08T00:00:00Z".to_string(),
        };

        assert_eq!(
            resolve_cron_wecom_notification_target(&task),
            Some(("aibot-1".to_string(), "single:iveswen".to_string()))
        );
        assert_eq!(
            normalize_wecom_peer_id(Some(&WecomTaskBindingTargetType::Group), "chat-1"),
            "group:chat-1"
        );
        assert_eq!(
            normalize_wecom_peer_id(Some(&WecomTaskBindingTargetType::User), "single:iveswen"),
            "single:iveswen"
        );
    }
}
