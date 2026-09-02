// apps/desktop/src-tauri/src/analytics.rs
//
// Native JSONL scanner for Claude, Codex, OpenCode, and DSH usage.

use crate::config;
use crate::dsh_history;
use crate::opencode;
use chrono::{Datelike, Local, NaiveDate};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
#[cfg(test)]
use std::io::BufRead;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

const SOURCE_CLAUDE: &str = "claude";
const SOURCE_CODEX: &str = "codex";
const SOURCE_OPENCODE: &str = "opencode";
const SOURCE_DSH: &str = "dsh";
// Version 7 stores compact per-source rollups plus one materialized global
// rollup. Unchanged history is therefore never folded row-by-row when an
// Analytics view opens. Versions 5 and 6 are migrated once in memory.
const USAGE_CACHE_VERSION: u32 = 7;
const USAGE_SUMMARY_VERSION: u32 = 2;
const USAGE_STATS_MEMO_TTL: Duration = Duration::from_secs(60);
const OPENCODE_NATIVE_ENV_NAME: &str = opencode::OPENCODE_NATIVE_ENV_NAME;
/// Shadow-compare gate: when enabled, every incremental parse also runs a
/// full re-parse of the same file and compares the resulting `CacheStats`.
/// Enabled in test builds (so the fixture matrix below is enforced on every
/// `cargo test` run), disabled in dev/release binaries. On mismatch it logs
/// and `debug_assert!`s — it never panics in release.
const ANALYTICS_SHADOW_INCREMENTAL: bool = cfg!(test);
static USAGE_REFRESH_LOCK: Mutex<()> = Mutex::new(());
/// Single-flight coordinator for `shared_usage_cache`: serializes refreshers
/// so concurrent analytics commands wait for the in-flight refresh instead of
/// each paying for their own. Waiters block on this mutex (equivalent to a
/// Condvar wait — released exactly when the refresh completes), then re-check
/// the snapshot before deciding to refresh themselves.
static USAGE_REFRESH_INFLIGHT: Mutex<()> = Mutex::new(());
static USAGE_STATS_MEMO: OnceLock<Mutex<UsageStatsMemo>> = OnceLock::new();
static USAGE_SNAPSHOT: OnceLock<Mutex<Option<UsageSnapshot>>> = OnceLock::new();

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
    #[serde(default)]
    pub unpriced_tokens: u64,
    #[serde(default)]
    pub cost_incomplete: bool,
}

impl TokenUsageWithCost {
    fn add(&mut self, other: &TokenUsageWithCost) {
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        self.cache_read_tokens += other.cache_read_tokens;
        self.cache_creation_tokens += other.cache_creation_tokens;
        self.cost += other.cost;
        self.unpriced_tokens += other.unpriced_tokens;
        self.cost_incomplete |= other.cost_incomplete;
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dsh_status: Option<DshSourceStatus>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DshSourceStatus {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub session_count: u32,
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
// Cache types — Desktop-owned compact cache. The legacy shared cache is only
// read once for migration and is never overwritten by Desktop v7.
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CacheFile {
    #[serde(default = "default_cache_version")]
    version: u32,
    #[serde(default)]
    files: HashMap<String, CacheFileEntry>,
    #[serde(default)]
    global_rollup: CacheRollup,
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
            global_rollup: CacheRollup::default(),
            last_updated: None,
        }
    }
}

// Version-5 entry shape: besides `meta` + `stats`, each entry carries parse
// continuation state so a grown file only needs its appended bytes re-parsed.
//
// - `parse_offset`: absolute byte offset of the next unconsumed byte. It
//   always sits on a line boundary (start of an unconsumed line, or EOF
//   exactly after a `\n`). Bytes before it have been fed to the accumulator.
// - `last_line_complete`: false when the file currently ends mid-line; the
//   pending partial after `parse_offset` is NOT consumed until its `\n`
//   arrives. A partial line is never trusted and never counted twice.
// - `codex_state`: codex parsing is stateful (current model from
//   session_meta/turn_context lines, plus the last cumulative token totals
//   used for delta computation), so the continuation state must survive
//   between incremental parses. Codex files store Some, Claude files None.
// - `claude_state`: claude parsing is stateful for message-id dedup (the
//   appends partial assistant records and re-emits the same message.id with
//   growing usage; a later record must REPLACE the earlier entry, including
//   across an incremental append boundary), so the dedup map must survive
//   between incremental parses. Claude files store Some, codex files None.
#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq)]
struct CacheFileEntry {
    #[serde(default)]
    meta: CacheMeta,
    #[serde(default)]
    stats: CacheStats,
    #[serde(default)]
    rollup: CacheRollup,
    #[serde(default)]
    parse_offset: u64,
    #[serde(default = "default_last_line_complete")]
    last_line_complete: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    codex_state: Option<CodexParseState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    claude_state: Option<ClaudeParseState>,
    /// Bounded hash of the consumed prefix's head and tail. It distinguishes
    /// true append-only growth from same-path rewrites without re-reading a
    /// whole multi-gigabyte transcript on every append.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    append_anchor: Option<String>,
    /// Opaque revision string for DSH entries — used for cache reuse/invalidation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    revision: Option<String>,
}

fn default_last_line_complete() -> bool {
    true
}

impl CacheFileEntry {
    /// Entry for sources that are never incrementally parsed (opencode):
    /// parse continuation fields get inert values.
    fn from_meta_stats(meta: CacheMeta, mut stats: CacheStats, source: &str) -> Self {
        let rollup = CacheRollup::from_entries(source, &stats.entries);
        if source != SOURCE_CLAUDE {
            stats.entries.clear();
        }
        Self {
            meta,
            stats,
            rollup,
            parse_offset: 0,
            last_line_complete: true,
            codex_state: None,
            claude_state: None,
            append_anchor: None,
            revision: None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq)]
struct CacheMeta {
    #[serde(default)]
    mtime: f64,
    #[serde(default)]
    size: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq)]
struct CacheStats {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    entries: Vec<CacheEntry>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
struct CacheEntry {
    timestamp: String,
    model: String,
    #[serde(default)]
    environment: Option<String>,
    usage: CacheUsage,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq)]
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

impl CacheUsage {
    fn add(&mut self, other: &Self) {
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        self.cache_read_tokens += other.cache_read_tokens;
        self.cache_creation_tokens += other.cache_creation_tokens;
        self.cost += other.cost;
    }

    fn subtract(&mut self, other: &Self) {
        self.input_tokens = self.input_tokens.saturating_sub(other.input_tokens);
        self.output_tokens = self.output_tokens.saturating_sub(other.output_tokens);
        self.cache_read_tokens = self
            .cache_read_tokens
            .saturating_sub(other.cache_read_tokens);
        self.cache_creation_tokens = self
            .cache_creation_tokens
            .saturating_sub(other.cache_creation_tokens);
        self.cost -= other.cost;
        if self.cost.abs() < 1e-12 {
            self.cost = 0.0;
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
struct CacheRollup {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    buckets: Vec<CacheRollupBucket>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
struct CacheRollupBucket {
    source: String,
    #[serde(default)]
    date: Option<String>,
    #[serde(default)]
    hour: Option<String>,
    model: String,
    #[serde(default)]
    environment: Option<String>,
    #[serde(default)]
    usage: CacheUsage,
    #[serde(default)]
    entry_count: u64,
}

#[derive(Debug, Clone, Hash, PartialEq, Eq, PartialOrd, Ord)]
struct RollupKey {
    source: String,
    date: Option<String>,
    hour: Option<String>,
    model: String,
    environment: Option<String>,
}

impl From<&CacheRollupBucket> for RollupKey {
    fn from(bucket: &CacheRollupBucket) -> Self {
        Self {
            source: bucket.source.clone(),
            date: bucket.date.clone(),
            hour: bucket.hour.clone(),
            model: bucket.model.clone(),
            environment: bucket.environment.clone(),
        }
    }
}

impl CacheRollup {
    fn from_entries(source: &str, entries: &[CacheEntry]) -> Self {
        let mut buckets: HashMap<RollupKey, CacheRollupBucket> = HashMap::new();
        for entry in entries {
            let key = RollupKey {
                source: source.to_string(),
                date: extract_date(&entry.timestamp),
                hour: extract_hour(&entry.timestamp),
                model: entry.model.clone(),
                environment: entry
                    .environment
                    .as_ref()
                    .filter(|value| !value.trim().is_empty())
                    .cloned(),
            };
            let bucket = buckets
                .entry(key.clone())
                .or_insert_with(|| CacheRollupBucket {
                    source: key.source.clone(),
                    date: key.date.clone(),
                    hour: key.hour.clone(),
                    model: key.model.clone(),
                    environment: key.environment.clone(),
                    ..Default::default()
                });
            bucket.usage.add(&entry.usage);
            bucket.entry_count += 1;
        }
        Self::from_bucket_map(buckets)
    }

    fn from_file_entries(files: &HashMap<String, CacheFileEntry>) -> Self {
        let mut accumulator = RollupAccumulator::default();
        for entry in files.values() {
            accumulator.add(&entry.rollup);
        }
        accumulator.finish()
    }

    fn from_bucket_map(buckets: HashMap<RollupKey, CacheRollupBucket>) -> Self {
        let mut buckets = buckets.into_values().collect::<Vec<_>>();
        buckets.sort_by_key(|bucket| RollupKey::from(bucket));
        Self { buckets }
    }
}

#[derive(Default)]
struct RollupAccumulator {
    buckets: HashMap<RollupKey, CacheRollupBucket>,
}

impl RollupAccumulator {
    fn from_rollup(rollup: &CacheRollup) -> Self {
        let mut accumulator = Self::default();
        accumulator.add(rollup);
        accumulator
    }

    fn add(&mut self, rollup: &CacheRollup) {
        for incoming in &rollup.buckets {
            let key = RollupKey::from(incoming);
            let bucket = self
                .buckets
                .entry(key)
                .or_insert_with(|| CacheRollupBucket {
                    source: incoming.source.clone(),
                    date: incoming.date.clone(),
                    hour: incoming.hour.clone(),
                    model: incoming.model.clone(),
                    environment: incoming.environment.clone(),
                    ..Default::default()
                });
            bucket.usage.add(&incoming.usage);
            bucket.entry_count += incoming.entry_count;
        }
    }

    fn subtract(&mut self, rollup: &CacheRollup) {
        for outgoing in &rollup.buckets {
            let key = RollupKey::from(outgoing);
            let remove = if let Some(bucket) = self.buckets.get_mut(&key) {
                bucket.usage.subtract(&outgoing.usage);
                bucket.entry_count = bucket.entry_count.saturating_sub(outgoing.entry_count);
                bucket.entry_count == 0
            } else {
                false
            };
            if remove {
                self.buckets.remove(&key);
            }
        }
    }

    fn finish(self) -> CacheRollup {
        CacheRollup::from_bucket_map(self.buckets)
    }
}

/// Claude parse continuation state persisted in the cache entry (see the
/// version-5 entry shape comment above). Claude Code appends partial
/// assistant records as a stream progresses and re-emits the same message.id
/// on resume (3-4x per file is common). The map below carries
/// message.id -> index into the accumulated `stats.entries` so a later
/// record REPLACES the earlier entry and only the final usage snapshot
/// counts. It must survive incremental appends: the final record for an id
/// can arrive in a later chunk than the one that first saw it.
#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq)]
struct ClaudeParseState {
    #[serde(default)]
    message_entry_indexes: HashMap<String, usize>,
}

/// Codex parse continuation state persisted in the cache entry (see the
/// version-5 entry shape comment above).
#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq)]
struct CodexParseState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    current_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_total: Option<CodexTotals>,
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

#[cfg(test)]
thread_local! {
    static MODEL_PRICE_LOOKUP_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn reset_model_price_lookup_count() {
    MODEL_PRICE_LOOKUP_COUNT.with(|count| count.set(0));
}

#[cfg(test)]
fn model_price_lookup_count() -> usize {
    MODEL_PRICE_LOOKUP_COUNT.with(std::cell::Cell::get)
}

/// Look up model price: direct -> normalized -> fuzzy -> keyword fallback (Claude only).
fn get_model_price<'a>(
    model: &str,
    prices: &'a HashMap<String, ModelPrice>,
) -> Option<&'a ModelPrice> {
    #[cfg(test)]
    MODEL_PRICE_LOOKUP_COUNT.with(|count| count.set(count.get() + 1));

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

struct JsonlDiscovery {
    files: Vec<DiscoveredFile>,
    claude_complete: bool,
    codex_complete: bool,
}

fn discover_jsonl_files() -> JsonlDiscovery {
    let (mut files, claude_complete) = discover_claude_jsonl_files();
    let (codex_files, codex_complete) = discover_codex_jsonl_files();
    files.extend(codex_files);
    JsonlDiscovery {
        files,
        claude_complete,
        codex_complete,
    }
}

/// Scan ~/.claude/projects/*/*.jsonl
fn discover_claude_jsonl_files() -> (Vec<DiscoveredFile>, bool) {
    let mut files = Vec::new();
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return (files, false),
    };

    let projects_dir = home.join(".claude").join("projects");
    if !projects_dir.exists() {
        return (files, true);
    }

    let projects = match fs::read_dir(&projects_dir) {
        Ok(entries) => entries,
        Err(_) => return (files, false),
    };

    let mut complete = true;
    for project_entry in projects {
        let project_entry = match project_entry {
            Ok(entry) => entry,
            Err(_) => {
                complete = false;
                continue;
            }
        };
        let project_path = project_entry.path();
        if !project_path.is_dir() {
            continue;
        }
        // Depth-limited walk: main transcripts sit directly in the project
        // dir, while subagent transcripts (Task tool / dynamic routing) live
        // under `<session-id>/subagents/agent-*.jsonl` — 2 levels deeper.
        complete &= collect_claude_jsonl_dir(&project_path, 0, 3, &mut files);
    }

    (files, complete)
}

fn collect_claude_jsonl_dir(
    dir: &Path,
    depth: usize,
    max_depth: usize,
    out: &mut Vec<DiscoveredFile>,
) -> bool {
    if depth > max_depth {
        return true;
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return false,
    };
    let mut complete = true;
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                complete = false;
                continue;
            }
        };
        let path = entry.path();
        let is_dir = path.is_dir();
        if is_dir {
            complete &= collect_claude_jsonl_dir(&path, depth + 1, max_depth, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(DiscoveredFile {
                path,
                source: UsageSource::Claude,
            });
        }
    }
    complete
}

/// Scan ~/.codex/sessions recursively for *.jsonl
fn discover_codex_jsonl_files() -> (Vec<DiscoveredFile>, bool) {
    let mut files = Vec::new();
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return (files, false),
    };

    let sessions_dir = home.join(".codex").join("sessions");
    if !sessions_dir.exists() {
        return (files, true);
    }

    let mut complete = true;
    let mut stack = vec![sessions_dir];
    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => {
                complete = false;
                continue;
            }
        };

        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    complete = false;
                    continue;
                }
            };
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

    (files, complete)
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
    id: Option<String>,
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

