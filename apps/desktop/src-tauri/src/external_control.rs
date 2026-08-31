use crate::browser::{BrowserBounds, BrowserManager, BrowserToolRequest};
use crate::config::{self, resolve_claude_env, resolve_codex_runtime};
use crate::event_bus::ReplayBatch;
use crate::native_runtime::{
    NativeProvider, NativeRuntimeManager, NativeSessionOptions, NativeSessionSummary,
    RouterLaunchDraft,
};
use crate::proxy_debug::ProxyDebugManager;
use crate::router::{
    rename_router_config_environment, router_config_environment_references, validate_router_config,
    RouterConfig, RouterManager, SessionRouterState, UpdateSessionRouterRequest,
};
use crate::session_provenance::{register_launch, SessionProvenanceUpsert, DEFAULT_CONFIG_SOURCE};
use crate::system_proxy;
use crate::terminal;
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::fs;
#[cfg(unix)]
use std::fs::OpenOptions;
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const HEADER_READ_LIMIT: usize = 1024 * 1024;
const BODY_READ_LIMIT: usize = 4 * 1024 * 1024;
const SOCKET_IO_TIMEOUT: Duration = Duration::from_secs(10);
const SOCKET_RETRY_SLEEP: Duration = Duration::from_millis(10);
const MIN_SOCKET_READ_TIMEOUT: Duration = Duration::from_millis(1);
const BROWSER_SMOKE_SESSION_ID: &str = "external-control-smoke";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalControlDescriptor {
    pub endpoint: String,
    pub token: String,
    pub pid: u32,
    pub created_at: String,
}

#[derive(Debug)]
struct ExternalControlRuntime {
    port: u16,
    shutdown_flag: Arc<AtomicBool>,
    join_handle: Option<thread::JoinHandle<()>>,
    published_descriptor: Option<PublishedControlDescriptor>,
}

#[derive(Debug)]
struct PublishedControlDescriptor {
    path: PathBuf,
    descriptor: ExternalControlDescriptor,
}

pub struct ExternalControlManager {
    runtime: Mutex<Option<ExternalControlRuntime>>,
    environment_mutations: Arc<config::EnvironmentMutationCoordinator>,
    native_runtime: Arc<NativeRuntimeManager>,
    token: String,
}

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

fn rpc_client_message_id(id: Option<&Value>) -> Option<String> {
    let raw = match id? {
        Value::String(value) => value.trim().to_string(),
        Value::Number(value) => value.to_string(),
        _ => return None,
    };
    if raw.is_empty() {
        None
    } else {
        Some(format!("external-control:{raw}"))
    }
}

#[derive(Debug)]
struct ControlRpcError {
    message: String,
    data: Option<Value>,
}

impl ControlRpcError {
    fn with_data(message: impl Into<String>, data: Value) -> Self {
        Self {
            message: message.into(),
            data: Some(data),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct EnvironmentMutationError {
    code: &'static str,
    message: String,
    references: Vec<String>,
}

impl EnvironmentMutationError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            references: Vec::new(),
        }
    }

    fn referenced(name: &str, mut references: Vec<String>) -> Self {
        references.sort();
        references.dedup();
        Self {
            code: "ENVIRONMENT_REFERENCED",
            message: format!(
                "Cannot delete environment '{}'; it is referenced by {}",
                name,
                references.join(", ")
            ),
            references,
        }
    }
}

fn apply_environment_rename(
    config: &mut config::CcemConfig,
    old_name: &str,
    new_name: &str,
) -> Result<(), EnvironmentMutationError> {
    if old_name.trim().is_empty() || new_name.trim().is_empty() {
        return Err(EnvironmentMutationError::new(
            "ENVIRONMENT_NAME_INVALID",
            "Environment names cannot be empty.",
        ));
    }
    if old_name == config::OFFICIAL_ENV_NAME {
        return Err(EnvironmentMutationError::new(
            "ENVIRONMENT_PROTECTED",
            format!(
                "Cannot rename the protected '{}' environment.",
                config::OFFICIAL_ENV_NAME
            ),
        ));
    }
    if !config.registries.contains_key(old_name) {
        return Err(EnvironmentMutationError::new(
            "ENVIRONMENT_NOT_FOUND",
            format!("Environment '{}' not found.", old_name),
        ));
    }
    if config.registries.contains_key(new_name) {
        return Err(EnvironmentMutationError::new(
            "ENVIRONMENT_ALREADY_EXISTS",
            format!("Environment '{}' already exists.", new_name),
        ));
    }

    let environment = config
        .registries
        .remove(old_name)
        .expect("environment existence checked above");
    config.registries.insert(new_name.to_string(), environment);
    if config.current.as_deref() == Some(old_name) {
        config.current = Some(new_name.to_string());
    }
    rename_router_config_environment(&mut config.router, old_name, new_name);
    Ok(())
}

fn apply_environment_delete(
    config: &mut config::CcemConfig,
    name: &str,
    native_references: Vec<String>,
) -> Result<(), EnvironmentMutationError> {
    if name.trim().is_empty() {
        return Err(EnvironmentMutationError::new(
            "ENVIRONMENT_NAME_INVALID",
            "Environment name cannot be empty.",
        ));
    }
    if name == config::OFFICIAL_ENV_NAME {
        return Err(EnvironmentMutationError::new(
            "ENVIRONMENT_PROTECTED",
            format!(
                "Cannot delete the protected '{}' environment.",
                config::OFFICIAL_ENV_NAME
            ),
        ));
    }
    if !config.registries.contains_key(name) {
        return Err(EnvironmentMutationError::new(
            "ENVIRONMENT_NOT_FOUND",
            format!("Environment '{}' not found.", name),
        ));
    }

    let mut references = router_config_environment_references(&config.router, name);
    references.extend(native_references);
    references.sort();
    references.dedup();
    if !references.is_empty() {
        return Err(EnvironmentMutationError::referenced(name, references));
    }

    config.registries.remove(name);
    if config.current.as_deref() == Some(name) {
        config.current = Some(config::OFFICIAL_ENV_NAME.to_string());
    }
    Ok(())
}

fn environment_mutation_control_error(
    error: EnvironmentMutationError,
    operation: &'static str,
    environment_name: &str,
    new_name: Option<&str>,
) -> ControlRpcError {
    ControlRpcError::with_data(
        error.message,
        json!({
            "code": error.code,
            "operation": operation,
            "environmentName": environment_name,
            "newName": new_name,
            "references": error.references,
        }),
    )
}

fn environment_system_control_error(
    code: &'static str,
    message: impl Into<String>,
    operation: &'static str,
    environment_name: &str,
    new_name: Option<&str>,
) -> ControlRpcError {
    ControlRpcError::with_data(
        message,
        json!({
            "code": code,
            "operation": operation,
            "environmentName": environment_name,
            "newName": new_name,
            "references": [],
        }),
    )
}

impl From<String> for ControlRpcError {
    fn from(message: String) -> Self {
        Self {
            message,
            data: None,
        }
    }
}

