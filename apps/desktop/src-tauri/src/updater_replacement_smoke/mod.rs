mod contract;
mod runtime;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use contract::{
    canonical_path_for_evidence, load_config, write_json_create_new, ActorRole, AppBootRecord,
    SmokeConfig, EXIT_GATE_REJECTED, EXIT_SMOKE_FAILED,
};
use runtime::run_current_observer;
#[cfg(feature = "updater-replacement-smoke-harness")]
pub(crate) use runtime::{configure_updater_builder, record_verified_download};
#[cfg(feature = "updater-replacement-smoke-harness")]
use runtime::{run_previous_updater, set_previous_smoke_context};
use sha2::{Digest, Sha256};

const ARGUMENT: &str = "--ccem-updater-replacement-smoke";

fn requested_config_path() -> Result<Option<PathBuf>, String> {
    let arguments = std::env::args_os().collect::<Vec<_>>();
    let matches = arguments
        .iter()
        .enumerate()
        .filter(|(_, value)| value == &&std::ffi::OsString::from(ARGUMENT))
        .collect::<Vec<_>>();
    if matches.is_empty() {
        return Ok(None);
    }
    if matches.len() != 1 {
        return Err("updater replacement smoke argument must appear exactly once".to_string());
    }
    let index = matches[0].0;
    let candidate = arguments
        .get(index + 1)
        .ok_or_else(|| "updater replacement smoke config path is missing".to_string())?;
    if arguments
        .get(index + 2)
        .is_some_and(|value| value == &std::ffi::OsString::from(ARGUMENT))
    {
        return Err("updater replacement smoke argument is duplicated".to_string());
    }
    Ok(Some(PathBuf::from(candidate)))
}

fn require_ci_gate(config: &SmokeConfig) -> Result<(), String> {
    if std::env::var("CCEM_UPDATER_REPLACEMENT_SMOKE_ALLOW").as_deref() != Ok("1")
        || std::env::var("GITHUB_ACTIONS").as_deref() != Ok("true")
    {
        return Err("updater replacement smoke requires its explicit GitHub Actions gate".into());
    }
    for (name, expected) in [
        ("GITHUB_RUN_ID", config.run.id.as_str()),
        ("GITHUB_RUN_ATTEMPT", config.run.attempt.as_str()),
        ("GITHUB_SHA", config.source_commit.as_str()),
    ] {
        if std::env::var(name).as_deref() != Ok(expected) {
            return Err(format!(
                "updater replacement smoke {name} does not match config"
            ));
        }
    }
    let expected_runner = match config.platform.as_str() {
        "macos" => "macOS",
        "windows" => "Windows",
        _ => return Err("updater replacement smoke platform is unsupported".into()),
    };
    if std::env::var("RUNNER_OS").as_deref() != Ok(expected_runner) {
        return Err("updater replacement smoke RUNNER_OS does not match config".into());
    }
    Ok(())
}

fn sha256_file(candidate: &Path) -> Result<String, String> {
    use std::io::Read;

    let mut file = std::fs::File::open(candidate)
        .map_err(|error| format!("open {}: {error}", candidate.display()))?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("read {}: {error}", candidate.display()))?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn built_source_commit() -> Option<&'static str> {
    option_env!("GITHUB_SHA")
}

fn identify_role(config: &SmokeConfig) -> Result<ActorRole, String> {
    let runtime_version = env!("CARGO_PKG_VERSION");
    let source_commit = built_source_commit()
        .ok_or_else(|| "binary lacks an embedded GITHUB_SHA build identity".to_string())?;
    if runtime_version == config.previous.version && source_commit == config.previous.source_commit
    {
        #[cfg(feature = "updater-replacement-smoke-harness")]
        return Ok(ActorRole::PreviousApp);
        #[cfg(not(feature = "updater-replacement-smoke-harness"))]
        return Err("previous app lacks the instrumented updater smoke feature".into());
    }
    if runtime_version == config.current_version && source_commit == config.source_commit {
        return Ok(ActorRole::CurrentApp);
    }
    Err("binary runtime version and embedded source commit do not match either actor".into())
}

