use crate::event_bus::{InteractiveToolPrompt, SessionEventPayload, SessionEventRecord};
use crate::native_runtime::NativeSessionSummary;
use crate::session::Session;
use crate::unified_session::UnifiedSessionInfo;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};

const RUNTIME_HISTORY_FALLBACK_WINDOW_MS: u64 = 2 * 60 * 1000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDecorationSessionInput {
    pub id: String,
    pub source: String,
    pub timestamp: u64,
    pub project: String,
    pub project_name: String,
    #[serde(default)]
    pub env_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSessionDecoration {
    pub session_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub is_active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env_name: Option<String>,
    pub visual_state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attention_kind: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceRuntimeDescriptor {
    Unified {
        id: String,
        client: String,
        status: String,
        is_active: bool,
        env_name: String,
        project_dir: String,
        created_at: u64,
        history_session_id: Option<String>,
    },
    Native {
        id: String,
        client: String,
        status: String,
        is_active: bool,
        env_name: String,
        project_dir: String,
        created_at: u64,
        provider_session_id: Option<String>,
    },
    LegacyInteractive {
        id: String,
        client: String,
        status: String,
        is_active: bool,
        env_name: String,
        project_dir: String,
        created_at: u64,
    },
}

pub fn build_workspace_session_decorations(
    sessions: &[WorkspaceDecorationSessionInput],
    runtimes: &[WorkspaceRuntimeDescriptor],
    events_by_runtime: &HashMap<String, Vec<SessionEventRecord>>,
) -> Vec<WorkspaceSessionDecoration> {
    let matched_runtime_by_session_key = build_runtime_match_map(sessions, runtimes);
    let mut decorations = Vec::new();

    for session in sessions {
        let session_key = session_key(&session.source, &session.id);
        let Some(runtime) = matched_runtime_by_session_key.get(&session_key) else {
            continue;
        };
        let is_active = runtime.is_active();
        let attention_kind = is_active
            .then(|| {
                resolve_attention_kind(
                    events_by_runtime
                        .get(runtime.id())
                        .map(Vec::as_slice)
                        .unwrap_or(&[]),
                )
            })
            .flatten();

        decorations.push(WorkspaceSessionDecoration {
            session_key,
            runtime_id: Some(runtime.id().to_string()),
            client: Some(runtime.client().to_string()),
            status: Some(runtime.status().to_string()),
            is_active,
            env_name: Some(runtime.env_name().to_string()),
            visual_state: if attention_kind.is_some() {
                "attention".to_string()
            } else if is_active && is_runtime_processing(runtime) {
                "processing".to_string()
            } else {
                "identity".to_string()
            },
            attention_kind,
        });
    }

    decorations
}

pub fn should_replay_decoration_events(status: &str) -> bool {
    matches!(
        status,
        "idle" | "initializing" | "processing" | "ready" | "running"
    )
}

pub fn unified_runtime_descriptor(runtime: &UnifiedSessionInfo) -> WorkspaceRuntimeDescriptor {
    WorkspaceRuntimeDescriptor::Unified {
        id: runtime.id.clone(),
        client: normalize_runtime_client(runtime.client.as_deref()),
        status: runtime.status.clone(),
        is_active: runtime.is_active,
        env_name: runtime.env_name.clone(),
        project_dir: runtime.project_dir.clone(),
        created_at: timestamp_millis(runtime.created_at),
        history_session_id: runtime.claude_session_id.clone(),
    }
}

pub fn native_runtime_descriptor(runtime: &NativeSessionSummary) -> WorkspaceRuntimeDescriptor {
    WorkspaceRuntimeDescriptor::Native {
        id: runtime.runtime_id.clone(),
        client: runtime.provider.as_str().to_string(),
        status: runtime.status.clone(),
        is_active: runtime.is_active,
        env_name: runtime.env_name.clone(),
        project_dir: runtime.project_dir.clone(),
        created_at: timestamp_millis(runtime.created_at),
        provider_session_id: runtime.provider_session_id.clone(),
    }
}

pub fn legacy_interactive_runtime_descriptor(session: &Session) -> WorkspaceRuntimeDescriptor {
    WorkspaceRuntimeDescriptor::LegacyInteractive {
        id: session.id.clone(),
        client: normalize_runtime_client(Some(session.client.as_str())),
        status: session.status.clone(),
        is_active: session.status == "running",
        env_name: session.env_name.clone(),
        project_dir: session.working_dir.clone(),
        created_at: parse_timestamp_millis(&session.start_time).unwrap_or(0),
    }
}

impl WorkspaceRuntimeDescriptor {
    fn id(&self) -> &str {
        match self {
            Self::Unified { id, .. }
            | Self::Native { id, .. }
            | Self::LegacyInteractive { id, .. } => id,
        }
    }

    fn client(&self) -> &str {
        match self {
            Self::Unified { client, .. }
            | Self::Native { client, .. }
            | Self::LegacyInteractive { client, .. } => client,
        }
    }

    fn status(&self) -> &str {
        match self {
            Self::Unified { status, .. }
            | Self::Native { status, .. }
            | Self::LegacyInteractive { status, .. } => status,
        }
    }

    fn is_active(&self) -> bool {
        match self {
            Self::Unified { is_active, .. }
            | Self::Native { is_active, .. }
            | Self::LegacyInteractive { is_active, .. } => *is_active,
        }
    }

    fn env_name(&self) -> &str {
        match self {
            Self::Unified { env_name, .. }
            | Self::Native { env_name, .. }
            | Self::LegacyInteractive { env_name, .. } => env_name,
        }
    }

    fn project_dir(&self) -> &str {
        match self {
            Self::Unified { project_dir, .. }
            | Self::Native { project_dir, .. }
            | Self::LegacyInteractive { project_dir, .. } => project_dir,
        }
    }

    fn created_at(&self) -> u64 {
        match self {
            Self::Unified { created_at, .. }
            | Self::Native { created_at, .. }
            | Self::LegacyInteractive { created_at, .. } => *created_at,
        }
    }

    fn provider_identity(&self) -> Option<&str> {
        match self {
            Self::Unified {
                history_session_id, ..
            } => history_session_id.as_deref(),
            Self::Native {
                provider_session_id,
                ..
            } => provider_session_id.as_deref(),
            Self::LegacyInteractive { .. } => None,
        }
    }
}

fn build_runtime_match_map(
    sessions: &[WorkspaceDecorationSessionInput],
    runtimes: &[WorkspaceRuntimeDescriptor],
) -> HashMap<String, WorkspaceRuntimeDescriptor> {
    let mut matched_by_key = HashMap::new();
    let mut used_runtime_ids = HashSet::new();
    let mut history_by_timestamp = sessions.to_vec();
    history_by_timestamp.sort_by_key(|session| Reverse(session.timestamp));
    let mut runtimes_by_priority = runtimes.to_vec();
    runtimes_by_priority
        .sort_by_key(|runtime| Reverse((runtime.is_active(), runtime.created_at())));

    for session in &history_by_timestamp {
        let direct_match = runtimes_by_priority.iter().find(|runtime| {
            !used_runtime_ids.contains(runtime.id())
                && runtime.client() == session.source
                && runtime.provider_identity() == Some(session.id.as_str())
        });

        if let Some(runtime) = direct_match {
            matched_by_key.insert(session_key(&session.source, &session.id), runtime.clone());
            used_runtime_ids.insert(runtime.id().to_string());
        }
    }

    for runtime in &runtimes_by_priority {
        if used_runtime_ids.contains(runtime.id()) || runtime.provider_identity().is_some() {
            continue;
        }

        let project_dir = normalize_path(runtime.project_dir());
        let project_dir_base = basename(runtime.project_dir());
        let candidate = history_by_timestamp.iter().find(|session| {
            let key = session_key(&session.source, &session.id);
            if matched_by_key.contains_key(&key) || session.source != runtime.client() {
                return false;
            }
            if let Some(env_name) = &session.env_name {
                if env_name != runtime.env_name() {
                    return false;
                }
            }
            if !can_use_history_fallback_match(runtime, session) {
                return false;
            }

            let history_project = normalize_path(&session.project);
            if !history_project.is_empty() && !project_dir.is_empty() {
                return history_project == project_dir;
            }

            basename(&session.project_name) == project_dir_base
        });

        if let Some(session) = candidate {
            matched_by_key.insert(session_key(&session.source, &session.id), runtime.clone());
            used_runtime_ids.insert(runtime.id().to_string());
        }
    }

    matched_by_key
}

fn resolve_attention_kind(events: &[SessionEventRecord]) -> Option<String> {
    let mut pending_permissions = HashSet::new();
    let mut pending_responses: HashMap<String, String> = HashMap::new();
    let mut terminal_prompt_pending = false;

    for event in events {
        match &event.payload {
            SessionEventPayload::PermissionRequired { request_id, .. } => {
                pending_permissions.insert(request_id.clone());
            }
            SessionEventPayload::PermissionResponded { request_id, .. } => {
                pending_permissions.remove(request_id);
            }
            SessionEventPayload::TerminalPromptRequired { .. } => {
                terminal_prompt_pending = true;
            }
            SessionEventPayload::TerminalPromptResolved { .. } => {
                terminal_prompt_pending = false;
            }
            SessionEventPayload::ToolUseStarted {
                tool_use_id,
                needs_response: true,
                prompt,
                ..
            } => {
                let attention_kind = match prompt {
                    Some(InteractiveToolPrompt::PlanExit { .. }) => "plan_review",
                    _ => "input_required",
                };
                pending_responses.insert(tool_use_id.clone(), attention_kind.to_string());
            }
            SessionEventPayload::ToolUseCompleted {
                tool_use_id,
                success,
                ..
            } => {
                let pending_kind = pending_responses.get(tool_use_id).map(String::as_str);
                if pending_kind != Some("plan_review") || *success {
                    pending_responses.remove(tool_use_id);
                }
            }
            SessionEventPayload::UserPrompt { .. } => {
                pending_responses.clear();
            }
            SessionEventPayload::SessionCompleted { .. } => {
                pending_permissions.clear();
                pending_responses.clear();
                terminal_prompt_pending = false;
            }
            _ => {}
        }
    }

    if !pending_permissions.is_empty() || terminal_prompt_pending {
        return Some("permission_required".to_string());
    }

    if pending_responses
        .values()
        .any(|value| value == "plan_review")
    {
        return Some("plan_review".to_string());
    }

    if pending_responses
        .values()
        .any(|value| value == "input_required")
    {
        return Some("input_required".to_string());
    }

    None
}

fn is_runtime_processing(runtime: &WorkspaceRuntimeDescriptor) -> bool {
    match runtime {
        WorkspaceRuntimeDescriptor::LegacyInteractive { status, .. } => status == "running",
        WorkspaceRuntimeDescriptor::Unified { status, .. }
        | WorkspaceRuntimeDescriptor::Native { status, .. } => {
            status == "processing" || status == "initializing"
        }
    }
}

fn can_use_history_fallback_match(
    runtime: &WorkspaceRuntimeDescriptor,
    session: &WorkspaceDecorationSessionInput,
) -> bool {
    runtime.created_at().abs_diff(session.timestamp) <= RUNTIME_HISTORY_FALLBACK_WINDOW_MS
}

fn normalize_runtime_client(client: Option<&str>) -> String {
    match client {
        Some("codex") => "codex".to_string(),
        Some("opencode") => "opencode".to_string(),
        _ => "claude".to_string(),
    }
}

fn normalize_path(path: &str) -> String {
    path.replace('\\', "/")
        .trim_end_matches('/')
        .trim()
        .to_lowercase()
}

fn basename(path: &str) -> String {
    normalize_path(path)
        .split('/')
        .next_back()
        .unwrap_or("")
        .to_string()
}

fn session_key(source: &str, id: &str) -> String {
    format!("{source}:{id}")
}

fn timestamp_millis(value: DateTime<Utc>) -> u64 {
    value.timestamp_millis().max(0) as u64
}

fn parse_timestamp_millis(value: &str) -> Option<u64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|timestamp| timestamp.timestamp_millis().max(0) as u64)
}

