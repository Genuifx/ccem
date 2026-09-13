use super::*;
use std::sync::Condvar;

const ACTIVATION_TIMEOUT: Duration = Duration::from_secs(20);
const ACTIVATION_NOTIFICATION_INTERVAL: Duration = Duration::from_millis(250);
const ACTIVATION_POLL_INTERVAL: Duration = Duration::from_millis(20);
const STALE_ACTIVATION: &str =
    "Browser activation belongs to a stopped or stale foreground command.";
const ACTIVATION_TIMED_OUT: &str =
    "The embedded browser did not become ready for this conversation before activation timed out.";

#[derive(Clone)]
struct BrowserActivationForeground {
    command_id: String,
    query_generation: u64,
    conversation_epoch: u64,
    actor_id: String,
}

#[derive(Default)]
struct NativeBrowserRequestState {
    activating: bool,
    rejection: Option<&'static str>,
}

struct NativeBrowserRequest {
    foreground: Option<BrowserActivationForeground>,
    state: Mutex<NativeBrowserRequestState>,
    changed: Condvar,
}

impl NativeBrowserRequest {
    fn begin_activation(&self) -> Result<(), String> {
        self.state
            .lock()
            .map_err(|_| "Failed to lock browser activation".to_string())?
            .activating = true;
        Ok(())
    }

    fn finish_activation(&self) -> bool {
        self.state
            .lock()
            .map(|mut state| std::mem::take(&mut state.activating))
            .unwrap_or(false)
    }

    fn ensure_pending_activation(&self) -> Result<(), String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Failed to lock browser activation".to_string())?;
        if let Some(error) = state.rejection {
            return Err(error.to_string());
        }
        if !state.activating {
            return Err("Browser activation request is no longer pending.".to_string());
        }
        Ok(())
    }

    fn reject(&self, reason: &str) -> Result<(), String> {
        let error = match reason {
            "disabled" => "Agent browser control is disabled for this conversation. Turn on Hand to Agent in its browser panel to continue.",
            "cancelled" => "Browser activation was cancelled by the user.",
            "unavailable" => "The embedded browser could not be opened for this conversation.",
            _ => return Err("Invalid browser activation rejection reason.".to_string()),
        };
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Failed to lock browser activation".to_string())?;
        if !state.activating {
            return Err("Browser activation request is no longer pending.".to_string());
        }
        state.rejection.get_or_insert(error);
        self.changed.notify_all();
        Ok(())
    }

    fn wait(&self, duration: Duration) -> Result<(), String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Failed to lock browser activation".to_string())?;
        if let Some(error) = state.rejection {
            return Err(error.to_string());
        }
        let (state, _) = self
            .changed
            .wait_timeout(state, duration)
            .map_err(|_| "Failed to wait for browser activation".to_string())?;
        state
            .rejection
            .map_or(Ok(()), |error| Err(error.to_string()))
    }
}

/// Requests belong to one exact helper incarnation. Keeping the registry on its handle makes
/// stale frontend callbacks unable to select a successor helper with the same runtime id.
#[derive(Default)]
pub(super) struct NativeBrowserRequests {
    pending: Mutex<HashMap<String, Arc<NativeBrowserRequest>>>,
}

impl NativeBrowserRequests {
    fn register(
        self: &Arc<Self>,
        request_id: &str,
        foreground: Option<BrowserActivationForeground>,
    ) -> Result<Option<NativeBrowserRequestLease>, String> {
        if request_id.is_empty()
            || request_id.len() > 80
            || !request_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            return Err("Invalid browser tool request ID.".to_string());
        }
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "Failed to lock native browser requests".to_string())?;
        if pending.contains_key(request_id) {
            return Ok(None);
        }
        let request = Arc::new(NativeBrowserRequest {
            foreground,
            state: Mutex::default(),
            changed: Condvar::new(),
        });
        pending.insert(request_id.to_string(), Arc::clone(&request));
        Ok(Some(NativeBrowserRequestLease {
            registry: Arc::clone(self),
            request_id: request_id.to_string(),
            request,
        }))
    }

    fn get(&self, request_id: &str) -> Result<Arc<NativeBrowserRequest>, String> {
        self.pending
            .lock()
            .map_err(|_| "Failed to lock native browser requests".to_string())?
            .get(request_id)
            .cloned()
            .ok_or_else(|| "Browser activation request is no longer pending.".to_string())
    }
}

