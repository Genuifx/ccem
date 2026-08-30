use crate::event_bus::{
    NativeEventReplayPage, ReplayBatch, SessionEventPayload, SessionEventRecord, TodoSnapshotV1,
};
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
pub(crate) const MAX_EVENT_REPLAY_PAGE_SIZE: u64 = 2000;
pub(crate) const MAX_EVENT_REPLAY_PAGE_BYTES: usize = 512 * 1024;
// Leave ample room for the page fields, JSON keys, array delimiters, and
// numeric values. Event records are measured with serde_json before inclusion,
// and the completed page is checked again before it leaves Rust.
const EVENT_REPLAY_PAGE_ENVELOPE_BYTES: usize = 4 * 1024;

pub(crate) struct BoundedDecodedEventPage {
    pub events: Vec<SessionEventRecord>,
    pub next_cursor: Option<u64>,
    pub has_more: bool,
    pub oversized_event_count: u64,
}

pub(crate) fn validate_event_replay_page_request(
    after_seq: Option<u64>,
    snapshot_newest_seq: Option<u64>,
) -> Result<(), String> {
    if let (Some(after), Some(snapshot)) = (after_seq, snapshot_newest_seq) {
        if after > snapshot {
            return Err("after_seq cannot be greater than snapshot_newest_seq".to_string());
        }
    }
    if let Some(after) = after_seq {
        sqlite_i64_from_u64(after, "after_seq")?;
    }
    if let Some(snapshot) = snapshot_newest_seq {
        sqlite_i64_from_u64(snapshot, "snapshot_newest_seq")?;
    }
    Ok(())
}

pub(crate) fn bound_decoded_event_page(
    records: Vec<SessionEventRecord>,
    limit: u64,
) -> Result<BoundedDecodedEventPage, String> {
    let page_size = limit.clamp(1, MAX_EVENT_REPLAY_PAGE_SIZE) as usize;
    let event_budget = MAX_EVENT_REPLAY_PAGE_BYTES.saturating_sub(EVENT_REPLAY_PAGE_ENVELOPE_BYTES);
    let mut events = Vec::with_capacity(records.len().min(page_size));
    let mut serialized_event_bytes = 0_usize;
    let mut next_cursor = None;
    let mut oversized_event_count = 0_u64;
    let mut scanned_rows = 0_usize;
    let mut has_more = false;

    for record in records {
        if scanned_rows >= page_size {
            has_more = true;
            break;
        }

        let record_bytes = serialized_event_size(&record)?;
        let record_with_delimiter = record_bytes.saturating_add(1);
        if record_with_delimiter > event_budget {
            scanned_rows += 1;
            next_cursor = Some(record.seq);
            oversized_event_count = oversized_event_count.saturating_add(1);
            continue;
        }
        if serialized_event_bytes.saturating_add(record_with_delimiter) > event_budget {
            has_more = true;
            break;
        }

        scanned_rows += 1;
        serialized_event_bytes = serialized_event_bytes.saturating_add(record_with_delimiter);
        next_cursor = Some(record.seq);
        events.push(record);
    }

    Ok(BoundedDecodedEventPage {
        events,
        next_cursor,
        has_more,
        oversized_event_count,
    })
}

pub(crate) fn ensure_event_replay_page_size(page: &NativeEventReplayPage) -> Result<(), String> {
    let serialized_bytes = serde_json::to_vec(page)
        .map_err(|error| format!("Failed to measure native event page: {}", error))?
        .len();
    if serialized_bytes > MAX_EVENT_REPLAY_PAGE_BYTES {
        return Err(format!(
            "Native event page exceeded serialized byte budget: {} > {}",
            serialized_bytes, MAX_EVENT_REPLAY_PAGE_BYTES
        ));
    }
    Ok(())
}