impl From<&str> for ControlRpcError {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSessionParams {
    provider: String,
    #[serde(alias = "workingDir")]
    cwd: Option<String>,
    prompt: String,
    env_name: Option<String>,
    permission_mode: Option<String>,
    runtime_permission_mode: Option<String>,
    provider_session_id: Option<String>,
    effort: Option<String>,
    open: Option<bool>,
    router_launch_draft: Option<RouterLaunchDraft>,
    routes: Option<HashMap<String, String>>,
    allowed_envs: Option<Vec<String>>,
    dynamic_routing: Option<bool>,
}

fn resolve_external_router_launch_draft(
    params: &CreateSessionParams,
) -> Result<Option<RouterLaunchDraft>, String> {
    let has_legacy_draft = params.routes.is_some()
        || params.allowed_envs.is_some()
        || params.dynamic_routing.is_some();
    if params.router_launch_draft.is_some() && has_legacy_draft {
        return Err(
            "ROUTER_LAUNCH_DRAFT_CONFLICT: routerLaunchDraft cannot be combined with legacy routes, allowedEnvs, or dynamicRouting fields"
                .to_string(),
        );
    }
    if let Some(draft) = params.router_launch_draft.as_ref() {
        return Ok(Some(draft.clone()));
    }
    if !has_legacy_draft {
        return Ok(None);
    }
    Ok(Some(RouterLaunchDraft {
        bindings: params.routes.clone().unwrap_or_default(),
        allowed_envs: params.allowed_envs.clone().unwrap_or_default(),
        source_profile_id: None,
        profile_revision: None,
        dynamic_routing: params.dynamic_routing,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListSessionsParams {
    cwd: Option<String>,
    provider: Option<String>,
    status: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeIdParams {
    runtime_id: String,
}

#[derive(Debug, Deserialize)]
struct EnvironmentNameParams {
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameEnvironmentParams {
    old_name: String,
    new_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventsParams {
    runtime_id: String,
    since_seq: Option<u64>,
    limit: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendInputParams {
    runtime_id: String,
    client_message_id: Option<String>,
    text: String,
    display_text: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenSessionParams {
    link: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserSmokeProbeParams {
    url: String,
    workspace_dir: Option<String>,
    marker_text: Option<String>,
    navigate_url: Option<String>,
    navigate_marker_text: Option<String>,
    input_label: Option<String>,
    input_text: Option<String>,
    click_label: Option<String>,
    wait_for_text: Option<String>,
    verify_pause: Option<bool>,
    verify_stale_snapshot: Option<bool>,
    verify_console: Option<bool>,
    timeout_ms: Option<u64>,
    close: Option<bool>,
    bounds: Option<BrowserBounds>,
}

impl ExternalControlManager {
    pub fn new(
        native_runtime: Arc<NativeRuntimeManager>,
        environment_mutations: Arc<config::EnvironmentMutationCoordinator>,
    ) -> Self {
        Self {
            runtime: Mutex::new(None),
            environment_mutations,
            native_runtime,
            token: generate_token(),
        }
    }

    pub fn start(self: &Arc<Self>, app: AppHandle) -> Result<u16, String> {
        if let Some(port) = self.current_port() {
            return Ok(port);
        }

        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|error| format!("Failed to bind external control listener: {}", error))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("Failed to configure external control listener: {}", error))?;
        let port = listener
            .local_addr()
            .map_err(|error| {
                format!(
                    "Failed to read external control listener address: {}",
                    error
                )
            })?
            .port();

        let endpoint = format!("http://127.0.0.1:{}/rpc", port);
        let descriptor = ExternalControlDescriptor {
            endpoint,
            token: self.token.clone(),
            pid: std::process::id(),
            created_at: now_rfc3339(),
        };
        let published_descriptor = if should_publish_control_descriptor() {
            let path = control_descriptor_path();
            write_descriptor_at(&path, &descriptor)?;
            Some(PublishedControlDescriptor {
                path,
                descriptor: descriptor.clone(),
            })
        } else {
            None
        };

        let shutdown_flag = Arc::new(AtomicBool::new(false));
        let shutdown_for_thread = Arc::clone(&shutdown_flag);
        let manager = Arc::clone(self);
        let join_handle = thread::spawn(move || {
            while !shutdown_for_thread.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _addr)) => {
                        let manager = Arc::clone(&manager);
                        let app = app.clone();
                        thread::spawn(move || {
                            manager.handle_connection(&app, stream);
                        });
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(20));
                    }
                    Err(error) => {
                        eprintln!("External control accept error: {}", error);
                        thread::sleep(Duration::from_millis(50));
                    }
                }
            }
        });

        *self.runtime.lock().unwrap() = Some(ExternalControlRuntime {
            port,
            shutdown_flag,
            join_handle: Some(join_handle),
            published_descriptor,
        });

        Ok(port)
    }

    pub fn shutdown(&self) {
        let runtime = self.runtime.lock().unwrap().take();
        let mut published_descriptor = None;
        if let Some(mut runtime) = runtime {
            runtime.shutdown_flag.store(true, Ordering::Relaxed);
            if let Some(handle) = runtime.join_handle.take() {
                let _ = handle.join();
            }
            published_descriptor = runtime.published_descriptor.take();
        }
        if let Some(published) = published_descriptor {
            remove_descriptor_if_owned(&published.path, &published.descriptor);
        }
    }

    pub fn current_port(&self) -> Option<u16> {
        self.runtime
            .lock()
            .unwrap()
            .as_ref()
            .map(|runtime| runtime.port)
    }

    fn handle_connection(self: &Arc<Self>, app: &AppHandle, mut stream: TcpStream) {
        let _ = stream.set_read_timeout(Some(SOCKET_IO_TIMEOUT));
        let _ = stream.set_write_timeout(Some(SOCKET_IO_TIMEOUT));
        let response = match read_http_request(&mut stream) {
            Ok(request) => self.handle_http_request(app, request),
            Err(error) => HttpResponse::json_error(400, None, -32700, &error),
        };
        let _ = stream.write_all(&response.to_bytes());
    }

    fn handle_http_request(&self, app: &AppHandle, request: HttpRequest) -> HttpResponse {
        if request.method != "POST" || request.path != "/rpc" {
            return HttpResponse::plain(404, "Not found");
        }

        // Host header must be loopback to prevent DNS rebinding attacks.
        if let Some(host_header) = request.headers.get("host") {
            if !is_loopback_host_header(host_header) {
                return HttpResponse::plain(403, "Forbidden: non-loopback Host header");
            }
        } else {
            // HTTP/1.1 requires a Host header; reject if missing.
            return HttpResponse::plain(400, "Bad Request: missing Host header");
        }

        // Origin (if present) must be a loopback origin. Non-browser clients
        // (like the ccem CLI) typically omit Origin, so only enforce when set.
        if let Some(origin) = request.headers.get("origin") {
            if !is_loopback_origin(origin) {
                return HttpResponse::plain(403, "Forbidden: non-loopback Origin header");
            }
        }

        // Content-Type must be application/json for POST /rpc.
        if !is_json_content_type(request.headers.get("content-type").map(String::as_str)) {
            return HttpResponse::plain(
                415,
                "Unsupported Media Type: Content-Type must be application/json",
            );
        }

        let expected_auth = format!("Bearer {}", self.token);
        if request.headers.get("authorization").map(String::as_str) != Some(expected_auth.as_str())
        {
            return HttpResponse::json_error(401, None, -32001, "Unauthorized");
        }

        let rpc = match serde_json::from_slice::<JsonRpcRequest>(&request.body) {
            Ok(rpc) => rpc,
            Err(error) => {
                return HttpResponse::json_error(
                    400,
                    None,
                    -32700,
                    &format!("Invalid JSON: {}", error),
                );
            }
        };
        let id = rpc.id.clone();

        // Method allowlist: reject unknown JSON-RPC methods with -32601.
        if !is_allowed_method(&rpc.method) {
            return HttpResponse::json_error(
                200,
                id,
                -32601,
                &format!("Method not found: {}", rpc.method),
            );
        }

        match self.handle_rpc(app, rpc) {
            Ok(result) => HttpResponse::json_result(id, result),
            Err(error) => {
                HttpResponse::json_error_with_data(200, id, -32000, &error.message, error.data)
            }
        }
    }

    fn handle_rpc(&self, app: &AppHandle, rpc: JsonRpcRequest) -> Result<Value, ControlRpcError> {
        match rpc.method.as_str() {
            "ccem.health" => Ok(json!({
                "ok": true,
                "pid": std::process::id(),
                "running": true,
                "version": env!("CARGO_PKG_VERSION"),
            })),
            "ccem.workspace.listSessions" => {
                let _mutation_guard = self.environment_mutations.lock()?;
                let params = deserialize_params::<ListSessionsParams>(rpc.params)?;
                let sessions = self
                    .native_runtime
                    .list_sessions()
                    .into_iter()
                    .filter(|session| session_matches(session, &params))
                    .map(ControlSessionSummary::from)
                    .collect::<Vec<_>>();
                Ok(serde_json::to_value(sessions).map_err(|error| error.to_string())?)
            }
            "ccem.environment.references" => {
                let _mutation_guard = self.environment_mutations.lock()?;
                let params = deserialize_params::<EnvironmentNameParams>(rpc.params)?;
                let name = params.name.trim();
                if name.is_empty() {
                    return Err("Environment name cannot be empty".into());
                }
                let references = self.native_runtime.router_environment_references(name)?;
                Ok(json!({ "references": references }))
            }
            "ccem.environment.rename" => {
                let params = deserialize_params::<RenameEnvironmentParams>(rpc.params)?;
                self.rename_environment(app, params)
            }
            "ccem.environment.delete" => {
                let params = deserialize_params::<EnvironmentNameParams>(rpc.params)?;
                self.delete_environment(params)
            }
            "ccem.workspace.getSession" => {
                let _mutation_guard = self.environment_mutations.lock()?;
                let params = deserialize_params::<RuntimeIdParams>(rpc.params)?;
                let session = self
                    .native_runtime
                    .list_sessions()
                    .into_iter()
                    .find(|session| session.runtime_id == params.runtime_id)
                    .map(ControlSessionSummary::from)
                    .ok_or_else(|| format!("Native runtime {} not found", params.runtime_id))?;
                Ok(serde_json::to_value(session).map_err(|error| error.to_string())?)
            }
            "ccem.workspace.getEvents" => {
                let params = deserialize_params::<EventsParams>(rpc.params)?;
                let events = self.native_runtime.replay_events_limited(
                    &params.runtime_id,
                    params.since_seq,
                    params.limit,
                )?;
                Ok(serde_json::to_value(ControlReplayBatch::from(events))
                    .map_err(|error| error.to_string())?)
            }
            "ccem.workspace.sendInput" => {
                let params = deserialize_params::<SendInputParams>(rpc.params)?;
                let client_message_id = params
                    .client_message_id
                    .clone()
                    .or_else(|| rpc_client_message_id(rpc.id.as_ref()));
                let _mutation_guard = self.environment_mutations.lock()?;
                self.native_runtime.send_user_message(
                    app,
                    &params.runtime_id,
                    &params.text,
                    params.display_text.as_deref(),
                    None,
                    None,
                    client_message_id.as_deref(),
                )?;
                Ok(json!({ "ok": true }))
            }
            "ccem.workspace.openSession" => {
                let params = deserialize_params::<OpenSessionParams>(rpc.params)?;
                app.emit(
                    "ccem-control-request",
                    json!({
                        "kind": "openSession",
                        "link": params.link,
                    }),
                )
                .map_err(|error| format!("Failed to emit workspace open request: {}", error))?;
                if let Some(window) = app.get_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
                Ok(json!({ "ok": true }))
            }
            "ccem.workspace.createSession" => {
                let params = deserialize_params::<CreateSessionParams>(rpc.params)?;
                let summary = self.create_session(app.clone(), params)?;
                Ok(serde_json::to_value(summary).map_err(|error| error.to_string())?)
            }
            "ccem.router.getSettings" => {
                let _mutation_guard = self.environment_mutations.lock()?;
                let settings = config::read_config()?.router;
                Ok(serde_json::to_value(settings).map_err(|error| error.to_string())?)
            }
            "ccem.router.updateSettings" => {
                let settings = deserialize_params::<RouterConfig>(rpc.params)?;
                let _mutation_guard = self.environment_mutations.lock()?;
                validate_router_config(&settings).map_err(|error| error.to_string())?;
                let proxy = app
                    .try_state::<Arc<ProxyDebugManager>>()
                    .ok_or_else(|| "Router listener manager is unavailable.".to_string())?
                    .inner()
                    .clone();
                proxy.validate_router_config_change(&settings)?;
                config::update_ccem_config(|config| {
                    config::validate_router_config_environment_targets(
                        &settings,
                        &config.registries,
                    )?;
                    config.router = settings.clone();
                    Ok(())
                })?;
                let status = tauri::async_runtime::block_on(proxy.apply_router_config(settings))?;
                Ok(serde_json::to_value(status).map_err(|error| error.to_string())?)
            }
            "ccem.router.status" => {
                let router = app
                    .try_state::<Arc<RouterManager>>()
                    .ok_or_else(|| "Router manager is unavailable.".to_string())?;
                Ok(serde_json::to_value(router.status()).map_err(|error| error.to_string())?)
            }
            "ccem.workspace.getRouter" => {
                let _mutation_guard = self.environment_mutations.lock()?;
                let params = deserialize_params::<RuntimeIdParams>(rpc.params)?;
                let state = self
                    .native_runtime
                    .get_session_router(&params.runtime_id)
                    .map_err(|error| {
                        let data = serde_json::to_value(&error).unwrap_or(Value::Null);
                        ControlRpcError::with_data(error.to_string(), data)
                    })?;
                Ok(serde_json::to_value(state).map_err(|error| error.to_string())?)
            }
            "ccem.workspace.updateRouter" => {
                let request = deserialize_params::<UpdateSessionRouterRequest>(rpc.params)?;
                let _mutation_guard = self.environment_mutations.lock()?;
                let state = self
                    .native_runtime
                    .update_session_router(app, request, "externalControl")
                    .map_err(|error| {
                        let data = serde_json::to_value(&error).unwrap_or(Value::Null);
                        ControlRpcError::with_data(error.to_string(), data)
                    })?;
                Ok(serde_json::to_value(state).map_err(|error| error.to_string())?)
            }
            "ccem.workspace.restartDirect" => {
                let params = deserialize_params::<RuntimeIdParams>(rpc.params)?;
                let _mutation_guard = self.environment_mutations.lock()?;
                let state = self
                    .native_runtime
                    .restart_session_direct(app, &params.runtime_id)
                    .map_err(|error| {
                        let data = serde_json::to_value(&error).unwrap_or(Value::Null);
                        ControlRpcError::with_data(error.to_string(), data)
                    })?;
                Ok(serde_json::to_value(state).map_err(|error| error.to_string())?)
            }
            method => Err(format!("Unknown method: {}", method).into()),
        }
    }

    fn rename_environment(
        &self,
        app: &AppHandle,
        params: RenameEnvironmentParams,
    ) -> Result<Value, ControlRpcError> {
        let old_name = params.old_name.as_str();
        let new_name = params.new_name.as_str();
        let _mutation_guard = self.environment_mutations.lock().map_err(|_| {
            environment_system_control_error(
                "ENVIRONMENT_MUTATION_UNAVAILABLE",
                "Environment mutation coordinator is unavailable.",
                "rename",
                old_name,
                Some(new_name),
            )
        })?;
        let prepare_error = RefCell::new(None);
        let result = config::commit_environment_rename(
            old_name,
            new_name,
            |next| {
                apply_environment_rename(next, old_name, new_name).map_err(|error| {
                    let message = error.message.clone();
                    *prepare_error.borrow_mut() = Some(error);
                    message
                })
            },
            |from, to| {
                self.native_runtime
                    .rename_router_environment_references(from, to)
            },
        );
        let (events, next) = result.map_err(|error| {
            if let Some(mutation_error) = prepare_error.into_inner() {
                return environment_mutation_control_error(
                    mutation_error,
                    "rename",
                    old_name,
                    Some(new_name),
                );
            }
            let code = match error.stage {
                config::EnvironmentRenameStage::NativeMutation => {
                    "ENVIRONMENT_NATIVE_MUTATION_FAILED"
                }
                config::EnvironmentRenameStage::Rollback => "ENVIRONMENT_ROLLBACK_FAILED",
                config::EnvironmentRenameStage::ConfigAccess => "ENVIRONMENT_CONFIG_UNAVAILABLE",
                config::EnvironmentRenameStage::Prepare => "ENVIRONMENT_CONFIG_INVALID",
                config::EnvironmentRenameStage::TransitionWrite
                | config::EnvironmentRenameStage::FinalWrite => "ENVIRONMENT_CONFIG_WRITE_FAILED",
            };
            environment_system_control_error(
                code,
                error.to_string(),
                "rename",
                old_name,
                Some(new_name),
            )
        })?;

        let updated_sessions = events.len();
        for event in events {
            if let Err(error) = app.emit("native-session-router-updated", event) {
                eprintln!("Failed to emit router environment rename event: {error}");
            }
        }
        Ok(json!({
            "ok": true,
            "operation": "rename",
            "oldName": old_name,
            "newName": new_name,
            "updatedSessions": updated_sessions,
            "current": next.current,
        }))
    }

    fn delete_environment(&self, params: EnvironmentNameParams) -> Result<Value, ControlRpcError> {
        let name = params.name.as_str();
        let _mutation_guard = self.environment_mutations.lock().map_err(|_| {
            environment_system_control_error(
                "ENVIRONMENT_MUTATION_UNAVAILABLE",
                "Environment mutation coordinator is unavailable.",
                "delete",
                name,
                None,
            )
        })?;
        let current = config::update_ccem_config_transaction(|next| {
            let native_references = self
                .native_runtime
                .router_environment_references(name)
                .map_err(|error| {
                    environment_system_control_error(
                        "ENVIRONMENT_NATIVE_STATE_UNAVAILABLE",
                        format!("Failed to inspect native environment references: {error}"),
                        "delete",
                        name,
                        None,
                    )
                })?;
            apply_environment_delete(next, name, native_references)
                .map_err(|error| environment_mutation_control_error(error, "delete", name, None))?;
            Ok(next.current.clone())
        })
        .map_err(|error| match error {
            config::CcemConfigTransactionError::Operation(error) => error,
            config::CcemConfigTransactionError::Storage(error) => environment_system_control_error(
                "ENVIRONMENT_CONFIG_WRITE_FAILED",
                format!("Failed to update environment config: {error}"),
                "delete",
                name,
                None,
            ),
        })?;
        Ok(json!({
            "ok": true,
            "operation": "delete",
            "name": name,
            "current": current,
        }))
    }

    fn create_session(
        &self,
        app: AppHandle,
        params: CreateSessionParams,
    ) -> Result<ControlCreateSessionResult, String> {
        let mutation_guard = self.environment_mutations.lock()?;
        let provider = parse_native_provider(&params.provider)?;
        let router_launch_draft = resolve_external_router_launch_draft(&params)?;
        if provider != NativeProvider::Claude && router_launch_draft.is_some() {
            return Err(
                "ROUTER_PROVIDER_UNSUPPORTED: dynamic routing is only available for Claude sessions"
                    .to_string(),
            );
        }
        let env_name = params
            .env_name
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or_else(resolve_current_env)
            .unwrap_or_else(|| "official".to_string());
        let working_dir = resolve_working_dir(params.cwd)?;
        let perm_mode = resolve_effective_perm_mode(params.permission_mode)?;
        let runtime_perm_mode = params
            .runtime_permission_mode
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty() && value != &perm_mode);
        if let Some(ref rpm) = runtime_perm_mode {
            if !is_known_perm_mode(rpm) {
                return Err(format!(
                    "Invalid runtime_permission_mode '{}': expected one of {}",
                    rpm,
                    KNOWN_PERM_MODES.join(", ")
                ));
            }
        }

        let options = match provider {
            NativeProvider::Claude => {
                let resolved = resolve_claude_env(&env_name)?;
                NativeSessionOptions {
                    provider,
                    env_name: resolved.env_name,
                    perm_mode,
                    runtime_perm_mode,
                    working_dir,
                    initial_prompt: Some(params.prompt),
                    display_prompt: None,
                    initial_images: None,
                    initial_annotations: None,
                    provider_session_id: params.provider_session_id,
                    seed_boundary_message_count: None,
                    helper_env_vars: resolved.env_vars.clone(),
                    terminal_env_vars: resolved.env_vars,
                    claude_path: terminal::resolve_claude_path(),
                    codex_path: None,
                    codex_base_url: None,
                    codex_api_key: None,
                    effort: params.effort,
                    router_launch_draft,
                    router_record: None,
                    fork_from_message_id: None,
                }
            }
            NativeProvider::Codex => {
                let resolved = resolve_codex_runtime(&env_name)?;
                let proxy_env_vars = system_proxy::resolve_codex_proxy_env();
                NativeSessionOptions {
                    provider,
                    env_name: if resolved.env_name.is_empty() {
                        env_name
                    } else {
                        resolved.env_name
                    },
                    perm_mode,
                    runtime_perm_mode,
                    working_dir,
                    initial_prompt: Some(params.prompt),
                    display_prompt: None,
                    initial_images: None,
                    initial_annotations: None,
                    provider_session_id: params.provider_session_id,
                    seed_boundary_message_count: None,
                    helper_env_vars: proxy_env_vars.clone(),
                    terminal_env_vars: proxy_env_vars,
                    claude_path: None,
                    codex_path: terminal::resolve_codex_path(),
                    codex_base_url: None,
                    codex_api_key: None,
                    effort: params.effort,
                    router_launch_draft: None,
                    router_record: None,
                    fork_from_message_id: None,
                }
            }
        };

        let open = params.open.unwrap_or(false);
        let summary = self.native_runtime.create_session(app.clone(), options)?;
        drop(mutation_guard);
        if let Err(error) = register_launch(SessionProvenanceUpsert {
            ccem_session_id: summary.runtime_id.clone(),
            client: summary.provider.as_str().to_string(),
            env_name: summary.env_name.clone(),
            config_source: Some(DEFAULT_CONFIG_SOURCE.to_string()),
            working_dir: summary.project_dir.clone(),
            perm_mode: Some(summary.perm_mode.clone()),
            launch_mode: "external_control".to_string(),
            started_via: "desktop_control".to_string(),
            source_session_id: summary.provider_session_id.clone(),
        }) {
            eprintln!(
                "Failed to register external-control launch provenance for {}: {}",
                summary.runtime_id, error
            );
        }

        let result = ControlCreateSessionResult::from(summary);
        if open {
            let _ = app.emit(
                "ccem-control-request",
                json!({
                    "kind": "openSession",
                    "link": result.link,
                }),
            );
        }
        Ok(result)
    }

    fn browser_smoke_probe(
        &self,
        app: &AppHandle,
        params: BrowserSmokeProbeParams,
    ) -> Result<Value, String> {
        let close_after = params.close.unwrap_or(true);
        let browser = app
            .try_state::<Arc<BrowserManager>>()
            .ok_or_else(|| "Browser manager is not available".to_string())?
            .inner()
            .clone();

        let result = run_browser_smoke_probe(app, &browser, params);
        if close_after {
            let _ = browser.close(app, Some(BROWSER_SMOKE_SESSION_ID));
        }
        result
    }
}

fn run_browser_smoke_probe(
    app: &AppHandle,
    browser: &BrowserManager,
    params: BrowserSmokeProbeParams,
) -> Result<Value, String> {
    let timeout_ms = params.timeout_ms.unwrap_or(8_000).clamp(500, 30_000);
    let workspace_dir = params.workspace_dir.clone().unwrap_or_else(|| {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .to_string_lossy()
            .into_owned()
    });
    let bounds = params.bounds.unwrap_or(BrowserBounds {
        x: 64.0,
        y: 72.0,
        width: 760.0,
        height: 520.0,
    });
    let mut steps = Vec::new();

    let info = browser.open(app, Some(BROWSER_SMOKE_SESSION_ID), Some(&params.url))?;
    steps.push(json!({
        "step": "open",
        "url": info.url,
        "visible": info.visible,
    }));
    // External smoke is never allowed to supersede a Workspace presentation that already owns
    // the native browser slot. Epoch one works only before the Workspace has selected an owner.
    browser.set_active_session(app, Some(BROWSER_SMOKE_SESSION_ID), true, Some(1))?;
    steps.push(json!({ "step": "activate", "sessionId": BROWSER_SMOKE_SESSION_ID }));

    browser.set_bounds(app, Some(BROWSER_SMOKE_SESSION_ID), bounds)?;
    steps.push(json!({ "step": "setBounds", "bounds": bounds }));

    let mut snapshot = wait_for_browser_snapshot(
        app,
        browser,
        BROWSER_SMOKE_SESSION_ID,
        params.marker_text.as_deref(),
        timeout_ms,
    )?;
    steps.push(json!({
        "step": "snapshot",
        "snapshot": summarize_browser_snapshot(&snapshot),
        "matched": params
            .marker_text
            .as_deref()
            .map(|marker| snapshot_text_contains(&snapshot, marker))
            .unwrap_or(true),
    }));

    if params.verify_pause.unwrap_or(false) {
        let paused = browser.set_paused(app, Some(BROWSER_SMOKE_SESSION_ID), true)?;
        let paused_error = match browser.run_tool(
            app,
            BROWSER_SMOKE_SESSION_ID,
            &workspace_dir,
            &BrowserToolRequest {
                request_id: "smoke-paused-get-url".to_string(),
                tool: "get_url".to_string(),
                args: json!({}),
            },
        ) {
            Ok(_) => {
                return Err("Paused browser action unexpectedly succeeded.".to_string());
            }
            Err(error) => error,
        };
        if !paused_error.to_ascii_lowercase().contains("paused") {
            return Err(format!(
                "Paused browser action returned an unexpected error: {paused_error}"
            ));
        }
        steps.push(json!({
            "step": "pause",
            "paused": paused.paused,
            "control": paused.control,
            "blockedError": paused_error,
        }));
        let resumed = browser.set_paused(app, Some(BROWSER_SMOKE_SESSION_ID), false)?;
        steps.push(json!({
            "step": "resume",
            "paused": resumed.paused,
            "control": resumed.control,
        }));
    }

    if let Some(navigate_url) = params.navigate_url.as_deref() {
        let info = browser.navigate(app, Some(BROWSER_SMOKE_SESSION_ID), navigate_url)?;
        steps.push(json!({
            "step": "navigate",
            "url": info.url,
            "visible": info.visible,
        }));
        snapshot = wait_for_browser_snapshot(
            app,
            browser,
            BROWSER_SMOKE_SESSION_ID,
            params
                .navigate_marker_text
                .as_deref()
                .or(params.marker_text.as_deref()),
            timeout_ms,
        )?;
        steps.push(json!({
            "step": "navigateSnapshot",
            "snapshot": summarize_browser_snapshot(&snapshot),
            "matched": params
                .navigate_marker_text
                .as_deref()
                .map(|marker| snapshot_text_contains(&snapshot, marker))
                .unwrap_or(true),
        }));
    }

    if params.verify_stale_snapshot.unwrap_or(false) {
        let stale_snapshot_id = required_snapshot_id(&snapshot)?;
        let stale_ref = snapshot
            .get("elements")
            .and_then(Value::as_array)
            .and_then(|elements| elements.first())
            .and_then(|element| element.get("ref"))
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                "Browser stale-snapshot smoke requires at least one interactable element."
                    .to_string()
            })?;
        let fresh_snapshot = browser.snapshot(app, Some(BROWSER_SMOKE_SESSION_ID))?;
        let stale_error = match browser.run_tool(
            app,
            BROWSER_SMOKE_SESSION_ID,
            &workspace_dir,
            &BrowserToolRequest {
                request_id: "smoke-stale-snapshot".to_string(),
                tool: "click".to_string(),
                args: json!({ "snapshotId": stale_snapshot_id, "ref": stale_ref }),
            },
        ) {
            Ok(_) => return Err("Stale browser snapshot unexpectedly succeeded.".to_string()),
            Err(error) => error,
        };
        if !stale_error.to_ascii_lowercase().contains("stale") {
            return Err(format!(
                "Stale browser snapshot returned an unexpected error: {stale_error}"
            ));
        }
        steps.push(json!({
            "step": "staleSnapshotRejected",
            "blockedError": stale_error,
        }));
        snapshot = fresh_snapshot;
    }

    if let Some(label) = params.input_label.as_deref() {
        let reference = find_snapshot_ref_by_label(&snapshot, label)
            .ok_or_else(|| format!("Browser smoke input label not found: {label}"))?;
        let snapshot_id = required_snapshot_id(&snapshot)?;
        let text = params.input_text.clone().unwrap_or_default();
        let typed = browser.run_tool(
            app,
            BROWSER_SMOKE_SESSION_ID,
            &workspace_dir,
            &BrowserToolRequest {
                request_id: "smoke-type".to_string(),
                tool: "type".to_string(),
                args: json!({ "snapshotId": snapshot_id, "ref": reference, "text": text }),
            },
        )?;
        steps.push(json!({
            "step": "type",
            "label": label,
            "ref": reference,
            "result": typed,
        }));
        snapshot =
            wait_for_browser_snapshot(app, browser, BROWSER_SMOKE_SESSION_ID, None, timeout_ms)?;
    }

    if let Some(label) = params.click_label.as_deref() {
        let reference = find_snapshot_ref_by_label(&snapshot, label)
            .ok_or_else(|| format!("Browser smoke click label not found: {label}"))?;
        let snapshot_id = required_snapshot_id(&snapshot)?;
        let clicked = browser.run_tool(
            app,
            BROWSER_SMOKE_SESSION_ID,
            &workspace_dir,
            &BrowserToolRequest {
                request_id: "smoke-click".to_string(),
                tool: "click".to_string(),
                args: json!({ "snapshotId": snapshot_id, "ref": reference }),
            },
        )?;
        steps.push(json!({
            "step": "click",
            "label": label,
            "ref": reference,
            "result": clicked,
        }));
    }

    if let Some(text) = params.wait_for_text.as_deref() {
        let waited = browser.run_tool(
            app,
            BROWSER_SMOKE_SESSION_ID,
            &workspace_dir,
            &BrowserToolRequest {
                request_id: "smoke-wait-for".to_string(),
                tool: "wait_for".to_string(),
                args: json!({ "text": text, "timeoutMs": timeout_ms }),
            },
        )?;
        if !waited
            .get("found")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return Err(format!("Browser smoke text was not found: {text}"));
        }
        steps.push(json!({
            "step": "waitFor",
            "text": text,
            "result": waited,
        }));
        snapshot = wait_for_browser_snapshot(
            app,
            browser,
            BROWSER_SMOKE_SESSION_ID,
            Some(text),
            timeout_ms,
        )?;
    }