/// Shared per-line Claude accumulator: used by both the full parse and the
/// append-aware incremental parse, so the two paths cannot drift.
fn accumulate_claude_line(
    state: &mut ClaudeParseState,
    entries: &mut Vec<CacheEntry>,
    line: &str,
    prices: &HashMap<String, ModelPrice>,
) {
    if line.trim().is_empty() {
        return;
    }

    let parsed: ClaudeJsonlLine = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(_) => return,
    };

    if parsed.entry_type.as_deref() != Some("assistant") {
        return;
    }

    let message = match parsed.message {
        Some(message) => message,
        None => return,
    };

    let message_id = message.id.filter(|value| !value.is_empty());

    let usage = match message.usage {
        Some(usage) => usage,
        None => return,
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

    let entry = CacheEntry {
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
    };

    // Claude Code appends partial assistant records as a stream progresses
    // and again on resume: the same message.id can appear 3-4x in one file.
    // Keep replacing the entry for that id so analytics uses the final usage
    // snapshot instead of summing partial records or retaining an early
    // zero. The map lives in the per-file continuation state, so a final
    // record appended in a later chunk still replaces the entry produced by
    // an earlier one. Records without an id are rare; they always append.
    if let Some(message_id) = message_id {
        if let Some(index) = state.message_entry_indexes.get(&message_id).copied() {
            entries[index] = entry;
        } else {
            state
                .message_entry_indexes
                .insert(message_id, entries.len());
            entries.push(entry);
        }
    } else {
        entries.push(entry);
    }
}

/// Test seam over the shared accumulator (line iteration via `BufRead`).
#[cfg(test)]
fn parse_claude_jsonl_reader<R: BufRead>(
    reader: R,
    prices: &HashMap<String, ModelPrice>,
) -> CacheStats {
    let mut state = ClaudeParseState::default();
    let mut entries = Vec::new();
    for line in reader.lines().map_while(Result::ok) {
        accumulate_claude_line(&mut state, &mut entries, &line, prices);
    }
    CacheStats { entries }
}

// ============================================================================
// Codex JSONL parsing
// ============================================================================

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
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

/// Shared per-line Codex accumulator (stateful: model context + last
/// cumulative totals drive delta computation). Used by both the full parse
/// and the append-aware incremental parse.
fn accumulate_codex_line(
    state: &mut CodexParseState,
    entries: &mut Vec<CacheEntry>,
    line: &str,
    prices: &HashMap<String, ModelPrice>,
) {
    if line.trim().is_empty() {
        return;
    }

    let parsed: serde_json::Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(_) => return,
    };

    let line_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let payload = parsed.get("payload").unwrap_or(&serde_json::Value::Null);

    match line_type {
        "session_meta" => {
            if let Some(model) = payload.get("model").and_then(|v| v.as_str()) {
                state.current_model = Some(model.to_string());
            }
        }
        "turn_context" => {
            if let Some(model) = payload.get("model").and_then(|v| v.as_str()) {
                state.current_model = Some(model.to_string());
            }
        }
        "event_msg" => {
            if payload.get("type").and_then(|v| v.as_str()) != Some("token_count") {
                return;
            }

            let total_usage = match payload
                .get("info")
                .and_then(|v| v.get("total_token_usage"))
                .and_then(CodexTotals::from_value)
            {
                Some(total) => total,
                None => return,
            };

            if state.last_total.as_ref() == Some(&total_usage) {
                return;
            }

            let last_usage = payload
                .get("info")
                .and_then(|v| v.get("last_token_usage"))
                .and_then(CodexTotals::from_value);

            let delta = match last_usage {
                Some(last_usage) => last_usage,
                None => match &state.last_total {
                    Some(last) => total_usage.diff_from(last),
                    None => total_usage.clone(),
                },
            };
            state.last_total = Some(total_usage);

            if delta.is_zero() {
                return;
            }

            let model = state
                .current_model
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

/// Test seam over the shared accumulator (line iteration via `BufRead`).
#[cfg(test)]
fn parse_codex_jsonl_reader<R: BufRead>(
    reader: R,
    prices: &HashMap<String, ModelPrice>,
) -> CacheStats {
    let mut state = CodexParseState::default();
    let mut entries = Vec::new();
    for line in reader.lines().map_while(Result::ok) {
        accumulate_codex_line(&mut state, &mut entries, &line, prices);
    }
    CacheStats { entries }
}

// ============================================================================
// Byte-level JSONL parsing: full + append-aware incremental share one core
// ============================================================================

/// Result of parsing a byte range starting at `start_offset`.
#[derive(Debug, Default)]
struct JsonlTailStats {
    /// Entries after this pass: the resumed seed entries plus whatever the
    /// lines consumed in this pass produced (message-id replacement mutates
    /// seeded entries in place instead of appending).
    stats: CacheStats,
    /// Absolute offset of the next unconsumed byte (always a line boundary).
    consumed_offset: u64,
    /// False when the range ends mid-line; the pending partial line after
    /// `consumed_offset` is deliberately left unconsumed.
    last_line_complete: bool,
    /// Claude continuation state after this pass.
    claude_state: ClaudeParseState,
    /// Codex continuation state after this pass.
    codex_state: CodexParseState,
}

/// Prior parse state an incremental pass resumes from: the entries
/// accumulated by earlier passes plus the per-source accumulator state.
/// Full parses start from `Default` (no entries, fresh state).
#[derive(Debug, Default)]
struct ParseResume {
    entries: Vec<CacheEntry>,
    claude_state: ClaudeParseState,
    codex_state: CodexParseState,
}

/// Parse `bytes` (which start at absolute file offset `start_offset`) by
/// feeding only `\n`-terminated lines into the shared accumulators. A
/// trailing chunk without `\n` is treated as a pending partial line and left
/// unconsumed — the invariant that makes incremental offset tracking safe
/// (a partial line is never trusted, never counted, and never counted twice).
fn parse_jsonl_tail(
    source: UsageSource,
    bytes: &[u8],
    start_offset: u64,
    resume: ParseResume,
    prices: &HashMap<String, ModelPrice>,
) -> JsonlTailStats {
    let ParseResume {
        mut entries,
        mut claude_state,
        mut codex_state,
    } = resume;

    let mut line_start = 0usize;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b'\n' {
            continue;
        }
        if let Ok(line) = std::str::from_utf8(&bytes[line_start..index]) {
            match source {
                UsageSource::Claude => {
                    accumulate_claude_line(&mut claude_state, &mut entries, line, prices)
                }
                UsageSource::Codex => {
                    accumulate_codex_line(&mut codex_state, &mut entries, line, prices)
                }
            }
        }
        line_start = index + 1;
    }

    JsonlTailStats {
        stats: CacheStats { entries },
        consumed_offset: start_offset + line_start as u64,
        last_line_complete: line_start == bytes.len(),
        claude_state,
        codex_state,
    }
}

/// Read the byte range [offset, EOF) from `path`. `None` on I/O error.
fn read_jsonl_tail(path: &Path, offset: u64) -> Option<Vec<u8>> {
    let mut file = fs::File::open(path).ok()?;
    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    Some(bytes)
}

const APPEND_ANCHOR_WINDOW: u64 = 64 * 1024;

/// Hash a bounded sample of the bytes already consumed by the incremental
/// parser. Most session files fit entirely inside the two windows. Large files
/// hash both the head and the bytes immediately before `offset`, catching the
/// normal same-path rewrite/rotation shapes while keeping append validation
/// constant-time.
fn compute_append_anchor(path: &Path, offset: u64) -> Option<String> {
    let mut file = File::open(path).ok()?;
    if file.metadata().ok()?.len() < offset {
        return None;
    }

    let mut hasher = Sha256::new();
    hasher.update(offset.to_le_bytes());

    let head_len = offset.min(APPEND_ANCHOR_WINDOW) as usize;
    let mut head = vec![0u8; head_len];
    file.read_exact(&mut head).ok()?;
    hasher.update(&head);

    if offset > APPEND_ANCHOR_WINDOW {
        let tail_start = offset.saturating_sub(APPEND_ANCHOR_WINDOW);
        file.seek(SeekFrom::Start(tail_start)).ok()?;
        let mut tail = vec![0u8; (offset - tail_start) as usize];
        file.read_exact(&mut tail).ok()?;
        hasher.update(&tail);
    }

    Some(hex::encode(hasher.finalize()))
}

/// Verify `offset` sits on a line boundary by checking the preceding byte is
/// `\n` (offset 0 is trivially a boundary). Detects same-path rewrites that
/// would otherwise make the cached offset point mid-line.
fn offset_is_line_boundary(path: &Path, offset: u64) -> bool {
    if offset == 0 {
        return true;
    }
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return false,
    };
    if file.seek(SeekFrom::Start(offset - 1)).is_err() {
        return false;
    }
    let mut byte = [0u8; 1];
    file.read_exact(&mut byte).is_ok_and(|_| byte[0] == b'\n')
}

/// Parse the whole file from byte 0 (full parse). Mirrors the previous
/// `parse_*_jsonl_file` behavior of returning empty stats when the file
/// cannot be opened, and records fresh parse continuation state.
fn full_parse_jsonl(
    source: UsageSource,
    path: &Path,
    meta: CacheMeta,
    prices: &HashMap<String, ModelPrice>,
) -> CacheFileEntry {
    let bytes = read_jsonl_tail(path, 0).unwrap_or_default();
    let tail = parse_jsonl_tail(source, &bytes, 0, ParseResume::default(), prices);
    let mut entry = source_aware_entry(
        meta,
        tail.stats,
        tail.consumed_offset,
        tail.last_line_complete,
        Some(tail.codex_state),
        Some(tail.claude_state),
        source,
    );
    entry.append_anchor = compute_append_anchor(path, entry.parse_offset);
    entry
}

fn source_aware_entry(
    meta: CacheMeta,
    mut stats: CacheStats,
    parse_offset: u64,
    last_line_complete: bool,
    codex_state: Option<CodexParseState>,
    claude_state: Option<ClaudeParseState>,
    source: UsageSource,
) -> CacheFileEntry {
    let source_name = match source {
        UsageSource::Claude => SOURCE_CLAUDE,
        UsageSource::Codex => SOURCE_CODEX,
    };
    let rollup = CacheRollup::from_entries(source_name, &stats.entries);
    if source == UsageSource::Codex {
        stats.entries.clear();
    }
    CacheFileEntry {
        meta,
        stats,
        rollup,
        parse_offset,
        last_line_complete,
        codex_state: match source {
            UsageSource::Claude => None,
            UsageSource::Codex => Some(codex_state.unwrap_or_default()),
        },
        claude_state: match source {
            UsageSource::Claude => Some(claude_state.unwrap_or_default()),
            UsageSource::Codex => None,
        },
        append_anchor: None,
        revision: None,
    }
}

/// Decide per discovered file: reuse cached stats (meta match), extend them
/// incrementally (strict growth), or fall back to a full re-parse.
fn refresh_discovered_entry(
    cached: Option<&CacheFileEntry>,
    discovered: &DiscoveredFile,
    meta: CacheMeta,
    prices: &HashMap<String, ModelPrice>,
) -> CacheFileEntry {
    if let Some(cached) = cached {
        if (cached.meta.mtime - meta.mtime).abs() < 1.0 && cached.meta.size == meta.size {
            let mut entry = cached.clone();
            if entry.append_anchor.is_none() {
                entry.append_anchor = compute_append_anchor(&discovered.path, entry.parse_offset);
            }
            return entry;
        }
        if let Some(entry) = incremental_refresh_entry(cached, discovered, &meta, prices) {
            return entry;
        }
    }
    full_parse_jsonl(discovered.source, &discovered.path, meta, prices)
}

/// Append-aware incremental parse. Guards (any failure falls back to a full
/// re-parse):
/// - strict growth: `size > parse_offset` (equal size with a changed mtime is
///   a same-size rewrite; smaller is truncation/rotation);
/// - rotation: the file's mtime must not be older than the cached one;
/// - boundary: the byte before `parse_offset` must be `\n`.
fn incremental_refresh_entry(
    cached: &CacheFileEntry,
    discovered: &DiscoveredFile,
    meta: &CacheMeta,
    prices: &HashMap<String, ModelPrice>,
) -> Option<CacheFileEntry> {
    if meta.size <= cached.parse_offset {
        return None;
    }
    if meta.mtime < cached.meta.mtime - 1.0 {
        return None;
    }
    if !offset_is_line_boundary(&discovered.path, cached.parse_offset) {
        return None;
    }
    let cached_anchor = cached.append_anchor.as_deref()?;
    if compute_append_anchor(&discovered.path, cached.parse_offset).as_deref()
        != Some(cached_anchor)
    {
        return None;
    }

    let bytes = read_jsonl_tail(&discovered.path, cached.parse_offset)?;
    // Resume from the cached entries + accumulator states instead of
    // extending: a re-emitted message.id in the appended bytes must REPLACE
    // its earlier entry (final usage snapshot wins) rather than append a
    // duplicate.
    let tail = parse_jsonl_tail(
        discovered.source,
        &bytes,
        cached.parse_offset,
        ParseResume {
            entries: if discovered.source == UsageSource::Claude {
                cached.stats.entries.clone()
            } else {
                Vec::new()
            },
            claude_state: cached.claude_state.clone().unwrap_or_default(),
            codex_state: cached.codex_state.clone().unwrap_or_default(),
        },
        prices,
    );

    let mut entry = source_aware_entry(
        meta.clone(),
        tail.stats,
        tail.consumed_offset,
        tail.last_line_complete,
        Some(tail.codex_state),
        Some(tail.claude_state),
        discovered.source,
    );

    if discovered.source == UsageSource::Codex {
        let mut accumulator = RollupAccumulator::from_rollup(&cached.rollup);
        accumulator.add(&entry.rollup);
        entry.rollup = accumulator.finish();
    }
    entry.append_anchor = compute_append_anchor(&discovered.path, entry.parse_offset);

    if ANALYTICS_SHADOW_INCREMENTAL {
        let full = full_parse_jsonl(discovered.source, &discovered.path, meta.clone(), prices);
        if entry.stats != full.stats || entry.rollup != full.rollup {
            eprintln!(
                "analytics shadow mismatch for {}: incremental {:?} != full {:?}",
                discovered.path.display(),
                entry.rollup,
                full.rollup
            );
        }
        debug_assert_eq!(
            entry.stats,
            full.stats,
            "incremental entries diverged from full parse for {}",
            discovered.path.display()
        );
        debug_assert_eq!(
            entry.rollup,
            full.rollup,
            "incremental rollup diverged from full parse for {}",
            discovered.path.display()
        );
    }

    Some(entry)
}

// ============================================================================
// Cache read / write
// ============================================================================

fn usage_cache_path() -> PathBuf {
    config::get_ccem_dir().join("usage-cache-desktop.json")
}

fn legacy_usage_cache_path() -> PathBuf {
    config::get_ccem_dir().join("usage-cache.json")
}

fn usage_summary_path() -> PathBuf {
    config::get_ccem_dir().join("usage-summary.json")
}

fn read_usage_cache() -> CacheFile {
    let desktop_path = usage_cache_path();
    if desktop_path.exists() {
        read_usage_cache_at(&desktop_path)
    } else {
        // One-way, read-only import. The CLI and older Desktop releases keep
        // owning usage-cache.json; v7 never overwrites it.
        read_usage_cache_at(&legacy_usage_cache_path())
    }
}

fn compact_cache(mut cache: CacheFile) -> CacheFile {
    for (path, entry) in &mut cache.files {
        let Some(source) = detect_source_from_path(path) else {
            continue;
        };
        if entry.rollup.buckets.is_empty() && !entry.stats.entries.is_empty() {
            entry.rollup = CacheRollup::from_entries(source, &entry.stats.entries);
        }
        if source != SOURCE_CLAUDE {
            entry.stats.entries.clear();
        }
    }
    cache.global_rollup = CacheRollup::from_file_entries(&cache.files);
    cache.version = USAGE_CACHE_VERSION;
    cache
}

