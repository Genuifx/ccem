//! Explicit, isolated smoke for the ad-hoc release bundle. Never enters normal startup.
use super::{
    bootstrap::{
        expected_credential_store_marker, validate_credential_store_marker,
        CefCredentialStorePolicy,
    },
    host::CefHostController,
    surface::{CefSurfaceConnection, CefSurfaceLifecycle, CefSurfaceRequest, LogicalViewport},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, RunEvent};

const TIMEOUT: Duration = Duration::from_secs(15);
const SURFACE: &str = "adhoc-bundle-smoke";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    nonce: String,
    phase: String,
    origin: String,
}

struct RootLock(PathBuf);
impl Drop for RootLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn configuration() -> Result<(PathBuf, Config), String> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 2 || args[0] != "--cef-bundle-smoke" {
        return Err("expected exactly --cef-bundle-smoke <dedicated directory>".into());
    }
    let root = PathBuf::from(&args[1]);
    if !root.is_absolute() || fs::canonicalize(&root).map_err(|e| e.to_string())? != root {
        return Err("smoke directory must be an existing canonical absolute path".into());
    }
    let config_path = root.join("smoke-config.json");
    if !fs::symlink_metadata(&config_path)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_file()
    {
        return Err("smoke config must be a regular file".into());
    }
    let config: Config = serde_json::from_slice(&fs::read(config_path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if config.nonce.len() != 32
        || !config.nonce.bytes().all(|v| v.is_ascii_hexdigit())
        || !matches!(config.phase.as_str(), "prime" | "restore")
    {
        return Err("invalid smoke nonce or phase".into());
    }
    let url = tauri::Url::parse(&config.origin).map_err(|e| e.to_string())?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("smoke origin must be an explicit loopback HTTP port".into());
    }
    let cache = root.join("cef-cache");
    fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    if fs::canonicalize(&cache).map_err(|e| e.to_string())? != cache {
        return Err("smoke cache must not resolve outside its dedicated directory".into());
    }
    Ok((root, config))
}

pub(crate) fn run_requested(mut context: tauri::Context<tauri::Wry>) -> i32 {
    let (root, config) = match configuration() {
        Ok(value) => value,
        Err(error) => {
            eprintln!("CEF bundle smoke rejected: {error}");
            return 78;
        }
    };
    let lock_path = root.join("running.lock");
    let _lock = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock_path)
    {
        Ok(_) => RootLock(lock_path),
        Err(error) => {
            eprintln!("smoke directory is already owned or unavailable: {error}");
            return 78;
        }
    };
    let controller =
        Arc::new(CefHostController::new(root.join("cef-cache")).expect("absolute cache"));
    for window in &mut context.config_mut().app.windows {
        window.create = window.label == "main";
        if window.create {
            window.url = tauri::WebviewUrl::External(tauri::Url::parse("about:blank").unwrap());
            window.incognito = true;
            window.data_directory = None;
            window.data_store_identifier = None;
            window.visible = false;
            window.title = "CCEM ad-hoc bundled CEF smoke".into();
        }
    }
    let result = Arc::new(Mutex::new(None::<Result<Value, String>>));
    let config = Arc::new(config);
    let event_code = match tauri::Builder::default().build(context) {
        Ok(app) => {
            let worker_result = result.clone();
            let worker_controller = controller.clone();
            let worker_root = root.clone();
            let worker_config = config.clone();
            let mut started = false;
            let mut exiting = false;
            app.run_return(move |app, event| match event {
                RunEvent::Ready if !started => {
                    started = true;
                    let app = app.clone();
                    let controller = worker_controller.clone();
                    let root = worker_root.clone();
                    let config = worker_config.clone();
                    let result = worker_result.clone();
                    thread::spawn(move || {
                        let outcome = exercise(&app, &controller, &root, &config);
                        let code = if outcome.is_ok() { 0 } else { 1 };
                        *result.lock().unwrap() = Some(outcome);
                        app.exit(code);
                    });
                }
                RunEvent::ExitRequested { code, api, .. } if !exiting => {
                    exiting = true;
                    api.prevent_exit();
                    let mut code = code.unwrap_or(1);
                    if let Err(error) = worker_controller.prepare_shutdown_current_thread() {
                        *worker_result.lock().unwrap() = Some(Err(error));
                        code = 1;
                    }
                    app.exit(code);
                }
                _ => {}
            })
        }
        Err(error) => {
            *result.lock().unwrap() = Some(Err(error.to_string()));
            1
        }
    };
    if let Err(error) = controller.finish_shutdown_current_thread() {
        let mut result = result.lock().unwrap();
        if result.as_ref().is_none_or(Result::is_ok) {
            *result = Some(Err(error));
        }
    }
    let outcome = result
        .lock()
        .unwrap()
        .take()
        .unwrap_or_else(|| Err("no smoke result".into()));
    let passed = outcome.is_ok() && event_code == 0;
    let receipt = json!({
        "schemaVersion": 1, "smoke": "macos-adhoc-cef-bundle", "status": if passed { "passed" } else { "failed" },
        "nonce": config.nonce, "phase": config.phase, "pid": std::process::id(),
        "executable": std::env::current_exe().ok(), "root": root,
        "normalStartupBypassed": true, "releaseBuild": true,
        "facts": outcome.as_ref().ok(), "error": outcome.as_ref().err(), "eventCode": event_code,
    });
    let receipt_path = root.join(format!("{}.json", config.phase));
    let write = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&receipt_path)
        .and_then(|mut file| file.write_all(&serde_json::to_vec_pretty(&receipt).unwrap()));
    if let Err(error) = write {
        eprintln!("write CEF smoke receipt: {error}");
        return 1;
    }
    eprintln!("CEF bundle smoke receipt: {}", receipt_path.display());
    if passed {
        0
    } else {
        1
    }
}

