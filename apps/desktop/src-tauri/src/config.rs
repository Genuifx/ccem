use crate::crypto;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::path::PathBuf; // 文件锁支持
use std::process::Command;
use std::sync::Mutex;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EnvConfig {
    #[serde(rename = "ANTHROPIC_BASE_URL")]
    pub base_url: Option<String>,
    #[serde(
        rename = "ANTHROPIC_AUTH_TOKEN",
        skip_serializing_if = "Option::is_none"
    )]
    pub auth_token: Option<String>,
    #[serde(
        rename = "ANTHROPIC_DEFAULT_OPUS_MODEL",
        skip_serializing_if = "Option::is_none"
    )]
    pub default_opus_model: Option<String>,
    #[serde(
        rename = "ANTHROPIC_DEFAULT_SONNET_MODEL",
        skip_serializing_if = "Option::is_none"
    )]
    pub default_sonnet_model: Option<String>,
    #[serde(
        rename = "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        skip_serializing_if = "Option::is_none"
    )]
    pub default_haiku_model: Option<String>,
    #[serde(rename = "ANTHROPIC_MODEL")]
    pub model: Option<String>,
    #[serde(
        rename = "CLAUDE_CODE_SUBAGENT_MODEL",
        skip_serializing_if = "Option::is_none"
    )]
    pub subagent_model: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
