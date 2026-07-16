use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
};

pub(crate) const EXIT_GATE_REJECTED: i32 = 88;
pub(crate) const EXIT_SMOKE_FAILED: i32 = 89;
pub(crate) const EXIT_SMOKE_TIMEOUT: i32 = 90;

const SCHEMA_VERSION: u32 = 1;
const SMOKE_NAME: &str = "macos-mode2-safe-storage-release";
const SMOKE_DIRECTORY: &str = "ccem-mode2-safe-storage-smoke";
const ENV_ALLOW: &str = "CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_ALLOW";
const ENV_NONCE: &str = "CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_NONCE";
const ENV_ROOT: &str = "CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_ROOT";
const ENV_SCENARIO: &str = "CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_SCENARIO";
const ENV_PHASE: &str = "CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_PHASE";
const ENV_SCENARIO_ROOT: &str = "CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_SCENARIO_ROOT";
const ENV_RECEIPT: &str = "CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_RECEIPT_PATH";
const ENV_TICKET: &str = "CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_TICKET_PATH";
const ENV_EXPECTED_EXE: &str = "CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_EXPECTED_EXE";
const ENV_KEYCHAIN: &str = "CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_KEYCHAIN_PATH";
const ENV_ISOLATION: &str = "CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_ISOLATION_RECEIPT";

const EXPLICIT_ENVIRONMENT: [&str; 11] = [
    ENV_ALLOW,
    ENV_NONCE,
    ENV_ROOT,
    ENV_SCENARIO,
    ENV_PHASE,
    ENV_SCENARIO_ROOT,
    ENV_RECEIPT,
    ENV_TICKET,
    ENV_EXPECTED_EXE,
    ENV_KEYCHAIN,
    ENV_ISOLATION,
];

const PROCESS_ENVIRONMENT: [&str; 18] = [
    ENV_ALLOW,
    ENV_NONCE,
    ENV_ROOT,
    ENV_SCENARIO,
    ENV_PHASE,
    ENV_SCENARIO_ROOT,
    ENV_RECEIPT,
    ENV_TICKET,
    ENV_EXPECTED_EXE,
    ENV_KEYCHAIN,
    ENV_ISOLATION,
    "GITHUB_ACTIONS",
    "CI",
    "RUNNER_OS",
    "RUNNER_TEMP",
    "GITHUB_SHA",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
];

#[derive(Clone, Debug)]
pub(crate) struct MacosSafeStorageSmokeConfig {
    pub(crate) nonce: String,
    pub(crate) source_commit: String,
    pub(crate) run_id: String,
    pub(crate) run_attempt: String,
    pub(crate) scenario: String,
    pub(crate) phase: String,
    pub(crate) smoke_root: PathBuf,
    pub(crate) cef_cache_root: PathBuf,
    pub(crate) receipt_path: PathBuf,
    ticket_path: PathBuf,
    expected_executable: PathBuf,
    keychain_path: PathBuf,
    isolation_receipt_path: PathBuf,
}

pub(crate) enum MacosSafeStorageSmokeGate {
    Disabled,
    Enabled(MacosSafeStorageSmokeConfig),
    Rejected(String),
}

#[derive(Clone, Copy)]
struct BuildIdentity<'a> {
    macos: bool,
    release: bool,
    source_commit: Option<&'a str>,
    run_id: Option<&'a str>,
    run_attempt: Option<&'a str>,
}

impl BuildIdentity<'static> {
    fn current() -> Self {
        Self {
            macos: cfg!(target_os = "macos"),
            release: !cfg!(debug_assertions),
            source_commit: option_env!("GITHUB_SHA"),
            run_id: option_env!("GITHUB_RUN_ID"),
            run_attempt: option_env!("GITHUB_RUN_ATTEMPT"),
        }
    }
}

pub(crate) fn gate_from_process_environment() -> MacosSafeStorageSmokeGate {
    let environment = PROCESS_ENVIRONMENT
        .into_iter()
        .filter_map(|name| std::env::var(name).ok().map(|value| (name, value)))
        .collect::<BTreeMap<_, _>>();
    match evaluate_gate(BuildIdentity::current(), &environment) {
        MacosSafeStorageSmokeGate::Enabled(config) => match validate_process_filesystem(&config) {
            Ok(()) => MacosSafeStorageSmokeGate::Enabled(config),
            Err(error) => MacosSafeStorageSmokeGate::Rejected(error),
        },
        gate => gate,
    }
}