/// Read a usage cache from an explicit path (test seam). Versions 5 and 6
/// are compacted once into v7. Older versions fail closed.
fn read_usage_cache_at(path: &Path) -> CacheFile {
    if !path.exists() {
        return CacheFile::default();
    }
    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return CacheFile::default(),
    };
    match serde_json::from_reader::<_, CacheFile>(std::io::BufReader::new(file)) {
        Ok(cache) if cache.version == USAGE_CACHE_VERSION => {
            if cache.global_rollup.buckets.is_empty()
                && cache.files.values().any(|entry| {
                    !entry.rollup.buckets.is_empty() || !entry.stats.entries.is_empty()
                })
            {
                compact_cache(cache)
            } else {
                cache
            }
        }
        Ok(cache) if matches!(cache.version, 5 | 6) => compact_cache(cache),
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

// ============================================================================
// Shared single-flight snapshot — the one refresh path for all analytics
// commands
// ============================================================================

/// Process-wide shared cache snapshot. Entry stats are read-only after
/// build; all four usage commands aggregate from the same `Arc`.
struct UsageSnapshot {
    cache: Arc<CacheFile>,
    collected_at: Instant,
}

fn lock_usage_snapshot() -> MutexGuard<'static, Option<UsageSnapshot>> {
    USAGE_SNAPSHOT
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn lock_usage_refresh_inflight() -> MutexGuard<'static, ()> {
    USAGE_REFRESH_INFLIGHT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn snapshot_is_fresh(collected_at: Instant) -> bool {
    collected_at.elapsed() < USAGE_STATS_MEMO_TTL
}

/// Build a fresh cache snapshot. Tests can stub this out (with a call
/// counter) to observe how often a real refresh runs.
fn collect_usage_snapshot() -> CacheFile {
    #[cfg(test)]
    {
        let stub = *TEST_SNAPSHOT_REFRESH
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(stub) = stub {
            return stub();
        }
    }
    refresh_usage_cache()
}

/// Single-flight shared snapshot: fresh within TTL it is returned as-is;
/// concurrent callers wait for the in-flight refresh (they queue on
/// `USAGE_REFRESH_INFLIGHT`, released when the refresh completes) and then
/// re-use its result. Lock ordering is strictly
/// `USAGE_REFRESH_INFLIGHT` → (`USAGE_REFRESH_LOCK` → file lock) inside
/// `refresh_usage_cache`; nothing acquires the inflight lock while holding
/// the snapshot or refresh locks, so the layers cannot deadlock.
///
/// `min_collected_at` carries force semantics: `Some(request_started)` (a
/// force refresh) never reuses a snapshot collected BEFORE this request
/// started, but does reuse one collected after it — including by a concurrent
/// refresh — so concurrent force requests still merge into a single
/// collection. `None` keeps the plain TTL behaviour.
fn shared_usage_cache(min_collected_at: Option<Instant>) -> Arc<CacheFile> {
    {
        let snapshot = lock_usage_snapshot();
        if let Some(current) = snapshot.as_ref() {
            if snapshot_satisfies_request(current.collected_at, min_collected_at) {
                return current.cache.clone();
            }
        }
    }

    // Wait for any concurrent refresh to finish (blocking lock = the wait),
    // then re-check: the predecessor's snapshot may already satisfy us.
    let _inflight = lock_usage_refresh_inflight();
    {
        let snapshot = lock_usage_snapshot();
        if let Some(current) = snapshot.as_ref() {
            if snapshot_satisfies_request(current.collected_at, min_collected_at) {
                return current.cache.clone();
            }
        }
    }

    let cache = Arc::new(collect_usage_snapshot());
    *lock_usage_snapshot() = Some(UsageSnapshot {
        cache: cache.clone(),
        collected_at: Instant::now(),
    });
    cache
}

/// Non-force requests reuse any snapshot inside the TTL window. Force
/// requests only reuse snapshots collected at/after their request start.
fn snapshot_satisfies_request(collected_at: Instant, min_collected_at: Option<Instant>) -> bool {
    match min_collected_at {
        Some(min) => collected_at >= min,
        None => snapshot_is_fresh(collected_at),
    }
}

#[cfg(test)]
static TEST_SNAPSHOT_REFRESH: OnceLock<Mutex<Option<fn() -> CacheFile>>> = OnceLock::new();

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
                    && cached.stats == entry.stats
                    && cached.rollup == entry.rollup
                    && cached.parse_offset == entry.parse_offset
                    && cached.last_line_complete == entry.last_line_complete
                    && cached.codex_state == entry.codex_state
                    && cached.claude_state == entry.claude_state
                    && cached.append_anchor == entry.append_anchor
                    && cached.revision == entry.revision
            })
        })
}

/// Apply only changed file contributions to the persisted global rollup.
/// The returned counter is the number of compact buckets added/subtracted;
/// callers ignore it in production, while tests use it to prove unchanged
/// histories do not enter the aggregation path.
fn update_global_rollup(
    existing: &CacheFile,
    next_files: &HashMap<String, CacheFileEntry>,
) -> (CacheRollup, usize) {
    let baseline = if existing.global_rollup.buckets.is_empty() {
        CacheRollup::from_file_entries(&existing.files)
    } else {
        existing.global_rollup.clone()
    };
    let mut accumulator = RollupAccumulator::from_rollup(&baseline);
    let mut bucket_mutations = 0usize;

    for (path, old_entry) in &existing.files {
        match next_files.get(path) {
            None => {
                accumulator.subtract(&old_entry.rollup);
                bucket_mutations += old_entry.rollup.buckets.len();
            }
            Some(next_entry) if next_entry.rollup != old_entry.rollup => {
                accumulator.subtract(&old_entry.rollup);
                accumulator.add(&next_entry.rollup);
                bucket_mutations +=
                    old_entry.rollup.buckets.len() + next_entry.rollup.buckets.len();
            }
            Some(_) => {}
        }
    }

    for (path, next_entry) in next_files {
        if !existing.files.contains_key(path) {
            accumulator.add(&next_entry.rollup);
            bucket_mutations += next_entry.rollup.buckets.len();
        }
    }

    (accumulator.finish(), bucket_mutations)
}

/// A failed or partial enumeration is not evidence that previously cached
/// sessions were deleted. Preserve unseen entries for that source until a
/// later authoritative enumeration succeeds.
fn retain_incomplete_source_entries(
    existing: &CacheFile,
    source: &str,
    next: &mut HashMap<String, CacheFileEntry>,
    complete: bool,
) {
    if complete {
        return;
    }
    for (path, entry) in &existing.files {
        if detect_source_from_path(path) == Some(source) {
            next.entry(path.clone()).or_insert_with(|| entry.clone());
        }
    }
}

fn should_write_usage_cache(
    desktop_cache_exists: bool,
    existing: &CacheFile,
    next: &CacheFile,
) -> bool {
    !desktop_cache_exists
        || !cache_files_have_same_meta(&existing.files, &next.files)
        || existing.global_rollup != next.global_rollup
}

// ============================================================================
// Orchestration: incremental refresh
// ============================================================================

/// Refresh usage cache by scanning known usage files incrementally.
fn refresh_usage_cache() -> CacheFile {
    let _process_guard = lock_usage_refresh();
    let _ = config::ensure_ccem_dir();
    let lock_path = config::get_ccem_dir().join("usage-cache-desktop.lock");
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
    let discovery = discover_jsonl_files();
    let mut claude_complete = discovery.claude_complete;
    let mut codex_complete = discovery.codex_complete;
    let desktop_cache_exists = usage_cache_path().exists();
    let existing_cache = read_usage_cache();

    let mut new_cache = CacheFile {
        version: USAGE_CACHE_VERSION,
        files: HashMap::new(),
        global_rollup: CacheRollup::default(),
        last_updated: Some(Local::now().to_rfc3339()),
    };

    for discovered in discovery.files {
        let path_str = discovered.path.to_string_lossy().to_string();

        let meta = match get_file_meta(&discovered.path) {
            Some(m) => m,
            None => {
                match discovered.source {
                    UsageSource::Claude => claude_complete = false,
                    UsageSource::Codex => codex_complete = false,
                }
                continue;
            }
        };

        let cached = existing_cache.files.get(&path_str);
        let entry = refresh_discovered_entry(cached, &discovered, meta, &prices);
        if entry.append_anchor.is_none() {
            match discovered.source {
                UsageSource::Claude => claude_complete = false,
                UsageSource::Codex => codex_complete = false,
            }
            continue;
        }

        new_cache.files.insert(path_str, entry);
    }

    retain_incomplete_source_entries(
        &existing_cache,
        SOURCE_CLAUDE,
        &mut new_cache.files,
        claude_complete,
    );
    retain_incomplete_source_entries(
        &existing_cache,
        SOURCE_CODEX,
        &mut new_cache.files,
        codex_complete,
    );

    let opencode_result = load_opencode_cache_entries(&prices, &existing_cache);
    for (path_key, entry) in opencode_result.entries {
        new_cache.files.insert(path_key, entry);
    }
    retain_incomplete_source_entries(
        &existing_cache,
        SOURCE_OPENCODE,
        &mut new_cache.files,
        opencode_result.complete,
    );

    // DSH usage — virtual keys dsh://<sourceInstanceId>/<sessionId>
    let dsh_result = load_dsh_usage_data(&prices, &existing_cache);
    *lock_dsh_status() = Some(dsh_result.status);
    for (path_key, entry) in dsh_result.entries {
        new_cache.files.insert(path_key, entry);
    }
    retain_incomplete_source_entries(
        &existing_cache,
        SOURCE_DSH,
        &mut new_cache.files,
        dsh_result.complete,
    );

    new_cache.global_rollup = update_global_rollup(&existing_cache, &new_cache.files).0;

    if should_write_usage_cache(desktop_cache_exists, &existing_cache, &new_cache) {
        write_usage_cache(&new_cache);
    }
    new_cache
}

struct SourceCacheLoad {
    entries: HashMap<String, CacheFileEntry>,
    complete: bool,
}

fn load_opencode_cache_entries(
    prices: &HashMap<String, ModelPrice>,
    existing_cache: &CacheFile,
) -> SourceCacheLoad {
    let (local_sessions, local_complete) = opencode::list_local_sessions_with_completeness();
    let local_sessions = local_sessions
        .into_iter()
        .map(|session| (session.id.clone(), session))
        .collect::<HashMap<_, _>>();

    let session_list_result = opencode::load_session_list_value_from_cli_or_fixture();
    let Some(session_list) = session_list_result.ok().flatten() else {
        return SourceCacheLoad {
            entries: build_local_opencode_cache_entries(&local_sessions, existing_cache),
            complete: local_complete,
        };
    };

    let Some(items) = parse_opencode_session_items(&session_list) else {
        return SourceCacheLoad {
            entries: build_local_opencode_cache_entries(&local_sessions, existing_cache),
            complete: local_complete,
        };
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

        if cache_valid {
            let mut cached = existing_cache.files[&path_key].clone();
            cached.meta = meta;
            entries.insert(path_key, cached);
            continue;
        }

        let stats = opencode::load_export_from_cli_or_fixture(&session.id)
            .ok()
            .flatten()
            .map(|value| parse_opencode_export_stats(&value, &session.environment, prices))
            .or_else(|| local_session.map(local_opencode_session_to_cache_stats));

        let Some(stats) = stats else {
            if let Some(cached) = existing_cache.files.get(&path_key) {
                entries.insert(path_key, cached.clone());
            }
            continue;
        };

        entries.insert(
            path_key,
            CacheFileEntry::from_meta_stats(meta, stats, SOURCE_OPENCODE),
        );
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

        if cache_valid {
            let mut cached = existing_cache.files[&path_key].clone();
            cached.meta = meta;
            entries.insert(path_key, cached);
            continue;
        }

        let stats = local_opencode_session_to_cache_stats(session);

        entries.insert(
            path_key,
            CacheFileEntry::from_meta_stats(meta, stats, SOURCE_OPENCODE),
        );
    }

    SourceCacheLoad {
        entries,
        // A valid CLI list is the authoritative session inventory even when
        // the optional local mirror was unavailable.
        complete: true,
    }
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

        if cache_valid {
            let mut cached = existing_cache.files[&path_key].clone();
            cached.meta = meta;
            entries.insert(path_key, cached);
            continue;
        }

        let stats = local_opencode_session_to_cache_stats(session);

        entries.insert(
            path_key,
            CacheFileEntry::from_meta_stats(meta, stats, SOURCE_OPENCODE),
        );
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
// DSH usage discovery and cache integration
// ============================================================================

/// Result of attempting to load DSH usage data.
struct DshLoadResult {
    entries: HashMap<String, CacheFileEntry>,
    status: DshSourceStatus,
    complete: bool,
}

/// Map DSH provider name to environment display name.
fn dsh_provider_to_environment(provider: Option<&str>) -> Option<String> {
    match provider.map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(p) => {
            let lower = p.to_ascii_lowercase();
            if lower.contains("deepseek") {
                Some("DeepSeek".to_string())
            } else {
                Some(p.to_string())
            }
        }
        None => None,
    }
}

/// Convert a millisecond timestamp to ISO 8601 (local time).
fn ms_to_iso(ms: i64) -> String {
    use chrono::TimeZone;
    let secs = ms / 1000;
    let nanos = ((ms % 1000) * 1_000_000) as u32;
    match Local.timestamp_opt(secs, nanos) {
        chrono::LocalResult::Single(dt) => dt.to_rfc3339(),
        _ => {
            // Fallback: just use the seconds
            Local
                .timestamp_opt(secs, 0)
                .single()
                .map(|dt| dt.to_rfc3339())
                .unwrap_or_else(|| "1970-01-01T00:00:00+00:00".to_string())
        }
    }
}

