use fs2::FileExt;
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

#[path = "connections.rs"]
mod connections;
pub use connections::ConnectionRecord;

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
pub fn random_id() -> String {
    let mut bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}
pub fn digest(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
fn err(e: impl std::fmt::Display) -> String {
    format!("ledger_error: {e}")
}

/// Identity is supplied only by the authenticated, private Hermes host.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub account_ref: String,
    pub platform: String,
    pub profile: String,
    pub transport_profile: String,
    pub user_id: String,
    pub chat_id: String,
    pub thread_id: Option<String>,
    pub chat_type: String,
}
impl Source {
    pub fn validate(&self) -> Result<(), String> {
        for field in [
            &self.account_ref,
            &self.platform,
            &self.profile,
            &self.transport_profile,
            &self.user_id,
            &self.chat_id,
            &self.chat_type,
        ] {
            if field.is_empty() || field.len() > 512 || field.chars().any(char::is_control) {
                return Err("invalid_source".into());
            }
        }
        if self
            .thread_id
            .as_ref()
            .is_some_and(|v| v.is_empty() || v.len() > 512 || v.chars().any(char::is_control))
        {
            return Err("invalid_source".into());
        }
        Ok(())
    }
    pub fn key(&self) -> String {
        digest(&serde_json::to_string(self).expect("source serializes"))
    }
    pub fn target(&self) -> Value {
        json!({"platform":self.platform,"profile":self.transport_profile,"chat_id":self.chat_id,"thread_id":self.thread_id})
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub id: String,
    pub generation: i64,
    pub source: Source,
    pub identity_ref: String,
    pub target_ref: String,
    pub workspaces: Vec<String>,
    pub allow_input: bool,
    pub notifications: bool,
    pub enabled: bool,
    pub created_at: i64,
}
impl Route {
    pub fn permits(&self, project: &str) -> bool {
        let Ok(project) = Path::new(project).canonicalize() else {
            return false;
        };
        self.enabled
            && self.workspaces.iter().any(|root| {
                Path::new(root)
                    .canonicalize()
                    .ok()
                    .is_some_and(|p| p == Path::new(root) && project.starts_with(p))
            })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub id: String,
    pub route_id: String,
    pub generation: i64,
    pub runtime_id: String,
    pub text: String,
    pub state: String,
    pub detail: String,
    pub invocation_id: Option<String>,
    #[serde(default)]
    pub ambiguous_invocation: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Delivery {
    #[serde(default)]
    pub cron: Option<crate::cron::CronDeliveryScope>,
    pub id: String,
    pub route_id: String,
    pub generation: i64,
    pub text: String,
    pub status: String,
    pub receipt: Option<Value>,
    pub created_at: i64,
}

struct StoreOwner(File);
impl Drop for StoreOwner {
    fn drop(&mut self) {
        // A concurrent fork can retain the open file description until exec,
        // even with CLOEXEC. Closing only our descriptor would retain the lock.
        let _ = FileExt::unlock(&self.0);
    }
}

pub struct Store {
    db: Connection,
    // Fields drop in declaration order: close SQLite before releasing ownership.
    _owner: StoreOwner,
}
impl Store {
    pub fn open(root: &Path) -> Result<Self, String> {
        fs::create_dir_all(root).map_err(err)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root, fs::Permissions::from_mode(0o700)).map_err(err)?;
        }
        let owner = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.join("bridge.lock"))
            .map_err(err)?;
        owner
            .try_lock_exclusive()
            .map_err(|_| "bridge_owned_by_another_process".to_string())?;
        let owner = StoreOwner(owner);
        let db = Connection::open(root.join("bridge.sqlite3")).map_err(err)?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS routes(id TEXT PRIMARY KEY, source_key TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY, route_id TEXT NOT NULL, generation INTEGER NOT NULL, runtime_id TEXT NOT NULL, text TEXT NOT NULL, input_message TEXT NOT NULL, expires INTEGER NOT NULL, state TEXT NOT NULL, operation_id TEXT);
            CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, hash TEXT NOT NULL, response TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, route_id TEXT NOT NULL, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, route_id TEXT NOT NULL, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS cursors(id TEXT PRIMARY KEY, seq INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS settings(id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS connections(account_ref TEXT PRIMARY KEY, platform TEXT NOT NULL, label TEXT NOT NULL, cipher TEXT NOT NULL, configured_fields TEXT NOT NULL, enabled INTEGER NOT NULL);").map_err(err)?;
        let mut store = Self { db, _owner: owner };
        store.migrate_connections()?;
        // A crash may have occurred after an external side effect. Never infer a safe retry.
        for mut op in store.operations()? {
            if ["submitting", "running"].contains(&op.state.as_str()) {
                op.state = "unknown".into();
                op.detail = "CCEM restarted before a verified terminal event".into();
                store.save_operation(&op)?;
            }
        }
        for mut d in store.deliveries()? {
            if d.status == "sending" {
                d.status = "unknown".into();
                store.save_delivery(&d)?;
            }
        }
        Ok(store)
    }
    pub fn setting(&self, key: &str) -> Result<Option<String>, String> {
        self.db
            .query_row("SELECT data FROM settings WHERE id=?1", [key], |r| r.get(0))
            .optional()
            .map_err(err)
    }
    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), String> {
        self.db.execute("INSERT INTO settings VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data", params![key,value]).map_err(err)?;
        Ok(())
    }
    fn list<T: serde::de::DeserializeOwned>(&self, sql: &str) -> Result<Vec<T>, String> {
        let mut query = self.db.prepare(sql).map_err(err)?;
        let rows = query
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(err)?;
        rows.map(|s| serde_json::from_str(&s.map_err(err)?).map_err(err))
            .collect()
    }
    pub fn routes(&self) -> Result<Vec<Route>, String> {
        self.list("SELECT data FROM routes ORDER BY rowid")
    }
    pub fn route(&self, source: &Source) -> Result<Route, String> {
        source.validate()?;
        let raw: Option<String> = self
            .db
            .query_row(
                "SELECT data FROM routes WHERE source_key=?1",
                [source.key()],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?;
        let route: Route = serde_json::from_str(&raw.ok_or("source_not_paired")?).map_err(err)?;
        if !route.enabled {
            return Err("route_disabled".into());
        }
        Ok(route)
    }
    pub fn approve_route(
        &mut self,
        source: Source,
        workspaces: Vec<String>,
        allow_input: bool,
        notifications: bool,
    ) -> Result<Route, String> {
        self.approve_route_with_baselines(source, workspaces, allow_input, notifications, &[])
    }
    pub fn approve_route_with_baselines(
        &mut self,
        source: Source,
        workspaces: Vec<String>,
        allow_input: bool,
        notifications: bool,
        baselines: &[(String, String, u64)],
    ) -> Result<Route, String> {
        source.validate()?;
        let scopes = Self::canonical_workspaces(workspaces)?;
        let has_access = !scopes.is_empty();
        let old = self.routes()?.into_iter().find(|r| r.source == source);
        let route = Route {
            id: old.as_ref().map(|r| r.id.clone()).unwrap_or_else(random_id),
            generation: old.as_ref().map_or(1, |r| r.generation + 1),
            identity_ref: digest(&format!(
                "{}:{}:{}:{}",
                source.account_ref, source.profile, source.platform, source.user_id
            )),
            target_ref: digest(&format!("{}:{}", source.account_ref, source.target())),
            source,
            workspaces: scopes,
            allow_input: has_access && allow_input,
            notifications: has_access && notifications,
            enabled: true,
            created_at: now(),
        };
        self.write_route_with_baselines(&route, baselines)?;
        Ok(route)
    }
    pub fn canonical_workspaces(workspaces: Vec<String>) -> Result<Vec<String>, String> {
        let mut scopes = Vec::new();
        for value in workspaces {
            let path = Path::new(&value)
                .canonicalize()
                .map_err(|_| "workspace_not_found".to_string())?;
            if !path.is_dir() || path.parent().is_none() {
                return Err("invalid_workspace_scope".into());
            }
            scopes.push(path.to_string_lossy().into_owned());
        }
        scopes.sort();
        scopes.dedup();
        if scopes.len() > 32 {
            return Err("too_many_workspace_scopes".into());
        }
        // An empty scope records a paired identity, never unrestricted access.
        Ok(scopes)
    }
    pub fn update_route_access(
        &mut self,
        account: &str,
        id: &str,
        generation: i64,
        workspaces: Vec<String>,
        allow_input: bool,
        notifications: bool,
        baselines: &[(String, String, u64)],
    ) -> Result<Route, String> {
        let connection = self.connection(account)?;
        let route = self
            .routes()?
            .into_iter()
            .find(|r| r.id == id)
            .ok_or("route_not_found")?;
        if !connection.enabled
            || route.source.account_ref != account
            || route.source.platform != connection.platform
        {
            return Err("account_not_authorized".into());
        }
        if !route.enabled || route.generation != generation {
            return Err("route_authority_changed".into());
        }
        self.approve_route_with_baselines(
            route.source,
            workspaces,
            allow_input,
            notifications,
            baselines,
        )
    }
    fn write_route(&mut self, route: &Route) -> Result<(), String> {
        self.write_route_with_baselines(route, &[])
    }
    fn write_route_with_baselines(
        &mut self,
        route: &Route,
        baselines: &[(String, String, u64)],
    ) -> Result<(), String> {
        let tx = self.db.transaction().map_err(err)?;
        tx.execute("INSERT INTO routes VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET source_key=excluded.source_key,data=excluded.data", params![route.id,route.source.key(),serde_json::to_string(route).map_err(err)?]).map_err(err)?;
        tx.execute(
            "UPDATE challenges SET state='revoked' WHERE route_id=?1 AND state='pending'",
            [&route.id],
        )
        .map_err(err)?;
        for (runtime, project, seq) in baselines
            .iter()
            .filter(|(_, project, _)| route.permits(project))
        {
            let _ = project;
            tx.execute(
                "INSERT INTO cursors VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET seq=excluded.seq",
                params![format!("{}:{}:{runtime}", route.id, route.generation), seq],
            )
            .map_err(err)?;
        }
        tx.commit().map_err(err)
    }
    pub fn disable_route(&mut self, id: &str) -> Result<(), String> {
        let mut route = self
            .routes()?
            .into_iter()
            .find(|r| r.id == id)
            .ok_or("route_not_found")?;
        route.enabled = false;
        route.generation += 1;
        self.write_route(&route)
    }
    pub fn prepare(
        &mut self,
        route: &Route,
        message: &str,
        runtime: &str,
        text: &str,
    ) -> Result<Value, String> {
        if !route.allow_input {
            return Err("input_not_allowed".into());
        }
        validate_message_id(message)?;
        if text.trim().is_empty() || text.len() > 2000 {
            return Err("invalid_input_size".into());
        }
        let request = digest(&format!(
            "{}:{}:input:{}",
            route.id, route.generation, message
        ));
        let hash = digest(&json!([runtime, text]).to_string());
        let tx = self.db.transaction().map_err(err)?;
        if let Some(reply) = replay(&tx, &request, &hash)? {
            return Ok(reply);
        }
        let challenge = random_id();
        let expires = now() + 120_000;
        let reply = json!({"challenge":challenge,"runtimeId":runtime,"text":text,"expiresAt":expires,"state":"confirmation_required"});
        tx.execute(
            "INSERT INTO challenges VALUES(?1,?2,?3,?4,?5,?6,?7,'pending',NULL)",
            params![
                challenge,
                route.id,
                route.generation,
                runtime,
                text,
                message,
                expires
            ],
        )
        .map_err(err)?;
        tx.execute(
            "INSERT INTO requests VALUES(?1,?2,?3)",
            params![request, hash, reply.to_string()],
        )
        .map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(reply)
    }
    /// Returns a durable operation and whether this call owns its one permitted submission.
    pub fn confirm(
        &mut self,
        route: &Route,
        message: &str,
        challenge: &str,
        allowed_runtime: &str,
    ) -> Result<(Operation, bool), String> {
        if !route.allow_input {
            return Err("input_not_allowed".into());
        }
        validate_message_id(message)?;
        let request = digest(&format!(
            "{}:{}:confirm:{}",
            route.id, route.generation, message
        ));
        let hash = digest(challenge);
        let tx = self.db.transaction().map_err(err)?;
        if let Some(reply) = replay(&tx, &request, &hash)? {
            let id = reply["operationId"].as_str().ok_or("corrupt_operation")?;
            return Ok((read_operation(&tx, id)?, false));
        }
        type ChallengeRow = (
            String,
            i64,
            String,
            String,
            String,
            i64,
            String,
            Option<String>,
        );
        let row: ChallengeRow=tx.query_row("SELECT route_id,generation,runtime_id,text,input_message,expires,state,operation_id FROM challenges WHERE id=?1", [challenge], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?))).optional().map_err(err)?.ok_or("challenge_not_found")?;
        if row.0 != route.id || row.1 != route.generation || row.2 != allowed_runtime {
            return Err("challenge_scope_mismatch".into());
        }
        if row.4 == message {
            return Err("separate_confirmation_message_required".into());
        }
        let (op, submit) = if let Some(id) = row.7 {
            (read_operation(&tx, &id)?, false)
        } else {
            if row.6 != "pending" || row.5 < now() {
                return Err("challenge_expired_or_revoked".into());
            }
            let op = Operation {
                id: format!("hermes:{}", random_id()),
                route_id: route.id.clone(),
                generation: route.generation,
                runtime_id: row.2,
                text: row.3,
                state: "submitting".into(),
                detail: "Confirmed; submission reserved".into(),
                invocation_id: None,
                ambiguous_invocation: false,
                created_at: now(),
                updated_at: now(),
            };
            tx.execute(
                "INSERT INTO operations VALUES(?1,?2,?3)",
                params![op.id, op.route_id, serde_json::to_string(&op).map_err(err)?],
            )
            .map_err(err)?;
            tx.execute(
                "UPDATE challenges SET state='confirmed',operation_id=?2 WHERE id=?1",
                params![challenge, op.id],
            )
            .map_err(err)?;
            (op, true)
        };
        tx.execute(
            "INSERT INTO requests VALUES(?1,?2,?3)",
            params![request, hash, json!({"operationId":op.id}).to_string()],
        )
        .map_err(err)?;
        tx.commit().map_err(err)?;
        Ok((op, submit))
    }
    pub fn challenge_runtime(&self, route: &Route, id: &str) -> Result<String, String> {
        self.db
            .query_row(
                "SELECT runtime_id FROM challenges WHERE id=?1 AND route_id=?2 AND generation=?3",
                params![id, route.id, route.generation],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?
            .ok_or_else(|| "challenge_not_found".into())
    }
    pub fn cancel(&self, route: &Route, id: &str) -> Result<(), String> {
        let n=self.db.execute("UPDATE challenges SET state='cancelled' WHERE id=?1 AND route_id=?2 AND generation=?3 AND state='pending'",params![id,route.id,route.generation]).map_err(err)?;
        if n == 0 {
            return Err("challenge_not_pending".into());
        }
        Ok(())
    }
    pub fn operations(&self) -> Result<Vec<Operation>, String> {
        self.list("SELECT data FROM operations ORDER BY rowid DESC")
    }
    pub fn operation(&self, id: &str) -> Result<Operation, String> {
        read_operation(&self.db, id)
    }
    pub fn save_operation(&self, op: &Operation) -> Result<(), String> {
        self.db
            .execute(
                "UPDATE operations SET data=?2 WHERE id=?1",
                params![op.id, serde_json::to_string(op).map_err(err)?],
            )
            .map_err(err)?;
        Ok(())
    }
    pub fn observe_operation(
        &self,
        id: &str,
        runtime: &str,
        invocation: &str,
        stage: &str,
        detail: &str,
    ) -> Result<(), String> {
        let Ok(mut op) = self.operation(id) else {
            return Ok(());
        };
        if op.runtime_id != runtime {
            return Ok(());
        }
        if op.ambiguous_invocation
            || op
                .invocation_id
                .as_ref()
                .is_some_and(|old| old != invocation)
        {
            op.ambiguous_invocation = true;
            op.state = "unknown".into();
            op.detail = "Multiple provider invocations observed for one operation".into();
        } else if !["completed", "failed"].contains(&op.state.as_str()) {
            op.invocation_id = Some(invocation.into());
            op.state = match stage {
                "started" => "running",
                "completed" => "completed",
                "failed" => "failed",
                _ => "unknown",
            }
            .into();
            op.detail = detail.chars().take(1000).collect();
        }
        op.updated_at = now();
        self.save_operation(&op)
    }
    pub fn cursor(&self, id: &str) -> Result<Option<u64>, String> {
        self.db
            .query_row("SELECT seq FROM cursors WHERE id=?1", [id], |r| r.get(0))
            .optional()
            .map_err(err)
    }
    pub fn enqueue_page(
        &mut self,
        cursor: &str,
        seq: u64,
        deliveries: &[Delivery],
    ) -> Result<(), String> {
        self.enqueue_notification_page(cursor, seq, deliveries, None)
    }
    pub fn notification_input_state(&self, cursor: &str) -> Result<Option<String>, String> {
        self.setting(&format!("notification_input:{cursor}"))
    }
    /// Input provenance advances atomically with the replay cursor and its outbox.
    pub fn enqueue_notification_page(
        &mut self,
        cursor: &str,
        seq: u64,
        deliveries: &[Delivery],
        input_state: Option<&str>,
    ) -> Result<(), String> {
        let tx = self.db.transaction().map_err(err)?;
        for d in deliveries {
            tx.execute(
                "INSERT OR IGNORE INTO outbox VALUES(?1,?2,?3)",
                params![d.id, d.route_id, serde_json::to_string(d).map_err(err)?],
            )
            .map_err(err)?;
        }
        tx.execute(
            "INSERT INTO cursors VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET seq=excluded.seq",
            params![cursor, seq],
        )
        .map_err(err)?;
        if let Some(state) = input_state {
            tx.execute(
                "INSERT INTO settings VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
                params![format!("notification_input:{cursor}"), state],
            )
            .map_err(err)?;
        }
        tx.commit().map_err(err)
    }
    pub fn deliveries(&self) -> Result<Vec<Delivery>, String> {
        self.list("SELECT data FROM outbox ORDER BY rowid DESC")
    }
    pub fn delivery(&self, id: &str) -> Result<Option<Delivery>, String> {
        let raw: Option<String> = self
            .db
            .query_row("SELECT data FROM outbox WHERE id=?1", [id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(err)?;
        raw.map(|raw| serde_json::from_str(&raw).map_err(err))
            .transpose()
    }
    pub fn enqueue_delivery(&self, d: &Delivery) -> Result<(), String> {
        self.db
            .execute(
                "INSERT OR IGNORE INTO outbox VALUES(?1,?2,?3)",
                params![d.id, d.route_id, serde_json::to_string(d).map_err(err)?],
            )
            .map_err(err)?;
        Ok(())
    }
    pub fn save_delivery(&self, d: &Delivery) -> Result<(), String> {
        self.db
            .execute(
                "UPDATE outbox SET data=?2 WHERE id=?1",
                params![d.id, serde_json::to_string(d).map_err(err)?],
            )
            .map_err(err)?;
        Ok(())
    }
}
fn validate_message_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 512 || id.chars().any(char::is_control) {
        Err("source_message_id_required".into())
    } else {
        Ok(())
    }
}
fn replay(db: &Connection, id: &str, hash: &str) -> Result<Option<Value>, String> {
    let row: Option<(String, String)> = db
        .query_row(
            "SELECT hash,response FROM requests WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(err)?;
    match row {
        Some((old, reply)) if old == hash => Ok(Some(serde_json::from_str(&reply).map_err(err)?)),
        Some(_) => Err("source_message_payload_conflict".into()),
        None => Ok(None),
    }
}
fn read_operation(db: &Connection, id: &str) -> Result<Operation, String> {
    let raw: String = db
        .query_row("SELECT data FROM operations WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .optional()
        .map_err(err)?
        .ok_or("operation_not_found")?;
    serde_json::from_str(&raw).map_err(err)
}

#[cfg(test)]
mod channel_transaction_tests {
    use super::*;

    #[test]
    #[cfg(unix)]
    fn closing_store_releases_ownership_while_an_inherited_description_survives() {
        use std::os::fd::AsRawFd;

        let root = tempfile::tempdir().unwrap();
        let store = Store::open(root.path()).unwrap();
        let flags = unsafe { libc::fcntl(store._owner.0.as_raw_fd(), libc::F_GETFD) };
        assert!(flags >= 0 && flags & libc::FD_CLOEXEC != 0);
        // dup and fork share the same open file description. Holding this clone
        // deterministically models the window before a concurrent child execs.
        let inherited = store._owner.0.try_clone().unwrap();
        drop(store);

        let reopened = Store::open(root.path())
            .expect("a completed owner must release its lock before child exec");
        assert!(
            Store::open(root.path()).is_err(),
            "the new owner stays exclusive"
        );
        drop(inherited);
        assert!(
            Store::open(root.path()).is_err(),
            "closing the old inherited handle cannot unlock the new owner"
        );
        drop(reopened);
        assert!(Store::open(root.path()).is_ok());
    }

    #[test]
    fn failed_channel_replacement_rolls_back_credentials_account_and_authorizations() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let database = root.path().join("state");
        let mut store = Store::open(&database).unwrap();
        let old = store
            .save_connection(
                None,
                "telegram",
                None,
                "old-encrypted-credentials",
                &["TELEGRAM_BOT_TOKEN".into()],
                true,
            )
            .unwrap();
        let source = Source {
            account_ref: old.account_ref.clone(),
            platform: "telegram".into(),
            profile: "private".into(),
            transport_profile: "private".into(),
            user_id: "fixture-user".into(),
            chat_id: "fixture-chat".into(),
            thread_id: None,
            chat_type: "dm".into(),
        };
        let route = store
            .approve_route(
                source.clone(),
                vec![workspace.to_string_lossy().into()],
                true,
                true,
            )
            .unwrap();
        let prepared = store
            .prepare(&route, "original-input", "fixture-runtime", "original text")
            .unwrap();
        let challenge = prepared["challenge"].as_str().unwrap();
        let challenge_state = |store: &Store| -> String {
            store
                .db
                .query_row(
                    "SELECT state FROM challenges WHERE id=?1",
                    [challenge],
                    |row| row.get(0),
                )
                .unwrap()
        };
        let old_route = json!(store.route(&source).unwrap());

        // Fail after route/challenge revocation, before the atomic credential edit.
        store
            .db
            .execute_batch(
                "CREATE TRIGGER fail_channel_replacement BEFORE INSERT ON connections
            BEGIN SELECT RAISE(ABORT, 'injected replacement failure'); END;",
            )
            .unwrap();
        let fields = ["TELEGRAM_BOT_TOKEN".into()];
        let error = store
            .save_connection(
                Some(&old.account_ref),
                "telegram",
                None,
                "new-encrypted-credentials",
                &fields,
                true,
            )
            .unwrap_err();
        assert!(error.contains("injected replacement failure"));
        assert_eq!(
            store.connection(&old.account_ref).unwrap().cipher,
            old.cipher
        );
        assert_eq!(store.connections().unwrap().len(), 1);
        assert_eq!(json!(store.route(&source).unwrap()), old_route);
        assert_eq!(
            store.challenge_runtime(&route, challenge).unwrap(),
            "fixture-runtime"
        );
        assert_eq!(challenge_state(&store), "pending");

        drop(store);
        let mut store = Store::open(&database).unwrap();
        assert_eq!(
            store.connection(&old.account_ref).unwrap().cipher,
            old.cipher
        );
        assert_eq!(json!(store.route(&source).unwrap()), old_route);
        assert_eq!(
            store.challenge_runtime(&route, challenge).unwrap(),
            "fixture-runtime"
        );
        assert_eq!(challenge_state(&store), "pending");

        store
            .db
            .execute_batch("DROP TRIGGER fail_channel_replacement;")
            .unwrap();
        store
            .save_connection(
                Some(&old.account_ref),
                "telegram",
                None,
                "new-encrypted-credentials",
                &fields,
                true,
            )
            .unwrap();
        assert_eq!(
            store.connection(&old.account_ref).unwrap().cipher,
            "new-encrypted-credentials"
        );
        assert_eq!(store.connections().unwrap().len(), 1);
        assert!(store.route(&source).is_err());
        assert_eq!(challenge_state(&store), "revoked");
        assert!(store
            .confirm(&route, "later-confirmation", challenge, "fixture-runtime")
            .is_err());
    }
}
