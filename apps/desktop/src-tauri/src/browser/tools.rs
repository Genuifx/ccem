use super::login::capability::BrowserPermissionAuthorityTicket;
use super::registry::{BrowserOperationToken, BrowserSessionState};
use super::{
    emit_browser_opened_for_agent, emit_browser_state, normalize_browser_session_id,
    BrowserManager, BrowserToolRequest,
};
use rand::rngs::OsRng;
use rand::RngCore;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

fn required_string_arg(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("Missing browser tool string arg: {key}"))
}

fn required_u32_arg(args: &Value, key: &str) -> Result<u32, String> {
    let value = args
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("Missing browser tool numeric arg: {key}"))?;
    u32::try_from(value).map_err(|_| format!("Browser tool arg out of range: {key}"))
}

fn decode_eval_value(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string()))
}

fn decode_eval_json_string(raw: &str) -> Result<String, String> {
    match serde_json::from_str::<Value>(raw)
        .map_err(|error| format!("decode browser eval: {error}"))?
    {
        Value::String(value) => Ok(value),
        other => Ok(other.to_string()),
    }
}

pub(super) fn build_eval_json_script(expression: &str) -> Result<String, String> {
    Ok(format!(
        r#"
(() => {{
  try {{
    const value = (
{expression}
    );
    return JSON.stringify(value === undefined ? null : value);
  }} catch (error) {{
    return JSON.stringify({{ ok: false, error: String(error && error.message || error) }});
  }}
}})()
"#
    ))
}

impl BrowserManager {
    pub fn run_tool(
        &self,
        app: &AppHandle,
        session_id: &str,
        workspace_dir: &str,
        request: &BrowserToolRequest,
    ) -> Result<Value, String> {
        self.run_tool_with_permission_context(app, session_id, workspace_dir, request, None)
    }

    pub(crate) fn run_tool_with_permission(
        &self,
        app: &AppHandle,
        session_id: &str,
        workspace_dir: &str,
        request: &BrowserToolRequest,
        permission: &BrowserPermissionAuthorityTicket,
    ) -> Result<Value, String> {
        self.run_tool_with_permission_context(
            app,
            session_id,
            workspace_dir,
            request,
            Some(permission),
        )
    }

    fn run_tool_with_permission_context(
        &self,
        app: &AppHandle,
        session_id: &str,
        workspace_dir: &str,
        request: &BrowserToolRequest,
        permission: Option<&BrowserPermissionAuthorityTicket>,
    ) -> Result<Value, String> {
        let started_at = Instant::now();
        let outcome = self.run_tool_authorized(app, session_id, workspace_dir, request, permission);
        if let Err(error) = self.audit_tool_result(
            workspace_dir,
            session_id,
            request,
            started_at.elapsed().as_millis(),
            &outcome,
        ) {
            eprintln!("Failed to append preview browser action audit: {error}");
        }
        outcome
    }

