use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

pub const DEFAULT_SESSION_EVENT_CAPACITY: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UserInputKind {
    Question,
    PlanEntry,
    PlanExit,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "category", rename_all = "snake_case")]
pub enum ToolCategory {
    UserInput {
        kind: UserInputKind,
        raw_name: String,
    },
    FileOp {
        raw_name: String,
    },
    Execution {
        raw_name: String,
    },
    Search {
        raw_name: String,
    },
    TaskMgmt {
        raw_name: String,
    },
    Unknown {
        raw_name: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolQuestionOption {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolQuestionPrompt {
    pub question: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    #[serde(rename = "multiSelect")]
    pub multi_select: bool,
    pub options: Vec<ToolQuestionOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "prompt_type", rename_all = "snake_case")]
pub enum InteractiveToolPrompt {
    AskUserQuestion {
        questions: Vec<ToolQuestionPrompt>,
    },
    PlanEntry,
    PlanExit {
        #[serde(default)]
        allowed_prompts: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        plan_summary: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TerminalPromptKind {
    Permission,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ContextUsageCategory {
    pub name: String,
    pub tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionPromptImage {
    pub media_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base64_data: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub byte_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TodoSnapshotItemV1 {
    pub id: String,
    pub text: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TodoSnapshotV1 {
    pub version: u8,
    pub provider: String,
    pub source: String,
    pub revision: u64,
    pub items: Vec<TodoSnapshotItemV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionEventPayload {
    UserPrompt {
        text: String,
        image_count: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        images: Option<Vec<SessionPromptImage>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        canonical_hash: Option<String>,
    },
    SystemMessage {
        message: String,
    },
    Lifecycle {
        stage: String,
        detail: String,
    },
    ClaudeJson {
        message_type: Option<String>,
        raw_json: String,
    },
    #[serde(rename = "stderr_line", alias = "std_err_line")]
    StdErrLine {
        line: String,
    },
    AssistantChunk {
        text: String,
    },
    ToolUseStarted {
        tool_use_id: String,
        category: ToolCategory,
        raw_name: String,
        input_summary: String,
        needs_response: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prompt: Option<InteractiveToolPrompt>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        todo_snapshot: Option<TodoSnapshotV1>,
    },
    ToolUseCompleted {
        tool_use_id: String,
        raw_name: String,
        result_summary: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result_content: Option<String>,
        success: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        todo_snapshot: Option<TodoSnapshotV1>,
    },
    PermissionRequired {
        request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_use_id: Option<String>,
        tool_name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input_summary: Option<String>,
    },
    PermissionResponded {
        request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_use_id: Option<String>,
        approved: bool,
        responder: String,
    },
    CheckpointCreated {
        provider: String,
        checkpoint_id: String,
        provider_session_id: Option<String>,
        prompt_summary: Option<String>,
        source: String,
    },
    FilesRewound {
        provider: String,
        checkpoint_id: String,
        files_changed: Vec<String>,
        insertions: Option<i64>,
        deletions: Option<i64>,
    },
    FileRewindFailed {
        provider: String,
        checkpoint_id: String,
        error: String,
    },
    SessionCompleted {
        reason: String,
    },
    TerminalPromptRequired {
        prompt_kind: TerminalPromptKind,
        prompt_text: String,
    },
    TerminalPromptResolved {
        prompt_kind: TerminalPromptKind,
        approved: bool,
    },
    GapNotification {
        last_seen_seq: u64,
        oldest_available_seq: u64,
    },
    TokenUsage {
        provider: String,
        input_tokens: u64,
        output_tokens: u64,
        cache_read_tokens: u64,
        cache_creation_tokens: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        total_cost_usd: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<String>,
    },
    ContextUsage {
        provider: String,
        used_tokens: u64,
        max_tokens: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        raw_max_tokens: Option<u64>,
        percentage: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        auto_compact_threshold: Option<u64>,
        is_auto_compact_enabled: bool,
        model: String,
        categories: Vec<ContextUsageCategory>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionEventRecord {
    pub runtime_id: String,
    pub seq: u64,
    pub occurred_at: DateTime<Utc>,
    pub payload: SessionEventPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReplayBatch {
    pub gap_detected: bool,
    pub truncated: bool,
    pub oldest_available_seq: Option<u64>,
    pub newest_available_seq: Option<u64>,
    pub events: Vec<SessionEventRecord>,
}

pub fn replay_records(records: &[SessionEventRecord], last_seen_seq: Option<u64>) -> ReplayBatch {
    let oldest_available_seq = records.first().map(|event| event.seq);
    let newest_available_seq = records.last().map(|event| event.seq);
    let gap_detected = match (last_seen_seq, oldest_available_seq) {
        (Some(last_seen), Some(oldest)) => last_seen.saturating_add(1) < oldest,
        _ => false,
    };

    let events = match last_seen_seq {
        Some(last_seen) => records
            .iter()
            .filter(|event| event.seq > last_seen)
            .cloned()
            .collect(),
        None => records.to_vec(),
    };

    ReplayBatch {
        gap_detected,
        truncated: false,
        oldest_available_seq,
        newest_available_seq,
        events,
    }
}

pub struct SessionStore {
    runtime_id: String,
    capacity: usize,
    next_seq: u64,
    events: VecDeque<SessionEventRecord>,
}

impl SessionStore {
    pub fn new(runtime_id: impl Into<String>) -> Self {
        Self::with_capacity(runtime_id, DEFAULT_SESSION_EVENT_CAPACITY)
    }

    pub fn with_capacity(runtime_id: impl Into<String>, capacity: usize) -> Self {
        assert!(
            capacity > 0,
            "session event capacity must be greater than zero"
        );

        Self {
            runtime_id: runtime_id.into(),
            capacity,
            next_seq: 1,
            events: VecDeque::with_capacity(capacity),
        }
    }

    pub fn with_start_seq(runtime_id: impl Into<String>, start_seq: u64) -> Self {
        Self {
            runtime_id: runtime_id.into(),
            capacity: DEFAULT_SESSION_EVENT_CAPACITY,
            next_seq: start_seq,
            events: VecDeque::with_capacity(DEFAULT_SESSION_EVENT_CAPACITY),
        }
    }

    pub fn append(&mut self, payload: SessionEventPayload) -> SessionEventRecord {
        let record = SessionEventRecord {
            runtime_id: self.runtime_id.clone(),
            seq: self.next_seq,
            occurred_at: Utc::now(),
            payload,
        };
        self.next_seq += 1;

        if self.events.len() == self.capacity {
            self.events.pop_front();
        }

        self.events.push_back(record.clone());
        record
    }

    pub fn events_since(&self, last_seen_seq: Option<u64>) -> ReplayBatch {
        let records = self.events.iter().cloned().collect::<Vec<_>>();
        replay_records(&records, last_seen_seq)
    }

    pub fn len(&self) -> usize {
        self.events.len()
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    pub fn oldest_seq(&self) -> Option<u64> {
        self.events.front().map(|event| event.seq)
    }

    pub fn newest_seq(&self) -> Option<u64> {
        self.events.back().map(|event| event.seq)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ContextUsageCategory, InteractiveToolPrompt, SessionEventPayload, SessionStore,
        TodoSnapshotItemV1, TodoSnapshotV1, ToolCategory, ToolQuestionOption, ToolQuestionPrompt,
        UserInputKind,
    };

    #[test]
    fn session_store_emits_monotonic_sequence_numbers() {
        let mut store = SessionStore::new("runtime-1");

        assert!(store.is_empty());

        let first = store.append(SessionEventPayload::SystemMessage {
            message: "boot".to_string(),
        });
        let second = store.append(SessionEventPayload::AssistantChunk {
            text: "hello".to_string(),
        });
        let third = store.append(SessionEventPayload::SessionCompleted {
            reason: "done".to_string(),
        });

        assert_eq!(first.seq, 1);
        assert_eq!(second.seq, 2);
        assert_eq!(third.seq, 3);
        assert_eq!(store.len(), 3);
        assert_eq!(store.oldest_seq(), Some(1));
        assert_eq!(store.newest_seq(), Some(3));
    }

    #[test]
    fn session_store_replays_only_unseen_events() {
        let mut store = SessionStore::with_capacity("runtime-1", 5);
        store.append(SessionEventPayload::SystemMessage {
            message: "boot".to_string(),
        });
        store.append(SessionEventPayload::AssistantChunk {
            text: "step-1".to_string(),
        });
        store.append(SessionEventPayload::AssistantChunk {
            text: "step-2".to_string(),
        });

        let replay = store.events_since(Some(1));

        assert!(!replay.gap_detected);
        assert_eq!(replay.events.len(), 2);
        assert_eq!(replay.events[0].seq, 2);
        assert_eq!(replay.events[1].seq, 3);
    }

    #[test]
    fn tool_use_started_round_trips_with_lightweight_prompt_payload() {
        let payload = SessionEventPayload::ToolUseStarted {
            tool_use_id: "toolu-1".to_string(),
            category: ToolCategory::UserInput {
                kind: UserInputKind::Question,
                raw_name: "AskUserQuestion".to_string(),
            },
            raw_name: "AskUserQuestion".to_string(),
            input_summary: "需要用户回答 1 个问题".to_string(),
            needs_response: true,
            prompt: Some(InteractiveToolPrompt::AskUserQuestion {
                questions: vec![ToolQuestionPrompt {
                    question: "Which one?".to_string(),
                    header: Some("Choice".to_string()),
                    multi_select: false,
                    options: vec![
                        ToolQuestionOption {
                            label: "A".to_string(),
                            description: None,
                            preview: None,
                        },
                        ToolQuestionOption {
                            label: "B".to_string(),
                            description: Some("Preferred".to_string()),
                            preview: None,
                        },
                    ],
                }],
            }),
            todo_snapshot: None,
        };

        let encoded = serde_json::to_string(&payload).expect("serialize");
        let decoded: SessionEventPayload = serde_json::from_str(&encoded).expect("deserialize");
        assert_eq!(decoded, payload);
    }

    #[test]
    fn legacy_tool_events_without_todo_snapshot_still_deserialize() {
        let started: SessionEventPayload = serde_json::from_str(
            r#"{"type":"tool_use_started","tool_use_id":"toolu-legacy-start","category":{"category":"task_mgmt","raw_name":"TodoWrite"},"raw_name":"TodoWrite","input_summary":"1 todo","needs_response":false}"#,
        )
        .expect("deserialize legacy tool start");
        let completed: SessionEventPayload = serde_json::from_str(
            r#"{"type":"tool_use_completed","tool_use_id":"toolu-legacy-complete","raw_name":"TaskUpdate","result_summary":"updated","success":true}"#,
        )
        .expect("deserialize legacy tool completion");

        assert!(matches!(
            started,
            SessionEventPayload::ToolUseStarted {
                todo_snapshot: None,
                ..
            }
        ));
        assert!(matches!(
            completed,
            SessionEventPayload::ToolUseCompleted {
                todo_snapshot: None,
                ..
            }
        ));
    }

    #[test]
    fn todo_snapshot_round_trips_long_text_on_tool_events() {
        let long_text = "preserve this todo detail ".repeat(32);
        let snapshot = TodoSnapshotV1 {
            version: 1,
            provider: "claude".to_string(),
            source: "TodoWrite".to_string(),
            revision: 7,
            items: vec![TodoSnapshotItemV1 {
                id: "todo-long".to_string(),
                text: long_text.clone(),
                status: "in_progress".to_string(),
                active_text: Some("Preserving the full task detail".to_string()),
            }],
        };
        let payloads = [
            SessionEventPayload::ToolUseStarted {
                tool_use_id: "toolu-todo-start".to_string(),
                category: ToolCategory::TaskMgmt {
                    raw_name: "TodoWrite".to_string(),
                },
                raw_name: "TodoWrite".to_string(),
                input_summary: "1 todo".to_string(),
                needs_response: false,
                prompt: None,
                todo_snapshot: Some(snapshot.clone()),
            },
            SessionEventPayload::ToolUseCompleted {
                tool_use_id: "toolu-todo-complete".to_string(),
                raw_name: "TodoWrite".to_string(),
                result_summary: "updated".to_string(),
                result_content: None,
                success: true,
                todo_snapshot: Some(snapshot.clone()),
            },
        ];

        for payload in payloads {
            let encoded = serde_json::to_value(&payload).expect("serialize todo snapshot event");
            assert_eq!(encoded["todo_snapshot"]["items"][0]["text"], long_text);
            let decoded: SessionEventPayload =
                serde_json::from_value(encoded).expect("deserialize todo snapshot event");
            assert_eq!(decoded, payload);
        }
    }

    #[test]
    fn permission_events_preserve_optional_tool_use_correlation() {
        let required = SessionEventPayload::PermissionRequired {
            request_id: "req-sdk-1".to_string(),
            tool_use_id: Some("toolu-1".to_string()),
            tool_name: "Bash".to_string(),
            input_summary: Some("pnpm test".to_string()),
        };
        let responded = SessionEventPayload::PermissionResponded {
            request_id: "req-sdk-1".to_string(),
            tool_use_id: Some("toolu-1".to_string()),
            approved: true,
            responder: "desktop".to_string(),
        };

        for payload in [required, responded] {
            let encoded = serde_json::to_value(&payload).expect("serialize");
            assert_eq!(encoded["tool_use_id"], "toolu-1");
            let decoded: SessionEventPayload =
                serde_json::from_value(encoded).expect("deserialize permission event");
            assert_eq!(decoded, payload);
        }

        let legacy: SessionEventPayload = serde_json::from_str(
            r#"{"type":"permission_required","request_id":"req-legacy","tool_name":"Bash"}"#,
        )
        .expect("deserialize legacy permission request");
        assert_eq!(
            legacy,
            SessionEventPayload::PermissionRequired {
                request_id: "req-legacy".to_string(),
                tool_use_id: None,
                tool_name: "Bash".to_string(),
                input_summary: None,
            }
        );
    }

    #[test]
    fn file_checkpoint_events_round_trip() {
        let checkpoint = SessionEventPayload::CheckpointCreated {
            provider: "claude".to_string(),
            checkpoint_id: "checkpoint-1".to_string(),
            provider_session_id: Some("session-1".to_string()),
            prompt_summary: Some("edit example.txt".to_string()),
            source: "claude-file-checkpoint".to_string(),
        };
        let rewind = SessionEventPayload::FilesRewound {
            provider: "claude".to_string(),
            checkpoint_id: "checkpoint-1".to_string(),
            files_changed: vec!["example.txt".to_string()],
            insertions: Some(0),
            deletions: Some(3),
        };
        let failure = SessionEventPayload::FileRewindFailed {
            provider: "claude".to_string(),
            checkpoint_id: "checkpoint-1".to_string(),
            error: "No file checkpoint found for message".to_string(),
        };

        for payload in [checkpoint, rewind, failure] {
            let encoded = serde_json::to_string(&payload).expect("serialize");
            let decoded: SessionEventPayload = serde_json::from_str(&encoded).expect("deserialize");
            assert_eq!(decoded, payload);
        }
    }

    #[test]
    fn stderr_line_uses_helper_protocol_name_and_accepts_legacy_alias() {
        let payload = SessionEventPayload::StdErrLine {
            line: "Native CLI binary not found".to_string(),
        };

        let encoded = serde_json::to_value(&payload).expect("serialize");
        assert_eq!(encoded["type"], "stderr_line");

        let decoded: SessionEventPayload =
            serde_json::from_str(r#"{"type":"std_err_line","line":"legacy"}"#)
                .expect("deserialize legacy alias");

        assert_eq!(
            decoded,
            SessionEventPayload::StdErrLine {
                line: "legacy".to_string(),
            }
        );
    }

    #[test]
    fn usage_events_round_trip_with_context_window_snapshot() {
        let payload = SessionEventPayload::ContextUsage {
            provider: "codex".to_string(),
            used_tokens: 167_000,
            max_tokens: 258_400,
            raw_max_tokens: Some(258_400),
            percentage: 64.6,
            auto_compact_threshold: None,
            is_auto_compact_enabled: true,
            model: "gpt-5.5-codex".to_string(),
            categories: vec![ContextUsageCategory {
                name: "messages".to_string(),
                tokens: 167_000,
            }],
        };

        let encoded = serde_json::to_value(&payload).expect("serialize");
        assert_eq!(encoded["type"], "context_usage");
        assert_eq!(encoded["raw_max_tokens"], 258_400);

        let decoded: SessionEventPayload =
            serde_json::from_value(encoded).expect("deserialize context usage");
        assert_eq!(decoded, payload);
    }

    #[test]
    fn session_store_flags_gap_when_requested_seq_has_been_evicted() {
        let mut store = SessionStore::with_capacity("runtime-1", 2);
        store.append(SessionEventPayload::SystemMessage {
            message: "boot".to_string(),
        });
        store.append(SessionEventPayload::AssistantChunk {
            text: "step-1".to_string(),
        });
        store.append(SessionEventPayload::AssistantChunk {
            text: "step-2".to_string(),
        });

        let replay = store.events_since(Some(0));

        assert!(replay.gap_detected);
        assert_eq!(replay.oldest_available_seq, Some(2));
        assert_eq!(replay.events.len(), 2);
        assert_eq!(replay.events[0].seq, 2);
        assert_eq!(replay.events[1].seq, 3);
    }
}
