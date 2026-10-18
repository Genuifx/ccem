//! Claude uses CCEM-owned state. Codex shares official state by default and
//! pins the selected profile for the lifetime of each launched session.
use std::collections::HashMap;
use std::process::Command;
use std::sync::Arc;

use serde::Serialize;

use crate::agent_home;

pub const CODEX_ISOLATED_ENV: &str = "CCEM_CODEX_ISOLATED";

pub fn codex_isolated_for_env(env: &HashMap<String, String>) -> bool {
    match env.get(CODEX_ISOLATED_ENV).map(String::as_str) {
        Some("1") => true,
        Some("0") => false,
        _ => agent_home::codex_isolated(),
    }
}

/// Resolve once before adding a pin, so corrupt preferences cannot be hidden by
/// the safe fallback used for read-only path lookups.
pub fn prepare_env(client: &str, env: &mut HashMap<String, String>) -> Result<(), String> {
    if !matches!(client, "claude" | "codex") {
        return Ok(());
    }
    let inherited_pin = std::env::var(CODEX_ISOLATED_ENV).ok();
    let isolated = match env
        .get(CODEX_ISOLATED_ENV)
        .map(String::as_str)
        .or(inherited_pin.as_deref())
    {
        Some("1") => true,
        Some("0") => false,
        _ => agent_home::codex_isolation_preference()?,
    };
    agent_home::prepare_agent_homes_for_mode(isolated)?;
    env.insert(
        CODEX_ISOLATED_ENV.into(),
        if isolated { "1" } else { "0" }.into(),
    );
    apply_env(client, env);
    Ok(())
}

fn is_codex_auth_key(key: &str) -> bool {
    matches!(
        key,
        "OPENAI_API_KEY" | "CODEX_API_KEY" | "OPENAI_BASE_URL" | "CODEX_ACCESS_TOKEN"
    )
}

pub const AUTH_OVERRIDE_KEYS: &[&str] = &[
    "CLAUDE_CODE_PLUGIN_SEED_DIR",
    "CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_OAUTH_CLIENT_ID",
    "CLAUDE_CODE_OAUTH_SCOPES",
    "CLAUDE_CODE_DESIGN_OAUTH_CLIENT_ID",
    "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
    "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
    "CLAUDE_CODE_HOST_CREDS_FILE",
    "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
    "CLAUDE_CODE_HOST_AUTH_REFRESH_TIMEOUT_MS",
    "CLAUDE_CODE_ORGANIZATION_UUID",
    "CLAUDE_CODE_USER_EMAIL",
    "ANTHROPIC_PROFILE",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
    "CLAUDE_CODE_USE_GATEWAY",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "OPENAI_BASE_URL",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
    "AWS_BEARER_TOKEN_BEDROCK",
    "ANTHROPIC_AWS_API_KEY",
    "ANTHROPIC_FOUNDRY_API_KEY",
    "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
    "ANTHROPIC_FOUNDRY_RESOURCE",
    "ANTHROPIC_VERTEX_PROJECT_ID",
    "CLOUD_ML_REGION",
    "CODEX_ACCESS_TOKEN",
    "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
    "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "CLAUDE_CODE_ACCOUNT_UUID",
    "CLAUDE_CODE_ACCOUNT_TAGGED_ID",
    "CLAUDE_CODE_HFI_BEARER_TOKEN",
    "CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER",
    "CLAUDE_CODE_CUSTOM_OAUTH_URL",
    "CLAUDE_CODE_REMOTE_SETTINGS_PATH",
    "CLAUDE_CODE_MOCK_REMOTE_SETTINGS",
    "USE_LOCAL_OAUTH",
    "USE_STAGING_OAUTH",
    "CLAUDE_LOCAL_OAUTH_API_BASE",
];