fn evaluate_gate(
    build: BuildIdentity<'_>,
    environment: &BTreeMap<&str, String>,
) -> MacosSafeStorageSmokeGate {
    if !EXPLICIT_ENVIRONMENT
        .iter()
        .any(|name| environment.contains_key(name))
    {
        return MacosSafeStorageSmokeGate::Disabled;
    }
    let result = (|| {
        if !build.macos || !build.release {
            return Err(
                "macOS Safe Storage smoke requires a signed macOS release build".to_string(),
            );
        }
        require_exact(environment, ENV_ALLOW, "1")?;
        require_exact(environment, "GITHUB_ACTIONS", "true")?;
        require_exact(environment, "CI", "true")?;
        require_exact(environment, "RUNNER_OS", "macOS")?;
        let nonce = require_lower_hex(environment, ENV_NONCE, 64)?;
        let source_commit = require_lower_hex(environment, "GITHUB_SHA", 40)?;
        let run_id = require_run_number(environment, "GITHUB_RUN_ID")?;
        let run_attempt = require_run_number(environment, "GITHUB_RUN_ATTEMPT")?;
        require_built_identity("GITHUB_SHA", build.source_commit, &source_commit)?;
        require_built_identity("GITHUB_RUN_ID", build.run_id, &run_id)?;
        require_built_identity("GITHUB_RUN_ATTEMPT", build.run_attempt, &run_attempt)?;

        let runner_temp = require_normalized_absolute_path(environment, "RUNNER_TEMP")?;
        let current_run_root = runner_temp
            .join(SMOKE_DIRECTORY)
            .join(format!("{run_id}-{run_attempt}-{}", &nonce[..16]));
        require_exact_path(environment, ENV_ROOT, &current_run_root)?;
        let scenario = require_choice(environment, ENV_SCENARIO, &["clean", "generic-conflict"])?;
        let phase = require_choice(environment, ENV_PHASE, &["prime", "verify"])?;
        let smoke_root = current_run_root.join("scenarios").join(&scenario);
        require_exact_path(environment, ENV_SCENARIO_ROOT, &smoke_root)?;
        let receipt_path = smoke_root
            .join("evidence")
            .join(format!("{phase}-runtime.json"));
        let ticket_path = smoke_root.join("tickets").join(format!("{phase}.ticket"));
        let keychain_path = smoke_root.join("keychain/smoke.keychain-db");
        let isolation_receipt_path = smoke_root.join("keychain/isolation.json");
        let expected_executable = current_run_root.join("app/CCEM.app/Contents/MacOS/ccem-desktop");
        require_exact_path(environment, ENV_RECEIPT, &receipt_path)?;
        require_exact_path(environment, ENV_TICKET, &ticket_path)?;
        require_exact_path(environment, ENV_KEYCHAIN, &keychain_path)?;
        require_exact_path(environment, ENV_ISOLATION, &isolation_receipt_path)?;
        require_exact_path(environment, ENV_EXPECTED_EXE, &expected_executable)?;

        Ok(MacosSafeStorageSmokeConfig {
            nonce,
            source_commit,
            run_id,
            run_attempt,
            scenario,
            phase,
            cef_cache_root: smoke_root.join("data/login/cef"),
            smoke_root,
            receipt_path,
            ticket_path,
            expected_executable,
            keychain_path,
            isolation_receipt_path,
        })
    })();
    match result {
        Ok(config) => MacosSafeStorageSmokeGate::Enabled(config),
        Err(error) => MacosSafeStorageSmokeGate::Rejected(error),
    }
}

fn require_exact(
    environment: &BTreeMap<&str, String>,
    name: &str,
    expected: &str,
) -> Result<(), String> {
    if environment.get(name).map(String::as_str) == Some(expected) {
        Ok(())
    } else {
        Err(format!(
            "macOS Safe Storage smoke requires {name}={expected}"
        ))
    }
}

fn require_lower_hex(
    environment: &BTreeMap<&str, String>,
    name: &str,
    length: usize,
) -> Result<String, String> {
    let value = environment
        .get(name)
        .ok_or_else(|| format!("macOS Safe Storage smoke requires {name}"))?;
    if value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        Ok(value.clone())
    } else {
        Err(format!(
            "macOS Safe Storage smoke requires {name} as {length} lowercase hex characters"
        ))
    }
}

