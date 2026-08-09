use crate::terminal::{self, CachedCodexRuntime};
use base64::Engine;
use chrono::{NaiveDate, Utc};
use rand::RngCore;
use serde::Serialize;
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const AFFECTED_MODEL: &str = "gpt-5.4";
const AFFECTED_MINI_MODEL: &str = "gpt-5.4-mini";
const TERRA_REPLACEMENT: &str = "gpt-5.6-terra";
const LUNA_REPLACEMENT: &str = "gpt-5.6-luna";
const LAST_REMINDER_DATE: (i32, u32, u32) = (2026, 8, 31);
const MAX_CONFIG_BYTES: u64 = 1024 * 1024;
const MAX_AUTH_BYTES: u64 = 4 * 1024 * 1024;
const PROOF_VERSION: &[u8] = b"ccem-codex-model-migration-v2";
static PROOF_SALT: OnceLock<[u8; 32]> = OnceLock::new();

pub const PREFLIGHT_CHANGED_ERROR: &str = "codex_migration_preflight_changed";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexModelMigrationPreflightResult {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replacement: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proof_token: Option<String>,
}

impl CodexModelMigrationPreflightResult {
    fn unknown() -> Self {
        Self {
            status: "unknown",
            model: None,
            replacement: None,
            proof_token: None,
        }
    }

    fn affected(model: &'static str, replacement: &'static str, proof_token: String) -> Self {
        Self {
            status: "affected",
            model: Some(model),
            replacement: Some(replacement),
            proof_token: Some(proof_token),
        }
    }

    fn is_affected(&self) -> bool {
        self.status == "affected"
    }
}

#[derive(Debug, Clone)]
struct PreflightRuntime {
    path: String,
    version: String,
    binary_sha256: String,
}

impl From<CachedCodexRuntime> for PreflightRuntime {
    fn from(runtime: CachedCodexRuntime) -> Self {
        Self {
            path: runtime.path,
            version: runtime.version,
            binary_sha256: runtime.binary_sha256,
        }
    }
}

#[derive(Debug, Clone)]
struct PreflightContext {
    codex_home: PathBuf,
    working_dir: PathBuf,
    env_name: String,
    runtime: PreflightRuntime,
    has_process_auth_override: bool,
    has_unknown_codex_env: bool,
    managed_preferences_present: bool,
    system_layer_paths: Vec<PathBuf>,
    now_epoch_seconds: i64,
}

#[derive(Debug)]
struct PreflightEvaluation {
    result: CodexModelMigrationPreflightResult,
    runtime_path: Option<String>,
}

#[tauri::command]
pub fn preflight_codex_model_migration(
    env_name: String,
    working_dir: String,
) -> CodexModelMigrationPreflightResult {
    evaluate_live(&env_name, &working_dir).result
}

/// Re-evaluate immediately inside `create_native_session`, before CCEM opens
/// its own config or starts the runtime. An affected launch must carry the
/// exact proof shown to the user; unknown results intentionally fail open.
pub fn runtime_path_for_verified_launch(
    env_name: &str,
    working_dir: &str,
    proof_token: Option<&str>,
) -> Result<Option<String>, String> {
    require_matching_proof(evaluate_live(env_name, working_dir), proof_token)
}

fn require_matching_proof(
    evaluation: PreflightEvaluation,
    proof_token: Option<&str>,
) -> Result<Option<String>, String> {
    // A missing proof means the read-only preflight channel failed or returned
    // unknown. That path is deliberately fail-open. Once the UI supplies a
    // proof, creation stays bound to the exact facts it confirmed.
    let Some(proof_token) = proof_token else {
        return Ok(None);
    };
    if !evaluation.result.is_affected() {
        return Ok(None);
    }

    if evaluation.result.proof_token.as_deref() != Some(proof_token) {
        return Err(PREFLIGHT_CHANGED_ERROR.to_string());
    }

    Ok(evaluation.runtime_path)
}

fn evaluate_live(env_name: &str, working_dir: &str) -> PreflightEvaluation {
    let unknown = || PreflightEvaluation {
        result: CodexModelMigrationPreflightResult::unknown(),
        runtime_path: None,
    };

    let Some(runtime) = terminal::cached_codex_runtime().map(PreflightRuntime::from) else {
        return unknown();
    };
    let working_dir = PathBuf::from(working_dir);
    if working_dir.as_os_str().is_empty() {
        return unknown();
    }
    let Some(codex_home) = resolve_codex_home(&working_dir) else {
        return unknown();
    };
    let layer_paths = system_layer_paths(&codex_home);

    evaluate(PreflightContext {
        codex_home,
        working_dir,
        env_name: env_name.to_string(),
        runtime,
        has_process_auth_override: has_process_auth_override(),
        has_unknown_codex_env: has_unknown_codex_environment(),
        managed_preferences_present: managed_preferences_present(),
        system_layer_paths: layer_paths,
        now_epoch_seconds: Utc::now().timestamp(),
    })
}

