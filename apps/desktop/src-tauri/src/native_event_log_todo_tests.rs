use super::NativeEventLog;
use crate::event_bus::{
    SessionEventPayload, SessionEventRecord, TodoSnapshotItemV1, TodoSnapshotV1, ToolCategory,
};
use chrono::Utc;

#[test]
fn native_event_log_flushes_todo_snapshot_started_immediately() {
    let db_path = std::env::temp_dir().join(format!(
        "ccem-native-event-log-todo-flush-test-{}.sqlite",
        Utc::now().timestamp_nanos_opt().unwrap_or_default(),
    ));
    let runtime_id = "runtime-todo-flush";
    let log = NativeEventLog::new(db_path.clone());

    log.append(&SessionEventRecord {
        runtime_id: runtime_id.to_string(),
        seq: 1,
        occurred_at: Utc::now(),
        payload: todo_snapshot_started_payload(1, "flush now"),
    })
    .expect("append snapshot-bearing tool start");

    let observer = NativeEventLog::new(db_path.clone());
    assert!(observer
        .has_events(runtime_id)
        .expect("query persisted events"));

    drop(observer);
    drop(log);
    let _ = std::fs::remove_file(db_path);
}

#[test]
fn native_event_log_returns_latest_todo_snapshot_for_helper_reconnect() {
    let db_path = std::env::temp_dir().join(format!(
        "ccem-native-event-log-todo-seed-test-{}.sqlite",
        Utc::now().timestamp_nanos_opt().unwrap_or_default(),
    ));
    let runtime_id = "runtime-todo-seed";
    let log = NativeEventLog::new(db_path.clone());

    for (index, payload) in [
        todo_snapshot_started_payload(4, "first task"),
        todo_snapshot_completed_payload(7, "latest task"),
        SessionEventPayload::AssistantChunk {
            text: r#"diagnostic text containing \"todo_snapshot\":{}"#.to_string(),
        },
    ]
    .into_iter()
    .enumerate()
    {
        log.append(&SessionEventRecord {
            runtime_id: runtime_id.to_string(),
            seq: index as u64 + 1,
            occurred_at: Utc::now(),
            payload,
        })
        .expect("append reconnect seed fixture");
    }

    let snapshot = log
        .latest_todo_snapshot(runtime_id)
        .expect("query latest todo snapshot")
        .expect("latest todo snapshot exists");
    assert_eq!(snapshot.revision, 7);
    assert_eq!(snapshot.items[0].text, "latest task");

    drop(log);
    let _ = std::fs::remove_file(db_path);
}

#[test]
fn native_event_log_keeps_latest_todo_snapshot_anchor_in_limited_replay() {
    let db_path = std::env::temp_dir().join(format!(
        "ccem-native-event-log-todo-anchor-test-{}.sqlite",
        Utc::now().timestamp_nanos_opt().unwrap_or_default(),
    ));
    let runtime_id = "runtime-todo-anchor";
    let log = NativeEventLog::new(db_path.clone());

    let payloads = [
        SessionEventPayload::Lifecycle {
            stage: "runtime_boot".to_string(),
            detail: "Starting claude native runtime.".to_string(),
        },
        todo_snapshot_started_payload(1, "stale snapshot"),
        SessionEventPayload::AssistantChunk {
            text: "between snapshots".to_string(),
        },
        todo_snapshot_started_payload(2, "latest snapshot"),
        SessionEventPayload::AssistantChunk {
            text: "after snapshot".to_string(),
        },
        SessionEventPayload::AssistantChunk {
            text: "tail one".to_string(),
        },
        SessionEventPayload::AssistantChunk {
            text: "tail two".to_string(),
        },
    ];

    for (index, payload) in payloads.into_iter().enumerate() {
        log.append(&SessionEventRecord {
            runtime_id: runtime_id.to_string(),
            seq: index as u64 + 1,
            occurred_at: Utc::now(),
            payload,
        })
        .expect("append todo anchor fixture");
    }

    let replay = log.replay(runtime_id, None, Some(2)).expect("replay tail");
    assert!(replay.truncated);
    assert_eq!(
        replay
            .events
            .iter()
            .map(|event| event.seq)
            .collect::<Vec<_>>(),
        vec![1, 4, 6, 7]
    );
    assert_eq!(todo_snapshot_count(&replay.events), 1);

    drop(log);
    let _ = std::fs::remove_file(db_path);
}

