use serde::Serialize;
use std::{collections::BTreeMap, path::PathBuf};

pub(crate) const EXIT_GATE_REJECTED: i32 = 85;
pub(crate) const EXIT_SMOKE_FAILED: i32 = 86;
pub(crate) const EXIT_SMOKE_TIMEOUT: i32 = 87;

const SCHEMA_VERSION: u32 = 4;
const ENV_ALLOW: &str = "CCEM_MACOS_MODE2_SMOKE_ALLOW";
const ENV_ALLOW_CONCURRENT_RELEASE: &str = "CCEM_MACOS_MODE2_SMOKE_ALLOW_CONCURRENT_RELEASE";
const ENV_NONCE: &str = "CCEM_MACOS_MODE2_SMOKE_NONCE";
const ENV_ROOT: &str = "CCEM_MACOS_MODE2_SMOKE_ROOT";
const ENV_RECEIPT_PATH: &str = "CCEM_MACOS_MODE2_SMOKE_RECEIPT_PATH";
const RECEIPT_RELATIVE_PATH: &str = "evidence/runtime-receipt.json";
const EXPLICIT_ENVIRONMENT: [&str; 5] = [
    ENV_ALLOW,
    ENV_ALLOW_CONCURRENT_RELEASE,
    ENV_NONCE,
    ENV_ROOT,
    ENV_RECEIPT_PATH,
];

#[derive(Clone, Debug)]
pub(crate) struct MacosDebugMode2SmokeConfig {
    nonce: String,
    smoke_root: PathBuf,
    data_root: PathBuf,
    evidence_root: PathBuf,
    receipt_path: PathBuf,
    instance_lock_path: PathBuf,
    cef_cache_root: PathBuf,
    allow_concurrent_release: bool,
}

pub(crate) enum MacosDebugMode2SmokeGate {
    Disabled,
    Enabled(MacosDebugMode2SmokeConfig),
    Rejected(String),
}

#[derive(Clone, Copy)]
struct BuildIdentity {
    macos: bool,
    debug: bool,
}

impl BuildIdentity {
    fn current() -> Self {
        Self {
            macos: cfg!(target_os = "macos"),
            debug: cfg!(debug_assertions),
        }
    }
}

pub(crate) fn gate_from_process_environment() -> MacosDebugMode2SmokeGate {
    let environment = EXPLICIT_ENVIRONMENT
        .into_iter()
        .filter_map(|name| std::env::var(name).ok().map(|value| (name, value)))
        .collect::<BTreeMap<_, _>>();
    match evaluate_gate(BuildIdentity::current(), &environment) {
        MacosDebugMode2SmokeGate::Enabled(config) => {
            #[cfg(all(target_os = "macos", debug_assertions))]
            {
                match validate_process_filesystem(&config) {
                    Ok(()) => MacosDebugMode2SmokeGate::Enabled(config),
                    Err(error) => MacosDebugMode2SmokeGate::Rejected(error),
                }
            }
            #[cfg(not(all(target_os = "macos", debug_assertions)))]
            {
                let _ = config;
                MacosDebugMode2SmokeGate::Rejected(
                    "macOS Mode 2 smoke reached an impossible build gate".to_string(),
                )
            }
        }
        gate => gate,
    }
}

fn evaluate_gate(
    build: BuildIdentity,
    environment: &BTreeMap<&str, String>,
) -> MacosDebugMode2SmokeGate {
    if !EXPLICIT_ENVIRONMENT
        .iter()
        .any(|name| environment.contains_key(name))
    {
        return MacosDebugMode2SmokeGate::Disabled;
    }

    let result = (|| {
        if !build.macos || !build.debug {
            return Err("macOS Mode 2 smoke requires a macOS debug build".to_string());
        }
        require_exact(environment, ENV_ALLOW, "1")?;
        require_exact(environment, ENV_ALLOW_CONCURRENT_RELEASE, "1")?;
        let nonce = require_lower_hex(environment, ENV_NONCE, 64)?;
        let smoke_root = require_normalized_absolute_path(environment, ENV_ROOT)?;
        let receipt_path = require_normalized_absolute_path(environment, ENV_RECEIPT_PATH)?;
        let expected_receipt = smoke_root.join(RECEIPT_RELATIVE_PATH);
        if receipt_path != expected_receipt {
            return Err(format!(
                "macOS Mode 2 smoke {ENV_RECEIPT_PATH} must be exactly {}",
                expected_receipt.display()
            ));
        }

        Ok(MacosDebugMode2SmokeConfig {
            nonce,
            data_root: smoke_root.join("data"),
            evidence_root: smoke_root.join("evidence"),
            instance_lock_path: smoke_root.join("instance/debug-mode2-smoke.lock"),
            cef_cache_root: smoke_root.join("data/login/cef"),
            allow_concurrent_release: true,
            smoke_root,
            receipt_path,
        })
    })();
    match result {
        Ok(config) => MacosDebugMode2SmokeGate::Enabled(config),
        Err(error) => MacosDebugMode2SmokeGate::Rejected(error),
    }
}

fn require_exact(
    environment: &BTreeMap<&str, String>,
    name: &str,
    expected: &str,
) -> Result<(), String> {
    match environment.get(name).map(String::as_str) {
        Some(actual) if actual == expected => Ok(()),
        _ => Err(format!("macOS Mode 2 smoke requires {name}={expected}")),
    }
}

