use crate::event_bus::{ReplayBatch, SessionEventPayload, SessionEventRecord, TodoSnapshotV1};
use crate::session_provenance::state_db_path;
use crate::user_prompt_display::normalize_user_visible_prompt;
use crate::workspace_decorations::AttentionSummary;
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

const EVENT_LOG_FLUSH_BATCH_SIZE: usize = 64;
const ATTENTION_SUMMARY_TAIL_FALLBACK_LIMIT: u64 = 2000;

pub struct NativeEventLog {
    db_path: PathBuf,
    conn: Mutex<Option<Connection>>,
    pending: Mutex<Vec<SessionEventRecord>>,
    first_user_prompt_cache: Mutex<HashMap<String, String>>,
}

impl Default for NativeEventLog {
    fn default() -> Self {
        Self::new(state_db_path())
    }
}

impl Drop for NativeEventLog {
    fn drop(&mut self) {
        let _ = self.flush_pending();
    }
}

impl NativeEventLog {
    pub fn new(db_path: PathBuf) -> Self {
        Self {
            db_path,
            conn: Mutex::new(None),
            pending: Mutex::new(Vec::new()),
            first_user_prompt_cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn append(&self, record: &SessionEventRecord) -> Result<(), String> {
        let should_flush = {
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| "Failed to lock pending native event log records".to_string())?;
            pending.push(record.clone());
            pending.len() >= EVENT_LOG_FLUSH_BATCH_SIZE
                || should_flush_after_append(&record.payload)
        };

        if should_flush {
            self.flush_pending()?;
        }

        Ok(())
    }

    pub fn flush_pending(&self) -> Result<(), String> {
        let records = {
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| "Failed to lock pending native event log records".to_string())?;
            if pending.is_empty() {
                return Ok(());
            }
            std::mem::take(&mut *pending)
        };

        if let Err(error) = self.write_records(&records) {
            if let Ok(mut pending) = self.pending.lock() {
                let mut restored = records;
                restored.append(&mut *pending);
                *pending = restored;
            }
            return Err(error);
        }

        Ok(())
    }

    pub fn replay(
        &self,
        runtime_id: &str,
        since_seq: Option<u64>,
        limit: Option<u64>,
    ) -> Result<ReplayBatch, String> {
        self.flush_pending()?;
        self.with_conn(|conn| {
            let (oldest_available_seq, newest_available_seq) = event_seq_bounds(conn, runtime_id)?;
            let gap_detected = match (since_seq, oldest_available_seq) {
                (Some(last_seen), Some(oldest)) => last_seen.saturating_add(1) < oldest,
                _ => false,
            };

            let events = query_events_since(conn, runtime_id, since_seq, limit)?;
            let unloaded_gap_starts = if since_seq.is_none() && limit.is_some_and(|value| value > 0)
            {
                limited_replay_unloaded_gap_starts(conn, runtime_id, &events)?
            } else {
                Vec::new()
            };
            let truncated = replay_batch_is_truncated(
                &events,
                since_seq,
                oldest_available_seq,
                newest_available_seq,
                gap_detected,
            );

            Ok(ReplayBatch {
                source_available: true,
                gap_detected,
                truncated,
                unloaded_gap_starts,
                oldest_available_seq,
                newest_available_seq,
                events,
            })
        })
    }

    pub fn has_events(&self, runtime_id: &str) -> Result<bool, String> {
        self.flush_pending()?;
        self.with_conn(|conn| runtime_has_events(conn, runtime_id))
    }

    /// Read the first user-visible prompt for each requested runtime without
    /// replaying its transcript. The `(runtime_id, seq)` primary key keeps each
    /// cursor ordered, while one connection lock and one prepared statement
    /// keep a cold-start batch inexpensive.
    pub fn first_user_prompts(
        &self,
        runtime_ids: &[String],
    ) -> Result<HashMap<String, String>, String> {
        if runtime_ids.is_empty() {
            return Ok(HashMap::new());
        }

        let mut cache = self
            .first_user_prompt_cache
            .lock()
            .map_err(|_| "Failed to lock native first prompt cache".to_string())?;
        let mut requested_ids = Vec::new();
        for runtime_id in runtime_ids {
            let runtime_id = runtime_id.trim();
            if !runtime_id.is_empty() && !requested_ids.iter().any(|id| id == runtime_id) {
                requested_ids.push(runtime_id.to_string());
            }
        }
        let uncached_ids = requested_ids
            .iter()
            .filter(|runtime_id| !cache.contains_key(runtime_id.as_str()))
            .cloned()
            .collect::<Vec<_>>();

        if !uncached_ids.is_empty() {
            self.flush_pending()?;
            let discovered = self.with_conn(|conn| {
                let mut stmt = conn
                    .prepare_cached(
                        "SELECT payload_json
                         FROM native_session_events
                         WHERE runtime_id = ?1
                           AND payload_json LIKE '{\"type\":\"user_prompt\"%'
                         ORDER BY seq ASC",
                    )
                    .map_err(|error| {
                        format!("Failed to prepare first native user prompt query: {error}")
                    })?;
                let mut prompts = HashMap::new();

                for runtime_id in &uncached_ids {
                    let runtime_id = runtime_id.trim();
                    if runtime_id.is_empty() || prompts.contains_key(runtime_id) {
                        continue;
                    }
                    let mut rows = stmt.query([runtime_id]).map_err(|error| {
                        format!("Failed to query native user prompts for {runtime_id}: {error}")
                    })?;
                    while let Some(row) = rows.next().map_err(|error| {
                        format!("Failed to read native user prompt for {runtime_id}: {error}")
                    })? {
                        let Ok(payload_json) = row.get::<_, String>(0) else {
                            continue;
                        };
                        let Ok(payload) = serde_json::from_str::<serde_json::Value>(&payload_json)
                        else {
                            // A corrupt legacy row must not prevent every other
                            // restored runtime from receiving its prompt.
                            continue;
                        };
                        let Some(prompt) = payload
                            .get("text")
                            .and_then(serde_json::Value::as_str)
                            .and_then(normalize_user_visible_prompt)
                        else {
                            continue;
                        };
                        prompts.insert(runtime_id.to_string(), prompt);
                        break;
                    }
                }

                Ok(prompts)
            })?;
            for (runtime_id, prompt) in discovered {
                cache.insert(runtime_id, prompt);
            }
        }

        Ok(requested_ids
            .into_iter()
            .filter_map(|runtime_id| {
                cache
                    .get(&runtime_id)
                    .cloned()
                    .map(|prompt| (runtime_id, prompt))
            })
            .collect())
    }

