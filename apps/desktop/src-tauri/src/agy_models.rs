use crate::{system_proxy, terminal};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const CACHE_TTL: Duration = Duration::from_secs(600);
const CLI_TIMEOUT: Duration = Duration::from_secs(15);

const EFFORT_ORDER: &[&str] = &["minimal", "low", "medium", "high", "xhigh", "max"];
const AGY_STRIPPED_ENV_KEYS: &[&str] = &[
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    "CLAUDE_CODE_PLUGIN_CACHE_DIR",
    "CODEX_HOME",
    "CODEX_SQLITE_HOME",
    "CCEM_CODEX_ISOLATED",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgyModelCatalogItem {
    pub id: String,
    pub name: String,
    pub efforts: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgyModelCatalogResponse {
    pub models: Vec<AgyModelCatalogItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    pub source: String,
}

#[derive(Debug, Clone)]
struct CachedCatalog {
    agy_path: String,
    fetched_at: Instant,
    models: Vec<AgyModelCatalogItem>,
    default_model: Option<String>,
}

static CATALOG_CACHE: OnceLock<Mutex<Option<CachedCatalog>>> = OnceLock::new();

fn cache_lock() -> &'static Mutex<Option<CachedCatalog>> {
    CATALOG_CACHE.get_or_init(|| Mutex::new(None))
}

pub fn invalidate_cache() {
    if let Ok(mut guard) = cache_lock().lock() {
        *guard = None;
    }
}

fn strip_ansi_sequences(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            if matches!(chars.peek(), Some('[')) {
                chars.next();
                while let Some(next) = chars.next() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(ch);
    }
    out
}

fn is_valid_model_id_token(token: &str) -> bool {
    let bytes = token.as_bytes();
    if bytes.is_empty()
        || bytes.len() > 256
        || !bytes[0].is_ascii_alphanumeric()
        || !bytes[bytes.len() - 1].is_ascii_alphanumeric()
        || token.contains("..")
    {
        return false;
    }
    if !token.contains('-') && !token.contains('.') && !token.contains('_') {
        return false;
    }
    bytes
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || b"._:/-".contains(b))
}

fn split_effort_suffix(raw_id: &str) -> Option<(&str, &str)> {
    for &effort in EFFORT_ORDER {
        if let Some(base) = raw_id.strip_suffix(&format!("-{effort}")) {
            if !base.is_empty() {
                return Some((base, effort));
            }
        }
    }
    None
}

fn strip_trailing_effort_parens(display_name: &str) -> String {
    let trimmed = display_name.trim();
    if let Some(open_idx) = trimmed.rfind('(') {
        if trimmed.ends_with(')') && open_idx > 0 {
            let inner = trimmed[open_idx + 1..trimmed.len() - 1]
                .trim()
                .to_ascii_lowercase();
            if matches!(
                inner.as_str(),
                "minimal" | "low" | "medium" | "high" | "xhigh" | "extra" | "extra high" | "max"
            ) {
                let candidate = trimmed[..open_idx].trim();
                if !candidate.is_empty() {
                    return candidate.to_string();
                }
            }
        }
    }
    trimmed.to_string()
}

fn effort_rank(effort: &str) -> usize {
    EFFORT_ORDER
        .iter()
        .position(|&candidate| candidate == effort)
        .unwrap_or(EFFORT_ORDER.len())
}

#[derive(Debug, Clone)]
struct ParsedVariant {
    raw_id: String,
    display_name: String,
    effort: Option<String>,
}