fn evaluate(context: PreflightContext) -> PreflightEvaluation {
    let unknown = || PreflightEvaluation {
        result: CodexModelMigrationPreflightResult::unknown(),
        runtime_path: None,
    };

    if !reminder_is_active(context.now_epoch_seconds)
        || !runtime_version_is_supported(&context.runtime.version)
        || context.has_process_auth_override
        || context.has_unknown_codex_env
        || context.managed_preferences_present
        || has_any_system_layer(&context.system_layer_paths)
    {
        return unknown();
    }

    let Ok(working_dir) = fs::canonicalize(&context.working_dir) else {
        return unknown();
    };
    if !working_dir.is_dir() {
        return unknown();
    }

    let config_path = context.codex_home.join("config.toml");
    if has_project_config_surface(&working_dir, &config_path) {
        return unknown();
    }

    let Some(config_bytes) = read_stable_file(&config_path, MAX_CONFIG_BYTES) else {
        return unknown();
    };
    let Ok(config_text) = std::str::from_utf8(&config_bytes) else {
        return unknown();
    };
    let Ok(config) = toml::from_str::<toml::Value>(config_text) else {
        return unknown();
    };
    let Some((model, replacement)) = classify_config(&config) else {
        return unknown();
    };

    let auth_path = context.codex_home.join("auth.json");
    let Some(auth_bytes) = read_stable_file(&auth_path, MAX_AUTH_BYTES) else {
        return unknown();
    };
    let Ok(auth) = serde_json::from_slice::<JsonValue>(&auth_bytes) else {
        return unknown();
    };
    if !is_provable_personal_chatgpt_auth(&auth, context.now_epoch_seconds) {
        return unknown();
    }

    let proof_token = build_proof_token(
        &context,
        &working_dir,
        &config_bytes,
        &auth_bytes,
        model,
        replacement,
    );
    PreflightEvaluation {
        result: CodexModelMigrationPreflightResult::affected(model, replacement, proof_token),
        runtime_path: Some(context.runtime.path),
    }
}

fn resolve_codex_home(working_dir: &Path) -> Option<PathBuf> {
    let home_dir = dirs::home_dir()?;
    let raw = std::env::var("CODEX_HOME").ok();
    let path = raw
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(|value| resolve_path_value(value, &home_dir, working_dir))
        .unwrap_or_else(|| home_dir.join(".codex"));
    let canonical = fs::canonicalize(path).ok()?;
    canonical.is_dir().then_some(canonical)
}

fn resolve_path_value(raw: &str, home_dir: &Path, relative_base: &Path) -> PathBuf {
    if raw == "~" {
        return home_dir.to_path_buf();
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        return home_dir.join(rest);
    }
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        path
    } else {
        relative_base.join(path)
    }
}

fn has_process_auth_override() -> bool {
    std::env::vars_os().any(|(key, value)| {
        let Some(key) = key.to_str() else {
            return false;
        };
        !value.is_empty() && is_process_auth_override_key(key, cfg!(windows))
    })
}

fn has_unknown_codex_environment() -> bool {
    std::env::vars_os().any(|(key, value)| {
        let Some(key) = key.to_str() else {
            return false;
        };
        !value.is_empty() && is_unknown_codex_environment_key(key, cfg!(windows))
    })
}

fn is_process_auth_override_key(key: &str, case_insensitive: bool) -> bool {
    env_key_eq(key, "CODEX_API_KEY", case_insensitive)
        || env_key_eq(key, "CODEX_ACCESS_TOKEN", case_insensitive)
        || env_key_has_prefix(key, "OPENAI_", case_insensitive)
}

fn is_unknown_codex_environment_key(key: &str, case_insensitive: bool) -> bool {
    env_key_has_prefix(key, "CODEX_", case_insensitive)
        && !env_key_eq(key, "CODEX_HOME", case_insensitive)
}

fn env_key_eq(actual: &str, expected: &str, case_insensitive: bool) -> bool {
    if case_insensitive {
        actual.eq_ignore_ascii_case(expected)
    } else {
        actual == expected
    }
}