    /// Persisted, incrementally maintained attention summary for a runtime.
    /// Falls back to deriving the summary once from the bounded event tail for
    /// runtimes that predate summary persistence, then serves it from storage.
    pub fn attention_summary(&self, runtime_id: &str) -> Result<AttentionSummary, String> {
        self.flush_pending()?;
        self.with_conn(|conn| load_or_seed_attention_summary(conn, runtime_id))
    }

    pub fn newest_seq(&self, runtime_id: &str) -> Result<Option<u64>, String> {
        self.flush_pending()?;
        self.with_conn(|conn| {
            let seq = conn
                .query_row(
                    "SELECT MAX(seq) FROM native_session_events WHERE runtime_id = ?1",
                    [runtime_id],
                    |row| row.get::<_, Option<i64>>(0),
                )
                .map_err(|error| format!("Failed to query newest native event seq: {}", error))?;
            Ok(seq.and_then(non_negative_i64_to_u64))
        })
    }

    /// Cheapest possible check for incremental replay: how many events exist
    /// for this runtime after `since_seq`, plus the runtime's global
    /// oldest/newest seq (matching what `event_seq_bounds` would report).
    /// Runs after flush_pending, like replay does, so pending writer batches
    /// stay visible. Lets callers skip the events query entirely when the
    /// pending count is zero.
    pub fn pending_since(
        &self,
        runtime_id: &str,
        since_seq: Option<u64>,
    ) -> Result<(u64, Option<u64>, Option<u64>), String> {
        self.flush_pending()?;
        self.with_conn(|conn| {
            let since = since_seq.map(|seq| seq as i64);
            let (pending_count, oldest, newest) = conn
                .query_row(
                    "SELECT COALESCE(SUM(CASE WHEN ?2 IS NULL OR seq > ?2 THEN 1 ELSE 0 END), 0),
                            MIN(seq), MAX(seq)
                     FROM native_session_events
                     WHERE runtime_id = ?1",
                    params![runtime_id, since],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, Option<i64>>(1)?,
                            row.get::<_, Option<i64>>(2)?,
                        ))
                    },
                )
                .map_err(|error| {
                    format!("Failed to count pending native session events: {}", error)
                })?;
            Ok((
                pending_count as u64,
                oldest.and_then(non_negative_i64_to_u64),
                newest.and_then(non_negative_i64_to_u64),
            ))
        })
    }

    pub fn latest_todo_snapshot(&self, runtime_id: &str) -> Result<Option<TodoSnapshotV1>, String> {
        self.flush_pending()?;
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT payload_json
                     FROM native_session_events
                     WHERE runtime_id = ?1
                       AND payload_json LIKE '%\"todo_snapshot\":{%'
                     ORDER BY seq DESC",
                )
                .map_err(|error| {
                    format!(
                        "Failed to prepare latest native todo snapshot query: {}",
                        error
                    )
                })?;
            let rows = stmt
                .query_map([runtime_id], |row| row.get::<_, String>(0))
                .map_err(|error| {
                    format!("Failed to query latest native todo snapshot: {}", error)
                })?;

            for row in rows {
                let payload_json = row.map_err(|error| {
                    format!("Failed to read latest native todo snapshot row: {}", error)
                })?;
                let payload: SessionEventPayload =
                    serde_json::from_str(&payload_json).map_err(|error| {
                        format!(
                            "Failed to deserialize native todo snapshot event: {}",
                            error
                        )
                    })?;
                if let Some(snapshot) = todo_snapshot_from_payload(&payload) {
                    return Ok(Some(snapshot.clone()));
                }
            }

            Ok(None)
        })
    }

    fn write_records(&self, records: &[SessionEventRecord]) -> Result<(), String> {
        self.with_conn(|conn| {
            let tx = conn.transaction().map_err(|error| {
                format!("Failed to begin native event log transaction: {}", error)
            })?;
            // Seed per-runtime base summaries before inserting the batch so the
            // tail fallback only ever folds events that already exist on disk.
            let mut summaries: HashMap<String, AttentionSummary> = HashMap::new();
            for record in records {
                if !summaries.contains_key(&record.runtime_id) {
                    let base = load_or_seed_attention_summary(&tx, &record.runtime_id)?;
                    summaries.insert(record.runtime_id.clone(), base);
                }
            }
            {
                let mut stmt = tx
                    .prepare_cached(
                        "INSERT OR IGNORE INTO native_session_events (
                            runtime_id,
                            seq,
                            occurred_at,
                            payload_json,
                            created_at
                        ) VALUES (?1, ?2, ?3, ?4, ?5)",
                    )
                    .map_err(|error| {
                        format!("Failed to prepare native session event append: {}", error)
                    })?;
                let created_at = Utc::now().to_rfc3339();
                for record in records {
                    let payload_json = serde_json::to_string(&record.payload).map_err(|error| {
                        format!("Failed to serialize native event payload: {}", error)
                    })?;
                    stmt.execute(params![
                        record.runtime_id,
                        record.seq as i64,
                        record.occurred_at.to_rfc3339(),
                        payload_json,
                        created_at,
                    ])
                    .map_err(|error| format!("Failed to append native session event: {}", error))?;
                }
            }
            for record in records {
                if let Some(summary) = summaries.get_mut(&record.runtime_id) {
                    summary.apply(record);
                }
            }
            for (runtime_id, summary) in &summaries {
                persist_attention_summary(&tx, runtime_id, summary)?;
            }
            tx.commit().map_err(|error| {
                format!("Failed to commit native event log transaction: {}", error)
            })?;
            Ok(())
        })
    }

    fn with_conn<T>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self
            .conn
            .lock()
            .map_err(|_| "Failed to lock native event log connection".to_string())?;

        if guard.is_none() {
            if let Some(parent) = self.db_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("Failed to create sqlite state dir: {}", error))?;
            }

            let conn = Connection::open(&self.db_path).map_err(|error| {
                format!(
                    "Failed to open sqlite state db {}: {}",
                    self.db_path.display(),
                    error
                )
            })?;
            conn.busy_timeout(Duration::from_secs(3))
                .map_err(|error| format!("Failed to configure sqlite busy timeout: {}", error))?;
            conn.execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA synchronous = NORMAL;
                 DROP INDEX IF EXISTS idx_native_session_events_runtime_seq;
                 CREATE TABLE IF NOT EXISTS native_session_events (
                     runtime_id TEXT NOT NULL,
                     seq INTEGER NOT NULL,
                     occurred_at TEXT NOT NULL,
                     payload_json TEXT NOT NULL,
                     created_at TEXT NOT NULL,
                     PRIMARY KEY(runtime_id, seq)
                 );
                 CREATE TABLE IF NOT EXISTS native_attention_summaries (
                     runtime_id TEXT PRIMARY KEY,
                     summary_json TEXT NOT NULL,
                     updated_at TEXT NOT NULL
                 );
                 PRAGMA optimize;",
            )
            .map_err(|error| format!("Failed to initialize native event log schema: {}", error))?;
            *guard = Some(conn);
        }

        let conn = guard
            .as_mut()
            .ok_or_else(|| "Native event log connection was not initialized".to_string())?;
        f(conn)
    }
}