#[cfg(test)]
mod tests {
    use super::{
        build_workspace_session_decorations, should_replay_decoration_events,
        WorkspaceDecorationSessionInput, WorkspaceRuntimeDescriptor,
    };
    use crate::event_bus::{
        InteractiveToolPrompt, SessionEventPayload, SessionEventRecord, ToolCategory,
    };
    use chrono::Utc;
    use std::collections::HashMap;

    fn session(
        id: &str,
        source: &str,
        timestamp: u64,
        project: &str,
    ) -> WorkspaceDecorationSessionInput {
        WorkspaceDecorationSessionInput {
            id: id.to_string(),
            source: source.to_string(),
            timestamp,
            project: project.to_string(),
            project_name: project
                .split('/')
                .next_back()
                .unwrap_or("unknown")
                .to_string(),
            env_name: Some("dev".to_string()),
        }
    }

    #[test]
    fn direct_provider_identity_match_wins_over_fallback() {
        let sessions = vec![
            session("target", "codex", 1000, "/repo/a"),
            session("nearby", "codex", 1001, "/repo/a"),
        ];
        let runtimes = vec![WorkspaceRuntimeDescriptor::Native {
            id: "runtime-1".to_string(),
            client: "codex".to_string(),
            status: "processing".to_string(),
            is_active: true,
            env_name: "dev".to_string(),
            project_dir: "/repo/a".to_string(),
            created_at: 1001,
            provider_session_id: Some("target".to_string()),
        }];

        let decorations =
            build_workspace_session_decorations(&sessions, &runtimes, &HashMap::new());

        assert_eq!(decorations.len(), 1);
        assert_eq!(decorations[0].session_key, "codex:target");
        assert_eq!(decorations[0].visual_state, "processing");
    }

