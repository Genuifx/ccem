// apps/desktop/src-tauri/src/analytics.rs
//
// Native JSONL scanner for Claude, Codex, and OpenCode usage.

use crate::config;
use crate::opencode;
use chrono::{Datelike, Local, NaiveDate};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

const SOURCE_CLAUDE: &str = "claude";
const SOURCE_CODEX: &str = "codex";
const SOURCE_OPENCODE: &str = "opencode";
const USAGE_CACHE_VERSION: u32 = 2;
const USAGE_SUMMARY_VERSION: u32 = 1;
const USAGE_STATS_MEMO_TTL: Duration = Duration::from_secs(60);
const OPENCODE_NATIVE_ENV_NAME: &str = opencode::OPENCODE_NATIVE_ENV_NAME;
static USAGE_REFRESH_LOCK: Mutex<()> = Mutex::new(());
static USAGE_STATS_MEMO: OnceLock<Mutex<UsageStatsMemo>> = OnceLock::new();

// ============================================================================
// Output types — sent to frontend (must use camelCase)
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageWithCost {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cost: f64,
}

impl TokenUsageWithCost {
    fn add(&mut self, other: &TokenUsageWithCost) {
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        self.cache_read_tokens += other.cache_read_tokens;
        self.cache_creation_tokens += other.cache_creation_tokens;
        self.cost += other.cost;
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageStats {
    pub today: TokenUsageWithCost,
    pub week: TokenUsageWithCost,
    pub month: TokenUsageWithCost,
    pub total: TokenUsageWithCost,
    pub daily_history: HashMap<String, TokenUsageWithCost>,
    pub hourly_history: HashMap<String, TokenUsageWithCost>,
    pub by_model: HashMap<String, TokenUsageWithCost>,
    pub by_environment: HashMap<String, TokenUsageWithCost>,
    pub last_updated: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageSummaryFile {
    version: u32,
    stats: UsageStats,
}

struct CachedUsageStats {
    collected_at: Instant,
    stats: UsageStats,
}

#[derive(Default)]
struct UsageStatsMemo {
    by_source: HashMap<&'static str, CachedUsageStats>,
}

pub type ModelBreakdownHistory = HashMap<String, HashMap<String, TokenUsageWithCost>>;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageHistory {
    pub daily: HashMap<String, TokenUsageWithCost>,
    pub by_model: HashMap<String, TokenUsageWithCost>,
    pub by_environment: HashMap<String, TokenUsageWithCost>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ModelBreakdownGranularity {
    Hour,
    Day,
    Week,
    Month,
}

impl ModelBreakdownGranularity {
    fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "hour" => Ok(Self::Hour),
            "day" => Ok(Self::Day),
            "week" => Ok(Self::Week),
            "month" => Ok(Self::Month),
            other => Err(format!(
                "Unsupported granularity '{}'. Use hour, day, week, or month.",
                other
            )),
        }
    }
}

// ============================================================================
// Cache types — shared with ~/.ccem/usage-cache.json
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CacheFile {
    #[serde(default = "default_cache_version")]
    version: u32,
    #[serde(default)]
    files: HashMap<String, CacheFileEntry>,
    #[serde(default)]
    last_updated: Option<String>,
}

fn default_cache_version() -> u32 {
    USAGE_CACHE_VERSION
}

impl Default for CacheFile {
    fn default() -> Self {
        Self {
            version: USAGE_CACHE_VERSION,
            files: HashMap::new(),
            last_updated: None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct CacheFileEntry {
    #[serde(default)]
    meta: CacheMeta,
    #[serde(default)]
    stats: CacheStats,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
struct CacheMeta {
    #[serde(default)]
    mtime: f64,
    #[serde(default)]
    size: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
struct CacheStats {
    #[serde(default)]
    entries: Vec<CacheEntry>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct CacheEntry {
    timestamp: String,
    model: String,
    #[serde(default)]
    environment: Option<String>,
    usage: CacheUsage,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct CacheUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_read_tokens: u64,
    #[serde(default)]
    cache_creation_tokens: u64,
    #[serde(default)]
    cost: f64,
}

// ============================================================================
// Model pricing
// ============================================================================

#[derive(Debug, Deserialize, Clone)]
struct ModelPrice {
    input_cost_per_token: f64,
    output_cost_per_token: f64,
    cache_read_input_token_cost: Option<f64>,
    cache_creation_input_token_cost: Option<f64>,
}

/// Default prices matching CLI defaults for Claude models.
fn default_prices() -> HashMap<String, ModelPrice> {
    let mut m = HashMap::new();
    m.insert(
        "claude-opus-4-5".to_string(),
        ModelPrice {
            input_cost_per_token: 5e-6,
            output_cost_per_token: 25e-6,
            cache_read_input_token_cost: Some(0.5e-6),
            cache_creation_input_token_cost: Some(6.25e-6),
        },
    );
    m.insert(
        "claude-sonnet-4-5".to_string(),
        ModelPrice {
            input_cost_per_token: 3e-6,
            output_cost_per_token: 15e-6,
            cache_read_input_token_cost: Some(0.3e-6),
            cache_creation_input_token_cost: Some(3.75e-6),
        },
    );
    m.insert(
        "claude-haiku-4-5".to_string(),
        ModelPrice {
            input_cost_per_token: 1e-6,
            output_cost_per_token: 5e-6,
            cache_read_input_token_cost: Some(0.1e-6),
            cache_creation_input_token_cost: Some(1.25e-6),
        },
    );
    m
}

/// Load model prices from ~/.ccem/model-prices.json, falling back to defaults.
fn load_model_prices() -> HashMap<String, ModelPrice> {
    let prices_path = config::get_ccem_dir().join("model-prices.json");
    if let Ok(content) = fs::read_to_string(&prices_path) {
        if let Ok(prices) = serde_json::from_str::<HashMap<String, ModelPrice>>(&content) {
            if !prices.is_empty() {
                return prices;
            }
        }
    }
    default_prices()
}

// ============================================================================
// Model name normalization
// ============================================================================

/// Remove date suffixes, bedrock versions, provider prefixes.
fn normalize_model_name(model: &str) -> String {
    let mut s = model.to_string();

    // Remove date version suffix: -20250929, -20250929-v1:0
    if let Some(pos) = s.find("-20") {
        if s.len() > pos + 9 {
            let maybe_date = &s[pos + 1..pos + 9];
            if maybe_date.chars().all(|c| c.is_ascii_digit()) {
                s = s[..pos].to_string();
            }
        } else if s.len() == pos + 9 {
            let maybe_date = &s[pos + 1..];
            if maybe_date.chars().all(|c| c.is_ascii_digit()) {
                s = s[..pos].to_string();
            }
        }
    }

    // Remove bedrock version: -v1:0
    if let Some(pos) = s.find("-v") {
        let rest = &s[pos + 2..];
        if rest.contains(':') && rest.chars().next().is_some_and(|c| c.is_ascii_digit()) {
            s = s[..pos].to_string();
        }
    }

    // Remove provider prefixes.
    if let Some(stripped) = s.strip_prefix("anthropic.") {
        s = stripped.to_string();
    }
    if let Some(stripped) = s.strip_prefix("vertex_ai/") {
        s = stripped.to_string();
    }

    // Remove @ suffix.
    if let Some(pos) = s.find('@') {
        s = s[..pos].to_string();
    }

    s
}

/// Look up model price: direct -> normalized -> fuzzy -> keyword fallback (Claude only).
fn get_model_price<'a>(
    model: &str,
    prices: &'a HashMap<String, ModelPrice>,
) -> Option<&'a ModelPrice> {
    if let Some(p) = prices.get(model) {
        return Some(p);
    }

    let normalized = normalize_model_name(model);
    if let Some(p) = prices.get(&normalized) {
        return Some(p);
    }

    for (key, value) in prices {
        let norm_key = normalize_model_name(key);
        if key.contains(&normalized) || normalized.contains(&norm_key) {
            return Some(value);
        }
    }

    // Keep a conservative fallback only for explicit Claude model families.
    let model_lower = model.to_ascii_lowercase();
    if model_lower.contains("claude")
        || model_lower.contains("opus")
        || model_lower.contains("sonnet")
        || model_lower.contains("haiku")
    {
        if model_lower.contains("opus") {
            return prices.get("claude-opus-4-5");
        }
        if model_lower.contains("haiku") {
            return prices.get("claude-haiku-4-5");
        }
        return prices.get("claude-sonnet-4-5");
    }

    None
}

/// Calculate cost for a single usage entry.
fn calculate_cost(
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    price: &ModelPrice,
) -> f64 {
    input_tokens as f64 * price.input_cost_per_token
        + output_tokens as f64 * price.output_cost_per_token
        + cache_read_tokens as f64 * price.cache_read_input_token_cost.unwrap_or(0.0)
        + cache_creation_tokens as f64 * price.cache_creation_input_token_cost.unwrap_or(0.0)
}

fn calculate_cost_or_zero(
    model: &str,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    prices: &HashMap<String, ModelPrice>,
) -> f64 {
    match get_model_price(model, prices) {
        Some(price) => calculate_cost(
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_creation_tokens,
            price,
        ),
        None => 0.0,
    }
}

// ============================================================================
// JSONL file discovery
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UsageSource {
    Claude,
    Codex,
}

#[derive(Debug, Clone)]
struct DiscoveredFile {
    path: PathBuf,
    source: UsageSource,
}

fn discover_jsonl_files() -> Vec<DiscoveredFile> {
    let mut files = Vec::new();
    files.extend(discover_claude_jsonl_files());
    files.extend(discover_codex_jsonl_files());
    files
}

/// Scan ~/.claude/projects/*/*.jsonl
fn discover_claude_jsonl_files() -> Vec<DiscoveredFile> {
    let mut files = Vec::new();
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return files,
    };

    let projects_dir = home.join(".claude").join("projects");
    if !projects_dir.exists() {
        return files;
    }

    let projects = match fs::read_dir(&projects_dir) {
        Ok(entries) => entries,
        Err(_) => return files,
    };

    for project_entry in projects.flatten() {
        let project_path = project_entry.path();
        if !project_path.is_dir() {
            continue;
        }
        // Depth-limited walk: main transcripts sit directly in the project
        // dir, while subagent transcripts (Task tool / dynamic routing) live
        // under `<session-id>/subagents/agent-*.jsonl` — 2 levels deeper.
        collect_claude_jsonl_dir(&project_path, 0, 3, &mut files);
    }

    files
}

fn collect_claude_jsonl_dir(dir: &Path, depth: usize, max_depth: usize, out: &mut Vec<DiscoveredFile>) {
    if depth > max_depth {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_dir = path.is_dir();
        if is_dir {
            collect_claude_jsonl_dir(&path, depth + 1, max_depth, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(DiscoveredFile {
                path,
                source: UsageSource::Claude,
            });
        }
    }
}

/// Scan ~/.codex/sessions recursively for *.jsonl
fn discover_codex_jsonl_files() -> Vec<DiscoveredFile> {
    let mut files = Vec::new();
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return files,
    };

    let sessions_dir = home.join(".codex").join("sessions");
    if !sessions_dir.exists() {
        return files;
    }

    let mut stack = vec![sessions_dir];
    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }

            if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                files.push(DiscoveredFile {
                    path,
                    source: UsageSource::Codex,
                });
            }
        }
    }

    files
}

// ============================================================================
// File metadata
// ============================================================================

/// Get mtime in milliseconds (matching Node.js stat.mtimeMs) and size in bytes.
fn get_file_meta(path: &PathBuf) -> Option<CacheMeta> {
    let metadata = fs::metadata(path).ok()?;
    let mtime = metadata.modified().ok()?;
    let duration = mtime.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(CacheMeta {
        mtime: duration.as_millis() as f64,
        size: metadata.len(),
    })
}

// ============================================================================
// Claude JSONL parsing
// ============================================================================

#[derive(Debug, Deserialize)]
struct ClaudeJsonlLine {
    #[serde(rename = "type")]
    entry_type: Option<String>,
    timestamp: Option<String>,
    message: Option<ClaudeJsonlMessage>,
}

#[derive(Debug, Deserialize)]
struct ClaudeJsonlMessage {
    model: Option<String>,
    usage: Option<ClaudeJsonlUsage>,
}

#[derive(Debug, Deserialize)]
struct ClaudeJsonlUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
}

