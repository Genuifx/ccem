//! Post-turn "suggested next step" generation via a one-shot helper query.

use crate::session_titles::{resolve_helper_query_env, run_helper_query};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use tauri::AppHandle;

const CONTEXT_MAX_CHARS: usize = 8_000;
const MAX_SUGGESTIONS: usize = 2;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NextStepSuggestion {
    pub title: String,
    pub prompt: String,
}

#[derive(Serialize)]
struct NextStepsQueryCommand<'a> {
    #[serde(rename = "type")]
    command_type: &'static str,
    context: &'a str,
    working_dir: &'a str,
    env_vars: &'a HashMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    claude_path: Option<&'a str>,
    model: &'a str,
}

fn clip_context(context: &str) -> String {
    let trimmed = context.trim();
    let count = trimmed.chars().count();
    if count <= CONTEXT_MAX_CHARS {
        return trimmed.to_string();
    }
    // Keep the tail: the final reply carries what is left to do.
    trimmed.chars().skip(count - CONTEXT_MAX_CHARS).collect()
}

fn parse_suggestions(value: Option<Value>) -> Vec<NextStepSuggestion> {
    let Some(items) = value
        .as_ref()
        .and_then(|value| value.get("suggestions"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| serde_json::from_value::<NextStepSuggestion>(item.clone()).ok())
        .filter(|item| !item.title.trim().is_empty() && !item.prompt.trim().is_empty())
        .take(MAX_SUGGESTIONS)
        .collect()
}

#[tauri::command]
pub async fn suggest_workspace_next_steps(
    app: AppHandle,
    context: String,
    env_name: Option<String>,
    working_dir: Option<String>,
) -> Result<Vec<NextStepSuggestion>, String> {
    let context = clip_context(&context);
    if context.is_empty() {
        return Ok(Vec::new());
    }
    let resolved = resolve_helper_query_env(env_name.as_deref(), working_dir.as_deref())?;
    tauri::async_runtime::spawn_blocking(crate::agent_home::ensure_agent_homes)
        .await
        .map_err(|error| format!("Failed to prepare agent profile: {error}"))??;
    let line = serde_json::to_string(&NextStepsQueryCommand {
        command_type: "next_steps_query",
        context: &context,
        working_dir: &resolved.working_dir,
        env_vars: &resolved.env_vars,
        claude_path: resolved.claude_path.as_deref(),
        model: &resolved.model,
    })
    .map_err(|error| format!("Failed to encode next steps query: {}", error))?;
    let result = run_helper_query(app, line, &resolved.working_dir, "next_steps_result").await?;
    Ok(parse_suggestions(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_valid_suggestions_and_drops_malformed_ones() {
        let parsed = parse_suggestions(Some(json!({
            "type": "next_steps_result",
            "suggestions": [
                {"title": "修复登录", "prompt": "修复 login.ts"},
                {"title": " ", "prompt": "x"},
                {"title": "missing prompt"},
                {"title": "补文档", "prompt": "写文档"},
                {"title": "第三条", "prompt": "y"}
            ]
        })));
        assert_eq!(
            parsed,
            vec![
                NextStepSuggestion { title: "修复登录".into(), prompt: "修复 login.ts".into() },
                NextStepSuggestion { title: "补文档".into(), prompt: "写文档".into() },
            ]
        );
        assert!(parse_suggestions(None).is_empty());
        assert!(parse_suggestions(Some(json!({"suggestions": "nope"}))).is_empty());
    }

    #[test]
    fn clips_context_keeping_the_tail() {
        let long = format!("{}{}", "头".repeat(CONTEXT_MAX_CHARS), "尾巴");
        let clipped = clip_context(&long);
        assert_eq!(clipped.chars().count(), CONTEXT_MAX_CHARS);
        assert!(clipped.ends_with("尾巴"));
        assert_eq!(clip_context("  short  "), "short");
    }
}