    fn run_tool_authorized(
        &self,
        app: &AppHandle,
        session_id: &str,
        workspace_dir: &str,
        request: &BrowserToolRequest,
        permission: Option<&BrowserPermissionAuthorityTicket>,
    ) -> Result<Value, String> {
        let requested_session_id = normalize_browser_session_id(Some(session_id));
        // Native helpers address their owning runtime, while the trusted shell gives every
        // mounted Preview Browser a lifetime-unique physical id. An existing binding is frozen
        // immediately; an Agent-first request may create one provisional generation and adopt
        // the first shell binding, but can never follow a later unbind/rebind or reopen.
        let (mut route, initial_session) = {
            let _routing = self.alias_operation()?;
            let mut route = self.capture_preview_route_locked(&requested_session_id)?;
            let session =
                self.prepare_initial_agent_tool_route_locked(&mut route, workspace_dir)?;
            (route, session)
        };
        if initial_session.paused {
            return Err("Browser agent control is paused by the user.".to_string());
        }
        self.reveal_for_agent_tool(app, &initial_session, &requested_session_id)?;
        self.wait_for_visible_agent_control(app, &mut route)?;

        let (session_id, expected_generation, actor) = {
            let _routing = self.alias_operation()?;
            let session =
                self.prepare_existing_agent_tool_route_locked(&mut route, workspace_dir)?;
            let actor = self.registry.actor(&session.session_id)?;
            (session.session_id, session.generation, actor)
        };
        let _permit = actor
            .lock()
            .map_err(|_| format!("Browser session {session_id} actor is unavailable"))?;
        let session = {
            let _routing = self.alias_operation()?;
            let session =
                self.prepare_existing_agent_tool_route_locked(&mut route, workspace_dir)?;
            if session.session_id != session_id || session.generation != expected_generation {
                return Err(super::stale_preview_route_error());
            }
            self.discard_provisional_agent_route_locked(app, &route, &session)?;
            session
        };
        if session.paused {
            return Err("Browser agent control is paused by the user.".to_string());
        }
        let expected_cancel_epoch = session.cancel_epoch;
        let _ = self.drain_console_log(app, &session_id, workspace_dir);
        let (active, token) = match permission {
            Some(permission) => begin_permission_bound_preview_action(
                self.registry.as_ref(),
                &session_id,
                expected_generation,
                expected_cancel_epoch,
                &request.tool,
                permission,
            )?,
            None => self.registry.begin_agent_action_expected_route(
                &session_id,
                expected_generation,
                expected_cancel_epoch,
                &request.tool,
            )?,
        };
        emit_browser_state(app, &active, "agent_action_started");

        let effect = || self.run_tool_inner(app, &session_id, workspace_dir, request, &token);
        let outcome = if preview_tool_has_immediate_effect(&request.tool) {
            match permission {
                Some(permission) => execute_permission_bound_preview_effect(
                    self.registry.as_ref(),
                    &token,
                    permission,
                    effect,
                ),
                None => {
                    self.registry.validate_operation(&token)?;
                    effect().and_then(|value| {
                        self.registry.validate_operation(&token)?;
                        Ok(value)
                    })
                }
            }
        } else {
            effect().and_then(|value| {
                self.registry.validate_operation(&token)?;
                Ok(value)
            })
        };
        let finish_error = outcome.as_ref().err().map(String::as_str);
        if let Some(finished) = self.registry.finish_agent_action(&token, finish_error)? {
            emit_browser_state(
                app,
                &finished,
                if outcome.is_ok() {
                    "agent_action_finished"
                } else {
                    "agent_action_failed"
                },
            );
        }
        let _ = self.drain_console_log(app, &session_id, workspace_dir);
        outcome
    }

    fn prepare_initial_agent_tool_route_locked(
        &self,
        route: &mut super::alias::BrowserSessionAliasRoute,
        workspace_dir: &str,
    ) -> Result<BrowserSessionState, String> {
        if route.adopted.is_some() {
            return self.prepare_existing_agent_tool_route_locked(route, workspace_dir);
        }
        // Native Agent sessions do not have a BrowserPanel until their first browser tool asks
        // the trusted shell to reveal one. This is the only route path allowed to create a
        // provisional generation; all later reveal/wait/prepare phases are exact snapshots.
        let session = self.session_snapshot(&route.requested_session_id)?;
        route.provisional = Some((session.session_id.clone(), session.generation));
        self.registry
            .bind_workspace(&session.session_id, workspace_dir)
    }

    fn prepare_existing_agent_tool_route_locked(
        &self,
        route: &mut super::alias::BrowserSessionAliasRoute,
        workspace_dir: &str,
    ) -> Result<BrowserSessionState, String> {
        let session = self.preview_route_session_locked(route)?;
        self.registry
            .bind_workspace(&session.session_id, workspace_dir)
    }

    fn discard_provisional_agent_route_locked(
        &self,
        app: &AppHandle,
        route: &super::alias::BrowserSessionAliasRoute,
        adopted_session: &BrowserSessionState,
    ) -> Result<(), String> {
        let Some((provisional_session_id, provisional_generation)) = route.provisional.as_ref()
        else {
            return Ok(());
        };
        if provisional_session_id == &adopted_session.session_id
            && *provisional_generation == adopted_session.generation
        {
            return Ok(());
        }
        let Some(provisional) = self.registry.snapshot(provisional_session_id)? else {
            return Ok(());
        };
        if provisional.generation != *provisional_generation
            || app.get_webview(&provisional.label).is_some()
        {
            return Ok(());
        }
        if let Some(discarded) = self.registry.remove(provisional_session_id)? {
            emit_browser_state(app, &discarded, "agent_alias_adopted");
        }
        Ok(())
    }