    if params.verify_console.unwrap_or(false) {
        let console = browser.run_tool(
            app,
            BROWSER_SMOKE_SESSION_ID,
            &workspace_dir,
            &BrowserToolRequest {
                request_id: "smoke-read-console".to_string(),
                tool: "read_console_log".to_string(),
                args: json!({}),
            },
        )?;
        verify_browser_console_log(&console)?;
        steps.push(json!({
            "step": "consoleLog",
            "summary": console,
        }));
    }

    let snapshot_artifact = browser.run_tool(
        app,
        BROWSER_SMOKE_SESSION_ID,
        &workspace_dir,
        &BrowserToolRequest {
            request_id: "smoke-snapshot-artifact".to_string(),
            tool: "snapshot".to_string(),
            args: json!({}),
        },
    )?;
    verify_browser_artifact(&snapshot_artifact, "interaction_snapshot")?;
    steps.push(json!({
        "step": "snapshotArtifact",
        "artifact": snapshot_artifact,
    }));

    let screenshot = browser.run_tool(
        app,
        BROWSER_SMOKE_SESSION_ID,
        &workspace_dir,
        &BrowserToolRequest {
            request_id: "smoke-screenshot".to_string(),
            tool: "screenshot".to_string(),
            args: json!({}),
        },
    )?;
    verify_browser_artifact(&screenshot, "screenshot")?;
    steps.push(json!({
        "step": "screenshot",
        "artifact": screenshot,
    }));