/// Load DSH usage entries from the helper (blocking, no AppHandle).
/// On failure: returns empty entries with error status.
fn load_dsh_usage_data(
    prices: &HashMap<String, ModelPrice>,
    existing_cache: &CacheFile,
) -> DshLoadResult {
    let source = match dsh_history::resolve_dsh_source() {
        Ok(s) => s,
        Err(dsh_history::DshHistoryError::Absent) => {
            return DshLoadResult {
                entries: HashMap::new(),
                status: DshSourceStatus {
                    available: false,
                    error: None,
                    session_count: 0,
                },
                complete: true,
            };
        }
        Err(e) => {
            return DshLoadResult {
                entries: HashMap::new(),
                status: DshSourceStatus {
                    available: false,
                    error: Some(e.to_string()),
                    session_count: 0,
                },
                complete: false,
            };
        }
    };

    let roots = vec![source.sessions_root.to_string_lossy().to_string()];
    let request = dsh_history::DshHistoryRequest::Usage {
        roots: roots.clone(),
    };

    let helper_path = match resolve_dsh_helper_for_analytics() {
        Some(p) => p,
        None => {
            return DshLoadResult {
                entries: HashMap::new(),
                status: DshSourceStatus {
                    available: false,
                    error: Some("DSH helper not found".to_string()),
                    session_count: 0,
                },
                complete: false,
            };
        }
    };

    let ccem_node = match resolve_ccem_node_for_analytics() {
        Some(p) => p,
        None => {
            return DshLoadResult {
                entries: HashMap::new(),
                status: DshSourceStatus {
                    available: false,
                    error: Some("ccem-node sidecar not found".to_string()),
                    session_count: 0,
                },
                complete: false,
            };
        }
    };

    let request_json = match serde_json::to_string(&request) {
        Ok(j) => j,
        Err(e) => {
            return DshLoadResult {
                entries: HashMap::new(),
                status: DshSourceStatus {
                    available: false,
                    error: Some(format!("serialize error: {e}")),
                    session_count: 0,
                },
                complete: false,
            };
        }
    };
    let roots_json = serde_json::to_string(&roots).unwrap_or_else(|_| "[]".to_string());

    let usage_entries: Vec<dsh_history::DshUsageEntry> =
        match dsh_history::process::invoke_helper_core(
            helper_path,
            ccem_node,
            request_json,
            roots_json,
            &dsh_history::InvocationLimits::production(),
        ) {
            Ok((entries, _warnings)) => entries,
            Err(e) => {
                return DshLoadResult {
                    entries: HashMap::new(),
                    status: DshSourceStatus {
                        available: false,
                        error: Some(e.to_string()),
                        session_count: 0,
                    },
                    complete: false,
                };
            }
        };

    let session_count = usage_entries.len() as u32;
    let mut entries = HashMap::new();

    for usage_entry in &usage_entries {
        let path_key = format!(
            "dsh://{}/{}",
            usage_entry.source_instance_id, usage_entry.session_id
        );

        // Check cache: if revision matches, reuse
        if let Some(cached) = existing_cache.files.get(&path_key) {
            if cached.revision.as_deref() == usage_entry.revision.as_deref()
                && usage_entry.revision.is_some()
            {
                entries.insert(path_key, cached.clone());
                continue;
            }
        }

        // Build stats from steps
        let mut stats = build_dsh_cache_stats(&usage_entry.steps, prices);
        let rollup = CacheRollup::from_entries(SOURCE_DSH, &stats.entries);
        stats.entries.clear();
        entries.insert(
            path_key,
            CacheFileEntry {
                meta: CacheMeta {
                    mtime: 0.0,
                    size: 0,
                },
                stats,
                rollup,
                parse_offset: 0,
                last_line_complete: true,
                codex_state: None,
                claude_state: None,
                append_anchor: None,
                revision: usage_entry.revision.clone(),
            },
        );
    }

    DshLoadResult {
        entries,
        status: DshSourceStatus {
            available: true,
            error: None,
            session_count,
        },
        complete: true,
    }
}

/// Build CacheStats from DSH usage steps.
fn build_dsh_cache_stats(
    steps: &[dsh_history::DshUsageStep],
    prices: &HashMap<String, ModelPrice>,
) -> CacheStats {
    let mut entries = Vec::with_capacity(steps.len());
    for step in steps {
        let model = step.model.clone().unwrap_or_else(|| "unknown".to_string());
        let environment = dsh_provider_to_environment(step.provider.as_deref());
        let cost = calculate_cost_or_zero(
            &model,
            step.input_tokens,
            step.output_tokens,
            step.cache_read_tokens,
            step.cache_write_tokens,
            prices,
        );
        let timestamp = step
            .time
            .map(ms_to_iso)
            .unwrap_or_else(|| "1970-01-01T00:00:00+00:00".to_string());

        entries.push(CacheEntry {
            timestamp,
            model,
            environment,
            usage: CacheUsage {
                input_tokens: step.input_tokens,
                output_tokens: step.output_tokens,
                cache_read_tokens: step.cache_read_tokens,
                cache_creation_tokens: step.cache_write_tokens,
                cost,
            },
        });
    }
    CacheStats { entries }
}

/// Resolve DSH helper script path without AppHandle.
fn resolve_dsh_helper_for_analytics() -> Option<PathBuf> {
    // In debug: try source path first
    if cfg!(debug_assertions) {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("dsh-history")
            .join("lib/dsh-history-helper.mjs");
        if source.exists() {
            return Some(source);
        }
    }

    // Release: next to executable
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let candidates = [
        exe_dir.join("../Resources/resources/dsh-history/lib/dsh-history-helper.mjs"),
        exe_dir.join("resources/dsh-history/lib/dsh-history-helper.mjs"),
        exe_dir.join("dsh-history/lib/dsh-history-helper.mjs"),
    ];
    candidates.iter().find(|p| p.exists()).cloned()
}

/// Resolve ccem-node sidecar path without AppHandle.
fn resolve_ccem_node_for_analytics() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let name = if cfg!(windows) {
        "ccem-node.exe"
    } else {
        "ccem-node"
    };
    let path = exe_dir.join(name);
    if path.exists() {
        Some(path)
    } else {
        None
    }
}

/// Global DSH source status — populated during each cache refresh.
static DSH_SOURCE_STATUS: OnceLock<Mutex<Option<DshSourceStatus>>> = OnceLock::new();

fn lock_dsh_status() -> MutexGuard<'static, Option<DshSourceStatus>> {
    DSH_SOURCE_STATUS
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
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
    if path.starts_with("dsh://") {
        return Some(SOURCE_DSH);
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
        SOURCE_DSH => Ok(Some(SOURCE_DSH)),
        _ => Err(format!(
            "Unsupported source '{}'. Use claude, codex, opencode, dsh, or all.",
            raw
        )),
    }
}

fn effective_cache_rollup(cache: &CacheFile) -> Cow<'_, CacheRollup> {
    if !cache.global_rollup.buckets.is_empty() {
        return Cow::Borrowed(&cache.global_rollup);
    }

    // Compatibility fallback for in-memory callers and tests that construct
    // legacy entries directly. Persisted v7 caches always take the branch
    // above and never visit raw rows.
    let mut accumulator = RollupAccumulator::default();
    for (path, entry) in &cache.files {
        if !entry.rollup.buckets.is_empty() {
            accumulator.add(&entry.rollup);
            continue;
        }
        if !entry.stats.entries.is_empty() {
            let source = detect_source_from_path(path).unwrap_or("unknown");
            accumulator.add(&CacheRollup::from_entries(source, &entry.stats.entries));
        }
    }
    Cow::Owned(accumulator.finish())
}

fn bucket_token_usage<'a>(
    bucket: &CacheRollupBucket,
    prices: &'a HashMap<String, ModelPrice>,
    price_by_model: &mut HashMap<String, Option<&'a ModelPrice>>,
) -> TokenUsageWithCost {
    let total_tokens = bucket.usage.input_tokens
        + bucket.usage.output_tokens
        + bucket.usage.cache_read_tokens
        + bucket.usage.cache_creation_tokens;
    let price = *price_by_model
        .entry(bucket.model.clone())
        .or_insert_with(|| get_model_price(&bucket.model, prices));
    let unpriced_tokens = match price {
        None => total_tokens,
        Some(price) => {
            let mut unpriced = 0u64;
            if bucket.usage.cache_read_tokens > 0 && price.cache_read_input_token_cost.is_none() {
                unpriced += bucket.usage.cache_read_tokens;
            }
            if bucket.usage.cache_creation_tokens > 0
                && price.cache_creation_input_token_cost.is_none()
            {
                unpriced += bucket.usage.cache_creation_tokens;
            }
            unpriced
        }
    };

    TokenUsageWithCost {
        input_tokens: bucket.usage.input_tokens,
        output_tokens: bucket.usage.output_tokens,
        cache_read_tokens: bucket.usage.cache_read_tokens,
        cache_creation_tokens: bucket.usage.cache_creation_tokens,
        cost: bucket.usage.cost,
        unpriced_tokens,
        cost_incomplete: unpriced_tokens > 0,
    }
}

fn aggregate_cache(
    cache: &CacheFile,
    source_filter: Option<&'static str>,
    prices: &HashMap<String, ModelPrice>,
) -> UsageStats {
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
    let mut price_by_model: HashMap<String, Option<&ModelPrice>> = HashMap::new();
    let rollup = effective_cache_rollup(cache);

    for bucket in &rollup.buckets {
        if source_filter.is_some_and(|filter| bucket.source != filter) {
            continue;
        }

        let token_usage = bucket_token_usage(bucket, prices, &mut price_by_model);

        stats.total.add(&token_usage);
        stats
            .by_model
            .entry(bucket.model.clone())
            .or_default()
            .add(&token_usage);
        if let Some(environment) = bucket
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

        if let Some(date_str) = bucket.date.clone() {
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

        if let Some(hour_key) = bucket.hour.clone() {
            stats
                .hourly_history
                .entry(hour_key)
                .or_default()
                .add(&token_usage);
        }
    }

    stats
}

fn aggregate_model_breakdown(
    cache: &CacheFile,
    source_filter: Option<&'static str>,
    granularity: ModelBreakdownGranularity,
    now: chrono::DateTime<Local>,
    prices: &HashMap<String, ModelPrice>,
) -> ModelBreakdownHistory {
    let mut breakdown: ModelBreakdownHistory = HashMap::new();
    let mut price_by_model: HashMap<String, Option<&ModelPrice>> = HashMap::new();
    let rollup = effective_cache_rollup(cache);

    for bucket in &rollup.buckets {
        if source_filter.is_some_and(|filter| bucket.source != filter) {
            continue;
        }
        let bucket_key = match granularity {
            ModelBreakdownGranularity::Hour => bucket.hour.clone(),
            ModelBreakdownGranularity::Day => bucket.date.clone(),
            ModelBreakdownGranularity::Week => bucket.date.as_ref().and_then(|date| {
                NaiveDate::parse_from_str(date, "%Y-%m-%d")
                    .ok()
                    .map(format_week_bucket)
            }),
            ModelBreakdownGranularity::Month => bucket.date.as_ref().and_then(|date| {
                NaiveDate::parse_from_str(date, "%Y-%m-%d")
                    .ok()
                    .map(|date| date.format("%Y-%m").to_string())
            }),
        };
        let Some(bucket_key) = bucket_key else {
            continue;
        };

        let token_usage = bucket_token_usage(bucket, prices, &mut price_by_model);

        breakdown
            .entry(bucket_key)
            .or_default()
            .entry(bucket.model.clone())
            .or_default()
            .add(&token_usage);
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

        // Force must also hold at the SHARED snapshot layer: a snapshot
        // collected before this request started is not reusable even when it
        // is still TTL-fresh; one collected after (by a concurrent refresh)
        // is, preserving single-flight for concurrent force requests.
        let cache = shared_usage_cache(force_requested.then_some(request_started));
        let prices = load_model_prices();
        let mut stats = aggregate_cache(&cache, source_filter, &prices);

        // Attach DSH source status for 'all' or 'dsh' queries
        if source_filter.is_none() || source_filter == Some(SOURCE_DSH) {
            stats.dsh_status = lock_dsh_status().clone();
        }

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
        let cache = shared_usage_cache(None);
        let prices = load_model_prices();
        let stats = aggregate_cache(&cache, source_filter, &prices);

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
        let cache = shared_usage_cache(None);
        let prices = load_model_prices();
        Ok(aggregate_model_breakdown(
            &cache,
            source_filter,
            granularity,
            Local::now(),
            &prices,
        ))
    })
    .await
}

