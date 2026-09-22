use super::*;

// Deliberately not Serialize: callers must build a public view without cipher.
#[derive(Clone, Debug)]
pub struct ConnectionRecord {
    pub account_ref: String,
    pub platform: String,
    pub label: String,
    pub cipher: String,
    pub configured_fields: Vec<String>,
    pub enabled: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(account: &str, platform: &str) -> Source {
        Source {
            account_ref: account.into(),
            platform: platform.into(),
            profile: "profile".into(),
            transport_profile: "transport".into(),
            user_id: "same-user".into(),
            chat_id: "same-chat".into(),
            thread_id: None,
            chat_type: "dm".into(),
        }
    }

    fn seed_legacy(store: &Store) {
        store
            .db
            .execute("DELETE FROM settings WHERE id='connectionsMigratedV1'", [])
            .unwrap();
        for (key, value) in [
            ("accountRef", "legacy-account"),
            ("platform", "wecom"),
            ("channelSecrets", "unchanged-encrypted-credentials"),
            ("configuredFields", "[\"WECOM_BOT_ID\",\"WECOM_SECRET\"]"),
            ("enabled", "true"),
        ] {
            store.set_setting(key, value).unwrap();
        }
    }

    #[test]
    fn legacy_migration_retains_identity_cipher_and_route_and_never_resurrects_removed_account() {
        let root = tempfile::tempdir().unwrap();
        let mut store = Store::open(root.path()).unwrap();
        seed_legacy(&store);
        let source = source("legacy-account", "wecom");
        let route = store
            .approve_route(
                source.clone(),
                vec![root.path().to_string_lossy().into()],
                true,
                true,
            )
            .unwrap();
        drop(store);
        let mut store = Store::open(root.path()).unwrap();
        let connections = store.connections().unwrap();
        assert_eq!(connections.len(), 1);
        assert_eq!(connections[0].account_ref, "legacy-account");
        assert_eq!(connections[0].cipher, "unchanged-encrypted-credentials");
        assert!(connections[0].enabled);
        assert_eq!(
            connections[0].configured_fields,
            ["WECOM_BOT_ID", "WECOM_SECRET"]
        );
        assert_eq!(
            json!(store.route_for_account("legacy-account", &source).unwrap()),
            json!(route)
        );
        assert!(store.setting("channelSecrets").unwrap().is_none());
        store.remove_connection("legacy-account").unwrap();
        drop(store);
        let store = Store::open(root.path()).unwrap();
        assert!(store.connections().unwrap().is_empty());
        assert!(!store.routes().unwrap()[0].enabled);
    }