fn serialized_event_size(record: &SessionEventRecord) -> Result<usize, String> {
    serde_json::to_vec(record)
        .map(|json| json.len())
        .map_err(|error| format!("Failed to measure native event record: {}", error))
}

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

    /// Read a bounded forward page from a fixed event-sequence snapshot.
    ///
    /// A request that omits `snapshot_newest_seq` starts a new snapshot and may
    /// still carry `after_seq` for incremental replay. The returned bound must
    /// be echoed by every later request. This makes backfill finite even while
    /// a live runtime continues appending events. The cursor advances by raw
    /// SQLite rows rather than decoded events, so an unreadable row cannot
    /// trap the caller in an infinite retry loop.
    pub fn replay_page(
        &self,
        runtime_id: &str,
        after_seq: Option<u64>,
        snapshot_newest_seq: Option<u64>,
        limit: u64,
    ) -> Result<NativeEventReplayPage, String> {
        validate_event_replay_page_request(after_seq, snapshot_newest_seq)?;
        self.flush_pending()?;
        self.with_conn(|conn| {
            let (oldest_available_seq, current_newest_seq) = event_seq_bounds(conn, runtime_id)?;
            // A supplied snapshot is immutable. If persisted rows disappear
            // between calls, retain the original bound and report the missing
            // tail as a real gap instead of silently shrinking the snapshot.
            let snapshot_newest_seq = snapshot_newest_seq.or(current_newest_seq);
            let Some(snapshot_newest_seq) = snapshot_newest_seq else {
                let page = NativeEventReplayPage {
                    source_available: true,
                    gap_detected: false,
                    decode_failure_count: 0,
                    oversized_event_count: 0,
                    oldest_available_seq,
                    snapshot_newest_seq: None,
                    next_cursor: None,
                    has_more: false,
                    events: Vec::new(),
                };
                ensure_event_replay_page_size(&page)?;
                return Ok(page);
            };
            // The initial request can supply a cursor before the snapshot is
            // known. Once bound, it must obey the same cursor ordering as a
            // continuation request.
            validate_event_replay_page_request(after_seq, Some(snapshot_newest_seq))?;

            let page_size = limit.clamp(1, MAX_EVENT_REPLAY_PAGE_SIZE);
            let after_seq_i64 = sqlite_i64_from_u64(after_seq.unwrap_or(0), "after_seq")?;
            let snapshot_newest_seq_i64 =
                sqlite_i64_from_u64(snapshot_newest_seq, "snapshot_newest_seq")?;
            let row_limit_i64 =
                sqlite_i64_from_u64(page_size.saturating_add(1), "native event page row limit")?;
            let scan = scan_event_page_rows(
                conn,
                runtime_id,
                after_seq_i64,
                snapshot_newest_seq_i64,
                after_seq.map(|seq| seq.saturating_add(1)).or(Some(1)),
                snapshot_newest_seq,
                page_size as usize,
                row_limit_i64,
            )?;

            let page = NativeEventReplayPage {
                source_available: true,
                gap_detected: scan.gap_detected,
                decode_failure_count: scan.decode_failure_count,
                oversized_event_count: scan.oversized_event_count,
                oldest_available_seq,
                snapshot_newest_seq: Some(snapshot_newest_seq),
                next_cursor: scan.next_cursor,
                has_more: scan.has_more,
                events: scan.events,
            };
            ensure_event_replay_page_size(&page)?;
            Ok(page)
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
            let since = since_seq
                .map(|seq| sqlite_i64_from_u64(seq, "since_seq"))
                .transpose()?;
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
                    let seq = sqlite_i64_from_u64(record.seq, "native event sequence")?;
                    stmt.execute(params![
                        record.runtime_id,
                        seq,
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
        let last_seen_i64 = sqlite_i64_from_u64(last_seen, "since_seq")?;
        if let Some(limit) = limit.filter(|value| *value > 0) {
            let limit_i64 = sqlite_i64_from_u64(limit, "event replay limit")?;
            let mut stmt = conn
                .prepare(
                    "SELECT seq, occurred_at, payload_json
                     FROM native_session_events
                     WHERE runtime_id = ?1 AND seq > ?2
                     ORDER BY seq ASC
                     LIMIT ?3",
                )
                .map_err(|error| {
                    format!("Failed to prepare limited native event replay: {}", error)
                })?;
            let rows = stmt
                .query_map(params![runtime_id, last_seen_i64, limit_i64], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(|error| {
                    format!("Failed to query limited native session events: {}", error)
                })?;

            for row in rows {
                let row = row.map_err(|error| {
                    format!("Failed to read limited native session event row: {}", error)
                })?;
                if let Some(record) = event_row_to_record_lossy(runtime_id, row) {
                    records.push(record);
                }
            }
        } else {
            let mut stmt = conn
                .prepare(
                    "SELECT seq, occurred_at, payload_json
                     FROM native_session_events
                     WHERE runtime_id = ?1 AND seq > ?2
                     ORDER BY seq ASC",
                )
                .map_err(|error| format!("Failed to prepare native event replay: {}", error))?;
            let rows = stmt
                .query_map(params![runtime_id, last_seen_i64], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(|error| format!("Failed to query native session events: {}", error))?;

            for row in rows {
                let row = row.map_err(|error| {
                    format!("Failed to read native session event row: {}", error)
                })?;
                if let Some(record) = event_row_to_record_lossy(runtime_id, row) {
                    records.push(record);
                }
            }
        }
        return Ok(records);
    }

    if let Some(limit) = limit.filter(|value| *value > 0) {
        let limit_i64 = sqlite_i64_from_u64(limit, "event replay limit")?;
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
            .query_map(params![runtime_id, limit_i64], |row| {
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

struct PersistedEventPageScan {
    gap_detected: bool,
    decode_failure_count: u64,
    oversized_event_count: u64,
    next_cursor: Option<u64>,
    has_more: bool,
    events: Vec<SessionEventRecord>,
}

#[allow(clippy::too_many_arguments)]
fn scan_event_page_rows(
    conn: &Connection,
    runtime_id: &str,
    after_seq: i64,
    snapshot_newest_seq_i64: i64,
    expected_first_seq: Option<u64>,
    snapshot_newest_seq: u64,
    page_size: usize,
    row_limit: i64,
) -> Result<PersistedEventPageScan, String> {
    let event_budget = MAX_EVENT_REPLAY_PAGE_BYTES.saturating_sub(EVENT_REPLAY_PAGE_ENVELOPE_BYTES);
    let event_budget_i64 = i64::try_from(event_budget)
        .map_err(|_| "Native event page byte budget exceeds SQLite range".to_string())?;
    let mut metadata_stmt = conn
        .prepare(
            "SELECT seq,
                    occurred_at,
                    length(CAST(payload_json AS BLOB)),
                    CASE
                      WHEN length(CAST(payload_json AS BLOB)) <= ?5 THEN payload_json
                      ELSE NULL
                    END
             FROM native_session_events
             WHERE runtime_id = ?1 AND seq > ?2 AND seq <= ?3
             ORDER BY seq ASC
             LIMIT ?4",
        )
        .map_err(|error| format!("Failed to prepare native event page: {}", error))?;
    let mut rows = metadata_stmt
        .query(params![
            runtime_id,
            after_seq,
            snapshot_newest_seq_i64,
            row_limit,
            event_budget_i64
        ])
        .map_err(|error| format!("Failed to query native event page: {}", error))?;

    let mut serialized_event_bytes = 0_usize;
    let mut scanned_rows = 0_usize;
    let mut previous_raw_seq = None;
    let mut next_cursor = None;
    let mut has_more = false;
    let mut gap_detected = false;
    let mut decode_failure_count = 0_u64;
    let mut oversized_event_count = 0_u64;
    let mut events = Vec::with_capacity(page_size);

    while let Some(row) = rows
        .next()
        .map_err(|error| format!("Failed to read native event page metadata: {}", error))?
    {
        if scanned_rows >= page_size {
            has_more = true;
            break;
        }

        let seq_i64 = row
            .get::<_, i64>(0)
            .map_err(|error| format!("Failed to read native event page sequence: {}", error))?;
        let seq = non_negative_i64_to_u64(seq_i64)
            .ok_or_else(|| format!("Invalid native event sequence number: {}", seq_i64))?;
        let occurred_at = row
            .get::<_, String>(1)
            .map_err(|error| format!("Failed to read native event page timestamp: {}", error))?;
        let payload_bytes = row
            .get::<_, i64>(2)
            .map_err(|error| format!("Failed to read native event payload length: {}", error))?;
        let payload_bytes = usize::try_from(payload_bytes).unwrap_or(usize::MAX);

        let row_has_gap = previous_raw_seq
            .map(|previous: u64| seq != previous.saturating_add(1))
            .or_else(|| expected_first_seq.map(|expected| seq != expected))
            .unwrap_or(false);

        // A payload that cannot possibly fit is counted and skipped without
        // copying its body from SQLite into Rust. The raw cursor still moves.
        if payload_bytes > event_budget {
            scanned_rows += 1;
            gap_detected |= row_has_gap;
            previous_raw_seq = Some(seq);
            next_cursor = Some(seq);
            oversized_event_count = oversized_event_count.saturating_add(1);
            continue;
        }

        let payload_json = row
            .get::<_, Option<String>>(3)
            .map_err(|error| format!("Failed to read native event payload: {}", error))?
            .ok_or_else(|| "Native event payload was unexpectedly omitted".to_string())?;
        let record = event_row_to_record_lossy(runtime_id, (seq_i64, occurred_at, payload_json));
        let Some(record) = record else {
            scanned_rows += 1;
            gap_detected |= row_has_gap;
            previous_raw_seq = Some(seq);
            next_cursor = Some(seq);
            decode_failure_count = decode_failure_count.saturating_add(1);
            continue;
        };

        let record_with_delimiter = serialized_event_size(&record)?.saturating_add(1);
        if record_with_delimiter > event_budget {
            scanned_rows += 1;
            gap_detected |= row_has_gap;
            previous_raw_seq = Some(seq);
            next_cursor = Some(seq);
            oversized_event_count = oversized_event_count.saturating_add(1);
            continue;
        }
        if serialized_event_bytes.saturating_add(record_with_delimiter) > event_budget {
            has_more = true;
            break;
        }

        scanned_rows += 1;
        serialized_event_bytes = serialized_event_bytes.saturating_add(record_with_delimiter);
        gap_detected |= row_has_gap;
        previous_raw_seq = Some(seq);
        next_cursor = Some(seq);
        events.push(record);
    }

    // Exhausting the query below the immutable snapshot means persisted rows
    // are missing at the tail. Byte/count pagination is normal and reports
    // has_more instead, so it must not be mistaken for corruption.
    if !has_more {
        let scanned_through =
            next_cursor.or_else(|| expected_first_seq.map(|seq| seq.saturating_sub(1)));
        if scanned_through.is_some_and(|seq| seq < snapshot_newest_seq) {
            gap_detected = true;
        }
    }

    Ok(PersistedEventPageScan {
        gap_detected,
        decode_failure_count,
        oversized_event_count,
        next_cursor,
        has_more,
        events,
    })
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

fn sqlite_i64_from_u64(value: u64, field: &str) -> Result<i64, String> {
    i64::try_from(value).map_err(|_| {
        format!(
            "{} exceeds SQLite's signed 64-bit integer range: {}",
            field, value
        )
    })
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
        let previous_seq = sqlite_i64_from_u64(previous.seq, "native event sequence")?;
        let next_seq = sqlite_i64_from_u64(next.seq, "native event sequence")?;

        let contains_omitted_event = conn
            .query_row(
                "SELECT EXISTS(
                    SELECT 1
                    FROM native_session_events
                    WHERE runtime_id = ?1 AND seq > ?2 AND seq < ?3
                    LIMIT 1
                 )",
                params![runtime_id, previous_seq, next_seq],
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
        | SessionEventPayload::InteractiveResponseResult { .. }
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
    use super::{NativeEventLog, MAX_EVENT_REPLAY_PAGE_BYTES};
    use crate::event_bus::{SessionEventPayload, SessionEventRecord};
    use crate::user_prompt_display::WRITE_TOOL_LIMIT_SYSTEM_TIP;
    use chrono::Utc;
    use rusqlite::Connection;

    fn replay_page_test_record(runtime_id: &str, seq: u64) -> SessionEventRecord {
        SessionEventRecord {
            runtime_id: runtime_id.to_string(),
            seq,
            occurred_at: Utc::now(),
            payload: SessionEventPayload::AssistantChunk {
                text: format!("chunk-{seq}"),
            },
        }
    }

    #[test]
    fn native_event_log_page_skips_one_oversized_row_and_keeps_a_hard_response_limit() {
        let db_path = std::env::temp_dir().join(format!(
            "ccem-native-event-page-oversized-{}-{}.sqlite",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        let runtime_id = "runtime-page-oversized";
        let log = NativeEventLog::new(db_path.clone());
        log.append(&SessionEventRecord {
            runtime_id: runtime_id.to_string(),
            seq: 1,
            occurred_at: Utc::now(),
            payload: SessionEventPayload::AssistantChunk {
                text: "x".repeat(MAX_EVENT_REPLAY_PAGE_BYTES + 1024),
            },
        })
        .expect("append oversized event");
        log.append(&replay_page_test_record(runtime_id, 2))
            .expect("append readable event");

        let page = log
            .replay_page(runtime_id, None, None, 10)
            .expect("oversized page");
        assert_eq!(page.oversized_event_count, 1);
        assert_eq!(page.decode_failure_count, 0);
        assert_eq!(page.next_cursor, Some(2));
        assert!(!page.has_more);
        assert!(!page.gap_detected);
        assert_eq!(
            page.events
                .iter()
                .map(|event| event.seq)
                .collect::<Vec<_>>(),
            vec![2],
        );
        assert!(
            serde_json::to_vec(&page).expect("serialize page").len() <= MAX_EVENT_REPLAY_PAGE_BYTES
        );

        drop(log);
        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn native_event_log_page_stops_lazy_scan_at_the_byte_budget() {
        let db_path = std::env::temp_dir().join(format!(
            "ccem-native-event-page-many-large-{}-{}.sqlite",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        let runtime_id = "runtime-page-many-large";
        let log = NativeEventLog::new(db_path.clone());
        for seq in 1..=2001 {
            log.append(&SessionEventRecord {
                runtime_id: runtime_id.to_string(),
                seq,
                occurred_at: Utc::now(),
                payload: SessionEventPayload::AssistantChunk {
                    text: "x".repeat(4 * 1024),
                },
            })
            .expect("append large event");
        }

        let page = log
            .replay_page(runtime_id, None, None, 2000)
            .expect("byte-bounded page");
        assert!(page.has_more);
        assert_eq!(page.oversized_event_count, 0);
        assert!(!page.events.is_empty());
        assert!(page.events.len() < 2000);
        assert_eq!(page.next_cursor, page.events.last().map(|event| event.seq));
        assert!(
            serde_json::to_vec(&page).expect("serialize page").len() <= MAX_EVENT_REPLAY_PAGE_BYTES
        );

        drop(log);
        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn native_event_log_page_reports_a_missing_runtime_head() {
        let db_path = std::env::temp_dir().join(format!(
            "ccem-native-event-page-head-gap-{}-{}.sqlite",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        let runtime_id = "runtime-page-head-gap";
        let log = NativeEventLog::new(db_path.clone());
        for seq in 2..=3 {
            log.append(&replay_page_test_record(runtime_id, seq))
                .expect("append event after missing head");
        }

        let page = log
            .replay_page(runtime_id, None, None, 10)
            .expect("head-gapped page");
        assert_eq!(page.oldest_available_seq, Some(2));
        assert!(page.gap_detected);

        drop(log);
        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn native_event_log_pages_a_fixed_snapshot_while_new_events_arrive() {
        let db_path = std::env::temp_dir().join(format!(
            "ccem-native-event-page-snapshot-{}.sqlite",
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        let runtime_id = "runtime-page-snapshot";
        let log = NativeEventLog::new(db_path.clone());
        for seq in 1..=5 {
            log.append(&replay_page_test_record(runtime_id, seq))
                .expect("append snapshot event");
        }

        let first = log
            .replay_page(runtime_id, None, None, 2)
            .expect("first page");
        assert_eq!(first.snapshot_newest_seq, Some(5));
        assert_eq!(first.next_cursor, Some(2));
        assert!(first.has_more);
        assert!(!first.gap_detected);
        assert_eq!(
            first
                .events
                .iter()
                .map(|event| event.seq)
                .collect::<Vec<_>>(),
            vec![1, 2],
        );

        // This row is visible to live polling, but must not move the frozen
        // history snapshot or make pagination chase a moving tail.
        log.append(&replay_page_test_record(runtime_id, 6))
            .expect("append live event");
        let second = log
            .replay_page(runtime_id, first.next_cursor, first.snapshot_newest_seq, 2)
            .expect("second page");
        assert_eq!(second.snapshot_newest_seq, Some(5));
        assert_eq!(second.next_cursor, Some(4));
        assert!(second.has_more);
        assert_eq!(
            second
                .events
                .iter()
                .map(|event| event.seq)
                .collect::<Vec<_>>(),
            vec![3, 4],
        );
        let third = log
            .replay_page(
                runtime_id,
                second.next_cursor,
                second.snapshot_newest_seq,
                2,
            )
            .expect("third page");
        assert_eq!(third.snapshot_newest_seq, Some(5));
        assert_eq!(third.next_cursor, Some(5));
        assert!(!third.has_more);
        assert_eq!(
            third
                .events
                .iter()
                .map(|event| event.seq)
                .collect::<Vec<_>>(),
            vec![5],
        );

        drop(log);
        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn native_event_log_page_has_more_is_false_on_an_exact_final_page() {
        let db_path = std::env::temp_dir().join(format!(
            "ccem-native-event-page-exact-{}-{}.sqlite",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        let runtime_id = "runtime-page-exact";
        let log = NativeEventLog::new(db_path.clone());
        for seq in 1..=4 {
            log.append(&replay_page_test_record(runtime_id, seq))
                .expect("append exact-page event");
        }

        let first = log
            .replay_page(runtime_id, None, None, 2)
            .expect("first exact page");
        assert!(first.has_more);
        assert_eq!(first.next_cursor, Some(2));
        let second = log
            .replay_page(runtime_id, first.next_cursor, first.snapshot_newest_seq, 2)
            .expect("second exact page");
        assert!(!second.has_more);
        assert_eq!(second.next_cursor, Some(4));
        assert_eq!(
            second
                .events
                .iter()
                .map(|event| event.seq)
                .collect::<Vec<_>>(),
            vec![3, 4],
        );

        drop(log);
        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn native_event_log_page_detects_a_gap_at_the_page_boundary() {
        let db_path = std::env::temp_dir().join(format!(
            "ccem-native-event-page-boundary-gap-{}-{}.sqlite",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        let runtime_id = "runtime-page-boundary-gap";
        let log = NativeEventLog::new(db_path.clone());
        for seq in 1..=5 {
            log.append(&replay_page_test_record(runtime_id, seq))
                .expect("append boundary-gap event");
        }
        log.flush_pending().expect("flush boundary-gap events");
        log.with_conn(|conn| {
            conn.execute(
                "DELETE FROM native_session_events WHERE runtime_id = ?1 AND seq = 3",
                [runtime_id],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })
        .expect("delete boundary row");

        let first = log
            .replay_page(runtime_id, None, None, 2)
            .expect("first boundary page");
        assert!(!first.gap_detected);
        assert!(first.has_more);
        let second = log
            .replay_page(runtime_id, first.next_cursor, first.snapshot_newest_seq, 2)
            .expect("second boundary page");
        assert!(second.gap_detected);
        assert_eq!(second.events.first().map(|event| event.seq), Some(4));

        drop(log);
        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn native_event_log_page_keeps_snapshot_and_reports_a_deleted_tail() {
        let db_path = std::env::temp_dir().join(format!(
            "ccem-native-event-page-tail-gap-{}-{}.sqlite",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        let runtime_id = "runtime-page-tail-gap";
        let log = NativeEventLog::new(db_path.clone());
        for seq in 1..=4 {
            log.append(&replay_page_test_record(runtime_id, seq))
                .expect("append tail-gap event");
        }
        let first = log
            .replay_page(runtime_id, None, None, 2)
            .expect("first tail page");
        log.with_conn(|conn| {
            conn.execute(
                "DELETE FROM native_session_events WHERE runtime_id = ?1 AND seq = 4",
                [runtime_id],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })
        .expect("delete snapshot tail");

        let second = log
            .replay_page(runtime_id, first.next_cursor, first.snapshot_newest_seq, 2)
            .expect("tail-gapped page");
        assert_eq!(second.snapshot_newest_seq, Some(4));
        assert_eq!(second.next_cursor, Some(3));
        assert!(!second.has_more);
        assert!(second.gap_detected);

        drop(log);
        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn native_event_log_page_start_after_binds_a_fixed_snapshot() {
        let db_path = std::env::temp_dir().join(format!(
            "ccem-native-event-page-start-after-{}-{}.sqlite",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        let runtime_id = "runtime-page-start-after";
        let log = NativeEventLog::new(db_path.clone());
        for seq in 1..=5 {
            log.append(&replay_page_test_record(runtime_id, seq))
                .expect("append initial event");
        }

        let first = log
            .replay_page(runtime_id, Some(2), None, 2)
            .expect("start-after page");
        assert_eq!(first.snapshot_newest_seq, Some(5));
        assert_eq!(
            first
                .events
                .iter()
                .map(|event| event.seq)
                .collect::<Vec<_>>(),
            vec![3, 4]
        );
        assert_eq!(first.next_cursor, Some(4));
        assert!(first.has_more);

        log.append(&replay_page_test_record(runtime_id, 6))
            .expect("append after snapshot");
        let second = log
            .replay_page(runtime_id, first.next_cursor, first.snapshot_newest_seq, 2)
            .expect("snapshot continuation");
        assert_eq!(second.snapshot_newest_seq, Some(5));
        assert_eq!(
            second
                .events
                .iter()
                .map(|event| event.seq)
                .collect::<Vec<_>>(),
            vec![5]
        );
        assert_eq!(second.next_cursor, Some(5));
        assert!(!second.has_more);
        assert!(log.replay_page(runtime_id, Some(7), None, 2).is_err());

        drop(log);
        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn native_event_log_page_rejects_invalid_continuation_and_integer_parameters() {
        let db_path = std::env::temp_dir().join(format!(
            "ccem-native-event-page-params-{}-{}.sqlite",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        let runtime_id = "runtime-page-params";
        let log = NativeEventLog::new(db_path.clone());
        log.append(&replay_page_test_record(runtime_id, 1))
            .expect("append parameter-test event");

        assert!(log.replay_page(runtime_id, Some(2), Some(1), 10).is_err());
        assert!(log
            .replay_page(runtime_id, Some(u64::MAX), Some(u64::MAX), 10)
            .is_err());
        assert!(log.replay(runtime_id, Some(u64::MAX), Some(1)).is_err());
        assert!(log.replay(runtime_id, None, Some(u64::MAX)).is_err());

        drop(log);
        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn native_event_log_page_cursor_advances_past_an_unreadable_row() {
        let db_path = std::env::temp_dir().join(format!(
            "ccem-native-event-page-decode-{}.sqlite",
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        let runtime_id = "runtime-page-decode";
        let log = NativeEventLog::new(db_path.clone());
        for seq in 1..=3 {
            log.append(&replay_page_test_record(runtime_id, seq))
                .expect("append event");
        }
        log.flush_pending().expect("flush events");
        log.with_conn(|conn| {
            conn.execute(
                "UPDATE native_session_events SET payload_json = ?1
                 WHERE runtime_id = ?2 AND seq = 2",
                ["{\"type\":\"unknown-future-payload\"}", runtime_id],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })
        .expect("inject unreadable row");

        let first = log
            .replay_page(runtime_id, None, None, 2)
            .expect("first lossy page");
        assert_eq!(first.events.len(), 1);
        assert_eq!(first.events[0].seq, 1);
        assert_eq!(first.decode_failure_count, 1);
        assert_eq!(first.next_cursor, Some(2));
        assert!(first.has_more);

        let second = log
            .replay_page(runtime_id, first.next_cursor, first.snapshot_newest_seq, 2)
            .expect("page after unreadable row");
        assert_eq!(second.events.len(), 1);
        assert_eq!(second.events[0].seq, 3);
        assert_eq!(second.next_cursor, Some(3));
        assert!(!second.has_more);

        drop(log);
        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn native_event_log_page_cursor_advances_when_every_row_in_a_page_is_unreadable() {
        let db_path = std::env::temp_dir().join(format!(
            "ccem-native-event-page-all-decode-{}-{}.sqlite",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        let runtime_id = "runtime-page-all-decode";
        let log = NativeEventLog::new(db_path.clone());
        for seq in 1..=3 {
            log.append(&replay_page_test_record(runtime_id, seq))
                .expect("append event");
        }
        log.flush_pending().expect("flush events");
        log.with_conn(|conn| {
            conn.execute(
                "UPDATE native_session_events SET payload_json = ?1
                 WHERE runtime_id = ?2 AND seq <= 2",
                ["{\"type\":\"unknown-future-payload\"}", runtime_id],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })
        .expect("inject unreadable page");

        let first = log
            .replay_page(runtime_id, None, None, 2)
            .expect("all-unreadable page");
        assert!(first.events.is_empty());
        assert_eq!(first.decode_failure_count, 2);
        assert_eq!(first.next_cursor, Some(2));
        assert!(first.has_more);

        let second = log
            .replay_page(runtime_id, first.next_cursor, first.snapshot_newest_seq, 2)
            .expect("page after all unreadable rows");
        assert_eq!(second.events.len(), 1);
        assert_eq!(second.events[0].seq, 3);
        assert_eq!(second.next_cursor, Some(3));
        assert!(!second.has_more);

        drop(log);
        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn native_event_log_page_reports_a_real_sequence_gap() {
        let db_path = std::env::temp_dir().join(format!(
            "ccem-native-event-page-gap-{}.sqlite",
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        let runtime_id = "runtime-page-gap";
        let log = NativeEventLog::new(db_path.clone());
        for seq in 1..=3 {
            log.append(&replay_page_test_record(runtime_id, seq))
                .expect("append event");
        }
        log.flush_pending().expect("flush events");
        log.with_conn(|conn| {
            conn.execute(
                "DELETE FROM native_session_events WHERE runtime_id = ?1 AND seq = 2",
                [runtime_id],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })
        .expect("delete middle row");

        let page = log
            .replay_page(runtime_id, None, None, 10)
            .expect("gapped page");
        assert!(page.gap_detected);
        assert_eq!(page.next_cursor, Some(3));
        assert!(!page.has_more);

        drop(log);
        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn native_event_log_page_applies_a_serialized_byte_budget() {
        let db_path = std::env::temp_dir().join(format!(
            "ccem-native-event-page-bytes-{}.sqlite",
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        let runtime_id = "runtime-page-bytes";
        let log = NativeEventLog::new(db_path.clone());
        for seq in 1..=3 {
            log.append(&SessionEventRecord {
                runtime_id: runtime_id.to_string(),
                seq,
                occurred_at: Utc::now(),
                payload: SessionEventPayload::AssistantChunk {
                    text: "x".repeat(300 * 1024),
                },
            })
            .expect("append large event");
        }

        let first = log
            .replay_page(runtime_id, None, None, 10)
            .expect("byte-bounded first page");
        assert_eq!(first.events.len(), 1);
        assert_eq!(first.next_cursor, Some(1));
        assert!(first.has_more);

        let second = log
            .replay_page(runtime_id, first.next_cursor, first.snapshot_newest_seq, 10)
            .expect("byte-bounded second page");
        assert_eq!(second.events.len(), 1);
        assert_eq!(second.next_cursor, Some(2));
        assert!(second.has_more);

        drop(log);
        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn native_event_log_applies_limit_to_incremental_replay() {
        let db_path = std::env::temp_dir().join(format!(
            "ccem-native-event-incremental-limit-{}.sqlite",
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        let runtime_id = "runtime-incremental-limit";
        let log = NativeEventLog::new(db_path.clone());
        for seq in 1..=5 {
            log.append(&replay_page_test_record(runtime_id, seq))
                .expect("append event");
        }

        let replay = log
            .replay(runtime_id, Some(1), Some(2))
            .expect("limited incremental replay");
        assert_eq!(
            replay
                .events
                .iter()
                .map(|event| event.seq)
                .collect::<Vec<_>>(),
            vec![2, 3],
        );
        assert!(replay.truncated);

        drop(log);
        let _ = std::fs::remove_file(db_path);
    }

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
                command_id: None,
                query_generation: None,
                user_message_uuid: None,
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
                command_id: None,
                query_generation: None,
                user_message_uuid: None,
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
