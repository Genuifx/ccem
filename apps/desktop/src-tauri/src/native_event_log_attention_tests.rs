use super::NativeEventLog;
use crate::event_bus::{SessionEventPayload, SessionEventRecord, ToolCategory};
use chrono::Utc;
use rusqlite::Connection;

#[test]
fn native_event_log_persists_and_restores_attention_summary() {
    let db_path = std::env::temp_dir().join(format!(
        "ccem-native-event-log-attention-test-{}.sqlite",
        Utc::now().timestamp_nanos_opt().unwrap_or_default(),
    ));
    let runtime_id = "runtime-attention-persist";
    let log = NativeEventLog::new(db_path.clone());

    // Buffered chunks plus a flush-triggering tail exercise both the batched
    // write path and the per-event flush path for summary folding.
    for seq in 1..=2 {
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
    log.append(&SessionEventRecord {
        runtime_id: runtime_id.to_string(),
        seq: 3,
        occurred_at: Utc::now(),
        payload: SessionEventPayload::PermissionRequired {
            request_id: "req-1".to_string(),
            tool_use_id: Some("toolu-perm".to_string()),
            tool_name: "Bash".to_string(),
            input_summary: None,
        },
    })
    .expect("append permission request");
    log.append(&SessionEventRecord {
        runtime_id: runtime_id.to_string(),
        seq: 4,
        occurred_at: Utc::now(),
        payload: SessionEventPayload::PermissionResponded {
            request_id: "req-1".to_string(),
            tool_use_id: Some("toolu-perm".to_string()),
            approved: true,
            responder: "desktop".to_string(),
        },
    })
    .expect("append permission response");
    log.append(&SessionEventRecord {
        runtime_id: runtime_id.to_string(),
        seq: 5,
        occurred_at: Utc::now(),
        payload: SessionEventPayload::ToolUseStarted {
            tool_use_id: "toolu-input".to_string(),
            category: ToolCategory::UserInput {
                kind: crate::event_bus::UserInputKind::Question,
                raw_name: "AskUserQuestion".to_string(),
            },
            raw_name: "AskUserQuestion".to_string(),
            input_summary: String::new(),
            needs_response: true,
            prompt: None,
            todo_snapshot: None,
        },
    })
    .expect("append tool use start");

    let summary = log
        .attention_summary(runtime_id)
        .expect("read persisted attention summary");
    assert_eq!(
        summary.attention_kind().as_deref(),
        Some("input_required")
    );

    drop(log);
    let reopened = NativeEventLog::new(db_path.clone());
    let restored = reopened
        .attention_summary(runtime_id)
        .expect("read restored attention summary");
    assert_eq!(restored.attention_kind().as_deref(), Some("input_required"));
    assert_eq!(restored, summary);

    drop(reopened);
    let _ = std::fs::remove_file(db_path);
}

#[test]
fn native_event_log_attention_summary_fallback_derives_from_existing_events() {
    let db_path = std::env::temp_dir().join(format!(
        "ccem-native-event-log-attention-fallback-test-{}.sqlite",
        Utc::now().timestamp_nanos_opt().unwrap_or_default(),
    ));
    let runtime_id = "runtime-attention-fallback";
    let log = NativeEventLog::new(db_path.clone());
    // Force schema creation without writing any events through the log.
    assert!(!log
        .has_events(runtime_id)
        .expect("check events for schema bootstrap"));
    assert_eq!(
        log.attention_summary(runtime_id)
            .expect("summary for eventless runtime")
            .attention_kind(),
        None
    );
    drop(log);

    // Simulate an in-place upgrade: events exist on disk but no summary row.
    let payload = SessionEventPayload::PermissionRequired {
        request_id: "req-legacy".to_string(),
        tool_use_id: None,
        tool_name: "Bash".to_string(),
        input_summary: None,
    };
    let conn = Connection::open(&db_path).expect("open sqlite db");
    conn.execute(
        "INSERT INTO native_session_events (
            runtime_id, seq, occurred_at, payload_json, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![
            runtime_id,
            1_i64,
            Utc::now().to_rfc3339(),
            serde_json::to_string(&payload).expect("serialize legacy payload"),
            Utc::now().to_rfc3339(),
        ],
    )
    .expect("insert legacy event without summary row");
    drop(conn);

    let upgraded = NativeEventLog::new(db_path.clone());
    let summary = upgraded
        .attention_summary(runtime_id)
        .expect("derive attention summary via tail fallback");
    assert_eq!(
        summary.attention_kind().as_deref(),
        Some("permission_required")
    );

    // The fallback persisted its result; a fresh reader serves it directly.
    let persisted_row: Option<String> = Connection::open(&db_path)
        .expect("open sqlite db")
        .query_row(
            "SELECT summary_json FROM native_attention_summaries WHERE runtime_id = ?1",
            [runtime_id],
            |row| row.get::<_, String>(0),
        )
        .ok();
    assert!(persisted_row.is_some());

    drop(upgraded);
    let _ = std::fs::remove_file(db_path);
}