    let recent_activity = browser.recent_activity(BROWSER_SMOKE_SESSION_ID)?;
    if params.verify_console.unwrap_or(false) {
        verify_browser_audit_log(
            recent_activity.audit_log_path.as_deref(),
            params.input_text.as_deref(),
        )?;
    }
    steps.push(json!({
        "step": "recentActivity",
        "activity": recent_activity,
    }));

    let health = browser.health_check(app, Some(BROWSER_SMOKE_SESSION_ID))?;
    steps.push(json!({
        "step": "health",
        "lifecycle": health.lifecycle,
        "loading": health.loading,
        "control": health.control,
        "generation": health.generation,
        "url": health.url,
        "title": health.title,
    }));

    Ok(json!({
        "ok": true,
        "snapshot": summarize_browser_snapshot(&snapshot),
        "steps": steps,
    }))
}

fn required_snapshot_id(snapshot: &Value) -> Result<String, String> {
    snapshot
        .get("snapshot_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "Browser smoke snapshot did not include a snapshot id.".to_string())
}

fn verify_browser_artifact(artifact: &Value, expected_kind: &str) -> Result<(), String> {
    let kind = artifact
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| "Browser smoke artifact did not include a kind.".to_string())?;
    if kind != expected_kind {
        return Err(format!(
            "Browser smoke artifact kind mismatch: expected {expected_kind}, got {kind}."
        ));
    }
    let path = artifact
        .get("path")
        .and_then(Value::as_str)
        .map(Path::new)
        .ok_or_else(|| "Browser smoke artifact did not include a path.".to_string())?;
    if !path.is_absolute() || !path.is_file() {
        return Err(format!(
            "Browser smoke artifact path is not a readable absolute file: {}",
            path.display()
        ));
    }
    let sha256 = artifact
        .get("sha256")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Browser smoke artifact did not include a valid SHA-256.".to_string());
    }
    if expected_kind == "interaction_snapshot" {
        let payload: Value = serde_json::from_slice(
            &fs::read(path)
                .map_err(|error| format!("Failed to read browser smoke artifact: {error}"))?,
        )
        .map_err(|error| format!("Failed to parse browser smoke snapshot artifact: {error}"))?;
        if payload
            .pointer("/provenance/untrusted")
            .and_then(Value::as_bool)
            != Some(true)
        {
            return Err(
                "Browser smoke snapshot artifact is missing untrusted provenance.".to_string(),
            );
        }
    }
    Ok(())
}