    #[test]
    fn failed_legacy_migration_keeps_original_config_for_retry() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(root.path()).unwrap();
        seed_legacy(&store);
        store.db.execute_batch("CREATE TRIGGER fail_migration BEFORE INSERT ON connections BEGIN SELECT RAISE(ABORT,'injected migration failure'); END;").unwrap();
        drop(store);
        assert!(Store::open(root.path())
            .err()
            .unwrap()
            .contains("injected migration failure"));
        let db = Connection::open(root.path().join("bridge.sqlite3")).unwrap();
        let cipher: String = db
            .query_row(
                "SELECT data FROM settings WHERE id='channelSecrets'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cipher, "unchanged-encrypted-credentials");
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM settings WHERE id='connectionsMigratedV1'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        db.execute_batch("DROP TRIGGER fail_migration").unwrap();
        drop(db);
        assert_eq!(
            Store::open(root.path())
                .unwrap()
                .connections()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn add_edit_stop_resume_and_remove_are_scoped_to_one_connection() {
        let root = tempfile::tempdir().unwrap();
        let mut store = Store::open(root.path()).unwrap();
        let fields = ["TOKEN".into()];
        let a = store
            .save_connection(None, "test", Some("A"), "cipher-A", &fields, true)
            .unwrap();
        let source_a = source(&a.account_ref, "test");
        let route_a = store
            .approve_route(
                source_a.clone(),
                vec![root.path().to_string_lossy().into()],
                true,
                true,
            )
            .unwrap();
        let pending_a = store
            .prepare(&route_a, "input", "runtime", "continue A")
            .unwrap();
        let delivery_a =
            super::super::super::make_delivery(&route_a, "complete", "A completed".into());
        store
            .enqueue_page("seed-delivery", 1, &[delivery_a.clone()])
            .unwrap();

        // This is the same insert path used by QR and manual onboarding.
        let b = store
            .save_connection(None, "test", Some("B"), "cipher-B", &fields, true)
            .unwrap();
        assert_ne!(a.account_ref, b.account_ref);
        assert!(store.route_for_account(&a.account_ref, &source_a).is_ok());
        let source_b = source(&b.account_ref, "test");
        let route_b = store
            .approve_route(
                source_b.clone(),
                vec![root.path().to_string_lossy().into()],
                true,
                true,
            )
            .unwrap();
        let pending_b = store
            .prepare(&route_b, "input", "runtime", "continue B")
            .unwrap();
        assert!(
            store.route_for_account(&a.account_ref, &source_b).is_err(),
            "a token cannot claim b's source"
        );
        let renamed = store
            .save_connection(
                Some(&a.account_ref),
                "test",
                Some("Renamed A"),
                &a.cipher,
                &fields,
                false,
            )
            .unwrap();
        assert_eq!(renamed.account_ref, a.account_ref);
        assert_eq!(renamed.label, "Renamed A");
        assert_eq!(json!(store.route(&source_a).unwrap()), json!(route_a));

        store.set_connection_enabled(&a.account_ref, false).unwrap();
        assert!(store.route_for_account(&a.account_ref, &source_a).is_err());
        assert!(store.route_for_account(&b.account_ref, &source_b).is_ok());
        assert!(
            store.route(&source_a).unwrap().enabled,
            "stop preserves authorization"
        );
        assert_eq!(
            store.delivery(&delivery_a.id).unwrap().unwrap().status,
            "pending"
        );
        store.set_connection_enabled(&a.account_ref, true).unwrap();
        assert!(store.route_for_account(&a.account_ref, &source_a).is_ok());

        store
            .save_connection(
                Some(&a.account_ref),
                "test",
                None,
                "rotated-A",
                &fields,
                true,
            )
            .unwrap();
        assert!(store.route_for_account(&a.account_ref, &source_a).is_err());
        assert_eq!(
            store.delivery(&delivery_a.id).unwrap().unwrap().status,
            "revoked"
        );
        assert!(store
            .confirm(
                &route_a,
                "confirm",
                pending_a["challenge"].as_str().unwrap(),
                "runtime"
            )
            .is_err());
        assert!(
            store
                .confirm(
                    &route_b,
                    "confirm",
                    pending_b["challenge"].as_str().unwrap(),
                    "runtime"
                )
                .unwrap()
                .1
        );
        store.remove_connection(&a.account_ref).unwrap();
        assert_eq!(store.connections().unwrap().len(), 1);
        assert!(store.route_for_account(&b.account_ref, &source_b).is_ok());
        assert_eq!(store.connection(&b.account_ref).unwrap().cipher, "cipher-B");
        assert!(store.connection(&a.account_ref).is_err());
    }

    #[test]
    fn public_connection_view_never_contains_cipher_or_field_values() {
        let record = ConnectionRecord {
            account_ref: "account".into(),
            platform: "wecom".into(),
            label: "Bot".into(),
            cipher: "private-ciphertext-value".into(),
            configured_fields: vec!["WECOM_SECRET".into()],
            enabled: true,
        };
        let public = record.public_status();
        assert_eq!(public["configuredFields"], json!(["WECOM_SECRET"]));
        assert!(public.get("cipher").is_none());
        assert!(!public.to_string().contains("private-ciphertext-value"));
    }
}

impl ConnectionRecord {
    pub fn public_status(&self) -> Value {
        json!({"accountRef":self.account_ref,"platform":self.platform,"label":self.label,
            "configuredFields":self.configured_fields,"enabled":self.enabled,
            "state":"stopped","pending":[],"pairing":null})
    }
}

fn read_connection(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConnectionRecord> {
    let raw: String = row.get(4)?;
    let configured_fields = serde_json::from_str(&raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(ConnectionRecord {
        account_ref: row.get(0)?,
        platform: row.get(1)?,
        label: row.get(2)?,
        cipher: row.get(3)?,
        configured_fields,
        enabled: row.get(5)?,
    })
}

fn revoke_account(
    tx: &rusqlite::Transaction<'_>,
    routes: Vec<Route>,
    account: &str,
) -> Result<(), String> {
    for mut route in routes
        .into_iter()
        .filter(|r| r.source.account_ref == account && r.enabled)
    {
        route.enabled = false;
        route.generation += 1;
        tx.execute(
            "UPDATE routes SET data=?1 WHERE id=?2",
            params![serde_json::to_string(&route).map_err(err)?, route.id],
        )
        .map_err(err)?;
        tx.execute(
            "UPDATE challenges SET state='revoked' WHERE route_id=?1 AND state='pending'",
            [&route.id],
        )
        .map_err(err)?;
        tx.execute("UPDATE outbox SET data=json_set(data,'$.status','revoked') WHERE route_id=?1 AND json_extract(data,'$.status')='pending'", [&route.id]).map_err(err)?;
    }
    Ok(())
}

impl Store {
    pub(super) fn migrate_connections(&mut self) -> Result<(), String> {
        if self.setting("connectionsMigratedV1")?.is_some() {
            return Ok(());
        }
        let platform = self.setting("platform")?;
        let cipher = self.setting("channelSecrets")?;
        let account = self.setting("accountRef")?;
        let configured_fields = self.setting("configuredFields")?.unwrap_or("[]".into());
        let enabled = self.setting("enabled")?.as_deref() == Some("true");
        // An incomplete legacy config is never silently converted into a new identity.
        if platform.is_some() != cipher.is_some() || (platform.is_some() && account.is_none()) {
            return Err("legacy_connection_incomplete".into());
        }
        serde_json::from_str::<Vec<String>>(&configured_fields)
            .map_err(|_| "legacy_connection_incomplete")?;
        let tx = self.db.transaction().map_err(err)?;
        if let (Some(platform), Some(cipher), Some(account)) = (platform, cipher, account) {
            tx.execute(
                "INSERT INTO connections VALUES(?1,?2,?2,?3,?4,?5)",
                params![account, platform, cipher, configured_fields, enabled],
            )
            .map_err(err)?;
        }
        tx.execute("DELETE FROM settings WHERE id IN ('accountRef','platform','channelSecrets','configuredFields','enabled')", []).map_err(err)?;
        tx.execute(
            "INSERT INTO settings VALUES('connectionsMigratedV1','true')",
            [],
        )
        .map_err(err)?;
        tx.commit().map_err(err)
    }

    pub fn connections(&self) -> Result<Vec<ConnectionRecord>, String> {
        let mut statement = self.db.prepare("SELECT account_ref,platform,label,cipher,configured_fields,enabled FROM connections ORDER BY rowid").map_err(err)?;
        let rows = statement.query_map([], read_connection).map_err(err)?;
        rows.map(|row| row.map_err(err)).collect()
    }

    pub fn connection(&self, account: &str) -> Result<ConnectionRecord, String> {
        self.db.query_row("SELECT account_ref,platform,label,cipher,configured_fields,enabled FROM connections WHERE account_ref=?1", [account], read_connection)
            .optional().map_err(err)?.ok_or_else(|| "connection_not_found".into())
    }

    pub fn route_for_account(&self, account: &str, source: &Source) -> Result<Route, String> {
        let connection = self.connection(account)?;
        if account != source.account_ref
            || connection.platform != source.platform
            || !connection.enabled
        {
            return Err("account_not_authorized".into());
        }
        self.route(source)
    }

    pub fn save_connection(
        &mut self,
        account: Option<&str>,
        platform: &str,
        label: Option<&str>,
        cipher: &str,
        fields: &[String],
        credentials_changed: bool,
    ) -> Result<ConnectionRecord, String> {
        let existing = account.map(|id| self.connection(id)).transpose()?;
        if existing
            .as_ref()
            .is_some_and(|old| old.platform != platform)
        {
            return Err("connection_platform_immutable".into());
        }
        let account = existing
            .as_ref()
            .map(|old| old.account_ref.clone())
            .unwrap_or_else(random_id);
        let label = label
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .or_else(|| existing.as_ref().map(|old| old.label.clone()))
            .unwrap_or_else(|| platform.into());
        if label.len() > 120 || label.chars().any(char::is_control) {
            return Err("invalid_connection_label".into());
        }
        let enabled = existing.as_ref().map_or(true, |old| old.enabled);
        let routes = self.routes()?;
        let tx = self.db.transaction().map_err(err)?;
        if existing.is_some() && credentials_changed {
            revoke_account(&tx, routes, &account)?;
        }
        tx.execute("INSERT INTO connections VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(account_ref) DO UPDATE SET label=excluded.label,cipher=excluded.cipher,configured_fields=excluded.configured_fields",
            params![account, platform, label, cipher, json!(fields).to_string(), enabled]).map_err(err)?;
        tx.commit().map_err(err)?;
        self.connection(&account)
    }

    pub fn set_connection_enabled(&self, account: &str, enabled: bool) -> Result<(), String> {
        let changed = self
            .db
            .execute(
                "UPDATE connections SET enabled=?2 WHERE account_ref=?1",
                params![account, enabled],
            )
            .map_err(err)?;
        if changed != 1 {
            return Err("connection_not_found".into());
        }
        Ok(())
    }

    pub fn remove_connection(&mut self, account: &str) -> Result<(), String> {
        self.connection(account)?;
        let routes = self.routes()?;
        let tx = self.db.transaction().map_err(err)?;
        revoke_account(&tx, routes, account)?;
        tx.execute("DELETE FROM connections WHERE account_ref=?1", [account])
            .map_err(err)?;
        tx.commit().map_err(err)
    }
}
