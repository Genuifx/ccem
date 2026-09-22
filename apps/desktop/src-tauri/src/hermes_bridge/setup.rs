//! QR creation returns bot credentials, never a trusted chat user's identity.
use super::*;
use serde::Serialize;
use std::time::Instant;

const WAIT_MS: i64 = 300_000;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Setup {
    id: String,
    platform: String,
    state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    qr_payload: Option<String>,
    expires_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl Setup {
    fn new(platform: &str, at: i64) -> Self {
        Self {
            id: random_id(),
            platform: platform.into(),
            state: "generating".into(),
            qr_payload: None,
            expires_at: at + WAIT_MS,
            error: None,
        }
    }
    fn active(&self, id: &str) -> bool {
        self.id == id && matches!(self.state.as_str(), "generating" | "waiting" | "connecting")
    }
    fn expire(&mut self, at: i64) {
        if matches!(self.state.as_str(), "generating" | "waiting") && at >= self.expires_at {
            self.finish("expired", None);
        }
    }
    fn finish(&mut self, state: &str, error: Option<&str>) {
        self.state = state.into();
        self.qr_payload = None;
        self.error = error.map(str::to_owned);
    }
    fn accept_qr(&mut self, id: &str, reply: &Value, at: i64) -> Result<bool, String> {
        self.expire(at);
        if !self.active(id) || self.state != "generating" {
            return Ok(false);
        }
        let payload = reply["qrPayload"]
            .as_str()
            .ok_or("setup_invalid_response")?;
        let url = reqwest::Url::parse(payload).map_err(|_| "setup_invalid_response")?;
        if reply["id"] != id
            || reply["state"] != "waiting"
            || payload.len() > 4096
            || url.scheme() != "https"
            || url.host_str() != Some("work.weixin.qq.com")
            || url.path() != "/ai/qc/c"
            || url.port().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err("setup_invalid_response".into());
        }
        self.expires_at = self.expires_at.min(
            reply["expiresAt"]
                .as_i64()
                .ok_or("setup_invalid_response")?,
        );
        self.qr_payload = Some(payload.into());
        self.state = "waiting".into();
        self.expire(at);
        Ok(self.active(id))
    }
}

// Never let a malformed success reuse one credential from an old bot.
fn complete_credentials(
    id: &str,
    platform: &str,
    reply: &Value,
) -> Result<serde_json::Map<String, Value>, String> {
    if platform != "wecom"
        || reply["id"] != id
        || reply["platform"] != platform
        || reply["state"] != "ready"
    {
        return Err("setup_invalid_response".into());
    }
    let fields = reply["fields"]
        .as_object()
        .ok_or("setup_invalid_credentials")?;
    if fields.len() != 2 {
        return Err("setup_invalid_credentials".into());
    }
    for key in ["WECOM_BOT_ID", "WECOM_SECRET"] {
        let value = fields
            .get(key)
            .and_then(Value::as_str)
            .ok_or("setup_invalid_credentials")?;
        if value.trim().is_empty() || value.len() > 4096 || value.chars().any(char::is_control) {
            return Err("setup_invalid_credentials".into());
        }
    }
    Ok(fields.clone())
}

fn public_error(error: &str) -> &'static str {
    match error {
        "setup_expired" => "setup_expired",
        "setup_invalid_credentials" => "setup_invalid_credentials",
        "setup_invalid_response" => "setup_invalid_response",
        "setup_connection_failed" => "setup_connection_failed",
        "setup_pairing_failed" => "setup_pairing_failed",
        "setup_not_supported" | "unknown_host_method" => "setup_not_supported",
        _ => "setup_request_failed",
    }
}

fn setup_current(setup: &Mutex<Option<Setup>>, shutdown: &AtomicBool, id: &str) -> bool {
    if shutdown.load(Ordering::Acquire) {
        return false;
    }
    setup.lock().unwrap().as_mut().is_some_and(|s| {
        s.expire(now());
        s.active(id)
    })
}

fn finish_pairing(
    lifecycle: &Mutex<()>,
    setup: &Mutex<Option<Setup>>,
    shutdown: &AtomicBool,
    id: &str,
    process: &Arc<GatewayProcess>,
    current_host: impl FnOnce() -> Result<Arc<GatewayProcess>, String>,
) -> Result<(), String> {
    if !setup_current(setup, shutdown, id) {
        return Ok(());
    }
    process
        .request("openPairing", json!({}))
        .map_err(|_| "setup_pairing_failed")?;
    // Keep slow host I/O outside the policy lock so stop can reap it. A
    // replacement cannot complete this session, even after a successful reply.
    let _lifecycle = lifecycle.lock().map_err(|_| "bridge_lock_poisoned")?;
    if !setup_current(setup, shutdown, id) {
        return Ok(());
    }
    if !Arc::ptr_eq(process, &current_host()?) {
        return Err("setup_connection_failed".into());
    }
    setup
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .finish("connected", None);
    Ok(())
}