fn verify_browser_console_log(summary: &Value) -> Result<(), String> {
    let path = summary
        .get("path")
        .and_then(Value::as_str)
        .map(Path::new)
        .ok_or_else(|| "Browser console summary did not include a path.".to_string())?;
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read browser console smoke log: {error}"))?;
    if !content.contains("CCEM_CONSOLE_PROBE_READY")
        || !content.contains("CCEM_CONSOLE_REDACTION_PROBE")
        || !content.contains("[REDACTED]")
        || content.contains("raw-console-secret")
    {
        return Err("Browser console smoke log failed capture or redaction checks.".to_string());
    }
    if summary.get("untrusted").and_then(Value::as_bool) != Some(true) {
        return Err("Browser console summary is missing untrusted provenance.".to_string());
    }
    Ok(())
}

fn verify_browser_audit_log(
    audit_path: Option<&str>,
    forbidden_typed_text: Option<&str>,
) -> Result<(), String> {
    let path = audit_path
        .map(Path::new)
        .ok_or_else(|| "Browser recent activity did not include an audit path.".to_string())?;
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read browser audit smoke log: {error}"))?;
    if !content.contains("\"event\":\"action_result\"") {
        return Err("Browser audit smoke log did not contain action results.".to_string());
    }
    if forbidden_typed_text.is_some_and(|text| !text.is_empty() && content.contains(text)) {
        return Err("Browser audit log persisted typed page content.".to_string());
    }
    Ok(())
}

fn wait_for_browser_snapshot(
    app: &AppHandle,
    browser: &BrowserManager,
    browser_session_id: &str,
    marker_text: Option<&str>,
    timeout_ms: u64,
) -> Result<Value, String> {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut last_error = None;
    let mut last_snapshot = None;

    loop {
        match browser.snapshot(app, Some(browser_session_id)) {
            Ok(snapshot) => {
                let matched = marker_text
                    .map(|marker| snapshot_text_contains(&snapshot, marker))
                    .unwrap_or(true);
                if matched {
                    match browser.info(app, Some(browser_session_id)) {
                        Ok(info)
                            if info.lifecycle
                                == crate::browser::BrowserLifecycleState::Interactive
                                && !info.loading =>
                        {
                            return Ok(snapshot);
                        }
                        Ok(_) => {}
                        Err(error) => last_error = Some(error),
                    }
                }
                last_snapshot = Some(snapshot);
            }
            Err(error) => {
                last_error = Some(error);
            }
        }

        if Instant::now() >= deadline {
            let context = last_snapshot
                .as_ref()
                .map(summarize_browser_snapshot)
                .unwrap_or(Value::Null);
            let detail = last_error
                .as_deref()
                .map(|error| format!(" Last error: {error}"))
                .unwrap_or_default();
            let marker = marker_text.unwrap_or("<any snapshot>");
            return Err(format!(
                "Timed out waiting for browser snapshot marker '{marker}'. Snapshot: {context}.{detail}"
            ));
        }
        thread::sleep(Duration::from_millis(150));
    }
}

fn summarize_browser_snapshot(snapshot: &Value) -> Value {
    let text = snapshot
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let elements = snapshot
        .get("elements")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let preview = elements
        .iter()
        .take(12)
        .map(|element| {
            json!({
                "ref": element.get("ref").cloned().unwrap_or(Value::Null),
                "tag": element.get("tag").cloned().unwrap_or(Value::Null),
                "label": element.get("label").cloned().unwrap_or(Value::Null),
            })
        })
        .collect::<Vec<_>>();

    json!({
        "url": snapshot.get("url").cloned().unwrap_or(Value::Null),
        "title": snapshot.get("title").cloned().unwrap_or(Value::Null),
        "text": text.chars().take(500).collect::<String>(),
        "elementsCount": elements.len(),
        "elements": preview,
    })
}

fn snapshot_text_contains(snapshot: &Value, needle: &str) -> bool {
    let needle = needle.trim().to_ascii_lowercase();
    if needle.is_empty() {
        return true;
    }
    snapshot
        .get("text")
        .and_then(Value::as_str)
        .map(|text| text.to_ascii_lowercase().contains(&needle))
        .unwrap_or(false)
}

fn find_snapshot_ref_by_label(snapshot: &Value, needle: &str) -> Option<u32> {
    let needle = needle.trim().to_ascii_lowercase();
    if needle.is_empty() {
        return None;
    }
    snapshot
        .get("elements")
        .and_then(Value::as_array)?
        .iter()
        .find_map(|element| {
            let label = element
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_ascii_lowercase();
            if label.contains(&needle) {
                element
                    .get("ref")
                    .and_then(Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok())
            } else {
                None
            }
        })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlCreateSessionResult {
    runtime_id: String,
    provider: String,
    provider_session_id: Option<String>,
    cwd: String,
    status: String,
    link: String,
    routes: Option<SessionRouterState>,
}

impl From<NativeSessionSummary> for ControlCreateSessionResult {
    fn from(summary: NativeSessionSummary) -> Self {
        let link = build_runtime_link(&summary);
        Self {
            runtime_id: summary.runtime_id,
            provider: summary.provider.as_str().to_string(),
            provider_session_id: summary.provider_session_id,
            cwd: summary.project_dir,
            status: summary.status,
            link,
            routes: summary.router,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlSessionSummary {
    runtime_id: String,
    provider: String,
    provider_session_id: Option<String>,
    project_dir: String,
    env_name: String,
    perm_mode: String,
    runtime_perm_mode: Option<String>,
    effort: Option<String>,
    status: String,
    created_at: String,
    updated_at: String,
    is_active: bool,
    last_event_seq: Option<u64>,
    last_error: Option<String>,
    link: String,
    routes: Option<SessionRouterState>,
}

impl From<NativeSessionSummary> for ControlSessionSummary {
    fn from(summary: NativeSessionSummary) -> Self {
        let link = build_runtime_link(&summary);
        Self {
            runtime_id: summary.runtime_id,
            provider: summary.provider.as_str().to_string(),
            provider_session_id: summary.provider_session_id,
            project_dir: summary.project_dir,
            env_name: summary.env_name,
            perm_mode: summary.perm_mode,
            runtime_perm_mode: summary.runtime_perm_mode,
            effort: summary.effort,
            status: summary.status,
            created_at: summary.created_at.to_rfc3339(),
            updated_at: summary.updated_at.to_rfc3339(),
            is_active: summary.is_active,
            last_event_seq: summary.last_event_seq,
            last_error: summary.last_error,
            link,
            routes: summary.router,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlReplayBatch {
    source_available: bool,
    gap_detected: bool,
    truncated: bool,
    unloaded_gap_starts: Vec<u64>,
    oldest_available_seq: Option<u64>,
    newest_available_seq: Option<u64>,
    events: Vec<Value>,
}

impl From<ReplayBatch> for ControlReplayBatch {
    fn from(batch: ReplayBatch) -> Self {
        Self {
            source_available: batch.source_available,
            gap_detected: batch.gap_detected,
            truncated: batch.truncated,
            unloaded_gap_starts: batch.unloaded_gap_starts,
            oldest_available_seq: batch.oldest_available_seq,
            newest_available_seq: batch.newest_available_seq,
            events: batch
                .events
                .into_iter()
                .filter_map(|event| serde_json::to_value(event).ok())
                .collect(),
        }
    }
}

struct HttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

struct HttpResponse {
    status: u16,
    content_type: &'static str,
    body: Vec<u8>,
}

impl HttpResponse {
    fn plain(status: u16, body: &str) -> Self {
        Self {
            status,
            content_type: "text/plain; charset=utf-8",
            body: body.as_bytes().to_vec(),
        }
    }

    fn json_result(id: Option<Value>, result: Value) -> Self {
        Self::json(
            200,
            json!({
                "jsonrpc": "2.0",
                "id": id.unwrap_or(Value::Null),
                "result": result,
            }),
        )
    }

    fn json_error(status: u16, id: Option<Value>, code: i64, message: &str) -> Self {
        Self::json_error_with_data(status, id, code, message, None)
    }

    fn json_error_with_data(
        status: u16,
        id: Option<Value>,
        code: i64,
        message: &str,
        data: Option<Value>,
    ) -> Self {
        let mut error = json!({
            "code": code,
            "message": message,
        });
        if let Some(data) = data {
            error["data"] = data;
        }
        Self::json(
            status,
            json!({
                "jsonrpc": "2.0",
                "id": id.unwrap_or(Value::Null),
                "error": error,
            }),
        )
    }

    fn json(status: u16, body: Value) -> Self {
        Self {
            status,
            content_type: "application/json",
            body: serde_json::to_vec(&body).unwrap_or_else(|_| b"{}".to_vec()),
        }
    }

    fn to_bytes(&self) -> Vec<u8> {
        let status_text = match self.status {
            200 => "OK",
            400 => "Bad Request",
            401 => "Unauthorized",
            404 => "Not Found",
            _ => "OK",
        };
        let mut output = format!(
            "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            self.status,
            status_text,
            self.content_type,
            self.body.len()
        )
        .into_bytes();
        output.extend_from_slice(&self.body);
        output
    }
}

fn read_http_request(stream: &mut TcpStream) -> Result<HttpRequest, String> {
    read_http_request_with_deadline(stream, SOCKET_IO_TIMEOUT)
}

fn read_http_request_with_deadline(
    stream: &mut TcpStream,
    total_timeout: Duration,
) -> Result<HttpRequest, String> {
    let deadline = Instant::now() + total_timeout;
    let mut buffer = Vec::new();
    let header_end = loop {
        let mut chunk = [0_u8; 4096];
        match read_with_deadline(stream, &mut chunk, deadline, "request headers") {
            Ok(0) => return Err("Connection closed before complete request headers".to_string()),
            Ok(size) => {
                buffer.extend_from_slice(&chunk[..size]);
                if buffer.len() > HEADER_READ_LIMIT {
                    return Err("Request headers are too large".to_string());
                }
                if let Some(pos) = find_header_end(&buffer) {
                    break pos;
                }
            }
            Err(error) => return Err(error),
        }
    };

    let headers_raw = String::from_utf8_lossy(&buffer[..header_end]);
    let mut lines = headers_raw.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| "Missing request line".to_string())?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default().to_string();
    let path = request_parts.next().unwrap_or_default().to_string();
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_lowercase(), value.trim().to_string());
        }
    }

    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    if content_length > BODY_READ_LIMIT {
        return Err("Request body is too large".to_string());
    }

    let body_start = header_end + 4;
    let mut body = buffer.get(body_start..).unwrap_or_default().to_vec();
    while body.len() < content_length {
        let mut chunk = [0_u8; 4096];
        match read_with_deadline(stream, &mut chunk, deadline, "request body") {
            Ok(0) => return Err("Connection closed before complete request body".to_string()),
            Ok(size) => body.extend_from_slice(&chunk[..size]),
            Err(error) => return Err(error),
        }
    }
    body.truncate(content_length);

    Ok(HttpRequest {
        method,
        path,
        headers,
        body,
    })
}

fn read_with_deadline(
    stream: &mut TcpStream,
    buf: &mut [u8],
    deadline: Instant,
    context: &str,
) -> Result<usize, String> {
    loop {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return Err(format!("Timed out reading {}", context));
        };
        let read_timeout = if remaining < SOCKET_IO_TIMEOUT {
            remaining.max(MIN_SOCKET_READ_TIMEOUT)
        } else {
            SOCKET_IO_TIMEOUT
        };
        let _ = stream.set_read_timeout(Some(read_timeout));

        match stream.read(buf) {
            Ok(size) => return Ok(size),
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                if deadline.checked_duration_since(Instant::now()).is_none() {
                    return Err(format!("Timed out reading {}", context));
                }
                let remaining = deadline
                    .checked_duration_since(Instant::now())
                    .unwrap_or_default();
                let sleep_for = if remaining < SOCKET_RETRY_SLEEP {
                    remaining
                } else {
                    SOCKET_RETRY_SLEEP
                };
                if !sleep_for.is_zero() {
                    thread::sleep(sleep_for);
                }
            }
            Err(error) => return Err(format!("Failed reading {}: {}", context, error)),
        }
    }
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn deserialize_params<T: for<'de> Deserialize<'de>>(params: Value) -> Result<T, String> {
    serde_json::from_value(params).map_err(|error| format!("Invalid params: {}", error))
}

fn session_matches(session: &NativeSessionSummary, params: &ListSessionsParams) -> bool {
    if let Some(cwd) = params
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if session.project_dir != cwd {
            return false;
        }
    }
    if let Some(provider) = params
        .provider
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if session.provider.as_str() != provider {
            return false;
        }
    }
    if let Some(status) = params
        .status
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if session.status != status {
            return false;
        }
    }
    true
}