/// Calculate continuous usage days (streak), optionally filtered by source.
#[tauri::command]
pub async fn get_continuous_usage_days(source: Option<String>) -> Result<u32, String> {
    run_blocking(move || {
        let source_filter = normalize_usage_source(source.as_deref())?;
        let cache = shared_usage_cache(None);
        let prices = load_model_prices();
        let stats = aggregate_cache(&cache, source_filter, &prices);
        Ok(calculate_streak(&stats.daily_history))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::{
        aggregate_cache, aggregate_model_breakdown, build_local_opencode_cache_entries,
        cache_files_have_same_meta, calculate_streak, default_prices, detect_source_from_path,
        dsh_provider_to_environment, extract_model_breakdown_bucket, format_week_bucket,
        full_parse_jsonl, get_file_meta, lock_usage_snapshot, lock_usage_stats_memo,
        model_price_lookup_count, normalize_usage_source, parse_claude_jsonl_reader,
        parse_codex_jsonl_reader, parse_opencode_export_stats, parse_opencode_session_items,
        read_usage_cache_at, read_usage_summary_from, refresh_discovered_entry,
        reset_model_price_lookup_count, retain_incomplete_source_entries, shared_usage_cache,
        should_reuse_usage_stats, should_write_usage_cache, snapshot_is_fresh,
        update_global_rollup, usage_cache_path, write_json_atomic, write_usage_summary_to,
        CacheEntry, CacheFile, CacheFileEntry, CacheMeta, CacheRollup, CacheRollupBucket,
        CacheStats, CacheUsage, ClaudeParseState, CodexParseState, DiscoveredFile,
        ModelBreakdownGranularity, ModelPrice, TokenUsageWithCost, UsageSource, UsageStats,
        ANALYTICS_SHADOW_INCREMENTAL, OPENCODE_NATIVE_ENV_NAME, SOURCE_CLAUDE, SOURCE_CODEX,
        SOURCE_DSH, SOURCE_OPENCODE, TEST_SNAPSHOT_REFRESH, USAGE_CACHE_VERSION,
        USAGE_SUMMARY_VERSION,
    };
    use chrono::{Local, TimeZone};
    use std::collections::HashMap;
    use std::fs;
    use std::io::BufReader;
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    use std::thread;
    use std::time::{Duration, Instant};

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
            ..Default::default()
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
                ..Default::default()
            },
        );
        files.insert(
            "/tmp/.codex/sessions/session.jsonl".to_string(),
            CacheFileEntry {
                meta: CacheMeta::default(),
                stats: CacheStats {
                    entries: codex_entries,
                },
                ..Default::default()
            },
        );

        CacheFile {
            version: 1,
            files,
            global_rollup: CacheRollup::default(),
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
            &default_prices(),
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

        let day_result = aggregate_model_breakdown(
            &cache,
            None,
            ModelBreakdownGranularity::Day,
            fixed_now(),
            &default_prices(),
        );
        assert_eq!(day_result.len(), 7);
        assert!(!day_result.contains_key("2026-02-27"));
        assert_eq!(day_result["2026-03-06"]["claude-opus-4-5"].input_tokens, 80);

        let week_result = aggregate_model_breakdown(
            &cache,
            None,
            ModelBreakdownGranularity::Week,
            fixed_now(),
            &default_prices(),
        );
        assert!(week_result.contains_key(&format_week_bucket(
            chrono::NaiveDate::from_ymd_opt(2026, 3, 6).unwrap()
        )));

        let month_result = aggregate_model_breakdown(
            &cache,
            None,
            ModelBreakdownGranularity::Month,
            fixed_now(),
            &default_prices(),
        );
        let march_total = &month_result["2026-03"]["claude-opus-4-5"];
        assert_eq!(march_total.input_tokens, 330);
        assert_eq!(march_total.output_tokens, 0);
        assert_eq!(march_total.cache_read_tokens, 0);
        assert_eq!(march_total.cache_creation_tokens, 0);
        assert!((march_total.cost - 3.3).abs() < 1e-9);
    }

    #[test]
    fn claude_jsonl_dedups_assistant_messages_by_message_id() {
        // Claude Code writes partial assistant records as the stream
        // progresses: the same message.id appears multiple times with growing
        // usage. Only the last record per id is meaningful for per-request
        // usage; without dedup tokens inflate ~3x.
        let jsonl = r#"
{"type":"assistant","message":{"id":"msg_a","model":"glm-5.3","usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0}}}
{"type":"assistant","message":{"id":"msg_a","model":"glm-5.3","usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":30}}}
{"type":"assistant","message":{"id":"msg_a","model":"glm-5.3","usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":30}}}
{"type":"assistant","message":{"id":"msg_b","model":"deepseek-v4-flash","usage":{"input_tokens":50,"output_tokens":5}}}
{"type":"assistant","message":{"id":null,"model":"deepseek-v4-flash","usage":{"input_tokens":7,"output_tokens":1}}}
"#;
        let stats = parse_claude_jsonl_reader(jsonl.as_bytes(), &HashMap::new());
        let total: u64 = stats.entries.iter().map(|e| e.usage.input_tokens).sum();
        let output_total: u64 = stats.entries.iter().map(|e| e.usage.output_tokens).sum();
        let cache_read_total: u64 = stats
            .entries
            .iter()
            .map(|e| e.usage.cache_read_tokens)
            .sum();
        // final snapshot of msg_a (100/20) + msg_b (50/5) + id-less record (7/1)
        assert_eq!(
            total, 157,
            "duplicate message.id must keep its final input usage"
        );
        assert_eq!(
            output_total, 26,
            "duplicate message.id must keep its final output usage"
        );
        assert_eq!(
            cache_read_total, 30,
            "duplicate message.id must keep its final cache usage"
        );
        assert_eq!(stats.entries.len(), 3);
    }

    // ========================================================================
    // Plan 021: single-flight snapshot + append-aware incremental parsing.
    // All fixtures live in tempdirs — the real ~/.ccem/usage-cache.json is
    // never read or written by tests.
    // ========================================================================

    fn claude_line(ts: &str, input: u64, output: u64) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"{ts}","message":{{"model":"claude-sonnet-4-5","usage":{{"input_tokens":{input},"output_tokens":{output},"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}"#
        )
    }

    /// `claude_line` with a message.id: Claude Code re-emits the same id as a
    /// stream progresses, so fixtures for the dedup path need stable ids.
    fn claude_message_line(ts: &str, id: &str, input: u64, output: u64) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"{ts}","message":{{"id":"{id}","model":"claude-sonnet-4-5","usage":{{"input_tokens":{input},"output_tokens":{output},"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}"#
        )
    }

    fn codex_context_line(model: &str) -> String {
        format!(r#"{{"type":"turn_context","payload":{{"model":"{model}"}}}}"#)
    }

    fn codex_count_line(ts: &str, input: u64, cached: u64, output: u64, reasoning: u64) -> String {
        format!(
            r#"{{"timestamp":"{ts}","type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":{input},"cached_input_tokens":{cached},"output_tokens":{output},"reasoning_output_tokens":{reasoning}}}}}}}}}"#
        )
    }

    fn discovered_at(path: &Path, source: UsageSource) -> DiscoveredFile {
        DiscoveredFile {
            path: path.to_path_buf(),
            source,
        }
    }

    fn meta_of(path: &Path) -> CacheMeta {
        get_file_meta(&path.to_path_buf()).expect("fixture file meta")
    }

    /// One refresh round over a fixture file (same decision path as
    /// `refresh_usage_cache_locked`).
    fn refresh_round(
        cached: Option<&CacheFileEntry>,
        discovered: &DiscoveredFile,
    ) -> CacheFileEntry {
        refresh_discovered_entry(
            cached,
            discovered,
            meta_of(&discovered.path),
            &default_prices(),
        )
    }

    /// Independent full-parse reference for shadow assertions.
    fn full_stats(discovered: &DiscoveredFile) -> CacheStats {
        full_parse_jsonl(
            discovered.source,
            &discovered.path,
            meta_of(&discovered.path),
            &default_prices(),
        )
        .stats
    }

    fn full_rollup(discovered: &DiscoveredFile) -> CacheRollup {
        full_parse_jsonl(
            discovered.source,
            &discovered.path,
            meta_of(&discovered.path),
            &default_prices(),
        )
        .rollup
    }

    fn input_total(stats: &CacheStats) -> u64 {
        stats
            .entries
            .iter()
            .map(|entry| entry.usage.input_tokens)
            .sum()
    }

    fn append_bytes(path: &Path, bytes: &str) {
        use std::io::Write as _;
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(path)
            .expect("open fixture for append");
        file.write_all(bytes.as_bytes())
            .expect("append fixture bytes");
    }

    #[test]
    fn test_snapshot_freshness_window() {
        assert!(snapshot_is_fresh(Instant::now()));
        let stale = Instant::now()
            .checked_sub(Duration::from_secs(61))
            .expect("stale instant");
        assert!(!snapshot_is_fresh(stale));
    }

    static SNAPSHOT_REFRESH_COUNT: AtomicUsize = AtomicUsize::new(0);

    fn stubbed_snapshot_cache() -> CacheFile {
        let entry = CacheFileEntry::from_meta_stats(
            CacheMeta {
                mtime: 1_000.0,
                size: 10,
            },
            CacheStats {
                entries: vec![CacheEntry {
                    timestamp: "2026-03-01T10:00:00+08:00".to_string(),
                    model: "claude-sonnet-4-5".to_string(),
                    environment: None,
                    usage: CacheUsage {
                        input_tokens: 120,
                        output_tokens: 30,
                        cache_read_tokens: 0,
                        cache_creation_tokens: 0,
                        cost: 0.5,
                    },
                }],
            },
            SOURCE_CLAUDE,
        );
        CacheFile {
            version: super::USAGE_CACHE_VERSION,
            files: HashMap::from([("/tmp/fixture-session.jsonl".to_string(), entry)]),
            global_rollup: CacheRollup::default(),
            last_updated: None,
        }
    }

    fn counting_snapshot_stub() -> CacheFile {
        SNAPSHOT_REFRESH_COUNT.fetch_add(1, Ordering::SeqCst);
        stubbed_snapshot_cache()
    }

    #[test]
    fn test_shared_usage_cache_single_flight_and_command_sharing() {
        *lock_usage_snapshot() = None;
        lock_usage_stats_memo().by_source.clear();
        SNAPSHOT_REFRESH_COUNT.store(0, Ordering::SeqCst);
        *TEST_SNAPSHOT_REFRESH
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap() = Some(counting_snapshot_stub);

        // Concurrent callers: exactly one refresh runs.
        let handles: Vec<_> = (0..8)
            .map(|_| {
                thread::spawn(|| {
                    let cache = shared_usage_cache(None);
                    assert_eq!(cache.files.len(), 1);
                })
            })
            .collect();
        for handle in handles {
            handle.join().expect("single-flight worker thread");
        }
        assert_eq!(SNAPSHOT_REFRESH_COUNT.load(Ordering::SeqCst), 1);

        // Sequential callers within the TTL reuse the snapshot.
        for _ in 0..5 {
            assert_eq!(shared_usage_cache(None).files.len(), 1);
        }
        assert_eq!(SNAPSHOT_REFRESH_COUNT.load(Ordering::SeqCst), 1);

        // The command layer routes through the same single-flight snapshot:
        // back-to-back analytics commands must not trigger a second refresh.
        let history = tauri::async_runtime::block_on(super::get_usage_history(
            "day".to_string(),
            None,
            None,
            None,
        ))
        .expect("usage history from shared snapshot");
        assert_eq!(SNAPSHOT_REFRESH_COUNT.load(Ordering::SeqCst), 1);
        assert_eq!(
            history.daily.get("2026-03-01").map(|v| v.input_tokens),
            Some(120)
        );

        let breakdown = tauri::async_runtime::block_on(super::get_usage_model_breakdown(
            "day".to_string(),
            None,
        ))
        .expect("model breakdown from shared snapshot");
        assert_eq!(SNAPSHOT_REFRESH_COUNT.load(Ordering::SeqCst), 1);
        assert!(breakdown
            .values()
            .any(|models| models.contains_key("claude-sonnet-4-5")));

        // Force must bypass the TTL-fresh shared snapshot collected BEFORE
        // the request started: the analysis page Refresh button re-collects
        // even inside the 60s window. (Source filter keeps the command from
        // writing the usage summary file in tests.)
        let forced = tauri::async_runtime::block_on(super::get_usage_stats(
            Some("claude".to_string()),
            Some(true),
        ))
        .expect("forced usage stats re-collect");
        assert_eq!(SNAPSHOT_REFRESH_COUNT.load(Ordering::SeqCst), 2);
        assert!(!forced.last_updated.is_empty());

        // Non-force right after still reuses the fresh snapshot.
        let _ = tauri::async_runtime::block_on(super::get_usage_model_breakdown(
            "day".to_string(),
            None,
        ))
        .expect("non-force breakdown reuses snapshot");
        assert_eq!(SNAPSHOT_REFRESH_COUNT.load(Ordering::SeqCst), 2);

        // Concurrent force requests merge into ONE collection: every waiter
        // accepts the first snapshot collected after their shared floor.
        let concurrent_floor = Instant::now();
        let handles: Vec<_> = (0..6)
            .map(|_| {
                thread::spawn(move || {
                    let cache = shared_usage_cache(Some(concurrent_floor));
                    assert_eq!(cache.files.len(), 1);
                })
            })
            .collect();
        for handle in handles {
            handle.join().expect("concurrent force worker thread");
        }
        assert_eq!(SNAPSHOT_REFRESH_COUNT.load(Ordering::SeqCst), 3);

        // A force whose floor is NEWER than the last collection (a serial
        // follow-up refresh) collects again.
        let serial_floor = Instant::now();
        assert_eq!(shared_usage_cache(Some(serial_floor)).files.len(), 1);
        assert_eq!(SNAPSHOT_REFRESH_COUNT.load(Ordering::SeqCst), 4);

        // Plain TTL reads keep reusing without collecting.
        assert_eq!(shared_usage_cache(None).files.len(), 1);
        assert_eq!(SNAPSHOT_REFRESH_COUNT.load(Ordering::SeqCst), 4);

        *TEST_SNAPSHOT_REFRESH
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap() = None;
        lock_usage_stats_memo().by_source.clear();
        *lock_usage_snapshot() = None;
    }

    #[test]
    fn test_shadow_gate_is_enabled_in_tests() {
        assert!(ANALYTICS_SHADOW_INCREMENTAL);
    }

    #[test]
    fn test_incremental_append_only_growth_claude_and_codex() {
        let temp = tempfile::tempdir().expect("claude tempdir");
        let claude_path = temp.path().join("claude-session.jsonl");
        fs::write(
            &claude_path,
            format!(
                "{}\n{}\n{}\n",
                claude_line("2026-03-01T00:00:01.000Z", 100, 10),
                claude_line("2026-03-01T00:00:02.000Z", 200, 20),
                claude_line("2026-03-01T00:00:03.000Z", 300, 30),
            ),
        )
        .expect("write claude fixture");

        let claude = discovered_at(&claude_path, UsageSource::Claude);
        let first = refresh_round(None, &claude);
        assert_eq!(first.stats.entries.len(), 3);
        assert_eq!(first.parse_offset, meta_of(&claude_path).size);
        assert!(first.last_line_complete);
        assert_eq!(first.stats, full_stats(&claude));

        append_bytes(
            &claude_path,
            &format!(
                "{}\n{}\n",
                claude_line("2026-03-01T00:00:04.000Z", 400, 40),
                claude_line("2026-03-01T00:00:05.000Z", 500, 50),
            ),
        );
        let second = refresh_round(Some(&first), &claude);
        assert_eq!(second.stats.entries.len(), 5);
        assert_eq!(input_total(&second.stats), 1500);
        assert_eq!(second.parse_offset, meta_of(&claude_path).size);
        assert!(second.last_line_complete);
        assert_eq!(second.stats, full_stats(&claude));

        // Codex: stateful accumulator — current model + last totals must
        // survive the incremental boundary.
        let codex_path = temp.path().join("codex-session.jsonl");
        fs::write(
            &codex_path,
            format!(
                "{}\n{}\n",
                codex_context_line("gpt-5.3-codex"),
                codex_count_line("2026-03-01T00:00:01.000Z", 100, 20, 10, 5),
            ),
        )
        .expect("write codex fixture");

        let codex = discovered_at(&codex_path, UsageSource::Codex);
        let codex_first = refresh_round(None, &codex);
        assert!(codex_first.stats.entries.is_empty());
        assert_eq!(codex_first.rollup.buckets.len(), 1);
        assert_eq!(codex_first.rollup.buckets[0].usage.input_tokens, 80);
        assert_eq!(codex_first.rollup.buckets[0].usage.cache_read_tokens, 20);
        assert_eq!(codex_first.rollup.buckets[0].usage.output_tokens, 15);
        assert_eq!(codex_first.rollup.buckets[0].model, "gpt-5.3-codex");
        assert_eq!(codex_first.parse_offset, meta_of(&codex_path).size);
        let codex_state = codex_first
            .codex_state
            .as_ref()
            .expect("codex continuation state persisted");
        assert_eq!(codex_state.current_model.as_deref(), Some("gpt-5.3-codex"));
        assert!(codex_state.last_total.is_some());
        assert_eq!(codex_first.rollup, full_rollup(&codex));

        append_bytes(
            &codex_path,
            &format!(
                "{}\n",
                codex_count_line("2026-03-01T00:00:02.000Z", 150, 50, 25, 8)
            ),
        );
        let codex_second = refresh_round(Some(&codex_first), &codex);
        assert!(codex_second.stats.entries.is_empty());
        assert_eq!(codex_second.rollup.buckets.len(), 1);
        assert_eq!(codex_second.rollup.buckets[0].usage.input_tokens, 100);
        assert_eq!(codex_second.rollup.buckets[0].usage.cache_read_tokens, 50);
        assert_eq!(codex_second.rollup.buckets[0].usage.output_tokens, 33);
        assert_eq!(codex_second.rollup.buckets[0].model, "gpt-5.3-codex");
        assert_eq!(codex_second.parse_offset, meta_of(&codex_path).size);
        assert_eq!(codex_second.rollup, full_rollup(&codex));
    }

    #[test]
    fn test_incremental_interleaved_appends_and_refreshes() {
        let temp = tempfile::tempdir().expect("interleaved tempdir");
        let path = temp.path().join("interleaved.jsonl");
        fs::write(
            &path,
            format!("{}\n", claude_line("2026-03-02T00:00:01.000Z", 10, 1)),
        )
        .expect("write fixture");

        let discovered = discovered_at(&path, UsageSource::Claude);
        let mut entry = refresh_round(None, &discovered);
        assert_eq!(entry.stats, full_stats(&discovered));

        for round in 1..=4u64 {
            // A refresh with no change must be a pure cache hit.
            let unchanged = refresh_round(Some(&entry), &discovered);
            assert_eq!(unchanged, entry);

            append_bytes(
                &path,
                &format!(
                    "{}\n{}\n",
                    claude_line("2026-03-02T00:00:0{round}.000Z", round * 100, round * 10),
                    claude_line(
                        "2026-03-02T00:01:0{round}.000Z",
                        round * 100 + 1,
                        round * 10
                    ),
                ),
            );
            entry = refresh_round(Some(&entry), &discovered);
            assert_eq!(entry.stats.entries.len(), 1 + (round as usize) * 2);
            assert_eq!(entry.parse_offset, meta_of(&path).size);
            assert!(entry.last_line_complete);
            assert_eq!(
                entry.stats,
                full_stats(&discovered),
                "incremental diverged from full parse at round {round}"
            );
        }
    }

    #[test]
    fn test_incremental_re_emitted_message_id_replaces_across_append_boundary() {
        let temp = tempfile::tempdir().expect("dedup tempdir");
        let path = temp.path().join("message-id-dedup.jsonl");
        // First chunk: a partial record for msg_dup (stream in progress)
        // plus one complete unrelated message.
        fs::write(
            &path,
            format!(
                "{}\n{}\n",
                claude_message_line("2026-03-09T00:00:01.000Z", "msg_dup", 40, 4),
                claude_message_line("2026-03-09T00:00:02.000Z", "msg_other", 7, 1),
            ),
        )
        .expect("write fixture");

        let discovered = discovered_at(&path, UsageSource::Claude);
        let first = refresh_round(None, &discovered);
        assert_eq!(first.stats.entries.len(), 2);
        assert_eq!(input_total(&first.stats), 47);
        assert_eq!(first.stats, full_stats(&discovered));
        assert_eq!(
            first
                .claude_state
                .as_ref()
                .expect("claude continuation state persisted")
                .message_entry_indexes
                .len(),
            2
        );

        // Appended chunk re-emits msg_dup with its final usage snapshot: the
        // incremental path must REPLACE the earlier entry (final usage
        // wins), not append a third — the dedup map crosses the boundary.
        append_bytes(
            &path,
            &format!(
                "{}\n",
                claude_message_line("2026-03-09T00:00:03.000Z", "msg_dup", 100, 20),
            ),
        );
        let second = refresh_round(Some(&first), &discovered);
        assert_eq!(
            second.stats.entries.len(),
            2,
            "re-emitted message.id must replace its earlier entry, not append"
        );
        assert_eq!(input_total(&second.stats), 107);
        assert_eq!(second.stats.entries[0].usage.input_tokens, 100);
        assert_eq!(second.stats.entries[0].usage.output_tokens, 20);
        assert_eq!(second.stats.entries[1].usage.input_tokens, 7);
        assert_eq!(second.parse_offset, meta_of(&path).size);
        assert!(second.last_line_complete);
        // The shadow gate in `incremental_refresh_entry` already compared
        // this against a fresh full parse; assert it here too so the deduped
        // result is pinned even outside debug builds.
        assert_eq!(second.stats, full_stats(&discovered));
    }

    #[test]
    fn test_incremental_half_line_then_completion_counts_once() {
        let temp = tempfile::tempdir().expect("half-line tempdir");
        let path = temp.path().join("half-line.jsonl");
        let complete_tail = format!(
            "{}\n{}\n{}\n",
            claude_line("2026-03-03T00:00:01.000Z", 100, 10),
            claude_line("2026-03-03T00:00:02.000Z", 200, 20),
            claude_line("2026-03-03T00:00:03.000Z", 300, 30),
        );
        fs::write(&path, &complete_tail).expect("write fixture");

        let discovered = discovered_at(&path, UsageSource::Claude);
        let first = refresh_round(None, &discovered);
        assert_eq!(first.stats.entries.len(), 3);
        assert!(first.last_line_complete);
        assert_eq!(first.parse_offset, complete_tail.len() as u64);

        // Append an unterminated partial line (invalid JSON prefix): split a
        // real line in half so completing it later yields exactly one valid
        // JSON line. `claude_line` output is pure ASCII, so byte slicing is
        // character-safe.
        let full_line = claude_line("2026-03-03T00:00:04.000Z", 400, 40);
        let (partial, rest) = full_line.split_at(full_line.len() / 2);
        append_bytes(&path, partial);
        let mid = refresh_round(Some(&first), &discovered);
        assert_eq!(
            mid.stats.entries.len(),
            3,
            "partial line must not be counted"
        );
        assert!(!mid.last_line_complete);
        assert_eq!(mid.parse_offset, complete_tail.len() as u64);
        assert_eq!(mid.meta.size, meta_of(&path).size);

        // Complete the line: it must be consumed exactly once.
        append_bytes(&path, rest);
        append_bytes(&path, "\n");
        let done = refresh_round(Some(&mid), &discovered);
        assert_eq!(
            done.stats.entries.len(),
            4,
            "completed line counted exactly once"
        );
        assert_eq!(done.stats.entries[3].usage.input_tokens, 400);
        assert!(done.last_line_complete);
        assert_eq!(done.parse_offset, meta_of(&path).size);
        assert_eq!(done.stats, full_stats(&discovered));
    }

    #[test]
    fn test_incremental_truncation_falls_back_to_full_reparse() {
        let temp = tempfile::tempdir().expect("truncate tempdir");
        let path = temp.path().join("truncated.jsonl");
        fs::write(
            &path,
            format!(
                "{}\n{}\n{}\n",
                claude_line("2026-03-04T00:00:01.000Z", 100, 10),
                claude_line("2026-03-04T00:00:02.000Z", 200, 20),
                claude_line("2026-03-04T00:00:03.000Z", 300, 30),
            ),
        )
        .expect("write fixture");

        let discovered = discovered_at(&path, UsageSource::Claude);
        let first = refresh_round(None, &discovered);
        assert_eq!(first.stats.entries.len(), 3);

        // Truncate: rewrite with a single shorter line.
        let shrunk = format!("{}\n", claude_line("2026-03-04T00:00:01.000Z", 100, 10));
        fs::write(&path, &shrunk).expect("truncate fixture");

        let second = refresh_round(Some(&first), &discovered);
        assert_eq!(
            second.stats.entries.len(),
            1,
            "truncation resets to full re-parse"
        );
        assert_eq!(second.parse_offset, shrunk.len() as u64);
        assert!(second.last_line_complete);
        assert_eq!(second.stats, full_stats(&discovered));
    }

    #[test]
    fn test_incremental_same_size_rewrite_falls_back_to_full_reparse() {
        let temp = tempfile::tempdir().expect("rewrite tempdir");
        let path = temp.path().join("rewritten.jsonl");
        let original = format!(
            "{}\n{}\n{}\n",
            claude_line("2026-03-05T00:00:01.000Z", 100, 10),
            claude_line("2026-03-05T00:00:02.000Z", 200, 20),
            claude_line("2026-03-05T00:00:03.000Z", 300, 30),
        );
        fs::write(&path, &original).expect("write fixture");

        let discovered = discovered_at(&path, UsageSource::Claude);
        let first = refresh_round(None, &discovered);
        assert_eq!(input_total(&first.stats), 600);

        // Same-size rewrite: line 2 tokens 200 -> 999 (identical byte
        // length). Sleep past the 1 ms mtime tolerance so the meta check
        // cannot mistake this for an unchanged file.
        thread::sleep(Duration::from_millis(15));
        let rewritten = original.replace(r#""input_tokens":200"#, r#""input_tokens":999"#);
        assert_eq!(
            rewritten.len(),
            original.len(),
            "fixture must stay same-size"
        );
        fs::write(&path, &rewritten).expect("rewrite fixture");

        let second = refresh_round(Some(&first), &discovered);
        assert_eq!(
            input_total(&second.stats),
            1399,
            "same-size rewrite must re-parse fully"
        );
        assert_eq!(second.parse_offset, rewritten.len() as u64);
        assert_eq!(second.stats, full_stats(&discovered));
    }

    #[test]
    fn test_incremental_larger_rewrite_falls_back_to_full_reparse() {
        let temp = tempfile::tempdir().expect("larger rewrite tempdir");
        let path = temp.path().join("larger-rewrite.jsonl");
        let original = format!("{}\n", claude_line("2026-03-05T00:00:01.000Z", 100, 10));
        fs::write(&path, &original).expect("write original fixture");

        let discovered = discovered_at(&path, UsageSource::Claude);
        let first = refresh_round(None, &discovered);
        assert_eq!(input_total(&first.stats), 100);

        // Rewrite the consumed prefix with the same byte length, then append
        // another valid line. Size/mtime/newline checks alone misclassify this
        // as append-only growth and retain the stale 100-token contribution.
        thread::sleep(Duration::from_millis(15));
        let rewritten_prefix = original.replace(r#""input_tokens":100"#, r#""input_tokens":900"#);
        assert_eq!(rewritten_prefix.len(), original.len());
        let rewritten = format!(
            "{}{}\n",
            rewritten_prefix,
            claude_line("2026-03-05T00:00:02.000Z", 50, 5)
        );
        fs::write(&path, &rewritten).expect("write larger replacement fixture");

        let second = refresh_round(Some(&first), &discovered);
        assert_eq!(input_total(&second.stats), 950);
        assert_eq!(second.stats, full_stats(&discovered));
    }

    #[test]
    fn test_incremental_older_mtime_falls_back_to_full_reparse() {
        let temp = tempfile::tempdir().expect("rotation tempdir");
        let path = temp.path().join("rotated.jsonl");
        fs::write(
            &path,
            format!(
                "{}\n{}\n",
                claude_line("2026-03-06T00:00:01.000Z", 100, 10),
                claude_line("2026-03-06T00:00:02.000Z", 200, 20),
            ),
        )
        .expect("write fixture");

        let discovered = discovered_at(&path, UsageSource::Claude);
        let first = refresh_round(None, &discovered);
        assert_eq!(first.stats.entries.len(), 2);

        // Simulate rotation to an "older" file: the cached entry claims a
        // future mtime and stale stats. If the incremental path ran from
        // offset 0 it would extend the poisoned stats; the guard must force
        // a full re-parse instead.
        let mut poisoned = first.clone();
        poisoned.meta.mtime += 10_000.0;
        poisoned.parse_offset = 0;
        poisoned.stats.entries.push(CacheEntry {
            timestamp: "1970-01-01T00:00:00.000Z".to_string(),
            model: "poison".to_string(),
            environment: None,
            usage: CacheUsage::default(),
        });

        let second = refresh_round(Some(&poisoned), &discovered);
        assert_eq!(
            second.stats.entries.len(),
            2,
            "rotation guard must discard poisoned stats"
        );
        assert!(!second
            .stats
            .entries
            .iter()
            .any(|entry| entry.model == "poison"));
        assert_eq!(second.stats, full_stats(&discovered));
    }

    #[test]
    fn test_usage_cache_version_guard_migrates_v5_v6_and_discards_older_versions() {
        let temp = tempfile::tempdir().expect("version tempdir");
        let cache_path = temp.path().join("usage-cache.json");

        let entry = CacheFileEntry {
            meta: CacheMeta {
                mtime: 1_000.0,
                size: 42,
            },
            stats: CacheStats {
                entries: vec![CacheEntry {
                    timestamp: "2026-03-07T00:00:00.000Z".to_string(),
                    model: "claude-sonnet-4-5".to_string(),
                    environment: None,
                    usage: CacheUsage::default(),
                }],
            },
            rollup: CacheRollup::default(),
            parse_offset: 42,
            last_line_complete: false,
            codex_state: Some(CodexParseState {
                current_model: Some("gpt-5.3-codex".to_string()),
                last_total: None,
            }),
            claude_state: Some(ClaudeParseState {
                message_entry_indexes: HashMap::from([("msg_roundtrip".to_string(), 3)]),
            }),
            append_anchor: None,
            revision: None,
        };

        let v6 = CacheFile {
            version: 6,
            files: HashMap::from([("legacy.jsonl".to_string(), entry.clone())]),
            global_rollup: CacheRollup::default(),
            last_updated: None,
        };
        write_json_atomic(&cache_path, &v6).expect("write v6 cache");
        let migrated = read_usage_cache_at(&cache_path);
        assert_eq!(migrated.version, super::USAGE_CACHE_VERSION);
        assert!(
            migrated.files.contains_key("legacy.jsonl"),
            "v6 entries must survive the compact v7 migration"
        );

        let v5 = CacheFile {
            version: 5,
            files: HashMap::from([("stale.jsonl".to_string(), entry.clone())]),
            global_rollup: CacheRollup::default(),
            last_updated: None,
        };
        write_json_atomic(&cache_path, &v5).expect("write v5 cache");
        assert_eq!(
            read_usage_cache_at(&cache_path).version,
            USAGE_CACHE_VERSION
        );

        // Older schemas are not known to be compatible and still fail closed.
        let stale = CacheFile {
            version: 4,
            files: HashMap::from([("stale.jsonl".to_string(), entry.clone())]),
            global_rollup: CacheRollup::default(),
            last_updated: None,
        };
        write_json_atomic(&cache_path, &stale).expect("write stale cache");
        assert!(read_usage_cache_at(&cache_path).files.is_empty());

        // A current-version cache round-trips the parse continuation state.
        let current = CacheFile {
            version: super::USAGE_CACHE_VERSION,
            files: HashMap::from([("current.jsonl".to_string(), entry)]),
            global_rollup: CacheRollup::default(),
            last_updated: None,
        };
        write_json_atomic(&cache_path, &current).expect("write current cache");
        let parsed = read_usage_cache_at(&cache_path);
        let round_tripped = parsed
            .files
            .get("current.jsonl")
            .expect("current cache entry");
        assert_eq!(round_tripped.parse_offset, 42);
        assert!(!round_tripped.last_line_complete);
        assert_eq!(
            round_tripped
                .codex_state
                .as_ref()
                .and_then(|state| state.current_model.as_deref()),
            Some("gpt-5.3-codex")
        );
        assert_eq!(
            round_tripped
                .claude_state
                .as_ref()
                .and_then(|state| state.message_entry_indexes.get("msg_roundtrip").copied()),
            Some(3),
            "claude message-id dedup map must round-trip through the cache"
        );
    }

    #[test]
    fn v6_migration_compacts_codex_rows_without_changing_analytics() {
        let temp = tempfile::tempdir().expect("v6 migration tempdir");
        let cache_path = temp.path().join("usage-cache.json");
        let legacy = serde_json::json!({
            "version": 6,
            "files": {
                "/tmp/.codex/sessions/2026/03/06/session.jsonl": {
                    "meta": { "mtime": 1000.0, "size": 2048 },
                    "stats": {
                        "entries": [
                            {
                                "timestamp": "2026-03-06T10:15:00+08:00",
                                "model": "gpt-5.4",
                                "environment": "Local Codex",
                                "usage": {
                                    "inputTokens": 100,
                                    "outputTokens": 20,
                                    "cacheReadTokens": 30,
                                    "cacheCreationTokens": 0,
                                    "cost": 0.5
                                }
                            },
                            {
                                "timestamp": "2026-03-06T10:45:00+08:00",
                                "model": "gpt-5.4",
                                "environment": "Local Codex",
                                "usage": {
                                    "inputTokens": 50,
                                    "outputTokens": 10,
                                    "cacheReadTokens": 5,
                                    "cacheCreationTokens": 0,
                                    "cost": 0.25
                                }
                            }
                        ]
                    },
                    "parseOffset": 2048,
                    "lastLineComplete": true,
                    "codexState": { "currentModel": "gpt-5.4" }
                }
            },
            "lastUpdated": "2026-03-06T11:00:00+08:00"
        });
        fs::write(
            &cache_path,
            serde_json::to_vec(&legacy).expect("serialize legacy fixture"),
        )
        .expect("write legacy fixture");

        let migrated = read_usage_cache_at(&cache_path);
        let persisted_shape = serde_json::to_value(&migrated).expect("serialize migrated cache");
        let file_shape = &persisted_shape["files"]["/tmp/.codex/sessions/2026/03/06/session.jsonl"];

        assert_eq!(persisted_shape["version"], 7);
        assert!(
            file_shape["stats"].get("entries").is_none(),
            "v7 must not retain compactable Codex usage rows"
        );
        assert_eq!(
            file_shape["rollup"]["buckets"].as_array().map(Vec::len),
            Some(1)
        );

        let stats = aggregate_cache(&migrated, Some(SOURCE_CODEX), &default_prices());
        assert_eq!(stats.total.input_tokens, 150);
        assert_eq!(stats.total.output_tokens, 30);
        assert_eq!(stats.total.cache_read_tokens, 35);
        assert!((stats.total.cost - 0.75).abs() < 1e-9);
        assert_eq!(stats.daily_history["2026-03-06"].input_tokens, 150);
        assert_eq!(stats.hourly_history["2026-03-06T10"].input_tokens, 150);
        assert_eq!(stats.by_model["gpt-5.4"].input_tokens, 150);
        assert_eq!(stats.by_environment["Local Codex"].input_tokens, 150);
    }

    #[test]
    fn current_v7_compact_cache_serves_views_without_raw_entries() {
        let temp = tempfile::tempdir().expect("v7 compact tempdir");
        let cache_path = temp.path().join("usage-cache-desktop.json");
        let today = Local::now().date_naive();
        let yesterday = today - chrono::Duration::days(1);
        let today_key = today.format("%Y-%m-%d").to_string();
        let yesterday_key = yesterday.format("%Y-%m-%d").to_string();
        let today_hour = format!("{today_key}T09");
        let compact = serde_json::json!({
            "version": 7,
            "files": {
                "/tmp/.codex/sessions/session.jsonl": {
                    "meta": { "mtime": 1000.0, "size": 2048 },
                    "stats": {},
                    "rollup": {
                        "buckets": [
                            {
                                "source": "codex",
                                "date": today_key,
                                "hour": today_hour,
                                "model": "gpt-5.4",
                                "environment": "Local Codex",
                                "usage": {
                                    "inputTokens": 120,
                                    "outputTokens": 30,
                                    "cacheReadTokens": 10,
                                    "cacheCreationTokens": 0,
                                    "cost": 0.6
                                },
                                "entryCount": 2
                            },
                            {
                                "source": "codex",
                                "date": yesterday_key,
                                "hour": null,
                                "model": "gpt-5.4",
                                "environment": null,
                                "usage": {
                                    "inputTokens": 0,
                                    "outputTokens": 0,
                                    "cacheReadTokens": 0,
                                    "cacheCreationTokens": 0,
                                    "cost": 0.0
                                },
                                "entryCount": 1
                            }
                        ]
                    },
                    "parseOffset": 2048,
                    "lastLineComplete": true,
                    "codexState": { "currentModel": "gpt-5.4" }
                }
            },
            "globalRollup": {
                "buckets": [
                    {
                        "source": "codex",
                        "date": today_key,
                        "hour": today_hour,
                        "model": "gpt-5.4",
                        "environment": "Local Codex",
                        "usage": {
                            "inputTokens": 120,
                            "outputTokens": 30,
                            "cacheReadTokens": 10,
                            "cacheCreationTokens": 0,
                            "cost": 0.6
                        },
                        "entryCount": 2
                    },
                    {
                        "source": "codex",
                        "date": yesterday_key,
                        "hour": null,
                        "model": "gpt-5.4",
                        "environment": null,
                        "usage": {
                            "inputTokens": 0,
                            "outputTokens": 0,
                            "cacheReadTokens": 0,
                            "cacheCreationTokens": 0,
                            "cost": 0.0
                        },
                        "entryCount": 1
                    }
                ]
            }
        });
        fs::write(
            &cache_path,
            serde_json::to_vec(&compact).expect("serialize compact fixture"),
        )
        .expect("write compact fixture");

        let cache = read_usage_cache_at(&cache_path);
        assert!(cache
            .files
            .values()
            .all(|entry| entry.stats.entries.is_empty()));

        let stats = aggregate_cache(&cache, Some(SOURCE_CODEX), &default_prices());
        assert_eq!(stats.total.input_tokens, 120);
        assert_eq!(stats.daily_history[&today_key].input_tokens, 120);
        assert!(stats.daily_history.contains_key(&yesterday_key));
        assert_eq!(calculate_streak(&stats.daily_history), 2);

        let breakdown = aggregate_model_breakdown(
            &cache,
            Some(SOURCE_CODEX),
            ModelBreakdownGranularity::Day,
            Local::now(),
            &default_prices(),
        );
        assert_eq!(breakdown[&today_key]["gpt-5.4"].input_tokens, 120);
    }

    #[test]
    fn desktop_usage_cache_has_an_independent_filename() {
        assert_eq!(
            usage_cache_path()
                .file_name()
                .and_then(|name| name.to_str()),
            Some("usage-cache-desktop.json")
        );
    }

    #[test]
    fn legacy_import_is_written_once_even_when_sources_are_unchanged() {
        let files = HashMap::from([(
            "/tmp/.codex/sessions/session.jsonl".to_string(),
            CacheFileEntry {
                rollup: CacheRollup {
                    buckets: vec![CacheRollupBucket {
                        source: SOURCE_CODEX.to_string(),
                        model: "gpt-5.4".to_string(),
                        entry_count: 1,
                        ..Default::default()
                    }],
                },
                ..Default::default()
            },
        )]);
        let cache = CacheFile {
            version: USAGE_CACHE_VERSION,
            global_rollup: CacheRollup::from_file_entries(&files),
            files,
            last_updated: None,
        };

        assert!(should_write_usage_cache(false, &cache, &cache));
        assert!(!should_write_usage_cache(true, &cache, &cache));
    }

    #[test]
    fn unchanged_opencode_session_reuses_its_compact_rollup() {
        let session = crate::opencode::LocalOpenCodeSession {
            id: "oc-1".to_string(),
            title: "fixture".to_string(),
            updated_at: 1234,
            created_at: 1200,
            project: None,
            env_name: Some("OpenCode Native".to_string()),
            config_source: Some("native".to_string()),
            prompt_tokens: 999,
            completion_tokens: 111,
            cost: 0.42,
            model: Some("fixture-model".to_string()),
        };
        let stats = CacheStats {
            entries: vec![CacheEntry {
                timestamp: "2026-03-06T10:00:00+08:00".to_string(),
                model: "fixture-model".to_string(),
                environment: Some("OpenCode Native".to_string()),
                usage: CacheUsage {
                    input_tokens: 999,
                    output_tokens: 111,
                    cost: 0.42,
                    ..Default::default()
                },
            }],
        };
        let cached = CacheFileEntry {
            meta: CacheMeta {
                mtime: 1234.0,
                size: 0,
            },
            rollup: CacheRollup::from_entries(SOURCE_OPENCODE, &stats.entries),
            ..Default::default()
        };
        let existing = CacheFile {
            version: USAGE_CACHE_VERSION,
            files: HashMap::from([("opencode://session/oc-1".to_string(), cached.clone())]),
            global_rollup: cached.rollup.clone(),
            last_updated: None,
        };

        let refreshed = build_local_opencode_cache_entries(
            &HashMap::from([("oc-1".to_string(), session)]),
            &existing,
        );

        assert_eq!(refreshed["opencode://session/oc-1"].rollup, cached.rollup);
    }

    #[test]
    fn incomplete_source_load_retains_cached_rollups_until_authoritative_success() {
        let cached = CacheFileEntry {
            rollup: CacheRollup {
                buckets: vec![CacheRollupBucket {
                    source: SOURCE_DSH.to_string(),
                    model: "deepseek-v4".to_string(),
                    entry_count: 1,
                    ..Default::default()
                }],
            },
            revision: Some("rev-1".to_string()),
            ..Default::default()
        };
        let existing = CacheFile {
            version: USAGE_CACHE_VERSION,
            files: HashMap::from([("dsh://source/session-1".to_string(), cached.clone())]),
            global_rollup: cached.rollup.clone(),
            last_updated: None,
        };

        let mut transient_failure = HashMap::new();
        retain_incomplete_source_entries(&existing, SOURCE_DSH, &mut transient_failure, false);
        assert_eq!(
            transient_failure["dsh://source/session-1"].rollup, cached.rollup,
            "a failed enumeration must not masquerade as an authoritative deletion"
        );

        let mut authoritative_empty = HashMap::new();
        retain_incomplete_source_entries(&existing, SOURCE_DSH, &mut authoritative_empty, true);
        assert!(
            authoritative_empty.is_empty(),
            "a successful empty enumeration must still delete stale sessions"
        );
    }

    #[test]
    fn global_rollup_replaces_changed_files_and_removes_deleted_files() {
        let entry = |path: &str, timestamp: &str, model: &str, tokens: u64| {
            let stats = CacheStats {
                entries: vec![CacheEntry {
                    timestamp: timestamp.to_string(),
                    model: model.to_string(),
                    environment: Some(format!("env-{model}")),
                    usage: CacheUsage {
                        input_tokens: tokens,
                        ..Default::default()
                    },
                }],
            };
            (
                path.to_string(),
                CacheFileEntry {
                    rollup: CacheRollup::from_entries(SOURCE_CODEX, &stats.entries),
                    stats: CacheStats::default(),
                    ..Default::default()
                },
            )
        };

        let old_files = HashMap::from([
            entry("a", "2026-03-05T10:00:00+08:00", "old-model", 10),
            entry("b", "2026-03-05T11:00:00+08:00", "deleted-model", 0),
            entry("unchanged", "2026-03-05T12:00:00+08:00", "same-model", 5),
        ]);
        let existing = CacheFile {
            version: USAGE_CACHE_VERSION,
            global_rollup: CacheRollup::from_file_entries(&old_files),
            files: old_files.clone(),
            last_updated: None,
        };
        let new_files = HashMap::from([
            entry("a", "2026-03-06T09:00:00+08:00", "new-model", 25),
            old_files
                .get_key_value("unchanged")
                .map(|(path, value)| (path.clone(), value.clone()))
                .expect("unchanged fixture"),
        ]);

        let (rollup, bucket_mutations) = update_global_rollup(&existing, &new_files);
        let updated = CacheFile {
            version: USAGE_CACHE_VERSION,
            files: new_files,
            global_rollup: rollup,
            last_updated: None,
        };
        let stats = aggregate_cache(&updated, Some(SOURCE_CODEX), &default_prices());

        assert_eq!(
            bucket_mutations, 3,
            "unchanged file buckets must not be revisited"
        );
        assert_eq!(stats.total.input_tokens, 30);
        assert!(
            !stats.daily_history.contains_key("2026-03-05")
                || stats.daily_history["2026-03-05"].input_tokens == 5
        );
        assert_eq!(stats.daily_history["2026-03-06"].input_tokens, 25);
        assert!(!stats.by_model.contains_key("old-model"));
        assert!(!stats.by_model.contains_key("deleted-model"));
        assert_eq!(stats.by_model["new-model"].input_tokens, 25);
        assert_eq!(stats.by_model["same-model"].input_tokens, 5);
    }

    #[test]
    fn test_full_parse_matches_reader_semantics_for_terminated_files() {
        let temp = tempfile::tempdir().expect("reader parity tempdir");
        let prices = default_prices();

        let claude_path = temp.path().join("claude.jsonl");
        let claude_content = format!(
            "{}\n{}\n",
            claude_line("2026-03-08T00:00:01.000Z", 100, 10),
            claude_line("2026-03-08T00:00:02.000Z", 200, 20),
        );
        fs::write(&claude_path, &claude_content).expect("write claude fixture");
        let byte_core = full_parse_jsonl(
            UsageSource::Claude,
            &claude_path,
            meta_of(&claude_path),
            &prices,
        )
        .stats;
        let reader = parse_claude_jsonl_reader(BufReader::new(claude_content.as_bytes()), &prices);
        assert_eq!(byte_core, reader);

        let codex_path = temp.path().join("codex.jsonl");
        let codex_content = format!(
            "{}\n{}\n",
            codex_context_line("gpt-5.3-codex"),
            codex_count_line("2026-03-08T00:00:01.000Z", 100, 20, 10, 5),
        );
        fs::write(&codex_path, &codex_content).expect("write codex fixture");
        let codex_byte_core = full_parse_jsonl(
            UsageSource::Codex,
            &codex_path,
            meta_of(&codex_path),
            &prices,
        );
        let codex_reader =
            parse_codex_jsonl_reader(BufReader::new(codex_content.as_bytes()), &prices);
        assert!(codex_byte_core.stats.entries.is_empty());
        assert_eq!(
            codex_byte_core.rollup,
            CacheRollup::from_entries(SOURCE_CODEX, &codex_reader.entries)
        );
    }

    // ── Phase 3: DSH Analytics Tests ───────────────────────────────────────────

    #[test]
    fn test_dsh_source_detection_from_virtual_key() {
        // dsh:// virtual keys should resolve to SOURCE_DSH
        let source = detect_source_from_path("dsh://instance123/session456");
        assert_eq!(source, Some(SOURCE_DSH));
    }

    #[test]
    fn test_dsh_normalize_usage_source() {
        assert_eq!(normalize_usage_source(Some("dsh")), Ok(Some(SOURCE_DSH)));
    }

    #[test]
    fn test_unpriced_tokens_propagation_via_add() {
        let mut a = TokenUsageWithCost {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_tokens: 10,
            cache_creation_tokens: 5,
            cost: 0.5,
            unpriced_tokens: 0,
            cost_incomplete: false,
        };
        let b = TokenUsageWithCost {
            input_tokens: 200,
            output_tokens: 100,
            cache_read_tokens: 20,
            cache_creation_tokens: 10,
            cost: 0.0,
            unpriced_tokens: 330,
            cost_incomplete: true,
        };
        a.add(&b);
        assert_eq!(a.input_tokens, 300);
        assert_eq!(a.output_tokens, 150);
        assert!((a.cost - 0.5).abs() < 0.001);
        assert_eq!(a.unpriced_tokens, 330);
        assert!(a.cost_incomplete);
    }

    #[test]
    fn test_unpriced_tokens_both_incomplete() {
        let mut a = TokenUsageWithCost {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            cost: 0.0,
            unpriced_tokens: 150,
            cost_incomplete: true,
        };
        let b = TokenUsageWithCost {
            input_tokens: 200,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            cost: 0.0,
            unpriced_tokens: 200,
            cost_incomplete: true,
        };
        a.add(&b);
        assert_eq!(a.unpriced_tokens, 350);
        assert!(a.cost_incomplete);
    }

    #[test]
    fn test_unpriced_tokens_mixed_pricing_in_aggregate() {
        // Build a CacheFile with one priced and one unpriced entry
        let mut files = HashMap::new();
        files.insert(
            "dsh://inst1/sess1".to_string(),
            CacheFileEntry {
                meta: CacheMeta {
                    mtime: 1.0,
                    size: 10,
                },
                stats: CacheStats {
                    entries: vec![
                        CacheEntry {
                            timestamp: "2026-08-20T10:00:00.000Z".to_string(),
                            model: "claude-sonnet-4-5".to_string(),
                            environment: Some("official".to_string()),
                            usage: CacheUsage {
                                input_tokens: 1000,
                                output_tokens: 500,
                                cache_read_tokens: 100,
                                cache_creation_tokens: 50,
                                cost: 0.02,
                            },
                        },
                        CacheEntry {
                            timestamp: "2026-08-20T11:00:00.000Z".to_string(),
                            model: "unknown-model".to_string(),
                            environment: Some("dsh".to_string()),
                            usage: CacheUsage {
                                input_tokens: 2000,
                                output_tokens: 1000,
                                cache_read_tokens: 200,
                                cache_creation_tokens: 100,
                                cost: 0.0,
                            },
                        },
                    ],
                },
                rollup: CacheRollup::default(),
                parse_offset: 0,
                last_line_complete: true,
                codex_state: None,
                claude_state: None,
                append_anchor: None,
                revision: None,
            },
        );
        let cache = CacheFile {
            version: USAGE_CACHE_VERSION,
            files,
            global_rollup: CacheRollup::default(),
            last_updated: None,
        };
        let stats = aggregate_cache(&cache, None, &default_prices());
        // Total should include all tokens
        assert_eq!(stats.total.input_tokens, 3000);
        assert_eq!(stats.total.output_tokens, 1500);
        // Cost should only be from priced entry
        assert!((stats.total.cost - 0.02).abs() < 0.001);
        // Unpriced tokens from the zero-cost entry
        assert_eq!(stats.total.unpriced_tokens, 3300); // 2000+1000+200+100
        assert!(stats.total.cost_incomplete);
    }

    #[test]
    fn test_aggregate_cache_resolves_repeated_model_price_once() {
        let repeated_entry = CacheEntry {
            timestamp: "2026-08-20T10:00:00.000Z".to_string(),
            model: "unknown-model".to_string(),
            environment: Some("dsh".to_string()),
            usage: CacheUsage {
                input_tokens: 1,
                ..Default::default()
            },
        };
        let cache = CacheFile {
            version: USAGE_CACHE_VERSION,
            files: HashMap::from([(
                "dsh://inst1/sess1".to_string(),
                CacheFileEntry {
                    stats: CacheStats {
                        entries: vec![repeated_entry; 128],
                    },
                    ..Default::default()
                },
            )]),
            global_rollup: CacheRollup::default(),
            last_updated: None,
        };

        reset_model_price_lookup_count();
        let stats = aggregate_cache(&cache, None, &default_prices());

        assert_eq!(stats.total.input_tokens, 128);
        assert_eq!(model_price_lookup_count(), 1);
    }

    #[test]
    fn test_model_breakdown_resolves_repeated_model_price_once() {
        let repeated_entry = CacheEntry {
            timestamp: "2026-08-20T10:00:00.000Z".to_string(),
            model: "unknown-model".to_string(),
            environment: Some("dsh".to_string()),
            usage: CacheUsage {
                input_tokens: 1,
                ..Default::default()
            },
        };
        let cache = CacheFile {
            version: USAGE_CACHE_VERSION,
            files: HashMap::from([(
                "dsh://inst1/sess1".to_string(),
                CacheFileEntry {
                    stats: CacheStats {
                        entries: vec![repeated_entry; 128],
                    },
                    ..Default::default()
                },
            )]),
            global_rollup: CacheRollup::default(),
            last_updated: None,
        };

        reset_model_price_lookup_count();
        let breakdown = aggregate_model_breakdown(
            &cache,
            None,
            ModelBreakdownGranularity::Day,
            fixed_now(),
            &default_prices(),
        );

        assert_eq!(breakdown["2026-08-20"]["unknown-model"].input_tokens, 128);
        assert_eq!(model_price_lookup_count(), 1);
    }

    #[test]
    fn test_fully_priced_has_no_unpriced_tokens() {
        let mut files = HashMap::new();
        files.insert(
            "dsh://inst1/sess1".to_string(),
            CacheFileEntry {
                meta: CacheMeta {
                    mtime: 1.0,
                    size: 10,
                },
                stats: CacheStats {
                    entries: vec![CacheEntry {
                        timestamp: "2026-08-20T10:00:00.000Z".to_string(),
                        model: "claude-sonnet-4-5".to_string(),
                        environment: Some("official".to_string()),
                        usage: CacheUsage {
                            input_tokens: 1000,
                            output_tokens: 500,
                            cache_read_tokens: 100,
                            cache_creation_tokens: 50,
                            cost: 0.02,
                        },
                    }],
                },
                rollup: CacheRollup::default(),
                parse_offset: 0,
                last_line_complete: true,
                codex_state: None,
                claude_state: None,
                append_anchor: None,
                revision: None,
            },
        );
        let cache = CacheFile {
            version: USAGE_CACHE_VERSION,
            files,
            global_rollup: CacheRollup::default(),
            last_updated: None,
        };
        let stats = aggregate_cache(&cache, None, &default_prices());
        assert_eq!(stats.total.unpriced_tokens, 0);
        assert!(!stats.total.cost_incomplete);
    }

    #[test]
    fn test_dsh_provider_to_environment_mapping() {
        assert_eq!(
            dsh_provider_to_environment(Some("anthropic")),
            Some("anthropic".to_string())
        );
        assert_eq!(
            dsh_provider_to_environment(Some("Anthropic")),
            Some("Anthropic".to_string())
        );
        assert_eq!(
            dsh_provider_to_environment(Some("openai")),
            Some("openai".to_string())
        );
        assert_eq!(
            dsh_provider_to_environment(Some("DeepSeek-chat")),
            Some("DeepSeek".to_string())
        );
        assert_eq!(
            dsh_provider_to_environment(Some("some-custom")),
            Some("some-custom".to_string())
        );
        assert_eq!(dsh_provider_to_environment(None), None);
        assert_eq!(dsh_provider_to_environment(Some("")), None);
    }

    #[test]
    fn test_usage_cache_version_is_7() {
        assert_eq!(USAGE_CACHE_VERSION, 7);
    }

    #[test]
    fn test_usage_summary_version_is_2() {
        assert_eq!(USAGE_SUMMARY_VERSION, 2);
    }

    #[test]
    fn test_dsh_cache_entry_revision_reuse() {
        // CacheFileEntry with a revision should preserve it through serialization
        let entry = CacheFileEntry {
            meta: CacheMeta {
                mtime: 1.0,
                size: 10,
            },
            stats: CacheStats { entries: vec![] },
            rollup: CacheRollup::default(),
            parse_offset: 0,
            last_line_complete: true,
            codex_state: None,
            claude_state: None,
            append_anchor: None,
            revision: Some("rev_abc123".to_string()),
        };
        let json = serde_json::to_string(&entry).expect("serialize");
        let deser: CacheFileEntry = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(deser.revision, Some("rev_abc123".to_string()));
    }

    #[test]
    fn test_dsh_cache_entry_revision_none_round_trip() {
        let entry = CacheFileEntry {
            meta: CacheMeta {
                mtime: 1.0,
                size: 10,
            },
            stats: CacheStats { entries: vec![] },
            rollup: CacheRollup::default(),
            parse_offset: 0,
            last_line_complete: true,
            codex_state: None,
            claude_state: None,
            append_anchor: None,
            revision: None,
        };
        let json = serde_json::to_string(&entry).expect("serialize");
        let deser: CacheFileEntry = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(deser.revision, None);
    }

    #[test]
    fn test_dsh_source_filter_excludes_non_dsh() {
        let mut files = HashMap::new();
        // Legacy claude entry
        files.insert(
            "/home/user/.claude/projects/foo/usage.jsonl".to_string(),
            CacheFileEntry {
                meta: CacheMeta {
                    mtime: 1.0,
                    size: 10,
                },
                stats: CacheStats {
                    entries: vec![CacheEntry {
                        timestamp: "2026-08-20T10:00:00.000Z".to_string(),
                        model: "claude-sonnet-4-5".to_string(),
                        environment: Some("official".to_string()),
                        usage: CacheUsage {
                            input_tokens: 5000,
                            output_tokens: 2000,
                            cache_read_tokens: 0,
                            cache_creation_tokens: 0,
                            cost: 0.10,
                        },
                    }],
                },
                rollup: CacheRollup::default(),
                parse_offset: 0,
                last_line_complete: true,
                codex_state: None,
                claude_state: None,
                append_anchor: None,
                revision: None,
            },
        );
        // DSH entry
        files.insert(
            "dsh://inst1/sess1".to_string(),
            CacheFileEntry {
                meta: CacheMeta {
                    mtime: 1.0,
                    size: 10,
                },
                stats: CacheStats {
                    entries: vec![CacheEntry {
                        timestamp: "2026-08-20T11:00:00.000Z".to_string(),
                        model: "claude-sonnet-4-5".to_string(),
                        environment: Some("official".to_string()),
                        usage: CacheUsage {
                            input_tokens: 3000,
                            output_tokens: 1000,
                            cache_read_tokens: 0,
                            cache_creation_tokens: 0,
                            cost: 0.05,
                        },
                    }],
                },
                rollup: CacheRollup::default(),
                parse_offset: 0,
                last_line_complete: true,
                codex_state: None,
                claude_state: None,
                append_anchor: None,
                revision: None,
            },
        );
        let cache = CacheFile {
            version: USAGE_CACHE_VERSION,
            files,
            global_rollup: CacheRollup::default(),
            last_updated: None,
        };

        // Filter by DSH: only DSH entry
        let dsh_stats = aggregate_cache(&cache, Some(SOURCE_DSH), &default_prices());
        assert_eq!(dsh_stats.total.input_tokens, 3000);
        assert!((dsh_stats.total.cost - 0.05).abs() < 0.001);

        // No filter (all): both entries
        let all_stats = aggregate_cache(&cache, None, &default_prices());
        assert_eq!(all_stats.total.input_tokens, 8000);
        assert!((all_stats.total.cost - 0.15).abs() < 0.001);

        // DSH == All minus legacy baseline
        assert_eq!(
            all_stats.total.input_tokens - dsh_stats.total.input_tokens,
            5000
        );
    }

    #[test]
    fn test_category_aware_pricing_partial_rate_gap() {
        // A model with input/output rates but no cache_read/cache_creation rates:
        // only cache tokens should be unpriced, and costIncomplete should be set.
        let mut custom_prices = HashMap::new();
        custom_prices.insert(
            "partial-model".to_string(),
            ModelPrice {
                input_cost_per_token: 1e-6,
                output_cost_per_token: 2e-6,
                cache_read_input_token_cost: None,
                cache_creation_input_token_cost: None,
            },
        );

        let mut files = HashMap::new();
        files.insert(
            "dsh://inst1/sess1".to_string(),
            CacheFileEntry {
                meta: CacheMeta {
                    mtime: 1.0,
                    size: 10,
                },
                stats: CacheStats {
                    entries: vec![CacheEntry {
                        timestamp: "2026-08-25T10:00:00.000Z".to_string(),
                        model: "partial-model".to_string(),
                        environment: Some("custom".to_string()),
                        usage: CacheUsage {
                            input_tokens: 1000,
                            output_tokens: 500,
                            cache_read_tokens: 200,
                            cache_creation_tokens: 100,
                            cost: 0.002,
                        },
                    }],
                },
                rollup: CacheRollup::default(),
                parse_offset: 0,
                last_line_complete: true,
                codex_state: None,
                claude_state: None,
                append_anchor: None,
                revision: None,
            },
        );
        let cache = CacheFile {
            version: USAGE_CACHE_VERSION,
            files,
            global_rollup: CacheRollup::default(),
            last_updated: None,
        };
        let stats = aggregate_cache(&cache, None, &custom_prices);
        // Only cache tokens (200 + 100 = 300) are unpriced
        assert_eq!(stats.total.unpriced_tokens, 300);
        assert!(stats.total.cost_incomplete);
        // Cost is still non-zero (from input+output)
        assert!((stats.total.cost - 0.002).abs() < 0.0001);
    }

    #[test]
    fn test_category_aware_pricing_fully_covered_model() {
        // A model with all rates defined: no unpriced tokens even with cache tokens
        let mut files = HashMap::new();
        files.insert(
            "dsh://inst1/sess1".to_string(),
            CacheFileEntry {
                meta: CacheMeta {
                    mtime: 1.0,
                    size: 10,
                },
                stats: CacheStats {
                    entries: vec![CacheEntry {
                        timestamp: "2026-08-25T10:00:00.000Z".to_string(),
                        model: "claude-sonnet-4-5".to_string(),
                        environment: Some("official".to_string()),
                        usage: CacheUsage {
                            input_tokens: 1000,
                            output_tokens: 500,
                            cache_read_tokens: 200,
                            cache_creation_tokens: 100,
                            cost: 0.01,
                        },
                    }],
                },
                rollup: CacheRollup::default(),
                parse_offset: 0,
                last_line_complete: true,
                codex_state: None,
                claude_state: None,
                append_anchor: None,
                revision: None,
            },
        );
        let cache = CacheFile {
            version: USAGE_CACHE_VERSION,
            files,
            global_rollup: CacheRollup::default(),
            last_updated: None,
        };
        // claude-sonnet-4-5 has all 4 rates defined
        let stats = aggregate_cache(&cache, None, &default_prices());
        assert_eq!(stats.total.unpriced_tokens, 0);
        assert!(!stats.total.cost_incomplete);
    }

    /// Regression: production aggregators must use user-provided prices, not just
    /// default_prices(). A custom price table that lacks cache rates must yield
    /// cost_incomplete even when default_prices() would fully cover the model.
    #[test]
    fn test_production_path_uses_user_prices_not_defaults() {
        // Build a cache with cache_read_tokens for claude-sonnet-4-5
        let mut files = HashMap::new();
        files.insert(
            "file1.jsonl".to_string(),
            CacheFileEntry {
                meta: CacheMeta {
                    mtime: 1.0,
                    size: 10,
                },
                stats: CacheStats {
                    entries: vec![CacheEntry {
                        timestamp: "2026-08-25T10:00:00.000Z".to_string(),
                        model: "claude-sonnet-4-5".to_string(),
                        environment: Some("official".to_string()),
                        usage: CacheUsage {
                            input_tokens: 1000,
                            output_tokens: 500,
                            cache_read_tokens: 300,
                            cache_creation_tokens: 0,
                            cost: 0.01,
                        },
                    }],
                },
                rollup: CacheRollup::default(),
                parse_offset: 0,
                last_line_complete: true,
                codex_state: None,
                claude_state: None,
                append_anchor: None,
                revision: None,
            },
        );
        let cache = CacheFile {
            version: USAGE_CACHE_VERSION,
            files,
            global_rollup: CacheRollup::default(),
            last_updated: None,
        };

        // With default prices (full coverage), no unpriced tokens
        let stats_default = aggregate_cache(&cache, None, &default_prices());
        assert_eq!(stats_default.total.unpriced_tokens, 0);
        assert!(!stats_default.total.cost_incomplete);

        // With custom user prices that omit cache_read rate for this model
        let mut custom_prices = HashMap::new();
        custom_prices.insert(
            "claude-sonnet-4-5".to_string(),
            ModelPrice {
                input_cost_per_token: 3.0,
                output_cost_per_token: 15.0,
                cache_read_input_token_cost: None, // user hasn't configured this
                cache_creation_input_token_cost: Some(3.75),
            },
        );
        let stats_custom = aggregate_cache(&cache, None, &custom_prices);
        // The 300 cache_read_tokens should be unpriced
        assert_eq!(stats_custom.total.unpriced_tokens, 300);
        assert!(stats_custom.total.cost_incomplete);

        // Model breakdown also consistent with user prices
        let breakdown = aggregate_model_breakdown(
            &cache,
            None,
            ModelBreakdownGranularity::Day,
            fixed_now(),
            &custom_prices,
        );
        // HashMap<bucket, HashMap<model, TokenUsageWithCost>>
        let all_model_entries: Vec<_> = breakdown.values().flat_map(|m| m.values()).collect();
        assert!(!all_model_entries.is_empty());
        let entry = &all_model_entries[0];
        assert_eq!(entry.unpriced_tokens, 300);
        assert!(entry.cost_incomplete);
    }
}