#[test]
fn native_event_log_keeps_pre_tail_todo_snapshot_when_newer_snapshot_is_in_tail() {
    let db_path = std::env::temp_dir().join(format!(
        "ccem-native-event-log-pre-tail-todo-anchor-test-{}.sqlite",
        Utc::now().timestamp_nanos_opt().unwrap_or_default(),
    ));
    let runtime_id = "runtime-pre-tail-todo-anchor";
    let log = NativeEventLog::new(db_path.clone());
    let payloads = [
        SessionEventPayload::Lifecycle {
            stage: "runtime_boot".to_string(),
            detail: "Starting claude native runtime.".to_string(),
        },
        todo_snapshot_started_payload(1, "pre-tail snapshot"),
        SessionEventPayload::AssistantChunk {
            text: "middle one".to_string(),
        },
        SessionEventPayload::AssistantChunk {
            text: "middle two".to_string(),
        },
        todo_snapshot_started_payload(2, "tail snapshot"),
        SessionEventPayload::AssistantChunk {
            text: "tail chunk".to_string(),
        },
    ];

    for (index, payload) in payloads.into_iter().enumerate() {
        log.append(&SessionEventRecord {
            runtime_id: runtime_id.to_string(),
            seq: index as u64 + 1,
            occurred_at: Utc::now(),
            payload,
        })
        .expect("append pre-tail todo anchor fixture");
    }

    let replay = log.replay(runtime_id, None, Some(2)).expect("replay tail");
    assert_eq!(
        replay
            .events
            .iter()
            .map(|event| event.seq)
            .collect::<Vec<_>>(),
        vec![1, 2, 5, 6]
    );
    assert_eq!(todo_snapshot_count(&replay.events), 2);

    drop(log);
    let _ = std::fs::remove_file(db_path);
}

fn todo_snapshot_count(events: &[SessionEventRecord]) -> usize {
    events
        .iter()
        .filter(|event| {
            matches!(
                event.payload,
                SessionEventPayload::ToolUseStarted {
                    todo_snapshot: Some(_),
                    ..
                }
            )
        })
        .count()
}

fn todo_snapshot_started_payload(revision: u64, text: &str) -> SessionEventPayload {
    SessionEventPayload::ToolUseStarted {
        tool_use_id: format!("toolu-todo-{revision}"),
        category: ToolCategory::TaskMgmt {
            raw_name: "TodoWrite".to_string(),
        },
        raw_name: "TodoWrite".to_string(),
        input_summary: "1 todo".to_string(),
        needs_response: false,
        prompt: None,
        todo_snapshot: Some(TodoSnapshotV1 {
            version: 1,
            provider: "claude".to_string(),
            source: "TodoWrite".to_string(),
            revision,
            items: vec![TodoSnapshotItemV1 {
                id: "todo-1".to_string(),
                text: text.to_string(),
                status: "in_progress".to_string(),
                active_text: Some("Working".to_string()),
            }],
        }),
    }
}

fn todo_snapshot_completed_payload(revision: u64, text: &str) -> SessionEventPayload {
    SessionEventPayload::ToolUseCompleted {
        tool_use_id: format!("toolu-todo-{revision}"),
        raw_name: "TodoWrite".to_string(),
        result_summary: "updated".to_string(),
        result_content: None,
        success: true,
        todo_snapshot: Some(TodoSnapshotV1 {
            version: 1,
            provider: "claude".to_string(),
            source: "TodoWrite".to_string(),
            revision,
            items: vec![TodoSnapshotItemV1 {
                id: "todo-1".to_string(),
                text: text.to_string(),
                status: "in_progress".to_string(),
                active_text: Some("Working".to_string()),
            }],
        }),
    }
}
