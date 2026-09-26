//! CCEM owns workspace policy, confirmations, operation state and the durable outbox.
mod connection_config;
mod poll;
mod process;
mod setup;
mod startup;
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
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use store::{digest, now, random_id, ConnectionRecord, Delivery, Route, Source, Store};
use tauri::{AppHandle, Manager};

struct OwnedGateway {
    process: Arc<GatewayProcess>,
    token: String,
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
    discovery: Mutex<Option<OwnedGateway>>,
    gateways: Mutex<HashMap<String, OwnedGateway>>,
    connection_errors: Mutex<HashMap<String, String>>,
    failures: Mutex<HashMap<String, u32>>,
    polling: Mutex<HashSet<String>>,
    lifecycle: Mutex<()>,
    startup: startup::StartupQueue,
    native: Arc<NativeRuntimeManager>,
    environment: Arc<EnvironmentMutationCoordinator>,
    shutdown: AtomicBool,
    install_requested: AtomicBool,
    install_cancelled: AtomicBool,
    runtime_removing: AtomicBool,
    last_error: Mutex<Option<String>>,
    setup: Mutex<Option<setup::Setup>>,
    setup_workers: AtomicUsize,
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
            discovery: Mutex::new(None),
            gateways: Mutex::new(HashMap::new()),
            connection_errors: Mutex::new(HashMap::new()),
            failures: Mutex::new(HashMap::new()),
            polling: Mutex::new(HashSet::new()),
            lifecycle: Mutex::new(()),
            startup: startup::StartupQueue::default(),
            native,
            environment,
            shutdown: AtomicBool::new(false),
            install_requested: AtomicBool::new(false),
            install_cancelled: AtomicBool::new(false),
            runtime_removing: AtomicBool::new(false),
            last_error: Mutex::new(None),
            setup: Mutex::new(None),
            setup_workers: AtomicUsize::new(0),
        }
    }
    fn with_store<T>(&self, f: impl FnOnce(&mut Store) -> Result<T, String>) -> Result<T, String> {
        let mut store = self.store.lock().map_err(|_| "bridge_lock_poisoned")?;
        if store.is_none() {
            *store = Some(Store::open(&self.root)?)
        }
        f(store.as_mut().expect("initialized"))
    }
    fn account_for_token(&self, header: &str) -> Option<String> {
        let gateways = self.gateways.lock().unwrap();
        resolve_bearer(
            header,
            gateways
                .iter()
                .filter(|(_, g)| g.process.alive())
                .map(|(account, g)| (account.as_str(), g.token.as_str())),
        )
    }
    pub fn authorized_token(&self, header: &str) -> bool {
        self.account_for_token(header).is_some()
    }
    pub fn status(&self) -> Value {
        let mut gateway = self
            .host_process()
            .ok()
            .map(|p| p.snapshot())
            .unwrap_or(json!({"state":"stopped","platforms":[]}));
        if let Some(object) = gateway.as_object_mut() {
            object.remove("pending");
            object.remove("pairing");
        }
        if self.startup.discovery_pending() {
            gateway["state"] = json!("starting");
        }
        if let Some(error) = self.last_error.lock().unwrap().as_ref() {
            gateway["error"] = json!(error);
        }
        let mut result = json!({"installer":self.installer.status(),"gateway":gateway,"connections":[],"pending":[],"pairing":null,"routes":[],"operations":[],"deliveries":[],"workspaces":[],"setup":self.setup_snapshot()});
        if self.install_requested.load(Ordering::Acquire)
            && !self.runtime_removing.load(Ordering::Acquire)
            && ["not_installed", "installed", "error"]
                .contains(&result["installer"]["state"].as_str().unwrap_or(""))
        {
            result["installer"]["state"] = json!("checking");
        }
        if self.root.join("bridge.sqlite3").exists() {
            let records = self.with_store(|s| {
                let routes = s.routes()?;
                result["operations"] = json!(s.operations()?.into_iter().take(30).map(|op| {
                    let account = routes.iter().find(|r| r.id == op.route_id).map(|r| &r.source.account_ref);
                    json!({"id":op.id,"accountRef":account,"runtimeId":op.runtime_id,"state":op.state,"detail":op.detail,"updatedAt":op.updated_at})
                }).collect::<Vec<_>>());
                result["routes"] = json!(routes);
                result["deliveries"] = json!(s.deliveries()?.into_iter().take(30).collect::<Vec<_>>());
                s.connections()
            });
            match records {
                Ok(records) => {
                    result["connections"] = json!(records
                        .iter()
                        .map(|record| {
                            let mut public = record.public_status();
                            if let Ok(process) = self.connection_process(&record.account_ref) {
                                let snapshot = process.snapshot();
                                public["state"] = snapshot["state"].clone();
                                public["error"] = snapshot["error"].clone();
                                public["pending"] = snapshot["pending"]
                                    .as_array()
                                    .map(|v| json!(v))
                                    .unwrap_or(json!([]));
                                public["pairing"] = snapshot["pairing"].clone();
                            } else if record.enabled
                                && self.startup.connection_pending(&record.account_ref)
                            {
                                public["state"] = json!("starting");
                            }
                            if let Some(error) = self
                                .connection_errors
                                .lock()
                                .unwrap()
                                .get(&record.account_ref)
                            {
                                apply_connection_error(&mut public, error);
                            }
                            public
                        })
                        .collect::<Vec<_>>())
                }
                Err(error) => result["gateway"]["error"] = json!(error),
            }
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
    // Discovery has no registered bridge capability and never owns a connection.
    fn host_process(&self) -> Result<Arc<GatewayProcess>, String> {
        self.discovery
            .lock()
            .unwrap()
            .as_ref()
            .map(|g| g.process.clone())
            .ok_or_else(|| "gateway_not_running".into())
    }
    fn connection_process(&self, account: &str) -> Result<Arc<GatewayProcess>, String> {
        self.gateways
            .lock()
            .unwrap()
            .get(account)
            .map(|g| g.process.clone())
            .ok_or_else(|| "gateway_not_running".into())
    }
    fn stop_connection_locked(&self, account: &str) {
        self.startup.cancel_connection(account);
        let gateway = self.gateways.lock().unwrap().remove(account);
        drop(gateway); // Revoke the token before waiting on this exact child.
    }
    fn stop_locked(&self) {
        self.startup.cancel_all();
        let gateways = std::mem::take(&mut *self.gateways.lock().unwrap());
        let discovery = self.discovery.lock().unwrap().take();
        drop(gateways);
        drop(discovery);
    }
    fn spawn_gateway(
        &self,
        app: &AppHandle,
        connection: Option<&ConnectionRecord>,
        lease: HermesRuntimeLease,
    ) -> Result<OwnedGateway, String> {
        let port = app
            .state::<Arc<ExternalControlManager>>()
            .current_port()
            .ok_or("control_server_not_running")?;
        let instance = self.with_store(|s| {
            let instance = s.setting("instance")?.unwrap_or_else(random_id);
            s.set_setting("instance", &instance)?;
            Ok(instance)
        })?;
        let fields = connection
            .map(|c| decode_fields(&c.cipher))
            .transpose()?
            .map(|v| json!(v))
            .unwrap_or(json!({}));
        let account = connection
            .map(|c| c.account_ref.as_str())
            .unwrap_or("discovery");
        let token = random_id();
        let boot = json!({"protocolVersion":1,"instanceId":instance,"accountRef":account,"endpoint":format!("http://127.0.0.1:{port}/rpc"),"token":token,"platform":connection.map(|c| &c.platform),"fields":fields,"connect":connection.is_some()});
        let launch = &lease.launch;
        let process = GatewayProcess::spawn(
            &launch.python,
            &launch.host,
            &launch.source,
            &self.root.join("profiles").join(account),
            boot,
        )?;
        Ok(OwnedGateway {
            process: Arc::new(process),
            token,
            _lease: lease,
        })
    }
    pub fn action(
        self: &Arc<Self>,
        app: &AppHandle,
        action: &str,
        payload: Value,
    ) -> Result<Value, String> {
        if action == "cancelInstall" {
            self.installer.cancel();
            self.install_cancelled.store(true, Ordering::Release);
            self.startup.wake();
            return Ok(self.status());
        }
        if action == "removeRuntime" {
            return self.remove_runtime();
        }
        if action == "openPairing" || action == "approvePairing" {
            return self.pairing_action(app, action, &payload);
        }
        let _lifecycle =
            if ["cancelSetup", "stop", "removeChannel", "disableRoute"].contains(&action) {
                self.lifecycle.lock().map_err(|_| "bridge_lock_poisoned")?
            } else {
                idle_lifecycle(&self.lifecycle, &self.install_requested)?
            };
        match action {
            "beginSetup" => {
                self.begin_setup_locked(
                    app,
                    payload["platform"].as_str().ok_or("platform_required")?,
                )?;
            }
            "cancelSetup" => {
                self.cancel_setup_locked(payload["id"].as_str().ok_or("setup_id_required")?)?;
            }
            "install" => {
                self.with_store(|_| Ok(()))?;
                if self.install_requested.load(Ordering::Acquire) {
                    return Err("installation_already_running".into());
                }
                let had_runtime = self.installer.status().launch.is_some();
                self.install_cancelled.store(false, Ordering::Release);
                let reservation = self
                    .installer
                    .prepare_install()
                    .map_err(|e| e.to_string())?;
                self.invalidate_setup_locked();
                self.install_requested.store(true, Ordering::Release);
                self.stop_locked();
                let manager = self.clone();
                let app = app.clone();
                thread::spawn(move || {
                    // An in-flight verifier may already own the old runtime's
                    // shared lease. Wait outside the lifecycle lock before the
                    // installer requests exclusive activation. Cancellation can
                    // settle immediately without attempting activation.
                    manager
                        .startup
                        .wait_idle(|| manager.install_cancelled.load(Ordering::Acquire));
                    let install_result = reservation.run().map_err(|e| e.to_string());
                    let _guard = manager.lifecycle.lock().unwrap();
                    manager.install_requested.store(false, Ordering::Release);
                    if !manager.shutdown.load(Ordering::Acquire)
                        && (had_runtime || install_result.is_ok())
                    {
                        // Explicit updates restore every enabled connection on
                        // either the new runtime or the intact previous runtime.
                        let _ = manager.start_discovery_locked(&app);
                        if let Ok(connections) = manager.with_store(|s| s.connections()) {
                            for connection in connections.into_iter().filter(|c| c.enabled) {
                                let _ =
                                    manager.start_connection_locked(&app, &connection.account_ref);
                            }
                        }
                    }
                    if let Err(error) = install_result {
                        *manager.last_error.lock().unwrap() = Some(error);
                    }
                });
            }
            "configureChannel" => {
                let account_ref = self.configure_channel_locked(app, &payload)?;
                let mut result = self.status();
                result["configuredAccountRef"] = json!(account_ref);
                return Ok(result);
            }
            "refreshPlatforms" => {
                if self.setup_in_progress() {
                    return Err("setup_in_progress".into());
                }
                self.start_discovery_locked(app)?;
            }
            "start" => {
                let account = payload["accountRef"]
                    .as_str()
                    .ok_or("account_ref_required")?;
                self.with_store(|s| s.set_connection_enabled(account, true))?;
                self.start_connection_locked(app, account)?;
            }
            "stop" => {
                let account = payload["accountRef"]
                    .as_str()
                    .ok_or("account_ref_required")?;
                self.invalidate_setup_for_account(account);
                self.with_store(|s| s.set_connection_enabled(account, false))?;
                self.stop_connection_locked(account);
                self.connection_errors.lock().unwrap().remove(account);
            }
            "removeChannel" => {
                let account = payload["accountRef"]
                    .as_str()
                    .ok_or("account_ref_required")?;
                self.invalidate_setup_for_account(account);
                self.with_store(|s| s.remove_connection(account))?;
                self.stop_connection_locked(account);
                self.connection_errors.lock().unwrap().remove(account);
                self.failures.lock().unwrap().remove(account);
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
    fn remove_runtime(&self) -> Result<Value, String> {
        {
            let _guard = idle_lifecycle(&self.lifecycle, &self.install_requested)?;
            self.with_store(|s| {
                for connection in s.connections()? {
                    s.set_connection_enabled(&connection.account_ref, false)?;
                }
                Ok(())
            })?;
            self.runtime_removing.store(true, Ordering::Release);
            self.install_requested.store(true, Ordering::Release);
            self.invalidate_setup_locked();
            self.stop_locked();
        }
        // Preserve the synchronous remove action, while allowing stop/remove of
        // individual accounts and status reads during a previous verification.
        self.startup.wait_idle(|| false);
        let result = self.installer.remove_runtime().map_err(|e| e.to_string());
        let _guard = self.lifecycle.lock().unwrap();
        self.install_requested.store(false, Ordering::Release);
        self.runtime_removing.store(false, Ordering::Release);
        result?;
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
        let account = self
            .account_for_token(authorization)
            .ok_or("bridge_token_revoked")?;
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
        let route = self.with_store(|s| s.route_for_account(&account, &p.source))?;
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
            let mut initialized = false;
            loop {
                thread::sleep(Duration::from_secs(2));
                let Some(manager) = weak.upgrade() else { break };
                if manager.shutdown.load(Ordering::Acquire) {
                    break;
                }
                if manager.install_requested.load(Ordering::Acquire) {
                    // The explicit install worker restores saved connections.
                    // Startup and recovery must not reacquire old runtime leases.
                    initialized = true;
                    continue;
                }
                if !initialized {
                    initialized = true;
                    if manager.installer.status().launch.is_some() {
                        let Ok(_guard) =
                            idle_lifecycle(&manager.lifecycle, &manager.install_requested)
                        else {
                            continue;
                        };
                        let _ = manager.start_discovery_locked(&app);
                        if background_services {
                            let connections =
                                manager.with_store(|s| s.connections()).unwrap_or_default();
                            for connection in connections.into_iter().filter(|c| c.enabled) {
                                let _ =
                                    manager.start_connection_locked(&app, &connection.account_ref);
                            }
                        }
                    }
                }
                let discovery = manager.host_process().ok();
                if discovery.as_ref().is_some_and(|p| !p.alive()) && !manager.setup_in_progress() {
                    let Ok(_guard) = idle_lifecycle(&manager.lifecycle, &manager.install_requested)
                    else {
                        continue;
                    };
                    if manager.setup_in_progress()
                        || !discovery.as_ref().is_some_and(|old| {
                            manager
                                .host_process()
                                .is_ok_and(|current| Arc::ptr_eq(old, &current))
                        })
                    {
                        continue;
                    }
                    let count = *manager
                        .failures
                        .lock()
                        .unwrap()
                        .get("discovery")
                        .unwrap_or(&0);
                    if count < 3 {
                        let _ = manager.start_discovery_locked(&app);
                        manager
                            .failures
                            .lock()
                            .unwrap()
                            .insert("discovery".into(), count + 1);
                    }
                }
                let processes: Vec<_> = manager
                    .gateways
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|(account, g)| (account.clone(), g.process.clone()))
                    .collect();
                for (account, process) in processes {
                    if !process.alive() {
                        let Ok(_guard) =
                            idle_lifecycle(&manager.lifecycle, &manager.install_requested)
                        else {
                            break;
                        };
                        if !manager
                            .connection_process(&account)
                            .is_ok_and(|p| Arc::ptr_eq(&p, &process))
                        {
                            continue;
                        }
                        if !manager
                            .with_store(|s| s.connection(&account).map(|c| c.enabled))
                            .unwrap_or(false)
                        {
                            continue;
                        }
                        let count = *manager.failures.lock().unwrap().get(&account).unwrap_or(&0);
                        if count < 3 {
                            let _ = manager.start_connection_locked(&app, &account);
                            manager
                                .failures
                                .lock()
                                .unwrap()
                                .insert(account.clone(), count + 1);
                        } else {
                            manager
                                .connection_errors
                                .lock()
                                .unwrap()
                                .insert(account.clone(), "gateway_stopped_retry_required".into());
                        }
                    } else if process.snapshot()["state"] == "running" {
                        manager.schedule_poll(&account);
                    }
                }
            }
        });
    }
    fn schedule_poll(self: &Arc<Self>, account: &str) {
        if !self.polling.lock().unwrap().insert(account.into()) {
            return;
        }
        let manager = self.clone();
        let account = account.to_string();
        thread::spawn(move || {
            let result = poll::poll(&manager, &account);
            let _guard = manager.lifecycle.lock().unwrap();
            if manager
                .with_store(|s| s.connection(&account).map(|c| c.enabled))
                .unwrap_or(false)
                && manager
                    .connection_process(&account)
                    .is_ok_and(|p| p.snapshot()["state"] == "running")
            {
                let mut errors = manager.connection_errors.lock().unwrap();
                if let Err(error) = result {
                    errors.insert(account.clone(), error);
                } else {
                    errors.remove(&account);
                }
            }
            manager.polling.lock().unwrap().remove(&account);
        });
    }
    pub fn shutdown(&self) {
        self.shutdown.store(true, Ordering::Release);
        let _guard = self.lifecycle.lock().unwrap();
        self.invalidate_setup_locked();
        self.stop_locked()
    }
}
fn idle_lifecycle<'a>(
    lifecycle: &'a Mutex<()>,
    install_requested: &AtomicBool,
) -> Result<std::sync::MutexGuard<'a, ()>, String> {
    let guard = lifecycle.lock().map_err(|_| "bridge_lock_poisoned")?;
    // Recheck after acquiring the lock: an install may have reserved the runtime
    // while a watcher or UI action was waiting for an earlier lifecycle action.
    if install_requested.load(Ordering::Acquire) {
        return Err("installation_already_running".into());
    }
    Ok(guard)
}