pub fn apply_env(client: &str, env: &mut HashMap<String, String>) {
    if !matches!(client, "claude" | "codex") {
        return;
    }
    let isolated = codex_isolated_for_env(env);
    // Empty entries also override credentials exported by terminal shell startup
    // files. Explicit credentials from a selected CCEM environment are retained.
    for key in AUTH_OVERRIDE_KEYS {
        if !isolated && is_codex_auth_key(key) {
            continue;
        }
        env.entry((*key).to_string()).or_default();
    }
    // Host-supplied account/config channels cannot be selected by a model entry.
    for key in std::env::vars_os().filter_map(|(key, _)| key.into_string().ok()) {
        if is_identity_override(&key) && (isolated || !is_codex_auth_key(&key)) {
            env.entry(key).or_default();
        }
    }
    for (key, value) in env.iter_mut() {
        if is_identity_override(key) && (isolated || !is_codex_auth_key(key)) {
            value.clear();
        }
    }
    let claude = agent_home::claude_home().to_string_lossy().into_owned();
    let codex = agent_home::codex_home_for_mode(isolated)
        .to_string_lossy()
        .into_owned();
    if let Some(base) = agent_home::claude_home().parent() {
        env.insert(
            "CCEM_AGENT_HOME".into(),
            base.to_string_lossy().into_owned(),
        );
    }
    env.insert("CLAUDE_CONFIG_DIR".into(), claude.clone());
    env.insert(
        "CLAUDE_CODE_PLUGIN_CACHE_DIR".into(),
        agent_home::claude_home()
            .join("plugins")
            .to_string_lossy()
            .into_owned(),
    );
    env.insert("CLAUDE_SECURESTORAGE_CONFIG_DIR".into(), claude);
    env.insert("CODEX_HOME".into(), codex.clone());
    env.insert(
        CODEX_ISOLATED_ENV.into(),
        if isolated { "1" } else { "0" }.into(),
    );
    if isolated {
        env.insert("CODEX_SQLITE_HOME".into(), codex);
    } else if let Ok(value) = std::env::var("CODEX_SQLITE_HOME") {
        env.insert("CODEX_SQLITE_HOME".into(), value);
    } else {
        env.remove("CODEX_SQLITE_HOME");
    }
}

fn is_identity_override(key: &str) -> bool {
    key.starts_with("CLAUDE_CODE_OAUTH_")
        || key.starts_with("CLAUDE_CODE_HOST_")
        || key.starts_with("CLAUDE_CODE_ACCOUNT_")
        || key.starts_with("CLAUDE_COWORK_MEMORY_")
        || matches!(
            key,
            "CLAUDE_CODE_SESSION_ACCESS_TOKEN"
                | "CLAUDE_CODE_PLUGIN_SEED_DIR"
                | "CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE"
                | "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR"
                | "CLAUDE_CODE_ORGANIZATION_UUID"
                | "CLAUDE_CODE_USER_EMAIL"
                | "ANTHROPIC_PROFILE"
                | "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"
                | "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR"
                | "CLAUDE_CODE_HFI_BEARER_TOKEN"
                | "CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER"
                | "CLAUDE_CODE_CUSTOM_OAUTH_URL"
                | "CLAUDE_CODE_DESIGN_OAUTH_CLIENT_ID"
                | "CLAUDE_CODE_REMOTE_SETTINGS_PATH"
                | "CLAUDE_CODE_MOCK_REMOTE_SETTINGS"
                | "USE_LOCAL_OAUTH"
                | "USE_STAGING_OAUTH"
                | "CLAUDE_LOCAL_OAUTH_API_BASE"
                | "CODEX_ACCESS_TOKEN"
        )
}

