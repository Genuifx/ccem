use crate::event_bus::{
    InteractiveToolPrompt, SessionEventPayload, ToolCategory, ToolQuestionOption,
    ToolQuestionPrompt, UserInputKind,
};
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct JsonlWatcher {
    project_dir: String,
    started_at: DateTime<Utc>,
    jsonl_path: Option<PathBuf>,
    last_offset: u64,
    session_id: Option<String>,
    pending_tool_uses: HashMap<String, String>,
}

#[derive(Debug, Default)]
pub struct JsonlPollResult {
    pub claude_session_id: Option<String>,
    pub jsonl_path: Option<PathBuf>,
    pub events: Vec<SessionEventPayload>,
}

impl JsonlWatcher {
    pub fn new(
        project_dir: impl Into<String>,
        started_at: DateTime<Utc>,
        resume_session_id: Option<String>,
    ) -> Self {
        Self {
            project_dir: project_dir.into(),
            started_at,
            jsonl_path: None,
            last_offset: 0,
            session_id: resume_session_id,
            pending_tool_uses: HashMap::new(),
        }
    }

    pub fn jsonl_path(&self) -> Option<&PathBuf> {
        self.jsonl_path.as_ref()
    }

    pub fn poll(&mut self) -> Result<JsonlPollResult, String> {
        if self.jsonl_path.is_none() {
            self.jsonl_path = discover_jsonl_path(
                &self.project_dir,
                self.started_at,
                self.session_id.as_deref(),
            );
        }

        let Some(path) = self.jsonl_path.clone() else {
            return Ok(JsonlPollResult::default());
        };

        let mut file = File::open(&path)
            .map_err(|error| format!("Failed to open JSONL file {}: {}", path.display(), error))?;
        file.seek(SeekFrom::Start(self.last_offset))
            .map_err(|error| format!("Failed to seek JSONL file {}: {}", path.display(), error))?;

        let mut appended = String::new();
        file.read_to_string(&mut appended)
            .map_err(|error| format!("Failed to read JSONL file {}: {}", path.display(), error))?;
        self.last_offset += appended.len() as u64;

        let mut events = Vec::new();
        for line in appended.lines().filter(|line| !line.trim().is_empty()) {
            let Ok(value) = serde_json::from_str::<Value>(line) else {
                continue;
            };

            if self.session_id.is_none() {
                self.session_id = value
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(|value| value.to_string());
            }

            events.extend(parse_jsonl_line(&value, &mut self.pending_tool_uses));
        }

        Ok(JsonlPollResult {
            claude_session_id: self.session_id.clone(),
            jsonl_path: Some(path),
            events,
        })
    }
}

pub fn discover_jsonl_path(
    project_dir: &str,
    started_at: DateTime<Utc>,
    preferred_session_id: Option<&str>,
) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let projects_dir = home.join(".claude").join("projects");
    let earliest_modified_at = if preferred_session_id.is_some() {
        started_at - chrono::Duration::minutes(10)
    } else {
        started_at - chrono::Duration::seconds(15)
    };

    for key in project_dir_keys(project_dir) {
        let base_dir = projects_dir.join(key);
        if !base_dir.exists() {
            continue;
        }

        if let Some(session_id) = preferred_session_id {
            let preferred = base_dir.join(format!("{}.jsonl", session_id));
            if preferred.exists() {
                return Some(preferred);
            }
        }

        let mut candidates = fs::read_dir(&base_dir)
            .ok()?
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
            .filter_map(|path| {
                let modified = path.metadata().ok()?.modified().ok()?;
                let modified_at = DateTime::<Utc>::from(modified);
                if modified_at < earliest_modified_at {
                    return None;
                }
                Some((modified_at, path))
            })
            .collect::<Vec<_>>();

        candidates.sort_by_key(|left| left.0);
        if let Some((_, path)) = candidates.pop() {
            return Some(path);
        }
    }

    None
}

fn project_dir_key(project_dir: &str) -> String {
    project_dir.replace(['/', '\\', ':'], "-").replace(' ', "-")
}