fn parse_claude_jsonl_file(path: &PathBuf, prices: &HashMap<String, ModelPrice>) -> CacheStats {
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return CacheStats::default(),
    };

    let reader = BufReader::new(file);
    parse_claude_jsonl_reader(reader, prices)
}

fn parse_claude_jsonl_reader<R: BufRead>(
    reader: R,
    prices: &HashMap<String, ModelPrice>,
) -> CacheStats {
    let mut entries = Vec::new();

    for line_result in reader.lines() {
        let line = match line_result {
            Ok(line) => line,
            Err(_) => continue,
        };
        if line.trim().is_empty() {
            continue;
        }

        let parsed: ClaudeJsonlLine = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };

        if parsed.entry_type.as_deref() != Some("assistant") {
            continue;
        }

        let message = match parsed.message {
            Some(message) => message,
            None => continue,
        };

        let usage = match message.usage {
            Some(usage) => usage,
            None => continue,
        };

        let model = message.model.unwrap_or_else(|| "unknown".to_string());
        let input_tokens = usage.input_tokens.unwrap_or(0);
        let output_tokens = usage.output_tokens.unwrap_or(0);
        let cache_read_tokens = usage.cache_read_input_tokens.unwrap_or(0);
        let cache_creation_tokens = usage.cache_creation_input_tokens.unwrap_or(0);

        let cost = calculate_cost_or_zero(
            &model,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_creation_tokens,
            prices,
        );

        let timestamp = parsed
            .timestamp
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

        entries.push(CacheEntry {
            timestamp,
            model,
            environment: None,
            usage: CacheUsage {
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_creation_tokens,
                cost,
            },
        });
    }

    CacheStats { entries }
}

// ============================================================================
// Codex JSONL parsing
// ============================================================================

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct CodexTotals {
    input_tokens: u64,
    cached_input_tokens: u64,
    output_tokens: u64,
    reasoning_output_tokens: u64,
}