fn require_lower_hex(
    environment: &BTreeMap<&str, String>,
    name: &str,
    length: usize,
) -> Result<String, String> {
    let value = environment
        .get(name)
        .ok_or_else(|| format!("macOS Mode 2 smoke requires {name}"))?;
    if value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        Ok(value.clone())
    } else {
        Err(format!(
            "macOS Mode 2 smoke requires {name} as {length} lowercase hex characters"
        ))
    }
}

fn require_normalized_absolute_path(
    environment: &BTreeMap<&str, String>,
    name: &str,
) -> Result<PathBuf, String> {
    use std::path::Component;

    let value = environment
        .get(name)
        .ok_or_else(|| format!("macOS Mode 2 smoke requires {name}"))?;
    let path = PathBuf::from(value);
    let mut components = path.components();
    if !matches!(components.next(), Some(Component::RootDir))
        || components.any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!(
            "macOS Mode 2 smoke {name} must be a normalized absolute path"
        ));
    }
    Ok(path)
}

pub(crate) fn rejection_json(error: &str) -> String {
    serde_json::to_string(&ProcessResult {
        schema_version: SCHEMA_VERSION,
        smoke: "macos-mode2-debug",
        status: "rejected",
        exit_code: EXIT_GATE_REJECTED,
        receipt_path: None,
        error: Some(error),
    })
    .unwrap_or_else(|_| {
        format!(
            "{{\"schemaVersion\":{SCHEMA_VERSION},\"smoke\":\"macos-mode2-debug\",\"status\":\"rejected\",\"exitCode\":{EXIT_GATE_REJECTED}}}"
        )
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessResult<'a> {
    schema_version: u32,
    smoke: &'static str,
    status: &'static str,
    exit_code: i32,
    receipt_path: Option<&'a str>,
    error: Option<&'a str>,
}

#[cfg(all(target_os = "macos", debug_assertions))]
mod runtime;

#[cfg(all(target_os = "macos", debug_assertions))]
use runtime::validate_process_filesystem;

#[cfg(all(target_os = "macos", debug_assertions))]
pub(crate) use runtime::run;

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_environment(root: &str) -> BTreeMap<&'static str, String> {
        BTreeMap::from([
            (ENV_ALLOW, "1".to_string()),
            (
                "CCEM_MACOS_MODE2_SMOKE_ALLOW_CONCURRENT_RELEASE",
                "1".to_string(),
            ),
            (ENV_NONCE, "a".repeat(64)),
            (ENV_ROOT, root.to_string()),
            (ENV_RECEIPT_PATH, format!("{root}/{RECEIPT_RELATIVE_PATH}")),
        ])
    }

    #[test]
    fn gate_is_disabled_without_explicit_smoke_environment() {
        assert!(matches!(
            evaluate_gate(
                BuildIdentity {
                    macos: true,
                    debug: true,
                },
                &BTreeMap::new(),
            ),
            MacosDebugMode2SmokeGate::Disabled
        ));
    }

    #[test]
    fn gate_rejects_partial_environment() {
        let environment = BTreeMap::from([(ENV_ALLOW, "1".to_string())]);
        assert!(matches!(
            evaluate_gate(
                BuildIdentity {
                    macos: true,
                    debug: true,
                },
                &environment,
            ),
            MacosDebugMode2SmokeGate::Rejected(_)
        ));
    }

    #[test]
    fn gate_rejects_non_debug_or_non_macos_builds() {
        let environment = valid_environment("/private/tmp/ccem-mode2-smoke-a");
        for build in [
            BuildIdentity {
                macos: false,
                debug: true,
            },
            BuildIdentity {
                macos: true,
                debug: false,
            },
        ] {
            assert!(matches!(
                evaluate_gate(build, &environment),
                MacosDebugMode2SmokeGate::Rejected(_)
            ));
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn gate_accepts_exact_debug_macos_contract() {
        let root = "/private/tmp/ccem-mode2-smoke-a";
        let gate = evaluate_gate(
            BuildIdentity {
                macos: true,
                debug: true,
            },
            &valid_environment(root),
        );
        let MacosDebugMode2SmokeGate::Enabled(config) = gate else {
            panic!("expected enabled gate");
        };
        assert!(
            config.allow_concurrent_release,
            "the isolated E2E gate must explicitly authorize coexistence with the release app"
        );
        assert_eq!(config.smoke_root, PathBuf::from(root));
        assert_eq!(
            config.receipt_path,
            PathBuf::from(root).join(RECEIPT_RELATIVE_PATH)
        );
        assert_eq!(
            config.cef_cache_root,
            PathBuf::from(root).join("data/login/cef")
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn gate_rejects_traversal_and_receipt_escape() {
        let traversal = valid_environment("/private/tmp/../tmp/ccem-mode2-smoke-a");
        assert!(matches!(
            evaluate_gate(
                BuildIdentity {
                    macos: true,
                    debug: true,
                },
                &traversal,
            ),
            MacosDebugMode2SmokeGate::Rejected(_)
        ));

        let mut escaped = valid_environment("/private/tmp/ccem-mode2-smoke-a");
        escaped.insert(
            ENV_RECEIPT_PATH,
            "/private/tmp/other/runtime-receipt.json".to_string(),
        );
        assert!(matches!(
            evaluate_gate(
                BuildIdentity {
                    macos: true,
                    debug: true,
                },
                &escaped,
            ),
            MacosDebugMode2SmokeGate::Rejected(_)
        ));
    }
}