struct NativeBrowserRequestLease {
    registry: Arc<NativeBrowserRequests>,
    request_id: String,
    request: Arc<NativeBrowserRequest>,
}

impl Drop for NativeBrowserRequestLease {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.registry.pending.lock() {
            if pending
                .get(&self.request_id)
                .is_some_and(|request| Arc::ptr_eq(request, &self.request))
            {
                pending.remove(&self.request_id);
            }
        }
    }
}

#[derive(Clone, Serialize)]
struct NativeBrowserActivationRequested<'a> {
    runtime_id: &'a str,
    request_id: &'a str,
}

#[derive(Clone, Serialize)]
struct NativeBrowserActivationFinished<'a> {
    runtime_id: &'a str,
    request_id: &'a str,
    activated: bool,
}

fn finish_activation(
    app: &AppHandle,
    runtime_id: &str,
    request_id: &str,
    pending: &NativeBrowserRequest,
    activated: bool,
) {
    if pending.finish_activation() {
        let _ = app.emit_to(
            "main",
            "native_browser_activation_finished",
            NativeBrowserActivationFinished {
                runtime_id,
                request_id,
                activated,
            },
        );
    }
}

fn wait_for_activation<T>(
    request: &NativeBrowserRequest,
    mut prepare: impl FnMut() -> Result<Option<T>, String>,
    mut validate: impl FnMut() -> Result<(), String>,
    mut notify: impl FnMut() -> Result<(), String>,
    timeout: Duration,
    notification_interval: Duration,
) -> Result<T, String> {
    let deadline = Instant::now() + timeout;
    let mut next_notification = Instant::now();
    loop {
        if Instant::now() >= deadline {
            return Err(ACTIVATION_TIMED_OUT.to_string());
        }
        request.ensure_pending_activation()?;
        validate()?;
        if let Some(prepared) = prepare()? {
            // The native route and the UI rejection can change while preparation runs.
            request.ensure_pending_activation()?;
            validate()?;
            if Instant::now() >= deadline {
                return Err(ACTIVATION_TIMED_OUT.to_string());
            }
            return Ok(prepared);
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(ACTIVATION_TIMED_OUT.to_string());
        }
        if now >= next_notification {
            notify()?;
            next_notification = now + notification_interval;
        }
        request.wait(ACTIVATION_POLL_INTERVAL.min(deadline - now))?;
    }
}

impl NativeRuntimeManager {
    fn capture_browser_activation_foreground(
        &self,
        runtime_id: &str,
        handle: &Arc<NativeSessionHandle>,
    ) -> Option<BrowserActivationForeground> {
        let projection = self.lifecycle.projection(runtime_id)?;
        let command_id = projection.active_command_id?;
        let conversation_epoch = self
            .session_handoff_foreground(
                runtime_id,
                handle,
                projection.query_generation,
                &command_id,
            )
            .ok()?;
        Some(BrowserActivationForeground {
            command_id,
            query_generation: projection.query_generation,
            conversation_epoch,
            actor_id: handle.record.lock().ok()?.browser_actor_id.clone(),
        })
    }