impl HermesBridgeManager {
    pub(super) fn setup_snapshot(&self) -> Value {
        let mut current = self.setup.lock().unwrap();
        if let Some(setup) = current.as_mut() {
            setup.expire(now());
        }
        json!(*current)
    }
    fn setup_current(&self, id: &str) -> bool {
        setup_current(&self.setup, &self.shutdown, id)
    }
    pub(super) fn invalidate_setup_locked(&self) {
        let mut current = self.setup.lock().unwrap();
        if let Some(setup) = current.as_mut() {
            if setup.active(&setup.id) {
                setup.finish("cancelled", None);
            }
        }
    }
    pub(super) fn cancel_setup_locked(&self, id: &str) -> Result<(), String> {
        let mut current = self.setup.lock().unwrap();
        let Some(setup) = current.as_mut().filter(|s| s.id == id) else {
            return Ok(());
        };
        if setup.state == "connecting" {
            return Err("setup_already_connecting".into());
        }
        if setup.active(id) {
            setup.finish("cancelled", None);
        }
        // The worker owns any outstanding request; a local invalidation wins even
        // if the platform creates the bot before that request returns.
        Ok(())
    }
    pub(super) fn begin_setup_locked(
        self: &Arc<Self>,
        app: &AppHandle,
        platform: &str,
    ) -> Result<(), String> {
        if self.install_requested.load(Ordering::Acquire) {
            return Err("installation_already_running".into());
        }
        if self
            .setup
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|s| s.state == "connecting")
        {
            return Err("setup_already_connecting".into());
        }
        // Bound workers even if callers repeatedly refresh while the network stalls.
        if self.setup_workers.load(Ordering::Acquire) >= 2 {
            return Err("setup_busy_retry".into());
        }
        let host = self.host_process()?;
        let snapshot = host.snapshot();
        if platform != "wecom"
            || !snapshot["platforms"].as_array().is_some_and(|ps| {
                ps.iter().any(|p| {
                    p["id"] == platform
                        && p["available"] == true
                        && p["strictSend"] == true
                        && p["qrSetup"] == true
                })
            })
        {
            return Err("setup_not_supported".into());
        }
        let setup = Setup::new(platform, now());
        let id = setup.id.clone();
        let platform = platform.to_string();
        *self.setup.lock().unwrap() = Some(setup);
        self.setup_workers.fetch_add(1, Ordering::AcqRel);
        let manager = self.clone();
        let app = app.clone();
        thread::spawn(move || {
            if let Err(error) = manager.run_setup(&app, &host, &id, &platform) {
                let mut current = manager.setup.lock().unwrap();
                if let Some(s) = current.as_mut().filter(|s| s.active(&id)) {
                    s.finish(
                        if error == "setup_expired" {
                            "expired"
                        } else {
                            "error"
                        },
                        Some(public_error(&error)),
                    );
                }
            }
            let _ = host.request("cancelSetup", json!({"id":id}));
            manager.setup_workers.fetch_sub(1, Ordering::AcqRel);
        });
        Ok(())
    }
    fn run_setup(
        &self,
        app: &AppHandle,
        host: &Arc<GatewayProcess>,
        id: &str,
        platform: &str,
    ) -> Result<(), String> {
        let qr = host.request("beginSetup", json!({"id":id,"platform":platform}))?;
        {
            let mut current = self.setup.lock().unwrap();
            let Some(s) = current.as_mut().filter(|s| s.id == id) else {
                return Ok(());
            };
            if !s.accept_qr(id, &qr, now())? {
                return Ok(());
            }
        }
        while self.setup_current(id) {
            // Short local waits make cancellation/replacement release the worker promptly.
            for _ in 0..12 {
                if !self.setup_current(id) {
                    return Ok(());
                }
                thread::sleep(Duration::from_millis(250));
            }
            let reply = host.request("pollSetup", json!({"id":id}))?;
            if !self.setup_current(id) {
                return Ok(());
            }
            if reply["id"] != id {
                return Err("setup_invalid_response".into());
            }
            match reply["state"].as_str() {
                Some("waiting") => continue,
                Some("expired") => return Err("setup_expired".into()),
                Some("ready") => {}
                _ => return Err("setup_invalid_response".into()),
            }
            let fields = complete_credentials(id, platform, &reply)?;
            let cipher = crypto::encrypt(
                &serde_json::to_string(&fields).map_err(|_| "setup_invalid_credentials")?,
            )?;
            {
                let _lifecycle = self.lifecycle.lock().map_err(|_| "bridge_lock_poisoned")?;
                if !self.setup_current(id) {
                    return Ok(());
                }
                // Close the cancellation window before the single atomic credential replacement.
                self.setup
                    .lock()
                    .unwrap()
                    .as_mut()
                    .unwrap()
                    .finish("connecting", None);
                self.stop_locked();
                self.with_store(|s| {
                    s.replace_channel(
                        platform,
                        &cipher,
                        &fields.keys().cloned().collect::<Vec<_>>(),
                    )
                })?;
                self.start_locked(app, true)
                    .map_err(|_| "setup_connection_failed")?;
            }
            let deadline = Instant::now() + Duration::from_secs(60);
            while self.setup_current(id) && Instant::now() < deadline {
                let process = self.host_process().map_err(|_| "setup_connection_failed")?;
                match process.snapshot()["state"].as_str() {
                    Some("running") => {
                        return finish_pairing(
                            &self.lifecycle,
                            &self.setup,
                            &self.shutdown,
                            id,
                            &process,
                            || self.host_process(),
                        );
                    }
                    Some("error" | "stopped") => return Err("setup_connection_failed".into()),
                    _ => thread::sleep(Duration::from_millis(250)),
                }
            }
            if !self.setup_current(id) {
                return Ok(());
            }
            return Err("setup_connection_failed".into());
        }
        Ok(())
    }
}