/// Parse stdout from `agy models` into base models with per-model supported efforts.
///
/// Mirrors `agy acp`'s own `configOptions` grouping:
/// - Models advertised with multiple effort variants (e.g. `gemini-4-neon-low/medium/high/xhigh`)
///   collapse into a single base model (`gemini-4-neon`) with `efforts: ["low", "medium", "high", "xhigh"]`.
/// - Standalone models with only one variant (including ones whose ID happens to end with `-medium`,
///   such as `gpt-oss-120b-medium`) stay unstripped with `efforts: []`.
pub fn parse_agy_models_output(raw: &str) -> Vec<AgyModelCatalogItem> {
    let cleaned = strip_ansi_sequences(raw);
    let mut group_order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<ParsedVariant>> = HashMap::new();
    let mut seen_raw_ids: HashSet<String> = HashSet::new();

    for raw_line in cleaned.lines() {
        // Spinner animations overwrite the current line using '\r'; keep the final segment.
        let segment = raw_line.rsplit('\r').next().unwrap_or(raw_line).trim();
        if segment.is_empty() {
            continue;
        }
        let mut parts = segment.splitn(2, char::is_whitespace);
        let Some(token) = parts.next().map(str::trim) else {
            continue;
        };
        if !is_valid_model_id_token(token) || !seen_raw_ids.insert(token.to_string()) {
            continue;
        }
        let display_name = parts
            .next()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .unwrap_or(token)
            .to_string();

        let (group_key, effort) = match split_effort_suffix(token) {
            Some((base, suffix)) => (base.to_string(), Some(suffix.to_string())),
            None => (token.to_string(), None),
        };

        if !groups.contains_key(&group_key) {
            group_order.push(group_key.clone());
        }
        groups.entry(group_key).or_default().push(ParsedVariant {
            raw_id: token.to_string(),
            display_name,
            effort,
        });
    }

    let mut catalog = Vec::with_capacity(group_order.len());
    for group_key in group_order {
        let Some(variants) = groups.remove(&group_key) else {
            continue;
        };
        let mut distinct_efforts: Vec<String> = Vec::new();
        for variant in &variants {
            if let Some(effort) = variant.effort.as_ref() {
                if !distinct_efforts.iter().any(|existing| existing == effort) {
                    distinct_efforts.push(effort.clone());
                }
            }
        }

        if distinct_efforts.len() >= 2 {
            let first_seen_effort = distinct_efforts.first().cloned();
            distinct_efforts.sort_by_key(|effort| effort_rank(effort));
            let default_effort = first_seen_effort.or_else(|| {
                if distinct_efforts.iter().any(|e| e == "high") {
                    Some("high".to_string())
                } else {
                    distinct_efforts.first().cloned()
                }
            });
            let name = variants
                .first()
                .map(|variant| strip_trailing_effort_parens(&variant.display_name))
                .unwrap_or_else(|| group_key.clone());
            catalog.push(AgyModelCatalogItem {
                id: group_key,
                name,
                efforts: distinct_efforts,
                default_effort,
            });
        } else {
            for single in variants {
                catalog.push(AgyModelCatalogItem {
                    id: single.raw_id,
                    name: single.display_name,
                    efforts: Vec::new(),
                    default_effort: None,
                });
            }
        }
    }

    catalog
}

fn is_disallowed_agy_env_key(key: &str) -> bool {
    key.starts_with("ANTHROPIC_") || AGY_STRIPPED_ENV_KEYS.contains(&key)
}

fn is_auth_required_message(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("authentication required")
        || lower.contains("not signed in")
        || lower.contains("not logged in")
        || lower.contains("sign in with google")
        || lower.contains("unauthenticated")
}

fn run_agy_models_cli(agy_path: &str) -> Result<String, String> {
    let mut cmd = Command::new(agy_path);
    cmd.arg("models")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    cmd.env_clear();
    for (key, value) in std::env::vars() {
        if !is_disallowed_agy_env_key(&key) {
            cmd.env(key, value);
        }
    }
    let user_path = terminal::get_user_path();
    if !user_path.is_empty() {
        cmd.env("PATH", user_path);
    }
    for (key, value) in system_proxy::resolve_codex_proxy_env() {
        if key != "HOME" && !is_disallowed_agy_env_key(&key) && !value.is_empty() {
            cmd.env(key, value);
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|error| format!("Failed to run Antigravity CLI ({agy_path} models): {error}"))?;

    // Drain stdout and stderr concurrently so large outputs can never deadlock the pipe buffer.
    let stdout_handle = child.stdout.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            String::from_utf8_lossy(&buf).to_string()
        })
    });
    let stderr_handle = child.stderr.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            String::from_utf8_lossy(&buf).to_string()
        })
    });

    let deadline = Instant::now() + CLI_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    if let Some(handle) = stdout_handle {
                        let _ = handle.join();
                    }
                    if let Some(handle) = stderr_handle {
                        let _ = handle.join();
                    }
                    return Err("Timed out fetching Antigravity models.".to_string());
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                if let Some(handle) = stdout_handle {
                    let _ = handle.join();
                }
                if let Some(handle) = stderr_handle {
                    let _ = handle.join();
                }
                return Err(format!("Failed while waiting for agy models: {error}"));
            }
        }
    };

    let stdout = stdout_handle
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();
    let stderr = stderr_handle
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();

    if !status.success() {
        let combined = format!("{}\n{}", stderr.trim(), stdout.trim());
        if is_auth_required_message(&combined) {
            return Err(
                "AGY_AUTH_REQUIRED: Antigravity is not signed in. Sign in with Google to continue."
                    .to_string(),
            );
        }
        let detail = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else if !stdout.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            format!("exited with status {status}")
        };
        return Err(format!("Antigravity model discovery failed: {detail}"));
    }

    if stdout.trim().is_empty() && is_auth_required_message(&stderr) {
        return Err(
            "AGY_AUTH_REQUIRED: Antigravity is not signed in. Sign in with Google to continue."
                .to_string(),
        );
    }

    Ok(stdout)
}