    fn validate_browser_activation(
        &self,
        runtime_id: &str,
        handle: &Arc<NativeSessionHandle>,
        request: &NativeBrowserRequest,
    ) -> Result<(), String> {
        let foreground = request.foreground.as_ref().ok_or_else(|| {
            "Opening the embedded browser requires a current foreground command.".to_string()
        })?;
        if !handle.alive.load(Ordering::SeqCst)
            || handle.permission_quarantined.load(Ordering::SeqCst)
            || !self.is_current_handle(runtime_id, handle)?
        {
            return Err(STALE_ACTIVATION.to_string());
        }
        let epoch = self
            .session_handoff_foreground(
                runtime_id,
                handle,
                foreground.query_generation,
                &foreground.command_id,
            )
            .map_err(|_| STALE_ACTIVATION.to_string())?;
        if epoch != foreground.conversation_epoch
            || self.browser_actor_id_for_runtime(runtime_id)? != foreground.actor_id
        {
            return Err(STALE_ACTIVATION.to_string());
        }
        Ok(())
    }

    pub(crate) fn get_browser_activation(
        &self,
        runtime_id: &str,
        request_id: &str,
    ) -> Result<NativeSessionSummary, String> {
        let handle = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(runtime_id)
            .cloned()
            .ok_or_else(|| STALE_ACTIVATION.to_string())?;
        let request = handle.browser_requests.get(request_id)?;
        request.ensure_pending_activation()?;
        self.validate_browser_activation(runtime_id, &handle, &request)?;
        let summary = self.summary_for(runtime_id)?;
        self.validate_browser_activation(runtime_id, &handle, &request)?;
        request.ensure_pending_activation()?;
        Ok(summary)
    }

    pub(crate) fn reject_browser_activation(
        &self,
        runtime_id: &str,
        request_id: &str,
        reason: &str,
    ) -> Result<(), String> {
        let handle = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(runtime_id)
            .cloned()
            .ok_or_else(|| STALE_ACTIVATION.to_string())?;
        let request = handle.browser_requests.get(request_id)?;
        self.validate_browser_activation(runtime_id, &handle, &request)?;
        request.reject(reason)
    }

    pub(super) fn handle_browser_tool_request(
        &self,
        app: Option<&AppHandle>,
        runtime_id: &str,
        helper_incarnation: u64,
        request: BrowserToolRequest,
    ) -> Result<(), String> {
        let handle = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(runtime_id)
            .filter(|handle| handle.generation == helper_incarnation)
            .cloned()
            .ok_or_else(|| "Browser tool request came from a stale helper.".to_string())?;
        if handle.permission_quarantined.load(Ordering::SeqCst) {
            return Err(
                "Native runtime helper is quarantined after an incomplete permission update."
                    .to_string(),
            );
        }
        let app = app
            .ok_or_else(|| "Browser tool request requires an app handle.".to_string())?
            .clone();
        let manager = app
            .try_state::<Arc<NativeRuntimeManager>>()
            .map(|state| Arc::clone(state.inner()))
            .ok_or_else(|| "Native runtime manager is unavailable.".to_string())?;
        let foreground = self.capture_browser_activation_foreground(runtime_id, &handle);
        let Some(pending) = handle
            .browser_requests
            .register(&request.request_id, foreground)?
        else {
            // One original request owns both the effect and response. A duplicate must not
            // fail that same waiter while its first execution is still in flight.
            return Ok(());
        };
        let runtime_id = runtime_id.to_string();
        // Browser startup and semantic commands can wait on native owner work. Keep the stdout
        // pump free to ingest permission ACKs, Stop results, and helper termination meanwhile.
        tauri::async_runtime::spawn_blocking(move || {
            let result = manager.execute_browser_tool_request(
                &app,
                &runtime_id,
                &handle,
                &request,
                &pending.request,
            );
            finish_activation(
                &app,
                &runtime_id,
                &request.request_id,
                &pending.request,
                false,
            );
            if manager
                .is_current_handle(&runtime_id, &handle)
                .unwrap_or(false)
                && handle.alive.load(Ordering::SeqCst)
            {
                if let Err(error) = manager.write_to_child(
                    &handle,
                    &HelperInputCommand::BrowserToolResponse {
                        request_id: &request.request_id,
                        ok: result.is_ok(),
                        result: result.as_ref().ok(),
                        error: result.as_ref().err().map(String::as_str),
                    },
                ) {
                    let _ = manager.append_event_if_current(
                        &runtime_id,
                        SessionEventPayload::StdErrLine {
                            line: format!("Failed to return browser tool result: {error}"),
                        },
                        &handle,
                    );
                }
            }
            // The lease removes the request on success, rejection, timeout, or cancellation.
            drop(pending);
        });
        Ok(())
    }