fn todo_snapshot_from_payload(payload: &SessionEventPayload) -> Option<&TodoSnapshotV1> {
    match payload {
        SessionEventPayload::ToolUseStarted { todo_snapshot, .. }
        | SessionEventPayload::ToolUseCompleted { todo_snapshot, .. } => todo_snapshot.as_ref(),
        _ => None,
    }
}

fn load_or_seed_attention_summary(
    conn: &Connection,
    runtime_id: &str,
) -> Result<AttentionSummary, String> {
    let summary_json = conn
        .query_row(
            "SELECT summary_json FROM native_attention_summaries WHERE runtime_id = ?1",
            [runtime_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Failed to query native attention summary: {}", error))?;

    if let Some(summary_json) = summary_json {
        return serde_json::from_str(&summary_json)
            .map_err(|error| format!("Failed to parse native attention summary: {}", error));
    }

    if !runtime_has_events(conn, runtime_id)? {
        return Ok(AttentionSummary::default());
    }

    // Upgrade path: events exist but no summary row was persisted yet. Derive
    // it once from the bounded tail replay and persist the result so later
    // reads and writes stay O(1).
    eprintln!(
        "Deriving native attention summary for {} from event tail fallback",
        runtime_id
    );
    let tail = query_events_since(
        conn,
        runtime_id,
        None,
        Some(ATTENTION_SUMMARY_TAIL_FALLBACK_LIMIT),
    )?;
    let mut summary = AttentionSummary::default();
    for record in &tail {
        summary.apply(record);
    }
    persist_attention_summary(conn, runtime_id, &summary)?;
    Ok(summary)
}

fn persist_attention_summary(
    conn: &Connection,
    runtime_id: &str,
    summary: &AttentionSummary,
) -> Result<(), String> {
    let summary_json = serde_json::to_string(summary)
        .map_err(|error| format!("Failed to serialize native attention summary: {}", error))?;
    conn.execute(
        "INSERT OR REPLACE INTO native_attention_summaries (
            runtime_id,
            summary_json,
            updated_at
        ) VALUES (?1, ?2, ?3)",
        params![runtime_id, summary_json, Utc::now().to_rfc3339()],
    )
    .map_err(|error| format!("Failed to persist native attention summary: {}", error))?;
    Ok(())
}

fn runtime_has_events(conn: &Connection, runtime_id: &str) -> Result<bool, String> {
    let count = conn
        .query_row(
            "SELECT 1 FROM native_session_events WHERE runtime_id = ?1 LIMIT 1",
            [runtime_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("Failed to check native session event log: {}", error))?;
    Ok(count.is_some())
}

fn event_seq_bounds(
    conn: &Connection,
    runtime_id: &str,
) -> Result<(Option<u64>, Option<u64>), String> {
    let (oldest, newest) = conn
        .query_row(
            "SELECT MIN(seq), MAX(seq)
             FROM native_session_events
             WHERE runtime_id = ?1",
            [runtime_id],
            |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, Option<i64>>(1)?)),
        )
        .map_err(|error| format!("Failed to query native event sequence bounds: {}", error))?;

    Ok((
        oldest.and_then(non_negative_i64_to_u64),
        newest.and_then(non_negative_i64_to_u64),
    ))
}