    fn run_tool_inner(
        &self,
        app: &AppHandle,
        session_id: &str,
        workspace_dir: &str,
        request: &BrowserToolRequest,
        token: &BrowserOperationToken,
    ) -> Result<Value, String> {
        match request.tool.as_str() {
            "navigate" => {
                let url = required_string_arg(&request.args, "url")?;
                let info = self.navigate(app, Some(session_id), &url)?;
                serde_json::to_value(info).map_err(|error| error.to_string())
            }
            "get_url" => {
                let info = self.info(app, Some(session_id))?;
                Ok(json!({ "url": info.url, "title": info.title }))
            }
            "snapshot" => {
                let snapshot = self.snapshot(app, Some(session_id))?;
                self.store_interaction_snapshot_artifact(session_id, workspace_dir, &snapshot)
            }
            "click" => {
                let snapshot_id = required_string_arg(&request.args, "snapshotId")?;
                self.registry
                    .validate_interaction_snapshot(session_id, &snapshot_id)?;
                let reference = required_u32_arg(&request.args, "ref")?;
                let snapshot_id_json =
                    serde_json::to_string(&snapshot_id).map_err(|error| error.to_string())?;
                ensure_page_action_ok(self.eval_json(
                    app,
                    Some(session_id),
                    &format!(
                        r#"
                    (() => {{
                      const snapshotId = {snapshot_id_json};
                      const refs = window[`__ccemSnapshot_${{snapshotId}}`];
                      if (window.__ccemCurrentSnapshotId !== snapshotId || !refs) {{
                        return {{ ok: false, error: 'Browser interaction snapshot is stale' }};
                      }}
                      const node = refs[{reference}];
                      if (!node) return {{ ok: false, error: 'Unknown browser ref {reference}' }};
                      node.scrollIntoView({{ block: 'center', inline: 'center' }});
                      node.click();
                      return {{ ok: true }};
                    }})()
                    "#
                    ),
                )?)
            }
            "type" => {
                let snapshot_id = required_string_arg(&request.args, "snapshotId")?;
                self.registry
                    .validate_interaction_snapshot(session_id, &snapshot_id)?;
                let reference = required_u32_arg(&request.args, "ref")?;
                let text = required_string_arg(&request.args, "text")?;
                let text_json = serde_json::to_string(&text).map_err(|error| error.to_string())?;
                let snapshot_id_json =
                    serde_json::to_string(&snapshot_id).map_err(|error| error.to_string())?;
                ensure_page_action_ok(self.eval_json(
                    app,
                    Some(session_id),
                    &format!(
                        r#"
                    (() => {{
                      const snapshotId = {snapshot_id_json};
                      const refs = window[`__ccemSnapshot_${{snapshotId}}`];
                      if (window.__ccemCurrentSnapshotId !== snapshotId || !refs) {{
                        return {{ ok: false, error: 'Browser interaction snapshot is stale' }};
                      }}
                      const node = refs[{reference}];
                      if (!node) return {{ ok: false, error: 'Unknown browser ref {reference}' }};
                      node.focus();
                      if ('value' in node) {{
                        node.value = {text_json};
                        node.dispatchEvent(new Event('input', {{ bubbles: true }}));
                        node.dispatchEvent(new Event('change', {{ bubbles: true }}));
                      }} else {{
                        node.textContent = {text_json};
                      }}
                      return {{ ok: true }};
                    }})()
                    "#
                    ),
                )?)
            }
            "press_key" => {
                let key = required_string_arg(&request.args, "key")?;
                let key_json = serde_json::to_string(&key).map_err(|error| error.to_string())?;
                self.eval_json(app, Some(session_id), &format!(
                    r#"
                    (() => {{
                      const active = document.activeElement || document.body;
                      for (const type of ['keydown', 'keyup']) {{
                        active.dispatchEvent(new KeyboardEvent(type, {{ key: {key_json}, bubbles: true }}));
                      }}
                      return {{ ok: true }};
                    }})()
                    "#
                ))
            }
            "scroll" => {
                let delta_y = request
                    .args
                    .get("deltaY")
                    .or_else(|| request.args.get("delta_y"))
                    .and_then(Value::as_f64)
                    .unwrap_or(640.0);
                self.eval_json(
                    app,
                    Some(session_id),
                    &format!(
                        r#"
                    (() => {{
                      window.scrollBy(0, {delta_y});
                      return {{
                        ok: true,
                        scrollY: window.scrollY
                      }};
                    }})()
                    "#
                    ),
                )
            }
            "screenshot" => self.capture_screenshot_artifact(app, session_id, workspace_dir),
            "evaluate" => {
                let script = required_string_arg(&request.args, "script")?;
                let result = self.eval_js(app, Some(session_id), &script)?;
                Ok(json!({ "result": decode_eval_value(&result) }))
            }
            "wait_for" => {
                let text = required_string_arg(&request.args, "text")?;
                let timeout_ms = request
                    .args
                    .get("timeoutMs")
                    .or_else(|| request.args.get("timeout_ms"))
                    .and_then(Value::as_u64)
                    .unwrap_or(5_000);
                self.wait_for_text(app, Some(session_id), &text, timeout_ms, Some(token))
            }
            "read_console_log" => self.read_console_log(app, session_id, workspace_dir),
            "read_network_log" => Ok(preview_network_log_unsupported()),
            other => Err(format!("Unsupported browser tool: {other}")),
        }
    }