fn parse_native_provider(provider: &str) -> Result<NativeProvider, String> {
    match provider.trim().to_lowercase().as_str() {
        "claude" => Ok(NativeProvider::Claude),
        "codex" => Ok(NativeProvider::Codex),
        other => Err(format!(
            "Unsupported native provider '{}'. Use claude or codex.",
            other
        )),
    }
}

fn resolve_current_env() -> Option<String> {
    config::read_config()
        .ok()
        .and_then(|cfg| cfg.current)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Known permission mode names accepted by external control.
const KNOWN_PERM_MODES: &[&str] = &["yolo", "dev", "readonly", "safe", "ci", "audit"];

fn is_known_perm_mode(mode: &str) -> bool {
    KNOWN_PERM_MODES
        .iter()
        .any(|known| known.eq_ignore_ascii_case(mode))
}

/// Validate and resolve the working directory for external control.
/// - If `cwd` is `None` or empty: falls back to config default → home → ".".
/// - If `cwd` is provided: must be an absolute path; relative paths are rejected.
fn resolve_working_dir(cwd: Option<String>) -> Result<String, String> {
    let trimmed = cwd
        .map(|dir| dir.trim().to_string())
        .filter(|dir| !dir.is_empty());

    match trimmed {
        Some(dir) => {
            let path = std::path::Path::new(&dir);
            if !path.is_absolute() {
                return Err(format!(
                    "Invalid cwd '{}': external control requires an absolute path",
                    dir
                ));
            }
            Ok(dir)
        }
        None => Ok(config::get_default_working_dir()
            .or_else(|| dirs::home_dir().map(|path| path.to_string_lossy().to_string()))
            .unwrap_or_else(|| ".".to_string())),
    }
}

fn resolve_default_perm_mode() -> String {
    config::read_config()
        .ok()
        .and_then(|cfg| cfg.default_mode)
        .map(|mode| mode.trim().to_string())
        .filter(|mode| !mode.is_empty())
        .unwrap_or_else(|| "dev".to_string())
}

/// Validate and resolve permission mode for external control.
/// - If `perm_mode` is `None` or empty: falls back to config default → "dev".
/// - If provided: must be one of [`yolo`, `dev`, `readonly`, `safe`, `ci`, `audit`].
fn resolve_effective_perm_mode(perm_mode: Option<String>) -> Result<String, String> {
    let trimmed = perm_mode
        .map(|mode| mode.trim().to_string())
        .filter(|mode| !mode.is_empty());

    match trimmed {
        Some(mode) => {
            if !is_known_perm_mode(&mode) {
                return Err(format!(
                    "Invalid permission_mode '{}': expected one of {}",
                    mode,
                    KNOWN_PERM_MODES.join(", ")
                ));
            }
            Ok(mode)
        }
        None => Ok(resolve_default_perm_mode()),
    }
}

fn build_runtime_link(summary: &NativeSessionSummary) -> String {
    let mut link = format!(
        "ccem://workspace/session?source={}&idKind=runtime&id={}&runtimeId={}&cwd={}&focus=live",
        summary.provider.as_str(),
        urlencoding::encode(&summary.runtime_id),
        urlencoding::encode(&summary.runtime_id),
        urlencoding::encode(&summary.project_dir),
    );
    if let Some(provider_session_id) = summary.provider_session_id.as_deref() {
        link.push_str("&providerSessionId=");
        link.push_str(&urlencoding::encode(provider_session_id));
    }
    link
}

fn control_descriptor_path() -> PathBuf {
    config::get_ccem_dir().join("control.json")
}

fn should_publish_control_descriptor() -> bool {
    let override_value = std::env::var("CCEM_DESKTOP_PUBLISH_CONTROL_DESCRIPTOR").ok();
    should_publish_control_descriptor_for_env(cfg!(debug_assertions), override_value.as_deref())
}

// Debug builds include `pnpm tauri dev`; keep them from overwriting the release
// app's global discovery descriptor unless a developer opts in explicitly.
fn should_publish_control_descriptor_for_env(
    debug_assertions: bool,
    override_value: Option<&str>,
) -> bool {
    if !debug_assertions {
        return true;
    }
    override_value
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn write_descriptor_at(path: &Path, descriptor: &ExternalControlDescriptor) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create CCEM config directory: {}", error))?;
    }
    let content = serde_json::to_vec_pretty(descriptor)
        .map_err(|error| format!("Failed to encode control descriptor: {}", error))?;
    let temp_path = path.with_extension(format!("json.{}.tmp", std::process::id()));
    write_private_file(&temp_path, &content)?;
    fs::rename(&temp_path, path)
        .map_err(|error| format!("Failed to publish control descriptor: {}", error))?;
    apply_private_file_permissions(path);
    Ok(())
}

#[cfg(unix)]
fn write_private_file(path: &Path, content: &[u8]) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| format!("Failed to write control descriptor: {}", error))?;
    file.write_all(content)
        .map_err(|error| format!("Failed to write control descriptor: {}", error))
}

#[cfg(not(unix))]
fn write_private_file(path: &Path, content: &[u8]) -> Result<(), String> {
    fs::write(path, content)
        .map_err(|error| format!("Failed to write control descriptor: {}", error))
}

#[cfg(unix)]
fn apply_private_file_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(metadata) = fs::metadata(path) {
        let mut permissions = metadata.permissions();
        permissions.set_mode(0o600);
        let _ = fs::set_permissions(path, permissions);
    }
}

#[cfg(not(unix))]
fn apply_private_file_permissions(_path: &Path) {}

fn remove_descriptor_if_owned(path: &Path, expected: &ExternalControlDescriptor) {
    let Ok(content) = fs::read_to_string(path) else {
        return;
    };
    let Ok(current) = serde_json::from_str::<ExternalControlDescriptor>(&content) else {
        return;
    };
    if descriptor_owned_by_runtime(&current, expected) {
        let _ = fs::remove_file(path);
    }
}

fn descriptor_owned_by_runtime(
    current: &ExternalControlDescriptor,
    expected: &ExternalControlDescriptor,
) -> bool {
    current.endpoint == expected.endpoint
        && current.pid == expected.pid
        && current.token == expected.token
}

fn generate_token() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(48)
        .map(char::from)
        .collect()
}

fn now_rfc3339() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    format!("{}", timestamp)
}

// ---------------------------------------------------------------------------
// HTTP boundary validation helpers (pure functions — testable without a server)
// ---------------------------------------------------------------------------

/// Returns true when the Host header value points at a loopback address.
/// Accepts `127.0.0.1:port`, `localhost:port`, `[::1]:port`, and bare
/// `127.0.0.1` / `localhost` / `::1`.
pub fn is_loopback_host_header(host: &str) -> bool {
    let trimmed = host.trim();
    if trimmed.is_empty() {
        return false;
    }

    // IPv6 bracketed form: `[::1]:port` or `[::1]`
    if trimmed.starts_with('[') {
        let close = match trimmed.find(']') {
            Some(idx) => idx,
            None => return false,
        };
        let inner = &trimmed[1..close];
        return is_loopback_ipv6_literal(inner);
    }

    // Strip the port (last colon that is not part of an IPv6 address).
    // After the bracket check above, we're only dealing with IPv4/host:port.
    let host_part = match trimmed.rsplit_once(':') {
        Some((left, right)) if right.chars().all(|c| c.is_ascii_digit()) => left,
        _ => trimmed,
    };

    is_loopback_host_name(host_part)
}