impl CodexTotals {
    fn from_value(value: &serde_json::Value) -> Option<Self> {
        Some(Self {
            input_tokens: value.get("input_tokens")?.as_u64()?,
            cached_input_tokens: value
                .get("cached_input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
            output_tokens: value.get("output_tokens")?.as_u64()?,
            reasoning_output_tokens: value
                .get("reasoning_output_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
        })
    }

    fn diff_from(&self, last: &Self) -> Self {
        // If totals go backwards, treat this as a reset and restart from current totals.
        if self.input_tokens < last.input_tokens
            || self.cached_input_tokens < last.cached_input_tokens
            || self.output_tokens < last.output_tokens
            || self.reasoning_output_tokens < last.reasoning_output_tokens
        {
            return self.clone();
        }

        Self {
            input_tokens: self.input_tokens.saturating_sub(last.input_tokens),
            cached_input_tokens: self
                .cached_input_tokens
                .saturating_sub(last.cached_input_tokens),
            output_tokens: self.output_tokens.saturating_sub(last.output_tokens),
            reasoning_output_tokens: self
                .reasoning_output_tokens
                .saturating_sub(last.reasoning_output_tokens),
        }
    }

    fn non_cache_input_tokens(&self) -> u64 {
        self.input_tokens.saturating_sub(self.cached_input_tokens)
    }

    fn total_output_tokens(&self) -> u64 {
        self.output_tokens
            .saturating_add(self.reasoning_output_tokens)
    }

    fn is_zero(&self) -> bool {
        self.input_tokens == 0
            && self.cached_input_tokens == 0
            && self.output_tokens == 0
            && self.reasoning_output_tokens == 0
    }
}

fn parse_codex_jsonl_file(path: &PathBuf, prices: &HashMap<String, ModelPrice>) -> CacheStats {
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return CacheStats::default(),
    };

    let reader = BufReader::new(file);
    parse_codex_jsonl_reader(reader, prices)
}

fn parse_codex_jsonl_reader<R: BufRead>(
    reader: R,
    prices: &HashMap<String, ModelPrice>,
) -> CacheStats {
    let mut entries = Vec::new();

    let mut current_model: Option<String> = None;
    let mut last_total: Option<CodexTotals> = None;

    for line_result in reader.lines() {
        let line = match line_result {
            Ok(line) => line,
            Err(_) => continue,
        };
        if line.trim().is_empty() {
            continue;
        }

        let parsed: serde_json::Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };

        let line_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let payload = parsed.get("payload").unwrap_or(&serde_json::Value::Null);

        match line_type {
            "session_meta" => {
                if let Some(model) = payload.get("model").and_then(|v| v.as_str()) {
                    current_model = Some(model.to_string());
                }
            }
            "turn_context" => {
                if let Some(model) = payload.get("model").and_then(|v| v.as_str()) {
                    current_model = Some(model.to_string());
                }
            }
            "event_msg" => {
                if payload.get("type").and_then(|v| v.as_str()) != Some("token_count") {
                    continue;
                }

                let total_usage = match payload
                    .get("info")
                    .and_then(|v| v.get("total_token_usage"))
                    .and_then(CodexTotals::from_value)
                {
                    Some(total) => total,
                    None => continue,
                };

                if last_total.as_ref() == Some(&total_usage) {
                    continue;
                }

                let last_usage = payload
                    .get("info")
                    .and_then(|v| v.get("last_token_usage"))
                    .and_then(CodexTotals::from_value);

                let delta = match last_usage {
                    Some(last_usage) => last_usage,
                    None => match &last_total {
                        Some(last) => total_usage.diff_from(last),
                        None => total_usage.clone(),
                    },
                };
                last_total = Some(total_usage);

                if delta.is_zero() {
                    continue;
                }

                let model = current_model
                    .clone()
                    .unwrap_or_else(|| "unknown".to_string());
                let input_tokens = delta.non_cache_input_tokens();
                let cache_read_tokens = delta.cached_input_tokens;
                let output_tokens = delta.total_output_tokens();
                let cache_creation_tokens = 0;

                let cost = calculate_cost_or_zero(
                    &model,
                    input_tokens,
                    output_tokens,
                    cache_read_tokens,
                    cache_creation_tokens,
                    prices,
                );

                let timestamp = parsed
                    .get("timestamp")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

                entries.push(CacheEntry {
                    timestamp,
                    model,
                    environment: None,
                    usage: CacheUsage {
                        input_tokens,
                        output_tokens,
                        cache_read_tokens,
                        cache_creation_tokens,
                        cost,
                    },
                });
            }
            _ => {}
        }
    }

    CacheStats { entries }
}

// ============================================================================
// Cache read / write
// ============================================================================

fn usage_cache_path() -> PathBuf {
    config::get_ccem_dir().join("usage-cache.json")
}

fn usage_summary_path() -> PathBuf {
    config::get_ccem_dir().join("usage-summary.json")
}

fn read_usage_cache() -> CacheFile {
    let cache_path = usage_cache_path();
    if !cache_path.exists() {
        return CacheFile::default();
    }
    let content = match fs::read_to_string(&cache_path) {
        Ok(c) => c,
        Err(_) => return CacheFile::default(),
    };
    match serde_json::from_str::<CacheFile>(&content) {
        Ok(cache) if cache.version == USAGE_CACHE_VERSION => cache,
        _ => CacheFile::default(),
    }
}

fn replace_file(temp_path: &Path, target_path: &Path) -> std::io::Result<()> {
    #[cfg(not(target_os = "windows"))]
    {
        fs::rename(temp_path, target_path)
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };

        let temp_wide = temp_path
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let target_wide = target_path
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let moved = unsafe {
            MoveFileExW(
                temp_wide.as_ptr(),
                target_wide.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if moved == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create usage cache directory: {error}"))?;
    }

    let temp_path = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let result = (|| {
        let file = File::create(&temp_path)
            .map_err(|error| format!("Failed to create usage cache temp file: {error}"))?;
        let mut writer = BufWriter::new(file);
        serde_json::to_writer_pretty(&mut writer, value)
            .map_err(|error| format!("Failed to serialize usage cache: {error}"))?;
        writer
            .flush()
            .map_err(|error| format!("Failed to flush usage cache: {error}"))?;
        writer
            .get_ref()
            .sync_all()
            .map_err(|error| format!("Failed to sync usage cache: {error}"))?;
        replace_file(&temp_path, path)
            .map_err(|error| format!("Failed to replace usage cache: {error}"))
    })();

    if result.is_err() {
        let _ = fs::remove_file(temp_path);
    }
    result
}

fn write_usage_cache(cache: &CacheFile) {
    if config::ensure_ccem_dir().is_err() {
        return;
    }
    if let Err(error) = write_json_atomic(&usage_cache_path(), cache) {
        eprintln!("Usage cache write warning: {error}");
    }
}

fn read_usage_summary_from(path: &Path) -> Option<UsageStats> {
    let content = fs::read_to_string(path).ok()?;
    let summary = serde_json::from_str::<UsageSummaryFile>(&content).ok()?;
    (summary.version == USAGE_SUMMARY_VERSION).then_some(summary.stats)
}

fn write_usage_summary_to(path: &Path, stats: &UsageStats) -> Result<(), String> {
    write_json_atomic(
        path,
        &UsageSummaryFile {
            version: USAGE_SUMMARY_VERSION,
            stats: stats.clone(),
        },
    )
}

fn write_usage_summary(stats: &UsageStats) {
    if let Err(error) = write_usage_summary_to(&usage_summary_path(), stats) {
        eprintln!("Usage summary write warning: {error}");
    }
}

fn usage_stats_memo() -> &'static Mutex<UsageStatsMemo> {
    USAGE_STATS_MEMO.get_or_init(|| Mutex::new(UsageStatsMemo::default()))
}

fn lock_usage_stats_memo() -> MutexGuard<'static, UsageStatsMemo> {
    usage_stats_memo()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn lock_usage_refresh() -> MutexGuard<'static, ()> {
    USAGE_REFRESH_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn should_reuse_usage_stats(
    force_requested: bool,
    collected_at: Instant,
    request_started: Instant,
) -> bool {
    if force_requested {
        return collected_at >= request_started;
    }

    collected_at.elapsed() < USAGE_STATS_MEMO_TTL
}

fn read_tray_usage_stats() -> Option<UsageStats> {
    if let Some(stats) = usage_stats_memo()
        .try_lock()
        .ok()
        .and_then(|memo| memo.by_source.get("all").map(|cached| cached.stats.clone()))
    {
        return Some(stats);
    }

    read_usage_summary_from(&usage_summary_path())
}

fn cache_files_have_same_meta(
    existing: &HashMap<String, CacheFileEntry>,
    next: &HashMap<String, CacheFileEntry>,
) -> bool {
    existing.len() == next.len()
        && next.iter().all(|(path, entry)| {
            existing.get(path).is_some_and(|cached| {
                (cached.meta.mtime - entry.meta.mtime).abs() < 1.0
                    && cached.meta.size == entry.meta.size
            })
        })
}

// ============================================================================
// Orchestration: incremental refresh
// ============================================================================

/// Refresh usage cache by scanning known usage files incrementally.
fn refresh_usage_cache() -> CacheFile {
    let _process_guard = lock_usage_refresh();
    let _ = config::ensure_ccem_dir();
    let lock_path = config::get_ccem_dir().join("usage-cache.lock");
    let lock_file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(lock_path)
        .ok();

    if let Some(file) = lock_file.as_ref() {
        if file.lock_exclusive().is_err() {
            return read_usage_cache();
        }
    }

    let refreshed = refresh_usage_cache_locked();
    if let Some(file) = lock_file.as_ref() {
        let _ = FileExt::unlock(file);
    }
    refreshed
}