fn env_key_has_prefix(actual: &str, prefix: &str, case_insensitive: bool) -> bool {
    actual
        .get(..prefix.len())
        .is_some_and(|candidate| env_key_eq(candidate, prefix, case_insensitive))
}

fn reminder_is_active(now_epoch_seconds: i64) -> bool {
    let Some(now) = chrono::DateTime::from_timestamp(now_epoch_seconds, 0) else {
        return false;
    };
    let Some(last_date) = NaiveDate::from_ymd_opt(
        LAST_REMINDER_DATE.0,
        LAST_REMINDER_DATE.1,
        LAST_REMINDER_DATE.2,
    ) else {
        return false;
    };
    now.date_naive() <= last_date
}

fn runtime_version_is_supported(raw: &str) -> bool {
    matches!(raw, "0.139.0" | "0.147.0-alpha.6.5")
}

fn system_layer_paths(_codex_home: &Path) -> Vec<PathBuf> {
    #[cfg(unix)]
    {
        return [
            "/etc/codex/config.toml",
            "/etc/codex/requirements.toml",
            "/etc/codex/managed_config.toml",
        ]
        .into_iter()
        .map(PathBuf::from)
        .collect();
    }

    #[cfg(windows)]
    {
        let base = std::env::var_os("ProgramData")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"))
            .join("OpenAI")
            .join("Codex");
        let mut paths: Vec<PathBuf> = ["config.toml", "requirements.toml"]
            .into_iter()
            .map(|name| base.join(name))
            .collect();
        paths.push(_codex_home.join("managed_config.toml"));
        return paths;
    }

    #[allow(unreachable_code)]
    {
        let _ = _codex_home;
        Vec::new()
    }
}

fn has_any_system_layer(paths: &[PathBuf]) -> bool {
    paths
        .iter()
        .any(|path| !matches!(path.try_exists(), Ok(false)))
}

fn has_project_config_surface(working_dir: &Path, user_config_path: &Path) -> bool {
    let user_config_canonical = fs::canonicalize(user_config_path).ok();
    let mut candidates = BTreeSet::new();
    candidates.insert(working_dir.join("config.toml"));
    for ancestor in working_dir.ancestors() {
        candidates.insert(ancestor.join(".codex").join("config.toml"));
    }

    candidates.into_iter().any(|candidate| {
        let exists = candidate.try_exists();
        if matches!(exists, Ok(false)) {
            return false;
        }
        if exists.is_err() {
            return true;
        }
        match (fs::canonicalize(&candidate), user_config_canonical.as_ref()) {
            (Ok(candidate), Some(user)) if &candidate == user => false,
            _ => true,
        }
    })
}

fn read_stable_file(path: &Path, max_bytes: u64) -> Option<Vec<u8>> {
    let link_metadata = fs::symlink_metadata(path).ok()?;
    if link_metadata.file_type().is_symlink() || !link_metadata.is_file() {
        return None;
    }

    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    let mut file = options.open(path).ok()?;
    let before = file.metadata().ok()?;
    if !before.is_file() || before.len() == 0 || before.len() > max_bytes {
        return None;
    }
    let mut contents = Vec::with_capacity(before.len() as usize);
    file.by_ref()
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut contents)
        .ok()?;
    let after = file.metadata().ok()?;
    if contents.len() as u64 != before.len()
        || after.len() != before.len()
        || after.modified().ok()? != before.modified().ok()?
        || !after.is_file()
    {
        return None;
    }
    Some(contents)
}

fn classify_config(config: &toml::Value) -> Option<(&'static str, &'static str)> {
    let table = config.as_table()?;
    if has_unreviewed_config_key(table.keys().map(String::as_str)) {
        return None;
    }
    if table.contains_key("profile")
        || table.contains_key("profiles")
        || table.contains_key("forced_chatgpt_workspace_id")
        || table.contains_key("project_root_markers")
        || table.contains_key("openai_base_url")
        || table.contains_key("chatgpt_base_url")
    {
        return None;
    }

    match table.get("model_provider") {
        None => {}
        Some(value) if value.as_str() == Some("openai") => {}
        _ => return None,
    }
    match table.get("cli_auth_credentials_store") {
        None => {}
        Some(value) if value.as_str() == Some("file") => {}
        _ => return None,
    }
    match table.get("forced_login_method") {
        None => {}
        Some(value) if value.as_str() == Some("chatgpt") => {}
        _ => return None,
    }
    if let Some(value) = table.get("model_providers") {
        let providers = value.as_table()?;
        if providers.contains_key("openai") {
            return None;
        }
    }

    match table.get("model").and_then(toml::Value::as_str) {
        Some(AFFECTED_MODEL) => Some((AFFECTED_MODEL, TERRA_REPLACEMENT)),
        Some(AFFECTED_MINI_MODEL) => Some((AFFECTED_MINI_MODEL, LUNA_REPLACEMENT)),
        _ => None,
    }
}

