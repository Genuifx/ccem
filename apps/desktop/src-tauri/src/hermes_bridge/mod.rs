//! CCEM owns workspace policy, confirmations, operation state and the durable outbox.
mod poll;
mod process;
mod store;
#[cfg(test)]
mod tests;

use crate::{
    config::{self, EnvironmentMutationCoordinator},
    crypto,
    external_control::ExternalControlManager,
    hermes_installer::{HermesInstaller, HermesRuntimeLease},
    native_runtime::{NativeRuntimeManager, NativeSessionSummary},
    remote_bridge::project_batch,
};
use process::GatewayProcess;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use store::{digest, now, random_id, Delivery, Route, Source, Store};
use tauri::{AppHandle, Manager};

struct OwnedGateway {
    process: Arc<GatewayProcess>,
    connect: bool,
    _lease: HermesRuntimeLease,
}
impl Drop for OwnedGateway {
    fn drop(&mut self) {
        // Request clones may outlive the owner. Reap the child before releasing its lease.
        self.process.stop();
    }
}
pub struct HermesBridgeManager {
    root: PathBuf,
    pub installer: HermesInstaller,
    store: Mutex<Option<Store>>,
    gateway: Mutex<Option<OwnedGateway>>,
    token: Mutex<Option<String>>,
    lifecycle: Mutex<()>,
    native: Arc<NativeRuntimeManager>,
    environment: Arc<EnvironmentMutationCoordinator>,
    shutdown: AtomicBool,
    install_requested: AtomicBool,
    last_error: Mutex<Option<String>>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BridgeParams {
    source: Source,
    #[serde(default)]
    source_message_id: Option<String>,
    #[serde(default)]
    runtime_id: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    challenge: Option<String>,
    #[serde(default)]
    operation_id: Option<String>,
    #[serde(default)]
    cursor: Option<u64>,
}

impl HermesBridgeManager {
    pub fn new(
        native: Arc<NativeRuntimeManager>,
        environment: Arc<EnvironmentMutationCoordinator>,
    ) -> Self {
        let root = config::get_ccem_dir().join("hermes");
        #[cfg(debug_assertions)]
        let root = std::env::var_os("CCEM_HERMES_STATE_DIR")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or(root);
        Self {
            installer: HermesInstaller::new(root.join("runtime")),
            root,
            store: Mutex::new(None),
            gateway: Mutex::new(None),
            token: Mutex::new(None),
            lifecycle: Mutex::new(()),
            native,
            environment,
            shutdown: AtomicBool::new(false),
            install_requested: AtomicBool::new(false),
            last_error: Mutex::new(None),
        }
    }
    fn with_store<T>(&self, f: impl FnOnce(&mut Store) -> Result<T, String>) -> Result<T, String> {
        let mut store = self.store.lock().map_err(|_| "bridge_lock_poisoned")?;
        if store.is_none() {
            *store = Some(Store::open(&self.root)?)
        }
        f(store.as_mut().expect("initialized"))
    }
    pub fn authorized_token(&self, header: &str) -> bool {
        let token = self.token.lock().unwrap();
        let Some(token) = token.as_ref() else {
            return false;
        };
        let expected = format!("Bearer {token}");
        header.len() == expected.len()
            && header
                .bytes()
                .zip(expected.bytes())
                .fold(0u8, |a, (b, c)| a | (b ^ c))
                == 0
    }
    pub fn status(&self) -> Value {
        let mut gateway = self
            .host_process()
            .ok()
            .map(|process| process.snapshot())
            .unwrap_or(json!({"state":"stopped","platforms":[]}));
        if let Some(error) = self.last_error.lock().unwrap().as_ref() {
            gateway["error"] = json!(error)
        }
        let mut result = json!({"installer":self.installer.status(),"gateway":gateway,"pending":[],"routes":[],"operations":[],"deliveries":[],"workspaces":[]});
        if self.install_requested.load(Ordering::Acquire)
            && ["not_installed", "installed", "error"]
                .contains(&result["installer"]["state"].as_str().unwrap_or(""))
        {
            result["installer"]["state"] = json!("checking")
        }
        result["pending"] = result["gateway"]["pending"]
            .as_array()
            .map(|a| json!(a))
            .unwrap_or(json!([]));
        result["pairing"] = result["gateway"]["pairing"].clone();
        if self.root.join("bridge.sqlite3").exists() {
            if let Err(error)=self.with_store(|s|{
                result["routes"]=json!(s.routes()?);
                result["operations"]=json!(s.operations()?.into_iter().take(30).map(|op|json!({"id":op.id,"runtimeId":op.runtime_id,"state":op.state,"detail":op.detail,"updatedAt":op.updated_at})).collect::<Vec<_>>());
                result["deliveries"]=json!(s.deliveries()?.into_iter().take(30).collect::<Vec<_>>());
                if let Some(p)=s.setting("platform")? {result["gateway"]["configuredPlatform"]=json!(p)}
                if let Some(keys)=s.setting("configuredFields")?{result["gateway"]["configuredFields"]=serde_json::from_str(&keys).unwrap_or(json!([]))}
                Ok(())
            }){result["gateway"]["error"]=json!(error)}
        }
        let mut workspaces: Vec<_> = self
            .native
            .list_sessions()
            .into_iter()
            .map(|s| s.project_dir)
            .filter(|p| std::path::Path::new(p).is_dir())
            .collect();
        workspaces.sort();
        workspaces.dedup();
        result["workspaces"] = json!(workspaces);
        result
    }
    fn host_request(&self, method: &str, params: Value) -> Result<Value, String> {
        let process = self.host_process()?;
        process.request(method, params)
    }
    fn host_process(&self) -> Result<Arc<GatewayProcess>, String> {
        self.gateway
            .lock()
            .unwrap()
            .as_ref()
            .map(|gateway| gateway.process.clone())
            .ok_or_else(|| "gateway_not_running".into())
    }
    fn stop_locked(&self) {
        *self.token.lock().unwrap() = None;
        let gateway = self.gateway.lock().unwrap().take();
        drop(gateway);
    }
    fn start_locked(&self, app: &AppHandle, connect: bool) -> Result<(), String> {
        self.stop_locked();
        let lease = self.installer.lease_runtime().map_err(|e| e.to_string())?;
        let port = app
            .state::<Arc<ExternalControlManager>>()
            .current_port()
            .ok_or("control_server_not_running")?;
        let (instance, account, platform, fields) = self.with_store(|s| {
            let instance = s.setting("instance")?.unwrap_or_else(random_id);
            s.set_setting("instance", &instance)?;
            let fields = match s.setting("channelSecrets")? {
                Some(cipher) => serde_json::from_str::<Value>(&crypto::decrypt(&cipher)?)
                    .map_err(|_| "channel_config_corrupt")?,
                None => json!({}),
            };
            Ok((
                instance,
                s.setting("accountRef")?
                    .unwrap_or_else(|| "unconfigured".into()),
                s.setting("platform")?,
                fields,
            ))
        })?;
        if connect && platform.is_none() {
            return Err("channel_not_configured".into());
        }
        let token = random_id();
        // One token exists for one host lifetime. The administrator descriptor never crosses this pipe.
        *self.token.lock().unwrap() = Some(token.clone());
        let boot = json!({"protocolVersion":1,"instanceId":instance,"accountRef":account,"endpoint":format!("http://127.0.0.1:{port}/rpc"),"token":token,"platform":platform,"fields":fields,"connect":connect});
        let launch = &lease.launch;
        match GatewayProcess::spawn(
            &launch.python,
            &launch.host,
            &launch.source,
            &self.root.join("profiles").join(&account),
            boot,
        ) {
            Ok(process) => {
                *self.gateway.lock().unwrap() = Some(OwnedGateway {
                    process: Arc::new(process),
                    connect,
                    _lease: lease,
                });
                *self.last_error.lock().unwrap() = None;
                Ok(())
            }
            Err(e) => {
                *self.token.lock().unwrap() = None;
                Err(e)
            }
        }
    }
    pub fn action(
        self: &Arc<Self>,
        app: &AppHandle,
        action: &str,
        payload: Value,
    ) -> Result<Value, String> {
        if action == "cancelInstall" {
            self.installer.cancel();
            return Ok(self.status());
        }
        let _lifecycle = self.lifecycle.lock().map_err(|_| "bridge_lock_poisoned")?;
        match action {
            "install" => {
                self.with_store(|_| Ok(()))?;
                if self.install_requested.load(Ordering::Acquire) {
                    return Err("installation_already_running".into());
                }
                let reservation = self
                    .installer
                    .prepare_install()
                    .map_err(|e| e.to_string())?;
                self.install_requested.store(true, Ordering::Release);
                self.stop_locked();
                let manager = self.clone();
                let app = app.clone();
                thread::spawn(move || {
                    let result = reservation.run().map_err(|e| e.to_string()).and_then(|_| {
                        let _guard = manager.lifecycle.lock().unwrap();
                        manager.start_locked(&app, false)
                    });
                    if let Err(e) = result {
                        *manager.last_error.lock().unwrap() = Some(e)
                    }
                    manager.install_requested.store(false, Ordering::Release);
                });
            }
            "removeRuntime" => {
                self.stop_locked();
                self.with_store(|s| s.set_setting("enabled", "false"))?;
                self.installer.remove_runtime().map_err(|e| e.to_string())?;
            }
            "configureChannel" => {
                let platform = payload["platform"].as_str().ok_or("platform_required")?;
                let fields = payload["fields"].as_object().ok_or("fields_required")?;
                let snapshot = self
                    .gateway
                    .lock()
                    .unwrap()
                    .as_ref()
                    .ok_or("gateway_not_running")?
                    .process
                    .snapshot();
                let meta = snapshot["platforms"]
                    .as_array()
                    .and_then(|a| a.iter().find(|v| v["id"] == platform))
                    .ok_or("platform_not_supported")?;
                if meta["strictSend"] != true || meta["available"] != true {
                    return Err("platform_not_available".into());
                }
                let schema = meta["fields"].as_array().ok_or("platform_schema_missing")?;
                let old = self.with_store(|s| {
                    if s.setting("platform")?.as_deref() == Some(platform) {
                        s.setting("channelSecrets")?
                            .map(|s| crypto::decrypt(&s))
                            .transpose()
                    } else {
                        Ok(None)
                    }
                })?;
                let mut merged: serde_json::Map<String, Value> = old
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default();
                for (k, v) in fields {
                    if !schema.iter().any(|s| s["key"] == *k) {
                        return Err("unknown_channel_field".into());
                    }
                    let value = v.as_str().ok_or("invalid_channel_field")?;
                    if value.len() > 4096 || value.contains('\0') {
                        return Err("invalid_channel_field".into());
                    }
                    if !value.is_empty() {
                        merged.insert(k.clone(), json!(value));
                    }
                }
                for field in schema {
                    if field["required"] == true
                        && merged
                            .get(field["key"].as_str().unwrap_or(""))
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .is_empty()
                    {
                        return Err("required_channel_field_missing".into());
                    }
                }
                let cipher =
                    crypto::encrypt(&serde_json::to_string(&merged).map_err(|e| e.to_string())?)?;
                self.stop_locked();
                self.with_store(|s| {
                    for r in s.routes()? {
                        if r.enabled {
                            s.disable_route(&r.id)?
                        }
                    }
                    s.set_setting("accountRef", &random_id())?;
                    s.set_setting("platform", platform)?;
                    s.set_setting("channelSecrets", &cipher)?;
                    s.set_setting(
                        "configuredFields",
                        &json!(merged.keys().collect::<Vec<_>>()).to_string(),
                    )?;
                    s.set_setting("enabled", "true")
                })?;
                self.start_locked(app, true)?;
            }
            "start" => {
                let connect = self.with_store(|s| {
                    let configured = s.setting("platform")?.is_some();
                    s.set_setting("enabled", if configured { "true" } else { "false" })?;
                    Ok(configured)
                })?;
                self.start_locked(app, connect)?;
            }
            "stop" => {
                self.with_store(|s| s.set_setting("enabled", "false"))?;
                self.start_locked(app, false)?;
            }
            "openPairing" => {
                self.host_request("openPairing", json!({}))?;
            }
            "approvePairing" => {
                let id = payload["id"].as_str().ok_or("pairing_id_required")?;
                let workspaces: Vec<String> = serde_json::from_value(payload["workspaces"].clone())
                    .map_err(|_| "workspace_scope_required")?;
                // Validate scopes before granting Hermes native authorization.
                for path in &workspaces {
                    if !std::path::Path::new(path).is_dir() {
                        return Err("workspace_not_found".into());
                    }
                }
                if workspaces.is_empty() {
                    return Err("workspace_scope_required".into());
                }
                let approved = self.host_request("approvePairing", json!({"id":id}))?;
                let source: Source = serde_json::from_value(approved["source"].clone())
                    .map_err(|_| "invalid_pairing_response")?;
                // Capture before committing approval: a completion racing the
                // approval must be replayed, never included in a later baseline.
                let baselines: Vec<_> = self.native.list_sessions().into_iter()
                    .map(|session| (session.runtime_id, session.project_dir, session.last_event_seq.unwrap_or(0)))
                    .collect();
                self.with_store(|s| {
                    s.approve_route_with_baselines(
                        source,
                        workspaces,
                        payload["allowInput"] == true,
                        payload["notifications"] != false,
                        &baselines,
                    )
                    .map(|_| ())
                })?;
            }
            "disableRoute" => {
                self.with_store(|s| {
                    s.disable_route(payload["id"].as_str().ok_or("route_id_required")?)
                })?;
            }
            _ => return Err("unknown_hermes_action".into()),
        }
        Ok(self.status())
    }
    fn scoped_session(&self, route: &Route, id: &str) -> Result<NativeSessionSummary, String> {
        let session = self
            .native
            .get_session_summary(id)?
            .ok_or("session_not_found")?;
        if !route.permits(&session.project_dir) {
            return Err("workspace_not_authorized".into());
        }
        Ok(session)
    }
    pub fn handle_rpc(
        &self,
        app: &AppHandle,
        authorization: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        // Calls cannot run while local approval/route revocation changes the policy generation.
        let _lifecycle = self.lifecycle.lock().map_err(|_| "bridge_lock_poisoned")?;
        if !self.authorized_token(authorization) {
            return Err("bridge_token_revoked".into());
        }
        if ![
            "ccem.bridge.list",
            "ccem.bridge.status",
            "ccem.bridge.events",
            "ccem.bridge.input",
            "ccem.bridge.confirm",
            "ccem.bridge.cancel",
            "ccem.bridge.operation",
        ]
        .contains(&method)
        {
            return Err("method_not_allowed".into());
        }
        let p: BridgeParams =
            serde_json::from_value(params).map_err(|_| "invalid_bridge_request")?;
        let route = self.with_store(|s| {
            if s.setting("accountRef")?.as_deref() != Some(&p.source.account_ref) {
                return Err("account_not_authorized".into());
            }
            s.route(&p.source)
        })?;
        match method {
            "ccem.bridge.list" => {
                let mut sessions: Vec<_> = self
                    .native
                    .list_sessions()
                    .into_iter()
                    .filter(|s| route.permits(&s.project_dir))
                    .collect();
                sessions.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
                Ok(
                    json!({"sessions":sessions.into_iter().take(20).map(|s|json!({"runtimeId":s.runtime_id,"title":s.display_title,"status":s.status,"updatedAt":s.updated_at})).collect::<Vec<_>>()}),
                )
            }
            "ccem.bridge.status" | "ccem.bridge.events" => {
                let id = p.runtime_id.as_deref().ok_or("runtime_id_required")?;
                let session = self.scoped_session(&route, id)?;
                if method.ends_with("status") {
                    Ok(
                        json!({"runtimeId":session.runtime_id,"title":session.display_title,"status":session.status,"updatedAt":session.updated_at}),
                    )
                } else {
                    Ok(project_batch(
                        self.native.replay_event_page(id, p.cursor, None, 5)?,
                        p.cursor,
                    ))
                }
            }
            "ccem.bridge.input" => {
                let id = p.runtime_id.as_deref().ok_or("runtime_id_required")?;
                self.scoped_session(&route, id)?;
                self.with_store(|s| {
                    s.prepare(
                        &route,
                        p.source_message_id.as_deref().unwrap_or(""),
                        id,
                        p.text.as_deref().unwrap_or(""),
                    )
                })
            }
            "ccem.bridge.confirm" => {
                let challenge = p.challenge.as_deref().ok_or("challenge_required")?;
                let id = self.with_store(|s| s.challenge_runtime(&route, challenge))?;
                self.scoped_session(&route, &id)?;
                let (mut op, submit) = self.with_store(|s| {
                    s.confirm(
                        &route,
                        p.source_message_id.as_deref().unwrap_or(""),
                        challenge,
                        &id,
                    )
                })?;
                if submit {
                    let _environment = self.environment.lock()?;
                    let outcome = self.native.send_user_message(
                        app,
                        &id,
                        &op.text,
                        None,
                        None,
                        None,
                        Some(&op.id),
                    );
                    if outcome.is_err() {
                        op.state = "unknown".into();
                        op.detail =
                            "Submission could not be verified. Inspect the task in CCEM.".into();
                        op.updated_at = now();
                        self.with_store(|s| s.save_operation(&op))?;
                    }
                }
                Ok(
                    json!({"operationId":op.id,"runtimeId":op.runtime_id,"state":op.state,"detail":op.detail}),
                )
            }
            "ccem.bridge.cancel" => {
                self.with_store(|s| {
                    s.cancel(&route, p.challenge.as_deref().ok_or("challenge_required")?)
                })?;
                Ok(json!({"state":"cancelled"}))
            }
            "ccem.bridge.operation" => {
                let op = self.with_store(|s| {
                    s.operation(p.operation_id.as_deref().ok_or("operation_id_required")?)
                })?;
                if op.route_id != route.id || op.generation != route.generation {
                    return Err("operation_not_authorized".into());
                }
                self.scoped_session(&route, &op.runtime_id)?;
                Ok(
                    json!({"operationId":op.id,"runtimeId":op.runtime_id,"state":op.state,"detail":op.detail}),
                )
            }
            _ => Err("method_not_allowed".into()),
        }
    }
    pub fn activate(self: &Arc<Self>, app: &AppHandle, background_services: bool) {
        let weak = Arc::downgrade(self);
        let app = app.clone();
        thread::spawn(move || {
            let mut failures = 0;
            let mut initialized = false;
            loop {
                thread::sleep(Duration::from_secs(2));
                let Some(manager) = weak.upgrade() else { break };
                if manager.shutdown.load(Ordering::Acquire) {
                    break;
                }
                if !initialized {
                    initialized = true;
                    if manager.installer.status().launch.is_some() {
                        let connect = background_services
                            && manager
                                .with_store(
                                    |s| Ok(s.setting("enabled")?.as_deref() == Some("true")),
                                )
                                .unwrap_or(false);
                        let _guard = manager.lifecycle.lock().unwrap();
                        if let Err(e) = manager.start_locked(&app, connect) {
                            *manager.last_error.lock().unwrap() = Some(e);
                            failures += 1
                        }
                    }
                }
                let gateway_state = manager
                    .gateway
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|g| (g.process.alive(), g.connect));
                let alive = gateway_state.map(|s| s.0);
                if alive == Some(false) {
                    *manager.token.lock().unwrap() = None;
                    if failures < 3 {
                        let _guard = manager.lifecycle.lock().unwrap();
                        let _ = manager.start_locked(&app, gateway_state.is_some_and(|s| s.1));
                        failures += 1;
                    } else {
                        *manager.last_error.lock().unwrap() =
                            Some("gateway_stopped_retry_required".into())
                    }
                }
                if alive == Some(true) {
                    if let Err(e) = manager.poll() {
                        *manager.last_error.lock().unwrap() = Some(e)
                    }
                }
            }
        });
    }
    fn poll(&self) -> Result<(), String> {
        poll::poll(self)
    }
    pub fn shutdown(&self) {
        self.shutdown.store(true, Ordering::Release);
        let _guard = self.lifecycle.lock().unwrap();
        self.stop_locked()
    }
}
fn make_delivery(route: &Route, event: &str, text: String) -> Delivery {
    Delivery {
        id: digest(&format!("{}:{}:{event}", route.id, route.generation)),
        route_id: route.id.clone(),
        generation: route.generation,
        text: bounded_chat_text(&text),
        status: "pending".into(),
        receipt: None,
        created_at: now(),
    }
}
fn bounded_chat_text(text: &str) -> String {
    if text.len() <= 3500 {
        return text.into();
    }
    let mut end = 3490;
    while !text.is_char_boundary(end) {
        end -= 1
    }
    format!("{}…", &text[..end])
}

#[tauri::command]
pub async fn hermes_status(manager: tauri::State<'_, Arc<HermesBridgeManager>>) -> Result<Value, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.status())
        .await
        .map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn hermes_action(
    app: AppHandle,
    manager: tauri::State<'_, Arc<HermesBridgeManager>>,
    action: String,
    payload: Option<Value>,
) -> Result<Value, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.action(&app, &action, payload.unwrap_or(json!({})))
    })
    .await
    .map_err(|e| e.to_string())?
}