struct RawEnvConfig {
    #[serde(rename = "ANTHROPIC_BASE_URL", default)]
    base_url: Option<String>,
    #[serde(rename = "ANTHROPIC_AUTH_TOKEN", default)]
    auth_token: Option<String>,
    #[serde(rename = "ANTHROPIC_API_KEY", default)]
    api_key: Option<String>,
    #[serde(rename = "ANTHROPIC_DEFAULT_OPUS_MODEL", default)]
    default_opus_model: Option<String>,
    #[serde(rename = "ANTHROPIC_DEFAULT_SONNET_MODEL", default)]
    default_sonnet_model: Option<String>,
    #[serde(rename = "ANTHROPIC_DEFAULT_HAIKU_MODEL", default)]
    default_haiku_model: Option<String>,
    #[serde(rename = "ANTHROPIC_MODEL", default)]
    model: Option<String>,
    #[serde(rename = "ANTHROPIC_SMALL_FAST_MODEL", default)]
    small_fast_model: Option<String>,
    #[serde(rename = "CLAUDE_CODE_SUBAGENT_MODEL", default)]
    subagent_model: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ResolvedClaudeEnv {
    pub env_name: String,
    pub env_vars: HashMap<String, String>,
    pub upstream_base_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ResolvedOpenCodeRuntime {
    pub env_name: String,
    pub env_vars: HashMap<String, String>,
    pub config_source: String,
}

#[derive(Debug, Clone)]
pub struct ResolvedCodexRuntime {
    pub env_name: String,
    pub env_vars: HashMap<String, String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
}

pub const OPENCODE_NATIVE_ENV_NAME: &str = "OpenCode Native";
const OFFICIAL_ENV_NAME: &str = "official";
const OFFICIAL_BASE_URL: &str = "https://api.anthropic.com";
const LEGACY_OFFICIAL_MODEL_PIN: &str = "claude-opus-4-1-20250805";
const LEGACY_OFFICIAL_HAIKU_PIN: &str = "claude-3-5-haiku-20241022";
const OFFICIAL_RUNTIME_ALIAS: &str = "opus";

#[derive(Debug, Serialize, Deserialize)]
pub struct CcemConfig {
    #[serde(default)]
    pub registries: HashMap<String, EnvConfig>,
    #[serde(default)]
    pub current: Option<String>,
    #[serde(rename = "defaultMode", default)]
    pub default_mode: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct RawCcemConfig {
    #[serde(default)]
    registries: HashMap<String, RawEnvConfig>,
    #[serde(default)]
    current: Option<String>,
    #[serde(rename = "defaultMode", default)]
    default_mode: Option<String>,
}

fn default_official_env() -> EnvConfig {
    EnvConfig {
        base_url: Some("https://api.anthropic.com".to_string()),
        auth_token: None,
        default_opus_model: None,
        default_sonnet_model: None,
        default_haiku_model: Some("claude-3-5-haiku-20241022".to_string()),
        model: Some("opus".to_string()),
        subagent_model: None,
    }
}

fn resolve_env_config_for_runtime(env_name: &str, mut env: EnvConfig) -> EnvConfig {
    let has_untouched_legacy_official_pins = env_name == OFFICIAL_ENV_NAME
        && env.base_url.as_deref() == Some(OFFICIAL_BASE_URL)
        && env.default_opus_model.as_deref() == Some(LEGACY_OFFICIAL_MODEL_PIN)
        && env.default_sonnet_model.as_deref() == Some(LEGACY_OFFICIAL_MODEL_PIN)
        && env.default_haiku_model.as_deref() == Some(LEGACY_OFFICIAL_HAIKU_PIN)
        && env.model.as_deref() == Some(OFFICIAL_RUNTIME_ALIAS)
        && env.subagent_model.is_none();

    if has_untouched_legacy_official_pins {
        env.default_opus_model = None;
        env.default_sonnet_model = None;
    }

    env
}

fn normalize_env_config(raw: RawEnvConfig) -> EnvConfig {
    let has_tier_defaults = raw.default_opus_model.is_some()
        || raw.default_sonnet_model.is_some()
        || raw.default_haiku_model.is_some();

    let default_opus_model = raw.default_opus_model.or_else(|| {
        if has_tier_defaults {
            None
        } else {
            raw.model.clone()
        }
    });
    let default_sonnet_model = raw
        .default_sonnet_model
        .or_else(|| default_opus_model.clone())
        .or_else(|| {
            if has_tier_defaults {
                None
            } else {
                raw.model.clone()
            }
        });
    let default_haiku_model = raw.default_haiku_model.or(raw.small_fast_model);

    EnvConfig {
        base_url: raw.base_url,
        auth_token: raw.auth_token.or(raw.api_key),
        default_opus_model,
        default_sonnet_model,
        default_haiku_model,
        model: Some(if has_tier_defaults {
            raw.model.unwrap_or_else(|| "opus".to_string())
        } else {
            "opus".to_string()
        }),
        subagent_model: raw.subagent_model,
    }
}

fn normalize_config(raw: RawCcemConfig) -> CcemConfig {
    CcemConfig {
        registries: raw
            .registries
            .into_iter()
            .map(|(name, env)| (name, normalize_env_config(env)))
            .collect(),
        current: raw.current,
        default_mode: raw.default_mode,
    }
}

fn is_tier_model_alias(value: &str) -> bool {
    matches!(value, "opus" | "sonnet" | "haiku")
}

fn should_recover_tier_model(value: &Option<String>) -> bool {
    match value.as_deref() {
        None => true,
        Some(model) => is_tier_model_alias(model),
    }
}

fn recover_env_from_legacy(current: &mut EnvConfig, legacy: &EnvConfig) -> bool {
    let mut changed = false;

    if current.auth_token.is_none() {
        if let Some(auth_token) = legacy.auth_token.clone() {
            current.auth_token = Some(auth_token);
            changed = true;
        }
    }

    if should_recover_tier_model(&current.default_opus_model) {
        if let Some(default_opus_model) = legacy.default_opus_model.clone() {
            if current.default_opus_model.as_ref() != Some(&default_opus_model) {
                current.default_opus_model = Some(default_opus_model);
                changed = true;
            }
        }
    }

    if should_recover_tier_model(&current.default_sonnet_model) {
        if let Some(default_sonnet_model) = legacy.default_sonnet_model.clone() {
            if current.default_sonnet_model.as_ref() != Some(&default_sonnet_model) {
                current.default_sonnet_model = Some(default_sonnet_model);
                changed = true;
            }
        }
    }

    if should_recover_tier_model(&current.default_haiku_model) {
        if let Some(default_haiku_model) = legacy.default_haiku_model.clone() {
            if current.default_haiku_model.as_ref() != Some(&default_haiku_model) {
                current.default_haiku_model = Some(default_haiku_model);
                changed = true;
            }
        }
    }

    if current.subagent_model.is_none() {
        if let Some(subagent_model) = legacy.subagent_model.clone() {
            current.subagent_model = Some(subagent_model);
            changed = true;
        }
    }

    changed
}

fn recover_config_from_legacy(current: &mut CcemConfig, legacy: &CcemConfig) -> bool {
    let current_auth_count = current
        .registries
        .values()
        .filter(|env| env.auth_token.is_some())
        .count();
    if current_auth_count > 0 {
        return false;
    }

    let recoverable_auth_count = current
        .registries
        .iter()
        .filter(|(name, env)| {
            env.auth_token.is_none()
                && legacy
                    .registries
                    .get(*name)
                    .and_then(|legacy_env| legacy_env.auth_token.as_ref())
                    .is_some()
        })
        .count();

    if recoverable_auth_count == 0 {
        return false;
    }

    let mut changed = false;
    for (name, env) in current.registries.iter_mut() {
        if let Some(legacy_env) = legacy.registries.get(name) {
            changed |= recover_env_from_legacy(env, legacy_env);
        }
    }

    changed
}

fn read_normalized_config_file(config_path: &PathBuf) -> Result<CcemConfig, String> {
    let (_, raw) = read_raw_config_file(config_path)?;
    Ok(normalize_config(raw))
}

pub(crate) const MANAGED_CLAUDE_ENV_KEYS: &[&str] = &[
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_SMALL_FAST_MODEL",
];

fn read_raw_config_file(
    config_path: &PathBuf,
) -> Result<(serde_json::Value, RawCcemConfig), String> {
    let content =
        fs::read_to_string(config_path).map_err(|e| format!("Failed to read config: {}", e))?;
    let original_value: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse config: {}", e))?;
    let raw: RawCcemConfig = serde_json::from_value(original_value.clone())
        .map_err(|e| format!("Failed to parse config: {}", e))?;

    Ok((original_value, raw))
}

fn write_config_locked(
    config_path: &PathBuf,
    _lock_file: &File,
    config: &CcemConfig,
) -> Result<(), String> {
    let temp_path = config_path.with_extension("tmp");
    let content = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    fs::write(&temp_path, &content).map_err(|e| format!("Failed to write temp config: {}", e))?;
    fs::rename(&temp_path, config_path)
        .map_err(|e| format!("Failed to rename temp config: {}", e))?;

    Ok(())
}

impl Default for CcemConfig {
    fn default() -> Self {
        let mut registries = HashMap::new();
        registries.insert("official".to_string(), default_official_env());
        Self {
            registries,
            current: Some("official".to_string()),
            default_mode: None,
        }
    }
}

// ============================================================================
// App Config (Desktop-only configuration for working directory management)
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct FavoriteProject {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RecentProject {
    pub path: String,
    #[serde(rename = "lastUsed")]
    pub last_used: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VSCodeProject {
    pub path: String,
    #[serde(rename = "syncedAt")]
    pub synced_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JetBrainsProject {
    pub path: String,
    pub ide: String, // e.g., "WebStorm", "IntelliJ IDEA", "PyCharm"
    #[serde(rename = "syncedAt")]
    pub synced_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct AppConfig {
    pub favorites: Vec<FavoriteProject>,
    pub recent: Vec<RecentProject>,
    #[serde(rename = "vscodeProjects")]
    pub vscode_projects: Vec<VSCodeProject>,
    #[serde(rename = "jetbrainsProjects", default)]
    pub jetbrains_projects: Vec<JetBrainsProject>,
    #[serde(rename = "defaultWorkingDir", default)]
    pub default_working_dir: Option<String>,
}

/// Get ~/.ccem/ directory path
pub fn get_ccem_dir() -> PathBuf {
    let home = dirs::home_dir().expect("Could not find home directory");
    home.join(".ccem")
}

/// Get ~/.ccem/config.json path
pub fn get_config_path() -> PathBuf {
    get_ccem_dir().join("config.json")
}

/// Get legacy config path (conf package default)
pub fn get_legacy_config_path() -> PathBuf {
    let home = dirs::home_dir().expect("Could not find home directory");
    #[cfg(target_os = "macos")]
    {
        home.join("Library")
            .join("Preferences")
            .join("claude-code-env-manager-nodejs")
            .join("config.json")
    }
    #[cfg(not(target_os = "macos"))]
    {
        home.join(".config")
            .join("claude-code-env-manager-nodejs")
            .join("config.json")
    }
}

/// Get ~/.ccem/app.json path (desktop-only config)
pub fn get_app_config_path() -> PathBuf {
    get_ccem_dir().join("app.json")
}

/// Ensure ~/.ccem/ directory exists
pub fn ensure_ccem_dir() -> std::io::Result<()> {
    let dir = get_ccem_dir();
    if !dir.exists() {
        fs::create_dir_all(&dir)?;
    }
    Ok(())
}

/// Migrate config from legacy path if needed
pub fn migrate_if_needed() -> Result<bool, String> {
    let new_path = get_config_path();
    let legacy_path = get_legacy_config_path();

    // Already migrated
    if new_path.exists() {
        return Ok(false);
    }

    // No legacy config
    if !legacy_path.exists() {
        return Ok(false);
    }

    // Perform migration
    ensure_ccem_dir().map_err(|e| format!("Failed to create config dir: {}", e))?;
    fs::copy(&legacy_path, &new_path).map_err(|e| format!("Failed to copy config: {}", e))?;

    println!("CCEM: Config migrated to ~/.ccem/");
    Ok(true)
}

/// Read config from ~/.ccem/config.json with file lock
pub fn read_config() -> Result<CcemConfig, String> {
    let config_path = get_config_path();
    let legacy_config_path = get_legacy_config_path();

    if !config_path.exists() {
        return Ok(CcemConfig::default());
    }

    let legacy_config = if legacy_config_path.exists() {
        read_normalized_config_file(&legacy_config_path).ok()
    } else {
        None
    };

    let (original_value, mut config) = {
        let lock_file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&config_path)
            .map_err(|e| format!("Failed to open config for locking: {}", e))?;

        lock_file
            .lock_shared()
            .map_err(|e| format!("Failed to acquire read lock: {}", e))?;

        let (original_value, raw) = read_raw_config_file(&config_path)?;

        (original_value, normalize_config(raw))
    };

    if let Some(legacy_config) = legacy_config.as_ref() {
        recover_config_from_legacy(&mut config, legacy_config);
    }

    let normalized_value =
        serde_json::to_value(&config).map_err(|e| format!("Failed to serialize config: {}", e))?;
    if normalized_value != original_value {
        let lock_file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&config_path)
            .map_err(|e| format!("Failed to open config for locking: {}", e))?;

        lock_file
            .lock_exclusive()
            .map_err(|e| format!("Failed to acquire lock: {}", e))?;

        let (latest_value, latest_raw) = read_raw_config_file(&config_path)?;
        let mut latest_config = normalize_config(latest_raw);
        if let Some(legacy_config) = legacy_config.as_ref() {
            recover_config_from_legacy(&mut latest_config, legacy_config);
        }
        let latest_normalized_value = serde_json::to_value(&latest_config)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;

        if latest_normalized_value != latest_value {
            write_config_locked(&config_path, &lock_file, &latest_config)?;
        }

        return Ok(latest_config);
    }

    Ok(config)
}

/// Write config to ~/.ccem/config.json with file lock and atomic write
pub fn write_config(config: &CcemConfig) -> Result<(), String> {
    ensure_ccem_dir().map_err(|e| format!("Failed to create config dir: {}", e))?;

    let config_path = get_config_path();

    // 获取文件锁（如果文件不存在会创建）
    let lock_file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(&config_path)
        .map_err(|e| format!("Failed to open config for locking: {}", e))?;

    // 加排他锁
    lock_file
        .lock_exclusive()
        .map_err(|e| format!("Failed to acquire lock: {}", e))?;

    write_config_locked(&config_path, &lock_file, config)
}

/// Read app config from ~/.ccem/app.json
pub fn read_app_config() -> Result<AppConfig, String> {
    let config_path = get_app_config_path();

    if !config_path.exists() {
        return Ok(AppConfig::default());
    }

    let content = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read app config: {}", e))?;

    serde_json::from_str(&content).map_err(|e| format!("Failed to parse app config: {}", e))
}

/// Write app config to ~/.ccem/app.json
pub fn write_app_config(config: &AppConfig) -> Result<(), String> {
    ensure_ccem_dir().map_err(|e| format!("Failed to create config dir: {}", e))?;

    let content = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize app config: {}", e))?;

    fs::write(get_app_config_path(), content)
        .map_err(|e| format!("Failed to write app config: {}", e))
}

/// Get environment config with decrypted auth token
pub fn get_env_with_decrypted_key(env: &EnvConfig) -> Result<EnvConfig, String> {
    Ok(EnvConfig {
        base_url: env.base_url.clone(),
        auth_token: env
            .auth_token
            .as_deref()
            .map(|k| crypto::decrypt_local_secret("local auth token", k))
            .transpose()?,
        default_opus_model: env.default_opus_model.clone(),
        default_sonnet_model: env.default_sonnet_model.clone(),
        default_haiku_model: env.default_haiku_model.clone(),
        model: env.model.clone(),
        subagent_model: env.subagent_model.clone(),
    })
}

pub fn build_claude_env_vars(env: &EnvConfig) -> HashMap<String, String> {
    let mut env_vars = HashMap::new();

    if let Some(url) = &env.base_url {
        env_vars.insert("ANTHROPIC_BASE_URL".to_string(), url.clone());
    }
    if let Some(token) = &env.auth_token {
        env_vars.insert("ANTHROPIC_AUTH_TOKEN".to_string(), token.clone());
    }
    if let Some(model) = &env.default_opus_model {
        env_vars.insert("ANTHROPIC_DEFAULT_OPUS_MODEL".to_string(), model.clone());
    }
    if let Some(model) = &env.default_sonnet_model {
        env_vars.insert("ANTHROPIC_DEFAULT_SONNET_MODEL".to_string(), model.clone());
    }
    if let Some(model) = &env.default_haiku_model {
        env_vars.insert("ANTHROPIC_DEFAULT_HAIKU_MODEL".to_string(), model.clone());
    }
    if let Some(model) = &env.model {
        env_vars.insert("ANTHROPIC_MODEL".to_string(), model.clone());
    }
    if let Some(model) = &env.subagent_model {
        env_vars.insert("CLAUDE_CODE_SUBAGENT_MODEL".to_string(), model.clone());
    }

    env_vars
}

pub fn clear_managed_claude_env(command: &mut Command) {
    for key in MANAGED_CLAUDE_ENV_KEYS {
        command.env_remove(key);
    }
}

/// Resolve a named Claude environment into concrete process env vars.
pub fn resolve_claude_env(env_name: &str) -> Result<ResolvedClaudeEnv, String> {
    let cfg = read_config()?;
    let env_config = cfg
        .registries
        .get(env_name)
        .ok_or_else(|| format!("Environment '{}' does not exist", env_name))?;
    let env = resolve_env_config_for_runtime(env_name, get_env_with_decrypted_key(env_config)?);
    let (env_vars, upstream_base_url) = env_config_to_process_env(&env);

    Ok(ResolvedClaudeEnv {
        env_name: env_name.to_string(),
        env_vars,
        upstream_base_url,
    })
}

pub fn resolve_opencode_runtime(env_name: &str) -> Result<ResolvedOpenCodeRuntime, String> {
    if env_name.trim().is_empty() || env_name == OPENCODE_NATIVE_ENV_NAME {
        return Ok(ResolvedOpenCodeRuntime {
            env_name: OPENCODE_NATIVE_ENV_NAME.to_string(),
            env_vars: HashMap::new(),
            config_source: "native".to_string(),
        });
    }

    let cfg = read_config()?;
    let env_config = cfg
        .registries
        .get(env_name)
        .ok_or_else(|| format!("Environment '{}' does not exist", env_name))?;
    let env = get_env_with_decrypted_key(env_config)?;

    if let Some(config_content) = build_opencode_config_content(&env) {
        let mut env_vars = HashMap::new();
        env_vars.insert("OPENCODE_CONFIG_CONTENT".to_string(), config_content);
        return Ok(ResolvedOpenCodeRuntime {
            env_name: env_name.to_string(),
            env_vars,
            config_source: "ccem".to_string(),
        });
    }

    Ok(ResolvedOpenCodeRuntime {
        env_name: OPENCODE_NATIVE_ENV_NAME.to_string(),
        env_vars: HashMap::new(),
        config_source: "native".to_string(),
    })
}

pub fn resolve_codex_runtime(env_name: &str) -> Result<ResolvedCodexRuntime, String> {
    if env_name.trim().is_empty() {
        return Ok(ResolvedCodexRuntime {
            env_name: String::new(),
            env_vars: HashMap::new(),
            base_url: None,
            api_key: None,
        });
    }

    let cfg = read_config()?;
    cfg.registries
        .get(env_name)
        .ok_or_else(|| format!("Environment '{}' does not exist", env_name))?;

    Ok(ResolvedCodexRuntime {
        env_name: env_name.to_string(),
        env_vars: HashMap::new(),
        base_url: None,
        api_key: None,
    })
}

fn env_config_to_process_env(env: &EnvConfig) -> (HashMap<String, String>, Option<String>) {
    (build_claude_env_vars(env), env.base_url.clone())
}

fn build_opencode_config_content(env: &EnvConfig) -> Option<String> {
    let mut root = serde_json::Map::new();
    root.insert(
        "$schema".to_string(),
        json!("https://opencode.ai/config.json"),
    );

    let mut provider_options = serde_json::Map::new();
    if let Some(base_url) = env
        .base_url
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        provider_options.insert("baseURL".to_string(), json!(base_url));
    }
    if let Some(api_key) = env
        .auth_token
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        provider_options.insert("apiKey".to_string(), json!(api_key));
    }
    if !provider_options.is_empty() {
        root.insert(
            "provider".to_string(),
            json!({
                "anthropic": {
                    "options": provider_options
                }
            }),
        );
    }

    if let Some(model) = resolve_opencode_primary_model(env) {
        root.insert(
            "model".to_string(),
            json!(format_opencode_model_ref(&model)),
        );
    }
    if let Some(model) = env
        .default_haiku_model
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        root.insert(
            "small_model".to_string(),
            json!(format_opencode_model_ref(model)),
        );
    }

    if root.len() <= 1 {
        return None;
    }

    serde_json::to_string(&root).ok()
}

fn resolve_opencode_primary_model(env: &EnvConfig) -> Option<String> {
    match env
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some("haiku") => env
            .default_haiku_model
            .clone()
            .or_else(|| env.default_sonnet_model.clone())
            .or_else(|| env.default_opus_model.clone()),
        Some("sonnet") => env
            .default_sonnet_model
            .clone()
            .or_else(|| env.default_opus_model.clone()),
        Some("opus") => env
            .default_opus_model
            .clone()
            .or_else(|| env.default_sonnet_model.clone()),
        Some(model) => Some(model.to_string()),
        None => env
            .default_sonnet_model
            .clone()
            .or_else(|| env.default_opus_model.clone()),
    }
}

fn format_opencode_model_ref(model: &str) -> String {
    let trimmed = model.trim();
    if trimmed.contains('/') {
        trimmed.to_string()
    } else {
        format!("anthropic/{trimmed}")
    }
}

/// Get default working directory from app config (validated)
pub fn get_default_working_dir() -> Option<String> {
    read_app_config()
        .ok()
        .and_then(|cfg| cfg.default_working_dir)
        .filter(|d| !d.is_empty() && std::path::Path::new(d).is_dir())
}

// ============================================================================
// Desktop Settings (stored in ~/.ccem/settings.json)
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DesktopSettings {
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(rename = "autoStart", default)]
    pub auto_start: bool,
    #[serde(rename = "startMinimized", default)]
    pub start_minimized: bool,
    #[serde(rename = "closeToTray", default = "default_close_to_tray")]
    pub close_to_tray: bool,
    #[serde(rename = "desktopPetEnabled", default)]
    pub desktop_pet_enabled: bool,
    #[serde(rename = "defaultMode", default)]
    pub default_mode: Option<String>,
    #[serde(rename = "performanceMode", default = "default_performance_mode")]
    pub performance_mode: String,
    #[serde(
        rename = "desktopNotificationsEnabled",
        default = "default_desktop_notifications_enabled"
    )]
    pub desktop_notifications_enabled: bool,
    #[serde(
        rename = "notifyOnTaskCompleted",
        default = "default_notify_on_task_completed"
    )]
    pub notify_on_task_completed: bool,
    #[serde(
        rename = "notifyOnTaskFailed",
        default = "default_notify_on_task_failed"
    )]
    pub notify_on_task_failed: bool,
    #[serde(
        rename = "notifyOnActionRequired",
        default = "default_notify_on_action_required"
    )]
    pub notify_on_action_required: bool,
    #[serde(rename = "proxyDebugEnabled", default)]
    pub proxy_debug_enabled: bool,
    #[serde(
        rename = "proxyDebugCodexUpstreamBaseUrl",
        default = "default_proxy_debug_codex_upstream_base_url"
    )]
    pub proxy_debug_codex_upstream_base_url: String,
    #[serde(
        rename = "proxyDebugLogMaxBytes",
        default = "default_proxy_debug_log_max_bytes"
    )]
    pub proxy_debug_log_max_bytes: u64,
    #[serde(
        rename = "proxyDebugRecordMode",
        default = "default_proxy_debug_record_mode"
    )]
    pub proxy_debug_record_mode: String,
    #[serde(rename = "aiEnhanced", default)]
    pub ai_enhanced: bool,
    #[serde(rename = "aiEnvName", default)]
    pub ai_env_name: Option<String>,
    /// Explicitly enabled environment names for runtime selectors.
    /// `None` means legacy mode: all environments are treated as enabled.
    /// Once the user starts managing enablement, this becomes `Some(vec![...])`.
    #[serde(
        rename = "enabledEnvironments",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub enabled_environments: Option<Vec<String>>,
}