fn has_unreviewed_config_key<'a>(mut keys: impl Iterator<Item = &'a str>) -> bool {
    const REVIEWED_KEYS: &[&str] = &[
        "approval_policy",
        "check_for_update_on_startup",
        "cli_auth_credentials_store",
        "disable_response_storage",
        "features",
        "file_opener",
        "forced_login_method",
        "hide_agent_reasoning",
        "history",
        "mcp_servers",
        "model",
        "model_provider",
        "model_providers",
        "model_reasoning_effort",
        "model_reasoning_summary",
        "model_verbosity",
        "notify",
        "personality",
        "project_doc_fallback_filenames",
        "project_doc_max_bytes",
        "projects",
        "sandbox_mode",
        "show_raw_agent_reasoning",
        "tools",
        "tui",
        "web_search",
        "windows",
    ];
    keys.any(|key| !REVIEWED_KEYS.contains(&key))
}

fn is_provable_personal_chatgpt_auth(auth: &JsonValue, now_epoch_seconds: i64) -> bool {
    let Some(auth) = auth.as_object() else {
        return false;
    };
    const AUTH_KEYS: &[&str] = &[
        "auth_mode",
        "OPENAI_API_KEY",
        "tokens",
        "last_refresh",
        "agent_identity",
        "personal_access_token",
        "bedrock_api_key",
    ];
    let auth_mode_is_chatgpt = match auth.get("auth_mode") {
        None | Some(JsonValue::Null) => true,
        Some(JsonValue::String(mode)) => mode == "chatgpt",
        _ => false,
    };
    if auth.keys().any(|key| !AUTH_KEYS.contains(&key.as_str()))
        || !auth_mode_is_chatgpt
        || auth
            .get("OPENAI_API_KEY")
            .is_some_and(|value| !value.is_null())
        || auth
            .get("agent_identity")
            .is_some_and(|value| !value.is_null())
        || auth
            .get("personal_access_token")
            .is_some_and(|value| !value.is_null())
        || auth
            .get("bedrock_api_key")
            .is_some_and(|value| !value.is_null())
    {
        return false;
    }
    let Some(last_refresh) = auth.get("last_refresh").and_then(JsonValue::as_str) else {
        return false;
    };
    if chrono::DateTime::parse_from_rfc3339(last_refresh).is_err() {
        return false;
    }

    let Some(tokens) = auth.get("tokens").and_then(JsonValue::as_object) else {
        return false;
    };
    const TOKEN_KEYS: &[&str] = &["id_token", "access_token", "refresh_token", "account_id"];
    if tokens.keys().any(|key| !TOKEN_KEYS.contains(&key.as_str()))
        || !matches!(
            tokens.get("account_id"),
            None | Some(JsonValue::Null) | Some(JsonValue::String(_))
        )
    {
        return false;
    }
    let Some(id_token) = tokens.get("id_token").and_then(JsonValue::as_str) else {
        return false;
    };
    let Some(access_token) = tokens.get("access_token").and_then(JsonValue::as_str) else {
        return false;
    };
    if tokens
        .get("refresh_token")
        .and_then(JsonValue::as_str)
        .is_none_or(str::is_empty)
        || id_token.is_empty()
        || access_token.is_empty()
        || !jwt_is_current(access_token, now_epoch_seconds, 5 * 60)
    {
        return false;
    }

    let Some(claims) = decode_jwt_payload(id_token) else {
        return false;
    };
    if claims.get("exp").and_then(JsonValue::as_i64) <= Some(now_epoch_seconds + 5 * 60) {
        return false;
    }
    let Some(openai_auth) = claims
        .get("https://api.openai.com/auth")
        .and_then(JsonValue::as_object)
    else {
        return false;
    };
    if !matches!(
        openai_auth.get("chatgpt_account_is_fedramp"),
        None | Some(JsonValue::Bool(false))
    ) || !json_is_absent_null_or_string(openai_auth.get("chatgpt_user_id"))
        || !json_is_absent_null_or_string(openai_auth.get("user_id"))
        || !json_is_absent_null_or_string(openai_auth.get("chatgpt_account_id"))
    {
        return false;
    }
    let user_id = openai_auth
        .get("chatgpt_user_id")
        .or_else(|| openai_auth.get("user_id"))
        .and_then(JsonValue::as_str)
        .filter(|value| !value.is_empty());
    if user_id.is_none() {
        return false;
    }
    if let (Some(token_account_id), Some(claim_account_id)) = (
        tokens
            .get("account_id")
            .and_then(JsonValue::as_str)
            .filter(|value| !value.is_empty()),
        openai_auth
            .get("chatgpt_account_id")
            .and_then(JsonValue::as_str)
            .filter(|value| !value.is_empty()),
    ) {
        if token_account_id != claim_account_id {
            return false;
        }
    }

    matches!(
        openai_auth
            .get("chatgpt_plan_type")
            .and_then(JsonValue::as_str),
        Some("free" | "go" | "plus" | "pro" | "prolite")
    )
}