fn refresh_usage_cache_locked() -> CacheFile {
    let prices = load_model_prices();
    let jsonl_files = discover_jsonl_files();
    let existing_cache = read_usage_cache();

    let mut new_cache = CacheFile {
        version: USAGE_CACHE_VERSION,
        files: HashMap::new(),
        last_updated: Some(Local::now().to_rfc3339()),
    };

    for discovered in jsonl_files {
        let path_str = discovered.path.to_string_lossy().to_string();

        let meta = match get_file_meta(&discovered.path) {
            Some(m) => m,
            None => continue,
        };

        let cache_valid = existing_cache.files.get(&path_str).is_some_and(|cached| {
            (cached.meta.mtime - meta.mtime).abs() < 1.0 && cached.meta.size == meta.size
        });

        let stats = if cache_valid {
            existing_cache.files[&path_str].stats.clone()
        } else {
            match discovered.source {
                UsageSource::Claude => parse_claude_jsonl_file(&discovered.path, &prices),
                UsageSource::Codex => parse_codex_jsonl_file(&discovered.path, &prices),
            }
        };

        new_cache
            .files
            .insert(path_str, CacheFileEntry { meta, stats });
    }

    for (path_key, entry) in load_opencode_cache_entries(&prices, &existing_cache) {
        new_cache.files.insert(path_key, entry);
    }

    if !cache_files_have_same_meta(&existing_cache.files, &new_cache.files) {
        write_usage_cache(&new_cache);
    }
    new_cache
}

fn load_opencode_cache_entries(
    prices: &HashMap<String, ModelPrice>,
    existing_cache: &CacheFile,
) -> HashMap<String, CacheFileEntry> {
    let local_sessions = opencode::list_local_sessions()
        .unwrap_or_default()
        .into_iter()
        .map(|session| (session.id.clone(), session))
        .collect::<HashMap<_, _>>();

    let Some(session_list) = opencode::load_session_list_value_from_cli_or_fixture()
        .ok()
        .flatten()
    else {
        return build_local_opencode_cache_entries(&local_sessions, existing_cache);
    };

    let Some(items) = parse_opencode_session_items(&session_list) else {
        return build_local_opencode_cache_entries(&local_sessions, existing_cache);
    };

    let mut entries = HashMap::new();
    for session in items {
        let path_key = format!("opencode://session/{}", session.id);
        let local_session = local_sessions.get(&session.id);
        let meta = CacheMeta {
            mtime: session
                .updated_at
                .or_else(|| local_session.map(|item| item.updated_at))
                .unwrap_or(0) as f64,
            size: 0,
        };

        let cache_valid = existing_cache.files.get(&path_key).is_some_and(|cached| {
            (cached.meta.mtime - meta.mtime).abs() < 1.0 && cached.meta.size == meta.size
        });

        let stats = if cache_valid {
            existing_cache.files[&path_key].stats.clone()
        } else {
            opencode::load_export_from_cli_or_fixture(&session.id)
                .ok()
                .flatten()
                .map(|value| parse_opencode_export_stats(&value, &session.environment, prices))
                .or_else(|| local_session.map(local_opencode_session_to_cache_stats))
                .unwrap_or_default()
        };

        entries.insert(path_key, CacheFileEntry { meta, stats });
    }

    for (session_id, session) in &local_sessions {
        let path_key = format!("opencode://session/{session_id}");
        if entries.contains_key(&path_key) {
            continue;
        }

        let meta = CacheMeta {
            mtime: session.updated_at as f64,
            size: 0,
        };

        let cache_valid = existing_cache.files.get(&path_key).is_some_and(|cached| {
            (cached.meta.mtime - meta.mtime).abs() < 1.0 && cached.meta.size == meta.size
        });

        let stats = if cache_valid {
            existing_cache.files[&path_key].stats.clone()
        } else {
            local_opencode_session_to_cache_stats(session)
        };

        entries.insert(path_key, CacheFileEntry { meta, stats });
    }

    entries
}

#[derive(Debug, Clone)]
struct OpenCodeSessionItem {
    id: String,
    updated_at: Option<u64>,
    environment: String,
}

fn build_local_opencode_cache_entries(
    local_sessions: &HashMap<String, opencode::LocalOpenCodeSession>,
    existing_cache: &CacheFile,
) -> HashMap<String, CacheFileEntry> {
    let mut entries = HashMap::new();

    for session in local_sessions.values() {
        let path_key = format!("opencode://session/{}", session.id);
        let meta = CacheMeta {
            mtime: session.updated_at as f64,
            size: 0,
        };

        let cache_valid = existing_cache.files.get(&path_key).is_some_and(|cached| {
            (cached.meta.mtime - meta.mtime).abs() < 1.0 && cached.meta.size == meta.size
        });

        let stats = if cache_valid {
            existing_cache.files[&path_key].stats.clone()
        } else {
            local_opencode_session_to_cache_stats(session)
        };

        entries.insert(path_key, CacheFileEntry { meta, stats });
    }

    entries
}

fn local_opencode_session_to_cache_stats(session: &opencode::LocalOpenCodeSession) -> CacheStats {
    let timestamp_ms = session.updated_at.max(session.created_at);
    let timestamp = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(timestamp_ms as i64)
        .map(|value| value.to_rfc3339())
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

    CacheStats {
        entries: vec![CacheEntry {
            timestamp,
            model: session
                .model
                .clone()
                .unwrap_or_else(|| "unknown".to_string()),
            environment: session.env_name.clone(),
            usage: CacheUsage {
                input_tokens: session.prompt_tokens,
                output_tokens: session.completion_tokens,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
                cost: session.cost,
            },
        }],
    }
}

fn parse_opencode_session_items(value: &Value) -> Option<Vec<OpenCodeSessionItem>> {
    let items = if let Some(array) = value.as_array() {
        array
    } else {
        value.get("sessions")?.as_array()?
    };

    let mut sessions = Vec::new();
    for item in items {
        let Some(id) = extract_opencode_string(item, &["id", "sessionId", "session_id"]) else {
            continue;
        };

        let metadata = opencode::read_session_metadata(&id);
        let environment = extract_opencode_string(item, &["envName", "environment", "env"])
            .or_else(|| metadata.as_ref().map(|entry| entry.env_name.clone()))
            .or_else(|| {
                extract_opencode_string(item, &["configSource"]).and_then(|source| {
                    if source.eq_ignore_ascii_case("native") {
                        Some(OPENCODE_NATIVE_ENV_NAME.to_string())
                    } else {
                        metadata.as_ref().map(|entry| entry.env_name.clone())
                    }
                })
            })
            .unwrap_or_else(|| OPENCODE_NATIVE_ENV_NAME.to_string());

        sessions.push(OpenCodeSessionItem {
            id,
            updated_at: extract_opencode_timestamp(item),
            environment,
        });
    }

    Some(sessions)
}

fn parse_opencode_export_stats(
    value: &Value,
    environment: &str,
    prices: &HashMap<String, ModelPrice>,
) -> CacheStats {
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    collect_opencode_usage_entries(value, None, environment, prices, &mut seen, &mut entries);
    CacheStats { entries }
}

fn collect_opencode_usage_entries(
    value: &Value,
    current_model: Option<String>,
    environment: &str,
    prices: &HashMap<String, ModelPrice>,
    seen: &mut HashSet<String>,
    entries: &mut Vec<CacheEntry>,
) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_opencode_usage_entries(
                    item,
                    current_model.clone(),
                    environment,
                    prices,
                    seen,
                    entries,
                );
            }
        }
        Value::Object(object) => {
            let next_model = extract_opencode_string(value, &["model"]).or(current_model.clone());
            if let Some(entry) =
                build_opencode_cache_entry(value, next_model.as_deref(), environment, prices)
            {
                let fingerprint = format!(
                    "{}|{}|{}|{}|{}|{}|{}",
                    entry.timestamp,
                    entry.model,
                    entry.usage.input_tokens,
                    entry.usage.output_tokens,
                    entry.usage.cache_read_tokens,
                    entry.usage.cache_creation_tokens,
                    entry.usage.cost
                );
                if seen.insert(fingerprint) {
                    entries.push(entry);
                }
            }

            for child in object.values() {
                collect_opencode_usage_entries(
                    child,
                    next_model.clone(),
                    environment,
                    prices,
                    seen,
                    entries,
                );
            }
        }
        _ => {}
    }
}