/// Returns true when an Origin header value is a loopback origin.
/// Accepts `http://127.0.0.1:*`, `http://localhost:*`, `http://[::1]:*`.
pub fn is_loopback_origin(origin: &str) -> bool {
    let trimmed = origin.trim();
    if trimmed.is_empty() {
        return false;
    }
    // Strip scheme
    let without_scheme = trimmed
        .strip_prefix("http://")
        .or_else(|| trimmed.strip_prefix("https://"))
        .unwrap_or(trimmed);

    // Strip path
    let authority = without_scheme.split('/').next().unwrap_or(without_scheme);
    // Extract host:port — careful with IPv6
    if authority.starts_with('[') {
        let close = match authority.find(']') {
            Some(idx) => idx,
            None => return false,
        };
        let inner = &authority[1..close];
        return is_loopback_ipv6_literal(inner);
    }
    let host_part = match authority.rsplit_once(':') {
        Some((left, right)) if right.chars().all(|c| c.is_ascii_digit()) => left,
        _ => authority,
    };
    is_loopback_host_name(host_part)
}

/// Returns true for `application/json` and `application/json; charset=utf-8`.
pub fn is_json_content_type(content_type: Option<&str>) -> bool {
    let value = match content_type {
        Some(value) => value.trim().to_lowercase(),
        None => return false,
    };
    // Strip parameters like ; charset=utf-8
    let mime = value.split(';').next().unwrap_or("").trim();
    mime == "application/json"
}

/// Allowlist of JSON-RPC method names accepted by the external control server.
/// Any method not in this list is rejected with -32601 before dispatch.
pub fn is_allowed_method(method: &str) -> bool {
    is_allowed_method_for_build(method, cfg!(debug_assertions))
}

fn is_allowed_method_for_build(method: &str, _debug_assertions: bool) -> bool {
    matches!(
        method,
        "ccem.health"
            | "ccem.workspace.listSessions"
            | "ccem.environment.references"
            | "ccem.environment.rename"
            | "ccem.environment.delete"
            | "ccem.workspace.getSession"
            | "ccem.workspace.getEvents"
            | "ccem.workspace.sendInput"
            | "ccem.workspace.openSession"
            | "ccem.workspace.createSession"
            | "ccem.router.getSettings"
            | "ccem.router.updateSettings"
            | "ccem.router.status"
            | "ccem.workspace.getRouter"
            | "ccem.workspace.updateRouter"
            | "ccem.workspace.restartDirect"
    )
}

fn is_loopback_host_name(host: &str) -> bool {
    let normalized = host.to_lowercase();
    if normalized == "localhost" {
        return true;
    }
    // 127.0.0.0/8 loopback range
    if normalized.starts_with("127.") {
        // Quick sanity check: IPv4 dotted quad
        let parts: Vec<&str> = normalized.split('.').collect();
        if parts.len() == 4 && parts.iter().all(|p| p.parse::<u8>().is_ok()) {
            return true;
        }
    }
    // Bare IPv6 ::1
    is_loopback_ipv6_literal(&normalized)
}