fn project_dir_keys(project_dir: &str) -> Vec<String> {
    let mut candidates = vec![project_dir.to_string()];
    if let Ok(canonical) = fs::canonicalize(project_dir) {
        candidates.push(canonical.to_string_lossy().to_string());
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(stripped) = project_dir.strip_prefix("/private") {
            candidates.push(stripped.to_string());
        } else if project_dir.starts_with("/tmp") {
            candidates.push(format!("/private{}", project_dir));
        } else if let Some(stripped) = project_dir.strip_prefix("/var") {
            candidates.push(format!("/private/var{}", stripped));
        }
    }

    let mut keys = Vec::new();
    for candidate in candidates {
        let key = project_dir_key(&candidate);
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    keys
}

fn parse_jsonl_line(
    value: &Value,
    pending_tool_uses: &mut HashMap<String, String>,
) -> Vec<SessionEventPayload> {
    match value.get("type").and_then(Value::as_str) {
        Some("assistant") => parse_assistant_line(value, pending_tool_uses),
        Some("user") => parse_user_line(value, pending_tool_uses),
        Some("system") => value
            .get("subtype")
            .and_then(Value::as_str)
            .map(|subtype| {
                vec![SessionEventPayload::Lifecycle {
                    stage: subtype.to_string(),
                    detail: value.to_string(),
                }]
            })
            .unwrap_or_default(),
        Some("progress") => parse_progress_line(value),
        _ => Vec::new(),
    }
}

fn parse_assistant_line(
    value: &Value,
    pending_tool_uses: &mut HashMap<String, String>,
) -> Vec<SessionEventPayload> {
    let Some(message) = value.get("message") else {
        return Vec::new();
    };

    if is_synthetic_no_response_message(message) {
        return Vec::new();
    }

    let mut events = vec![SessionEventPayload::ClaudeJson {
        message_type: Some("assistant".to_string()),
        raw_json: value.to_string(),
    }];

    match message.get("content") {
        Some(Value::String(text)) => {
            let text = text.trim();
            if !text.is_empty() {
                events.push(SessionEventPayload::AssistantChunk {
                    text: text.to_string(),
                });
            }
        }
        Some(Value::Array(blocks)) => {
            for block in blocks {
                match block
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                {
                    "text" => {
                        let text = block
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .trim();
                        if !text.is_empty() {
                            events.push(SessionEventPayload::AssistantChunk {
                                text: text.to_string(),
                            });
                        }
                    }
                    "tool_use" => {
                        let Some(raw_name) = block.get("name").and_then(Value::as_str) else {
                            continue;
                        };
                        let Some(tool_use_id) = block.get("id").and_then(Value::as_str) else {
                            continue;
                        };

                        let input = block.get("input").cloned().unwrap_or(Value::Null);
                        let category = categorize_tool(raw_name);
                        let prompt = parse_interactive_tool_prompt(raw_name, &input);
                        let needs_response = matches!(
                            category,
                            ToolCategory::UserInput {
                                kind: UserInputKind::Question | UserInputKind::PlanExit,
                                ..
                            }
                        );

                        pending_tool_uses.insert(tool_use_id.to_string(), raw_name.to_string());
                        events.push(SessionEventPayload::ToolUseStarted {
                            tool_use_id: tool_use_id.to_string(),
                            category,
                            raw_name: raw_name.to_string(),
                            input_summary: summarize_tool_input(raw_name, &input),
                            needs_response,
                            prompt,
                            todo_snapshot: None,
                        });
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }

    events
}

fn is_synthetic_no_response_message(message: &Value) -> bool {
    if message.get("model").and_then(Value::as_str) != Some("<synthetic>") {
        return false;
    }

    extract_message_text(message)
        .map(|text| text.trim() == "No response requested.")
        .unwrap_or(false)
}

fn extract_message_text(message: &Value) -> Option<String> {
    match message.get("content")? {
        Value::String(text) => {
            let trimmed = text.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        Value::Array(blocks) => {
            let mut parts = Vec::new();
            for block in blocks {
                if block.get("type").and_then(Value::as_str) != Some("text") {
                    return None;
                }
                if let Some(text) = block
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    parts.push(text.to_string());
                }
            }
            (!parts.is_empty()).then(|| parts.join("\n"))
        }
        _ => None,
    }
}

fn parse_user_line(
    value: &Value,
    pending_tool_uses: &mut HashMap<String, String>,
) -> Vec<SessionEventPayload> {
    let Some(message) = value.get("message") else {
        return Vec::new();
    };

    let mut events = vec![SessionEventPayload::ClaudeJson {
        message_type: Some("user".to_string()),
        raw_json: value.to_string(),
    }];

    if let Some(blocks) = message.get("content").and_then(Value::as_array) {
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }

            let Some(tool_use_id) = block.get("tool_use_id").and_then(Value::as_str) else {
                continue;
            };

            let raw_name = pending_tool_uses
                .remove(tool_use_id)
                .unwrap_or_else(|| "unknown_tool".to_string());
            let success = !block
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false);

            events.push(SessionEventPayload::ToolUseCompleted {
                tool_use_id: tool_use_id.to_string(),
                result_content: subagent_tool_result_content(&raw_name, block),
                raw_name,
                result_summary: summarize_tool_result(block),
                success,
                todo_snapshot: None,
            });
        }
    }

    events
}

fn categorize_tool(name: &str) -> ToolCategory {
    if name.contains("AskUser") || name.contains("Question") {
        return ToolCategory::UserInput {
            kind: UserInputKind::Question,
            raw_name: name.to_string(),
        };
    }

    if name.contains("PlanMode") && name.contains("Enter") {
        return ToolCategory::UserInput {
            kind: UserInputKind::PlanEntry,
            raw_name: name.to_string(),
        };
    }

    if name.contains("PlanMode") && name.contains("Exit") {
        return ToolCategory::UserInput {
            kind: UserInputKind::PlanExit,
            raw_name: name.to_string(),
        };
    }

    match name {
        "Bash" | "BashOutput" | "KillShell" => ToolCategory::Execution {
            raw_name: name.to_string(),
        },
        "Read" | "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => ToolCategory::FileOp {
            raw_name: name.to_string(),
        },
        "Glob" | "Grep" | "LSP" | "WebFetch" | "WebSearch" | "ToolSearch" => ToolCategory::Search {
            raw_name: name.to_string(),
        },
        _ if name.contains("Task") || name.contains("Todo") => ToolCategory::TaskMgmt {
            raw_name: name.to_string(),
        },
        _ => ToolCategory::Unknown {
            raw_name: name.to_string(),
        },
    }
}

fn parse_interactive_tool_prompt(name: &str, input: &Value) -> Option<InteractiveToolPrompt> {
    if name.contains("AskUser") || name.contains("Question") {
        let questions = input
            .get("questions")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(|question| {
                        let question_text = question.get("question").and_then(Value::as_str)?;
                        let options = question
                            .get("options")
                            .and_then(Value::as_array)
                            .map(|options| {
                                options
                                    .iter()
                                    .filter_map(|option| {
                                        let label =
                                            option.get("label").and_then(Value::as_str)?.trim();
                                        if label.is_empty() {
                                            return None;
                                        }
                                        Some(ToolQuestionOption {
                                            label: label.to_string(),
                                            description: option
                                                .get("description")
                                                .and_then(Value::as_str)
                                                .map(str::trim)
                                                .filter(|value| !value.is_empty())
                                                .map(ToString::to_string),
                                            preview: option
                                                .get("preview")
                                                .and_then(Value::as_str)
                                                .map(str::trim)
                                                .filter(|value| !value.is_empty())
                                                .map(ToString::to_string),
                                        })
                                    })
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_default();

                        Some(ToolQuestionPrompt {
                            question: question_text.trim().to_string(),
                            header: question
                                .get("header")
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .filter(|value| !value.is_empty())
                                .map(ToString::to_string),
                            multi_select: question
                                .get("multiSelect")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                            options,
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        return Some(InteractiveToolPrompt::AskUserQuestion { questions });
    }

    if name.contains("PlanMode") && name.contains("Enter") {
        return Some(InteractiveToolPrompt::PlanEntry);
    }

    if name.contains("PlanMode") && name.contains("Exit") {
        let allowed_prompts = input
            .get("allowedPrompts")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let plan_summary = input
            .get("plan")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);
        return Some(InteractiveToolPrompt::PlanExit {
            allowed_prompts,
            plan_summary,
        });
    }

    None
}

fn summarize_tool_input(name: &str, input: &Value) -> String {
    if let Some(summary) = summarize_question_input(input) {
        return summary;
    }

    if name.contains("PlanMode") && name.contains("Exit") {
        if let Some(plan_summary) = input
            .get("plan")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return truncate_summary(plan_summary);
        }
    }

    if name == "Bash" {
        if let Some(command) = input
            .get("command")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return truncate_summary(command);
        }
    }

    for key in ["file_path", "path", "target_file", "pattern", "query"] {
        if let Some(value) = input
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return truncate_summary(value);
        }
    }

    truncate_summary(&compact_json(input))
}

fn summarize_question_input(input: &Value) -> Option<String> {
    let questions = input.get("questions")?.as_array()?;
    let count = questions.len();
    let first_question = questions
        .first()
        .and_then(|question| question.get("question"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    Some(truncate_summary(&format!(
        "需要用户回答 {} 个问题：{}",
        count, first_question
    )))
}

fn summarize_tool_result(block: &Value) -> String {
    if let Some(content) = extract_tool_result_text(block.get("content")) {
        return truncate_summary(&content);
    }

    if let Some(message) = block
        .get("toolUseResult")
        .and_then(Value::as_object)
        .and_then(|value| value.get("message"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return truncate_summary(message);
    }

    truncate_summary(&compact_json(block))
}

fn subagent_tool_result_content(raw_name: &str, block: &Value) -> Option<String> {
    if !matches!(raw_name, "Agent" | "Task") {
        return None;
    }

    extract_tool_result_text(block.get("content")).or_else(|| {
        block
            .get("toolUseResult")
            .and_then(Value::as_object)
            .and_then(|value| value.get("message"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
    })
}

fn extract_tool_result_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => {
            let text = text.trim();
            (!text.is_empty()).then(|| text.to_string())
        }
        Value::Array(values) => {
            let joined = values
                .iter()
                .filter_map(|value| match value {
                    Value::String(text) => Some(text.trim().to_string()),
                    Value::Object(map) => map
                        .get("text")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .map(ToString::to_string),
                    _ => None,
                })
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            (!joined.is_empty()).then_some(joined)
        }
        Value::Object(map) => map
            .get("text")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string),
        _ => None,
    }
}

fn compact_json(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "<invalid-json>".to_string())
}

fn truncate_summary(value: &str) -> String {
    const MAX_CHARS: usize = 200;
    let trimmed = value.trim();
    if trimmed.chars().count() <= MAX_CHARS {
        return trimmed.to_string();
    }

    let mut truncated = trimmed.chars().take(MAX_CHARS).collect::<String>();
    truncated.push('…');
    truncated
}

fn parse_progress_line(value: &Value) -> Vec<SessionEventPayload> {
    let Some(data) = value.get("data") else {
        return Vec::new();
    };

    if data.get("type").and_then(Value::as_str) == Some("hook_progress") {
        return vec![SessionEventPayload::Lifecycle {
            stage: "hook_progress".to_string(),
            detail: value.to_string(),
        }];
    }

    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::{parse_jsonl_line, project_dir_key, project_dir_keys};
    use crate::event_bus::{
        InteractiveToolPrompt, SessionEventPayload, ToolCategory, UserInputKind,
    };
    use serde_json::json;
    use std::collections::HashMap;

    #[test]
    fn project_dir_key_matches_claude_layout() {
        assert_eq!(
            project_dir_key("/Users/g/Github/ccem"),
            "-Users-g-Github-ccem"
        );
    }

    #[test]
    fn project_dir_keys_include_private_tmp_variant_on_macos() {
        let keys = project_dir_keys("/tmp");
        assert!(keys.contains(&"-tmp".to_string()));
        #[cfg(target_os = "macos")]
        assert!(keys.contains(&"-private-tmp".to_string()));
    }

    #[test]
    fn assistant_jsonl_line_produces_chunks_and_structured_tool_event() {
        let mut pending = HashMap::new();
        let value = json!({
            "type": "assistant",
            "message": {
                "stop_reason": "tool_use",
                "content": [
                    {"type": "text", "text": "hello"},
                    {"type": "tool_use", "id": "toolu-1", "name": "Bash", "input": {"command": "npm test"}}
                ]
            }
        });

        let events = parse_jsonl_line(&value, &mut pending);
        assert!(events.iter().any(|event| matches!(
            event,
            SessionEventPayload::AssistantChunk { text } if text == "hello"
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            SessionEventPayload::ToolUseStarted {
                tool_use_id,
                category: ToolCategory::Execution { raw_name },
                raw_name: raw_name_again,
                input_summary,
                needs_response,
                prompt: None,
                ..
            } if tool_use_id == "toolu-1"
                && raw_name == "Bash"
                && raw_name_again == "Bash"
                && input_summary == "npm test"
                && !needs_response
        )));
    }

    #[test]
    fn assistant_jsonl_line_accepts_sdk_string_content() {
        let mut pending = HashMap::new();
        let value = json!({
            "type": "assistant",
            "message": {
                "content": "plain sdk output"
            }
        });

        let events = parse_jsonl_line(&value, &mut pending);

        assert!(events.iter().any(|event| matches!(
            event,
            SessionEventPayload::ClaudeJson {
                message_type: Some(message_type),
                ..
            } if message_type == "assistant"
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            SessionEventPayload::AssistantChunk { text } if text == "plain sdk output"
        )));
    }

    #[test]
    fn assistant_jsonl_line_skips_synthetic_no_response() {
        let mut pending = HashMap::new();
        let value = json!({
            "type": "assistant",
            "message": {
                "id": "synthetic-no-response",
                "type": "message",
                "role": "assistant",
                "model": "<synthetic>",
                "content": [{ "type": "text", "text": "No response requested." }]
            }
        });

        let events = parse_jsonl_line(&value, &mut pending);

        assert!(events.is_empty());
        assert!(pending.is_empty());
    }

    #[test]
    fn ask_user_question_produces_prompt_metadata() {
        let mut pending = HashMap::new();
        let value = json!({
            "type": "assistant",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "id": "toolu-ask",
                    "name": "AskUserQuestion",
                    "input": {
                        "questions": [{
                            "question": "Which approach?",
                            "header": "Approach",
                            "multiSelect": false,
                            "options": [
                                {"label": "A", "description": "alpha"},
                                {"label": "B", "description": "beta"}
                            ]
                        }]
                    }
                }]
            }
        });

        let events = parse_jsonl_line(&value, &mut pending);
        assert!(events.iter().any(|event| matches!(
            event,
            SessionEventPayload::ToolUseStarted {
                category: ToolCategory::UserInput {
                    kind: UserInputKind::Question,
                    raw_name,
                },
                needs_response,
                prompt: Some(InteractiveToolPrompt::AskUserQuestion { questions }),
                ..
            } if raw_name == "AskUserQuestion"
                && *needs_response
                && questions.len() == 1
                && questions[0].question == "Which approach?"
                && questions[0].options.len() == 2
        )));
    }

    #[test]
    fn user_tool_result_emits_completion_event() {
        let mut pending = HashMap::from([("toolu-plan".to_string(), "EnterPlanMode".to_string())]);
        let value = json!({
            "type": "user",
            "message": {
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu-plan",
                    "content": "Entered plan mode."
                }]
            }
        });

        let events = parse_jsonl_line(&value, &mut pending);
        assert!(events.iter().any(|event| matches!(
            event,
            SessionEventPayload::ToolUseCompleted {
                tool_use_id,
                raw_name,
                result_summary,
                result_content: None,
                success,
                ..
            } if tool_use_id == "toolu-plan"
                && raw_name == "EnterPlanMode"
                && result_summary == "Entered plan mode."
                && *success
        )));
        assert!(pending.is_empty());
    }

    #[test]
    fn subagent_tool_result_includes_full_content() {
        let mut pending = HashMap::from([("toolu-agent".to_string(), "Agent".to_string())]);
        let full_output =
            "# Review\n\n- finding one\n- finding two\n\n```ts\nconst ok = true;\n```";
        let value = json!({
            "type": "user",
            "message": {
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu-agent",
                    "content": full_output
                }]
            }
        });

        let events = parse_jsonl_line(&value, &mut pending);

        assert!(events.iter().any(|event| matches!(
            event,
            SessionEventPayload::ToolUseCompleted {
                tool_use_id,
                raw_name,
                result_summary,
                result_content: Some(result_content),
                success,
                ..
            } if tool_use_id == "toolu-agent"
                && raw_name == "Agent"
                && result_summary == full_output
                && result_content == full_output
                && *success
        )));
        assert!(pending.is_empty());
    }

    #[test]
    fn exit_plan_mode_prompt_captures_plan_summary() {
        let mut pending = HashMap::new();
        let value = json!({
            "type": "assistant",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "id": "toolu-exit-plan",
                    "name": "ExitPlanMode",
                    "input": {
                        "plan": "Step 1: write hello.sh\nStep 2: run it",
                        "allowedPrompts": ["Type here to tell Claude what to change"]
                    }
                }]
            }
        });

        let events = parse_jsonl_line(&value, &mut pending);
        assert!(events.iter().any(|event| matches!(
            event,
            SessionEventPayload::ToolUseStarted {
                category: ToolCategory::UserInput {
                    kind: UserInputKind::PlanExit,
                    raw_name,
                },
                input_summary,
                needs_response,
                prompt: Some(InteractiveToolPrompt::PlanExit {
                    allowed_prompts,
                    plan_summary: Some(plan_summary),
                }),
                ..
            } if raw_name == "ExitPlanMode"
                && *needs_response
                && input_summary.contains("Step 1: write hello.sh")
                && allowed_prompts == &vec!["Type here to tell Claude what to change".to_string()]
                && plan_summary.contains("Step 2: run it")
        )));
    }
}