fn build_opencode_cache_entry(
    value: &Value,
    fallback_model: Option<&str>,
    environment: &str,
    prices: &HashMap<String, ModelPrice>,
) -> Option<CacheEntry> {
    let usage_node = value
        .get("usage")
        .or_else(|| value.get("tokens"))
        .or_else(|| value.get("stats"))?;
    let usage = parse_opencode_cache_usage(usage_node)?;
    if usage.input_tokens == 0
        && usage.output_tokens == 0
        && usage.cache_read_tokens == 0
        && usage.cache_creation_tokens == 0
        && usage.cost == 0.0
    {
        return None;
    }

    let timestamp = extract_opencode_timestamp(value)
        .and_then(|timestamp| {
            chrono::DateTime::<chrono::Utc>::from_timestamp_millis(timestamp as i64)
        })
        .map(|timestamp| timestamp.to_rfc3339())
        .or_else(|| extract_opencode_string(value, &["timestamp", "createdAt", "updatedAt"]))?;

    let model = extract_opencode_string(value, &["model"])
        .or_else(|| fallback_model.map(|model| model.to_string()))
        .unwrap_or_else(|| "unknown".to_string());

    let cost = if usage.cost > 0.0 {
        usage.cost
    } else {
        calculate_cost_or_zero(
            &model,
            usage.input_tokens,
            usage.output_tokens,
            usage.cache_read_tokens,
            usage.cache_creation_tokens,
            prices,
        )
    };

    Some(CacheEntry {
        timestamp,
        model,
        environment: Some(environment.to_string()),
        usage: CacheUsage {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read_tokens: usage.cache_read_tokens,
            cache_creation_tokens: usage.cache_creation_tokens,
            cost,
        },
    })
}

fn parse_opencode_cache_usage(value: &Value) -> Option<CacheUsage> {
    let object = value.as_object()?;

    Some(CacheUsage {
        input_tokens: object
            .get("inputTokens")
            .or_else(|| object.get("input_tokens"))
            .and_then(|value| value.as_u64())
            .unwrap_or(0),
        output_tokens: object
            .get("outputTokens")
            .or_else(|| object.get("output_tokens"))
            .and_then(|value| value.as_u64())
            .unwrap_or(0),
        cache_read_tokens: object
            .get("cacheReadTokens")
            .or_else(|| object.get("cache_read_tokens"))
            .and_then(|value| value.as_u64())
            .unwrap_or(0),
        cache_creation_tokens: object
            .get("cacheCreationTokens")
            .or_else(|| object.get("cache_creation_tokens"))
            .and_then(|value| value.as_u64())
            .unwrap_or(0),
        cost: object
            .get("cost")
            .and_then(|value| value.as_f64())
            .unwrap_or(0.0),
    })
}

fn extract_opencode_string(value: &Value, keys: &[&str]) -> Option<String> {
    let object = value.as_object()?;
    for key in keys {
        let Some(raw) = object.get(*key) else {
            continue;
        };
        if let Some(text) = raw.as_str().filter(|text| !text.trim().is_empty()) {
            return Some(text.to_string());
        }
        if let Some(path) = raw
            .as_object()
            .and_then(|nested| nested.get("path"))
            .and_then(|nested| nested.as_str())
            .filter(|text| !text.trim().is_empty())
        {
            return Some(path.to_string());
        }
    }
    None
}

fn extract_opencode_timestamp(value: &Value) -> Option<u64> {
    for key in ["timestamp", "updatedAt", "createdAt", "lastUpdated"] {
        let Some(raw) = value.get(key) else {
            continue;
        };
        if let Some(number) = raw.as_u64() {
            return Some(normalize_unix_timestamp(number));
        }
        if let Some(text) = raw.as_str().filter(|text| !text.trim().is_empty()) {
            if let Ok(number) = text.parse::<u64>() {
                return Some(normalize_unix_timestamp(number));
            }
            if let Ok(timestamp) = chrono::DateTime::parse_from_rfc3339(text) {
                return Some(timestamp.timestamp_millis() as u64);
            }
        }
    }
    None
}

fn normalize_unix_timestamp(timestamp: u64) -> u64 {
    if timestamp > 10_000_000_000 {
        timestamp
    } else {
        timestamp.saturating_mul(1000)
    }
}

// ============================================================================
// Timestamp helpers
// ============================================================================

fn parse_to_local(timestamp: &str) -> Option<chrono::DateTime<Local>> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(timestamp) {
        return Some(dt.into());
    }

    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(
        timestamp.trim_end_matches('Z'),
        "%Y-%m-%dT%H:%M:%S%.f",
    ) {
        let utc_dt = dt.and_utc();
        return Some(utc_dt.into());
    }

    None
}

fn extract_date(timestamp: &str) -> Option<String> {
    if let Some(local_dt) = parse_to_local(timestamp) {
        return Some(local_dt.format("%Y-%m-%d").to_string());
    }

    if timestamp.len() >= 10 {
        Some(timestamp[..10].to_string())
    } else {
        None
    }
}

fn extract_hour(timestamp: &str) -> Option<String> {
    parse_to_local(timestamp).map(|dt| dt.format("%Y-%m-%dT%H").to_string())
}

fn format_week_bucket(date: NaiveDate) -> String {
    let jan1 = NaiveDate::from_ymd_opt(date.year(), 1, 1).unwrap_or(date);
    let days_since_jan1 = date.signed_duration_since(jan1).num_days();
    let week_num =
        ((days_since_jan1 + jan1.weekday().num_days_from_monday() as i64 + 7) / 7) as u32;
    format!("{}-W{:02}", date.year(), week_num)
}

fn extract_model_breakdown_bucket(
    timestamp: &str,
    granularity: ModelBreakdownGranularity,
) -> Option<String> {
    match granularity {
        ModelBreakdownGranularity::Hour => extract_hour(timestamp),
        ModelBreakdownGranularity::Day => extract_date(timestamp),
        ModelBreakdownGranularity::Week => {
            let date = NaiveDate::parse_from_str(&extract_date(timestamp)?, "%Y-%m-%d").ok()?;
            Some(format_week_bucket(date))
        }
        ModelBreakdownGranularity::Month => {
            let date = NaiveDate::parse_from_str(&extract_date(timestamp)?, "%Y-%m-%d").ok()?;
            Some(date.format("%Y-%m").to_string())
        }
    }
}

fn retain_latest_keys(breakdown: &mut ModelBreakdownHistory, max_entries: usize) {
    if breakdown.len() <= max_entries {
        return;
    }

    let mut keys: Vec<_> = breakdown.keys().cloned().collect();
    keys.sort();
    let keep: HashSet<_> = keys.into_iter().rev().take(max_entries).collect();
    breakdown.retain(|key, _| keep.contains(key));
}

fn trim_model_breakdown_to_visible_window(
    breakdown: &mut ModelBreakdownHistory,
    granularity: ModelBreakdownGranularity,
    now: chrono::DateTime<Local>,
) {
    match granularity {
        ModelBreakdownGranularity::Hour => {
            let keep: HashSet<_> = (0..24)
                .map(|offset| {
                    (now - chrono::Duration::hours(offset))
                        .format("%Y-%m-%dT%H")
                        .to_string()
                })
                .collect();
            breakdown.retain(|key, _| keep.contains(key));
        }
        ModelBreakdownGranularity::Day => retain_latest_keys(breakdown, 7),
        ModelBreakdownGranularity::Week => retain_latest_keys(breakdown, 4),
        ModelBreakdownGranularity::Month => {}
    }
}

// ============================================================================
// Aggregation
// ============================================================================

