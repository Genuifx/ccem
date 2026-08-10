use crate::crypto;
use crate::router::RouterConfig;
use crate::secure_fs::{ensure_private_dir, open_private_lock_file, write_private_atomic};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::fs::{self, File};
use std::path::PathBuf; // 文件锁支持
use std::process::Command;
use std::sync::{Mutex, MutexGuard};

/// Process-local linearization barrier for environment identity mutations and
/// every router write that can add a reference to an environment.
///
/// The advisory filesystem lock protects `config.json` between cooperating
/// writers. This coordinator closes the wider in-process transaction that spans
/// config.json, persisted native session records, and the live RouterManager.
#[derive(Debug, Default)]
pub(crate) struct EnvironmentMutationCoordinator {
    gate: Mutex<()>,
}

impl EnvironmentMutationCoordinator {
    pub(crate) fn lock(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.gate
            .lock()
            .map_err(|_| "Environment mutation coordinator is unavailable".to_string())
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

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
    #[serde(
        rename = "CCEM_LIMIT_WRITE_TOOLS",
        default,
        skip_serializing_if = "is_false"
    )]
    pub limit_write_tools: bool,
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
    #[serde(rename = "CCEM_LIMIT_WRITE_TOOLS", default)]
    limit_write_tools: bool,
}

#[derive(Debug, Clone)]
pub struct ResolvedClaudeEnv {
    pub env_name: String,
    pub env_vars: HashMap<String, String>,
    pub upstream_base_url: Option<String>,
    pub limit_write_tools: bool,
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
    pub limit_write_tools: bool,
}

pub const OPENCODE_NATIVE_ENV_NAME: &str = "OpenCode Native";
pub(crate) const OFFICIAL_ENV_NAME: &str = "official";
pub(crate) const OFFICIAL_BASE_URL: &str = "https://api.anthropic.com";
const LEGACY_OFFICIAL_MODEL_PIN: &str = "claude-opus-4-1-20250805";
const LEGACY_OFFICIAL_HAIKU_PIN: &str = "claude-3-5-haiku-20241022";
const OFFICIAL_RUNTIME_ALIAS: &str = "opus";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CcemConfig {
    #[serde(default)]
    pub registries: HashMap<String, EnvConfig>,
    #[serde(default)]
    pub current: Option<String>,
    #[serde(rename = "defaultMode", default)]
    pub default_mode: Option<String>,
    #[serde(default)]
    pub router: RouterConfig,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct RawCcemConfig {
    #[serde(default)]
    registries: HashMap<String, RawEnvConfig>,
    #[serde(default)]
    current: Option<String>,
    #[serde(rename = "defaultMode", default)]
    default_mode: Option<String>,
    #[serde(default)]
    router: RouterConfig,
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
        limit_write_tools: false,
    }
}

pub(crate) fn resolve_env_config_for_runtime(env_name: &str, mut env: EnvConfig) -> EnvConfig {
    let has_untouched_legacy_official_pins = env_name == OFFICIAL_ENV_NAME
        && is_trusted_official_base_url(env.base_url.as_deref())
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
        limit_write_tools: raw.limit_write_tools,
    }
}

fn normalize_config(raw: RawCcemConfig) -> CcemConfig {
    let mut registries: HashMap<String, EnvConfig> = raw
        .registries
        .into_iter()
        .map(|(name, env)| (name, normalize_env_config(env)))
        .collect();
    registries
        .entry(OFFICIAL_ENV_NAME.to_string())
        .or_insert_with(default_official_env);

    CcemConfig {
        registries,
        current: raw.current,
        default_mode: raw.default_mode,
        router: raw.router,
    }
}

pub(crate) fn ensure_environment_rename_allowed(
    old_name: &str,
    new_name: &str,
) -> Result<(), String> {
    if old_name == OFFICIAL_ENV_NAME && new_name != OFFICIAL_ENV_NAME {
        return Err(format!(
            "Cannot rename the protected '{}' environment",
            OFFICIAL_ENV_NAME
        ));
    }
    Ok(())
}