    fn reveal_for_agent_tool(
        &self,
        app: &AppHandle,
        session: &BrowserSessionState,
        agent_session_id: &str,
    ) -> Result<(), String> {
        if let Some(window) = app.get_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        emit_browser_opened_for_agent(app, &session.session_id, agent_session_id, &session.label);
        emit_browser_state(app, session, "agent_visibility_requested");
        Ok(())
    }

    fn wait_for_visible_agent_control(
        &self,
        app: &AppHandle,
        route: &mut super::alias::BrowserSessionAliasRoute,
    ) -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            let session = {
                let _routing = self.alias_operation()?;
                self.preview_route_session_locked(route)?
            };
            if session.paused {
                return Err("Browser agent control is paused by the user.".to_string());
            }
            let main_visible = app
                .get_window("main")
                .and_then(|window| window.is_visible().ok())
                .unwrap_or(false);
            if main_visible
                && app.get_webview(&session.label).is_some()
                && self.registry.is_visible_for_agent(&session.session_id)?
            {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(
                    "Browser action was cancelled because the matching Preview Browser session did not become visible."
                        .to_string(),
                );
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    pub(crate) fn snapshot(
        &self,
        app: &AppHandle,
        session_id: Option<&str>,
    ) -> Result<Value, String> {
        let session_id = normalize_browser_session_id(session_id);
        let snapshot_id = random_snapshot_id();
        let script = build_snapshot_script(&snapshot_id)?;
        let mut snapshot = self.eval_json(app, Some(&session_id), &script)?;
        self.record_browser_page_metadata_from_value(&session_id, &snapshot)?;
        let token = self
            .registry
            .record_interaction_snapshot(&session_id, &snapshot_id)?;
        let object = snapshot
            .as_object_mut()
            .ok_or_else(|| "Browser interaction snapshot is not an object.".to_string())?;
        object.insert("snapshot_id".to_string(), Value::String(snapshot_id));
        object.insert("generation".to_string(), json!(token.generation));
        object.insert("navigation_seq".to_string(), json!(token.navigation_seq));
        object.insert("frame_id".to_string(), Value::String("main".to_string()));
        Ok(snapshot)
    }

    pub(super) fn eval_json(
        &self,
        app: &AppHandle,
        session_id: Option<&str>,
        expression: &str,
    ) -> Result<Value, String> {
        let script = build_eval_json_script(expression)?;
        let raw = self.eval_js(app, session_id, &script)?;
        decode_eval_json_string(&raw).and_then(|json_text| {
            serde_json::from_str(&json_text)
                .map_err(|error| format!("decode browser JSON: {error}"))
        })
    }

    fn wait_for_text(
        &self,
        app: &AppHandle,
        session_id: Option<&str>,
        text: &str,
        timeout_ms: u64,
        operation: Option<&BrowserOperationToken>,
    ) -> Result<Value, String> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms.min(30_000));
        let needle = serde_json::to_string(text).map_err(|error| error.to_string())?;
        loop {
            if let Some(operation) = operation {
                self.registry.validate_operation(operation)?;
            }
            let found = self.eval_json(
                app,
                session_id,
                &format!("({{ ok: true, found: document.body && document.body.innerText.includes({needle}) }})"),
            )?;
            if found.get("found").and_then(Value::as_bool).unwrap_or(false) {
                return Ok(found);
            }
            if Instant::now() >= deadline {
                return Ok(json!({ "ok": false, "found": false, "timeout_ms": timeout_ms }));
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    }

    fn record_browser_page_metadata(
        &self,
        session_id: &str,
        url: Option<String>,
        title: Option<String>,
    ) -> Result<(), String> {
        if url.is_none() && title.is_none() {
            return Ok(());
        }
        self.registry.record_metadata(session_id, url, title)?;
        Ok(())
    }

    fn record_browser_page_metadata_from_value(
        &self,
        session_id: &str,
        value: &Value,
    ) -> Result<(), String> {
        let url = value
            .get("url")
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|value| !value.is_empty());
        let title = value
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|value| !value.is_empty());
        self.record_browser_page_metadata(session_id, url, title)
    }
}