fn detect_source_from_path(path: &str) -> Option<&'static str> {
    if path.contains("/.claude/projects/") || path.contains("\\.claude\\projects\\") {
        return Some(SOURCE_CLAUDE);
    }
    if path.contains("/.codex/sessions/") || path.contains("\\.codex\\sessions\\") {
        return Some(SOURCE_CODEX);
    }
    if path.starts_with("opencode://") {
        return Some(SOURCE_OPENCODE);
    }
    None
}

fn normalize_usage_source(source: Option<&str>) -> Result<Option<&'static str>, String> {
    let raw = match source {
        Some(value) => value.trim(),
        None => return Ok(None),
    };

    if raw.is_empty() || raw.eq_ignore_ascii_case("all") {
        return Ok(None);
    }

    let lowered = raw.to_ascii_lowercase();
    match lowered.as_str() {
        SOURCE_CLAUDE => Ok(Some(SOURCE_CLAUDE)),
        SOURCE_CODEX => Ok(Some(SOURCE_CODEX)),
        SOURCE_OPENCODE => Ok(Some(SOURCE_OPENCODE)),
        _ => Err(format!(
            "Unsupported source '{}'. Use claude, codex, opencode, or all.",
            raw
        )),
    }
}

fn aggregate_cache(cache: &CacheFile, source_filter: Option<&'static str>) -> UsageStats {
    let now = Local::now();
    let today_str = now.format("%Y-%m-%d").to_string();

    let today_date = now.date_naive();
    let days_since_monday = today_date.weekday().num_days_from_monday();
    let week_start = today_date - chrono::Duration::days(days_since_monday as i64);
    let month_start =
        NaiveDate::from_ymd_opt(today_date.year(), today_date.month(), 1).unwrap_or(today_date);

    let mut stats = UsageStats {
        last_updated: cache
            .last_updated
            .clone()
            .unwrap_or_else(|| now.to_rfc3339()),
        ..Default::default()
    };

    for (file_path, file_entry) in &cache.files {
        if let Some(filter) = source_filter {
            if detect_source_from_path(file_path) != Some(filter) {
                continue;
            }
        }

        for entry in &file_entry.stats.entries {
            let token_usage = TokenUsageWithCost {
                input_tokens: entry.usage.input_tokens,
                output_tokens: entry.usage.output_tokens,
                cache_read_tokens: entry.usage.cache_read_tokens,
                cache_creation_tokens: entry.usage.cache_creation_tokens,
                cost: entry.usage.cost,
            };

            stats.total.add(&token_usage);
            stats
                .by_model
                .entry(entry.model.clone())
                .or_default()
                .add(&token_usage);
            if let Some(environment) = entry
                .environment
                .as_ref()
                .filter(|value| !value.trim().is_empty())
            {
                stats
                    .by_environment
                    .entry(environment.clone())
                    .or_default()
                    .add(&token_usage);
            }

            if let Some(date_str) = extract_date(&entry.timestamp) {
                stats
                    .daily_history
                    .entry(date_str.clone())
                    .or_default()
                    .add(&token_usage);

                if date_str == today_str {
                    stats.today.add(&token_usage);
                }

                if let Ok(entry_date) = NaiveDate::parse_from_str(&date_str, "%Y-%m-%d") {
                    if entry_date >= week_start && entry_date <= today_date {
                        stats.week.add(&token_usage);
                    }
                    if entry_date >= month_start && entry_date <= today_date {
                        stats.month.add(&token_usage);
                    }
                }
            }

            if let Some(hour_key) = extract_hour(&entry.timestamp) {
                stats
                    .hourly_history
                    .entry(hour_key.clone())
                    .or_default()
                    .add(&token_usage);
            }
        }
    }

    stats
}

fn aggregate_model_breakdown(
    cache: &CacheFile,
    source_filter: Option<&'static str>,
    granularity: ModelBreakdownGranularity,
    now: chrono::DateTime<Local>,
) -> ModelBreakdownHistory {
    let mut breakdown: ModelBreakdownHistory = HashMap::new();

    for (file_path, file_entry) in &cache.files {
        if let Some(filter) = source_filter {
            if detect_source_from_path(file_path) != Some(filter) {
                continue;
            }
        }

        for entry in &file_entry.stats.entries {
            let Some(bucket_key) = extract_model_breakdown_bucket(&entry.timestamp, granularity)
            else {
                continue;
            };

            let token_usage = TokenUsageWithCost {
                input_tokens: entry.usage.input_tokens,
                output_tokens: entry.usage.output_tokens,
                cache_read_tokens: entry.usage.cache_read_tokens,
                cache_creation_tokens: entry.usage.cache_creation_tokens,
                cost: entry.usage.cost,
            };

            breakdown
                .entry(bucket_key)
                .or_default()
                .entry(entry.model.clone())
                .or_default()
                .add(&token_usage);
        }
    }

    trim_model_breakdown_to_visible_window(&mut breakdown, granularity, now);
    breakdown
}

fn calculate_streak(daily_history: &HashMap<String, TokenUsageWithCost>) -> u32 {
    let today = Local::now().date_naive();
    let mut streak: u32 = 0;
    let mut check_date = today;

    loop {
        let date_str = check_date.format("%Y-%m-%d").to_string();
        if daily_history.contains_key(&date_str) {
            streak += 1;
            check_date -= chrono::Duration::days(1);
        } else {
            break;
        }
    }

    streak
}

async fn run_blocking<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("Blocking analytics task failed: {error}"))?
}

// ============================================================================
// Tauri commands
// ============================================================================

#[tauri::command]
pub async fn get_tray_usage_stats() -> Result<Option<UsageStats>, String> {
    run_blocking(|| Ok(read_tray_usage_stats())).await
}

/// Get usage statistics (optionally filtered by source).
#[tauri::command]
pub async fn get_usage_stats(
    source: Option<String>,
    force: Option<bool>,
) -> Result<UsageStats, String> {
    let request_started = Instant::now();
    run_blocking(move || {
        let source_filter = normalize_usage_source(source.as_deref())?;
        let source_key = source_filter.unwrap_or("all");
        let force_requested = force.unwrap_or(false);
        let mut memo = lock_usage_stats_memo();
        if let Some(cached) = memo.by_source.get(source_key) {
            if should_reuse_usage_stats(force_requested, cached.collected_at, request_started) {
                return Ok(cached.stats.clone());
            }
        }

        let cache = refresh_usage_cache();
        let stats = aggregate_cache(&cache, source_filter);
        if source_filter.is_none() {
            write_usage_summary(&stats);
        }
        memo.by_source.insert(
            source_key,
            CachedUsageStats {
                collected_at: Instant::now(),
                stats: stats.clone(),
            },
        );
        Ok(stats)
    })
    .await
}

/// Get usage history with time granularity (optionally filtered by source).
#[tauri::command]
pub async fn get_usage_history(
    _granularity: String,
    _start_date: Option<String>,
    _end_date: Option<String>,
    source: Option<String>,
) -> Result<UsageHistory, String> {
    run_blocking(move || {
        let source_filter = normalize_usage_source(source.as_deref())?;
        let cache = refresh_usage_cache();
        let stats = aggregate_cache(&cache, source_filter);

        Ok(UsageHistory {
            daily: stats.daily_history,
            by_model: stats.by_model,
            by_environment: stats.by_environment,
        })
    })
    .await
}

#[tauri::command]
pub async fn get_usage_model_breakdown(
    granularity: String,
    source: Option<String>,
) -> Result<ModelBreakdownHistory, String> {
    run_blocking(move || {
        let source_filter = normalize_usage_source(source.as_deref())?;
        let granularity = ModelBreakdownGranularity::parse(&granularity)?;
        let cache = refresh_usage_cache();
        Ok(aggregate_model_breakdown(
            &cache,
            source_filter,
            granularity,
            Local::now(),
        ))
    })
    .await
}