fn require_run_number(environment: &BTreeMap<&str, String>, name: &str) -> Result<String, String> {
    let value = environment
        .get(name)
        .ok_or_else(|| format!("macOS Safe Storage smoke requires {name}"))?;
    if !value.is_empty()
        && value.len() <= 20
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && !value.starts_with('0')
        && value.parse::<u64>().is_ok_and(|number| number > 0)
    {
        Ok(value.clone())
    } else {
        Err(format!(
            "macOS Safe Storage smoke requires {name} as a positive canonical run number"
        ))
    }
}

fn require_built_identity(name: &str, built: Option<&str>, runtime: &str) -> Result<(), String> {
    match built {
        Some(value) if value == runtime => Ok(()),
        Some(_) => Err(format!(
            "macOS Safe Storage smoke runtime {name} does not match the release build"
        )),
        None => Err(format!(
            "macOS Safe Storage smoke release build is missing embedded {name}"
        )),
    }
}

fn require_choice(
    environment: &BTreeMap<&str, String>,
    name: &str,
    choices: &[&str],
) -> Result<String, String> {
    let value = environment
        .get(name)
        .ok_or_else(|| format!("macOS Safe Storage smoke requires {name}"))?;
    if choices.contains(&value.as_str()) {
        Ok(value.clone())
    } else {
        Err(format!("macOS Safe Storage smoke {name} is invalid"))
    }
}

fn require_normalized_absolute_path(
    environment: &BTreeMap<&str, String>,
    name: &str,
) -> Result<PathBuf, String> {
    let value = environment
        .get(name)
        .ok_or_else(|| format!("macOS Safe Storage smoke requires {name}"))?;
    let path = PathBuf::from(value);
    let mut components = path.components();
    if !matches!(components.next(), Some(Component::RootDir))
        || components.any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!(
            "macOS Safe Storage smoke {name} must be a normalized absolute path"
        ));
    }
    Ok(path)
}

fn require_exact_path(
    environment: &BTreeMap<&str, String>,
    name: &str,
    expected: &Path,
) -> Result<(), String> {
    let actual = require_normalized_absolute_path(environment, name)?;
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "macOS Safe Storage smoke {name} escaped its exact current-run path"
        ))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OneShotTicket {
    schema_version: u32,
    nonce: String,
    scenario: String,
    phase: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeychainIsolationReceipt {
    schema_version: u32,
    nonce: String,
    scenario: String,
    keychain_path: PathBuf,
    exclusive_temporary_keychain: bool,
}

fn validate_process_filesystem(config: &MacosSafeStorageSmokeConfig) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let metadata = fs::symlink_metadata(&config.smoke_root)
            .map_err(|error| format!("inspect macOS Safe Storage smoke root: {error}"))?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o077 != 0
        {
            return Err(
                "macOS Safe Storage smoke root must be a private current-user directory"
                    .to_string(),
            );
        }
        if fs::canonicalize(&config.smoke_root)
            .map_err(|error| format!("canonicalize macOS Safe Storage smoke root: {error}"))?
            != config.smoke_root
        {
            return Err("macOS Safe Storage smoke root must be canonical".to_string());
        }
        for path in [
            &config.ticket_path,
            &config.isolation_receipt_path,
            &config.keychain_path,
        ] {
            let metadata = fs::symlink_metadata(path)
                .map_err(|error| format!("inspect macOS Safe Storage smoke input: {error}"))?;
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.uid() != unsafe { libc::geteuid() }
                || metadata.permissions().mode() & 0o077 != 0
            {
                return Err(
                    "macOS Safe Storage smoke input must be a private current-user file"
                        .to_string(),
                );
            }
            let canonical = fs::canonicalize(path)
                .map_err(|error| format!("canonicalize macOS Safe Storage smoke input: {error}"))?;
            if canonical != *path || !canonical.starts_with(&config.smoke_root) {
                return Err(
                    "macOS Safe Storage smoke input escaped through a symlinked parent".to_string(),
                );
            }
        }
        let receipt_parent = config
            .receipt_path
            .parent()
            .ok_or_else(|| "macOS Safe Storage receipt has no parent".to_string())?;
        if fs::canonicalize(receipt_parent)
            .map_err(|error| format!("canonicalize Safe Storage evidence root: {error}"))?
            != receipt_parent
            || !receipt_parent.starts_with(&config.smoke_root)
        {
            return Err("macOS Safe Storage evidence root escaped through a symlink".to_string());
        }
    }
    let current_executable = fs::canonicalize(
        std::env::current_exe()
            .map_err(|error| format!("resolve macOS Safe Storage smoke executable: {error}"))?,
    )
    .map_err(|error| format!("canonicalize macOS Safe Storage smoke executable: {error}"))?;
    let expected_executable = fs::canonicalize(&config.expected_executable)
        .map_err(|error| format!("canonicalize expected signed smoke executable: {error}"))?;
    if current_executable != expected_executable {
        return Err(
            "macOS Safe Storage smoke is not running the exact copied signed app".to_string(),
        );
    }
    let isolation: KeychainIsolationReceipt = serde_json::from_slice(
        &fs::read(&config.isolation_receipt_path)
            .map_err(|error| format!("read Keychain isolation receipt: {error}"))?,
    )
    .map_err(|error| format!("parse Keychain isolation receipt: {error}"))?;
    if isolation.schema_version != SCHEMA_VERSION
        || isolation.nonce != config.nonce
        || isolation.scenario != config.scenario
        || isolation.keychain_path != config.keychain_path
        || !isolation.exclusive_temporary_keychain
    {
        return Err("temporary Keychain isolation receipt is not bound to this smoke".to_string());
    }
    if fs::symlink_metadata(&config.receipt_path).is_ok() {
        return Err("macOS Safe Storage smoke receipt already exists".to_string());
    }
    Ok(())
}

