use super::*;
use base64::Engine;

fn identity_fields(platform: &str, meta: &Value) -> Vec<String> {
    if let Some(fields) = meta["identityFields"].as_array() {
        let fields: Vec<_> = fields
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        if !fields.is_empty() {
            return fields;
        }
    }
    // Older installed hosts lack this metadata. These names are identity hints,
    // not a second channel registry or an SDK dependency.
    match platform {
        "wecom" => vec!["WECOM_BOT_ID".into()],
        "telegram" => vec!["TELEGRAM_BOT_TOKEN".into()],
        "feishu" => vec!["FEISHU_APP_ID".into()],
        "discord" => vec!["DISCORD_BOT_TOKEN".into()],
        "slack" => vec!["SLACK_BOT_TOKEN".into()],
        _ => vec![],
    }
}

fn normalized_identity(key: &str, value: &str) -> String {
    let value = value.trim();
    if key == "TELEGRAM_BOT_TOKEN" {
        if let Some((id, _)) = value.split_once(':') {
            if !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()) {
                return id.into();
            }
        }
    } else if key == "DISCORD_BOT_TOKEN" {
        if let Some(first) = value.split('.').next() {
            if let Ok(decoded) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(first) {
                if (15..=25).contains(&decoded.len()) && decoded.iter().all(u8::is_ascii_digit) {
                    return String::from_utf8(decoded).expect("ASCII identity");
                }
            }
        }
    } else if key == "SLACK_BOT_TOKEN" {
        let parts: Vec<_> = value.split('-').collect();
        if parts.len() >= 4
            && parts[0] == "xoxb"
            && parts[1..3]
                .iter()
                .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        {
            return format!("xoxb-{}-{}", parts[1], parts[2]);
        }
    }
    value.into()
}

fn same_identity(
    fields: &[String],
    left: &serde_json::Map<String, Value>,
    right: &serde_json::Map<String, Value>,
) -> bool {
    !fields.is_empty()
        && fields.iter().all(|key| {
            match (
                left.get(key).and_then(Value::as_str),
                right.get(key).and_then(Value::as_str),
            ) {
                (Some(a), Some(b)) if !a.trim().is_empty() && !b.trim().is_empty() => {
                    normalized_identity(key, a) == normalized_identity(key, b)
                }
                _ => false,
            }
        })
}

impl HermesBridgeManager {
    pub(super) fn ensure_unique_connection_locked(
        &self,
        platform: &str,
        fields: &serde_json::Map<String, Value>,
        except: Option<&str>,
        meta: &Value,
    ) -> Result<(), String> {
        let identity = identity_fields(platform, meta);
        for connection in self
            .with_store(|s| s.connections())?
            .into_iter()
            .filter(|c| c.platform == platform && Some(c.account_ref.as_str()) != except)
        {
            if same_identity(&identity, fields, &decode_fields(&connection.cipher)?) {
                return Err("connection_already_configured".into());
            }
        }
        Ok(())
    }

    pub(super) fn configure_channel_locked(
        self: &Arc<Self>,
        app: &AppHandle,
        payload: &Value,
    ) -> Result<(), String> {
        let platform = payload["platform"].as_str().ok_or("platform_required")?;
        let fields = payload["fields"].as_object().ok_or("fields_required")?;
        let account = payload
            .get("accountRef")
            .map(|v| {
                v.as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or("account_ref_required")
            })
            .transpose()?;
        let label = payload
            .get("label")
            .map(|v| v.as_str().ok_or("invalid_connection_label"))
            .transpose()?;
        let snapshot = self.host_process()?.snapshot();
        let meta = snapshot["platforms"]
            .as_array()
            .and_then(|ps| ps.iter().find(|p| p["id"] == platform))
            .ok_or("platform_not_supported")?;
        if meta["available"] != true || meta["strictSend"] != true {
            return Err("platform_not_available".into());
        }
        let schema = meta["fields"].as_array().ok_or("platform_schema_missing")?;
        let existing = account
            .map(|a| self.with_store(|s| s.connection(a)))
            .transpose()?;
        if existing.as_ref().is_some_and(|c| c.platform != platform) {
            return Err("connection_platform_immutable".into());
        }
        let old_fields = existing
            .as_ref()
            .map(|c| decode_fields(&c.cipher))
            .transpose()?
            .unwrap_or_default();
        let mut merged = old_fields.clone();
        for (key, value) in fields {
            if !schema.iter().any(|s| s["key"] == *key) {
                return Err("unknown_channel_field".into());
            }
            let value = value.as_str().ok_or("invalid_channel_field")?.trim();
            if value.len() > 4096 || value.chars().any(char::is_control) {
                return Err("invalid_channel_field".into());
            }
            if key == "FEISHU_DOMAIN" && !value.is_empty() && !matches!(value, "feishu" | "lark") {
                return Err("invalid_channel_field".into());
            }
            if !value.is_empty() {
                merged.insert(key.clone(), json!(value));
            }
        }
        for field in schema.iter().filter(|f| f["required"] == true) {
            if merged
                .get(field["key"].as_str().unwrap_or(""))
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
            {
                return Err("required_channel_field_missing".into());
            }
        }
        self.ensure_unique_connection_locked(platform, &merged, account, meta)?;
        let changed = existing.is_none() || merged != old_fields;
        let cipher = if changed {
            crypto::encrypt(&json!(merged).to_string())?
        } else {
            existing.as_ref().unwrap().cipher.clone()
        };
        let connection = self.with_store(|s| {
            s.save_connection(
                account,
                platform,
                label,
                &cipher,
                &merged.keys().cloned().collect::<Vec<_>>(),
                changed,
            )
        })?;
        if changed {
            self.invalidate_setup_for_account(&connection.account_ref);
            // Saving succeeds even when transport startup fails: the card retains
            // its credentials and a retryable error, without disrupting peers.
            if connection.enabled {
                let _ = self.start_connection_locked(app, &connection.account_ref);
            }
        }
        Ok(())
    }