fn begin_permission_bound_preview_action(
    registry: &super::registry::BrowserSessionRegistry,
    session_id: &str,
    expected_generation: u64,
    expected_cancel_epoch: u64,
    tool: &str,
    permission: &BrowserPermissionAuthorityTicket,
) -> Result<(super::registry::BrowserSessionState, BrowserOperationToken), String> {
    let revision = permission.revision();
    permission
        .with_current_revision(revision, || {
            registry.begin_agent_action_with_permission_expected_route(
                session_id,
                expected_generation,
                expected_cancel_epoch,
                tool,
                revision,
            )
        })
        .map_err(|_| "Browser permission changed before the Preview action began.".to_string())?
}

fn execute_permission_bound_preview_effect<T>(
    registry: &super::registry::BrowserSessionRegistry,
    token: &BrowserOperationToken,
    permission: &BrowserPermissionAuthorityTicket,
    effect: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let revision = token.permission_revision.ok_or_else(|| {
        "Browser permission revision is missing from the Preview action.".to_string()
    })?;
    permission
        .with_current_revision(revision, || {
            registry.validate_operation(token)?;
            let value = effect()?;
            registry.validate_operation(token)?;
            Ok(value)
        })
        .map_err(|_| "Browser permission changed before the Preview effect.".to_string())?
}

fn preview_tool_has_immediate_effect(tool: &str) -> bool {
    matches!(
        tool,
        "navigate" | "click" | "type" | "press_key" | "scroll" | "evaluate"
    )
}