fn resolve_bearer<'a>(
    header: &str,
    mut accounts: impl Iterator<Item = (&'a str, &'a str)>,
) -> Option<String> {
    accounts.find_map(|(account, token)| {
        let expected = format!("Bearer {token}");
        (header.len() == expected.len()
            && header
                .bytes()
                .zip(expected.bytes())
                .fold(0u8, |acc, (a, b)| acc | (a ^ b))
                == 0)
            .then(|| account.to_string())
    })
}
fn apply_connection_error(public: &mut Value, error: &str) {
    // Projection failures belong to event history. Preserve the host's network
    // state so a live connection remains pairable and can still be stopped.
    if public["error"].is_null() {
        public["error"] = json!(error);
    }
    if public["state"] == "stopped" {
        public["state"] = json!("error");
    }
}
fn decode_fields(cipher: &str) -> Result<serde_json::Map<String, Value>, String> {
    serde_json::from_str(&crypto::decrypt(cipher)?).map_err(|_| "channel_config_corrupt".into())
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
    const LIMIT: usize = 1800;
    if text.len() <= LIMIT {
        return text.into();
    }
    // Generated query commands are the user's way back to the full result.
    // Reserve their bytes before shortening potentially long task output.
    let tail = text.rsplit_once('\n').filter(|(_, tail)| {
        (tail.starts_with("/ccem operation ") || tail.starts_with("/ccem status "))
            && tail.len() + 4 < LIMIT
    });
    let (body, budget) = match tail {
        Some((body, tail)) => (body, LIMIT - tail.len() - 4), // Ellipsis + newline.
        None => (text, LIMIT - '…'.len_utf8()),
    };
    let mut end = budget.min(body.len());
    while !body.is_char_boundary(end) {
        end -= 1
    }
    match tail {
        Some((_, tail)) => format!("{}…\n{tail}", &body[..end]),
        None => format!("{}…", &body[..end]),
    }
}

#[tauri::command]
pub async fn hermes_status(
    manager: tauri::State<'_, Arc<HermesBridgeManager>>,
) -> Result<Value, String> {
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
