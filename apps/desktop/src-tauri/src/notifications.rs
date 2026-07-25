use crate::config::{self, DesktopSettings};
use crate::event_bus::{InteractiveToolPrompt, SessionEventPayload};
use std::path::Path;
use std::sync::RwLock;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_notification::NotificationExt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NotificationKind {
    TaskCompleted,
    TaskFailed,
    ActionRequired,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NotificationPrefs {
    enabled: bool,
    task_completed: bool,
    task_failed: bool,
    action_required: bool,
}

impl NotificationPrefs {
    fn disabled() -> Self {
        Self {
            enabled: false,
            task_completed: false,
            task_failed: false,
            action_required: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NotificationDraft {
    kind: NotificationKind,
    title: String,
    body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationContext {
    pub env_name: String,
    pub project_dir: String,
    pub client_name: String,
}

impl NotificationContext {
    pub fn new(
        env_name: impl Into<String>,
        project_dir: impl Into<String>,
        client_name: impl Into<String>,
    ) -> Self {
        Self {
            env_name: env_name.into(),
            project_dir: project_dir.into(),
            client_name: client_name.into(),
        }
    }
}

impl From<&DesktopSettings> for NotificationPrefs {
    fn from(settings: &DesktopSettings) -> Self {
        Self {
            enabled: settings.desktop_notifications_enabled,
            task_completed: settings.notify_on_task_completed,
            task_failed: settings.notify_on_task_failed,
            action_required: settings.notify_on_action_required,
        }
    }
}

pub struct NotificationPrefsState {
    prefs: RwLock<NotificationPrefs>,
}

impl NotificationPrefsState {
    pub fn new() -> Self {
        let prefs = match config::read_settings() {
            Ok(settings) => NotificationPrefs::from(&settings),
            Err(error) => {
                eprintln!("Failed to read notification prefs: {}", error);
                NotificationPrefs::disabled()
            }
        };

        Self {
            prefs: RwLock::new(prefs),
        }
    }

    fn snapshot(&self) -> NotificationPrefs {
        self.prefs
            .read()
            .map(|prefs| prefs.clone())
            .unwrap_or_else(|_| NotificationPrefs::disabled())
    }

    pub fn replace_from_settings(&self, settings: &DesktopSettings) {
        if let Ok(mut prefs) = self.prefs.write() {
            *prefs = NotificationPrefs::from(settings);
        }
    }
}

fn load_prefs<R: Runtime>(app: &AppHandle<R>) -> NotificationPrefs {
    app.try_state::<NotificationPrefsState>()
        .map(|state| state.snapshot())
        .unwrap_or_else(NotificationPrefs::disabled)
}

fn project_label(project_dir: &str) -> String {
    Path::new(project_dir)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| project_dir.to_string())
}

fn truncate_text(value: &str, max_chars: usize) -> String {
    let trimmed = value.trim();
    let mut result = trimmed.chars().take(max_chars).collect::<String>();
    if trimmed.chars().count() > max_chars {
        result.push('…');
    }
    result
}

fn action_prompt_body(prompt: Option<&InteractiveToolPrompt>) -> Option<String> {
    match prompt {
        Some(InteractiveToolPrompt::AskUserQuestion { questions }) => questions.first().map(|q| {
            truncate_text(
                q.header
                    .as_deref()
                    .filter(|header| !header.trim().is_empty())
                    .unwrap_or(&q.question),
                96,
            )
        }),
        Some(InteractiveToolPrompt::PlanExit { plan_summary, .. }) => Some(
            plan_summary
                .as_deref()
                .filter(|summary| !summary.trim().is_empty())
                .map(|summary| truncate_text(summary, 96))
                .unwrap_or_else(|| "A plan is ready for review.".to_string()),
        ),
        _ => None,
    }
}

fn build_task_completed_draft(context: &NotificationContext) -> NotificationDraft {
    NotificationDraft {
        kind: NotificationKind::TaskCompleted,
        title: format!("{} task completed", context.client_name),
        body: format!(
            "{} finished in {}",
            project_label(&context.project_dir),
            context.env_name
        ),
    }
}

fn build_task_failed_draft(
    context: &NotificationContext,
    detail: impl Into<String>,
) -> NotificationDraft {
    NotificationDraft {
        kind: NotificationKind::TaskFailed,
        title: format!("{} task needs attention", context.client_name),
        body: truncate_text(&detail.into(), 120),
    }
}

fn build_action_required_draft(
    _context: &NotificationContext,
    title: impl Into<String>,
    body: impl Into<String>,
) -> NotificationDraft {
    NotificationDraft {
        kind: NotificationKind::ActionRequired,
        title: title.into(),
        body: truncate_text(&body.into(), 120),
    }
}

fn build_session_event_draft(
    context: &NotificationContext,
    payload: &SessionEventPayload,
) -> Option<NotificationDraft> {
    match payload {
        SessionEventPayload::SessionCompleted { reason } => match reason.as_str() {
            "completed" => Some(build_task_completed_draft(context)),
            "stopped" => None,
            _ => Some(build_task_failed_draft(
                context,
                format!(
                    "{} failed in {}: {}",
                    project_label(&context.project_dir),
                    context.env_name,
                    reason
                ),
            )),
        },
        SessionEventPayload::PermissionRequired { tool_name, .. } => {
            Some(build_action_required_draft(
                context,
                "Approval required",
                format!(
                    "{} needs approval to continue in {} ({})",
                    context.client_name,
                    project_label(&context.project_dir),
                    tool_name
                ),
            ))
        }
        SessionEventPayload::TerminalPromptRequired { prompt_text, .. } => {
            Some(build_action_required_draft(
                context,
                "Approval required",
                format!(
                    "{} is waiting in {}: {}",
                    context.client_name,
                    project_label(&context.project_dir),
                    prompt_text
                ),
            ))
        }
        SessionEventPayload::ToolUseStarted {
            needs_response,
            prompt,
            ..
        } if *needs_response => {
            let (title, body) = match prompt {
                Some(InteractiveToolPrompt::PlanExit { .. }) => (
                    "Plan review required",
                    action_prompt_body(prompt.as_ref()).unwrap_or_else(|| {
                        format!(
                            "{} is waiting for feedback in {}",
                            context.client_name,
                            project_label(&context.project_dir)
                        )
                    }),
                ),
                _ => (
                    "Input required",
                    action_prompt_body(prompt.as_ref()).unwrap_or_else(|| {
                        format!(
                            "{} is waiting for input in {}",
                            context.client_name,
                            project_label(&context.project_dir)
                        )
                    }),
                ),
            };
            Some(build_action_required_draft(context, title, body))
        }
        _ => None,
    }
}

fn should_send(prefs: &NotificationPrefs, draft: &NotificationDraft) -> bool {
    if !prefs.enabled {
        return false;
    }

    match draft.kind {
        NotificationKind::TaskCompleted => prefs.task_completed,
        NotificationKind::TaskFailed => prefs.task_failed,
        NotificationKind::ActionRequired => prefs.action_required,
    }
}

fn show_notification<R: Runtime>(
    app: &AppHandle<R>,
    draft: &NotificationDraft,
) -> Result<(), String> {
    app.notification()
        .builder()
        .title(&draft.title)
        .body(&draft.body)
        .show()
        .map_err(|error| format!("Failed to show notification: {}", error))
}

pub fn maybe_notify_session_event<R: Runtime>(
    app: &AppHandle<R>,
    context: &NotificationContext,
    payload: &SessionEventPayload,
) {
    let Some(draft) = build_session_event_draft(context, payload) else {
        return;
    };
    let prefs = load_prefs(app);

    if should_send(&prefs, &draft) {
        let _ = show_notification(app, &draft);
    }
}

pub fn maybe_notify_task_completed<R: Runtime>(app: &AppHandle<R>, context: &NotificationContext) {
    let prefs = load_prefs(app);
    let draft = build_task_completed_draft(context);
    if should_send(&prefs, &draft) {
        let _ = show_notification(app, &draft);
    }
}

pub fn maybe_notify_task_failed<R: Runtime>(
    app: &AppHandle<R>,
    context: &NotificationContext,
    detail: impl Into<String>,
) {
    let prefs = load_prefs(app);
    let draft = build_task_failed_draft(context, detail);
    if should_send(&prefs, &draft) {
        let _ = show_notification(app, &draft);
    }
}

pub fn send_test_notification<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    show_notification(
        app,
        &NotificationDraft {
            kind: NotificationKind::ActionRequired,
            title: "CCEM notifications are ready".to_string(),
            body: "Task completion and feedback prompts will show up here.".to_string(),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event_bus::{
        InteractiveToolPrompt, SessionEventPayload, ToolCategory, UserInputKind,
    };

    fn enabled_prefs() -> NotificationPrefs {
        NotificationPrefs {
            enabled: true,
            task_completed: true,
            task_failed: true,
            action_required: true,
        }
    }

    fn context() -> NotificationContext {
        NotificationContext::new("official", "/tmp/demo-project", "Claude")
    }

    #[test]
    fn completed_event_maps_to_completion_notification() {
        let draft = build_session_event_draft(
            &context(),
            &SessionEventPayload::SessionCompleted {
                reason: "completed".to_string(),
            },
        )
        .expect("expected completion notification");

        assert_eq!(draft.kind, NotificationKind::TaskCompleted);
        assert!(draft.title.contains("completed"));
        assert!(draft.body.contains("demo-project"));
    }

    #[test]
    fn stopped_event_does_not_notify() {
        let draft = build_session_event_draft(
            &context(),
            &SessionEventPayload::SessionCompleted {
                reason: "stopped".to_string(),
            },
        );

        assert!(draft.is_none());
    }

    #[test]
    fn question_prompt_maps_to_action_required_notification() {
        let draft = build_session_event_draft(
            &context(),
            &SessionEventPayload::ToolUseStarted {
                tool_use_id: "tool-1".to_string(),
                category: ToolCategory::UserInput {
                    kind: UserInputKind::Question,
                    raw_name: "ask_user_question".to_string(),
                },
                raw_name: "ask_user_question".to_string(),
                input_summary: "question".to_string(),
                needs_response: true,
                prompt: Some(InteractiveToolPrompt::AskUserQuestion {
                    questions: vec![crate::event_bus::ToolQuestionPrompt {
                        question: "Need a deployment window?".to_string(),
                        header: Some("Deployment window".to_string()),
                        multi_select: false,
                        options: Vec::new(),
                    }],
                }),
                todo_snapshot: None,
            },
        )
        .expect("expected action notification");

        assert_eq!(draft.kind, NotificationKind::ActionRequired);
        assert_eq!(draft.title, "Input required");
        assert!(draft.body.contains("Deployment window"));
    }

    #[test]
    fn disabled_master_toggle_blocks_notification() {
        let mut prefs = enabled_prefs();
        prefs.enabled = false;

        let draft = build_task_completed_draft(&context());
        assert!(!should_send(&prefs, &draft));
    }
}