fn preview_network_log_unsupported() -> Value {
    json!({
        "supported": false,
        "backend": "preview_browser",
        "reason": "Preview Browser does not expose network diagnostics.",
        "recent": [],
        "untrusted": true,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        begin_permission_bound_preview_action, execute_permission_bound_preview_effect,
        preview_network_log_unsupported, BrowserManager,
    };
    use crate::browser::login::capability::BrowserPermissionAuthority;
    use crate::browser::registry::BrowserSessionRegistry;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::sync::Arc;
    use std::time::Duration;

    fn ready_registry() -> Arc<BrowserSessionRegistry> {
        let registry = Arc::new(BrowserSessionRegistry::new("session-a"));
        registry
            .snapshot_or_create("session-a", |_| "browser-a".to_string())
            .expect("create preview session");
        registry.mark_ready("session-a").expect("ready session");
        registry
    }

    fn ready_generation(registry: &BrowserSessionRegistry) -> u64 {
        registry
            .snapshot("session-a")
            .expect("snapshot ready session")
            .expect("ready session exists")
            .generation
    }

    fn ready_cancel_epoch(registry: &BrowserSessionRegistry) -> u64 {
        registry
            .snapshot("session-a")
            .expect("snapshot ready session")
            .expect("ready session exists")
            .cancel_epoch
    }

    #[test]
    fn stale_prevalidated_authority_cannot_begin_after_downgrade() {
        let registry = ready_registry();
        let authority = BrowserPermissionAuthority::new("yolo");
        let stale = authority.current_ticket().expect("current ticket");
        stale
            .validate_current()
            .expect("simulate the former pre-execution validation");

        authority
            .update_with_invalidation("readonly", |revision| {
                registry
                    .bump_permission_epoch("session-a", revision)
                    .is_ok()
            })
            .expect("downgrade authority");

        assert!(begin_permission_bound_preview_action(
            registry.as_ref(),
            "session-a",
            ready_generation(registry.as_ref()),
            ready_cancel_epoch(registry.as_ref()),
            "click",
            &stale,
        )
        .is_err());
    }

    #[test]
    fn immediate_effect_linearizes_before_downgrade_and_is_stale_afterward() {
        let registry = ready_registry();
        let authority = Arc::new(BrowserPermissionAuthority::new("yolo"));
        let ticket = authority.current_ticket().expect("current ticket");
        let (_, token) = begin_permission_bound_preview_action(
            registry.as_ref(),
            "session-a",
            ready_generation(registry.as_ref()),
            ready_cancel_epoch(registry.as_ref()),
            "evaluate",
            &ticket,
        )
        .expect("begin bound action");
        let (effect_entered_tx, effect_entered_rx) = mpsc::channel();
        let (release_effect_tx, release_effect_rx) = mpsc::channel();
        let (effect_done_tx, effect_done_rx) = mpsc::channel();
        let effect_registry = Arc::clone(&registry);
        let effect_ticket = ticket.clone();
        let effect_token = token.clone();
        let effect_thread = std::thread::spawn(move || {
            let result = execute_permission_bound_preview_effect(
                effect_registry.as_ref(),
                &effect_token,
                &effect_ticket,
                || {
                    effect_entered_tx.send(()).unwrap();
                    release_effect_rx.recv().unwrap();
                    Ok::<_, String>("effect")
                },
            );
            effect_done_tx.send(result).unwrap();
        });
        effect_entered_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("effect acquired revision proof");

        let effect_released = Arc::new(AtomicBool::new(false));
        let (downgrade_started_tx, downgrade_started_rx) = mpsc::channel();
        let (downgrade_done_tx, downgrade_done_rx) = mpsc::channel();
        let downgrade_authority = Arc::clone(&authority);
        let downgrade_registry = Arc::clone(&registry);
        let downgrade_effect_released = Arc::clone(&effect_released);
        let downgrade_thread = std::thread::spawn(move || {
            downgrade_started_tx.send(()).unwrap();
            let result = downgrade_authority.update_with_invalidation("readonly", |revision| {
                assert!(downgrade_effect_released.load(Ordering::Acquire));
                downgrade_registry
                    .bump_permission_epoch("session-a", revision)
                    .is_ok()
            });
            downgrade_done_tx.send(result).unwrap();
        });
        downgrade_started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("downgrade started while the effect held its revision proof");
        assert!(downgrade_done_rx
            .recv_timeout(Duration::from_millis(50))
            .is_err());

        effect_released.store(true, Ordering::Release);
        release_effect_tx.send(()).unwrap();
        assert_eq!(
            effect_done_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("effect completed")
                .expect("effect result"),
            "effect"
        );
        downgrade_done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("downgrade completed")
            .expect("downgrade result");
        effect_thread.join().expect("effect thread");
        downgrade_thread.join().expect("downgrade thread");

        assert!(execute_permission_bound_preview_effect(
            registry.as_ref(),
            &token,
            &ticket,
            || Ok::<_, String>("stale effect"),
        )
        .is_err());
        assert!(registry.validate_operation(&token).is_err());
    }

    #[test]
    fn bound_wait_token_is_cancelled_without_blocking_the_downgrade() {
        let registry = ready_registry();
        let authority = BrowserPermissionAuthority::new("yolo");
        let ticket = authority.current_ticket().expect("current ticket");
        let (_, token) = begin_permission_bound_preview_action(
            registry.as_ref(),
            "session-a",
            ready_generation(registry.as_ref()),
            ready_cancel_epoch(registry.as_ref()),
            "wait_for",
            &ticket,
        )
        .expect("begin bound wait");
        let (cancelled_tx, cancelled_rx) = mpsc::channel();
        let wait_registry = Arc::clone(&registry);
        std::thread::spawn(move || loop {
            if wait_registry.validate_operation(&token).is_err() {
                cancelled_tx.send(()).unwrap();
                break;
            }
            std::thread::yield_now();
        });

        authority
            .update_with_invalidation("readonly", |revision| {
                registry
                    .bump_permission_epoch("session-a", revision)
                    .is_ok()
            })
            .expect("downgrade authority without waiting for the read operation");

        cancelled_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("bound wait observed cancellation");
    }

    #[test]
    fn first_native_agent_tool_registers_before_binding_workspace() {
        let browser = BrowserManager::default();
        let _routing = browser.alias_operation().expect("lock alias route");
        let mut route = browser
            .capture_preview_route_locked("native-first-tool")
            .expect("capture first route");
        let state = browser
            .prepare_initial_agent_tool_route_locked(&mut route, "/workspace/preview")
            .expect("prepare first native Agent browser tool");

        assert_eq!(state.session_id, "native-first-tool");
        assert_eq!(state.workspace_dir.as_deref(), Some("/workspace/preview"));
        assert_eq!(
            route.provisional,
            Some(("native-first-tool".to_string(), state.generation))
        );
    }

    #[test]
    fn preview_network_diagnostics_fail_explicitly_without_fabricating_data() {
        let value = preview_network_log_unsupported();
        assert_eq!(value["supported"], false);
        assert_eq!(value["backend"], "preview_browser");
        assert_eq!(value["recent"], serde_json::json!([]));
        assert!(value.get("path").is_none());
    }
}

fn random_snapshot_id() -> String {
    let mut bytes = [0_u8; 16];
    OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn build_snapshot_script(snapshot_id: &str) -> Result<String, String> {
    if snapshot_id.len() != 32 || !snapshot_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Browser snapshot id is invalid.".to_string());
    }
    Ok(SNAPSHOT_SCRIPT_TEMPLATE.replace("__CCEM_SNAPSHOT_ID__", snapshot_id))
}

fn ensure_page_action_ok(result: Value) -> Result<Value, String> {
    if result.get("ok").and_then(Value::as_bool) == Some(false) {
        return Err(result
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Browser page rejected the interaction.")
            .to_string());
    }
    Ok(result)
}

const SNAPSHOT_SCRIPT_TEMPLATE: &str = r#"
(() => {
  const snapshotId = '__CCEM_SNAPSHOT_ID__';
  const normalize = (value, limit = 160) => String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
  const isRendered = (node) => {
    if (!node || node.nodeType !== Node.ELEMENT_NODE || node.hidden || node.getAttribute('aria-hidden') === 'true') return false;
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return rect.width > 0
      && rect.height > 0
      && style.visibility !== 'hidden'
      && style.display !== 'none'
      && style.opacity !== '0';
  };
  const safeUrl = (value) => {
    if (!value) return null;
    try {
      const url = new URL(String(value), location.href);
      url.username = '';
      url.password = '';
      for (const key of Array.from(url.searchParams.keys())) {
        if (/(token|secret|pass(word)?|api.?key|auth|session|otp|one.?time|code)/i.test(key)) {
          url.searchParams.set(key, '[REDACTED]');
        }
      }
      return url.href.slice(0, 2048);
    } catch (_) {
      return null;
    }
  };
  const inferredRole = (node) => {
    const explicit = node.getAttribute('role');
    if (explicit) return explicit;
    const tag = node.tagName.toLowerCase();
    if (tag === 'a' && node.href) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'input') {
      const type = (node.type || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
      return 'textbox';
    }
    return null;
  };
  const accessibleName = (node) => {
    const labelledBy = (node.getAttribute('aria-labelledby') || '')
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .map((label) => label.innerText || label.textContent || '')
      .join(' ');
    const associatedLabel = node.labels && node.labels.length
      ? Array.from(node.labels).map((label) => label.innerText || '').join(' ')
      : '';
    return normalize(
      node.getAttribute('aria-label')
        || labelledBy
        || associatedLabel
        || node.innerText
        || node.placeholder
        || node.getAttribute('title')
        || node.name
        || node.id
        || node.tagName,
    );
  };
  const isSensitiveInput = (node) => {
    const attributes = [
      node.type,
      node.name,
      node.id,
      node.autocomplete,
      node.getAttribute('aria-label'),
      node.placeholder,
    ].join(' ');
    return /(password|token|secret|api.?key|auth|session|otp|one.?time)/i.test(attributes);
  };
  const interesting = Array.from(document.querySelectorAll([
    'a[href]',
    'button',
    'input',
    'textarea',
    'select',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="textbox"]',
    '[role="combobox"]',
    '[contenteditable="true"]',
    '[tabindex]',
  ].join(',')))
    .filter(isRendered)
    .slice(0, 80);
  const refs = Object.create(null);
  const priorSlot = window.__ccemCurrentSnapshotSlot;
  if (typeof priorSlot === 'string' && priorSlot.startsWith('__ccemSnapshot_')) {
    try { delete window[priorSlot]; } catch (_) {}
  }
  const snapshotSlot = `__ccemSnapshot_${snapshotId}`;
  window[snapshotSlot] = refs;
  window.__ccemCurrentSnapshotSlot = snapshotSlot;
  window.__ccemCurrentSnapshotId = snapshotId;
  const items = interesting.map((node, index) => {
    const ref = index + 1;
    refs[ref] = node;
    const rect = node.getBoundingClientRect();
    const disabled = Boolean(node.disabled) || node.getAttribute('aria-disabled') === 'true';
    const editable = !disabled && !node.readOnly && (
      node.isContentEditable
      || node.tagName === 'TEXTAREA'
      || node.tagName === 'SELECT'
      || (node.tagName === 'INPUT' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'hidden'].includes((node.type || '').toLowerCase()))
    );
    const focusable = !disabled && (
      node.tabIndex >= 0
      || node.isContentEditable
      || ['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName)
    );
    const rawValue = 'value' in node ? String(node.value || '') : '';
    const valueRedacted = Boolean(rawValue) && isSensitiveInput(node);
    const name = accessibleName(node);
    return {
      ref,
      element_id: `${snapshotId}:${ref}`,
      tag: node.tagName.toLowerCase(),
      role: inferredRole(node),
      type: node.getAttribute('type') || null,
      name,
      label: name,
      href: safeUrl(node.href),
      disabled,
      hidden: false,
      focusable,
      editable,
      readonly: Boolean(node.readOnly),
      checked: typeof node.checked === 'boolean' ? node.checked : null,
      value: valueRedacted ? '[REDACTED]' : normalize(rawValue),
      value_redacted: valueRedacted,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  });
  const blockSelector = 'h1,h2,h3,h4,h5,h6,p,li,pre,code,label,legend,td,th,dt,dd,blockquote';
  const textBlocks = Array.from(document.querySelectorAll(blockSelector))
    .filter(isRendered)
    .map((node) => ({ tag: node.tagName.toLowerCase(), text: normalize(node.innerText, 500) }))
    .filter((block) => block.text)
    .slice(0, 200);
  const hiddenCandidatesAll = document.body ? Array.from(document.body.querySelectorAll('*')) : [];
  const hiddenCandidates = hiddenCandidatesAll.slice(0, 2000);
  const hiddenTextCount = hiddenCandidates.reduce((count, node) => {
    const ownText = Array.from(node.childNodes)
      .filter((child) => child.nodeType === Node.TEXT_NODE)
      .map((child) => child.textContent || '')
      .join(' ')
      .trim();
    return count + (ownText && !isRendered(node) ? 1 : 0);
  }, 0);
  const text = (document.body && document.body.innerText || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
  return {
    ok: true,
    url: location.href,
    title: document.title,
    text,
    text_blocks: textBlocks,
    hidden_text_count: hiddenTextCount,
    hidden_text_scan_truncated: hiddenCandidatesAll.length > hiddenCandidates.length,
    elements: items,
  };
})()
"#;