fn create_boot_record(config: &SmokeConfig, role: ActorRole) -> Result<AppBootRecord, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("resolve current executable: {error}"))?
        .canonicalize()
        .map_err(|error| format!("canonicalize current executable: {error}"))?;
    let executable = canonical_path_for_evidence(&executable);
    let image_sha256 = sha256_file(&executable)?;
    let expected_sha256 = match role {
        ActorRole::PreviousApp => &config.previous.executable_sha256,
        ActorRole::CurrentApp => &config.current_executable_sha256,
    };
    if &image_sha256 != expected_sha256 {
        return Err("running executable digest does not match the smoke config".into());
    }
    Ok(AppBootRecord {
        schema_version: 1,
        pid: std::process::id(),
        role,
        challenge_nonce: config.run.challenge_nonce.clone(),
        canonical_image_path: executable,
        image_sha256,
        runtime_version: env!("CARGO_PKG_VERSION").to_string(),
        embedded_source_commit: built_source_commit().unwrap().to_string(),
    })
}

fn run(
    config: SmokeConfig,
    role: ActorRole,
    mut context: tauri::Context<tauri::Wry>,
) -> Result<i32, String> {
    // The updater smoke is an early, windowless test mode. Clearing configured windows keeps
    // WebView/CEF/frontend startup and all credential-backed browser state outside this process.
    context.config_mut().app.windows.clear();
    let boot = create_boot_record(&config, role)?;
    write_json_create_new(&config.boot_path(boot.pid), &boot)?;
    let exit_result = Arc::new(Mutex::new(EXIT_SMOKE_FAILED));
    let result_for_task = Arc::clone(&exit_result);
    let config = Arc::new(config);
    let config_for_task = Arc::clone(&config);
    let boot_for_task = boot.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(crate::app_updates::PendingUpdate::default())
        .setup(move |app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let result = match role {
                    ActorRole::PreviousApp => {
                        #[cfg(feature = "updater-replacement-smoke-harness")]
                        {
                            match set_previous_smoke_context(&config_for_task, &boot_for_task) {
                                Ok(()) => {
                                    run_previous_updater(&handle, &config_for_task, &boot_for_task)
                                        .await
                                }
                                Err(error) => Err(error),
                            }
                        }
                        #[cfg(not(feature = "updater-replacement-smoke-harness"))]
                        {
                            Err("previous updater harness feature is unavailable".into())
                        }
                    }
                    ActorRole::CurrentApp => run_current_observer(&config_for_task, &boot_for_task),
                };
                let exit_code = match result {
                    Ok(()) => 0,
                    Err(error) => {
                        eprintln!("[updater-replacement-smoke] {error}");
                        EXIT_SMOKE_FAILED
                    }
                };
                if let Ok(mut guard) = result_for_task.lock() {
                    *guard = exit_code;
                }
                handle.exit(exit_code);
            });
            Ok(())
        })
        .build(context)
        .map_err(|error| format!("build isolated updater smoke app: {error}"))?;

    let event_loop_code = app.run_return(|_, _| {});
    Ok(exit_result
        .lock()
        .map(|guard| *guard)
        .unwrap_or(event_loop_code))
}

pub fn is_requested() -> bool {
    std::env::args_os().any(|value| value == std::ffi::OsString::from(ARGUMENT))
}

pub fn run_requested(context: tauri::Context<tauri::Wry>) -> i32 {
    let config_path = match requested_config_path() {
        Ok(Some(path)) => path,
        Ok(None) => {
            eprintln!("[updater-replacement-smoke] smoke argument disappeared after admission");
            return EXIT_GATE_REJECTED;
        }
        Err(error) => {
            eprintln!("[updater-replacement-smoke] {error}");
            return EXIT_GATE_REJECTED;
        }
    };
    let result = (|| {
        let config = load_config(&config_path)?;
        require_ci_gate(&config)?;
        let role = identify_role(&config)?;
        run(config, role, context)
    })();
    match result {
        Ok(code) => code,
        Err(error) => {
            eprintln!("[updater-replacement-smoke] {error}");
            EXIT_GATE_REJECTED
        }
    }
}

#[cfg(test)]
mod tests {
    use super::requested_config_path;

    #[test]
    fn absent_smoke_argument_keeps_normal_startup() {
        assert!(requested_config_path().unwrap().is_none());
    }
}