pub fn configure_command(client: &str, command: &mut Command) {
    if !matches!(client, "claude" | "codex") {
        return;
    }
    let mut env = command
        .get_envs()
        .filter_map(|(key, value)| {
            (key == CODEX_ISOLATED_ENV)
                .then(|| {
                    value
                        .and_then(|value| value.to_str())
                        .map(|value| (CODEX_ISOLATED_ENV.into(), value.into()))
                })
                .flatten()
        })
        .collect::<HashMap<String, String>>();
    let isolated = codex_isolated_for_env(&env);
    for key in AUTH_OVERRIDE_KEYS {
        if !isolated && is_codex_auth_key(key) {
            continue;
        }
        command.env_remove(key);
    }
    let explicit_identity_keys = command
        .get_envs()
        .filter_map(|(key, _)| {
            key.to_str()
                .filter(|key| is_identity_override(key) && (isolated || !is_codex_auth_key(key)))
                .map(str::to_string)
        })
        .collect::<Vec<_>>();
    for key in explicit_identity_keys {
        command.env_remove(key);
    }
    apply_env(client, &mut env);
    if !isolated && !env.contains_key("CODEX_SQLITE_HOME") {
        command.env_remove("CODEX_SQLITE_HOME");
    }
    for (key, value) in env {
        if value.is_empty() {
            command.env_remove(key);
        } else {
            command.env(key, value);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfileStatus {
    pub provider: &'static str,
    pub directory: String,
    pub initialized: bool,
    pub isolated: bool,
}

fn profile_statuses() -> Result<Vec<AgentProfileStatus>, String> {
    let isolated = agent_home::codex_isolation_preference()?;
    Ok([
        ("claude", agent_home::claude_home(), true),
        ("codex", agent_home::codex_home_for_mode(isolated), isolated),
    ]
    .into_iter()
    .map(|(provider, directory, isolated)| AgentProfileStatus {
        provider,
        initialized: !isolated || directory.join(".ccem-migration-v1.json").is_file(),
        directory: directory.to_string_lossy().into_owned(),
        isolated,
    })
    .collect())
}

#[tauri::command]
pub async fn get_agent_profiles() -> Result<Vec<AgentProfileStatus>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        agent_home::prepare_agent_homes_for_mode(agent_home::codex_isolation_preference()?)?;
        profile_statuses()
    })
    .await
    .map_err(|e| format!("Agent profile preparation failed: {e}"))?
}

#[tauri::command]
pub async fn set_codex_isolation(
    isolated: bool,
    native_state: tauri::State<'_, Arc<crate::native_runtime::NativeRuntimeManager>>,
    environment_mutations: tauri::State<'_, Arc<crate::config::EnvironmentMutationCoordinator>>,
) -> Result<Vec<AgentProfileStatus>, String> {
    let native_state = native_state.inner().clone();
    let environment_mutations = environment_mutations.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = environment_mutations.lock()?;
        if isolated && agent_home::codex_isolation_needs_preparation()? {
            native_state.ensure_no_active_shared_codex_helpers()?;
        }
        agent_home::set_codex_isolation(isolated)?;
        profile_statuses()
    })
    .await
    .map_err(|error| format!("Agent profile update failed: {error}"))?
}