    pub(super) fn pairing_action(
        &self,
        _app: &AppHandle,
        action: &str,
        payload: &Value,
    ) -> Result<Value, String> {
        let account = payload["accountRef"]
            .as_str()
            .ok_or("account_ref_required")?;
        let (request, workspaces) = if action == "approvePairing" {
            let id = payload["id"].as_str().ok_or("pairing_id_required")?;
            let workspaces: Vec<String> = serde_json::from_value(payload["workspaces"].clone())
                .map_err(|_| "workspace_scope_required")?;
            if workspaces.is_empty() {
                return Err("workspace_scope_required".into());
            }
            if workspaces.iter().any(|p| !std::path::Path::new(p).is_dir()) {
                return Err("workspace_not_found".into());
            }
            (json!({"id":id}), workspaces)
        } else {
            (json!({}), vec![])
        };
        let process = {
            let _guard = idle_lifecycle(&self.lifecycle, &self.install_requested)?;
            if !self.with_store(|s| s.connection(account))?.enabled {
                return Err("connection_stopped".into());
            }
            let process = self.connection_process(account)?;
            if process.snapshot()["state"] != "running" {
                return Err("gateway_not_running".into());
            }
            process
        };
        let reply = process.request(action, request)?;
        let _guard = idle_lifecycle(&self.lifecycle, &self.install_requested)?;
        let connection = self.with_store(|s| s.connection(account))?;
        if !connection.enabled
            || !self
                .connection_process(account)
                .is_ok_and(|p| Arc::ptr_eq(&p, &process))
        {
            return Err("pairing_authority_changed".into());
        }
        if action == "approvePairing" {
            let source: Source = serde_json::from_value(reply["source"].clone())
                .map_err(|_| "invalid_pairing_response")?;
            if source.account_ref != account || source.platform != connection.platform {
                return Err("invalid_pairing_response".into());
            }
            source.validate()?;
            let baselines: Vec<_> = self
                .native
                .list_sessions()
                .into_iter()
                .map(|s| (s.runtime_id, s.project_dir, s.last_event_seq.unwrap_or(0)))
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
        Ok(self.status())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fingerprints_reject_rotated_tokens_but_allow_distinct_bots() {
        for (platform, key, a, rotated, other) in [
            ("wecom", "WECOM_BOT_ID", "one", " one ", "two"),
            (
                "telegram",
                "TELEGRAM_BOT_TOKEN",
                "123:old",
                "123:new",
                "456:new",
            ),
            (
                "discord",
                "DISCORD_BOT_TOKEN",
                "MTIzNDU2Nzg5MDEyMzQ1Njc4.old.secret",
                "MTIzNDU2Nzg5MDEyMzQ1Njc4.new.secret",
                "MTIzNDU2Nzg5MDEyMzQ1Njc5.new.secret",
            ),
            (
                "slack",
                "SLACK_BOT_TOKEN",
                "xoxb-123-456-old",
                "xoxb-123-456-new",
                "xoxb-123-789-new",
            ),
            ("feishu", "FEISHU_APP_ID", "cli_one", "cli_one", "cli_two"),
        ] {
            let fields = identity_fields(platform, &json!({}));
            let map = |value| {
                serde_json::from_value::<serde_json::Map<String, Value>>(json!({key:value}))
                    .unwrap()
            };
            assert!(same_identity(&fields, &map(a), &map(rotated)), "{platform}");
            assert!(!same_identity(&fields, &map(a), &map(other)), "{platform}");
        }
    }
}