#[cfg(all(test, unix))]
#[path = "setup_worker_tests.rs"]
mod worker_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn qr(id: &str, expires: i64) -> Value {
        json!({"id":id,"state":"waiting","qrPayload":"https://work.weixin.qq.com/ai/qc/c?s=scan-token","expiresAt":expires})
    }
    #[test]
    fn cancelled_replaced_and_expired_results_cannot_advance_setup() {
        let mut s = Setup::new("wecom", 100);
        let id = s.id.clone();
        s.finish("cancelled", None);
        assert!(!s.accept_qr(&id, &qr(&id, 300100), 101).unwrap());
        let mut replacement = Setup::new("wecom", 200);
        assert!(!replacement.accept_qr(&id, &qr(&id, 300100), 201).unwrap());
        let fresh = replacement.id.clone();
        assert!(!replacement
            .accept_qr(&fresh, &qr(&fresh, 400000), 300200)
            .unwrap());
        assert_eq!(replacement.state, "expired");
        assert!(replacement.qr_payload.is_none());
    }
    #[test]
    fn only_official_qr_payload_is_rendered_with_bounded_wait() {
        let mut s = Setup::new("wecom", 100);
        let id = s.id.clone();
        let mut reply = qr(&id, 99999999);
        reply["qrPayload"] = json!("https://work.weixin.qq.com.evil.test/ai/qc/c?s=x");
        assert!(s.accept_qr(&id, &reply, 101).is_err());
        assert!(s.accept_qr(&id, &qr(&id, 99999999), 101).unwrap());
        assert_eq!(s.expires_at, 300100);
        s.finish("connecting", None);
        s.expire(900000);
        assert!(s.active(&id));
        assert!(s.qr_payload.is_none());
    }
    #[test]
    fn complete_bot_credentials_are_required_and_never_serialized_in_status() {
        let reply = json!({"id":"one","state":"ready","platform":"wecom","fields":{"WECOM_BOT_ID":"bot","WECOM_SECRET":"private-test-secret"}});
        assert!(complete_credentials("one", "wecom", &reply).is_ok());
        assert!(complete_credentials("other", "wecom", &reply).is_err());
        let mut partial = reply.clone();
        partial["fields"]
            .as_object_mut()
            .unwrap()
            .remove("WECOM_SECRET");
        assert!(complete_credentials("one", "wecom", &partial).is_err());
        assert!(!json!(Setup::new("wecom", 1))
            .to_string()
            .contains("private-test-secret"));
        assert_eq!(
            public_error("request failed?secret=private-test-secret"),
            "setup_request_failed"
        );
    }
}