fn default_theme() -> String {
    "system".to_string()
}
fn default_close_to_tray() -> bool {
    true
}
fn default_performance_mode() -> String {
    "auto".to_string()
}
fn default_desktop_notifications_enabled() -> bool {
    true
}
fn default_notify_on_task_completed() -> bool {
    true
}
fn default_notify_on_task_failed() -> bool {
    true
}
fn default_notify_on_action_required() -> bool {
    true
}
fn default_proxy_debug_codex_upstream_base_url() -> String {
    "https://api.openai.com/v1".to_string()
}
fn default_proxy_debug_log_max_bytes() -> u64 {
    500 * 1024 * 1024
}
fn default_proxy_debug_record_mode() -> String {
    "full".to_string()
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            theme: default_theme(),
            language: None,
            auto_start: false,
            start_minimized: false,
            close_to_tray: default_close_to_tray(),
            desktop_pet_enabled: false,
            default_mode: None,
            performance_mode: default_performance_mode(),
            desktop_notifications_enabled: default_desktop_notifications_enabled(),
            notify_on_task_completed: default_notify_on_task_completed(),
            notify_on_task_failed: default_notify_on_task_failed(),
            notify_on_action_required: default_notify_on_action_required(),
            proxy_debug_enabled: false,
            proxy_debug_codex_upstream_base_url: default_proxy_debug_codex_upstream_base_url(),
            proxy_debug_log_max_bytes: default_proxy_debug_log_max_bytes(),
            proxy_debug_record_mode: default_proxy_debug_record_mode(),
            ai_enhanced: false,
            ai_env_name: None,
            enabled_environments: None,
        }
    }
}