fn is_loopback_ipv6_literal(literal: &str) -> bool {
    let lower = literal.to_lowercase();
    lower == "::1" || lower == "0:0:0:0:0:0:0:1" || lower == "[::1]" || lower == "[0:0:0:0:0:0:0:1]"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_session_params(value: Value) -> CreateSessionParams {
        deserialize_params(value).expect("deserialize create-session params")
    }

    #[test]
    fn create_session_router_launch_draft_is_explicit_and_legacy_compatible() {
        let omitted = create_session_params(json!({
            "provider": "claude",
            "prompt": "direct"
        }));
        assert_eq!(
            resolve_external_router_launch_draft(&omitted).expect("resolve omitted draft"),
            None
        );

        let nested = create_session_params(json!({
            "provider": "claude",
            "prompt": "routed",
            "routerLaunchDraft": {
                "bindings": {"background": "glm"},
                "allowedEnvs": ["glm"],
                "sourceProfileId": "chores",
                "profileRevision": 3,
                "dynamicRouting": false
            }
        }));
        let nested = resolve_external_router_launch_draft(&nested)
            .expect("resolve nested draft")
            .expect("nested draft is explicit");
        assert_eq!(
            nested.bindings.get("background").map(String::as_str),
            Some("glm")
        );
        assert_eq!(nested.allowed_envs, vec!["glm"]);
        assert_eq!(nested.source_profile_id.as_deref(), Some("chores"));
        assert_eq!(nested.profile_revision, Some(3));
        assert_eq!(nested.dynamic_routing, Some(false));

        let empty = create_session_params(json!({
            "provider": "claude",
            "prompt": "main environment only",
            "routerLaunchDraft": {}
        }));
        let empty = resolve_external_router_launch_draft(&empty)
            .expect("resolve empty explicit draft")
            .expect("an empty object still opts in");
        assert!(empty.bindings.is_empty());
        assert!(empty.allowed_envs.is_empty());
        assert_eq!(empty.source_profile_id, None);

        let legacy = create_session_params(json!({
            "provider": "claude",
            "prompt": "legacy routed",
            "routes": {},
            "allowedEnvs": [],
            "dynamicRouting": true
        }));
        let legacy = resolve_external_router_launch_draft(&legacy)
            .expect("resolve legacy draft")
            .expect("legacy field presence opts in");
        assert!(legacy.bindings.is_empty());
        assert!(legacy.allowed_envs.is_empty());
        assert_eq!(legacy.dynamic_routing, Some(true));
    }

    #[test]
    fn create_session_rejects_nested_and_legacy_router_drafts_together() {
        let params = create_session_params(json!({
            "provider": "claude",
            "prompt": "ambiguous",
            "routerLaunchDraft": {},
            "routes": {}
        }));

        let error = resolve_external_router_launch_draft(&params)
            .expect_err("ambiguous draft shapes must fail closed");

        assert!(error.contains("ROUTER_LAUNCH_DRAFT_CONFLICT"), "{error}");
    }

    fn loopback_stream_pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let client = TcpStream::connect(addr).unwrap();
        let (server, _) = listener.accept().unwrap();
        (client, server)
    }

    #[test]
    fn read_http_request_times_out_partial_headers() {
        let (mut client, mut server) = loopback_stream_pair();
        client
            .write_all(b"POST /rpc HTTP/1.1\r\nHost: 127.0.0.1\r\n")
            .unwrap();

        let error = match read_http_request_with_deadline(&mut server, Duration::from_millis(50)) {
            Ok(_) => panic!("partial headers should time out"),
            Err(error) => error,
        };

        assert_eq!(error, "Timed out reading request headers");
    }

    #[test]
    fn read_http_request_times_out_partial_body() {
        let (mut client, mut server) = loopback_stream_pair();
        client
            .write_all(b"POST /rpc HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 5\r\n\r\nhe")
            .unwrap();

        let error = match read_http_request_with_deadline(&mut server, Duration::from_millis(50)) {
            Ok(_) => panic!("partial body should time out"),
            Err(error) => error,
        };

        assert_eq!(error, "Timed out reading request body");
    }

    #[test]
    fn read_http_request_accepts_complete_request_before_deadline() {
        let (mut client, mut server) = loopback_stream_pair();
        let body = br#"{"jsonrpc":"2.0","id":1,"method":"ccem.health"}"#;
        let request = format!(
            "POST /rpc HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            String::from_utf8_lossy(body)
        );
        client.write_all(request.as_bytes()).unwrap();

        let parsed =
            read_http_request_with_deadline(&mut server, Duration::from_millis(250)).unwrap();

        assert_eq!(parsed.method, "POST");
        assert_eq!(parsed.path, "/rpc");
        assert_eq!(
            parsed.headers.get("content-type").map(String::as_str),
            Some("application/json")
        );
        assert_eq!(parsed.body, body);
    }

    // --- Host header validation -------------------------------------------

    #[test]
    fn test_loopback_host_ipv4_with_port() {
        assert!(is_loopback_host_header("127.0.0.1:9123"));
        assert!(is_loopback_host_header("127.0.0.1:80"));
        assert!(is_loopback_host_header("127.0.0.1:65535"));
    }

    #[test]
    fn test_loopback_host_localhost_with_port() {
        assert!(is_loopback_host_header("localhost:9123"));
        assert!(is_loopback_host_header("localhost:80"));
    }

    #[test]
    fn test_loopback_host_bare() {
        assert!(is_loopback_host_header("127.0.0.1"));
        assert!(is_loopback_host_header("localhost"));
        assert!(is_loopback_host_header("127.1.2.3"));
    }

    #[test]
    fn test_loopback_host_ipv6_bracketed() {
        assert!(is_loopback_host_header("[::1]:9123"));
        assert!(is_loopback_host_header("[::1]"));
        assert!(is_loopback_host_header("[0:0:0:0:0:0:0:1]:9123"));
    }

    #[test]
    fn test_non_loopback_host_rejected() {
        assert!(!is_loopback_host_header("example.com:9123"));
        assert!(!is_loopback_host_header("example.com"));
        assert!(!is_loopback_host_header("192.168.1.1:9123"));
        assert!(!is_loopback_host_header("10.0.0.1"));
        assert!(!is_loopback_host_header("0.0.0.0:9123"));
        assert!(!is_loopback_host_header("evil.com"));
    }

    #[test]
    fn test_empty_host_rejected() {
        assert!(!is_loopback_host_header(""));
        assert!(!is_loopback_host_header("   "));
    }

    // --- Origin validation ------------------------------------------------

    #[test]
    fn test_loopback_origin_http() {
        assert!(is_loopback_origin("http://127.0.0.1:9123"));
        assert!(is_loopback_origin("http://localhost:9123"));
        assert!(is_loopback_origin("http://[::1]:9123"));
    }

    #[test]
    fn test_non_loopback_origin_rejected() {
        assert!(!is_loopback_origin("https://evil.com"));
        assert!(!is_loopback_origin("http://192.168.1.1:9123"));
        assert!(!is_loopback_origin("http://example.com:9123"));
    }

    // --- Content-Type validation ------------------------------------------

    #[test]
    fn test_json_content_type_accept() {
        assert!(is_json_content_type(Some("application/json")));
        assert!(is_json_content_type(Some(
            "application/json; charset=utf-8"
        )));
        assert!(is_json_content_type(Some("APPLICATION/JSON")));
        assert!(is_json_content_type(Some("  application/json  ")));
    }

    #[test]
    fn test_json_content_type_reject() {
        assert!(!is_json_content_type(None));
        assert!(!is_json_content_type(Some("text/plain")));
        assert!(!is_json_content_type(Some(
            "application/x-www-form-urlencoded"
        )));
        assert!(!is_json_content_type(Some(
            "multipart/form-data; boundary=xyz"
        )));
        assert!(!is_json_content_type(Some("")));
    }

    // --- Method allowlist -------------------------------------------------

    #[test]
    fn test_allowed_methods() {
        for method in [
            "ccem.health",
            "ccem.workspace.listSessions",
            "ccem.environment.references",
            "ccem.environment.rename",
            "ccem.environment.delete",
            "ccem.workspace.getSession",
            "ccem.workspace.getEvents",
            "ccem.workspace.sendInput",
            "ccem.workspace.openSession",
            "ccem.workspace.createSession",
            "ccem.router.getSettings",
            "ccem.router.updateSettings",
            "ccem.router.status",
            "ccem.workspace.getRouter",
            "ccem.workspace.updateRouter",
            "ccem.workspace.restartDirect",
        ] {
            assert!(is_allowed_method(method), "{} should be allowed", method);
        }
    }

    #[test]
    fn test_disallowed_methods() {
        assert!(!is_allowed_method_for_build(
            "ccem.browser.smokeProbe",
            true
        ));
        assert!(!is_allowed_method("ccem.evil"));
        assert!(!is_allowed_method("session/list"));
        assert!(!is_allowed_method(""));
        assert!(!is_allowed_method("admin.shutdown"));
        assert!(!is_allowed_method("system.execute"));
    }

    #[test]
    fn environment_mutation_helpers_cascade_and_return_stable_errors() {
        let mut config = config::CcemConfig::default();
        let environment = config.registries[config::OFFICIAL_ENV_NAME].clone();
        config.registries.insert("legacy".into(), environment);
        config.current = Some("legacy".into());
        config
            .router
            .bindings
            .insert("background".into(), "legacy".into());
        config.router.default_allowed_envs = vec!["official".into(), "legacy".into()];

        apply_environment_rename(&mut config, "legacy", "partner").expect("rename config");
        assert!(!config.registries.contains_key("legacy"));
        assert!(config.registries.contains_key("partner"));
        assert_eq!(config.current.as_deref(), Some("partner"));
        assert_eq!(
            config.router.bindings.get("background").map(String::as_str),
            Some("partner")
        );

        let referenced = apply_environment_delete(&mut config, "partner", Vec::new())
            .expect_err("router reference must reject delete");
        assert_eq!(referenced.code, "ENVIRONMENT_REFERENCED");
        assert!(referenced
            .references
            .iter()
            .any(|reference| reference == "router.bindings.background"));
        let rpc_error = environment_mutation_control_error(referenced, "delete", "partner", None);
        let data = rpc_error.data.expect("structured mutation error data");
        assert_eq!(data["code"], "ENVIRONMENT_REFERENCED");
        assert_eq!(data["operation"], "delete");
        assert_eq!(data["environmentName"], "partner");
        assert_eq!(data["newName"], Value::Null);
        assert!(data["references"]
            .as_array()
            .is_some_and(|references| !references.is_empty()));

        config.router = RouterConfig::default();
        let native_referenced =
            apply_environment_delete(&mut config, "partner", vec!["session:recoverable-1".into()])
                .expect_err("native snapshot reference must reject delete");
        assert_eq!(native_referenced.code, "ENVIRONMENT_REFERENCED");
        assert_eq!(
            native_referenced.references,
            vec!["session:recoverable-1".to_string()]
        );

        let protected =
            apply_environment_delete(&mut config, config::OFFICIAL_ENV_NAME, Vec::new())
                .expect_err("official must remain protected");
        assert_eq!(protected.code, "ENVIRONMENT_PROTECTED");
    }

    // --- Permission mode validation --------------------------------------

    #[test]
    fn test_known_perm_modes_accepted() {
        for mode in ["yolo", "dev", "readonly", "safe", "ci", "audit"] {
            assert!(is_known_perm_mode(mode), "{} should be known", mode);
        }
        // Case-insensitive
        assert!(is_known_perm_mode("YOLO"));
        assert!(is_known_perm_mode("ReadOnly"));
    }

    #[test]
    fn test_unknown_perm_mode_rejected() {
        assert!(!is_known_perm_mode("unrestricted"));
        assert!(!is_known_perm_mode("admin"));
        assert!(!is_known_perm_mode(""));
        assert!(!is_known_perm_mode("default"));
    }

    #[test]
    fn test_resolve_perm_mode_valid() {
        assert_eq!(
            resolve_effective_perm_mode(Some("safe".to_string())).unwrap(),
            "safe"
        );
        assert_eq!(
            resolve_effective_perm_mode(Some("AUDIT".to_string())).unwrap(),
            "AUDIT"
        );
    }

    #[test]
    fn test_resolve_perm_mode_invalid() {
        assert!(resolve_effective_perm_mode(Some("evil".to_string())).is_err());
        assert!(resolve_effective_perm_mode(Some("root".to_string())).is_err());
        assert!(
            resolve_effective_perm_mode(Some("yolo2".to_string())).is_err(),
            "prefix match should not pass"
        );
    }

    #[test]
    fn test_resolve_perm_mode_empty_falls_back() {
        // None and empty string both fall back to default (no error).
        assert!(resolve_effective_perm_mode(None).is_ok());
        assert!(resolve_effective_perm_mode(Some("   ".to_string())).is_ok());
    }

    // --- Working directory validation ------------------------------------

    #[test]
    fn test_resolve_working_dir_absolute_accepted() {
        let absolute = std::env::current_dir().expect("resolve current working directory");
        let absolute = absolute.to_string_lossy().into_owned();
        let result = resolve_working_dir(Some(absolute.clone()));
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), absolute);
    }

    #[test]
    fn test_resolve_working_dir_relative_rejected() {
        assert!(resolve_working_dir(Some("relative/path".to_string())).is_err());
        assert!(resolve_working_dir(Some("./here".to_string())).is_err());
        assert!(resolve_working_dir(Some("../parent".to_string())).is_err());
    }

    #[test]
    fn test_resolve_working_dir_empty_falls_back() {
        // None and empty string both fall back to default.
        assert!(resolve_working_dir(None).is_ok());
        assert!(resolve_working_dir(Some("   ".to_string())).is_ok());
    }

    // --- Control descriptor publication ----------------------------------

    fn test_descriptor(endpoint: &str, token: &str, pid: u32) -> ExternalControlDescriptor {
        ExternalControlDescriptor {
            endpoint: endpoint.to_string(),
            token: token.to_string(),
            pid,
            created_at: "1234567890".to_string(),
        }
    }

    fn temp_control_path(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        std::env::temp_dir().join(format!(
            "ccem-external-control-{name}-{}-{unique}.json",
            std::process::id()
        ))
    }

    #[test]
    fn debug_build_does_not_publish_descriptor_without_override() {
        assert!(!should_publish_control_descriptor_for_env(true, None));
        assert!(!should_publish_control_descriptor_for_env(true, Some("")));
        assert!(!should_publish_control_descriptor_for_env(true, Some("0")));
        assert!(!should_publish_control_descriptor_for_env(
            true,
            Some("false")
        ));
    }

    #[test]
    fn debug_build_allows_explicit_descriptor_publish_override() {
        assert!(should_publish_control_descriptor_for_env(true, Some("1")));
        assert!(should_publish_control_descriptor_for_env(
            true,
            Some("true")
        ));
        assert!(should_publish_control_descriptor_for_env(
            true,
            Some(" YES ")
        ));
        assert!(should_publish_control_descriptor_for_env(true, Some("on")));
    }

    #[test]
    fn release_build_publishes_descriptor_by_default() {
        assert!(should_publish_control_descriptor_for_env(false, None));
        assert!(should_publish_control_descriptor_for_env(false, Some("0")));
    }

    #[test]
    fn descriptor_ownership_requires_endpoint_pid_and_token() {
        let expected = test_descriptor("http://127.0.0.1:1234/rpc", "token-a", 111);
        assert!(descriptor_owned_by_runtime(&expected, &expected));
        assert!(!descriptor_owned_by_runtime(
            &test_descriptor("http://127.0.0.1:5678/rpc", "token-a", 111),
            &expected
        ));
        assert!(!descriptor_owned_by_runtime(
            &test_descriptor("http://127.0.0.1:1234/rpc", "token-b", 111),
            &expected
        ));
        assert!(!descriptor_owned_by_runtime(
            &test_descriptor("http://127.0.0.1:1234/rpc", "token-a", 222),
            &expected
        ));
    }

    #[test]
    fn rpc_id_is_a_namespaced_send_idempotency_fallback() {
        assert_eq!(
            rpc_client_message_id(Some(&json!("request-1"))).as_deref(),
            Some("external-control:request-1")
        );
        assert_eq!(
            rpc_client_message_id(Some(&json!(42))).as_deref(),
            Some("external-control:42")
        );
        assert_eq!(rpc_client_message_id(Some(&Value::Null)), None);
    }

    #[test]
    fn remove_descriptor_if_owned_deletes_matching_descriptor() {
        let path = temp_control_path("owned");
        let descriptor = test_descriptor("http://127.0.0.1:1234/rpc", "token-a", 111);
        write_descriptor_at(&path, &descriptor).unwrap();

        remove_descriptor_if_owned(&path, &descriptor);

        assert!(!path.exists());
    }

    #[test]
    fn remove_descriptor_if_owned_keeps_other_runtime_descriptor() {
        let path = temp_control_path("other-runtime");
        let expected = test_descriptor("http://127.0.0.1:1234/rpc", "token-a", 111);
        let other_runtime = test_descriptor("http://127.0.0.1:5678/rpc", "token-b", 222);
        write_descriptor_at(&path, &other_runtime).unwrap();

        remove_descriptor_if_owned(&path, &expected);

        assert!(path.exists());
        let _ = fs::remove_file(path);
    }
}