fn query_events_since(
    conn: &Connection,
    runtime_id: &str,
    since_seq: Option<u64>,
    limit: Option<u64>,
) -> Result<Vec<SessionEventRecord>, String> {
    let mut records = Vec::new();

    if let Some(last_seen) = since_seq {
        let mut stmt = conn
            .prepare(
                "SELECT seq, occurred_at, payload_json
                 FROM native_session_events
                 WHERE runtime_id = ?1 AND seq > ?2
                 ORDER BY seq ASC",
            )
            .map_err(|error| format!("Failed to prepare native event replay: {}", error))?;
        let rows = stmt
            .query_map(params![runtime_id, last_seen as i64], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| format!("Failed to query native session events: {}", error))?;

        for row in rows {
            let row =
                row.map_err(|error| format!("Failed to read native session event row: {}", error))?;
            if let Some(record) = event_row_to_record_lossy(runtime_id, row) {
                records.push(record);
            }
        }
        return Ok(records);
    }

    if let Some(limit) = limit.filter(|value| *value > 0) {
        let mut stmt = conn
            .prepare(
                "WITH oldest AS (
                     SELECT MIN(seq) AS seq
                     FROM native_session_events
                     WHERE runtime_id = ?1
                 ),
                 tail AS (
                     SELECT seq
                     FROM native_session_events
                     WHERE runtime_id = ?1
                     ORDER BY seq DESC
                     LIMIT ?2
                 ),
                 latest_pre_tail_todo AS (
                     SELECT MAX(seq) AS seq
                     FROM native_session_events
                     WHERE runtime_id = ?1
                       AND seq < (SELECT MIN(seq) FROM tail)
                       AND payload_json LIKE '%\"todo_snapshot\"%'
                 )
                 SELECT seq, occurred_at, payload_json
                 FROM native_session_events
                 WHERE runtime_id = ?1
                   AND (
                     seq IN (SELECT seq FROM oldest)
                     OR seq IN (SELECT seq FROM tail)
                     OR seq IN (SELECT seq FROM latest_pre_tail_todo)
                     OR payload_json LIKE '{\"type\":\"user_prompt\"%'
                     OR payload_json LIKE '{\"type\":\"checkpoint_created\"%'
                     OR payload_json LIKE '{\"type\":\"files_rewound\"%'
                     OR payload_json LIKE '{\"type\":\"file_rewind_failed\"%'
                   )
                 ORDER BY seq ASC",
            )
            .map_err(|error| format!("Failed to prepare native event tail replay: {}", error))?;
        let rows = stmt
            .query_map(params![runtime_id, limit as i64], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| format!("Failed to query native session event tail: {}", error))?;

        for row in rows {
            let row =
                row.map_err(|error| format!("Failed to read native session event row: {}", error))?;
            if let Some(record) = event_row_to_record_lossy(runtime_id, row) {
                records.push(record);
            }
        }
        return Ok(records);
    }

    let mut stmt = conn
        .prepare(
            "SELECT seq, occurred_at, payload_json
             FROM native_session_events
             WHERE runtime_id = ?1
             ORDER BY seq ASC",
        )
        .map_err(|error| format!("Failed to prepare native event replay: {}", error))?;
    let rows = stmt
        .query_map([runtime_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| format!("Failed to query native session events: {}", error))?;

    for row in rows {
        let row =
            row.map_err(|error| format!("Failed to read native session event row: {}", error))?;
        if let Some(record) = event_row_to_record_lossy(runtime_id, row) {
            records.push(record);
        }
    }
    Ok(records)
}

fn event_row_to_record(
    runtime_id: &str,
    row: (i64, String, String),
) -> Result<SessionEventRecord, String> {
    let (seq, occurred_at, payload_json) = row;
    let seq = non_negative_i64_to_u64(seq)
        .ok_or_else(|| format!("Invalid native event sequence number: {}", seq))?;
    let occurred_at = DateTime::parse_from_rfc3339(&occurred_at)
        .map_err(|error| format!("Failed to parse native event timestamp: {}", error))?
        .with_timezone(&Utc);
    let payload = serde_json::from_str::<SessionEventPayload>(&payload_json)
        .map_err(|error| format!("Failed to parse native event payload: {}", error))?;

    Ok(SessionEventRecord {
        runtime_id: runtime_id.to_string(),
        seq,
        occurred_at,
        payload,
    })
}

/// Forward-compatible row conversion: persisted events written by a newer (or
/// older) helper may carry payload types this build does not know. One such
/// row must not blank the entire session replay — skip it with a warning and
/// keep serving the rest.
fn event_row_to_record_lossy(
    runtime_id: &str,
    row: (i64, String, String),
) -> Option<SessionEventRecord> {
    match event_row_to_record(runtime_id, row) {
        Ok(record) => Some(record),
        Err(error) => {
            eprintln!("Skipping unparsable native event for {runtime_id} during replay: {error}");
            None
        }
    }
}

fn non_negative_i64_to_u64(value: i64) -> Option<u64> {
    if value < 0 {
        None
    } else {
        Some(value as u64)
    }
}

fn replay_batch_is_truncated(
    events: &[SessionEventRecord],
    since_seq: Option<u64>,
    oldest_available_seq: Option<u64>,
    newest_available_seq: Option<u64>,
    gap_detected: bool,
) -> bool {
    if events.is_empty() {
        if gap_detected {
            return true;
        }
        let Some(newest_available_seq) = newest_available_seq else {
            return false;
        };
        return since_seq
            .map(|last_seen| last_seen < newest_available_seq)
            .unwrap_or(oldest_available_seq.is_some());
    }

    if gap_detected {
        return true;
    }

    let Some(newest_available_seq) = newest_available_seq else {
        return false;
    };

    let expected_first_seq = since_seq
        .map(|seq| seq.saturating_add(1))
        .or(oldest_available_seq);
    let Some(expected_first_seq) = expected_first_seq else {
        return false;
    };

    let Some(first_event) = events.first() else {
        return false;
    };
    let Some(last_event) = events.last() else {
        return false;
    };

    if first_event.seq != expected_first_seq || last_event.seq != newest_available_seq {
        return true;
    }

    let expected_len = newest_available_seq
        .saturating_sub(expected_first_seq)
        .saturating_add(1);
    if events.len() as u64 != expected_len {
        return true;
    }

    events.windows(2).any(|window| {
        let [previous, next] = window else {
            return false;
        };
        next.seq != previous.seq.saturating_add(1)
    })
}