/// Calculate continuous usage days (streak), optionally filtered by source.
#[tauri::command]
pub async fn get_continuous_usage_days(source: Option<String>) -> Result<u32, String> {
    run_blocking(move || {
        let source_filter = normalize_usage_source(source.as_deref())?;
        let cache = refresh_usage_cache();
        let stats = aggregate_cache(&cache, source_filter);
        Ok(calculate_streak(&stats.daily_history))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::{
        aggregate_model_breakdown, cache_files_have_same_meta, default_prices,
        extract_model_breakdown_bucket, format_week_bucket, normalize_usage_source,
        parse_codex_jsonl_reader, parse_opencode_export_stats, parse_opencode_session_items,
        read_usage_summary_from, should_reuse_usage_stats, write_usage_summary_to, CacheEntry,
        CacheFile, CacheFileEntry, CacheMeta, CacheStats, CacheUsage, ModelBreakdownGranularity,
        ModelPrice, UsageStats, OPENCODE_NATIVE_ENV_NAME, SOURCE_CLAUDE,
    };
    use chrono::{Local, TimeZone};
    use std::collections::HashMap;
    use std::io::BufReader;
    use std::time::Instant;

    #[test]
    fn test_codex_token_count_differential() {
        let mut prices = HashMap::new();
        prices.insert(
            "gpt-5.3-codex".to_string(),
            ModelPrice {
                input_cost_per_token: 1.0,
                output_cost_per_token: 1.0,
                cache_read_input_token_cost: Some(1.0),
                cache_creation_input_token_cost: Some(0.0),
            },
        );

        let input = [
            r#"{"type":"turn_context","payload":{"model":"gpt-5.3-codex"}}"#,
            r#"{"timestamp":"2026-03-01T00:00:01.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":10,"reasoning_output_tokens":5}}}}"#,
            r#"{"timestamp":"2026-03-01T00:00:02.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":10,"reasoning_output_tokens":5}}}}"#,
            r#"{"timestamp":"2026-03-01T00:00:03.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":150,"cached_input_tokens":50,"output_tokens":25,"reasoning_output_tokens":8}}}}"#,
        ]
        .join("\n");

        let reader = BufReader::new(input.as_bytes());
        let stats = parse_codex_jsonl_reader(reader, &prices);

        assert_eq!(stats.entries.len(), 2);

        let first = &stats.entries[0];
        assert_eq!(first.usage.input_tokens, 80);
        assert_eq!(first.usage.cache_read_tokens, 20);
        assert_eq!(first.usage.output_tokens, 15);

        let second = &stats.entries[1];
        assert_eq!(second.usage.input_tokens, 20);
        assert_eq!(second.usage.cache_read_tokens, 30);
        assert_eq!(second.usage.output_tokens, 18);
    }

    #[test]
    fn test_codex_token_count_prefers_last_usage_and_skips_duplicate_snapshots() {
        let mut prices = HashMap::new();
        prices.insert(
            "gpt-5.4".to_string(),
            ModelPrice {
                input_cost_per_token: 1.0,
                output_cost_per_token: 1.0,
                cache_read_input_token_cost: Some(1.0),
                cache_creation_input_token_cost: Some(0.0),
            },
        );

        let input = [
            r#"{"type":"turn_context","payload":{"model":"gpt-5.4"}}"#,
            r#"{"timestamp":"2026-03-01T00:00:01.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":10,"reasoning_output_tokens":5},"last_token_usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":10,"reasoning_output_tokens":5}}}}"#,
            r#"{"timestamp":"2026-03-01T00:00:02.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":10,"reasoning_output_tokens":5},"last_token_usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":10,"reasoning_output_tokens":5}}}}"#,
            r#"{"timestamp":"2026-03-01T00:00:03.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":120,"cached_input_tokens":40,"output_tokens":12,"reasoning_output_tokens":6},"last_token_usage":{"input_tokens":20,"cached_input_tokens":20,"output_tokens":2,"reasoning_output_tokens":1}}}}"#,
            r#"{"timestamp":"2026-03-01T00:00:04.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":90,"cached_input_tokens":30,"output_tokens":11,"reasoning_output_tokens":6},"last_token_usage":{"input_tokens":15,"cached_input_tokens":10,"output_tokens":1,"reasoning_output_tokens":0}}}}"#,
        ]
        .join("\n");

        let reader = BufReader::new(input.as_bytes());
        let stats = parse_codex_jsonl_reader(reader, &prices);

        assert_eq!(stats.entries.len(), 3);

        let first = &stats.entries[0];
        assert_eq!(first.usage.input_tokens, 80);
        assert_eq!(first.usage.cache_read_tokens, 20);
        assert_eq!(first.usage.output_tokens, 15);

        let second = &stats.entries[1];
        assert_eq!(second.usage.input_tokens, 0);
        assert_eq!(second.usage.cache_read_tokens, 20);
        assert_eq!(second.usage.output_tokens, 3);

        let third = &stats.entries[2];
        assert_eq!(third.usage.input_tokens, 5);
        assert_eq!(third.usage.cache_read_tokens, 10);
        assert_eq!(third.usage.output_tokens, 1);
    }

    #[test]
    fn test_model_price_fallback_for_unknown_codex_models() {
        let prices = default_prices();
        let input = [
            r#"{"type":"turn_context","payload":{"model":"gpt-unknown-codex"}}"#,
            r#"{"timestamp":"2026-03-01T00:00:01.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":3,"reasoning_output_tokens":1}}}}"#,
        ]
        .join("\n");

        let reader = BufReader::new(input.as_bytes());
        let stats = parse_codex_jsonl_reader(reader, &prices);

        assert_eq!(stats.entries.len(), 1);
        assert_eq!(stats.entries[0].usage.cost, 0.0);
    }

    #[test]
    fn test_usage_source_filtering() {
        assert_eq!(normalize_usage_source(None).unwrap(), None);
        assert_eq!(normalize_usage_source(Some("all")).unwrap(), None);
        assert_eq!(
            normalize_usage_source(Some("claude")).unwrap(),
            Some("claude")
        );
        assert_eq!(
            normalize_usage_source(Some("CODEX")).unwrap(),
            Some("codex")
        );
        assert_eq!(
            normalize_usage_source(Some("OpenCode")).unwrap(),
            Some("opencode")
        );
        assert!(normalize_usage_source(Some("other")).is_err());
    }

    #[test]
    fn test_usage_summary_round_trip_uses_atomic_replacement() {
        let temp = tempfile::tempdir().expect("create usage summary tempdir");
        let summary_path = temp.path().join("usage-summary.json");
        let stats = UsageStats {
            last_updated: "2026-07-29T12:00:00+08:00".to_string(),
            ..Default::default()
        };

        assert!(read_usage_summary_from(&summary_path).is_none());
        write_usage_summary_to(&summary_path, &stats).expect("write usage summary");
        let parsed = read_usage_summary_from(&summary_path).expect("read usage summary");

        assert_eq!(parsed.last_updated, stats.last_updated);
        assert!(summary_path.metadata().expect("summary metadata").len() < 2048);
        assert!(!summary_path
            .with_extension(format!("json.{}.tmp", std::process::id()))
            .exists());
    }

    #[test]
    fn test_forced_usage_refresh_reuses_a_newer_result() {
        let request_started = Instant::now();
        let collected_before = request_started
            .checked_sub(std::time::Duration::from_secs(1))
            .expect("instant subtraction");
        let collected_after = Instant::now();

        assert!(should_reuse_usage_stats(
            false,
            collected_before,
            request_started
        ));
        assert!(!should_reuse_usage_stats(
            true,
            collected_before,
            request_started
        ));
        assert!(should_reuse_usage_stats(
            true,
            collected_after,
            request_started
        ));
    }

    #[test]
    fn test_cache_metadata_comparison_detects_source_changes() {
        let entry = |mtime, size| CacheFileEntry {
            meta: CacheMeta { mtime, size },
            stats: CacheStats::default(),
        };
        let existing = HashMap::from([("session.jsonl".to_string(), entry(100.0, 512))]);
        let unchanged = HashMap::from([("session.jsonl".to_string(), entry(100.0, 512))]);
        let resized = HashMap::from([("session.jsonl".to_string(), entry(100.0, 1024))]);

        assert!(cache_files_have_same_meta(&existing, &unchanged));
        assert!(!cache_files_have_same_meta(&existing, &resized));
        assert!(!cache_files_have_same_meta(&existing, &HashMap::new()));
    }

    #[test]
    fn test_parse_opencode_session_items_prefers_env_name_and_native_fallback() {
        let value = serde_json::json!({
            "sessions": [
                {
                    "id": "opencode-session-1",
                    "envName": "Fixture Anthropic",
                    "updatedAt": "2026-04-15T12:34:56.000Z"
                },
                {
                    "id": "opencode-session-2",
                    "configSource": "native",
                    "updatedAt": "2026-04-15T12:35:56.000Z"
                }
            ]
        });

        let sessions = parse_opencode_session_items(&value).expect("sessions parsed");
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].environment, "Fixture Anthropic");
        assert_eq!(sessions[1].environment, OPENCODE_NATIVE_ENV_NAME);
    }

    #[test]
    fn test_parse_opencode_export_stats_collects_usage_and_environment() {
        let export = serde_json::json!({
            "messages": [
                {
                    "id": "msg-1",
                    "role": "assistant",
                    "timestamp": "2026-04-15T12:35:10.000Z",
                    "model": "anthropic/claude-sonnet-4-5",
                    "usage": {
                        "inputTokens": 1200,
                        "outputTokens": 340,
                        "cacheReadTokens": 80,
                        "cacheCreationTokens": 20,
                        "cost": 0.42
                    }
                }
            ]
        });

        let stats = parse_opencode_export_stats(&export, "Fixture Anthropic", &default_prices());

        assert_eq!(stats.entries.len(), 1);
        let entry = &stats.entries[0];
        assert_eq!(entry.model, "anthropic/claude-sonnet-4-5");
        assert_eq!(entry.environment.as_deref(), Some("Fixture Anthropic"));
        assert_eq!(entry.usage.input_tokens, 1200);
        assert_eq!(entry.usage.output_tokens, 340);
        assert_eq!(entry.usage.cache_read_tokens, 80);
        assert_eq!(entry.usage.cache_creation_tokens, 20);
        assert_eq!(entry.usage.cost, 0.42);
    }

    fn usage_bucket(tokens: u64, cost: f64) -> CacheUsage {
        CacheUsage {
            input_tokens: tokens,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            cost,
        }
    }

    fn fixed_now() -> chrono::DateTime<Local> {
        Local
            .with_ymd_and_hms(2026, 3, 6, 12, 0, 0)
            .single()
            .expect("fixed local time")
    }

    fn build_cache(claude_entries: Vec<CacheEntry>, codex_entries: Vec<CacheEntry>) -> CacheFile {
        let mut files = HashMap::new();
        files.insert(
            "/tmp/.claude/projects/session.jsonl".to_string(),
            CacheFileEntry {
                meta: CacheMeta::default(),
                stats: CacheStats {
                    entries: claude_entries,
                },
            },
        );
        files.insert(
            "/tmp/.codex/sessions/session.jsonl".to_string(),
            CacheFileEntry {
                meta: CacheMeta::default(),
                stats: CacheStats {
                    entries: codex_entries,
                },
            },
        );

        CacheFile {
            version: 1,
            files,
            last_updated: None,
        }
    }

    #[test]
    fn test_model_breakdown_hour_window_and_source_filtering() {
        let visible_bucket = extract_model_breakdown_bucket(
            "2026-03-06T10:00:00+08:00",
            ModelBreakdownGranularity::Hour,
        )
        .expect("visible bucket");
        let stale_bucket = extract_model_breakdown_bucket(
            "2026-03-05T09:00:00+08:00",
            ModelBreakdownGranularity::Hour,
        )
        .expect("stale bucket");

        let cache = build_cache(
            vec![
                CacheEntry {
                    timestamp: "2026-03-06T10:00:00+08:00".to_string(),
                    model: "claude-sonnet-4-5".to_string(),
                    environment: None,
                    usage: usage_bucket(120, 1.2),
                },
                CacheEntry {
                    timestamp: "2026-03-05T09:00:00+08:00".to_string(),
                    model: "claude-opus-4-5".to_string(),
                    environment: None,
                    usage: usage_bucket(90, 0.9),
                },
            ],
            vec![CacheEntry {
                timestamp: "2026-03-06T11:00:00+08:00".to_string(),
                model: "gpt-5.3-codex".to_string(),
                environment: None,
                usage: usage_bucket(75, 0.75),
            }],
        );

        let result = aggregate_model_breakdown(
            &cache,
            Some(SOURCE_CLAUDE),
            ModelBreakdownGranularity::Hour,
            fixed_now(),
        );

        assert!(result.contains_key(&visible_bucket));
        assert!(!result.contains_key(&stale_bucket));
        assert_eq!(
            result[&visible_bucket]["claude-sonnet-4-5"].input_tokens,
            120
        );
        assert!(!result
            .values()
            .any(|models| models.contains_key("gpt-5.3-codex")));
    }

    #[test]
    fn test_model_breakdown_groups_and_trims_visible_buckets() {
        let cache = build_cache(
            vec![
                CacheEntry {
                    timestamp: "2026-02-27T10:00:00+08:00".to_string(),
                    model: "claude-sonnet-4-5".to_string(),
                    environment: None,
                    usage: usage_bucket(10, 0.1),
                },
                CacheEntry {
                    timestamp: "2026-02-28T10:00:00+08:00".to_string(),
                    model: "claude-sonnet-4-5".to_string(),
                    environment: None,
                    usage: usage_bucket(20, 0.2),
                },
                CacheEntry {
                    timestamp: "2026-03-01T10:00:00+08:00".to_string(),
                    model: "claude-opus-4-5".to_string(),
                    environment: None,
                    usage: usage_bucket(30, 0.3),
                },
                CacheEntry {
                    timestamp: "2026-03-02T10:00:00+08:00".to_string(),
                    model: "claude-opus-4-5".to_string(),
                    environment: None,
                    usage: usage_bucket(40, 0.4),
                },
                CacheEntry {
                    timestamp: "2026-03-03T10:00:00+08:00".to_string(),
                    model: "claude-opus-4-5".to_string(),
                    environment: None,
                    usage: usage_bucket(50, 0.5),
                },
                CacheEntry {
                    timestamp: "2026-03-04T10:00:00+08:00".to_string(),
                    model: "claude-opus-4-5".to_string(),
                    environment: None,
                    usage: usage_bucket(60, 0.6),
                },
                CacheEntry {
                    timestamp: "2026-03-05T10:00:00+08:00".to_string(),
                    model: "claude-opus-4-5".to_string(),
                    environment: None,
                    usage: usage_bucket(70, 0.7),
                },
                CacheEntry {
                    timestamp: "2026-03-06T10:00:00+08:00".to_string(),
                    model: "claude-opus-4-5".to_string(),
                    environment: None,
                    usage: usage_bucket(80, 0.8),
                },
            ],
            Vec::new(),
        );

        let day_result =
            aggregate_model_breakdown(&cache, None, ModelBreakdownGranularity::Day, fixed_now());
        assert_eq!(day_result.len(), 7);
        assert!(!day_result.contains_key("2026-02-27"));
        assert_eq!(day_result["2026-03-06"]["claude-opus-4-5"].input_tokens, 80);

        let week_result =
            aggregate_model_breakdown(&cache, None, ModelBreakdownGranularity::Week, fixed_now());
        assert!(week_result.contains_key(&format_week_bucket(
            chrono::NaiveDate::from_ymd_opt(2026, 3, 6).unwrap()
        )));

        let month_result =
            aggregate_model_breakdown(&cache, None, ModelBreakdownGranularity::Month, fixed_now());
        let march_total = &month_result["2026-03"]["claude-opus-4-5"];
        assert_eq!(march_total.input_tokens, 330);
        assert_eq!(march_total.output_tokens, 0);
        assert_eq!(march_total.cache_read_tokens, 0);
        assert_eq!(march_total.cache_creation_tokens, 0);
        assert!((march_total.cost - 3.3).abs() < 1e-9);
    }
}
