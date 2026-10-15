//! CCEM owns its agent state; launching a process must not inherit an official
//! application's login, config directory, or database location.
use std::collections::HashMap;
use std::process::Command;

use serde::Serialize;

use crate::agent_home;

pub const AUTH_OVERRIDE_KEYS: &[&str] = &[
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
    // Empty entries also override credentials exported by terminal shell startup
    // files. Explicit credentials from a selected CCEM environment are retained.
    for key in AUTH_OVERRIDE_KEYS {
        env.entry((*key).to_string()).or_default();
    }
    // Host-supplied account/config channels cannot be selected by a model entry.
    for key in std::env::vars_os().filter_map(|(key, _)| key.into_string().ok()) {
        if is_identity_override(&key) {
            env.entry(key).or_default();
        }
    }
    for (key, value) in env.iter_mut() {
        if is_identity_override(key) {
            value.clear();
        }
    }
    let claude = agent_home::claude_home().to_string_lossy().into_owned();
    let codex = agent_home::codex_home().to_string_lossy().into_owned();
    if let Some(base) = agent_home::claude_home().parent() {
        env.insert(
            "CCEM_AGENT_HOME".into(),
            base.to_string_lossy().into_owned(),
        );
    }
    env.insert("CLAUDE_CONFIG_DIR".into(), claude.clone());
    env.insert("CLAUDE_SECURESTORAGE_CONFIG_DIR".into(), claude);
    env.insert("CODEX_HOME".into(), codex.clone());
    env.insert("CODEX_SQLITE_HOME".into(), codex);
}

fn is_identity_override(key: &str) -> bool {
    key.starts_with("CLAUDE_CODE_OAUTH_")
        || key.starts_with("CLAUDE_CODE_HOST_")
        || key.starts_with("CLAUDE_CODE_ACCOUNT_")
        || key.starts_with("CLAUDE_COWORK_MEMORY_")
        || matches!(
            key,
            "CLAUDE_CODE_SESSION_ACCESS_TOKEN"
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
    for key in AUTH_OVERRIDE_KEYS {
        command.env_remove(key);
    }
    let explicit_identity_keys = command
        .get_envs()
        .filter_map(|(key, _)| {
            key.to_str()
                .filter(|key| is_identity_override(key))
                .map(str::to_string)
        })
        .collect::<Vec<_>>();
    for key in explicit_identity_keys {
        command.env_remove(key);
    }
    let mut env = HashMap::new();
    apply_env(client, &mut env);
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
}

#[tauri::command]
pub async fn get_agent_profiles() -> Result<Vec<AgentProfileStatus>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        agent_home::ensure_agent_homes()?;
        Ok([
            ("claude", agent_home::claude_home()),
            ("codex", agent_home::codex_home()),
        ]
        .into_iter()
        .map(|(provider, directory)| AgentProfileStatus {
            provider,
            initialized: directory.join(".ccem-migration-v1.json").is_file(),
            directory: directory.to_string_lossy().into_owned(),
        })
        .collect())
    })
    .await
    .map_err(|e| format!("Agent profile preparation failed: {e}"))?
}

#[tauri::command]
pub async fn login_agent_profile(provider: String) -> Result<(), String> {
    if !matches!(provider.as_str(), "claude" | "codex") {
        return Err("Unsupported agent provider".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        agent_home::ensure_agent_homes()?;
        crate::terminal::open_agent_login(&provider)
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
            ("CLAUDE_CONFIG_DIR".into(), "/official/claude".into()),
            ("CODEX_HOME".into(), "/official/codex".into()),
            ("ANTHROPIC_AUTH_TOKEN".into(), "selected-token".into()),
            ("CLAUDE_CODE_OAUTH_TOKEN".into(), "inherited-oauth".into()),
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
            env["CODEX_HOME"],
            agent_home::codex_home().to_string_lossy()
        );
        assert_eq!(env["CODEX_SQLITE_HOME"], env["CODEX_HOME"]);
        assert_eq!(env["ANTHROPIC_AUTH_TOKEN"], "selected-token");
        assert_eq!(env["CLAUDE_CODE_OAUTH_TOKEN"], "");
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
                agent_home::codex_home().display()
            )
        );
    }
}