#[tauri::command]
pub async fn login_agent_profile(
    provider: String,
    environment_mutations: tauri::State<'_, Arc<crate::config::EnvironmentMutationCoordinator>>,
) -> Result<(), String> {
    if !matches!(provider.as_str(), "claude" | "codex") {
        return Err("Unsupported agent provider".into());
    }
    let environment_mutations = environment_mutations.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = environment_mutations.lock()?;
        let isolated = agent_home::codex_isolation_preference()?;
        if provider == "codex" && !isolated {
            return Err("Codex uses the official login. Enable isolation before signing in to a separate CCEM profile.".into());
        }
        agent_home::prepare_agent_homes_for_mode(isolated)?;
        crate::terminal::open_agent_login(&provider, isolated)
    })
    .await
    .map_err(|e| format!("Agent login launch failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_roots_override_callers_but_selected_api_token_is_preserved() {
        let mut env = HashMap::from([
            (CODEX_ISOLATED_ENV.into(), "1".into()),
            ("CLAUDE_CONFIG_DIR".into(), "/official/claude".into()),
            (
                "CLAUDE_CODE_PLUGIN_CACHE_DIR".into(),
                "/official/plugins".into(),
            ),
            ("CODEX_HOME".into(), "/official/codex".into()),
            ("ANTHROPIC_AUTH_TOKEN".into(), "selected-token".into()),
            ("CLAUDE_CODE_OAUTH_TOKEN".into(), "inherited-oauth".into()),
            (
                "CLAUDE_CODE_PLUGIN_SEED_DIR".into(),
                "/official/plugins".into(),
            ),
            ("CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE".into(), "1".into()),
        ]);
        apply_env("claude", &mut env);
        assert_eq!(
            env["CLAUDE_CONFIG_DIR"],
            agent_home::claude_home().to_string_lossy()
        );
        assert_eq!(
            env["CLAUDE_SECURESTORAGE_CONFIG_DIR"],
            env["CLAUDE_CONFIG_DIR"]
        );
        assert_eq!(
            env["CLAUDE_CODE_PLUGIN_CACHE_DIR"],
            agent_home::claude_home().join("plugins").to_string_lossy()
        );
        assert_eq!(
            env["CODEX_HOME"],
            agent_home::isolated_codex_home().to_string_lossy()
        );
        assert_eq!(env["CODEX_SQLITE_HOME"], env["CODEX_HOME"]);
        assert_eq!(env["ANTHROPIC_AUTH_TOKEN"], "selected-token");
        assert_eq!(env["CLAUDE_CODE_OAUTH_TOKEN"], "");
        assert_eq!(env["CLAUDE_CODE_PLUGIN_SEED_DIR"], "");
        assert_eq!(env["CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE"], "");
        assert_eq!(env["OPENAI_API_KEY"], "");
    }

    #[test]
    fn unrelated_clients_keep_their_environment() {
        let mut env = HashMap::from([("OPENCODE_CONFIG_CONTENT".into(), "{}".into())]);
        let original = env.clone();
        apply_env("opencode", &mut env);
        assert_eq!(env, original);
    }

    #[cfg(unix)]
    #[test]
    fn child_process_uses_owned_homes_and_cannot_inherit_host_login() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "printf '%s\\n' \"$CLAUDE_CONFIG_DIR\" \"$CODEX_HOME\" \"$CLAUDE_CODE_HOST_CREDS_FILE\" \"$CLAUDE_CODE_OAUTH_CUSTOM\" \"$ANTHROPIC_AUTH_TOKEN\""]);
        command
            .env(CODEX_ISOLATED_ENV, "1")
            .env("CLAUDE_CONFIG_DIR", "/official/claude")
            .env("CODEX_HOME", "/official/codex")
            .env("CLAUDE_CODE_HOST_CREDS_FILE", "/official/credentials")
            .env("CLAUDE_CODE_OAUTH_CUSTOM", "host-login")
            .env("ANTHROPIC_AUTH_TOKEN", "ambient-token");
        configure_command("claude", &mut command);
        let output = command.output().unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!(
                "{}\n{}\n\n\n\n",
                agent_home::claude_home().display(),
                agent_home::isolated_codex_home().display()
            )
        );
    }

    #[test]
    fn shared_pin_preserves_codex_auth_without_forcing_its_database() {
        let mut env = HashMap::from([
            (CODEX_ISOLATED_ENV.into(), "0".into()),
            ("CODEX_ACCESS_TOKEN".into(), "official-login".into()),
            ("OPENAI_API_KEY".into(), "official-api".into()),
            (
                "CODEX_SQLITE_HOME".into(),
                "/model-entry/must-not-redirect".into(),
            ),
            (
                "CLAUDE_CODE_OAUTH_TOKEN".into(),
                "official-claude-login".into(),
            ),
        ]);
        apply_env("codex", &mut env);
        assert_eq!(env[CODEX_ISOLATED_ENV], "0");
        assert_eq!(
            env["CODEX_HOME"],
            agent_home::codex_home_for_mode(false).to_string_lossy()
        );
        assert_eq!(
            env.get("CODEX_SQLITE_HOME"),
            std::env::var("CODEX_SQLITE_HOME").ok().as_ref()
        );
        assert_eq!(env["CODEX_ACCESS_TOKEN"], "official-login");
        assert_eq!(env["OPENAI_API_KEY"], "official-api");
        assert_eq!(env["CLAUDE_CODE_OAUTH_TOKEN"], "");
    }

    #[cfg(unix)]
    #[test]
    fn shared_command_keeps_official_codex_login() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "printf '%s\\n' \"$CCEM_CODEX_ISOLATED\" \"$CODEX_ACCESS_TOKEN\" \"$OPENAI_API_KEY\" \"$CLAUDE_CODE_OAUTH_TOKEN\""]);
        command
            .env(CODEX_ISOLATED_ENV, "0")
            .env("CODEX_ACCESS_TOKEN", "official-login")
            .env("OPENAI_API_KEY", "official-api")
            .env("CLAUDE_CODE_OAUTH_TOKEN", "claude-login");
        configure_command("codex", &mut command);
        let output = command.output().unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            "0\nofficial-login\nofficial-api\n\n"
        );
    }
}