fn json_is_absent_null_or_string(value: Option<&JsonValue>) -> bool {
    matches!(
        value,
        None | Some(JsonValue::Null) | Some(JsonValue::String(_))
    )
}

fn jwt_is_current(jwt: &str, now_epoch_seconds: i64, minimum_seconds: i64) -> bool {
    decode_jwt_payload(jwt)
        .and_then(|claims| claims.get("exp").and_then(JsonValue::as_i64))
        .is_some_and(|expiration| expiration > now_epoch_seconds + minimum_seconds)
}

fn decode_jwt_payload(jwt: &str) -> Option<JsonValue> {
    let mut parts = jwt.split('.');
    let header = parts.next()?;
    let payload = parts.next()?;
    let signature = parts.next()?;
    if header.is_empty() || payload.is_empty() || signature.is_empty() || parts.next().is_some() {
        return None;
    }
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(payload))
        .ok()?;
    serde_json::from_slice(&decoded).ok()
}

fn build_proof_token(
    context: &PreflightContext,
    working_dir: &Path,
    config_bytes: &[u8],
    auth_bytes: &[u8],
    model: &str,
    replacement: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(proof_salt());
    for component in [
        PROOF_VERSION,
        context.env_name.as_bytes(),
        context.codex_home.as_os_str().as_encoded_bytes(),
        working_dir.as_os_str().as_encoded_bytes(),
        context.runtime.path.as_bytes(),
        context.runtime.version.as_bytes(),
        context.runtime.binary_sha256.as_bytes(),
        model.as_bytes(),
        replacement.as_bytes(),
        config_bytes,
        auth_bytes,
    ] {
        hasher.update((component.len() as u64).to_le_bytes());
        hasher.update(component);
    }
    hex::encode(hasher.finalize())
}

fn proof_salt() -> &'static [u8; 32] {
    PROOF_SALT.get_or_init(|| {
        let mut salt = [0_u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut salt);
        salt
    })
}

#[cfg(target_os = "macos")]
fn managed_preferences_present() -> bool {
    ["config_toml_base64", "requirements_toml_base64"]
        .into_iter()
        .any(|key| macos_managed_preference_exists(key).unwrap_or(true))
}

#[cfg(target_os = "macos")]
fn macos_managed_preference_exists(key: &str) -> Option<bool> {
    use std::ffi::{c_char, c_void, CString};

    type CfStringRef = *const c_void;
    const UTF8_ENCODING: u32 = 0x0800_0100;
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringCreateWithCString(
            allocator: *const c_void,
            text: *const c_char,
            encoding: u32,
        ) -> CfStringRef;
        fn CFPreferencesCopyAppValue(
            key: CfStringRef,
            application_id: CfStringRef,
        ) -> *const c_void;
        fn CFRelease(value: *const c_void);
    }

    let key = CString::new(key).ok()?;
    let application_id = CString::new("com.openai.codex").ok()?;
    unsafe {
        let key_ref = CFStringCreateWithCString(std::ptr::null(), key.as_ptr(), UTF8_ENCODING);
        let app_ref =
            CFStringCreateWithCString(std::ptr::null(), application_id.as_ptr(), UTF8_ENCODING);
        if key_ref.is_null() || app_ref.is_null() {
            if !key_ref.is_null() {
                CFRelease(key_ref);
            }
            if !app_ref.is_null() {
                CFRelease(app_ref);
            }
            return None;
        }
        let value = CFPreferencesCopyAppValue(key_ref, app_ref);
        CFRelease(key_ref);
        CFRelease(app_ref);
        if !value.is_null() {
            CFRelease(value);
        }
        Some(!value.is_null())
    }
}

#[cfg(not(target_os = "macos"))]
fn managed_preferences_present() -> bool {
    false
}

#[cfg(test)]
#[path = "codex_migration_tests.rs"]
mod tests;
