//! QR creation returns bot credentials, never a trusted chat user's identity.
use super::*;
use serde::Serialize;
use std::time::Instant;

const WAIT_MS: i64 = 300_000;

#[derive(Default)]
pub(super) struct ConnectionWait {
    deadline: Option<Instant>,
}

impl ConnectionWait {
    pub(super) fn ready(
        &mut self,
        at: Instant,
        pending: bool,
        process_state: Option<&str>,
    ) -> Result<bool, String> {
        let Some(state) = process_state else {
            return if pending {
                Ok(false)
            } else {
                Err("setup_connection_failed".into())
            };
        };
        // Inventory verification may be queued behind other accounts. Only a
        // published process starts the bounded network handshake budget.
        let deadline = *self.deadline.get_or_insert(at + Duration::from_secs(60));
        if at >= deadline || matches!(state, "error" | "stopped") {
            return Err("setup_connection_failed".into());
        }
        Ok(state == "running")
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Setup {
    id: String,
    platform: String,
    state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    account_ref: Option<String>,
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
            account_ref: None,
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
            || !allowed_qr_url(&self.platform, &url)
            || url.port().is_some()
            || payload
                .strip_prefix("https://")
                .and_then(|p| p.split('/').next())
                .is_some_and(|authority| authority.contains(':'))
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

fn allowed_qr_url(platform: &str, url: &reqwest::Url) -> bool {
    match platform {
        "wecom" => url.host_str() == Some("work.weixin.qq.com") && url.path() == "/ai/qc/c",
        "feishu" => {
            let query: Vec<_> = url.query_pairs().collect();
            matches!(
                url.host_str(),
                Some("open.feishu.cn" | "open.larksuite.com")
            ) && url.path() == "/page/launcher"
                && query.iter().filter(|(key, _)| key == "user_code").count() == 1
                && query.iter().all(|(key, value)| match key.as_ref() {
                    "user_code" => {
                        !value.is_empty()
                            && value.len() <= 256
                            && value.trim() == value
                            && !value.chars().any(char::is_control)
                    }
                    "from" | "tp" => {
                        value == "hermes"
                            && query.iter().filter(|(other, _)| other == key).count() == 1
                    }
                    _ => false,
                })
        }
        "telegram" => {
            if url.host_str() != Some("t.me") {
                return false;
            }
            let query: Vec<_> = url.query_pairs().collect();
            if let Some(path) = url.path().strip_prefix("/newbot/") {
                let parts: Vec<_> = path.split('/').collect();
                return parts.len() == 2
                    && parts.iter().all(|part| {
                        (5..=32).contains(&part.len())
                            && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                    })
                    && (query.is_empty()
                        || (query.len() == 1
                            && query[0].0 == "name"
                            && query[0].1.len() <= 256
                            && !query[0].1.chars().any(char::is_control)));
            }
            // The official broker can also return a private manager-bot start
            // link. Its nonce grants setup continuation, never CCEM authority.
            let username = url.path().strip_prefix('/').unwrap_or("");
            (5..=32).contains(&username.len())
                && username.as_bytes()[0].is_ascii_alphabetic()
                && username
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_')
                && username.to_ascii_lowercase().ends_with("bot")
                && query.len() == 1
                && query[0].0 == "start"
                && (1..=64).contains(&query[0].1.len())
                && query[0]
                    .1
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        }
        _ => false,
    }
}

// Never let a malformed success reuse one credential from an old bot.
fn complete_credentials(
    id: &str,
    platform: &str,
    reply: &Value,
) -> Result<serde_json::Map<String, Value>, String> {
    if reply["id"] != id || reply["platform"] != platform || reply["state"] != "ready" {
        return Err("setup_invalid_response".into());
    }
    let fields = reply["fields"]
        .as_object()
        .ok_or("setup_invalid_credentials")?;
    let expected: &[&str] = match platform {
        "wecom" => &["WECOM_BOT_ID", "WECOM_SECRET"],
        "telegram" => &["TELEGRAM_BOT_TOKEN"],
        "feishu" => &["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_DOMAIN"],
        _ => return Err("setup_not_supported".into()),
    };
    if fields.len() != expected.len() {
        return Err("setup_invalid_credentials".into());
    }
    for key in expected {
        let value = fields
            .get(*key)
            .and_then(Value::as_str)
            .ok_or("setup_invalid_credentials")?;
        if value.trim().is_empty() || value.len() > 4096 || value.chars().any(char::is_control) {
            return Err("setup_invalid_credentials".into());
        }
    }
    if platform == "feishu" && !matches!(fields["FEISHU_DOMAIN"].as_str(), Some("feishu" | "lark"))
    {
        return Err("setup_invalid_credentials".into());
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
        "connection_already_configured" => "connection_already_configured",
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
    pub(super) fn setup_in_progress(&self) -> bool {
        self.setup.lock().unwrap().as_mut().is_some_and(|s| {
            s.expire(now());
            s.active(&s.id)
        })
    }
    pub(super) fn invalidate_setup_for_account(&self, account: &str) {
        let mut current = self.setup.lock().unwrap();
        if let Some(setup) = current
            .as_mut()
            .filter(|s| s.account_ref.as_deref() == Some(account))
        {
            if setup.active(&setup.id) {
                setup.finish("cancelled", None);
            }
        }
    }
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
        if self.startup.discovery_pending() || !host.alive() {
            return Err("gateway_not_running".into());
        }
        let snapshot = host.snapshot();
        if !["wecom", "telegram", "feishu"].contains(&platform)
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
        self: &Arc<Self>,
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
            let account = {
                let _lifecycle = self.lifecycle.lock().map_err(|_| "bridge_lock_poisoned")?;
                if !self.setup_current(id) {
                    return Ok(());
                }
                if !self
                    .host_process()
                    .is_ok_and(|current| Arc::ptr_eq(host, &current))
                {
                    return Err("setup_connection_failed".into());
                }
                let snapshot = host.snapshot();
                let meta = snapshot["platforms"]
                    .as_array()
                    .and_then(|ps| ps.iter().find(|p| p["id"] == platform))
                    .cloned()
                    .unwrap_or(json!({}));
                self.ensure_unique_connection_locked(platform, &fields, None, &meta)?;
                let connection = self.with_store(|s| {
                    s.save_connection(
                        None,
                        platform,
                        None,
                        &cipher,
                        &fields.keys().cloned().collect::<Vec<_>>(),
                        true,
                    )
                })?;
                // The credentials and new identity commit together; existing
                // connections and their authorizations remain untouched.
                {
                    let mut current = self.setup.lock().unwrap();
                    let setup = current.as_mut().unwrap();
                    setup.account_ref = Some(connection.account_ref.clone());
                    setup.finish("connecting", None);
                }
                self.start_connection_locked(app, &connection.account_ref)
                    .map_err(|_| "setup_connection_failed")?;
                connection.account_ref
            };
            let mut wait = ConnectionWait::default();
            while self.setup_current(id) {
                let (process, pending) = {
                    // Publishing a gateway also removes its pending marker.
                    // Read both atomically so that handoff cannot look failed.
                    let _guard = self.lifecycle.lock().map_err(|_| "bridge_lock_poisoned")?;
                    if !self.setup_current(id) {
                        return Ok(());
                    }
                    (
                        self.connection_process(&account).ok(),
                        self.startup.connection_pending(&account),
                    )
                };
                let snapshot = process.as_ref().map(|p| p.snapshot());
                if wait.ready(
                    Instant::now(),
                    pending,
                    snapshot.as_ref().and_then(|s| s["state"].as_str()),
                )? {
                    return finish_pairing(
                        &self.lifecycle,
                        &self.setup,
                        &self.shutdown,
                        id,
                        process.as_ref().unwrap(),
                        || self.connection_process(&account),
                    );
                }
                thread::sleep(Duration::from_millis(250));
            }
            return Ok(());
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
    fn feishu_qr_restricts_launcher_and_requires_complete_regional_credentials() {
        let mut setup = Setup::new("feishu", 100);
        let id = setup.id.clone();
        let reply = |url| json!({"id":id,"state":"waiting","qrPayload":url,"expiresAt":300100});
        for invalid in [
            "https://open.feishu.cn.evil.test/page/launcher?user_code=code",
            "http://open.feishu.cn/page/launcher?user_code=code",
            "https://open.feishu.cn:443/page/launcher?user_code=code",
            "https://user@open.feishu.cn/page/launcher?user_code=code",
            "https://open.feishu.cn/page/other?user_code=code",
            "https://open.feishu.cn/page/launcher?user_code=code#fragment",
            "https://open.feishu.cn/page/launcher?user_code=code&user_code=other",
            "https://open.feishu.cn/page/launcher?user_code=code&redirect_uri=https://evil.test",
            "https://open.feishu.cn/page/launcher?user_code=code&from=other",
            "https://open.feishu.cn/page/launcher?user_code=code&tp=hermes&tp=hermes",
            "https://open.feishu.cn/page/launcher?user_code=%0A",
            "https://open.feishu.cn/page/launcher?user_code=",
        ] {
            assert!(
                setup.accept_qr(&id, &reply(invalid), 101).is_err(),
                "{invalid}"
            );
        }
        assert!(setup
            .accept_qr(
                &id,
                &reply("https://open.feishu.cn/page/launcher?user_code=code&from=hermes&tp=hermes"),
                101
            )
            .unwrap());
        assert!(allowed_qr_url(
            "feishu",
            &reqwest::Url::parse("https://open.larksuite.com/page/launcher?user_code=code")
                .unwrap()
        ));
        let complete = json!({"id":id,"platform":"feishu","state":"ready","fields":{
            "FEISHU_APP_ID":"cli_synthetic","FEISHU_APP_SECRET":"private-app-secret","FEISHU_DOMAIN":"lark"},"open_id":"untrusted-owner"});
        assert!(complete_credentials(&id, "feishu", &complete).is_ok());
        for key in ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_DOMAIN"] {
            let mut partial = complete.clone();
            partial["fields"].as_object_mut().unwrap().remove(key);
            assert!(complete_credentials(&id, "feishu", &partial).is_err());
        }
        let mut invalid = complete.clone();
        invalid["fields"]["FEISHU_DOMAIN"] = json!("untrusted-domain");
        assert!(complete_credentials(&id, "feishu", &invalid).is_err());
        invalid = complete.clone();
        invalid["fields"]["open_id"] = json!("untrusted-owner");
        assert!(complete_credentials(&id, "feishu", &invalid).is_err());
        setup.finish("connected", None);
        assert!(!json!(setup).to_string().contains("private-app-secret"));
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

    #[test]
    fn telegram_qr_restricts_host_path_query_and_complete_credentials() {
        let valid = "https://t.me/newbot/HermesSetupBot/ExampleBot?name=Example";
        let mut setup = Setup::new("telegram", 100);
        let id = setup.id.clone();
        let reply = |url| json!({"id":id,"state":"waiting","qrPayload":url,"expiresAt":300100});
        for invalid in [
            "https://t.me.evil.test/newbot/HermesSetupBot/ExampleBot",
            "https://t.me/newbot/HermesSetupBot/ExampleBot/extra",
            "https://t.me/newbot/HermesSetupBot/ExampleBot?token=secret",
            "https://t.me/newbot/HermesSetupBot/ExampleBot?name=A&name=B",
            "https://t.me/newbot/HermesSetupBot/%45xampleBot",
            "https://t.me/newbot/HermesSetupBot/ExampleBot#secret",
            "https://t.me:443/newbot/HermesSetupBot/ExampleBot",
            "https://user@t.me/newbot/HermesSetupBot/ExampleBot",
            "http://t.me/newbot/HermesSetupBot/ExampleBot",
        ] {
            assert!(
                setup.accept_qr(&id, &reply(invalid), 101).is_err(),
                "{invalid}"
            );
        }
        assert!(setup.accept_qr(&id, &reply(valid), 101).unwrap());
        let complete = json!({"id":id,"platform":"telegram","state":"ready","fields":{"TELEGRAM_BOT_TOKEN":"123:private-token"}});
        assert!(complete_credentials(&id, "telegram", &complete).is_ok());
        let mut partial = complete.clone();
        partial["fields"] = json!({});
        assert!(complete_credentials(&id, "telegram", &partial).is_err());
        partial["fields"] = json!({"TELEGRAM_BOT_TOKEN":"123:private-token", "owner_user_id":"not-a-trusted-identity"});
        assert!(complete_credentials(&id, "telegram", &partial).is_err());
        setup.account_ref = Some("new-connection".into());
        setup.finish("connected", None);
        let public = json!(setup);
        assert_eq!(public["accountRef"], "new-connection");
        assert!(!public.to_string().contains("private-token"));
    }

    #[test]
    fn telegram_private_manager_start_link_accepts_only_the_official_broker_shape() {
        let mut setup = Setup::new("telegram", 100);
        let id = setup.id.clone();
        let reply = |url| json!({"id":id,"state":"waiting","qrPayload":url,"expiresAt":300100});
        for invalid in [
            "https://t.me/HermesSetupBot?startgroup=nonce",
            "https://t.me/HermesSetupBot?start=nonce&start=other",
            "https://t.me/HermesSetupBot?start=nonce&extra=x",
            "https://t.me/HermesSetupBot?start=",
            "https://t.me/HermesSetupBot?start=contains%20space",
            "https://t.me/HermesSetupBot?start=has.dot",
            "https://t.me/HermesSetupBot/path?start=nonce",
            "https://t.me/HermesSetup?start=nonce",
            "https://t.me/_HermesBot?start=nonce",
            "https://t.me/1HermesBot?start=nonce",
            "https://t.me/Abot?start=nonce",
            "https://t.me/%48ermesSetupBot?start=nonce",
            "https://t.me:443/HermesSetupBot?start=nonce",
            "https://user@t.me/HermesSetupBot?start=nonce",
            "https://t.me/HermesSetupBot?start=nonce#fragment",
            "https://t.me.evil.test/HermesSetupBot?start=nonce",
            "http://t.me/HermesSetupBot?start=nonce",
        ] {
            assert!(
                setup.accept_qr(&id, &reply(invalid), 101).is_err(),
                "{invalid}"
            );
        }
        let too_long = format!("https://t.me/HermesSetupBot?start={}", "a".repeat(65));
        assert!(setup.accept_qr(&id, &reply(&too_long), 101).is_err());
        assert!(setup
            .accept_qr(
                &id,
                &reply("https://t.me/Hermes_SetupBOT?start=valid_nonce-123"),
                101
            )
            .unwrap());
    }

    #[test]
    fn telegram_qr_credentials_add_an_account_without_replacing_an_authorized_wecom_bot() {
        let root = tempfile::tempdir().unwrap();
        let mut store = Store::open(root.path()).unwrap();
        let existing = store
            .save_connection(
                None,
                "wecom",
                None,
                "encrypted-wecom-pair",
                &["WECOM_BOT_ID".into(), "WECOM_SECRET".into()],
                true,
            )
            .unwrap();
        let source = Source {
            account_ref: existing.account_ref.clone(),
            platform: "wecom".into(),
            profile: "profile".into(),
            transport_profile: "transport".into(),
            user_id: "verified-user".into(),
            chat_id: "verified-dm".into(),
            thread_id: None,
            chat_type: "dm".into(),
        };
        let route = store
            .approve_route(
                source.clone(),
                vec![root.path().to_string_lossy().into()],
                true,
                true,
            )
            .unwrap();
        let reply = json!({"id":"new-qr","state":"ready","platform":"telegram","fields":{"TELEGRAM_BOT_TOKEN":"123:private-token"},"owner_user_id":"untrusted-qr-owner"});
        let fields = complete_credentials("new-qr", "telegram", &reply).unwrap();
        let added = store
            .save_connection(
                None,
                "telegram",
                None,
                "encrypted-complete-telegram-token",
                &fields.keys().cloned().collect::<Vec<_>>(),
                true,
            )
            .unwrap();
        assert_ne!(added.account_ref, existing.account_ref);
        assert_eq!(store.connections().unwrap().len(), 2);
        assert_eq!(
            store.connection(&existing.account_ref).unwrap().cipher,
            "encrypted-wecom-pair"
        );
        assert_eq!(
            json!(store
                .route_for_account(&existing.account_ref, &source)
                .unwrap()),
            json!(route)
        );
        assert_eq!(
            store.routes().unwrap().len(),
            1,
            "QR owner does not receive a route or bypass DM pairing"
        );
        assert_eq!(added.configured_fields, ["TELEGRAM_BOT_TOKEN"]);
    }
}