    #[test]
    fn inactive_native_runtime_cannot_claim_processing_priority() {
        let sessions = vec![session("target", "claude", 1000, "/repo/a")];
        let runtimes = vec![WorkspaceRuntimeDescriptor::Native {
            id: "native-stale".to_string(),
            client: "claude".to_string(),
            status: "processing".to_string(),
            is_active: false,
            env_name: "dev".to_string(),
            project_dir: "/repo/a".to_string(),
            created_at: 1000,
            provider_session_id: Some("target".to_string()),
        }];

        let decorations =
            build_workspace_session_decorations(&sessions, &runtimes, &HashMap::new());

        assert_eq!(decorations.len(), 1);
        assert!(!decorations[0].is_active);
        assert_eq!(decorations[0].visual_state, "identity");
        assert_eq!(decorations[0].attention_kind, None);
    }

    #[test]
    fn active_runtime_wins_over_newer_inactive_runtime_for_same_provider_session() {
        let sessions = vec![session("target", "claude", 1000, "/repo/a")];
        let runtimes = vec![
            WorkspaceRuntimeDescriptor::Native {
                id: "native-active".to_string(),
                client: "claude".to_string(),
                status: "ready".to_string(),
                is_active: true,
                env_name: "dev".to_string(),
                project_dir: "/repo/a".to_string(),
                created_at: 1000,
                provider_session_id: Some("target".to_string()),
            },
            WorkspaceRuntimeDescriptor::Native {
                id: "native-newer-inactive".to_string(),
                client: "claude".to_string(),
                status: "processing".to_string(),
                is_active: false,
                env_name: "dev".to_string(),
                project_dir: "/repo/a".to_string(),
                created_at: 2000,
                provider_session_id: Some("target".to_string()),
            },
        ];

        let decorations =
            build_workspace_session_decorations(&sessions, &runtimes, &HashMap::new());

        assert_eq!(decorations.len(), 1);
        assert_eq!(decorations[0].runtime_id.as_deref(), Some("native-active"));
        assert!(decorations[0].is_active);
    }