pub fn list_agy_models(force_refresh: bool) -> Result<AgyModelCatalogResponse, String> {
    let agy_path = terminal::resolve_agy_path()
        .ok_or_else(|| "Antigravity CLI (agy) is not installed.".to_string())?;

    if !force_refresh {
        if let Ok(guard) = cache_lock().lock() {
            if let Some(cached) = guard.as_ref() {
                if cached.agy_path == agy_path
                    && !cached.models.is_empty()
                    && cached.fetched_at.elapsed() < CACHE_TTL
                {
                    return Ok(AgyModelCatalogResponse {
                        models: cached.models.clone(),
                        default_model: cached.default_model.clone(),
                        source: "cache".to_string(),
                    });
                }
            }
        }
    }

    let raw = run_agy_models_cli(&agy_path)?;
    let models = parse_agy_models_output(&raw);
    if models.is_empty() && is_auth_required_message(&raw) {
        return Err(
            "AGY_AUTH_REQUIRED: Antigravity is not signed in. Sign in with Google to continue."
                .to_string(),
        );
    }
    let default_model = models.first().map(|item| item.id.clone());

    if !models.is_empty() {
        if let Ok(mut guard) = cache_lock().lock() {
            *guard = Some(CachedCatalog {
                agy_path,
                fetched_at: Instant::now(),
                models: models.clone(),
                default_model: default_model.clone(),
            });
        }
    }

    Ok(AgyModelCatalogResponse {
        models,
        default_model,
        source: "cli".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::{parse_agy_models_output, AgyModelCatalogItem};

    #[test]
    fn parses_real_agy_models_output_matching_acp_config_options() {
        let sample = concat!(
            "\r\x1b[2K⠋ Fetching available models...\r",
            "gemini-4-neon-high              Gemini 4 Neon (High)\n",
            "gemini-4-neon-xhigh             Gemini 4 Neon (XHigh)\n",
            "gemini-4-neon-medium            Gemini 4 Neon (Medium)\n",
            "gemini-4-neon-low               Gemini 4 Neon (Low)\n",
            "gemini-4-argon-medium           Gemini 4 Argon (Medium)\n",
            "gemini-4-argon-high             Gemini 4 Argon (High)\n",
            "gemini-4-argon-low              Gemini 4 Argon (Low)\n",
            "gemini-pro-orchestrator-neon    Orchestrator (Neon)\n",
            "claude-opus-5-5-low             Claude Opus 5.5 (Low)\n",
            "claude-opus-5-5-medium          Claude Opus 5.5 (Medium)\n",
            "claude-opus-5-5-high            Claude Opus 5.5 (High)\n",
            "gpt-oss-120b-medium             GPT-OSS 120B (Medium)\n",
        );

        let parsed = parse_agy_models_output(sample);
        assert_eq!(
            parsed,
            vec![
                AgyModelCatalogItem {
                    id: "gemini-4-neon".to_string(),
                    name: "Gemini 4 Neon".to_string(),
                    efforts: vec![
                        "low".to_string(),
                        "medium".to_string(),
                        "high".to_string(),
                        "xhigh".to_string(),
                    ],
                    default_effort: Some("high".to_string()),
                },
                AgyModelCatalogItem {
                    id: "gemini-4-argon".to_string(),
                    name: "Gemini 4 Argon".to_string(),
                    efforts: vec!["low".to_string(), "medium".to_string(), "high".to_string()],
                    default_effort: Some("medium".to_string()),
                },
                AgyModelCatalogItem {
                    id: "gemini-pro-orchestrator-neon".to_string(),
                    name: "Orchestrator (Neon)".to_string(),
                    efforts: vec![],
                    default_effort: None,
                },
                AgyModelCatalogItem {
                    id: "claude-opus-5-5".to_string(),
                    name: "Claude Opus 5.5".to_string(),
                    efforts: vec!["low".to_string(), "medium".to_string(), "high".to_string()],
                    default_effort: Some("low".to_string()),
                },
                AgyModelCatalogItem {
                    id: "gpt-oss-120b-medium".to_string(),
                    name: "GPT-OSS 120B (Medium)".to_string(),
                    efforts: vec![],
                    default_effort: None,
                },
            ]
        );
    }

    #[test]
    fn ignores_noise_lines_and_deduplicates_variants() {
        let sample = "\nLoading...\n\nFetching available models...\n\
            gemini-3.8-flash-high   Gemini 3.8 Flash (High)\n\
            gemini-3.8-flash-high   Gemini 3.8 Flash (High)\n\
            gemini-3.8-flash-low    Gemini 3.8 Flash (Low)\n";
        let parsed = parse_agy_models_output(sample);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].id, "gemini-3.8-flash");
        assert_eq!(parsed[0].name, "Gemini 3.8 Flash");
        assert_eq!(parsed[0].efforts, vec!["low", "high"]);
    }
}