fn limited_replay_unloaded_gap_starts(
    conn: &Connection,
    runtime_id: &str,
    events: &[SessionEventRecord],
) -> Result<Vec<u64>, String> {
    let mut unloaded_gap_starts = Vec::new();
    for window in events.windows(2) {
        let [previous, next] = window else {
            continue;
        };
        if next.seq <= previous.seq.saturating_add(1) {
            continue;
        }

        let contains_omitted_event = conn
            .query_row(
                "SELECT EXISTS(
                    SELECT 1
                    FROM native_session_events
                    WHERE runtime_id = ?1 AND seq > ?2 AND seq < ?3
                    LIMIT 1
                 )",
                params![runtime_id, previous.seq as i64, next.seq as i64],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| format!("Failed to classify native event replay gap: {}", error))?
            != 0;
        if contains_omitted_event {
            unloaded_gap_starts.push(next.seq);
        }
    }
    Ok(unloaded_gap_starts)
}

fn should_flush_after_append(payload: &SessionEventPayload) -> bool {
    match payload {
        SessionEventPayload::Lifecycle { stage, .. } => {
            matches!(stage.as_str(), "error" | "stopped" | "handoff")
        }
        SessionEventPayload::UserPrompt { .. }
        | SessionEventPayload::SessionCompleted { .. }
        | SessionEventPayload::PermissionRequired { .. }
        | SessionEventPayload::PermissionResponded { .. }
        | SessionEventPayload::TerminalPromptRequired { .. }
        | SessionEventPayload::TerminalPromptResolved { .. }
        | SessionEventPayload::CheckpointCreated { .. }
        | SessionEventPayload::FilesRewound { .. }
        | SessionEventPayload::FileRewindFailed { .. }
        | SessionEventPayload::TokenUsage { .. }
        | SessionEventPayload::ContextUsage { .. }
        | SessionEventPayload::SessionUsage { .. } => true,
        SessionEventPayload::ToolUseStarted {
            needs_response,
            todo_snapshot,
            ..
        } => *needs_response || todo_snapshot.is_some(),
        SessionEventPayload::ToolUseCompleted { .. } => true,
        _ => false,
    }
}

#[cfg(test)]
#[path = "native_event_log_todo_tests.rs"]
mod todo_tests;

#[cfg(test)]
#[path = "native_event_log_attention_tests.rs"]
mod attention_tests;

#[cfg(test)]
mod tests {
    use super::NativeEventLog;
    use crate::event_bus::{SessionEventPayload, SessionEventRecord};
    use crate::user_prompt_display::WRITE_TOOL_LIMIT_SYSTEM_TIP;
    use chrono::Utc;
    use rusqlite::Connection;