    #[test]
    fn active_runtime_wins_over_newer_inactive_runtime_for_fallback_match() {
        let sessions = vec![session("target", "claude", 1000, "/repo/a")];
        let runtimes = vec![
            WorkspaceRuntimeDescriptor::Unified {
                id: "active-fallback".to_string(),
                client: "claude".to_string(),
                status: "ready".to_string(),
                is_active: true,
                env_name: "dev".to_string(),
                project_dir: "/repo/a".to_string(),
                created_at: 1000,
                history_session_id: None,
            },
            WorkspaceRuntimeDescriptor::Unified {
                id: "newer-inactive-fallback".to_string(),
                client: "claude".to_string(),
                status: "processing".to_string(),
                is_active: false,
                env_name: "dev".to_string(),
                project_dir: "/repo/a".to_string(),
                created_at: 2000,
                history_session_id: None,
            },
        ];

        let decorations =
            build_workspace_session_decorations(&sessions, &runtimes, &HashMap::new());

        assert_eq!(decorations.len(), 1);
        assert_eq!(
            decorations[0].runtime_id.as_deref(),
            Some("active-fallback")
        );
        assert!(decorations[0].is_active);
    }

    #[test]
    fn decoration_events_replay_only_for_live_or_attention_capable_statuses() {
        for status in ["idle", "initializing", "processing", "ready", "running"] {
            assert!(
                should_replay_decoration_events(status),
                "{status} should be replayed for live decoration state"
            );
        }

        for status in [
            "stopped",
            "completed",
            "error",
            "closed_idle",
            "interrupted",
            "handoff",
            "handoff_pending",
        ] {
            assert!(
                !should_replay_decoration_events(status),
                "{status} should not replay historical event logs during sidebar polling"
            );
        }
    }