fn exercise(
    app: &tauri::AppHandle,
    controller: &CefHostController,
    root: &PathBuf,
    config: &Config,
) -> Result<Value, String> {
    let window = app
        .get_webview_window("main")
        .ok_or("missing main smoke window")?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    eprintln!(
        "CEF bundle smoke {}: initializing bundled runtime",
        config.phase
    );
    let layout = controller.ensure_ready(app)?;
    if !layout.bundled || !layout.sandbox_enabled {
        return Err("CEF must be bundled and sandboxed".into());
    }
    let marker =
        expected_credential_store_marker(CefCredentialStorePolicy::AdHocSystemKeychain, None)?;
    validate_credential_store_marker(&root.join("cef-cache/.ccem-credential-store"), &marker)?;
    eprintln!(
        "CEF bundle smoke {}: bundled sandboxed runtime ready",
        config.phase
    );
    let first = format!("{}start", config.origin);
    let next = format!("{}navigated", config.origin);
    let mut connection = controller.open_surface(
        app,
        CefSurfaceRequest {
            surface_id: SURFACE.into(),
            profile_id: "profile-00000000000000000000000000000003".into(),
            initial_url: first.clone(),
            viewport: LogicalViewport {
                x: 30.0,
                y: 40.0,
                width: 720.0,
                height: 480.0,
            },
            visible: true,
        },
    )?;
    let result: Result<Value, String> = (|| {
        let ready = connection.wait_until_ready(TIMEOUT)?;
        if ready.lifecycle != CefSurfaceLifecycle::Ready || !ready.visible {
            return Err("surface did not become visible and ready".into());
        }
        let before = require_document(&mut connection, "CCEM_BUNDLE_START", &first, &config.nonce)?;
        controller.navigate_surface(app, SURFACE.into(), next.clone())?;
        let deadline = Instant::now() + TIMEOUT;
        while connection.snapshot().current_url != next
            || connection.snapshot().lifecycle != CefSurfaceLifecycle::Ready
        {
            if Instant::now() >= deadline {
                return Err("surface navigation timed out".into());
            }
            thread::sleep(Duration::from_millis(25));
        }
        let after = require_document(
            &mut connection,
            "CCEM_BUNDLE_NAVIGATED",
            &next,
            &config.nonce,
        )?;
        eprintln!(
            "CEF bundle smoke {}: renderer navigation and cookie verified",
            config.phase
        );
        controller.set_surface_visible(app, SURFACE.into(), false)?;
        if controller.surface_snapshot(app, SURFACE.into())?.visible {
            return Err("surface failed to hide".into());
        }
        controller.set_surface_visible(app, SURFACE.into(), true)?;
        if !controller.surface_snapshot(app, SURFACE.into())?.visible {
            return Err("surface failed to show".into());
        }
        Ok(
            json!({ "bundled": true, "sandboxEnabled": true, "credentialStore": "macos-system-keychain-adhoc",
            "persistentProfile": true, "visible": true, "hideShowVerified": true, "before": before, "after": after }),
        )
    })();
    let close = controller
        .close_surface(app, SURFACE.into())
        .and_then(|_| connection.wait_until_closed(TIMEOUT))
        .and_then(|snapshot| {
            if snapshot.lifecycle == CefSurfaceLifecycle::Closed && !snapshot.visible {
                Ok(())
            } else {
                Err("surface did not close".to_string())
            }
        });
    let mut facts = result?;
    close?;
    facts["closed"] = json!(true);
    Ok(facts)
}

fn require_document(
    connection: &mut CefSurfaceConnection,
    title: &str,
    url: &str,
    nonce: &str,
) -> Result<Value, String> {
    let deadline = Instant::now() + TIMEOUT;
    let mut id = 100;
    while Instant::now() < deadline {
        id += 1;
        let value = evaluate(connection, id, deadline)?;
        let cookie = value["cookie"].as_str().unwrap_or("");
        if value["title"] == title
            && value["url"] == url
            && cookie
                .split(';')
                .map(str::trim)
                .any(|v| v == format!("ccem_bundle_smoke={nonce}"))
        {
            return Ok(value);
        }
        thread::sleep(Duration::from_millis(50));
    }
    Err(format!(
        "renderer did not reach {title} with the persistent cookie"
    ))
}

fn evaluate(
    connection: &mut CefSurfaceConnection,
    id: u32,
    deadline: Instant,
) -> Result<Value, String> {
    let mut command = serde_json::to_vec(&json!({ "id": id, "method": "Runtime.evaluate", "params": {
        "expression": "({title:document.title,url:location.href,cookie:document.cookie})", "returnByValue": true
    }})).unwrap();
    command.push(0);
    connection
        .writer
        .write_all(&command)
        .map_err(|e| e.to_string())?;
    let mut buffered = Vec::new();
    while Instant::now() < deadline {
        let mut chunk = [0; 4096];
        match connection.reader.read(&mut chunk) {
            Ok(0) => return Err("CEF CDP transport closed".into()),
            Ok(count) => {
                buffered.extend_from_slice(&chunk[..count]);
                if buffered.len() > 1024 * 1024 {
                    return Err("CEF CDP response exceeded 1 MiB".into());
                }
                while let Some(end) = buffered.iter().position(|v| *v == 0) {
                    let frame: Vec<_> = buffered.drain(..=end).collect();
                    let value: Value = serde_json::from_slice(&frame[..frame.len() - 1])
                        .map_err(|e| e.to_string())?;
                    if value["id"] == id {
                        return value
                            .pointer("/result/result/value")
                            .cloned()
                            .ok_or_else(|| format!("CDP evaluation failed: {value}"));
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("CEF CDP response timed out".into())
}