    #[test]
    fn native_event_log_replay_skips_unknown_payload_types() {
        // Forward compatibility: a payload type written by a different build
        // (e.g. `background_tasks_changed`) must not blank the whole replay.
        let db_path = std::env::temp_dir().join(format!(
            "ccem-native-event-log-unknown-{}.sqlite",
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        let log = NativeEventLog::new(db_path.clone());
        log.append(&SessionEventRecord {
            runtime_id: "runtime-unknown".to_string(),
            seq: 1,
            occurred_at: Utc::now(),
            payload: SessionEventPayload::AssistantChunk {
                text: "before".to_string(),
            },
        })
        .expect("append first");
        drop(log);

        // Hand-inject a row with a payload this build cannot decode.
        {
            let conn = Connection::open(&db_path).expect("open db");
            conn.execute(
                "INSERT INTO native_session_events (runtime_id, seq, occurred_at, payload_json, created_at)
                 VALUES ('runtime-unknown', 2, '2026-08-18T00:00:00+00:00', ?1, '2026-08-18T00:00:00+00:00')",
                ["{\"type\":\"background_tasks_changed\",\"count\":2}"],
            )
            .expect("inject unknown payload");
        }

        let reopened = NativeEventLog::new(db_path.clone());
        let replay = reopened
            .replay("runtime-unknown", None, None)
            .expect("replay must tolerate unknown payload rows");
        assert_eq!(replay.events.len(), 1);
        assert_eq!(replay.events[0].seq, 1);
        assert_eq!(replay.newest_available_seq, Some(2));

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn native_event_log_marks_nonempty_bounds_with_no_decodable_rows_truncated() {
        let db_path = std::env::temp_dir().join(format!(
            "ccem-native-event-log-all-invalid-{}.sqlite",
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        let log = NativeEventLog::new(db_path.clone());
        log.append(&SessionEventRecord {
            runtime_id: "runtime-all-invalid".to_string(),
            seq: 1,
            occurred_at: Utc::now(),
            payload: SessionEventPayload::AssistantChunk {
                text: "before-corruption".to_string(),
            },
        })
        .expect("append event");
        drop(log);

        let conn = Connection::open(&db_path).expect("open db");
        conn.execute(
            "UPDATE native_session_events SET payload_json = ?1 WHERE runtime_id = ?2",
            [
                "{\"type\":\"unknown-future-payload\"}",
                "runtime-all-invalid",
            ],
        )
        .expect("corrupt stored payload");
        drop(conn);

        let reopened = NativeEventLog::new(db_path.clone());
        let replay = reopened
            .replay("runtime-all-invalid", None, None)
            .expect("lossy replay");
        assert!(replay.events.is_empty());
        assert_eq!(replay.oldest_available_seq, Some(1));
        assert_eq!(replay.newest_available_seq, Some(1));
        assert!(replay.truncated);

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn native_event_log_replays_events_after_reopen() {
        let db_path = std::env::temp_dir().join(format!(
            "ccem-native-event-log-test-{}.sqlite",
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        let log = NativeEventLog::new(db_path.clone());
        let first = SessionEventRecord {
            runtime_id: "runtime-1".to_string(),
            seq: 1,
            occurred_at: Utc::now(),
            payload: SessionEventPayload::AssistantChunk {
                text: "hello".to_string(),
            },
        };
        let second = SessionEventRecord {
            runtime_id: "runtime-1".to_string(),
            seq: 2,
            occurred_at: Utc::now(),
            payload: SessionEventPayload::SessionCompleted {
                reason: "done".to_string(),
            },
        };

        log.append(&first).expect("append first");
        log.append(&second).expect("append second");
        drop(log);

        let reopened = NativeEventLog::new(db_path.clone());
        let replay = reopened.replay("runtime-1", Some(1), None).expect("replay");

        assert!(!replay.gap_detected);
        assert!(!replay.truncated);
        assert_eq!(replay.oldest_available_seq, Some(1));
        assert_eq!(replay.newest_available_seq, Some(2));
        assert_eq!(replay.events.len(), 1);
        assert_eq!(replay.events[0].seq, 2);

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn native_event_log_restores_the_full_first_user_prompt_after_reopen() {
        let db_path = std::env::temp_dir().join(format!(
            "ccem-native-event-log-first-prompt-test-{}.sqlite",
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        let log = NativeEventLog::new(db_path.clone());
        let runtime_id = "runtime-first-prompt";
        log.append(&SessionEventRecord {
            runtime_id: runtime_id.to_string(),
            seq: 1,
            occurred_at: Utc::now(),
            payload: SessionEventPayload::Lifecycle {
                stage: "runtime_boot".to_string(),
                detail: "Starting native runtime".to_string(),
                assistant_message_uuid: None,
            },
        })
        .expect("append lifecycle");
        log.append(&SessionEventRecord {
            runtime_id: runtime_id.to_string(),
            seq: 2,
            occurred_at: Utc::now(),
            payload: SessionEventPayload::UserPrompt {
                text: "   ".to_string(),
                image_count: 0,
                images: None,
                annotations: None,
                canonical_hash: None,
            },
        })
        .expect("append blank prompt");
        log.with_conn(|conn| {
            let now = Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO native_session_events
                 (runtime_id, seq, occurred_at, payload_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    runtime_id,
                    3_i64,
                    now,
                    "{\"type\":\"user_prompt\",not-valid-json",
                    Utc::now().to_rfc3339(),
                ],
            )
            .map_err(|error| format!("insert corrupt prompt fixture: {error}"))?;
            Ok(())
        })
        .expect("insert corrupt prompt fixture");
        log.append(&SessionEventRecord {
            runtime_id: runtime_id.to_string(),
            seq: 4,
            occurred_at: Utc::now(),
            payload: SessionEventPayload::UserPrompt {
                text: format!(
                    "<system_tip>{WRITE_TOOL_LIMIT_SYSTEM_TIP}</system_tip>\n\n  第一行\n\n第二行 {}  ",
                    "很长的内容".repeat(80),
                ),
                image_count: 0,
                images: None,
                annotations: None,
                canonical_hash: None,
            },
        })
        .expect("append first visible prompt");
        log.append(&SessionEventRecord {
            runtime_id: runtime_id.to_string(),
            seq: 5,
            occurred_at: Utc::now(),
            payload: SessionEventPayload::UserPrompt {
                text: "后续消息不能替代首条消息".to_string(),
                image_count: 0,
                images: None,
                annotations: None,
                canonical_hash: None,
            },
        })
        .expect("append later prompt");
        drop(log);

        let reopened = NativeEventLog::new(db_path.clone());
        let prompts = reopened
            .first_user_prompts(&[runtime_id.to_string(), "missing".to_string()])
            .expect("restore first user prompts");
        let prompt = prompts.get(runtime_id).expect("first user prompt");

        assert_eq!(
            prompt,
            &format!("第一行\n\n第二行 {}", "很长的内容".repeat(80)),
        );
        assert!(!prompt.contains("后续消息"));
        assert!(!prompts.contains_key("missing"));

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn native_event_log_does_not_negative_cache_prompts_written_by_another_log() {
        let db_path = std::env::temp_dir().join(format!(
            "ccem-native-event-log-first-prompt-cache-test-{}.sqlite",
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        let observer = NativeEventLog::new(db_path.clone());
        let runtime_id = "runtime-first-prompt-cache";

        assert!(observer
            .first_user_prompts(&[runtime_id.to_string()])
            .expect("read missing prompt")
            .is_empty());
        assert!(!observer
            .first_user_prompt_cache
            .lock()
            .expect("lock first prompt cache")
            .contains_key(runtime_id));

        let writer = NativeEventLog::new(db_path.clone());
        writer
            .append(&SessionEventRecord {
                runtime_id: runtime_id.to_string(),
                seq: 1,
                occurred_at: Utc::now(),
                payload: SessionEventPayload::UserPrompt {
                    text: "后来抵达的第一条用户消息".to_string(),
                    image_count: 0,
                    images: None,
                    annotations: None,
                    canonical_hash: None,
                },
            })
            .expect("append user prompt from another event log");
        assert_eq!(
            observer
                .first_user_prompts(&[runtime_id.to_string()])
                .expect("observe newly persisted prompt")
                .get(runtime_id),
            Some(&"后来抵达的第一条用户消息".to_string()),
        );

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn native_event_log_pending_since_counts_events_after_seq() {
        let db_path = std::env::temp_dir().join(format!(
            "ccem-native-event-log-pending-test-{}.sqlite",
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        let log = NativeEventLog::new(db_path.clone());
        let runtime_id = "runtime-pending";

        for seq in 1..=3 {
            log.append(&SessionEventRecord {
                runtime_id: runtime_id.to_string(),
                seq,
                occurred_at: Utc::now(),
                payload: SessionEventPayload::AssistantChunk {
                    text: format!("chunk-{seq}"),
                },
            })
            .expect("append chunk");
        }

        // Nothing pending after the newest seq; bounds still report the full range.
        let (count, oldest, newest) = log
            .pending_since(runtime_id, Some(3))
            .expect("pending_since at newest");
        assert_eq!(count, 0);
        assert_eq!(oldest, Some(1));
        assert_eq!(newest, Some(3));

        // Two events pending after seq 1; newest stays the global max.
        let (count, oldest, newest) = log
            .pending_since(runtime_id, Some(1))
            .expect("pending_since mid-range");
        assert_eq!(count, 2);
        assert_eq!(oldest, Some(1));
        assert_eq!(newest, Some(3));

        // Unknown runtime: no count, no bounds.
        let (count, oldest, newest) = log
            .pending_since("runtime-other", None)
            .expect("pending_since unknown runtime");
        assert_eq!(count, 0);
        assert_eq!(oldest, None);
        assert_eq!(newest, None);

        // Bounds match what a full empty replay reports, so the zero-pending
        // fast path can reuse them to build an identical empty batch.
        let (_, pending_oldest, pending_newest) = log
            .pending_since(runtime_id, Some(3))
            .expect("pending_since for parity check");
        let replay = log
            .replay(runtime_id, Some(3), None)
            .expect("replay at newest");
        assert!(replay.events.is_empty());
        assert!(!replay.gap_detected);
        assert!(!replay.truncated);
        assert_eq!(replay.oldest_available_seq, pending_oldest);
        assert_eq!(replay.newest_available_seq, pending_newest);

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn native_event_log_preserves_raw_jsonl_payloads() {
        let db_path = std::env::temp_dir().join(format!(
            "ccem-native-event-log-jsonl-test-{}.sqlite",
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        let raw_json = serde_json::json!({
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "text", "text": "hello"},
                    {"type": "tool_use", "id": "toolu-1", "name": "Bash", "input": {"command": "npm test"}}
                ]
            }
        })
        .to_string();
        let log = NativeEventLog::new(db_path.clone());

        log.append(&SessionEventRecord {
            runtime_id: "runtime-jsonl".to_string(),
            seq: 1,
            occurred_at: Utc::now(),
            payload: SessionEventPayload::ClaudeJson {
                message_type: Some("assistant".to_string()),
                raw_json: raw_json.clone(),
            },
        })
        .expect("append raw jsonl payload");

        let replay = log.replay("runtime-jsonl", None, None).expect("replay all");
        assert!(!replay.truncated);
        assert_eq!(replay.events.len(), 1);
        assert_eq!(
            replay.events[0].payload,
            SessionEventPayload::ClaudeJson {
                message_type: Some("assistant".to_string()),
                raw_json,
            }
        );

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn native_event_log_flushes_pending_records_before_limited_replay() {
        let db_path = std::env::temp_dir().join(format!(
            "ccem-native-event-log-tail-test-{}.sqlite",
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        let log = NativeEventLog::new(db_path.clone());

        for seq in 1..=5 {
            log.append(&SessionEventRecord {
                runtime_id: "runtime-tail".to_string(),
                seq,
                occurred_at: Utc::now(),
                payload: SessionEventPayload::AssistantChunk {
                    text: format!("chunk-{seq}"),
                },
            })
            .expect("append chunk");
        }

        let replay = log
            .replay("runtime-tail", None, Some(2))
            .expect("replay tail");
        assert!(replay.truncated);
        assert_eq!(replay.oldest_available_seq, Some(1));
        assert_eq!(replay.newest_available_seq, Some(5));
        assert_eq!(
            replay
                .events
                .iter()
                .map(|event| event.seq)
                .collect::<Vec<_>>(),
            vec![1, 4, 5],
        );
        assert_eq!(replay.unloaded_gap_starts, vec![4]);

        let conn = Connection::open(&db_path).expect("open sqlite db");
        let duplicate_index_exists = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_native_session_events_runtime_seq'",
                [],
                |_| Ok(true),
            )
            .unwrap_or(false);
        assert!(!duplicate_index_exists);

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn native_event_log_does_not_suppress_a_real_hole_in_limited_replay() {
        let db_path = std::env::temp_dir().join(format!(
            "ccem-native-event-log-real-hole-test-{}.sqlite",
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        let log = NativeEventLog::new(db_path.clone());

        for seq in [1, 4, 5] {
            log.append(&SessionEventRecord {
                runtime_id: "runtime-real-hole".to_string(),
                seq,
                occurred_at: Utc::now(),
                payload: SessionEventPayload::AssistantChunk {
                    text: format!("chunk-{seq}"),
                },
            })
            .expect("append sparse chunk");
        }

        let replay = log
            .replay("runtime-real-hole", None, Some(2))
            .expect("replay sparse tail");

        assert!(replay.truncated);
        assert_eq!(
            replay
                .events
                .iter()
                .map(|event| event.seq)
                .collect::<Vec<_>>(),
            vec![1, 4, 5],
        );
        assert!(replay.unloaded_gap_starts.is_empty());

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn native_event_log_does_not_mark_complete_limited_replay_truncated() {
        let db_path = std::env::temp_dir().join(format!(
            "ccem-native-event-log-complete-tail-test-{}.sqlite",
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        let log = NativeEventLog::new(db_path.clone());

        for seq in 1..=3 {
            log.append(&SessionEventRecord {
                runtime_id: "runtime-complete-tail".to_string(),
                seq,
                occurred_at: Utc::now(),
                payload: SessionEventPayload::AssistantChunk {
                    text: format!("chunk-{seq}"),
                },
            })
            .expect("append chunk");
        }

        let replay = log
            .replay("runtime-complete-tail", None, Some(10))
            .expect("replay complete tail");

        assert!(!replay.truncated);
        assert_eq!(
            replay
                .events
                .iter()
                .map(|event| event.seq)
                .collect::<Vec<_>>(),
            vec![1, 2, 3],
        );

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn native_event_log_keeps_user_prompt_anchors_in_limited_replay() {
        let db_path = std::env::temp_dir().join(format!(
            "ccem-native-event-log-user-anchor-test-{}.sqlite",
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        let log = NativeEventLog::new(db_path.clone());

        log.append(&SessionEventRecord {
            runtime_id: "runtime-tail-anchor".to_string(),
            seq: 1,
            occurred_at: Utc::now(),
            payload: SessionEventPayload::UserPrompt {
                text: "start here".to_string(),
                image_count: 0,
                images: None,
                annotations: None,
                canonical_hash: None,
            },
        })
        .expect("append prompt");

        for seq in 2..=5 {
            log.append(&SessionEventRecord {
                runtime_id: "runtime-tail-anchor".to_string(),
                seq,
                occurred_at: Utc::now(),
                payload: SessionEventPayload::AssistantChunk {
                    text: format!("chunk-{seq}"),
                },
            })
            .expect("append chunk");
        }

        let replay = log
            .replay("runtime-tail-anchor", None, Some(2))
            .expect("replay tail");

        assert!(replay.truncated);
        assert_eq!(
            replay
                .events
                .iter()
                .map(|event| event.seq)
                .collect::<Vec<_>>(),
            vec![1, 4, 5],
        );

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn native_event_log_keeps_oldest_runtime_anchor_in_limited_replay() {
        let db_path = std::env::temp_dir().join(format!(
            "ccem-native-event-log-oldest-anchor-test-{}.sqlite",
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        let log = NativeEventLog::new(db_path.clone());

        log.append(&SessionEventRecord {
            runtime_id: "runtime-oldest-anchor".to_string(),
            seq: 1,
            occurred_at: Utc::now(),
            payload: SessionEventPayload::Lifecycle {
                stage: "runtime_boot".to_string(),
                detail: "Starting claude native runtime.".to_string(),
                assistant_message_uuid: None,
            },
        })
        .expect("append runtime anchor");

        log.append(&SessionEventRecord {
            runtime_id: "runtime-oldest-anchor".to_string(),
            seq: 2,
            occurred_at: Utc::now(),
            payload: SessionEventPayload::UserPrompt {
                text: "start here".to_string(),
                image_count: 0,
                images: None,
                annotations: None,
                canonical_hash: None,
            },
        })
        .expect("append prompt");

        for seq in 3..=5 {
            log.append(&SessionEventRecord {
                runtime_id: "runtime-oldest-anchor".to_string(),
                seq,
                occurred_at: Utc::now(),
                payload: SessionEventPayload::AssistantChunk {
                    text: format!("chunk-{seq}"),
                },
            })
            .expect("append chunk");
        }

        let replay = log
            .replay("runtime-oldest-anchor", None, Some(1))
            .expect("replay tail");

        assert!(replay.truncated);
        assert_eq!(
            replay
                .events
                .iter()
                .map(|event| event.seq)
                .collect::<Vec<_>>(),
            vec![1, 2, 5],
        );

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn native_event_log_keeps_checkpoint_anchors_in_limited_replay() {
        let db_path = std::env::temp_dir().join(format!(
            "ccem-native-event-log-checkpoint-anchor-test-{}.sqlite",
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        let log = NativeEventLog::new(db_path.clone());
        let runtime_id = "runtime-checkpoint-anchor";

        log.append(&SessionEventRecord {
            runtime_id: runtime_id.to_string(),
            seq: 1,
            occurred_at: Utc::now(),
            payload: SessionEventPayload::CheckpointCreated {
                provider: "claude".to_string(),
                checkpoint_id: "checkpoint-1".to_string(),
                provider_session_id: Some("session-1".to_string()),
                prompt_summary: Some("edit example".to_string()),
                source: "claude-file-checkpoint".to_string(),
            },
        })
        .expect("append checkpoint");
        log.append(&SessionEventRecord {
            runtime_id: runtime_id.to_string(),
            seq: 2,
            occurred_at: Utc::now(),
            payload: SessionEventPayload::FilesRewound {
                provider: "claude".to_string(),
                checkpoint_id: "checkpoint-1".to_string(),
                files_changed: vec!["example.txt".to_string()],
                insertions: Some(0),
                deletions: Some(1),
            },
        })
        .expect("append rewind");
        log.append(&SessionEventRecord {
            runtime_id: runtime_id.to_string(),
            seq: 3,
            occurred_at: Utc::now(),
            payload: SessionEventPayload::FileRewindFailed {
                provider: "claude".to_string(),
                checkpoint_id: "checkpoint-2".to_string(),
                error: "missing checkpoint".to_string(),
            },
        })
        .expect("append rewind failure");

        for seq in 4..=7 {
            log.append(&SessionEventRecord {
                runtime_id: runtime_id.to_string(),
                seq,
                occurred_at: Utc::now(),
                payload: SessionEventPayload::AssistantChunk {
                    text: format!("chunk-{seq}"),
                },
            })
            .expect("append chunk");
        }

        let replay = log.replay(runtime_id, None, Some(2)).expect("replay tail");

        assert!(replay.truncated);
        assert_eq!(
            replay
                .events
                .iter()
                .map(|event| event.seq)
                .collect::<Vec<_>>(),
            vec![1, 2, 3, 6, 7],
        );

        let _ = std::fs::remove_file(db_path);
    }
}