pub(crate) fn consume_one_shot_ticket(config: &MacosSafeStorageSmokeConfig) -> Result<(), String> {
    let consumed = config.ticket_path.with_extension("consumed");
    if fs::symlink_metadata(&consumed).is_ok() {
        return Err("macOS Safe Storage one-shot ticket was already consumed".to_string());
    }
    let ticket: OneShotTicket = serde_json::from_slice(
        &fs::read(&config.ticket_path)
            .map_err(|error| format!("read macOS Safe Storage one-shot ticket: {error}"))?,
    )
    .map_err(|error| format!("parse macOS Safe Storage one-shot ticket: {error}"))?;
    if ticket.schema_version != SCHEMA_VERSION
        || ticket.nonce != config.nonce
        || ticket.scenario != config.scenario
        || ticket.phase != config.phase
    {
        return Err(
            "macOS Safe Storage one-shot ticket is not bound to this invocation".to_string(),
        );
    }
    fs::hard_link(&config.ticket_path, &consumed)
        .map_err(|error| format!("publish consumed Safe Storage ticket: {error}"))?;
    fs::remove_file(&config.ticket_path)
        .map_err(|error| format!("remove active Safe Storage ticket: {error}"))?;
    let metadata = fs::symlink_metadata(&consumed)
        .map_err(|error| format!("verify consumed Safe Storage ticket: {error}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || config.ticket_path.exists() {
        return Err("macOS Safe Storage one-shot ticket consumption is inconsistent".to_string());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Rejection<'a> {
    schema_version: u32,
    smoke: &'static str,
    status: &'static str,
    exit_code: i32,
    error: &'a str,
}

pub(crate) fn rejection_json(error: &str) -> String {
    serde_json::to_string(&Rejection {
        schema_version: SCHEMA_VERSION,
        smoke: SMOKE_NAME,
        status: "rejected",
        exit_code: EXIT_GATE_REJECTED,
        error,
    })
    .unwrap_or_else(|_| {
        format!(
            "{{\"schemaVersion\":{SCHEMA_VERSION},\"smoke\":\"{SMOKE_NAME}\",\"status\":\"rejected\",\"exitCode\":{EXIT_GATE_REJECTED}}}"
        )
    })
}

#[cfg(all(target_os = "macos", not(debug_assertions)))]
mod runtime;

#[cfg(all(target_os = "macos", not(debug_assertions)))]
#[allow(unused_imports)]
pub(crate) use runtime::run;

#[cfg(test)]
#[path = "macos_safe_storage_smoke_tests.rs"]
mod tests;