pub fn get_settings_path() -> PathBuf {
    get_ccem_dir().join("settings.json")
}

pub fn read_settings() -> Result<DesktopSettings, String> {
    let path = get_settings_path();
    if !path.exists() {
        return Ok(DesktopSettings::default());
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read settings: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse settings: {}", e))
}

static DESKTOP_SETTINGS_WRITE_LOCK: Mutex<()> = Mutex::new(());

fn write_settings_unlocked(settings: &DesktopSettings) -> Result<(), String> {
    ensure_ccem_dir().map_err(|e| format!("Failed to create config dir: {}", e))?;
    let content = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    fs::write(get_settings_path(), content).map_err(|e| format!("Failed to write settings: {}", e))
}

pub fn write_settings(settings: &DesktopSettings) -> Result<(), String> {
    let _guard = DESKTOP_SETTINGS_WRITE_LOCK
        .lock()
        .map_err(|_| "Desktop settings write lock is poisoned".to_string())?;
    write_settings_unlocked(settings)
}

pub fn update_settings(
    update: impl FnOnce(&mut DesktopSettings),
) -> Result<DesktopSettings, String> {
    let _guard = DESKTOP_SETTINGS_WRITE_LOCK
        .lock()
        .map_err(|_| "Desktop settings write lock is poisoned".to_string())?;
    let mut settings = read_settings()?;
    update(&mut settings);
    write_settings_unlocked(&settings)?;
    Ok(settings)
}

/// Inject the appropriate AI environment variables into a Command.
/// When `ai_enhanced` is true in settings, uses the configured `ai_env_name`;
/// otherwise falls back to the current active environment.
pub fn inject_ai_env(cmd: &mut std::process::Command) {
    let settings = read_settings().unwrap_or_default();
    let cfg = match read_config() {
        Ok(c) => c,
        Err(_) => return,
    };
    let env_name = if settings.ai_enhanced {
        settings.ai_env_name.as_deref().or(cfg.current.as_deref())
    } else {
        cfg.current.as_deref()
    };
    if let Some(name) = env_name {
        if let Some(env) = cfg.registries.get(name) {
            clear_managed_claude_env(cmd);
            let decrypted = match get_env_with_decrypted_key(env) {
                Ok(env) => env,
                Err(error) => {
                    eprintln!("Failed to decrypt AI environment '{}': {}", name, error);
                    return;
                }
            };
            let runtime_env = resolve_env_config_for_runtime(name, decrypted);
            for (key, value) in build_claude_env_vars(&runtime_env) {
                cmd.env(key, value);
            }
        }
    }
}

/// Create environment config with encrypted auth token.
/// Returns Err if the install key cannot be loaded/persisted or AES-GCM
/// encryption fails — callers must propagate so no credential is saved
/// with an unpersisted key.
pub fn create_env_with_encrypted_key(
    base_url: Option<String>,
    auth_token: Option<String>,
    default_opus_model: Option<String>,
    default_sonnet_model: Option<String>,
    default_haiku_model: Option<String>,
    runtime_model: Option<String>,
    subagent_model: Option<String>,
) -> Result<EnvConfig, String> {
    let default_opus_model = default_opus_model
        .and_then(|value| (!value.trim().is_empty()).then(|| value.trim().to_string()));
    let default_sonnet_model = default_sonnet_model
        .and_then(|value| (!value.trim().is_empty()).then(|| value.trim().to_string()));
    let default_sonnet_model = default_sonnet_model.or_else(|| default_opus_model.clone());

    Ok(EnvConfig {
        base_url,
        auth_token: auth_token
            .map(|k| crypto::encrypt(&k))
            .transpose()
            .map_err(|e| format!("Failed to encrypt auth token: {}", e))?,
        default_opus_model,
        default_sonnet_model,
        default_haiku_model,
        model: runtime_model.or_else(|| Some("opus".to_string())),
        subagent_model,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        build_claude_env_vars, build_opencode_config_content, create_env_with_encrypted_key,
        default_official_env, env_config_to_process_env, get_env_with_decrypted_key, inject_ai_env,
        recover_config_from_legacy, resolve_env_config_for_runtime, resolve_opencode_primary_model,
        resolve_opencode_runtime, write_config, CcemConfig, EnvConfig, OPENCODE_NATIVE_ENV_NAME,
    };
    use std::collections::HashMap;
    use std::env;
    use std::ffi::OsStr;
    use std::process::Command;
    use std::sync::{Mutex, MutexGuard, OnceLock};

    fn test_home_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    struct TestHome {
        _lock: MutexGuard<'static, ()>,
        previous_home: Option<String>,
        _temp: tempfile::TempDir,
    }

    impl TestHome {
        fn new() -> Self {
            let lock = test_home_lock().lock().expect("lock test home");
            let temp = tempfile::tempdir().expect("create temp home");
            let previous_home = env::var("HOME").ok();
            env::set_var("HOME", temp.path());
            Self {
                _lock: lock,
                previous_home,
                _temp: temp,
            }
        }
    }

    impl Drop for TestHome {
        fn drop(&mut self) {
            if let Some(previous_home) = &self.previous_home {
                env::set_var("HOME", previous_home);
            } else {
                env::remove_var("HOME");
            }
        }
    }

    fn legacy_official_env() -> EnvConfig {
        EnvConfig {
            base_url: Some("https://api.anthropic.com".to_string()),
            auth_token: None,
            default_opus_model: Some("claude-opus-4-1-20250805".to_string()),
            default_sonnet_model: Some("claude-opus-4-1-20250805".to_string()),
            default_haiku_model: Some("claude-3-5-haiku-20241022".to_string()),
            model: Some("opus".to_string()),
            subagent_model: None,
        }
    }

    #[test]
    fn process_env_includes_auth_token_when_present() {
        let env = EnvConfig {
            base_url: Some("https://example.com/anthropic".to_string()),
            auth_token: Some("auth-token-123".to_string()),
            default_opus_model: Some("claude-opus-test".to_string()),
            default_sonnet_model: Some("claude-sonnet-test".to_string()),
            default_haiku_model: Some("claude-haiku-test".to_string()),
            model: Some("claude-sonnet-test".to_string()),
            subagent_model: Some("claude-subagent-test".to_string()),
        };

        let (env_vars, upstream_base_url) = env_config_to_process_env(&env);

        assert_eq!(
            upstream_base_url.as_deref(),
            Some("https://example.com/anthropic")
        );
        assert_eq!(
            env_vars.get("ANTHROPIC_AUTH_TOKEN").map(String::as_str),
            Some("auth-token-123")
        );
        assert_eq!(env_vars.get("ANTHROPIC_API_KEY"), None);
        assert_eq!(
            env_vars.get("ANTHROPIC_MODEL").map(String::as_str),
            Some("claude-sonnet-test")
        );
        assert_eq!(
            env_vars
                .get("ANTHROPIC_DEFAULT_OPUS_MODEL")
                .map(String::as_str),
            Some("claude-opus-test")
        );
        assert_eq!(
            env_vars
                .get("ANTHROPIC_DEFAULT_HAIKU_MODEL")
                .map(String::as_str),
            Some("claude-haiku-test")
        );
        assert_eq!(
            env_vars
                .get("CLAUDE_CODE_SUBAGENT_MODEL")
                .map(String::as_str),
            Some("claude-subagent-test")
        );
    }

    #[test]
    fn fresh_official_defaults_do_not_pin_opus_or_sonnet() {
        let env_vars = build_claude_env_vars(&default_official_env());

        assert_eq!(
            env_vars.get("ANTHROPIC_MODEL").map(String::as_str),
            Some("opus")
        );
        assert_eq!(env_vars.get("ANTHROPIC_DEFAULT_OPUS_MODEL"), None);
        assert_eq!(env_vars.get("ANTHROPIC_DEFAULT_SONNET_MODEL"), None);
    }

    #[test]
    fn blank_model_fields_remain_unpinned_when_saving_the_official_environment() {
        let env = create_env_with_encrypted_key(
            Some("https://api.anthropic.com".to_string()),
            None,
            Some("  ".to_string()),
            Some(String::new()),
            Some("claude-3-5-haiku-20241022".to_string()),
            Some("opus".to_string()),
            None,
        )
        .expect("create official environment");

        assert_eq!(env.default_opus_model, None);
        assert_eq!(env.default_sonnet_model, None);
    }

    #[test]
    fn untouched_legacy_official_defaults_follow_current_claude_aliases_at_runtime() {
        let stored = legacy_official_env();
        let original = serde_json::to_value(&stored).expect("serialize stored environment");

        let resolved = resolve_env_config_for_runtime("official", stored.clone());
        let env_vars = build_claude_env_vars(&resolved);

        assert_eq!(
            env_vars.get("ANTHROPIC_MODEL").map(String::as_str),
            Some("opus")
        );
        assert_eq!(env_vars.get("ANTHROPIC_DEFAULT_OPUS_MODEL"), None);
        assert_eq!(env_vars.get("ANTHROPIC_DEFAULT_SONNET_MODEL"), None);
        assert_eq!(
            serde_json::to_value(&stored).expect("serialize stored environment"),
            original,
            "runtime resolution must not rewrite the stored environment"
        );
    }

    #[test]
    fn customized_official_and_third_party_model_pins_are_preserved() {
        let mut customized = legacy_official_env();
        customized.default_sonnet_model = Some("claude-sonnet-custom".to_string());
        assert_eq!(
            resolve_env_config_for_runtime("official", customized.clone()).default_opus_model,
            customized.default_opus_model
        );
        assert_eq!(
            resolve_env_config_for_runtime("official", customized.clone()).default_sonnet_model,
            customized.default_sonnet_model
        );

        let mut custom_endpoint = legacy_official_env();
        custom_endpoint.base_url = Some("https://partner.example.com/anthropic".to_string());
        let resolved_custom_endpoint =
            resolve_env_config_for_runtime("official", custom_endpoint.clone());
        assert_eq!(
            resolved_custom_endpoint.default_opus_model,
            custom_endpoint.default_opus_model
        );
        assert_eq!(
            resolved_custom_endpoint.default_sonnet_model,
            custom_endpoint.default_sonnet_model
        );

        let mut custom_haiku = legacy_official_env();
        custom_haiku.default_haiku_model = Some("claude-haiku-custom".to_string());
        let resolved_custom_haiku =
            resolve_env_config_for_runtime("official", custom_haiku.clone());
        assert_eq!(
            resolved_custom_haiku.default_opus_model,
            custom_haiku.default_opus_model
        );
        assert_eq!(
            resolved_custom_haiku.default_sonnet_model,
            custom_haiku.default_sonnet_model
        );

        let third_party = legacy_official_env();
        let resolved = resolve_env_config_for_runtime("partner", third_party.clone());
        assert_eq!(resolved.default_opus_model, third_party.default_opus_model);
        assert_eq!(
            resolved.default_sonnet_model,
            third_party.default_sonnet_model
        );
    }

    #[test]
    fn env_decryption_rejects_tampered_v2_token_without_exposing_value() {
        let tampered = "enc:v2:000000000000000000000000:00:00000000000000000000000000000000";
        let env = EnvConfig {
            base_url: Some("https://example.com/anthropic".to_string()),
            auth_token: Some(tampered.to_string()),
            default_opus_model: None,
            default_sonnet_model: None,
            default_haiku_model: None,
            model: Some("opus".to_string()),
            subagent_model: None,
        };

        let error = get_env_with_decrypted_key(&env).expect_err("tampered v2 token should fail");

        assert!(
            !error.contains(tampered),
            "Error should not include encrypted token material"
        );
    }

    #[test]
    fn inject_ai_env_clears_managed_env_when_decryption_fails() {
        let _home = TestHome::new();
        let tampered = "enc:v2:000000000000000000000000:00:00000000000000000000000000000000";
        let mut registries = HashMap::new();
        registries.insert(
            "bad".to_string(),
            EnvConfig {
                base_url: Some("https://example.com/anthropic".to_string()),
                auth_token: Some(tampered.to_string()),
                default_opus_model: None,
                default_sonnet_model: None,
                default_haiku_model: None,
                model: Some("opus".to_string()),
                subagent_model: None,
            },
        );
        write_config(&CcemConfig {
            registries,
            current: Some("bad".to_string()),
            default_mode: Some("dev".to_string()),
        })
        .expect("write temp config");
        let mut command = Command::new("env");
        command.env("ANTHROPIC_AUTH_TOKEN", "parent-token");

        inject_ai_env(&mut command);

        let managed_value = command
            .get_envs()
            .find(|(key, _)| *key == OsStr::new("ANTHROPIC_AUTH_TOKEN"))
            .map(|(_, value)| value);
        assert_eq!(
            managed_value,
            Some(None),
            "decrypt failure should prevent managed token inheritance"
        );
    }

    #[test]
    fn recover_config_restores_missing_auth_and_tier_models_from_legacy() {
        let mut current_registries = HashMap::new();
        current_registries.insert(
            "glm".to_string(),
            EnvConfig {
                base_url: Some("https://open.bigmodel.cn/api/anthropic".to_string()),
                auth_token: None,
                default_opus_model: Some("opus".to_string()),
                default_sonnet_model: Some("opus".to_string()),
                default_haiku_model: None,
                model: Some("opus".to_string()),
                subagent_model: None,
            },
        );
        let mut current = CcemConfig {
            registries: current_registries,
            current: Some("glm".to_string()),
            default_mode: Some("dev".to_string()),
        };

        let mut legacy_registries = HashMap::new();
        legacy_registries.insert(
            "glm".to_string(),
            EnvConfig {
                base_url: Some("https://open.bigmodel.cn/api/anthropic".to_string()),
                auth_token: Some("enc:legacy-token".to_string()),
                default_opus_model: Some("glm-5".to_string()),
                default_sonnet_model: Some("glm-5".to_string()),
                default_haiku_model: Some("glm-4.5-air".to_string()),
                model: Some("opus".to_string()),
                subagent_model: None,
            },
        );
        let legacy = CcemConfig {
            registries: legacy_registries,
            current: Some("glm".to_string()),
            default_mode: Some("dev".to_string()),
        };

        let changed = recover_config_from_legacy(&mut current, &legacy);
        let recovered = current.registries.get("glm").expect("glm env should exist");

        assert!(changed);
        assert_eq!(recovered.auth_token.as_deref(), Some("enc:legacy-token"));
        assert_eq!(recovered.default_opus_model.as_deref(), Some("glm-5"));
        assert_eq!(recovered.default_sonnet_model.as_deref(), Some("glm-5"));
        assert_eq!(
            recovered.default_haiku_model.as_deref(),
            Some("glm-4.5-air")
        );
    }

    #[test]
    fn build_opencode_config_content_maps_claude_env_to_anthropic_overlay() {
        let env = EnvConfig {
            base_url: Some("https://example.com/anthropic".to_string()),
            auth_token: Some("auth-token-123".to_string()),
            default_opus_model: Some("claude-opus-test".to_string()),
            default_sonnet_model: Some("claude-sonnet-test".to_string()),
            default_haiku_model: Some("claude-haiku-test".to_string()),
            model: Some("sonnet".to_string()),
            subagent_model: None,
        };

        let content = build_opencode_config_content(&env).expect("overlay content");
        let value: serde_json::Value = serde_json::from_str(&content).expect("valid json");

        assert_eq!(
            value.get("$schema").and_then(|raw| raw.as_str()),
            Some("https://opencode.ai/config.json")
        );
        assert_eq!(
            value
                .pointer("/provider/anthropic/options/baseURL")
                .and_then(|raw| raw.as_str()),
            Some("https://example.com/anthropic")
        );
        assert_eq!(
            value
                .pointer("/provider/anthropic/options/apiKey")
                .and_then(|raw| raw.as_str()),
            Some("auth-token-123")
        );
        assert_eq!(
            value.get("model").and_then(|raw| raw.as_str()),
            Some("anthropic/claude-sonnet-test")
        );
        assert_eq!(
            value.get("small_model").and_then(|raw| raw.as_str()),
            Some("anthropic/claude-haiku-test")
        );
    }

    #[test]
    fn resolve_opencode_runtime_accepts_native_sentinel() {
        let runtime = resolve_opencode_runtime(OPENCODE_NATIVE_ENV_NAME).expect("native runtime");
        assert_eq!(runtime.env_name, OPENCODE_NATIVE_ENV_NAME);
        assert_eq!(runtime.config_source, "native");
        assert!(runtime.env_vars.is_empty());
    }

    #[test]
    fn resolve_opencode_primary_model_prefers_alias_defaults() {
        let env = EnvConfig {
            base_url: None,
            auth_token: None,
            default_opus_model: Some("claude-opus-test".to_string()),
            default_sonnet_model: Some("claude-sonnet-test".to_string()),
            default_haiku_model: Some("claude-haiku-test".to_string()),
            model: Some("haiku".to_string()),
            subagent_model: None,
        };

        assert_eq!(
            resolve_opencode_primary_model(&env).as_deref(),
            Some("claude-haiku-test")
        );
    }
}

#[cfg(test)]
mod desktop_pet_settings_tests {
    use super::DesktopSettings;

    #[test]
    fn desktop_pet_setting_defaults_to_disabled() {
        let settings = DesktopSettings::default();
        assert!(!settings.desktop_pet_enabled);
    }

    #[test]
    fn missing_language_is_preserved_for_legacy_migration() {
        let settings = DesktopSettings::default();
        assert_eq!(settings.language, None);

        let serialized = serde_json::to_value(&settings).expect("settings serialize");
        assert!(serialized.get("language").is_none());

        let legacy: DesktopSettings = serde_json::from_str(
            r#"{
                "theme": "system",
                "autoStart": false,
                "startMinimized": false,
                "closeToTray": true
            }"#,
        )
        .expect("settings deserialize");
        assert_eq!(legacy.language, None);
    }

    #[test]
    fn language_uses_the_existing_json_field_when_present() {
        let settings: DesktopSettings = serde_json::from_str(
            r#"{
                "theme": "system",
                "language": "en",
                "autoStart": false,
                "startMinimized": false,
                "closeToTray": true
            }"#,
        )
        .expect("settings deserialize");

        assert_eq!(settings.language.as_deref(), Some("en"));
    }

    #[test]
    fn desktop_pet_setting_uses_camel_case_json_key() {
        let settings = DesktopSettings {
            desktop_pet_enabled: true,
            ..DesktopSettings::default()
        };

        let serialized = serde_json::to_value(&settings).expect("settings serialize");
        assert_eq!(serialized["desktopPetEnabled"], true);
    }

    #[test]
    fn desktop_pet_setting_is_backward_compatible_when_missing() {
        let settings: DesktopSettings = serde_json::from_str(
            r#"{
                "theme": "system",
                "autoStart": false,
                "startMinimized": false,
                "closeToTray": true
            }"#,
        )
        .expect("settings deserialize");

        assert!(!settings.desktop_pet_enabled);
    }

    #[test]
    fn enabled_environments_defaults_to_none() {
        let settings = DesktopSettings::default();
        assert!(settings.enabled_environments.is_none());
    }

    #[test]
    fn enabled_environments_uses_camel_case_json_key() {
        let settings = DesktopSettings {
            enabled_environments: Some(vec!["official".to_string(), "glm".to_string()]),
            ..DesktopSettings::default()
        };

        let serialized = serde_json::to_value(&settings).expect("settings serialize");
        assert_eq!(
            serialized["enabledEnvironments"],
            serde_json::json!(["official", "glm"])
        );
    }

    #[test]
    fn enabled_environments_is_backward_compatible_when_missing() {
        let settings: DesktopSettings = serde_json::from_str(
            r#"{
                "theme": "system",
                "autoStart": false,
                "startMinimized": false,
                "closeToTray": true
            }"#,
        )
        .expect("settings deserialize");

        assert!(settings.enabled_environments.is_none());
    }
}