    #[test]
    fn fallback_matches_recent_runtime_by_project_and_env() {
        let sessions = vec![
            session("older", "claude", 1_000, "/repo/a"),
            session("candidate", "claude", 10_000, "/repo/a"),
        ];
        let runtimes = vec![WorkspaceRuntimeDescriptor::Unified {
            id: "runtime-1".to_string(),
            client: "claude".to_string(),
            status: "ready".to_string(),
            is_active: true,
            env_name: "dev".to_string(),
            project_dir: "/repo/a".to_string(),
            created_at: 10_500,
            history_session_id: None,
        }];

        let decorations =
            build_workspace_session_decorations(&sessions, &runtimes, &HashMap::new());

        assert_eq!(decorations.len(), 1);
        assert_eq!(decorations[0].session_key, "claude:candidate");
        assert_eq!(decorations[0].visual_state, "identity");
        assert!(decorations[0].is_active);
    }

    #[test]
    fn unified_events_promote_plan_review_attention() {
        let sessions = vec![session("target", "claude", 1000, "/repo/a")];
        let runtimes = vec![WorkspaceRuntimeDescriptor::Unified {
            id: "runtime-1".to_string(),
            client: "claude".to_string(),
            status: "processing".to_string(),
            is_active: true,
            env_name: "dev".to_string(),
            project_dir: "/repo/a".to_string(),
            created_at: 1000,
            history_session_id: Some("target".to_string()),
        }];
        let event = SessionEventRecord {
            runtime_id: "runtime-1".to_string(),
            seq: 1,
            occurred_at: Utc::now(),
            payload: SessionEventPayload::ToolUseStarted {
                tool_use_id: "tool-1".to_string(),
                category: ToolCategory::UserInput {
                    kind: crate::event_bus::UserInputKind::PlanExit,
                    raw_name: "ExitPlanMode".to_string(),
                },
                raw_name: "ExitPlanMode".to_string(),
                input_summary: String::new(),
                needs_response: true,
                prompt: Some(InteractiveToolPrompt::PlanExit {
                    allowed_prompts: vec![],
                    plan_summary: None,
                }),
                todo_snapshot: None,
            },
        };
        let mut events_by_runtime = HashMap::new();
        events_by_runtime.insert("runtime-1".to_string(), vec![event]);

        let decorations =
            build_workspace_session_decorations(&sessions, &runtimes, &events_by_runtime);

        assert_eq!(decorations.len(), 1);
        assert_eq!(decorations[0].visual_state, "attention");
        assert_eq!(
            decorations[0].attention_kind.as_deref(),
            Some("plan_review")
        );
    }

    #[test]
    fn native_events_promote_permission_attention() {
        let sessions = vec![session("target", "claude", 1000, "/repo/a")];
        let runtimes = vec![WorkspaceRuntimeDescriptor::Native {
            id: "native-1".to_string(),
            client: "claude".to_string(),
            status: "processing".to_string(),
            is_active: true,
            env_name: "dev".to_string(),
            project_dir: "/repo/a".to_string(),
            created_at: 1000,
            provider_session_id: Some("target".to_string()),
        }];
        let event = SessionEventRecord {
            runtime_id: "native-1".to_string(),
            seq: 1,
            occurred_at: Utc::now(),
            payload: SessionEventPayload::PermissionRequired {
                request_id: "req-1".to_string(),
                tool_use_id: Some("tool-1".to_string()),
                tool_name: "Bash".to_string(),
                input_summary: None,
            },
        };
        let mut events_by_runtime = HashMap::new();
        events_by_runtime.insert("native-1".to_string(), vec![event]);

        let decorations =
            build_workspace_session_decorations(&sessions, &runtimes, &events_by_runtime);

        assert_eq!(decorations.len(), 1);
        assert_eq!(decorations[0].session_key, "claude:target");
        assert_eq!(decorations[0].visual_state, "attention");
        assert_eq!(
            decorations[0].attention_kind.as_deref(),
            Some("permission_required")
        );
    }
}