/// Build the safe intermediate config for a rename that also cascades persisted
/// native router snapshots. Both aliases resolve during the cross-file update:
/// native routes can still use `old_name`, while RouterManager registration can
/// already validate `new_name`. Internal readers are additionally serialized by
/// `EnvironmentMutationCoordinator`, so this state is never a control-plane
/// result; it only makes in-flight routed HTTP requests fail-safe.
pub(crate) fn build_environment_rename_transition(
    previous: &CcemConfig,
    final_config: &CcemConfig,
    old_name: &str,
    new_name: &str,
) -> Result<CcemConfig, String> {
    if old_name == new_name {
        return Ok(final_config.clone());
    }
    if !previous.registries.contains_key(old_name) {
        return Err(format!("Environment '{}' does not exist", old_name));
    }
    if previous.registries.contains_key(new_name) {
        return Err(format!("Environment '{}' already exists", new_name));
    }
    let next_environment = final_config.registries.get(new_name).ok_or_else(|| {
        format!(
            "Final environment config does not contain renamed environment '{}'",
            new_name
        )
    })?;

    let mut transition = previous.clone();
    transition
        .registries
        .insert(new_name.to_string(), next_environment.clone());
    validate_config_invariants(&transition)?;
    Ok(transition)
}

/// Validate a control-plane RouterConfig write against the environment snapshot
/// read under the shared mutation coordinator. Hand-edited legacy files may
/// still contain dangling references (request routing remains fail-closed), but
/// IPC/external writes must never create a new dangling reference after delete.
pub(crate) fn validate_router_config_environment_targets(
    router: &RouterConfig,
    registries: &HashMap<String, EnvConfig>,
) -> Result<(), String> {
    let mut targets = router.bindings.values().collect::<Vec<_>>();
    targets.extend(router.default_allowed_envs.iter());
    for profile in &router.profiles {
        targets.extend(profile.bindings.values());
        targets.extend(profile.allowed_envs.iter());
    }
    targets.sort();
    targets.dedup();
    let missing = targets
        .into_iter()
        .filter(|target| !registries.contains_key(target.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Router config references missing environments: {}",
            missing.join(", ")
        ))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EnvironmentRenameStage {
    ConfigAccess,
    Prepare,
    TransitionWrite,
    NativeMutation,
    FinalWrite,
    Rollback,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct EnvironmentRenameTransactionError {
    pub(crate) stage: EnvironmentRenameStage,
    pub(crate) message: String,
}

impl EnvironmentRenameTransactionError {
    fn new(stage: EnvironmentRenameStage, message: impl Into<String>) -> Self {
        Self {
            stage,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for EnvironmentRenameTransactionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

fn run_environment_rename_transaction<T>(
    previous: &CcemConfig,
    transition: &CcemConfig,
    final_config: &CcemConfig,
    old_name: &str,
    new_name: &str,
    mut write: impl FnMut(&CcemConfig) -> Result<(), String>,
    mut cascade_native: impl FnMut(&str, &str) -> Result<T, String>,
) -> Result<T, EnvironmentRenameTransactionError> {
    write(transition).map_err(|error| {
        EnvironmentRenameTransactionError::new(
            EnvironmentRenameStage::TransitionWrite,
            format!("Failed to write safe rename transition: {error}"),
        )
    })?;

    let native_result = match cascade_native(old_name, new_name) {
        Ok(result) => result,
        Err(native_error) => {
            return Err(match write(previous) {
                Ok(()) => EnvironmentRenameTransactionError::new(
                    EnvironmentRenameStage::NativeMutation,
                    format!("Failed to update native environment references: {native_error}"),
                ),
                Err(rollback_error) => EnvironmentRenameTransactionError::new(
                    EnvironmentRenameStage::Rollback,
                    format!(
                        "Failed to update native environment references: {native_error}; failed to roll back environment config: {rollback_error}"
                    ),
                ),
            });
        }
    };

    if let Err(final_error) = write(final_config) {
        if let Err(native_rollback_error) = cascade_native(new_name, old_name) {
            // Keep the dual-alias transition config in place: it is the only
            // safe state when the persisted native direction is uncertain.
            return Err(EnvironmentRenameTransactionError::new(
                EnvironmentRenameStage::Rollback,
                format!(
                    "Failed to finalize environment config: {final_error}; failed to roll back native environment references: {native_rollback_error}"
                ),
            ));
        }
        if let Err(config_rollback_error) = write(previous) {
            return Err(EnvironmentRenameTransactionError::new(
                EnvironmentRenameStage::Rollback,
                format!(
                    "Failed to finalize environment config: {final_error}; native references were rolled back, but the environment config rollback failed: {config_rollback_error}"
                ),
            ));
        }
        return Err(EnvironmentRenameTransactionError::new(
            EnvironmentRenameStage::FinalWrite,
            format!("Failed to finalize environment config: {final_error}"),
        ));
    }

    Ok(native_result)
}

pub(crate) fn commit_environment_rename<T>(
    old_name: &str,
    new_name: &str,
    prepare_final: impl FnOnce(&mut CcemConfig) -> Result<(), String>,
    cascade_native: impl FnMut(&str, &str) -> Result<T, String>,
) -> Result<(T, CcemConfig), EnvironmentRenameTransactionError> {
    ensure_ccem_dir().map_err(|error| {
        EnvironmentRenameTransactionError::new(
            EnvironmentRenameStage::ConfigAccess,
            format!("Failed to create config dir: {error}"),
        )
    })?;
    let config_path = get_config_path();
    let lock_file = open_private_lock_file(&config_lock_path()).map_err(|error| {
        EnvironmentRenameTransactionError::new(
            EnvironmentRenameStage::ConfigAccess,
            format!("Failed to open config for locking: {error}"),
        )
    })?;
    lock_file.lock_exclusive().map_err(|error| {
        EnvironmentRenameTransactionError::new(
            EnvironmentRenameStage::ConfigAccess,
            format!("Failed to acquire config lock: {error}"),
        )
    })?;

    // Re-read after taking the exclusive file lock. Callers may have prepared
    // UI input earlier, but the mutation must be based on the latest persisted
    // snapshot rather than overwriting an intervening process write.
    let previous = read_current_config_locked(&config_path).map_err(|error| {
        EnvironmentRenameTransactionError::new(EnvironmentRenameStage::ConfigAccess, error)
    })?;
    let mut final_config = previous.clone();
    prepare_final(&mut final_config).map_err(|error| {
        EnvironmentRenameTransactionError::new(EnvironmentRenameStage::Prepare, error)
    })?;
    let transition =
        build_environment_rename_transition(&previous, &final_config, old_name, new_name).map_err(
            |error| EnvironmentRenameTransactionError::new(EnvironmentRenameStage::Prepare, error),
        )?;
    let native_result = run_environment_rename_transaction(
        &previous,
        &transition,
        &final_config,
        old_name,
        new_name,
        |config| write_config_locked(&config_path, &lock_file, config),
        cascade_native,
    )?;
    Ok((native_result, final_config))
}

pub(crate) fn ensure_environment_delete_allowed(name: &str) -> Result<(), String> {
    if name == OFFICIAL_ENV_NAME {
        return Err(format!(
            "Cannot delete the protected '{}' environment",
            OFFICIAL_ENV_NAME
        ));
    }
    Ok(())
}

pub(crate) fn validate_config_invariants(config: &CcemConfig) -> Result<(), String> {
    let official = config.registries.get(OFFICIAL_ENV_NAME).ok_or_else(|| {
        format!(
            "Cannot remove or rename the protected '{}' environment",
            OFFICIAL_ENV_NAME
        )
    })?;
    if !is_trusted_official_base_url(official.base_url.as_deref()) {
        return Err(format!(
            "The protected '{}' environment must use the trusted official root URL",
            OFFICIAL_ENV_NAME
        ));
    }
    Ok(())
}

pub(crate) fn is_trusted_official_base_url(base_url: Option<&str>) -> bool {
    matches!(
        base_url,
        Some(OFFICIAL_BASE_URL) | Some("https://api.anthropic.com/")
    )
}

pub(crate) fn validate_claude_auth_boundary(env_name: &str, env: &EnvConfig) -> Result<(), String> {
    if env_name == OFFICIAL_ENV_NAME {
        if !is_trusted_official_base_url(env.base_url.as_deref()) {
            return Err(format!(
                "The protected '{}' environment must use the trusted official root URL",
                OFFICIAL_ENV_NAME
            ));
        }
        return Ok(());
    }

    if env
        .auth_token
        .as_deref()
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .is_none()
    {
        return Err(format!(
            "Environment '{}' requires an auth token; OAuth is only allowed for '{}'",
            env_name, OFFICIAL_ENV_NAME
        ));
    }
    Ok(())
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
    let config = normalize_config(raw);
    validate_config_invariants(&config)?;
    Ok(config)
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
    validate_config_invariants(config)?;
    let content = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    write_private_atomic(config_path, content.as_bytes())
        .map_err(|e| format!("Failed to atomically write private config: {}", e))
}

fn config_lock_path() -> PathBuf {
    get_ccem_dir().join("config.lock")
}

impl Default for CcemConfig {
    fn default() -> Self {
        let mut registries = HashMap::new();
        registries.insert("official".to_string(), default_official_env());
        Self {
            registries,
            current: Some("official".to_string()),
            default_mode: None,
            router: RouterConfig::default(),
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
    ensure_private_dir(&dir)
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

    // Normalize and validate before creating the destination. This prevents a
    // legacy protected environment from bypassing current write invariants.
    let migrated = read_normalized_config_file(&legacy_path)?;
    write_config(&migrated)?;

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
        let lock_file = open_private_lock_file(&config_lock_path())
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
    validate_config_invariants(&config)?;

    let normalized_value =
        serde_json::to_value(&config).map_err(|e| format!("Failed to serialize config: {}", e))?;
    if normalized_value != original_value {
        let lock_file = open_private_lock_file(&config_lock_path())
            .map_err(|e| format!("Failed to open config for locking: {}", e))?;

        lock_file
            .lock_exclusive()
            .map_err(|e| format!("Failed to acquire lock: {}", e))?;

        let (latest_value, latest_raw) = read_raw_config_file(&config_path)?;
        let mut latest_config = normalize_config(latest_raw);
        if let Some(legacy_config) = legacy_config.as_ref() {
            recover_config_from_legacy(&mut latest_config, legacy_config);
        }
        validate_config_invariants(&latest_config)?;
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
    let lock_file = open_private_lock_file(&config_lock_path())
        .map_err(|e| format!("Failed to open config for locking: {}", e))?;

    // 加排他锁
    lock_file
        .lock_exclusive()
        .map_err(|e| format!("Failed to acquire lock: {}", e))?;

    write_config_locked(&config_path, &lock_file, config)
}

fn read_current_config_locked(config_path: &PathBuf) -> Result<CcemConfig, String> {
    let mut config = if config_path.exists() {
        read_normalized_config_file(config_path)?
    } else {
        CcemConfig::default()
    };
    let legacy_path = get_legacy_config_path();
    if legacy_path.exists() {
        if let Ok(legacy) = read_normalized_config_file(&legacy_path) {
            recover_config_from_legacy(&mut config, &legacy);
        }
    }
    validate_config_invariants(&config)?;
    Ok(config)
}

pub fn update_ccem_config<T>(
    update: impl FnOnce(&mut CcemConfig) -> Result<T, String>,
) -> Result<T, String> {
    update_ccem_config_transaction(update).map_err(|error| match error {
        CcemConfigTransactionError::Storage(error)
        | CcemConfigTransactionError::Operation(error) => error,
    })
}

pub(crate) enum CcemConfigTransactionError<E> {
    Storage(String),
    Operation(E),
}

pub(crate) fn update_ccem_config_transaction<T, E>(
    update: impl FnOnce(&mut CcemConfig) -> Result<T, E>,
) -> Result<T, CcemConfigTransactionError<E>> {
    ensure_ccem_dir().map_err(|error| {
        CcemConfigTransactionError::Storage(format!("Failed to create config dir: {error}"))
    })?;
    let config_path = get_config_path();
    let lock_file = open_private_lock_file(&config_lock_path()).map_err(|error| {
        CcemConfigTransactionError::Storage(format!("Failed to open config for locking: {error}"))
    })?;
    lock_file.lock_exclusive().map_err(|error| {
        CcemConfigTransactionError::Storage(format!("Failed to acquire lock: {error}"))
    })?;

    let mut config =
        read_current_config_locked(&config_path).map_err(CcemConfigTransactionError::Storage)?;
    let result = update(&mut config).map_err(CcemConfigTransactionError::Operation)?;
    write_config_locked(&config_path, &lock_file, &config)
        .map_err(CcemConfigTransactionError::Storage)?;
    Ok(result)
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
        limit_write_tools: env.limit_write_tools,
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
    validate_claude_auth_boundary(env_name, &env)?;
    let (env_vars, upstream_base_url) = env_config_to_process_env(&env);

    Ok(ResolvedClaudeEnv {
        env_name: env_name.to_string(),
        env_vars,
        upstream_base_url,
        limit_write_tools: env_config.limit_write_tools,
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
    validate_claude_auth_boundary(env_name, &env)?;

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
            limit_write_tools: false,
        });
    }

    let cfg = read_config()?;
    let env_config = cfg
        .registries
        .get(env_name)
        .ok_or_else(|| format!("Environment '{}' does not exist", env_name))?;

    Ok(ResolvedCodexRuntime {
        env_name: env_name.to_string(),
        env_vars: HashMap::new(),
        base_url: None,
        api_key: None,
        limit_write_tools: env_config.limit_write_tools,
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
    inject_ai_env_from_config(cmd, &cfg, env_name);
}

fn inject_ai_env_from_config(
    cmd: &mut std::process::Command,
    cfg: &CcemConfig,
    env_name: Option<&str>,
) {
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
            if let Err(error) = validate_claude_auth_boundary(name, &runtime_env) {
                eprintln!("Refusing unsafe AI environment '{}': {}", name, error);
                return;
            }
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
        limit_write_tools: false,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        build_claude_env_vars, build_environment_rename_transition, build_opencode_config_content,
        create_env_with_encrypted_key, default_official_env, ensure_environment_delete_allowed,
        ensure_environment_rename_allowed, env_config_to_process_env, get_env_with_decrypted_key,
        inject_ai_env_from_config, is_trusted_official_base_url, normalize_config,
        normalize_env_config, recover_config_from_legacy, resolve_env_config_for_runtime,
        resolve_opencode_primary_model, resolve_opencode_runtime,
        run_environment_rename_transaction, validate_claude_auth_boundary,
        validate_config_invariants, validate_router_config_environment_targets, CcemConfig,
        EnvConfig, EnvironmentMutationCoordinator, EnvironmentRenameStage, RawCcemConfig,
        RawEnvConfig, RouterConfig, OPENCODE_NATIVE_ENV_NAME,
    };
    use crate::router::{rename_router_config_environment, RouterProfile};
    use std::collections::HashMap;
    use std::ffi::OsStr;
    use std::process::Command;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    fn legacy_official_env() -> EnvConfig {
        EnvConfig {
            base_url: Some("https://api.anthropic.com".to_string()),
            auth_token: None,
            default_opus_model: Some("claude-opus-4-1-20250805".to_string()),
            default_sonnet_model: Some("claude-opus-4-1-20250805".to_string()),
            default_haiku_model: Some("claude-3-5-haiku-20241022".to_string()),
            model: Some("opus".to_string()),
            subagent_model: None,
            limit_write_tools: false,
        }
    }

    #[test]
    fn protected_official_environment_cannot_be_renamed_or_deleted() {
        assert!(ensure_environment_rename_allowed("official", "renamed").is_err());
        assert!(ensure_environment_rename_allowed("official", "official").is_ok());
        assert!(ensure_environment_rename_allowed("glm", "glm-2").is_ok());
        assert!(ensure_environment_delete_allowed("official").is_err());
        assert!(ensure_environment_delete_allowed("glm").is_ok());

        let missing_official = CcemConfig {
            registries: HashMap::new(),
            current: None,
            default_mode: None,
            router: RouterConfig::default(),
        };
        assert!(validate_config_invariants(&missing_official).is_err());
    }

    fn environment_rename_configs() -> (CcemConfig, CcemConfig) {
        let mut previous = CcemConfig::default();
        previous
            .registries
            .insert("legacy".to_string(), legacy_official_env());
        previous.current = Some("legacy".to_string());
        previous
            .router
            .bindings
            .insert("background".to_string(), "legacy".to_string());
        previous.router.default_allowed_envs = vec!["legacy".to_string()];
        previous.router.profiles = vec![RouterProfile {
            id: "legacy-profile".to_string(),
            name: "Legacy".to_string(),
            revision: 1,
            bindings: HashMap::from([("subagent:Explore".to_string(), "legacy".to_string())]),
            allowed_envs: vec!["legacy".to_string()],
        }];

        let mut final_config = previous.clone();
        let environment = final_config
            .registries
            .remove("legacy")
            .expect("legacy env");
        final_config
            .registries
            .insert("partner".to_string(), environment);
        final_config.current = Some("partner".to_string());
        rename_router_config_environment(&mut final_config.router, "legacy", "partner");
        (previous, final_config)
    }

    #[test]
    fn environment_rename_transition_keeps_both_aliases_resolvable() {
        let (previous, final_config) = environment_rename_configs();
        let transition =
            build_environment_rename_transition(&previous, &final_config, "legacy", "partner")
                .expect("transition");

        assert!(transition.registries.contains_key("legacy"));
        assert!(transition.registries.contains_key("partner"));
        assert_eq!(transition.current.as_deref(), Some("legacy"));
        assert_eq!(
            transition
                .router
                .bindings
                .get("background")
                .map(String::as_str),
            Some("legacy")
        );
        assert!(!final_config.registries.contains_key("legacy"));
        assert_eq!(
            final_config
                .router
                .bindings
                .get("background")
                .map(String::as_str),
            Some("partner")
        );
    }

    #[test]
    fn router_config_control_plane_write_rejects_deleted_environment_targets() {
        let mut config = CcemConfig::default();
        config
            .router
            .bindings
            .insert("background".to_string(), "deleted".to_string());
        config.router.default_allowed_envs = vec!["deleted".to_string()];
        let error = validate_router_config_environment_targets(&config.router, &config.registries)
            .expect_err("missing target must fail");
        assert!(error.contains("deleted"));

        config
            .registries
            .insert("deleted".to_string(), legacy_official_env());
        assert!(
            validate_router_config_environment_targets(&config.router, &config.registries,).is_ok()
        );
    }

    #[test]
    fn environment_rename_final_write_failure_rolls_native_and_config_back() {
        let (previous, final_config) = environment_rename_configs();
        let transition =
            build_environment_rename_transition(&previous, &final_config, "legacy", "partner")
                .expect("transition");
        let writes = Mutex::new(Vec::<Vec<String>>::new());
        let cascades = Mutex::new(Vec::<(String, String)>::new());
        let write_count = Mutex::new(0usize);

        let error = run_environment_rename_transaction(
            &previous,
            &transition,
            &final_config,
            "legacy",
            "partner",
            |config| {
                let mut names = config.registries.keys().cloned().collect::<Vec<_>>();
                names.sort();
                writes.lock().expect("writes").push(names);
                let mut count = write_count.lock().expect("write count");
                *count += 1;
                if *count == 2 {
                    Err("injected final write failure".to_string())
                } else {
                    Ok(())
                }
            },
            |from, to| {
                cascades
                    .lock()
                    .expect("cascades")
                    .push((from.to_string(), to.to_string()));
                Ok(())
            },
        )
        .expect_err("final write must fail");

        assert_eq!(error.stage, EnvironmentRenameStage::FinalWrite);
        assert_eq!(
            cascades.into_inner().expect("cascades"),
            vec![
                ("legacy".to_string(), "partner".to_string()),
                ("partner".to_string(), "legacy".to_string()),
            ]
        );
        let writes = writes.into_inner().expect("writes");
        assert_eq!(writes.len(), 3);
        assert!(writes[0].contains(&"legacy".to_string()));
        assert!(writes[0].contains(&"partner".to_string()));
        assert!(writes[2].contains(&"legacy".to_string()));
        assert!(!writes[2].contains(&"partner".to_string()));
    }

    #[test]
    fn environment_rename_native_failure_restores_previous_config() {
        let (previous, final_config) = environment_rename_configs();
        let transition =
            build_environment_rename_transition(&previous, &final_config, "legacy", "partner")
                .expect("transition");
        let writes = Mutex::new(Vec::<CcemConfig>::new());

        let error = run_environment_rename_transaction(
            &previous,
            &transition,
            &final_config,
            "legacy",
            "partner",
            |config| {
                writes.lock().expect("writes").push(config.clone());
                Ok(())
            },
            |_from, _to| Err::<(), _>("injected native failure".to_string()),
        )
        .expect_err("native mutation must fail");

        assert_eq!(error.stage, EnvironmentRenameStage::NativeMutation);
        let writes = writes.into_inner().expect("writes");
        assert_eq!(writes.len(), 2);
        assert!(writes[0].registries.contains_key("partner"));
        assert_eq!(
            serde_json::to_value(&writes[1]).expect("rolled back config"),
            serde_json::to_value(&previous).expect("previous config")
        );
    }

    #[test]
    fn environment_delete_check_and_router_reference_add_are_linearized() {
        let coordinator = Arc::new(EnvironmentMutationCoordinator::default());
        let environment_exists = Arc::new(AtomicBool::new(true));
        let references = Arc::new(Mutex::new(Vec::<String>::new()));
        let (scanned_tx, scanned_rx) = mpsc::channel();
        let (commit_tx, commit_rx) = mpsc::channel();

        let delete_coordinator = coordinator.clone();
        let delete_exists = environment_exists.clone();
        let delete_references = references.clone();
        let delete_thread = thread::spawn(move || {
            let _guard = delete_coordinator.lock().expect("delete lock");
            assert!(delete_references.lock().expect("refs").is_empty());
            scanned_tx.send(()).expect("scanned");
            commit_rx.recv().expect("commit delete");
            delete_exists.store(false, Ordering::SeqCst);
        });

        scanned_rx.recv().expect("delete scanned");
        let update_coordinator = coordinator.clone();
        let update_exists = environment_exists.clone();
        let update_references = references.clone();
        let (update_attempting_tx, update_attempting_rx) = mpsc::channel();
        let (update_done_tx, update_done_rx) = mpsc::channel();
        let update_thread = thread::spawn(move || {
            update_attempting_tx.send(()).expect("update attempting");
            let _guard = update_coordinator.lock().expect("router update lock");
            if update_exists.load(Ordering::SeqCst) {
                update_references
                    .lock()
                    .expect("refs")
                    .push("session:new-reference".to_string());
            }
            update_done_tx.send(()).expect("update done");
        });

        update_attempting_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("router update attempts lock");
        assert!(update_done_rx
            .recv_timeout(Duration::from_millis(50))
            .is_err());
        commit_tx.send(()).expect("commit delete");
        delete_thread.join().expect("delete thread");
        update_done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("router update completes after delete");
        update_thread.join().expect("update thread");
        assert!(!environment_exists.load(Ordering::SeqCst));
        assert!(references.lock().expect("refs").is_empty());
    }

    #[test]
    fn official_environment_requires_the_exact_trusted_root_url() {
        for trusted in ["https://api.anthropic.com", "https://api.anthropic.com/"] {
            assert!(is_trusted_official_base_url(Some(trusted)));
            let mut config = CcemConfig::default();
            config
                .registries
                .get_mut("official")
                .expect("official")
                .base_url = Some(trusted.to_string());
            assert!(validate_config_invariants(&config).is_ok(), "{trusted}");
        }

        for untrusted in [
            None,
            Some(""),
            Some("http://api.anthropic.com"),
            Some("https://api.anthropic.com:443"),
            Some("https://user@api.anthropic.com"),
            Some("https://api.anthropic.com/v1"),
            Some("https://api.anthropic.com/?debug=1"),
            Some("https://api.anthropic.com/#fragment"),
            Some("https://API.ANTHROPIC.COM"),
            Some("https://api.anthropic.com.evil.test"),
        ] {
            assert!(!is_trusted_official_base_url(untrusted), "{untrusted:?}");
            let mut config = CcemConfig::default();
            config
                .registries
                .get_mut("official")
                .expect("official")
                .base_url = untrusted.map(str::to_string);
            assert!(
                validate_config_invariants(&config).is_err(),
                "{untrusted:?}"
            );
        }
    }

    #[test]
    fn direct_claude_oauth_is_never_allowed_for_third_party_environments() {
        let official = default_official_env();
        assert!(validate_claude_auth_boundary("official", &official).is_ok());

        let third_party_without_token = EnvConfig {
            base_url: Some("https://partner.example.com/anthropic".to_string()),
            auth_token: None,
            ..default_official_env()
        };
        assert!(validate_claude_auth_boundary("partner", &third_party_without_token).is_err());

        let third_party_with_token = EnvConfig {
            auth_token: Some("partner-token".to_string()),
            ..third_party_without_token
        };
        assert!(validate_claude_auth_boundary("partner", &third_party_with_token).is_ok());

        let redirected_official = EnvConfig {
            base_url: Some("https://partner.example.com/anthropic".to_string()),
            auth_token: Some("explicit-token".to_string()),
            ..default_official_env()
        };
        assert!(validate_claude_auth_boundary("official", &redirected_official).is_err());
    }

    #[test]
    fn config_normalization_restores_the_protected_official_environment() {
        let normalized = normalize_config(RawCcemConfig::default());

        assert!(normalized.registries.contains_key("official"));
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
            limit_write_tools: false,
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
    fn write_tool_limit_is_backward_compatible_and_persists_when_enabled() {
        let raw: RawEnvConfig =
            serde_json::from_str(r#"{"ANTHROPIC_BASE_URL":"https://example.com/anthropic"}"#)
                .expect("parse legacy environment");
        assert!(!normalize_env_config(raw).limit_write_tools);

        let mut env = default_official_env();
        env.limit_write_tools = true;
        let serialized = serde_json::to_value(&env).expect("serialize environment");
        assert_eq!(serialized["CCEM_LIMIT_WRITE_TOOLS"], true);
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
            limit_write_tools: false,
        };

        let error = get_env_with_decrypted_key(&env).expect_err("tampered v2 token should fail");

        assert!(
            !error.contains(tampered),
            "Error should not include encrypted token material"
        );
    }

    #[test]
    fn inject_ai_env_clears_managed_env_when_decryption_fails() {
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
                limit_write_tools: false,
            },
        );
        let config = CcemConfig {
            registries,
            current: Some("bad".to_string()),
            default_mode: Some("dev".to_string()),
            router: RouterConfig::default(),
        };
        let mut command = Command::new("env");
        command.env("ANTHROPIC_AUTH_TOKEN", "parent-token");

        inject_ai_env_from_config(&mut command, &config, Some("bad"));

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
                limit_write_tools: false,
            },
        );
        let mut current = CcemConfig {
            registries: current_registries,
            current: Some("glm".to_string()),
            default_mode: Some("dev".to_string()),
            router: RouterConfig::default(),
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
                limit_write_tools: false,
            },
        );
        let legacy = CcemConfig {
            registries: legacy_registries,
            current: Some("glm".to_string()),
            default_mode: Some("dev".to_string()),
            router: RouterConfig::default(),
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
            limit_write_tools: false,
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
            limit_write_tools: false,
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