    fn execute_browser_tool_request(
        &self,
        app: &AppHandle,
        runtime_id: &str,
        handle: &Arc<NativeSessionHandle>,
        request: &BrowserToolRequest,
        pending: &NativeBrowserRequest,
    ) -> Result<Value, String> {
        let login = app
            .try_state::<Arc<crate::browser::login::session::LoginBrowserSessionManager>>()
            .map(|state| Arc::clone(&state))
            .ok_or_else(|| "Mode 2 browser manager is not registered.".to_string())?;
        let (workspace_dir, browser_actor_id) = {
            let record = handle
                .record
                .lock()
                .map_err(|_| "Failed to lock native session record".to_string())?;
            if !is_valid_browser_actor_id(&record.browser_actor_id) {
                return Err("Native browser actor lineage is unavailable.".to_string());
            }
            (record.project_dir.clone(), record.browser_actor_id.clone())
        };
        let prepare = || {
            if !handle.alive.load(Ordering::SeqCst)
                || handle.permission_quarantined.load(Ordering::SeqCst)
                || !self.is_current_handle(runtime_id, handle)?
            {
                return Err(STALE_ACTIVATION.to_string());
            }
            let _sync = handle
                .browser_permission_sync
                .lock()
                .map_err(|_| "Failed to lock native browser permission authority".to_string())?;
            if handle.permission_quarantined.load(Ordering::SeqCst) {
                return Err(
                    "Native runtime helper is quarantined after an incomplete permission update."
                        .to_string(),
                );
            }
            let authority = handle
                .browser_permission
                .current_ticket()
                .map_err(|_| "Native browser permission authority is unavailable".to_string())?;
            {
                let record = handle
                    .record
                    .lock()
                    .map_err(|_| "Failed to lock native session record".to_string())?;
                let recorded_mode = effective_native_perm_mode(
                    record.perm_mode.as_str(),
                    record.runtime_perm_mode.as_deref(),
                );
                if recorded_mode != authority.mode() {
                    return Err("Native browser permission authority is out of sync.".to_string());
                }
                if record.browser_actor_id != browser_actor_id {
                    return Err("Native browser actor lineage changed.".to_string());
                }
            }
            login.prepare_agent_tool_if_handed_off(
                &workspace_dir,
                &browser_actor_id,
                authority,
                request,
            )
        };
        let prepared = match prepare()? {
            Some(prepared) => prepared,
            None => {
                self.validate_browser_activation(runtime_id, handle, pending)?;
                pending.begin_activation()?;
                let prepared = wait_for_activation(
                    pending,
                    prepare,
                    || self.validate_browser_activation(runtime_id, handle, pending),
                    || {
                        app.emit_to(
                            "main",
                            "native_browser_activation_requested",
                            NativeBrowserActivationRequested {
                                runtime_id,
                                request_id: &request.request_id,
                            },
                        )
                        .map_err(|error| format!("Failed to request browser activation: {error}"))
                    },
                    ACTIVATION_TIMEOUT,
                    ACTIVATION_NOTIFICATION_INTERVAL,
                );
                finish_activation(
                    app,
                    runtime_id,
                    &request.request_id,
                    pending,
                    prepared.is_ok(),
                );
                // Resolving the activation never runs the original operation through a UI
                // navigation shortcut. Its exact actor, control and permission gates remain.
                prepared?
            }
        };
        login.execute_prepared_agent_tool(request, prepared)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn request_lease() -> NativeBrowserRequestLease {
        let registry = Arc::new(NativeBrowserRequests::default());
        let lease = registry.register("request-a", None).unwrap().unwrap();
        lease.request.begin_activation().unwrap();
        lease
    }

    fn foreground_request(
        runtime_id: &str,
    ) -> (
        Arc<NativeRuntimeManager>,
        Arc<NativeSessionHandle>,
        NativeBrowserRequestLease,
    ) {
        let manager = Arc::new(super::super::tests::manager_with_handle(runtime_id));
        let handle = manager.handles.lock().unwrap()[runtime_id].clone();
        manager
            .lifecycle
            .note_incarnation(runtime_id, handle.generation);
        manager.lifecycle.note_session_meta(
            runtime_id,
            handle.generation,
            Some("conversation-a"),
            Some(&["msg_lifecycle_v1".to_string()]),
            Some(1),
        );
        manager
            .lifecycle
            .admit_prompt_with_id(runtime_id, handle.generation, "command-a")
            .unwrap();
        manager
            .lifecycle
            .note_command_admitted(runtime_id, handle.generation, "command-a", 1);
        let foreground = manager.capture_browser_activation_foreground(runtime_id, &handle);
        assert!(foreground.is_some());
        let lease = handle
            .browser_requests
            .register("request-a", foreground)
            .unwrap()
            .unwrap();
        lease.request.begin_activation().unwrap();
        (manager, handle, lease)
    }

    #[test]
    fn browser_activation_retries_notification_and_resolves_one_original_request() {
        let lease = request_lease();
        let notifications = AtomicUsize::new(0);
        let ready = AtomicBool::new(false);
        let prepared = wait_for_activation(
            &lease.request,
            || Ok(ready.load(Ordering::SeqCst).then_some("exact-actor-route")),
            || Ok(()),
            || {
                if notifications.fetch_add(1, Ordering::SeqCst) == 1 {
                    ready.store(true, Ordering::SeqCst);
                }
                Ok(())
            },
            Duration::from_secs(1),
            Duration::from_millis(1),
        )
        .unwrap();
        assert_eq!(prepared, "exact-actor-route");
        assert_eq!(notifications.load(Ordering::SeqCst), 2);
        lease.request.finish_activation();
        assert!(lease.request.ensure_pending_activation().is_err());
        let registry = Arc::clone(&lease.registry);
        drop(lease);
        assert!(registry.get("request-a").is_err());
    }

    #[test]
    fn browser_activation_rejection_wakes_waiter_without_preparing_an_effect() {
        let lease = request_lease();
        let error = wait_for_activation::<()>(
            &lease.request,
            || Ok(None),
            || Ok(()),
            || lease.request.reject("disabled"),
            Duration::from_secs(1),
            Duration::from_millis(250),
        )
        .unwrap_err();
        assert!(error.contains("disabled"));
        assert!(lease.request.reject("arbitrary-message").is_err());
        let registry = Arc::clone(&lease.registry);
        drop(lease);
        assert!(registry.get("request-a").is_err());
    }

    #[test]
    fn browser_activation_timeout_cleans_up_the_request() {
        let lease = request_lease();
        let error = wait_for_activation::<()>(
            &lease.request,
            || Ok(None),
            || Ok(()),
            || Ok(()),
            Duration::from_millis(1),
            Duration::from_millis(250),
        )
        .unwrap_err();
        assert!(error.contains("timed out"));
        let registry = Arc::clone(&lease.registry);
        drop(lease);
        assert!(registry.get("request-a").is_err());
    }

    #[test]
    fn browser_activation_deduplicates_only_the_exact_helper_request() {
        let registry = Arc::new(NativeBrowserRequests::default());
        let first = registry.register("request-a", None).unwrap().unwrap();
        assert!(registry.register("request-a", None).unwrap().is_none());
        let second = registry.register("request-b", None).unwrap().unwrap();
        first.request.begin_activation().unwrap();
        second.request.begin_activation().unwrap();
        first.request.reject("cancelled").unwrap();
        assert!(first.request.ensure_pending_activation().is_err());
        assert!(second.request.ensure_pending_activation().is_ok());
        drop(first);
        assert!(registry.get("request-a").is_err());
        assert!(registry.get("request-b").is_ok());
    }

    #[test]
    fn browser_activation_stop_cancels_the_live_helper_wait_and_late_ui_claim() {
        let runtime_id = "browser-activation-stop";
        let (manager, handle, lease) = foreground_request(runtime_id);
        assert_eq!(
            manager
                .get_browser_activation(runtime_id, "request-a")
                .unwrap()
                .runtime_id,
            runtime_id,
        );
        let error = wait_for_activation::<()>(
            &lease.request,
            || Ok(None),
            || manager.validate_browser_activation(runtime_id, &handle, &lease.request),
            || {
                // Admission fences the command even when this test's helper has no writer.
                let _ =
                    manager.stop_session_from_expected(runtime_id, Some("test"), Some("command-a"));
                Ok(())
            },
            Duration::from_secs(1),
            Duration::from_millis(250),
        )
        .unwrap_err();
        assert!(error.contains("stopped or stale"));
        assert!(
            handle.alive.load(Ordering::SeqCst),
            "foreground Stop retains the helper"
        );
        assert!(manager
            .get_browser_activation(runtime_id, "request-a")
            .is_err());
    }

    #[test]
    fn browser_activation_rejects_replaced_query_and_helper_incarnation() {
        let runtime_id = "browser-activation-query";
        let (manager, handle, lease) = foreground_request(runtime_id);
        manager.lifecycle.note_session_meta(
            runtime_id,
            handle.generation,
            Some("conversation-b"),
            Some(&["msg_lifecycle_v1".to_string()]),
            Some(2),
        );
        assert!(manager
            .get_browser_activation(runtime_id, "request-a")
            .is_err());
        drop(lease);

        let runtime_id = "browser-activation-helper";
        let (manager, _handle, lease) = foreground_request(runtime_id);
        manager.handles.lock().unwrap().remove(runtime_id);
        assert!(manager
            .get_browser_activation(runtime_id, "request-a")
            .is_err());
        drop(lease);
    }

    #[test]
    fn browser_activation_rejects_a_replacement_command_and_missing_foreground() {
        let runtime_id = "browser-activation-command";
        let (manager, handle, lease) = foreground_request(runtime_id);
        manager.process_helper_stdout(runtime_id, r#"{"type":"event","payload":{"type":"lifecycle","stage":"sdk_command_state","detail":"completed","command_id":"command-a","query_generation":1}}"#).unwrap();
        manager
            .lifecycle
            .admit_prompt_with_id(runtime_id, handle.generation, "command-b")
            .unwrap();
        manager
            .lifecycle
            .note_command_admitted(runtime_id, handle.generation, "command-b", 1);
        assert!(manager
            .get_browser_activation(runtime_id, "request-a")
            .is_err());
        drop(lease);

        let runtime_id = "browser-activation-no-foreground";
        let manager = super::super::tests::manager_with_handle(runtime_id);
        let handle = manager.handles.lock().unwrap()[runtime_id].clone();
        assert!(manager
            .capture_browser_activation_foreground(runtime_id, &handle)
            .is_none());
        let lease = handle
            .browser_requests
            .register("request-a", None)
            .unwrap()
            .unwrap();
        lease.request.begin_activation().unwrap();
        assert!(manager
            .get_browser_activation(runtime_id, "request-a")
            .unwrap_err()
            .contains("foreground"));
    }
}
