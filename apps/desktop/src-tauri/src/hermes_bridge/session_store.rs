//! Session grants have their own identity; they never widen a paired workspace route.
use super::{err, now, random_id, Delivery, Route, Store};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBinding {
    pub id: String,
    pub runtime_id: String,
    pub route_id: String,
    pub generation: i64,
    pub title: String,
    pub model_env: String,
    pub model: String,
    pub cursor: u64,
    #[serde(default)]
    pub input_context: Option<String>,
    pub created_at: i64,
    pub last_decision_at: Option<i64>,
    pub last_decision: Option<String>,
    pub error: Option<String>,
}

impl SessionBinding {
    pub fn scoped_route(&self, paired: &Route) -> Route {
        Route {
            id: self.id.clone(),
            workspaces: vec![],
            allow_input: true,
            notifications: false,
            created_at: self.created_at,
            ..paired.clone()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDecision {
    pub id: String,
    pub binding_id: String,
    pub runtime_id: String,
    pub next_cursor: u64,
    #[serde(default)]
    pub input_context: Option<String>,
    pub events: Value,
    pub state: String,
    pub retry_after: i64,
}

impl Store {
    pub fn session_bindings(&self) -> Result<Vec<SessionBinding>, String> {
        self.list("SELECT data FROM session_bindings ORDER BY rowid")
    }

    pub fn session_binding(&self, runtime: &str) -> Result<Option<SessionBinding>, String> {
        let raw: Option<String> = self
            .db
            .query_row(
                "SELECT data FROM session_bindings WHERE runtime_id=?1",
                [runtime],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?;
        raw.map(|raw| serde_json::from_str(&raw).map_err(err))
            .transpose()
    }

    pub fn binding_route(&self, binding: &SessionBinding) -> Result<Option<Route>, String> {
        if self
            .session_binding(&binding.runtime_id)?
            .is_none_or(|b| b.id != binding.id)
        {
            return Ok(None);
        }
        Ok(self.routes()?.into_iter().find(|r| {
            r.id == binding.route_id
                && r.generation == binding.generation
                && r.enabled
                && self
                    .connection(&r.source.account_ref)
                    .is_ok_and(|c| c.enabled && c.platform == r.source.platform)
        }))
    }

    pub fn binding_for_route(
        &self,
        route: &Route,
        runtime: &str,
    ) -> Result<Option<SessionBinding>, String> {
        Ok(self.session_binding(runtime)?.filter(|b| {
            b.route_id == route.id && b.generation == route.generation && route.enabled
        }))
    }

    pub fn session_delivery_authorized(
        &self,
        binding_id: &str,
        route: &Route,
    ) -> Result<bool, String> {
        Ok(self.session_bindings()?.iter().any(|b| {
            b.id == binding_id
                && b.route_id == route.id
                && b.generation == route.generation
                && route.enabled
        }))
    }

    pub fn bind_session(
        &mut self,
        mut binding: SessionBinding,
        paired: &Route,
    ) -> Result<SessionBinding, String> {
        if paired.id != binding.route_id
            || paired.generation != binding.generation
            || !paired.enabled
        {
            return Err("session_pairing_changed".into());
        }
        binding.id = random_id();
        binding.created_at = now();
        let old = self.session_binding(&binding.runtime_id)?;
        let mut revoked = self
            .deliveries()?
            .into_iter()
            .filter(|d| {
                d.status == "pending"
                    && old
                        .as_ref()
                        .is_some_and(|b| d.session_binding_id.as_deref() == Some(&b.id))
            })
            .collect::<Vec<_>>();
        let tx = self.db.transaction().map_err(err)?;
        if let Some(old) = old {
            tx.execute(
                "UPDATE challenges SET state='revoked' WHERE route_id=?1 AND state='pending'",
                [&old.id],
            )
            .map_err(err)?;
            tx.execute("UPDATE session_decisions SET state='revoked' WHERE binding_id=?1 AND state='pending'", [&old.id]).map_err(err)?;
        }
        for d in &mut revoked {
            d.status = "revoked".into();
            tx.execute(
                "UPDATE outbox SET data=?2 WHERE id=?1",
                params![d.id, serde_json::to_string(d).map_err(err)?],
            )
            .map_err(err)?;
        }
        tx.execute("INSERT INTO session_bindings VALUES(?1,?2) ON CONFLICT(runtime_id) DO UPDATE SET data=excluded.data",
            params![binding.runtime_id, serde_json::to_string(&binding).map_err(err)?]).map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(binding)
    }

    pub fn detach_session(&mut self, runtime: &str, expected_id: &str) -> Result<(), String> {
        let Some(binding) = self.session_binding(runtime)? else {
            return Ok(());
        };
        if binding.id != expected_id {
            return Err("session_binding_changed".into());
        }
        let mut revoked = self
            .deliveries()?
            .into_iter()
            .filter(|d| {
                d.status == "pending" && d.session_binding_id.as_deref() == Some(expected_id)
            })
            .collect::<Vec<_>>();
        let tx = self.db.transaction().map_err(err)?;
        tx.execute(
            "DELETE FROM session_bindings WHERE runtime_id=?1",
            [runtime],
        )
        .map_err(err)?;
        tx.execute(
            "UPDATE challenges SET state='revoked' WHERE route_id=?1 AND state='pending'",
            [expected_id],
        )
        .map_err(err)?;
        tx.execute(
            "UPDATE session_decisions SET state='revoked' WHERE binding_id=?1 AND state='pending'",
            [expected_id],
        )
        .map_err(err)?;
        for d in &mut revoked {
            d.status = "revoked".into();
            tx.execute(
                "UPDATE outbox SET data=?2 WHERE id=?1",
                params![d.id, serde_json::to_string(d).map_err(err)?],
            )
            .map_err(err)?;
        }
        tx.commit().map_err(err)
    }

    pub fn pending_session_decisions(&self) -> Result<Vec<SessionDecision>, String> {
        self.list("SELECT data FROM session_decisions WHERE state='pending' ORDER BY rowid")
    }

    /// Journal the wake and its raw event cursor in the same transaction.
    pub fn enqueue_session_decision(
        &mut self,
        binding: &SessionBinding,
        decision: &SessionDecision,
    ) -> Result<(), String> {
        if decision.binding_id != binding.id
            || decision.runtime_id != binding.runtime_id
            || decision.next_cursor <= binding.cursor
        {
            return Err("session_decision_scope_mismatch".into());
        }
        let mut current = self
            .session_binding(&binding.runtime_id)?
            .ok_or("session_binding_revoked")?;
        if current.id != binding.id || current.cursor != binding.cursor {
            return Err("session_binding_changed".into());
        }
        current.cursor = decision.next_cursor;
        current.input_context = decision.input_context.clone();
        let tx = self.db.transaction().map_err(err)?;
        tx.execute(
            "INSERT OR IGNORE INTO session_decisions VALUES(?1,?2,'pending',?3)",
            params![
                decision.id,
                binding.id,
                serde_json::to_string(decision).map_err(err)?
            ],
        )
        .map_err(err)?;
        tx.execute(
            "UPDATE session_bindings SET data=?2 WHERE runtime_id=?1",
            params![
                current.runtime_id,
                serde_json::to_string(&current).map_err(err)?
            ],
        )
        .map_err(err)?;
        tx.commit().map_err(err)
    }

    /// A silent decision is durable too. Only CCEM constructs the recipient.
    pub fn finish_session_decision(
        &mut self,
        decision: &SessionDecision,
        delivery: Option<&Delivery>,
        error: Option<&str>,
    ) -> Result<(), String> {
        let Some(mut binding) = self.session_binding(&decision.runtime_id)? else {
            return Ok(());
        };
        if binding.id != decision.binding_id || self.binding_route(&binding)?.is_none() {
            return Ok(());
        }
        let state: Option<String> = self
            .db
            .query_row(
                "SELECT state FROM session_decisions WHERE id=?1",
                [&decision.id],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?;
        if state.as_deref() != Some("pending") {
            return Ok(());
        }
        let mut updated = decision.clone();
        updated.state = if error.is_some() {
            "pending"
        } else if delivery.is_some() {
            "notify"
        } else {
            "silent"
        }
        .into();
        updated.retry_after = if error.is_some() { now() + 60_000 } else { 0 };
        binding.last_decision_at = Some(now());
        binding.last_decision = Some(
            if error.is_some() {
                "error"
            } else {
                &updated.state
            }
            .into(),
        );
        binding.error = error.map(str::to_owned);
        let tx = self.db.transaction().map_err(err)?;
        if let Some(d) = delivery {
            tx.execute(
                "INSERT OR IGNORE INTO outbox VALUES(?1,?2,?3)",
                params![d.id, d.route_id, serde_json::to_string(d).map_err(err)?],
            )
            .map_err(err)?;
        }
        tx.execute(
            "UPDATE session_decisions SET state=?2,data=?3 WHERE id=?1",
            params![
                updated.id,
                updated.state,
                serde_json::to_string(&updated).map_err(err)?
            ],
        )
        .map_err(err)?;
        tx.execute(
            "UPDATE session_bindings SET data=?2 WHERE runtime_id=?1",
            params![
                binding.runtime_id,
                serde_json::to_string(&binding).map_err(err)?
            ],
        )
        .map_err(err)?;
        tx.commit().map_err(err)
    }
}
